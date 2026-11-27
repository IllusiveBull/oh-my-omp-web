/**
 * Turns the path a tool card shows (home-shortened, relative, or absolute, POSIX or Windows, maybe with a `:line`
 * suffix) into a file of a registered worktree, so a click can open it in the Files view. Pure text work: nothing
 * here touches the file system, so the answer is only "this path lies inside that root".
 */
import { shortenPath } from "@oh-my-pi/collab-web/src/tool-render/util";
import { LOCATABLE_URL_SCHEMES, type MachineSummary } from "@omp-web/protocol";

export interface ToolPathContext {
	/** Every registered project root and worktree path of the session's machine. */
	roots: readonly string[];
	/** The session's working directory: relative paths are relative to it. */
	cwd: string;
	/** The worktree the session works in: wins when a `~` path fits several roots. */
	preferredRoot?: string;
}

export interface ResolvedToolPath {
	/** The registered root exactly as listed in the context. */
	root: string;
	/** Root-relative, `/`-separated. */
	path: string;
	line?: number;
}

/** The roots a machine's Files views accept: project roots and the worktrees of every project. */
export function rootsOfMachine(machine: MachineSummary | undefined): string[] {
	const roots = new Set<string>();
	for (const project of machine?.projects ?? []) {
		roots.add(project.root);
		for (const worktree of project.worktrees) roots.add(worktree.path);
	}
	return [...roots];
}

/** An absolute path taken apart: what it is rooted at (`/`, `C:`, `//server/share`) and its segments. */
interface Absolute {
	prefix: string;
	segs: string[];
	/** Windows paths compare without regard to case. */
	fold: boolean;
}

/** Top-level directories that macOS makes links into `/private`. */
const MAC_LINKS = new Set(["var", "tmp", "etc"]);
const DRIVE = /^([A-Za-z]):(?:[\\/]|$)/;
const UNC = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]|$)/;

const isWindowsPath = (text: string): boolean => DRIVE.test(text) || UNC.test(text);
const isAbsolutePath = (text: string): boolean => text.startsWith("/") || isWindowsPath(text);

/**
 * Applies `parts` (a path's segments) to `base`: `.` and empty parts vanish, `..` removes the last segment. Null when a
 * `..` would climb above the root.
 */
function applySegments(base: readonly string[], parts: readonly string[]): string[] | null {
	const out = [...base];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.pop() === undefined) return null;
		} else out.push(part);
	}
	return out;
}

function parseAbsolute(text: string): Absolute | null {
	const drive = DRIVE.exec(text);
	if (drive) {
		const segs = applySegments([], text.slice(2).split(/[\\/]+/));
		return segs && { prefix: `${drive[1]!.toUpperCase()}:`, segs, fold: true };
	}
	const unc = UNC.exec(text);
	if (unc) {
		const segs = applySegments([], text.slice(unc[0].length).split(/[\\/]+/));
		return segs && { prefix: `//${unc[1]}/${unc[2]}`.toLowerCase(), segs, fold: true };
	}
	if (!text.startsWith("/")) return null;
	const segs = applySegments([], text.split("/"));
	return segs && { prefix: "/", segs, fold: false };
}

/** `path:12`, `path:12-20`, `path:12:5` → the path and its first line. */
function splitLineSuffix(text: string): { path: string; line?: number } {
	const match = /^(.+?):(\d+)(?:-\d+|:\d+)?$/s.exec(text);
	if (!match) return { path: text };
	const line = Number(match[2]);
	return line > 0 && Number.isSafeInteger(line) ? { path: match[1]!, line } : { path: match[1]! };
}

const same = (a: string, b: string, fold: boolean): boolean => (fold ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Whether `inner` is `outer` or lies below it (segment-wise: `/a/repo-x` is not inside `/a/repo`). */
function isInside(outer: Absolute, inner: Absolute): boolean {
	if (outer.fold !== inner.fold || !same(outer.prefix, inner.prefix, outer.fold)) return false;
	if (outer.segs.length > inner.segs.length) return false;
	return outer.segs.every((seg, i) => same(seg, inner.segs[i]!, outer.fold));
}

interface ParsedRoot {
	root: string;
	abs: Absolute;
	preferred: boolean;
}

/** `local://x.md`, `plan://…`, `proc://bg_1`, `https://…`: a URL, never a file. Two-letter minimum keeps `C://` a drive. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//;

/**
 * The file `text` names, as a path inside one of the registered roots; null when it names something outside all of
 * them (or cannot be understood, or is a URL such as omp's `local://` / `plan://` / `proc://`), so the caller leaves it
 * alone. Where several roots contain it the innermost wins (a linked worktree inside the main checkout), the session's
 * own worktree breaking ties.
 */
export function resolveToolPath(text: string, ctx: ToolPathContext): ResolvedToolPath | null {
	const { path: raw, line } = splitLineSuffix(text.trim());
	if (raw === "" || URL_SCHEME.test(raw)) return null;

	const roots: ParsedRoot[] = [];
	for (const root of ctx.roots) {
		const abs = parseAbsolute(root);
		if (abs) roots.push({ root, abs, preferred: root === ctx.preferredRoot });
	}
	roots.sort((a, b) => Number(b.preferred) - Number(a.preferred));

	let hit: { root: ParsedRoot; segs: string[] } | null = null;
	if (raw === "~" || raw.startsWith("~/")) {
		// `~` is what the tool cards print for the home directory; a root matches when its own shortened form is a
		// prefix of the text. (Copied behaviour of upstream's `shortenPath`, which is what produced the text.)
		for (const candidate of roots) {
			const short = shortenPath(candidate.root.replace(/\/+$/, ""));
			if (!short.startsWith("~") || !(raw === short || raw.startsWith(`${short}/`))) continue;
			const segs = applySegments(candidate.abs.segs, raw.slice(short.length).split("/"));
			if (segs && isInside(candidate.abs, { ...candidate.abs, segs })) {
				if (!hit || candidate.abs.segs.length > hit.root.abs.segs.length) hit = { root: candidate, segs };
				if (candidate.preferred) break;
			}
		}
	} else {
		let abs: Absolute | null = null;
		if (isAbsolutePath(raw)) abs = parseAbsolute(raw);
		else {
			const base = parseAbsolute(ctx.cwd);
			if (base) {
				const segs = applySegments(base.segs, raw.split(isWindowsPath(ctx.cwd) ? /[\\/]+/ : "/"));
				abs = segs && { ...base, segs };
			}
		}
		if (!abs) return null;
		const find = (target: Absolute): void => {
			for (const candidate of roots) {
				if (!isInside(candidate.abs, target)) continue;
				if (!hit || candidate.abs.segs.length > hit.root.abs.segs.length)
					hit = { root: candidate, segs: target.segs };
			}
		};
		find(abs);
		// Roots are canonical (the daemon resolves symlinks); tools often print the path as the process was started with.
		// On macOS `/var`, `/tmp` and `/etc` are links into `/private`: tried only when the text itself fits no root.
		if (!hit && abs.prefix === "/" && MAC_LINKS.has(abs.segs[0] ?? ""))
			find({ ...abs, segs: ["private", ...abs.segs] });
	}
	if (!hit) return null;

	const resolved: ResolvedToolPath = { root: hit.root.root, path: hit.segs.slice(hit.root.abs.segs.length).join("/") };
	if (line !== undefined) resolved.line = line;
	return resolved;
}

// ---------------------------------------------------------------------------
// Path-like tokens of plain text output

const WHITESPACE = /\s/;

/** The whitespace-delimited word at `offset` (a caret position: it may sit just after the word); null between words. */
export function tokenAt(text: string, offset: number): string | null {
	let at = offset;
	if (at >= text.length || WHITESPACE.test(text[at]!)) at--;
	if (at < 0 || at >= text.length || WHITESPACE.test(text[at]!)) return null;
	let start = at;
	let end = at + 1;
	while (start > 0 && !WHITESPACE.test(text[start - 1]!)) start--;
	while (end < text.length && !WHITESPACE.test(text[end]!)) end++;
	return text.slice(start, end);
}

const EDGE_PUNCTUATION = /^[()[\]<>"',;]+|[()[\]<>"',;:]+$/g;

/**
 * A token of command or search output that may name a file: `src/a.ts`, `/abs/b.ts:12`, `a.ts:12:5`,
 * `src/a.ts:12:matching text` (grep). A bare word needs an extension and a line number to count; anything with a
 * separator or an absolute path counts as it is. URLs, options and glob or shell syntax never do.
 */
export function pathCandidate(token: string): { text: string; line?: number } | null {
	const stripped = token.replace(EDGE_PUNCTUATION, "");
	if (stripped === "" || stripped.includes("://") || /[*?|$={}`]/.test(stripped) || stripped.startsWith("-"))
		return null;
	const match = /^(.+?):(\d+)(?::\d+)?(?::.*)?$/s.exec(stripped);
	const path = match ? match[1]! : stripped;
	const line = match ? Number(match[2]) : undefined;
	const hasExtension = /\.[A-Za-z0-9]{1,10}$/.test(path.split(/[\\/]/).at(-1) ?? "");
	const looksLikePath = isAbsolutePath(path) || path.startsWith("~/") || /[\\/]/.test(path);
	if (!looksLikePath && !(hasExtension && line !== undefined)) return null;
	return line !== undefined && line > 0 ? { text: path, line } : { text: path };
}

/** `local://x.md`, `agent://Id`, `artifact://3:12-40`, then an optional read selector (`:12`, `:12-40`, `:raw`, …). */
const OMP_URL = /^([A-Za-z][A-Za-z0-9+.-]+):\/\/([^\s:]*)(?::(\S*))?$/;

/**
 * One of omp's own URLs whose file the daemon can locate (see `LOCATABLE_URL_SCHEMES`), with the first line its read
 * selector names; null for anything else, `proc://` and web URLs included.
 */
export function ompUrlCandidate(token: string): { url: string; line?: number } | null {
	const match = OMP_URL.exec(token.replace(EDGE_PUNCTUATION, ""));
	if (!match || !LOCATABLE_URL_SCHEMES.includes(match[1]!.toLowerCase())) return null;
	const url = `${match[1]}://${match[2]}`;
	const line = Number(/^(\d+)/.exec(match[3] ?? "")?.[1]);
	return line > 0 ? { url, line } : { url };
}

// ---------------------------------------------------------------------------
// Where an edit landed

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function noteEdit(into: Map<string, number>, details: Record<string, unknown>, ctx: ToolPathContext): void {
	const { path, firstChangedLine } = details;
	if (typeof path !== "string" || typeof firstChangedLine !== "number" || !Number.isSafeInteger(firstChangedLine))
		return;
	if (firstChangedLine < 1) return;
	const hit = resolveToolPath(path, ctx);
	if (hit) into.set(editKey(hit.root, hit.path), firstChangedLine);
}

/** Key of {@link editedLines}. */
export const editKey = (root: string, path: string): string => `${root}\0${path}`;

/**
 * The first changed line of the newest successful edit of each file in `entries` (a session's committed entries), by
 * {@link editKey}. An edit card's header names the file but not the line (upstream prints the line only inside the opened
 * card), so this is where a click on that header finds out where the edit landed. A card that is not the file's newest
 * edit therefore opens at the newest edit's line: a heuristic, stated where it is used.
 */
export function editedLines(entries: readonly unknown[], ctx: ToolPathContext): Map<string, number> {
	const lines = new Map<string, number>();
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const { role, isError, details } = entry.message;
		if (role !== "toolResult" || isError === true || !isRecord(details)) continue;
		noteEdit(lines, details, ctx);
		if (Array.isArray(details.perFileResults)) {
			for (const file of details.perFileResults)
				if (isRecord(file) && file.isError !== true) noteEdit(lines, file, ctx);
		}
	}
	return lines;
}
