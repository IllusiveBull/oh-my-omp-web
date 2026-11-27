import {
	findSessionContinuation,
	isEmptySession,
	listAllSessions,
	listSessionsReadOnly,
	type SessionInfo as DiskSession,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionBackend } from "@omp-web/protocol";

/**
 * One conversation on disk. omp keeps a conversation in several files when a process that could not keep writing its
 * own file (another live process owned it) continued in a sibling whose header names the old session in
 * `continuationOf`; those files fold into one conversation represented by the newest copy. A fork only sets
 * `parentSession`: it is a deliberate new conversation and stays separate.
 */
export interface Conversation {
	/** Session id of the newest copy (the file `--resume` opens). */
	id: string;
	/** Agent backend that owns this conversation; absent means `"omp"`. */
	backend?: SessionBackend;
	/** The newest copy's file. */
	path: string;
	/** Ids of every file folded into this conversation, newest copy included. */
	memberIds: string[];
	/** The file of each id in `memberIds`, same order (the newest copy's is `path`). */
	memberPaths: string[];
	files: number;
	cwd: string;
	title?: string;
	/** First user message. */
	preview?: string;
	createdAt: number;
	modifiedAt: number;
	messageCount: number;
	/**
	 * Lowercased text a search looks in: ids, title, directory, files, and the user and assistant messages omp's session
	 * listing reads from the start of each file (never put on the wire).
	 */
	searchText: string;
}

/** Union-find over file paths, linking each file to the files holding the session its header continues. */
function components(sessions: readonly DiskSession[]): DiskSession[][] {
	const parent = new Map<string, string>(sessions.map(s => [s.path, s.path]));
	const find = (path: string): string => {
		let root = path;
		while (parent.get(root) !== root) root = parent.get(root)!;
		parent.set(path, root);
		return root;
	};
	const byId = new Map<string, DiskSession[]>();
	for (const session of sessions) byId.set(session.id, [...(byId.get(session.id) ?? []), session]);
	for (const session of sessions) {
		if (!session.continuationOf) continue;
		for (const previous of byId.get(session.continuationOf) ?? [])
			parent.set(find(previous.path), find(session.path));
	}
	const groups = new Map<string, DiskSession[]>();
	for (const session of sessions) {
		const root = find(session.path);
		groups.set(root, [...(groups.get(root) ?? []), session]);
	}
	return [...groups.values()];
}

/** The copy of a multi-file conversation to open: upstream's own resume rule (newest turn wins), from the first copy. */
async function newestCopy(members: readonly DiskSession[]): Promise<DiskSession> {
	const ids = new Set(members.map(m => m.id));
	const roots = members.filter(m => !m.continuationOf || !ids.has(m.continuationOf));
	const first = (roots.length > 0 ? roots : [...members]).toSorted(
		(a, b) => a.created.getTime() - b.created.getTime(),
	)[0]!;
	const continuation = await findSessionContinuation(first.path).catch(() => undefined);
	return members.find(m => m.path === continuation?.session.path) ?? continuation?.session ?? first;
}

/** How much of a file's end is read to find its last entries; a `session_exit` record is a few hundred bytes. */
const TAIL_BYTES = 16 * 1024;
/** Last activity per file, by path, valid while the file's mtime and size are unchanged. */
const activityCache = new Map<string, { mtime: number; size: number; at: number }>();

/**
 * When the file last changed in a way a reader cares about: its mtime, unless the file ends in the `session_exit`
 * records omp appends when a process lets go of the session (closing it here, quitting the TUI, a daemon restart). That
 * is not news, so the time of the last entry before them counts instead; otherwise every close would mark the
 * conversation unread.
 */
async function lastActivity(session: DiskSession): Promise<number> {
	const mtime = session.modified.getTime();
	const file = Bun.file(session.path);
	const size = file.size;
	const cached = activityCache.get(session.path);
	if (cached && cached.mtime === mtime && cached.size === size) return cached.at;
	let at = mtime;
	try {
		const tail = await file.slice(Math.max(0, size - TAIL_BYTES), size).text();
		// The first line may be cut by the slice; it is only used when it parses.
		const lines = tail.split("\n").filter(line => line.trim() !== "");
		let i = lines.length - 1;
		while (i >= 0 && isSessionExit(lines[i]!)) i--;
		if (i < lines.length - 1 && i >= 0) {
			const stamp = entryTime(lines[i]!);
			if (stamp !== undefined && stamp < mtime) at = stamp;
		}
	} catch {
		// Unreadable now: the mtime stands, and the next scan tries again.
		return mtime;
	}
	activityCache.set(session.path, { mtime, size, at });
	return at;
}

function parseEntry(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function isSessionExit(line: string): boolean {
	const entry = parseEntry(line);
	return entry?.type === "custom" && entry.customType === "session_exit";
}

function entryTime(line: string): number | undefined {
	const stamp = parseEntry(line)?.timestamp;
	const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
	return Number.isFinite(at) ? at : undefined;
}

/** Folds scanned session files into conversations, newest activity first. Sessions with no content are dropped, like omp's picker does. */
export async function foldConversations(sessions: readonly DiskSession[]): Promise<Conversation[]> {
	const out: Conversation[] = [];
	const seen = new Set(sessions.map(s => s.path));
	for (const path of activityCache.keys()) if (!seen.has(path)) activityCache.delete(path);
	for (const members of components(sessions)) {
		if (members.every(isEmptySession)) continue;
		const head = members.length === 1 ? members[0]! : await newestCopy(members);
		const first = members.find(m => m.firstMessage !== "(no messages)");
		const title = head.title ?? members.find(m => m.title)?.title;
		const others = members.filter(m => m !== head);
		// Continuation files repeat the start of their predecessors: each distinct text once.
		const messages = new Set(members.map(m => m.allMessagesText));
		out.push({
			id: head.id,
			path: head.path,
			memberIds: [head.id, ...members.filter(m => m !== head).map(m => m.id)],
			memberPaths: [head.path, ...members.filter(m => m !== head).map(m => m.path)],
			files: members.length,
			cwd: head.cwd,
			title,
			preview: first?.firstMessage,
			createdAt: Math.min(...members.map(m => m.created.getTime()).filter(Number.isFinite), Date.now()),
			modifiedAt: Math.max(...(await Promise.all(members.map(lastActivity)))),
			messageCount: head.messageCount,
			searchText: [
				head.id,
				...others.map(m => m.id),
				title,
				head.cwd,
				first?.firstMessage,
				...messages,
				head.path,
				...others.map(m => m.path),
			]
				.filter(Boolean)
				.join(" ")
				.toLowerCase(),
		});
	}
	return out.toSorted((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Every conversation on this machine's omp session store, with TUI-created ones included. `sessionDir` is the flat
 * directory of omp's `--session-dir`; without it, omp's default per-project buckets are scanned. Read-only: nothing is
 * repaired or written.
 */
export async function scanConversations(sessionDir?: string): Promise<Conversation[]> {
	const sessions = sessionDir
		? await listSessionsReadOnly(sessionDir, new FileSessionStorage())
		: await listAllSessions();
	return foldConversations(sessions);
}
