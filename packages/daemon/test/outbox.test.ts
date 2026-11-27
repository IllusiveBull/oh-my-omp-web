import { describe, expect, test } from "bun:test";
import { Outbox, type OutboxLimits, type OutboxSocket } from "../src/outbox";

/** A client that reads only when told to: `buffered` grows with every frame sent and shrinks on `read`. */
class StuckSocket implements OutboxSocket {
	sent: string[] = [];
	buffered = 0;
	closed: { code?: number; reason?: string } | null = null;
	send(data: string): number {
		this.sent.push(data);
		this.buffered += data.length;
		return -1;
	}
	getBufferedAmount(): number {
		return this.buffered;
	}
	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}
	/** The client reads everything buffered; the socket then reports `drain`. */
	readAll(): void {
		this.buffered = 0;
	}
}

const limits: OutboxLimits = { highWater: 1000, queueCap: 5000, hardLimit: 20_000 };
const frame = (tag: string, size = 100) => `${tag}:${"x".repeat(size - tag.length - 1)}`;
const tags = (socket: StuckSocket) => socket.sent.map(f => f.split(":")[0]);

function harness(overrides: Partial<OutboxLimits> = {}) {
	const socket = new StuckSocket();
	const resyncs: string[][] = [];
	const outbox = new Outbox(socket, ids => resyncs.push(ids), { ...limits, ...overrides });
	const drain = (): void => {
		socket.readAll();
		outbox.pump();
	};
	return { socket, outbox, resyncs, drain };
}

describe("client outbox under backpressure", () => {
	test("a client that reads promptly gets every frame immediately and in order", () => {
		const { socket, outbox } = harness();
		for (let i = 0; i < 5; i++) {
			outbox.event("s", frame(`e${i}`));
			socket.readAll();
		}
		expect(tags(socket)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
		expect(outbox.queuedBytes).toBe(0);
	});

	test("while the socket is backed up frames queue instead of growing the socket buffer, and flush in order on drain", () => {
		const { socket, outbox, drain } = harness();
		for (let i = 0; i < 30; i++) outbox.event("s", frame(`e${i}`));
		// the socket buffer stopped growing at the high-water mark (+ the frame that crossed it)
		expect(socket.buffered).toBeLessThanOrEqual(1000 + 100);
		expect(outbox.queuedBytes).toBeGreaterThan(0);
		for (let i = 0; i < 10; i++) drain();
		expect(tags(socket)).toEqual(Array.from({ length: 30 }, (_, i) => `e${i}`));
		expect(outbox.queuedBytes).toBe(0);
	});

	test("streaming snapshots are dropped first: a stuck client keeps only the newest one per session", () => {
		const { socket, outbox, drain } = harness();
		for (let i = 0; i < 12; i++) outbox.event("s", frame(`fill${i}`)); // reach the high-water mark
		for (let i = 0; i < 200; i++) outbox.coalesced("stream:s", frame(`u${i}`, 400), "s");
		outbox.event("s", frame("tool"));
		outbox.coalesced("stream:s", frame("ulast", 400), "s");
		expect(outbox.queuedBytes).toBeLessThan(2000); // 2 updates' worth, not 200
		for (let i = 0; i < 10; i++) drain();
		const updates = tags(socket).filter(t => t?.startsWith("u"));
		expect(updates).toEqual(["ulast"]);
		// order is preserved for everything else: the tool event precedes the final update
		expect(tags(socket).indexOf("tool")).toBeLessThan(tags(socket).indexOf("ulast"));
	});

	test("past the queue cap the queued events are discarded and the client is resynced with fresh snapshots once it drains", () => {
		const { socket, outbox, resyncs, drain } = harness();
		for (let i = 0; i < 300; i++) outbox.event(i % 2 ? "a" : "b", frame(`e${i}`, 100));
		// bounded: nothing near 300 * 100 bytes is held
		expect(outbox.queuedBytes).toBeLessThanOrEqual(5000);
		expect(outbox.staleSessions.toSorted()).toEqual(["a", "b"]);
		// events for stale sessions are not queued at all while the client is behind
		const before = outbox.queuedBytes;
		outbox.event("a", frame("late", 100));
		expect(outbox.queuedBytes).toBe(before);
		expect(resyncs).toEqual([]);
		for (let i = 0; i < 10; i++) drain();
		expect(resyncs).toHaveLength(1);
		expect(resyncs[0]!.toSorted()).toEqual(["a", "b"]);
		// after the resync request the sessions are live again
		outbox.event("a", frame("after"));
		expect(tags(socket).at(-1)).toBe("after");
		expect(socket.closed).toBeNull();
	});

	test("a snapshot is serialized lazily, only as fast as the client drains, and is replaced as a whole by a newer one", () => {
		const { socket, outbox, drain } = harness();
		let produced = 0;
		function* chunks(tag: string, count: number): Generator<string> {
			for (let i = 0; i < count; i++) {
				produced++;
				yield frame(`${tag}${i}`, 400);
			}
		}
		outbox.snapshot("s", chunks("a", 100));
		// the socket takes frames until it is at the high-water mark, the rest has not even been produced
		expect(produced).toBeLessThanOrEqual(4);
		drain();
		expect(produced).toBeLessThanOrEqual(8);
		// a newer snapshot of the same session supersedes the unfinished one
		outbox.snapshot("s", chunks("b", 2));
		for (let i = 0; i < 5; i++) drain();
		expect(tags(socket).filter(t => t?.startsWith("b"))).toEqual(["b0", "b1"]);
		expect(tags(socket).filter(t => t?.startsWith("a")).length).toBeLessThan(100);
		expect(produced).toBeLessThan(102);
	});

	test("events queued behind a snapshot of their session are not sent ahead of it, and unsubscribing drops everything queued", () => {
		const { socket, outbox, drain } = harness();
		for (let i = 0; i < 12; i++) outbox.event("other", frame(`fill${i}`));
		outbox.event("s", frame("old1"));
		outbox.event("s", frame("old2"));
		outbox.snapshot("s", ["snap-begin:x", "snap-end:x"][Symbol.iterator]());
		outbox.event("s", frame("new1"));
		outbox.forget("other");
		for (let i = 0; i < 10; i++) drain();
		const order = tags(socket).filter(t => !t?.startsWith("fill"));
		expect(order).toEqual(["snap-begin", "snap-end", "new1"]);
	});

	test("small control frames (acks) are never dropped by a cut-over", () => {
		const { socket, outbox, drain } = harness();
		for (let i = 0; i < 12; i++) outbox.event("s", frame(`fill${i}`));
		outbox.control(frame("ack1"));
		for (let i = 0; i < 100; i++) outbox.event("s", frame(`e${i}`)); // forces a cut-over
		outbox.control(frame("ack2"));
		for (let i = 0; i < 10; i++) drain();
		const sent = tags(socket);
		expect(sent).toContain("ack1");
		expect(sent).toContain("ack2");
		expect(sent.indexOf("ack1")).toBeLessThan(sent.indexOf("ack2"));
	});

	test("a client whose own socket buffer keeps growing, or that never reads control frames, is closed instead of buffered", () => {
		const grow = harness({ hardLimit: 3000, highWater: 100_000 });
		for (let i = 0; i < 40; i++) grow.outbox.event("s", frame(`e${i}`, 200));
		expect(grow.socket.closed?.code).toBe(1013);
		const sentAtClose = grow.socket.sent.length;
		grow.outbox.event("s", frame("more"));
		expect(grow.socket.sent).toHaveLength(sentAtClose); // nothing is written after the close

		const control = harness({ queueCap: 1000 });
		for (let i = 0; i < 30; i++) control.outbox.control(frame(`ack${i}`, 100));
		expect(control.socket.closed?.code).toBe(1013);
	});
});
