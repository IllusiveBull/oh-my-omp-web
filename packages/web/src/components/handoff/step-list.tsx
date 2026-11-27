import type { HandoffStep } from "@omp-web/protocol";
import { Check, Circle, LoaderCircle, Minus, X } from "lucide-react";
import type { ReactNode } from "react";
import { STEP_STATUS_TEXT, stepProgress } from "../../lib/handoff";

const ICONS = {
	pending: Circle,
	running: LoaderCircle,
	done: Check,
	skipped: Minus,
	failed: X,
} as const;

/** The steps of the operation in order, each with its state as an icon and in words, its detail and a transfer bar. */
export function StepList({ steps }: { steps: readonly HandoffStep[] }): ReactNode {
	return (
		<ol className="handoff-steps" data-testid="handoff-steps">
			{steps.map(step => {
				const Icon = ICONS[step.status];
				const progress = stepProgress(step);
				return (
					<li
						key={step.id}
						className={`handoff-step handoff-step--${step.status}`}
						data-testid={`handoff-step-${step.id}`}
						data-status={step.status}
					>
						<span className="handoff-step-icon" role="img" aria-label={STEP_STATUS_TEXT[step.status]}>
							<Icon size={16} aria-hidden />
						</span>
						<div className="handoff-step-body">
							<div className="handoff-step-label">
								{step.label}
								<span className="handoff-step-state">{STEP_STATUS_TEXT[step.status]}</span>
							</div>
							{step.detail && <div className="handoff-step-detail">{step.detail}</div>}
							{progress && (
								<div className="handoff-bar-row">
									<div
										className="handoff-bar"
										role="progressbar"
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={progress.percent}
										aria-label={`${step.label} transfer`}
										data-testid={`handoff-bar-${step.id}`}
									>
										<div className="handoff-bar-fill" style={{ width: `${progress.percent}%` }} />
									</div>
									<span className="handoff-bar-text">{progress.text}</span>
								</div>
							)}
						</div>
					</li>
				);
			})}
		</ol>
	);
}
