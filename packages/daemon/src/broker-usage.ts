import { resolveUsedFraction } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { UsageResponse } from "@oh-my-pi/pi-ai/auth-broker";
import type { UsageLimitWire, UsageReportWire } from "@omp-web/protocol";

/** One report of the broker's `/v1/usage` answer, in upstream's own type. */
type UpstreamReport = UsageResponse["reports"][number];
type UpstreamLimit = UpstreamReport["limits"][number];

const STATUSES: Record<string, UsageLimitWire["status"]> = {
	ok: "ok",
	warning: "warning",
	exhausted: "exhausted",
	unknown: "unknown",
};

type UpstreamUnit = UpstreamLimit["amount"]["unit"];
const UNITS: Record<string, UpstreamUnit> = {
	percent: "percent",
	tokens: "tokens",
	requests: "requests",
	credits: "credits",
	usd: "usd",
	minutes: "minutes",
	bytes: "bytes",
	unknown: "unknown",
};

/** `GET /v1/usage` as the broker answers it (`UsageResponse`), already trimmed of each report's `raw` field. */
export interface ParsedUsage {
	generatedAt: number;
	reports: UsageReportWire[];
	/** Reports or limits that did not have the expected shape and were left out. */
	skipped: number;
}

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const finite = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

function limitWire(raw: unknown): UsageLimitWire | null {
	if (!isRecord(raw)) return null;
	const id = text(raw.id);
	const label = text(raw.label);
	const amount = raw.amount;
	if (id === undefined || label === undefined || !isRecord(amount)) return null;
	const unit = (typeof amount.unit === "string" ? UNITS[amount.unit] : undefined) ?? "unknown";
	// `resolveUsedFraction` is upstream's own rule (explicit fraction > used/limit > percent > inverted remaining).
	const usedFraction = resolveUsedFraction({
		id,
		label,
		scope: { provider: text(isRecord(raw.scope) ? raw.scope.provider : undefined) ?? "" },
		amount: {
			unit,
			used: finite(amount.used),
			limit: finite(amount.limit),
			remaining: finite(amount.remaining),
			usedFraction: finite(amount.usedFraction),
			remainingFraction: finite(amount.remainingFraction),
		},
	});
	const window = isRecord(raw.window) ? raw.window : undefined;
	const scope = isRecord(raw.scope) ? raw.scope : undefined;
	const status = typeof raw.status === "string" ? STATUSES[raw.status] : undefined;
	const notes = Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === "string") : undefined;
	return {
		id,
		label,
		...(text(window?.label) ? { windowLabel: text(window?.label) } : {}),
		...(finite(window?.resetsAt) !== undefined ? { resetsAt: finite(window?.resetsAt) } : {}),
		...((text(window?.id) ?? text(scope?.windowId)) ? { windowId: text(window?.id) ?? text(scope?.windowId) } : {}),
		...(finite(window?.durationMs) !== undefined ? { durationMs: finite(window?.durationMs) } : {}),
		...(usedFraction !== undefined && Number.isFinite(usedFraction) ? { usedFraction } : {}),
		...(status ? { status } : {}),
		...(finite(amount.used) !== undefined ? { used: finite(amount.used) } : {}),
		...(finite(amount.limit) !== undefined ? { limit: finite(amount.limit) } : {}),
		unit,
		...(text(scope?.modelId) ? { modelId: text(scope?.modelId) } : {}),
		...(text(scope?.tier) ? { tier: text(scope?.tier) } : {}),
		...(notes && notes.length > 0 ? { notes } : {}),
	};
}

/** Who a report is for, as the provider reported it: the metadata's email, else its account id. */
function identityOf(raw: Record<string, unknown>): string | undefined {
	const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
	const email = text(metadata?.email);
	if (email) return email;
	const accountId = text(metadata?.accountId);
	if (accountId) return accountId;
	const limits = Array.isArray(raw.limits) ? raw.limits : [];
	const ids = new Set<string>();
	for (const limit of limits) {
		const scope = isRecord(limit) && isRecord(limit.scope) ? limit.scope : undefined;
		const id = text(scope?.accountId);
		if (id) ids.add(id);
	}
	return ids.size === 1 ? [...ids][0] : undefined;
}

/**
 * Reads the broker's `/v1/usage` body. Upstream's type is `UsageResponse` (`{ generatedAt, reports: UsageReport[] }`);
 * the body is validated rather than trusted (a broker of another version may add or drop fields), and what does not parse
 * is counted in `skipped` instead of failing the page. Throws when the answer is not a usage response at all.
 */
export function parseUsageResponse(body: unknown): ParsedUsage {
	if (!isRecord(body) || finite(body.generatedAt) === undefined || !Array.isArray(body.reports)) {
		throw new Error("the broker's /v1/usage answer is not a usage response");
	}
	let skipped = 0;
	const reports: UsageReportWire[] = [];
	for (const raw of body.reports) {
		const provider = isRecord(raw) ? text(raw.provider) : undefined;
		const fetchedAt = isRecord(raw) ? finite(raw.fetchedAt) : undefined;
		if (!isRecord(raw) || provider === undefined || fetchedAt === undefined || !Array.isArray(raw.limits)) {
			skipped++;
			continue;
		}
		const limits: UsageLimitWire[] = [];
		for (const limit of raw.limits) {
			const parsed = limitWire(limit);
			if (parsed) limits.push(parsed);
			else skipped++;
		}
		const notes = Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === "string") : [];
		const identity = identityOf(raw);
		const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
		const reset = isRecord(raw.resetCredits) ? raw.resetCredits : undefined;
		const availableCount = finite(reset?.availableCount);
		const credits = Array.isArray(reset?.credits)
			? reset.credits.flatMap(credit =>
					isRecord(credit) &&
					credit.remainingCount !== 0 &&
					credit.status !== "redeemed" &&
					typeof credit.expiresAt === "string" &&
					Number.isFinite(Date.parse(credit.expiresAt))
						? [{ expiresAt: credit.expiresAt }]
						: [],
				)
			: [];
		reports.push({
			provider,
			fetchedAt,
			...(identity ? { identity } : {}),
			limits,
			...((text(metadata?.orgName) ?? text(metadata?.orgId))
				? { orgName: text(metadata?.orgName) ?? text(metadata?.orgId) }
				: {}),
			...(text(metadata?.planType) ? { planType: text(metadata?.planType) } : {}),
			...(availableCount !== undefined
				? {
						resetCredits: {
							availableCount: Math.max(0, Math.trunc(availableCount)),
							...(finite(reset?.redeemableCount) !== undefined
								? { redeemableCount: Math.max(0, Math.trunc(finite(reset?.redeemableCount)!)) }
								: {}),
							credits,
						},
					}
				: {}),
			...(notes.length > 0 ? { notes } : {}),
		});
	}
	return { generatedAt: finite(body.generatedAt) ?? 0, reports, skipped };
}
