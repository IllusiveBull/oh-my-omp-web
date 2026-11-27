import type {
	AccountWire,
	BrokerStatus,
	EnvBrokerStatus,
	LoginKind,
	LoginProviderWire,
	MachineSummary,
	UsageLimitWire,
	UsageReportWire,
} from "@omp-web/protocol";

export type Tone = "ok" | "warn" | "bad" | "off";

/** How a provider signs in, as a short badge text. */
export function kindLabel(kind: LoginKind): string {
	switch (kind) {
		case "oauth":
			return "browser sign-in";
		case "device":
			return "device code";
		case "api-key":
			return "API key (terminal)";
		case "custom":
			return "custom flow";
		case "unknown":
			return "sign-in";
	}
}

/** The web offers a Sign in button for everything except pasted API keys, which are secrets. */
export function canSignInOnWeb(provider: LoginProviderWire): boolean {
	return provider.kind !== "api-key" && provider.available;
}

/** One line about the managed broker, and how worried to look. */
export function describeBroker(
	broker: BrokerStatus,
	now: number,
): { tone: Tone; headline: string; detail: string | null } {
	switch (broker.phase) {
		case "disabled":
			return {
				tone: "off",
				headline: "Not enabled",
				detail: "Machines use the credentials omp finds on each of them.",
			};
		case "starting":
			return { tone: "warn", headline: "Starting…", detail: null };
		case "stopped":
			return { tone: "off", headline: "Stopped", detail: null };
		case "restarting": {
			const wait = broker.nextRetryAt === null ? null : Math.max(0, Math.round((broker.nextRetryAt - now) / 1000));
			return {
				tone: "bad",
				headline: "Down — restarting",
				detail: `${broker.lastError?.message ?? "the broker exited"}${wait === null ? "" : `; next attempt in ${wait}s`}`,
			};
		}
		case "running":
			return broker.healthy
				? { tone: "ok", headline: "Running", detail: null }
				: {
						tone: "bad",
						headline: "Running but not answering",
						detail: "its process is alive, /v1/healthz does not respond",
					};
	}
}

/** What a machine's broker state means for the person looking at it; null when there is nothing to say. */
export function describeMachineBroker(
	status: EnvBrokerStatus | undefined,
	machineName: string,
): { tone: Tone; text: string } | null {
	if (!status || status.state === "unconfigured") return null;
	switch (status.state) {
		case "ok":
			return { tone: "ok", text: `${machineName} reaches the auth broker.` };
		case "unreachable":
			return {
				tone: "bad",
				text: `${machineName} cannot reach the auth broker${status.url ? ` at ${status.url}` : ""}: ${status.message ?? "no answer"}. Running sessions keep working on the credentials they already hold (omp caches them for up to an hour); new sessions may fail to start and expiring tokens cannot be refreshed.`,
			};
		case "unauthorized":
			return {
				tone: "bad",
				text: `${machineName}'s token for the auth broker is not accepted: ${status.message ?? "unauthorized"}. Restart its omp-webd (it receives the current token when it registers), or fix its broker.tokenFile.`,
			};
		case "withheld":
			return {
				tone: "warn",
				text: `${machineName} does not use the auth broker: ${status.message ?? "its link is not protected"}`,
			};
	}
}

/** `0.4213` -> `42%`; overage shows above 100. */
export function percent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

/** Width of a usage bar, 0..100. */
export function barWidth(fraction: number | undefined): number {
	return fraction === undefined ? 0 : Math.max(0, Math.min(100, fraction * 100));
}

/** Prefer an unambiguous identity match; otherwise associate a sole report with a sole provider account. */
export function usageForAccount(
	account: AccountWire,
	reports: readonly UsageReportWire[],
	accounts: readonly AccountWire[],
): UsageReportWire | null {
	const candidates = reports.filter(r => r.provider === account.provider);
	const peers = accounts.filter(a => a.provider === account.provider);
	const matches = (a: AccountWire, r: UsageReportWire): boolean =>
		!!r.identity?.trim() && `${a.label} ${a.detail}`.toLowerCase().includes(r.identity.toLowerCase());
	const byIdentity = candidates.filter(r => matches(account, r));
	if (byIdentity.length === 1 && peers.filter(a => matches(a, byIdentity[0]!)).length === 1) return byIdentity[0]!;
	return peers.length === 1 && candidates.length === 1 ? candidates[0]! : null;
}

/** Reports no account claims (an account the list does not show, or a provider reporting without identity). */
export function unmatchedReports(
	accounts: readonly AccountWire[],
	reports: readonly UsageReportWire[],
): UsageReportWire[] {
	const matched = new Set(
		accounts.map(a => usageForAccount(a, reports, accounts)).filter((r): r is UsageReportWire => r !== null),
	);
	return reports.filter(r => !matched.has(r));
}

/** "Claude 5 Hour: 42% used, resets in 2h 5m" for tooltips and tests. */
export function limitText(limit: UsageLimitWire, now: number, relative: (at: number, now: number) => string): string {
	const used = limit.usedFraction === undefined ? "usage unknown" : `${percent(limit.usedFraction)} used`;
	const reset = limit.resetsAt === undefined ? "" : `, resets ${relative(limit.resetsAt, now)}`;
	return `${limit.label}: ${used}${reset}`;
}

/** Progress / status of a flow as a short word. */
export function flowStatusLabel(status: "running" | "succeeded" | "failed" | "cancelled"): string {
	switch (status) {
		case "running":
			return "in progress";
		case "succeeded":
			return "signed in";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
	}
}

/** `navigator.clipboard` does not exist outside secure contexts (the gateway may be served over plain http). */
export function copyText(text: string): Promise<void> {
	return navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("clipboard unavailable"));
}

/**
 * The dot on the sidebar's Accounts button: worst of the broker's own state and every online machine's view of it.
 * `off` while the broker is not enabled (nothing to watch).
 */
export function accountsAttention(broker: BrokerStatus | null, machines: readonly MachineSummary[]): Tone {
	if (broker === null || broker.phase === "disabled") return "off";
	if (broker.phase === "restarting" || (broker.phase === "running" && !broker.healthy)) return "bad";
	const states = machines.filter(m => m.online).map(m => m.broker?.state);
	if (states.some(s => s === "unreachable" || s === "unauthorized")) return "bad";
	if (broker.phase === "starting" || states.some(s => s === "withheld")) return "warn";
	return "ok";
}

/** Accounts page toggle that masks emails, account ids and organizations (e.g. while sharing the screen). */
export const HIDE_PRIVATE_KEY = "omp-web.accounts.hide-private";

export function loadHidePrivate(): boolean {
	try {
		return localStorage.getItem(HIDE_PRIVATE_KEY) === "1";
	} catch {
		return false; // storage unavailable: start shown
	}
}
