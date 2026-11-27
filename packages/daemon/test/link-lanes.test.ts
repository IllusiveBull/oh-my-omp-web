import { describe, expect, test } from "bun:test";
import type { LinkEnd } from "../src/link-end";
import { BULK_HIGH_WATER_BYTES, LaneLink } from "../src/link-lanes";
import { until } from "./terminal-fixtures";

/** A socket whose buffer only drains when the test says so (a slow network). */
class SlowLink implements LinkEnd {
	readonly sent: string[] = [];
	buffered = 0;
	closed = false;

	send(text: string): void {
		this.sent.push(text);
		this.buffered += text.length;
	}

	bufferedAmount(): number {
		return this.buffered;
	}

	drain(bytes: number): void {
		this.buffered = Math.max(0, this.buffered - bytes);
	}

	close(): void {
		this.closed = true;
	}

	terminate(): void {
		this.closed = true;
	}
}

describe("LaneLink", () => {
	test("a priority frame is written at once even with a backlog of bulk frames; bulk frames keep their order", async () => {
		const inner = new SlowLink();
		const lanes = new LaneLink(inner, 1000);
		for (let i = 0; i < 10; i++) lanes.send(`bulk-${i}:${"x".repeat(400)}`); // the network takes none of it
		// the socket holds what crossed the line (up to the high-water mark plus the frame that crossed it); the rest waits
		expect(inner.sent.length).toBeLessThan(10);
		const waiting = lanes.queuedBytes;
		expect(waiting).toBeGreaterThan(0);
		expect(lanes.bufferedAmount()).toBe(inner.buffered + waiting);
		const sentBefore = inner.sent.length;
		lanes.sendPriority("echo");
		expect(inner.sent.length).toBe(sentBefore + 1);
		expect(inner.sent.at(-1)).toBe("echo");
		// the network catches up: every bulk frame is delivered, in order, once
		inner.drain(1e9);
		await until(() => lanes.queuedBytes === 0 || (inner.drain(1e9), false), 3000, "the bulk queue to drain");
		expect(inner.sent.filter(s => s.startsWith("bulk-")).map(s => s.split(":")[0])).toEqual(
			Array.from({ length: 10 }, (_, i) => `bulk-${i}`),
		);
		expect(inner.sent.filter(s => s === "echo")).toHaveLength(1);
	});

	test("the bytes ahead of an echo are bounded by the high-water mark plus one frame, however much bulk is queued", () => {
		const inner = new SlowLink();
		const lanes = new LaneLink(inner, BULK_HIGH_WATER_BYTES);
		const frame = "f".repeat(256 * 1024); // a snapshot chunk / replica chunk
		for (let i = 0; i < 8; i++) lanes.send(frame); // 2 MiB of bulk offered while the network is slow
		expect(inner.buffered).toBeLessThanOrEqual(BULK_HIGH_WATER_BYTES + frame.length);
		expect(lanes.queuedBytes).toBeGreaterThanOrEqual(5 * frame.length);
		const aheadOfEcho = inner.buffered;
		lanes.sendPriority("echo");
		expect(aheadOfEcho).toBeLessThanOrEqual(BULK_HIGH_WATER_BYTES + frame.length);
	});

	test("with nothing in the way bulk frames go straight through (no added latency, no queue)", () => {
		const inner = new SlowLink();
		const lanes = new LaneLink(inner);
		lanes.send("a");
		lanes.send("b");
		expect(inner.sent).toEqual(["a", "b"]);
		expect(lanes.queuedBytes).toBe(0);
	});

	test("a closed link drops what waits and sends nothing more", () => {
		const inner = new SlowLink();
		const lanes = new LaneLink(inner, 10);
		lanes.send("x".repeat(100));
		lanes.send("y".repeat(100));
		lanes.dispose();
		expect(lanes.queuedBytes).toBe(0);
		lanes.send("z");
		lanes.sendPriority("p");
		expect(inner.sent).toEqual(["x".repeat(100)]);
	});
});
