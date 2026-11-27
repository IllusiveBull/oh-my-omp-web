import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
	writeSync,
	openSync,
	closeSync,
	statSync,
	existsSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	REPLICA_CHUNK_BYTES,
	REPLICA_MAX_CHUNK_BYTES,
	type EnvLinkMessage,
	type ReplicaFileMeta,
} from "@omp-web/protocol";
import { GatewayStore } from "../src/db";
import { ReplicaUploader } from "../src/replica-env";
import { replicaFileId } from "../src/replica-files";
import { ReplicaFiles, ReplicaSync } from "../src/replica-gateway";

const scratch = mkdtempSync(join(tmpdir(), "ompweb-replica-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MACHINE = "m_remote";
const NAME = "2026-11-01T10-00-00-000Z_sess-1.jsonl";

const slotLine = (title: string, updatedAt = "2026-11-01T10:00:00.000Z"): string =>
	serializeTitleSlot({ title, source: "user", updatedAt });
const line = (n: number, pad = 0): string =>
	`${JSON.stringify({ type: "message", id: `e${n}`, text: `entry ${n} é 😀 ${"x".repeat(pad)}` })}\n`;

interface Rig {
	source: string;
	store: GatewayStore;
	files: ReplicaFiles;
	sync: ReplicaSync;
	uploader: ReplicaUploader;
	/** Payload bytes of every `replica.data` that crossed the link, and every message type. */
	sent: { data: number; chunks: number; restarts: number; messages: string[] };
	buffered: { value: number };
	copy: () => string;
	announce: () => void;
	settle: () => Promise<void>;
}

let dir: string;
let n = 0;

function rig(): Rig {
	dir = join(scratch, `case-${++n}`);
	const sourceDir = join(dir, "source");
	mkdirSync(sourceDir, { recursive: true });
	const source = join(sourceDir, NAME);
	const store = GatewayStore.open(":memory:");
	store.upsertMachine({
		id: MACHINE,
		name: "remote",
		platform: "linux",
		daemonVersion: "t",
		omp: { version: "1", expectedVersion: "1", versionMismatch: false },
		leaseWarnings: [],
		lastSeen: 1,
	});
	const files = new ReplicaFiles(store, join(dir, "replicas"));
	const sent = { data: 0, chunks: 0, restarts: 0, messages: [] as string[] };
	const buffered = { value: 0 };
	const pending: Promise<void>[] = [];
	// biome-style forward references: the two halves talk to each other through these.
	const route = (message: EnvLinkMessage): void => {
		sent.messages.push(message.t);
		if (message.t === "replica.manifest") sync.manifest(message.files);
		else if (message.t === "replica.data") {
			sent.chunks++;
			sent.data += Buffer.from(message.data, "base64").length;
			if (message.restart) sent.restarts++;
			sync.data(message);
		} else if (message.t === "replica.skip") sync.skip(message.id, message.reason);
	};
	const uploader = new ReplicaUploader(route, () => buffered.value);
	const sync = new ReplicaSync(
		MACHINE,
		store,
		files,
		message => {
			if (message.t === "replica.want") pending.push(uploader.want(message.id, message.have));
		},
		() => {},
	);
	const meta = (): ReplicaFileMeta => {
		const info = statSync(source);
		return { id: replicaFileId(source), name: NAME, sessionId: "sess-1", size: info.size, mtimeMs: info.mtimeMs };
	};
	return {
		source,
		store,
		files,
		sync,
		uploader,
		sent,
		buffered,
		copy: () => readFileSync(join(dir, "replicas", MACHINE, NAME), "utf8"),
		announce: () => uploader.announce(existsSync(source) ? [{ path: source, meta: meta() }] : []),
		settle: async () => {
			for (let i = 0; i < 1000; i++) {
				if (pending.length > 0) await Promise.all(pending.splice(0));
				await sync.idle();
				if (pending.length === 0) return;
			}
			throw new Error("replica sync did not settle");
		},
	};
}

/** Rewrites the title slot in place, like omp's `updateSessionTitle`: same size, bumped mtime. */
function rewriteSlot(path: string, title: string, bump: number): void {
	const fd = openSync(path, "r+");
	const text = Buffer.from(slotLine(title, `2026-11-01T10:00:0${bump}.000Z`), "utf8");
	writeSync(fd, text, 0, text.length, 0);
	closeSync(fd);
	const later = new Date(Date.now() + bump * 1000);
	utimesSyncCompat(path, later);
}
function utimesSyncCompat(path: string, when: Date): void {
	utimesSync(path, when, when);
}

describe("transcript replica: env uploader and gateway sync", () => {
	let r: Rig;
	beforeEach(() => {
		r = rig();
	});

	test("the title slot is 256 bytes and a copy is byte-identical, binary-safe, split into bounded chunks ending at line ends", async () => {
		expect(Buffer.byteLength(slotLine("a title"))).toBe(256);
		const body = `${JSON.stringify({ type: "session", id: "sess-1" })}\n${Array.from({ length: 6000 }, (_, i) => line(i, 100)).join("")}`;
		writeFileSync(
			r.source,
			Buffer.concat([
				Buffer.from(slotLine("t")),
				Buffer.from(body),
				Buffer.from(`${JSON.stringify({ n: "a\u0000b" })}\n`),
			]),
		);
		r.announce();
		await r.settle();
		expect(r.copy()).toBe(readFileSync(r.source, "utf8"));
		expect(r.sent.chunks).toBeGreaterThan(2);
		expect(r.sent.data).toBe(statSync(r.source).size - 256);
		expect(r.sent.restarts).toBe(1); // the first transfer is a "restart" from nothing
		const row = r.store.replicaRows(MACHINE)[0]!;
		expect(row).toMatchObject({ size: statSync(r.source).size, sourceSize: statSync(r.source).size, slotLen: 256 });
		expect(REPLICA_CHUNK_BYTES).toBeLessThan(statSync(r.source).size);
	});

	test("an append sends only the new bytes", async () => {
		writeFileSync(r.source, slotLine("t") + line(0) + line(1));
		r.announce();
		await r.settle();
		const before = r.sent.data;
		appendFileSync(r.source, line(2) + line(3));
		r.announce();
		await r.settle();
		expect(r.sent.data - before).toBe(Buffer.byteLength(line(2) + line(3)));
		expect(r.sent.restarts).toBe(1);
		expect(r.copy()).toBe(readFileSync(r.source, "utf8"));
	});

	test("an unfinished last line waits until its newline arrives", async () => {
		writeFileSync(r.source, slotLine("t") + line(0) + '{"type":"message","id":"e1","te');
		r.announce();
		await r.settle();
		expect(r.copy()).toBe(slotLine("t") + line(0));
		appendFileSync(r.source, 'xt":"done"}\n');
		r.announce();
		await r.settle();
		expect(r.copy()).toBe(readFileSync(r.source, "utf8"));
	});

	test("a title rewritten in place (same size, new mtime) updates only the slot, not the body", async () => {
		writeFileSync(r.source, slotLine("old") + line(0) + line(1));
		r.announce();
		await r.settle();
		const bodyBytes = r.sent.data;
		rewriteSlot(r.source, "a better title", 2);
		r.announce();
		await r.settle();
		expect(r.sent.data).toBe(bodyBytes); // no body bytes moved
		expect(r.sent.restarts).toBe(1);
		expect(r.copy()).toBe(readFileSync(r.source, "utf8"));
		expect(r.copy().slice(0, 256)).toContain("a better title");
		const row = r.store.replicaRows(MACHINE)[0]!;
		expect(row.mtimeMs).toBe(row.sourceMtimeMs);
	});

	test("a rename followed by more turns catches up", async () => {
		writeFileSync(r.source, slotLine("old") + line(0));
		r.announce();
		await r.settle();
		rewriteSlot(r.source, "renamed", 3);
		appendFileSync(r.source, line(1) + line(2));
		r.announce();
		await r.settle();
		expect(r.copy()).toBe(readFileSync(r.source, "utf8"));
	});

	test("a rewritten file (different content, even of the same size) is detected and copied again from the start", async () => {
		writeFileSync(r.source, slotLine("t") + line(0, 50) + line(1, 50));
		r.announce();
		await r.settle();
		// same length, different first entry: only the head hash can tell
		writeFileSync(r.source, slotLine("t") + line(0, 50).replace("entry 0", "entry 9") + line(1, 50));
		utimesSyncCompat(r.source, new Date(Date.now() + 5000));
		r.announce();
		await r.settle();
		expect(r.sent.restarts).toBe(2);
		expect(r.copy()).toBe(readFileSync(r.source, "utf8"));
		// a file replaced by a longer one with different content
		writeFileSync(r.source, slotLine("t") + line(7) + line(8) + line(9));
		utimesSyncCompat(r.source, new Date(Date.now() + 9000));
		r.announce();
		await r.settle();
		expect(r.sent.restarts).toBe(3);
		expect(r.copy()).toBe(readFileSync(r.source, "utf8"));
	});

	test("a file that got shorter, or lost its title slot, starts over", async () => {
		writeFileSync(r.source, slotLine("t") + line(0) + line(1) + line(2));
		r.announce();
		await r.settle();
		truncateSync(r.source, 256 + Buffer.byteLength(line(0)));
		utimesSyncCompat(r.source, new Date(Date.now() + 2000));
		r.announce();
		await r.settle();
		expect(r.copy()).toBe(readFileSync(r.source, "utf8"));
		expect(r.sent.restarts).toBe(2);
		writeFileSync(r.source, line(0) + line(1)); // rewritten without a slot
		utimesSyncCompat(r.source, new Date(Date.now() + 4000));
		r.announce();
		await r.settle();
		expect(r.copy()).toBe(line(0) + line(1));
		expect(r.store.replicaRows(MACHINE)[0]!.slotLen).toBe(0);
	});

	test("files no longer in the manifest are deleted from the copy and the index; a vanished file does not loop", async () => {
		writeFileSync(r.source, slotLine("t") + line(0));
		r.announce();
		await r.settle();
		expect(existsSync(join(dir, "replicas", MACHINE, NAME))).toBe(true);
		rmSync(r.source);
		r.uploader.announce([
			{
				path: r.source,
				meta: { id: replicaFileId(r.source), name: NAME, sessionId: "sess-1", size: 9, mtimeMs: 1 },
			},
		]);
		await r.settle(); // the file is gone: skip, not a retry loop
		expect(r.sent.messages.filter(m => m === "replica.skip")).toHaveLength(1);
		r.announce(); // the machine now lists nothing
		await r.settle();
		expect(existsSync(join(dir, "replicas", MACHINE, NAME))).toBe(false);
		expect(r.store.replicaRows(MACHINE)).toEqual([]);
	});

	test("a line longer than the cap is skipped with a reason instead of being copied piecemeal", async () => {
		writeFileSync(r.source, slotLine("t") + line(0) + `${"y".repeat(REPLICA_MAX_CHUNK_BYTES + 10)}\n`);
		const warn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
		try {
			r.announce();
			await r.settle();
		} finally {
			console.warn = warn;
		}
		expect(warnings.some(w => w.includes("longer than"))).toBe(true);
		// the lines before it are not lost silently either: the file simply is not replicated
		expect(r.sent.messages.filter(m => m === "replica.skip")).toHaveLength(1);
	});

	test("an upload waits while the link still holds a backlog (live traffic goes first)", async () => {
		writeFileSync(r.source, slotLine("t") + line(0));
		r.buffered.value = 10 * 1024 * 1024;
		r.announce();
		await Bun.sleep(150); // negative assertion: the chunk must not be sent while the socket is backed up
		expect(r.sent.chunks).toBe(0);
		r.buffered.value = 0;
		await r.settle();
		expect(r.sent.chunks).toBe(1);
		expect(r.copy()).toBe(readFileSync(r.source, "utf8"));
	});

	test("names that could leave the machine's directory are ignored", async () => {
		const evil = join(dir, "source", "x.jsonl");
		writeFileSync(evil, slotLine("t") + line(0));
		r.uploader.announce([
			{ path: evil, meta: { id: "evil", name: "../../escape.jsonl", sessionId: "s", size: 10, mtimeMs: 1 } },
		]);
		await r.settle();
		expect(r.sent.chunks).toBe(0);
		expect(existsSync(join(dir, "escape.jsonl"))).toBe(false);
		expect(basename(evil)).toBe("x.jsonl");
	});
});
