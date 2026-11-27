import { useEffect } from "react";
import type { DaemonClient } from "../store/daemon-client";
import { isLooking, onLookingChange } from "./looking";

/**
 * While the user looks at a session (page visible and focused), tells the gateway how far they have read it (so other
 * clients drop their unread marker). Re-evaluated whenever something the client's rules depend on changes: the
 * session's `modifiedAt` (it changed under the reader), the replica getting its snapshot, the machine coming online, the
 * page becoming visible or focused. The client itself decides whether a report is due and never repeats one.
 */
export function useReadReport(
	client: DaemonClient,
	machine: string,
	session: { id: string; modifiedAt: number } | undefined,
	ready: boolean,
): void {
	const id = session?.id;
	const modifiedAt = session?.modifiedAt;
	useEffect(() => {
		if (id === undefined || modifiedAt === undefined || !ready) return;
		const report = (): void => {
			void client.reportRead(machine, { id, modifiedAt }, isLooking());
		};
		report();
		return onLookingChange(report);
	}, [client, machine, id, modifiedAt, ready]);
}
