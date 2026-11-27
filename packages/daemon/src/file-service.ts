/**
 * The read-only file service of an environment daemon: directory listings (git's ignore rules honoured), file reads
 * (text pages, image bytes), `git status` and `git diff`, scoped to the worktree roots this machine registered.
 *
 * Everything that touches the filesystem goes through `file-path.ts` (containment, symlinks, special files, `.git`,
 * open-then-verify); everything that runs git goes through `git-run.ts` (argv only, hardened environment, timeouts, caps).
 */
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	FILE_CHUNK_BYTES,
	FILE_IMAGE_MAX_BYTES,
	FILE_LIST_LIMIT,
	FILE_PAGE_LINES,
	FILE_VIEW_MAX_BYTES,
	type FileBytes,
	type FileContent,
	type FileDiff,
	type FileDiffMode,
	type FileEntry,
	type FileListing,
	type FileLocation,
	type FilesClientMessage,
	type GitStatus,
	type GitStatusEntry,
	type LineCounts,
} from "@omp-web/protocol";
import {
	FileError,
	type PathHooks,
	checkDirectory,
	classifyLink,
	kindOf,
	openRegularFile,
	parseRelPath,
	resolveInside,
} from "./file-path";
import { highlightSpans, languageFor } from "./file-highlight";
import { readHead, readTextPage, sniff } from "./file-text";
import { runGit } from "./git-run";
import { cutAtLine, parseNumstat, parseStatusV2, summarizeDiff, sumCounts } from "./git-parse";

export interface FileServiceOptions {
	/** The canonical root for a worktree root named by a request; throws a {@link FileError} (`not_registered`) otherwise. */
	resolveRoot(root: string): Promise<string>;
	/**
	 * The absolute path behind an omp URL as session `sessionId` resolves it (see `omp-urls.ts`); throws a
	 * {@link FileError}. Absent: `files.locate` is refused.
	 */
	locateUrl?(sessionId: string, url: string): Promise<string>;
	hooks?: PathHooks;
}

/** Directories `files.locate` opened, browsable like worktrees for the daemon's lifetime; the oldest go first. */
const GRANT_LIMIT = 256;

/** Entries of one directory that are looked at before the rest is declared "more". */
const SCAN_LIMIT = 5000;
const DIFF_MAX_BYTES = 512 * 1024;
/** How much of the untracked files the status's line counts read: files looked at, bytes per file, bytes in all. */
const UNTRACKED_COUNT = { files: 1000, fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024 };

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const byName = (a: { name: string }, b: { name: string }): number =>
	collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/** Line counts per path of each side of the status; a side git could not count is undefined. */
interface LineCountsByPath {
	total: LineCounts | undefined;
	staged: Map<string, LineCounts> | undefined;
	unstaged: Map<string, LineCounts> | undefined;
	untracked: Map<string, LineCounts> | undefined;
}

/** The entry with the counts of its sides; an untracked directory sums the files below it. */
function withCounts(entry: GitStatusEntry, counts: LineCountsByPath): GitStatusEntry {
	if (entry.kind === "untracked") {
		if (!counts.untracked) return entry;
		if (entry.dir !== true) {
			const own = counts.untracked.get(entry.path);
			return own ? { ...entry, unstaged: own } : entry;
		}
		const below = [...counts.untracked].filter(([path]) => path.startsWith(entry.path)).map(([, count]) => count);
		return below.length > 0 ? { ...entry, unstaged: sumCounts(below) } : entry;
	}
	const staged = counts.staged?.get(entry.path);
	const unstaged = counts.unstaged?.get(entry.path);
	return { ...entry, ...(staged ? { staged } : {}), ...(unstaged ? { unstaged } : {}) };
}

export class FileService {
	/** Canonical directories that `files.locate` answered with: the request names them exactly as they were returned. */
	readonly #granted = new Set<string>();

	constructor(private readonly options: FileServiceOptions) {}

	/** Answers one validated `files.*` request with the ack's data. Throws {@link FileError} for refusals. */
	async handle(message: FilesClientMessage): Promise<unknown> {
		if (message.t === "files.locate") return this.locate(message.sessionId, message.url);
		const root = this.#granted.has(message.root) ? message.root : await this.options.resolveRoot(message.root);
		switch (message.t) {
			case "files.list":
				return this.list(root, message.path, message.showIgnored === true);
			case "files.read":
				return this.read(root, message.path, message.fromLine ?? 1, message.maxLines ?? FILE_PAGE_LINES);
			case "files.bytes":
				return this.bytes(root, message.path, message.offset, message.length);
			case "files.status":
				return this.status(root);
			case "files.diff":
				return this.diff(root, message.path, message.mode, message.origPath);
		}
	}

	/**
	 * Where an omp URL's file is, as a root (its directory, canonical) and the file in it; the root is granted so that the
	 * Files view can open it and its neighbours. A URL naming a directory is its own root.
	 */
	async locate(sessionId: string, url: string): Promise<FileLocation> {
		if (!this.options.locateUrl) throw new FileError("forbidden", "this machine does not open omp URLs");
		const located = await this.options.locateUrl(sessionId, url);
		const real = await realpath(located).catch(() => {
			throw new FileError("not_found", `${url} has no file on this machine yet`);
		});
		const dir = (await stat(real)).isDirectory();
		const root = dir ? real : dirname(real);
		this.#granted.delete(root);
		this.#granted.add(root);
		if (this.#granted.size > GRANT_LIMIT) this.#granted.delete(this.#granted.values().next().value!);
		return { root, path: dir ? "" : basename(real) };
	}

	/** Which of `paths` (relative to `root`) git ignores; null when git could not say. An omp URL's directory has no rules. */
	async #ignored(root: string, paths: readonly string[]): Promise<Set<string> | null> {
		if (paths.length === 0 || this.#granted.has(root)) return new Set();
		// A name starting with ":" would be read as pathspec magic (check-ignore cannot take literal pathspecs): "./" ends that.
		const sent = new Map(paths.map(path => [path.startsWith(":") ? `./${path}` : path, path]));
		const input = new TextEncoder().encode(`${[...sent.keys()].join("\0")}\0`);
		const result = await runGit(root, ["check-ignore", "--stdin", "-z"], {
			stdin: input,
			timeoutMs: 10_000,
			magicPathspecs: true,
		});
		if (result.code !== 0 && result.code !== 1) return null; // 128: not a repository, a path inside a submodule, …
		return new Set(
			decode(result.stdout)
				.split("\0")
				.filter(Boolean)
				.map(path => sent.get(path) ?? path),
		);
	}

	async list(root: string, path: string, showIgnored: boolean): Promise<FileListing> {
		const dir = await checkDirectory(root, parseRelPath(path), this.options.hooks);
		const scanned: { name: string; kind: FileEntry["kind"] }[] = [];
		let more = false;
		const handle = await opendir(dir.real).catch(() => {
			throw new FileError("forbidden", "cannot read the directory");
		});
		try {
			for await (const entry of handle) {
				if (entry.name.toLowerCase() === ".git") continue;
				if (scanned.length >= SCAN_LIMIT) {
					more = true;
					break;
				}
				const kind: FileEntry["kind"] = entry.isDirectory()
					? "dir"
					: entry.isSymbolicLink()
						? "symlink"
						: entry.isFile()
							? "file"
							: ((await kindOf(join(dir.real, entry.name))) ?? "other");
				scanned.push({ name: entry.name, kind });
			}
		} finally {
			await handle.close().catch(() => {});
		}
		await dir.verify(); // a directory swapped while it was read is discarded

		const below = (name: string): string => [...dir.rel, name].join("/");
		const probe = dir.rel.length > 0 ? [dir.rel.join("/")] : [];
		const ignoredSet = await this.#ignored(root, [...probe, ...scanned.map(e => below(e.name))]).catch(() => null);
		// Listing inside a directory git ignores: everything there is ignored, hiding it would show an empty directory.
		const insideIgnored = probe.length > 0 && ignoredSet?.has(probe[0]!) === true;
		const flagged = (name: string): boolean => ignoredSet?.has(below(name)) === true;
		const visible = scanned.filter(e => showIgnored || insideIgnored || !flagged(e.name));
		const ignoredHidden = scanned.length - visible.length;
		visible.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || byName(a, b));
		const shown = visible.slice(0, FILE_LIST_LIMIT);

		const entries: FileEntry[] = [];
		for (let at = 0; at < shown.length; at += 64) {
			entries.push(
				...(await Promise.all(
					shown.slice(at, at + 64).map(async (e): Promise<FileEntry> => {
						const entry: FileEntry = { name: e.name, kind: e.kind };
						if (flagged(e.name) || insideIgnored) entry.ignored = true;
						const full = join(dir.real, e.name);
						if (e.kind === "file") {
							const info = await lstat(full).catch(() => null);
							if (info !== null) entry.size = info.size;
						} else if (e.kind === "symlink") {
							entry.link = await classifyLink(root, full);
						}
						return entry;
					}),
				)),
			);
		}
		return {
			path,
			entries,
			truncated: more || visible.length > shown.length,
			scanned: scanned.length,
			ignoredHidden: insideIgnored ? 0 : ignoredHidden,
			ignoreChecked: ignoredSet !== null,
		};
	}

	async read(root: string, path: string, fromLine: number, maxLines: number): Promise<FileContent> {
		const segments = parseRelPath(path);
		const peek = await resolveInside(root, segments);
		if ((await lstat(peek.real).catch(() => null))?.isDirectory()) return { kind: "dir", path };
		const file = await openRegularFile(root, segments, this.options.hooks);
		try {
			const ignored = (await this.#ignored(root, [file.rel.join("/")]).catch(() => null))?.size === 1;
			const meta = { path, size: file.size, mtimeMs: file.mtimeMs, ignored };
			const head = await readHead(file.handle, file.size);
			const kind = sniff(head);
			if (kind.kind === "image") {
				if (file.size > FILE_IMAGE_MAX_BYTES) {
					return {
						...meta,
						kind: "binary",
						reason: `image larger than ${FILE_IMAGE_MAX_BYTES / (1024 * 1024)} MiB, not previewed`,
					};
				}
				return { ...meta, kind: "image", mime: kind.mime };
			}
			if (kind.kind === "binary") return { ...meta, kind: "binary", reason: kind.reason };
			if (file.size > FILE_VIEW_MAX_BYTES) return { ...meta, kind: "too_large", limit: FILE_VIEW_MAX_BYTES };
			const key = `${file.real}\0${file.size}\0${file.mtimeMs}`;
			const page = await readTextPage(file.handle, file.size, key, fromLine, maxLines);
			const lang = languageFor(path);
			return { ...meta, kind: "text", ...page, lang, spans: highlightSpans(page.text, lang) };
		} finally {
			await file.handle.close().catch(() => {});
		}
	}

	async bytes(root: string, path: string, offset: number, length: number): Promise<FileBytes> {
		const file = await openRegularFile(root, parseRelPath(path), this.options.hooks);
		try {
			if (sniff(await readHead(file.handle, file.size)).kind !== "image") {
				throw new FileError("forbidden", "only image previews are served as raw bytes");
			}
			if (file.size > FILE_IMAGE_MAX_BYTES) throw new FileError("too_large", "the image is too large to preview");
			const want = Math.max(0, Math.min(length, FILE_CHUNK_BYTES, file.size - offset));
			const buf = Buffer.allocUnsafe(want);
			const { bytesRead } = want === 0 ? { bytesRead: 0 } : await file.handle.read(buf, 0, want, offset);
			return {
				offset,
				length: bytesRead,
				size: file.size,
				mtimeMs: file.mtimeMs,
				eof: offset + bytesRead >= file.size,
				data: buf.subarray(0, bytesRead).toString("base64"),
			};
		} finally {
			await file.handle.close().catch(() => {});
		}
	}

	async status(root: string): Promise<GitStatus> {
		const result = await runGit(
			root,
			["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal", "--renames"],
			{
				timeoutMs: 20_000,
				maxBytes: 8 * 1024 * 1024,
			},
		);
		if (result.timedOut) throw new FileError("git", "git status timed out");
		if (result.code !== 0 && !result.truncated)
			throw new FileError("git", `git status failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
		let text = decode(result.stdout);
		if (result.truncated) text = text.slice(0, text.lastIndexOf("\0") + 1);
		const status = parseStatusV2(text);
		const counts = await this.#lineCounts(root, status.branch.oid);
		const entries = counts ? status.entries.map(entry => withCounts(entry, counts)) : status.entries;
		return {
			...status,
			entries,
			...(result.truncated ? { truncated: true } : {}),
			...(counts?.total ? { lines: counts.total } : {}),
		};
	}

	/**
	 * Lines changed per path: HEAD → index (staged), index → worktree (unstaged), the lines of untracked text files, and the
	 * total against HEAD (the empty tree before the first commit), untracked lines counted as added; the total is
	 * undefined when one of them failed. Untracked files are read within {@link UNTRACKED_COUNT} limits.
	 */
	async #lineCounts(root: string, head: string | null): Promise<LineCountsByPath | undefined> {
		const base = head ?? (await this.#emptyTree(root));
		if (base === undefined) return undefined;
		const numstat = async (args: string[]): Promise<Map<string, LineCounts> | undefined> => {
			const result = await runGit(
				root,
				["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--find-renames", ...args, "--"],
				{ timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 },
			);
			return result.timedOut || result.truncated || result.code !== 0
				? undefined
				: parseNumstat(decode(result.stdout));
		};
		const [tracked, staged, unstaged, untracked] = await Promise.all([
			numstat([base]),
			numstat(["--cached", base]),
			numstat([]),
			this.#untrackedLines(root),
		]);
		let total: LineCounts | undefined;
		if (tracked && untracked) {
			total = sumCounts(tracked.values());
			total.added += sumCounts(untracked.values()).added;
		}
		return { total, staged, unstaged, untracked };
	}

	/** The repository's empty tree id (SHA-1 or SHA-256, whichever the repository uses). */
	async #emptyTree(root: string): Promise<string | undefined> {
		const result = await runGit(root, ["hash-object", "-t", "tree", "--stdin"], {
			stdin: new Uint8Array(0),
			timeoutMs: 10_000,
		});
		const id = decode(result.stdout).trim();
		return result.code === 0 && /^[0-9a-f]+$/.test(id) ? id : undefined;
	}

	/** Lines of each untracked, not ignored text file (each read through the same checked open as a viewer would). */
	async #untrackedLines(root: string): Promise<Map<string, LineCounts> | undefined> {
		const listed = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], {
			timeoutMs: 20_000,
			maxBytes: 4 * 1024 * 1024,
		});
		if (listed.timedOut || (listed.code !== 0 && !listed.truncated)) return undefined;
		const paths = decode(listed.stdout).split("\0");
		paths.pop(); // what follows the last NUL: empty, or a name cut off by the cap
		const counts = new Map<string, LineCounts>();
		let budget = UNTRACKED_COUNT.totalBytes;
		for (const path of paths.slice(0, UNTRACKED_COUNT.files)) {
			let segments: string[];
			try {
				segments = parseRelPath(path);
			} catch {
				continue;
			}
			const file = await openRegularFile(root, segments, this.options.hooks).catch(() => null);
			if (!file) continue;
			try {
				if (file.size > UNTRACKED_COUNT.fileBytes || file.size > budget) continue;
				budget -= file.size;
				const buf = Buffer.allocUnsafe(file.size);
				const { bytesRead } = file.size === 0 ? { bytesRead: 0 } : await file.handle.read(buf, 0, file.size, 0);
				const bytes = buf.subarray(0, bytesRead);
				if (bytes.length === 0 || sniff(bytes.subarray(0, 8000)).kind !== "text") continue;
				let newlines = 0;
				for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, at + 1)) newlines++;
				counts.set(path, { added: newlines + (bytes[bytes.length - 1] === 0x0a ? 0 : 1), removed: 0 });
			} finally {
				await file.handle.close().catch(() => {});
			}
		}
		return counts;
	}

	async diff(root: string, path: string, mode: FileDiffMode, origPath?: string): Promise<FileDiff> {
		const segments = parseRelPath(path);
		if (segments.length === 0) throw new FileError("bad_path", "a diff needs a file path");
		const old = origPath === undefined ? undefined : (parseRelPath(origPath), origPath);
		if (mode === "untracked") return this.#untrackedDiff(root, path, segments);
		const flags = [
			"--no-ext-diff",
			"--no-textconv",
			"--no-color",
			"--find-renames",
			"--unified=3",
			"--src-prefix=a/",
			"--dst-prefix=b/",
		];
		const spec = old !== undefined && old !== path ? [old, path] : [path];
		const args =
			mode === "staged"
				? ["diff", "--cached", ...flags, "--", ...spec]
				: mode === "head"
					? ["diff", "HEAD", ...flags, "--", ...spec]
					: ["diff", ...flags, "--", path];
		const result = await runGit(root, args, { timeoutMs: 20_000, maxBytes: DIFF_MAX_BYTES });
		if (result.timedOut) throw new FileError("git", "git diff timed out");
		if (result.code !== 0 && !result.truncated) {
			throw new FileError("git", `git diff failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
		}
		const raw = decode(result.stdout);
		const diff = result.truncated ? cutAtLine(raw) : raw;
		return {
			mode,
			path,
			...(old === undefined ? {} : { origPath: old }),
			diff,
			truncated: result.truncated,
			...summarizeDiff(diff),
		};
	}

	/** A file git does not track, as the diff that adds it (read through the same checked open as a viewer would). */
	async #untrackedDiff(root: string, path: string, segments: readonly string[]): Promise<FileDiff> {
		const file = await openRegularFile(root, segments, this.options.hooks);
		try {
			const head = await readHead(file.handle, file.size);
			const header = `diff --git a/${path} b/${path}\nnew file mode ${file.mode & 0o111 ? "100755" : "100644"}\n`;
			if (sniff(head).kind !== "text") {
				const diff = `${header}Binary files /dev/null and b/${path} differ\n`;
				return { mode: "untracked", path, diff, truncated: false, binary: true, added: 0, removed: 0 };
			}
			const want = Math.min(file.size, DIFF_MAX_BYTES);
			const buf = Buffer.allocUnsafe(want);
			const { bytesRead } = want === 0 ? { bytesRead: 0 } : await file.handle.read(buf, 0, want, 0);
			const truncated = file.size > want;
			let text = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, bytesRead));
			if (truncated) text = cutAtLine(text);
			const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
			const endsWithNewline = text.endsWith("\n");
			const body = lines.map(line => `+${line}`).join("\n");
			const diff =
				lines.length === 0
					? `${header}`
					: `${header}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n${endsWithNewline || truncated ? "" : "\\ No newline at end of file\n"}`;
			return { mode: "untracked", path, diff, truncated, binary: false, added: lines.length, removed: 0 };
		} finally {
			await file.handle.close().catch(() => {});
		}
	}
}
