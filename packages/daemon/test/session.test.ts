import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	applySessionEvent,
	emptySessionView,
	fromSnapshot,
	toSnapshot,
	type SequencedEvent,
	type SessionEvent,
} from "@omp-web/protocol";
import { HostedSession } from "../src/session";
import { FakeSource, loadTurn, replayTurn } from "./fake-source";
import { assistant, user } from "./session-files";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const NOW = 1_700_000_000_000;
const GOLDEN = join(import.meta.dir, "../../protocol/test/fixtures/turn-frames.json");

async function hosted(source = new FakeSource()) {
	return { source, session: await HostedSession.attach({ source, cwd: "/work/project", now: () => NOW }) };
}

const typeOf = (e: SequencedEvent): string => (e.ev.k === "agent" ? `agent:${e.ev.event.type}` : e.ev.k);

describe("HostedSession over a recorded omp turn", () => {
	test("event log: monotonic seq, one pending update at most, authoritative entries, ordered per omp", async () => {
		const fixture = await loadTurn();
		const { source, session } = await hosted();
		const live: SequencedEvent[] = [];
		session.subscribe(events => live.push(...events), 0, undefined);
		const updatesInLogDuringStream: number[] = [];
		await replayTurn(source, fixture, () => {
			updatesInLogDuringStream.push(
				session.eventsAfter(0)!.filter(e => e.ev.k === "agent" && e.ev.event.type === "message_update").length,
			);
		});
		await session.whenSynced();

		// live delivery saw every update, seq strictly increasing
		expect(live.map(e => e.seq)).toEqual(live.map(e => e.seq).toSorted((a, b) => a - b));
		expect(new Set(live.map(e => e.seq)).size).toBe(live.length);
		expect(live.filter(e => e.ev.k === "agent" && e.ev.event.type === "message_update").length).toBeGreaterThan(5);
		// but the log never holds more than the latest snapshot of the in-flight message
		expect(Math.max(...updatesInLogDuringStream)).toBe(1);
		const logged = session.eventsAfter(0)!;
		expect(logged.filter(e => e.ev.k === "agent" && e.ev.event.type === "message_update")).toHaveLength(0);

		// committed entries: exactly the renderable entries of the recording, once each, real ids, in order
		const wire = new Set([
			"message",
			"custom_message",
			"compaction",
			"branch_summary",
			"model_change",
			"thinking_level_change",
		]);
		const expected = fixture.entries.filter(e => wire.has(e.type)).map(e => e.id);
		const got = logged.flatMap(e => (e.ev.k === "entries" ? e.ev.entries.map(x => x.id) : []));
		expect(got).toEqual(expected);
		// the daemon only ever asked for entries after the previous cursor (no refetching of history)
		const order = fixture.entries.map(e => e.id);
		let cursor = -1;
		for (const since of source.entryRequests) {
			if (since === undefined) {
				expect(cursor).toBe(-1); // full-list requests only before any entry exists
				continue;
			}
			const position = order.indexOf(since);
			expect(position).toBeGreaterThanOrEqual(cursor); // known id, never moving backwards
			cursor = position;
		}
		// the final assistant message was followed by agent_end -> state(idle) only after its entry landed
		const types = logged.map(typeOf);
		const lastEntries = types.lastIndexOf("entries");
		const idleState = logged.findLastIndex(e => e.ev.k === "state" && !e.ev.status.isStreaming);
		expect(idleState).toBeGreaterThan(lastEntries);
	});

	test("snapshot for a late subscriber equals folding the whole log from an empty view", async () => {
		const fixture = await loadTurn();
		const { source, session } = await hosted();
		await replayTurn(source, fixture);
		await session.whenSynced();
		let folded = emptySessionView;
		for (const { ev } of session.eventsAfter(0)!) folded = applySessionEvent(folded, ev, NOW);
		const { result } = session.subscribe(() => {}, 0, undefined);
		expect(result.kind).toBe("snapshot");
		if (result.kind !== "snapshot") return;
		expect(result.seq).toBe(session.headSeq);
		expect(result.snapshot).toEqual(toSnapshot(folded));
		expect(result.snapshot.working).toBe(false);
		expect(result.snapshot.stream).toBeNull();
		expect(result.snapshot.activeTools).toEqual([]);
	});

	test("mid-stream snapshots carry the in-flight message / the running tool, and later events complete them", async () => {
		const fixture = await loadTurn();
		const { source, session } = await hosted();
		const joins: { at: string; seq: number; snapshot: ReturnType<typeof toSnapshot>; tail: SequencedEvent[] }[] = [];
		let updates = 0;
		await replayTurn(source, fixture, (_i, event) => {
			const at =
				event.type === "message_update" && ++updates === 3
					? "stream"
					: event.type === "tool_execution_start"
						? "tool"
						: null;
			if (!at) return;
			const tail: SequencedEvent[] = [];
			const { result } = session.subscribe(events => tail.push(...events), 0, undefined);
			if (result.kind === "snapshot") joins.push({ at, seq: result.seq, snapshot: result.snapshot, tail });
		});
		await session.whenSynced();
		const stream = joins.find(j => j.at === "stream")!;
		expect(stream.snapshot.working).toBe(true);
		expect(stream.snapshot.stream?.role).toBe("assistant");
		expect(stream.snapshot.streamDone).toBe(false);
		const tool = joins.find(j => j.at === "tool")!;
		expect(tool.snapshot.working).toBe(true);
		expect(tool.snapshot.activeTools.map(t => t.toolName)).toEqual(["read"]);

		const final = session.subscribe(() => {}, 0, undefined).result;
		if (final.kind !== "snapshot") throw new Error("expected snapshot");
		for (const join of joins) {
			// snapshot + every later live event == the final state
			let view = fromSnapshot(join.snapshot);
			for (const e of join.tail) {
				expect(e.seq).toBeGreaterThan(join.seq);
				view = applySessionEvent(view, e.ev, NOW);
			}
			expect(toSnapshot(view)).toEqual(final.snapshot);
		}
	});

	test("replay from lastSeq returns exactly the events after it; a stale or future lastSeq falls back to a snapshot", async () => {
		const fixture = await loadTurn();
		const { source, session } = await hosted();
		await replayTurn(source, fixture);
		await session.whenSynced();
		const all = session.eventsAfter(0)!;
		const mid = all[Math.floor(all.length / 2)]!.seq;
		const { result } = session.subscribe(() => {}, mid, session.epoch);
		expect(result.kind).toBe("replay");
		if (result.kind === "replay")
			expect(result.events.map(e => e.seq)).toEqual(all.filter(e => e.seq > mid).map(e => e.seq));
		expect(session.subscribe(() => {}, session.headSeq + 100, session.epoch).result.kind).toBe("snapshot");
	});

	test("golden protocol frames for the recorded turn (the web contract test replays this file)", async () => {
		const fixture = await loadTurn();
		const { source, session } = await hosted();
		// What a client connected from the start receives: every event, including each streaming snapshot.
		const events: SequencedEvent[] = [];
		session.subscribe(batch => events.push(...batch), 0, undefined);
		await replayTurn(source, fixture);
		await session.whenSynced();
		const snapshot = session.subscribe(() => {}, 0, undefined).result;
		const actual = {
			headSeq: session.headSeq,
			events,
			snapshot: snapshot.kind === "snapshot" ? snapshot.snapshot : null,
		};
		if (Bun.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN)) {
			writeFileSync(GOLDEN, `${JSON.stringify(actual, null, "\t")}\n`);
		}
		expect(JSON.parse(JSON.stringify(actual))).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
	});
});

describe("HostedSession initial state and control", () => {
	test("attach loads existing history into the snapshot, not the log, and syncs only newer entries", async () => {
		const fixture = await loadTurn();
		const history = fixture.entries.slice(0, 4) as SessionEntry[];
		const { source, session } = await hosted(new FakeSource(history as never));
		expect(session.headSeq).toBe(0);
		const snap = session.subscribe(() => {}, 0, undefined).result;
		expect(snap.kind === "snapshot" && snap.snapshot.entries.map(e => e.id)).toEqual(
			history
				.filter(e => ["message", "model_change", "thinking_level_change", "custom_message"].includes(e.type))
				.map(e => e.id),
		);
		// a prompt turn then appends only the new entries
		source.committed.push(fixture.entries[4] as never);
		source.emit({ type: "message_end", message: { role: "assistant", content: [] } } as never);
		await session.whenSynced();
		expect(source.entryRequests.at(-1)).toBe(history.at(-1)!.id);
	});

	test("oversized entries are replaced by a placeholder instead of blowing the frame limit", async () => {
		const huge = "x".repeat(3 * 1024 * 1024);
		const entry = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: {
				role: "toolResult",
				toolCallId: "t",
				toolName: "read",
				content: [{ type: "text", text: huge }],
				isError: false,
				timestamp: 1,
			},
		};
		const { session } = await hosted(new FakeSource([entry as never]));
		const snap = session.subscribe(() => {}, 0, undefined).result;
		const entries = snap.kind === "snapshot" ? snap.snapshot.entries : [];
		expect(JSON.stringify(entries).length).toBeLessThan(1.5 * 1024 * 1024);
		expect(entries[0]!.id).toBe("e1");
	});

	test("ui requests: pending ones are in snapshots, the first answer wins, display-only methods are dropped", async () => {
		const { source, session } = await hosted();
		source.emitUi({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Run rm?", message: "really" });
		source.emitUi({ type: "extension_ui_request", id: "u2", method: "setStatus", statusKey: "k", statusText: "s" });
		source.emitUi({
			type: "extension_ui_request",
			id: "u3",
			method: "notify",
			message: "heads up",
			notifyType: "warning",
		});
		const snap = session.subscribe(() => {}, 0, undefined).result;
		if (snap.kind !== "snapshot") throw new Error("expected snapshot");
		expect(snap.snapshot.uiRequests.map(r => r.id)).toEqual(["u1"]);
		expect(snap.snapshot.notices.map(n => n.message)).toEqual(["heads up"]);

		session.respondUi("u1", { confirmed: true });
		expect(source.uiResponses).toEqual([{ type: "extension_ui_response", id: "u1", confirmed: true }]);
		expect(() => session.respondUi("u1", { confirmed: false })).toThrow(/already answered/);
		const after = session.subscribe(() => {}, 0, undefined).result;
		expect(after.kind === "snapshot" && after.snapshot.uiRequests).toEqual([]);

		// omp-side cancel (timeout) clears a pending request without any client answering
		source.emitUi({ type: "extension_ui_request", id: "u4", method: "select", title: "pick", options: ["a", "b"] });
		source.emitUi({ type: "extension_ui_request", id: "c1", method: "cancel", targetId: "u4" });
		const cancelled = session.subscribe(() => {}, 0, undefined).result;
		expect(cancelled.kind === "snapshot" && cancelled.snapshot.uiRequests).toEqual([]);
		expect(() => session.respondUi("u4", { cancelled: true })).toThrow();
	});

	test("ask answers are translated to omp's response frame", async () => {
		const { source, session } = await hosted();
		source.emitUi({
			type: "extension_ui_request",
			id: "a1",
			method: "ask",
			questions: [{ id: "q", question: "which?", options: [{ label: "one" }, { label: "two" }] }],
		});
		session.respondUi("a1", { answers: [{ id: "q", selectedOptions: ["two"], customInput: "because" }] });
		expect(source.uiResponses[0]).toEqual({
			type: "extension_ui_response",
			id: "a1",
			answers: [{ id: "q", selectedOptions: ["two"], customInput: "because" }],
		});
	});

	test("form requests reach clients whole and their data goes back to omp", async () => {
		const { source, session } = await hosted();
		const html = '<form><label><input type="radio" name="db" value="pg"> Postgres</label></form>';
		source.emitUi({ type: "extension_ui_request", id: "f1", method: "form", html, timeout: 5000 });
		const snap = session.subscribe(() => {}, 0, undefined).result;
		expect(snap.kind === "snapshot" && snap.snapshot.uiRequests).toEqual([
			{ id: "f1", method: "form", html, timeout: 5000 },
		]);
		session.respondUi("f1", { data: { db: "pg", tags: ["a", "b"], n: 3 } });
		expect(source.uiResponses).toEqual([
			{ type: "extension_ui_response", id: "f1", data: { db: "pg", tags: ["a", "b"], n: 3 } },
		]);
	});

	test("a dialog method the daemon does not know is cancelled instead of left waiting", async () => {
		const { source, session } = await hosted();
		source.emitUi({ type: "extension_ui_request", id: "x1", method: "hologram", spec: {} } as never);
		expect(source.uiResponses).toEqual([{ type: "extension_ui_response", id: "x1", cancelled: true }]);
		const snap = session.subscribe(() => {}, 0, undefined).result;
		if (snap.kind !== "snapshot") throw new Error("expected snapshot");
		expect(snap.snapshot.uiRequests).toEqual([]);
		expect(snap.snapshot.notices.map(n => n.message)).toEqual([
			'omp asked for "hologram", which omp-web cannot show; it was cancelled.',
		]);
	});

	test("failed prompt surfaces as a prompt_result event; process exit closes the session and rejects commands", async () => {
		const { source, session } = await hosted();
		const seen: SessionEvent[] = [];
		session.subscribe(events => seen.push(...events.map(e => e.ev)), 0, undefined);
		source.emitPromptResult({
			type: "prompt_result",
			agentInvoked: true,
			status: "error",
			error: { message: "Bedrock HTTP 403", retryable: false },
			sessionSettled: true,
		});
		expect(seen).toContainEqual({ k: "prompt_result", status: "error", error: "Bedrock HTTP 403" });
		source.exit("omp exited with code 1");
		expect(session.info.phase).toBe("closed");
		await expect(session.prompt("hi")).rejects.toThrow(/closed/);
		const snap = session.subscribe(() => {}, 0, undefined).result;
		expect(snap.kind === "snapshot" && snap.snapshot.closed).toBe("omp exited with code 1");
	});

	test("prompt, steer and abort go to omp", async () => {
		const { source, session } = await hosted();
		await session.prompt("a");
		await session.steer("b");
		await session.abort();
		expect([source.prompts, source.steers, source.aborts]).toEqual([["a"], ["b"], 1]);
	});
});

describe("HostedSession active branch", () => {
	// u1 - a1 - u2 - a2          (abandoned by a retry)
	//        \- u2b - a2b        (current)
	const branchy = () =>
		[
			user("u1", null, "question", "2026-11-01T10:00:01.000Z"),
			assistant("a1", "u1", "answer", "2026-11-01T10:00:02.000Z"),
			user("u2", "a1", "follow-up", "2026-11-01T10:00:03.000Z"),
			assistant("a2", "u2", "first try", "2026-11-01T10:00:04.000Z"),
			user("u2b", "a1", "better follow-up", "2026-11-01T10:00:05.000Z"),
			assistant("a2b", "u2b", "second try", "2026-11-01T10:00:06.000Z"),
		] as unknown as SessionEntry[];
	const snapshotIds = (session: HostedSession): string[] => {
		const { result } = session.subscribe(() => {}, 0, undefined);
		return result.kind === "snapshot" ? result.snapshot.entries.map(e => e.id) : [];
	};
	const turnEnd = { type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] } as never;

	test("the initial view holds only the path to the leaf, whichever branch the leaf is on", async () => {
		const { session } = await hosted(new FakeSource(branchy() as never));
		expect(snapshotIds(session)).toEqual(["u1", "a1", "u2b", "a2b"]);
		const source = new FakeSource(branchy() as never);
		source.leafId = "a2"; // navigated back to the first try
		expect(snapshotIds((await hosted(source)).session)).toEqual(["u1", "a1", "u2", "a2"]);
	});

	test("entries appended at the leaf extend the view; entries written to another branch do not show", async () => {
		const { source, session } = await hosted(new FakeSource(branchy().slice(0, 2) as never));
		const live: SessionEvent[] = [];
		session.subscribe(events => live.push(...events.map(e => e.ev)), 0, undefined);
		source.committed.push(user("u2", "a1", "follow-up", "2026-11-01T10:00:03.000Z") as never);
		source.emit(turnEnd);
		await session.whenSynced();
		// a late result written to a side branch: committed, but the leaf stays on u2
		source.committed.push(assistant("side", "u1", "off to the side", "2026-11-01T10:00:09.000Z") as never);
		source.leafId = "u2";
		source.emit(turnEnd);
		await session.whenSynced();
		expect(snapshotIds(session)).toEqual(["u1", "a1", "u2"]);
		const entryEvents = live.filter((e): e is Extract<SessionEvent, { k: "entries" }> => e.k === "entries");
		expect(entryEvents.map(e => e.entries.map(x => x.id))).toEqual([["u2"]]);
		expect(entryEvents.some(e => e.reset)).toBe(false);
	});

	test("a retry that replaces the last assistant message swaps it in the view (reset), and clients that were present converge with late joiners", async () => {
		const history = branchy().slice(0, 2); // u1, a1(the failed answer)
		const { source, session } = await hosted(new FakeSource(history as never));
		const early: SequencedEvent[] = [];
		session.subscribe(events => early.push(...events), 0, undefined);
		// omp cuts the failed answer off the branch and appends the retried one as its sibling
		source.committed.push(assistant("a1retry", "u1", "answer, retried", "2026-11-01T10:00:08.000Z") as never);
		source.emit({ type: "auto_retry_end", success: true, attempt: 1 } as never);
		await session.whenSynced();
		expect(snapshotIds(session)).toEqual(["u1", "a1retry"]);
		const reset = early.map(e => e.ev).find(ev => ev.k === "entries" && ev.reset);
		expect(reset?.k === "entries" && reset.entries.map(e => e.id)).toEqual(["u1", "a1retry"]);
		let folded = emptySessionView;
		for (const { ev } of early) folded = applySessionEvent(folded, ev, NOW);
		expect(folded.entries.map(e => e.id)).toEqual(["u1", "a1retry"]);
	});

	test("navigating the tree back to an earlier entry (no new entries) re-selects that branch", async () => {
		const { source, session } = await hosted(new FakeSource(branchy() as never));
		expect(snapshotIds(session)).toEqual(["u1", "a1", "u2b", "a2b"]);
		source.leafId = "a2";
		source.emit(turnEnd);
		await session.whenSynced();
		expect(snapshotIds(session)).toEqual(["u1", "a1", "u2", "a2"]);
	});

	test("a slash command that moves the leaf without any forwarded event (tree navigation) is picked up when its prompt completes", async () => {
		const { source, session } = await hosted(new FakeSource(branchy() as never));
		expect(snapshotIds(session)).toEqual(["u1", "a1", "u2b", "a2b"]);
		source.onPrompt = () => {
			source.leafId = "a1"; // /nav-back: omp writes nothing and emits nothing
		};
		await session.prompt("/nav-back");
		await session.whenSynced();
		expect(snapshotIds(session)).toEqual(["u1", "a1"]);
		// the same for an extension command, whose acknowledgement comes before its handler ran
		source.onPrompt = undefined;
		source.leafId = "a2";
		source.emitPromptResult({
			type: "prompt_result",
			agentInvoked: false,
			status: "completed",
			sessionSettled: true,
		});
		await session.whenSynced();
		expect(snapshotIds(session)).toEqual(["u1", "a1", "u2", "a2"]);
		// an ordinary prompt does not trigger an extra look
		const requests = source.entryRequests.length;
		await session.prompt("hello");
		await session.whenSynced();
		expect(source.entryRequests.length).toBe(requests);
	});

	test("when omp no longer knows the sync cursor (file rewritten), the whole branch is reloaded instead of failing", async () => {
		const { source, session } = await hosted(new FakeSource(branchy().slice(0, 2) as never));
		source.committed = [user("n1", null, "fresh start", "2026-11-01T11:00:00.000Z") as never];
		source.emit(turnEnd);
		await session.whenSynced();
		expect(snapshotIds(session)).toEqual(["n1"]);
		const notices = (session.subscribe(() => {}, 0, undefined).result as { snapshot: { notices: unknown[] } })
			.snapshot.notices;
		expect(notices).toEqual([]);
	});
});

describe("HostedSession following a session moved to a sibling file", () => {
	const persistenceNotice = {
		type: "notice",
		level: "warning",
		message:
			"Session x.jsonl is open for writing in another omp process, so this session now saves to y.jsonl instead",
		source: "session-persistence",
	} as never;

	async function movedSession() {
		const source = new FakeSource([user("u1", null, "q", "2026-11-01T10:00:01.000Z") as never], "sess-1");
		source.state.sessionFile = "/sessions/2026-11-01_sess-1.jsonl";
		const { session } = await hosted(source);
		const seen: SequencedEvent[] = [];
		session.subscribe(events => seen.push(...events), 0, undefined);
		return { source, session, seen };
	}

	const untilEvent = async (seen: SequencedEvent[], predicate: (e: SequencedEvent) => boolean) => {
		for (let i = 0; i < 200 && !seen.some(predicate); i++) await Bun.sleep(5);
		expect(seen.some(predicate)).toBe(true);
	};

	test("a session-persistence notice makes the hosted session follow the new session id and file, keep its own id, and tell the user", async () => {
		const { source, session, seen } = await movedSession();
		expect(session.info).toMatchObject({
			id: "sess-1",
			sessionId: "sess-1",
			file: "/sessions/2026-11-01_sess-1.jsonl",
		});
		// omp moved the session: same transcript in memory, new id, new file
		source.state.sessionId = "sess-2";
		source.state.sessionFile = "/sessions/2026-11-01_sess-2.jsonl";
		source.emit(persistenceNotice);
		await untilEvent(seen, e => e.ev.k === "state" && e.ev.status.sessionId === "sess-2");

		expect(session.id).toBe("sess-1"); // the id clients hold stays valid
		expect(session.info).toMatchObject({
			id: "sess-1",
			sessionId: "sess-2",
			file: "/sessions/2026-11-01_sess-2.jsonl",
		});
		const kinds = seen.map(e => e.ev.k);
		const notify = seen.find(e => e.ev.k === "notify")!.ev;
		expect(notify.k === "notify" && notify.level).toBe("warning");
		expect(notify.k === "notify" && notify.message).toContain("2026-11-01_sess-2.jsonl");
		// told first, then the list is reloaded from the new file, then the header moves
		expect(kinds.indexOf("notify")).toBeLessThan(kinds.indexOf("entries"));
		expect(kinds.indexOf("entries")).toBeLessThan(kinds.indexOf("state"));
		const snapshot = session.subscribe(() => {}, 0, undefined).result;
		expect(snapshot.kind === "snapshot" && snapshot.snapshot.status).toMatchObject({
			sessionId: "sess-2",
			sessionFile: "/sessions/2026-11-01_sess-2.jsonl",
		});
	});

	test("a notice from another source, or one that changes nothing, does not repoint", async () => {
		const { source, session, seen } = await movedSession();
		source.emit({ type: "notice", level: "info", message: "hello", source: "something-else" } as never);
		source.emit(persistenceNotice); // omp reported it, but get_state still names the same file
		await Bun.sleep(30);
		expect(session.info.sessionId).toBe("sess-1");
		expect(seen.filter(e => e.ev.k === "state")).toEqual([]);
		expect(seen.filter(e => e.ev.k === "notify")).toEqual([]);
	});
});

describe("HostedSession shared state (queue, todos, model, thinking, compaction, name)", () => {
	const snapshotOf = (session: HostedSession) => {
		const { result } = session.subscribe(() => {}, 0, undefined);
		if (result.kind !== "snapshot") throw new Error("expected snapshot");
		return result.snapshot;
	};
	const settle = () => Bun.sleep(10);

	test("the queue follows omp's queue_update events live, and a late joiner sees the same queue in its snapshot", async () => {
		const { source, session } = await hosted();
		const seen: SessionEvent[] = [];
		session.subscribe(events => seen.push(...events.map(e => e.ev)), 0, undefined);
		source.emit({ type: "agent_start" } as never);
		source.state.isStreaming = true;
		await settle(); // omp answers get_state before it later changes the queue
		source.emitQueue(["use the parser"], ["then add tests"]);
		await settle();
		const status = snapshotOf(session).status!;
		expect(status.queue).toEqual({ steering: ["use the parser"], followUp: ["then add tests"], liveSteered: 0 });
		expect(snapshotOf(session).working).toBe(true); // a patch never ends the running turn
		// a repeated identical update is not republished
		const before = seen.length;
		source.emitQueue(["use the parser"], ["then add tests"]);
		await settle();
		expect(seen.slice(before).filter(e => e.k === "status_patch")).toEqual([]);
		source.emitQueue([], []);
		await settle();
		expect(snapshotOf(session).status!.queue).toEqual({ steering: [], followUp: [], liveSteered: 0 });
	});

	test("the status line's time worked adds up the runs; spend and context use are read after each run", async () => {
		let now = 1_000;
		const paid = (id: string, parentId: string | null, cost: number) => {
			const entry = assistant(id, parentId, id, "2026-11-01T10:00:00.000Z");
			entry.message.usage.cost.total = cost;
			return entry as unknown as SessionEntry;
		};
		const source = new FakeSource([
			user("u1", null, "hi", "2026-11-01T10:00:00.000Z") as never,
			paid("a1", "u1", 0.3),
		]);
		const session = await HostedSession.attach({ source, cwd: "/work/project", now: () => now });
		expect(snapshotOf(session).status!.activeMs).toBeUndefined();
		expect(snapshotOf(session).status!.cost).toBe(0.3);
		source.emit({ type: "agent_start" } as never);
		await settle();
		expect(snapshotOf(session).status!.activeSince).toBe(1_000);
		now = 4_500;
		// A compaction drops a1 from the context; its spend stays, and the compaction's own model call adds to it.
		source.committed.push(
			{
				type: "compaction",
				id: "c1",
				parentId: "a1",
				timestamp: "2026-11-01T10:00:01.000Z",
				summary: "s",
				firstKeptEntryId: "c1",
				tokensBefore: 1,
			} as never,
			{
				type: "model_usage",
				id: "m1",
				parentId: "c1",
				timestamp: "2026-11-01T10:00:01.000Z",
				usage: { cost: { total: 0.02 } },
			} as never,
			paid("a2", "m1", 0.1),
		);
		source.state.contextUsage = { tokens: 29_000, contextWindow: 1_000_000, percent: 2.9 } as never;
		source.emit({ type: "agent_end", messages: [] } as never);
		for (let i = 0; i < 200 && (snapshotOf(session).status?.cost ?? 0) < 0.4; i++) await settle();
		let status = snapshotOf(session).status!;
		expect(status.activeMs).toBe(3_500);
		expect(status.activeSince).toBeUndefined();
		expect(status.cost).toBeCloseTo(0.42);
		expect(status.contextUsage).toEqual({ label: "2.9%/1M", level: "normal", percent: 2.9 });
		// idle time between runs does not count
		now = 100_000;
		source.emit({ type: "agent_start" } as never);
		await settle();
		now = 101_000;
		source.emit({ type: "agent_end", messages: [] } as never);
		await settle();
		status = snapshotOf(session).status!;
		expect(status.activeMs).toBe(4_500);
	});

	test("todos, model, thinking level and session name come from get_state when their signal event arrives", async () => {
		const { source, session } = await hosted();
		const phases = [{ name: "Build", tasks: [{ content: "write it", status: "in_progress", notes: ["private"] }] }];
		source.state.todoPhases = phases as never;
		source.emit({ type: "tool_execution_end", toolCallId: "t", toolName: "todo", result: {} } as never);
		await settle();
		// per-task notes/details are not part of the shared state
		expect(snapshotOf(session).status!.todos).toEqual([
			{ name: "Build", tasks: [{ content: "write it", status: "in_progress" }] },
		]);

		source.state.todoPhases = [];
		source.emit({ type: "todo_auto_clear" } as never);
		await settle();
		expect(snapshotOf(session).status!.todos).toEqual([]);

		source.state.model = { provider: "anthropic", id: "claude-haiku-4-5" } as never;
		source.emit({ type: "model_changed" } as never);
		await settle();
		expect(snapshotOf(session).status!.model).toBe("anthropic/claude-haiku-4-5");
		expect(session.info.model).toBe("anthropic/claude-haiku-4-5");

		source.state.thinkingLevel = "low" as never;
		source.emit({ type: "thinking_level_changed", thinkingLevel: "low" } as never);
		await settle();
		expect(snapshotOf(session).status!.thinkingLevel).toBe("low");

		// a builtin slash command renamed the session
		source.state.sessionName = "Parser work";
		source.emitSide({ type: "session_info_update" });
		await settle();
		expect(snapshotOf(session).status!.sessionName).toBe("Parser work");
		expect(session.info.title).toBe("Parser work");
	});

	test("manual compaction is visible to everyone while it runs and when it ends, and the compaction entry is synced", async () => {
		const { source, session } = await hosted(
			new FakeSource([user("u1", null, "q", "2026-11-01T10:00:01.000Z") as never]),
		);
		const seen: SessionEvent[] = [];
		session.subscribe(events => seen.push(...events.map(e => e.ev)), 0, undefined);
		source.emit({ type: "manual_compaction_start" } as never);
		await settle();
		expect(snapshotOf(session).status!.isCompacting).toBe(true);
		source.committed.push({
			type: "compaction",
			id: "c1",
			parentId: "u1",
			timestamp: "2026-11-01T10:00:09.000Z",
			summary: "s",
			firstKeptEntryId: "u1",
			tokensBefore: 10,
		} as never);
		source.emit({ type: "manual_compaction_end", aborted: false, result: {} } as never);
		await session.whenSynced();
		await settle();
		expect(snapshotOf(session).status!.isCompacting).toBe(false);
		expect(seen.filter(e => e.k === "compaction")).toEqual([
			{ k: "compaction", phase: "start" },
			{ k: "compaction", phase: "end", outcome: "compacted", message: undefined },
		]);
		expect(snapshotOf(session).entries.map(e => e.id)).toEqual(["u1", "c1"]);
		source.emit({
			type: "manual_compaction_end",
			aborted: false,
			skipped: true,
			errorMessage: "Already compacted",
		} as never);
		expect(seen.at(-1)).toMatchObject({ k: "compaction", outcome: "skipped", message: "Already compacted" });
	});
});

describe("HostedSession extension UI state", () => {
	const snapshotOf = (session: HostedSession) => {
		const { result } = session.subscribe(() => {}, 0, undefined);
		if (result.kind !== "snapshot") throw new Error("expected snapshot");
		return result.snapshot;
	};
	const ui = (request: object) => ({ type: "extension_ui_request", id: `r${Math.random()}`, ...request }) as never;

	test("status lines, widgets and the title persist in snapshots until cleared; the placement defaults to above the editor", async () => {
		const { source, session } = await hosted();
		source.emitUi(ui({ method: "setStatus", statusKey: "git", statusText: "main ✓" }));
		source.emitUi(ui({ method: "setStatus", statusKey: "tmp", statusText: "x" }));
		source.emitUi(ui({ method: "setStatus", statusKey: "tmp" })); // statusText undefined clears
		source.emitUi(ui({ method: "setWidget", widgetKey: "plan", widgetLines: ["step 1", "step 2"] }));
		source.emitUi(
			ui({ method: "setWidget", widgetKey: "foot", widgetLines: ["bye"], widgetPlacement: "belowEditor" }),
		);
		source.emitUi(ui({ method: "setWidget", widgetKey: "foot" })); // cleared
		source.emitUi(ui({ method: "setTitle", title: "Refactoring" }));
		const snap = snapshotOf(session);
		expect(snap.statuses).toEqual([{ key: "git", text: "main ✓" }]);
		expect(snap.widgets).toEqual([{ key: "plan", lines: ["step 1", "step 2"], placement: "aboveEditor" }]);
		expect(snap.title).toBe("Refactoring");
	});

	test("what an extension can put into every client's state is bounded", async () => {
		const { source, session } = await hosted();
		source.emitUi(
			ui({
				method: "setWidget",
				widgetKey: "big",
				widgetLines: Array.from({ length: 500 }, () => "y".repeat(5000)),
			}),
		);
		const [widget] = snapshotOf(session).widgets;
		expect(widget!.lines).toHaveLength(100);
		expect(widget!.lines[0]!.length).toBe(2000);
	});

	test("set_editor_text and open_url are one-shot events: delivered to who is connected, never part of a snapshot", async () => {
		const { source, session } = await hosted();
		const live: SessionEvent[] = [];
		session.subscribe(events => live.push(...events.map(e => e.ev)), 0, undefined);
		source.emitUi(ui({ method: "set_editor_text", text: "refactor the parser" }));
		source.emitUi(
			ui({
				method: "open_url",
				url: "https://auth.example/authorize?x=1",
				launchUrl: "http://127.0.0.1:9/go",
				instructions: "Sign in",
			}),
		);
		expect(live).toContainEqual({ k: "editor_text", text: "refactor the parser" });
		expect(live).toContainEqual({
			k: "open_url",
			url: "https://auth.example/authorize?x=1",
			launchUrl: "http://127.0.0.1:9/go",
			instructions: "Sign in",
		});
		const late = snapshotOf(session);
		expect(JSON.stringify(late)).not.toContain("refactor the parser");
		expect(JSON.stringify(late)).not.toContain("auth.example");
	});

	test("open_url never offers anything but a web URL: other schemes become a warning, an unusable launch URL is dropped", async () => {
		const { source, session } = await hosted();
		const live: SessionEvent[] = [];
		session.subscribe(events => live.push(...events.map(e => e.ev)), 0, undefined);
		source.emitUi(ui({ method: "open_url", url: "javascript:alert(document.cookie)" }));
		source.emitUi(ui({ method: "open_url", url: "file:///etc/passwd" }));
		expect(live.filter(e => e.k === "open_url")).toEqual([]);
		expect(live.filter(e => e.k === "notify")).toHaveLength(2);
		source.emitUi(ui({ method: "open_url", url: "https://ok.example/", launchUrl: "javascript:void(0)" }));
		expect(live.at(-1)).toMatchObject({ k: "open_url", url: "https://ok.example/" });
		expect((live.at(-1) as { launchUrl?: string }).launchUrl).toBeUndefined();
	});
});

describe("HostedSession controls", () => {
	const snapshotOf = (session: HostedSession) => {
		const { result } = session.subscribe(() => {}, 0, undefined);
		if (result.kind !== "snapshot") throw new Error("expected snapshot");
		return result.snapshot;
	};
	const cmd = (name: string) => ({ name, source: "builtin" as const, description: `${name} command` });

	test("the slash-command list is part of the state: seeded at attach, replaced when omp pushes an update", async () => {
		const source = new FakeSource();
		source.commands = [cmd("compact"), cmd("model")];
		const { session } = await hosted(source);
		expect(snapshotOf(session).commands.map(c => c.name)).toEqual(["compact", "model"]);
		source.emitCommands([cmd("compact"), cmd("model"), { name: "skill:review", source: "skill" }]);
		expect(snapshotOf(session).commands.map(c => c.name)).toEqual(["compact", "model", "skill:review"]);
	});

	test("command output of builtin slash commands reaches every client as a notice", async () => {
		const { source, session } = await hosted();
		source.emitSide({ type: "command_output", text: "Usage: 12k tokens" });
		expect(snapshotOf(session).notices.map(n => n.message)).toEqual(["Usage: 12k tokens"]);
	});

	test("the /context report goes to the client that asked, not into everyone's notices", async () => {
		const { source, session } = await hosted();
		source.onPrompt = message => {
			// omp writes the output frame after answering the command, as the stdout tap may deliver it
			if (message === "/context")
				setTimeout(
					() => source.emitSide({ type: "command_output", text: "Context window: 200000 tokens (3% used)" }),
					5,
				);
		};
		expect(await session.context()).toBe("Context window: 200000 tokens (3% used)");
		expect(source.prompts).toEqual(["/context"]);
		expect(snapshotOf(session).notices).toEqual([]);
		// later command output is a shared notice again
		source.emitSide({ type: "command_output", text: "Usage: 12k tokens" });
		expect(snapshotOf(session).notices.map(n => n.message)).toEqual(["Usage: 12k tokens"]);
	});

	test("each model carries the thinking settings omp's model hub offers for a role on it", async () => {
		const source = new FakeSource();
		source.models = [
			{ provider: "a", id: "ladder", reasoning: true, thinking: { efforts: ["low", "high"] } } as never,
			{
				provider: "a",
				id: "unverified",
				reasoning: true,
				thinking: { efforts: ["high"], unverified: true },
			} as never,
			{ provider: "a", id: "plain", reasoning: false } as never,
		];
		const { session } = await hosted(source);
		const { models } = await session.options();
		expect(models.map(m => m.thinking.map(t => t.value))).toEqual([
			["inherit", "off", "auto", "low", "high"],
			["inherit", "off", "high"],
			[],
		]);
		expect(models[0]!.thinking[0]).toEqual({
			value: "inherit",
			label: "inherit",
			description: "Inherit session default",
		});
	});

	test("options lists the models and thinking levels; switching model and level goes to omp and lands in the shared state", async () => {
		const source = new FakeSource();
		source.models = [
			{ provider: "anthropic", id: "claude-haiku-4-5", contextWindow: 200_000, reasoning: true } as never,
			{ provider: "anthropic", id: "claude-sonnet-5", contextWindow: null, reasoning: true } as never,
		];
		const { session } = await hosted(source);
		const options = await session.options();
		expect(options.models.map(m => `${m.provider}/${m.id}`)).toEqual([
			"anthropic/claude-haiku-4-5",
			"anthropic/claude-sonnet-5",
		]);
		expect(options.models[1]!.contextWindow).toBeUndefined();
		expect(options.thinkingLevels).toEqual(["off", "low", "high"]);

		await session.setModel("anthropic", "claude-sonnet-5");
		expect(source.modelCalls).toEqual(["anthropic/claude-sonnet-5"]);
		expect(snapshotOf(session).status!.model).toBe("anthropic/claude-sonnet-5");
		await session.setThinking("low");
		expect(source.thinkingCalls).toEqual(["low"]);
		expect(snapshotOf(session).status!.thinkingLevel).toBe("low");
		// a level the live model does not offer never reaches omp
		await expect(session.setThinking("max")).rejects.toThrow(/not available/);
		expect(source.thinkingCalls).toEqual(["low"]);
	});

	test("compact, follow-up and queue removal are passed to omp", async () => {
		const { source, session } = await hosted();
		await session.compact("keep the API notes");
		await session.compact();
		await session.followUp("later");
		expect(await session.removeQueued("later", "followUp")).toBe(true);
		expect([source.compactions, source.followUps, source.removed]).toEqual([
			["keep the API notes", undefined],
			["later"],
			[{ message: "later", queue: "followUp" }],
		]);
	});
});

describe("HostedSession sub-agent panel", () => {
	const progress = (id: string, status: "running" | "completed", tool?: string) => ({
		index: 0,
		agent: "task",
		task: "audit",
		progress: {
			index: 0,
			id,
			agent: "task",
			status,
			task: "audit",
			currentTool: tool,
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 1,
			tokens: 10,
			cost: 0,
			durationMs: 5,
		},
		sessionFile: `/tmp/${id}.jsonl`,
	});
	const snapshotAgents = (session: HostedSession) => {
		const { result } = session.subscribe(() => {}, 0, undefined);
		return result.kind === "snapshot" ? result.snapshot.subagents.map(a => [a.agent.id, a.agent.status]) : [];
	};

	async function withSession(sessionFile?: string) {
		const source = new FakeSource();
		source.state.sessionFile = sessionFile;
		source.subagents = [
			{
				id: "Auditor",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: "audit",
				sessionFile: "/tmp/Auditor.jsonl",
				lastUpdate: 1000,
				progress: progress("Auditor", "running").progress,
			} as never,
		];
		const session = await HostedSession.attach({ source, cwd: "/w", now: () => 5000, subagentFlushMs: 5 });
		return { source, session };
	}

	test("omp is asked for sub-agent frames while somebody has the panel open, and only then", async () => {
		const { source, session } = await withSession();
		const a = {};
		const b = {};
		// frames before anybody looks are not tracked
		source.emitSubagentProgress(progress("Early", "running") as never);
		await Bun.sleep(15);
		expect(snapshotAgents(session)).toEqual([]);

		await session.setAgentPanel(a, true);
		expect(source.subscriptionCalls).toEqual(["progress"]);
		expect(snapshotAgents(session)).toEqual([["Auditor", "running"]]); // registry snapshot loaded at open
		await session.setAgentPanel(b, true); // a second panel does not re-subscribe
		await session.setAgentPanel(a, false);
		expect(source.subscriptionCalls).toEqual(["progress"]);
		expect(source.subscription).toBe("progress");
		await session.setAgentPanel(b, false);
		expect(source.subscriptionCalls).toEqual(["progress", "off"]);
		expect(snapshotAgents(session)).toEqual([]);
		// closing twice is harmless
		await session.setAgentPanel(b, false);
		expect(source.subscriptionCalls).toEqual(["progress", "off"]);
	});

	test("a subscription that timed out is retried by the next panel call instead of failing every later one", async () => {
		const { source, session } = await withSession();
		const subscribe = source.setSubagentSubscription.bind(source);
		let busy = true;
		source.setSubagentSubscription = async level => {
			if (busy) throw new Error("Timeout waiting for response to set_subagent_subscription. Stderr: ");
			await subscribe(level);
		};
		const a = {};
		await expect(session.setAgentPanel(a, true)).rejects.toThrow("Timeout waiting");
		expect(snapshotAgents(session)).toEqual([]);
		busy = false;
		// the client reopens (or resubscribes): same owner, omp answers now
		await session.setAgentPanel(a, true);
		expect(source.subscriptionCalls).toEqual(["progress"]);
		expect(snapshotAgents(session)).toEqual([["Auditor", "running"]]);
		await session.setAgentPanel(a, false);
		expect(source.subscriptionCalls).toEqual(["progress", "off"]);
	});

	test("progress and lifecycle frames update the panel in batches: bursts for one agent publish its latest state once", async () => {
		const { source, session } = await withSession();
		const seen: SessionEvent[] = [];
		await session.setAgentPanel({}, true);
		session.subscribe(events => seen.push(...events.map(e => e.ev)), 0, undefined);
		for (const tool of ["read", "grep", "edit"])
			source.emitSubagentProgress(progress("Auditor", "running", tool) as never);
		source.emitSubagentLifecycle({ id: "Worker", agent: "task", status: "started", index: 1 } as never);
		await Bun.sleep(20);
		const updates = seen.filter(e => e.k === "subagent");
		expect(updates).toHaveLength(2); // one per agent, not one per frame
		const auditor = updates.find(e => e.k === "subagent" && e.agent.agent.id === "Auditor");
		expect(auditor?.k === "subagent" && auditor.agent.progress?.progress.currentTool).toBe("edit");
		expect(snapshotAgents(session).toSorted()).toEqual([
			["Auditor", "running"],
			["Worker", "running"],
		]);
		source.emitSubagentProgress(progress("Auditor", "completed") as never);
		await Bun.sleep(20);
		expect(snapshotAgents(session).find(([id]) => id === "Auditor")?.[1]).toBe("idle");
	});

	test("a session whose background work will wake it again counts as working after its reply", async () => {
		const source = new FakeSource();
		source.state.hasPendingAsyncWork = true; // a background sub-agent still runs
		const session = await HostedSession.attach({ source, cwd: "/w", now: () => 5000 });
		expect(session.info.phase).toBe("working");
		source.state.hasPendingAsyncWork = false;
		source.emit({ type: "agent_end", messages: [] } as never);
		await session.whenSynced();
		expect(session.info.phase).toBe("idle");
		await session.close();
	});

	test("a sub-agent's start comes from omp's run time, not from when the panel first saw it", async () => {
		const { source, session } = await withSession();
		await session.setAgentPanel({}, true);
		const late = progress("Worker", "running");
		late.progress.durationMs = 60_000; // started a minute before this frame (the session clock reads 5000)
		source.emitSubagentProgress(late as never);
		await Bun.sleep(20);
		const { result } = session.subscribe(() => {}, 0, undefined);
		if (result.kind !== "snapshot") throw new Error("expected snapshot");
		expect(result.snapshot.subagents.find(a => a.agent.id === "Worker")?.agent.createdAt).toBe(5000 - 60_000);
	});

	test("the panel lists the sub-agents omp forgot from their transcripts: finished, killed, nested; live ones win", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-web-agents-"));
		const lines = (...entries: unknown[]) => entries.map(entry => `${JSON.stringify(entry)}\n`).join("");
		const header = (at: string) => ({ type: "session", version: 3, id: "h", timestamp: at, cwd: "/w" });
		const said = (at: string, stopReason: string, tools: string[] = []) => ({
			type: "message",
			id: at,
			parentId: null,
			timestamp: at,
			message: {
				role: "assistant",
				stopReason,
				content: tools.map((name, i) => ({ type: "toolCall", id: `c${i}`, name, arguments: {} })),
			},
		});
		const main = join(dir, "main");
		mkdirSync(join(main, "Done"), { recursive: true });
		// yielded: finished normally
		writeFileSync(
			join(main, "Done.jsonl"),
			lines(header("2026-11-01T10:00:00.000Z"), said("2026-11-01T10:05:00.000Z", "toolUse", ["yield"])),
		);
		// killed mid-tool: its last turn asked for a tool and nothing followed
		writeFileSync(
			join(main, "Killed.jsonl"),
			lines(header("2026-11-01T10:01:00.000Z"), said("2026-11-01T10:02:00.000Z", "toolUse", ["bash"])),
		);
		// killed while streaming
		writeFileSync(
			join(main, "Done", "Done.Child.jsonl"),
			lines(header("2026-11-01T10:03:00.000Z"), said("2026-11-01T10:04:00.000Z", "aborted")),
		);
		// still running in omp: its registry entry wins over the transcript
		writeFileSync(
			join(main, "Auditor.jsonl"),
			lines(header("2026-11-01T10:00:00.000Z"), said("2026-11-01T10:00:01.000Z", "toolUse", ["read"])),
		);
		writeFileSync(join(main, "changes.jsonl"), lines({ type: "call", agent: "Main" })); // not a transcript
		writeFileSync(join(main, "__advisor.jsonl"), lines(header("2026-11-01T10:00:00.000Z")));
		try {
			const { session } = await withSession(`${main}.jsonl`);
			await session.setAgentPanel({}, true);
			expect(snapshotAgents(session).toSorted()).toEqual([
				["Auditor", "running"],
				["Done", "idle"],
				["Done.Child", "aborted"],
				["Killed", "aborted"],
			]);
			const { result } = session.subscribe(() => {}, 0, undefined);
			if (result.kind !== "snapshot") throw new Error("expected snapshot");
			const killed = result.snapshot.subagents.find(a => a.agent.id === "Killed")!.agent;
			expect([killed.createdAt, killed.lastActivity]).toEqual([
				Date.parse("2026-11-01T10:01:00.000Z"),
				Date.parse("2026-11-01T10:02:00.000Z"),
			]);
			// its transcript is read from the file the scan found
			const transcript = await session.agentTranscript("Killed");
			expect(transcript.entries.length).toBeGreaterThan(0);
			await session.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("spend is split like omp's status line: own, sub-agents (finished and live) and premium requests", async () => {
		const paid = assistant("a1", null, "hi", "2026-11-01T10:00:00.000Z");
		paid.message.usage.cost.total = 0.3;
		(paid.message.usage as { premiumRequests?: number }).premiumRequests = 2;
		const taskResult = {
			type: "message",
			id: "t1",
			parentId: "a1",
			timestamp: "2026-11-01T10:00:01.000Z",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "task",
				content: [],
				isError: false,
				timestamp: 1,
				details: { usage: { cost: { total: 0.5 }, premiumRequests: 1 } },
			},
		};
		const source = new FakeSource([paid as never, taskResult as never]);
		const session = await HostedSession.attach({ source, cwd: "/w", now: () => 5000, subagentFlushMs: 5 });
		const spend = () => {
			const { result } = session.subscribe(() => {}, 0, undefined);
			if (result.kind !== "snapshot") throw new Error("expected snapshot");
			const { cost, subagentCost, premiumRequests } = result.snapshot.status!;
			const cents = (n: number | undefined) => (n === undefined ? n : Math.round(n * 100) / 100);
			return { cost: cents(cost), subagentCost: cents(subagentCost), premiumRequests };
		};
		expect(spend()).toEqual({ cost: 0.3, subagentCost: 0.5, premiumRequests: 3 });
		// A watched sub-agent that has spent more than the finished task results raises the sub-agent total live.
		await session.setAgentPanel({}, true);
		const running = progress("Auditor", "running");
		running.progress.cost = 0.9;
		source.emitSubagentProgress(running as never);
		await Bun.sleep(20);
		expect(spend()).toEqual({ cost: 0.3, subagentCost: 0.9, premiumRequests: 3 });
	});

	test("background sub-agents' spend is read from their transcripts on disk, so it survives a restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-web-tree-"));
		const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
		const paid = (id: string, total: number) => {
			const entry = assistant(id, null, "hi", "2026-11-01T10:00:00.000Z");
			entry.message.usage.cost.total = total;
			return line(entry);
		};
		// A sub-agent's own `task` result is its child's spend: counted from the child's transcript, not twice.
		const childResult = line({
			type: "message",
			id: "t1",
			parentId: "w1",
			message: { role: "toolResult", toolName: "task", details: { usage: { cost: { total: 0.2 } } } },
		});
		mkdirSync(join(dir, "main", "Worker"), { recursive: true });
		writeFileSync(join(dir, "main", "Worker.jsonl"), paid("w1", 0.7) + childResult);
		writeFileSync(join(dir, "main", "Worker", "Child.jsonl"), paid("c1", 0.2));
		writeFileSync(join(dir, "main", "__advisor.jsonl"), paid("a1", 5)); // the main session's advisor: billed apart
		try {
			const source = new FakeSource();
			source.state.sessionFile = join(dir, "main.jsonl");
			const session = await HostedSession.attach({ source, cwd: "/w", now: () => 5000 });
			const subagentCost = () => {
				const { result, unsubscribe } = session.subscribe(() => {}, 0, undefined);
				unsubscribe();
				if (result.kind !== "snapshot") throw new Error("expected snapshot");
				const cost = result.snapshot.status!.subagentCost;
				return cost === undefined ? cost : Math.round(cost * 100) / 100;
			};
			/** Resolves once the published status carries `expected` (the scan runs off the attach / run-end path). */
			const reaches = (expected: number): Promise<void> => {
				const { promise, resolve } = Promise.withResolvers<void>();
				const check = () => {
					if (subagentCost() !== expected) return;
					stop();
					resolve();
				};
				const { unsubscribe: stop } = session.subscribe(check, session.headSeq, session.epoch);
				check();
				return promise;
			};
			await reaches(0.9);
			// A run's end rescans: what a sub-agent appended since counts.
			appendFileSync(join(dir, "main", "Worker.jsonl"), paid("w2", 0.4));
			source.emit({ type: "agent_end", messages: [] } as never);
			await reaches(1.3);
			await session.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a scheduled tariff's period is in the status and flips at its transition without any event", async () => {
		let now = Date.parse("2026-09-10T03:59:59.990Z"); // DeepSeek's discount starts at 04:00 UTC
		const source = new FakeSource();
		source.state.model = getBundledModel("deepseek", "deepseek-v4-flash");
		const session = await HostedSession.attach({ source, cwd: "/w", now: () => now });
		const period = () => {
			const { result } = session.subscribe(() => {}, 0, undefined);
			return result.kind === "snapshot" ? result.snapshot.status?.pricingPeriod : undefined;
		};
		expect(period()).toBe("peak");
		now = Date.parse("2026-09-10T04:00:00.000Z");
		await Bun.sleep(30); // the transition timer is 10ms of real time
		expect(period()).toBe("off-peak");
		await session.close();
	});

	test("a sub-agent transcript is read incrementally through omp and reduced to renderable entries", async () => {
		const { source, session } = await withSession();
		source.subagentTranscripts.set("Auditor", {
			sessionFile: "/tmp/Auditor.jsonl",
			fromByte: 0,
			nextByte: 321,
			reset: false,
			entries: [
				{ type: "session", id: "hdr", version: 3, timestamp: "t", cwd: "/w" },
				user("u1", null, "audit this", "2026-11-01T10:00:01.000Z"),
				{ type: "custom", id: "c1", parentId: "u1", customType: "x", data: 1, timestamp: "t" },
				assistant("a1", "u1", "done", "2026-11-01T10:00:02.000Z"),
			] as never,
			messages: [],
		});
		const result = await session.agentTranscript("Auditor");
		expect(result.entries.map(e => e.id)).toEqual(["u1", "a1"]);
		expect([result.startByte, result.nextByte, result.reset]).toEqual([0, 321, false]);
		expect(source.transcriptReads).toEqual([{ id: "Auditor", fromByte: 0 }]);
		await expect(session.agentTranscript("Nobody")).rejects.toThrow(/unknown subagent/);
	});

	test("once the transcript's path is known the daemon reads it itself, latest page first", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-web-transcript-"));
		const file = join(dir, "Auditor.jsonl");
		const lines = Array.from({ length: 300 }, (_, i) =>
			JSON.stringify(user(`u${i}`, null, "x".repeat(2000), "2026-11-01T10:00:01.000Z")),
		);
		writeFileSync(file, `${lines.join("\n")}\n`);
		try {
			const { source, session } = await withSession();
			await session.setAgentPanel({}, true);
			source.emitSubagentProgress({ ...progress("Auditor", "running"), sessionFile: file } as never);
			const latest = await session.agentTranscript("Auditor");
			expect(latest.entries.at(-1)?.id).toBe("u299");
			expect(latest.startByte).toBeGreaterThan(0);
			expect(latest.nextByte).toBe(Bun.file(file).size);
			const earlier = await session.agentTranscript("Auditor", { beforeByte: latest.startByte });
			expect(earlier.nextByte).toBe(latest.startByte!);
			expect(earlier.entries.at(-1)?.id).toBe(`u${299 - latest.entries.length}`);
			appendFileSync(file, `${JSON.stringify(user("u300", null, "new", "2026-11-01T10:00:02.000Z"))}\n{"torn`);
			const next = await session.agentTranscript("Auditor", { fromByte: latest.nextByte });
			expect(next.entries.map(e => e.id)).toEqual(["u300"]);
			expect(next.nextByte).toBe(Bun.file(file).size - '{"torn'.length);
			expect(source.transcriptReads).toEqual([]); // omp was never asked
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("HostedSession: /btw side questions", () => {
	const topic = (id: string, question: string) => ({
		id,
		leafId: null,
		question,
		answer: "earlier answer",
		status: "complete" as const,
		createdAt: 1,
		updatedAt: 2,
	});

	test("the history omp keeps is in the first snapshot; a streamed answer reaches clients and the log keeps its newest state only", async () => {
		const source = new FakeSource();
		source.btwHistory = [topic("old", "what is X?")];
		const { session } = await hosted(source);
		const joined = session.subscribe(() => {}, 0, undefined).result;
		if (joined.kind !== "snapshot") throw new Error("a fresh subscriber gets a snapshot");
		let view = fromSnapshot(joined.snapshot);
		expect([...view.btw.keys()]).toEqual(["old"]);

		const started = await session.btw("and Y?");
		expect(source.btwCalls).toEqual([{ question: "and Y?" }]);
		source.emitBtwDelta(started.id, "Y is ");
		source.emitBtwDelta(started.id, "fine.");
		await Bun.sleep(150); // deltas are published at most every 100 ms
		view = session.eventsAfter(0)!.reduce((v, e) => applySessionEvent(v, e.ev, NOW), view);
		expect([...view.btw.keys()]).toEqual([started.id, "old"]); // the new topic goes first
		expect(view.btw.get(started.id)).toMatchObject({ status: "running", answer: "Y is fine." });

		source.emitBtwRecord({ ...topic(started.id, "and Y?"), answer: "Y is fine.", status: "complete" });
		const logged = session.eventsAfter(0)!.filter(e => e.ev.k === "btw");
		expect(logged).toHaveLength(1);
		expect(logged[0]!.ev).toMatchObject({
			k: "btw",
			record: { id: started.id, status: "complete", answer: "Y is fine." },
		});
	});

	test("a follow-up's deltas extend the topic's newest turn, not its opening answer", async () => {
		const { source, session } = await hosted();
		source.emitBtwRecord({
			...topic("t", "first?"),
			followUps: [{ question: "second?", answer: "", status: "running", createdAt: 3, updatedAt: 3 }],
		});
		source.emitBtwDelta("t", "more");
		await Bun.sleep(150);
		const last = session
			.eventsAfter(0)!
			.filter(e => e.ev.k === "btw")
			.at(-1)!.ev;
		expect(last).toMatchObject({ record: { answer: "earlier answer", followUps: [{ answer: "more" }] } });
	});
});

describe("HostedSession: goal and loop modes", () => {
	const statusOf = (session: HostedSession) => {
		const joined = session.subscribe(() => {}, 0, undefined).result;
		if (joined.kind !== "snapshot") throw new Error("a fresh subscriber gets a snapshot");
		return fromSnapshot(joined.snapshot).status!;
	};

	test("a goal set through omp's RPC shows in the status; a loop cannot start beside it", async () => {
		const { source, session } = await hosted();
		const goal = {
			id: "g1",
			objective: "ship the release",
			status: "active" as const,
			tokensUsed: 1200,
			timeUsedSeconds: 3,
			createdAt: 1,
			updatedAt: 1,
		};
		source.goalResult = { goal, state: { enabled: true, mode: "active", goal } };
		expect(await session.goal("create", { objective: "ship the release" })).toEqual({
			objective: "ship the release",
			status: "active",
			tokensUsed: 1200,
		});
		expect(source.goalCalls).toEqual([{ op: "create", objective: "ship the release" }]);
		expect(statusOf(session).goal).toMatchObject({ objective: "ship the release", status: "active" });
		await expect(session.loop("again")).rejects.toThrow(/goal/);

		// omp reports the goal's end through `goal_updated`; the status follows `get_state`
		source.state.goal = null;
		source.emit({ type: "goal_updated", goal: null } as never);
		await session.whenSynced();
		await Bun.sleep(0);
		expect(statusOf(session).goal).toBeUndefined();
	});

	test("/loop with a prompt sends it, repeats it, and a stop pauses it; /loop again turns it off", async () => {
		const { source, session } = await hosted();
		await session.loop("fix the tests");
		expect(source.prompts).toEqual(["fix the tests"]);
		expect(statusOf(session).loop).toEqual({ state: "running", prompt: "fix the tests" });
		await expect(session.goal("create", { objective: "x" })).rejects.toThrow(/loop/);

		await session.abort();
		expect(statusOf(session).loop).toEqual({ state: "paused" });
		await session.prompt("now this");
		expect(statusOf(session).loop).toEqual({ state: "running", prompt: "now this" });

		await session.loop("");
		expect(statusOf(session).loop).toBeUndefined();
		expect(session.eventsAfter(0)!.some(e => e.ev.k === "notify" && e.ev.message === "Loop mode disabled.")).toBe(
			true,
		);
	});
});
