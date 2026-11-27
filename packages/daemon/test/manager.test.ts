import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionActionError, SessionManager, type SessionSpec } from "../src/manager";
import { FileOwnedSessions } from "../src/owned";
import { FakeSource } from "./fake-source";
import { turns, writeSessionFile } from "./session-files";

let root: string;
let sessionDir: string;
let project: string;
let held: Set<string>;
let probeFails: boolean;
let specs: SessionSpec[];
let sources: FakeSource[];
let renamed: { path: string; title: string; cwd: string }[];
let renameRefused: boolean;
let manager: SessionManager;

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ompweb-mgr-"));
	sessionDir = join(root, "sessions");
	project = join(root, "project");
	mkdirSync(project, { recursive: true });
	held = new Set();
	probeFails = false;
	specs = [];
	sources = [];
	renamed = [];
	renameRefused = false;
	manager = new SessionManager({
		ompPath: "unused",
		sessionDir,
		resolveCwd: async cwd => cwd, // the cwd restriction is the project registry's job (projects.test.ts, gateway tests)
		probeLeases: async ids => {
			if (probeFails) throw new Error("omp session lease exited with 1");
			return { held: new Set(ids.filter(id => held.has(id))), unknown: new Set() };
		},
		createSource: async spec => {
			specs.push(spec);
			// what omp would report for the session it opens
			const source = new FakeSource([], spec.resume ? "RESUMED" : spec.fork ? "FORKED" : `NEW-${sources.length}`);
			source.state.sessionFile = spec.resume ?? spec.fork;
			sources.push(source);
			return source;
		},
		renameStored: async (path, title, cwd) => {
			renamed.push({ path, title, cwd });
			return renameRefused ? null : title;
		},
	});
});
afterEach(async () => {
	await manager.closeAll();
	rmSync(root, { recursive: true, force: true });
});

/** A one-file conversation "RESUMED" (the id the fake omp reports when it resumes). */
function seedTuiSession(id = "RESUMED", title = "Written in the TUI") {
	return writeSessionFile(sessionDir, {
		id,
		created: iso(0),
		cwd: project,
		title,
		entries: turns("t", ["question", "answer"], T0 + 1000),
	});
}

describe("session list", () => {
	test("lists sessions the daemon does not host (created by the TUI) with their lease state, and prefers the hosted entry once taken over", async () => {
		seedTuiSession("FREE", "idle one");
		seedTuiSession("BUSY", "busy one");
		held.add("BUSY");
		await manager.refresh();
		const byId = new Map(manager.list().map(info => [info.id, info]));
		expect(byId.get("FREE")).toMatchObject({ access: "free", phase: "stored", title: "idle one", cwd: project });
		expect(byId.get("BUSY")).toMatchObject({ access: "held", phase: "stored" });

		const created = await manager.create(project);
		const ids = manager.list().map(info => info.id);
		expect(ids).toContain(created.id);
		expect(manager.list().find(info => info.id === created.id)).toMatchObject({ access: "hosted" });
	});

	test("creating new sessions without sending a message keeps at most one empty hosted session", async () => {
		const otherProject = join(root, "other-project");
		mkdirSync(otherProject, { recursive: true });

		const first = await manager.create(project);
		expect(first.isEmpty).toBe(true);
		expect(manager.list().map(s => s.id)).toEqual([first.id]);

		// Repeating create in the same directory reuses the existing untouched empty session.
		const reused = await manager.create(project);
		expect(reused).toBe(first);
		expect(specs).toHaveLength(1);
		expect(manager.list().map(s => s.id)).toEqual([first.id]);

		// Creating in a different directory replaces the previous untouched empty session.
		const moved = await manager.create(otherProject);
		expect(moved).not.toBe(first);
		expect(specs).toHaveLength(2);
		expect(manager.list().map(s => s.id)).toEqual([moved.id]);

		// Once a session has been prompted, creating another new session keeps the spoken one alongside the new empty one.
		await moved.prompt("hello");
		expect(moved.isEmpty).toBe(false);
		const fresh = await manager.create(project);
		expect(fresh).not.toBe(moved);
		expect(
			manager
				.list()
				.map(s => s.id)
				.toSorted(),
		).toEqual([fresh.id, moved.id].toSorted());
	});

	test("changes in lease state or new files from another process show up on refresh, and unchanged scans do not broadcast", async () => {
		seedTuiSession("A", "first");
		await manager.refresh();
		let changes = 0;
		manager.onChange(() => changes++);
		await manager.refresh();
		expect(changes).toBe(0);
		held.add("A");
		await manager.refresh();
		expect(manager.list().find(i => i.id === "A")?.access).toBe("held");
		expect(changes).toBe(1);
		seedTuiSession("B", "second");
		await manager.refresh();
		expect(
			manager
				.list()
				.map(i => i.id)
				.toSorted(),
		).toEqual(["A", "B"]);
		expect(changes).toBe(2);
	});

	test.each([undefined, "Named in omp"])(
		"taking over preserves disk display metadata (title: %s) while live renames win",
		async title => {
			writeSessionFile(sessionDir, {
				id: "RESUMED",
				created: iso(0),
				cwd: project,
				title,
				entries: turns("t", ["First prompt", "Answer"], T0 + 1000),
			});
			await manager.refresh();
			const before = manager.list().find(info => info.id === "RESUMED")!;
			expect(before.preview).toBe("First prompt");
			const session = await manager.resume("RESUMED", true);
			const after = manager.list().find(info => info.id === session.id)!;
			expect(after).toMatchObject({
				access: "hosted",
				title: before.title,
				preview: before.preview,
				createdAt: before.createdAt,
			});
			await manager.rename(session.id, "Renamed while hosted");
			expect(manager.list().find(info => info.id === session.id)?.title).toBe("Renamed while hosted");
		},
	);
});

describe("taking over a stored session", () => {
	test("a session whose lease is held is refused (read-only), without starting omp and without offering confirmation", async () => {
		seedTuiSession("RESUMED");
		held.add("RESUMED");
		await expect(manager.resume("RESUMED", true)).rejects.toMatchObject({ code: "held" });
		expect(specs).toEqual([]);
	});

	test("a free session this daemon did not create needs confirmation; with it, omp is resumed on the session file", async () => {
		const path = seedTuiSession("RESUMED");
		const refused = await manager.resume("RESUMED", false).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(SessionActionError);
		expect((refused as SessionActionError).code).toBe("confirm_takeover");
		expect(specs).toEqual([]);

		const replaced: string[][] = [];
		manager.onReplaced(ids => replaced.push(ids));
		const session = await manager.resume("RESUMED", true);
		expect(specs).toEqual([{ cwd: project, resume: path }]);
		expect(session.info).toMatchObject({ access: "hosted", id: "RESUMED" });
		expect(manager.list().filter(i => i.id === "RESUMED")).toHaveLength(1);
		expect(manager.list().find(i => i.id === "RESUMED")?.access).toBe("hosted");
		expect(replaced.flat()).toContain("RESUMED"); // viewers of the stored version must switch to the hosted one
		// taking it over again returns the running session instead of spawning another omp
		expect(await manager.resume("RESUMED", true)).toBe(session);
		expect(specs).toHaveLength(1);
	});

	test("a session this daemon already owned (created, then closed) is resumed without asking again, and a held lease still wins", async () => {
		const created = await manager.create(project);
		// omp wrote the session: it is now on disk under that id
		writeSessionFile(sessionDir, {
			id: created.id,
			created: iso(0),
			cwd: project,
			entries: turns("c", ["q", "a"], T0),
		});
		await manager.close(created.id);
		held.add(created.id);
		await expect(manager.resume(created.id, false)).rejects.toMatchObject({ code: "held" });
		held.delete(created.id);
		const again = await manager.resume(created.id, false);
		expect(again.info.access).toBe("hosted");
	});

	test("when the lease cannot be probed the takeover is refused instead of assumed free", async () => {
		seedTuiSession("RESUMED");
		probeFails = true;
		await expect(manager.resume("RESUMED", true)).rejects.toThrow(/cannot tell whether another omp process owns/);
		expect(specs).toEqual([]);
	});

	test("a conversation that moved to sibling files opens its newest file, and a lease on any of its files blocks the takeover", async () => {
		writeSessionFile(sessionDir, {
			id: "OLD",
			created: iso(0),
			cwd: project,
			entries: turns("a", ["q", "a"], T0 + 1000),
		});
		const newest = writeSessionFile(sessionDir, {
			id: "RESUMED",
			created: iso(60_000),
			cwd: project,
			continuationOf: "OLD",
			parentSession: "OLD",
			entries: turns("a", ["q", "a", "q2", "a2"], T0 + 1000),
		});
		held.add("OLD"); // an older file of the conversation is still owned by a live process
		await expect(manager.resume("OLD", true)).rejects.toMatchObject({ code: "held" });
		held.clear();
		// asking by the old file's id opens the newest file
		await manager.resume("OLD", true);
		expect(specs).toEqual([{ cwd: project, resume: newest }]);
	});

	test("a hosted session whose omp process died is resumed in a new process on its file", async () => {
		const path = seedTuiSession("RESUMED");
		const first = await manager.resume("RESUMED", true);
		sources[0]!.exit("omp exited with code 1");
		expect(first.info.phase).toBe("closed");

		const replaced: string[][] = [];
		manager.onReplaced(ids => replaced.push(ids));
		const again = await manager.resume("RESUMED", false); // owned by this daemon: no confirmation
		expect(again).not.toBe(first);
		expect(again.info).toMatchObject({ id: "RESUMED", phase: "idle", access: "hosted" });
		expect(specs).toEqual([
			{ cwd: project, resume: path },
			{ cwd: project, resume: path },
		]);
		expect(manager.list().filter(i => i.id === "RESUMED")).toEqual([expect.objectContaining({ phase: "idle" })]);
		expect(replaced.flat()).toContain("RESUMED"); // viewers of the dead one switch to the new process
	});
});

describe("fork and rename", () => {
	test("a session held by another process can be forked (the source is only read); the copy is a new hosted session", async () => {
		const path = seedTuiSession("SRC");
		held.add("SRC");
		await manager.refresh();
		const copy = await manager.fork("SRC");
		expect(specs).toEqual([{ cwd: project, fork: path }]);
		expect(copy.info.access).toBe("hosted");
		expect(copy.id).toBe("FORKED");
	});

	test("a running session can only be forked while idle", async () => {
		const session = await manager.create(project);
		sources[0]!.state.sessionFile = "/s/live.jsonl";
		sources[0]!.state.isStreaming = true;
		sources[0]!.emit({ type: "agent_start" } as never);
		await Bun.sleep(5);
		await expect(manager.fork(session.id)).rejects.toThrow(/idle/);
	});

	test("rename goes to the omp process for a hosted session, to the file for a stored one, and a refused rename says why", async () => {
		const path = seedTuiSession("STORED", "before");
		await manager.refresh();
		await manager.rename("STORED", "after");
		expect(renamed).toEqual([{ path, title: "after", cwd: project }]);

		renameRefused = true;
		await expect(manager.rename("STORED", "again")).rejects.toMatchObject({ code: "held" });

		const hosted = await manager.create(project);
		await manager.rename(hosted.id, "hosted name");
		expect(sources[0]!.names).toEqual(["hosted name"]);
		expect(manager.list().find(i => i.id === hosted.id)?.title).toBe("hosted name");
	});
});

describe("what a client can look at", () => {
	test("any file id of a stored conversation resolves to the same read-only view, commands on it are refused, unknown ids fail", async () => {
		writeSessionFile(sessionDir, {
			id: "OLD",
			created: iso(0),
			cwd: project,
			entries: turns("a", ["q", "a"], T0 + 1000),
		});
		writeSessionFile(sessionDir, {
			id: "NEW",
			created: iso(60_000),
			cwd: project,
			continuationOf: "OLD",
			parentSession: "OLD",
			entries: turns("a", ["q", "a", "q2", "a2"], T0 + 1000),
		});
		const byNew = await manager.view("NEW"); // not yet scanned: view() refreshes by itself
		const byOld = await manager.view("OLD");
		expect(byOld).toBe(byNew);
		const { result } = byNew.subscribe(() => {}, 0, undefined);
		expect(result.kind === "snapshot" && result.snapshot.entries.map(e => e.id)).toEqual(["a0", "a1", "a2", "a3"]);
		expect(() => manager.get("NEW")).toThrow(/take it over/);
		await expect(manager.view("nope")).rejects.toThrow(/unknown session/);
	});

	test("closing a hosted session hands its viewers over to the stored version", async () => {
		const session = await manager.create(project);
		writeSessionFile(sessionDir, {
			id: session.id,
			created: iso(0),
			cwd: project,
			entries: turns("c", ["q", "a"], T0),
		});
		const replaced: string[][] = [];
		manager.onReplaced(ids => replaced.push(ids));
		await manager.close(session.id);
		expect(replaced.flat()).toContain(session.id);
		const view = await manager.view(session.id);
		expect(view.info).toMatchObject({ phase: "stored", access: "free" });
	});
});

describe("where sessions may run and how a conversation is named", () => {
	test("create, resume and fork all go through the cwd policy, and the child runs in the canonical directory it returns", async () => {
		const allowed: string[] = [];
		const restricted = new SessionManager({
			ompPath: "unused",
			sessionDir,
			resolveCwd: async cwd => {
				if (!cwd.startsWith(project)) throw new Error(`${cwd} is not inside a registered project`);
				allowed.push(cwd);
				return `${cwd}/`.replace(/\/\/$/, "/") === `${project}/` ? project : cwd;
			},
			probeLeases: async ids => ({ held: new Set(ids.filter(id => held.has(id))), unknown: new Set() }),
			createSource: async spec => {
				specs.push(spec);
				const source = new FakeSource([], spec.resume ? "RESUMED" : spec.fork ? "FORKED" : "NEW");
				source.state.sessionFile = spec.resume ?? spec.fork;
				sources.push(source);
				return source;
			},
		});
		try {
			await expect(restricted.create(root)).rejects.toThrow("not inside a registered project");
			expect(specs).toHaveLength(0);
			const outside = writeSessionFile(sessionDir, {
				id: "OUTSIDE",
				created: iso(0),
				cwd: root,
				entries: turns("o", ["q", "a"], T0 + 1000),
			});
			await restricted.refresh();
			await expect(restricted.resume("OUTSIDE", true)).rejects.toThrow("not inside a registered project");
			await expect(restricted.fork("OUTSIDE")).rejects.toThrow("not inside a registered project");
			expect(specs).toHaveLength(0);
			// still listed and readable: only starting omp there is refused
			expect(restricted.list().map(i => i.id)).toContain("OUTSIDE");
			expect(outside).toContain("OUTSIDE");

			const created = await restricted.create(project);
			expect(specs[0]!.cwd).toBe(project);
			expect(created.info.cwd).toBe(project);
		} finally {
			await restricted.closeAll();
		}
	});

	test("aliases name the other ids of a conversation: older files of a stored one, and the same for the hosted session that took it over", async () => {
		writeSessionFile(sessionDir, {
			id: "OLD",
			created: iso(0),
			cwd: project,
			entries: turns("a", ["q", "a"], T0 + 1000),
		});
		writeSessionFile(sessionDir, {
			id: "RESUMED",
			created: iso(10_000),
			cwd: project,
			continuationOf: "OLD",
			parentSession: "OLD",
			entries: turns("b", ["q", "a", "q2", "a2"], T0 + 11_000),
		});
		await manager.refresh();
		const [only] = manager.list();
		expect(only!.files).toBe(2);
		expect([only!.id, ...only!.aliases].toSorted()).toEqual(["OLD", "RESUMED"]); // whichever file represents it, the other is an alias

		const hosted = await manager.resume("RESUMED", true); // the fake omp reports "RESUMED" as the session id
		const info = manager.list().find(i => i.id === hosted.id)!;
		expect(info.id).toBe("RESUMED");
		expect(info.aliases).toEqual(["OLD"]);
	});
});

describe("takeover confirmation survives a daemon restart", () => {
	const ownedFile = () => join(root, "state", "owned-sessions.json");
	const manage = (owned: FileOwnedSessions) =>
		new SessionManager({
			ompPath: "unused",
			sessionDir,
			resolveCwd: async cwd => cwd,
			owned,
			probeLeases: async () => ({ held: new Set(), unknown: new Set() }),
			createSource: async spec => {
				const source = new FakeSource([], spec.resume ? "RESUMED" : "FRESH");
				source.state.sessionFile = spec.resume;
				return source;
			},
		});

	test("a conversation this daemon created is taken over again without asking after a restart, one it never touched still asks", async () => {
		const first = manage(FileOwnedSessions.open(ownedFile()));
		const created = await first.create(project);
		expect(created.id).toBe("FRESH");
		await first.closeAll();
		expect(JSON.parse(readFileSync(ownedFile(), "utf8"))).toEqual({ ids: ["FRESH"] });

		// the daemon restarts: its sessions are only files now
		writeSessionFile(sessionDir, {
			id: "FRESH",
			created: iso(0),
			cwd: project,
			entries: turns("f", ["q", "a"], T0 + 1000),
		});
		writeSessionFile(sessionDir, {
			id: "FROM-TUI",
			created: iso(5000),
			cwd: project,
			entries: turns("g", ["q", "a"], T0 + 6000),
		});
		const second = manage(FileOwnedSessions.open(ownedFile()));
		await second.refresh();
		await expect(second.resume("FROM-TUI", false)).rejects.toMatchObject({ code: "confirm_takeover" });
		expect((await second.resume("FRESH", false)).id).toBe("RESUMED"); // no confirmation
		await second.closeAll();
	});

	test("a take-over that was confirmed is remembered too; the file only ever lists ids this daemon acted on", async () => {
		writeSessionFile(sessionDir, {
			id: "TAKEN",
			created: iso(0),
			cwd: project,
			entries: turns("t", ["q", "a"], T0 + 1000),
		});
		const first = manage(FileOwnedSessions.open(ownedFile()));
		await first.refresh();
		await first.resume("TAKEN", true);
		await first.closeAll();
		expect(FileOwnedSessions.open(ownedFile()).has("RESUMED")).toBe(true);
		expect(FileOwnedSessions.open(ownedFile()).has("never-seen")).toBe(false);
	});

	test("a missing file is an empty set; a file that is not a list of ids is an error, not silently emptied", () => {
		expect(FileOwnedSessions.open(join(root, "nothing-here.json")).has("x")).toBe(false);
		mkdirSync(join(root, "state"), { recursive: true });
		writeFileSync(ownedFile(), '{"ids":[1]}');
		expect(() => FileOwnedSessions.open(ownedFile())).toThrow("owned session ids");
		writeFileSync(ownedFile(), "nonsense");
		expect(() => FileOwnedSessions.open(ownedFile())).toThrow();
	});
});
