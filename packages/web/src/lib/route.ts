import { FILE_DIFF_MODES, type FileDiffMode } from "@omp-web/protocol";

/** A session is addressed by its machine and its id on that machine; ids are only unique per machine. */
export interface SessionRef {
	machine: string;
	id: string;
}

const SESSION_HASH = /^#\/m\/([^/]+)\/s\/([^/]+)$/;

export function parseSessionHash(hash: string): SessionRef | null {
	const match = SESSION_HASH.exec(hash);
	if (!match) return null;
	try {
		return { machine: decodeURIComponent(match[1]!), id: decodeURIComponent(match[2]!) };
	} catch {
		return null; // malformed percent-encoding in a hand-edited URL
	}
}

export function sessionHash(ref: SessionRef): string {
	return `#/m/${encodeURIComponent(ref.machine)}/s/${encodeURIComponent(ref.id)}`;
}

/** The Accounts page (broker, sign-in, accounts, usage) is a route of its own. */
export const ACCOUNTS_HASH = "#/accounts";

export function isAccountsHash(hash: string): boolean {
	return hash === ACCOUNTS_HASH;
}

/**
 * The Files view: one worktree `root` of a machine (a single encoded segment) and a root-relative `path` ("" = the
 * root itself, one encoded segment per path segment). `line` opens a text file around that line, `diff` opens a diff
 * mode of the file instead of its source.
 */
export interface FilesRef {
	machine: string;
	root: string;
	path: string;
	line?: number;
	diff?: FileDiffMode;
}

const FILES_HASH = /^#\/m\/([^/?]+)\/f\/([^/?]+)((?:\/[^/?]*)*)(?:\?(.*))?$/;

/** The Files route for `ref`, e.g. `#/m/home/f/%2Fsrc%2Frepo/src/app.ts?line=12`. */
export function filesHash(ref: FilesRef): string {
	const segments = ref.path === "" ? [] : ref.path.split("/");
	let hash = `#/m/${encodeURIComponent(ref.machine)}/f/${encodeURIComponent(ref.root)}`;
	for (const seg of segments) hash += `/${encodeURIComponent(seg)}`;
	const query: string[] = [];
	if (ref.line !== undefined && Number.isInteger(ref.line) && ref.line > 0) query.push(`line=${ref.line}`);
	if (ref.diff !== undefined) query.push(`diff=${ref.diff}`);
	return query.length > 0 ? `${hash}?${query.join("&")}` : hash;
}

/** The reference a Files hash points at; null for anything else (a session, accounts, malformed encoding, bad path). */
export function parseFilesHash(hash: string): FilesRef | null {
	const match = FILES_HASH.exec(hash);
	if (!match) return null;
	try {
		const machine = decodeURIComponent(match[1]!);
		const root = decodeURIComponent(match[2]!);
		if (machine === "" || root === "") return null;
		// A trailing slash is tolerated; any other empty segment is not a path.
		const raw = match[3]!.split("/").slice(1);
		if (raw.at(-1) === "") raw.pop();
		const segments = raw.map(decodeURIComponent);
		// `.` and `..` are kept: nothing in the app builds them, so a URL that has one is hand-made, and the daemon's refusal
		// (with its message) is what the page shows for it. Empty segments and ones carrying a separator or NUL are not paths.
		if (segments.some(seg => seg === "" || /[/\0]/.test(seg))) return null;
		const ref: FilesRef = { machine, root, path: segments.join("/") };
		const params = new URLSearchParams(match[4] ?? "");
		const line = params.get("line");
		if (line !== null && /^[1-9]\d{0,8}$/.test(line)) ref.line = Number(line);
		const diff = params.get("diff");
		const mode = FILE_DIFF_MODES.find(m => m === diff);
		if (mode !== undefined) ref.diff = mode;
		return ref;
	} catch {
		return null; // malformed percent-encoding in a hand-edited URL
	}
}

export function isFilesHash(hash: string): boolean {
	return parseFilesHash(hash) !== null;
}

/** A terminal is addressed by its machine and its id on that machine, like a session. */
export interface TerminalRef {
	machine: string;
	id: string;
}

const TERMINAL_HASH = /^#\/m\/([^/]+)\/t\/([^/]+)$/;

export function parseTerminalHash(hash: string): TerminalRef | null {
	const match = TERMINAL_HASH.exec(hash);
	if (!match) return null;
	try {
		return { machine: decodeURIComponent(match[1]!), id: decodeURIComponent(match[2]!) };
	} catch {
		return null; // malformed percent-encoding in a hand-edited URL
	}
}

export function terminalHash(ref: TerminalRef): string {
	return `#/m/${encodeURIComponent(ref.machine)}/t/${encodeURIComponent(ref.id)}`;
}

/**
 * The tabs of the right-hand dock: the session's sub-agents and `/btw` side questions, a machine's terminals, a
 * worktree's changes or files.
 */
export const DOCK_TABS = ["agents", "btw", "terminal", "changes", "files"] as const;
export type DockTab = (typeof DOCK_TABS)[number];

/** What the dock shows. A null `ref` lets the app pick: the terminal list, or the worktree in context at its root. */
export type DockRoute =
	| { tab: "agents" | "btw" }
	| { tab: "terminal"; ref: TerminalRef | null }
	| { tab: "changes" | "files"; ref: FilesRef | null };

/** The main view: a session, the Accounts page, or nothing chosen. */
export type MainRoute = { kind: "session"; ref: SessionRef } | { kind: "accounts" } | null;

/** The whole location: the main view and, beside it, the dock (null: closed). */
export interface AppRoute {
	main: MainRoute;
	dock: DockRoute | null;
}

/**
 * The dock rides after the main view's hash, behind a `|` (which `encodeURIComponent` always escapes, so no id or path
 * of either part can contain one): `#/m/a/s/42|files/m/a/f/%2Frepo/src/x.ts?line=3`, `#/accounts|terminal`, `#|agents`.
 * The dock part is its tab name followed by that tab's own hash body (`/m/…/t/…`, `/m/…/f/…`), if any.
 */
const DOCK_PART = /^(agents|btw|terminal|changes|files)(\/.*)?$/;

function parseDock(part: string): DockRoute | null {
	const match = DOCK_PART.exec(part);
	if (!match) return null;
	const tab = match[1] as DockTab;
	const rest = match[2];
	if (tab === "agents" || tab === "btw") return rest === undefined ? { tab } : null;
	if (rest === undefined) return { tab, ref: null };
	if (tab === "terminal") {
		const ref = parseTerminalHash(`#${rest}`);
		return ref ? { tab, ref } : null;
	}
	const ref = parseFilesHash(`#${rest}`);
	return ref ? { tab, ref } : null;
}

/**
 * The route of a hash. A bare Files or terminal hash (an older link, or a tool link opened with nothing else on screen)
 * opens that view in the dock beside an empty main view.
 */
export function parseRoute(hash: string): AppRoute {
	const bar = hash.indexOf("|");
	const mainPart = bar < 0 ? hash : hash.slice(0, bar);
	const dock = bar < 0 ? null : parseDock(hash.slice(bar + 1));
	const session = parseSessionHash(mainPart);
	if (session) return { main: { kind: "session", ref: session }, dock };
	if (isAccountsHash(mainPart)) return { main: { kind: "accounts" }, dock };
	if (bar < 0) {
		const files = parseFilesHash(mainPart);
		if (files) return { main: null, dock: { tab: "files", ref: files } };
		const terminal = parseTerminalHash(mainPart);
		if (terminal) return { main: null, dock: { tab: "terminal", ref: terminal } };
	}
	return { main: null, dock };
}

function dockHash(dock: DockRoute): string {
	if (!("ref" in dock) || dock.ref === null) return dock.tab;
	return dock.tab + (dock.tab === "terminal" ? terminalHash(dock.ref) : filesHash(dock.ref)).slice(1);
}

export function routeHash(route: AppRoute): string {
	const main =
		route.main === null ? "#" : route.main.kind === "accounts" ? ACCOUNTS_HASH : sessionHash(route.main.ref);
	if (route.dock === null) return main === "#" ? "" : main;
	return `${main}|${dockHash(route.dock)}`;
}
