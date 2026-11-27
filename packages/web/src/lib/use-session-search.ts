import { HISTORY_MERGE_DEBOUNCE_MS, HISTORY_MERGE_MIN_QUERY, type SessionSearchAck } from "@omp-web/protocol";
import { useEffect, useState } from "react";
import type { DaemonClient } from "../store/daemon-client";

/** What the daemon has said about the current query. */
export type DaemonSearch =
	| { state: "idle" }
	| { state: "pending" }
	| { state: "ready"; matches: readonly string[] }
	/** The daemon predates `sessions.search`: it has to be restarted on a newer version for transcript search. */
	| { state: "unsupported" }
	| { state: "failed"; error: string };

const IDLE: DaemonSearch = { state: "idle" };
const PENDING: DaemonSearch = { state: "pending" };

function isSearchAck(data: unknown): data is SessionSearchAck {
	return (
		typeof data === "object" &&
		data !== null &&
		"matches" in data &&
		Array.isArray(data.matches) &&
		data.matches.every(id => typeof id === "string")
	);
}

/**
 * Asks `machine`'s daemon to search the transcripts of its sessions and omp's prompt history for `query`, once typing
 * pauses. The answer belongs to the query (and machine) it was asked for: while the query changes the previous answer
 * is not shown for the new one, and a late reply to an older query is dropped. `revision` changes when the machine's
 * session list does, so an answer is refreshed as sessions gain messages without discarding the one on screen.
 *
 * Idle for a query too short to be worth a search, and for an offline machine (the browser's own ranking of the cached
 * list applies; there is no daemon to ask).
 */
export function useDaemonSessionSearch(
	client: DaemonClient,
	machine: string | undefined,
	online: boolean,
	query: string,
	revision: string,
): DaemonSearch {
	const trimmed = query.trim();
	const enabled = machine !== undefined && online && trimmed.length >= HISTORY_MERGE_MIN_QUERY;
	const key = `${machine}\0${trimmed}`;
	const [answer, setAnswer] = useState<{ key: string; search: DaemonSearch } | null>(null);
	useEffect(() => {
		if (!enabled || machine === undefined) return;
		let current = true;
		const timer = setTimeout(() => {
			void client.request(machine, { t: "sessions.search", query: trimmed }).then(ack => {
				if (!current) return;
				let search: DaemonSearch;
				if (ack.ok && isSearchAck(ack.data)) search = { state: "ready", matches: ack.data.matches };
				else if (ack.ok) search = { state: "failed", error: "the daemon sent an unreadable search result" };
				else if (/unknown message type/.test(ack.error)) search = { state: "unsupported" };
				else search = { state: "failed", error: ack.error };
				setAnswer({ key, search });
			});
		}, HISTORY_MERGE_DEBOUNCE_MS);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [client, machine, enabled, trimmed, key, revision]);
	if (!enabled) return IDLE;
	return answer?.key === key ? answer.search : PENDING;
}
