import type { HandoffWire, MachineSummary } from "@omp-web/protocol";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { displayPath } from "../../lib/environment";
import { canCancel, canDismiss, completedLocation, phaseText, phaseTone } from "../../lib/handoff";
import { sessionHash } from "../../lib/route";
import { CarriedView, NotCarried } from "./carried";
import { ForecastPanel } from "./forecast-panel";
import { StepList } from "./step-list";

interface Props {
	wire: HandoffWire;
	machines?: readonly MachineSummary[];
	now: number;
	/** A confirm, cancel or dismiss request is in flight. */
	busy: boolean;
	/** The last request the user made was refused. */
	error: string | null;
	onConfirm(): void;
	onCancel(): void;
	onDismiss(): void;
}

/**
 * The operation as the gateway reports it, and nothing else: every client renders the same wire, so a reload or a second
 * tab shows the same screen. Which buttons exist follows from the phase.
 */
export function ProgressView({ wire, machines, now, busy, error, onConfirm, onCancel, onDismiss }: Props): ReactNode {
	const tone = phaseTone(wire.phase);
	const location = completedLocation(wire);
	return (
		<div className="handoff-progress" data-testid="handoff-progress" data-phase={wire.phase}>
			<div className="handoff-route">
				<span>{wire.source.machineName}</span>
				<ArrowRight size={14} aria-hidden />
				<span>{wire.target.machineName}</span>
				{wire.target.worktree && (
					<code className="handoff-route-path">
						{displayPath(
							wire.target.worktree,
							machines?.find(m => m.id === wire.target.machine),
						)}
					</code>
				)}
				{wire.target.branch && <span className="handoff-route-branch">{wire.target.branch}</span>}
			</div>
			<div className={`handoff-phase handoff-phase--${tone}`} role="status" data-testid="handoff-phase">
				{phaseText(wire)}
			</div>
			{wire.leftovers && wire.leftovers.length > 0 && (
				<div className="handoff-leftovers" data-testid="handoff-leftovers">
					<h4>Left behind</h4>
					<ul className="handoff-paths">
						{wire.leftovers.map(item => (
							<li key={item}>{item}</li>
						))}
					</ul>
				</div>
			)}
			{wire.result?.warning && (
				<div className="handoff-warning" role="status" data-testid="handoff-warning">
					{wire.result.warning}
				</div>
			)}
			{wire.phase === "completed" && wire.result && !wire.result.sourceMarked && !wire.freshSession && (
				<div className="handoff-warning" role="status">
					The old copy on {wire.source.machineName} could not be marked as moved.
				</div>
			)}
			<StepList steps={wire.steps} />
			{wire.phase === "awaiting_confirm" ? (
				<ForecastPanel wire={wire} now={now} busy={busy} onConfirm={onConfirm} onCancel={onCancel} />
			) : (
				wire.carried && (
					<details className="handoff-details" data-testid="handoff-carried-details">
						<summary>What was carried</summary>
						<CarriedView carried={wire.carried} />
						<NotCarried carried={wire.carried} />
					</details>
				)
			)}
			{error && (
				<div className="form-error" role="alert" data-testid="handoff-request-error">
					{error}
				</div>
			)}
			<div className="handoff-actions">
				{wire.phase !== "awaiting_confirm" && canCancel(wire) && (
					<button
						type="button"
						className="btn btn--danger"
						data-testid="handoff-cancel"
						disabled={busy}
						onClick={onCancel}
					>
						Cancel
					</button>
				)}
				{location && (
					<a className="btn btn--primary" data-testid="handoff-open-new" href={sessionHash(location)}>
						Open on {wire.target.machineName}
					</a>
				)}
				{canDismiss(wire) && (
					<button
						type="button"
						className="btn btn--ghost"
						data-testid="handoff-dismiss"
						disabled={busy}
						onClick={onDismiss}
					>
						Dismiss
					</button>
				)}
			</div>
		</div>
	);
}
