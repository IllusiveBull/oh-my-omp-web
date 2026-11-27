import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import type { HandoffLimits, PermissionMode } from "@omp-web/protocol";
import { parseBrokerBind } from "./broker-supervisor";
import { DEFAULT_HANDOFF_LIMITS } from "./handoff-gateway";
import { DEFAULT_REPLICA_POLICY, type ReplicaPolicy } from "./env-host";
import { ConfigError, mkdirPrivate } from "./secrets";
import { DEFAULT_RING_CHARS, DEFAULT_SCROLLBACK_LINES, DEFAULT_TERMINAL_MAX } from "./terminal-service";

/**
 * Where `omp-webd` keeps its own files. Secrets (`token`, `machine-keys.json`, `credential`) and `config.json` live in
 * the config dir, state (the gateway database, the project registry, the machine id) in the state dir; both can be
 * moved with `--config-dir` / `--state-dir`.
 */
export interface Dirs {
	configDir: string;
	stateDir: string;
}

export function defaultDirs(env: Record<string, string | undefined> = Bun.env, platform = process.platform): Dirs {
	if (platform === "win32") {
		const roaming = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
		const local = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
		return { configDir: join(roaming, "omp-web"), stateDir: join(local, "omp-web") };
	}
	return {
		configDir: join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "omp-web"),
		stateDir: join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "omp-web"),
	};
}

export type Role = "gateway" | "env";

/** `config.json` in the config dir. Every key is optional; command-line flags win over it. */
export interface FileConfig {
	/** `gateway` (default): this machine hosts the gateway and is itself an environment. `env`: environment only. */
	role?: Role;
	/** Display name of this machine (default: its hostname). */
	name?: string;
	omp?: string;
	sessionDir?: string;
	/** Optional Antigravity ACP backend (`agy acp`). Auto-detected on PATH unless `enabled: false`. */
	antigravity?: {
		/** Set false to disable Antigravity auto-detection, or true to require `agy` at startup. */
		enabled?: boolean;
		/** Path or command name of the Antigravity CLI binary (default: `$AGY_BIN`, then `agy` on PATH). */
		bin?: string;
		/** Arguments used to launch ACP mode (default: `["acp"]`). */
		args?: string[];
		/** Custom Antigravity brain/session directory to scan for historical transcripts. */
		sessionDir?: string;
		/** Preferred ACP `authenticate` methodId (e.g. `oauth-personal` or `gemini-api-key`). */
		authMethod?: string;
		/** Default ACP execution mode id (`default`, `accept-edits`, `auto`, `plan`, …). */
		mode?: string;
		/** Default client-side permission approval policy (`ask`, `edits`, `auto`; default `auto`). */
		permissionMode?: PermissionMode;
	};
	gateway?: {
		/** Address to listen on (default 127.0.0.1). */
		bind?: string;
		port?: number;
		webDir?: string;
		allowOrigins?: string[];
		/** Contact URL (`mailto:` or `https:`) the push services see in the VAPID claim (default `mailto:omp-web@localhost`). */
		pushSubject?: string;
	};
	/** The transcript replica this machine's environment offers its gateway. */
	replica?: {
		/** Only conversations active within this many days are replicated (default 30). */
		retentionDays?: number;
		/** Files above this many MiB are not replicated (default 128). */
		maxFileMiB?: number;
		/** Seconds between rescans of the session store while a gateway is linked (default 30). */
		scanSeconds?: number;
	};
	/**
	 * Switching a thread to another environment. `worktreesDir` applies to the machine that receives the worktree;
	 * the limits and the confirmation timeout to the gateway role (they travel to the daemons with each operation).
	 */
	handoff?: {
		/** Where new worktrees are created: `<dir>/<project name>/<short thread id>` (default: next to the project, `<name>.omp-worktrees/`). */
		worktreesDir?: string;
		/** A carried file (untracked, or modified and tracked) above this many MiB is left behind and listed (default 10). */
		maxFileMiB?: number;
		/** The carried files of one switch together, in MiB (default 128). */
		maxTotalMiB?: number;
		/** Largest git bundle, MiB (default 256). */
		maxBundleMiB?: number;
		/** Largest session archive, MiB (default 512). */
		maxArchiveMiB?: number;
		/** A switch waiting for confirmation is rolled back after this many minutes (default 30). */
		confirmTimeoutMinutes?: number;
	};
	env?: {
		/** `ws://` / `wss://` URL of the gateway's `/env` endpoint. */
		gatewayUrl?: string;
		/** File with `<machine id>:<key>`; default `<config dir>/credential`. */
		credentialFile?: string;
	};
	/**
	 * Persistent shells (the web "Terminal"). A terminal is a full shell as the user running omp-webd, so it is OFF unless
	 * the operator of this machine turns it on here (or with `--terminal`). Either role.
	 */
	terminal?: {
		/** Allow terminals on this machine (default false). */
		enabled?: boolean;
		/** Terminals (running and exited, until dismissed) at most (default 16). */
		max?: number;
		/** Absolute path of the shell to start (default: the user's login shell from the account database, else $SHELL). */
		shell?: string;
		/** Output kept per terminal for gap-free reattach, in KiB of characters (default 1024). */
		ringKiB?: number;
		/** Lines of history in the screen snapshot a fresh client gets (default 2000). */
		scrollbackLines?: number;
	};
	/**
	 * The credential broker. Gateway role: host `omp auth-broker serve` (`enabled`, `bind`, `home`, `advertiseUrl`). Env
	 * role: use a broker of this machine's own instead of the one the gateway hands over (`url`, `tokenFile`).
	 */
	broker?: {
		/** Gateway role: host the broker (default false; enabling it switches every environment's omp to the broker's credentials). */
		enabled?: boolean;
		/** Gateway role: `host:port` the broker listens on (default 127.0.0.1:8765; no wildcard addresses). */
		bind?: string;
		/** Gateway role: HOME of the broker process; its credential database and token live under `<home>/.omp/` (default `<state dir>/auth-broker`). */
		home?: string;
		/** Gateway role: the `http(s)://host:port` other machines should use when it differs from `bind` (default: `bind`). */
		advertiseUrl?: string;
		/** Env role: broker URL for this machine's omp processes. */
		url?: string;
		/** Env role: file holding that broker's bearer token (owner-only: mode 600, on Windows an ACL). */
		tokenFile?: string;
	};
}

/** Where the hosted broker listens unless told otherwise: loopback only, upstream's own default. */
export const DEFAULT_BROKER_BIND = "127.0.0.1:8765";

const TOP_KEYS = [
	"role",
	"name",
	"omp",
	"sessionDir",
	"antigravity",
	"gateway",
	"env",
	"replica",
	"broker",
	"terminal",
	"handoff",
];
const ANTIGRAVITY_KEYS = ["enabled", "bin", "args", "sessionDir", "authMethod", "mode", "permissionMode"];
const HANDOFF_KEYS = [
	"worktreesDir",
	"maxFileMiB",
	"maxTotalMiB",
	"maxBundleMiB",
	"maxArchiveMiB",
	"confirmTimeoutMinutes",
];
const TERMINAL_KEYS = ["enabled", "max", "shell", "ringKiB", "scrollbackLines"];
const BROKER_KEYS = ["enabled", "bind", "home", "advertiseUrl", "url", "tokenFile"];
const GATEWAY_KEYS = ["bind", "port", "webDir", "allowOrigins", "pushSubject"];
const REPLICA_KEYS = ["retentionDays", "maxFileMiB", "scanSeconds"];
const ENV_KEYS = ["gatewayUrl", "credentialFile"];

function section(raw: unknown, where: string, allowed: string[]): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new ConfigError(`${where} must be an object`);
	const record = raw as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key))
			throw new ConfigError(`${where}: unknown key "${key}" (expected one of ${allowed.join(", ")})`);
	}
	return record;
}

function optional<T>(
	record: Record<string, unknown>,
	key: string,
	where: string,
	check: (v: unknown) => v is T,
	what: string,
): T | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (!check(value)) throw new ConfigError(`${where}.${key} must be ${what}`);
	return value;
}

const isString = (v: unknown): v is string => typeof v === "string" && v !== "";
const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 65535;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isPositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isContactUrl = (v: unknown): v is string =>
	typeof v === "string" && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(v);
const isRole = (v: unknown): v is Role => v === "gateway" || v === "env";
const isPermissionMode = (v: unknown): v is PermissionMode => v === "ask" || v === "edits" || v === "auto";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isIntBetween =
	(low: number, high: number) =>
	(v: unknown): v is number =>
		typeof v === "number" && Number.isInteger(v) && v >= low && v <= high;
const isAbsolutePath = (v: unknown): v is string => typeof v === "string" && /^([/\\]|[A-Za-z]:[/\\])/.test(v);
const isHttpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/[^\s/]+\S*$/.test(v);

/** Validates a parsed `config.json`; unknown keys are errors so a typo does not silently fall back to a default. */
export function parseFileConfig(raw: unknown, file = "config.json"): FileConfig {
	const top = section(raw, file, TOP_KEYS);
	const antigravity =
		top.antigravity === undefined ? undefined : section(top.antigravity, `${file}: antigravity`, ANTIGRAVITY_KEYS);
	const gateway = top.gateway === undefined ? undefined : section(top.gateway, `${file}: gateway`, GATEWAY_KEYS);
	const env = top.env === undefined ? undefined : section(top.env, `${file}: env`, ENV_KEYS);
	const replica = top.replica === undefined ? undefined : section(top.replica, `${file}: replica`, REPLICA_KEYS);
	const broker = top.broker === undefined ? undefined : section(top.broker, `${file}: broker`, BROKER_KEYS);
	const terminal = top.terminal === undefined ? undefined : section(top.terminal, `${file}: terminal`, TERMINAL_KEYS);
	const handoff = top.handoff === undefined ? undefined : section(top.handoff, `${file}: handoff`, HANDOFF_KEYS);
	return {
		role: optional(top, "role", file, isRole, '"gateway" or "env"'),
		name: optional(top, "name", file, isString, "a non-empty string"),
		omp: optional(top, "omp", file, isString, "a non-empty string"),
		sessionDir: optional(top, "sessionDir", file, isString, "a non-empty string"),
		antigravity: antigravity && {
			enabled: optional(antigravity, "enabled", "antigravity", isBoolean, "true or false"),
			bin: optional(antigravity, "bin", "antigravity", isString, "a non-empty string"),
			args: optional(antigravity, "args", "antigravity", isStrings, "an array of non-empty strings"),
			sessionDir: optional(antigravity, "sessionDir", "antigravity", isString, "a non-empty string"),
			authMethod: optional(antigravity, "authMethod", "antigravity", isString, "a non-empty string"),
			mode: optional(antigravity, "mode", "antigravity", isString, "a non-empty string"),
			permissionMode: optional(
				antigravity,
				"permissionMode",
				"antigravity",
				isPermissionMode,
				'"ask", "edits" or "auto"',
			),
		},
		gateway: gateway && {
			bind: optional(gateway, "bind", "gateway", isString, "a non-empty string"),
			port: optional(gateway, "port", "gateway", isPort, "a port number"),
			webDir: optional(gateway, "webDir", "gateway", isString, "a non-empty string"),
			allowOrigins: optional(gateway, "allowOrigins", "gateway", isStrings, "an array of origins"),
			pushSubject: optional(gateway, "pushSubject", "gateway", isContactUrl, "a mailto: or https: URL"),
		},
		replica: replica && {
			retentionDays: optional(replica, "retentionDays", "replica", isPositive, "a positive number"),
			maxFileMiB: optional(replica, "maxFileMiB", "replica", isPositive, "a positive number"),
			scanSeconds: optional(replica, "scanSeconds", "replica", isPositive, "a positive number"),
		},
		env: env && {
			gatewayUrl: optional(env, "gatewayUrl", "env", isString, "a non-empty string"),
			credentialFile: optional(env, "credentialFile", "env", isString, "a non-empty string"),
		},
		terminal: terminal && {
			enabled: optional(terminal, "enabled", "terminal", isBoolean, "true or false"),
			max: optional(terminal, "max", "terminal", isIntBetween(1, 64), "an integer from 1 to 64"),
			shell: optional(terminal, "shell", "terminal", isAbsolutePath, "an absolute path"),
			ringKiB: optional(terminal, "ringKiB", "terminal", isIntBetween(64, 65536), "an integer from 64 to 65536"),
			scrollbackLines: optional(
				terminal,
				"scrollbackLines",
				"terminal",
				isIntBetween(0, 100_000),
				"an integer from 0 to 100000",
			),
		},
		handoff: handoff && {
			worktreesDir: optional(handoff, "worktreesDir", "handoff", isAbsolutePath, "an absolute path"),
			maxFileMiB: optional(handoff, "maxFileMiB", "handoff", isPositive, "a positive number"),
			maxTotalMiB: optional(handoff, "maxTotalMiB", "handoff", isPositive, "a positive number"),
			maxBundleMiB: optional(handoff, "maxBundleMiB", "handoff", isPositive, "a positive number"),
			maxArchiveMiB: optional(handoff, "maxArchiveMiB", "handoff", isPositive, "a positive number"),
			confirmTimeoutMinutes: optional(handoff, "confirmTimeoutMinutes", "handoff", isPositive, "a positive number"),
		},
		broker: broker && {
			enabled: optional(broker, "enabled", "broker", isBoolean, "true or false"),
			bind: optional(broker, "bind", "broker", isString, "a host:port string"),
			home: optional(broker, "home", "broker", isString, "a non-empty string"),
			advertiseUrl: optional(broker, "advertiseUrl", "broker", isHttpUrl, "an http(s) URL"),
			url: optional(broker, "url", "broker", isHttpUrl, "an http(s) URL"),
			tokenFile: optional(broker, "tokenFile", "broker", isString, "a non-empty string"),
		},
	};
}

export async function loadFileConfig(configDir: string): Promise<FileConfig> {
	const file = join(configDir, "config.json");
	const handle = Bun.file(file);
	if (!(await handle.exists())) return {};
	let raw: unknown;
	try {
		raw = await handle.json();
	} catch {
		throw new ConfigError(`${file} is not valid JSON`);
	}
	return parseFileConfig(raw, file);
}

/** The command-line flags that override `config.json` (undefined = not given). */
export interface Flags {
	role?: string;
	name?: string;
	omp?: string;
	sessionDir?: string;
	antigravity?: string;
	antigravitySessionDir?: string;
	antigravityAuthMethod?: string;
	antigravityMode?: string;
	antigravityPermissionMode?: string;
	bind?: string;
	port?: string;
	webDir?: string;
	allowOrigin?: string[];
	gatewayUrl?: string;
	credentialFile?: string;
	broker?: boolean;
	terminal?: boolean;
	brokerBind?: string;
	brokerHome?: string;
	brokerAdvertiseUrl?: string;
	brokerUrl?: string;
	brokerTokenFile?: string;
}

/** Gateway role: the broker this daemon hosts. */
export interface BrokerHosting {
	enabled: boolean;
	/** `host:port`, never a wildcard address. */
	bind: string;
	home: string;
	advertiseUrl?: string;
}

export interface DaemonConfig extends Dirs {
	role: Role;
	name: string;
	omp?: string;
	sessionDir?: string;
	antigravity: {
		enabled?: boolean;
		bin?: string;
		args?: string[];
		sessionDir?: string;
		authMethod?: string;
		mode?: string;
		permissionMode?: PermissionMode;
	};
	gateway: { bind: string; port: number; webDir: string; allowOrigins: string[]; pushSubject: string };
	replica: ReplicaPolicy;
	env: { gatewayUrl?: string; credentialFile: string };
	/** Persistent shells; `enabled` is false unless the operator turned them on for this machine. */
	terminal: { enabled: boolean; max: number; shell?: string; ringChars: number; scrollbackLines: number };
	/** Gateway role: the broker this daemon hosts (disabled unless asked for). */
	broker: BrokerHosting;
	/** Environment switches: where this machine puts new worktrees, and the gateway's limits. */
	handoff: { worktreesDir?: string; limits: HandoffLimits; confirmTimeoutMs: number };
	/** Env role: this machine's own broker, which wins over the one the gateway hands over. */
	localBroker?: { url: string; tokenFile: string };
}

/** Merges flags over the file over the defaults and rejects combinations that make no sense. */
export function resolveConfig(flags: Flags, file: FileConfig, dirs: Dirs, defaults: { webDir: string }): DaemonConfig {
	const hostingKeys = [file.broker?.enabled, file.broker?.bind, file.broker?.home, file.broker?.advertiseUrl];
	const hostingSettings =
		flags.broker !== undefined ||
		flags.brokerBind !== undefined ||
		flags.brokerHome !== undefined ||
		flags.brokerAdvertiseUrl !== undefined ||
		hostingKeys.some(v => v !== undefined);
	const localSettings =
		flags.brokerUrl !== undefined ||
		flags.brokerTokenFile !== undefined ||
		file.broker?.url !== undefined ||
		file.broker?.tokenFile !== undefined;
	const roleText = flags.role ?? file.role ?? "gateway";
	if (!isRole(roleText)) throw new ConfigError(`--role must be "gateway" or "env", got "${roleText}"`);
	const agyPermText = flags.antigravityPermissionMode ?? file.antigravity?.permissionMode;
	if (agyPermText !== undefined && !isPermissionMode(agyPermText)) {
		throw new ConfigError(
			`--antigravity-permission-mode must be "ask", "edits" or "auto", got "${String(agyPermText)}"`,
		);
	}
	const portText = flags.port ?? file.gateway?.port ?? 7777;
	const port = Number(portText);
	if (!isPort(port)) throw new ConfigError(`invalid --port ${String(portText)}`);
	const gatewayUrl = flags.gatewayUrl ?? file.env?.gatewayUrl;
	const gatewaySettings =
		flags.bind !== undefined ||
		flags.port !== undefined ||
		flags.webDir !== undefined ||
		(flags.allowOrigin?.length ?? 0) > 0 ||
		file.gateway !== undefined;
	const config: DaemonConfig = {
		...dirs,
		role: roleText,
		name: flags.name ?? file.name ?? hostname(),
		omp: flags.omp ?? file.omp,
		sessionDir: flags.sessionDir ?? file.sessionDir,
		antigravity: {
			enabled: file.antigravity?.enabled,
			bin: flags.antigravity ?? file.antigravity?.bin,
			args: file.antigravity?.args,
			sessionDir: flags.antigravitySessionDir ?? file.antigravity?.sessionDir,
			authMethod: flags.antigravityAuthMethod ?? file.antigravity?.authMethod,
			mode: flags.antigravityMode ?? file.antigravity?.mode,
			permissionMode: agyPermText,
		},
		gateway: {
			bind: flags.bind ?? file.gateway?.bind ?? "127.0.0.1",
			port,
			webDir: resolve(flags.webDir ?? file.gateway?.webDir ?? defaults.webDir),
			allowOrigins: flags.allowOrigin ?? file.gateway?.allowOrigins ?? [],
			pushSubject: file.gateway?.pushSubject ?? "mailto:omp-web@localhost",
		},
		replica: {
			retentionDays: file.replica?.retentionDays ?? DEFAULT_REPLICA_POLICY.retentionDays,
			maxFileBytes: Math.round(
				(file.replica?.maxFileMiB ?? DEFAULT_REPLICA_POLICY.maxFileBytes / 1024 / 1024) * 1024 * 1024,
			),
			scanIntervalMs: Math.round((file.replica?.scanSeconds ?? DEFAULT_REPLICA_POLICY.scanIntervalMs / 1000) * 1000),
		},
		broker: {
			enabled: flags.broker ?? file.broker?.enabled ?? false,
			bind: flags.brokerBind ?? file.broker?.bind ?? DEFAULT_BROKER_BIND,
			home: resolve(flags.brokerHome ?? file.broker?.home ?? join(dirs.stateDir, "auth-broker")),
			advertiseUrl: flags.brokerAdvertiseUrl ?? file.broker?.advertiseUrl,
		},
		handoff: {
			worktreesDir: file.handoff?.worktreesDir ? resolve(file.handoff.worktreesDir) : undefined,
			limits: {
				maxFileBytes: Math.round(
					(file.handoff?.maxFileMiB ?? DEFAULT_HANDOFF_LIMITS.maxFileBytes / 1048576) * 1048576,
				),
				maxTotalBytes: Math.round(
					(file.handoff?.maxTotalMiB ?? DEFAULT_HANDOFF_LIMITS.maxTotalBytes / 1048576) * 1048576,
				),
				maxBundleBytes: Math.round(
					(file.handoff?.maxBundleMiB ?? DEFAULT_HANDOFF_LIMITS.maxBundleBytes / 1048576) * 1048576,
				),
				maxArchiveBytes: Math.round(
					(file.handoff?.maxArchiveMiB ?? DEFAULT_HANDOFF_LIMITS.maxArchiveBytes / 1048576) * 1048576,
				),
			},
			confirmTimeoutMs: Math.round((file.handoff?.confirmTimeoutMinutes ?? 30) * 60_000),
		},
		terminal: {
			enabled: flags.terminal ?? file.terminal?.enabled ?? false,
			max: file.terminal?.max ?? DEFAULT_TERMINAL_MAX,
			shell: file.terminal?.shell,
			ringChars: (file.terminal?.ringKiB ?? DEFAULT_RING_CHARS / 1024) * 1024,
			scrollbackLines: file.terminal?.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES,
		},
		env: {
			gatewayUrl,
			credentialFile: resolve(
				flags.credentialFile ?? file.env?.credentialFile ?? join(dirs.configDir, "credential"),
			),
		},
	};
	parseBrokerBind(config.broker.bind); // a bad or wildcard address is an error even while the broker is disabled
	if (config.role === "env") {
		if (hostingSettings)
			throw new ConfigError(
				"an env-only daemon does not host a broker: --broker/--broker-bind/--broker-home/--broker-advertise-url and broker.enabled/bind/home/advertiseUrl apply to the gateway role only",
			);
		const brokerUrl = flags.brokerUrl ?? file.broker?.url;
		const tokenFile = flags.brokerTokenFile ?? file.broker?.tokenFile;
		if ((brokerUrl === undefined) !== (tokenFile === undefined))
			throw new ConfigError(
				"a machine's own broker needs both a URL and a token file (broker.url + broker.tokenFile)",
			);
		if (brokerUrl !== undefined && tokenFile !== undefined)
			config.localBroker = { url: brokerUrl, tokenFile: resolve(tokenFile) };
		if (gatewayUrl === undefined)
			throw new ConfigError("role env needs a gateway: set --gateway-url (or env.gatewayUrl in config.json)");
		if (!/^wss?:\/\//.test(gatewayUrl))
			throw new ConfigError(`gateway URL must start with ws:// or wss://, got "${gatewayUrl}"`);
		if (gatewaySettings)
			throw new ConfigError(
				"an env-only daemon listens on no port: --bind/--port/--web-dir/--allow-origin and the gateway section apply to the gateway role only",
			);
	} else {
		if (gatewayUrl !== undefined)
			throw new ConfigError(
				"the gateway role is its own environment and does not register elsewhere; remove --gateway-url / env.gatewayUrl",
			);
		if (localSettings)
			throw new ConfigError(
				"the gateway role hosts its own broker: --broker-url/--broker-token-file and broker.url/tokenFile apply to --role env only",
			);
		if (config.broker.advertiseUrl !== undefined && !config.broker.enabled)
			throw new ConfigError("broker.advertiseUrl is set but the broker is not enabled (broker.enabled / --broker)");
	}
	return config;
}

/** This machine's id: random, generated on first run, kept in the state dir. It is the gateway machine's identity in the database. */
export async function loadMachineId(stateDir: string): Promise<string> {
	const file = join(stateDir, "machine-id");
	const existing = Bun.file(file);
	if (await existing.exists()) {
		const id = (await existing.text()).trim();
		if (id !== "") return id;
	}
	const id = `m_${randomBytes(6).toString("hex")}`;
	await mkdirPrivate(stateDir);
	await Bun.write(file, `${id}\n`);
	return id;
}
