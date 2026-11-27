import { describe, expect, test } from "bun:test";
import { FILE_CHUNK_BYTES } from "@omp-web/protocol";
import { FilesApi, MAX_IN_FLIGHT } from "../src/lib/files-data";
import { fetchImage } from "../src/lib/files-image";
import { FilesStore, MAX_DIRS_PER_TICK } from "../src/lib/files-store";
import { dir, FakeFiles, file, ok, refuse, sampleTree, settle } from "./files-fake";

const open = (fake: FakeFiles, showIgnored = false): { store: FilesStore; api: FilesApi } => {
	const api = new FilesApi(fake, "home", "/r");
	return { store: new FilesStore(api, showIgnored), api };
};

describe("FilesApi", () => {
	test("at most four requests are in flight, the rest wait in order", async () => {
		const fake = sampleTree();
		const api = new FilesApi(fake, "home", "/r");
		const results = await Promise.all(Array.from({ length: 12 }, () => api.read("README.md")));
		expect(results.every(r => r.ok)).toBe(true);
		expect(fake.maxInFlight).toBe(MAX_IN_FLIGHT);
		expect(fake.calls).toHaveLength(12);
	});

	test("the cap is shared by every view of one client", async () => {
		const fake = sampleTree();
		const a = new FilesApi(fake, "home", "/r");
		const b = new FilesApi(fake, "home", "/r");
		await Promise.all([
			...Array.from({ length: 6 }, () => a.read("README.md")),
			...Array.from({ length: 6 }, () => b.status()),
		]);
		expect(fake.maxInFlight).toBe(MAX_IN_FLIGHT);
	});

	test("a busy answer is retried once", async () => {
		let calls = 0;
		const api = new FilesApi(
			{
				request: async () =>
					++calls === 1 ? refuse("too many", "busy") : ok({ branch: {}, entries: [], truncated: false }),
			},
			"m",
			"/r",
		);
		expect((await api.status()).ok).toBe(true);
		expect(calls).toBe(2);

		calls = -100;
		const stuck = new FilesApi({ request: async () => (calls++, refuse("too many", "busy")) }, "m", "/r");
		const result = await stuck.status();
		expect(result).toMatchObject({ ok: false, failure: { code: "busy" } });
		expect(calls).toBe(-98);
	});

	test("failures keep the daemon's code and text; offline is recognised; garbage is a protocol error", async () => {
		const refused = new FilesApi({ request: async () => refuse("outside the worktree", "outside_root") }, "m", "/r");
		expect(await refused.read("x")).toEqual({
			ok: false,
			failure: { message: "outside the worktree", code: "outside_root" },
		});
		const offline = new FilesApi({ request: async () => refuse("machine Home is offline") }, "m", "/r");
		expect(await offline.read("x")).toMatchObject({ ok: false, failure: { code: "offline" } });
		const odd = new FilesApi({ request: async () => ok("what") }, "m", "/r");
		expect(await odd.read("x")).toMatchObject({ ok: false, failure: { code: "protocol" } });
		const thrown = new FilesApi(
			{
				request: async () => {
					throw new Error("socket closed");
				},
			},
			"m",
			"/r",
		);
		expect(await thrown.list("", false)).toMatchObject({
			ok: false,
			failure: { message: "socket closed", code: "failed" },
		});
	});

	test("closing drops requests that are still queued", async () => {
		const fake = sampleTree();
		const api = new FilesApi(fake, "home", "/r");
		const release = fake.hold(r => r.t === "files.read");
		const pending = Array.from({ length: 6 }, () => api.read("README.md"));
		await settle();
		api.close();
		release();
		const results = await Promise.all(pending);
		expect(results.filter(r => !r.ok && r.failure.code === "aborted")).toHaveLength(2);
		expect(fake.calls).toHaveLength(4);
	});
});

describe("FilesStore", () => {
	test("start loads the root and the status once", async () => {
		const fake = sampleTree();
		const { store } = open(fake);
		store.start();
		await settle();
		const snap = store.getSnapshot();
		expect(snap.dirs.get("")?.listing?.entries.map(e => e.name)).toEqual(["src", "README.md"]); // dist is ignored
		expect(snap.status.loaded).toBe(true);
		expect(fake.of("files.list")).toHaveLength(1);
		expect(fake.of("files.status")).toHaveLength(1);
		store.stop();
	});

	test("selecting a deep file expands its ancestors and loads each level", async () => {
		const fake = sampleTree();
		const { store } = open(fake);
		store.start();
		store.select({ path: "src/deep/x.ts", line: null, diff: null });
		await settle(8);
		const snap = store.getSnapshot();
		expect([...snap.expanded].sort()).toEqual(["src", "src/deep"]);
		expect(snap.dirs.get("src/deep")?.listing?.entries.map(e => e.name)).toEqual(["x.ts"]);
		expect(snap.file.content).toMatchObject({ kind: "text", startLine: 1, endLine: 1000, nextLine: 1001 });
		store.stop();
	});

	test("a line opens the page that contains it, 40 lines of context before it", async () => {
		const fake = sampleTree();
		const { store } = open(fake);
		store.start();
		store.select({ path: "src/deep/x.ts", line: 1500, diff: null });
		await settle(8);
		const read = fake.of("files.read").at(-1);
		expect(read).toMatchObject({ path: "src/deep/x.ts", fromLine: 1460, maxLines: 1000 });
		expect(store.getSnapshot().file).toMatchObject({ target: 1500, content: { startLine: 1460 } });
		store.stop();
	});

	test("paging: next uses nextLine, previous steps back a page, go-to-line re-centres", async () => {
		const fake = sampleTree();
		const { store } = open(fake);
		store.start();
		store.select({ path: "src/deep/x.ts", line: null, diff: null });
		await settle(8);
		store.nextPage();
		await settle();
		expect(store.getSnapshot().file.content).toMatchObject({ startLine: 1001, endLine: 2000 });
		store.nextPage();
		await settle();
		expect(store.getSnapshot().file.content).toMatchObject({ startLine: 2001, endLine: 2500, nextLine: null });
		store.prevPage();
		await settle();
		expect(store.getSnapshot().file.content).toMatchObject({ startLine: 1001 });
		store.prevPage();
		await settle();
		expect(store.getSnapshot().file.content).toMatchObject({ startLine: 1 });
		store.goToLine(2200);
		await settle();
		expect(store.getSnapshot().file).toMatchObject({ target: 2200, content: { startLine: 2160 } });
		store.stop();
	});

	test("a refused path shows the daemon's message and does not loop", async () => {
		const fake = sampleTree();
		fake.texts.delete("README.md");
		const { store } = open(fake);
		store.start();
		store.select({ path: "README.md", line: null, diff: null });
		await settle(8);
		expect(store.getSnapshot().file.error).toMatchObject({ code: "not_found" });
		const reads = fake.of("files.read").length;
		await settle(8);
		expect(fake.of("files.read")).toHaveLength(reads);
		store.stop();
	});

	test("a late answer for a file that is no longer open is dropped", async () => {
		const fake = sampleTree();
		const { store } = open(fake);
		store.start();
		const release = fake.hold(r => r.t === "files.read" && r.path === "README.md");
		store.select({ path: "README.md", line: null, diff: null });
		await settle();
		store.select({ path: "src/a.ts", line: null, diff: null });
		await settle(6);
		release();
		await settle(6);
		expect(store.getSnapshot().file).toMatchObject({ path: "src/a.ts", content: { path: "src/a.ts" } });
		store.stop();
	});

	test("a diff tab loads the diff, with the old path of a rename", async () => {
		const fake = sampleTree();
		fake.status = {
			...fake.status,
			entries: [{ path: "src/a.ts", origPath: "src/old.ts", kind: "renamed", x: "R", y: "." }],
		};
		fake.diffs.set("staged:src/a.ts", "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n");
		const { store } = open(fake);
		store.start();
		store.select({ path: "src/a.ts", line: null, diff: "staged" });
		await settle(8);
		expect(fake.of("files.diff")).toEqual([
			{ t: "files.diff", root: "/r", path: "src/a.ts", mode: "staged", origPath: "src/old.ts" },
		]);
		expect(store.getSnapshot().file.diff?.data?.diff).toContain("@@");
		store.stop();
	});

	test("showing ignored entries lists again, with the flag", async () => {
		const fake = sampleTree();
		const { store } = open(fake);
		store.start();
		await settle();
		expect(
			store
				.getSnapshot()
				.dirs.get("")
				?.listing?.entries.map(e => e.name),
		).toEqual(["src", "README.md"]);
		store.setShowIgnored(true);
		await settle();
		expect(fake.of("files.list").at(-1)).toMatchObject({ path: "", showIgnored: true });
		expect(
			store
				.getSnapshot()
				.dirs.get("")
				?.listing?.entries.map(e => e.name),
		).toEqual(["dist", "src", "README.md"]);
		store.stop();
	});

	test("an offline machine is reported, what was shown stays, and it reloads when the machine is back", async () => {
		const fake = sampleTree();
		const { store } = open(fake);
		store.start();
		store.setMachine(true, 1);
		store.select({ path: "README.md", line: null, diff: null });
		await settle(8);
		expect(store.getSnapshot().file.content?.kind).toBe("text");
		const before = fake.calls.length;

		store.setMachine(false, 1);
		expect(store.getSnapshot().offline).toBe(true);
		await store.pollStatus();
		await store.pollDirs();
		expect(fake.calls).toHaveLength(before); // nothing is polled while offline
		store.refresh(); // an explicit refresh still tries; the fake answers "offline"
		fake.offline = true;
		await settle(8);
		expect(store.getSnapshot().file.content?.kind).toBe("text"); // stale content stays
		expect(store.getSnapshot().offline).toBe(true);

		fake.offline = false;
		store.setMachine(true, 2); // back under a new link
		await settle(10);
		expect(store.getSnapshot().offline).toBe(false);
		expect(store.getSnapshot().status.error).toBeNull();
		expect(fake.of("files.status").length).toBeGreaterThan(1);
		store.stop();
	});

	test("polling skips a tick while the previous status request is out, and is bounded", async () => {
		const fake = sampleTree();
		const { store } = open(fake);
		store.start();
		await settle();
		const release = fake.hold(r => r.t === "files.status");
		const statuses = (): number => fake.of("files.status").length;
		const base = statuses();
		void store.pollStatus();
		await settle();
		void store.pollStatus();
		void store.pollStatus();
		await settle();
		expect(statuses()).toBe(base + 1);
		release();
		await settle();
		await store.pollStatus();
		expect(statuses()).toBe(base + 2);
		store.stop();
	});

	test("a directory tick refreshes at most 25 directories, the rest on the next tick", async () => {
		const fake = new FakeFiles();
		const names = Array.from({ length: 40 }, (_, i) => `d${String(i).padStart(2, "0")}`);
		fake.dirs.set(
			"",
			names.map(n => dir(n)),
		);
		for (const n of names) fake.dirs.set(n, [file("f")]);
		const { store } = open(fake);
		store.start();
		await settle();
		for (const n of names) store.toggleDir(n);
		await settle(30);
		expect(store.getSnapshot().expanded.size).toBe(40);
		const base = fake.of("files.list").length;
		await store.pollDirs();
		expect(fake.of("files.list").length - base).toBe(MAX_DIRS_PER_TICK);
		const second = fake.of("files.list").length;
		await store.pollDirs();
		expect(fake.of("files.list").length - second).toBe(MAX_DIRS_PER_TICK);
		const asked = new Set(
			fake
				.of("files.list")
				.slice(base)
				.map(r => (r.t === "files.list" ? r.path : "")),
		);
		expect(asked.size).toBe(41); // every directory including the root was refreshed within two ticks
		store.stop();
	});

	test("the open file is read again only when its git state changed", async () => {
		const fake = sampleTree();
		const { store } = open(fake);
		store.start();
		store.select({ path: "src/a.ts", line: null, diff: null });
		await settle(8);
		const reads = (): number => fake.of("files.read").length;
		const before = reads();
		await store.refreshStatus(); // same state
		await settle();
		expect(reads()).toBe(before);
		fake.status = { ...fake.status, entries: [{ path: "src/a.ts", kind: "changed", x: ".", y: "M" }] };
		await store.refreshStatus();
		await settle();
		expect(reads()).toBe(before + 1);
		store.stop();
	});

	test("stop() ends polling, drops later answers and refuses new changes", async () => {
		const fake = sampleTree();
		const { store } = open(fake);
		const release = fake.hold(r => r.t === "files.list");
		store.start();
		await settle();
		let notified = 0;
		store.subscribe(() => notified++);
		store.stop();
		release();
		await settle(6);
		expect(notified).toBe(0);
		expect(store.getSnapshot().dirs.get("")?.listing).toBeNull();
	});
});

describe("fetchImage", () => {
	const bytes = (n: number): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: n }, (_, i) => i % 251);

	test("assembles every chunk in order, with at most three requests in flight", async () => {
		const fake = new FakeFiles();
		const data = bytes(FILE_CHUNK_BYTES * 5 + 17);
		fake.images.set("a.png", { mime: "image/png", bytes: data });
		const api = new FilesApi(fake, "m", "/r");
		const result = await fetchImage(api, "a.png", data.length, "image/png", () => false);
		expect(result.ok).toBe(true);
		if (!result.ok || "cancelled" in result) throw new Error("expected a blob");
		expect(result.blob.type).toBe("image/png");
		expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(data);
		expect(fake.maxInFlight).toBeLessThanOrEqual(3);
		expect(fake.of("files.bytes")).toHaveLength(6);
	});

	test("fails when the file changes between chunks", async () => {
		const fake = new FakeFiles();
		const data = bytes(FILE_CHUNK_BYTES * 3);
		fake.images.set("a.png", { mime: "image/png", bytes: data });
		const api = new FilesApi(fake, "m", "/r");
		let served = 0;
		const original = fake.request.bind(fake);
		fake.request = async (machine, request) => {
			const ack = await original(machine, request);
			// the second slice reports a newer modification time
			if (request.t === "files.bytes" && ++served === 2 && ack.ok) {
				return { ...ack, data: { ...(ack.data as object), mtimeMs: fake.mtimeMs + 1 } };
			}
			return ack;
		};
		const result = await fetchImage(api, "a.png", data.length, "image/png", () => false);
		expect(result).toMatchObject({ ok: false, message: "file changed while loading" });
	});

	test("fails when the size differs from what the read reported", async () => {
		const fake = new FakeFiles();
		fake.images.set("a.png", { mime: "image/png", bytes: bytes(100) });
		const api = new FilesApi(fake, "m", "/r");
		expect(await fetchImage(api, "a.png", 99, "image/png", () => false)).toMatchObject({
			ok: false,
			message: "file changed while loading",
		});
	});

	test("refuses types it cannot preview, and stops when cancelled", async () => {
		const fake = new FakeFiles();
		fake.images.set("a.svg", { mime: "image/svg+xml", bytes: bytes(10) });
		const api = new FilesApi(fake, "m", "/r");
		expect(await fetchImage(api, "a.svg", 10, "image/svg+xml", () => false)).toMatchObject({ ok: false });
		expect(fake.calls).toHaveLength(0);
		fake.images.set("a.png", { mime: "image/png", bytes: bytes(10) });
		expect(await fetchImage(api, "a.png", 10, "image/png", () => true)).toEqual({ ok: false, cancelled: true });
	});
});
