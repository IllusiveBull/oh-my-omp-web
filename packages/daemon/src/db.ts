import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
	HANDOFF_ACTIVE_PHASES,
	type DaemonHello,
	type ForecastSummary,
	type GatewaySessionInfo,
	type HandoffWire,
	type ProjectInfo,
	type ReplicaFileMeta,
	type ReplicaInfo,
	type SessionInfo,
	type ThreadHop,
} from "@omp-web/protocol";
import { aclProblem, restrictPath } from "./file-acl";
import { ConfigError, mkdirPrivateSync, randomToken } from "./secrets";

export interface Migration {
	/** Strictly increasing, starting at 1; stored in `PRAGMA user_version`. */
	version: number;
	sql: string;
}

/**
 * The gateway database schema, oldest first. NEVER edit an entry that has shipped: add a new one. A migration runs in one
 * transaction together with the version bump.
 */
export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		sql: `
CREATE TABLE machines (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	platform TEXT NOT NULL,
	daemon_version TEXT NOT NULL,
	omp TEXT NOT NULL,
	lease_warnings TEXT NOT NULL,
	last_seen INTEGER NOT NULL
);
-- The registered projects of a machine as it last reported them (a cache: the machine is the authority).
CREATE TABLE projects (
	machine_id TEXT PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
	projects TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
-- A thread is one conversation. Today it lives on one machine; it chains the session ids that conversation went
-- through (older files, the id after omp moved the session to a sibling file).
CREATE TABLE threads (
	id TEXT PRIMARY KEY,
	machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL
);
CREATE TABLE thread_sessions (
	machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
	session_id TEXT NOT NULL,
	thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
	PRIMARY KEY (machine_id, session_id)
);
CREATE INDEX thread_sessions_thread ON thread_sessions(thread_id);
-- The machine's session list as it last reported it, so the list renders while the machine is offline.
CREATE TABLE session_index (
	machine_id TEXT PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
	sessions TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
-- How far the user has read a thread. modified_at is the session's own modifiedAt (a clock of its machine).
CREATE TABLE read_positions (
	thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	epoch TEXT,
	modified_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
-- Browser logins: only a hash of the cookie value is stored.
CREATE TABLE auth_sessions (
	token_hash TEXT PRIMARY KEY,
	expires_at INTEGER NOT NULL
);
`,
	},
	{
		version: 2,
		sql: `
-- The gateway's copy of a machine's session files (the bytes live under <state dir>/replicas/<machine>/<name>).
-- size / mtime_ms: what the copy holds; source_size / source_mtime_ms: the version the machine last reported.
CREATE TABLE replica_files (
	machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
	file_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	name TEXT NOT NULL,
	size INTEGER NOT NULL,
	source_size INTEGER NOT NULL,
	mtime_ms INTEGER NOT NULL,
	source_mtime_ms INTEGER NOT NULL,
	slot_len INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (machine_id, file_id)
);
CREATE INDEX replica_files_session ON replica_files(machine_id, session_id);
`,
	},
	{
		version: 3,
		sql: `
-- Web Push: one row per subscribed device. The endpoint is a capability URL, so it is never sent back to browsers.
CREATE TABLE push_subscriptions (
	id TEXT PRIMARY KEY,
	endpoint TEXT NOT NULL UNIQUE,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	label TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_delivered_at INTEGER
);
-- Which devices were pushed a notification for a thread and have not been told to clear it yet.
CREATE TABLE push_notified (
	subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	sent_at INTEGER NOT NULL,
	PRIMARY KEY (subscription_id, thread_id)
);
`,
	},
	{
		version: 4,
		sql: `
-- Environment switches: one row per operation, a persisted state machine. wire is what clients see (HandoffWire),
-- private is what only the orchestrator needs to finish or roll back (resources per machine, link ids, results of steps).
-- At most one operation per thread is active: the partial unique index is the lock.
CREATE TABLE handoffs (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
	phase TEXT NOT NULL,
	dismissed INTEGER NOT NULL DEFAULT 0,
	wire TEXT NOT NULL,
	private TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX handoffs_one_active ON handoffs(thread_id)
	WHERE phase IN ('running', 'awaiting_confirm', 'confirming', 'rolling_back', 'rollback_failed');
-- A thread chains the sessions of one conversation across environments: every completed move is a hop. The session on the
-- target machine also joins the thread through thread_sessions (migration 1), whose rows may now name several machines.
CREATE TABLE thread_hops (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
	handoff_id TEXT NOT NULL,
	at INTEGER NOT NULL,
	from_machine TEXT NOT NULL,
	from_machine_name TEXT NOT NULL,
	from_session TEXT NOT NULL,
	from_cwd TEXT NOT NULL,
	to_machine TEXT NOT NULL,
	to_machine_name TEXT NOT NULL,
	to_session TEXT NOT NULL,
	to_cwd TEXT NOT NULL,
	to_branch TEXT,
	forecast TEXT
);
CREATE INDEX thread_hops_thread ON thread_hops(thread_id, at);
`,
	},
	{
		version: 5,
		sql: "ALTER TABLE machines ADD COLUMN nickname TEXT;",
	},
	{
		version: 6,
		sql: "ALTER TABLE machines ADD COLUMN home TEXT;",
	},
	{
		version: 7,
		sql: "ALTER TABLE machines ADD COLUMN antigravity TEXT;",
	},
];

/** Brings `db` to the newest schema; refuses a database written by a newer build (it would be misread). */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): void {
	const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
	const latest = migrations.at(-1)?.version ?? 0;
	if (current > latest) {
		throw new ConfigError(
			`the gateway database is at schema version ${current}, newer than this build understands (${latest}); upgrade omp-web instead of opening it with an older one`,
		);
	}
	for (const migration of migrations) {
		if (migration.version <= current) continue;
		db.transaction(() => {
			db.exec(migration.sql);
			db.exec(`PRAGMA user_version = ${migration.version}`);
		})();
	}
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface StoredMachine {
	id: string;
	name: string;
	nickname?: string;
	platform: string;
	home?: string;
	daemonVersion: string;
	omp: DaemonHello["omp"];
	antigravity?: DaemonHello["antigravity"];
	leaseWarnings: string[];
	lastSeen: number;
}

export interface ReadReport {
	seq: number;
	epoch?: string;
	modifiedAt: number;
}

export class UnknownSessionError extends Error {}

/** What the gateway holds of one session file (see migration 2). */
export interface ReplicaRow {
	machineId: string;
	fileId: string;
	sessionId: string;
	name: string;
	/** Bytes of the copy, and the machine's file version (mtime) they belong to. */
	size: number;
	mtimeMs: number;
	/** The version the machine last reported. The copy is complete when both pairs are equal. */
	sourceSize: number;
	sourceMtimeMs: number;
	slotLen: number;
	updatedAt: number;
}

function toReplicaRow(r: Record<string, unknown>): ReplicaRow {
	return {
		machineId: r.machine_id as string,
		fileId: r.file_id as string,
		sessionId: r.session_id as string,
		name: r.name as string,
		size: r.size as number,
		mtimeMs: r.mtime_ms as number,
		sourceSize: r.source_size as number,
		sourceMtimeMs: r.source_mtime_ms as number,
		slotLen: r.slot_len as number,
		updatedAt: r.updated_at as number,
	};
}

/** The replica state of a conversation from the rows of its files; undefined when no byte of it was copied yet. */
function replicaInfo(rows: ReplicaRow[]): ReplicaInfo | undefined {
	const files = [...new Map(rows.map(r => [r.fileId, r])).values()];
	const copied = files.filter(r => r.size > 0);
	if (copied.length === 0) return undefined;
	return {
		state: files.every(r => r.size === r.sourceSize && r.mtimeMs === r.sourceMtimeMs) ? "complete" : "partial",
		asOf: Math.max(...copied.map(r => r.mtimeMs)),
		syncedAt: Math.max(...copied.map(r => r.updatedAt)),
	};
}

/** A subscribed device with the keys the push is encrypted to. */
export interface PushSubscriptionRow {
	id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	label: string;
	createdAt: number;
	lastDeliveredAt: number | null;
}

/** What the old end of a chain of moves points at: the thread's current location, found by following the hops. */
function movedToOf(
	chain: readonly ThreadHop[],
	machineId: string,
	ids: readonly string[],
): { machine: string; machineName: string; sessionId: string; at: number } | undefined {
	let at = chain.find(h => h.from.machine === machineId && ids.includes(h.from.sessionId));
	let last: ThreadHop | undefined;
	while (at) {
		last = at;
		const next: ThreadHop | undefined = chain.find(
			h =>
				h.at >= at!.at &&
				h.id !== at!.id &&
				h.from.machine === at!.to.machine &&
				h.from.sessionId === at!.to.sessionId,
		);
		at = next;
	}
	return (
		last && { machine: last.to.machine, machineName: last.to.machineName, sessionId: last.to.sessionId, at: last.at }
	);
}

/** Whether an active environment switch involves this session, and as which end. */
function handoffMarker(
	active: readonly HandoffWire[],
	threadId: string,
	machineId: string,
	ids: readonly string[],
	cwd: string,
): { id: string; role: "source" | "target" } | undefined {
	for (const wire of active) {
		if (wire.threadId !== threadId) continue;
		if (wire.source.machine === machineId && ids.includes(wire.source.sessionId))
			return { id: wire.id, role: "source" };
		if (wire.target.machine !== machineId) continue;
		if (wire.target.sessionId !== undefined ? ids.includes(wire.target.sessionId) : cwd === wire.target.worktree) {
			return { id: wire.id, role: "target" };
		}
	}
	return undefined;
}

/** A change another operation made to the same thread: the one-active-operation lock refused a second one. */
export class HandoffConflictError extends Error {}

/** The gateway's SQLite database (`bun:sqlite`): machines, projects, threads, the session index cache, read positions, logins. */
export class GatewayStore {
	readonly #db: Database;
	readonly #now: () => number;

	private constructor(db: Database, now: () => number) {
		this.#db = db;
		this.#now = now;
	}

	/** Opens (creating, readable by this user only) and migrates the database at `file`; `:memory:` for tests. */
	static open(file: string, options: { now?: () => number; migrations?: readonly Migration[] } = {}): GatewayStore {
		const isFile = file !== ":memory:";
		if (isFile) mkdirPrivateSync(dirname(file));
		const existed = isFile && existsSync(file);
		// Windows: an existing database whose ACL lets others read it is refused (like a secret file), a new one is restricted
		// before anything is written. Its -wal / -shm inherit from the directory: private when the daemon created it, else
		// whatever that directory grants.
		if (isFile && existed && process.platform === "win32") {
			const problem = aclProblem(file);
			if (problem !== null) throw new ConfigError(problem);
		}
		const db = new Database(file, { create: true });
		if (isFile && process.platform !== "win32") chmodSync(file, 0o600);
		else if (isFile && !existed) restrictPath(file);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA foreign_keys = ON");
		migrate(db, options.migrations);
		return new GatewayStore(db, options.now ?? Date.now);
	}

	close(): void {
		this.#db.close();
	}

	// -- machines ------------------------------------------------------------

	machines(): StoredMachine[] {
		return this.#db
			.query(
				"SELECT id, name, nickname, platform, home, daemon_version, omp, antigravity, lease_warnings, last_seen FROM machines ORDER BY name",
			)
			.all()
			.map(row => {
				const r = row as Record<string, string | number | null>;
				return {
					id: r.id as string,
					name: r.name as string,
					...(r.nickname == null ? {} : { nickname: r.nickname as string }),
					platform: r.platform as string,
					...(r.home == null ? {} : { home: r.home as string }),
					daemonVersion: r.daemon_version as string,
					omp: JSON.parse(r.omp as string) as DaemonHello["omp"],
					...(r.antigravity == null
						? {}
						: { antigravity: JSON.parse(r.antigravity as string) as DaemonHello["antigravity"] }),
					leaseWarnings: JSON.parse(r.lease_warnings as string) as string[],
					lastSeen: r.last_seen as number,
				};
			});
	}

	upsertMachine(machine: StoredMachine): void {
		this.#db
			.query(
				`INSERT INTO machines (id, name, platform, daemon_version, omp, antigravity, lease_warnings, last_seen, home)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
				ON CONFLICT(id) DO UPDATE SET name = ?2, platform = ?3, daemon_version = ?4, omp = ?5, antigravity = ?6, lease_warnings = ?7, last_seen = ?8, home = ?9`,
			)
			.run(
				machine.id,
				machine.name,
				machine.platform,
				machine.daemonVersion,
				JSON.stringify(machine.omp),
				machine.antigravity ? JSON.stringify(machine.antigravity) : null,
				JSON.stringify(machine.leaseWarnings),
				machine.lastSeen,
				machine.home ?? null,
			);
	}

	setMachineNickname(id: string, nickname: string | null): void {
		this.#db.query("UPDATE machines SET nickname = ?2 WHERE id = ?1").run(id, nickname);
	}

	touchMachine(id: string, lastSeen: number): void {
		this.#db.query("UPDATE machines SET last_seen = ?2 WHERE id = ?1").run(id, lastSeen);
	}

	/** Forgets a machine and everything the gateway cached about it (threads and read positions included). */
	deleteMachine(id: string): void {
		this.#db.query("DELETE FROM machines WHERE id = ?").run(id);
	}

	// -- projects ------------------------------------------------------------

	setProjects(machineId: string, projects: ProjectInfo[]): void {
		this.#db
			.query(
				`INSERT INTO projects (machine_id, projects, updated_at) VALUES (?1, ?2, ?3)
				ON CONFLICT(machine_id) DO UPDATE SET projects = ?2, updated_at = ?3`,
			)
			.run(machineId, JSON.stringify(projects), this.#now());
	}

	projects(machineId: string): ProjectInfo[] {
		const row = this.#db.query("SELECT projects FROM projects WHERE machine_id = ?").get(machineId) as {
			projects: string;
		} | null;
		return row ? (JSON.parse(row.projects) as ProjectInfo[]) : [];
	}

	// -- sessions, threads, read positions -----------------------------------

	/**
	 * Stores a machine's reported session list as the cache and makes sure every conversation has a thread: sessions whose
	 * id or alias is already known join that thread (so a conversation keeps its thread across the ids it goes through),
	 * the rest start one. A new thread starts read: what existed before the gateway saw it is history, not news.
	 */
	syncSessions(machineId: string, sessions: SessionInfo[]): GatewaySessionInfo[] {
		this.#db.transaction(() => {
			const known = this.#threadsOf(machineId);
			const now = this.#now();
			for (const info of sessions) {
				const ids = [info.id, info.sessionId, ...info.aliases];
				let thread = ids.map(id => known.get(id)).find(t => t !== undefined);
				if (thread === undefined) {
					thread = randomToken(12);
					this.#db
						.query("INSERT INTO threads (id, machine_id, created_at) VALUES (?, ?, ?)")
						.run(thread, machineId, now);
					this.#db
						.query(
							"INSERT INTO read_positions (thread_id, seq, epoch, modified_at, updated_at) VALUES (?, 0, NULL, ?, ?)",
						)
						.run(thread, info.modifiedAt, now);
				}
				for (const id of ids) {
					if (known.has(id)) continue;
					known.set(id, thread);
					this.#db
						.query("INSERT INTO thread_sessions (machine_id, session_id, thread_id) VALUES (?, ?, ?)")
						.run(machineId, id, thread);
				}
			}
			this.#db
				.query(
					`INSERT INTO session_index (machine_id, sessions, updated_at) VALUES (?1, ?2, ?3)
					ON CONFLICT(machine_id) DO UPDATE SET sessions = ?2, updated_at = ?3`,
				)
				.run(machineId, JSON.stringify(sessions), now);
		})();
		return this.sessions(machineId);
	}

	/** The machine's cached session list with thread ids and unread flags (empty when it never reported). */
	sessions(machineId: string): GatewaySessionInfo[] {
		const row = this.#db.query("SELECT sessions FROM session_index WHERE machine_id = ?").get(machineId) as {
			sessions: string;
		} | null;
		if (!row) return [];
		const known = this.#threadsOf(machineId);
		// By the sessions this machine lists, not by the thread's creator: a thread that moved here (a hop) was created on
		// the source machine, and its one read position covers the sessions of every machine it went through.
		const read = new Map<string, number>();
		for (const r of this.#db
			.query(
				"SELECT thread_id, modified_at FROM read_positions WHERE thread_id IN (SELECT thread_id FROM thread_sessions WHERE machine_id = ?)",
			)
			.all(machineId) as { thread_id: string; modified_at: number }[]) {
			read.set(r.thread_id, r.modified_at);
		}
		const replicas = new Map<string, ReplicaRow[]>();
		for (const r of this.replicaRows(machineId)) replicas.set(r.sessionId, [...(replicas.get(r.sessionId) ?? []), r]);
		const hops = this.#hopsByThread();
		const active = this.activeHandoffs();
		return (JSON.parse(row.sessions) as SessionInfo[]).flatMap(info => {
			const threadId = known.get(info.id);
			if (threadId === undefined) return [];
			const ids = [info.id, info.sessionId, ...info.aliases];
			const replica = replicaInfo(ids.flatMap(id => replicas.get(id) ?? []));
			const chain = hops.get(threadId);
			const movedTo = chain ? movedToOf(chain, machineId, ids) : undefined;
			const handoff = handoffMarker(active, threadId, machineId, ids, info.cwd);
			return [
				{
					...info,
					threadId,
					unread: info.modifiedAt > (read.get(threadId) ?? 0),
					...(replica ? { replica } : {}),
					...(chain ? { hops: chain } : {}),
					...(movedTo ? { movedTo } : {}),
					...(handoff ? { handoff } : {}),
				},
			];
		});
	}

	/**
	 * Records that a client has read a session up to `report`. Only moves forward (a stale tab reporting late changes
	 * nothing). Returns true when the thread's unread state may have changed, i.e. the session list needs re-sending.
	 */
	markRead(machineId: string, sessionId: string, report: ReadReport): boolean {
		const thread = this.#threadsOf(machineId).get(sessionId);
		if (thread === undefined) throw new UnknownSessionError(`unknown session: ${sessionId}`);
		const current = this.#db
			.query("SELECT seq, epoch, modified_at FROM read_positions WHERE thread_id = ?")
			.get(thread) as {
			seq: number;
			epoch: string | null;
			modified_at: number;
		} | null;
		const advancesTime = report.modifiedAt > (current?.modified_at ?? -1);
		const sameTime = report.modifiedAt === current?.modified_at;
		const advancesSeq = sameTime && (report.epoch !== (current.epoch ?? undefined) || report.seq > current.seq);
		if (!advancesTime && !advancesSeq) return false;
		this.#db
			.query(
				`INSERT INTO read_positions (thread_id, seq, epoch, modified_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
				ON CONFLICT(thread_id) DO UPDATE SET seq = ?2, epoch = ?3, modified_at = ?4, updated_at = ?5`,
			)
			.run(thread, report.seq, report.epoch ?? null, report.modifiedAt, this.#now());
		return advancesTime;
	}

	#threadsOf(machineId: string): Map<string, string> {
		const map = new Map<string, string>();
		for (const r of this.#db
			.query("SELECT session_id, thread_id FROM thread_sessions WHERE machine_id = ?")
			.all(machineId) as {
			session_id: string;
			thread_id: string;
		}[]) {
			map.set(r.session_id, r.thread_id);
		}
		return map;
	}

	// -- browser logins ------------------------------------------------------

	/** Starts a login; returns the cookie value (only its hash is stored). */
	createAuthSession(ttlMs: number): string {
		const cookie = randomBytes(32).toString("base64url");
		this.#db
			.query("INSERT INTO auth_sessions (token_hash, expires_at) VALUES (?, ?)")
			.run(sha256(cookie), this.#now() + ttlMs);
		this.#db.query("DELETE FROM auth_sessions WHERE expires_at <= ?").run(this.#now());
		return cookie;
	}

	authSessionValid(cookie: string): boolean {
		const row = this.#db.query("SELECT expires_at FROM auth_sessions WHERE token_hash = ?").get(sha256(cookie)) as {
			expires_at: number;
		} | null;
		return row !== null && row.expires_at > this.#now();
	}

	deleteAuthSession(cookie: string): void {
		this.#db.query("DELETE FROM auth_sessions WHERE token_hash = ?").run(sha256(cookie));
	}

	// -- transcript replicas ---------------------------------------------------

	replicaRows(machineId: string): ReplicaRow[] {
		return (
			this.#db.query("SELECT * FROM replica_files WHERE machine_id = ?").all(machineId) as Record<string, unknown>[]
		).map(toReplicaRow);
	}

	replicaRow(machineId: string, fileId: string): ReplicaRow | null {
		const row = this.#db
			.query("SELECT * FROM replica_files WHERE machine_id = ? AND file_id = ?")
			.get(machineId, fileId) as Record<string, unknown> | null;
		return row ? toReplicaRow(row) : null;
	}

	/**
	 * Takes the machine's list of files to replicate as the truth: new files get an empty row, known ones learn their
	 * current size / mtime on the machine, rows no longer listed are deleted (returned, so their copies can be removed).
	 * `stale` are the files whose copy is not the version the machine reported.
	 */
	replicaReconcile(machineId: string, files: ReplicaFileMeta[]): { stale: string[]; removed: ReplicaRow[] } {
		const now = this.#now();
		const listed = new Set(files.map(f => f.id));
		const removed = this.replicaRows(machineId).filter(r => !listed.has(r.fileId));
		this.#db.transaction(() => {
			for (const r of removed) {
				this.#db.query("DELETE FROM replica_files WHERE machine_id = ? AND file_id = ?").run(machineId, r.fileId);
			}
			for (const f of files) {
				this.#db
					.query(
						`INSERT INTO replica_files (machine_id, file_id, session_id, name, size, source_size, mtime_ms, source_mtime_ms, slot_len, updated_at)
						VALUES (?1, ?2, ?3, ?4, 0, ?5, 0, ?6, 0, ?7)
						ON CONFLICT(machine_id, file_id) DO UPDATE SET session_id = ?3, name = ?4, source_size = ?5, source_mtime_ms = ?6`,
					)
					.run(machineId, f.id, f.sessionId, f.name, f.size, f.mtimeMs, now);
			}
		})();
		const stale = this.replicaRows(machineId)
			.filter(r => r.size !== r.sourceSize || r.mtimeMs !== r.sourceMtimeMs)
			.map(r => r.fileId);
		return { stale, removed };
	}

	/** The copy of a file now holds `size` bytes (title slot `slotLen`) of the version modified at `mtimeMs`. */
	replicaApplied(
		machineId: string,
		fileId: string,
		applied: { size: number; slotLen: number; mtimeMs: number },
	): void {
		this.#db
			.query(
				"UPDATE replica_files SET size = ?3, slot_len = ?4, mtime_ms = ?5, updated_at = ?6 WHERE machine_id = ?1 AND file_id = ?2",
			)
			.run(machineId, fileId, applied.size, applied.slotLen, applied.mtimeMs, this.#now());
	}

	replicaForget(machineId: string, fileId: string): void {
		this.#db.query("DELETE FROM replica_files WHERE machine_id = ? AND file_id = ?").run(machineId, fileId);
	}

	// -- web push --------------------------------------------------------------

	/** Registers a device (or updates the one with the same endpoint, keeping its id). */
	addPushSubscription(sub: { endpoint: string; p256dh: string; auth: string; label: string }): PushSubscriptionRow {
		const existing = this.#db.query("SELECT id FROM push_subscriptions WHERE endpoint = ?").get(sub.endpoint) as {
			id: string;
		} | null;
		const id = existing?.id ?? randomToken(12);
		this.#db
			.query(
				`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
				ON CONFLICT(id) DO UPDATE SET p256dh = ?3, auth = ?4, label = ?5`,
			)
			.run(id, sub.endpoint, sub.p256dh, sub.auth, sub.label, this.#now());
		return this.pushSubscriptions().find(s => s.id === id)!;
	}

	pushSubscriptions(): PushSubscriptionRow[] {
		return (
			this.#db.query("SELECT * FROM push_subscriptions ORDER BY created_at").all() as Record<string, unknown>[]
		).map(r => ({
			id: r.id as string,
			endpoint: r.endpoint as string,
			p256dh: r.p256dh as string,
			auth: r.auth as string,
			label: r.label as string,
			createdAt: r.created_at as number,
			lastDeliveredAt: (r.last_delivered_at as number | null) ?? null,
		}));
	}

	deletePushSubscription(id: string): boolean {
		return this.#db.query("DELETE FROM push_subscriptions WHERE id = ?").run(id).changes > 0;
	}

	recordPushDelivered(id: string): void {
		this.#db.query("UPDATE push_subscriptions SET last_delivered_at = ? WHERE id = ?").run(this.#now(), id);
	}

	/** `thread` was pushed to device `subscriptionId`: a later read of the thread must clear it there. */
	markNotified(subscriptionId: string, threadId: string): void {
		this.#db
			.query("INSERT OR REPLACE INTO push_notified (subscription_id, thread_id, sent_at) VALUES (?, ?, ?)")
			.run(subscriptionId, threadId, this.#now());
	}

	/** The devices still showing a notification for `threadId` (forgets them: the caller is about to clear it). */
	takeNotified(threadId: string): string[] {
		const ids = (
			this.#db.query("SELECT subscription_id FROM push_notified WHERE thread_id = ?").all(threadId) as {
				subscription_id: string;
			}[]
		).map(r => r.subscription_id);
		this.#db.query("DELETE FROM push_notified WHERE thread_id = ?").run(threadId);
		return ids;
	}

	// -- environment switches -----------------------------------------------------

	/** Starts an operation; throws {@link HandoffConflictError} when the thread already has an active one. */
	createHandoff(row: { id: string; threadId: string; wire: HandoffWire; priv: unknown }): void {
		const now = this.#now();
		try {
			this.#db
				.query(
					`INSERT INTO handoffs (id, thread_id, phase, dismissed, wire, private, created_at, updated_at)
					VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?6)`,
				)
				.run(row.id, row.threadId, row.wire.phase, JSON.stringify(row.wire), JSON.stringify(row.priv), now);
		} catch (error) {
			if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
				throw new HandoffConflictError("This thread is already being switched to another environment.");
			}
			throw error;
		}
	}

	/** Replaces an operation's public and private state (and the phase column the lock index looks at). */
	saveHandoff(id: string, wire: HandoffWire, priv: unknown): void {
		this.#db
			.query("UPDATE handoffs SET phase = ?2, wire = ?3, private = ?4, updated_at = ?5 WHERE id = ?1")
			.run(id, wire.phase, JSON.stringify(wire), JSON.stringify(priv), this.#now());
	}

	handoff(id: string): { wire: HandoffWire; priv: unknown; dismissed: boolean } | null {
		const row = this.#db.query("SELECT wire, private, dismissed FROM handoffs WHERE id = ?").get(id) as {
			wire: string;
			private: string;
			dismissed: number;
		} | null;
		return (
			row && {
				wire: JSON.parse(row.wire) as HandoffWire,
				priv: JSON.parse(row.private),
				dismissed: row.dismissed === 1,
			}
		);
	}

	/** Operations still holding their thread (running, waiting for the user, rolling back). */
	activeHandoffs(): HandoffWire[] {
		const marks = HANDOFF_ACTIVE_PHASES.map(() => "?").join(", ");
		return (
			this.#db
				.query(`SELECT wire FROM handoffs WHERE phase IN (${marks}) ORDER BY created_at`)
				.all(...HANDOFF_ACTIVE_PHASES) as { wire: string }[]
		).map(r => JSON.parse(r.wire) as HandoffWire);
	}

	/** What clients list: active operations and the finished ones nobody dismissed within `finishedSinceMs`. */
	visibleHandoffs(finishedSinceMs: number): HandoffWire[] {
		const marks = HANDOFF_ACTIVE_PHASES.map(() => "?").join(", ");
		return (
			this.#db
				.query(
					`SELECT wire FROM handoffs WHERE phase IN (${marks}) OR (dismissed = 0 AND updated_at >= ?)
					ORDER BY created_at`,
				)
				.all(...HANDOFF_ACTIVE_PHASES, finishedSinceMs) as { wire: string }[]
		).map(r => JSON.parse(r.wire) as HandoffWire);
	}

	dismissHandoff(id: string): void {
		this.#db.query("UPDATE handoffs SET dismissed = 1 WHERE id = ?").run(id);
	}

	/**
	 * Lets the session `sessionId` of `machineId` belong to `threadId` (the forked copy on the target machine: it is part of
	 * the thread before the machine lists it, so it never gets a thread of its own). A thread the machine's list created
	 * for it in the meantime is dropped when nothing else is in it.
	 */
	mapSession(machineId: string, sessionId: string, threadId: string): void {
		this.#db.transaction(() => {
			const previous = this.#threadsOf(machineId).get(sessionId);
			this.#db
				.query("INSERT OR REPLACE INTO thread_sessions (machine_id, session_id, thread_id) VALUES (?, ?, ?)")
				.run(machineId, sessionId, threadId);
			if (previous !== undefined && previous !== threadId) {
				this.#db
					.query(
						"DELETE FROM threads WHERE id = ? AND NOT EXISTS (SELECT 1 FROM thread_sessions WHERE thread_id = threads.id)",
					)
					.run(previous);
			}
		})();
	}

	unmapSession(machineId: string, sessionId: string): void {
		this.#db.query("DELETE FROM thread_sessions WHERE machine_id = ? AND session_id = ?").run(machineId, sessionId);
	}

	/** The thread now continues in the target session: one hop recorded, the target session in the thread, in one transaction. */
	recordHop(hop: ThreadHop & { threadId: string }): void {
		this.#db.transaction(() => {
			this.#db
				.query(
					`INSERT INTO thread_hops (id, thread_id, handoff_id, at, from_machine, from_machine_name, from_session, from_cwd,
						to_machine, to_machine_name, to_session, to_cwd, to_branch, forecast)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
				)
				.run(
					hop.id,
					hop.threadId,
					hop.handoffId,
					hop.at,
					hop.from.machine,
					hop.from.machineName,
					hop.from.sessionId,
					hop.from.cwd,
					hop.to.machine,
					hop.to.machineName,
					hop.to.sessionId,
					hop.to.cwd,
					hop.to.branch,
					hop.forecast,
				);
			this.mapSession(hop.to.machine, hop.to.sessionId, hop.threadId);
		})();
	}

	/** The commit point of an environment switch: the hop and the operation's final state become durable together. */
	commitHandoff(hop: ThreadHop & { threadId: string }, wire: HandoffWire, priv: unknown): void {
		this.#db.transaction(() => {
			this.recordHop(hop);
			this.saveHandoff(wire.id, wire, priv);
		})();
	}

	/** Every completed move of `threadId`, oldest first. */
	hopsOf(threadId: string): ThreadHop[] {
		return this.#hopsByThread().get(threadId) ?? [];
	}

	#hopsByThread(): Map<string, ThreadHop[]> {
		const out = new Map<string, ThreadHop[]>();
		const rows = this.#db.query("SELECT * FROM thread_hops ORDER BY at, rowid").all() as Record<string, unknown>[];
		for (const r of rows) {
			const hop: ThreadHop = {
				id: r.id as string,
				handoffId: r.handoff_id as string,
				at: r.at as number,
				from: {
					machine: r.from_machine as string,
					machineName: r.from_machine_name as string,
					sessionId: r.from_session as string,
					cwd: r.from_cwd as string,
				},
				to: {
					machine: r.to_machine as string,
					machineName: r.to_machine_name as string,
					sessionId: r.to_session as string,
					cwd: r.to_cwd as string,
					branch: (r.to_branch as string | null) ?? null,
				},
				forecast: ((r.forecast as string | null) ?? null) as ForecastSummary | null,
			};
			const list = out.get(r.thread_id as string) ?? [];
			list.push(hop);
			out.set(r.thread_id as string, list);
		}
		return out;
	}

	/** The thread of a session (or one of its alias ids) on a machine. */
	threadOf(machineId: string, sessionId: string): string | undefined {
		return this.#threadsOf(machineId).get(sessionId);
	}
}
