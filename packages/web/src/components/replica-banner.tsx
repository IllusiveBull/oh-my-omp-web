import type { ReplicaInfo } from "@omp-web/protocol";
import type { ReactNode } from "react";
import { Moment } from "./moment";

interface Props {
	/** Name of the offline machine the session lives on. */
	machine: string;
	replica: ReplicaInfo;
	now: number;
}

/** Shown instead of the offline banner while a session is read from the gateway's copy. */
export function ReplicaBanner({ machine, replica, now }: Props): ReactNode {
	return (
		<div className="banner banner--replica" data-state={replica.state} role="status">
			This is a replica of {machine} (offline): the gateway's read-only copy of the transcript, last synced{" "}
			<Moment at={replica.syncedAt} now={now} absolute />. The session last changed on {machine}{" "}
			<Moment at={replica.asOf} now={now} absolute />.
			{replica.state === "partial" &&
				` ${machine} had newer data that was not copied before it went offline, so the end of the transcript may be missing.`}
		</div>
	);
}
