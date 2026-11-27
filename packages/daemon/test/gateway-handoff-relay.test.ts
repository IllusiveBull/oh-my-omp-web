import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { XFER_CHUNK_BYTES, XFER_WINDOW, type HandoffOpResult, type XferInfo } from "@omp-web/protocol";
import type { HandoffPort } from "../src/handoff-service";
import { HandoffCallError, pumpTransfer } from "../src/handoff-link";
import type { ProjectRegistry } from "../src/projects";
import { TerminalService } from "../src/terminal-service";
import { Harness, makeRepo } from "./gateway-harness";
import { startRemote, type Remote } from "./remote-harness";
import { fakePtyFactory } from "./terminal-fixtures";

const MIB = 1024 * 1024;
/** The gateway, both daemons and the test share one event loop here: a heartbeat tuned for idle links would misfire. */
const SLOW_HEARTBEAT = { intervalMs: 2000, timeoutMs: 30_000 };

const BLOCK = crypto.getRandomValues(new Uint8Array(1021 * 1021)); // a prime-ish length: copies at different offsets never align
/** Bytes by offset: nothing is stored, so only the code under test can hold the transfer in memory. */
function pattern(offset: number, len: number): Uint8Array {
	const out = new Uint8Array(len);
	let at = 0;
	while (at < len) {
		const from = (offset + at) % BLOCK.length;
		const take = Math.min(len - at, BLOCK.length - from);
		out.set(BLOCK.subarray(from, from + take), at);
		at += take;
	}
	return out;
}

/** An environment's handoff port serving (or receiving) one big file; records what a chunk-by-chunk receiver sees. */
class FileServer implements HandoffPort {
	received = 0;
	hasher = new Bun.CryptoHasher("sha256");
	expectedSize = 0;
	dropAtOffset: number | null = null;
	dropped: (() => void) | null = null;
	readonly #size: number;

	constructor(size: number) {
		this.#size = size;
	}

	async call(op: string): Promise<never> {
		if (op === "source.bundle") {
			const hasher = new Bun.CryptoHasher("sha256");
			for (let at = 0; at < this.#size; at += 4 * MIB)
				hasher.update(pattern(at, Math.min(4 * MIB, this.#size - at)));
			return {
				xfer: { id: "xfer-big-0001", size: this.#size, sha256: hasher.digest("hex") } satisfies XferInfo,
				full: true,
				prerequisites: 0,
			} as never;
		}
		if (op === "target.receive") {
			this.received = 0;
			this.hasher = new Bun.CryptoHasher("sha256");
			return { xfer: "recv-big-0001" } as HandoffOpResult["target.receive"] as never;
		}
		throw new Error(`unexpected ${op}`);
	}

	toWireError(error: unknown) {
		return { message: error instanceof Error ? error.message : String(error), kind: "failed" as const };
	}

	async readChunk(_xfer: string, offset: number, len: number) {
		if (this.dropAtOffset !== null && offset >= this.dropAtOffset) {
			this.dropped?.();
			await new Promise(() => {}); // the daemon is gone: the answer never comes (its link is cut by the test)
		}
		const take = Math.min(len, this.#size - offset);
		return { data: pattern(offset, take), eof: offset + take >= this.#size };
	}

	async writeChunk(_xfer: string, offset: number, bytes: Uint8Array): Promise<void> {
		if (offset !== this.received) throw new Error("out of order");
		this.hasher.update(bytes);
		this.received += bytes.byteLength;
	}

	close(): void {}
}

let repo: string;
let remoteRepo: string;
let h: Harness | undefined;
const remotes: Remote[] = [];

beforeAll(async () => {
	repo = await makeRepo();
	remoteRepo = await makeRepo();
});
afterAll(() => {
	rmSync(dirname(repo), { recursive: true, force: true });
	rmSync(dirname(remoteRepo), { recursive: true, force: true });
});
afterEach(async () => {
	for (const r of remotes.splice(0)) await r.stop();
	await h?.stop();
	h = undefined;
});

async function until(label: string, predicate: () => boolean, ms = 10_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(5);
	}
}

describe("a large transfer relayed through the gateway", () => {
	test("arrives intact over real links with at most the window in flight, while a terminal on the target machine keeps its echo", async () => {
		const size = 256 * MIB;
		const source = new FileServer(size);
		const sink = new FileServer(size);
		const wire: { projects?: ProjectRegistry } = {};
		const { factory, ptys } = fakePtyFactory();
		const terminals = new TerminalService({
			enabled: true,
			machineId: () => "m_remote",
			resolveShell: () => "/bin/sh",
			resolveCwd: cwd => wire.projects!.resolveCwd(cwd),
			factory,
			audit: () => {},
		});
		h = await Harness.start({ repo, handoff: source, heartbeat: SLOW_HEARTBEAT });
		const remote = await startRemote(h, remoteRepo, { handoff: sink, terminals, heartbeat: SLOW_HEARTBEAT });
		remotes.push(remote);
		wire.projects = remote.projects;
		await until(
			"remote registered",
			() => h!.gateway.peerOf(remote.id) !== null && h!.gateway.peerOf(remote.id) !== "unknown",
		);
		const from = h.gateway.peerOf(h.gateway.machines().find(m => m.gateway)!.id);
		const to = h.gateway.peerOf(remote.id);
		if (from === "unknown" || from === null || to === "unknown" || to === null)
			throw new Error("machines are not linked");

		const browser = await h.connect(remote.id);
		const open = await browser.call({ t: "term.open", cols: 80, rows: 24, cwd: remoteRepo });
		const id = (open.data as { terminal: { id: string } }).terminal.id;
		await browser.call({ t: "term.attach", id, offset: null, cols: 80, rows: 24 });

		const info = (
			await from.rpc.call("source.bundle", { opId: "op000001", threadId: "t1", have: [], limits: limits() })
		).xfer;
		const recv = await to.rpc.call("target.receive", {
			opId: "op000001",
			threadId: "t1",
			kind: "bundle",
			size: info.size,
			sha256: info.sha256,
		});

		// What the gateway holds at once: requested from the source, not yet acknowledged by the target.
		let requested = 0;
		let acked = 0;
		let peak = 0;
		const read = from.rpc.readChunk.bind(from.rpc);
		from.rpc.readChunk = (xfer, offset, len) => {
			requested += len;
			peak = Math.max(peak, requested - acked);
			return read(xfer, offset, len);
		};
		const write = to.rpc.writeChunk.bind(to.rpc);
		to.rpc.writeChunk = async (xfer, offset, data) => {
			const box = await write(xfer, offset, data);
			void box.ack.then(() => {
				acked += Buffer.from(data, "base64").length;
			});
			return box;
		};

		// Keystroke echo round trips through the same link while the transfer runs.
		const echoes: number[] = [];
		let running = true;
		const echoLoop = (async () => {
			let n = 0;
			while (running) {
				const mark = `echo-${n++}`;
				const sentAt = performance.now();
				browser.raw(JSON.stringify({ reqId: "", m: remote.id, t: "term.input", id, data: mark }));
				await until(`pty to receive ${mark}`, () => ptys[0]!.written.includes(mark), 5000);
				ptys[0]!.emit(mark);
				await browser.waitFor(f => f.t === "term.out" && f.m === remote.id && f.data.includes(mark));
				echoes.push(performance.now() - sentAt);
				await Bun.sleep(10);
			}
		})();

		const started = performance.now();
		await pumpTransfer(from.rpc, info, to.rpc, recv.xfer);
		running = false;
		await echoLoop;
		const seconds = (performance.now() - started) / 1000;

		expect(sink.received).toBe(size);
		expect(sink.hasher.digest("hex")).toBe(info.sha256);
		expect(peak).toBeLessThanOrEqual(XFER_WINDOW * XFER_CHUNK_BYTES);
		expect(echoes.length).toBeGreaterThan(5);
		const sorted = [...echoes].sort((a, b) => a - b);
		const median = sorted[Math.floor(sorted.length / 2)]!;
		console.log(
			`[relay] ${size / MIB} MiB in ${seconds.toFixed(1)} s, peak in flight ${(peak / 1024).toFixed(0)} KiB, echo n=${echoes.length} median ${median.toFixed(1)} ms max ${sorted.at(-1)!.toFixed(1)} ms`,
		);
		// The terminal lane is not queued behind the bulk transfer: a keystroke is answered in well under a second.
		expect(sorted.at(-1)!).toBeLessThan(1000);
	}, 120_000);

	test("the machine holding the source going away mid-transfer fails the pump with that machine named, and the target has not been handed more than it acknowledged", async () => {
		const size = 16 * MIB;
		const source = new FileServer(size);
		const sink = new FileServer(size);
		source.dropAtOffset = 4 * MIB;
		h = await Harness.start({ repo, handoff: sink, heartbeat: SLOW_HEARTBEAT });
		const remote = await startRemote(h, remoteRepo, { handoff: source, heartbeat: SLOW_HEARTBEAT });
		remotes.push(remote);
		await until("remote registered", () => {
			const p = h!.gateway.peerOf(remote.id);
			return p !== null && p !== "unknown";
		});
		const from = h.gateway.peerOf(remote.id);
		const to = h.gateway.peerOf(h.gateway.machines().find(m => m.gateway)!.id);
		if (from === "unknown" || from === null || to === "unknown" || to === null)
			throw new Error("machines are not linked");
		const info = (
			await from.rpc.call("source.bundle", { opId: "op000002", threadId: "t1", have: [], limits: limits() })
		).xfer;
		const recv = await to.rpc.call("target.receive", {
			opId: "op000002",
			threadId: "t1",
			kind: "bundle",
			size: info.size,
			sha256: info.sha256,
		});
		source.dropped = () => void remote.dialer.stop();
		const error = await pumpTransfer(from.rpc, info, to.rpc, recv.xfer).catch((e: unknown) => e);
		expect((error as Error).message).toContain("went offline");
		expect(error).toBeInstanceOf(HandoffCallError);
		expect((error as HandoffCallError).kind).toBe("link");
		expect(sink.received).toBeLessThan(size);
		expect(sink.received).toBeGreaterThanOrEqual(4 * MIB - XFER_WINDOW * XFER_CHUNK_BYTES);
	}, 60_000);
});

function limits() {
	return { maxFileBytes: MIB, maxTotalBytes: 8 * MIB, maxBundleBytes: 512 * MIB, maxArchiveBytes: 512 * MIB };
}
