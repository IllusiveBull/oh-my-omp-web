import type { AckErrorCode, SessionBackend } from "@omp-web/protocol";
import { type ReactNode, useState } from "react";
import { ackedSessionId } from "../lib/ack";
import type { DaemonClient } from "../store/daemon-client";

interface Props {
	client: DaemonClient;
	machine: string;
	sessionId: string;
	backend?: SessionBackend;
	/** Replaces the default explanation (e.g. for a hosted session whose process died). */
	prompt?: string;
	/** Replaces the default button label. */
	action?: string;
	onOpen(sessionId: string): void;
}

/**
 * Offers to take over a session no process of this daemon runs. The daemon decides whether confirmation is needed
 * (an omp session this daemon did not create), so the first attempt is unconfirmed and a `confirm_takeover` answer
 * turns into the confirmation prompt.
 */
export function Takeover({ client, machine, sessionId, backend = "omp", prompt, action, onOpen }: Props): ReactNode {
	const [busy, setBusy] = useState(false);
	const [confirm, setConfirm] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const resume = async (confirmed: boolean): Promise<void> => {
		setBusy(true);
		setError(null);
		const ack = await client.request(machine, { t: "session.resume", sessionId, confirm: confirmed });
		setBusy(false);
		if (ack.ok) {
			const resumed = ackedSessionId(ack.data);
			if (resumed === null) {
				setError("the daemon did not report the session to open");
				return;
			}
			setConfirm(null);
			onOpen(resumed);
			return;
		}
		const code: AckErrorCode | undefined = ack.code;
		if (code === "confirm_takeover") setConfirm(ack.error);
		else setError(ack.error);
	};

	const text =
		prompt ??
		(backend === "antigravity"
			? "Stored Antigravity session. Resume it with Antigravity ACP to continue here."
			: "Not running in omp-web. Take it over to continue the conversation here.");
	return (
		<div className="takeover">
			{confirm === null ? (
				<>
					<span className="takeover-text" title={text}>
						{text}
					</span>
					<button type="button" className="btn btn--primary" disabled={busy} onClick={() => void resume(false)}>
						{busy ? "Starting…" : (action ?? (backend === "antigravity" ? "Resume" : "Take over"))}
					</button>
				</>
			) : (
				<>
					<span className="takeover-text takeover-text--full">{confirm}</span>
					<button type="button" className="btn btn--primary" disabled={busy} onClick={() => void resume(true)}>
						{busy ? "Starting…" : "Take over anyway"}
					</button>
					<button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)}>
						Cancel
					</button>
				</>
			)}
			{error && <span className="form-error">{error}</span>}
		</div>
	);
}
