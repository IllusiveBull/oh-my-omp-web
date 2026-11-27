import type { GitStatus } from "@omp-web/protocol";
import { useEffect, useState } from "react";
import { FilesApi, type FilesTransport } from "./files-data";
import { STATUS_POLL_MS } from "./files-store";

export interface WorktreeTarget {
	machine: string;
	root: string;
}

/**
 * The git status of one worktree, polled every {@link STATUS_POLL_MS} while `poll` is true and the page is visible
 * (the dock toolbar's Changes button reads it while no Files view polls the same worktree). Null until the first
 * answer, after a failed one, and for no target.
 */
export function useWorktreeStatus(
	client: FilesTransport,
	target: WorktreeTarget | null,
	poll: boolean,
): GitStatus | null {
	const machine = target?.machine ?? null;
	const root = target?.root ?? null;
	const key = machine === null || root === null ? null : `${machine}\0${root}`;
	const [state, setState] = useState<{ key: string; status: GitStatus | null } | null>(null);

	useEffect(() => {
		if (!poll || key === null || machine === null || root === null) return;
		const api = new FilesApi(client, machine, root);
		let stopped = false;
		let inFlight = false;
		const load = async (): Promise<void> => {
			if (inFlight || document.visibilityState === "hidden") return;
			inFlight = true;
			const result = await api.status();
			inFlight = false;
			if (stopped || (!result.ok && result.failure.code === "aborted")) return;
			setState({ key, status: result.ok ? result.data : null });
		};
		const onVisibility = (): void => void load();
		void load();
		const timer = setInterval(() => void load(), STATUS_POLL_MS);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			stopped = true;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisibility);
			api.close();
		};
	}, [client, key, machine, root, poll]);

	return state !== null && state.key === key ? state.status : null;
}
