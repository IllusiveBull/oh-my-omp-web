/**
 * The session half of switching a thread to another environment: thin wrappers over `omp session pack|unpack|moved`
 * and the few file operations around an unpacked copy (header normalization, cleanup, a history fingerprint).
 *
 * omp owns the transfer format and the ownership leases; this module never reimplements them. It only runs the CLI with an
 * argv array (no shell), turns its outcome into a {@link SessionTransferError} the user can read, and edits the one line of
 * the unpacked copy omp leaves for the daemon to fix: line 2, the session header. Every other byte of a session file is
 * omp's and is preserved exactly.
 */
import type { Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { isRecord } from "@oh-my-pi/pi-utils";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { restrictPath } from "./file-acl";
import { killProcessTree } from "./proc-tree";

/**
 * `refused`: omp declined the operation and changed nothing (a live process holds the session, the archive is the wrong
 * version, the file is not a session, …); the message is fit to show the user. `failed`: anything else (omp could not be
 * run, crashed, timed out, printed something unexpected); the state of the files is not known.
 */
export class SessionTransferError extends Error {
	constructor(
		message: string,
		readonly kind: "refused" | "failed",
	) {
		super(message);
		this.name = "SessionTransferError";
	}
}

/** How to run `omp`: the binary, extra environment on top of the daemon's own, and a deadline. */
export interface OmpRun {
	ompPath: string;
	/** Overrides on top of `Bun.env`; an `undefined` value removes the variable. */
	env?: Record<string, string | undefined>;
	/** Kills the process after this long (default 120 s). */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_CAP_BYTES = 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
/** How far into a session file the title slot and header must lie (the slot is 256 bytes; a header is a few KiB). */
const HEADER_SEARCH_BYTES = 1024 * 1024;
const LABEL_MAX_CHARS = 120;
const MESSAGE_MAX_CHARS = 600;

// Escape sequences chalk wraps around omp's `error:` / warning lines when it believes stderr is a terminal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

const failed = (message: string): SessionTransferError => new SessionTransferError(message, "failed");

// ---------------------------------------------------------------------------
// Running omp
// ---------------------------------------------------------------------------

interface OmpOutput {
	stdout: string;
	/** ANSI-stripped. */
	stderr: string;
}

/** Keeps the first `max` bytes of a stream but reads it to the end, so a chatty child never blocks on a full pipe. */
async function drain(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (size < max) {
			const part = value.subarray(0, max - size);
			chunks.push(part);
			size += part.length;
		}
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return new TextDecoder().decode(bytes);
}

function childEnv(overrides: OmpRun["env"]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) if (value !== undefined) env[key] = value;
	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

function clip(text: string): string {
	return text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS)}…` : text;
}

/** The text of omp's `error: <message>` line (its way of reporting a refusal), if it printed one. */
function ompErrorLine(stderr: string): string | undefined {
	for (const line of stderr.split(/\r?\n/)) {
		const match = /^\s*error:\s*(.+?)\s*$/.exec(line);
		if (match) return match[1];
	}
	return undefined;
}

function lastLine(text: string): string | undefined {
	return text
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)
		.at(-1);
}

/** `omp` on Windows is a launcher whose child does the work: kill the whole tree there (see proc-tree.ts). */
function stop(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): void {
	if (process.platform !== "win32") proc.kill("SIGKILL");
	else if (proc.exitCode === null) killProcessTree(proc.pid); // never aim at a pid that may be reused
}

/** Runs `omp session <action> …`; resolves with the output on exit code 0, throws a {@link SessionTransferError} otherwise. */
async function runOmpSession(run: OmpRun, action: string, args: readonly string[]): Promise<OmpOutput> {
	const timeoutMs = run.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn([run.ompPath, "session", action, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: childEnv(run.env),
		});
	} catch (error) {
		throw failed(`cannot run omp: ${error instanceof Error ? error.message : String(error)}`);
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		stop(proc);
	}, timeoutMs);
	let stdout: string;
	let stderr: string;
	let code: number;
	try {
		[stdout, stderr, code] = await Promise.all([
			drain(proc.stdout, OUTPUT_CAP_BYTES),
			drain(proc.stderr, OUTPUT_CAP_BYTES),
			proc.exited,
		]);
	} finally {
		clearTimeout(timer);
		stop(proc); // a no-op once it has exited
	}
	if (timedOut) throw failed(`omp session ${action} did not finish within ${Math.round(timeoutMs / 1000)} s`);
	stderr = stderr.replace(ANSI, "");
	if (code !== 0) {
		const refusal = ompErrorLine(stderr);
		if (refusal !== undefined) throw new SessionTransferError(clip(refusal), "refused");
		if (/another live omp process/.test(stderr)) {
			throw new SessionTransferError(clip(lastLine(stderr) ?? stderr), "refused");
		}
		throw failed(clip(lastLine(stderr) ?? `omp session ${action} exited with code ${code}`));
	}
	return { stdout, stderr };
}

/** A path argument as omp must see it: absolute, so it can never be taken for an option. */
function pathArg(path: string, what: string): string {
	if (!path) throw failed(`${what} is empty`);
	return resolve(path);
}

// ---------------------------------------------------------------------------
// omp session pack / unpack / moved
// ---------------------------------------------------------------------------

/**
 * `omp session pack`: writes the archive at `tarPath` (omp replaces it atomically). omp refuses while a live process holds the
 * session's lease, so the hosted process must be stopped first. Blobs the transcript references but the local blob store
 * lost are not packed; their number is reported.
 */
export async function packSessionFile(
	run: OmpRun,
	sessionFile: string,
	tarPath: string,
): Promise<{ missingBlobs: number }> {
	const tar = pathArg(tarPath, "archive path");
	const { stderr } = await runOmpSession(run, "pack", [pathArg(sessionFile, "session file"), tar]);
	const archive = await stat(tar).catch(() => undefined);
	if (!archive?.isFile()) throw failed(`omp session pack reported success but wrote no archive at ${tar}`);
	const warning = /warning:\s*(\d+) referenced blob/.exec(stderr);
	return { missingBlobs: warning ? Number(warning[1]) : 0 };
}

export type UnpackMode = "created" | "replaced" | "forked";

// omp's own sentences (commands/session.ts UNPACK_NOTE), printed to stderr as `<note> (<id>).`
const UNPACK_NOTES: readonly [needle: string, mode: UnpackMode][] = [
	["The local copy of this session diverged; unpacked as a fork", "forked"],
	["Replaced the local copy of this session", "replaced"],
	["Unpacked session", "created"],
];

/**
 * `omp session unpack`: lands the archive in omp's default session directory for `cwd` (omp has no option to choose it) and
 * returns the session file. `mode` tells whether it created a new file, replaced an older local copy of the same session or,
 * because the local copy had diverged, was unpacked as a fork.
 */
export async function unpackSessionArchive(
	run: OmpRun,
	tarPath: string,
	cwd: string,
): Promise<{ file: string; id: string; mode: UnpackMode }> {
	const { stdout, stderr } = await runOmpSession(run, "unpack", [
		pathArg(tarPath, "archive path"),
		`--cwd=${pathArg(cwd, "working directory")}`,
	]);
	const lines = stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
	if (lines.length !== 1)
		throw failed(`omp session unpack printed ${lines.length} lines on stdout, expected the session file`);
	const file = lines[0]!;
	if (!isAbsolute(file) || !file.endsWith(".jsonl")) {
		throw failed(`omp session unpack printed something that is not a session file path: ${clip(file)}`);
	}
	const info = await stat(file).catch(() => undefined);
	if (!info?.isFile()) throw failed(`omp session unpack reported ${file}, which does not exist`);
	const note = UNPACK_NOTES.find(([needle]) => stderr.includes(needle));
	if (!note)
		throw failed(
			`omp session unpack unpacked ${file} but its outcome was not recognized: ${clip(lastLine(stderr) ?? "")}`,
		);
	const id = (await readSessionHeader(file)).header.id;
	if (typeof id !== "string" || !id) throw failed(`unpacked session ${file} has no id`);
	return { file, id, mode: note[1] };
}

/** One line, at most {@link LABEL_MAX_CHARS} characters; what omp writes into the transcript's `departed` notice. */
function sanitizeLabel(label: string): string {
	const line = Array.from(label, ch =>
		ch.charCodeAt(0) < 32 || ch === "\u007f" || ch === "\u2028" || ch === "\u2029" ? " " : ch,
	)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(line).slice(0, LABEL_MAX_CHARS).join("").trim();
}

/** `omp session moved`: appends the `departed` notice to the copy left behind, so resuming it forks. Refused while a process holds it. */
export async function markSessionMoved(run: OmpRun, sessionFile: string, label: string): Promise<void> {
	const to = sanitizeLabel(label);
	if (!to) throw failed("The move label must not be empty.");
	// `--to=<label>` keeps a label that starts with `-` from being read as an option.
	await runOmpSession(run, "moved", [pathArg(sessionFile, "session file"), `--to=${to}`]);
}

// ---------------------------------------------------------------------------
// Session file layout
// ---------------------------------------------------------------------------

export interface SessionHeaderInfo {
	/** Line 1 when it is omp's fixed-width title slot (without its terminator); `""` for a file that has none. */
	slot: string;
	/** Line 2 (line 1 without a slot) parsed. */
	header: Record<string, unknown>;
	additionalDirectories: string[];
	previousSessionFiles: string[];
}

interface HeaderLocation {
	slot: string;
	header: Record<string, unknown>;
	/** Byte offset where the header line's text starts. */
	headerStart: number;
	/** Byte offset just past the header line's text (before its `\r\n` / `\n`). */
	headerEnd: number;
	/** First byte after the header line and its terminator: where the body entries begin. */
	bodyStart: number;
	prefix: Uint8Array;
	size: number;
	mode: number;
	mtimeMs: number;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function parseLine(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(strictUtf8.decode(bytes));
	} catch {
		return undefined;
	}
}

/**
 * Finds the title slot and the header line in the first bytes of `file`. Nothing past the header is read or parsed, so a
 * session of any size costs the same. A `\r` before a line's `\n` belongs to the terminator, not to the JSON.
 */
async function locateHeader(file: string): Promise<HeaderLocation> {
	const not = (why: string) => failed(`${file} is not an omp session file (${why})`);
	let handle: FileHandle;
	try {
		handle = await open(file, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw failed(`Session file not found: ${file}`);
		throw failed(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let prefix: Uint8Array;
	let info: Stats;
	try {
		info = await handle.stat();
		if (!info.isFile()) throw not("not a regular file");
		const buffer = Buffer.alloc(Math.min(info.size, HEADER_SEARCH_BYTES));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		prefix = buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
	const complete = info.size <= HEADER_SEARCH_BYTES;

	/** The line starting at `start`: text end, and where the next one begins. */
	const lineAt = (start: number): { end: number; next: number } | undefined => {
		const newline = prefix.indexOf(0x0a, start);
		if (newline === -1)
			return complete && start < prefix.length ? { end: prefix.length, next: prefix.length } : undefined;
		const end = newline > start && prefix[newline - 1] === 0x0d ? newline - 1 : newline;
		return { end, next: newline + 1 };
	};

	const first = lineAt(0);
	if (!first) throw not("no line end in its first MiB");
	const firstEntry = parseLine(prefix.subarray(0, first.end));
	if (!isRecord(firstEntry)) throw not("its first line is not JSON");
	let slot = "";
	let headerStart = 0;
	let line = first;
	let entry: unknown = firstEntry;
	if (firstEntry.type === "title") {
		slot = strictUtf8.decode(prefix.subarray(0, first.end));
		headerStart = first.next;
		const second = lineAt(first.next);
		if (!second) throw not("no session header after the title slot");
		line = second;
		entry = parseLine(prefix.subarray(headerStart, second.end));
	}
	if (!isRecord(entry) || entry.type !== "session" || typeof entry.id !== "string" || !entry.id) {
		throw not("no session header");
	}
	return {
		slot,
		header: entry,
		headerStart,
		headerEnd: line.end,
		bodyStart: line.next,
		prefix,
		size: info.size,
		mode: info.mode,
		mtimeMs: info.mtimeMs,
	};
}

const stringList = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** The title slot and header of a session file; throws {@link SessionTransferError} when it is not a session journal. */
export async function readSessionHeader(file: string): Promise<SessionHeaderInfo> {
	const located = await locateHeader(file);
	return {
		slot: located.slot,
		header: located.header,
		additionalDirectories: stringList(located.header.additionalDirectories),
		previousSessionFiles: stringList(located.header.previousSessionFiles),
	};
}

/**
 * Edits the header of an unpacked copy before it is forked: drops `previousSessionFiles` (a staging path of the machine it was
 * unpacked on) and, when asked, `additionalDirectories` (paths of the source machine). Only the header line is rewritten
 * (parsed, keys removed, serialized in the original key order, its `\n` / `\r\n` kept); the title slot and every body byte
 * are copied unchanged, through a temp file in the same directory that is renamed over the original, so the file is never
 * seen half-written. A file with nothing to drop is not touched.
 */
export async function normalizeHeader(
	file: string,
	options: { clearAdditionalDirectories: boolean },
): Promise<{ dropped: string[]; removedPreviousSessionFiles: boolean }> {
	const located = await locateHeader(file);
	const header = { ...located.header };
	const removedPreviousSessionFiles = "previousSessionFiles" in header;
	delete header.previousSessionFiles;
	let dropped: string[] = [];
	let changed = removedPreviousSessionFiles;
	if (options.clearAdditionalDirectories && "additionalDirectories" in header) {
		dropped = stringList(header.additionalDirectories);
		delete header.additionalDirectories;
		changed = true;
	}
	if (!changed) return { dropped, removedPreviousSessionFiles };

	const head = Buffer.concat([
		located.prefix.subarray(0, located.headerStart),
		Buffer.from(JSON.stringify(header), "utf8"),
		located.prefix.subarray(located.headerEnd, located.bodyStart),
	]);
	const temp = join(
		dirname(file),
		`.${basename(file)}.normalize-${process.pid}-${crypto.randomUUID().slice(0, 8)}.tmp`,
	);
	let out: FileHandle | undefined;
	let source: FileHandle | undefined;
	try {
		out = await open(temp, "wx", 0o600);
		if (process.platform === "win32") restrictPath(temp);
		await out.write(head);
		source = await open(file, "r");
		const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
		let at = located.bodyStart;
		for (;;) {
			const { bytesRead } = await source.read(chunk, 0, chunk.length, at);
			if (bytesRead === 0) break;
			await out.write(chunk, 0, bytesRead);
			at += bytesRead;
		}
		// The copy is of an intermediate nobody writes to; if the original changed while it was read, publishing would lose that.
		const after = await source.stat();
		if (after.size !== located.size || after.mtimeMs !== located.mtimeMs) {
			throw failed(`${file} changed while its header was being rewritten`);
		}
		await out.chmod(located.mode & 0o7777);
		await out.sync();
		await out.close();
		out = undefined;
		await source.close();
		source = undefined;
		await rename(temp, file);
	} catch (error) {
		await out?.close().catch(() => {});
		await unlink(temp).catch(() => {});
		throw error instanceof SessionTransferError
			? error
			: failed(`cannot rewrite the header of ${file}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await source?.close().catch(() => {});
	}
	return { dropped, removedPreviousSessionFiles };
}

// ---------------------------------------------------------------------------
// Removing a session copy
// ---------------------------------------------------------------------------

/**
 * What belongs to the session file `file`, in the order it is removed (the journal last, so an interrupted removal can be
 * repeated: the journal is what proves the leftovers are a session's). Empty when the journal is already gone.
 */
async function copyFiles(file: string): Promise<string[]> {
	if (!isAbsolute(file) || !file.endsWith(".jsonl") || basename(file) === ".jsonl") {
		throw failed(`refusing to remove ${file}: not an absolute path of a .jsonl session file`);
	}
	const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
		throw failed(`cannot inspect ${file}: ${error.message}`);
	});
	if (!info) return [];
	if (!info.isFile()) throw failed(`refusing to remove ${file}: not a regular file`);
	await locateHeader(file); // throws unless it is a session journal

	const dir = dirname(file);
	const name = basename(file);
	const found: string[] = [];
	const names = await readdir(dir);
	// `<name>.<snowflake>.bak` (omp's rewrite fallback) and `<name>.unpack-<snowflake>.bak` (an unpack that set the copy aside).
	for (const entry of names.sort())
		if (entry.startsWith(`${name}.`) && entry.endsWith(".bak")) found.push(join(dir, entry));
	const extras = [
		file.slice(0, -".jsonl".length), // artifacts directory
		join(dir, `.${name}.lock.os`), // omp's process-owned publish gate, never unlinked by omp
		join(dir, `.${name}.lock`),
	];
	for (const path of extras)
		if (
			await lstat(path).then(
				() => true,
				() => false,
			)
		)
			found.push(path);
	found.push(file);
	return found;
}

/** The paths {@link removeSessionCopy} would remove (recorded in the operation before anything is deleted). */
export function sessionCopyFiles(file: string): Promise<string[]> {
	return copyFiles(file);
}

/**
 * Deletes a session copy: the journal, its artifacts directory, omp's hidden lock file and unpack backups beside it. Only for
 * an absolute `.jsonl` path whose header parses as a session; a journal that is already gone is not an error. The containing
 * directory goes too when `removeEmptyBucket` is set and nothing else is in it. Returns what was removed.
 */
export async function removeSessionCopy(
	file: string,
	options: { removeEmptyBucket?: boolean } = {},
): Promise<string[]> {
	const paths = await copyFiles(file);
	const removed: string[] = [];
	for (const path of paths) {
		try {
			await rm(path, { recursive: true, force: true });
			removed.push(path);
		} catch (error) {
			throw failed(`cannot remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (options.removeEmptyBucket) {
		const dir = dirname(file);
		try {
			await rmdir(dir); // refuses unless empty
			removed.push(dir);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") {
				throw failed(`cannot remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return removed;
}

// ---------------------------------------------------------------------------
// History fingerprint
// ---------------------------------------------------------------------------

/**
 * sha256 over the entries after the header, each re-serialized (`JSON.stringify(JSON.parse(line))`, so whitespace and line
 * endings do not matter), optionally only the first `maxEntries`. A fork copies the source's entries, so equal fingerprints over
 * the source's entry count prove it kept the history. Lines that are not JSON are skipped, as omp skips them when it reads
 * a session. The file is streamed.
 */
export async function sessionBodyFingerprint(
	file: string,
	maxEntries?: number,
): Promise<{ entries: number; hash: string }> {
	const located = await locateHeader(file);
	const hasher = new Bun.CryptoHasher("sha256");
	let entries = 0;
	const limit = maxEntries ?? Number.POSITIVE_INFINITY;
	const take = (line: string): boolean => {
		const text = line.trim();
		if (!text) return false;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return false;
		}
		hasher.update(`${JSON.stringify(value)}\n`);
		entries++;
		return entries >= limit;
	};
	if (limit > 0) {
		const handle = await open(file, "r");
		try {
			const decoder = new TextDecoder();
			const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
			let pending = "";
			let at = located.bodyStart;
			let done = false;
			while (!done) {
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, at);
				at += bytesRead;
				const text = pending + decoder.decode(chunk.subarray(0, bytesRead), { stream: bytesRead > 0 });
				// Walk the complete lines by offset: re-slicing the remainder per line would copy the chunk once per line.
				let from = 0;
				for (let newline = text.indexOf("\n"); newline !== -1 && !done; newline = text.indexOf("\n", from)) {
					done = take(text.slice(from, newline));
					from = newline + 1;
				}
				pending = text.slice(from);
				if (bytesRead === 0) {
					if (!done) take(pending);
					break;
				}
			}
		} finally {
			await handle.close();
		}
	}
	return { entries, hash: hasher.digest("hex") };
}
