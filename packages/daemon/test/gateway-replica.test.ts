import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	rmSync,
	statSync,
	utimesSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AttentionEvent, GatewaySessionInfo } from "@omp-web/protocol";
import type { AttentionSink } from "../src/attention";
import { DEFAULT_REPLICA_POLICY } from "../src/env-host";
import { Harness, makeRepo, sig, type TestClient } from "./gateway-harness";
import { startRemote as startRemoteOn, type Remote, type RemoteOptions } from "./remote-harness";
import { assistant, titleSlot, turns, user, writeSessionFile } from "./session-files";

const FAST = { ...DEFAULT_REPLICA_POLICY, scanIntervalMs: 40 };
const T0 = Date.parse("2026-11-01T10:00:00.000Z");

let repo: string;
let remoteRepo: string;
let h: Harness;
const remotes: Remote[] = [];
const machineDirs: string[] = [];

beforeAll(async () => {
	repo = await makeRepo();
	remoteRepo = await makeRepo();
});
afterAll(() => {
	rmSync(dirname(repo), { recursive: true, force: true });
	rmSync(dirname(remoteRepo), { recursive: true, force: true });
	for (const dir of machineDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
	h = await Harness.start({ repo, heartbeat: { intervalMs: 20, timeoutMs: 120 } });
});
afterEach(async () => {
	for (const r of remotes.splice(0)) await r.stop();
	await h.stop();
});

/** Starts the second machine; `seed` writes session files into its store before its daemon starts. */
async function remote(options: RemoteOptions & { seed?: (sessionDir: string) => void } = {}): Promise<Remote> {
	const dir = mkdtempSync(join(tmpdir(), "ompweb-remote-"));
	machineDirs.push(dir);
	options.seed?.(join(dir, "sessions"));
	const r = await startRemoteOn(h, remoteRepo, { replica: FAST, dir, ...options });
	remotes.push(r);
	return r;
}

const until = async (predicate: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
	const start = Date.now();
	while (!(await predicate())) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
};

const listed = (c: TestClient, machine: string, id: string): GatewaySessionInfo | undefined => {
	const last = c.frames.findLast(f => f.t === "sessions" && f.m === machine);
	return last?.t === "sessions" ? last.sessions.find(s => s.id === id) : undefined;
};

const seedConversation = (sessionDir: string, id = "sess-1", extra: object[] = [], slotTitle?: string): string =>
	writeSessionFile(sessionDir, {
		id,
		created: new Date(T0).toISOString(),
		cwd: remoteRepo,
		title: "From the remote",
		slotTitle,
		entries: [...turns("t", ["question", "answer"], T0 + 1000), ...extra],
	});

describe("offline reading from the transcript replica", () => {
	test("a client that never saw the session while the machine was online reads it, read-only, as the online page showed it", async () => {
		const r = await remote({ seed: dir => seedConversation(dir, "sess-1", [], "From the remote") });
		const online = await h.connect(r.id);
		await until(() => listed(online, r.id, "sess-1") !== undefined);
		expect((await online.call({ t: "subscribe", sessionId: "sess-1", lastSeq: 0 })).ok).toBe(true);
		await until(() => online.view.entries.length === 2);
		await until(() => listed(online, r.id, "sess-1")?.replica?.state === "complete");
		const liveView = sig(online.view);
		expect(listed(online, r.id, "sess-1")?.replica).toMatchObject({ state: "complete" });

		await r.stop(); // the machine goes away; nothing of this session is cached anywhere but the replica
		const fresh = await h.connect(r.id);
		await until(() => fresh.frames.some(f => f.t === "machines" && f.machines.some(m => m.id === r.id && !m.online)));
		const ack = await fresh.call({ t: "subscribe", sessionId: "sess-1", lastSeq: 0 });
		expect(ack).toMatchObject({ ok: true, data: { mode: "snapshot", replica: { state: "complete" } } });
		await until(() => fresh.view.entries.length === 2);
		expect(sig(fresh.view)).toBe(liveView);
		expect(fresh.frames.filter(f => f.t === "snapshot.begin").every(f => "m" in f && f.m === r.id)).toBe(true);
		// the replica is how fresh? the file's own mtime on the machine, and when the gateway last received bytes
		const info = listed(fresh, r.id, "sess-1")!;
		expect(info.replica!.asOf).toBeGreaterThan(Date.now() - 60_000);
		expect(info.replica!.syncedAt).toBeGreaterThanOrEqual(info.replica!.asOf - 1000);

		// everything that would change anything still fails the usual way
		expect(await fresh.call({ t: "prompt", sessionId: "sess-1", message: "hi" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("is offline"),
		});
		expect((await fresh.call({ t: "unsubscribe", sessionId: "sess-1" })).ok).toBe(true);
		// a session that was never replicated cannot be opened
		expect(await fresh.call({ t: "subscribe", sessionId: "nope", lastSeq: 0 })).toMatchObject({
			ok: false,
			error: expect.stringContaining("holds no copy"),
		});
	});

	test("images are not replicated: they arrive as a text block that says so, and the rest of the transcript is intact", async () => {
		const image = {
			type: "message",
			id: "img",
			parentId: "t1",
			timestamp: new Date(T0 + 5000).toISOString(),
			message: {
				role: "user",
				content: [
					{ type: "text", text: "look at this" },
					{ type: "image", data: `blob:sha256:${"ab".repeat(32)}`, mimeType: "image/png" },
				],
				attribution: "user",
				timestamp: T0 + 5000,
			},
		};
		const r = await remote({ seed: dir => seedConversation(dir, "sess-img", [image]) });
		const online = await h.connect(r.id);
		await until(() => listed(online, r.id, "sess-img")?.replica?.state === "complete");
		await r.stop();
		const fresh = await h.connect(r.id);
		await until(() => fresh.frames.some(f => f.t === "machines" && f.machines.some(m => m.id === r.id && !m.online)));
		await fresh.call({ t: "subscribe", sessionId: "sess-img", lastSeq: 0 });
		await until(() => fresh.view.entries.length === 3);
		const text = JSON.stringify(fresh.view.entries.at(-1));
		expect(text).toContain("[image not replicated to the gateway]");
		expect(text).not.toContain("blob:sha256");
		expect(text).toContain("look at this");
	});

	test("a rename (the title slot rewritten in place) and further turns reach the replica without a browser being connected", async () => {
		let path = "";
		const r = await remote({ seed: dir => (path = seedConversation(dir, "sess-1", [], "old title")) });
		await until(() => h.store.replicaRows(r.id)[0]?.size === statSync(path).size, 4000);
		// the machine renames the session (same-size slot rewrite) and a turn is appended
		const slot = Buffer.from(titleSlot("renamed on the machine", "2026-11-02T10:00:00.000Z"));
		expect(slot.length).toBe(256);
		const fd = openSync(path, "r+");
		writeSync(fd, slot, 0, slot.length, 0);
		closeSync(fd);
		appendFileSync(
			path,
			`${JSON.stringify(user("t2", "t1", "one more question", new Date(T0 + 9000).toISOString()))}\n`,
		);
		appendFileSync(
			path,
			`${JSON.stringify(assistant("t3", "t2", "one more answer", new Date(T0 + 10000).toISOString()))}\n`,
		);
		const size = statSync(path).size;
		await until(() => h.store.replicaRows(r.id)[0]?.size === size);
		// no browser has been connected to this machine at any point: the slow scan alone did it
		expect(r.host.clientCount).toBe(0);
		await r.stop();
		const fresh = await h.connect(r.id);
		await until(() => fresh.frames.some(f => f.t === "machines" && f.machines.some(m => m.id === r.id && !m.online)));
		await until(() => listed(fresh, r.id, "sess-1")?.replica?.state === "complete");
		await fresh.call({ t: "subscribe", sessionId: "sess-1", lastSeq: 0 });
		await until(() => fresh.view.entries.length === 4);
		expect(fresh.view.status?.sessionName).toBe("renamed on the machine");
	});

	test("what is replicated: recently active conversations within the size cap; the rest is not copied (and is not offered)", async () => {
		const r = await remote({
			replica: { ...FAST, maxFileBytes: 4000 },
			seed: dir => {
				seedConversation(dir, "recent");
				const old = seedConversation(dir, "stale");
				const big = seedConversation(dir, "big", [
					{ ...user("pad", "t1", "z".repeat(6000), new Date(T0 + 7000).toISOString()) },
				]);
				const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
				utimesSync(old, longAgo, longAgo);
				expect(statSync(big).size).toBeGreaterThan(4000);
			},
		});
		await until(() =>
			h.store.replicaRows(r.id).some(row => row.sessionId === "recent" && row.size === row.sourceSize),
		);
		await Bun.sleep(200); // negative: let further scans run before asserting the others never appear
		expect(h.store.replicaRows(r.id).map(row => row.sessionId)).toEqual(["recent"]);
	});

	test("when the machine stops listing a file, its copy is deleted from the gateway", async () => {
		let path = "";
		const r = await remote({ seed: dir => (path = seedConversation(dir, "sess-1")) });
		await until(() => h.store.replicaRows(r.id).length === 1 && h.store.replicaRows(r.id)[0]!.size > 0);
		const copy = join(h.replicaDir, r.id, h.store.replicaRows(r.id)[0]!.name);
		expect(statSync(copy).size).toBeGreaterThan(0);
		rmSync(path);
		await until(() => h.store.replicaRows(r.id).length === 0);
		// the row is dropped first and the file removed right after (an async rm): wait for that end state, not a moment
		await until(() => !existsSync(copy));
		expect(() => statSync(copy)).toThrow();
	});
});

describe("hosted sessions that need a human (reported over the link, no browser connected)", () => {
	class Sink implements AttentionSink {
		events: { machine: string; event: AttentionEvent }[] = [];
		seenIds: string[] = [];
		attention(machine: string, event: AttentionEvent): void {
			this.events.push({ machine, event });
		}
		seen(machine: string, sessionId: string): void {
			this.seenIds.push(`${machine}/${sessionId}`);
		}
	}

	test("the end of a run and a pending question are reported with title and detail; a run that never started, an editor and display requests are not", async () => {
		const sink = new Sink();
		await h.stop();
		h = await Harness.start({ repo, attention: sink });
		const client = await h.connect();
		const id = await h.createSession(client);
		client.close(); // from here on nobody is connected at all
		const source = h.sources[0]!;
		const assistantMessage = (text: string) => ({
			role: "assistant",
			content: [{ type: "text", text }],
			model: "m",
			stopReason: "stop",
			timestamp: 1,
			usage: {},
		});

		source.emit({ type: "agent_end", messages: [] } as never); // not preceded by a run
		source.emit({ type: "agent_start" } as never);
		source.emit({
			type: "message_end",
			message: assistantMessage("All done.\n\nTests are green and the branch is pushed."),
		} as never);
		source.emit({ type: "agent_end", messages: [] } as never);
		await until(() => sink.events.length === 1);
		expect(sink.events[0]).toMatchObject({
			machine: "m_self",
			event: { sessionId: id, kind: "turn_end", detail: "All done. Tests are green and the branch is pushed." },
		});
		expect(sink.events[0]!.event.title.length).toBeGreaterThan(0);

		source.emitUi({
			type: "extension_ui_request",
			id: "u1",
			method: "confirm",
			title: "Deploy?",
			message: "to production",
		});
		await until(() => sink.events.length === 2);
		expect(sink.events[1]!.event).toMatchObject({ kind: "input_needed", detail: "Deploy?: to production" });
		source.emitUi({ type: "extension_ui_request", id: "u2", method: "editor", title: "Edit this" });
		source.emitUi({
			type: "extension_ui_request",
			id: "u3",
			method: "notify",
			message: "fyi",
			notifyType: "info",
		} as never);
		await Bun.sleep(60); // negative: nothing further may be reported
		expect(sink.events).toHaveLength(2);
		expect(DEFAULT_REPLICA_POLICY.retentionDays).toBe(30);
	});
});
