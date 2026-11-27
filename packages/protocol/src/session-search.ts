import { FuzzyText } from "@oh-my-pi/pi-tui/fuzzy";

/**
 * Session search ranking shared by the daemon (which holds each session's transcript text and omp's prompt history)
 * and the browser (which ranks the cached list when the daemon cannot answer). It is omp's own resume-picker ranking
 * (`vendor/oh-my-pi/packages/tui/src/overlays/session-selector.ts`):
 *
 * - every whitespace-separated query token must match (AND);
 * - exact title matches lead partial title matches;
 * - other literal matches (every token a verbatim substring) follow, newest first;
 * - pure fuzzy matches come last, best score first, and a token that only scrapes by is dropped as noise.
 */

/** The fields of a session the ranking reads. */
export interface SessionSearchEntry {
	id: string;
	title?: string;
	/** Last activity, epoch ms: ties between literal matches go to the newer session. */
	modifiedAt: number;
	/** Every other id that names this session (see `SessionInfo.aliases`); prompt-history ids may name any of them. */
	aliases?: readonly string[];
}

/** Lowercased searchable text of a session. Called at most once per session per ranking pass. */
export type SessionTextOf<T> = (session: T) => string;

/** Queries shorter than this (trimmed) do not consult the prompt history: a single character matches nearly every prompt. */
export const HISTORY_MERGE_MIN_QUERY = 2;
/** Delay before a typed query is sent to the daemon, so a burst of keystrokes costs one search. */
export const HISTORY_MERGE_DEBOUNCE_MS = 150;

const MIN_PURE_FUZZY_TOKEN_SCORE = -20;

/** Sessions fuzzy-scored between two yields to the event loop by {@link rankSessionSearchMatchesAsync}. */
const FUZZY_SCAN_CHUNK_COUNT = 150;

export function tokenizeSessionQuery(query: string): string[] {
	const trimmed = query.trim().toLowerCase();
	return trimmed ? trimmed.split(/\s+/) : [];
}

interface Ranked<T> {
	session: T;
	score: number;
	index: number;
}

/** True when every token appears verbatim: literal matches rank by recency alone and skip fuzzy scoring. */
function isLiteralMatch(textLower: string, tokens: readonly string[]): boolean {
	for (const token of tokens) if (!textLower.includes(token)) return false;
	return true;
}

/** Undefined when a token fails to match, or when even the best-scoring token is pure-fuzzy noise. */
function scoreFuzzy<T>(session: T, index: number, tokens: readonly string[], textLower: string): Ranked<T> | undefined {
	const fuzzy = new FuzzyText(textLower);
	let score = 0;
	let worst = Number.NEGATIVE_INFINITY;
	for (const token of tokens) {
		const match = fuzzy.match(token);
		if (!match.matches) return undefined;
		score += match.score;
		worst = Math.max(worst, match.score);
	}
	return worst >= MIN_PURE_FUZZY_TOKEN_SCORE ? undefined : { session, score, index };
}

/** Exact titles lead partial titles; everything else keeps its order. */
function titleFirst<T extends SessionSearchEntry>(ordered: T[], tokens: readonly string[], literal: Ranked<T>[]): T[] {
	const query = tokens.join(" ");
	const exact: T[] = [];
	const partial: T[] = [];
	const titled = new Set<T>();
	for (const { session } of literal) {
		const title = session.title?.trim().toLowerCase().replace(/\s+/g, " ");
		if (title === query) exact.push(session);
		else if (title && isLiteralMatch(title, tokens)) partial.push(session);
		else continue;
		titled.add(session);
	}
	if (titled.size === 0) return ordered;
	return [...exact, ...partial, ...ordered.filter(session => !titled.has(session))];
}

function finish<T extends SessionSearchEntry>(
	tokens: readonly string[],
	literal: Ranked<T>[],
	fuzzy: Ranked<T>[],
): T[] {
	literal.sort((a, b) => b.session.modifiedAt - a.session.modifiedAt || a.index - b.index);
	fuzzy.sort((a, b) => a.score - b.score || b.session.modifiedAt - a.session.modifiedAt || a.index - b.index);
	const ordered = [...literal.map(m => m.session), ...fuzzy.map(m => m.session)];
	return titleFirst(ordered, tokens, literal);
}

/** The sessions matching `query`, best first; all of them, unchanged, for an empty query. */
export function rankSessionSearchMatches<T extends SessionSearchEntry>(
	sessions: readonly T[],
	query: string,
	textOf: SessionTextOf<T>,
): T[] {
	const tokens = tokenizeSessionQuery(query);
	if (tokens.length === 0) return [...sessions];
	const literal: Ranked<T>[] = [];
	const fuzzy: Ranked<T>[] = [];
	sessions.forEach((session, index) => {
		const text = textOf(session);
		if (isLiteralMatch(text, tokens)) literal.push({ session, score: 0, index });
		else {
			const match = scoreFuzzy(session, index, tokens, text);
			if (match) fuzzy.push(match);
		}
	});
	return finish(tokens, literal, fuzzy);
}

/**
 * {@link rankSessionSearchMatches} for a long list in a process that must stay responsive: fuzzy scoring (about 100µs
 * a session) yields to the event loop every {@link FUZZY_SCAN_CHUNK_COUNT} sessions. Same result as the sync version.
 */
export async function rankSessionSearchMatchesAsync<T extends SessionSearchEntry>(
	sessions: readonly T[],
	query: string,
	textOf: SessionTextOf<T>,
): Promise<T[]> {
	const tokens = tokenizeSessionQuery(query);
	if (tokens.length === 0) return [...sessions];
	const literal: Ranked<T>[] = [];
	const fuzzy: Ranked<T>[] = [];
	let visits = 0;
	for (let index = 0; index < sessions.length; index++) {
		const session = sessions[index]!;
		const text = textOf(session);
		if (isLiteralMatch(text, tokens)) {
			literal.push({ session, score: 0, index });
			continue;
		}
		const match = scoreFuzzy(session, index, tokens, text);
		if (match) fuzzy.push(match);
		if (++visits % FUZZY_SCAN_CHUNK_COUNT === 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		}
	}
	return finish(tokens, literal, fuzzy);
}

/**
 * Prompt-history matches (`historyIds`: session ids whose recorded prompts matched, best first, duplicates tolerated)
 * lead in history order; the remaining `ranked` matches follow. A ranked match is never dropped, and history ids that
 * name no session of `all` (deleted, or out of scope) are ignored. An id may be any of a session's `aliases`.
 */
export function mergeSessionRanking<T extends SessionSearchEntry>(
	all: readonly T[],
	ranked: readonly T[],
	historyIds: readonly string[],
): T[] {
	if (historyIds.length === 0) return [...ranked];
	const byId = new Map<string, T>();
	for (const session of all) {
		for (const id of [session.id, ...(session.aliases ?? [])]) if (!byId.has(id)) byId.set(id, session);
	}
	const led = new Set<T>();
	for (const id of historyIds) {
		const session = byId.get(id);
		if (session) led.add(session);
	}
	if (led.size === 0) return [...ranked];
	return [...led, ...ranked.filter(session => !led.has(session))];
}
