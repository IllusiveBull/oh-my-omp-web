import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, win32 } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { PtySession } from "@oh-my-pi/pi-natives";
import { killProcessTree } from "./proc-tree";
import { clampTerminalSize, type TerminalExit, type TerminalInfo, type TerminalPurpose } from "@omp-web/protocol";
import { OutputRing } from "./terminal-ring";
import { TerminalScreen } from "./terminal-screen";
import { joinWindowsServiceJob } from "./windows-job";

// ---------------------------------------------------------------------------
// The pty backend: `PtySession` from `@oh-my-pi/pi-natives`, behind a small interface so the terminal logic is tested
// without a real shell where that is what is under test.
// ---------------------------------------------------------------------------

export interface PtyOutcome {
	/** The shell's exit code; null when the pty did not report one. */
	exitCode: number | null;
	/** It was ended by `kill()` rather than by itself. */
	cancelled: boolean;
}

export interface PtyProcess {
	readonly pid: number | null;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	/**
	 * Ends the process: SIGTERM to its group and SIGHUP to the shell, SIGKILL shortly after (upstream's sequence). On Windows
	 * the pty is closed, which ends the shell and everything below it.
	 */
	kill(): void;
	/** Settles once the process ended and its output was delivered. */
	readonly exited: Promise<PtyOutcome>;
}

export interface PtyLaunch {
	application: string;
	args: string[];
	cwd: string;
	/**
	 * Added to (not replacing) the daemon's own environment: `PtySession` has no way to unset. POSIX removes variables with
	 * `env -u` (see {@link shellLaunch}); Windows overrides them with "" (see {@link shellEnvAdditions}).
	 */
	env: Record<string, string>;
	cols: number;
	rows: number;
}

/** Starts a process on a pty; resolves once it runs, rejects when it cannot be started. */
export type PtyFactory = (launch: PtyLaunch, onData: (chunk: string) => void) => Promise<PtyProcess>;

/** `PtySession`: one run per instance, output as decoded text, 20–400 x 5–200 (verify-5). */
export const nativePty: PtyFactory = async (launch, onData) => {
	const session = new PtySession();
	let releaseJob: (() => void) | undefined;
	const { promise: startup, resolve: started, reject: failed } = Promise.withResolvers<number>();
	const exited = session
		.startArgv(
			{
				application: launch.application,
				args: launch.args,
				cwd: launch.cwd,
				env: launch.env,
				cols: launch.cols,
				rows: launch.rows,
			},
			(error, chunk) => {
				if (error === null) onData(chunk);
			},
			(error, pid) => {
				if (error !== null) return failed(error);
				try {
					releaseJob = joinWindowsServiceJob(pid);
					started(pid);
				} catch (assignmentError) {
					try {
						session.kill();
					} catch {
						killProcessTree(pid);
					}
					failed(assignmentError);
				}
			},
		)
		.then(
			(result): PtyOutcome => ({ exitCode: result.exitCode ?? null, cancelled: result.cancelled }),
			(error: unknown) => {
				failed(error); // before `onStart`: the spawn itself failed
				throw error;
			},
		)
		.finally(() => releaseJob?.());
	// A start that failed is reported through `startup`; the promise must not also surface as an unhandled rejection.
	exited.catch(() => {});
	let pid: number;
	try {
		pid = await startup;
	} catch (error) {
		// Job assignment can fail after CreateProcess succeeded. Do not expose the error before that shell is gone.
		await exited.catch(() => {});
		throw error;
	}
	return {
		pid: pid > 0 ? pid : null,
		write: data => session.write(data),
		resize: (cols, rows) => session.resize(cols, rows),
		kill: () => session.kill(),
		exited,
	};
};

// ---------------------------------------------------------------------------
// What the shell runs as, and with which environment
// ---------------------------------------------------------------------------

/** Variables that carry the daemon's own credentials or wiring; never handed to a shell. */
const DAEMON_ENV_EXACT = ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"];
/** `OMP_WEB_*` (smoke knobs, anything a future setting adds). */
const DAEMON_ENV_PREFIXES = ["OMP_WEB_"];
/**
 * Variables that describe the terminal the *daemon* was started from (Ghostty, iTerm, tmux, a VS Code terminal …): they
 * would tell programs in the web terminal to talk to a terminal that is not there.
 */
const HOST_TERMINAL_ENV_EXACT = [
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TERM_SESSION_ID",
	"TERMINFO",
	"TERMINFO_DIRS",
	"COLORFGBG",
	"TMUX",
	"TMUX_PANE",
	"STY",
	"VTE_VERSION",
	"WT_SESSION",
	"WT_PROFILE_ID",
	"KONSOLE_VERSION",
	"KONSOLE_DBUS_SESSION",
	"SSH_TTY",
];
const HOST_TERMINAL_ENV_PREFIXES = ["ITERM_", "KITTY_", "WEZTERM_", "GHOSTTY_", "ALACRITTY_", "HERDR_"];

function scrubbed(rawName: string, platform: NodeJS.Platform): boolean {
	// Windows environment names are case-insensitive: `omp_auth_broker_token` is the same variable.
	const name = platform === "win32" ? rawName.toUpperCase() : rawName;
	return (
		DAEMON_ENV_EXACT.includes(name) ||
		HOST_TERMINAL_ENV_EXACT.includes(name) ||
		DAEMON_ENV_PREFIXES.some(prefix => name.startsWith(prefix)) ||
		HOST_TERMINAL_ENV_PREFIXES.some(prefix => name.startsWith(prefix))
	);
}

/** The names the daemon's environment holds that a shell must not inherit. */
export function scrubbedNames(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform,
): string[] {
	return Object.keys(env).filter(name => env[name] !== undefined && scrubbed(name, platform));
}

/**
 * The environment a terminal's shell gets: the daemon's own, minus {@link scrubbedNames}, plus `TERM=xterm-256color`,
 * `COLORTERM=truecolor` and, on POSIX, a UTF-8 locale when the daemon has none. `PtySession` can only *add* variables (its
 * command builder starts from the daemon's environment). POSIX removes by `env -u NAME … <shell>` (names only: no value ever
 * appears in an argument list). Windows has no `env`, but a variable given as "" is unset for cmd.exe and PowerShell and
 * set-but-empty for Git Bash: the secret value is gone either way, and no value is in an
 * argument list; this function returns those overrides too. ConPTY shells are UTF-8 (code page 65001) without any locale.
 */
export function shellEnvAdditions(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	const additions: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor" };
	if (platform === "win32") {
		for (const name of scrubbedNames(env, platform)) additions[name] = "";
		return additions;
	}
	const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(v => v !== undefined && v !== "");
	if (locale === undefined || !/utf-?8/i.test(locale)) {
		additions.LANG = platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
		if (env.LC_ALL !== undefined && env.LC_ALL !== "") additions.LC_ALL = additions.LANG;
	}
	return additions;
}

/** What a shell is, for the things that differ: its arguments and how a command is typed and quoted. */
export type ShellKind = "posix" | "cmd" | "powershell" | "gitbash";

/**
 * The kind of a shell by its file name. On Windows: `cmd`, `powershell` (Windows PowerShell and pwsh) and `gitbash`
 * (`bash.exe`/`sh.exe`, i.e. Git for Windows' msys shells); an unrecognised Windows shell is treated as `cmd` (no arguments, no
 * typed-command quoting beyond cmd's).
 */
export function shellKindOf(shell: string, platform: NodeJS.Platform = process.platform): ShellKind {
	if (platform !== "win32") return "posix";
	const name = win32
		.basename(shell)
		.toLowerCase()
		.replace(/\.exe$/, "");
	if (name === "pwsh" || name === "powershell") return "powershell";
	if (name === "bash" || name === "sh") return "gitbash";
	return "cmd";
}

/**
 * `application` and `args` that start `shell` as a login shell without the scrubbed variables. POSIX: `env -u … <shell> -l`.
 * Windows has no login shell; the analogue is the user's profile, which PowerShell loads by default (`-NoLogo` only drops the
 * banner), cmd.exe has none (no AutoRun is set), and Git Bash gets `-l -i` (its `/etc/profile`).
 */
export function shellLaunch(
	shell: string,
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform,
): { application: string; args: string[] } {
	if (platform === "win32") {
		const kind = shellKindOf(shell, platform);
		return { application: shell, args: kind === "powershell" ? ["-NoLogo"] : kind === "gitbash" ? ["-l", "-i"] : [] };
	}
	const unset = scrubbedNames(env, platform).flatMap(name => ["-u", name]);
	return { application: "/usr/bin/env", args: [...unset, shell, "-l"] };
}

export interface ShellSources {
	/** The login shell in the account database, or null. */
	account(): string | null;
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	/** Whether this path can be run. */
	executable(path: string): boolean;
	/** Windows: the first match of a program name on PATH (`pwsh` -> its path), or null. */
	which?(name: string): string | null;
}

function accountShell(): string | null {
	try {
		const info = userInfo();
		if (process.platform === "darwin") {
			const out = Bun.spawnSync(["dscl", ".", "-read", `/Users/${info.username}`, "UserShell"], {
				stderr: "ignore",
			});
			const match = /UserShell:\s*(\S+)/.exec(out.stdout.toString());
			return match?.[1] ?? null;
		}
		for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
			const fields = line.split(":");
			if (fields[2] === String(info.uid) && fields[6]) return fields[6].trim();
		}
	} catch {
		// no account database we can read: fall back to $SHELL
	}
	return null;
}

const defaultSources: ShellSources = {
	account: accountShell,
	env: Bun.env,
	platform: process.platform,
	executable: path => {
		try {
			// lstat, not stat: a Windows app-execution alias (the Store's pwsh.exe) is a reparse point that stat cannot follow
			if (process.platform === "win32") return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink();
			accessSync(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	},
	which: name => Bun.which(name),
};

/**
 * The shell a new terminal starts. POSIX: the configured one, else the user's login shell from the account database, else
 * `$SHELL`, else `/bin/zsh` (macOS) / `/bin/sh`; each candidate must be an absolute path that can be executed.
 *
 * Windows: the configured `terminal.shell` (an absolute path, or a name found on PATH; one that cannot be resolved is an
 * error, never a silent fallback), else `pwsh.exe` when it is on PATH, else Windows PowerShell under `%SystemRoot%`, else
 * `%COMSPEC%`, else `cmd.exe`. Git Bash is only ever used when configured. Always an absolute path.
 */
export function resolveShell(configured: string | undefined, sources: ShellSources = defaultSources): string {
	if (sources.platform === "win32") return resolveWindowsShell(configured, sources);
	const candidates = [
		configured,
		sources.account() ?? undefined,
		sources.env.SHELL,
		sources.platform === "darwin" ? "/bin/zsh" : undefined,
		"/bin/sh",
	];
	for (const candidate of candidates) {
		if (candidate && candidate.startsWith("/") && sources.executable(candidate)) return candidate;
	}
	throw new Error("no usable shell: set terminal.shell in config.json to an absolute path");
}

function resolveWindowsShell(configured: string | undefined, sources: ShellSources): string {
	const which = sources.which ?? (() => null);
	const runnable = (candidate: string): string | null => {
		if (win32.isAbsolute(candidate)) return sources.executable(candidate) ? candidate : null;
		const found = which(candidate);
		return found !== null && win32.isAbsolute(found) ? found : null;
	};
	if (configured !== undefined && configured !== "") {
		const found = runnable(configured);
		if (found === null) {
			throw new Error(
				`terminal.shell "${configured}" cannot be run: it is neither an existing file nor a program on PATH. Set it in config.json ` +
					'to a full path such as "C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe", or remove it to use the default (pwsh, Windows PowerShell, cmd).',
			);
		}
		if (
			sources.env.OMP_WEB_SERVICE_JOB &&
			/(?:^|[\\/])WindowsApps[\\/]/i.test(found) &&
			shellKindOf(found, "win32") === "powershell"
		) {
			throw new Error(
				"Packaged/AppX pwsh is not supported by the Windows service: measured PowerShell 7.7 children escape its job. Set terminal.shell to System32\\WindowsPowerShell\\v1.0\\powershell.exe, or a nonpackaged shell whose cleanup you have verified.",
			);
		}
		return found;
	}
	const systemRoot = sources.env.SystemRoot ?? sources.env.SYSTEMROOT ?? "C:\\Windows";
	if (sources.env.OMP_WEB_SERVICE_JOB) {
		const systemShell = runnable(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
		if (systemShell !== null) return systemShell;
		throw new Error(
			"The Windows service requires system Windows PowerShell by default; configure a verified nonpackaged terminal.shell.",
		);
	}
	const candidates: (string | undefined)[] = [
		"pwsh.exe",
		win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		sources.env.COMSPEC ?? sources.env.ComSpec,
		win32.join(systemRoot, "System32", "cmd.exe"),
	];
	for (const candidate of candidates) {
		const found = candidate ? runnable(candidate) : null;
		if (found !== null) return found;
	}
	throw new Error(
		"no usable shell found (pwsh, Windows PowerShell, cmd): set terminal.shell in config.json to a full path",
	);
}

// ---------------------------------------------------------------------------
// One terminal
// ---------------------------------------------------------------------------

/** A pty size in force from `offset` of the output on. `n` increases with every event (clients track which they saw). */
export interface SizeEvent {
	n: number;
	offset: number;
	cols: number;
	rows: number;
}

export interface PtyTerminalOptions {
	id: string;
	factory: PtyFactory;
	shell: string;
	cwd: string;
	cols: number;
	rows: number;
	ringChars: number;
	scrollbackLines: number;
	/** Name shown until the program sets a title. */
	name: string;
	purpose?: TerminalPurpose["kind"];
	env: Record<string, string | undefined>;
	now: () => number;
	/** Typed into the shell right after it started, without a line break. */
	initialInput?: string;
}

/** Pre-typed text waits for the shell's first prompt to settle: this much silence after its output, or this long at most. */
const TYPE_AFTER_QUIET_MS = 150;
const TYPE_GIVE_UP_MS = 3000;

/** Shells get this long to react to SIGHUP before the daemon kills the process group itself. */
const KILL_ESCALATION_MS = 1500;

/**
 * One persistent shell: the pty process, the ring of its output, the screen emulator that follows it, and the size
 * timeline. It knows nothing about clients; {@link TerminalService} attaches them through the listeners.
 */
export class PtyTerminal {
	readonly ring: OutputRing;
	readonly screen: TerminalScreen;
	readonly #sizes: SizeEvent[] = [];
	#sizeCount = 0;
	#proc: PtyProcess | null = null;
	#info: TerminalInfo;
	#killRequested = false;
	#typingTimer: ReturnType<typeof setTimeout> | null = null;
	#exited: Promise<void> = Promise.resolve();
	readonly #output = new Set<() => void>();
	readonly #size = new Set<(event: SizeEvent) => void>();
	readonly #exit = new Set<() => void>();
	readonly #infoListeners = new Set<() => void>();

	private constructor(
		private readonly options: PtyTerminalOptions,
		size: { cols: number; rows: number },
	) {
		this.ring = new OutputRing(options.ringChars);
		this.#info = {
			id: options.id,
			name: options.name,
			title: null,
			cwd: options.cwd,
			shell: options.shell,
			pid: null,
			createdAt: options.now(),
			cols: size.cols,
			rows: size.rows,
			state: "running",
			exit: null,
			...(options.purpose ? { purpose: options.purpose } : {}),
		};
		this.#sizes.push({ n: this.#sizeCount++, offset: 0, cols: size.cols, rows: size.rows });
		this.screen = new TerminalScreen(this.ring, {
			cols: size.cols,
			rows: size.rows,
			scrollback: options.scrollbackLines,
			onTitle: title => {
				const clean = title
					.replace(/\p{Cc}/gu, " ")
					.trim()
					.slice(0, 200);
				this.#setInfo({ title: clean === "" ? null : clean });
			},
		});
	}

	/** Starts the shell. Rejects (and leaves nothing running) when it cannot be started. */
	static async spawn(options: PtyTerminalOptions): Promise<PtyTerminal> {
		const size = clampTerminalSize(options.cols, options.rows);
		const terminal = new PtyTerminal(options, size);
		const launch = shellLaunch(options.shell, options.env);
		try {
			terminal.#proc = await options.factory(
				{
					...launch,
					cwd: options.cwd,
					env: shellEnvAdditions(options.env),
					cols: size.cols,
					rows: size.rows,
				},
				chunk => terminal.#onData(chunk),
			);
		} catch (error) {
			terminal.screen.dispose();
			throw error;
		}
		terminal.#info = { ...terminal.#info, pid: terminal.#proc.pid };
		terminal.#exited = terminal.#proc.exited.then(
			outcome => terminal.#onExit(outcome.exitCode, outcome.cancelled),
			() => terminal.#onExit(null, false),
		);
		if (options.initialInput) terminal.#typeWhenReady(options.initialInput);
		return terminal;
	}

	get info(): TerminalInfo {
		return this.#info;
	}

	get running(): boolean {
		return this.#info.state === "running";
	}

	get sizes(): readonly SizeEvent[] {
		return this.#sizes;
	}

	onOutput(listener: () => void): () => void {
		this.#output.add(listener);
		return () => this.#output.delete(listener);
	}

	onSize(listener: (event: SizeEvent) => void): () => void {
		this.#size.add(listener);
		return () => this.#size.delete(listener);
	}

	onExit(listener: () => void): () => void {
		this.#exit.add(listener);
		return () => this.#exit.delete(listener);
	}

	/** Title, size or state changed. */
	onInfo(listener: () => void): () => void {
		this.#infoListeners.add(listener);
		return () => this.#infoListeners.delete(listener);
	}

	write(data: string): void {
		if (!this.running) return;
		try {
			this.#proc?.write(data);
		} catch {
			// the process is going away: its exit is reported separately
		}
	}

	/** Applies a (clamped) size to the pty; true when it changed. The change is recorded at the current end of the output. */
	resize(cols: number, rows: number): boolean {
		if (!this.running) return false;
		const size = clampTerminalSize(cols, rows);
		if (size.cols === this.#info.cols && size.rows === this.#info.rows) return false;
		try {
			this.#proc?.resize(size.cols, size.rows);
		} catch {
			return false;
		}
		const event: SizeEvent = { n: this.#sizeCount++, offset: this.ring.head, ...size };
		this.#sizes.push(event);
		const keep = this.#sizes.findLastIndex(e => e.offset <= this.ring.start);
		if (keep > 0) this.#sizes.splice(0, keep);
		this.screen.noteResize(event.offset, size.cols, size.rows);
		this.#setInfo(size);
		for (const listener of this.#size) listener(event);
		return true;
	}

	/** Ends the shell and resolves once it is gone (escalating to SIGKILL of its group if it ignores the hangup). */
	async kill(): Promise<void> {
		if (!this.running) return this.#exited;
		this.#killRequested = true;
		try {
			this.#proc?.kill();
		} catch {
			// already gone
		}
		const pid = this.#proc?.pid;
		const timer = setTimeout(() => {
			if (pid === null || pid === undefined || !this.running) return;
			if (process.platform === "win32") {
				killProcessTree(pid);
				return;
			}
			for (const target of [-pid, pid]) {
				try {
					process.kill(target, "SIGKILL");
				} catch {
					// not there any more
				}
			}
		}, KILL_ESCALATION_MS);
		await Promise.race([this.#exited, Bun.sleep(KILL_ESCALATION_MS + 1500)]);
		clearTimeout(timer);
	}

	dispose(): void {
		clearTimeout(this.#typingTimer ?? undefined);
		this.screen.dispose();
	}

	/**
	 * Types `text` (no line break) once the shell is reading: input that arrives before the first prompt is echoed by the
	 * tty and then drawn again by the shell's line editor, which shows the text twice. So: after the first output, wait for
	 * a quiet moment; if the shell prints nothing at all, type anyway after a few seconds.
	 */
	#typeWhenReady(text: string): void {
		const type = (): void => {
			off();
			clearTimeout(this.#typingTimer ?? undefined);
			this.#typingTimer = null;
			this.write(text);
		};
		let hasVisibleOutput = false;
		const afterOutput = (): void => {
			// ConPTY emits cursor queries, title/mode changes and blank resize repaints before PowerShell's prompt.
			// Silence after those controls is not shell readiness: typing then can lose the first character.
			if (!hasVisibleOutput) {
				hasVisibleOutput =
					stripVTControlCharacters(this.ring.slice(this.ring.start, Number.MAX_SAFE_INTEGER)).trim() !== "";
				if (!hasVisibleOutput) return;
			}
			clearTimeout(this.#typingTimer ?? undefined);
			this.#typingTimer = setTimeout(type, TYPE_AFTER_QUIET_MS);
		};
		const off = this.onOutput(afterOutput);
		this.#typingTimer = setTimeout(type, TYPE_GIVE_UP_MS);
		afterOutput();
	}

	#onData(chunk: string): void {
		this.ring.append(chunk);
		this.screen.pump();
		for (const listener of this.#output) listener();
	}

	#onExit(code: number | null, cancelled: boolean): void {
		if (!this.running) return;
		const exit: TerminalExit = { code, killed: cancelled || this.#killRequested, at: this.options.now() };
		this.#setInfo({ state: "exited", exit });
		for (const listener of this.#exit) listener();
	}

	#setInfo(patch: Partial<TerminalInfo>): void {
		this.#info = { ...this.#info, ...patch };
		for (const listener of this.#infoListeners) listener();
	}
}

/** The label of a terminal before its program sets a title. */
export const shellName = (shell: string): string => basename(shell).replace(/\.exe$/i, "");
