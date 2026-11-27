import { describe, expect, test } from "bun:test";
import {
	XFER_CHUNK_BYTES,
	XFER_WINDOW,
	type EnvLinkMessage,
	type GatewayLinkMessage,
	type XferInfo,
} from "@omp-web/protocol";
import { HandoffCallError, PeerRpc, pumpTransfer } from "../src/handoff-link";
import { BULK_HIGH_WATER_BYTES } from "../src/link-lanes";

/** A daemon's end of the handoff protocol, enough for the gateway's pump: serves reads of a buffer, stores writes in order. */
class FakeDaemon {
	rpc: PeerRpc;
	received: Uint8Array[] = [];
	receivedBytes = 0;
	/** Bytes the gateway has pulled from this daemon and no sink has acknowledged yet, at the worst moment. */
	buffered = 0;
	sendOrder: number[] = [];
	onWrite: ((msg: Extract<GatewayLinkMessage, { t: "xfer.write" }>) => void) | null = null;
	dropAfterChunks: number | null = null;
	chunksServed = 0;

	constructor(
		readonly name: string,
		private readonly data: Uint8Array = new Uint8Array(0),
		public bufferedAmount = 0,
	) {
		this.rpc = new PeerRpc(
			message => queueMicrotask(() => this.#handle(message)),
			() => this.bufferedAmount,
			() => name,
		);
	}

	#reply(message: EnvLinkMessage): void {
		this.rpc.receive(message);
	}

	#handle(message: GatewayLinkMessage): void {
		if (message.t === "xfer.read") {
			this.chunksServed++;
			if (this.dropAfterChunks !== null && this.chunksServed > this.dropAfterChunks) {
				this.rpc.close(`${this.name} went offline`);
				return;
			}
			const slice = this.data.subarray(message.offset, message.offset + message.len);
			this.#reply({
				t: "xfer.data",
				xfer: message.xfer,
				offset: message.offset,
				data: Buffer.from(slice).toString("base64"),
				eof: message.offset + slice.length >= this.data.length,
			});
		} else if (message.t === "xfer.write") {
			this.onWrite?.(message);
			const bytes = Buffer.from(message.data, "base64");
			this.sendOrder.push(message.offset);
			if (message.offset !== this.receivedBytes) {
				this.#reply({
					t: "xfer.ack",
					xfer: message.xfer,
					offset: message.offset,
					ok: false,
					error: "out of order",
				});
				return;
			}
			this.received.push(bytes);
			this.receivedBytes += bytes.length;
			this.#reply({ t: "xfer.ack", xfer: message.xfer, offset: message.offset, ok: true });
		}
	}
}

const payload = (size: number): Uint8Array => {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
	return bytes;
};
const info = (size: number): XferInfo => ({ id: "xfer-test-0001", size, sha256: "0".repeat(64) });

describe("pumpTransfer", () => {
	test("moves a file in order with every byte intact (sizes around the chunk boundary)", async () => {
		for (const size of [
			0,
			1,
			XFER_CHUNK_BYTES - 1,
			XFER_CHUNK_BYTES,
			XFER_CHUNK_BYTES + 1,
			3 * XFER_CHUNK_BYTES + 17,
		]) {
			const data = payload(size);
			const source = new FakeDaemon("src", data);
			const target = new FakeDaemon("dst");
			const progress: number[] = [];
			await pumpTransfer(source.rpc, info(size), target.rpc, "recv", { onProgress: done => progress.push(done) });
			expect(Buffer.concat(target.received).equals(Buffer.from(data))).toBe(true);
			expect(target.sendOrder).toEqual([...target.sendOrder].sort((a, b) => a - b));
			if (size > 0) expect(progress.at(-1)).toBe(size);
		}
	});

	test("a 24 MiB transfer never holds more than the window between the daemons", async () => {
		const size = 24 * 1024 * 1024;
		const data = payload(size);
		const source = new FakeDaemon("src", data);
		const target = new FakeDaemon("dst");
		let requested = 0;
		let acked = 0;
		let peak = 0;
		// Count what the gateway has pulled out of the source but the target has not acknowledged.
		const rawRead = source.rpc.readChunk.bind(source.rpc);
		source.rpc.readChunk = (xfer, offset, len) => {
			requested += len;
			peak = Math.max(peak, requested - acked);
			return rawRead(xfer, offset, len);
		};
		target.onWrite = message => {
			const length = Buffer.from(message.data, "base64").length;
			queueMicrotask(() => {
				acked += length;
			});
		};
		await pumpTransfer(source.rpc, info(size), target.rpc, "recv");
		expect(target.receivedBytes).toBe(size);
		expect(peak).toBeLessThanOrEqual(XFER_WINDOW * XFER_CHUNK_BYTES);
		expect(peak).toBeGreaterThan(XFER_CHUNK_BYTES); // it does pipeline
	});

	test("holds each chunk back while the target's link has more than the bulk threshold unsent", async () => {
		const data = payload(4 * XFER_CHUNK_BYTES);
		const source = new FakeDaemon("src", data);
		const target = new FakeDaemon("dst", new Uint8Array(0), BULK_HIGH_WATER_BYTES + 1);
		const run = pumpTransfer(source.rpc, info(data.length), target.rpc, "recv");
		await Bun.sleep(40); // a congested link: nothing is handed to it (the wait is the behaviour under test)
		expect(target.receivedBytes).toBe(0);
		target.bufferedAmount = 0;
		await run;
		expect(target.receivedBytes).toBe(data.length);
	});

	test("a link that drops mid-transfer fails the pump cleanly, with the daemon named", async () => {
		const data = payload(8 * XFER_CHUNK_BYTES);
		const source = new FakeDaemon("src", data);
		source.dropAfterChunks = 3;
		const target = new FakeDaemon("dst");
		const error = await pumpTransfer(source.rpc, info(data.length), target.rpc, "recv").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HandoffCallError);
		expect((error as HandoffCallError).kind).toBe("link");
		expect((error as HandoffCallError).message).toContain("src went offline");
		expect(target.receivedBytes).toBeLessThan(data.length);
	});

	test("a target that refuses a chunk fails the transfer", async () => {
		const data = payload(2 * XFER_CHUNK_BYTES);
		const source = new FakeDaemon("src", data);
		const target = new FakeDaemon("dst");
		target.receivedBytes = 5; // so the first offset (0) is not what it expects
		const error = await pumpTransfer(source.rpc, info(data.length), target.rpc, "recv").catch((e: unknown) => e);
		expect((error as Error).message).toContain("refused a chunk");
	});

	test("aborted() ends the transfer between chunks", async () => {
		const data = payload(16 * XFER_CHUNK_BYTES);
		const source = new FakeDaemon("src", data);
		const target = new FakeDaemon("dst");
		let aborted = false;
		target.onWrite = () => {
			aborted = true;
		};
		const error = await pumpTransfer(source.rpc, info(data.length), target.rpc, "recv", {
			aborted: () => aborted,
		}).catch((e: unknown) => e);
		expect((error as Error).message).toContain("cancelled");
		expect(target.receivedBytes).toBeLessThan(data.length);
	});
});

describe("PeerRpc", () => {
	test("call resolves with the daemon's result and rejects with its message and kind", async () => {
		const sent: GatewayLinkMessage[] = [];
		const rpc = new PeerRpc(
			m => sent.push(m),
			() => 0,
			() => "box",
		);
		const ok = rpc.call("target.verify", { opId: "op000001", sessionId: "s" });
		const first = sent[0] as Extract<GatewayLinkMessage, { t: "op" }>;
		rpc.receive({ t: "op.result", id: first.id, ok: true, data: { alive: true } });
		expect(await ok).toEqual({ alive: true });
		const bad = rpc.call("target.verify", { opId: "op000001", sessionId: "s" });
		const second = sent[1] as Extract<GatewayLinkMessage, { t: "op" }>;
		rpc.receive({ t: "op.result", id: second.id, ok: false, error: { message: "nope", kind: "refused" } });
		const error = (await bad.catch((e: unknown) => e)) as HandoffCallError;
		expect(error.message).toBe("nope");
		expect(error.kind).toBe("refused");
	});

	test("close fails calls in flight and refuses new ones", async () => {
		const rpc = new PeerRpc(
			() => {},
			() => 0,
			() => "box",
		);
		const pending = rpc.call("target.verify", { opId: "op000001", sessionId: "s" });
		rpc.close("box went offline");
		expect(((await pending.catch((e: unknown) => e)) as HandoffCallError).kind).toBe("link");
		expect(
			(
				(await rpc
					.call("target.verify", { opId: "op000001", sessionId: "s" })
					.catch((e: unknown) => e)) as HandoffCallError
			).message,
		).toBe("box went offline");
	});
});
