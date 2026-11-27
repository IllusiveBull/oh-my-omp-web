import { describe, expect, test } from "bun:test";
import {
	type GatewaySessionInfo,
	type MachineSummary,
	PING_FRAME,
	PONG_FRAME,
	type ServerMessage,
	snapshotFrames,
} from "@omp-web/protocol";
import type { SequencedEvent } from "@omp-web/protocol";
import type { SessionCheck } from "../src/lib/auth";
import { DaemonClient, type DaemonClientOptions } from "../src/store/daemon-client";
import { brokerStatus, emptySnapshot, gatewaySession, loginFlow, machineSummary, userEntry } from "./fixtures";

class FakeSocket {
	static instances: FakeSocket[] = [];
	readyState = 0;
	sent: Record<string, unknown>[] = [];
	readonly #acked = new Set<string>();
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
	}
	send(text: string): void {
		this.sent.push(JSON.parse(text));
	}
	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}
	deliver(message: ServerMessage): void {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
	deliverMachines(...machines: MachineSummary[]): void {
		this.deliver({ t: "machines", machines });
	}
	/** A whole snapshot as the gateway relays it: `entryCount` user entries, one per chunk. */
	deliverSnapshot(machine: string, sessionId: string, seq: number, entryCount: number): void {
		for (const frame of this.snapshotFrames(machine, sessionId, `snap-${sessionId}-${seq}`, seq, entryCount))
			this.onmessage?.({ data: frame });
	}
	/** The daemon's frames tagged with the machine, as the gateway forwards them. */
	snapshotFrames(machine: string, sessionId: string, snapshotId: string, seq: number, entryCount: number): string[] {
		const entries = Array.from({ length: entryCount }, (_, i) => userEntry(`${sessionId}-${i}`, `m${i}`));
		const frames = snapshotFrames(sessionId, snapshotId, seq, `epoch-${sessionId}`, emptySnapshot({ entries }), 1);
		return [...frames].map(frame => JSON.stringify({ ...JSON.parse(frame), m: machine }));
	}
	deliverRaw(frame: string): void {
		this.onmessage?.({ data: frame });
	}
	/** Answers every request that was not answered by an earlier call. */
	ackAll(ok = true): void {
		for (const req of this.sent) {
			if (typeof req.reqId !== "string" || this.#acked.has(req.reqId)) continue;
			this.#acked.add(req.reqId);
			this.deliver(
				ok ? { t: "ack", reqId: req.reqId, ok: true } : { t: "ack", reqId: req.reqId, ok: false, error: "nope" },
			);
		}
	}
	/** Frames sent by type. */
	requests(type: string): Record<string, unknown>[] {
		return this.sent.filter(m => m.t === type);
	}
}

/** Lets promise continuations (acks) run; no timers involved. */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Waits for a condition that a client timer (reconnect backoff, heartbeat interval) is about to make true. */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition was not met in time");
		await Bun.sleep(1);
	}
}

/** For "nothing happens" assertions: waits several reconnect/heartbeat periods (5-10 ms in these tests). */
const quiet = (): Promise<void> => Bun.sleep(40);

interface Harness {
	client: DaemonClient;
	socket: FakeSocket;
}

function newClient(options: Omit<DaemonClientOptions, "socketFactory"> = {}): DaemonClient {
	FakeSocket.instances = [];
	return new DaemonClient("ws://x/ws", {
		socketFactory: url => new FakeSocket(url) as unknown as WebSocket,
		reconnect: { minMs: 5, maxMs: 10 },
		authProbe: async () => "valid",
		...options,
	});
}

/** A client whose first socket is open and has received the gateway's `machines` frame. */
function connect(
	machines: MachineSummary[] = [machineSummary({ id: "m1" })],
	options: Omit<DaemonClientOptions, "socketFactory"> = {},
): Harness {
	const client = newClient(options);
	client.connect();
	const socket = FakeSocket.instances[0]!;
	socket.open();
	socket.deliverMachines(...machines);
	return { client, socket };
}

test("notification sounds follow final outcomes and input, never replay or duplicate events", async () => {
	const sounds: string[] = [];
	const { client, socket } = connect(undefined, { onSound: sound => sounds.push(sound) });
	client.open("m1", "a");
	const deliver = (events: SequencedEvent[]): void => socket.deliver({ t: "events", m: "m1", sessionId: "a", events });
	// Catch-up precedes the subscribe ack.
	deliver([{ seq: 1, ev: { k: "prompt_result", status: "completed" } }]);
	expect(sounds).toEqual([]);
	socket.ackAll();
	await flush();
	const events: SequencedEvent[] = [
		{ seq: 2, ev: { k: "agent", event: { type: "agent_end" } } },
		{ seq: 3, ev: { k: "prompt_result", status: "aborted" } },
		{ seq: 4, ev: { k: "prompt_result", status: "completed" } },
		{ seq: 5, ev: { k: "prompt_result", status: "error", error: "provider failed" } },
		{ seq: 6, ev: { k: "ui", request: { id: "q", method: "ask", questions: [] } } },
		{ seq: 7, ev: { k: "ui", request: { id: "c", method: "confirm", title: "Confirm", message: "Proceed?" } } },
		{ seq: 8, ev: { k: "ui", request: { id: "i", method: "input", title: "Input" } } },
		{ seq: 9, ev: { k: "ui", request: { id: "s", method: "select", title: "Select", options: ["A"] } } },
		{ seq: 10, ev: { k: "ui", request: { id: "e", method: "editor", title: "Editor" } } },
	];
	deliver(events);
	expect(sounds).toEqual(["completion", "error", "ask", "ask", "ask", "ask"]);
	deliver(events);
	socket.deliverSnapshot("m1", "a", 10, 0);
	expect(sounds).toEqual(["completion", "error", "ask", "ask", "ask", "ask"]);
	client.release("m1", "a");
	deliver([{ seq: 11, ev: { k: "prompt_result", status: "completed" } }]);
	expect(sounds).toEqual(["completion", "error", "ask", "ask", "ask", "ask"]);
	client.close();
});

describe("DaemonClient reconnect", () => {
	test("resubscribes open sessions with their own lastSeq once the machines frame of the new socket arrives, and not released ones", async () => {
		const { client, socket: first } = connect();
		client.open("m1", "a");
		client.open("m1", "b");
		expect(first.sent.map(m => [m.t, m.m, m.sessionId, m.lastSeq])).toEqual([
			["subscribe", "m1", "a", 0],
			["subscribe", "m1", "b", 0],
		]);
		first.ackAll();
		first.deliverSnapshot("m1", "a", 41, 0);
		first.deliverSnapshot("m1", "b", 7, 0);
		client.release("m1", "b");

		first.close(); // network drop
		expect(client.getSnapshot().phase).toBe("reconnecting");
		await until(() => FakeSocket.instances.length === 2);
		const second = FakeSocket.instances[1]!;
		second.open();
		expect(client.getSnapshot().phase).toBe("open");
		expect(second.sent).toEqual([]); // which machines are online (and under which link) is only known from the next frame
		second.deliverMachines(machineSummary({ id: "m1" }));
		expect(second.sent.map(m => [m.t, m.m, m.sessionId, m.lastSeq, m.epoch])).toEqual([
			["subscribe", "m1", "a", 41, "epoch-a"],
		]);
		client.close();
	});

	test("a pending request resolves with an error when the connection drops", async () => {
		const { client, socket } = connect(undefined, { reconnect: { minMs: 1000, maxMs: 1000 } });
		const pending = client.request("m1", { t: "prompt", sessionId: "a", message: "hi" });
		socket.close();
		expect(await pending).toMatchObject({ ok: false, error: "connection lost" });
		client.close();
	});

	test("an unknown session after reconnect marks the replica lost instead of leaving it loading forever", async () => {
		const { client, socket } = connect();
		const store = client.open("m1", "gone");
		socket.deliver({ t: "ack", reqId: String(socket.sent[0]!.reqId), ok: false, error: "unknown session: gone" });
		await flush();
		expect(store.getSnapshot().lost).toBe("unknown session: gone");
		expect(store.getSnapshot().loading).toBe(false);
	});

	test("a subscribe that was in flight when the socket dropped is not reported as a lost session", async () => {
		const { client, socket } = connect(undefined, { reconnect: { minMs: 1000, maxMs: 1000 } });
		const store = client.open("m1", "a");
		socket.close();
		await flush();
		expect(store.getSnapshot().lost).toBeNull();
		client.close();
	});
});

describe("DaemonClient state", () => {
	test("hello, machines and per-machine session lists are kept; a sessions frame replaces only its machine", () => {
		const { client, socket } = connect([machineSummary({ id: "m1" }), machineSummary({ id: "m2" })]);
		socket.deliver({ t: "hello", protocol: 3, gatewayVersion: "x", machine: "m1" });
		const s1 = gatewaySession({ id: "a" });
		const s2 = gatewaySession({ id: "b" });
		socket.deliver({ t: "sessions", m: "m1", sessions: [s1] });
		socket.deliver({ t: "sessions", m: "m2", sessions: [s2] });
		socket.deliver({ t: "sessions", m: "m1", sessions: [] });
		const state = client.getSnapshot();
		expect(state.hello?.machine).toBe("m1");
		expect(state.machines.map(m => m.id)).toEqual(["m1", "m2"]);
		expect(state.sessions).toEqual({ m1: [], m2: [s2] });
	});

	test("requests are addressed to a machine", () => {
		const { client, socket } = connect();
		void client.request("m1", { t: "project.list" });
		expect(socket.requests("project.list")).toMatchObject([{ m: "m1", reqId: expect.any(String) }]);
		client.close();
	});

	test("sessions with the same id on two machines have separate replicas, subscriptions and streams", () => {
		const { client, socket } = connect([machineSummary({ id: "m1" }), machineSummary({ id: "m2" })]);
		const a = client.open("m1", "same");
		const b = client.open("m2", "same");
		expect(a).not.toBe(b);
		expect(socket.requests("subscribe").map(m => [m.m, m.sessionId])).toEqual([
			["m1", "same"],
			["m2", "same"],
		]);
		socket.deliverSnapshot("m1", "same", 5, 1);
		socket.deliverSnapshot("m2", "same", 9, 2);
		expect(a.lastSeq).toBe(5);
		expect(b.lastSeq).toBe(9);
		expect(a.getSnapshot().view.entries).toHaveLength(1);
		expect(b.getSnapshot().view.entries).toHaveLength(2);
		socket.deliver({
			t: "events",
			m: "m2",
			sessionId: "same",
			events: [{ seq: 10, ev: { k: "notify", level: "info", message: "only m2" } }],
		});
		expect(a.lastSeq).toBe(5);
		expect(b.lastSeq).toBe(10);
		client.close();
	});
});

describe("DaemonClient snapshot frames", () => {
	test("a chunked snapshot reaches the store only at snapshot.end", () => {
		const { client, socket } = connect();
		const store = client.open("m1", "a");
		const frames = socket.snapshotFrames("m1", "a", "s1", 12, 3);
		expect(frames).toHaveLength(5); // begin, 3 chunks, end
		for (const frame of frames.slice(0, -1)) socket.deliverRaw(frame);
		expect(store.getSnapshot().loading).toBe(true);
		expect(store.getSnapshot().view.entries).toHaveLength(0);
		expect(store.lastSeq).toBe(0);
		socket.deliverRaw(frames.at(-1)!);
		expect(store.getSnapshot().loading).toBe(false);
		expect(store.getSnapshot().view.entries.map(e => e.id)).toEqual(["a-0", "a-1", "a-2"]);
		expect(store.lastSeq).toBe(12);
		expect(store.epoch).toBe("epoch-a");
	});

	test("interleaved snapshots of two sessions are assembled independently", () => {
		const { client, socket } = connect();
		const a = client.open("m1", "a");
		const b = client.open("m1", "b");
		const fa = socket.snapshotFrames("m1", "a", "sa", 5, 2);
		const fb = socket.snapshotFrames("m1", "b", "sb", 9, 3);
		const order: string[] = [];
		for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
			if (fa[i]) socket.deliverRaw(fa[i]!);
			if (fb[i]) socket.deliverRaw(fb[i]!);
			order.push(`${a.getSnapshot().view.entries.length}/${b.getSnapshot().view.entries.length}`);
		}
		expect(order.at(-1)).toBe("2/3");
		expect(a.lastSeq).toBe(5);
		expect(b.lastSeq).toBe(9);
		// `a` (4 frames) completed while `b` (5 frames) was still half-assembled.
		expect(order[3]).toBe("2/0");
	});

	test("a begin supersedes a half-assembled snapshot; leftovers of the old one are ignored", () => {
		const { client, socket } = connect();
		const store = client.open("m1", "a");
		const stale = socket.snapshotFrames("m1", "a", "old", 10, 4);
		const fresh = socket.snapshotFrames("m1", "a", "new", 20, 2);
		for (const frame of stale.slice(0, 3)) socket.deliverRaw(frame); // begin + 2 of 4 chunks
		for (const frame of fresh) socket.deliverRaw(frame);
		expect(store.lastSeq).toBe(20);
		expect(store.getSnapshot().view.entries).toHaveLength(2);
		for (const frame of stale.slice(3)) socket.deliverRaw(frame); // late chunks and end of the superseded one
		expect(store.lastSeq).toBe(20);
		expect(store.getSnapshot().view.entries).toHaveLength(2);
	});

	test("an incomplete snapshot is not applied and makes the client resubscribe from scratch", async () => {
		const { client, socket } = connect();
		const store = client.open("m1", "a");
		socket.ackAll();
		await flush();
		socket.deliverSnapshot("m1", "a", 41, 1);
		expect(store.lastSeq).toBe(41);
		const frames = socket.snapshotFrames("m1", "a", "broken", 60, 3);
		frames.splice(2, 1); // one chunk lost
		for (const frame of frames) socket.deliverRaw(frame);
		expect(store.getSnapshot().view.entries).toHaveLength(1); // untouched
		const subscribes = socket.requests("subscribe");
		expect(subscribes).toHaveLength(2);
		expect(subscribes[1]).toMatchObject({ m: "m1", sessionId: "a", lastSeq: 0 });
		expect(subscribes[1]!.epoch).toBeUndefined();
	});
});

describe("DaemonClient machines", () => {
	test("a machine that registered again (new linkId) gets every wanted session resubscribed with its lastSeq and epoch", async () => {
		const { client, socket } = connect([
			machineSummary({ id: "m1", linkId: 1 }),
			machineSummary({ id: "m2", linkId: 1 }),
		]);
		client.open("m1", "a");
		client.open("m2", "b");
		socket.ackAll();
		await flush();
		socket.deliverSnapshot("m1", "a", 41, 0);
		socket.deliverSnapshot("m2", "b", 7, 0);
		expect(socket.requests("subscribe")).toHaveLength(2);

		// The offline frame may have been coalesced away: only the new linkId is visible.
		socket.deliverMachines(machineSummary({ id: "m1", linkId: 2 }), machineSummary({ id: "m2", linkId: 1 }));
		const subscribes = socket.requests("subscribe");
		expect(subscribes).toHaveLength(3);
		expect(subscribes[2]).toMatchObject({ m: "m1", sessionId: "a", lastSeq: 41, epoch: "epoch-a" });

		// The same link again (any other change of the machine list) subscribes nothing.
		socket.deliverMachines(
			machineSummary({ id: "m1", linkId: 2, name: "renamed" }),
			machineSummary({ id: "m2", linkId: 1 }),
		);
		expect(socket.requests("subscribe")).toHaveLength(3);
		client.close();
	});

	test("an offline machine keeps its replicas, receives no requests and is never marked lost; it resubscribes when it is back", async () => {
		const { client, socket } = connect([machineSummary({ id: "m1", linkId: 1 })]);
		const store = client.open("m1", "a");
		socket.ackAll();
		await flush();
		socket.deliverSnapshot("m1", "a", 41, 2);
		const sentBefore = socket.sent.length;

		socket.deliverMachines(machineSummary({ id: "m1", linkId: 1, online: false }));
		expect(store.getSnapshot().waiting).toBe("machine offline");
		expect(store.getSnapshot().lost).toBeNull();
		expect(store.getSnapshot().view.entries).toHaveLength(2); // replica kept

		const refused = await client.request("m1", { t: "prompt", sessionId: "a", message: "hi" });
		expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("offline") });
		client.setAgentsWatched("m1", "a", true);
		client.release("m1", "a");
		expect(socket.sent).toHaveLength(sentBefore); // nothing went out for the offline machine

		client.open("m1", "a");
		expect(socket.sent).toHaveLength(sentBefore); // opening a session of an offline machine only waits
		expect(store.getSnapshot().lost).toBeNull();

		socket.deliverMachines(machineSummary({ id: "m1", linkId: 2 }));
		expect(store.getSnapshot().waiting).toBeNull();
		expect(socket.requests("subscribe").at(-1)).toMatchObject({
			m: "m1",
			sessionId: "a",
			lastSeq: 41,
			epoch: "epoch-a",
		});
		client.close();
	});

	test("a subscribe still in flight when its machine went offline is dropped without marking the session lost", async () => {
		const { client, socket } = connect([machineSummary({ id: "m1", linkId: 1 })]);
		const store = client.open("m1", "a");
		socket.deliverMachines(machineSummary({ id: "m1", linkId: 1, online: false }));
		socket.ackAll(false);
		await flush();
		expect(store.getSnapshot().lost).toBeNull();
		expect(store.getSnapshot().waiting).toBe("machine offline");
		client.close();
	});

	test("a session of a machine the gateway does not know is lost", () => {
		const { client } = connect([machineSummary({ id: "m1" })]);
		const store = client.open("nope", "a");
		expect(store.getSnapshot().lost).toContain("unknown machine");
		client.close();
	});
});

describe("DaemonClient heartbeat", () => {
	/** A clock the test moves; the heartbeat's interval timer stays real but only compares against this. */
	function clock(): { now: () => number; advance(ms: number): void } {
		let t = 0;
		return { now: () => t, advance: ms => void (t += ms) };
	}

	test("a silent socket is treated as closed: requests fail, a new socket is dialed, the old one is ignored", async () => {
		const time = clock();
		const client = newClient({ heartbeat: { intervalMs: 5, timeoutMs: 15, now: time.now } });
		client.connect();
		const first = FakeSocket.instances[0]!;
		first.open();
		first.deliverMachines(machineSummary({ id: "m1" }));
		const store = client.open("m1", "a");
		const pending = client.request("m1", { t: "prompt", sessionId: "a", message: "hi" });
		await until(() => first.requests("ping").length > 0); // the client pings while all is quiet
		time.advance(100); // ... and nothing comes back
		expect(await pending).toMatchObject({ ok: false, error: "connection lost" });
		expect(client.getSnapshot().phase).toBe("reconnecting");
		expect(first.readyState).toBe(3); // the dead socket was closed from our side

		await until(() => FakeSocket.instances.length === 2);
		// Late events of the abandoned socket change nothing.
		first.deliver({ t: "sessions", m: "m1", sessions: [gatewaySession()] });
		first.deliverMachines();
		expect(client.getSnapshot().sessions).toEqual({});
		expect(client.getSnapshot().machines.map(m => m.id)).toEqual(["m1"]);
		expect(store.getSnapshot().lost).toBeNull();
		first.onclose?.(); // and its close event does not schedule another reconnect
		await quiet();
		expect(FakeSocket.instances).toHaveLength(2);
		client.close();
	});

	test("pings are answered without being parsed, and any frame keeps the link alive", async () => {
		const time = clock();
		const { client, socket } = connect(undefined, { heartbeat: { intervalMs: 5, timeoutMs: 40, now: time.now } });
		socket.deliverRaw(PING_FRAME);
		expect(socket.requests("pong")).toHaveLength(1);

		time.advance(30);
		socket.deliverRaw(PONG_FRAME);
		time.advance(30); // 60 ms in, but only 30 since the last frame
		const pings = socket.requests("ping").length;
		await until(() => socket.requests("ping").length > pings); // at least one interval ran after the clock moved
		expect(client.getSnapshot().phase).toBe("open");

		time.advance(100);
		await until(() => client.getSnapshot().phase === "reconnecting");
		client.close();
	});

	test("closing the client stops the heartbeat", async () => {
		const time = clock();
		const { client, socket } = connect(undefined, { heartbeat: { intervalMs: 5, timeoutMs: 15, now: time.now } });
		await until(() => socket.requests("ping").length > 0);
		client.close();
		const pings = socket.requests("ping").length;
		time.advance(100);
		await quiet();
		expect(socket.requests("ping")).toHaveLength(pings);
		expect(FakeSocket.instances).toHaveLength(1); // the dead-socket path did not dial again
	});
});

describe("DaemonClient session check", () => {
	test("an expired session stops the reconnects and reloads for the login page", async () => {
		let reloads = 0;
		const client = newClient({ authProbe: async () => "expired", reload: () => reloads++ });
		client.connect();
		const socket = FakeSocket.instances[0]!;
		socket.open();
		socket.close();
		await until(() => reloads > 0);
		await quiet();
		expect(reloads).toBe(1);
		expect(FakeSocket.instances).toHaveLength(1);
	});

	test("an expired session is detected when the very first connection is refused", async () => {
		let reloads = 0;
		const client = newClient({ authProbe: async () => "expired", reload: () => reloads++ });
		client.connect();
		FakeSocket.instances[0]!.close(); // the upgrade was answered with 401: the socket closes without ever opening
		await until(() => reloads > 0);
		await quiet();
		expect(reloads).toBe(1);
		expect(FakeSocket.instances).toHaveLength(1);
	});

	for (const result of ["valid", "unreachable"] satisfies SessionCheck[]) {
		test(`a ${result} session check keeps reconnecting without reloading`, async () => {
			let reloads = 0;
			const client = newClient({ authProbe: async () => result, reload: () => reloads++ });
			client.connect();
			const socket = FakeSocket.instances[0]!;
			socket.open();
			socket.close();
			await until(() => FakeSocket.instances.length > 1);
			await flush();
			expect(reloads).toBe(0);
			client.close();
		});
	}

	test("a check that answers after the reconnect succeeded is ignored", async () => {
		let reloads = 0;
		let answer: (result: SessionCheck) => void = () => {};
		const client = newClient({
			authProbe: () => new Promise<SessionCheck>(resolve => (answer = resolve)),
			reload: () => reloads++,
		});
		client.connect();
		FakeSocket.instances[0]!.open();
		FakeSocket.instances[0]!.close();
		await until(() => FakeSocket.instances.length === 2);
		FakeSocket.instances[1]!.open();
		answer("expired");
		await flush();
		expect(reloads).toBe(0);
		expect(client.getSnapshot().phase).toBe("open");
		client.close();
	});
});

describe("DaemonClient read reports", () => {
	const session = (modifiedAt: number): Pick<GatewaySessionInfo, "id" | "modifiedAt"> => ({ id: "a", modifiedAt });

	/** Subscribed, with a snapshot at seq 41: the state in which a user is looking at the transcript. */
	async function reading(): Promise<Harness> {
		const harness = connect();
		harness.client.open("m1", "a");
		harness.socket.ackAll();
		await flush();
		harness.socket.deliverSnapshot("m1", "a", 41, 1);
		return harness;
	}

	test("reports the replica's position once, and again only for a newer modifiedAt", async () => {
		const { client, socket } = await reading();
		const first = client.reportRead("m1", session(100), true);
		expect(socket.requests("read")).toEqual([
			{ t: "read", reqId: expect.any(String), m: "m1", sessionId: "a", seq: 41, epoch: "epoch-a", modifiedAt: 100 },
		]);
		socket.ackAll();
		expect(await first).toBe(true);

		expect(await client.reportRead("m1", session(100), true)).toBe(false);
		expect(await client.reportRead("m1", session(90), true)).toBe(false);
		expect(socket.requests("read")).toHaveLength(1);

		const next = client.reportRead("m1", session(150), true);
		socket.ackAll();
		expect(await next).toBe(true);
		expect(socket.requests("read").map(m => m.modifiedAt)).toEqual([100, 150]);
		client.close();
	});

	test("nothing is reported from a hidden tab, before the snapshot, or for an offline machine", async () => {
		const { client, socket } = connect();
		client.open("m1", "a");
		expect(await client.reportRead("m1", session(100), true)).toBe(false); // still loading
		socket.ackAll();
		await flush();
		socket.deliverSnapshot("m1", "a", 41, 1);
		expect(await client.reportRead("m1", session(100), false)).toBe(false); // tab hidden
		socket.deliverMachines(machineSummary({ id: "m1", online: false }));
		expect(await client.reportRead("m1", session(100), true)).toBe(false); // machine offline
		expect(socket.requests("read")).toEqual([]);

		socket.deliverMachines(machineSummary({ id: "m1", linkId: 2 }));
		const sent = client.reportRead("m1", session(100), true); // visible and online again: the skipped report is due
		socket.ackAll();
		expect(await sent).toBe(true);
		client.close();
	});

	test("a report whose ack failed is repeated on the next trigger", async () => {
		const { client, socket } = await reading();
		const failed = client.reportRead("m1", session(100), true);
		socket.ackAll(false);
		expect(await failed).toBe(false);
		const retried = client.reportRead("m1", session(100), true);
		socket.ackAll();
		expect(await retried).toBe(true);
		expect(socket.requests("read")).toHaveLength(2);
		client.close();
	});

	test("reports of the same session id on different machines are tracked separately", async () => {
		const { client, socket } = connect([machineSummary({ id: "m1" }), machineSummary({ id: "m2" })]);
		client.open("m1", "a");
		client.open("m2", "a");
		socket.ackAll();
		await flush();
		socket.deliverSnapshot("m1", "a", 3, 0);
		socket.deliverSnapshot("m2", "a", 8, 0);
		void client.reportRead("m1", session(100), true);
		void client.reportRead("m2", session(100), true);
		expect(socket.requests("read").map(m => [m.m, m.seq])).toEqual([
			["m1", 3],
			["m2", 8],
		]);
		client.close();
	});
});

describe("DaemonClient sub-agent panel", () => {
	const ackSubscribes = (socket: FakeSocket): void => {
		for (const req of socket.requests("subscribe")) {
			socket.deliver({ t: "ack", reqId: String(req.reqId), ok: true });
		}
	};
	const agentRequests = (socket: FakeSocket) => socket.requests("session.agents").map(m => [m.m, m.sessionId, m.open]);

	test("the open panel is announced once subscribed and again after a reconnect, until it is closed", async () => {
		const { client, socket } = connect();
		client.open("m1", "a");
		client.setAgentsWatched("m1", "a", true); // before the subscribe was acked: must wait for it
		await flush();
		expect(agentRequests(socket)).toEqual([]);
		ackSubscribes(socket);
		await flush();
		expect(agentRequests(socket)).toEqual([["m1", "a", true]]);

		socket.close();
		await until(() => FakeSocket.instances.length === 2);
		const second = FakeSocket.instances[1]!;
		second.open();
		second.deliverMachines(machineSummary({ id: "m1" }));
		await flush();
		expect(agentRequests(second)).toEqual([]); // not before the resubscribe is acked
		ackSubscribes(second);
		await flush();
		expect(agentRequests(second)).toEqual([["m1", "a", true]]);

		client.setAgentsWatched("m1", "a", false);
		expect(agentRequests(second)).toEqual([
			["m1", "a", true],
			["m1", "a", false],
		]);
		second.close();
		await until(() => FakeSocket.instances.length === 3);
		const third = FakeSocket.instances[2]!;
		third.open();
		third.deliverMachines(machineSummary({ id: "m1" }));
		ackSubscribes(third);
		await flush();
		expect(agentRequests(third)).toEqual([]);
		client.close();
	});

	test("releasing a session closes its panel on the daemon before unsubscribing", async () => {
		const { client, socket } = connect();
		client.open("m1", "a");
		ackSubscribes(socket);
		await flush();
		client.setAgentsWatched("m1", "a", true);
		client.release("m1", "a");
		expect(socket.sent.slice(-3).map(m => [m.t, m.open])).toEqual([
			["session.agents", true],
			["session.agents", false],
			["unsubscribe", undefined],
		]);
	});
});

describe("DaemonClient presence", () => {
	const views = (socket: FakeSocket): unknown[][] => socket.requests("view").map(m => [m.m, m.sessionId, m.visible]);

	test("reports the session and visibility to the gateway, once per state", async () => {
		const { client, socket } = connect();
		const first = client.reportView("m1", "a", true);
		expect(socket.requests("view")).toEqual([
			{ t: "view", reqId: expect.any(String), m: "m1", sessionId: "a", visible: true },
		]);
		socket.ackAll();
		expect(await first).toBe(true);

		expect(await client.reportView("m1", "a", true)).toBe(true); // nothing changed: nothing sent
		expect(views(socket)).toEqual([["m1", "a", true]]);

		const hidden = client.reportView("m1", "a", false);
		socket.ackAll();
		expect(await hidden).toBe(true);
		const closed = client.reportView("", null, true);
		socket.ackAll();
		await closed;
		expect(views(socket)).toEqual([
			["m1", "a", true],
			["m1", "a", false],
			["", null, true],
		]);
		client.close();
	});

	test("a state still waiting for its ack is not sent again by a machines frame", async () => {
		const { client, socket } = connect();
		void client.reportView("m1", "a", true);
		socket.deliverMachines(machineSummary({ id: "m1" }));
		socket.deliverMachines(machineSummary({ id: "m1", name: "renamed" }));
		expect(socket.requests("view")).toHaveLength(1);
		socket.ackAll();
		await flush();
		socket.deliverMachines(machineSummary({ id: "m1" }));
		expect(socket.requests("view")).toHaveLength(1);
		client.close();
	});

	test("a failed report is retried by the next call for the same state and by the next machines frame", async () => {
		const { client, socket } = connect();
		const failed = client.reportView("m1", "a", true);
		socket.ackAll(false);
		expect(await failed).toBe(false);

		const retried = client.reportView("m1", "a", true);
		expect(socket.requests("view")).toHaveLength(2);
		socket.ackAll(false);
		expect(await retried).toBe(false);

		socket.deliverMachines(machineSummary({ id: "m1" }));
		expect(socket.requests("view")).toHaveLength(3);
		socket.ackAll();
		await flush();
		socket.deliverMachines(machineSummary({ id: "m1" }));
		expect(socket.requests("view")).toHaveLength(3);
		client.close();
	});

	test("a new socket starts with no presence: the last state is re-sent after its machines frame, only the last", async () => {
		const { client, socket: first } = connect();
		void client.reportView("m1", "a", true);
		first.ackAll();
		void client.reportView("m1", "b", false);
		first.ackAll();
		await flush();

		first.close();
		await until(() => FakeSocket.instances.length === 2);
		const second = FakeSocket.instances[1]!;
		second.open();
		expect(second.sent).toEqual([]);
		second.deliverMachines(machineSummary({ id: "m1" }));
		expect(views(second)).toEqual([["m1", "b", false]]);
		client.close();
	});

	test("a report made while disconnected is sent once the next socket has its machines frame; with no report nothing is sent", async () => {
		const quietClient = connect().client;
		const quietSocket = FakeSocket.instances[0]!;
		expect(quietSocket.requests("view")).toEqual([]);
		quietClient.close();

		const client = newClient();
		expect(await client.reportView("m1", "a", true)).toBe(false); // no socket yet
		client.connect();
		const socket = FakeSocket.instances[0]!;
		socket.open();
		expect(socket.requests("view")).toEqual([]);
		socket.deliverMachines(machineSummary({ id: "m1" }));
		expect(views(socket)).toEqual([["m1", "a", true]]);
		client.close();
	});
});

describe("DaemonClient replicas of offline machines", () => {
	const copy = { state: "complete", asOf: 1_000, syncedAt: 2_000 } as const;
	const offline = (linkId = 1): MachineSummary => machineSummary({ id: "m1", online: false, linkId });
	const online = (linkId: number): MachineSummary => machineSummary({ id: "m1", linkId });
	const listed = (socket: FakeSocket, ...sessions: GatewaySessionInfo[]): void =>
		socket.deliver({ t: "sessions", m: "m1", sessions });
	const lastRequest = (socket: FakeSocket, type: string): Record<string, unknown> | undefined =>
		socket.requests(type).at(-1);
	const ackWith = (socket: FakeSocket, request: Record<string, unknown> | undefined, data: unknown): void => {
		if (typeof request?.reqId !== "string") throw new Error("no request to ack");
		socket.deliver({ t: "ack", reqId: request.reqId, ok: true, data });
	};
	const subscribeIds = (socket: FakeSocket): unknown[] => socket.requests("subscribe").map(m => m.sessionId);

	test("a wanted session with a copy is subscribed through the gateway and marked as served from it", async () => {
		const { client, socket } = connect([offline()]);
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		const store = client.open("m1", "a");
		expect(socket.requests("subscribe")).toMatchObject([{ m: "m1", sessionId: "a", lastSeq: 0 }]);
		expect(store.getSnapshot().replica).toBeNull(); // not before the gateway says so

		ackWith(socket, lastRequest(socket, "subscribe"), { mode: "snapshot", replica: copy });
		await flush();
		socket.deliverSnapshot("m1", "a", 12, 3);
		const state = store.getSnapshot();
		expect(state.replica).toEqual(copy);
		expect(state.view.entries).toHaveLength(3);
		expect(state.loading).toBe(false);
		expect(state.lost).toBeNull();
		expect(state.waiting).toBe("machine offline"); // the machine is still away
		client.close();
	});

	test("a wanted session without a copy keeps waiting: nothing is sent", () => {
		const { client, socket } = connect([offline()]);
		listed(socket, gatewaySession({ id: "a" }), gatewaySession({ id: "b", replica: copy }));
		const a = client.open("m1", "a");
		client.open("m1", "b");
		expect(subscribeIds(socket)).toEqual(["b"]);
		expect(a.getSnapshot()).toMatchObject({ waiting: "machine offline", replica: null, loading: true });
		client.close();
	});

	test("a sessions frame that announces a copy starts the subscribe once, however often the lists repeat", async () => {
		const { client, socket } = connect([offline()]);
		listed(socket, gatewaySession({ id: "a" }));
		const store = client.open("m1", "a");
		expect(socket.requests("subscribe")).toEqual([]);

		listed(socket, gatewaySession({ id: "a", replica: { ...copy, state: "partial" } }));
		expect(subscribeIds(socket)).toEqual(["a"]);
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		socket.deliverMachines(offline());
		expect(subscribeIds(socket)).toEqual(["a"]);

		ackWith(socket, lastRequest(socket, "subscribe"), { mode: "snapshot", replica: { ...copy, state: "partial" } });
		await flush();
		expect(store.getSnapshot().replica?.state).toBe("partial");
		client.close();
	});

	test("an online machine's session list with copies changes nothing", () => {
		const { client, socket } = connect([online(1)]);
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		client.open("m1", "a");
		expect(socket.requests("subscribe")).toHaveLength(1); // the live one
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		expect(socket.requests("subscribe")).toHaveLength(1);
		client.close();
	});

	test("a session already loaded live keeps its transcript when the machine goes away: offline banner, no copy requested", async () => {
		const { client, socket } = connect([online(1)]);
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		const store = client.open("m1", "a");
		socket.ackAll();
		await flush();
		socket.deliverSnapshot("m1", "a", 41, 1);

		socket.deliverMachines(offline());
		expect(socket.requests("subscribe")).toHaveLength(1);
		expect(store.getSnapshot()).toMatchObject({ replica: null, waiting: "machine offline", lastSeq: 41 });
		expect(store.getSnapshot().view.entries).toHaveLength(1);
		client.close();
	});

	test("unsubscribing reaches the gateway for a copy-served session, and only for those", async () => {
		const { client, socket } = connect([offline()]);
		listed(socket, gatewaySession({ id: "a", replica: copy }), gatewaySession({ id: "b" }));
		client.open("m1", "a");
		client.open("m1", "b");
		ackWith(socket, lastRequest(socket, "subscribe"), { mode: "snapshot", replica: copy });
		await flush();
		client.release("m1", "b");
		expect(socket.requests("unsubscribe")).toEqual([]);
		client.release("m1", "a");
		expect(socket.requests("unsubscribe")).toMatchObject([{ m: "m1", sessionId: "a" }]);
		client.close();
	});

	test("every other request to the offline machine is still refused, copy or not", async () => {
		const { client, socket } = connect([offline()]);
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		client.open("m1", "a");
		const sent = socket.sent.length;
		expect(await client.request("m1", { t: "prompt", sessionId: "a", message: "hi" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("offline"),
		});
		expect(await client.request("m1", { t: "unsubscribe", sessionId: "a" })).toMatchObject({ ok: false });
		expect(socket.sent).toHaveLength(sent);
		client.close();
	});

	test("when the machine is back the session goes live from a full snapshot and stops being a copy", async () => {
		const { client, socket } = connect([offline()]);
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		const store = client.open("m1", "a");
		ackWith(socket, lastRequest(socket, "subscribe"), { mode: "snapshot", replica: copy });
		await flush();
		socket.deliverSnapshot("m1", "a", 12, 3);
		expect(store.getSnapshot().replica).toEqual(copy);

		socket.deliverMachines(online(2));
		expect(store.getSnapshot().waiting).toBeNull();
		expect(socket.requests("subscribe").at(-1)).toMatchObject({ m: "m1", sessionId: "a", lastSeq: 0 });
		expect(socket.requests("subscribe").at(-1)?.epoch).toBeUndefined(); // the copy's position means nothing to the machine
		expect(store.getSnapshot().replica).toEqual(copy); // until the machine's own data arrives

		socket.deliverSnapshot("m1", "a", 90, 5); // the live snapshot, before its ack
		expect(store.getSnapshot()).toMatchObject({ replica: null, waiting: null, lastSeq: 90 });
		expect(store.getSnapshot().view.entries).toHaveLength(5);
		ackWith(socket, lastRequest(socket, "subscribe"), { mode: "snapshot" });
		await flush();
		expect(store.getSnapshot().replica).toBeNull();
		client.close();
	});

	test("a live ack without a copy clears the marker even when it comes before any snapshot frame", async () => {
		const { client, socket } = connect([offline()]);
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		const store = client.open("m1", "a");
		ackWith(socket, lastRequest(socket, "subscribe"), { mode: "snapshot", replica: copy });
		await flush();
		socket.deliverMachines(online(2));
		ackWith(socket, lastRequest(socket, "subscribe"), { mode: "replay" });
		await flush();
		expect(store.getSnapshot().replica).toBeNull();
		client.close();
	});

	test("a copy the gateway cannot serve marks the session lost and is not asked for again on every machines frame", async () => {
		const { client, socket } = connect([offline()]);
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		const store = client.open("m1", "a");
		socket.ackAll(false);
		await flush();
		expect(store.getSnapshot().lost).toBe("nope");
		socket.deliverMachines(offline());
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		expect(socket.requests("subscribe")).toHaveLength(1);
		client.close();
	});

	test("after a reconnect while the machine is still offline the copy is subscribed again on the new socket", async () => {
		const { client, socket: first } = connect([offline()]);
		listed(first, gatewaySession({ id: "a", replica: copy }));
		const store = client.open("m1", "a");
		ackWith(first, lastRequest(first, "subscribe"), { mode: "snapshot", replica: copy });
		await flush();
		first.deliverSnapshot("m1", "a", 12, 1);

		first.close();
		await until(() => FakeSocket.instances.length === 2);
		const second = FakeSocket.instances[1]!;
		second.open();
		second.deliverMachines(offline());
		expect(second.requests("subscribe")).toMatchObject([{ m: "m1", sessionId: "a" }]);
		expect(store.getSnapshot().view.entries).toHaveLength(1); // kept meanwhile
		client.close();
	});

	test("an incomplete copy snapshot asks the gateway again, not the machine", async () => {
		const { client, socket } = connect([offline()]);
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		client.open("m1", "a");
		ackWith(socket, lastRequest(socket, "subscribe"), { mode: "snapshot", replica: copy });
		await flush();
		const frames = socket.snapshotFrames("m1", "a", "broken", 60, 3);
		frames.splice(2, 1); // one chunk lost
		for (const frame of frames) socket.deliverRaw(frame);
		const subscribes = socket.requests("subscribe");
		expect(subscribes).toHaveLength(2);
		expect(subscribes[1]).toMatchObject({ m: "m1", sessionId: "a", lastSeq: 0 });
		client.close();
	});

	test("reading a copy reports a read position, even though the machine is offline", async () => {
		const { client, socket } = connect([offline()]);
		listed(socket, gatewaySession({ id: "a", replica: copy }));
		client.open("m1", "a");
		ackWith(socket, lastRequest(socket, "subscribe"), { mode: "snapshot", replica: copy });
		await flush();
		expect(await client.reportRead("m1", { id: "a", modifiedAt: 500 }, true)).toBe(false); // snapshot not here yet
		socket.deliverSnapshot("m1", "a", 12, 2);
		expect(await client.reportRead("m1", { id: "a", modifiedAt: 500 }, false)).toBe(false); // hidden tab
		const sent = client.reportRead("m1", { id: "a", modifiedAt: 500 }, true);
		expect(socket.requests("read")).toMatchObject([{ m: "m1", sessionId: "a", seq: 12, modifiedAt: 500 }]);
		socket.ackAll();
		expect(await sent).toBe(true);
		client.close();
	});

	test("an offline session without a copy still reports nothing", async () => {
		const { client, socket } = connect([online(1)]);
		client.open("m1", "a");
		socket.ackAll();
		await flush();
		socket.deliverSnapshot("m1", "a", 12, 2);
		socket.deliverMachines(offline());
		expect(await client.reportRead("m1", { id: "a", modifiedAt: 500 }, true)).toBe(false);
		expect(socket.requests("read")).toEqual([]);
		client.close();
	});
});

describe("DaemonClient credentials (auth.* frames)", () => {
	test("each auth frame replaces its own part of the state wholesale; before any frame there is nothing", () => {
		const { client, socket } = connect();
		expect(client.getSnapshot().auth).toMatchObject({
			broker: null,
			flow: null,
			accounts: { providers: null, accounts: [] },
			usage: { fetchedAt: null },
		});
		const broker = brokerStatus({ phase: "restarting", healthy: false });
		socket.deliver({ t: "auth.broker", broker });
		socket.deliver({ t: "auth.flow", flow: loginFlow({ link: { url: "https://x.invalid/a" } }) });
		expect(client.getSnapshot().auth.broker).toEqual(broker);
		expect(client.getSnapshot().auth.flow?.link?.url).toBe("https://x.invalid/a");
		socket.deliver({
			t: "auth.accounts",
			providers: [{ id: "anthropic", name: "Anthropic", available: true, authenticated: true, kind: "oauth" }],
			accounts: [],
			disabled: [],
			error: null,
			loadedAt: 5,
			migration: null,
		});
		expect(client.getSnapshot().auth.accounts).toEqual({
			providers: [{ id: "anthropic", name: "Anthropic", available: true, authenticated: true, kind: "oauth" }],
			accounts: [],
			disabled: [],
			error: null,
			loadedAt: 5,
			migration: null,
		}); // the frame's own `t` is not part of the state
		socket.deliver({ t: "auth.usage", fetchedAt: 9, generatedAt: 8, reports: [], error: null });
		expect(client.getSnapshot().auth.usage).toEqual({ fetchedAt: 9, generatedAt: 8, reports: [], error: null });
		socket.deliver({ t: "auth.flow", flow: null });
		expect(client.getSnapshot().auth.flow).toBeNull();
		expect(client.getSnapshot().auth.broker).toEqual(broker); // untouched by the others
		client.close();
	});

	test("an auth request has no machine id and is answered by its ack", async () => {
		const { client, socket } = connect();
		const pending = client.authRequest({ t: "auth.login.start", providerId: "anthropic" });
		const sent = socket.requests("auth.login.start")[0]!;
		expect(sent).toMatchObject({ t: "auth.login.start", providerId: "anthropic" });
		expect("m" in sent).toBe(false);
		socket.ackAll();
		expect(await pending).toMatchObject({ ok: true });
		client.close();
	});

	test("the Accounts page being open is told to the gateway once, and again on every new socket (the gateway forgets it with the connection)", async () => {
		const { client, socket: first } = connect();
		client.setAccountsOpen(true);
		client.setAccountsOpen(true); // no duplicate
		expect(first.requests("auth.watch")).toMatchObject([{ open: true }]);
		first.close();
		await until(() => FakeSocket.instances.length === 2);
		const second = FakeSocket.instances[1]!;
		second.open();
		expect(second.requests("auth.watch")).toMatchObject([{ open: true }]);
		client.setAccountsOpen(false);
		expect(second.requests("auth.watch")).toMatchObject([{ open: true }, { open: false }]);
		second.close();
		await until(() => FakeSocket.instances.length === 3);
		const third = FakeSocket.instances[2]!;
		third.open();
		expect(third.requests("auth.watch")).toEqual([]); // closed pages are not re-announced
		client.close();
	});
});
