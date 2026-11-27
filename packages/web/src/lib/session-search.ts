import { type GatewaySessionInfo, mergeSessionRanking, rankSessionSearchMatches } from "@omp-web/protocol";

const textCache = new WeakMap<GatewaySessionInfo, string>();

/** Lowercased text of a listed session that the browser can search without the daemon: what the list shows. */
function listedText(session: GatewaySessionInfo): string {
	let text = textCache.get(session);
	if (text === undefined) {
		text = [session.id, session.title, session.cwd, session.preview, session.file, session.model]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
		textCache.set(session, text);
	}
	return text;
}

/**
 * The sessions matching `query`, best first.
 *
 * `daemonMatches` is the daemon's answer to `sessions.search` for this same query: its ranking over each session's
 * transcript and omp's prompt history, which the browser does not have. Sessions it names lead, in its order. The
 * browser's own ranking of the listed fields (omp's ranking too) follows, which adds the sessions the daemon has not
 * indexed yet (a session that has just started) and keeps a rename the daemon has not seen. Without an answer (none
 * yet, the machine offline, an old daemon) only the browser's ranking applies.
 */
export function searchSessions(
	sessions: readonly GatewaySessionInfo[],
	query: string,
	daemonMatches?: readonly string[],
): GatewaySessionInfo[] {
	if (query.trim() === "") return [...sessions];
	const local = rankSessionSearchMatches(sessions, query, listedText);
	if (daemonMatches === undefined) return local;
	// Matched ids lead in the daemon's order; "all" for the merge is every session, so ids that name none are dropped.
	return mergeSessionRanking(sessions, local, daemonMatches);
}
