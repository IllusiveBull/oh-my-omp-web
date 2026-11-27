/**
 * The file browser's wire types (read-only access to a registered worktree of one machine).
 *
 * Every request names the machine (the browser's `m`), a worktree root (an absolute path the machine registered:
 * a project root or one of its `git worktree`s) and a path relative to that root in `/` form (`""` = the root). The
 * daemon resolves symlinks and refuses anything that does not stay inside the root (see `file-path.ts`). Answers are
 * ordinary acks (`data`), so they travel the same request/ack path as session requests, one bounded frame each: the
 * client pages through large content (`files.read` by line, `files.bytes` by byte range) and so decides how much is in
 * flight; nothing is streamed unasked.
 */

/** Largest slice of a file one frame carries (before base64), and the size of `files.read` text pages in bytes. */
export const FILE_CHUNK_BYTES = 256 * 1024;
/** Default and largest number of lines `files.read` returns in a page (a page is also capped at {@link FILE_CHUNK_BYTES}). */
export const FILE_PAGE_LINES = 1000;
export const FILE_MAX_PAGE_LINES = 5000;
/** Entries of one directory listing. More than this are cut off and the listing says so. */
export const FILE_LIST_LIMIT = 2000;
/** Raster images up to this size are previewed inline. */
export const FILE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Text files larger than this are not opened (paging a line number costs a scan from the start of the file). */
export const FILE_VIEW_MAX_BYTES = 64 * 1024 * 1024;
/** Longest path (in characters) a request may carry. */
export const FILE_PATH_MAX = 4096;

export type FileDiffMode =
	/** Working tree against the index (`git diff`). */
	| "unstaged"
	/** Index against HEAD (`git diff --cached`). */
	| "staged"
	/** Working tree against HEAD (`git diff HEAD`). */
	| "head"
	/** A file git does not know: shown as an all-added file. */
	| "untracked";

export const FILE_DIFF_MODES: readonly FileDiffMode[] = ["unstaged", "staged", "head", "untracked"];

export type FilesClientMessage =
	/** The entries of one directory; ignored ones only when `showIgnored`. Acks a {@link FileListing}. */
	| { t: "files.list"; reqId: string; root: string; path: string; showIgnored?: boolean }
	/**
	 * Opens a file (or says it is a directory). Text comes back as a page starting at 1-based line `fromLine`
	 * (default 1) with at most `maxLines` lines. Acks a {@link FileContent}.
	 */
	| { t: "files.read"; reqId: string; root: string; path: string; fromLine?: number; maxLines?: number }
	/** A byte range of a previewable image (at most {@link FILE_CHUNK_BYTES}). Acks a {@link FileBytes}. */
	| { t: "files.bytes"; reqId: string; root: string; path: string; offset: number; length: number }
	/** `git status` of the worktree. Acks a {@link GitStatus}. */
	| { t: "files.status"; reqId: string; root: string }
	/** `git diff` of one file (`origPath`: where a renamed file came from). Acks a {@link FileDiff}. */
	| { t: "files.diff"; reqId: string; root: string; path: string; mode: FileDiffMode; origPath?: string }
	/**
	 * The file behind one of omp's own URLs (`local://x.md`, `agent://Id`, `skill://name`, …, see
	 * {@link LOCATABLE_URL_SCHEMES}) as the session `sessionId` would resolve it. The daemon lets the file's directory be
	 * browsed like a worktree from then on. Acks a {@link FileLocation}.
	 */
	| { t: "files.locate"; reqId: string; sessionId: string; url: string };

/**
 * omp URL schemes whose resources are files on the session's machine, so the Files view can show them. Not here:
 * in-process state (`proc://`, `xd://`, `out://`), rules loaded by the omp process (`rule://`), remote ones (`pr://`,
 * `issue://`, `ssh://`, `mcp://`) and secrets (`vault://`).
 */
export const LOCATABLE_URL_SCHEMES: readonly string[] = [
	"agent",
	"artifact",
	"attachment",
	"history",
	"local",
	"memory",
	"omp",
	"skill",
];

/** Where a `files.locate` URL lives: a root the Files view may open (the file's directory) and the file in it. */
export interface FileLocation {
	root: string;
	/** Root-relative; "" when the URL names a directory. */
	path: string;
}

/** Why a file request was refused; the message says more. */
export type FilesErrorCode =
	/** The root is not a registered project root or worktree of the machine. */
	| "not_registered"
	/** A malformed path: absolute, `..`, NUL, empty segment, too long. */
	| "bad_path"
	/** Nothing there. */
	| "not_found"
	/** The path (or a symlink on it) leads outside the worktree. */
	| "outside_root"
	/** Never served: git's own directory, special files (fifo, socket, device), symlink loops. */
	| "forbidden"
	/** Larger than the viewer's cap. */
	| "too_large"
	/** The file changed or was swapped while it was being read. */
	| "changed"
	/** Too many file requests at once; try again. */
	| "busy"
	/** git failed, timed out, or is too old. */
	| "git";

export type FileEntryKind = "file" | "dir" | "symlink" | "other";

/** What a symlink inside the worktree leads to. Only `file` and `dir` can be opened. */
export type LinkTargetKind = "file" | "dir" | "other" | "outside" | "broken";

export interface FileEntry {
	name: string;
	kind: FileEntryKind;
	/** Bytes, for files. */
	size?: number;
	/** git ignores it (only listed when ignored entries were asked for). */
	ignored?: boolean;
	/** For symlinks: the link's own text and where it ends up. The link is never followed outside the worktree. */
	link?: { target: string; resolves: LinkTargetKind };
}

export interface FileListing {
	path: string;
	entries: FileEntry[];
	/** Directories first, then files, each sorted by name. `true`: the directory has more entries than were listed. */
	truncated: boolean;
	/** Entries of the directory that were looked at (a huge directory is not read to the end). */
	scanned: number;
	/** How many entries git's ignore rules hid. */
	ignoredHidden: number;
	/** False when git could not be asked which entries are ignored (nothing was hidden). */
	ignoreChecked: boolean;
}

/** Syntax classes of {@link FileContent} `spans`, by `kind - 1` (kind 0 is plain text). Names follow upstream's highlighter. */
export const HIGHLIGHT_KINDS = [
	"comment",
	"keyword",
	"function",
	"variable",
	"string",
	"number",
	"type",
	"operator",
	"punctuation",
	"inserted",
	"deleted",
] as const;
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];

interface FileMeta {
	path: string;
	size: number;
	mtimeMs: number;
	/** git ignores this file (it is readable all the same). */
	ignored: boolean;
}

export type FileContent =
	| { kind: "dir"; path: string }
	| (FileMeta & {
			kind: "text";
			/** The page's text, valid UTF-8 or (when `lossy`) with U+FFFD where bytes were not. Line ends as in the file. */
			text: string;
			/** 1-based number of the page's first line, and of its last (`startLine - 1` for an empty page). */
			startLine: number;
			endLine: number;
			/** First line of the next page, or null at the end of the file. */
			nextLine: number | null;
			/** Lines in the whole file when the daemon counted them (files up to 32 MiB), else null. */
			totalLines: number | null;
			lossy: boolean;
			crlf: boolean;
			bom: boolean;
			/** A line longer than a page was cut. */
			cut: boolean;
			/** Highlighter language, null when the file type is unknown. */
			lang: string | null;
			/** Flattened `[kind, length, kind, length, …]` over the UTF-16 units of `text`; null when not highlighted. */
			spans: number[] | null;
	  })
	| (FileMeta & { kind: "image"; mime: string })
	| (FileMeta & { kind: "binary"; reason: string })
	| (FileMeta & { kind: "too_large"; limit: number });

export interface FileBytes {
	offset: number;
	length: number;
	/** The file's size and mtime when this slice was read; they must stay the same across the slices of one image. */
	size: number;
	mtimeMs: number;
	eof: boolean;
	/** base64 */
	data: string;
}

/** One line of `git status --porcelain=v2`. `x` is the index side, `y` the working-tree side (`.` = unchanged). */
export interface GitStatusEntry {
	path: string;
	/** The old path of a rename or copy. */
	origPath?: string;
	kind: "changed" | "renamed" | "untracked" | "unmerged";
	x: string;
	y: string;
	/** An untracked directory is listed as one entry (git's `normal` mode), its path ends with `/`. */
	dir?: boolean;
	/** Lines of the index side (HEAD → index, the Staged row). Absent when git could not count them (binary files). */
	staged?: LineCounts;
	/**
	 * Lines of the working-tree side (index → worktree, the Unstaged or Conflicted row); for an untracked entry its text
	 * files' lines as added. Absent when not counted.
	 */
	unstaged?: LineCounts;
}

export interface LineCounts {
	added: number;
	removed: number;
}

export interface GitStatus {
	branch: {
		head: string | null;
		oid: string | null;
		upstream: string | null;
		ahead: number | null;
		behind: number | null;
	};
	entries: GitStatusEntry[];
	truncated: boolean;
	/**
	 * Lines added and removed in the worktree against HEAD, untracked text files counted as added (GitHub's `+12 −3`).
	 * Absent when git could not say.
	 */
	lines?: LineCounts;
}

export interface FileDiff {
	mode: FileDiffMode;
	path: string;
	origPath?: string;
	/** Unified diff text as git printed it (headers included), cut at a line boundary when `truncated`. */
	diff: string;
	truncated: boolean;
	binary: boolean;
	added: number;
	removed: number;
	/** `rename from` of the diff, when git detected a rename. */
	renamedFrom?: string;
}

// ---------------------------------------------------------------------------
// Validation (daemon and gateway share it; path rules proper live in the daemon's file-path.ts)

type Rec = Record<string, unknown>;

const str = (r: Rec, k: string): string => {
	const v = r[k];
	if (typeof v !== "string") throw new Error(`${String(r.t)}: "${k}" must be a string`);
	return v;
};
const optBool = (r: Rec, k: string): boolean | undefined => {
	const v = r[k];
	if (v === undefined) return undefined;
	if (typeof v !== "boolean") throw new Error(`${String(r.t)}: "${k}" must be a boolean`);
	return v;
};
const int = (r: Rec, k: string, min: number, max: number): number => {
	const v = r[k];
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
		throw new Error(`${String(r.t)}: "${k}" must be an integer from ${min} to ${max}`);
	}
	return v;
};
const optInt = (r: Rec, k: string, min: number, max: number): number | undefined =>
	r[k] === undefined ? undefined : int(r, k, min, max);
const pathString = (r: Rec, k: string): string => {
	const v = str(r, k);
	if (v.length > FILE_PATH_MAX) throw new Error(`${String(r.t)}: "${k}" is longer than ${FILE_PATH_MAX} characters`);
	return v;
};

/** Whether `t` names a file request. */
export function isFilesMessageType(t: string): boolean {
	return t.startsWith("files.");
}

/** Validates a `files.*` frame (type and size checks; the daemon decides whether a path is acceptable). */
export function parseFilesMessage(raw: Rec): FilesClientMessage {
	const reqId = str(raw, "reqId");
	if (raw.t === "files.locate") {
		const sessionId = str(raw, "sessionId");
		const url = pathString(raw, "url");
		if (sessionId === "" || url === "") throw new Error(`files.locate: "sessionId" and "url" must not be empty`);
		return { t: "files.locate", reqId, sessionId, url };
	}
	const root = pathString(raw, "root");
	if (root === "") throw new Error(`${String(raw.t)}: "root" must not be empty`);
	switch (raw.t) {
		case "files.list":
			return {
				t: "files.list",
				reqId,
				root,
				path: pathString(raw, "path"),
				showIgnored: optBool(raw, "showIgnored"),
			};
		case "files.read":
			return {
				t: "files.read",
				reqId,
				root,
				path: pathString(raw, "path"),
				fromLine: optInt(raw, "fromLine", 1, Number.MAX_SAFE_INTEGER),
				maxLines: optInt(raw, "maxLines", 1, FILE_MAX_PAGE_LINES),
			};
		case "files.bytes":
			return {
				t: "files.bytes",
				reqId,
				root,
				path: pathString(raw, "path"),
				offset: int(raw, "offset", 0, Number.MAX_SAFE_INTEGER),
				length: int(raw, "length", 1, FILE_CHUNK_BYTES),
			};
		case "files.status":
			return { t: "files.status", reqId, root };
		case "files.diff": {
			const mode = raw.mode;
			if (typeof mode !== "string" || !(FILE_DIFF_MODES as readonly string[]).includes(mode)) {
				throw new Error(`files.diff: "mode" must be one of ${FILE_DIFF_MODES.join(", ")}`);
			}
			const origPath = raw.origPath === undefined ? undefined : pathString(raw, "origPath");
			return { t: "files.diff", reqId, root, path: pathString(raw, "path"), mode: mode as FileDiffMode, origPath };
		}
		default:
			throw new Error(`unknown message type: ${String(raw.t)}`);
	}
}
