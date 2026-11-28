/**
 * Credentials: the gateway hosts `omp auth-broker serve`, every environment's omp children read their credentials
 * from it, and the web logs accounts in and out through a dedicated omp RPC process on the gateway machine.
 *
 * Everything here crosses the browser <-> gateway WebSocket as gateway-originated frames (`AuthFrame`) and gateway-handled
 * requests (`AuthMessage`, no machine id: they concern the vault, not an environment), or the gateway <-> env link
 * (`EnvBrokerStatus`, see `link.ts`). No secret is ever part of any of these: not the broker's bearer token, not access
 * or refresh tokens, not API keys. The one value a browser sends upward is the OAuth authorization code or redirect URL
 * the user pastes during a sign-in (single use, bound to the flow's PKCE verifier).
 */

// ---------------------------------------------------------------------------
// The managed broker (gateway machine)
// ---------------------------------------------------------------------------

/**
 * - `disabled`: the gateway was not asked to host a broker (`broker.enabled`); every environment keeps using whatever
 *   credentials omp finds on its own machine.
 * - `starting`: the child was spawned, `/v1/healthz` does not answer yet.
 * - `running`: the child is up (see `healthy` for whether it answers right now).
 * - `restarting`: the child exited or failed to start; the supervisor waits `nextRetryAt` and tries again.
 * - `stopped`: the gateway is shutting down (or stopped it).
 */
export type BrokerPhase = "disabled" | "starting" | "running" | "restarting" | "stopped";

export interface BrokerStatus {
	phase: BrokerPhase;
	/** `/v1/healthz` answered at the last probe. Only meaningful while `phase` is `running`. */
	healthy: boolean;
	/** The broker as the gateway machine reaches it (`http://host:port`); null while disabled. */
	url: string | null;
	/** What the other machines are told to use (`broker.advertiseUrl`, default: `url`); null while disabled. */
	advertisedUrl: string | null;
	/** The configured listen address (`host:port`); null while disabled. */
	bind: string | null;
	/** HOME of the broker process: its credential database and bearer token live under it (`<home>/.omp/...`). */
	home: string | null;
	agentDb: string | null;
	tokenFile: string | null;
	pid: number | null;
	/** `version` of the last `/v1/healthz` answer. */
	version: string | null;
	startedAt: number | null;
	checkedAt: number | null;
	/** Restarts since the gateway started. */
	restarts: number;
	nextRetryAt: number | null;
	/** Why the previous run ended (or why the last start failed): exit status plus the tail of its output. */
	lastError: { message: string; at: number } | null;
}

/**
 * How one environment sees the broker. `source`: where its URL/token came from: `gateway` (handed over the authenticated
 * link), `local` (the machine's own `broker` section in `config.json`), or `none`.
 *
 * - `unconfigured`: no broker configured for this machine; omp uses the credentials on the machine itself.
 * - `ok`: the broker answered and accepted the token at the last probe.
 * - `unreachable`: the broker did not answer. Running omp processes keep the credentials they already hold (omp caches
 *   the broker's snapshot for up to an hour), but new ones may not start and tokens that expire cannot be refreshed.
 * - `unauthorized`: the broker answered but rejected the token (it was regenerated, or the machine has a stale one).
 * - `withheld`: the gateway has a broker but this machine did not take its credentials: the link to the gateway is
 *   plain `ws://` over an address that is not loopback or the tailnet, so handing a bearer token over it would expose it.
 */
export type EnvBrokerState = "unconfigured" | "ok" | "unreachable" | "unauthorized" | "withheld";

export interface EnvBrokerStatus {
	source: "none" | "gateway" | "local";
	state: EnvBrokerState;
	/** The broker URL this machine uses (never the token). */
	url?: string;
	/** Human-readable cause for every state but `ok` / `unconfigured`. */
	message?: string;
	checkedAt: number | null;
	lastOkAt: number | null;
}

/** What the gateway hands an environment over the link (`broker.config`): never shown to a browser, never logged. */
export interface BrokerLinkConfig {
	url: string;
	token: string;
}

// ---------------------------------------------------------------------------
// Providers and accounts
// ---------------------------------------------------------------------------

/**
 * How a provider signs in, from upstream's provider catalog:
 * - `oauth`: authorization-code flow; the user opens a link and the browser is redirected back (or pastes the redirect URL);
 * - `device`: the user opens a link and enters a code shown by the provider;
 * - `api-key`: the user pastes an API key. omp-web never accepts that: it is a secret (see `terminalCommand`);
 * - `custom`: provider-specific flow (may ask for things RPC cannot carry; the flow reports it if so);
 * - `unknown`: the installed omp knows a provider this build's catalog does not.
 */
export type LoginKind = "oauth" | "device" | "api-key" | "custom" | "unknown";

export interface LoginProviderWire {
	id: string;
	name: string;
	available: boolean;
	/** The vault holds at least one credential (or an env var / config key supplies one) for this provider. */
	authenticated: boolean;
	kind: LoginKind;
	/** Exact command to run on the gateway machine for providers the web does not sign in (`api-key`, `custom`). */
	terminalCommand?: string;
}

export interface AccountWire {
	provider: string;
	providerName: string;
	/** The broker's row id; only meaningful for `auth.logout`, never a stable cross-machine identity. */
	credentialId: number;
	/** omp's own label: email, account id, project, or `API key #n`. */
	label: string;
	detail: string;
	type: "oauth" | "api_key";
	/** Epoch ms of the interactive OAuth authorization, when the broker knows it. */
	authorizedAt?: number;
	/** The account omp currently serves requests from for this provider. */
	active: boolean;
}

/** A credential the broker disabled (a refresh failed for good, a token was revoked): the user has to sign in again. */
export interface DisabledAccountWire {
	provider: string;
	type: "oauth" | "api_key";
	label: string;
	cause: string;
	disabledAt: number | null;
}

/**
 * Local credentials on the gateway machine that the broker does not hold (see `migrate --from-local`). Detected from
 * non-secret columns only (provider, type, identity key); nothing is migrated automatically.
 */
export interface MigrationWire {
	/** `available`: there are rows to migrate. `none`: nothing to migrate. `same`: the broker serves that very database. */
	state: "available" | "none" | "same";
	/** The local credential database that was inspected. */
	localDb: string;
	entries: { provider: string; type: "oauth" | "api_key"; identity: string }[];
	/** Dry-run first, exactly as typed on the gateway machine. */
	dryRunCommand: string;
	/** The real thing (what to run after reading the dry run). */
	command: string;
	/** Why OAuth rows are only included with an explicit flag, in words. */
	note: string;
}

// ---------------------------------------------------------------------------
// The login flow (one at a time, visible to every client)
// ---------------------------------------------------------------------------

export type LoginStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * - `secret_input`: the provider asked for a typed credential (an API key or a password): refused, nothing was accepted;
 * - `unsupported`: the provider needs something RPC cannot carry (an interactive prompt before the sign-in link);
 * - `broker`: the vault is not reachable, so there is nowhere to store a credential;
 * - `provider`: the provider or omp reported an error (the message is omp's).
 */
export type LoginFailureKind = "secret_input" | "unsupported" | "broker" | "provider";

export interface LoginFlowWire {
	/** Changes with every new flow; requests that name an older id are refused. */
	id: string;
	providerId: string;
	providerName: string;
	startedAt: number;
	status: LoginStatus;
	/** The sign-in link omp asked the user to open. http(s) only. The web shows it as a link, never navigates. */
	link: { url: string; launchUrl?: string; instructions?: string } | null;
	/**
	 * The authorization code / redirect URL prompt, once omp asked for it. `submitted`: somebody (any client) already
	 * answered; the first answer wins and omp is waiting for the provider.
	 */
	prompt: { id: string; title: string; placeholder?: string; submitted: boolean } | null;
	/** omp's progress lines, newest last (bounded). */
	progress: string[];
	failure: { kind: LoginFailureKind; message: string; terminalCommand?: string } | null;
	/** Set on success: the account omp stored (its label), when it reported one. */
	identity?: string;
	endedAt: number | null;
}

// ---------------------------------------------------------------------------
// Usage (`/v1/usage` of the broker)
// ---------------------------------------------------------------------------

export interface UsageLimitWire {
	id: string;
	label: string;
	/** `5 Hour`, `7 Day`, … */
	windowLabel?: string;
	windowId?: string;
	durationMs?: number;
	/** Epoch ms the window resets. */
	resetsAt?: number;
	/** 0..1 (above 1: overage), from whichever amount fields the provider filled. */
	usedFraction?: number;
	status?: "ok" | "warning" | "exhausted" | "unknown";
	used?: number;
	limit?: number;
	unit: string;
	modelId?: string;
	tier?: string;
	notes?: string[];
}

export interface UsageReportWire {
	provider: string;
	fetchedAt: number;
	/** Who the report is for, as the provider reported it (email, else account id). */
	identity?: string;
	orgName?: string;
	planType?: string;
	/**
	 * `credentialPinHash`es the report's account may carry in a session's `credential_pin` (see `SessionStatus.pins`):
	 * the full identity, and without org/project in case the report and the credential disagree on those.
	 */
	pinHashes?: string[];
	resetCredits?: {
		availableCount: number;
		redeemableCount?: number;
		credits?: { expiresAt: string }[];
	};
	limits: UsageLimitWire[];
	notes?: string[];
}

export interface UsageWire {
	/** When the gateway last asked the broker (epoch ms); null before the first request. */
	fetchedAt: number | null;
	/** The broker's own `generatedAt` of the answer. */
	generatedAt: number | null;
	reports: UsageReportWire[];
	/** The broker could not be asked, or answered an error; the previous reports are kept. */
	error: string | null;
}

// ---------------------------------------------------------------------------
// Frames and requests
// ---------------------------------------------------------------------------

/** What the Accounts page needs about providers and accounts, replaced wholesale on every change. */
export interface AuthAccountsWire {
	/** Null until the first successful listing. */
	providers: LoginProviderWire[] | null;
	accounts: AccountWire[];
	disabled: DisabledAccountWire[];
	/** Why the listing failed (the previous lists are kept); null when it succeeded. */
	error: string | null;
	loadedAt: number | null;
	migration: MigrationWire | null;
}

export type AuthFrame =
	| { t: "auth.broker"; broker: BrokerStatus }
	| ({ t: "auth.accounts" } & AuthAccountsWire)
	| { t: "auth.flow"; flow: LoginFlowWire | null }
	| ({ t: "auth.usage" } & UsageWire);

export type AuthMessage =
	/** The Accounts page is open (true) or closed on this connection. While any is open the gateway keeps the lists and usage fresh. */
	| { t: "auth.watch"; reqId: string; open: boolean }
	/** Reloads providers and accounts now. */
	| { t: "auth.refresh"; reqId: string }
	/** Asks the broker for usage now (rate limited by the gateway). */
	| { t: "auth.usage.refresh"; reqId: string }
	/** Starts a sign-in. Refused while another flow runs. Acks `{ flowId }`. */
	| { t: "auth.login.start"; reqId: string; providerId: string }
	/** Answers the flow's authorization-code prompt. The first answer wins; later ones are refused. */
	| { t: "auth.login.input"; reqId: string; flowId: string; promptId: string; value: string }
	/** Cancels the running flow (the gateway stops the omp process driving it). */
	| { t: "auth.login.cancel"; reqId: string; flowId: string }
	/** Clears a finished flow from every client's view. */
	| { t: "auth.login.dismiss"; reqId: string; flowId: string }
	| { t: "auth.logout"; reqId: string; providerId: string; credentialId: number };

/** The longest authorization code / redirect URL the gateway forwards (real ones are a few hundred bytes). */
export const MAX_LOGIN_INPUT_CHARS = 4096;
