import type { HandoffPlan, MachineSummary, TargetChoice } from "@omp-web/protocol";
import type { ReactNode } from "react";
import { displayPath } from "../../lib/environment";
import { shortHead, startBlockers } from "../../lib/handoff";
import { CarriedView, NotCarried } from "./carried";

interface Props {
	plan: HandoffPlan;
	machines?: readonly MachineSummary[];
	choice: TargetChoice | null;
	onChoice(choice: TargetChoice): void;
	onStart(): void;
	/** `handoff.start` is in flight. */
	starting: boolean;
	/** The start request was refused. */
	error: string | null;
}

/** What the plan says before anything is created: matched project, source preview, target choice, blockers, Start. */
export function PlanView({ plan, machines, choice, onChoice, onStart, starting, error }: Props): ReactNode {
	const blockers = startBlockers(plan, choice);
	const target = plan.target;
	const sourceMachine = machines?.find(m => m.id === plan.source.machine);
	const targetMachine = machines?.find(m => m.id === target?.machine);
	return (
		<div className="handoff-plan" data-testid="handoff-plan">
			{blockers.length > 0 && (
				<ul className="handoff-blockers" role="alert" data-testid="handoff-blockers">
					{blockers.map(blocker => (
						<li key={blocker}>{blocker}</li>
					))}
				</ul>
			)}
			{target?.project && (
				<p className="handoff-note" data-testid="handoff-project">
					Project <strong>{target.project.name}</strong> on {target.machineName}:{" "}
					<code>{displayPath(target.project.root, targetMachine)}</code>
				</p>
			)}
			{plan.repo && (
				<section className="handoff-section" data-testid="handoff-source">
					<h4>
						From {plan.source.machineName}: {plan.repo.project.name}
					</h4>
					<div className="handoff-note">
						{plan.repo.branch ? `branch ${plan.repo.branch}` : "detached HEAD"} at{" "}
						<code>{shortHead(plan.repo.head)}</code> ·{" "}
						<code>{displayPath(plan.repo.project.worktree, sourceMachine)}</code>
					</div>
					<CarriedView carried={plan.repo.preview} />
					<NotCarried carried={plan.repo.preview} />
				</section>
			)}
			{target?.project && (
				<fieldset className="handoff-choices" data-testid="handoff-targets">
					<legend>Where the thread continues</legend>
					{target.newWorktree && (
						<label className="handoff-choice" data-testid="handoff-target-new">
							<input
								type="radio"
								name="handoff-target"
								checked={choice?.mode === "new"}
								onChange={() => onChoice({ mode: "new" })}
							/>
							<span>
								New worktree <code>{displayPath(target.newWorktree.path, targetMachine)}</code> on branch{" "}
								<code>{target.newWorktree.branch}</code>
							</span>
						</label>
					)}
					{target.worktrees.map(w => (
						<label
							key={w.path}
							className={`handoff-choice${w.eligible ? "" : " handoff-choice--off"}`}
							data-testid="handoff-target-existing"
							data-worktree={w.path}
							data-eligible={w.eligible}
						>
							<input
								type="radio"
								name="handoff-target"
								disabled={!w.eligible}
								checked={choice?.mode === "existing" && choice.worktree === w.path}
								onChange={() => onChoice({ mode: "existing", worktree: w.path })}
							/>
							<span>
								Existing worktree <code>{displayPath(w.path, targetMachine)}</code>
								{w.branch ? ` on ${w.branch}` : ""} at <code>{shortHead(w.head)}</code>
								{w.isSource && " (this session's worktree)"}
								{!w.eligible && (
									<span className="handoff-why"> — not usable: {w.reason ?? "not eligible"}</span>
								)}
							</span>
						</label>
					))}
				</fieldset>
			)}
			{error && (
				<div className="form-error" role="alert" data-testid="handoff-request-error">
					{error}
				</div>
			)}
			<div className="handoff-actions">
				<button
					type="button"
					className="btn btn--primary"
					data-testid="handoff-start"
					disabled={starting || blockers.length > 0}
					onClick={onStart}
				>
					{starting ? "Starting…" : "Start switch"}
				</button>
			</div>
		</div>
	);
}
