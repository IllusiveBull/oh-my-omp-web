/**
 * The memory bound of file replies at the daemon's edge: how many requests one client may have running, and how many
 * reply bytes may wait in its outbox when the transport (the link, paused by a backed-up browser) is not taking them.
 */
import { describe, expect, test } from "bun:test";
import type { FilesClientMessage } from "@omp-web/protocol";
import { EnvClient, type ClientHost } from "../src/env-client";
import { FileError } from "../src/file-path";
import type { FileService } from "../src/file-service";
import type { OutboxSocket } from "../src/outbox";

class FakeSocket implements OutboxSocket {
	sent: string[] = [];
	/** What `getBufferedAmount` reports: above the outbox's high water mark means "not taking frames". */
	buffered = 0;
	send(frame: string): number {
		this.sent.push(frame);
		return frame.length;
	}
	getBufferedAmount(): number {
		return this.buffered;
	}
	close(): void {}
}

const PAGE = "x".repeat(300 * 1024);

function client(files: Pick<FileService, "handle">): { client: EnvClient; socket: FakeSocket } {
	const socket = new FakeSocket();
	const host = { files, projectsRefreshed() {}, brokerConfig() {} } as unknown as ClientHost;
	return { client: new EnvClient(host, socket), socket };
}

const read = (n: number): string => JSON.stringify({ t: "files.read", reqId: `r${n}`, root: "/r", path: "f.txt" });
const acks = (socket: FakeSocket): { reqId: string; ok: boolean; code?: string }[] =>
	socket.sent
		.map(f => JSON.parse(f) as { t: string; reqId: string; ok: boolean; code?: string })
		.filter(f => f.t === "ack");

describe("file requests at the edge of the daemon", () => {
	test("a client that cannot take replies is cut off from more file work once ~2 MiB of replies wait; they all flush when it can", async () => {
		const { client: c, socket } = client({ handle: async () => ({ kind: "text", text: PAGE }) });
		socket.buffered = 10 * 1024 * 1024; // the link is paused: nothing is written, everything queues
		for (let n = 1; n <= 10; n++) await c.receive(read(n)); // one at a time: the backlog is what limits
		expect(socket.sent).toHaveLength(0);
		// it did not queue ten pages: the first ~7 were served, the rest refused (and a refusal is tiny)
		socket.buffered = 0;
		c.pump();
		const answered = acks(socket);
		expect(answered).toHaveLength(10);
		const served = answered.filter(a => a.ok).length;
		expect(served).toBeGreaterThanOrEqual(6);
		expect(served).toBeLessThanOrEqual(8);
		expect(answered.filter(a => !a.ok).every(a => a.code === "busy")).toBe(true);
		// every reply is bounded
		expect(Math.max(...socket.sent.map(f => f.length))).toBeLessThan(400 * 1024);
		// and once the queue drained, the client may ask again
		await c.receive(read(11));
		expect(acks(socket).at(-1)).toMatchObject({ reqId: "r11", ok: true });
	});

	test("at most four file requests run at once per client; the others are refused at once with code busy", async () => {
		let running = 0;
		let peak = 0;
		const gate = Promise.withResolvers<void>();
		const { client: c, socket } = client({
			handle: async () => {
				running++;
				peak = Math.max(peak, running);
				await gate.promise;
				running--;
				return { kind: "dir" };
			},
		});
		const all = Array.from({ length: 7 }, (_, i) => c.receive(read(i + 1)));
		// the refusals are answered while the four are still running
		await Promise.all(all.slice(4));
		expect(acks(socket).map(a => [a.reqId, a.ok, a.code])).toEqual([
			["r5", false, "busy"],
			["r6", false, "busy"],
			["r7", false, "busy"],
		]);
		gate.resolve();
		await Promise.all(all);
		expect(peak).toBe(4);
		expect(acks(socket).filter(a => a.ok)).toHaveLength(4);
	});

	test("a refusal carries its code; any other failure is a plain error", async () => {
		const { client: c, socket } = client({
			handle: async (m: FilesClientMessage) => {
				if (m.reqId === "r1") throw new FileError("outside_root", "nope");
				throw new Error("boom");
			},
		});
		await c.receive(read(1));
		await c.receive(read(2));
		const [a, b] = socket.sent.map(f => JSON.parse(f) as Record<string, unknown>);
		expect(a).toMatchObject({ ok: false, error: "nope", code: "outside_root" });
		expect(b).toMatchObject({ ok: false, error: "boom" });
		expect(b).not.toHaveProperty("code");
	});

	test("malformed file frames are refused by validation, before any file work", async () => {
		let calls = 0;
		const { client: c, socket } = client({
			handle: async () => {
				calls++;
				return null;
			},
		});
		for (const frame of [
			{ t: "files.read", reqId: "a", root: "/r" }, // no path
			{ t: "files.read", reqId: "b", root: "", path: "x" },
			{ t: "files.read", reqId: "c", root: "/r", path: "x", fromLine: 0 },
			{ t: "files.read", reqId: "d", root: "/r", path: "x", maxLines: 99999 },
			{ t: "files.bytes", reqId: "e", root: "/r", path: "x", offset: 0, length: 10_000_000 },
			{ t: "files.diff", reqId: "f", root: "/r", path: "x", mode: "everything" },
			{ t: "files.list", reqId: "g", root: "/r", path: "x".repeat(5000) },
			{ t: "files.nope", reqId: "h", root: "/r" },
		]) {
			await c.receive(JSON.stringify(frame));
		}
		expect(calls).toBe(0);
		expect(acks(socket).map(a => a.ok)).toEqual(Array(8).fill(false));
	});
});
