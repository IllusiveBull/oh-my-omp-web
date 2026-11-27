import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffWire, SessionInfo } from "@omp-web/protocol";
import { GatewayStore, HandoffConflictError, MIGRATIONS, migrate, type Migration, type StoredMachine } from "../src/db";
import { ConfigError } from "../src/secrets";

const version = (db: Database): number =>
	(db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const tables = (db: Database): string[] =>
	(
		db
			.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all() as { name: string }[]
	).map(r => r.name);

describe("schema migrations", () => {
	test("an empty database is brought to the newest version with every table", () => {
		const db = new Database(":memory:");
		migrate(db);
		expect(version(db)).toBe(MIGRATIONS.at(-1)!.version);
		expect(tables(db)).toEqual([
			"auth_sessions",
			"handoffs",
			"machines",
			"projects",
			"push_notified",
			"push_subscriptions",
			"read_positions",
			"replica_files",
			"session_index",
			"thread_hops",
			"thread_sessions",
			"threads",
		]);
	});

	test("the shipped migration list is contiguous from 1", () => {
		expect(MIGRATIONS.map(m => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
	});

	test("a database at an older version is upgraded in place, keeping its data, and rerunning is a no-op", () => {
		const v1 = MIGRATIONS.slice(0, 1);
		const v2: Migration = {
			version: 2,
			sql: "ALTER TABLE machines ADD COLUMN note TEXT NOT NULL DEFAULT 'none'; CREATE TABLE extra (id INTEGER PRIMARY KEY);",
		};
		const db = new Database(":memory:");
		migrate(db, v1);
		db.query(
			"INSERT INTO machines (id, name, platform, daemon_version, omp, lease_warnings, last_seen) VALUES ('m', 'n', 'p', 'v', '{}', '[]', 1)",
		).run();
		expect(version(db)).toBe(1);
		migrate(db, [...v1, v2]);
		expect(version(db)).toBe(2);
		expect(db.query("SELECT id, note FROM machines").all()).toEqual([{ id: "m", note: "none" }]);
		expect(tables(db)).toContain("extra");
		migrate(db, [...v1, v2]);
		expect(version(db)).toBe(2);
	});

	test("a database written by the first release is upgraded through every later migration, keeping its data", () => {
		const db = new Database(":memory:");
		migrate(db, MIGRATIONS.slice(0, 1));
		db.query(
			"INSERT INTO machines (id, name, platform, daemon_version, omp, lease_warnings, last_seen) VALUES ('m', 'n', 'p', 'v', '{}', '[]', 1)",
		).run();
		db.query("INSERT INTO auth_sessions (token_hash, expires_at) VALUES ('h', 99)").run();
		migrate(db);
		expect(version(db)).toBe(MIGRATIONS.at(-1)!.version);
		expect(db.query("SELECT id FROM machines").all()).toEqual([{ id: "m" }]);
		expect(db.query("SELECT token_hash FROM auth_sessions").all()).toEqual([{ token_hash: "h" }]);
		expect(tables(db)).toContain("replica_files");
		expect(tables(db)).toContain("push_subscriptions");
	});

	test("a failing migration changes nothing (it runs in one transaction with the version bump)", () => {
		const db = new Database(":memory:");
		migrate(db, MIGRATIONS.slice(0, 1));
		const broken: Migration = {
			version: 2,
			sql: "CREATE TABLE half (id INTEGER); CREATE TABLE machines (id INTEGER);",
		};
		expect(() => migrate(db, [...MIGRATIONS.slice(0, 1), broken])).toThrow();
		expect(version(db)).toBe(1);
		expect(tables(db)).not.toContain("half");
	});

	test("a database written by a newer build is refused instead of being misread", () => {
		const db = new Database(":memory:");
		db.exec("PRAGMA user_version = 99");
		expect(() => migrate(db)).toThrow(ConfigError);
		expect(() => migrate(db)).toThrow("newer than this build");
	});

	test("opening a file creates it readable by this user only and persists across opens", () => {
		const dir = mkdtempSync(join(tmpdir(), "ompweb-db-"));
		const file = join(dir, "state", "gateway.db");
		const store = GatewayStore.open(file);
		store.upsertMachine(machine("m1"));
		store.setMachineNickname("m1", "Desk");
		store.close();
		if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
		const reopened = GatewayStore.open(file);
		expect(reopened.machines().map(m => m.id)).toEqual(["m1"]);
		expect(reopened.machines()[0]!.nickname).toBe("Desk");
		reopened.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

const machine = (id: string, name = id): StoredMachine => ({
	id,
	name,
	platform: "linux",
	daemonVersion: "1",
	omp: { version: "1.0.0", expectedVersion: "1.0.0", versionMismatch: false },
	leaseWarnings: [],
	lastSeen: 100,
});

const info = (id: string, overrides: Partial<SessionInfo> = {}): SessionInfo => ({
	id,
	sessionId: id,
	access: "free",
	cwd: "/p",
	phase: "stored",
	createdAt: 1,
	modifiedAt: 10,
	files: 1,
	aliases: [],
	...overrides,
});

function store(now = () => 1_000): GatewayStore {
	const s = GatewayStore.open(":memory:", { now });
	s.upsertMachine(machine("m1"));
	s.upsertMachine(machine("m2"));
	return s;
}

describe("machines and projects", () => {
	test("machine records are upserted, projects cached per machine, and deleting a machine removes everything about it", () => {
		const s = store();
		s.upsertMachine({ ...machine("m1", "renamed"), lastSeen: 500 });
		expect(s.machines().find(m => m.id === "m1")).toMatchObject({ name: "renamed", lastSeen: 500 });
		s.touchMachine("m1", 900);
		expect(s.machines().find(m => m.id === "m1")!.lastSeen).toBe(900);
		const project = { id: "abc", name: "repo", root: "/r", worktrees: [{ path: "/r", branch: "main", main: true }] };
		s.setProjects("m1", [project]);
		expect(s.projects("m1")).toEqual([project]);
		expect(s.projects("m2")).toEqual([]);
		s.syncSessions("m1", [info("s1")]);
		s.deleteMachine("m1");
		expect(s.projects("m1")).toEqual([]);
		expect(s.sessions("m1")).toEqual([]);
		expect(s.machines().map(m => m.id)).toEqual(["m2"]);
	});
});

describe("session index and threads", () => {
	test("the cached list comes back with a stable thread per conversation, and what existed before the gateway saw it is read", () => {
		const s = store();
		const first = s.syncSessions("m1", [info("s1"), info("s2", { modifiedAt: 20 })]);
		expect(first.map(x => [x.id, x.unread])).toEqual([
			["s1", false],
			["s2", false],
		]);
		expect(new Set(first.map(x => x.threadId)).size).toBe(2);
		// the same sessions reported again keep their threads
		const again = s.syncSessions("m1", [info("s2", { modifiedAt: 20 }), info("s1")]);
		expect(again.find(x => x.id === "s1")!.threadId).toBe(first.find(x => x.id === "s1")!.threadId);
		// the cache is what an offline machine serves
		expect(s.sessions("m1").map(x => x.id)).toEqual(["s2", "s1"]);
		expect(s.sessions("m2")).toEqual([]);
	});

	test("a conversation keeps its thread when its id changes, through the aliases the daemon reports (older files, repointed hosted session)", () => {
		const s = store();
		const [a] = s.syncSessions("m1", [info("file-a")]);
		// a successor file appeared: the conversation is now named by file-b, and file-a is an alias
		const [b] = s.syncSessions("m1", [info("file-b", { aliases: ["file-a"], modifiedAt: 30 })]);
		expect(b!.threadId).toBe(a!.threadId);
		expect(b!.unread).toBe(true); // it changed after the baseline
		// and when the daemon later reports only the old id again, still the same thread
		const [c] = s.syncSessions("m1", [info("file-a", { modifiedAt: 30 })]);
		expect(c!.threadId).toBe(a!.threadId);
		// the same session id on another machine is another thread
		const [other] = s.syncSessions("m2", [info("file-a")]);
		expect(other!.threadId).not.toBe(a!.threadId);
	});

	test("a hosted session whose omp id differs from its stable id joins one thread through its alias", () => {
		const s = store();
		const [hosted] = s.syncSessions("m1", [
			info("stable", { sessionId: "omp-1", aliases: ["omp-1"], phase: "idle" }),
		]);
		const [moved] = s.syncSessions("m1", [
			info("stable", { sessionId: "omp-2", aliases: ["omp-2", "omp-1"], phase: "idle" }),
		]);
		expect(moved!.threadId).toBe(hosted!.threadId);
	});
});

describe("read positions", () => {
	test("a read report clears the unread flag, only moves forward, and is per thread", () => {
		const s = store();
		s.syncSessions("m1", [info("s1"), info("s2")]);
		const changed = s.syncSessions("m1", [info("s1", { modifiedAt: 50 }), info("s2")]);
		expect(changed.find(x => x.id === "s1")!.unread).toBe(true);
		expect(changed.find(x => x.id === "s2")!.unread).toBe(false);

		expect(s.markRead("m1", "s1", { seq: 5, epoch: "e", modifiedAt: 50 })).toBe(true);
		expect(s.sessions("m1").find(x => x.id === "s1")!.unread).toBe(false);
		// older report from a client that is behind: no change, and the position does not move back
		expect(s.markRead("m1", "s1", { seq: 1, epoch: "e", modifiedAt: 40 })).toBe(false);
		expect(s.sessions("m1").find(x => x.id === "s1")!.unread).toBe(false);
		// the same time, further along in the log: recorded but the unread state is unchanged (nothing to re-send)
		expect(s.markRead("m1", "s1", { seq: 9, epoch: "e", modifiedAt: 50 })).toBe(false);
		// the session changes again: unread until the next report
		expect(s.syncSessions("m1", [info("s1", { modifiedAt: 60 }), info("s2")]).find(x => x.id === "s1")!.unread).toBe(
			true,
		);
		expect(() => s.markRead("m1", "unknown", { seq: 0, modifiedAt: 1 })).toThrow("unknown session");
		expect(() => s.markRead("m2", "s1", { seq: 0, modifiedAt: 1 })).toThrow("unknown session");
	});

	test("an alias reports into the same thread as the conversation's current id", () => {
		const s = store();
		s.syncSessions("m1", [info("old")]);
		expect(s.syncSessions("m1", [info("new", { aliases: ["old"], modifiedAt: 70 })])[0]!.unread).toBe(true);
		s.markRead("m1", "old", { seq: 0, modifiedAt: 70 });
		expect(s.sessions("m1")[0]!.unread).toBe(false);
	});

	test("a session that moved here from another machine is marked read by its read report", () => {
		const s = store();
		const [source] = s.syncSessions("m1", [info("src")]);
		// the forked copy on m2 joins the thread that m1 created
		s.mapSession("m2", "dst", source!.threadId);
		expect(s.syncSessions("m2", [info("dst", { modifiedAt: 80 })])[0]!.unread).toBe(true);
		expect(s.markRead("m2", "dst", { seq: 0, modifiedAt: 80 })).toBe(true);
		expect(s.sessions("m2")[0]!.unread).toBe(false);
	});
});

describe("browser logins", () => {
	test("a login is valid until it expires or is deleted; only a hash is stored", () => {
		let now = 1_000;
		const s = store(() => now);
		const cookie = s.createAuthSession(5_000);
		expect(s.authSessionValid(cookie)).toBe(true);
		expect(s.authSessionValid(`${cookie}x`)).toBe(false);
		now = 5_999;
		expect(s.authSessionValid(cookie)).toBe(true);
		now = 6_000;
		expect(s.authSessionValid(cookie)).toBe(false);
		now = 7_000;
		const second = s.createAuthSession(5_000); // also sweeps the expired one
		s.deleteAuthSession(second);
		expect(s.authSessionValid(second)).toBe(false);
	});
});

describe("environment switches: schema 4", () => {
	const wire = (id: string, threadId: string, phase: HandoffWire["phase"]): HandoffWire => ({
		id,
		threadId,
		source: {
			machine: "m1",
			machineName: "one",
			sessionId: "s1",
			cwd: "/a",
			worktree: "/a",
			projectId: "p",
			projectName: "proj",
		},
		target: { machine: "m2", machineName: "two", choice: { mode: "new" } },
		phase,
		steps: [],
		createdAt: 1,
		updatedAt: 1,
	});

	test("a version 3 database is upgraded in place: its threads, read positions and logins survive, the new tables are empty", () => {
		const db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		migrate(db, MIGRATIONS.slice(0, 3));
		expect(version(db)).toBe(3);
		db.query(
			"INSERT INTO machines (id, name, platform, daemon_version, omp, lease_warnings, last_seen) VALUES ('m1', 'n', 'p', 'v', '{}', '[]', 1)",
		).run();
		db.query("INSERT INTO threads (id, machine_id, created_at) VALUES ('t1', 'm1', 1)").run();
		db.query("INSERT INTO thread_sessions (machine_id, session_id, thread_id) VALUES ('m1', 's1', 't1')").run();
		db.query(
			"INSERT INTO read_positions (thread_id, seq, epoch, modified_at, updated_at) VALUES ('t1', 3, NULL, 9, 1)",
		).run();
		migrate(db);
		expect(db.query("SELECT thread_id FROM thread_sessions WHERE session_id = 's1'").all()).toEqual([
			{ thread_id: "t1" },
		]);
		expect(db.query("SELECT modified_at FROM read_positions").all()).toEqual([{ modified_at: 9 }]);
		expect(db.query("SELECT count(*) AS n FROM handoffs").get()).toEqual({ n: 0 });
		expect(db.query("SELECT count(*) AS n FROM thread_hops").get()).toEqual({ n: 0 });
	});

	test("one active operation per thread: the unique index refuses a second and lets a finished one go", () => {
		const s = store();
		s.upsertMachine(machine("m1"));
		s.syncSessions("m1", [info("s1")]);
		const thread = s.threadOf("m1", "s1")!;
		s.createHandoff({ id: "op000001", threadId: thread, wire: wire("op000001", thread, "running"), priv: {} });
		expect(() =>
			s.createHandoff({ id: "op000002", threadId: thread, wire: wire("op000002", thread, "running"), priv: {} }),
		).toThrow(HandoffConflictError);
		expect(s.activeHandoffs().map(w => w.id)).toEqual(["op000001"]);
		s.saveHandoff("op000001", wire("op000001", thread, "rolled_back"), {});
		s.createHandoff({ id: "op000002", threadId: thread, wire: wire("op000002", thread, "running"), priv: {} });
		expect(s.activeHandoffs().map(w => w.id)).toEqual(["op000002"]);
		// finished operations are listed until dismissed
		expect(s.visibleHandoffs(0).map(w => w.id)).toEqual(["op000001", "op000002"]);
		s.dismissHandoff("op000001");
		expect(s.visibleHandoffs(0).map(w => w.id)).toEqual(["op000002"]);
	});

	test("hops chain a thread across machines: the old session reports where the thread went, the new one lists the history; a second hop is followed", () => {
		const s = store();
		for (const id of ["m1", "m2", "m3"]) s.upsertMachine(machine(id));
		s.syncSessions("m1", [info("s1")]);
		const thread = s.threadOf("m1", "s1")!;
		const hop = (id: string, at: number, from: [string, string], to: [string, string]) => ({
			id,
			threadId: thread,
			handoffId: `h-${id}`,
			at,
			from: { machine: from[0], machineName: from[0], sessionId: from[1], cwd: "/a" },
			to: { machine: to[0], machineName: to[0], sessionId: to[1], cwd: "/b", branch: "omp-web/x" },
			forecast: "partial" as const,
		});
		s.commitHandoff(hop("1", 100, ["m1", "s1"], ["m2", "s2"]), wire("h-1", thread, "completed"), {});
		s.syncSessions("m2", [info("s2")]);
		// the target session joined the existing thread instead of getting a thread of its own
		expect(s.threadOf("m2", "s2")).toBe(thread);
		expect(s.sessions("m1")[0]!.movedTo).toMatchObject({ machine: "m2", sessionId: "s2", at: 100 });
		expect(s.sessions("m2")[0]!.movedTo).toBeUndefined();
		expect(s.sessions("m2")[0]!.hops).toHaveLength(1);
		s.commitHandoff(hop("2", 200, ["m2", "s2"], ["m3", "s3"]), wire("h-2", thread, "completed"), {});
		s.syncSessions("m3", [info("s3")]);
		expect(s.sessions("m1")[0]!.movedTo).toMatchObject({ machine: "m3", sessionId: "s3" });
		expect(s.sessions("m2")[0]!.movedTo).toMatchObject({ machine: "m3", sessionId: "s3" });
		expect(s.sessions("m3")[0]!.movedTo).toBeUndefined();
		expect(s.sessions("m3")[0]!.hops!.map(h => h.id)).toEqual(["1", "2"]);
	});

	test("the pending target session is marked while the operation is active, and mapping it early keeps it out of a thread of its own", () => {
		const s = store();
		s.upsertMachine(machine("m1"));
		s.upsertMachine(machine("m2"));
		s.syncSessions("m1", [info("s1")]);
		const thread = s.threadOf("m1", "s1")!;
		const pending = wire("op000001", thread, "running");
		pending.target.sessionId = "s2";
		s.createHandoff({ id: "op000001", threadId: thread, wire: pending, priv: {} });
		s.mapSession("m2", "s2", thread);
		s.syncSessions("m2", [info("s2")]);
		expect(s.threadOf("m2", "s2")).toBe(thread);
		expect(s.sessions("m2")[0]!.handoff).toEqual({ id: "op000001", role: "target" });
		expect(s.sessions("m1")[0]!.handoff).toEqual({ id: "op000001", role: "source" });
		// a rolled back operation un-maps the fork
		s.unmapSession("m2", "s2");
		expect(s.threadOf("m2", "s2")).toBeUndefined();
	});
});
