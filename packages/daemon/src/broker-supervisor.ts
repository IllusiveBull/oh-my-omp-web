import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrokerStatus } from "@omp-web/protocol";
import { descendantPids, inspectWindowsProcesses, killProcessTree, processAlive, type ProcessInfo } from "./proc-tree";
import { ConfigError } from "./secrets";

export type { ProcessInfo } from "./proc-tree";

const WIN32 = process.platform === "win32";

/** `host:port` the broker listens on. */
export interface BrokerBind {
	host: string;
	port: number;
}

const WILDCARD_HOSTS = new Set(["", "*", "0.0.0.0", "::", "[::]"]);

/**
 * Parses `broker.bind`. The broker holds refresh tokens, so the address has to be a decision: a wildcard address would
 * expose the vault on every interface of the machine, and is refused. Use loopback, or the tailscale address.
 */
export function parseBrokerBind(text: string): BrokerBind {
	const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(text.trim());
	if (!match) throw new ConfigError(`broker bind must be host:port (e.g. 127.0.0.1:8765), got "${text}"`);
	const host = match[1]!;
	const port = Number(match[2]);
	if (port < 1 || port > 65535) throw new ConfigError(`broker bind port must be 1-65535, got ${port}`);
	if (WILDCARD_HOSTS.has(host.toLowerCase())) {
		throw new ConfigError(
			`refusing to bind the credential broker to ${host}: that exposes it on every interface. Bind loopback (127.0.0.1) or the tailscale address (tailscale ip -4).`,
		);
	}
	return { host, port };
}

/** `http://host:port` for a bind (IPv6 hosts keep their brackets). */
export function brokerUrlOf(bind: BrokerBind): string {
	const host = bind.host.includes(":") && !bind.host.startsWith("[") ? `[${bind.host}]` : bind.host;
	return `http://${host}:${bind.port}`;
}

/** A broker child as the supervisor sees it. */
export interface BrokerChild {
	readonly pid: number;
	/** The command line the process was really started with (what `ps` will show), for recognising it later. */
	readonly argv: string[];
	/** Resolves when the process ended (also for a process that never came up). */
	readonly exited: Promise<{ code: number | null; signal: string | null }>;
	kill(signal: "SIGINT" | "SIGKILL"): void;
	/**
	 * Windows only: the processes below the child (`omp.exe` is a launcher, the broker is its child). Their presence says the
	 * stop has to be a tree kill and that the child's exit does not prove the listener is gone.
	 */
	descendants?(): number[];
	/** The last bytes of its output (stdout and stderr), for the failure message. Never contains the token: omp does not log it. */
	tail(): string;
}

export type SpawnBroker = (argv: string[], env: Record<string, string | undefined>) => BrokerChild;

const TAIL_BYTES = 2048;

/** Spawns a real child and keeps the tail of its output. */
export const spawnBrokerChild: SpawnBroker = (argv, env) => {
	const proc = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let tail = "";
	const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of stream) tail = (tail + decoder.decode(chunk, { stream: true })).slice(-TAIL_BYTES);
		} catch {
			// the process ended; whatever was read is enough
		}
	};
	void drain(proc.stdout);
	void drain(proc.stderr);
	return {
		pid: proc.pid,
		argv,
		exited: proc.exited.then(code => ({ code, signal: proc.signalCode })),
		// Windows has no signals and no graceful stop: Bun turns `kill("SIGINT")` into TerminateProcess of the launcher only, which
		// leaves the real broker running and listening. A tree kill (launcher + its child) is what stop means there.
		kill: signal => (WIN32 ? killProcessTree(proc.pid) : proc.kill(signal)),
		...(WIN32 ? { descendants: () => descendantPids(proc.pid) } : {}),
		tail: () => tail,
	};
};

/** What `omp auth-broker token --json` printed: the bearer token and the file it lives in. */
export interface BrokerToken {
	token: string;
	path: string;
}

/** Start time and command line of a live process: via `ps` (POSIX), via one CIM query (Windows); null when it cannot be told. */
export async function inspectProcess(pid: number): Promise<ProcessInfo | null> {
	if (WIN32) return (await inspectWindowsProcesses([pid])).get(pid) ?? null;
	try {
		const proc = Bun.spawn(["ps", "-ww", "-o", "lstart=", "-o", "command=", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
			// `lstart` is printed in the time zone of ps's environment while Date.parse reads the zone of this process (bun test
			// forces UTC): pin both.
			env: { ...Bun.env, TZ: "UTC" },
		});
		const out = (await new Response(proc.stdout).text()).replace(/\n$/, "");
		if ((await proc.exited) !== 0) return null;
		const startedAt = Date.parse(`${out.slice(0, 24)} UTC`);
		const command = out.slice(24).trim();
		return Number.isFinite(startedAt) && command !== "" ? { startedAt, command } : null;
	} catch {
		return null;
	}
}

/**
 * Whether `ps`'s command line is the one a child was started with. `ps` shows the program as the shell found it (`omp`) where
 * the spawn used its absolute path, and a script launched through its shebang with the interpreter in front (`bun /x/omp ...`),
 * so: the arguments must match exactly, the program by file name, and at most one interpreter token may precede it.
 */
export function sameCommand(rawCommand: string, argv: string[]): boolean {
	if (argv.length === 0) return false;
	// Windows command lines quote what has spaces (`"C:\Program Files\...\omp.exe" auth-broker ...`) and name programs with .exe
	const command = WIN32 ? rawCommand.replaceAll('"', "") : rawCommand;
	if (command === argv.join(" ")) return true;
	const rest = argv.slice(1).join(" ");
	const head = rest === "" ? command : command.endsWith(` ${rest}`) ? command.slice(0, -rest.length - 1) : null;
	if (head === null) return false;
	const name = (path: string): string => (path.split(/[\\/]/).at(-1) ?? path).replace(WIN32 ? /\.exe$/i : /^$/, "");
	const tokens = head.trim().split(/\s+/);
	const wanted = name(argv[0]!);
	return name(tokens.at(-1)!) === wanted && tokens.length <= 2;
}

const isAlive = processAlive;

/** What the supervisor writes about the child it started, so a later daemon can recognise it as its own. */
interface BrokerRecord {
	pid: number;
	/** Epoch ms right after the spawn. */
	startedAt: number;
	argv: string[];
	/**
	 * Windows: the launcher and the processes below it (the real broker), each with the creation time and command line it
	 * had when seen, so a later daemon can tell them from an unrelated process that got the same pid.
	 */
	procs?: { pid: number; startedAt: number; command: string }[];
}

/** Process start times are whole seconds and recorded just after the spawn: how far apart they may be and still be one process. */
const START_SLACK = { before: 10_000, after: 2_000 };

type BrokerFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SupervisorOptions {
	/** Absolute path of the omp binary. */
	ompPath: string;
	bind: BrokerBind;
	/** HOME of the broker process: its credential database and token live under it. */
	home: string;
	/** Advertised URL for other machines (default: the bind's). */
	advertiseUrl?: string;
	/** The daemon's environment; the broker's HOME is replaced, and omp settings that would move its state are removed. */
	env?: Record<string, string | undefined>;
	/** Replaces the argv of the long-running child (default `omp auth-broker serve --bind host:port`). Test seam. */
	serveArgv?: string[];
	/** Test seam: replaces spawning. */
	spawn?: SpawnBroker;
	/** Where the running child is recorded (default `<home>/omp-web-broker.json`), so a SIGKILLed daemon's orphan can be stopped. */
	pidFile?: string;
	/** Test seam: replaces `ps` (and, on Windows, the CIM query). */
	inspect?: (pid: number) => Promise<ProcessInfo | null>;
	/** Test seam: replaces `omp auth-broker token --json`. */
	getToken?: (env: Record<string, string | undefined>) => Promise<BrokerToken>;
	fetch?: BrokerFetch;
	now?: () => number;
	/** Restart delays: first `minMs`, doubling up to `maxMs`; a run that lasted `stableMs` resets the delay. */
	backoff?: { minMs: number; maxMs: number; stableMs: number };
	/** How often a running broker is probed (default 5 s). */
	healthIntervalMs?: number;
	/** How long a fresh child may take to answer `/v1/healthz` (default 20 s). */
	startTimeoutMs?: number;
	/** After SIGINT, how long the child gets to shut down before SIGKILL (default 5 s). */
	stopGraceMs?: number;
}

const DEFAULT_BACKOFF = { minMs: 500, maxMs: 30_000, stableMs: 30_000 };

/** The environment variables that would make the broker use some other state than `home`, or talk to another broker. */
const STRIPPED_ENV = [
	"PI_CODING_AGENT_DIR",
	"PI_PROFILE",
	"OMP_PROFILE",
	"OMP_AUTH_BROKER_URL",
	"OMP_AUTH_BROKER_TOKEN",
];

/** `omp auth-broker token --json` with the broker's environment: creates the token file on first use (mode 600). */
async function ompBrokerToken(ompPath: string, env: Record<string, string | undefined>): Promise<BrokerToken> {
	const proc = Bun.spawn([ompPath, "auth-broker", "token", "--json"], { env, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`omp auth-broker token failed (exit ${code}): ${err.trim().slice(-300)}`);
	const parsed: unknown = JSON.parse(out.trim().split("\n").at(-1) ?? "");
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("token" in parsed) ||
		typeof parsed.token !== "string" ||
		!("path" in parsed) ||
		typeof parsed.path !== "string"
	) {
		throw new Error("omp auth-broker token --json printed an unexpected answer");
	}
	return { token: parsed.token, path: parsed.path };
}

/**
 * Runs `omp auth-broker serve` as a child of the gateway: starts it, waits until it answers, probes it, restarts it with
 * backoff when it dies, and stops it with SIGINT (upstream's graceful path: close the listener, close the database) before
 * resorting to SIGKILL. All of its state (agent.db, bearer token) lives under `home`; nothing of the user's own omp
 * directory is touched unless `home` is the user's home directory, which is an explicit choice.
 *
 * If the daemon itself is killed without running its shutdown, the child keeps running and holds the port (upstream's broker
 * does not watch its parent). So the child is recorded in a pid file (pid, start time, argv); the next start looks at it and, only
 * when the process with that pid still has exactly that command line and that start time, stops it (SIGINT, then SIGKILL).
 * A process that merely reuses the pid, or that cannot be inspected (Windows), is never touched.
 */
export class BrokerSupervisor {
	readonly #bind: BrokerBind;
	readonly #url: string;
	readonly #advertised: string;
	readonly #env: Record<string, string | undefined>;
	readonly #spawn: SpawnBroker;
	readonly #getToken: (env: Record<string, string | undefined>) => Promise<BrokerToken>;
	readonly #fetch: BrokerFetch;
	readonly #now: () => number;
	readonly #backoff: { minMs: number; maxMs: number; stableMs: number };
	readonly #healthIntervalMs: number;
	readonly #startTimeoutMs: number;
	readonly #stopGraceMs: number;
	readonly #listeners = new Set<() => void>();
	readonly #pidFile: string;
	readonly #inspect: (pid: number) => Promise<ProcessInfo | null>;
	readonly #inspectAll: (pids: number[]) => Promise<Map<number, ProcessInfo>>;
	/** Windows: every pid of the running broker's tree seen so far, to prove after a stop that none is left. */
	#tree = new Set<number>();
	#status: BrokerStatus;
	#token: BrokerToken | null = null;
	#child: BrokerChild | null = null;
	#loop: Promise<void> | null = null;
	#stopping = false;
	#startedAt = 0;
	#wake: (() => void) | null = null;

	constructor(private readonly options: SupervisorOptions) {
		this.#bind = options.bind;
		this.#url = brokerUrlOf(options.bind);
		this.#advertised = options.advertiseUrl ?? this.#url;
		const env: Record<string, string | undefined> = { ...(options.env ?? Bun.env) };
		for (const name of STRIPPED_ENV) delete env[name];
		env.HOME = options.home;
		env.USERPROFILE = options.home; // Windows reads this instead of HOME
		this.#env = env;
		this.#spawn = options.spawn ?? spawnBrokerChild;
		this.#pidFile = options.pidFile ?? join(options.home, "omp-web-broker.json");
		this.#inspect = options.inspect ?? inspectProcess;
		const single = options.inspect;
		this.#inspectAll = single
			? async pids => {
					const out = new Map<number, ProcessInfo>();
					for (const pid of pids) {
						const info = await single(pid);
						if (info) out.set(pid, info);
					}
					return out;
				}
			: inspectWindowsProcesses;
		this.#getToken = options.getToken ?? (e => ompBrokerToken(options.ompPath, e));
		this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.#now = options.now ?? Date.now;
		this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.#healthIntervalMs = options.healthIntervalMs ?? 5_000;
		this.#startTimeoutMs = options.startTimeoutMs ?? 20_000;
		this.#stopGraceMs = options.stopGraceMs ?? 5_000;
		this.#status = {
			phase: "starting",
			healthy: false,
			url: this.#url,
			advertisedUrl: this.#advertised,
			bind: `${options.bind.host}:${options.bind.port}`,
			home: options.home,
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

	status(): BrokerStatus {
		return this.#status;
	}

	/** The bearer token once `omp auth-broker token` has run (before that null). Handed to environments, never shown. */
	get token(): string | null {
		return this.#token?.token ?? null;
	}

	/** Where the broker is reachable from the gateway machine itself (`http://host:port`). */
	get url(): string {
		return this.#url;
	}

	get advertisedUrl(): string {
		return this.#advertised;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Starts the supervision loop and returns at once; watch `status()` / `onChange`. */
	start(): void {
		if (this.#loop) return;
		this.#loop = this.#run();
	}

	/**
	 * POSIX: SIGINT, then SIGKILL after the grace period. Windows: a tree kill, no graceful stop (the store reopens fine after a
	 * hard kill: WAL recovery, measured). Resolves when the child and the loop are gone and, on Windows, when every process
	 * of the tree is dead and the listener no longer answers.
	 */
	async stop(): Promise<void> {
		this.#stopping = true;
		this.#wake?.();
		const child = this.#child;
		if (child?.descendants) {
			const tree = new Set([child.pid, ...child.descendants(), ...this.#tree]);
			child.kill("SIGKILL");
			await child.exited;
			await this.#awaitGone(tree);
		} else if (child) {
			child.kill("SIGINT");
			const exited = await Promise.race([
				child.exited.then(() => true),
				Bun.sleep(this.#stopGraceMs).then(() => false),
			]);
			if (!exited) {
				child.kill("SIGKILL");
				await child.exited;
			}
		}
		await this.#loop;
		this.#set({ phase: "stopped", healthy: false, pid: null, nextRetryAt: null });
	}

	/** Windows: waits until none of `pids` exists and the broker's port is closed; whatever is left then is reaped by the record. */
	async #awaitGone(pids: Set<number>): Promise<void> {
		const deadline = this.#now() + 5_000;
		while ([...pids].some(isAlive) && this.#now() < deadline) await Bun.sleep(20);
		if ([...pids].some(isAlive)) throw new Error("auth broker process tree did not exit after being killed");
		while ((await this.#health()) !== null) {
			if (this.#now() >= deadline + 5_000) throw new Error("auth broker is still listening after being killed");
			await Bun.sleep(50);
		}
	}

	/** Windows: notes the launcher's child (found a moment after the spawn) and what it is, in the pid file. */
	async #recordTree(child: BrokerChild): Promise<void> {
		for (let i = 0; i < 50 && this.#child === child; i++) {
			const kids = child.descendants?.() ?? [];
			if (kids.length > 0) {
				const pids = [child.pid, ...kids];
				for (const pid of pids) this.#tree.add(pid);
				const seen = await this.#inspectAll(pids);
				if (this.#child !== child) return;
				const procs = pids.flatMap(pid => {
					const info = seen.get(pid);
					return info ? [{ pid, startedAt: info.startedAt, command: info.command }] : [];
				});
				await Bun.write(
					this.#pidFile,
					JSON.stringify({
						pid: child.pid,
						startedAt: this.#startedAt,
						argv: child.argv,
						procs,
					} satisfies BrokerRecord),
				).catch(() => {});
				return;
			}
			await Bun.sleep(100);
		}
	}

	/**
	 * Stops a broker of ours that outlived its daemon. Returns what it found: `none`, `reaped`, or `foreign` (a pid file whose
	 * process is not provably the recorded child: left alone, the record dropped).
	 */
	async reapStale(): Promise<"none" | "reaped" | "foreign"> {
		let record: BrokerRecord;
		try {
			record = JSON.parse(await Bun.file(this.#pidFile).text()) as BrokerRecord;
		} catch {
			return "none";
		}
		if (typeof record.pid === "number" && Array.isArray(record.argv) && (WIN32 || record.procs !== undefined)) {
			return this.#reapTree(record);
		}
		if (typeof record.pid !== "number" || !Array.isArray(record.argv) || !isAlive(record.pid)) {
			await rm(this.#pidFile, { force: true });
			return "none";
		}
		const ours = async (): Promise<boolean> => {
			const info = await this.#inspect(record.pid);
			return (
				info !== null &&
				sameCommand(info.command, record.argv) &&
				info.startedAt >= record.startedAt - START_SLACK.before &&
				info.startedAt <= record.startedAt + START_SLACK.after
			);
		};
		if (!(await ours())) {
			const seen = await this.#inspect(record.pid);
			console.warn(
				`omp-webd: pid ${record.pid} from a previous run's broker record is alive but is not provably that broker (ps: ${seen ? JSON.stringify(seen.command) : "unavailable"}); leaving it alone. If it is a leftover broker, stop it by hand.`,
			);
			await rm(this.#pidFile, { force: true });
			return "foreign";
		}
		console.warn(`omp-webd: stopping a leftover auth broker of a previous run (pid ${record.pid})`);
		process.kill(record.pid, "SIGINT");
		const deadline = this.#now() + this.#stopGraceMs;
		while (isAlive(record.pid) && this.#now() < deadline) await Bun.sleep(50);
		if (isAlive(record.pid) && (await ours())) {
			process.kill(record.pid, "SIGKILL");
			while (isAlive(record.pid)) await Bun.sleep(20);
		}
		await rm(this.#pidFile, { force: true });
		return "reaped";
	}

	/**
	 * Windows: the record names the launcher and the real broker below it. Whatever of that is still alive is stopped as a
	 * tree, but only a process whose pid, creation time and command line are the recorded ones: a pid can be reused, and a
	 * process that cannot be told (PowerShell/CIM unavailable) is left alone. `foreign` = something alive, nothing provably ours.
	 */
	async #reapTree(record: BrokerRecord): Promise<"none" | "reaped" | "foreign"> {
		const procs = record.procs ?? [{ pid: record.pid, startedAt: record.startedAt, command: null }];
		const alive = procs.filter(p => isAlive(p.pid));
		if (alive.length === 0) {
			await rm(this.#pidFile, { force: true });
			return "none";
		}
		const seen = await this.#inspectAll(alive.map(p => p.pid));
		const ours = alive.filter(p => {
			const info = seen.get(p.pid);
			if (!info) return false;
			// recorded with its command line: exactly that, started when it was; the early record (launcher only, written
			// before the child existed) has the argv it was spawned with and the slack the POSIX record uses
			return p.command !== null
				? info.command === p.command && Math.abs(info.startedAt - p.startedAt) <= 2_000
				: sameCommand(info.command, record.argv) &&
						info.startedAt >= p.startedAt - START_SLACK.before &&
						info.startedAt <= p.startedAt + START_SLACK.after;
		});
		if (ours.length === 0) {
			console.warn(
				`omp-webd: pid ${alive.map(p => p.pid).join(", ")} from a previous run's broker record is alive but is not provably that broker; leaving it alone. If it is a leftover broker, stop it by hand.`,
			);
			await rm(this.#pidFile, { force: true });
			return "foreign";
		}
		console.warn(
			`omp-webd: stopping a leftover auth broker of a previous run (pid ${ours.map(p => p.pid).join(", ")}; Windows: killed as a tree, no graceful stop)`,
		);
		for (const p of ours) killProcessTree(p.pid);
		const deadline = this.#now() + 5_000;
		while (ours.some(p => isAlive(p.pid)) && this.#now() < deadline) await Bun.sleep(20);
		await rm(this.#pidFile, { force: true });
		return "reaped";
	}

	async #run(): Promise<void> {
		await this.reapStale().catch(error => {
			console.warn(
				`omp-webd: could not check for a leftover auth broker: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		let delay = this.#backoff.minMs;
		let first = true;
		while (!this.#stopping) {
			const startedAt = this.#now();
			this.#set({
				phase: "starting",
				healthy: false,
				pid: null,
				nextRetryAt: null,
				...(first ? {} : { restarts: this.#status.restarts + 1 }),
			});
			first = false;
			const failure = await this.#attempt();
			if (this.#stopping) break;
			const ranMs = this.#now() - startedAt;
			if (ranMs >= this.#backoff.stableMs) delay = this.#backoff.minMs;
			this.#set({
				phase: "restarting",
				healthy: false,
				pid: null,
				lastError: { message: failure, at: this.#now() },
				nextRetryAt: this.#now() + delay,
			});
			await this.#sleep(delay);
			delay = Math.min(delay * 2, this.#backoff.maxMs);
		}
	}

	/** One start-to-exit run of the child. Returns why it ended. */
	async #attempt(): Promise<string> {
		try {
			this.#token = await this.#getToken(this.#env);
		} catch (error) {
			return `cannot read the broker token: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (this.#stopping) return "stopped";
		const configRoot = dirname(this.#token.path);
		this.#set({ tokenFile: this.#token.path, agentDb: join(configRoot, "agent", "agent.db") });
		const argv = this.options.serveArgv ?? [
			this.options.ompPath,
			"auth-broker",
			"serve",
			"--bind",
			`${this.#bind.host}:${this.#bind.port}`,
		];
		let child: BrokerChild;
		try {
			child = this.#spawn(argv, this.#env);
		} catch (error) {
			return `cannot start the broker: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.#child = child;
		this.#startedAt = this.#now();
		await Bun.write(
			this.#pidFile,
			JSON.stringify({ pid: child.pid, startedAt: this.#startedAt, argv: child.argv } satisfies BrokerRecord),
		).catch(() => {});
		if (child.descendants) void this.#recordTree(child);
		this.#set({ pid: child.pid, startedAt: this.#now() });
		this.#notifyTokenKnown();
		try {
			const up = await this.#awaitHealthy(child);
			if (this.#stopping) {
				await child.exited;
				return "stopped";
			}
			if (up === null) {
				// exited before answering
				const ended = await child.exited;
				return describeExit(ended, child.tail());
			}
			if (up === "timeout") {
				child.kill("SIGKILL");
				const ended = await child.exited;
				return `did not answer ${this.#url}/v1/healthz within ${Math.round(this.#startTimeoutMs / 1000)} s (${describeExit(ended, child.tail())})`;
			}
			this.#set({ phase: "running", healthy: true, version: up.version, checkedAt: this.#now() });
			const monitor = setInterval(() => void this.#probe(), this.#healthIntervalMs);
			try {
				const ended = await child.exited;
				return describeExit(ended, child.tail());
			} finally {
				clearInterval(monitor);
			}
		} finally {
			this.#child = null;
			// Windows: the launcher can be gone while its child still listens (killed from outside, or a crash of the launcher).
			if (child.descendants) await this.reapStale().catch(() => {});
			this.#tree.clear();
			await rm(this.#pidFile, { force: true });
		}
	}

	/** Waits for the first healthy answer: `{version}`, `null` when the child exited first, `"timeout"` otherwise. */
	async #awaitHealthy(child: BrokerChild): Promise<{ version: string | null } | null | "timeout"> {
		let exited = false;
		void child.exited.then(() => {
			exited = true;
		});
		const deadline = this.#now() + this.#startTimeoutMs;
		while (!exited && !this.#stopping) {
			const health = await this.#health();
			if (health) return health;
			if (this.#now() > deadline) return "timeout";
			await Bun.sleep(150);
		}
		return exited ? null : "timeout";
	}

	async #health(): Promise<{ version: string | null } | null> {
		try {
			const response = await this.#fetch(`${this.#url}/v1/healthz`, { signal: AbortSignal.timeout(2_000) });
			if (!response.ok) return null;
			const body: unknown = await response.json();
			const version =
				typeof body === "object" && body !== null && "version" in body && typeof body.version === "string"
					? body.version
					: null;
			return { version };
		} catch {
			return null;
		}
	}

	async #probe(): Promise<void> {
		const health = await this.#health();
		if (this.#status.phase !== "running") return;
		this.#status = { ...this.#status, checkedAt: this.#now() };
		if (health === null && this.#status.healthy) this.#set({ healthy: false });
		else if (health !== null && (!this.#status.healthy || health.version !== this.#status.version))
			this.#set({ healthy: true, version: health.version });
	}

	#notifyTokenKnown(): void {
		for (const listener of this.#listeners) listener();
	}

	#sleep(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			this.#wake = null;
			resolve();
		}, ms);
		this.#wake = () => {
			clearTimeout(timer);
			this.#wake = null;
			resolve();
		};
		return promise;
	}

	#set(patch: Partial<BrokerStatus>): void {
		const next = { ...this.#status, ...patch };
		const changed = (Object.keys(patch) as (keyof BrokerStatus)[]).some(
			key => JSON.stringify(this.#status[key]) !== JSON.stringify(next[key]),
		);
		this.#status = next;
		if (changed) for (const listener of this.#listeners) listener();
	}
}

function describeExit(ended: { code: number | null; signal: string | null }, tail: string): string {
	const how = ended.signal ? `killed by ${ended.signal}` : `exited with code ${ended.code}`;
	const output = tail.trim().split("\n").slice(-4).join(" | ").slice(-400);
	return output === "" ? how : `${how}: ${output}`;
}
