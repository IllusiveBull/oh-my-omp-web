/**
 * Runs git for the file browser, hardened: a repository's own configuration must not make the daemon execute anything.
 *
 * - argv arrays only (never a shell); callers put `--` before paths; `--literal-pathspecs` so names are never magic.
 * - The environment is rebuilt without any inherited `GIT_*` variable (no `GIT_DIR`, `GIT_EXTERNAL_DIFF`, …) and with
 *   `GIT_OPTIONAL_LOCKS=0`, no pager, no prompts.
 * - Configuration that makes git run programs is overridden through `GIT_CONFIG_COUNT` (git >= 2.31; key names may then
 *   contain anything): `core.fsmonitor` (a hook or the fsmonitor daemon), `core.hooksPath`, `core.pager`, and every `filter.<name>.{clean,smudge,process}`
 *   defined anywhere except git-lfs's own fixed command lines (filters run on `status` and `diff` for files an attributes
 *   file names). Callers of `diff` also pass `--no-ext-diff --no-textconv` (external diff drivers, textconv).
 * - `--work-tree=<root>` pins the tree git examines (a `core.worktree` in the repository's config would otherwise redirect
 *   it: it is read before overrides apply).
 * - One process at a time per slot (4 slots), a timeout that kills the process, and output caps that kill it too.
 */
import { FileError } from "./file-path";

const SLOTS = 4;
let free = SLOTS;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
	if (free > 0) {
		free -= 1;
		return;
	}
	await new Promise<void>(resolve => waiting.push(resolve));
}

function release(): void {
	const next = waiting.shift();
	if (next) next();
	else free += 1;
}

export interface GitResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
	/** Output beyond `maxBytes` was dropped (and the process stopped). */
	truncated: boolean;
	timedOut: boolean;
}

export interface GitOptions {
	timeoutMs?: number;
	/** Cap on stdout; default 8 MiB. */
	maxBytes?: number;
	/** Written to the process's stdin. */
	stdin?: Uint8Array;
	/**
	 * Pathspecs are taken literally (default). `check-ignore` refuses that mode ("pathspec magic not supported"), so it
	 * is fed through stdin without it; the caller then must not pass names git could read as magic (a leading `:`).
	 */
	magicPathspecs?: boolean;
	/** Do not pin the work tree (for commands that are not about a repository). */
	noRepository?: boolean;
	/**
	 * Variables set after the `GIT_*` scrub, for callers that need a specific `GIT_INDEX_FILE`, author/committer identity,
	 * `HOME` or `GIT_CONFIG_GLOBAL`. `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` stay reserved for
	 * the hardening below (use `config` instead).
	 */
	env?: Record<string, string>;
	/** Extra `key=value` configuration, appended after (and so winning over) the hardening overrides. */
	config?: readonly (readonly [string, string])[];
}

const STDERR_MAX = 64 * 1024;

/** The commands of git-lfs's `git lfs install`: the only filters that are let through (they run the user's own git-lfs). */
const LFS_FILTER_VALUES: Record<string, true> = {
	"git-lfs clean -- %f": true,
	"git-lfs smudge -- %f": true,
	"git-lfs smudge --skip -- %f": true,
	"git-lfs filter-process": true,
	"git-lfs filter-process --skip": true,
	"": true,
};

/** Whether a `filter.<name>.*` value is one of git-lfs's fixed command lines (or empty). */
export function isTrustedFilterValue(value: string): boolean {
	return LFS_FILTER_VALUES[value.trim()] === true;
}

const NULL_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

/** What every call overrides regardless of the repository. */
function baseOverrides(): [string, string][] {
	return [
		["core.fsmonitor", "false"],
		["core.useBuiltinFSMonitor", "false"],
		["core.hooksPath", NULL_PATH],
		["core.pager", "cat"],
		["core.quotePath", "false"],
		["color.ui", "never"],
		["diff.noprefix", "false"],
		["diff.mnemonicPrefix", "false"],
		["gc.auto", "0"],
		["maintenance.auto", "false"],
	];
}

function environment(
	overrides: readonly (readonly [string, string])[],
	literal: boolean,
	extra?: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.toUpperCase().startsWith("GIT_")) continue;
		env[key] = value;
	}
	Object.assign(env, {
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_PAGER: "cat",
		...(literal ? { GIT_LITERAL_PATHSPECS: "1" } : {}),
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_CONFIG_COUNT: String(overrides.length),
		LC_ALL: "C",
	});
	overrides.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	if (extra) {
		for (const [key, value] of Object.entries(extra)) {
			if (/^GIT_CONFIG_(COUNT|PARAMETERS|KEY_|VALUE_)/i.test(key)) {
				throw new FileError("git", `the environment variable ${key} is reserved for the git hardening`);
			}
			env[key] = value;
		}
	}
	return env;
}

async function readCapped(
	stream: ReadableStream<Uint8Array>,
	max: number,
	onFull: () => void,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (size + value.length > max) {
				chunks.push(value.subarray(0, max - size));
				size = max;
				truncated = true;
				onFull();
				break;
			}
			chunks.push(value);
			size += value.length;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return { bytes, truncated };
}
// A Windows-only launcher joins a kill-on-close job before spawning git. The last job
// handle closes on launcher death, including timeout, output cap, and normal git exit.
// This invokes the current Bun runtime; compiled-daemon packaging is not validated.
const WINDOWS_GIT_LAUNCHER = `
import { dlopen } from "bun:ffi";
const k = dlopen("kernel32.dll", {
  CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
  SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
  GetCurrentProcess: { args: [], returns: "ptr" },
  AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
  GetLastError: { args: [], returns: "u32" },
});
const job = k.symbols.CreateJobObjectW(null, null);
if (!job) throw new Error("CreateJobObjectW: " + k.symbols.GetLastError());
try {
  const limits = new Uint8Array(144);
  new DataView(limits.buffer).setUint32(16, 0x2000, true);
  if (!k.symbols.SetInformationJobObject(job, 9, limits, limits.byteLength) ||
      !k.symbols.AssignProcessToJobObject(job, k.symbols.GetCurrentProcess()))
    throw new Error("cannot contain git in Windows job: " + k.symbols.GetLastError());
  const child = Bun.spawn(JSON.parse(process.argv.at(-1)), { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  process.exit(code);
} catch (error) {
  k.symbols.CloseHandle(job);
  k.close();
  throw error;
}
`;

async function spawnGit(
	root: string,
	args: readonly string[],
	overrides: readonly (readonly [string, string])[],
	options: GitOptions,
): Promise<GitResult> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
	const literal = options.magicPathspecs !== true;
	await acquire();
	try {
		let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
		const argv = [
			"git",
			"--no-pager",
			"--no-optional-locks",
			...(literal ? ["--literal-pathspecs"] : []),
			"-C",
			root,
			// `core.worktree` in the repository's own config is read before any override applies; this wins over it.
			...(options.noRepository ? [] : [`--work-tree=${root}`]),
			...args,
		];
		try {
			proc = Bun.spawn(
				process.platform === "win32" ? [process.execPath, "-e", WINDOWS_GIT_LAUNCHER, JSON.stringify(argv)] : argv,
				{
					stdin: options.stdin ? "pipe" : "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: environment(overrides, literal, options.env),
				},
			);
		} catch (error) {
			throw new FileError("git", `cannot run git: ${error instanceof Error ? error.message : String(error)}`);
		}
		const stop = (): void => {
			if (proc.exitCode === null) proc.kill("SIGKILL");
		};
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, timeoutMs);
		try {
			if (options.stdin) {
				const sink = proc.stdin as { write(data: Uint8Array): unknown; end(): unknown };
				// A process that exits without reading its input closes the pipe; that is its exit code's business.
				void Promise.resolve()
					.then(() => {
						sink.write(options.stdin!);
						return sink.end();
					})
					.catch(() => {});
			}
			const [out, err, code] = await Promise.all([
				readCapped(proc.stdout, maxBytes, stop),
				readCapped(proc.stderr, STDERR_MAX, () => {}),
				proc.exited,
			]);
			return {
				code,
				stdout: out.bytes,
				stderr: new TextDecoder().decode(err.bytes),
				truncated: out.truncated,
				timedOut,
			};
		} finally {
			clearTimeout(timer);
			stop();
		}
	} finally {
		release();
	}
}

/** `filter.<name>` names of every scope whose clean/smudge/process command is not git-lfs's own. */
async function untrustedFilters(root: string, env?: Record<string, string>): Promise<string[]> {
	const result = await spawnGit(root, ["config", "-z", "--get-regexp", "^filter\\."], baseOverrides(), {
		timeoutMs: 5000,
		maxBytes: 1024 * 1024,
		...(env ? { env } : {}),
	});
	if (result.code === 1) return []; // no match
	if (result.code !== 0)
		throw new FileError("git", `cannot read the repository's configuration: ${result.stderr.trim()}`);
	const names = new Set<string>();
	for (const entry of new TextDecoder().decode(result.stdout).split("\0")) {
		if (entry === "") continue;
		const newline = entry.indexOf("\n");
		const key = newline < 0 ? entry : entry.slice(0, newline);
		const value = newline < 0 ? "" : entry.slice(newline + 1);
		const match = /^filter\.(.*)\.(clean|smudge|process|required)$/is.exec(key);
		if (!match) continue;
		if (match[2]!.toLowerCase() === "required") continue;
		if (!isTrustedFilterValue(value)) names.add(match[1]!);
	}
	return [...names];
}

let versionCheck: Promise<void> | null = null;

/** git >= 2.31 is needed for `GIT_CONFIG_COUNT`; checked once. */
function requireModernGit(): Promise<void> {
	versionCheck ??= (async () => {
		const out = await spawnGit(process.cwd(), ["--version"], [], {
			timeoutMs: 5000,
			maxBytes: 4096,
			noRepository: true,
		});
		const match = /(\d+)\.(\d+)/.exec(new TextDecoder().decode(out.stdout));
		if (out.code !== 0 || !match) throw new FileError("git", "cannot run git (is it installed and on PATH?)");
		const [major, minor] = [Number(match[1]), Number(match[2])];
		if (major < 2 || (major === 2 && minor < 31)) {
			throw new FileError("git", `git ${match[0]} is too old for the file browser (2.31 or newer is required)`);
		}
	})().catch(error => {
		versionCheck = null; // a later call checks again (git may have been installed meanwhile)
		throw error;
	});
	return versionCheck;
}

/** Runs `git <args>` in `root` (a canonical worktree root) with the hardening described above. */
export async function runGit(root: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
	await requireModernGit();
	const overrides = baseOverrides();
	for (const name of await untrustedFilters(root, options.env)) {
		for (const variable of ["clean", "smudge", "process"]) overrides.push([`filter.${name}.${variable}`, ""]);
		overrides.push([`filter.${name}.required`, "false"]);
	}
	if (options.config) overrides.push(...options.config.map(([key, value]): [string, string] => [key, value]));
	return spawnGit(root, args, overrides, options);
}
