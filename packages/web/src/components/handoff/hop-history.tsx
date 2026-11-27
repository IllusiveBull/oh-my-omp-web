import type { ThreadHop } from "@omp-web/protocol";
import type { ReactNode } from "react";
import { hopText } from "../../lib/handoff";

interface Props {
	hops: readonly ThreadHop[];
	now: number;
	/** The newest hops shown; older ones collapse into `+N earlier`. */
	limit?: number;
}

/**
 * Where the thread has been, oldest first, one chip per move (`desktop → laptop · partial hit · 2 h ago`). Phrasing
 * elements only, so it can sit inside a list entry's button.
 */
export function HopHistory({ hops, now, limit = 3 }: Props): ReactNode {
	if (hops.length === 0) return null;
	const shown = hops.slice(-limit);
	const earlier = hops.length - shown.length;
	return (
		<span className="hop-history" data-testid="hop-history">
			{earlier > 0 && <span className="hop-chip hop-chip--more">+{earlier} earlier</span>}
			{shown.map(hop => (
				<span key={hop.id} className="hop-chip" data-testid="hop-chip" data-forecast={hop.forecast ?? "none"}>
					{hopText(hop, now)}
				</span>
			))}
		</span>
	);
}
