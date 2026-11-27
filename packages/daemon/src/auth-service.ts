import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
	AccountWire,
	AuthAccountsWire,
	AuthFrame,
	AuthMessage,
	BrokerLinkConfig,
	BrokerStatus,
	DisabledAccountWire,
	LoginFlowWire,
	LoginKind,
	LoginProviderWire,
	UsageWire,
} from "@omp-web/protocol";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AuthPort } from "./gateway";
import type { AuthProcess, LoginEvent, LoginProviderInfo, LoginRun } from "./auth-process";
import { parseUsageResponse } from "./broker-usage";
import type { BrokerSupervisor } from "./broker-supervisor";
import {
	brokerCliCommand,
	loginKindOf,
	posixQuote,
	webSignInAllowed,
	type CliContext,
	type CliShell,
} from "./login-kinds";
import { detectMigration } from "./migration";

type BrokerFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What the service uses of the managed broker (`BrokerSupervisor`; tests pass a stand-in). */
export type BrokerControl = Pick<BrokerSupervisor, "status" | "token" | "url" | "advertisedUrl" | "onChange" | "stop">;

export interface AuthServiceOptions {
	/** The managed broker; null when the gateway does not host one (the service then only reports `disabled`). */
	supervisor: BrokerControl | null;
	/** Machine id of the gateway's own environment: it reaches the broker locally, the others through the advertised URL. */
	selfMachineId: string;
	/** Sends a frame to every connected browser. */
	publish(frame: AuthFrame): void;
	/** The broker URL/token machines should use changed: tell the linked daemons. */
	brokerConfigChanged(): void;
	/** Starts the omp RPC process for credential work with this environment (the daemon's own plus the broker's URL and token). */
	createProcess(env: Record<string, string | undefined>): Promise<AuthProcess>;
	/** The environment of the gateway process, as omp children get it. */
	baseEnv?: Record<string, string | undefined>;
	/** `<agent dir>/agent.db` of this machine's own omp, for the `migrate --from-local` guide; null: no guide. */
	localAgentDb: string | null;
	/** The user's home directory (a broker whose HOME is that needs no environment override in the commands we print). */
	userHome: string;
	platform?: NodeJS.Platform;
	fetch?: BrokerFetch;
	now?: () => number;
	/** Housekeeping period while a browser has the Accounts page open (default 5 s). */
	tickMs?: number;
	/** How stale the lists may get while the page is open (default 30 s). */
	accountsRefreshMs?: number;
	/** How stale the usage may get while the page is open (default 5 min). */
	usageRefreshMs?: number;
	/** Shortest time between two broker usage requests (default 15 s). */
	usageMinIntervalMs?: number;
}

/** A sign-in in progress (or just finished) and the process that drives it. */
interface Flow {
	wire: LoginFlowWire;
	kind: LoginKind;
	process: AuthProcess;
	run: LoginRun | null;
	finished: boolean;
}

const MAX_PROGRESS = 8;
const USAGE_TIMEOUT_MS = 30_000;
const EMPTY_ACCOUNTS: AuthAccountsWire = {
	providers: null,
	accounts: [],
	disabled: [],
	error: null,
	loadedAt: null,
	migration: null,
};

const safeId = /^[\w.-]+$/;
const quoteArg = (value: string): string => (safeId.test(value) ? value : posixQuote(value));

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Credential management on the gateway: the managed broker's status, a long-lived omp RPC process that lists and
 * edits accounts and drives sign-ins, the broker's usage, and the `migrate --from-local` guide, all published to every
 * browser. Sign-ins are one at a time and visible to everyone: the flow lives here, not in a page, so it survives a
 * browser reconnecting, any client may answer or cancel it, and the first answer wins.
 *
 * What the browser can send is deliberately narrow: an OAuth authorization code or redirect URL (single use, bound to the
 * flow's PKCE verifier), never an API key or any other secret. Prompts for typed secrets are refused here, whatever the
 * provider, and the flow ends with the exact terminal command to run on the gateway machine instead.
 */
export class AuthService implements AuthPort {
	readonly #options: AuthServiceOptions;
	readonly #supervisor: BrokerControl | null;
	readonly #fetch: BrokerFetch;
	readonly #now: () => number;
	readonly #watchers = new Set<object>();
	#accounts: AuthAccountsWire = EMPTY_ACCOUNTS;
	#usage: UsageWire = { fetchedAt: null, generatedAt: null, reports: [], error: null };
	#flow: Flow | null = null;
	#process: Promise<AuthProcess> | null = null;
	#refreshing: Promise<void> | null = null;
	#usageFetching: Promise<void> | null = null;
	#lastUsageAttempt = 0;
	#timer: NodeJS.Timeout | null = null;
	#pushedConfig = "";
	#lastPhase: BrokerStatus["phase"];
	#unsubscribe: (() => void) | null = null;
	/** Sign-in aliases whose credentials are stored under another provider (`openai-codex-device` -> `openai-codex`), as of the last listing. */
	#storedAs = new Map<string, string>();
	#stopped = false;
	/** A sign-in is between its checks and the omp process it will run in: the idle process must not be replaced now. */
	#startingLogin = false;

	constructor(options: AuthServiceOptions) {
		this.#options = options;
		this.#supervisor = options.supervisor;
		this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.#now = options.now ?? Date.now;
		this.#lastPhase = this.#brokerStatus().phase;
	}

	/** Starts following the broker supervisor. The supervisor itself is started by the caller. */
	start(): void {
		this.#unsubscribe = this.#supervisor?.onChange(() => this.#brokerChanged()) ?? null;
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#unsubscribe?.();
		clearInterval(this.#timer ?? undefined);
		this.#timer = null;
		const process = this.#process;
		this.#process = null;
		if (process)
			await process.then(
				p => p.stop(),
				() => {},
			);
		await this.#supervisor?.stop();
	}

	// -- AuthPort ------------------------------------------------------------

	frames(): AuthFrame[] {
		return [
			{ t: "auth.broker", broker: this.#brokerStatus() },
			{ t: "auth.accounts", ...this.#accounts },
			{ t: "auth.flow", flow: this.#flow?.wire ?? null },
			{ t: "auth.usage", ...this.#usage },
		];
	}

	brokerConfigFor(machineId: string): BrokerLinkConfig | null {
		const supervisor = this.#supervisor;
		const token = supervisor?.token;
		if (!supervisor || !token) return null;
		return { url: machineId === this.#options.selfMachineId ? supervisor.url : supervisor.advertisedUrl, token };
	}

	released(connection: object): void {
		this.#watchers.delete(connection);
		if (this.#watchers.size === 0) {
			clearInterval(this.#timer ?? undefined);
			this.#timer = null;
		}
	}

	async handle(connection: object, message: AuthMessage): Promise<unknown> {
		switch (message.t) {
			case "auth.watch":
				if (message.open) {
					this.#watchers.add(connection);
					this.#startTicking();
					void this.#opened();
				} else {
					this.released(connection);
				}
				return {};
			case "auth.refresh":
				this.#requireBroker();
				await this.#refreshAccounts();
				if (this.#accounts.error !== null) throw new Error(this.#accounts.error);
				return {};
			case "auth.usage.refresh": {
				this.#requireBroker();
				const wait = this.#lastUsageAttempt + (this.#options.usageMinIntervalMs ?? 15_000) - this.#now();
				if (wait > 0) return { refreshed: false, retryInMs: wait };
				await this.#fetchUsage();
				return { refreshed: true };
			}
			case "auth.login.start":
				return { flowId: await this.#startLogin(message.providerId) };
			case "auth.login.input":
				this.#answer(message.flowId, message.promptId, message.value);
				return {};
			case "auth.login.cancel":
				await this.#cancel(message.flowId);
				return {};
			case "auth.login.dismiss":
				this.#dismiss(message.flowId);
				return {};
			case "auth.logout":
				return await this.#logout(message.providerId, message.credentialId);
		}
	}

	// -- broker --------------------------------------------------------------

	#brokerStatus(): BrokerStatus {
		if (this.#supervisor) return this.#supervisor.status();
		return {
			phase: "disabled",
			healthy: false,
			url: null,
			advertisedUrl: null,
			bind: null,
			home: null,
			agentDb: null,
			tokenFile: null,
			pid: null,
			version: null,
			startedAt: null,
			checkedAt: null,
			restarts: 0,
			nextRetryAt: null,
			lastError: null,
		};
	}

	#requireBroker(): BrokerStatus {
		const status = this.#brokerStatus();
		if (status.phase === "disabled") {
			throw new Error(
				"the auth broker is not enabled on this gateway: start omp-webd with --broker (or broker.enabled in config.json), see README.md",
			);
		}
		return status;
	}

	/** The running broker's URL and token, or why there is none right now. */
	#requireRunning(): { url: string; token: string } {
		const status = this.#requireBroker();
		const token = this.#supervisor?.token;
		if (status.phase !== "running" || !status.healthy || !token || !this.#supervisor) {
			const why = status.lastError ? `: ${status.lastError.message}` : "";
			throw new Error(`the auth broker is not running (${status.phase}${why})`);
		}
		return { url: this.#supervisor.url, token };
	}

	#brokerChanged(): void {
		if (this.#stopped) return;
		const status = this.#brokerStatus();
		this.#options.publish({ t: "auth.broker", broker: status });
		const config = this.#supervisor?.token ? `${this.#supervisor.advertisedUrl}\0${this.#supervisor.token}` : "";
		if (config !== this.#pushedConfig) {
			this.#pushedConfig = config;
			this.#options.brokerConfigChanged();
		}
		const previous = this.#lastPhase;
		this.#lastPhase = status.phase;
		if (previous === "running" && status.phase !== "running") this.#brokerLost(status);
		else if (previous !== "running" && status.phase === "running" && this.#watchers.size > 0) void this.#opened(true);
	}

	/** The broker went away: whatever the omp process holds of it is stale, and a sign-in in progress cannot finish. */
	#brokerLost(status: BrokerStatus): void {
		const flow = this.#flow;
		if (flow && !flow.finished) {
			this.#end(flow, "failed", {
				failure: {
					kind: "broker",
					message: `The auth broker stopped while signing in (${status.lastError?.message ?? status.phase}). Nothing was stored.`,
				},
			});
		}
		void this.#dropProcess();
	}

	// -- the omp RPC process -------------------------------------------------

	#ensureProcess(): Promise<AuthProcess> {
		if (this.#process) return this.#process;
		const { url, token } = this.#requireRunning();
		const env = { ...(this.#options.baseEnv ?? Bun.env), OMP_AUTH_BROKER_URL: url, OMP_AUTH_BROKER_TOKEN: token };
		const starting = this.#options.createProcess(env).then(process => {
			process.onExit(reason => {
				if (this.#process === starting) this.#process = null;
				const flow = this.#flow;
				if (flow?.process === process && !flow.finished) {
					this.#end(flow, "failed", {
						failure: { kind: "provider", message: `The omp process driving the sign-in ended: ${reason}` },
					});
				}
			});
			return process;
		});
		this.#process = starting;
		starting.catch(() => {
			if (this.#process === starting) this.#process = null;
		});
		return starting;
	}

	async #dropProcess(): Promise<void> {
		const process = this.#process;
		this.#process = null;
		if (process)
			await process.then(
				p => p.kill(),
				() => {},
			);
	}

	// -- accounts ------------------------------------------------------------

	#cli(): CliContext | null {
		const status = this.#brokerStatus();
		if (!this.#supervisor || status.home === null) return null;
		return {
			platform: this.#options.platform ?? process.platform,
			brokerHome: status.home === this.#options.userHome ? null : status.home,
			brokerUrl: this.#supervisor.url,
			tokenFile: status.tokenFile ?? join(status.home, ".omp", "auth-broker.token"),
		};
	}

	#terminalCommand(providerId: string): string | undefined {
		const cli = this.#cli();
		return cli ? brokerCliCommand(`login ${quoteArg(providerId)}`, cli) : undefined;
	}

	/**
	 * Where the gateway machine's "Open in terminal" for `providerId` starts and what it types: a shell in the broker's home
	 * with the same command the Accounts page prints (HOME of the broker in front, so omp opens the broker's own
	 * `agent.db`), typed but not run. Null when this gateway hosts no broker. The client only names the provider.
	 */
	brokerLoginTerminal(providerId: string, shell?: CliShell): { cwd: string; input: string } | null {
		const cli = this.#cli();
		const home = this.#brokerStatus().home;
		if (!cli || home === null) return null;
		return { cwd: home, input: brokerCliCommand(`login ${quoteArg(providerId)}`, { ...cli, shell }) };
	}

	#providerWire(info: LoginProviderInfo): LoginProviderWire {
		const kind = loginKindOf(info.id);
		const terminal = kind === "api-key" || kind === "custom" ? this.#terminalCommand(info.id) : undefined;
		return {
			id: info.id,
			name: info.name,
			available: info.available,
			authenticated: info.authenticated,
			kind,
			...(terminal ? { terminalCommand: terminal } : {}),
		};
	}

	/** The Accounts page opened (or the broker came back while one is open): bring the lists up to date unless they just were. */
	#opened(force = false): Promise<void> {
		const tasks: Promise<void>[] = [];
		if (this.#brokerStatus().phase === "running") {
			if (force || this.#accounts.loadedAt === null || this.#now() - this.#accounts.loadedAt > 3_000) {
				tasks.push(this.#refreshAccounts());
			}
			if (this.#usage.fetchedAt === null || this.#now() - this.#usage.fetchedAt > 60_000) {
				tasks.push(this.#fetchUsage().catch(() => {}));
			}
		} else if (this.#brokerStatus().phase !== "disabled") {
			this.#setAccounts({ error: `the auth broker is not running (${this.#brokerStatus().phase})` });
		}
		return Promise.all(tasks).then(() => {});
	}

	#startTicking(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => void this.#tick(), this.#options.tickMs ?? 5_000);
		this.#timer.unref?.();
	}

	/** Housekeeping while somebody has the Accounts page open: keep the lists and the usage from going stale, boundedly. */
	async #tick(): Promise<void> {
		if (this.#watchers.size === 0 || this.#brokerStatus().phase !== "running") return;
		const now = this.#now();
		const tasks: Promise<void>[] = [];
		if (
			this.#accounts.loadedAt === null ||
			now - this.#accounts.loadedAt >= (this.#options.accountsRefreshMs ?? 30_000)
		) {
			tasks.push(this.#refreshAccounts());
		}
		if (this.#usage.fetchedAt === null || now - this.#usage.fetchedAt >= (this.#options.usageRefreshMs ?? 300_000)) {
			tasks.push(this.#fetchUsage().catch(() => {}));
		}
		await Promise.all(tasks);
	}

	#setAccounts(patch: Partial<AuthAccountsWire>): void {
		this.#accounts = { ...this.#accounts, ...patch };
		this.#options.publish({ t: "auth.accounts", ...this.#accounts });
	}

	/** Reloads providers and accounts from omp (through the broker) plus the broker's disabled rows; failures keep the old lists. */
	#refreshAccounts(): Promise<void> {
		this.#refreshing ??= this.#loadAccounts().finally(() => {
			this.#refreshing = null;
		});
		return this.#refreshing;
	}

	async #loadAccounts(): Promise<void> {
		try {
			const { url, token } = this.#requireRunning();
			// omp's view of the broker is a snapshot it follows lazily: an account added or removed outside this page (`omp
			// auth-broker login|import|logout` on the gateway machine, another machine) only shows after a fresh process
			// (found by the smoke: an imported account did not appear for a minute). A fresh process is cheap (~0.2 s) and the
			// refresh is bounded, so the idle process is replaced; one that drives a sign-in is left alone.
			if (!this.#startingLogin && (!this.#flow || this.#flow.finished)) await this.#dropProcess();
			const process = await this.#ensureProcess();
			const infos = await process.providers();
			const providers = infos.map(info => this.#providerWire(info));
			const accounts: AccountWire[] = [];
			const storedAs = new Map<string, string>();
			const authorized = await this.#loadAuthorizationDates(url, token).catch(() => new Map<string, number>());
			const seen = new Set<string>();
			for (const provider of providers) {
				if (!provider.authenticated) continue;
				for (const account of await process.accounts(provider.id)) {
					// `account.provider` is the provider the credential is stored under: a sign-in alias (`openai-codex-device` ->
					// `openai-codex`, omp's `store-as`) lists the very rows of its target, so one row is reached from every alias.
					if (account.provider !== provider.id) storedAs.set(provider.id, account.provider);
					const key = `${account.provider}\0${account.credentialId}`;
					if (seen.has(key)) continue;
					seen.add(key);
					accounts.push({
						provider: account.provider,
						providerName: providers.find(p => p.id === account.provider)?.name ?? provider.name,
						credentialId: account.credentialId,
						label: account.label,
						detail: account.detail,
						type: account.type,
						active: account.active,
						...(authorized.has(key) ? { authorizedAt: authorized.get(key)! } : {}),
					});
				}
			}
			this.#storedAs = storedAs;
			const disabled = await this.#loadDisabled(url, token, providers).catch(() => []);
			this.#setAccounts({
				providers,
				accounts,
				disabled,
				error: null,
				loadedAt: this.#now(),
				migration: this.#migration(),
			});
		} catch (error) {
			this.#setAccounts({ error: describe(error) });
		}
	}

	/** Read only the login timestamp; snapshot tokens never enter browser state. */
	async #loadAuthorizationDates(url: string, token: string): Promise<Map<string, number>> {
		const response = await this.#fetch(`${url}/v1/snapshot`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body: unknown = await response.json();
		const dates = new Map<string, number>();
		if (!isRecord(body) || !Array.isArray(body.credentials)) return dates;
		for (const row of body.credentials) {
			if (!isRecord(row) || !isRecord(row.credential)) continue;
			const at = row.credential.authorizedAt;
			if (
				typeof row.provider === "string" &&
				typeof row.id === "number" &&
				typeof at === "number" &&
				Number.isFinite(at)
			) {
				dates.set(`${row.provider}\0${row.id}`, at);
			}
		}
		return dates;
	}

	async #loadDisabled(url: string, token: string, providers: LoginProviderWire[]): Promise<DisabledAccountWire[]> {
		const response = await this.#fetch(`${url}/v1/credentials/disabled`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body: unknown = await response.json();
		if (!isRecord(body) || !Array.isArray(body.disabled)) return [];
		const out: DisabledAccountWire[] = [];
		for (const row of body.disabled) {
			if (!isRecord(row) || typeof row.provider !== "string" || typeof row.cause !== "string") continue;
			const label =
				[row.email, row.accountId, `credential #${String(row.id)}`].find(v => typeof v === "string" && v !== "") ??
				"credential";
			const org = typeof row.orgName === "string" && row.orgName !== "" ? ` (${row.orgName})` : "";
			out.push({
				provider: providers.find(p => p.id === row.provider)?.name ?? row.provider,
				type: row.type === "api_key" ? "api_key" : "oauth",
				label: `${String(label)}${org}`,
				cause: row.cause,
				disabledAt: typeof row.disabledAtMs === "number" ? row.disabledAtMs : null,
			});
		}
		return out;
	}

	#migration(): AuthAccountsWire["migration"] {
		const cli = this.#cli();
		const brokerDb = this.#brokerStatus().agentDb;
		if (!cli || !brokerDb || !this.#options.localAgentDb) return null;
		try {
			return detectMigration({ localDb: this.#options.localAgentDb, brokerDb, cli });
		} catch {
			return null; // an unreadable database is not worth a failed listing
		}
	}

	// -- usage ---------------------------------------------------------------

	/** Asks the broker's `/v1/usage` (the broker caches provider probes for 5 minutes itself). The old reports stay on failure. */
	#fetchUsage(): Promise<void> {
		this.#usageFetching ??= this.#loadUsage().finally(() => {
			this.#usageFetching = null;
		});
		return this.#usageFetching;
	}

	async #loadUsage(): Promise<void> {
		this.#lastUsageAttempt = this.#now();
		try {
			const { url, token } = this.#requireRunning();
			const response = await this.#fetch(`${url}/v1/usage`, {
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`the broker answered HTTP ${response.status} to /v1/usage`);
			const parsed = parseUsageResponse(await response.json());
			this.#usage = {
				fetchedAt: this.#now(),
				generatedAt: parsed.generatedAt,
				reports: parsed.reports,
				error: null,
			};
		} catch (error) {
			this.#usage = { ...this.#usage, fetchedAt: this.#usage.fetchedAt, error: describe(error) };
		}
		this.#options.publish({ t: "auth.usage", ...this.#usage });
	}

	// -- the login flow ------------------------------------------------------

	#publishFlow(): void {
		this.#options.publish({ t: "auth.flow", flow: this.#flow?.wire ?? null });
	}

	/** Ends a flow once: the first of done / failure / cancel / refusal wins, later ones are ignored. */
	#end(flow: Flow, status: LoginFlowWire["status"], patch: Partial<LoginFlowWire> = {}): boolean {
		if (flow.finished) return false;
		flow.finished = true;
		flow.wire = { ...flow.wire, ...patch, status, prompt: null, endedAt: this.#now() };
		if (this.#flow === flow) this.#publishFlow();
		return true;
	}

	async #startLogin(providerId: string): Promise<string> {
		this.#requireBroker();
		if (this.#flow && !this.#flow.finished) {
			const running = this.#flow.wire;
			throw new Error(
				`a sign-in for ${running.providerName} is already in progress (started ${new Date(running.startedAt).toISOString()}): finish or cancel it first`,
			);
		}
		if (this.#accounts.providers === null) await this.#refreshAccounts();
		const provider = this.#accounts.providers?.find(p => p.id === providerId);
		if (!provider)
			throw new Error(`unknown provider: ${providerId}${this.#accounts.error ? ` (${this.#accounts.error})` : ""}`);
		if (!provider.available) throw new Error(`${provider.name} is not available for sign-in in this omp`);
		if (!webSignInAllowed(provider.kind)) {
			const command = this.#terminalCommand(providerId);
			throw new Error(
				`${provider.name} signs in with a pasted API key, which omp-web does not accept through the browser (a key typed into a web page is a secret in transit and in the page). ` +
					(command
						? `Run this on the gateway machine instead: ${command}`
						: "Sign in with `omp auth-broker login` on the gateway machine."),
			);
		}
		this.#startingLogin = true;
		let process: AuthProcess;
		try {
			process = await this.#ensureProcess();
		} finally {
			this.#startingLogin = false;
		}
		const flow: Flow = {
			kind: provider.kind,
			process,
			run: null,
			finished: false,
			wire: {
				id: randomUUID(),
				providerId,
				providerName: provider.name,
				startedAt: this.#now(),
				status: "running",
				link: null,
				prompt: null,
				progress: [],
				failure: null,
				endedAt: null,
			},
		};
		this.#flow = flow;
		this.#publishFlow();
		const stored = this.#storedAs.get(providerId) ?? providerId; // an alias (`openai-codex-device`) stores under its target
		const before = new Set(this.#accounts.accounts.filter(a => a.provider === stored).map(a => a.credentialId));
		flow.run = process.login(providerId, event => this.#onLoginEvent(flow, event));
		flow.run.done.then(
			() => void this.#loginSucceeded(flow, before),
			error => this.#loginFailed(flow, error),
		);
		return flow.wire.id;
	}

	#onLoginEvent(flow: Flow, event: LoginEvent): void {
		if (flow.finished) return;
		switch (event.kind) {
			case "link":
				flow.wire = {
					...flow.wire,
					link: { url: event.url, launchUrl: event.launchUrl, instructions: event.instructions },
				};
				break;
			case "progress":
				flow.wire = {
					...flow.wire,
					progress: [
						...flow.wire.progress,
						`${event.level === "info" ? "" : `${event.level}: `}${event.message}`,
					].slice(-MAX_PROGRESS),
				};
				break;
			case "prompt_cancelled":
				if (flow.wire.prompt?.id === event.id) flow.wire = { ...flow.wire, prompt: null };
				break;
			case "unsupported":
				this.#refuse(
					flow,
					"unsupported",
					`${flow.wire.providerName} asks for input (${event.method}) that RPC sign-in cannot carry.`,
				);
				return;
			case "prompt":
				// The authorization code (or the redirect URL carrying it) of an OAuth sign-in is the only thing a browser may
				// type: it is single-use and tied to the flow's PKCE verifier. Anything else a provider asks for is a typed
				// credential (an API key, a password): refused here whatever the provider claims, and `secret` ones always.
				if (event.secret || flow.kind !== "oauth" || flow.wire.link === null) {
					this.#refuse(
						flow,
						"secret_input",
						`${flow.wire.providerName} asks you to type a credential ("${event.title.slice(0, 120)}"). omp-web does not accept API keys or other secrets through the browser, so nothing was asked of you and nothing was stored.`,
					);
					return;
				}
				flow.wire = {
					...flow.wire,
					prompt: { id: event.id, title: event.title, placeholder: event.placeholder, submitted: false },
				};
				break;
		}
		this.#publishFlow();
	}

	/** Ends the flow as failed and drops the omp process, so no provider flow keeps waiting for what was refused. */
	#refuse(flow: Flow, kind: "secret_input" | "unsupported", message: string): void {
		const terminalCommand = this.#terminalCommand(flow.wire.providerId);
		if (!this.#end(flow, "failed", { failure: { kind, message, ...(terminalCommand ? { terminalCommand } : {}) } }))
			return;
		void this.#dropProcess();
	}

	async #loginSucceeded(flow: Flow, before: Set<number>): Promise<void> {
		if (flow.finished) return;
		await this.#refreshAccounts();
		const stored = this.#storedAs.get(flow.wire.providerId) ?? flow.wire.providerId; // read after the refresh: it learns aliases
		const added = this.#accounts.accounts.find(a => a.provider === stored && !before.has(a.credentialId));
		const label = added?.label ?? this.#accounts.accounts.find(a => a.provider === stored && a.active)?.label;
		this.#end(flow, "succeeded", label ? { identity: label } : {});
	}

	#loginFailed(flow: Flow, error: unknown): void {
		if (flow.finished) return; // cancelled or refused: that outcome stands
		const message = describe(error);
		const status = this.#brokerStatus();
		if (/requires secret input/i.test(message)) {
			this.#refuse(
				flow,
				"secret_input",
				`${flow.wire.providerName} asks for a typed credential, which RPC sign-in refuses (${message}).`,
			);
		} else if (/requires interactive prompts/i.test(message)) {
			this.#refuse(
				flow,
				"unsupported",
				`${flow.wire.providerName} needs input before it can show a sign-in link: ${message}`,
			);
		} else if (status.phase !== "running" || !status.healthy) {
			this.#end(flow, "failed", {
				failure: {
					kind: "broker",
					message: `The auth broker is not reachable, so nothing could be stored: ${message}`,
				},
			});
		} else {
			this.#end(flow, "failed", { failure: { kind: "provider", message } });
		}
	}

	#answer(flowId: string, promptId: string, value: string): void {
		const flow = this.#flow;
		if (!flow || flow.wire.id !== flowId) throw new Error("that sign-in is no longer the current one");
		if (flow.finished) throw new Error("that sign-in has already ended");
		const prompt = flow.wire.prompt;
		if (!prompt || prompt.id !== promptId) throw new Error("this sign-in is not asking for anything (any more)");
		if (prompt.submitted)
			throw new Error("somebody already submitted the code for this sign-in; waiting for the provider");
		if (value.trim() === "") throw new Error("paste the authorization code or the full redirect URL");
		// First answer wins: mark it before anything else can interleave.
		flow.wire = { ...flow.wire, prompt: { ...prompt, submitted: true } };
		try {
			flow.run?.answer(prompt.id, { value: value.trim() });
		} catch (error) {
			this.#end(flow, "failed", {
				failure: { kind: "provider", message: `Could not hand the code to omp: ${describe(error)}` },
			});
			return;
		}
		this.#publishFlow();
	}

	async #cancel(flowId: string): Promise<void> {
		const flow = this.#flow;
		if (!flow || flow.wire.id !== flowId) throw new Error("that sign-in is no longer the current one");
		if (flow.finished) return; // already over (somebody else cancelled, or it ended): nothing to do
		this.#end(flow, "cancelled");
		await this.#dropProcess();
	}

	#dismiss(flowId: string): void {
		const flow = this.#flow;
		if (!flow || flow.wire.id !== flowId) return;
		if (!flow.finished) throw new Error("this sign-in is still running: cancel it first");
		this.#flow = null;
		this.#publishFlow();
	}

	async #logout(providerId: string, credentialId: number): Promise<{ remainingSource?: string }> {
		this.#requireRunning();
		if (this.#flow && !this.#flow.finished) throw new Error("a sign-in is in progress: finish or cancel it first");
		const account = this.#accounts.accounts.find(a => a.provider === providerId && a.credentialId === credentialId);
		if (!account) throw new Error("that account is not in the list (reload it): nothing was removed");
		const process = await this.#ensureProcess();
		const result = await process.logout(providerId, credentialId);
		await this.#refreshAccounts();
		return result;
	}
}
