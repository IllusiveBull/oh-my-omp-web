import type {
	AntigravityUsageAck,
	MachineSummary,
	UsageLimitWire,
	UsageReportWire,
	UsageWire,
} from "@omp-web/protocol";
import type { AuthViewState, DaemonClient } from "../store/daemon-client";

/** The last `antigravity.usage` answer of one machine; a failed probe keeps the previous report. */
export interface MachineUsage {
	/** When it was last asked (epoch ms), success or not: what throttles the next probe. */
	checkedAt: number;
	report: UsageReportWire | null;
	unavailable: AntigravityUsageAck["unavailable"] | null;
	error: string | null;
}

export interface UsageState {
	/** Per machine id, the machines whose Antigravity CLI is available. */
	antigravity: Readonly<Record<string, MachineUsage>>;
	/** Requests in flight (machine probes and the broker refresh). */
	pending: number;
	/** Machine ids with a probe in flight. */
	probing: ReadonlySet<string>;
}

/** The gateway rate-limits `auth.usage.refresh` to one per 15 s itself; asking sooner only earns a refusal. */
const BROKER_MIN_INTERVAL_MS = 15_000;
const ANTIGRAVITY_TIMEOUT_MS = 35_000;
/** The broker refresh's key among the in-flight sources (machine ids are never empty-prefixed). */
const BROKER_KEY = "\0broker";

/**
 * Usage across every source, independent of which backend a session runs: the broker's provider reports (omp) and
 * each machine's Antigravity quota (agy). Nothing polls by itself: callers say how stale they accept data with
 * {@link ensure}, and only sources older than that are asked again.
 */
export class UsageStore {
	#state: UsageState = { antigravity: {}, pending: 0, probing: new Set() };
	#listeners = new Set<() => void>();
	/** Requests running per source (a machine id, or the broker), so a forced probe can overlap a periodic one. */
	#inFlight = new Map<string, number>();
	#brokerAskedAt = -Infinity;

	constructor(private readonly client: DaemonClient) {}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): UsageState => this.#state;

	/**
	 * Re-asks every source whose data is older than `maxAgeMs` (0: all of them, within the broker's rate limit): the
	 * broker as `auth` describes it and the Antigravity machines among `machines`.
	 */
	ensure(auth: AuthViewState, machines: readonly MachineSummary[], maxAgeMs: number, now = Date.now()): void {
		this.refreshAntigravity(machines, maxAgeMs, now);
		const fetchedAt = auth.usage.fetchedAt;
		if (
			auth.broker?.phase === "running" &&
			!this.#inFlight.has(BROKER_KEY) &&
			now - this.#brokerAskedAt >= BROKER_MIN_INTERVAL_MS &&
			(fetchedAt === null || now - fetchedAt >= maxAgeMs)
		) {
			this.#brokerAskedAt = now;
			void this.#track(BROKER_KEY, this.client.authRequest({ t: "auth.usage.refresh" }));
		}
	}

	/** Re-probes every online Antigravity machine whose quota is older than `maxAgeMs`. */
	refreshAntigravity(machines: readonly MachineSummary[], maxAgeMs: number, now = Date.now()): void {
		for (const machine of machines) {
			if (!machine.online || machine.antigravity?.available !== true || this.#inFlight.has(machine.id)) continue;
			const last = this.#state.antigravity[machine.id];
			if (last && now - last.checkedAt < maxAgeMs) continue;
			void this.probe(machine.id, now);
		}
	}

	/** Asks one machine now, even while an earlier probe runs (a sign-in just changed what it would answer). */
	async probe(machineId: string, now = Date.now()): Promise<void> {
		const ack = await this.#track(
			machineId,
			this.client.request(machineId, { t: "antigravity.usage" }, ANTIGRAVITY_TIMEOUT_MS),
		);
		const previous = this.#state.antigravity[machineId];
		// A slower, older probe must not overwrite a newer answer.
		if (previous && previous.checkedAt > now) return;
		const next: MachineUsage = ack.ok
			? {
					checkedAt: now,
					report: (ack.data as AntigravityUsageAck | undefined)?.report ?? null,
					unavailable: (ack.data as AntigravityUsageAck | undefined)?.unavailable ?? null,
					error: null,
				}
			: {
					checkedAt: now,
					report: previous?.report ?? null,
					unavailable: previous?.unavailable ?? null,
					error: ack.error,
				};
		this.#set({ antigravity: { ...this.#state.antigravity, [machineId]: next } });
	}

	async #track<T>(key: string, request: Promise<T>): Promise<T> {
		this.#inFlight.set(key, (this.#inFlight.get(key) ?? 0) + 1);
		this.#publishInFlight();
		try {
			return await request;
		} finally {
			const left = (this.#inFlight.get(key) ?? 1) - 1;
			if (left > 0) this.#inFlight.set(key, left);
			else this.#inFlight.delete(key);
			this.#publishInFlight();
		}
	}

	#publishInFlight(): void {
		let pending = 0;
		for (const count of this.#inFlight.values()) pending += count;
		this.#set({ pending, probing: new Set([...this.#inFlight.keys()].filter(k => k !== BROKER_KEY)) });
	}

	#set(patch: Partial<UsageState>): void {
		this.#state = { ...this.#state, ...patch };
		for (const listener of Array.from(this.#listeners)) listener();
	}
}

const stores = new WeakMap<DaemonClient, UsageStore>();

/** The one usage store of a connection (created on first use), so remounting the toolbar keeps what it fetched. */
export function usageOf(client: DaemonClient): UsageStore {
	let store = stores.get(client);
	if (!store) {
		store = new UsageStore(client);
		stores.set(client, store);
	}
	return store;
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
	anthropic: "Claude",
	"openai-codex": "Codex",
	openai: "OpenAI",
	antigravity: "Antigravity",
	"google-antigravity": "Antigravity",
	"google-gemini-cli": "Gemini CLI",
	"github-copilot": "Copilot",
	xai: "Grok",
	zai: "Z.ai",
	cursor: "Cursor",
	kimi: "Kimi",
	minimax: "MiniMax",
	openrouter: "OpenRouter",
};

/** "anthropic" -> "Claude"; an unknown id is shown as it is, capitalized. */
export function providerName(provider: string): string {
	return PROVIDER_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Whether a machine's Antigravity CLI is signed in, as its last quota probe found out. */
export interface SignIn {
	tone: "ok" | "warn" | "bad" | "off";
	/** "Signed in", "Not signed in", … */
	label: string;
	/** Why, or what to do; null when the label says it all. */
	detail: string | null;
}

/** The quota probe reads the same stored sign-in `agy` uses, so its answer is also the sign-in state. */
export function antigravitySignIn(state: MachineUsage | undefined): SignIn {
	if (!state) return { tone: "off", label: "Checking sign-in…", detail: null };
	const failed = state.error ? `Could not check: ${state.error}` : null;
	if (state.report) return { tone: "ok", label: "Signed in", detail: failed };
	switch (state.unavailable?.reason) {
		case "unauthenticated":
			return { tone: "bad", label: "Not signed in", detail: failed };
		case "expired":
			return { tone: "bad", label: "Sign-in expired", detail: state.unavailable.message };
		case "unsupported":
			return { tone: "ok", label: "Not a Google sign-in", detail: state.unavailable.message };
		case "probe_failed":
			return { tone: "warn", label: "Sign-in unverified", detail: state.unavailable.message };
		case undefined:
			return { tone: "warn", label: "Sign-in unknown", detail: failed };
	}
}

/** One account's usage as the usage menu shows it. */
export interface UsageEntry {
	key: string;
	/** The provider id (`anthropic`, `antigravity`); compare with {@link providerName} to match omp's aliases. */
	provider: string;
	/** "Claude", "Claude 2" when the same provider has several accounts. */
	name: string;
	report: UsageReportWire | null;
	/** Where it came from when that is worth saying (the machine of an Antigravity quota). */
	origin: string | null;
	/** Why there is no report, or why the latest refresh failed. */
	note: string | null;
	/** Antigravity only: the sign-in state. */
	signIn: SignIn | null;
	/** Antigravity only: the machines that report this account. */
	machines: string[];
}

/**
 * Each machine's Antigravity quota. Machines signed in to the same Google account report the same quota, so they
 * collapse into one entry with the newest report.
 */
export function antigravityEntries(
	antigravity: Readonly<Record<string, MachineUsage>>,
	machines: readonly MachineSummary[],
): UsageEntry[] {
	const byAccount = new Map<string, { entry: UsageEntry; fetchedAt: number }>();
	for (const machine of machines) {
		const state = antigravity[machine.id];
		if (!state || machine.antigravity?.available !== true) continue;
		const identity = state.report?.identity;
		const key = identity ? `agy:${identity}` : `agy@${machine.id}`;
		const fetchedAt = state.report?.fetchedAt ?? state.checkedAt;
		const prior = byAccount.get(key);
		const names = [...(prior?.entry.machines ?? []), machine.name];
		if (prior && prior.fetchedAt >= fetchedAt) {
			prior.entry.machines = names;
			continue;
		}
		const signIn = antigravitySignIn(state);
		byAccount.set(key, {
			entry: {
				key,
				provider: "antigravity",
				name: providerName("antigravity"),
				report: state.report,
				origin: null,
				note: signIn.detail,
				signIn,
				machines: names,
			},
			fetchedAt,
		});
	}
	const entries = [...byAccount.values()].map(({ entry }): UsageEntry => ({
		...entry,
		origin: entry.machines.join(", "),
	}));
	// The machine name only tells entries apart; a single Antigravity account needs no origin.
	if (entries.length === 1) entries[0]!.origin = null;
	return entries;
}

/** Every account with usage: the broker's reports, then each machine's Antigravity quota. */
export function usageEntries(
	usage: UsageWire,
	antigravity: Readonly<Record<string, MachineUsage>>,
	machines: readonly MachineSummary[],
): UsageEntry[] {
	const entries: UsageEntry[] = usage.reports.map((report, i) => ({
		key: `broker:${i}:${report.provider}:${report.identity ?? ""}`,
		provider: report.provider,
		name: providerName(report.provider),
		report,
		origin: null,
		note: null,
		signIn: null,
		machines: [],
	}));
	entries.push(...antigravityEntries(antigravity, machines));

	const totals = new Map<string, number>();
	for (const e of entries) totals.set(e.name, (totals.get(e.name) ?? 0) + 1);
	const seen = new Map<string, number>();
	return entries.map(e => {
		if ((totals.get(e.name) ?? 0) < 2 || e.origin !== null) return e;
		const n = (seen.get(e.name) ?? 0) + 1;
		seen.set(e.name, n);
		return n === 1 ? e : { ...e, name: `${e.name} ${n}` };
	});
}

/** The limit closest to running out: what an account's ring shows. */
export function peakLimit(report: UsageReportWire | null): UsageLimitWire | null {
	let peak: UsageLimitWire | null = null;
	for (const limit of report?.limits ?? []) {
		if (limit.usedFraction === undefined) continue;
		if (!peak || limit.usedFraction > (peak.usedFraction ?? 0)) peak = limit;
	}
	return peak;
}

/** Ring/percentage colour of a limit: the provider's status, else the same thresholds the probes use. */
export function usageTone(limit: UsageLimitWire | null): "ok" | "warning" | "exhausted" | "unknown" {
	if (!limit || limit.usedFraction === undefined) return "unknown";
	if (limit.status && limit.status !== "unknown") return limit.status;
	return limit.usedFraction >= 1 ? "exhausted" : limit.usedFraction >= 0.8 ? "warning" : "ok";
}
