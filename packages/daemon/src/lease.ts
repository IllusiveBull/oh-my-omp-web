import { statSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { getBaseConfigRoot, getSessionOwnersDir, getSessionsDir } from "@oh-my-pi/pi-utils/dirs";

/** Ids per `omp session lease` invocation: keeps argv far below the Windows command-line limit. */
const IDS_PER_PROBE = 200;

export interface LeaseReport {
	/** Ids whose ownership lease is held by a live omp process. */
	held: Set<string>;
	/** Ids the platform could not answer for. */
	unknown: Set<string>;
}

/**
 * Which of `ids` a running omp owns, via `omp session lease --json -- <id>...` (omp >= 18.14.1). The probe does not
 * take the lease. Throws when the command fails or prints something else than `{held, unknown}`: callers must not
 * read a failed probe as "free".
 */
export async function probeLeases(ompPath: string, ids: readonly string[]): Promise<LeaseReport> {
	const report: LeaseReport = { held: new Set(), unknown: new Set() };
	const chunks: string[][] = [];
	for (let i = 0; i < ids.length; i += IDS_PER_PROBE) chunks.push(ids.slice(i, i + IDS_PER_PROBE));
	await Promise.all(
		chunks.map(async chunk => {
			const proc = Bun.spawn([ompPath, "session", "lease", "--json", "--", ...chunk], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (code !== 0) throw new Error(`omp session lease exited with ${code}: ${err.trim() || out.trim()}`);
			let parsed: unknown;
			try {
				parsed = JSON.parse(out);
			} catch {
				throw new Error(`omp session lease printed non-JSON output: ${out.slice(0, 200)}`);
			}
			if (!isRecord(parsed) || !Array.isArray(parsed.held) || !Array.isArray(parsed.unknown)) {
				throw new Error(`omp session lease printed an unexpected shape: ${out.slice(0, 200)}`);
			}
			for (const id of parsed.held) if (typeof id === "string") report.held.add(id);
			for (const id of parsed.unknown) if (typeof id === "string") report.unknown.add(id);
		}),
	);
	return report;
}

/** Facts about the environment that decide where leases live; see {@link checkLeaseEnvironment}. */
export interface LeaseFacts {
	platform: NodeJS.Platform;
	/** `HOME` / `USERPROFILE` as this process sees it. */
	home: string;
	/** Home directory of the OS account this process runs as (`getpwuid`), which a TUI started from a login shell uses. */
	accountHome: string;
	/** Directory holding the per-session lease files (derived from HOME and `PI_CONFIG_DIR`). */
	ownersDir: string;
	ownersDirExists: boolean;
	/** omp config root (`~/.omp`, honours `PI_CONFIG_DIR`). */
	configRoot: string;
	/** Directory the daemon lists sessions from. */
	sessionsDir: string;
	sessionsDirExists: boolean;
	/** Uid owning the sessions directory, when the platform has one. */
	sessionsDirUid: number | undefined;
	uid: number | undefined;
	env: { piConfigDir?: string; piCodingAgentDir?: string; xdgStateHome?: string };
}

export function collectLeaseFacts(sessionsDirOverride?: string): LeaseFacts {
	const sessionsDir = sessionsDirOverride ? resolve(sessionsDirOverride) : getSessionsDir();
	const ownersDir = getSessionOwnersDir();
	const stat = (path: string) => statSync(path, { throwIfNoEntry: false });
	const sessionsStat = stat(sessionsDir);
	return {
		platform: platform(),
		home: homedir(),
		accountHome: userInfo().homedir,
		ownersDir,
		ownersDirExists: stat(ownersDir)?.isDirectory() === true,
		configRoot: getBaseConfigRoot(),
		sessionsDir,
		sessionsDirExists: sessionsStat?.isDirectory() === true,
		sessionsDirUid: sessionsStat?.uid,
		uid: typeof process.getuid === "function" ? process.getuid() : undefined,
		env: {
			piConfigDir: Bun.env.PI_CONFIG_DIR,
			piCodingAgentDir: Bun.env.PI_CODING_AGENT_DIR,
			xdgStateHome: Bun.env.XDG_STATE_HOME,
		},
	};
}

/**
 * Warnings for conditions under which `omp session lease` would answer "free" for a session a TUI holds, because the
 * daemon looks in a different lease directory than the TUI writes to.
 *
 * The lease directory follows `HOME` and `PI_CONFIG_DIR` only (not `PI_CODING_AGENT_DIR`), so these checks compare the
 * daemon's own view of the world. What cannot be checked from here: the environment of a TUI the user starts later
 * (or in another login, container, network namespace, or on a Linux box with `XDG_STATE_HOME` set only for the TUI),
 * and Windows named-mutex visibility. Those stay documented limits, not warnings.
 */
export function checkLeaseEnvironment(facts: LeaseFacts): string[] {
	const warnings: string[] = [];
	if (!samePath(facts.home, facts.accountHome, facts.platform)) {
		warnings.push(
			`HOME is ${facts.home} but this account's home is ${facts.accountHome}. A TUI started from a normal login uses the latter, so its session leases are not visible here and held sessions may show as free.`,
		);
	}
	if (facts.uid !== undefined && facts.sessionsDirUid !== undefined && facts.uid !== facts.sessionsDirUid) {
		warnings.push(
			`The session directory ${facts.sessionsDir} belongs to another user (uid ${facts.sessionsDirUid}, daemon runs as ${facts.uid}). That user's omp processes keep their leases under their own home, so held sessions may show as free.`,
		);
	}
	if (facts.env.piCodingAgentDir !== undefined && !isInside(facts.configRoot, resolve(facts.env.piCodingAgentDir))) {
		warnings.push(
			`PI_CODING_AGENT_DIR (${facts.env.piCodingAgentDir}) moves sessions outside ${facts.configRoot}, but session leases still live under HOME/PI_CONFIG_DIR. The TUI must run with the same HOME and PI_CONFIG_DIR as this daemon, or held sessions may show as free.`,
		);
	}
	if (facts.platform === "linux" && facts.env.xdgStateHome !== undefined) {
		warnings.push(
			`XDG_STATE_HOME is set (${facts.env.xdgStateHome}); on Linux omp then keeps leases under ${facts.ownersDir}. A TUI started without the same XDG_STATE_HOME will not be seen.`,
		);
	}
	if (facts.platform !== "linux" && facts.platform !== "win32" && facts.sessionsDirExists && !facts.ownersDirExists) {
		warnings.push(
			`Sessions exist in ${facts.sessionsDir} but the lease directory ${facts.ownersDir} does not: no omp process using this HOME/PI_CONFIG_DIR has ever written a session. If the TUI is used from a different HOME or PI_CONFIG_DIR, held sessions will show as free.`,
		);
	}
	return warnings;
}

/**
 * Whether two home directories are the same place. NTFS paths compare case-insensitively and may differ in separators
 * (`C:\Users\Me` / `c:/users/me/`); POSIX paths compare as they are. On Windows omp reads `USERPROFILE` and ignores
 * `HOME`, and `os.homedir()` follows `USERPROFILE` too, so an unset or different `HOME` is
 * no reason to warn there (a scheduled task has no `HOME` at all).
 */
function samePath(a: string, b: string, platform: string): boolean {
	if (platform !== "win32") return a === b;
	const norm = (p: string): string =>
		win32
			.normalize(p)
			.replace(/[\\/]+$/, "")
			.toLowerCase();
	return norm(a) === norm(b);
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
