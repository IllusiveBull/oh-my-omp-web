import { Markdown, StreamingMarkdown } from "@oh-my-pi/collab-web/src/components/transcript/Markdown";
import type { BtwRecordWire, BtwTurnWire } from "@omp-web/protocol";
import { CornerDownRight, Square, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useState } from "react";
import type { DaemonClient } from "../store/daemon-client";
import { IconButton } from "./ui/icon-button";

interface Props {
	client: DaemonClient;
	machine: string;
	sessionId: string;
	/** The session's topics by id, newest first. */
	topics: ReadonlyMap<string, BtwRecordWire>;
	/** Not hosted here: the topics can be read, nothing can be asked. */
	readOnly: boolean;
}

const STATUS_LABEL: Record<BtwTurnWire["status"], string | null> = {
	running: "answering…",
	complete: null,
	cancelled: "cancelled",
	error: "failed",
	interrupted: "interrupted",
};

function Turn({ turn }: { turn: BtwTurnWire }): ReactNode {
	const label = STATUS_LABEL[turn.status];
	return (
		<div className="btw-turn" data-status={turn.status}>
			<div className="btw-question">{turn.question}</div>
			{turn.answer !== "" && (
				<div className="btw-answer tr-md">
					{turn.status === "running" ? <StreamingMarkdown text={turn.answer} /> : <Markdown text={turn.answer} />}
				</div>
			)}
			{label && <div className={`btw-status btw-status--${turn.status}`}>{turn.error ?? label}</div>}
		</div>
	);
}

/**
 * omp's `/btw`: side questions answered from the session's context without entering its transcript or interrupting
 * the turn that runs. A topic takes follow-ups; omp answers one side question at a time. The topics live in omp's
 * sidecar of the session file, so the terminal UI shows the same ones.
 */
export function BtwPanel({ client, machine, sessionId, topics, readOnly }: Props): ReactNode {
	const [draft, setDraft] = useState("");
	const [followUp, setFollowUp] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const list = [...topics.values()];
	// A topic's latest question (its last follow-up, else its opening one) still being answered; omp answers one at a time.
	const active = list.find(t => (t.followUps?.at(-1) ?? t).status === "running");
	const target = followUp === null ? undefined : topics.get(followUp);

	const ask = async (e?: FormEvent): Promise<void> => {
		e?.preventDefault();
		const question = draft.trim();
		if (question === "" || busy || active) return;
		setBusy(true);
		setError(null);
		const ack = await client.request(machine, {
			t: "session.btw",
			sessionId,
			question,
			...(target ? { recordId: target.id } : {}),
		});
		setBusy(false);
		if (!ack.ok) setError(ack.error);
		else setDraft("");
	};

	const cancel = async (): Promise<void> => {
		if (!active) return;
		const ack = await client.request(machine, { t: "session.btw_cancel", sessionId, recordId: active.id });
		if (!ack.ok) setError(ack.error);
	};

	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void ask();
		}
	};

	return (
		<div className="btw">
			<div className="btw-topics">
				{list.length === 0 && (
					<div className="dock-empty">
						Ask something on the side: answered from this session's context, without adding to its transcript or
						interrupting the agent.
					</div>
				)}
				{list.map(topic => (
					<article
						key={topic.id}
						className={`btw-topic${topic.id === followUp ? " btw-topic--on" : ""}`}
						data-topic={topic.id}
					>
						<Turn turn={topic} />
						{topic.followUps?.map(turn => (
							<Turn key={turn.createdAt} turn={turn} />
						))}
						{!readOnly && topic.id !== followUp && topic !== active && (
							<button
								type="button"
								className="btn btn--ghost btn--small btw-follow"
								onClick={() => setFollowUp(topic.id)}
							>
								<CornerDownRight size={14} aria-hidden="true" /> Follow up
							</button>
						)}
					</article>
				))}
			</div>
			{readOnly ? (
				<div className="btw-note">Side questions can be asked in sessions omp-web hosts.</div>
			) : (
				<form className="btw-form" onSubmit={e => void ask(e)}>
					{target && (
						<div className="btw-target">
							<CornerDownRight size={14} aria-hidden="true" />
							<span className="btw-target-text">{target.question}</span>
							<IconButton icon={X} label="Ask a new question instead" small onClick={() => setFollowUp(null)} />
						</div>
					)}
					{error && (
						<div className="form-error" role="alert">
							{error}
						</div>
					)}
					<textarea
						className="btw-input"
						name="btw-question"
						rows={2}
						value={draft}
						placeholder={target ? "Follow-up question" : "Ask a side question (/btw)"}
						onChange={e => setDraft(e.target.value)}
						onKeyDown={onKey}
					/>
					<div className="btw-actions">
						{active ? (
							<button type="button" className="btn btn--small btn--danger" onClick={() => void cancel()}>
								<Square size={14} aria-hidden="true" /> Stop
							</button>
						) : (
							<button
								type="submit"
								className="btn btn--small btn--primary"
								disabled={busy || draft.trim() === ""}
							>
								{target ? "Follow up" : "Ask"}
							</button>
						)}
					</div>
				</form>
			)}
		</div>
	);
}
