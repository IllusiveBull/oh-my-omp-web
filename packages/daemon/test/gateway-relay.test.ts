import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { FakeSource, loadTurn, replayTurn } from "./fake-source";
import { Harness, SELF, makeRepo, sig, type TestClient } from "./gateway-harness";
import { assistant, turns, writeSessionFile } from "./session-files";

let repo: string;
let h: Harness;
let heldIds: Set<string>;

beforeAll(async () => {
	repo = await makeRepo();
});
afterAll(() => rmSync(dirname(repo), { recursive: true, force: true }));

beforeEach(async () => {
	heldIds = new Set();
	h = await Harness.start({ repo, heldIds });
});
afterEach(async () => {
	await h.stop();
});

const connect = (): Promise<TestClient> => h.connect();

describe("gateway relay of the session protocol", () => {
	test("greets with hello, machines and the session list; create/list/close round trip", async () => {
		const a = await connect();
		const hello = await a.waitFor(m => m.t === "hello");
		expect(hello).toMatchObject({ t: "hello", machine: SELF });
		const machines = await a.waitFor(m => m.t === "machines");
		expect(machines.t === "machines" && machines.machines).toMatchObject([
			{ id: SELF, name: "gateway-box", online: true, gateway: true, linkId: 1 },
		]);
		const id = await h.createSession(a);
		const listed = await a.waitFor(m => m.t === "sessions" && m.sessions.some(s => s.id === id));
		expect(listed.t === "sessions" && listed.m).toBe(SELF);
		expect(listed.t === "sessions" && listed.sessions[0]).toMatchObject({ phase: "idle", unread: false });
		const b = await connect();
		await b.waitFor(m => m.t === "sessions" && m.sessions.length === 1);
		expect((await a.call({ t: "session.close", sessionId: id })).ok).toBe(true);
		await b.waitFor(m => m.t === "sessions" && m.sessions.length === 0);
		expect(h.sources[0]!.stopped).toBe(true);
		const bad = await a.call({ t: "session.create", cwd: "/definitely/not/a/dir" });
		expect(bad.ok).toBe(false);
	});

	test("bad frames get an error ack and do not kill the connection; unknown machines are refused", async () => {
		const a = await connect();
		a.raw("not json");
		a.raw(JSON.stringify({ t: "subscribe", m: SELF, reqId: "x1", sessionId: "s", lastSeq: -1 }));
		a.raw(JSON.stringify({ t: "nope", m: SELF, reqId: "x2" }));
		a.raw(JSON.stringify({ t: "sessions.list", reqId: "x3" })); // no machine
		await a.waitFor(m => m.t === "ack" && m.reqId === "x1" && !m.ok);
		await a.waitFor(m => m.t === "ack" && m.reqId === "x2" && !m.ok);
		await a.waitFor(m => m.t === "ack" && m.reqId === "x3" && !m.ok);
		expect((await a.call({ t: "subscribe", sessionId: "missing", lastSeq: 0 })).ok).toBe(false);
		expect((await a.call({ t: "sessions.list" })).ok).toBe(true);
		a.raw(JSON.stringify({ t: "sessions.list", m: "m_nobody", reqId: "x4" }));
		expect(await a.waitFor(m => m.t === "ack" && m.reqId === "x4")).toMatchObject({
			ok: false,
			error: expect.stringContaining("unknown machine"),
		});
	});

	test("a client joining mid-stream with lastSeq=0 ends with the same transcript as one present all along", async () => {
		const fixture = await loadTurn();
		const early = await connect();
		const id = await h.createSession(early);
		await early.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		const source = h.sources[0]!;
		let late!: TestClient;
		await replayTurn(source, fixture, async (_i, event) => {
			if (event.type === "tool_execution_start") {
				late = await connect();
				await late.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
				expect(late.view.working).toBe(true);
				expect(late.view.activeTools.size).toBe(1);
			}
		});
		await early.until(() => early.view.status?.isStreaming === false && early.view.entries.length === 6);
		await late.until(() => late.view.status?.isStreaming === false && late.view.entries.length === 6);
		expect(sig(late.view)).toBe(sig(early.view));
		const after = await connect();
		await after.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		expect(sig(after.view)).toBe(sig(early.view));
	});

	test("reconnect with lastSeq replays only what was missed, without duplicates", async () => {
		const fixture = await loadTurn();
		const a = await connect();
		const id = await h.createSession(a);
		await a.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		const source = h.sources[0]!;
		const half = Math.floor(fixture.events.length / 2);
		await replayTurn(source, { events: fixture.events.slice(0, half), entries: fixture.entries });
		await a.until(() => a.view.entries.length > 0);
		const seenSeq = a.lastSeq;
		a.close(); // connection drops mid-turn
		await replayTurn(source, { events: fixture.events.slice(half), entries: fixture.entries }).catch(() => {});

		const b = await connect();
		b.view = a.view;
		b.lastSeq = seenSeq;
		const ack = await b.call({ t: "subscribe", sessionId: id, lastSeq: seenSeq, epoch: a.epoch });
		expect((ack.data as { mode: string }).mode).toBe("replay");
		expect(b.frames.some(m => m.t === "snapshot.begin")).toBe(false);
		const replayed = b.frames.flatMap(m => (m.t === "events" ? m.events : []));
		expect(replayed.every(e => e.seq > seenSeq)).toBe(true);
		const fresh = await connect();
		await fresh.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		expect(sig(b.view)).toBe(sig(fresh.view));
	});

	test("streaming snapshots are throttled per client; the end state is exact", async () => {
		const a = await connect();
		const id = await h.createSession(a);
		await a.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		const source = h.sources[0]!;
		const message = (n: number) => ({
			role: "assistant",
			content: [{ type: "text", text: `t${n}` }],
			model: "m",
			stopReason: "stop",
			timestamp: 1,
			usage: {},
		});
		source.emit({ type: "agent_start" } as never);
		source.emit({ type: "message_start", message: message(0) } as never);
		for (let i = 1; i <= 200; i++) source.emit({ type: "message_update", message: message(i) } as never);
		await a.until(() => a.updateFrames > 0);
		expect(a.updateFrames).toBeLessThan(10); // 200 updates produced in one tick collapse to the latest
		await a.until(() => JSON.stringify(a.view.stream).includes('"t200"'));
		source.emit({ type: "message_end", message: message(200) } as never);
		await a.until(() => a.view.streamDone);
		expect(JSON.stringify(a.view.stream)).toContain("t200");
	});

	test("commands are routed to omp; ui answers: first wins, others see it end", async () => {
		const a = await connect();
		const b = await connect();
		const id = await h.createSession(a);
		await a.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		await b.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		const source = h.sources[0]!;
		expect((await a.call({ t: "prompt", sessionId: id, message: "hello" })).ok).toBe(true);
		expect((await a.call({ t: "steer", sessionId: id, message: "wait" })).ok).toBe(true);
		expect((await a.call({ t: "abort", sessionId: id })).ok).toBe(true);
		expect([source.prompts, source.steers, source.aborts]).toEqual([["hello"], ["wait"], 1]);

		source.emitUi({
			type: "extension_ui_request",
			id: "u1",
			method: "select",
			title: "Approve edit?",
			options: ["Allow", "Deny"],
		});
		await a.until(() => a.view.uiRequests.length === 1);
		await b.until(() => b.view.uiRequests.length === 1);
		const first = await b.call({ t: "ui.response", sessionId: id, requestId: "u1", response: { value: "Allow" } });
		expect(first.ok).toBe(true);
		const second = await a.call({ t: "ui.response", sessionId: id, requestId: "u1", response: { value: "Deny" } });
		expect(second.ok).toBe(false);
		await a.until(() => a.view.uiRequests.length === 0);
		expect(source.uiResponses).toEqual([{ type: "extension_ui_response", id: "u1", value: "Allow" }]);
	});

	test("when omp exits, subscribers are told and the session stays listed as closed", async () => {
		const a = await connect();
		const id = await h.createSession(a);
		await a.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		h.sources[0]!.exit("omp exited with code 9");
		await a.until(() => a.view.closed !== null);
		await a.waitFor(m => m.t === "sessions" && m.sessions.some(s => s.id === id && s.phase === "closed"));
		const ack = await a.call({ t: "prompt", sessionId: id, message: "x" });
		expect(ack.ok).toBe(false);
	});
});

describe("gateway relay of sessions on disk", () => {
	const T0 = Date.parse("2026-11-01T10:00:00.000Z");
	/** A session a TUI wrote, with the id the fake omp will report when resumed. */
	const seed = (id = "sess-1") =>
		writeSessionFile(h.sessionDir, {
			id,
			created: new Date(T0).toISOString(),
			cwd: repo,
			title: "From the TUI",
			entries: turns("t", ["question", "answer"], T0 + 1000),
		});

	test("a stored session is listed, can be read through a snapshot, and a held one stays read-only with a coded refusal", async () => {
		seed("sess-1");
		heldIds.add("sess-1");
		const a = await connect();
		expect((await a.call({ t: "sessions.list" })).ok).toBe(true);
		const listed = await a.waitFor(m => m.t === "sessions" && m.sessions.some(s => s.id === "sess-1"));
		expect(listed.t === "sessions" && listed.sessions.find(s => s.id === "sess-1")).toMatchObject({
			access: "held",
			phase: "stored",
			projectRoot: repo,
			worktreeRoot: repo,
		});
		expect((await a.call({ t: "subscribe", sessionId: "sess-1", lastSeq: 0 })).ok).toBe(true);
		expect(a.view.entries.map(e => e.id)).toEqual(["t0", "t1"]);
		const prompt = await a.call({ t: "prompt", sessionId: "sess-1", message: "hi" });
		expect(prompt).toMatchObject({ ok: false, error: expect.stringContaining("take it over") });
		const resume = await a.call({ t: "session.resume", sessionId: "sess-1", confirm: true });
		expect(resume).toMatchObject({ ok: false, code: "held" });
		expect(h.sources).toHaveLength(0);
	});

	test("taking over asks for confirmation first; afterwards everybody viewing the stored session is moved to the hosted one", async () => {
		seed("sess-1");
		const a = await connect();
		const b = await connect();
		await a.call({ t: "sessions.list" });
		await a.call({ t: "subscribe", sessionId: "sess-1", lastSeq: 0 });
		await b.call({ t: "subscribe", sessionId: "sess-1", lastSeq: 0 });
		const storedEpoch = a.epoch;

		expect(await a.call({ t: "session.resume", sessionId: "sess-1" })).toMatchObject({
			ok: false,
			code: "confirm_takeover",
		});
		expect(h.sources).toHaveLength(0);
		const ok = await a.call({ t: "session.resume", sessionId: "sess-1", confirm: true });
		expect(ok).toMatchObject({ ok: true, data: { sessionId: "sess-1" } });

		// both viewers got a fresh snapshot of the hosted session (new log epoch) without resubscribing
		await a.until(() => a.epoch !== storedEpoch);
		await b.until(() => b.epoch !== storedEpoch);
		await a.waitFor(m => m.t === "sessions" && m.sessions.some(s => s.id === "sess-1" && s.access === "hosted"));
		expect((await a.call({ t: "prompt", sessionId: "sess-1", message: "continue" })).ok).toBe(true);
		expect(h.sources[0]!.prompts).toEqual(["continue"]);
	});

	test("a replay is only offered for the log it was taken from: another epoch gets a snapshot", async () => {
		const a = await connect();
		const id = await h.createSession(a);
		await a.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		h.sources[0]!.emit({ type: "agent_start" } as never);
		await a.until(() => a.lastSeq > 0);
		const b = await connect();
		const stale = await b.call({
			t: "subscribe",
			sessionId: id,
			lastSeq: a.lastSeq,
			epoch: "from-a-previous-daemon-run",
		});
		expect(stale).toMatchObject({ ok: true, data: { mode: "snapshot" } });
		const c = await connect();
		const fresh = await c.call({ t: "subscribe", sessionId: id, lastSeq: a.lastSeq, epoch: a.epoch });
		expect(fresh).toMatchObject({ ok: true, data: { mode: "replay" } });
	});

	test("fork and rename are routed and acked", async () => {
		seed("sess-1");
		const a = await connect();
		await a.call({ t: "sessions.list" });
		const forked = await a.call({ t: "session.fork", sessionId: "sess-1" });
		expect(forked.ok).toBe(true);
		expect(h.sources).toHaveLength(1);
		const id = (forked.data as { sessionId: string }).sessionId;
		expect((await a.call({ t: "session.rename", sessionId: id, title: "renamed" })).ok).toBe(true);
		expect(h.sources[0]!.names).toEqual(["renamed"]);
		expect((await a.call({ t: "session.fork", sessionId: "nope" })).ok).toBe(false);
	});
});

describe("gateway relay of controls and large sessions", () => {
	test("controls are routed to the session and every subscribed client sees the result", async () => {
		const a = await connect();
		const b = await connect();
		const id = await h.createSession(a);
		await a.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		await b.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		const source = h.sources[0]!;
		source.models = [{ provider: "p", id: "m1" } as never, { provider: "p", id: "m2" } as never];
		const options = await a.call({ t: "session.options", sessionId: id });
		expect(options).toMatchObject({ ok: true, data: { thinkingLevels: ["off", "low", "high"] } });
		expect((options.data as { models: unknown[] }).models).toHaveLength(2);

		expect((await a.call({ t: "session.set_model", sessionId: id, provider: "p", modelId: "m2" })).ok).toBe(true);
		await b.until(() => b.view.status?.model === "p/m2");
		expect((await a.call({ t: "session.set_thinking", sessionId: id, level: "low" })).ok).toBe(true);
		await b.until(() => b.view.status?.thinkingLevel === "low");
		expect((await a.call({ t: "session.set_thinking", sessionId: id, level: "max" })).ok).toBe(false);
		expect((await a.call({ t: "session.compact", sessionId: id, instructions: "short" })).ok).toBe(true);
		expect(source.compactions).toEqual(["short"]);

		// a message queued from A is in B's queue
		expect((await a.call({ t: "follow_up", sessionId: id, message: "later" })).ok).toBe(true);
		source.emitQueue([], ["later"]);
		await b.until(() => b.view.status?.queue.followUp[0] === "later");
		expect(await a.call({ t: "queue.remove", sessionId: id, message: "later", queue: "followUp" })).toMatchObject({
			ok: true,
			data: { removed: true },
		});
	});

	test("the sub-agent panel is per connection: omp keeps sending sub-agent frames until the last panel is closed or its connection drops", async () => {
		const a = await connect();
		const b = await connect();
		const id = await h.createSession(a);
		await a.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		const source = h.sources[0]!;
		expect((await a.call({ t: "session.agents", sessionId: id, open: true })).ok).toBe(true);
		expect((await b.call({ t: "session.agents", sessionId: id, open: true })).ok).toBe(true);
		expect(source.subscriptionCalls).toEqual(["progress"]);
		await a.call({ t: "session.agents", sessionId: id, open: false });
		expect(source.subscription).toBe("progress");
		b.close(); // closing the tab closes its panel
		await a.until(() => source.subscription === "off");
		expect(source.subscriptionCalls).toEqual(["progress", "off"]);
	});

	test("a snapshot of a large session arrives in bounded frames and assembles to exactly the daemon's view", async () => {
		const history = Array.from({ length: 60 }, (_, i) =>
			assistant(`a${i}`, i === 0 ? null : `a${i - 1}`, `${i} ${"z".repeat(20_000)}`, "2026-11-01T10:00:00.000Z"),
		);
		const big = await Harness.start({
			repo,
			frameBytes: 100_000,
			createSource: async () => new FakeSource(history as never, "big-1"),
		});
		try {
			const c = await big.connect();
			const id = await big.createSession(c);
			await c.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
			await c.until(() => c.view.entries.length === 60);
			const raw = c.rawFrames.filter(f => f.includes('"snapshot.'));
			expect(raw.length).toBeGreaterThan(8);
			expect(Math.max(...raw.map(f => f.length))).toBeLessThan(100_000 + 20_500 + 400);
			expect(c.snapshots).toBe(1);
			expect(c.view.entries.map(e => e.id)).toEqual(history.map(e => e.id));
		} finally {
			await big.stop();
		}
	});
});

describe("read positions", () => {
	test("a read report clears the unread marker on every client, and only moves forward", async () => {
		const a = await connect();
		const b = await connect();
		const id = await h.createSession(a);
		await a.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		const unreadOf = (c: TestClient): boolean | undefined => {
			const last = c.frames.findLast(m => m.t === "sessions" && m.m === SELF);
			return last?.t === "sessions" ? last.sessions.find(s => s.id === id)?.unread : undefined;
		};
		await b.until(() => unreadOf(b) === false);

		// the session changes while nobody has read it
		h.sources[0]!.emit({ type: "agent_start" } as never);
		await b.until(() => unreadOf(b) === true);
		await a.until(() => unreadOf(a) === true);
		const session = a.frames.findLast(m => m.t === "sessions")!;
		const modifiedAt = session.t === "sessions" ? session.sessions.find(s => s.id === id)!.modifiedAt : 0;

		// A reads it: the marker clears on both
		const ack = await a.callGateway({ t: "read", sessionId: id, seq: a.lastSeq, epoch: a.epoch, modifiedAt });
		expect(ack.ok).toBe(true);
		await b.until(() => unreadOf(b) === false);
		await a.until(() => unreadOf(a) === false);

		// a late client starts read, and a stale (older) report does not make it unread again
		const c = await connect();
		await c.until(() => unreadOf(c) === false);
		expect((await c.callGateway({ t: "read", sessionId: id, seq: 0, modifiedAt: modifiedAt - 1000 })).ok).toBe(true);
		await Bun.sleep(30);
		expect(unreadOf(b)).toBe(false);

		// reading something unknown is refused
		expect(await c.callGateway({ t: "read", sessionId: "nope", seq: 0, modifiedAt })).toMatchObject({ ok: false });
	});
});

describe("backpressure across the gateway", () => {
	test("while the browser socket is backed up the daemon queues instead of writing, and flushes when it drains", async () => {
		const a = await connect();
		const id = await h.createSession(a);
		await a.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		const source = h.sources[0]!;
		// Pause the virtual client the way the gateway does when the browser's socket reports a backlog.
		const peer = h.gateway.peerOf(SELF);
		if (peer === null || peer === "unknown") throw new Error("local env is not registered");
		const cid = [...peer.clients.keys()][0]!;
		peer.link.send(JSON.stringify({ t: "pause", cid }));
		await Bun.sleep(10);
		const eventFrames = (): number => a.frames.filter(m => m.t === "events").length;
		const before = eventFrames();
		const message = (n: number) => ({
			role: "assistant",
			content: [{ type: "text", text: `t${n}` }],
			model: "m",
			stopReason: "stop",
			timestamp: 1,
			usage: {},
		});
		source.emit({ type: "agent_start" } as never);
		source.emit({ type: "message_start", message: message(0) } as never);
		for (let i = 1; i <= 20; i++) source.emit({ type: "message_update", message: message(i) } as never);
		await Bun.sleep(100); // a negative assertion: there is no event to await, only the absence of frames
		expect(eventFrames()).toBe(before); // nothing was written while paused
		peer.link.send(JSON.stringify({ t: "resume", cid }));
		await a.until(() => JSON.stringify(a.view.stream).includes('"t20"'));
		expect(a.view.working).toBe(true);
	});
});
