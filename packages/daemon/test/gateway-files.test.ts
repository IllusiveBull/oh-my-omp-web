/**
 * File requests end to end through the gateway: browser -> gateway -> link -> daemon (own machine in-process, and a
 * second machine over a real link), replies relayed untouched, no starvation of live session traffic by a large file,
 * and the offline behaviour.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FileBytes, FileContent, FileDiff, FileListing, GitStatus, MachineSummary } from "@omp-web/protocol";
import { Harness, SELF, git, makeRepo, type TestClient } from "./gateway-harness";
import { startRemote as startRemoteOn, type Remote } from "./remote-harness";
import { makeLink } from "./links";

let repo: string;
let remoteRepo: string;
let h: Harness;
const remotes: Remote[] = [];

const LINES = 40_000;
const line = (n: number): string => `row ${String(n).padStart(6, "0")} ${"q".repeat(70)}\n`;
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

beforeAll(async () => {
	repo = await makeRepo();
	remoteRepo = await makeRepo();
	for (const root of [repo, remoteRepo]) {
		writeFileSync(join(root, "big.txt"), Array.from({ length: LINES }, (_, i) => line(i + 1)).join(""));
		writeFileSync(join(root, "pic.png"), PNG);
		writeFileSync(join(root, "README.md"), "hello\nchanged\n");
		writeFileSync(join(root, "untracked.txt"), "new\n");
		makeLink(dirname(root), join(root, "out"));
		await git(root, "add", "big.txt", "pic.png");
		await git(root, "commit", "-q", "-m", "files");
	}
});
afterAll(() => {
	rmSync(dirname(repo), { recursive: true, force: true });
	rmSync(dirname(remoteRepo), { recursive: true, force: true });
});
beforeEach(async () => {
	h = await Harness.start({ repo });
});
afterEach(async () => {
	for (const r of remotes.splice(0)) await r.stop();
	await h.stop();
});

const startRemote = async (): Promise<{ remote: Remote; client: TestClient }> => {
	const remote = await startRemoteOn(h, remoteRepo, { backoff: { minMs: 400, maxMs: 400 } });
	remotes.push(remote);
	const client = await h.connect(remote.id);
	await until(() => machine(client, remote.id)?.online === true);
	return { remote, client };
};

const until = async (predicate: () => boolean, ms = 3000): Promise<void> => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
};
const machine = (c: TestClient, id: string): MachineSummary | undefined =>
	(c.frames.findLast(f => f.t === "machines") as { machines: MachineSummary[] } | undefined)?.machines.find(
		m => m.id === id,
	);

type Text = Extract<FileContent, { kind: "text" }>;
interface Ack<T> {
	ok: boolean;
	data: T;
	error?: string;
	code?: string;
	m?: string;
}
const call = async <T>(c: TestClient, root: string, req: Record<string, unknown>): Promise<Ack<T>> =>
	(await c.call({ ...req, root } as never)) as never;

describe("files through the gateway", () => {
	for (const where of ["the gateway's own machine", "a second machine"] as const) {
		test(`list, read, bytes, status and diff on ${where}; replies carry the machine id`, async () => {
			const own = where === "the gateway's own machine";
			const { remote, client } = own ? { remote: null, client: await h.connect() } : await startRemote();
			const id = own ? SELF : remote!.id;
			const root = own ? repo : remoteRepo;

			const listing = await call<FileListing>(client, root, { t: "files.list", path: "" });
			expect(listing).toMatchObject({ ok: true, m: id });
			expect(listing.data.entries.map(e => e.name)).toEqual(
				expect.arrayContaining(["big.txt", "pic.png", "README.md", "out"]),
			);
			expect(listing.data.entries.find(e => e.name === "out")?.link?.resolves).toBe("outside");

			const text = await call<FileContent>(client, root, { t: "files.read", path: "README.md" });
			expect(text.data).toMatchObject({ kind: "text", text: "hello\nchanged\n" });
			const image = await call<FileContent>(client, root, { t: "files.read", path: "pic.png" });
			expect(image.data).toMatchObject({ kind: "image", mime: "image/png" });
			const bytes = await call<FileBytes>(client, root, {
				t: "files.bytes",
				path: "pic.png",
				offset: 0,
				length: 4096,
			});
			expect(Buffer.from(bytes.data.data, "base64")).toEqual(PNG);

			const status = await call<GitStatus>(client, root, { t: "files.status" });
			expect(status.data.entries.map(e => [e.path, e.kind])).toEqual(
				expect.arrayContaining([
					["README.md", "changed"],
					["untracked.txt", "untracked"],
				]),
			);
			const diff = await call<FileDiff>(client, root, { t: "files.diff", path: "README.md", mode: "unstaged" });
			expect(diff.data.diff).toContain("+changed");
		});
	}

	test("refusals reach the browser with their code: traversal, escape, git's directory, unregistered root", async () => {
		const client = await h.connect();
		const codes: Record<string, string | undefined> = {};
		for (const [name, req] of Object.entries({
			traversal: { t: "files.read", path: "../x" },
			escape: { t: "files.read", path: "out/secret" },
			git: { t: "files.read", path: ".git/config" },
			absolute: { t: "files.list", path: "/etc" },
		})) {
			const ack = await call(client, repo, req);
			expect(ack.ok).toBe(false);
			codes[name] = ack.code;
		}
		expect(codes).toEqual({ traversal: "bad_path", escape: "outside_root", git: "forbidden", absolute: "bad_path" });
		const unregistered = await call(client, dirname(repo), { t: "files.list", path: "" });
		expect(unregistered).toMatchObject({ ok: false, code: "not_registered" });
		// a subdirectory of a registered worktree is not a worktree root
		const sub = await call(client, join(repo, "out"), { t: "files.list", path: "" });
		expect(sub).toMatchObject({ ok: false, code: "not_registered" });
	});

	test("a large file is paged in bounded frames while live session traffic keeps flowing between them", async () => {
		const { remote, client } = await startRemote();
		const created = await client.call({ t: "session.create", cwd: remoteRepo });
		const sessionId = (created.data as { sessionId: string }).sessionId;
		await client.call({ t: "subscribe", sessionId, lastSeq: 0 });
		const source = remote.sources[0]!;
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
		let n = 0;
		const live = setInterval(() => source.emit({ type: "message_update", message: message(++n) } as never), 3);
		try {
			let at: number | null = 1 as number | null;
			let pages = 0;
			let rebuilt = 0;
			const marks: number[] = []; // index in the browser's frame list of every file page
			while (at !== null) {
				const ack: Ack<Text> = await call<Text>(client, remoteRepo, {
					t: "files.read",
					path: "big.txt",
					fromLine: at,
					maxLines: 5000,
				});
				expect(ack.ok).toBe(true);
				marks.push(client.rawFrames.length);
				rebuilt += Buffer.byteLength(ack.data.text);
				at = ack.data.nextLine;
				pages++; // the next page is requested after the previous arrived: the client sets the pace
			}
			expect(rebuilt).toBe(Buffer.byteLength(Array.from({ length: LINES }, (_, i) => line(i + 1)).join("")));
			expect(pages).toBeGreaterThan(10);
			// every frame the browser got is bounded; the large file never travelled as one frame
			expect(Math.max(...client.rawFrames.map(f => f.length))).toBeLessThan(800 * 1024);
			// live events were delivered between the file pages (the link was not monopolized)
			const eventFramesBetween = client.rawFrames
				.slice(marks[0]!, marks.at(-1)!)
				.filter(f => f.startsWith('{"m":') && f.includes('"t":"events"')).length;
			expect(eventFramesBetween).toBeGreaterThan(0);
		} finally {
			clearInterval(live);
		}
	});

	test("while the browser's socket is backed up the daemon holds the reply instead of sending it; it flushes on resume", async () => {
		const client = await h.connect();
		await call(client, repo, { t: "files.list", path: "" }); // opens the virtual client
		const peer = h.gateway.peerOf(SELF);
		if (peer === null || peer === "unknown") throw new Error("local env is not registered");
		const cid = [...peer.clients.keys()][0]!;
		peer.link.send(JSON.stringify({ t: "pause", cid }));
		const pending = call<Extract<FileContent, { kind: "text" }>>(client, repo, {
			t: "files.read",
			path: "big.txt",
			fromLine: 1,
			maxLines: 5000,
		});
		await Bun.sleep(100); // a negative assertion: there is no event to await, only the absence of a reply
		expect(
			client.frames.filter(f => f.t === "ack" && "data" in f && JSON.stringify(f.data).includes("row 000001")),
		).toHaveLength(0);
		peer.link.send(JSON.stringify({ t: "resume", cid }));
		const ack = await pending;
		expect(ack.ok).toBe(true);
		expect(ack.data.text.startsWith("row 000001")).toBe(true);
	});
});

describe("a machine that is offline", () => {
	test("file requests are answered at once with a clear error; nothing is served from the gateway", async () => {
		const { remote, client } = await startRemote();
		expect((await call(client, remoteRepo, { t: "files.list", path: "" })).ok).toBe(true);
		h.gateway.disconnectEnv(remote.id, "test: link drop");
		await until(() => machine(client, remote.id)?.online === false);
		for (const req of [
			{ t: "files.list", path: "" },
			{ t: "files.read", path: "README.md" },
			{ t: "files.status" },
		]) {
			expect(await call(client, remoteRepo, req)).toMatchObject({
				ok: false,
				error: expect.stringContaining("is offline"),
			});
		}
		// back online (the daemon redials with a new link id): files work again with no page reload
		await until(() => machine(client, remote.id)?.online === true && machine(client, remote.id)?.linkId === 2);
		expect((await call(client, remoteRepo, { t: "files.list", path: "" })).ok).toBe(true);
	});

	test("a request in flight when the link drops fails with 'went offline' instead of hanging", async () => {
		const { remote, client } = await startRemote();
		await call(client, remoteRepo, { t: "files.list", path: "" });
		const peer = h.gateway.peerOf(remote.id);
		if (peer === null || peer === "unknown") throw new Error("remote is not registered");
		const cid = [...peer.clients.keys()][0]!;
		peer.link.send(JSON.stringify({ t: "pause", cid })); // the reply is held in the daemon, so the request stays in flight
		const pending = call(client, remoteRepo, { t: "files.read", path: "README.md" });
		await Bun.sleep(50); // let the request reach the daemon (a negative: no reply can arrive)
		h.gateway.disconnectEnv(remote.id, "test: link drop");
		expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("went offline") });
	});
});
