import type { HandoffWire } from "@omp-web/protocol";
import { useEffect } from "react";
import { completedLocation } from "../../lib/handoff";
import type { SessionRef } from "../../lib/route";

/**
 * Takes this tab to the thread's new location when an operation it confirmed completes. Other tabs never navigate:
 * they see the old session as moved. An id leaves `confirmedHere` once it reaches an end state (a list that is empty for a
 * moment while the socket reconnects does not forget it).
 */
export function useHandoffNavigation(
	handoffs: readonly HandoffWire[],
	confirmedHere: Set<string>,
	navigate: (to: SessionRef) => void,
): void {
	useEffect(() => {
		for (const wire of handoffs) {
			if (!confirmedHere.has(wire.id)) continue;
			const to = completedLocation(wire);
			if (to) {
				confirmedHere.delete(wire.id);
				navigate(to);
			} else if (wire.phase === "failed" || wire.phase === "rolled_back" || wire.phase === "rollback_failed") {
				confirmedHere.delete(wire.id);
			}
		}
	}, [handoffs, confirmedHere, navigate]);
}
