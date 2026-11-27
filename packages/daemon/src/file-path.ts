/**
 * Path safety for the file browser: a request names a worktree root the machine registered and a
 * relative path; whatever that path resolves to (symlinks followed) must stay inside the root, must not touch git's own
 * directory, and must be a regular file (to read) or a directory (to list). A symlink is never followed out of the
 * root; it is shown as an entry with its target text.
 *
 * Checking a path and then opening it leaves a window in which someone could swap a directory for a symlink. So files
 * are opened first and verified afterwards: the descriptor's identity (device + inode) must be the one of the path that
 * was checked, the path must still resolve to the same place after the open, and where the platform can name an open
 * descriptor's path (Linux) that is compared as well.
 */
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { FILE_PATH_MAX, type FilesErrorCode } from "@omp-web/protocol";
import { isInside } from "./projects";

/** A refusal with a machine-readable reason; the message is for the user. */
export class FileError extends Error {
	constructor(
		readonly code: FilesErrorCode,
		message: string,
	) {
		super(message);
	}
}

const WINDOWS = process.platform === "win32";
const fold = (name: string): string => (WINDOWS || process.platform === "darwin" ? name.toLowerCase() : name);

/** git's own directory (or the `.git` file of a linked worktree): never served, wherever it sits. */
const isGitDir = (name: string): boolean => fold(name) === ".git";

/**
 * The segments of a relative `/` path (`""` = the root). Refuses what could name something else than a path below the
 * root: absolute paths, drive letters, backslashes on Windows, NUL, empty / `.` / `..` segments, and `.git`.
 */
export function parseRelPath(path: string): string[] {
	if (typeof path !== "string") throw new FileError("bad_path", "the path must be a string");
	if (path.length > FILE_PATH_MAX)
		throw new FileError("bad_path", `the path is longer than ${FILE_PATH_MAX} characters`);
	if (path.includes("\0")) throw new FileError("bad_path", "the path contains a NUL byte");
	if (path === "") return [];
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
		throw new FileError("bad_path", "the path must be relative to the worktree root");
	}
	if (WINDOWS && /[\\:]/.test(path)) throw new FileError("bad_path", "the path must use / and no drive letter");
	const segments = path.split("/");
	for (const segment of segments) {
		if (segment === "") throw new FileError("bad_path", "the path has an empty segment");
		if (segment === "." || segment === "..")
			throw new FileError("bad_path", `the path must not contain "${segment}"`);
		if (isGitDir(segment)) throw new FileError("forbidden", "git's own directory is not served");
	}
	return segments;
}

/** The `/` path below `root` that `real` (canonical, inside `root`) names, as segments. */
function below(root: string, real: string): string[] {
	if (real === root) return [];
	return real.slice(root.endsWith(sep) ? root.length : root.length + 1).split(sep);
}

export interface Resolved {
	/** The path as requested, joined to the root (symlinks not resolved). */
	abs: string;
	/** Canonical path: no symlinks left, inside the root. */
	real: string;
	/** `real` below the root, as segments. */
	rel: string[];
}

/** Test seams: run where a racing process would strike (after the containment check; after the type check, just before the open). */
export interface PathHooks {
	afterResolve?(real: string): Promise<void> | void;
	beforeOpen?(real: string): Promise<void> | void;
}

/** Resolves symlinks and requires the result to stay inside `root` (canonical) and away from `.git`. */
export async function resolveInside(root: string, segments: readonly string[]): Promise<Resolved> {
	const abs = segments.length === 0 ? root : join(root, ...segments);
	let real: string;
	try {
		real = await realpath(abs);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			// Not finding something beyond a symlink that leaves the root must not tell whether it exists out there.
			for (let keep = segments.length - 1; keep >= 0; keep--) {
				const parent = await realpath(keep === 0 ? root : join(root, ...segments.slice(0, keep))).catch(() => null);
				if (parent === null) continue;
				if (!isInside(root, parent))
					throw new FileError(
						"outside_root",
						"the path leads outside the worktree (through a symlink), so it is not served",
					);
				break;
			}
			throw new FileError("not_found", "no such file or directory");
		}
		if (code === "ELOOP") throw new FileError("forbidden", "symlink loop");
		if (code === "EACCES" || code === "EPERM") throw new FileError("forbidden", "permission denied");
		// Bun cannot canonicalize some special files (a unix socket answers EOPNOTSUPP): they exist, and are refused as such.
		const special = await lstat(abs).catch(() => null);
		if (special !== null && !special.isSymbolicLink() && !special.isFile() && !special.isDirectory()) {
			throw new FileError("forbidden", `not a regular file: ${describeType(await lstat(abs, { bigint: true }))}`);
		}
		throw new FileError("not_found", `cannot resolve the path (${code ?? "error"})`);
	}
	if (!isInside(root, real)) {
		throw new FileError(
			"outside_root",
			"the path leads outside the worktree (through a symlink), so it is not served",
		);
	}
	const rel = below(root, real);
	if (rel.some(isGitDir)) throw new FileError("forbidden", "git's own directory is not served");
	return { abs, real, rel };
}

const sameFile = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean =>
	a.dev === b.dev && a.ino === b.ino;

const describeType = (s: BigIntStats): string => {
	if (s.isSymbolicLink()) return "a symlink";
	if (s.isFIFO()) return "a named pipe";
	if (s.isSocket()) return "a socket";
	if (s.isBlockDevice() || s.isCharacterDevice()) return "a device";
	if (s.isDirectory()) return "a directory";
	return "not a regular file";
};

/** Linux can name what a descriptor points at; elsewhere this is skipped. */
async function descriptorPath(fd: number): Promise<string | null> {
	if (process.platform !== "linux") return null;
	return readlink(`/proc/self/fd/${fd}`).catch(() => null);
}

export interface OpenedFile {
	handle: FileHandle;
	real: string;
	rel: string[];
	size: number;
	mtimeMs: number;
	/** Unix permission bits (for the "executable" flag of a synthesized diff). */
	mode: number;
}

/**
 * Opens a regular file inside `root` for reading. The descriptor is only returned when, after the open, it is still the
 * file the checked path names. Special files are never opened (their type is known from `lstat` before `open`, and the
 * open itself cannot block: `O_NONBLOCK`, `O_NOFOLLOW` on the already symlink-free path).
 */
export async function openRegularFile(
	root: string,
	segments: readonly string[],
	hooks?: PathHooks,
): Promise<OpenedFile> {
	const resolved = await resolveInside(root, segments);
	await hooks?.afterResolve?.(resolved.real);
	const before = await lstat(resolved.real, { bigint: true }).catch(() => {
		throw new FileError("changed", "the file disappeared while it was being opened");
	});
	if (!before.isFile()) {
		throw new FileError(
			before.isDirectory() ? "bad_path" : "forbidden",
			`not a regular file: ${describeType(before)}`,
		);
	}
	await hooks?.beforeOpen?.(resolved.real);
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
	let handle: FileHandle;
	try {
		handle = await open(resolved.real, flags);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP" || code === "EMLINK")
			throw new FileError("changed", "the path turned into a symlink while it was being opened");
		if (code === "ENOENT") throw new FileError("changed", "the file disappeared while it was being opened");
		if (code === "EACCES" || code === "EPERM") throw new FileError("forbidden", "permission denied");
		throw new FileError("forbidden", `cannot open the file (${code ?? "error"})`);
	}
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile()) throw new FileError("forbidden", `not a regular file: ${describeType(opened)}`);
		// The identity of the descriptor, the path as it is now and the path as it was checked must all agree.
		const again = await resolveInside(root, segments).catch(() => null);
		const now = again === null ? null : await lstat(again.real, { bigint: true }).catch(() => null);
		if (
			again === null ||
			again.real !== resolved.real ||
			now === null ||
			!sameFile(opened, now) ||
			!sameFile(opened, before)
		) {
			throw new FileError("changed", "the file was replaced while it was being opened");
		}
		const named = await descriptorPath(handle.fd);
		if (named !== null && named !== resolved.real) {
			throw new FileError("changed", "the file was replaced while it was being opened");
		}
		return {
			handle,
			real: resolved.real,
			rel: resolved.rel,
			size: Number(opened.size),
			mtimeMs: Number(opened.mtimeMs),
			mode: Number(opened.mode),
		};
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

/**
 * A directory inside `root` to list, verified the same way after the caller has read it: call `verify()` once the
 * entries are in, and discard them when it throws.
 */
export async function checkDirectory(
	root: string,
	segments: readonly string[],
	hooks?: PathHooks,
): Promise<Resolved & { verify(): Promise<void> }> {
	const resolved = await resolveInside(root, segments);
	await hooks?.afterResolve?.(resolved.real);
	const before = await lstat(resolved.real, { bigint: true }).catch(() => {
		throw new FileError("changed", "the directory disappeared");
	});
	if (!before.isDirectory()) {
		throw new FileError(before.isFile() ? "bad_path" : "forbidden", `not a directory: ${describeType(before)}`);
	}
	return {
		...resolved,
		verify: async () => {
			const again = await resolveInside(root, segments).catch(() => null);
			const now = again === null ? null : await lstat(again.real, { bigint: true }).catch(() => null);
			if (again === null || again.real !== resolved.real || now === null || !sameFile(before, now)) {
				throw new FileError("changed", "the directory was replaced while it was being listed");
			}
		},
	};
}

/** What a path is without following it: used for tree entries, where `lstat` is the truth. */
export async function kindOf(path: string): Promise<"file" | "dir" | "symlink" | "other" | null> {
	const s = await lstat(path).catch(() => null);
	if (s === null) return null;
	if (s.isSymbolicLink()) return "symlink";
	if (s.isDirectory()) return "dir";
	if (s.isFile()) return "file";
	return "other";
}

/** Whether a symlink inside `root` leads to a file or directory that is itself inside `root` (target text is `readlink`). */
export async function classifyLink(
	root: string,
	linkPath: string,
): Promise<{ target: string; resolves: "file" | "dir" | "other" | "outside" | "broken" }> {
	const target = (await readlink(linkPath).catch(() => "")).slice(0, 1024);
	let real: string;
	try {
		real = await realpath(linkPath);
	} catch {
		return { target, resolves: "broken" };
	}
	if (!isInside(root, real) || below(root, real).some(isGitDir)) return { target, resolves: "outside" };
	const s = await stat(real).catch(() => null);
	if (s === null) return { target, resolves: "broken" };
	return { target, resolves: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other" };
}
