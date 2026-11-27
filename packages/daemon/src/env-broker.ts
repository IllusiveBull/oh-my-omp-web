import type { BrokerLinkConfig, EnvBrokerStatus } from "@omp-web/protocol";
import { isLoopback } from "./secrets";

/**
 * Why a link to the gateway may carry the credential broker's bearer token, or null when it may not.
 *
 * The registration handshake authenticates both ends but does not encrypt the link, and the gateway sends the token over
 * it. So the daemon only accepts it when the link is TLS (`wss://`), loopback, or inside the tailnet (WireGuard encrypts
 * and authenticates every Tailscale packet; recognised by the CGNAT range 100.64.0.0/10, the ULA prefix
 * fd7a:115c:a1e0::/48, or a `*.ts.net` MagicDNS name). Anything else, like `ws://gateway.example.com`, is refused: the
 * machine then needs its own `broker` section in `config.json`. [INFERENCE] that the tailnet encrypts is Tailscale's
 * documented behaviour, not something this project observed.
 */
export function linkProtection(gatewayUrl: string): "tls" | "loopback" | "tailnet" | null {
	let url: URL;
	try {
		url = new URL(gatewayUrl);
	} catch {
		return null;
	}
	if (url.protocol === "wss:") return "tls";
	if (url.protocol !== "ws:") return null;
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (isLoopback(host)) return "loopback";
	const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
	if (v4 && Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127) return "tailnet";
	if (host.startsWith("fd7a:115c:a1e0:")) return "tailnet";
	if (host.endsWith(".ts.net")) return "tailnet";
	return null;
}

type BrokerFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface EnvBrokerOptions {
	/** This machine's own `broker` section: when present it wins over what the gateway hands over. */
	local?: BrokerLinkConfig;
	fetch?: BrokerFetch;
	now?: () => number;
	/** Probe period (default 10 s). */
	intervalMs?: number;
	/** How long one probe may take (default 3 s). */
	timeoutMs?: number;
}

/** The broker an environment's omp children use, and where it came from. */
export interface ActiveBroker extends BrokerLinkConfig {
	source: "gateway" | "local";
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const PROBE_PROVIDER = "omp-web-probe";

/**
 * This machine's view of the credential broker: which one (the local override, else what the gateway handed over), whether
 * it answers and accepts the token, and the environment the omp children get. Nothing is persisted: the token lives in
 * this object and in the children's environment only.
 *
 * Upstream omp caches the broker's credential snapshot (up to an hour), so an unreachable broker does not stop omp
 * processes that started recently, which is exactly why the state is surfaced here instead of being left to show up as
 * an obscure failed turn later.
 */
export class EnvBroker {
	readonly #local: BrokerLinkConfig | undefined;
	readonly #fetch: BrokerFetch;
	readonly #now: () => number;
	readonly #intervalMs: number;
	readonly #timeoutMs: number;
	readonly #listeners = new Set<() => void>();
	#gateway: BrokerLinkConfig | null = null;
	#status: EnvBrokerStatus;
	#lastOkAt: number | null = null;
	#timer: NodeJS.Timeout | null = null;
	#probing: Promise<void> | null = null;
	#generation = 0;

	constructor(options: EnvBrokerOptions = {}) {
		this.#local = options.local;
		this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.#now = options.now ?? Date.now;
		this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#status = this.#idle();
	}

	/** The broker this machine's omp processes use, with where it came from; null = none (omp uses its own credentials). */
	get config(): ActiveBroker | null {
		if (this.#local) return { ...this.#local, source: "local" };
		if (this.#gateway) return { ...this.#gateway, source: "gateway" };
		return null;
	}

	/** Extra environment for an omp child: `OMP_AUTH_BROKER_URL` + `OMP_AUTH_BROKER_TOKEN` (upstream's own variables). */
	childEnv(): Record<string, string> {
		const config = this.config;
		return config ? { OMP_AUTH_BROKER_URL: config.url, OMP_AUTH_BROKER_TOKEN: config.token } : {};
	}

	status(): EnvBrokerStatus {
		return this.#status;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The gateway's `broker.config` (null: it hosts none). Probes at once so the state is current in a moment. */
	setGateway(config: BrokerLinkConfig | null): void {
		const same = this.#gateway?.url === config?.url && this.#gateway?.token === config?.token;
		this.#gateway = config;
		if (same) return;
		this.#generation++;
		if (this.config === null) {
			this.#lastOkAt = null;
			this.#set(this.#idle());
			return;
		}
		void this.probe();
	}

	/** Starts the periodic probe. */
	start(): void {
		this.#timer ??= setInterval(() => void this.probe(), this.#intervalMs);
		this.#timer.unref?.();
		if (this.config !== null) void this.probe();
	}

	stop(): void {
		clearInterval(this.#timer ?? undefined);
		this.#timer = null;
	}

	/** One probe: `/v1/healthz` (no credentials), then a cheap authenticated read to learn whether the token is accepted. */
	probe(): Promise<void> {
		this.#probing ??= this.#probe().finally(() => {
			this.#probing = null;
		});
		return this.#probing;
	}

	async #probe(): Promise<void> {
		const config = this.config;
		if (config === null) return;
		const generation = this.#generation;
		const at = this.#now();
		let result: Pick<EnvBrokerStatus, "state" | "message">;
		try {
			const health = await this.#fetch(`${config.url}/v1/healthz`, { signal: AbortSignal.timeout(this.#timeoutMs) });
			if (!health.ok) {
				result = { state: "unreachable", message: `the broker answered HTTP ${health.status} to /v1/healthz` };
			} else {
				const auth = await this.#fetch(`${config.url}/v1/credentials/disabled?provider=${PROBE_PROVIDER}`, {
					headers: { authorization: `Bearer ${config.token}` },
					signal: AbortSignal.timeout(this.#timeoutMs),
				});
				if (auth.status === 401 || auth.status === 403) {
					result = {
						state: "unauthorized",
						message:
							"the broker rejected this machine's token (it was regenerated, or this machine holds an old one)",
					};
				} else if (auth.status >= 500) {
					result = { state: "unreachable", message: `the broker answered HTTP ${auth.status}` };
				} else {
					result = { state: "ok" };
				}
				await auth.body?.cancel().catch(() => {});
			}
			await health.body?.cancel().catch(() => {});
		} catch (error) {
			result = { state: "unreachable", message: describeFetchError(error) };
		}
		if (generation !== this.#generation) return; // the configuration changed while probing: the newer probe decides
		if (result.state === "ok") this.#lastOkAt = at;
		this.#set({
			source: config.source,
			state: result.state,
			url: config.url,
			...(result.message === undefined ? {} : { message: result.message }),
			checkedAt: at,
			lastOkAt: this.#lastOkAt,
		});
	}

	/**
	 * A clearer error for a failed omp start when this machine cannot use its broker: omp refuses to start without a
	 * usable credential snapshot, with an error that does not say the broker is the problem. Null when it is not.
	 */
	explainSpawnError(error: Error): Error | null {
		const status = this.#status;
		if (status.state !== "unreachable" && status.state !== "unauthorized") return null;
		const where = status.url ? ` at ${status.url}` : "";
		return new Error(
			`${error.message} (this machine cannot use the auth broker${where}: ${status.message ?? status.state}; omp needs ` +
				"its credentials to start unless it still holds a recent cached copy)",
		);
	}

	#idle(): EnvBrokerStatus {
		return { source: "none", state: "unconfigured", checkedAt: null, lastOkAt: null };
	}

	#set(next: EnvBrokerStatus): void {
		const prev = this.#status;
		this.#status = next;
		if (
			prev.state === next.state &&
			prev.source === next.source &&
			prev.url === next.url &&
			prev.message === next.message
		) {
			return;
		}
		for (const listener of this.#listeners) listener();
	}
}

function describeFetchError(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || error.name === "AbortError") return "the broker did not answer in time";
		const code = "code" in error ? error.code : undefined;
		if (code === "ConnectionRefused" || code === "ECONNREFUSED") return "connection refused (is the broker running?)";
		return error.message;
	}
	return String(error);
}
