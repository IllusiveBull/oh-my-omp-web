import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import {
	HISTORY_MERGE_MIN_QUERY,
	mergeSessionRanking,
	rankSessionSearchMatchesAsync,
	type SessionSearchEntry,
} from "@omp-web/protocol";
import type { Conversation } from "./session-index";

/** Ids of the sessions whose recorded prompts match a query, best first (omp's `HistoryStorage.matchingSessionIds`). */
export type HistoryMatcher = (query: string) => string[];

/**
 * omp's prompt history (`history.db` in its agent directory), opened on the first search that asks for it. It reaches
 * past the start of each session file that the conversation text covers: a prompt typed deep into a long session is
 * only found here. A store that cannot be opened is reported once and the search goes on without it.
 */
export function promptHistoryMatcher(): HistoryMatcher {
	let history: HistoryStorage | null | undefined;
	return query => {
		if (history === undefined) {
			try {
				history = HistoryStorage.open();
			} catch (error) {
				console.warn(`omp-webd: prompt history unavailable for session search: ${error}`);
				history = null;
			}
		}
		return history ? history.matchingSessionIds(query) : [];
	};
}

interface IndexedConversation extends SessionSearchEntry {
	searchText: string;
}

/**
 * The conversations matching `query`, best first, as the ids a list entry is known by. The same ranking omp's resume
 * picker uses over each conversation's text (see `rankSessionSearchMatches`); conversations whose recorded prompts
 * match (`history`, consulted for queries of at least {@link HISTORY_MERGE_MIN_QUERY} characters) lead.
 */
export async function searchConversations(
	conversations: readonly Conversation[],
	query: string,
	history?: HistoryMatcher,
): Promise<string[]> {
	const trimmed = query.trim();
	if (trimmed === "") return [];
	const entries: IndexedConversation[] = conversations.map(c => ({
		id: c.id,
		title: c.title,
		modifiedAt: c.modifiedAt,
		aliases: c.memberIds,
		searchText: c.searchText,
	}));
	const ranked = await rankSessionSearchMatchesAsync(entries, trimmed, entry => entry.searchText);
	const historyIds = history && trimmed.length >= HISTORY_MERGE_MIN_QUERY ? history(trimmed) : [];
	return mergeSessionRanking(entries, ranked, historyIds).map(entry => entry.id);
}
