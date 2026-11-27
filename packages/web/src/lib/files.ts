/**
 * Pure helpers of the Files view: path arithmetic, decoding of daemon answers, git status decorations, the
 * highlighted-line splitter and the image chunk planner. Nothing here touches the DOM or the network.
 */
import {
	FILE_CHUNK_BYTES,
	FILE_DIFF_MODES,
	type FileBytes,
	type FileContent,
	type FileDiff,
	type FileDiffMode,
	type FileEntry,
	type FileListing,
	type FileLocation,
	type FilesErrorCode,
	type GitStatus,
	type GitStatusEntry,
	HIGHLIGHT_KINDS,
	type HighlightKind,
	type LineCounts,
	type LinkTargetKind,
} from "@omp-web/protocol";

/**
 * Why a files request produced no data: the daemon's refusal, a machine that is away (`offline`), any other failure
 * of the request (`failed`), an answer that cannot be read (`protocol`), or a request dropped because the view closed.
 */
export type FilesFailureCode = FilesErrorCode | "offline" | "failed" | "protocol" | "aborted";

export interface FilesFailure {
	message: string;
	code: FilesFailureCode;
}

// ---------------------------------------------------------------------------
// Paths (root-relative, `/`-separated, "" = the root)

export function joinPath(dir: string, name: string): string {
	return dir === "" ? name : `${dir}/${name}`;
}

export function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

/** Every directory above `path`, outermost first, starting with the root: `a/b/c` → `["", "a", "a/b"]`. */
export function ancestorsOf(path: string): string[] {
	if (path === "") return [];
	const segments = path.split("/");
	const out = [""];
	for (let i = 1; i < segments.length; i++) out.push(segments.slice(0, i).join("/"));
	return out;
}

export function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = -1;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Listing entries

/** What a click on the entry does: open the file, expand the directory, or nothing (null: the row is inert). */
export function openKind(entry: FileEntry): "file" | "dir" | null {
	if (entry.kind === "file" || entry.kind === "dir") return entry.kind;
	const resolves = entry.kind === "symlink" ? entry.link?.resolves : undefined;
	return resolves === "file" || resolves === "dir" ? resolves : null;
}

/** The tooltip of an inert row. */
export function inertReason(entry: FileEntry): string {
	if (entry.kind === "symlink") {
		const target = entry.link?.target ?? "";
		switch (entry.link?.resolves) {
			case "outside":
				return `Symbolic link to ${target}, which points outside the worktree`;
			case "broken":
				return `Symbolic link to ${target}, which does not exist`;
			default:
				return `Symbolic link to ${target}, which is not a regular file or directory`;
		}
	}
	return "Not a regular file or directory (socket, pipe or device)";
}

// ---------------------------------------------------------------------------
// Decoding daemon answers (an ack's `data` is `unknown`)

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const ENTRY_KINDS: Record<string, true> = { file: true, dir: true, symlink: true, other: true };
const LINK_KINDS: Record<string, true> = { file: true, dir: true, other: true, outside: true, broken: true };

function decodeEntry(raw: unknown): FileEntry | null {
	if (!isRec(raw) || typeof raw.name !== "string" || raw.name === "" || /[/\0]/.test(raw.name)) return null;
	if (typeof raw.kind !== "string" || !Object.hasOwn(ENTRY_KINDS, raw.kind)) return null;
	const entry: FileEntry = { name: raw.name, kind: raw.kind as FileEntry["kind"] };
	if (isNum(raw.size)) entry.size = raw.size;
	if (raw.ignored === true) entry.ignored = true;
	if (isRec(raw.link) && typeof raw.link.target === "string") {
		const resolves =
			typeof raw.link.resolves === "string" && Object.hasOwn(LINK_KINDS, raw.link.resolves)
				? raw.link.resolves
				: "other";
		entry.link = { target: raw.link.target, resolves: resolves as LinkTargetKind };
	}
	return entry;
}

export function decodeListing(data: unknown): FileListing | null {
	if (!isRec(data) || typeof data.path !== "string" || !Array.isArray(data.entries)) return null;
	const entries: FileEntry[] = [];
	for (const raw of data.entries) {
		const entry = decodeEntry(raw);
		if (entry) entries.push(entry);
	}
	return {
		path: data.path,
		entries,
		truncated: data.truncated === true,
		scanned: isNum(data.scanned) ? data.scanned : entries.length,
		ignoredHidden: isNum(data.ignoredHidden) ? data.ignoredHidden : 0,
		ignoreChecked: data.ignoreChecked !== false,
	};
}

export function decodeContent(data: unknown): FileContent | null {
	if (!isRec(data) || typeof data.path !== "string") return null;
	if (data.kind === "dir") return { kind: "dir", path: data.path };
	if (!isNum(data.size) || !isNum(data.mtimeMs)) return null;
	const meta = { path: data.path, size: data.size, mtimeMs: data.mtimeMs, ignored: data.ignored === true };
	switch (data.kind) {
		case "text": {
			if (typeof data.text !== "string" || !isNum(data.startLine) || !isNum(data.endLine)) return null;
			const spans = Array.isArray(data.spans) && data.spans.every(isNum) ? (data.spans as number[]) : null;
			return {
				...meta,
				kind: "text",
				text: data.text,
				startLine: data.startLine,
				endLine: data.endLine,
				nextLine: isNum(data.nextLine) ? data.nextLine : null,
				totalLines: isNum(data.totalLines) ? data.totalLines : null,
				lossy: data.lossy === true,
				crlf: data.crlf === true,
				bom: data.bom === true,
				cut: data.cut === true,
				lang: typeof data.lang === "string" ? data.lang : null,
				spans,
			};
		}
		case "image":
			return typeof data.mime === "string" ? { ...meta, kind: "image", mime: data.mime } : null;
		case "binary":
			return { ...meta, kind: "binary", reason: typeof data.reason === "string" ? data.reason : "binary file" };
		case "too_large":
			return isNum(data.limit) ? { ...meta, kind: "too_large", limit: data.limit } : null;
		default:
			return null;
	}
}

export function decodeBytes(data: unknown): FileBytes | null {
	if (!isRec(data) || typeof data.data !== "string") return null;
	if (!isNum(data.offset) || !isNum(data.length) || !isNum(data.size) || !isNum(data.mtimeMs)) return null;
	return {
		offset: data.offset,
		length: data.length,
		size: data.size,
		mtimeMs: data.mtimeMs,
		eof: data.eof === true,
		data: data.data,
	};
}

const STATUS_KINDS: Record<string, true> = { changed: true, renamed: true, untracked: true, unmerged: true };

const decodeCounts = (data: unknown): LineCounts | null =>
	isRec(data) && isNum(data.added) && isNum(data.removed) ? { added: data.added, removed: data.removed } : null;

export function decodeStatus(data: unknown): GitStatus | null {
	if (!isRec(data) || !Array.isArray(data.entries) || !isRec(data.branch)) return null;
	const entries: GitStatusEntry[] = [];
	for (const raw of data.entries) {
		if (!isRec(raw) || typeof raw.path !== "string" || raw.path === "") continue;
		if (typeof raw.kind !== "string" || !Object.hasOwn(STATUS_KINDS, raw.kind)) continue;
		if (typeof raw.x !== "string" || typeof raw.y !== "string") continue;
		const entry: GitStatusEntry = { path: raw.path, kind: raw.kind as GitStatusEntry["kind"], x: raw.x, y: raw.y };
		if (typeof raw.origPath === "string") entry.origPath = raw.origPath;
		if (raw.dir === true) entry.dir = true;
		const staged = decodeCounts(raw.staged);
		if (staged) entry.staged = staged;
		const unstaged = decodeCounts(raw.unstaged);
		if (unstaged) entry.unstaged = unstaged;
		entries.push(entry);
	}
	const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
	const num = (v: unknown): number | null => (isNum(v) ? v : null);
	const b = data.branch;
	const status: GitStatus = {
		branch: {
			head: str(b.head),
			oid: str(b.oid),
			upstream: str(b.upstream),
			ahead: num(b.ahead),
			behind: num(b.behind),
		},
		entries,
		truncated: data.truncated === true,
	};
	const lines = decodeCounts(data.lines);
	if (lines) status.lines = lines;
	return status;
}

export function decodeLocation(data: unknown): FileLocation | null {
	if (!isRec(data) || typeof data.root !== "string" || data.root === "" || typeof data.path !== "string") return null;
	return { root: data.root, path: data.path };
}

export function decodeDiff(data: unknown): FileDiff | null {
	if (!isRec(data) || typeof data.diff !== "string" || typeof data.path !== "string") return null;
	const mode = FILE_DIFF_MODES.find(m => m === data.mode);
	if (mode === undefined) return null;
	const diff: FileDiff = {
		mode,
		path: data.path,
		diff: data.diff,
		truncated: data.truncated === true,
		binary: data.binary === true,
		added: isNum(data.added) ? data.added : 0,
		removed: isNum(data.removed) ? data.removed : 0,
	};
	if (typeof data.origPath === "string") diff.origPath = data.origPath;
	if (typeof data.renamedFrom === "string") diff.renamedFrom = data.renamedFrom;
	return diff;
}

// ---------------------------------------------------------------------------
// Git status → decorations

export type ChangeLabel = "modified" | "staged-modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

/** One-letter marker shown beside a changed file. */
const LETTERS: Record<ChangeLabel, string> = {
	modified: "M",
	"staged-modified": "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	untracked: "U",
	conflicted: "!",
};

export const changeLetter = (label: ChangeLabel): string => LETTERS[label];

/** Porcelain marks an unchanged side with `.` (v2) or a blank. */
const changedSide = (c: string): boolean => c !== "." && c !== " " && c !== "";

export function labelOf(entry: GitStatusEntry): ChangeLabel {
	if (entry.kind === "unmerged") return "conflicted";
	if (entry.kind === "untracked") return "untracked";
	if (entry.kind === "renamed") return "renamed";
	if (entry.x === "A") return "added";
	if (entry.x === "D" || entry.y === "D") return "deleted";
	return changedSide(entry.y) ? "modified" : "staged-modified";
}

export interface StatusIndex {
	/** Entries by path (an untracked directory without its trailing slash). */
	entries: ReadonlyMap<string, GitStatusEntry>;
	/** Untracked directories: everything below one is untracked. */
	untrackedDirs: ReadonlySet<string>;
	/** How many entries sit anywhere below each directory. */
	dirCounts: ReadonlyMap<string, number>;
}

export const EMPTY_STATUS_INDEX: StatusIndex = { entries: new Map(), untrackedDirs: new Set(), dirCounts: new Map() };

export function indexStatus(status: GitStatus | null): StatusIndex {
	if (!status) return EMPTY_STATUS_INDEX;
	const entries = new Map<string, GitStatusEntry>();
	const untrackedDirs = new Set<string>();
	const dirCounts = new Map<string, number>();
	for (const entry of status.entries) {
		const path = entry.dir === true && entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
		if (path === "") continue;
		entries.set(path, { ...entry, path });
		if (entry.dir === true) untrackedDirs.add(path);
		for (const dir of ancestorsOf(path)) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
	}
	return { entries, untrackedDirs, dirCounts };
}

/** The synthesized entry of something inside an untracked directory. */
const untrackedBelow = (path: string): GitStatusEntry => ({ path, kind: "untracked", x: "?", y: "?" });

/** The status entry that applies to `path`: its own, or an untracked parent directory's. */
export function entryFor(index: StatusIndex, path: string): GitStatusEntry | undefined {
	const own = index.entries.get(path);
	if (own) return own;
	if (index.untrackedDirs.size === 0) return undefined;
	for (const dir of ancestorsOf(path)) if (index.untrackedDirs.has(dir)) return untrackedBelow(path);
	return undefined;
}

export interface Decoration {
	/** `data-status`: a file's change, or `changed` for a directory with changes below it. */
	status: ChangeLabel | "changed";
	/** `data-xy`: the raw two-letter code (`??` for untracked). Files only. */
	xy?: string;
	/** Number of changed entries below a directory. */
	count?: number;
	letter?: string;
}

export function decorationOf(index: StatusIndex, path: string, isDir: boolean): Decoration | null {
	const entry = entryFor(index, path);
	if (entry) {
		const label = labelOf(entry);
		return { status: label, xy: entry.kind === "untracked" ? "??" : `${entry.x}${entry.y}`, letter: LETTERS[label] };
	}
	const count = index.dirCounts.get(path);
	return isDir && count ? { status: "changed", count } : null;
}

export type ChangeGroup = "conflicted" | "staged" | "unstaged" | "untracked";
export const CHANGE_GROUPS: readonly ChangeGroup[] = ["conflicted", "staged", "unstaged", "untracked"];

export interface ChangeItem {
	group: ChangeGroup;
	path: string;
	origPath?: string;
	kind: GitStatusEntry["kind"];
	xy: string;
	label: ChangeLabel;
	/** The diff mode this row opens; null for an untracked directory (it opens in the tree). */
	mode: FileDiffMode | null;
	/** Lines of this row's side of the change, when the daemon counted them. */
	lines?: LineCounts;
}

/** Changes grouped as the Changes list shows them. A file changed in the index and the worktree is in two groups. */
export function groupChanges(status: GitStatus | null): Record<ChangeGroup, ChangeItem[]> {
	const groups: Record<ChangeGroup, ChangeItem[]> = { conflicted: [], staged: [], unstaged: [], untracked: [] };
	if (!status) return groups;
	for (const raw of status.entries) {
		const path = raw.dir === true && raw.path.endsWith("/") ? raw.path.slice(0, -1) : raw.path;
		const base = { path, origPath: raw.origPath, kind: raw.kind, label: labelOf(raw) };
		const xy = raw.kind === "untracked" ? "??" : `${raw.x}${raw.y}`;
		const side = (lines: LineCounts | undefined) => (lines ? { lines } : {});
		if (raw.kind === "unmerged") {
			groups.conflicted.push({ ...base, group: "conflicted", xy, mode: "unstaged", ...side(raw.unstaged) });
		} else if (raw.kind === "untracked") {
			const mode = raw.dir === true ? null : "untracked";
			groups.untracked.push({ ...base, group: "untracked", xy, mode, ...side(raw.unstaged) });
		} else {
			if (changedSide(raw.x))
				groups.staged.push({ ...base, group: "staged", xy, mode: "staged", ...side(raw.staged) });
			if (changedSide(raw.y)) {
				groups.unstaged.push({ ...base, group: "unstaged", xy, mode: "unstaged", ...side(raw.unstaged) });
			}
		}
	}
	return groups;
}

/** What the worktree's changes amount to: changed entries (an untracked directory is one) and lines, GitHub style. */
export interface ChangeStats {
	files: number;
	/** Null when the daemon did not count lines. */
	added: number | null;
	removed: number | null;
}

export function changeStats(status: GitStatus | null): ChangeStats {
	return {
		files: status?.entries.length ?? 0,
		added: status?.lines?.added ?? null,
		removed: status?.lines?.removed ?? null,
	};
}

/**
 * GitHub's five-square diffstat: one colored square per changed line up to five, split green (added) and red (removed)
 * in proportion, gray for the rest; none when nothing changed.
 */
export function diffBlocks(added: number, removed: number): ("added" | "removed" | "neutral")[] {
	const total = added + removed;
	if (total === 0) return [];
	const colored = Math.min(5, total);
	const green = Math.round((added / total) * colored);
	return [
		...Array<"added">(green).fill("added"),
		...Array<"removed">(colored - green).fill("removed"),
		...Array<"neutral">(5 - colored).fill("neutral"),
	];
}

/** The diff modes worth offering for a file, in tab order. */
export function diffModesFor(entry: GitStatusEntry | undefined): FileDiffMode[] {
	if (!entry) return [];
	if (entry.kind === "untracked") return ["untracked"];
	if (entry.kind === "unmerged") return ["unstaged", "head"];
	const modes: FileDiffMode[] = [];
	if (changedSide(entry.y)) modes.push("unstaged");
	if (changedSide(entry.x)) modes.push("staged");
	modes.push("head");
	return modes;
}

/** The diff a file's status points at first: untracked → untracked, staged only → staged, else unstaged. */
export function defaultDiffMode(entry: GitStatusEntry): FileDiffMode {
	if (entry.kind === "untracked") return "untracked";
	if (entry.kind === "changed" || entry.kind === "renamed") return changedSide(entry.y) ? "unstaged" : "staged";
	return "unstaged";
}

/** Changes whenever the file's git state does; the open file is reloaded when it does. */
export function signatureOf(index: StatusIndex, path: string): string {
	const entry = entryFor(index, path);
	return entry ? `${entry.kind}:${entry.x}${entry.y}:${entry.origPath ?? ""}` : "";
}

export function describeBranch(branch: GitStatus["branch"]): string {
	const head =
		branch.head === null || branch.head === "(detached)"
			? `detached ${branch.oid?.slice(0, 7) ?? ""}`.trim()
			: branch.head;
	const sync = [branch.ahead ? `↑${branch.ahead}` : "", branch.behind ? `↓${branch.behind}` : ""].filter(Boolean);
	return [head, ...sync].join(" ");
}

// ---------------------------------------------------------------------------
// Highlighted text

export interface Segment {
	kind: HighlightKind | null;
	text: string;
}

/** `[kind, length, …]` covering exactly `textLength` UTF-16 units, with known kinds. */
export function validSpans(spans: readonly number[] | null, textLength: number): spans is readonly number[] {
	if (spans === null || spans.length % 2 !== 0) return false;
	let total = 0;
	for (let i = 0; i < spans.length; i += 2) {
		const kind = spans[i]!;
		const length = spans[i + 1]!;
		if (!Number.isInteger(kind) || kind < 0 || kind > HIGHLIGHT_KINDS.length) return false;
		if (!Number.isInteger(length) || length < 0) return false;
		total += length;
	}
	return total === textLength;
}

/**
 * Splits `text` into lines of highlighted segments. Spans may run over line breaks and are cut at them; spans that do
 * not describe `text` are ignored (the text is shown plain). A final line break does not start another line; with
 * `crlf` a trailing carriage return is dropped from each line.
 */
export function highlightLines(text: string, spans: readonly number[] | null, crlf: boolean): Segment[][] {
	const pieces: { kind: HighlightKind | null; from: number; to: number }[] = [];
	if (validSpans(spans, text.length)) {
		let at = 0;
		for (let i = 0; i < spans.length; i += 2) {
			const length = spans[i + 1]!;
			if (length > 0) pieces.push({ kind: HIGHLIGHT_KINDS[spans[i]! - 1] ?? null, from: at, to: at + length });
			at += length;
		}
	} else {
		pieces.push({ kind: null, from: 0, to: text.length });
	}

	const lines: Segment[][] = [];
	let current: Segment[] = [];
	const add = (kind: HighlightKind | null, part: string): void => {
		if (part === "") return;
		const last = current.at(-1);
		if (last && last.kind === kind) last.text += part;
		else current.push({ kind, text: part });
	};
	const endLine = (): void => {
		const last = current.at(-1);
		if (crlf && last?.text.endsWith("\r")) {
			last.text = last.text.slice(0, -1);
			if (last.text === "") current.pop();
		}
		lines.push(current);
		current = [];
	};
	for (const { kind, from, to } of pieces) {
		let at = from;
		while (at < to) {
			const nl = text.indexOf("\n", at);
			if (nl < 0 || nl >= to) {
				add(kind, text.slice(at, to));
				break;
			}
			add(kind, text.slice(at, nl));
			endLine();
			at = nl + 1;
		}
	}
	if (text !== "" && !text.endsWith("\n")) endLine();
	return lines;
}

// ---------------------------------------------------------------------------
// Pages and images

export const PAGE_LINES = 1000;
/** Lines of context a deep link or "go to line" shows before the target. */
export const LINE_CONTEXT = 40;

export function pageStartFor(line: number): number {
	return Math.max(1, line - LINE_CONTEXT);
}

type TextContent = Extract<FileContent, { kind: "text" }>;

/** "lines 1–1000 of 5000", "lines 1001–1200 (end of file)", "lines 1–1000 of at least 1000". */
export function pageInfo(content: TextContent): string {
	if (content.endLine < content.startLine) return content.startLine <= 1 ? "empty file" : "past the end of the file";
	const range = `lines ${content.startLine}–${content.endLine}`;
	if (content.totalLines !== null) return `${range} of ${content.totalLines}`;
	return content.nextLine === null ? `${range} (end of file)` : `${range} of at least ${content.endLine}`;
}

export interface Chunk {
	offset: number;
	length: number;
}

/** The byte ranges that cover `size` bytes in requests of at most `chunk` bytes. */
export function planChunks(size: number, chunk: number = FILE_CHUNK_BYTES): Chunk[] {
	const chunks: Chunk[] = [];
	for (let offset = 0; offset < size; offset += chunk) chunks.push({ offset, length: Math.min(chunk, size - offset) });
	return chunks;
}

/** Image types the viewer previews inline (the daemon only offers raster formats). */
export const PREVIEW_MIMES: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
	"image/bmp": true,
	"image/avif": true,
	"image/x-icon": true,
	"image/vnd.microsoft.icon": true,
};

export function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// ---------------------------------------------------------------------------
// Diff text

/** The hunks of a unified diff: everything from the first `@@` line (git's own header lines are dropped). */
export function diffBody(diff: string): string {
	const at = diff.startsWith("@@") ? 0 : diff.indexOf("\n@@");
	return at < 0 ? "" : diff.slice(at === 0 ? 0 : at + 1);
}

// ---------------------------------------------------------------------------
// Preferences

export const SHOW_IGNORED_KEY = "omp-web.files.showIgnored";

export function loadShowIgnored(storage: Pick<Storage, "getItem"> | null): boolean {
	try {
		return storage?.getItem(SHOW_IGNORED_KEY) === "true";
	} catch {
		return false; // storage can throw (private mode, disabled cookies)
	}
}

export function saveShowIgnored(storage: Pick<Storage, "setItem"> | null, value: boolean): void {
	try {
		storage?.setItem(SHOW_IGNORED_KEY, String(value));
	} catch {
		// not persisted; the choice still holds for this page
	}
}
