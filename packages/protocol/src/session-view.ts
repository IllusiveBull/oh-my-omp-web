/**
 * Pure fold of a session's {@link SessionEvent} stream into what the transcript renders.
 *
 * Used by both ends: the daemon folds the stream to build snapshots for late subscribers, the browser
 * folds it to drive upstream collab-web's `<Transcript>` (whose props this mirrors; collab-web's
 * `GuestClient` builds the same props from collab frames, see `GuestClient.#applyEvent`).
 *
 * Immutable: every change returns a new object and replaces changed collections by reference, which
 * is what upstream's memoised rows rely on (`entryRowEqual` in Transcript.tsx).
 */
import type { AgentEvent, AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type {
	ActiveToolWire,
	BtwRecordWire,
	NoticeWire,
	SessionAttention,
	SessionEvent,
	SessionSnapshot,
	SessionStatus,
	SlashCommandWire,
	SubagentWire,
	UiRequest,
	WidgetWire,
} from "./messages";

/** Structurally identical to collab-web `ActiveTool`; assignability to `<Transcript activeTools>` is typechecked in web. */
export type ActiveTool = ActiveToolWire;

const MAX_NOTICES = 20;

export interface SessionView {
	/** Committed entries (authoritative ids from omp's session file). */
	entries: readonly SessionEntry[];
	/** Streaming assistant ghost; held after `message_end` until the committed entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	status: SessionStatus | null;
	/** Pending interactive requests, oldest first. */
	uiRequests: readonly UiRequest[];
	/** Capped, newest last. */
	notices: readonly NoticeWire[];
	/** Reason the omp child exited, else null. */
	closed: string | null;
	/** Keyed status lines set by extensions (`setStatus`). */
	statuses: ReadonlyMap<string, string>;
	/** Keyed line blocks set by extensions (`setWidget`). */
	widgets: ReadonlyMap<string, WidgetWire>;
	/** Title an extension set (`setTitle`). */
	title: string | null;
	/** Slash commands the session offers. */
	commands: readonly SlashCommandWire[];
	/** Sub-agents; only filled while some client watches them (see `session.agents`). */
	subagents: ReadonlyMap<string, SubagentWire>;
	/** `/btw` topics by id, newest first. */
	btw: ReadonlyMap<string, BtwRecordWire>;
}

export const emptySessionView: SessionView = {
	entries: [],
	stream: null,
	streamDone: false,
	activeTools: new Map(),
	working: false,
	status: null,
	uiRequests: [],
	notices: [],
	closed: null,
	statuses: new Map(),
	widgets: new Map(),
	title: null,
	commands: [],
	subagents: new Map(),
	btw: new Map(),
};

export function toSnapshot(view: SessionView): SessionSnapshot {
	return {
		entries: [...view.entries],
		stream: view.stream,
		streamDone: view.streamDone,
		activeTools: [...view.activeTools.values()],
		working: view.working,
		status: view.status,
		uiRequests: [...view.uiRequests],
		notices: [...view.notices],
		closed: view.closed,
		statuses: [...view.statuses].map(([key, text]) => ({ key, text })),
		widgets: [...view.widgets].map(([key, widget]) => ({ key, ...widget })),
		title: view.title,
		commands: [...view.commands],
		subagents: [...view.subagents.values()],
		btw: [...view.btw.values()],
	};
}

export function fromSnapshot(snapshot: SessionSnapshot): SessionView {
	return {
		entries: snapshot.entries,
		stream: snapshot.stream,
		streamDone: snapshot.streamDone,
		activeTools: new Map(snapshot.activeTools.map(tool => [tool.toolCallId, tool])),
		working: snapshot.working,
		status: snapshot.status,
		uiRequests: snapshot.uiRequests,
		notices: snapshot.notices,
		closed: snapshot.closed,
		statuses: new Map(snapshot.statuses.map(({ key, text }) => [key, text])),
		widgets: new Map(snapshot.widgets.map(({ key, ...widget }) => [key, widget])),
		title: snapshot.title,
		commands: snapshot.commands,
		subagents: new Map(snapshot.subagents.map(agent => [agent.agent.id, agent])),
		btw: new Map((snapshot.btw ?? []).map(record => [record.id, record])),
	};
}

/**
 * What the session waits on a human for: an open question (even mid-run: the run is blocked on it), or, once idle, a
 * last run that ended in an error (an `error` stop or an error notice; both clear when the next run starts).
 */
export function attentionOf(view: SessionView): SessionAttention | undefined {
	if (view.closed !== null) return undefined;
	if (view.uiRequests.length > 0) return "input";
	if (view.working) return undefined;
	if (view.notices.some(n => n.level === "error")) return "error";
	const last = view.stream ?? lastAssistant(view.entries);
	return last?.stopReason === "error" ? "error" : undefined;
}

/** The newest message when it is the assistant's (a later user or tool message means the error was moved past). */
function lastAssistant(entries: readonly SessionEntry[]): AssistantMessage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "message") return entry.message.role === "assistant" ? entry.message : undefined;
	}
	return undefined;
}

function withNotice(
	view: SessionView,
	level: NoticeWire["level"],
	message: string,
	now: number,
	op?: NoticeWire["op"],
): SessionView {
	const notices = [...view.notices, { level, message, at: now, ...(op ? { op } : {}) }];
	if (notices.length > MAX_NOTICES) notices.splice(0, notices.length - MAX_NOTICES);
	return { ...view, notices };
}

/** The operation `op` ended: its progress and intermediate notices go away, the caller adds the outcome. */
function endOperation(view: SessionView, op: NonNullable<NoticeWire["op"]>): SessionView {
	return view.notices.some(n => n.op === op) ? { ...view, notices: view.notices.filter(n => n.op !== op) } : view;
}

/** Notices raised while a compaction runs (omp reports its fallbacks as notices) belong to it. */
function ongoingOp(view: SessionView): NoticeWire["op"] {
	return view.status?.isCompacting ? "compaction" : undefined;
}

function applyAgentEvent(view: SessionView, event: AgentEvent, now: number): SessionView {
	switch (event.type) {
		case "message_start":
		case "message_update":
			if (event.message.role !== "assistant") return view;
			return { ...view, stream: event.message, streamDone: false };
		case "message_end":
			if (event.message.role !== "assistant") return view;
			return { ...view, stream: event.message, streamDone: true };
		case "tool_execution_start": {
			const tool: ActiveTool = {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
				startedAt: now,
			};
			return { ...view, activeTools: new Map(view.activeTools).set(event.toolCallId, tool) };
		}
		case "tool_execution_update": {
			const existing = view.activeTools.get(event.toolCallId);
			const tool: ActiveTool = existing
				? { ...existing, partialResult: event.partialResult }
				: {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						partialResult: event.partialResult,
						startedAt: now,
					};
			return { ...view, activeTools: new Map(view.activeTools).set(event.toolCallId, tool) };
		}
		case "tool_execution_end": {
			const next = new Map(view.activeTools);
			next.delete(event.toolCallId);
			return { ...view, activeTools: next };
		}
		case "agent_start":
			// A new run: what was said about the previous one is history.
			return { ...view, working: true, notices: view.notices.length === 0 ? view.notices : [] };
		case "agent_end":
			return { ...view, working: false };
		case "notice":
			return withNotice(view, event.level, event.message, now, ongoingOp(view));
		case "auto_retry_start":
			return withNotice(
				view,
				"info",
				`retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
				now,
				"retry",
			);
		case "auto_retry_end": {
			const ended = endOperation(view, "retry");
			return event.success ? ended : withNotice(ended, "error", event.finalError ?? "retry failed", now);
		}
		case "auto_compaction_start":
			return withNotice(view, "info", `compacting context (${event.reason})`, now, "compaction");
		case "auto_compaction_end":
			if (event.skipped) return endOperation(view, "compaction");
			return withNotice(
				endOperation(view, "compaction"),
				event.errorMessage ? "error" : "info",
				event.aborted
					? "compaction aborted"
					: event.errorMessage
						? `compaction failed: ${event.errorMessage}`
						: "context compacted",
				now,
			);
		default:
			// turn_start/turn_end/thinking_level_changed/unknown: not transcript rows.
			return view;
	}
}

export function applySessionEvent(view: SessionView, ev: SessionEvent, now: number): SessionView {
	switch (ev.k) {
		case "agent":
			return applyAgentEvent(view, ev.event, now);
		case "entries": {
			if (ev.reset) {
				return { ...view, entries: ev.entries, stream: null, streamDone: false };
			}
			if (ev.entries.length === 0) return view;
			// The committed row supersedes the finished stream ghost in the same step (no flicker).
			const supersedes =
				view.streamDone && ev.entries.some(e => e.type === "message" && e.message.role === "assistant");
			return {
				...view,
				entries: [...view.entries, ...ev.entries],
				...(supersedes ? { stream: null, streamDone: false } : {}),
			};
		}
		case "status_patch":
			return view.status ? { ...view, status: { ...view.status, ...ev.patch } } : view;
		case "ui_status": {
			const statuses = new Map(view.statuses);
			if (ev.text === null) statuses.delete(ev.key);
			else statuses.set(ev.key, ev.text);
			return { ...view, statuses };
		}
		case "ui_widget": {
			const widgets = new Map(view.widgets);
			if (ev.lines === null) widgets.delete(ev.key);
			else widgets.set(ev.key, { lines: ev.lines, placement: ev.placement });
			return { ...view, widgets };
		}
		case "ui_title":
			return { ...view, title: ev.title };
		case "commands":
			return { ...view, commands: ev.commands };
		case "compaction":
			if (ev.phase === "start") return withNotice(view, "info", "compacting context…", now, "compaction");
			return withNotice(
				endOperation(view, "compaction"),
				ev.outcome === "failed" ? "error" : "info",
				ev.outcome === "compacted"
					? "context compacted"
					: ev.outcome === "aborted"
						? "compaction aborted"
						: ev.outcome === "skipped"
							? `nothing to compact${ev.message ? `: ${ev.message}` : ""}`
							: `compaction failed${ev.message ? `: ${ev.message}` : ""}`,
				now,
			);
		case "subagents":
			return { ...view, subagents: new Map(ev.agents.map(agent => [agent.agent.id, agent])) };
		case "subagent":
			return { ...view, subagents: new Map(view.subagents).set(ev.agent.agent.id, ev.agent) };
		case "btw_history":
			return { ...view, btw: new Map(ev.records.map(record => [record.id, record])) };
		case "btw": {
			// A new topic goes first (newest first); a known one keeps its place.
			if (view.btw.has(ev.record.id)) return { ...view, btw: new Map(view.btw).set(ev.record.id, ev.record) };
			return { ...view, btw: new Map([[ev.record.id, ev.record], ...view.btw]) };
		}
		case "editor_text":
		case "open_url":
			// One-shot attention requests: per-client UI state (see SessionStore), deliberately not part of the view.
			return view;
		case "state": {
			const next = { ...view, status: ev.status, working: ev.status.isStreaming };
			if (ev.status.isStreaming) return next;
			// Idle implies no tool can be running and no ghost is pending: heals a dropped end event.
			return {
				...next,
				activeTools: view.activeTools.size === 0 ? view.activeTools : new Map(),
				...(view.streamDone ? { stream: null, streamDone: false } : {}),
			};
		}
		case "ui":
			return view.uiRequests.some(r => r.id === ev.request.id)
				? view
				: { ...view, uiRequests: [...view.uiRequests, ev.request] };
		case "ui_end":
			return view.uiRequests.some(r => r.id === ev.requestId)
				? { ...view, uiRequests: view.uiRequests.filter(r => r.id !== ev.requestId) }
				: view;
		case "prompt_result":
			return ev.status === "error" ? withNotice(view, "error", ev.error ?? "prompt failed", now) : view;
		case "notify":
			return withNotice(view, ev.level, ev.message, now, ongoingOp(view));
		case "closed":
			return {
				...view,
				closed: ev.reason,
				working: false,
				activeTools: new Map(),
				uiRequests: [],
			};
	}
}
