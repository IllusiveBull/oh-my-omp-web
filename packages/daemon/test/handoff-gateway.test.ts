import { afterEach, describe, expect, test } from "bun:test";
import type {
	HandoffLimits,
	HandoffOpArgs,
	HandoffOpName,
	HandoffOpResult,
	HandoffWire,
	SessionFacts,
	SessionInfo,
	XferInfo,
} from "@omp-web/protocol";
import { GatewayStore } from "../src/db";
import { HandoffCoordinator, subdirOf, type HandoffTransport } from "../src/handoff-gateway";
import { HandoffCallError } from "../src/handoff-link";

const LIMITS: HandoffLimits = {
	maxFileBytes: 1 << 20,
	maxTotalBytes: 8 << 20,
	maxBundleBytes: 64 << 20,
	maxArchiveBytes: 64 << 20,
};
const SESSION = "01a1d235-fba4-7640-b01c-7cea4ff1c5c5";
const SOURCE_CWD = "/work/proj/packages/web";

const FACTS: SessionFacts = {
	sessionId: SESSION,
	origin: "live",
	capturedAt: 1,
	omp: "18.19.0",
	platform: "darwin",
	model: { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" },
	thinkingLevel: "high",
	fastModeActive: false,
	slowModeEnabled: false,
	tools: { hash: "t", count: 12 },
	systemHead: { hash: "h", chars: 7500 },
	systemTail: { hash: "tail", chars: 460 },
	context: { tokens: 9000, window: 200000 },
	lastRequestAt: 1_000_000 - 30_000,
	history: { entries: 7, hash: "hist", compactions: 0, lastCompactionIndex: null },
	pins: [],
	accounts: { via: "local-db", hashes: [] },
	promptCacheKey: SESSION,
};

const carried = {
	base: { commit: "a".repeat(40), branch: "main", detached: false },
	tracked: { modified: 1, added: 0, deleted: 0, renamed: 0, typeChanged: 0, modeChanged: 0 },
	untracked: { files: 1, bytes: 10 },
	staged: { preserved: true, paths: 0 },
	skipped: [],
	skippedTruncated: false,
	ignored: { count: 0, sample: [] },
	sample: ["a.txt"],
	paths: 2,
};

type Handler = (machine: string, op: HandoffOpName, args: unknown) => unknown | Promise<unknown>;

/** Two simulated daemons behind the transport the coordinator uses; every call is recorded, any can be made to fail. */
class World implements HandoffTransport {
	calls: { machine: string; op: HandoffOpName; args: unknown }[] = [];
	online_ = new Set<string>(["m1", "m2"]);
	links: Record<string, number> = { m1: 1, m2: 1 };
	failOn: { op: HandoffOpName; machine?: string; kind?: "refused" | "failed" | "link" } | null = null;
	rollbackLeftovers: Record<string, string[]> = {};
	transfers = 0;
	failTransfer = false;
	targetFacts: SessionFacts = { ...FACTS, sessionId: "fork-session-id", origin: "live" };
	projectOnTarget = true;
	sourceBlockers: string[] = [];
	/** The source session has no conversation yet (`source.commit` reports it fresh). */
	fresh = false;
	handler: Handler | null = null;
	/** Gate a given op until released, to hold the machine in a step. */
	hold: { op: HandoffOpName; release: () => void; reached: Promise<void> } | null = null;
	#reached: (() => void) | null = null;

	online = (m: string): boolean => this.online_.has(m);
	linkId = (m: string): number | null => (this.online_.has(m) ? this.links[m]! : null);
	machineName = (m: string): string => (m === "m1" ? "desktop" : m === "m2" ? "laptop" : m);

	holdAt(op: HandoffOpName): () => void {
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		this.hold = { op, release: gate.resolve, reached: reached.promise };
		this.#reached = reached.resolve;
		this.#gate = gate.promise;
		return gate.resolve;
	}
	#gate: Promise<void> | null = null;

	async call<K extends HandoffOpName>(machine: string, op: K, args: HandoffOpArgs[K]): Promise<HandoffOpResult[K]> {
		if (!this.online(machine)) throw new HandoffCallError(`${this.machineName(machine)} is offline`, "link");
		this.calls.push({ machine, op, args });
		if (this.hold?.op === op) {
			this.#reached?.();
			await this.#gate;
		}
		if (
			this.failOn &&
			this.failOn.op === op &&
			(this.failOn.machine === undefined || this.failOn.machine === machine)
		) {
			throw new HandoffCallError(`injected failure at ${op}`, this.failOn.kind ?? "failed");
		}
		if (this.handler) {
			const custom = await this.handler(machine, op, args);
			if (custom !== undefined) return custom as HandoffOpResult[K];
		}
		return this.#default(machine, op, args) as HandoffOpResult[K];
	}

	#default(machine: string, op: HandoffOpName, args: unknown): unknown {
		const a = args as Record<string, unknown>;
		switch (op) {
			case "source.inspect":
				return {
					session: {
						id: SESSION,
						sessionId: SESSION,
						cwd: SOURCE_CWD,
						file: "/s/x.jsonl",
						hosted: true,
						access: "hosted",
						phase: "idle",
						title: "T",
					},
					sessionBlockers: this.sourceBlockers,
					project: { id: "root1", name: "proj", root: "/work/proj", worktree: "/work/proj" },
					repo: {
						head: "a".repeat(40),
						branch: "main",
						detached: false,
						stateIssue: null,
						recent: ["a".repeat(40)],
						shallow: false,
						preview: carried,
					},
					repoBlockers: [],
				};
			case "target.inspect":
				return {
					project: this.projectOnTarget ? { id: "root1", name: "proj", root: "/other/proj" } : null,
					worktrees: [
						{ path: "/other/proj", branch: "main", head: "a".repeat(40), eligible: true, isSource: false },
					],
					have: ["a".repeat(40)],
					shallow: false,
					newWorktree: { path: "/other/proj.omp-worktrees/abc", branch: "omp-web/abc" },
					gitVersion: "git version 2.56.0",
				};
			case "source.commit":
				return {
					commit: "c".repeat(40),
					indexCommit: "d".repeat(40),
					base: carried.base,
					carried,
					fresh: this.fresh,
				};
			case "source.capture":
				return { facts: FACTS, hosted: true };
			case "source.bundle":
				return {
					xfer: { id: "xfer-bundle-1", size: 2048, sha256: "0".repeat(64) } satisfies XferInfo,
					full: false,
					prerequisites: 1,
				};
			case "target.receive":
				return { xfer: `recv-${String(a.kind)}` };
			case "target.fetch":
				return { refs: ["refs/omp-web/handoff/x"] };
			case "target.workspace":
				return {
					worktree: "/other/proj.omp-worktrees/abc",
					branch: "omp-web/abc",
					created: true,
					applied: { written: 2, removed: 0 },
				};
			case "source.pack":
				return {
					xfer: { id: "xfer-session-1", size: 4096, sha256: "1".repeat(64) },
					file: "/s/x.jsonl",
					id: SESSION,
					cwd: SOURCE_CWD,
					stoppedHosted: true,
				};
			case "target.unpack":
				return { file: "/t/u.jsonl", id: SESSION, dropped: ["/Users/x/extra"] };
			case "target.fork":
				return {
					sessionId: "fork-session-id",
					file: "/t/fork.jsonl",
					facts: a.fresh === true ? null : this.targetFacts,
				};
			case "target.verify":
				return { alive: true };
			case "source.finish":
				return { marked: true };
			case "op.commit":
				return { cleaned: [], warnings: [] };
			case "op.rollback":
				return { removed: ["x"], leftovers: this.rollbackLeftovers[machine] ?? [] };
			default:
				throw new Error(`unhandled ${op}`);
		}
	}

	async transfer(
		_from: string,
		info: XferInfo,
		_to: string,
		_toXfer: string,
		options: { onProgress: (d: number, t: number) => void; aborted: () => boolean },
	): Promise<void> {
		this.transfers++;
		if (this.failTransfer) throw new HandoffCallError("link dropped during the transfer", "link");
		options.onProgress(info.size / 2, info.size);
		await Promise.resolve();
		if (options.aborted()) throw new HandoffCallError("the transfer was cancelled", "failed");
		options.onProgress(info.size, info.size);
	}

	count(op: HandoffOpName, machine?: string): number {
		return this.calls.filter(c => c.op === op && (machine === undefined || c.machine === machine)).length;
	}
}

interface Rig {
	store: GatewayStore;
	world: World;
	coordinator: HandoffCoordinator;
	published: HandoffWire[][];
	changed: string[][];
	threadId: string;
	now: { t: number };
	sessionsOf(machine: string): ReturnType<GatewayStore["sessions"]>;
}

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) {
		rig.coordinator.close();
		rig.store.close();
	}
});

function info(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: SESSION,
		sessionId: SESSION,
		access: "hosted",
		cwd: SOURCE_CWD,
		phase: "idle",
		createdAt: 1,
		modifiedAt: 2,
		files: 1,
		aliases: [],
		title: "T",
		...overrides,
	};
}

function makeRig(options: { confirmTimeoutMs?: number; world?: World } = {}): Rig {
	const store = GatewayStore.open(":memory:");
	const world = options.world ?? new World();
	for (const id of ["m1", "m2"]) {
		store.upsertMachine({
			id,
			name: world.machineName(id),
			platform: "darwin",
			daemonVersion: "t",
			omp: { version: "18.19.0", expectedVersion: "18.19.0", versionMismatch: false },
			leaseWarnings: [],
			lastSeen: 1,
		});
	}
	store.syncSessions("m1", [info()]);
	const threadId = store.threadOf("m1", SESSION)!;
	const published: HandoffWire[][] = [];
	const changed: string[][] = [];
	const now = { t: 1_000_000 };
	let n = 0;
	const coordinator = new HandoffCoordinator({
		store,
		transport: world,
		projects: m => store.projects(m),
		sessions: m => store.sessions(m),
		publish: list => published.push(list),
		sessionsChanged: m => changed.push(m),
		limits: LIMITS,
		confirmTimeoutMs: options.confirmTimeoutMs ?? 60_000,
		now: () => now.t,
		newId: () => `op${String(++n).padStart(8, "0")}`,
	});
	const rig: Rig = {
		store,
		world,
		coordinator,
		published,
		changed,
		threadId,
		now,
		sessionsOf: m => store.sessions(m),
	};
	rigs.push(rig);
	return rig;
}

async function settle(rig: Rig, id: string, phases: string[], ms = 3000): Promise<HandoffWire> {
	const deadline = Date.now() + ms;
	for (;;) {
		const wire = rig.store.handoff(id)!.wire;
		if (phases.includes(wire.phase)) return wire;
		if (Date.now() > deadline)
			throw new Error(`stuck in ${wire.phase}: ${JSON.stringify(wire.steps.map(s => `${s.id}:${s.status}`))}`);
		await Bun.sleep(5);
	}
}

const choice = { mode: "new" } as const;

describe("plan", () => {
	test("lists the matched project, the worktrees and the carried preview", async () => {
		const rig = makeRig();
		const plan = await rig.coordinator.plan("m1", SESSION, "m2");
		expect(plan.blockers).toEqual([]);
		expect(plan.target?.project).toEqual({ name: "proj", root: "/other/proj" });
		expect(plan.target?.newWorktree?.branch).toBe("omp-web/abc");
		expect(plan.repo?.preview.paths).toBe(2);
		expect(plan.sameMachine).toBe(false);
	});

	test("a project missing on the target is refused with the clone-first message and nothing is created", async () => {
		const rig = makeRig();
		rig.world.projectOnTarget = false;
		const plan = await rig.coordinator.plan("m1", SESSION, "m2");
		expect(plan.blockers.join(" ")).toMatch(
			/not registered on laptop.*Clone the repository there and register the project/s,
		);
		await expect(rig.coordinator.start("m1", SESSION, "m2", choice)).rejects.toThrow(/Clone the repository there/);
		expect(rig.store.activeHandoffs()).toEqual([]);
		expect(rig.world.count("source.commit")).toBe(0);
	});

	test("an offline target and a busy session are blockers", async () => {
		const rig = makeRig();
		rig.world.online_.delete("m2");
		expect((await rig.coordinator.plan("m1", SESSION, "m2")).blockers.join(" ")).toContain("laptop is offline");
		rig.world.online_.add("m2");
		rig.world.sourceBlockers = ["A run is in progress"];
		expect((await rig.coordinator.plan("m1", SESSION, "m2")).blockers).toContain("A run is in progress");
	});
});

describe("the happy path", () => {
	test("runs every step in order, waits for confirmation with the forecast, and confirm moves the thread", async () => {
		const rig = makeRig();
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		const wire = await settle(rig, id, ["awaiting_confirm"]);
		expect(wire.steps.map(s => [s.id, s.status])).toEqual([
			["preflight", "done"],
			["commit", "done"],
			["capture", "done"],
			["bundle", "done"],
			["worktree", "done"],
			["session", "done"],
			["fork", "done"],
			["forecast", "done"],
		]);
		expect(rig.world.calls.map(c => `${c.machine}:${c.op}`)).toEqual([
			"m1:source.inspect",
			"m2:target.inspect",
			"m1:source.commit",
			"m1:source.capture",
			"m1:source.bundle",
			"m2:target.receive",
			"m2:target.fetch",
			"m2:target.workspace",
			"m1:source.pack",
			"m2:target.receive",
			"m2:target.unpack",
			"m2:target.fork",
		]);
		expect(rig.world.transfers).toBe(2);
		expect(wire.forecast?.items.map(i => i.id)).toHaveLength(10);
		expect(wire.forecast?.summary).toBe("hit");
		expect(wire.carried?.paths).toBe(2);
		expect(wire.bundle).toEqual({ bytes: 2048, full: false, prerequisites: 1 });
		expect(wire.droppedDirectories).toEqual(["/Users/x/extra"]);
		expect(wire.expiresAt).toBe(rig.now.t + 60_000);
		// While waiting, the fork belongs to the thread and is marked as the pending target; the source is marked too.
		expect(rig.store.threadOf("m2", "fork-session-id")).toBe(rig.threadId);
		expect(rig.sessionsOf("m1")[0]!.handoff).toEqual({ id, role: "source" });
		// the source's subdirectory travels as a relative path
		expect(rig.world.calls.find(c => c.op === "target.fork")!.args).toMatchObject({
			subdir: "packages/web",
			historyEntries: 7,
		});

		await rig.coordinator.confirm(id);
		const done = rig.store.handoff(id)!.wire;
		expect(done.phase).toBe("completed");
		expect(done.result).toMatchObject({
			sessionId: "fork-session-id",
			worktree: "/other/proj.omp-worktrees/abc",
			sourceMarked: true,
		});
		const hops = rig.store.hopsOf(rig.threadId);
		expect(hops).toHaveLength(1);
		expect(hops[0]).toMatchObject({
			from: { machine: "m1", sessionId: SESSION },
			to: { machine: "m2", sessionId: "fork-session-id", branch: "omp-web/abc" },
			forecast: "hit",
		});
		const old = rig.sessionsOf("m1")[0]!;
		expect(old.movedTo).toMatchObject({ machine: "m2", machineName: "laptop", sessionId: "fork-session-id" });
		expect(old.handoff).toBeUndefined();
		expect(rig.world.count("source.finish", "m1")).toBe(1);
		expect(rig.world.count("op.commit")).toBe(2);
		expect(rig.world.count("op.rollback")).toBe(0);
		// the thread is free for another switch
		expect(rig.store.activeHandoffs()).toEqual([]);
	});

	test("a switch within one machine skips bundle and session and forks from the source's own file", async () => {
		const rig = makeRig();
		const { id } = await rig.coordinator.start("m1", SESSION, "m1", choice);
		const wire = await settle(rig, id, ["awaiting_confirm"]);
		expect(wire.steps.filter(s => s.status === "skipped").map(s => s.id)).toEqual(["bundle", "session"]);
		expect(rig.world.transfers).toBe(0);
		expect(rig.world.calls.map(c => c.op)).not.toContain("source.pack");
		expect(rig.world.calls.find(c => c.op === "target.inspect")!.args).toMatchObject({
			sourceWorktree: "/work/proj",
		});
		await rig.coordinator.confirm(id);
		expect(rig.store.handoff(id)!.wire.phase).toBe("completed");
	});

	test("a session with no conversation moves only the workspace and starts a new session on the target", async () => {
		const rig = makeRig();
		rig.world.fresh = true;
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		const wire = await settle(rig, id, ["awaiting_confirm"]);
		expect(wire.freshSession).toBe(true);
		expect(wire.steps.map(s => [s.id, s.status])).toEqual([
			["preflight", "done"],
			["commit", "done"],
			["capture", "skipped"],
			["bundle", "done"],
			["worktree", "done"],
			["session", "skipped"],
			["fork", "done"],
			["forecast", "skipped"],
		]);
		expect(rig.world.calls.map(c => `${c.machine}:${c.op}`)).toEqual([
			"m1:source.inspect",
			"m2:target.inspect",
			"m1:source.commit",
			"m1:source.bundle",
			"m2:target.receive",
			"m2:target.fetch",
			"m2:target.workspace",
			"m2:target.fork",
		]);
		expect(rig.world.calls.find(c => c.op === "target.fork")!.args).toMatchObject({ fresh: true });
		expect(wire.forecast).toBeUndefined();
		await rig.coordinator.confirm(id);
		const done = rig.store.handoff(id)!.wire;
		expect(done.phase).toBe("completed");
		expect(done.result?.sessionId).toBe("fork-session-id");
		expect(rig.world.count("source.finish", "m1")).toBe(1);
		expect(rig.store.hopsOf(rig.threadId)[0]).toMatchObject({ forecast: null });
	});

	test("only one switch per thread at a time", async () => {
		const rig = makeRig();
		const release = rig.world.holdAt("source.capture");
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		await rig.world.hold!.reached;
		await expect(rig.coordinator.start("m1", SESSION, "m2", choice)).rejects.toThrow(
			/already being switched|already running/,
		);
		release();
		await settle(rig, id, ["awaiting_confirm"]);
		await rig.coordinator.cancel(id);
		// after it ended the thread is free again
		const second = await rig.coordinator.start("m1", SESSION, "m2", choice);
		expect(second.id).not.toBe(id);
	});
});

describe("rollback", () => {
	test("cancelling at the forecast removes everything on both machines and leaves the thread where it was", async () => {
		const rig = makeRig();
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		await settle(rig, id, ["awaiting_confirm"]);
		await rig.coordinator.cancel(id);
		const wire = rig.store.handoff(id)!.wire;
		expect(wire.phase).toBe("rolled_back");
		expect(rig.world.count("op.rollback", "m1")).toBe(1);
		expect(rig.world.count("op.rollback", "m2")).toBe(1);
		expect(rig.world.count("source.finish")).toBe(0);
		expect(rig.store.hopsOf(rig.threadId)).toEqual([]);
		expect(rig.store.threadOf("m2", "fork-session-id")).toBeUndefined();
		expect(rig.sessionsOf("m1")[0]!.movedTo).toBeUndefined();
		expect(rig.sessionsOf("m1")[0]!.handoff).toBeUndefined();
	});

	const stepOps: { op: HandoffOpName; machine: string; touchesTarget: boolean }[] = [
		{ op: "source.commit", machine: "m1", touchesTarget: false },
		{ op: "source.capture", machine: "m1", touchesTarget: false },
		{ op: "source.bundle", machine: "m1", touchesTarget: false },
		{ op: "target.receive", machine: "m2", touchesTarget: true },
		{ op: "target.fetch", machine: "m2", touchesTarget: true },
		{ op: "target.workspace", machine: "m2", touchesTarget: true },
		{ op: "source.pack", machine: "m1", touchesTarget: true },
		{ op: "target.unpack", machine: "m2", touchesTarget: true },
		{ op: "target.fork", machine: "m2", touchesTarget: true },
	];
	for (const { op, machine, touchesTarget } of stepOps) {
		test(`a failure at ${op} rolls back the machines it touched and says why`, async () => {
			const rig = makeRig();
			rig.world.failOn = { op, machine };
			const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
			const wire = await settle(rig, id, ["failed", "rollback_failed", "rolled_back"]);
			expect(wire.phase).toBe("failed");
			expect(wire.error).toContain(`injected failure at ${op}`);
			expect(rig.world.count("op.rollback", "m1")).toBe(1);
			expect(rig.world.count("op.rollback", "m2")).toBe(touchesTarget ? 1 : 0);
			expect(wire.steps.some(s => s.status === "failed")).toBe(true);
			expect(rig.world.count("op.commit")).toBe(0);
			expect(rig.store.hopsOf(rig.threadId)).toEqual([]);
			expect(rig.store.threadOf("m2", "fork-session-id")).toBeUndefined();
			expect(rig.store.activeHandoffs()).toEqual([]);
		});
	}

	test("a failure during a transfer (link dropped) rolls back", async () => {
		const rig = makeRig();
		rig.world.failTransfer = true;
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		const wire = await settle(rig, id, ["failed", "rollback_failed"]);
		expect(wire.phase).toBe("failed");
		expect(wire.error).toContain("link dropped");
		expect(rig.world.count("op.rollback")).toBe(2);
	});

	test("a failure in the same-machine flow rolls back the single machine once", async () => {
		const rig = makeRig();
		rig.world.failOn = { op: "target.fork" };
		const { id } = await rig.coordinator.start("m1", SESSION, "m1", choice);
		const wire = await settle(rig, id, ["failed", "rollback_failed"]);
		expect(wire.phase).toBe("failed");
		expect(rig.world.count("op.rollback")).toBe(1);
	});

	test("a rollback the daemon could not finish ends as rollback_failed with the leftovers, keeps the thread locked and finishes when asked again", async () => {
		const rig = makeRig();
		rig.world.failOn = { op: "target.fork" };
		rig.world.rollbackLeftovers = { m2: ["could not remove /other/proj.omp-worktrees/abc: busy"] };
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		const wire = await settle(rig, id, ["rollback_failed", "failed"]);
		expect(wire.phase).toBe("rollback_failed");
		expect(wire.leftovers?.join(" ")).toContain("could not remove");
		await expect(rig.coordinator.start("m1", SESSION, "m2", choice)).rejects.toThrow();
		rig.world.rollbackLeftovers = {};
		await rig.coordinator.cancel(id);
		const after = rig.store.handoff(id)!.wire;
		expect(after.phase).toBe("failed");
		expect(after.leftovers).toBeUndefined();
	});

	test("a machine that is offline during the rollback is cleaned when it registers again", async () => {
		const rig = makeRig();
		const release = rig.world.holdAt("target.workspace");
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		await rig.world.hold!.reached;
		rig.world.online_.delete("m2");
		rig.coordinator.machineLost("m2");
		release();
		const wire = await settle(rig, id, ["rollback_failed"]);
		expect(wire.leftovers?.join(" ")).toContain("laptop is offline");
		expect(rig.world.count("op.rollback", "m1")).toBe(1);
		rig.world.online_.add("m2");
		rig.world.links.m2 = 2;
		rig.coordinator.machineBack("m2");
		const after = await settle(rig, id, ["failed"]);
		expect(after.leftovers).toBeUndefined();
		expect(rig.world.count("op.rollback", "m2")).toBe(1);
	});

	test("losing the target's link while waiting for confirmation rolls back at once", async () => {
		const rig = makeRig();
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		await settle(rig, id, ["awaiting_confirm"]);
		rig.world.online_.delete("m1");
		rig.coordinator.machineLost("m1");
		const wire = await settle(rig, id, ["rollback_failed", "failed"]);
		expect(wire.error).toContain("desktop went offline");
		expect(rig.world.count("op.rollback", "m2")).toBe(1);
	});

	test("confirming after a participant reconnected (its daemon restarted) rolls back instead", async () => {
		const rig = makeRig();
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		await settle(rig, id, ["awaiting_confirm"]);
		rig.world.links.m2 = 2;
		await expect(rig.coordinator.confirm(id)).rejects.toThrow(/rolled back/);
		expect(rig.store.handoff(id)!.wire.phase).toBe("failed");
		expect(rig.store.hopsOf(rig.threadId)).toEqual([]);
	});

	test("a forked session that died before confirmation rolls back", async () => {
		const rig = makeRig();
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		await settle(rig, id, ["awaiting_confirm"]);
		rig.world.handler = (_m, op) =>
			op === "target.verify" ? { alive: false, detail: "the forked session's process is gone" } : undefined;
		await expect(rig.coordinator.confirm(id)).rejects.toThrow(/process is gone/);
		expect(rig.store.handoff(id)!.wire.phase).toBe("failed");
		expect(rig.world.count("source.finish")).toBe(0);
	});

	test("an unconfirmed switch rolls itself back after the timeout", async () => {
		const rig = makeRig({ confirmTimeoutMs: 40 });
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		const wire = await settle(rig, id, ["failed"], 3000);
		expect(wire.error).toContain("not confirmed in time");
		expect(rig.world.count("op.rollback")).toBe(2);
	});

	test("cancelling while a step is running stops at the next checkpoint and rolls back", async () => {
		const rig = makeRig();
		const release = rig.world.holdAt("source.capture");
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		await rig.world.hold!.reached;
		await rig.coordinator.cancel(id);
		expect(rig.store.handoff(id)!.wire.phase).toBe("rolling_back");
		release();
		const wire = await settle(rig, id, ["rolled_back"]);
		expect(wire.phase).toBe("rolled_back");
		expect(rig.world.count("source.bundle")).toBe(0);
		expect(rig.world.count("op.rollback", "m1")).toBe(1);
	});
});

describe("after the commit point", () => {
	test("a source that is offline at confirm still moves the thread; the cleanup runs when it returns", async () => {
		const rig = makeRig();
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		await settle(rig, id, ["awaiting_confirm"]);
		rig.world.failOn = { op: "source.finish", machine: "m1" };
		await rig.coordinator.confirm(id);
		let wire = rig.store.handoff(id)!.wire;
		expect(wire.phase).toBe("completed");
		expect(wire.result?.sourceMarked).toBe(false);
		expect(wire.result?.warning).toContain("desktop");
		expect(rig.store.hopsOf(rig.threadId)).toHaveLength(1);
		rig.world.failOn = null;
		rig.coordinator.machineBack("m1");
		for (let i = 0; i < 400 && !rig.store.handoff(id)!.wire.result?.sourceMarked; i++) await Bun.sleep(5);
		wire = rig.store.handoff(id)!.wire;
		expect(wire.result?.sourceMarked).toBe(true);
		expect(wire.result?.warning).toBeUndefined();
	});
});

describe("crash recovery", () => {
	test("a switch that was running when the gateway stopped rolls back once its machines register", async () => {
		const rig = makeRig();
		rig.world.holdAt("target.workspace");
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		await rig.world.hold!.reached;
		// The "gateway" dies here (its step never returns): a new coordinator over the same database finds the operation.
		rig.coordinator.close();
		const world = new World();
		world.online_.clear();
		const revived = new HandoffCoordinator({
			store: rig.store,
			transport: world,
			projects: m => rig.store.projects(m),
			sessions: m => rig.store.sessions(m),
			publish: () => {},
			sessionsChanged: () => {},
			limits: LIMITS,
			confirmTimeoutMs: 60_000,
			now: () => rig.now.t,
		});
		revived.recover();
		const stuck = rig.store.handoff(id)!.wire;
		expect(stuck.phase).toBe("rollback_failed");
		expect(rig.store.activeHandoffs()).toHaveLength(1); // still locks the thread
		world.online_.add("m1");
		world.online_.add("m2");
		revived.machineBack("m1");
		revived.machineBack("m2");
		const wire = await settle(rig, id, ["failed"]);
		expect(wire.error).toContain("gateway restarted");
		expect(world.count("op.rollback", "m1")).toBe(1);
		expect(world.count("op.rollback", "m2")).toBeGreaterThanOrEqual(1);
		revived.close();
	});

	test("a switch waiting for confirmation when the gateway stopped is rolled back, not resumed", async () => {
		const rig = makeRig();
		const { id } = await rig.coordinator.start("m1", SESSION, "m2", choice);
		await settle(rig, id, ["awaiting_confirm"]);
		rig.coordinator.close();
		const world = new World();
		const revived = new HandoffCoordinator({
			store: rig.store,
			transport: world,
			projects: m => rig.store.projects(m),
			sessions: m => rig.store.sessions(m),
			publish: () => {},
			sessionsChanged: () => {},
			limits: LIMITS,
			confirmTimeoutMs: 60_000,
			now: () => rig.now.t,
		});
		revived.recover();
		const wire = await settle(rig, id, ["failed"]);
		expect(wire.phase).toBe("failed");
		expect(rig.store.hopsOf(rig.threadId)).toEqual([]);
		revived.close();
	});
});

describe("subdirOf", () => {
	test("is the session's directory relative to its worktree, for either platform's paths", () => {
		expect(subdirOf("/work/proj", "/work/proj")).toBe("");
		expect(subdirOf("/work/proj", "/work/proj/packages/web")).toBe("packages/web");
		expect(subdirOf("/work/proj", "/work/proj-other/x")).toBe("");
		expect(subdirOf("C:\\Users\\a\\proj", "c:\\users\\a\\proj\\src\\app")).toBe("src/app");
	});
});
