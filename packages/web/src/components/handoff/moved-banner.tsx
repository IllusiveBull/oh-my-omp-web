import type { GatewaySessionInfo } from "@omp-web/protocol";
import type { ReactNode } from "react";
import { sessionHash } from "../../lib/route";
import { Moment } from "../moment";

interface Props {
	movedTo: NonNullable<GatewaySessionInfo["movedTo"]>;
	now: number;
}

/** Shown on the old end of a completed move: it is history now, and the link leads to where the thread lives. */
export function MovedBanner({ movedTo, now }: Props): ReactNode {
	return (
		<div className="banner banner--info handoff-moved" role="status" data-testid="moved-banner">
			This session moved to {movedTo.machineName} (<Moment at={movedTo.at} now={now} />
			). This copy is read-only history.{" "}
			<a data-testid="moved-link" href={sessionHash({ machine: movedTo.machine, id: movedTo.sessionId })}>
				Open it on {movedTo.machineName}
			</a>
		</div>
	);
}
