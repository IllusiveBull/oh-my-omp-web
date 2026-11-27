import type { HandoffPlan, MachineSummary, HandoffWire, TargetChoice } from "@omp-web/protocol";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { defaultChoice } from "../../lib/handoff";
import { useNow } from "../../lib/use-now";
import type { DaemonClient } from "../../store/daemon-client";
import { IconButton } from "../ui/icon-button";
import { PlanView } from "./plan-view";
import { ProgressView } from "./progress-view";

/** What the dialog is opened for: a session about to be switched, or an operation that already exists. */
export type SwitchTarget =
	| { kind: "plan"; machine: string; sessionId: string; title?: string }
	| { kind: "handoff"; id: string };

interface Props {
	client: DaemonClient;
	machines: readonly MachineSummary[];
	handoffs: readonly HandoffWire[];
	target: SwitchTarget;
	onClose(): void;
	/** Operations this tab confirmed: when one completes, this tab (and only this one) navigates to the thread's new place. */
	confirmedHere: Set<string>;
}

type PlanState =
	| { state: "idle" }
	| { state: "loading"; machine: string }
	| { state: "error"; machine: string; error: string }
	| { state: "ready"; machine: string; plan: HandoffPlan };

function startedId(data: unknown): string | null {
	if (typeof data === "object" && data !== null && "id" in data && typeof data.id === "string") return data.id;
	return null;
}

/**
 * The environment switch: pick the target machine, look at the plan, start; then the progress of the operation, its
 * cache forecast and the confirmation. A full-screen sheet on phones.
 */
export function SwitchEnvironment({ client, machines, handoffs, target, onClose, confirmedHere }: Props): ReactNode {
	const [plan, setPlan] = useState<PlanState>({ state: "idle" });
	const [choice, setChoice] = useState<TargetChoice | null>(null);
	const [starting, setStarting] = useState(false);
	const [started, setStarted] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const planRequest = useRef(0);

	const wire = handoffs.find(h => h.id === (target.kind === "handoff" ? target.id : started));
	const now = useNow(wire?.phase === "awaiting_confirm");

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const pick = async (targetMachine: string): Promise<void> => {
		if (target.kind !== "plan") return;
		const request = ++planRequest.current;
		setError(null);
		setPlan({ state: "loading", machine: targetMachine });
		const ack = await client.handoffRequest({
			t: "handoff.plan",
			m: target.machine,
			sessionId: target.sessionId,
			targetMachine,
		});
		if (planRequest.current !== request) return; // the user picked another machine meanwhile
		if (!ack.ok) {
			setPlan({ state: "error", machine: targetMachine, error: ack.error });
			return;
		}
		const next = ack.data as HandoffPlan;
		setPlan({ state: "ready", machine: targetMachine, plan: next });
		setChoice(defaultChoice(next));
	};

	const start = async (): Promise<void> => {
		if (target.kind !== "plan" || plan.state !== "ready" || !choice) return;
		setStarting(true);
		setError(null);
		const ack = await client.handoffRequest({
			t: "handoff.start",
			m: target.machine,
			sessionId: target.sessionId,
			targetMachine: plan.machine,
			target: choice,
		});
		setStarting(false);
		if (!ack.ok) {
			setError(ack.error);
			return;
		}
		const id = startedId(ack.data);
		if (id === null) setError("the gateway did not report the started switch");
		else setStarted(id);
	};

	/** Sends a request about the operation on screen; a refusal is shown where the button is. */
	const act = async (request: "handoff.confirm" | "handoff.cancel" | "handoff.dismiss"): Promise<void> => {
		if (!wire) return;
		setBusy(true);
		setError(null);
		// Marked before the ack: the completed state can arrive first.
		if (request === "handoff.confirm") confirmedHere.add(wire.id);
		const ack = await client.handoffRequest({ t: request, id: wire.id });
		setBusy(false);
		if (!ack.ok) {
			if (request === "handoff.confirm") confirmedHere.delete(wire.id);
			setError(ack.error);
		} else if (request === "handoff.dismiss") onClose();
	};

	const title = target.kind === "plan" ? (target.title ?? target.sessionId) : (wire?.source.title ?? wire?.threadId);

	let body: ReactNode;
	if (wire) {
		body = (
			<ProgressView
				wire={wire}
				machines={machines}
				now={now}
				busy={busy}
				error={error}
				onConfirm={() => void act("handoff.confirm")}
				onCancel={() => void act("handoff.cancel")}
				onDismiss={() => void act("handoff.dismiss")}
			/>
		);
	} else if (target.kind === "handoff") {
		body = (
			<p className="handoff-note" data-testid="handoff-missing">
				This switch is no longer listed: it was dismissed or the gateway restarted.
			</p>
		);
	} else if (started !== null) {
		body = (
			<p className="handoff-note" role="status" data-testid="handoff-starting">
				Starting the switch…
			</p>
		);
	} else {
		body = (
			<>
				<fieldset className="handoff-machines" data-testid="handoff-machines">
					<legend>Switch to which machine?</legend>
					{machines.map(m => (
						<button
							key={m.id}
							type="button"
							className={`handoff-machine${plan.state !== "idle" && plan.machine === m.id ? " handoff-machine--on" : ""}`}
							data-testid={`handoff-machine-${m.id}`}
							data-online={m.online}
							disabled={!m.online}
							aria-pressed={plan.state !== "idle" && plan.machine === m.id}
							onClick={() => void pick(m.id)}
						>
							<span className="handoff-machine-name">{m.name}</span>
							{m.id === target.machine && (
								<span className="handoff-machine-hint">this machine: a new worktree</span>
							)}
							{!m.online && <span className="handoff-machine-hint">offline</span>}
						</button>
					))}
				</fieldset>
				{plan.state === "loading" && (
					<p className="handoff-note" role="status" data-testid="handoff-plan-loading">
						Checking the repository…
					</p>
				)}
				{plan.state === "error" && (
					<div className="form-error" role="alert" data-testid="handoff-plan-error">
						{plan.error}
					</div>
				)}
				{plan.state === "ready" && (
					<PlanView
						plan={plan.plan}
						machines={machines}
						choice={choice}
						onChoice={setChoice}
						onStart={() => void start()}
						starting={starting}
						error={error}
					/>
				)}
			</>
		);
	}

	return (
		<div className="handoff-overlay" data-testid="handoff-dialog">
			<div className="handoff-sheet" role="dialog" aria-modal="true" aria-label="Switch environment">
				<div className="handoff-head">
					<h2>Switch environment</h2>
					<IconButton
						icon={X}
						label="Close"
						className="handoff-close"
						data-testid="handoff-close"
						onClick={onClose}
					/>
				</div>
				{title && <div className="handoff-title">{title}</div>}
				<div className="handoff-body">{body}</div>
			</div>
		</div>
	);
}
