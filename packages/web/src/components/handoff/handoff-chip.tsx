import type { HandoffWire } from "@omp-web/protocol";
import { ArrowRightLeft } from "lucide-react";
import type { ReactNode } from "react";
import { chipText, phaseTone } from "../../lib/handoff";

/**
 * An unobtrusive strip on a thread while an environment switch exists for it (the same for every client): what it is
 * doing and a button that reopens the dialog.
 */
export function HandoffChip({ wire, onOpen }: { wire: HandoffWire; onOpen(id: string): void }): ReactNode {
	return (
		<div
			className={`banner handoff-chip handoff-chip--${phaseTone(wire.phase)}`}
			role="status"
			data-testid="handoff-chip"
			data-phase={wire.phase}
		>
			<ArrowRightLeft size={14} aria-hidden />
			<span className="handoff-chip-text">{chipText(wire)}</span>
			<button
				type="button"
				className="btn btn--small"
				data-testid="handoff-chip-open"
				onClick={() => onOpen(wire.id)}
			>
				View
			</button>
		</div>
	);
}
