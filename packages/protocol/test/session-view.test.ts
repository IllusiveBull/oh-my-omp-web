import { describe, expect, test } from "bun:test";
import type { AgentEvent, AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import {
	applySessionEvent,
	attentionOf,
	emptySessionView,
	fromSnapshot,
	toSnapshot,
	type SessionEvent,
	type SessionStatus,
	type SessionView,
} from "../src";

const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	stopReason: "stop",
	timestamp: 1,
});
const entry = (id: string, message: AssistantMessage): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00Z",
	message,
});
const agent = (event: AgentEvent): SessionEvent => ({ k: "agent", event });
const status = (isStreaming: boolean): SessionStatus => ({
	sessionId: "s",
	cwd: "/c",
	isStreaming,
	isCompacting: false,
	queue: { steering: [], followUp: [], liveSteered: 0 },
	todos: [],
});
const fold = (events: SessionEvent[], from: SessionView = emptySessionView): SessionView =>
	events.reduce((view, ev) => applySessionEvent(view, ev, 100), from);

describe("session view reducer", () => {
	test("a finished assistant message stays as a ghost until its committed entry lands, then is replaced in one step", () => {
		const done = fold([
			agent({ type: "message_start", message: assistant("") }),
			agent({ type: "message_end", message: assistant("hi") }),
		]);
		expect(done.stream?.content).toEqual([{ type: "text", text: "hi" }]);
		expect(done.streamDone).toBe(true);
		const committed = applySessionEvent(done, { k: "entries", entries: [entry("e1", assistant("hi"))] }, 100);
		expect(committed.stream).toBeNull();
		expect(committed.entries.map(e => e.id)).toEqual(["e1"]);
		// an entry that is not an assistant message does not drop the ghost
		const other = applySessionEvent(
			done,
			{ k: "entries", entries: [{ type: "model_change", id: "m", parentId: null, timestamp: "t", model: "x" }] },
			100,
		);
		expect(other.stream).not.toBeNull();
	});

	test("idle state heals a stuck ghost and stuck tool cards (dropped end events); streaming state does not", () => {
		const stuck = fold([
			agent({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {} }),
			agent({ type: "message_end", message: assistant("x") }),
		]);
		expect(fold([{ k: "state", status: status(true) }], stuck).activeTools.size).toBe(1);
		const healed = fold([{ k: "state", status: status(false) }], stuck);
		expect(healed.activeTools.size).toBe(0);
		expect(healed.stream).toBeNull();
		expect(healed.working).toBe(false);
	});

	test("tool lifecycle: start, partial update, end", () => {
		const v1 = fold([
			agent({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { cmd: "ls" } }),
		]);
		const v2 = fold(
			[agent({ type: "tool_execution_update", toolCallId: "t", toolName: "bash", args: {}, partialResult: "out" })],
			v1,
		);
		expect(v2.activeTools.get("t")).toMatchObject({
			toolName: "bash",
			args: { cmd: "ls" },
			partialResult: "out",
			startedAt: 100,
		});
		expect(
			fold([agent({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: {} })], v2).activeTools
				.size,
		).toBe(0);
	});

	test("ui requests: duplicates ignored, ui_end removes only its own, close clears them", () => {
		const req = { id: "u", method: "confirm", title: "t", message: "m" } as const;
		const v = fold([
			{ k: "ui", request: req },
			{ k: "ui", request: req },
			{ k: "ui", request: { ...req, id: "u2" } },
		]);
		expect(v.uiRequests.map(r => r.id)).toEqual(["u", "u2"]);
		expect(
			fold(
				[
					{ k: "ui_end", requestId: "u" },
					{ k: "ui_end", requestId: "missing" },
				],
				v,
			).uiRequests.map(r => r.id),
		).toEqual(["u2"]);
		const closed = fold([{ k: "closed", reason: "bye" }], v);
		expect([closed.uiRequests, closed.closed, closed.working]).toEqual([[], "bye", false]);
	});

	test("attention: an open question blocks even mid-run; an error stop or error notice once idle; a new run clears it", () => {
		const req = { id: "u", method: "confirm", title: "t", message: "m" } as const;
		const asking = fold([agent({ type: "agent_start" }), { k: "ui", request: req }]);
		expect(attentionOf(asking)).toBe("input");
		expect(attentionOf(fold([{ k: "ui_end", requestId: "u" }], asking))).toBeUndefined(); // still working
		const failed = { ...assistant("x"), stopReason: "error" as const, errorMessage: "overloaded" };
		const errored = fold([
			agent({ type: "agent_start" }),
			{ k: "entries", entries: [entry("e", failed)] },
			agent({ type: "agent_end" }),
		]);
		expect(attentionOf(errored)).toBe("error");
		expect(attentionOf(fold([agent({ type: "agent_start" })], errored))).toBeUndefined();
		expect(attentionOf(fold([{ k: "entries", entries: [entry("ok", assistant("y"))] }], errored))).toBeUndefined();
		expect(attentionOf(fold([{ k: "prompt_result", status: "error", error: "no model" } as SessionEvent]))).toBe(
			"error",
		);
		expect(attentionOf(fold([{ k: "closed", reason: "bye" }], errored))).toBeUndefined();
	});

	test("entries reset replaces the list and drops any ghost; notices are capped", () => {
		const v = fold([
			agent({ type: "message_end", message: assistant("x") }),
			{ k: "entries", reset: true, entries: [entry("a", assistant("y"))] },
		]);
		expect([v.entries.length, v.stream]).toEqual([1, null]);
		const many = fold(
			Array.from({ length: 30 }, (_, i): SessionEvent => ({ k: "notify", level: "info", message: `n${i}` })),
		);
		expect(many.notices).toHaveLength(20);
		expect(many.notices.at(-1)?.message).toBe("n29");
	});

	test("a failed prompt becomes an error notice; a completed one does not", () => {
		expect(fold([{ k: "prompt_result", status: "completed" }]).notices).toEqual([]);
		expect(fold([{ k: "prompt_result", status: "error", error: "403" }]).notices[0]).toMatchObject({
			level: "error",
			message: "403",
		});
	});

	test("snapshot round trip preserves the view", () => {
		const v = fold([
			agent({ type: "agent_start" }),
			agent({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: { path: "a" } }),
			agent({ type: "message_update", message: assistant("part") }),
			{ k: "state", status: status(true) },
		]);
		expect(toSnapshot(fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(v)))))).toEqual(toSnapshot(v));
	});

	test("status patches change the header fields only: they never end a running turn or clear a stream", () => {
		const running = fold([
			agent({ type: "agent_start" }),
			{ k: "state", status: status(true) },
			agent({ type: "message_update", message: assistant("part") }),
		]);
		const patched = fold(
			[
				{ k: "status_patch", patch: { queue: { steering: ["use X"], followUp: ["then Y"], liveSteered: 1 } } },
				{ k: "status_patch", patch: { isCompacting: true, thinkingLevel: "low" } },
			],
			running,
		);
		expect(patched.status).toMatchObject({
			isStreaming: true,
			isCompacting: true,
			thinkingLevel: "low",
			queue: { steering: ["use X"], followUp: ["then Y"], liveSteered: 1 },
		});
		expect([patched.working, patched.stream?.content]).toEqual([true, running.stream?.content]);
		// before the first state there is nothing to patch
		expect(fold([{ k: "status_patch", patch: { isCompacting: true } }]).status).toBeNull();
	});

	test("extension UI state (status lines, widgets, title), commands, and sub-agents are session state that survives a snapshot", () => {
		const agentRecord = (id: string, status: "running" | "idle") => ({
			agent: {
				id,
				displayName: id,
				kind: "sub" as const,
				status,
				hasSessionFile: true,
				createdAt: 1,
				lastActivity: 2,
			},
		});
		const view = fold([
			{ k: "ui_status", key: "git", text: "main" },
			{ k: "ui_status", key: "tmp", text: "x" },
			{ k: "ui_status", key: "tmp", text: null },
			{ k: "ui_widget", key: "plan", lines: ["a", "b"], placement: "belowEditor" },
			{ k: "ui_widget", key: "gone", lines: ["z"], placement: "aboveEditor" },
			{ k: "ui_widget", key: "gone", lines: null, placement: "aboveEditor" },
			{ k: "ui_title", title: "Working on X" },
			{ k: "commands", commands: [{ name: "compact", source: "builtin" }] },
			{ k: "subagents", agents: [agentRecord("A", "running"), agentRecord("B", "running")] },
			{ k: "subagent", agent: agentRecord("A", "idle") },
		]);
		expect([...view.statuses]).toEqual([["git", "main"]]);
		expect([...view.widgets]).toEqual([["plan", { lines: ["a", "b"], placement: "belowEditor" }]]);
		expect(view.title).toBe("Working on X");
		expect(view.commands.map(c => c.name)).toEqual(["compact"]);
		expect([...view.subagents.values()].map(a => [a.agent.id, a.agent.status])).toEqual([
			["A", "idle"],
			["B", "running"],
		]);
		const late = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(view))));
		expect(toSnapshot(late)).toEqual(toSnapshot(view));
		expect(late.statuses.get("git")).toBe("main");
		// closing the panel empties the list
		expect(fold([{ k: "subagents", agents: [] }], view).subagents.size).toBe(0);
	});

	test("one-shot attention events (editor text, open url) are not session state: the view is untouched, so snapshots never replay them", () => {
		const before = fold([{ k: "state", status: status(false) }]);
		const after = fold(
			[
				{ k: "editor_text", text: "draft this" },
				{ k: "open_url", url: "https://example.com/login" },
			],
			before,
		);
		expect(after).toBe(before);
	});

	test("a compaction's progress and the warnings raised during it are replaced by its outcome", () => {
		const running = fold([
			{ k: "state", status: status(false) },
			{ k: "status_patch", patch: { isCompacting: true } },
			{ k: "compaction", phase: "start" },
			// omp reports a fallback between the methods as an ordinary warning
			agent({ type: "notice", level: "warning", message: "snapcompact failed; trying the next method" }),
		]);
		expect(running.notices.map(n => n.message)).toEqual([
			"compacting context…",
			"snapcompact failed; trying the next method",
		]);
		const done = fold(
			[
				{ k: "status_patch", patch: { isCompacting: false } },
				{ k: "compaction", phase: "end", outcome: "compacted" },
			],
			running,
		);
		expect(done.notices.map(n => [n.level, n.message])).toEqual([["info", "context compacted"]]);
		const outcomes = (outcome: "skipped" | "failed" | "aborted", message?: string) =>
			fold([{ k: "compaction", phase: "end", outcome, message }]).notices.map(n => [n.level, n.message]);
		expect(outcomes("skipped", "Already compacted")).toEqual([["info", "nothing to compact: Already compacted"]]);
		expect(outcomes("failed", "boom")).toEqual([["error", "compaction failed: boom"]]);
		expect(outcomes("aborted")).toEqual([["info", "compaction aborted"]]);
		// automatic compaction and retries follow the same rule
		const auto = fold([
			agent({ type: "auto_compaction_start", reason: "threshold" } as never),
			agent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "overloaded" }),
			agent({ type: "auto_retry_end", success: true, attempt: 1 }),
			agent({ type: "auto_compaction_end", aborted: false, willRetry: false } as never),
		]);
		expect(auto.notices.map(n => n.message)).toEqual(["context compacted"]);
	});

	test("notices are about the current turn: the next run clears them for everyone, and a late joiner's snapshot holds the same list", () => {
		const view = fold([
			{ k: "state", status: status(false) },
			{ k: "prompt_result", status: "error", error: "Bedrock 403" },
			{ k: "notify", level: "info", message: "Usage: 12k tokens" },
		]);
		expect(view.notices.map(n => n.message)).toEqual(["Bedrock 403", "Usage: 12k tokens"]);
		// they stay until something new happens, however long the session sits idle
		const late = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(view))));
		expect(late.notices).toEqual(view.notices);
		const next = fold([agent({ type: "agent_start" })], view);
		expect(next.notices).toEqual([]);
		expect(fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(next)))).notices).toEqual([]);
		// a notice of the new run is kept
		expect(fold([{ k: "notify", level: "warning", message: "w" }], next).notices).toHaveLength(1);
	});
});
