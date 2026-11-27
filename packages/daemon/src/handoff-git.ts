/**
 * The git layer of "switch environment": everything that touches a repository, and nothing else.
 *
 * - Source: {@link createHandoffCommit} records the working tree and the index as two commits under
 *   `refs/omp-web/handoff*` using plumbing only (a temporary index file, `hash-object --no-filters`, `write-tree`,
 *   `commit-tree`). The user's branch, real index, stash and working tree are never written; the real index is only
 *   *copied*. {@link inspectRepo} computes the same summary without writing a single object.
 * - Transfer: {@link createBundle} / {@link verifyAndFetchBundle} / {@link commitsPresent}.
 * - Target: {@link listTargetWorktrees}, {@link planNewWorktree}, {@link createWorkspace} (worktree + materialization)
 *   and {@link rollbackWorkspace}, which removes only what a persisted {@link WorkspaceRecord} proves this operation made.
 *
 * Every git call goes through `runGit` (argv arrays, scrubbed environment, hooks/fsmonitor/filters neutralized,
 * timeouts and output caps). Files are written by hand (raw blob bytes, exact modes, no filters, no EOL conversion, no
 * hooks) and never through a symlink.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readlink,
	realpath,
	rm,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	THREAD_ID_PATTERN,
	type CarriedSummary,
	type HandoffLimits,
	type RepoStateIssue,
	type SkippedPath,
	type TargetChoice,
	type TargetWorktree,
} from "@omp-web/protocol";
import { runGit, type GitResult } from "./git-run";
import { restrictPath } from "./file-acl";
import { isInside } from "./projects";

const samePath = (a: string, b: string): boolean => isInside(a, b) && isInside(b, a);

async function privateTemp(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "omp-web-handoff-"));
	try {
		if (process.platform === "win32") restrictPath(path, true);
		return path;
	} catch (error) {
		await rm(path, { recursive: true, force: true });
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Errors, running git
// ---------------------------------------------------------------------------

/** `refused`: a precondition failed and nothing changed (the message is shown to the user as is). `failed`: something broke. */
export class HandoffGitError extends Error {
	/** Set by {@link createWorkspace} when it fails: the last record it handed to `onRecord`. */
	record?: WorkspaceRecord;
	constructor(
		message: string,
		readonly kind: "refused" | "failed",
	) {
		super(message);
		this.name = "HandoffGitError";
	}
}

/** A test seam (and the caller's way to set `HOME` or `GIT_CONFIG_GLOBAL`); passed through to `runGit`'s `env`. */
export interface GitContext {
	env?: Record<string, string>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const MIB = 1024 * 1024;
const mib = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

interface RunOptions {
	stdin?: Uint8Array | string;
	timeoutMs?: number;
	maxBytes?: number;
	/** `-C <root>` without pinning `--work-tree` (worktree add/remove/list, bundle, fetch, update-ref, branch). */
	noRepository?: boolean;
	env?: Record<string, string>;
	config?: readonly (readonly [string, string])[];
	/** Exit codes that are answers rather than failures. */
	ok?: readonly number[];
	/** Output beyond `maxBytes` is cut instead of failing the call. */
	allowTruncated?: boolean;
}

/** The identity of every commit this module makes: nobody's, and independent of the user's git configuration. */
const SYNTHETIC_IDENTITY = {
	GIT_AUTHOR_NAME: "omp-web handoff",
	GIT_AUTHOR_EMAIL: "omp-web@localhost",
	GIT_COMMITTER_NAME: "omp-web handoff",
	GIT_COMMITTER_EMAIL: "omp-web@localhost",
};
/** Never sign, never write reflogs (a reflog needs an identity of its own), whatever the user's configuration says. */
const PLAIN_OBJECTS: readonly (readonly [string, string])[] = [
	["commit.gpgsign", "false"],
	["tag.gpgsign", "false"],
	["core.logAllRefUpdates", "false"],
];

function describeCall(args: readonly string[]): string {
	return args
		.filter(arg => !arg.startsWith("-"))
		.slice(0, 2)
		.join(" ");
}

async function git(
	root: string,
	args: readonly string[],
	ctx: GitContext | undefined,
	options: RunOptions = {},
): Promise<GitResult> {
	let result: GitResult;
	try {
		result = await runGit(root, args, {
			timeoutMs: options.timeoutMs ?? 120_000,
			maxBytes: options.maxBytes ?? 32 * MIB,
			...(options.stdin === undefined
				? {}
				: { stdin: typeof options.stdin === "string" ? encoder.encode(options.stdin) : options.stdin }),
			...(options.noRepository ? { noRepository: true } : {}),
			env: { ...ctx?.env, ...options.env },
			...(options.config ? { config: options.config } : {}),
		});
	} catch (error) {
		throw new HandoffGitError(
			`git ${describeCall(args)}: ${error instanceof Error ? error.message : String(error)}`,
			"failed",
		);
	}
	if (result.timedOut) throw new HandoffGitError(`git ${describeCall(args)} timed out`, "failed");
	if (result.truncated && !options.allowTruncated) {
		throw new HandoffGitError(`git ${describeCall(args)} produced more output than the daemon accepts`, "failed");
	}
	if (result.code !== 0 && !(options.ok ?? []).includes(result.code)) {
		const detail = result.stderr.trim().split("\n")[0] ?? "";
		throw new HandoffGitError(
			`git ${describeCall(args)} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`,
			"failed",
		);
	}
	return result;
}

const text = (result: GitResult): string => decoder.decode(result.stdout);
const lines = (result: GitResult): string[] =>
	text(result)
		.split("\n")
		.filter(line => line !== "");

const HEX_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function requireOids(what: string, ids: readonly string[]): void {
	for (const id of ids) {
		if (!HEX_OID.test(id)) throw new HandoffGitError(`${what}: "${id}" is not a full commit id`, "failed");
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

function errnoCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) return String(error.code);
	return undefined;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
	try {
		return await lstat(path);
	} catch (error) {
		const code = errnoCode(error);
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw error;
	}
}

async function realOrSame(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export function handoffRefs(threadId: string): { worktree: string; index: string } {
	if (!THREAD_ID_PATTERN.test(threadId)) throw new HandoffGitError(`"${threadId}" is not a valid thread id`, "failed");
	return { worktree: `refs/omp-web/handoff/${threadId}`, index: `refs/omp-web/handoff-index/${threadId}` };
}

async function refExists(repoDir: string, ref: string, ctx?: GitContext): Promise<boolean> {
	const result = await git(repoDir, ["rev-parse", "--verify", "--quiet", ref], ctx, { noRepository: true, ok: [1] });
	return result.code === 0;
}

/** Deletes both handoff refs of a thread; returns those that existed. Idempotent. */
export async function removeHandoffRefs(repoDir: string, threadId: string, ctx?: GitContext): Promise<string[]> {
	const refs = handoffRefs(threadId);
	const removed: string[] = [];
	for (const ref of [refs.worktree, refs.index]) {
		if (!(await refExists(repoDir, ref, ctx))) continue;
		await git(repoDir, ["update-ref", "-d", ref], ctx, { noRepository: true, config: PLAIN_OBJECTS });
		removed.push(ref);
	}
	return removed;
}

// ---------------------------------------------------------------------------
// Repository state
// ---------------------------------------------------------------------------

interface BlockedState {
	issue: RepoStateIssue;
	message: string;
}

/** Operation-in-progress markers; paths resolved by git, so they are right for linked worktrees too. */
async function operationInProgress(root: string, ctx?: GitContext): Promise<BlockedState | null> {
	const names = [
		"MERGE_HEAD",
		"rebase-merge",
		"rebase-apply",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"BISECT_LOG",
		"sequencer",
	];
	const out = await git(root, ["rev-parse", ...names.flatMap(name => ["--git-path", name])], ctx);
	const paths = text(out).split("\n");
	const at = async (name: string): Promise<string | null> => {
		const path = paths[names.indexOf(name)];
		if (!path) return null;
		const absolute = resolve(root, path);
		return (await exists(absolute)) ? absolute : null;
	};
	if (await at("rebase-merge"))
		return { issue: "rebase", message: "a rebase is in progress (rebase-merge): finish or abort it first" };
	if (await at("rebase-apply")) {
		return {
			issue: "rebase",
			message: "a rebase or `git am` is in progress (rebase-apply): finish or abort it first",
		};
	}
	if (await at("MERGE_HEAD"))
		return { issue: "merge", message: "a merge is in progress (MERGE_HEAD exists): commit or abort it first" };
	if (await at("CHERRY_PICK_HEAD")) {
		return {
			issue: "cherry-pick",
			message: "a cherry-pick is in progress (CHERRY_PICK_HEAD exists): finish or abort it first",
		};
	}
	if (await at("REVERT_HEAD"))
		return { issue: "revert", message: "a revert is in progress (REVERT_HEAD exists): finish or abort it first" };
	const sequencer = await at("sequencer");
	if (sequencer) {
		const todo = await readFile(join(sequencer, "todo"), "utf8").catch(() => "");
		const revert = /^\s*(?:revert|r)\s/m.test(
			todo.split("\n").find(line => line.trim() !== "" && !line.startsWith("#")) ?? "",
		);
		return revert
			? { issue: "revert", message: "a multi-commit revert is in progress (sequencer): finish or abort it first" }
			: {
					issue: "cherry-pick",
					message: "a multi-commit cherry-pick is in progress (sequencer): finish or abort it first",
				};
	}
	if (await at("BISECT_LOG"))
		return { issue: "bisect", message: "a bisect is in progress (BISECT_LOG exists): run `git bisect reset` first" };
	return null;
}

// ---------------------------------------------------------------------------
// `git status --porcelain=v2 -z`, with the fields the handoff needs (modes and object ids)
// ---------------------------------------------------------------------------

interface StatusRecord {
	kind: "changed" | "renamed" | "unmerged" | "untracked";
	path: string;
	origPath?: string;
	x: string;
	y: string;
	sub: string;
	/** Mode and object id in HEAD / the index / the working tree, as git prints them. */
	mH: string;
	mI: string;
	mW: string;
	hH: string;
}

function splitFields(record: string, count: number): { fields: string[]; rest: string } | null {
	const fields: string[] = [];
	let at = 0;
	for (let i = 0; i < count; i++) {
		const space = record.indexOf(" ", at);
		if (space < 0) return null;
		fields.push(record.slice(at, space));
		at = space + 1;
	}
	return { fields, rest: record.slice(at) };
}

/** Like `parseStatusV2`, which drops the modes and object ids this module needs (to tell a mode change from a content change). */
function parseStatusRecords(output: string): StatusRecord[] {
	const out: StatusRecord[] = [];
	const records = output.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (record === "") continue;
		const kind = record[0];
		if (kind === "1") {
			const parts = splitFields(record, 8);
			if (!parts) continue;
			const f = parts.fields;
			out.push({
				kind: "changed",
				path: parts.rest,
				x: f[1]![0]!,
				y: f[1]![1]!,
				sub: f[2]!,
				mH: f[3]!,
				mI: f[4]!,
				mW: f[5]!,
				hH: f[6]!,
			});
		} else if (kind === "2") {
			const parts = splitFields(record, 9);
			const origPath = records[++i];
			if (!parts || origPath === undefined) continue;
			const f = parts.fields;
			out.push({
				kind: "renamed",
				path: parts.rest,
				origPath,
				x: f[1]![0]!,
				y: f[1]![1]!,
				sub: f[2]!,
				mH: f[3]!,
				mI: f[4]!,
				mW: f[5]!,
				hH: f[6]!,
			});
		} else if (kind === "u") {
			const parts = splitFields(record, 10);
			if (!parts) continue;
			const f = parts.fields;
			out.push({
				kind: "unmerged",
				path: parts.rest,
				x: f[1]![0]!,
				y: f[1]![1]!,
				sub: f[2]!,
				mH: f[3]!,
				mI: f[4]!,
				mW: f[6]!,
				hH: f[7]!,
			});
		} else if (kind === "?") {
			out.push({
				kind: "untracked",
				path: record.slice(2),
				x: "?",
				y: "?",
				sub: "",
				mH: "",
				mI: "",
				mW: "",
				hH: "",
			});
		}
		// "#" headers and "!" ignored entries are not asked for
	}
	return out;
}

// ---------------------------------------------------------------------------
// Scanning a working tree (shared by the preview and the real commit)
// ---------------------------------------------------------------------------

interface HeadEntry {
	mode: string;
	oid: string;
}

interface PathInfo {
	path: string;
	head: HeadEntry | null;
	indexMode: string;
	/** A changed / renamed status entry exists (the path is known to the index or HEAD). */
	tracked: boolean;
	submodule: boolean;
	/** The status reported a directory (an untracked directory is a nested repository: `-uall` lists files of anything else). */
	dir: boolean;
	staged: boolean;
	/** This path is the destination of a rename; `renamedFrom` is its origin. */
	renamedFrom?: string;
	renameOrigin: boolean;
}

type Target =
	| { kind: "absent" }
	| { kind: "file"; mode: "100644" | "100755" | "120000"; size: number }
	| { kind: "link"; mode: "120000"; size: number }
	| { kind: "skip"; reason: SkippedPath["reason"]; detail?: string; size?: number };

type Final = { kind: "absent" } | { kind: "blob"; mode: string; oid: string; size: number };

interface Scan {
	head: string;
	branch: string | null;
	detached: boolean;
	blocked: BlockedState | null;
	unmerged: string[];
	summary: CarriedSummary;
	/** `update-index -z --index-info` input that turns HEAD's tree into the working tree's. */
	workingTree: Uint8Array;
	/** The same kind of input that puts the paths this handoff did not carry back to their HEAD state in a copy of the index. */
	indexFixups: Uint8Array;
}

const GITLINK = "160000";
const IGNORED_SAMPLE = 20;
const SUMMARY_SAMPLE = 40;
const SKIPPED_MAX = 500;

async function headState(
	root: string,
	ctx?: GitContext,
): Promise<{ head: string; branch: string | null; detached: boolean }> {
	const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], ctx, { ok: [1, 128] });
	if (head.code !== 0) {
		const repo = await git(root, ["rev-parse", "--git-dir"], ctx, { ok: [128] });
		if (repo.code !== 0) throw new HandoffGitError(`${root} is not a git repository`, "refused");
		throw new HandoffGitError("the repository has no commits yet: commit something first", "refused");
	}
	const symbolic = await git(root, ["symbolic-ref", "--quiet", "HEAD"], ctx, { ok: [1] });
	const ref = symbolic.code === 0 ? text(symbolic).trim() : "";
	const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
	return { head: text(head).trim(), branch, detached: branch === null };
}

async function trustsFileMode(root: string, ctx?: GitContext): Promise<boolean> {
	const result = await git(root, ["config", "--bool", "--get", "core.filemode"], ctx, { ok: [1] });
	return result.code === 1 || text(result).trim() !== "false";
}

/**
 * Whether every directory above `path` is a real directory inside the worktree. git treats a path behind a symlinked
 * directory as nonexistent; reading it anyway would pull a file from outside the worktree into the handoff.
 */
async function parentsAreDirectories(
	root: string,
	path: string,
	cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
	const slash = path.lastIndexOf("/");
	if (slash < 0) return true;
	const parent = path.slice(0, slash);
	let verdict = cache.get(parent);
	if (!verdict) {
		verdict = (async () => {
			if (!(await parentsAreDirectories(root, parent, cache))) return false;
			const stat = await lstatOrNull(join(root, parent));
			return stat !== null && stat.isDirectory();
		})();
		cache.set(parent, verdict);
	}
	return verdict;
}

async function describeTarget(
	root: string,
	info: PathInfo,
	trustMode: boolean,
	parents: Map<string, Promise<boolean>>,
	trustSymlinks: boolean,
): Promise<Target> {
	if (info.submodule) return { kind: "skip", reason: "submodule", detail: "submodule changes are not carried" };
	if (!(await parentsAreDirectories(root, info.path, parents).catch(() => false))) return { kind: "absent" };
	const absolute = join(root, info.path);
	let stat;
	try {
		stat = await lstat(absolute);
	} catch (error) {
		const code = errnoCode(error);
		if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
		return { kind: "skip", reason: "unreadable", detail: code ?? String(error) };
	}
	if (stat.isDirectory()) {
		// A directory with its own `.git` is a nested repository (or a checked-out submodule's twin): never carried.
		if (await exists(join(absolute, ".git"))) {
			return {
				kind: "skip",
				reason: "embedded-repo",
				detail: "a repository of its own (carry it with its own git)",
			};
		}
		return info.dir
			? { kind: "skip", reason: "embedded-repo", detail: "a directory git reports as one entry" }
			: { kind: "absent" };
	}
	if (stat.isSymbolicLink()) return { kind: "link", mode: "120000", size: stat.size };
	if (stat.isFile()) {
		try {
			await open(absolute, fsConstants.O_RDONLY).then(handle => handle.close());
		} catch (error) {
			return { kind: "skip", reason: "unreadable", detail: errnoCode(error) ?? String(error), size: stat.size };
		}
		if (!trustSymlinks && info.indexMode === "120000") return { kind: "file", mode: "120000", size: stat.size };
		const executable = trustMode
			? (stat.mode & 0o111) !== 0
			: info.indexMode === "100755" || (info.indexMode === "" && info.head?.mode === "100755");
		return { kind: "file", mode: executable ? "100755" : "100644", size: stat.size };
	}
	return {
		kind: "skip",
		reason: "special-file",
		detail: stat.isFIFO() ? "named pipe" : stat.isSocket() ? "socket" : "device",
	};
}

/** C-style quoting `hash-object --stdin-paths` understands: any path, newlines and quotes included. */
function quotePath(path: string): string {
	let out = '"';
	for (const char of path) {
		const code = char.codePointAt(0)!;
		if (char === '"') out += '\\"';
		else if (char === "\\") out += "\\\\";
		else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, "0")}`;
		else out += char;
	}
	return `${out}"`;
}

/** Object ids of the given regular files and symlinks (a symlink's blob is its link text), written to the object store only when `write`. */
async function hashContent(
	root: string,
	items: readonly { path: string; kind: "file" | "link" }[],
	write: boolean,
	tmp: string,
	ctx?: GitContext,
): Promise<string[]> {
	if (items.length === 0) return [];
	const inputs: string[] = [];
	let linkNumber = 0;
	for (const item of items) {
		if (item.kind === "file") {
			inputs.push(quotePath(item.path));
			continue;
		}
		// hash-object follows symlinks, so a link's text is handed over as a file of its own.
		const target = await readlink(join(root, item.path), { encoding: "buffer" });
		const file = join(tmp, `link-${linkNumber++}`);
		await writeFile(file, target);
		inputs.push(quotePath(file));
	}
	const result = await git(root, ["hash-object", ...(write ? ["-w"] : []), "--no-filters", "--stdin-paths"], ctx, {
		stdin: `${inputs.join("\n")}\n`,
		timeoutMs: 10 * 60_000,
	});
	const oids = lines(result);
	if (oids.length !== items.length)
		throw new HandoffGitError("git hash-object returned an unexpected number of object ids", "failed");
	return oids;
}

async function ignoredSummary(root: string, ctx?: GitContext): Promise<CarriedSummary["ignored"]> {
	const result = await git(
		root,
		["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z"],
		ctx,
		{ timeoutMs: 2 * 60_000, maxBytes: 4 * MIB, allowTruncated: true },
	);
	const entries = text(result).split("\0");
	entries.pop(); // the tail after the last terminator: empty, or an entry cut by the output cap
	return { count: entries.length, sample: entries.slice(0, IGNORED_SAMPLE) };
}

async function scanWorktree(
	root: string,
	limits: Pick<HandoffLimits, "maxFileBytes" | "maxTotalBytes">,
	options: { write: boolean; refuse: boolean; tmp: string },
	ctx?: GitContext,
): Promise<Scan> {
	const { head, branch, detached } = await headState(root, ctx);
	const blocked = await operationInProgress(root, ctx);
	if (blocked && options.refuse) throw new HandoffGitError(blocked.message, "refused");

	const statusResult = await git(
		root,
		["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"],
		ctx,
		{ timeoutMs: 10 * 60_000, maxBytes: 128 * MIB },
	);
	const records = parseStatusRecords(text(statusResult));
	const unmerged = records.filter(record => record.kind === "unmerged").map(record => record.path);
	if (unmerged.length > 0 && options.refuse) {
		const shown = unmerged.slice(0, 5).join(", ");
		throw new HandoffGitError(
			`${unmerged.length} path(s) have unresolved merge conflicts (${shown}${unmerged.length > 5 ? ", …" : ""}): resolve them first`,
			"refused",
		);
	}
	const nullOid = "0".repeat(head.length);

	// ---- who is who
	const infos = new Map<string, PathInfo>();
	const info = (path: string): PathInfo => {
		let found = infos.get(path);
		if (!found) {
			found = {
				path,
				head: null,
				indexMode: "",
				tracked: false,
				submodule: false,
				dir: false,
				staged: false,
				renameOrigin: false,
			};
			infos.set(path, found);
		}
		return found;
	};
	const markSubmodule = (target: PathInfo, record: StatusRecord): void => {
		if (record.sub.startsWith("S") || [record.mH, record.mI, record.mW].includes(GITLINK)) target.submodule = true;
	};
	for (const record of records) {
		if (record.kind === "unmerged") continue;
		if (record.kind === "untracked") {
			const dir = record.path.endsWith("/");
			const target = info(dir ? record.path.slice(0, -1) : record.path);
			if (dir) target.dir = true;
		} else if (record.kind === "changed") {
			const target = info(record.path);
			target.tracked = true;
			target.indexMode = record.mI;
			if (!/^0+$/.test(record.hH)) target.head = { mode: record.mH, oid: record.hH };
			if (record.x !== ".") target.staged = true;
			markSubmodule(target, record);
		} else {
			const target = info(record.path);
			target.tracked = true;
			target.indexMode = record.mI;
			target.renamedFrom = record.origPath!;
			if (record.x !== ".") target.staged = true;
			markSubmodule(target, record);
			const origin = info(record.origPath!);
			origin.tracked = true;
			origin.renameOrigin = true;
			if (!/^0+$/.test(record.hH)) origin.head = { mode: record.mH, oid: record.hH };
			markSubmodule(origin, record);
		}
	}
	const ordered = [...infos.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	// ---- what is on disk
	const trustMode = await trustsFileMode(root, ctx);
	const symlinks = await git(root, ["config", "--bool", "--get", "core.symlinks"], ctx, { ok: [1] });
	const trustSymlinks = symlinks.code === 1 || text(symlinks).trim() !== "false";
	const targets = new Map<string, Target>();
	const parents = new Map<string, Promise<boolean>>();
	for (let i = 0; i < ordered.length; i += 64) {
		const chunk = ordered.slice(i, i + 64);
		const described = await Promise.all(
			chunk.map(item => describeTarget(root, item, trustMode, parents, trustSymlinks)),
		);
		chunk.forEach((item, index) => targets.set(item.path, described[index]!));
	}
	const skipped: SkippedPath[] = [];
	const skip = (path: string, target: Extract<Target, { kind: "skip" }>): void => {
		skipped.push({
			path,
			reason: target.reason,
			...(target.size === undefined ? {} : { size: target.size }),
			...(target.detail === undefined ? {} : { detail: target.detail }),
		});
	};
	const skippedPaths = new Set<string>();
	for (const item of ordered) {
		const target = targets.get(item.path)!;
		if (target.kind === "skip") {
			skip(item.path, target);
			skippedPaths.add(item.path);
		}
	}

	// ---- git-lfs: a pointer file's text must never stand in for the real content
	const candidates = ordered.filter(item => {
		const target = targets.get(item.path)!;
		return target.kind === "file" || target.kind === "link";
	});
	if (candidates.length > 0) {
		const attrs = await git(root, ["check-attr", "-z", "--stdin", "filter"], ctx, {
			stdin: candidates.map(item => `${item.path}\0`).join(""),
			timeoutMs: 5 * 60_000,
		});
		const fields = text(attrs).split("\0");
		for (let i = 0; i + 2 < fields.length; i += 3) {
			if (fields[i + 2] !== "lfs") continue;
			const path = fields[i]!;
			const target = targets.get(path);
			if (target && target.kind !== "skip" && target.kind !== "absent") {
				skip(path, {
					kind: "skip",
					reason: "lfs",
					size: target.size,
					detail: "tracked by git-lfs: the pointer would stand in for the content",
				});
				skippedPaths.add(path);
			}
		}
	}

	// ---- size caps, in path order; once the total is reached nothing further is taken
	let total = 0;
	let capReached = false;
	for (const item of candidates) {
		if (skippedPaths.has(item.path)) continue;
		const target = targets.get(item.path)!;
		if (target.kind !== "file" && target.kind !== "link") continue;
		if (target.size > limits.maxFileBytes) {
			skip(item.path, {
				kind: "skip",
				reason: "too-large",
				size: target.size,
				detail: `larger than ${mib(limits.maxFileBytes)}`,
			});
			skippedPaths.add(item.path);
		} else if (capReached || total + target.size > limits.maxTotalBytes) {
			capReached = true;
			skip(item.path, {
				kind: "skip",
				reason: "total-cap",
				size: target.size,
				detail: `the carried files would exceed ${mib(limits.maxTotalBytes)}`,
			});
			skippedPaths.add(item.path);
		} else {
			total += target.size;
		}
	}

	// A rename whose destination stayed behind is not a rename: its origin keeps its HEAD state too.
	const keptOrigins = new Set<string>();
	for (const item of ordered) {
		if (item.renamedFrom !== undefined && skippedPaths.has(item.path)) keptOrigins.add(item.renamedFrom);
	}
	const untouched = (path: string): boolean => skippedPaths.has(path) || keptOrigins.has(path);

	// ---- object ids of what is carried
	const hashing = ordered
		.filter(item => !untouched(item.path))
		.map(item => ({ item, target: targets.get(item.path)! }))
		.filter(
			(entry): entry is { item: PathInfo; target: Extract<Target, { kind: "file" | "link" }> } =>
				entry.target.kind === "file" || entry.target.kind === "link",
		);
	const oids = await hashContent(
		root,
		hashing.map(entry => ({ path: entry.item.path, kind: entry.target.kind })),
		options.write,
		options.tmp,
		ctx,
	);
	const finals = new Map<string, Final>();
	hashing.forEach((entry, index) => {
		finals.set(entry.item.path, {
			kind: "blob",
			mode: entry.target.mode,
			oid: oids[index]!,
			size: entry.target.size,
		});
	});

	// ---- the tree edits, counts and the staged paths
	const tracked = { modified: 0, added: 0, deleted: 0, renamed: 0, typeChanged: 0, modeChanged: 0 };
	const untracked = { files: 0, bytes: 0 };
	const carried: string[] = [];
	let stagedPaths = 0;
	const edits: string[] = [];
	for (const item of ordered) {
		if (untouched(item.path)) continue;
		const final: Final = finals.get(item.path) ?? { kind: "absent" };
		if (final.kind === "blob") edits.push(`${final.mode} ${final.oid}\t${item.path}\0`);
		else edits.push(`0 ${nullOid}\t${item.path}\0`);
		if (item.staged && !item.renameOrigin) stagedPaths++;

		const before = item.head;
		const same =
			final.kind === "absent"
				? before === null
				: before !== null && before.mode === final.mode && before.oid === final.oid;
		if (same) continue;
		carried.push(item.path);
		if (item.renameOrigin && !item.renamedFrom) continue; // counted under the rename's destination
		if (item.renamedFrom !== undefined) tracked.renamed++;
		else if (!item.tracked && final.kind === "blob") {
			untracked.files++;
			untracked.bytes += final.size;
		} else if (before === null) tracked.added++;
		else if (final.kind === "absent") tracked.deleted++;
		else if ((before.mode === "120000") !== (final.mode === "120000")) tracked.typeChanged++;
		else if (before.oid !== final.oid) tracked.modified++;
		else tracked.modeChanged++;
	}
	// removals first: a directory replaced by a file (or the other way round) needs the old entries gone before the new ones
	edits.sort((a, b) => Number(b.startsWith("0 ")) - Number(a.startsWith("0 ")));

	const fixups: string[] = [];
	for (const item of ordered) {
		if (!untouched(item.path)) continue;
		fixups.push(item.head ? `${item.head.mode} ${item.head.oid}\t${item.path}\0` : `0 ${nullOid}\t${item.path}\0`);
	}

	const ignored = await ignoredSummary(root, ctx);
	skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	carried.sort();
	const summary: CarriedSummary = {
		base: { commit: head, branch, detached },
		tracked,
		untracked,
		staged: { preserved: true, paths: stagedPaths },
		skipped: skipped.slice(0, SKIPPED_MAX),
		skippedTruncated: skipped.length > SKIPPED_MAX,
		ignored,
		sample: carried.slice(0, SUMMARY_SAMPLE),
		paths: carried.length,
	};
	return {
		head,
		branch,
		detached,
		blocked,
		unmerged,
		summary,
		workingTree: encoder.encode(edits.join("")),
		indexFixups: encoder.encode(fixups.join("")),
	};
}

// ---------------------------------------------------------------------------
// Source: inspect and commit
// ---------------------------------------------------------------------------

export interface RepoInspection {
	head: string;
	branch: string | null;
	detached: boolean;
	stateIssue: RepoStateIssue | null;
	/** Up to 256 commits reachable from HEAD, newest first. */
	recent: string[];
	shallow: boolean;
	preview: CarriedSummary;
}

async function isShallow(repoDir: string, ctx?: GitContext): Promise<boolean> {
	const out = await git(repoDir, ["rev-parse", "--is-shallow-repository"], ctx, { noRepository: true });
	return text(out).trim() === "true";
}

/** Read-only: what {@link createHandoffCommit} would carry, without writing any object, ref or index. */
export async function inspectRepo(
	worktree: string,
	limits: Pick<HandoffLimits, "maxFileBytes" | "maxTotalBytes">,
	ctx?: GitContext,
): Promise<RepoInspection> {
	const tmp = await privateTemp();
	try {
		const scan = await scanWorktree(worktree, limits, { write: false, refuse: false, tmp }, ctx);
		const recent = lines(await git(worktree, ["rev-list", "--max-count=256", scan.head], ctx));
		return {
			head: scan.head,
			branch: scan.branch,
			detached: scan.detached,
			stateIssue: scan.blocked?.issue ?? (scan.unmerged.length > 0 ? "merge" : null),
			recent,
			shallow: await isShallow(worktree, ctx),
			preview: scan.summary,
		};
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

export interface HandoffCommitResult {
	commit: string;
	indexCommit: string | null;
	base: { commit: string; branch: string | null; detached: boolean };
	carried: CarriedSummary;
}

function commitMessage(threadId: string, summary: CarriedSummary): string {
	const t = summary.tracked;
	const parts = [
		`${t.modified} modified`,
		`${t.added} added`,
		`${t.deleted} deleted`,
		`${t.renamed} renamed`,
		`${t.typeChanged} type-changed`,
		`${t.modeChanged} mode-changed`,
		`${summary.untracked.files} untracked`,
	];
	return [
		`omp-web handoff ${threadId}`,
		"",
		`Working tree of ${summary.base.branch ?? "a detached HEAD"} at ${summary.base.commit.slice(0, 12)}: ${summary.paths} path(s) (${parts.join(", ")}).`,
		`Not carried: ${summary.skipped.length} path(s), ${summary.ignored.count} ignored.`,
	].join("\n");
}

/**
 * Records the working tree (`refs/omp-web/handoff/<id>`) and the index (`refs/omp-web/handoff-index/<id>`) as commits
 * on top of HEAD. Writes objects and those two refs, nothing else.
 */
export async function createHandoffCommit(
	worktree: string,
	threadId: string,
	limits: Pick<HandoffLimits, "maxFileBytes" | "maxTotalBytes">,
	ctx?: GitContext,
): Promise<HandoffCommitResult> {
	const refs = handoffRefs(threadId);
	const tmp = await privateTemp();
	try {
		const scan = await scanWorktree(worktree, limits, { write: true, refuse: true, tmp }, ctx);
		const summary = scan.summary;
		const identity = { ...SYNTHETIC_IDENTITY };

		// The working tree: HEAD's tree edited in a temporary index.
		const workIndex = join(tmp, "index-worktree");
		const workEnv = { GIT_INDEX_FILE: workIndex };
		await git(worktree, ["read-tree", scan.head], ctx, { env: workEnv });
		if (scan.workingTree.length > 0) {
			await git(worktree, ["update-index", "-z", "--index-info"], ctx, { env: workEnv, stdin: scan.workingTree });
		}
		const tree = text(await git(worktree, ["write-tree"], ctx, { env: workEnv })).trim();
		const message = commitMessage(threadId, summary);
		const commit = text(
			await git(worktree, ["commit-tree", tree, "-p", scan.head, "-m", message], ctx, {
				env: identity,
				config: PLAIN_OBJECTS,
			}),
		).trim();

		// The index: the real index file copied, then every path that was not carried put back to HEAD.
		let indexCommit: string | null = null;
		try {
			const indexPath = resolve(
				worktree,
				text(await git(worktree, ["rev-parse", "--git-path", "index"], ctx)).trim(),
			);
			const copy = join(tmp, "index-copy");
			await copyFile(indexPath, copy);
			const copyEnv = { GIT_INDEX_FILE: copy };
			if (scan.indexFixups.length > 0) {
				await git(worktree, ["update-index", "-z", "--index-info"], ctx, { env: copyEnv, stdin: scan.indexFixups });
			}
			const indexTree = text(await git(worktree, ["write-tree"], ctx, { env: copyEnv })).trim();
			indexCommit = text(
				await git(
					worktree,
					["commit-tree", indexTree, "-p", scan.head, "-m", `omp-web handoff ${threadId} (index)`],
					ctx,
					{
						env: identity,
						config: PLAIN_OBJECTS,
					},
				),
			).trim();
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			summary.staged = {
				preserved: false,
				paths: summary.staged.paths,
				note: `the staged state could not be recorded (${why}); every change arrives unstaged`,
			};
		}

		try {
			await git(worktree, ["update-ref", refs.worktree, commit], ctx, {
				noRepository: true,
				env: identity,
				config: PLAIN_OBJECTS,
			});
			if (indexCommit) {
				await git(worktree, ["update-ref", refs.index, indexCommit], ctx, {
					noRepository: true,
					env: identity,
					config: PLAIN_OBJECTS,
				});
			} else {
				await removeIndexRef(worktree, refs.index, ctx);
			}
		} catch (error) {
			await removeHandoffRefs(worktree, threadId, ctx).catch(() => []);
			throw error;
		}
		return {
			commit,
			indexCommit,
			base: { commit: scan.head, branch: scan.branch, detached: scan.detached },
			carried: summary,
		};
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

/** A stale index ref of an earlier attempt must not outlive a commit that has no index state. */
async function removeIndexRef(repoDir: string, ref: string, ctx?: GitContext): Promise<void> {
	if (await refExists(repoDir, ref, ctx))
		await git(repoDir, ["update-ref", "-d", ref], ctx, { noRepository: true, config: PLAIN_OBJECTS });
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

const MAX_HAVES = 64;

/**
 * The subset of `candidates` this repository has completely, in the given order. A commit counts when it exists and is
 * reachable from a ref (git guarantees everything reachable from a ref is present); shallow and partial repositories
 * claim nothing, and neither does a repository where the check cannot complete (the bundle is then a full one).
 */
export async function commitsPresent(repoDir: string, candidates: string[], ctx?: GitContext): Promise<string[]> {
	requireOids("commitsPresent", candidates);
	if (candidates.length === 0) return [];
	if (await isShallow(repoDir, ctx)) return [];
	const partial = await git(repoDir, ["config", "--get", "extensions.partialclone"], ctx, {
		noRepository: true,
		ok: [1],
	});
	if (partial.code === 0) return [];

	const checked = await git(repoDir, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], ctx, {
		noRepository: true,
		stdin: `${candidates.join("\n")}\n`,
	});
	const commits = new Set<string>();
	for (const line of lines(checked)) {
		const [oid, type] = line.split(" ");
		if (oid && type === "commit") commits.add(oid);
	}
	const present = candidates.filter(oid => commits.has(oid));
	if (present.length === 0) return [];
	try {
		const unreachable = await git(repoDir, ["rev-list", ...present, "--not", "--all"], ctx, {
			noRepository: true,
			maxBytes: 8 * MIB,
		});
		const lost = new Set(lines(unreachable));
		return present.filter(oid => !lost.has(oid));
	} catch {
		return [];
	}
}

async function bundlePrerequisites(file: string): Promise<number> {
	const handle = await open(file, fsConstants.O_RDONLY);
	try {
		const buffer = new Uint8Array(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const header = decoder.decode(buffer.subarray(0, bytesRead));
		const end = header.indexOf("\n\n");
		const head = end < 0 ? header : header.slice(0, end);
		return head.split("\n").filter(line => line.startsWith("-")).length;
	} finally {
		await handle.close();
	}
}

/**
 * Writes a bundle of the two handoff refs, thin against `have` (≤ 64 commits the target has completely, newest first;
 * more are ignored: they only make the bundle smaller). Refuses over `maxBytes` and leaves no output file then.
 */
export async function createBundle(
	repoDir: string,
	outPath: string,
	threadId: string,
	have: string[],
	maxBytes: number,
	ctx?: GitContext,
): Promise<{ bytes: number; full: boolean; prerequisites: number }> {
	const refs = handoffRefs(threadId);
	requireOids("createBundle", have);
	const wanted: string[] = [];
	for (const ref of [refs.worktree, refs.index]) if (await refExists(repoDir, ref, ctx)) wanted.push(ref);
	if (!wanted.includes(refs.worktree))
		throw new HandoffGitError(`there is no handoff commit for thread ${threadId}`, "failed");

	let haves = have.slice(0, MAX_HAVES);
	if (haves.length > 0) {
		const checked = await git(repoDir, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], ctx, {
			noRepository: true,
			stdin: `${haves.join("\n")}\n`,
		});
		const known = new Set(
			lines(checked)
				.filter(line => line.endsWith(" commit"))
				.map(line => line.split(" ")[0]!),
		);
		haves = haves.filter(oid => known.has(oid));
	}
	const exclusions = haves.map(oid => `^${oid}`);

	// `--disk-usage` sums the stored sizes of the objects the bundle needs: an estimate (a bundle recompresses), so only
	// a clearly hopeless one is refused here; the file's real size decides below.
	const estimate = Number(
		text(
			await git(repoDir, ["rev-list", "--objects", "--disk-usage", ...wanted, ...exclusions], ctx, {
				noRepository: true,
				timeoutMs: 5 * 60_000,
			}),
		).trim(),
	);
	if (Number.isFinite(estimate) && estimate > maxBytes * 2) {
		throw new HandoffGitError(
			`the workspace would be a bundle of about ${mib(estimate)}, over the ${mib(maxBytes)} limit; commit or drop large files first`,
			"refused",
		);
	}
	try {
		await git(repoDir, ["bundle", "create", outPath, ...wanted, ...exclusions], ctx, {
			noRepository: true,
			timeoutMs: 15 * 60_000,
		});
		const size = (await lstat(outPath)).size;
		if (size > maxBytes) {
			throw new HandoffGitError(
				`the bundle is ${mib(size)}, over the ${mib(maxBytes)} limit; commit or drop large files first`,
				"refused",
			);
		}
		const prerequisites = await bundlePrerequisites(outPath);
		return { bytes: size, full: prerequisites === 0, prerequisites };
	} catch (error) {
		await rm(outPath, { force: true });
		throw error;
	} finally {
		await rm(`${outPath}.lock`, { force: true }); // a killed `bundle create` leaves its lock behind
	}
}

/**
 * `git bundle verify`, then fetch the handoff refs out of the bundle. Throws, leaving no handoff ref behind, when the
 * bundle is damaged or builds on commits this repository lacks.
 */
export async function verifyAndFetchBundle(
	repoDir: string,
	bundlePath: string,
	threadId: string,
	ctx?: GitContext,
): Promise<string[]> {
	const refs = handoffRefs(threadId);
	const verify = await git(repoDir, ["bundle", "verify", bundlePath], ctx, { noRepository: true, ok: [1, 128] });
	if (verify.code !== 0) {
		const detail = verify.stderr.trim().split("\n").slice(0, 3).join(" ");
		throw new HandoffGitError(
			`the bundle does not apply to this repository${detail ? `: ${detail}` : ""}`,
			"refused",
		);
	}
	const listed = new Map<string, string>();
	for (const line of lines(await git(repoDir, ["bundle", "list-heads", bundlePath], ctx, { noRepository: true }))) {
		const [oid, ref] = line.split(" ");
		if (oid && ref) listed.set(ref, oid);
	}
	const wanted = [refs.worktree, refs.index].filter(ref => listed.has(ref));
	if (!wanted.includes(refs.worktree)) {
		throw new HandoffGitError(`the bundle does not contain the handoff commit of thread ${threadId}`, "refused");
	}
	try {
		await git(
			repoDir,
			[
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-write-fetch-head",
				"--no-recurse-submodules",
				"--atomic",
				bundlePath,
				...wanted.map(ref => `+${ref}:${ref}`),
			],
			ctx,
			{ noRepository: true, timeoutMs: 15 * 60_000 },
		);
		// url.<base>.insteadOf and friends could have pointed the fetch somewhere else: what arrived must be what the bundle lists.
		const present: string[] = [];
		for (const ref of wanted) {
			const got = await git(repoDir, ["rev-parse", "--verify", "--quiet", ref], ctx, {
				noRepository: true,
				ok: [1],
			});
			if (text(got).trim() !== listed.get(ref))
				throw new HandoffGitError(`fetching ${ref} from the bundle did not produce the bundled commit`, "failed");
			present.push(ref);
		}
		return present;
	} catch (error) {
		await removeHandoffRefs(repoDir, threadId, ctx).catch(() => []);
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

interface ListedWorktree {
	path: string;
	head: string;
	branch: string | null;
	bare: boolean;
	/** null: not locked; "" locked without a reason. */
	locked: string | null;
	prunable: string | null;
}

async function listWorktrees(projectRoot: string, ctx?: GitContext): Promise<ListedWorktree[]> {
	const out = await git(projectRoot, ["worktree", "list", "--porcelain", "-z"], ctx, { noRepository: true });
	const worktrees: ListedWorktree[] = [];
	let current: ListedWorktree | null = null;
	for (const field of text(out).split("\0")) {
		if (field === "") {
			if (current) worktrees.push(current);
			current = null;
			continue;
		}
		const space = field.indexOf(" ");
		const key = space < 0 ? field : field.slice(0, space);
		const value = space < 0 ? "" : field.slice(space + 1);
		if (key === "worktree") {
			if (current) worktrees.push(current);
			current = { path: value, head: "", branch: null, bare: false, locked: null, prunable: null };
		} else if (current) {
			if (key === "HEAD") current.head = value;
			else if (key === "branch")
				current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
			else if (key === "bare") current.bare = true;
			else if (key === "locked") current.locked = value;
			else if (key === "prunable") current.prunable = value;
		}
	}
	if (current) worktrees.push(current);
	return worktrees;
}

export interface WorktreeCandidates {
	worktrees: TargetWorktree[];
}

const short = (oid: string): string => oid.slice(0, 8);

/** The existing worktrees of a repository, each with whether the thread may move into it and why not. */
export async function listTargetWorktrees(
	projectRoot: string,
	sourceHead: string,
	opts: { sourceWorktree?: string },
	ctx?: GitContext,
): Promise<TargetWorktree[]> {
	const listed = await listWorktrees(projectRoot, ctx);
	const source = opts.sourceWorktree ? await realOrSame(opts.sourceWorktree) : null;
	const result: TargetWorktree[] = [];
	for (const entry of listed) {
		const path = await realOrSame(entry.path);
		const isSource = source !== null && samePath(path, source);
		let reason: string | undefined;
		if (entry.bare) reason = "this is the bare repository, not a working tree";
		else if (entry.prunable !== null || !(await exists(entry.path))) reason = "its directory is missing (prunable)";
		else if (entry.locked !== null) reason = `it is locked${entry.locked ? ` (${entry.locked})` : ""}`;
		else if (isSource) reason = "this is the source's own worktree";
		else if (entry.head !== sourceHead) {
			reason = `it is at ${short(entry.head)}, the source is at ${short(sourceHead)}`;
		} else {
			const blocked = await operationInProgress(path, ctx).catch(() => null);
			if (blocked) reason = blocked.message;
			else {
				const status = await git(
					path,
					["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignore-submodules=none"],
					ctx,
					{
						timeoutMs: 5 * 60_000,
					},
				);
				const changes = text(status)
					.split("\0")
					.filter(record => record !== "");
				if (changes.length > 0) {
					const untracked = changes.filter(record => record.startsWith("? ")).length;
					reason = `it has uncommitted changes (${changes.length} entr${changes.length === 1 ? "y" : "ies"}${untracked ? `, ${untracked} untracked` : ""})`;
				}
			}
		}
		result.push({
			path,
			branch: entry.branch,
			head: entry.head,
			eligible: reason === undefined,
			...(reason === undefined ? {} : { reason }),
			isSource,
		});
	}
	return result;
}

const SHORT_THREAD = 8;

function safeSegment(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
	return cleaned === "" ? "project" : cleaned;
}

/** A free directory and a free branch name for a new worktree of the thread: nothing is created. */
export async function planNewWorktree(
	projectRoot: string,
	projectName: string,
	threadId: string,
	opts: { worktreesDir?: string },
	ctx?: GitContext,
): Promise<{ path: string; branch: string }> {
	handoffRefs(threadId); // validates the id
	const id = threadId.slice(0, SHORT_THREAD);
	const root = await realOrSame(projectRoot);
	const base = opts.worktreesDir
		? join(resolve(opts.worktreesDir), safeSegment(projectName))
		: join(dirname(root), `${basename(root)}.omp-worktrees`);
	// `omp-web` as a branch of its own would stop `omp-web/<id>` from existing.
	if (await refExists(projectRoot, "refs/heads/omp-web", ctx)) {
		throw new HandoffGitError(
			'a branch named "omp-web" exists, which blocks the "omp-web/…" branches handoff creates',
			"refused",
		);
	}
	const registered = new Set((await listWorktrees(projectRoot, ctx)).map(entry => resolve(entry.path)));
	for (let n = 1; n < 1000; n++) {
		const name = n === 1 ? id : `${id}-${n}`;
		const path = join(base, name);
		const branch = `omp-web/${name}`;
		if ((await exists(path)) || registered.has(path)) continue;
		if (await refExists(projectRoot, `refs/heads/${branch}`, ctx)) continue;
		const nested = await git(
			projectRoot,
			["for-each-ref", "--count=1", "--format=%(refname)", `refs/heads/${branch}/`],
			ctx,
			{ noRepository: true },
		);
		if (text(nested).trim() !== "") continue;
		return { path, branch };
	}
	throw new HandoffGitError("no free worktree name is left (999 tried)", "refused");
}

// ---------------------------------------------------------------------------
// Writing files into a worktree: never through a symlink, never outside it, never into `.git`
// ---------------------------------------------------------------------------

function safeParts(rel: string): string[] {
	const parts = rel.split("/");
	const bad =
		rel === "" ||
		rel.includes("\0") ||
		(process.platform === "win32" && (rel.includes("\\") || rel.includes(":"))) ||
		parts.some(
			part =>
				part === "" ||
				part === "." ||
				part === ".." ||
				part.toLowerCase() === ".git" ||
				(process.platform === "win32" &&
					(/[<>:"\\|?*]/.test(part) ||
						[...part].some(char => char.charCodeAt(0) < 32) ||
						/[. ]$/.test(part) ||
						/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))),
		);
	if (bad) throw new HandoffGitError(`refusing to touch the unsafe path "${rel}"`, "failed");
	return parts;
}

async function ensureParents(root: string, rel: string, parts: string[]): Promise<void> {
	let current = root;
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		const stat = await lstatOrNull(current);
		if (!stat) {
			try {
				await mkdir(current);
			} catch (error) {
				if (errnoCode(error) !== "EEXIST") throw error;
			}
		} else if (!stat.isDirectory()) {
			throw new HandoffGitError(
				`refusing to write ${rel}: ${part} is a ${stat.isSymbolicLink() ? "symbolic link" : "file"}, not a directory`,
				"failed",
			);
		}
	}
}

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** Creates `rel` with exactly these bytes and mode; an existing file or link is replaced, never followed. */
async function writeEntry(
	root: string,
	rel: string,
	mode: string,
	bytes: Uint8Array,
	trustSymlinks: boolean,
): Promise<void> {
	const parts = safeParts(rel);
	await ensureParents(root, rel, parts);
	const target = join(root, rel);
	const existing = await lstatOrNull(target);
	if (existing) {
		if (existing.isDirectory()) {
			try {
				await rmdir(target);
			} catch {
				throw new HandoffGitError(`refusing to replace the directory ${rel} that still has files in it`, "failed");
			}
		} else {
			await unlink(target);
		}
	}
	if (mode === "120000") {
		if (!trustSymlinks) {
			await writeFile(target, bytes, { flag: "wx" });
		} else {
			await symlink(Buffer.from(bytes), target);
		}
		return;
	}
	const handle = await open(
		target,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
		mode === "100755" ? 0o777 : 0o666,
	);
	try {
		await handle.writeFile(bytes);
	} finally {
		await handle.close();
	}
}

/** Removes a file or link (never a directory), then the parent directories that became empty. Returns whether it removed anything. */
async function removeEntry(root: string, rel: string): Promise<boolean> {
	const parts = safeParts(rel);
	let current = root;
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		const stat = await lstatOrNull(current);
		if (!stat) return false;
		if (!stat.isDirectory())
			throw new HandoffGitError(`refusing to remove ${rel}: ${part} is not a directory`, "failed");
	}
	const target = join(root, rel);
	const stat = await lstatOrNull(target);
	if (!stat || stat.isDirectory()) return false;
	await unlink(target);
	for (let depth = parts.length - 1; depth >= 1; depth--) {
		try {
			await rmdir(join(root, ...parts.slice(0, depth)));
		} catch {
			break; // not empty (or not ours to remove)
		}
	}
	return true;
}

/** Reads blobs in batches that bound the daemon's memory; `visit` gets each distinct object id once. */
async function readBlobs(
	root: string,
	oids: readonly string[],
	ctx: GitContext | undefined,
	visit: (oid: string, bytes: Uint8Array) => Promise<void>,
): Promise<void> {
	const distinct = [...new Set(oids)];
	if (distinct.length === 0) return;
	const sizes = new Map<string, number>();
	const checked = await git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], ctx, {
		stdin: `${distinct.join("\n")}\n`,
		maxBytes: 64 * MIB,
	});
	for (const line of lines(checked)) {
		const [oid, type, size] = line.split(" ");
		if (type !== "blob")
			throw new HandoffGitError(
				`object ${oid} is ${type === "missing" ? "missing from this repository" : `a ${type}, not a blob`}`,
				"failed",
			);
		sizes.set(oid!, Number(size));
	}
	const batches: string[][] = [];
	let batch: string[] = [];
	let batchBytes = 0;
	for (const oid of distinct) {
		const size = sizes.get(oid) ?? 0;
		if (batch.length > 0 && batchBytes + size > 48 * MIB) {
			batches.push(batch);
			batch = [];
			batchBytes = 0;
		}
		batch.push(oid);
		batchBytes += size;
	}
	if (batch.length > 0) batches.push(batch);
	for (const group of batches) {
		const total = group.reduce((sum, oid) => sum + (sizes.get(oid) ?? 0), 0);
		const out = await git(root, ["cat-file", "--batch"], ctx, {
			stdin: `${group.join("\n")}\n`,
			maxBytes: total + group.length * 160 + 1024,
			timeoutMs: 10 * 60_000,
		});
		let at = 0;
		for (const oid of group) {
			const end = out.stdout.indexOf(10, at);
			if (end < 0) throw new HandoffGitError("git cat-file returned a short answer", "failed");
			const header = decoder.decode(out.stdout.subarray(at, end)).split(" ");
			const size = Number(header[2]);
			if (
				header[0] !== oid ||
				header[1] !== "blob" ||
				!Number.isFinite(size) ||
				end + 1 + size > out.stdout.length
			) {
				throw new HandoffGitError(`git cat-file could not read ${oid}`, "failed");
			}
			await visit(oid, out.stdout.subarray(end + 1, end + 1 + size));
			at = end + 1 + size + 1;
		}
	}
}

// ---------------------------------------------------------------------------
// Target: creating the workspace and rolling it back
// ---------------------------------------------------------------------------

/** What an operation did to a target repository: enough to undo exactly that, persisted by the caller before each phase. */
export interface WorkspaceRecord {
	worktree: string;
	branch: string | null;
	createdWorktree: boolean;
	createdBranch: boolean;
	startCommit: string;
	/** Path of the file written into the created worktree's admin directory (`{ opId, … }`); null for an existing worktree. */
	marker: string | null;
	opId: string;
	/** Paths this operation wrote or replaced (an upper bound while a phase is running). */
	written: string[];
	/** Paths this operation deleted, with what to put back. */
	removed: { path: string; restoreBlob: string | null; mode: string | null }[];
	indexReplaced: boolean;
	threadId: string;
	/** The repository the worktree belongs to (the main worktree or any registered one). */
	projectRoot: string;
	/** Directories this operation created above a new worktree, outermost first. */
	createdDirs: string[];
	/** Original checkout bytes of touched paths in an existing worktree, including checkout filters. */
	originalFiles?: { path: string; mode: string; bytes: string }[];
}

const MARKER_NAME = "omp-web-handoff";

interface TreeChange {
	status: string;
	oldMode: string;
	newMode: string;
	oldOid: string;
	newOid: string;
	path: string;
}

async function treeChanges(root: string, from: string, to: string, ctx?: GitContext): Promise<TreeChange[]> {
	const out = await git(root, ["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", from, to], ctx, {
		maxBytes: 128 * MIB,
	});
	const fields = text(out).split("\0");
	const changes: TreeChange[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const meta = fields[i]!.replace(/^:/, "").split(" ");
		if (meta.length < 5) continue;
		changes.push({
			oldMode: meta[0]!,
			newMode: meta[1]!,
			oldOid: meta[2]!,
			newOid: meta[3]!,
			status: meta[4]!,
			path: fields[i + 1]!,
		});
	}
	return changes;
}

async function requireCommit(root: string, oid: string, ctx?: GitContext): Promise<void> {
	const result = await git(root, ["cat-file", "-e", `${oid}^{commit}`], ctx, { ok: [1, 128] });
	if (result.code !== 0) throw new HandoffGitError(`commit ${short(oid)} is not in this repository`, "failed");
}

/** The missing directories above `path` (outermost first). */
async function missingAncestors(path: string): Promise<string[]> {
	const missing: string[] = [];
	let current = dirname(path);
	while (!(await exists(current))) {
		missing.unshift(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return missing;
}

export async function createWorkspace(
	opts: {
		opId: string;
		threadId: string;
		projectRoot: string;
		choice: TargetChoice;
		base: { commit: string; branch: string | null };
		commit: string;
		indexCommit: string | null;
		plan?: { path: string; branch: string };
		onRecord: (record: WorkspaceRecord) => Promise<void> | void;
	},
	ctx?: GitContext,
): Promise<{ record: WorkspaceRecord; applied: { written: number; removed: number } }> {
	const { opId, threadId, projectRoot, choice, base, commit, indexCommit } = opts;
	handoffRefs(threadId);
	requireOids("createWorkspace", [base.commit, commit, ...(indexCommit ? [indexCommit] : [])]);
	for (const oid of [base.commit, commit, ...(indexCommit ? [indexCommit] : [])])
		await requireCommit(projectRoot, oid, ctx);
	if (process.platform === "win32") {
		for (const oid of [base.commit, commit, ...(indexCommit ? [indexCommit] : [])]) {
			const listing = await git(projectRoot, ["ls-tree", "-r", "-z", "--name-only", oid], ctx, {
				maxBytes: 256 * MIB,
			});
			const names = new Map<string, string>();
			for (const path of text(listing).split("\0").filter(Boolean)) {
				safeParts(path);
				const parts = path.split("/");
				for (let i = 1; i <= parts.length; i++) {
					const name = parts.slice(0, i).join("/");
					const folded = name.toLowerCase();
					const prior = names.get(folded);
					if (prior !== undefined && prior !== name)
						throw new HandoffGitError(
							`refusing Windows-incompatible case collision: "${prior}" and "${name}"`,
							"refused",
						);
					names.set(folded, name);
				}
			}
		}
	}

	const record: WorkspaceRecord = {
		worktree: "",
		branch: null,
		createdWorktree: false,
		createdBranch: false,
		startCommit: base.commit,
		marker: null,
		opId,
		written: [],
		removed: [],
		indexReplaced: false,
		threadId,
		projectRoot,
		createdDirs: [],
	};
	const save = async (): Promise<void> => {
		await opts.onRecord(structuredClone(record));
	};
	try {
		if (choice.mode === "new") {
			const plan = opts.plan ?? (await planNewWorktree(projectRoot, basename(projectRoot), threadId, {}, ctx));
			if (!isAbsolute(plan.path))
				throw new HandoffGitError(`the worktree path ${plan.path} is not absolute`, "refused");
			if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(plan.branch))
				throw new HandoffGitError(`"${plan.branch}" is not an acceptable branch name`, "refused");
			if (await exists(plan.path)) throw new HandoffGitError(`${plan.path} already exists`, "refused");
			if (await refExists(projectRoot, `refs/heads/${plan.branch}`, ctx)) {
				throw new HandoffGitError(`the branch ${plan.branch} already exists`, "refused");
			}
			// Recorded before anything exists: a crash from here on is answered by a rollback that checks the marker.
			record.worktree = plan.path;
			record.branch = plan.branch;
			record.createdWorktree = true;
			record.createdBranch = true;
			record.createdDirs = await missingAncestors(plan.path);
			await save();
			await mkdir(dirname(plan.path), { recursive: true });
			// `--no-checkout` so the marker exists before the (long) checkout; never `--force`.
			await git(projectRoot, ["worktree", "add", "--no-checkout", "-b", plan.branch, plan.path, base.commit], ctx, {
				noRepository: true,
				timeoutMs: 10 * 60_000,
			});
			const admin = text(await git(plan.path, ["rev-parse", "--absolute-git-dir"], ctx)).trim();
			record.marker = join(admin, MARKER_NAME);
			await writeFile(
				record.marker,
				JSON.stringify({ opId, threadId, branch: plan.branch, startCommit: base.commit, createdAt: Date.now() }),
			);
			await save();
			await git(plan.path, ["reset", "--hard", "--quiet", "--no-recurse-submodules"], ctx, {
				timeoutMs: 30 * 60_000,
			});
		} else {
			const listed = await listTargetWorktrees(projectRoot, base.commit, {}, ctx);
			const wanted = await realOrSame(choice.worktree);
			const target = listed.find(entry => samePath(resolve(entry.path), resolve(wanted)));
			if (!target) throw new HandoffGitError(`${choice.worktree} is not a worktree of this repository`, "refused");
			if (!target.eligible) throw new HandoffGitError(`${target.path} cannot be used: ${target.reason}`, "refused");
			record.worktree = target.path;
			record.branch = target.branch;
			record.startCommit = target.head;
			await save();
		}

		const root = await realpath(record.worktree);
		const symlinks = await git(root, ["config", "--bool", "--get", "core.symlinks"], ctx, { ok: [1] });
		const trustSymlinks = symlinks.code === 1 || text(symlinks).trim() !== "false";
		const changes = (await treeChanges(root, base.commit, commit, ctx)).filter(
			change => change.oldMode !== GITLINK && change.newMode !== GITLINK,
		);
		const writes = changes.filter(change => change.status !== "D");
		const deletes = changes.filter(change => change.status === "D");
		if (!record.createdWorktree) {
			// An ignored file in the way is the one thing a clean worktree can hold that would be lost: refuse before touching anything.
			for (const change of writes) {
				if (change.status === "A" && (await lstatOrNull(join(root, change.path)))) {
					throw new HandoffGitError(
						`${change.path} already exists in ${record.worktree} (an ignored file?) and would be overwritten`,
						"refused",
					);
				}
			}
		}
		if (!record.createdWorktree) {
			record.originalFiles = [];
			const parents = new Map<string, Promise<boolean>>();
			for (const change of changes) {
				if (!(await parentsAreDirectories(root, change.path, parents))) continue;
				const path = join(root, change.path);
				const info = await lstatOrNull(path);
				if (!info || (!info.isFile() && !info.isSymbolicLink())) continue;
				const bytes = info.isSymbolicLink() ? await readlink(path, { encoding: "buffer" }) : await readFile(path);
				record.originalFiles.push({
					path: change.path,
					mode: info.isSymbolicLink() ? "120000" : change.oldMode,
					bytes: bytes.toString("base64"),
				});
			}
		}
		record.written = writes.map(change => change.path);
		record.removed = deletes.map(change => ({ path: change.path, restoreBlob: change.oldOid, mode: change.oldMode }));
		record.indexReplaced = indexCommit !== null;
		await save();

		let removedCount = 0;
		for (const change of deletes) if (await removeEntry(root, change.path)) removedCount++;
		const byOid = new Map<string, TreeChange[]>();
		for (const change of writes) byOid.set(change.newOid, [...(byOid.get(change.newOid) ?? []), change]);
		let writtenCount = 0;
		await readBlobs(root, [...byOid.keys()], ctx, async (oid, bytes) => {
			for (const change of byOid.get(oid)!) {
				await writeEntry(root, change.path, change.newMode, bytes, trustSymlinks);
				writtenCount++;
			}
		});

		if (indexCommit) await git(root, ["read-tree", indexCommit], ctx);
		await git(root, ["update-index", "-q", "--refresh"], ctx, { ok: [1], timeoutMs: 10 * 60_000 });
		await save();
		return { record: structuredClone(record), applied: { written: writtenCount, removed: removedCount } };
	} catch (error) {
		const wrapped =
			error instanceof HandoffGitError
				? error
				: new HandoffGitError(error instanceof Error ? error.message : String(error), "failed");
		wrapped.record = structuredClone(record);
		throw wrapped;
	}
}

async function readMarker(path: string): Promise<{ opId?: unknown } | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as { opId?: unknown }) : null;
	} catch {
		return null;
	}
}

async function headOf(root: string, ctx?: GitContext): Promise<string | null> {
	const result = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], ctx, { ok: [1, 128] }).catch(
		() => null,
	);
	return result && result.code === 0 ? text(result).trim() : null;
}

/** Removes what the record proves this operation created. Idempotent; what it refuses to remove is returned as `leftovers`. */
export async function rollbackWorkspace(
	record: WorkspaceRecord,
	ctx?: GitContext,
): Promise<{ removed: string[]; leftovers: string[] }> {
	const removed: string[] = [];
	const leftovers: string[] = [];
	const repo = record.projectRoot;
	let repoUsable = true;

	if (record.createdWorktree) {
		const present = await exists(record.worktree);
		const admin = record.marker ? dirname(record.marker) : null;
		const adminPresent = admin !== null && (await exists(admin));
		if (!present && !adminPresent) {
			// nothing was made, or it is already gone
		} else if (
			!record.marker ||
			!(await readMarker(record.marker)) ||
			(await readMarker(record.marker))?.opId !== record.opId
		) {
			leftovers.push(
				`worktree ${record.worktree}: not removed, its marker file is missing or belongs to another operation`,
			);
			if (record.branch)
				leftovers.push(`branch ${record.branch}: not removed, it is checked out in ${record.worktree}`);
			repoUsable = false;
		} else {
			let blocked: string | null = null;
			if (present) {
				const stat = await lstat(record.worktree);
				const pointer = stat.isDirectory()
					? await readFile(join(record.worktree, ".git"), "utf8").catch(() => "")
					: "";
				const gitdir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
				if (!stat.isDirectory()) blocked = "it is not a directory";
				else if (!gitdir || !samePath(await realOrSame(resolve(record.worktree, gitdir)), await realOrSame(admin!)))
					blocked = "it does not belong to the recorded worktree entry";
				else {
					const head = await headOf(record.worktree, ctx);
					if (head !== record.startCommit) blocked = `its HEAD moved to ${head ? short(head) : "something else"}`;
				}
			}
			if (blocked === null && record.createdBranch && record.branch) {
				const tip = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${record.branch}`], ctx, {
					noRepository: true,
					ok: [1],
				});
				if (tip.code === 0 && text(tip).trim() !== record.startCommit)
					blocked = `its branch ${record.branch} has new commits`;
			}
			if (blocked !== null) {
				leftovers.push(`worktree ${record.worktree}: not removed, ${blocked}`);
				if (record.branch) leftovers.push(`branch ${record.branch}: not removed, it belongs to ${record.worktree}`);
				repoUsable = false;
			} else if (present) {
				const result = await git(repo, ["worktree", "remove", "--force", record.worktree], ctx, {
					noRepository: true,
					ok: [1, 128],
				});
				if (result.code !== 0 || (await exists(record.worktree))) {
					leftovers.push(
						`worktree ${record.worktree}: git could not remove it (${result.stderr.trim().split("\n")[0] ?? "unknown"})`,
					);
					if (record.branch)
						leftovers.push(`branch ${record.branch}: not removed, it belongs to ${record.worktree}`);
					repoUsable = false;
				} else {
					removed.push(`worktree ${record.worktree}`);
				}
			} else if (admin && basename(dirname(admin)) === "worktrees") {
				// the directory is gone but its (marked) administrative entry is not: delete that one entry, never `worktree prune` (other worktrees)
				await rm(admin, { recursive: true, force: true });
				removed.push(`worktree entry ${admin}`);
			}
		}
		if (repoUsable && record.createdBranch && record.branch) {
			const tip = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${record.branch}`], ctx, {
				noRepository: true,
				ok: [1],
			});
			if (tip.code === 0) {
				if (text(tip).trim() === record.startCommit) {
					await git(repo, ["update-ref", "-d", `refs/heads/${record.branch}`, record.startCommit], ctx, {
						noRepository: true,
						config: PLAIN_OBJECTS,
					});
					removed.push(`branch ${record.branch}`);
				} else {
					leftovers.push(`branch ${record.branch}: not removed, it has new commits`);
				}
			}
		}
		if (repoUsable) {
			for (const dir of [...record.createdDirs].reverse()) {
				try {
					await rmdir(dir); // only when empty
					removed.push(`directory ${dir}`);
				} catch {
					// not empty or already gone: not ours to force
				}
			}
		}
	} else if (
		record.worktree !== "" &&
		(record.written.length > 0 || record.removed.length > 0 || record.indexReplaced)
	) {
		await restoreExisting(record, ctx, removed, leftovers);
	}

	if (record.threadId) {
		try {
			for (const ref of await removeHandoffRefs(repo, record.threadId, ctx)) removed.push(`ref ${ref}`);
		} catch (error) {
			leftovers.push(
				`handoff refs of thread ${record.threadId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { removed, leftovers };
}

/** An existing (clean) worktree: put the touched paths back to their state at `startCommit` and the index to HEAD. */
async function restoreExisting(
	record: WorkspaceRecord,
	ctx: GitContext | undefined,
	removed: string[],
	leftovers: string[],
): Promise<void> {
	if (!(await exists(record.worktree))) return;
	const root = await realpath(record.worktree);
	const symlinks = await git(root, ["config", "--bool", "--get", "core.symlinks"], ctx, { ok: [1] });
	const trustSymlinks = symlinks.code === 1 || text(symlinks).trim() !== "false";
	const head = await headOf(root, ctx);
	if (head !== record.startCommit) {
		leftovers.push(
			`worktree ${record.worktree}: not restored, its HEAD moved to ${head ? short(head) : "something else"}`,
		);
		return;
	}
	const touched = [...new Set([...record.written, ...record.removed.map(entry => entry.path)])].sort();
	if (record.originalFiles) {
		const original = new Map(record.originalFiles.map(entry => [entry.path, entry]));
		for (const path of touched) {
			const entry = original.get(path);
			if (!entry) {
				if (await removeEntry(root, path)) removed.push(`file ${path} (written by the handoff)`);
				continue;
			}
			const bytes = Buffer.from(entry.bytes, "base64");
			if (!(await sameAsBlob(join(root, path), entry.mode, bytes, trustSymlinks))) {
				await removeEntry(root, path);
				await writeEntry(root, path, entry.mode, bytes, trustSymlinks);
				removed.push(`restored ${path}`);
			}
		}
	} else if (touched.length > 0) {
		const wanted = new Set(touched);
		const listing = await git(root, ["ls-tree", "-r", "-z", record.startCommit], ctx, { maxBytes: 256 * MIB });
		const original = new Map<string, HeadEntry>();
		for (const entry of text(listing).split("\0")) {
			const tab = entry.indexOf("\t");
			if (tab < 0) continue;
			const path = entry.slice(tab + 1);
			if (!wanted.has(path)) continue;
			const [mode, , oid] = entry.slice(0, tab).split(" ");
			if (mode && oid && mode !== GITLINK) original.set(path, { mode, oid });
		}
		// Which paths differ from the original state: read the blobs once and compare.
		const restore: { path: string; mode: string; bytes: Uint8Array }[] = [];
		const drop: string[] = [];
		const byOid = new Map<string, string[]>();
		for (const path of touched) {
			const entry = original.get(path);
			if (entry) byOid.set(entry.oid, [...(byOid.get(entry.oid) ?? []), path]);
			else if (await lstatOrNull(join(root, path))) drop.push(path);
		}
		await readBlobs(root, [...byOid.keys()], ctx, async (oid, bytes) => {
			for (const path of byOid.get(oid)!) {
				const entry = original.get(path)!;
				if (!(await sameAsBlob(join(root, path), entry.mode, bytes, trustSymlinks)))
					restore.push({ path, mode: entry.mode, bytes: bytes.slice() });
			}
		});
		for (const path of drop) if (await removeEntry(root, path)) removed.push(`file ${path} (written by the handoff)`);
		for (const item of restore) await removeEntry(root, item.path);
		for (const item of restore) {
			await writeEntry(root, item.path, item.mode, item.bytes, trustSymlinks);
			removed.push(`restored ${item.path}`);
		}
	}
	if (record.indexReplaced) {
		const differs = await git(root, ["diff-index", "--cached", "--quiet", record.startCommit], ctx, { ok: [1] });
		if (differs.code === 1) {
			await git(root, ["read-tree", record.startCommit], ctx);
			removed.push(`index of ${record.worktree} reset to ${short(record.startCommit)}`);
		}
	}
	await git(root, ["update-index", "-q", "--refresh"], ctx, { ok: [1] });
}

async function sameAsBlob(path: string, mode: string, bytes: Uint8Array, trustSymlinks: boolean): Promise<boolean> {
	const stat = await lstatOrNull(path);
	if (!stat) return false;
	if (mode === "120000" && (trustSymlinks || stat.isSymbolicLink())) {
		if (!stat.isSymbolicLink()) return false;
		const target = await readlink(path, { encoding: "buffer" });
		return Buffer.compare(target, Buffer.from(bytes)) === 0;
	}
	// core.symlinks=false: a 120000 entry is checked out as a plain file holding the link text.
	if (!stat.isFile() || stat.size !== bytes.length) return false;
	if (mode !== "120000" && process.platform !== "win32" && ((stat.mode & 0o111) !== 0) !== (mode === "100755"))
		return false;
	return Buffer.compare(await readFile(path), Buffer.from(bytes)) === 0;
}
