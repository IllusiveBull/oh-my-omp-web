/**
 * The gateway's state machine for switching a thread to another environment. One operation ("handoff") per move,
 * persisted in SQLite after every step, driven by `op` calls to the two environment daemons and a byte pump between them.
 *
 *   preflight → commit → capture → bundle → worktree → session → fork → forecast → awaiting_confirm
 *                                                                                  ↓ confirm        ↓ cancel / error / timeout
 *                                                                              confirming → completed   rolling_back → rolled_back | failed | rollback_failed
 *
 * Invariants:
 * - The thread only moves at one point: the SQLite transaction in `#confirm` (hop recorded, operation `completed`). Before it
 *   every failure ends in a rollback on both machines; after it only best-effort cleanups remain (retried when a machine returns).
 * - What each daemon created is recorded on that daemon first (`HandoffService`), and `op.rollback` removes exactly that, so a
 *   rollback works after a crash of either side. The gateway only has to remember which machines it touched.
 * - A restart of the gateway, or the loss of a participating machine's link, before the commit point rolls the operation back
 *   (retried when the machine returns): no half-moved thread, and no operation waits for a user who is not there (`confirmTimeoutMs`).
 */
import {
	HANDOFF_ACTIVE_PHASES,
	HANDOFF_STEP_IDS,
	forecastCache,
	type CacheForecast,
	type CarriedSummary,
	type GatewaySessionInfo,
	type HandoffLimits,
	type HandoffOpArgs,
	type HandoffOpName,
	type HandoffOpResult,
	type HandoffPhase,
	type HandoffPlan,
	type HandoffStep,
	type HandoffStepId,
	type HandoffWire,
	type ProjectInfo,
	type SessionFacts,
	type SourceInspect,
	type TargetChoice,
	type TargetInspect,
	type XferInfo,
} from "@omp-web/protocol";
import { HandoffConflictError, type GatewayStore } from "./db";
import { randomToken } from "./secrets";

/** What the coordinator needs from the gateway's links; the gateway implements it, tests fake it. */
export interface HandoffTransport {
	online(machine: string): boolean;
	/** The registration counter of the machine's live link, null while it is offline. */
	linkId(machine: string): number | null;
	machineName(machine: string): string;
	call<K extends HandoffOpName>(
		machine: string,
		op: K,
		args: HandoffOpArgs[K],
		timeoutMs?: number,
	): Promise<HandoffOpResult[K]>;
	/** Moves a file the source offers into a transfer the target is receiving. Rejects with a {@link HandoffCallError}. */
	transfer(
		from: string,
		info: XferInfo,
		to: string,
		toXfer: string,
		options: { onProgress: (done: number, total: number) => void; aborted: () => boolean },
	): Promise<void>;
}

export interface HandoffCoordinatorOptions {
	store: GatewayStore;
	transport: HandoffTransport;
	/** The projects of a machine as the gateway last heard them (the cache, which also serves offline machines). */
	projects: (machine: string) => ProjectInfo[];
	/** The machine's session list as the gateway serves it (thread ids, hops, markers). */
	sessions: (machine: string) => GatewaySessionInfo[];
	/** Every operation clients should see, replaced wholesale. */
	publish: (handoffs: HandoffWire[]) => void;
	/** The session lists of these machines changed (hop recorded, markers set or cleared). */
	sessionsChanged: (machines: string[]) => void;
	limits: HandoffLimits;
	/** An operation waiting for confirmation is rolled back after this long. */
	confirmTimeoutMs: number;
	/** The broker's accounts as pin hashes, for a target whose omp uses the gateway's broker; null when unreadable. */
	brokerAccounts?: () => Promise<SessionFacts["accounts"] | null>;
	now?: () => number;
	newId?: () => string;
	/** Finished operations stay listed this long unless dismissed. */
	finishedVisibleMs?: number;
}

export const DEFAULT_HANDOFF_LIMITS: HandoffLimits = {
	maxFileBytes: 10 * 1024 * 1024,
	maxTotalBytes: 128 * 1024 * 1024,
	maxBundleBytes: 256 * 1024 * 1024,
	maxArchiveBytes: 512 * 1024 * 1024,
};

const STEP_LABELS: Record<HandoffStepId, string> = {
	preflight: "Check the session and the target",
	commit: "Handoff commit of the working tree",
	capture: "Record the source's cache state",
	bundle: "Transfer the commits (bundle)",
	worktree: "Create the worktree and apply the changes",
	session: "Transfer the session",
	fork: "Start the forked session",
	forecast: "Forecast the cache",
};

/** Everything only the orchestrator needs; stored next to the public state. */
interface HandoffPrivate {
	threadId: string;
	sourceMachine: string;
	targetMachine: string;
	sameMachine: boolean;
	limits: HandoffLimits;
	/** Session working directory relative to its worktree on the source ("" = the root). */
	subdir: string;
	target: { projectId: string; projectRoot: string };
	sourceLink: number | null;
	targetLink: number | null;
	have: string[];
	/** The machines that may hold something of this operation (rollback goes there). */
	involved: { source: boolean; target: boolean };
	commit?: HandoffOpResult["source.commit"];
	sourceFacts?: SessionFacts;
	forkSessionId?: string;
	/** Machines whose rollback did not finish (retried when they are back). */
	pendingRollback: string[];
	/** After the commit point: cleanups still owed. */
	pendingCleanup: ("source.finish" | "source.commit" | "target.commit")[];
	byUser: boolean;
}

class Cancelled extends Error {}

interface Op {
	wire: HandoffWire;
	priv: HandoffPrivate;
	/** The runner (steps) is executing: external triggers only set `stop`, the runner rolls back at its next checkpoint. */
	runner: Promise<void> | null;
	stop: { byUser: boolean; reason: string } | null;
	undoing: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	lastPublish: number;
}

/** Result of looking at a source session and a target machine without creating anything. */
interface Evaluation {
	plan: HandoffPlan;
	threadId: string;
	source: SourceInspect | null;
	target: TargetInspect | null;
}

/** `812 B`, `15.0 KiB`, `4.2 MiB`: what the step list shows next to a transfer. */
const size = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MiB`;
};

/** The session's directory relative to its worktree, `/`-separated (works for either platform's paths). */
export function subdirOf(worktree: string, cwd: string): string {
	const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
	const [root, dir] = [norm(worktree), norm(cwd)];
	const fold = /^[A-Za-z]:/.test(root);
	const [r, d] = fold ? [root.toLowerCase(), dir.toLowerCase()] : [root, dir];
	if (d === r || !d.startsWith(`${r}/`)) return "";
	return dir.slice(root.length + 1);
}

export class HandoffCoordinator {
	readonly #ops = new Map<string, Op>();
	readonly #store: GatewayStore;
	readonly #now: () => number;
	readonly #newId: () => string;
	#closed = false;

	constructor(private readonly options: HandoffCoordinatorOptions) {
		this.#store = options.store;
		this.#now = options.now ?? Date.now;
		this.#newId = options.newId ?? (() => randomToken(9));
	}

	/** What clients see. */
	list(): HandoffWire[] {
		return this.#store.visibleHandoffs(this.#now() - (this.options.finishedVisibleMs ?? 24 * 60 * 60 * 1000));
	}

	close(): void {
		this.#closed = true;
		for (const op of this.#ops.values()) clearTimeout(op.timer ?? undefined);
	}

	// -- planning ----------------------------------------------------------------

	async plan(machine: string, sessionId: string, targetMachine: string): Promise<HandoffPlan> {
		return (await this.#evaluate(machine, sessionId, targetMachine)).plan;
	}

	async #evaluate(machine: string, sessionId: string, targetMachine: string): Promise<Evaluation> {
		const { transport, limits } = this.options;
		const entry = this.options
			.sessions(machine)
			.find(s => s.id === sessionId || s.sessionId === sessionId || s.aliases.includes(sessionId));
		const blockers: string[] = [];
		const sameMachine = machine === targetMachine;
		const targetName = transport.machineName(targetMachine);
		const plan: HandoffPlan = {
			source: {
				machine,
				machineName: transport.machineName(machine),
				sessionId,
				threadId: entry?.threadId ?? "",
				title: entry?.title,
				cwd: entry?.cwd ?? "",
				hosted: entry?.access === "hosted",
			},
			repo: null,
			sameMachine,
			target: null,
			blockers,
		};
		if (!entry) {
			blockers.push("Unknown session.");
			return { plan, threadId: "", source: null, target: null };
		}
		if (entry.movedTo) {
			blockers.push(
				`This session already moved to ${entry.movedTo.machineName}; switch the thread from its current session.`,
			);
		}
		if (entry.handoff) blockers.push("An environment switch is already running for this thread.");
		if (!transport.online(machine)) blockers.push(`${plan.source.machineName} is offline.`);
		const targetKnown =
			this.options.projects(targetMachine) !== undefined && transport.machineName(targetMachine) !== "";
		if (!transport.online(targetMachine)) blockers.push(`${targetName} is offline.`);
		if (blockers.length > 0 && (!transport.online(machine) || !transport.online(targetMachine))) {
			plan.target = targetKnown
				? {
						machine: targetMachine,
						machineName: targetName,
						online: transport.online(targetMachine),
						project: null,
						worktrees: [],
						newWorktree: null,
					}
				: null;
			return { plan, threadId: entry.threadId, source: null, target: null };
		}
		let source: SourceInspect | null = null;
		try {
			source = await transport.call(machine, "source.inspect", { sessionId, limits });
		} catch (error) {
			blockers.push(error instanceof Error ? error.message : String(error));
			return { plan, threadId: entry.threadId, source: null, target: null };
		}
		blockers.push(...source.sessionBlockers, ...source.repoBlockers);
		plan.source.cwd = source.session.cwd;
		plan.source.hosted = source.session.hosted;
		if (source.project && source.repo) {
			plan.repo = {
				project: {
					id: source.project.id,
					name: source.project.name,
					root: source.project.root,
					worktree: source.project.worktree,
				},
				head: source.repo.head,
				branch: source.repo.branch,
				detached: source.repo.detached,
				preview: source.repo.preview,
			};
		}
		let target: TargetInspect | null = null;
		plan.target = {
			machine: targetMachine,
			machineName: targetName,
			online: true,
			project: null,
			worktrees: [],
			newWorktree: null,
		};
		if (source.project && source.repo) {
			try {
				target = await transport.call(targetMachine, "target.inspect", {
					projectId: source.project.id,
					sourceHead: source.repo.head,
					recent: source.repo.recent,
					sourceWorktree: sameMachine ? source.project.worktree : undefined,
					threadId: entry.threadId,
				});
				plan.target.project = target.project && { name: target.project.name, root: target.project.root };
				plan.target.worktrees = target.worktrees;
				plan.target.newWorktree = target.newWorktree;
				if (!target.project) {
					blockers.push(
						`The project "${source.project.name}" is not registered on ${targetName}. Clone the repository there and register the project (Add project), then switch again. omp-web does not clone for you.`,
					);
				} else if (!target.newWorktree && target.worktrees.every(w => !w.eligible)) {
					blockers.push(`No worktree can be created or reused on ${targetName}.`);
				}
			} catch (error) {
				blockers.push(error instanceof Error ? error.message : String(error));
			}
		}
		return { plan, threadId: entry.threadId, source, target };
	}

	// -- starting ------------------------------------------------------------------

	async start(
		machine: string,
		sessionId: string,
		targetMachine: string,
		choice: TargetChoice,
	): Promise<{ id: string }> {
		const evaluation = await this.#evaluate(machine, sessionId, targetMachine);
		const { plan, source, target } = evaluation;
		if (choice.mode === "existing" && target) {
			const picked = target.worktrees.find(w => w.path === choice.worktree);
			if (!picked) plan.blockers.push("That worktree does not exist on the target.");
			else if (!picked.eligible) plan.blockers.push(picked.reason ?? "That worktree cannot be used.");
		} else if (choice.mode === "new" && target && !target.newWorktree) {
			plan.blockers.push("A new worktree cannot be created on the target.");
		}
		if (plan.blockers.length > 0 || !source || !target || !source.project || !source.repo || !target.project) {
			throw new Error(plan.blockers.join("\n") || "The switch cannot start.");
		}
		const { transport, limits } = this.options;
		const now = this.#now();
		const sameMachine = machine === targetMachine;
		const id = this.#newId();
		const steps: HandoffStep[] = HANDOFF_STEP_IDS.map(stepId => ({
			id: stepId,
			label: STEP_LABELS[stepId],
			status: sameMachine && (stepId === "bundle" || stepId === "session") ? "skipped" : "pending",
			...(sameMachine && (stepId === "bundle" || stepId === "session")
				? { detail: "same machine: nothing to transfer" }
				: {}),
		}));
		const wire: HandoffWire = {
			id,
			threadId: evaluation.threadId,
			source: {
				machine,
				machineName: transport.machineName(machine),
				sessionId: source.session.id,
				title: source.session.title,
				cwd: source.session.cwd,
				worktree: source.project.worktree,
				projectId: source.project.id,
				projectName: source.project.name,
			},
			target: {
				machine: targetMachine,
				machineName: transport.machineName(targetMachine),
				choice,
				...(choice.mode === "existing" ? { worktree: choice.worktree } : {}),
			},
			phase: "running",
			steps,
			createdAt: now,
			updatedAt: now,
		};
		const priv: HandoffPrivate = {
			threadId: evaluation.threadId,
			sourceMachine: machine,
			targetMachine,
			sameMachine,
			limits,
			subdir: subdirOf(source.project.worktree, source.session.cwd),
			target: { projectId: target.project.id, projectRoot: target.project.root },
			sourceLink: transport.linkId(machine),
			targetLink: transport.linkId(targetMachine),
			have: target.have,
			involved: { source: false, target: false },
			pendingRollback: [],
			pendingCleanup: [],
			byUser: false,
		};
		try {
			this.#store.createHandoff({ id, threadId: evaluation.threadId, wire, priv });
		} catch (error) {
			if (error instanceof HandoffConflictError) throw new Error(error.message);
			throw error;
		}
		const op: Op = { wire, priv, runner: null, stop: null, undoing: false, timer: null, lastPublish: 0 };
		this.#ops.set(id, op);
		this.#step(op, "preflight", {
			status: "done",
			detail: `${source.project.name} matches on ${wire.target.machineName}`,
		});
		this.#changed(op, true);
		op.runner = this.#run(op, source, target).finally(() => {
			op.runner = null;
		});
		return { id };
	}

	// -- running ---------------------------------------------------------------------

	async #run(op: Op, source: SourceInspect, target: TargetInspect): Promise<void> {
		const { wire, priv } = op;
		const sameMachine = priv.sameMachine;
		const common = { opId: wire.id, threadId: priv.threadId };
		try {
			// 2. handoff commit on the source
			priv.involved.source = true;
			const commit = await this.#stepRun(op, "commit", () =>
				this.#call(op, priv.sourceMachine, "source.commit", {
					...common,
					sessionId: wire.source.sessionId,
					limits: priv.limits,
				}),
			);
			priv.commit = commit;
			wire.carried = commit.carried;
			this.#step(op, "commit", { detail: carriedLine(commit.carried) });
			if (commit.fresh) {
				// No conversation yet: only the workspace moves, the target starts a new session.
				wire.freshSession = true;
				const detail = "new session: no conversation to carry";
				for (const id of ["capture", "session", "forecast"] as const)
					this.#step(op, id, { status: "skipped", detail });
			}
			this.#changed(op, true);

			// 3. the source's cache facts, before anything stops the source
			let captured: HandoffOpResult["source.capture"] | null = null;
			if (!commit.fresh) {
				captured = await this.#stepRun(op, "capture", () =>
					this.#call(op, priv.sourceMachine, "source.capture", {
						opId: wire.id,
						sessionId: wire.source.sessionId,
					}),
				);
				priv.sourceFacts = captured.facts;
				this.#step(op, "capture", {
					detail: `${captured.facts.origin === "live" ? "live session" : "probed"}: ${captured.facts.history.entries} entries`,
				});
			}

			// 4. bundle
			if (!sameMachine) {
				await this.#stepRun(op, "bundle", async () => {
					const bundle = await this.#call(
						op,
						priv.sourceMachine,
						"source.bundle",
						{ ...common, have: priv.have, limits: priv.limits },
						15 * 60_000,
					);
					priv.involved.target = true;
					const recv = await this.#call(op, priv.targetMachine, "target.receive", {
						opId: wire.id,
						threadId: priv.threadId,
						kind: "bundle",
						size: bundle.xfer.size,
						sha256: bundle.xfer.sha256,
					});
					await this.#transfer(op, "bundle", bundle.xfer, recv.xfer);
					await this.#call(
						op,
						priv.targetMachine,
						"target.fetch",
						{ ...common, xfer: recv.xfer, projectRoot: priv.target.projectRoot },
						15 * 60_000,
					);
					wire.bundle = { bytes: bundle.xfer.size, full: bundle.full, prerequisites: bundle.prerequisites };
					this.#step(op, "bundle", {
						detail: `${size(bundle.xfer.size)}, ${bundle.full ? "full history" : `thin, ${bundle.prerequisites} prerequisite${bundle.prerequisites === 1 ? "" : "s"}`}`,
					});
				});
			}

			// 5. worktree + working tree
			priv.involved.target = true;
			const workspace = await this.#stepRun(op, "worktree", () =>
				this.#call(
					op,
					priv.targetMachine,
					"target.workspace",
					{
						...common,
						projectId: priv.target.projectId,
						projectRoot: priv.target.projectRoot,
						choice: wire.target.choice,
						base: commit.base,
						commit: commit.commit,
						indexCommit: commit.indexCommit,
					},
					10 * 60_000,
				),
			);
			wire.target.worktree = workspace.worktree;
			wire.target.branch = workspace.branch;
			this.#step(op, "worktree", {
				detail: `${workspace.created ? "created" : "reused"} ${workspace.worktree}${workspace.branch ? ` on ${workspace.branch}` : ""} (${workspace.applied.written} written, ${workspace.applied.removed} removed)`,
			});
			this.#changed(op, true);

			// 6. session archive
			if (!sameMachine && !commit.fresh) {
				await this.#stepRun(op, "session", async () => {
					const packed = await this.#call(
						op,
						priv.sourceMachine,
						"source.pack",
						{ opId: wire.id, sessionId: wire.source.sessionId, limits: priv.limits },
						15 * 60_000,
					);
					const recv = await this.#call(op, priv.targetMachine, "target.receive", {
						opId: wire.id,
						threadId: priv.threadId,
						kind: "session",
						size: packed.xfer.size,
						sha256: packed.xfer.sha256,
					});
					await this.#transfer(op, "session", packed.xfer, recv.xfer);
					const unpacked = await this.#call(
						op,
						priv.targetMachine,
						"target.unpack",
						{
							opId: wire.id,
							xfer: recv.xfer,
							cwd: workspace.worktree,
							subdir: priv.subdir,
							clearAdditionalDirectories: true,
						},
						5 * 60_000,
					);
					wire.archiveBytes = packed.xfer.size;
					if (unpacked.dropped.length > 0) wire.droppedDirectories = unpacked.dropped;
					this.#step(op, "session", {
						detail: `${size(packed.xfer.size)}${packed.stoppedHosted ? "; the source's omp process was stopped for it" : ""}`,
					});
				});
			}

			// 7. the forked session (a new one when there was nothing to fork)
			const fork = await this.#stepRun(op, "fork", () =>
				this.#call(
					op,
					priv.targetMachine,
					"target.fork",
					{
						opId: wire.id,
						cwd: workspace.worktree,
						subdir: priv.subdir,
						historyEntries: captured?.facts.history.entries ?? 0,
						fresh: commit.fresh,
					},
					5 * 60_000,
				),
			);
			priv.forkSessionId = fork.sessionId;
			wire.target.sessionId = fork.sessionId;
			// The fork joins the thread before its machine lists it, so it never gets a thread of its own.
			this.#store.mapSession(priv.targetMachine, fork.sessionId, priv.threadId);
			this.#step(op, "fork", {
				detail: `${commit.fresh ? "new " : ""}session ${fork.sessionId.slice(0, 8)} in ${workspace.worktree}`,
			});
			this.#changed(op, true);
			this.options.sessionsChanged([priv.targetMachine]);

			// 8. the forecast (nothing to compare for a fresh session)
			if (captured && fork.facts) {
				const sourceFacts = captured.facts;
				let targetFacts = fork.facts;
				const forecast = await this.#stepRun(op, "forecast", async () => {
					if (targetFacts.accounts.via === "broker" && this.options.brokerAccounts) {
						const accounts = await this.options.brokerAccounts().catch(() => null);
						if (accounts) targetFacts = { ...targetFacts, accounts };
					}
					return forecastCache(sourceFacts, targetFacts, { now: this.#now(), sameMachine });
				});
				wire.forecast = forecast;
				this.#step(op, "forecast", { detail: forecast.headline });
			}
			this.#checkStop(op);
			this.#awaitConfirm(op);
			void source;
			void target;
		} catch (error) {
			const stop = op.stop;
			if (error instanceof Cancelled || stop) {
				await this.#undo(op, stop?.byUser ?? true, stop?.byUser === false ? stop.reason : undefined);
			} else {
				await this.#undo(op, false, error instanceof Error ? error.message : String(error));
			}
		}
	}

	/** Runs one step: marks it running, awaits `fn`, marks it done (the step may refine `detail` itself), checks for a stop request. */
	async #stepRun<T>(op: Op, id: HandoffStepId, fn: () => Promise<T>): Promise<T> {
		this.#checkStop(op);
		this.#step(op, id, { status: "running", bytes: undefined });
		this.#changed(op, true);
		let result: T;
		try {
			result = await fn();
		} catch (error) {
			this.#step(op, id, { status: "failed", detail: error instanceof Error ? error.message : String(error) });
			this.#changed(op, true);
			throw error;
		}
		this.#step(op, id, { status: "done", bytes: undefined });
		this.#changed(op, true);
		this.#checkStop(op);
		return result;
	}

	#step(op: Op, id: HandoffStepId, patch: Partial<HandoffStep>): void {
		const step = op.wire.steps.find(s => s.id === id)!;
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete (step as unknown as Record<string, unknown>)[key];
			else (step as unknown as Record<string, unknown>)[key] = value;
		}
	}

	#checkStop(op: Op): void {
		if (op.stop) throw new Cancelled(op.stop.reason);
	}

	async #call<K extends HandoffOpName>(
		op: Op,
		machine: string,
		name: K,
		args: HandoffOpArgs[K],
		timeoutMs?: number,
	): Promise<HandoffOpResult[K]> {
		this.#checkStop(op);
		return this.options.transport.call(machine, name, args, timeoutMs);
	}

	async #transfer(op: Op, step: "bundle" | "session", info: XferInfo, toXfer: string): Promise<void> {
		this.#step(op, step, { bytes: { done: 0, total: info.size } });
		this.#changed(op, true);
		await this.options.transport.transfer(op.priv.sourceMachine, info, op.priv.targetMachine, toXfer, {
			onProgress: (done, total) => {
				this.#step(op, step, { bytes: { done, total } });
				this.#changed(op, false);
			},
			aborted: () => op.stop !== null,
		});
		this.#checkStop(op);
	}

	#awaiting(op: Op): boolean {
		return op.wire.phase === "awaiting_confirm";
	}

	#awaitConfirm(op: Op): void {
		op.wire.phase = "awaiting_confirm";
		op.wire.expiresAt = this.#now() + this.options.confirmTimeoutMs;
		this.#armTimer(op);
		this.#changed(op, true);
	}

	#armTimer(op: Op): void {
		clearTimeout(op.timer ?? undefined);
		const wait = Math.max(0, (op.wire.expiresAt ?? this.#now()) - this.#now());
		op.timer = setTimeout(() => {
			if (this.#closed || !this.#awaiting(op)) return;
			void this.#undo(op, false, "The switch was not confirmed in time, so it was rolled back.");
		}, wait);
	}

	// -- user actions ------------------------------------------------------------------

	async confirm(id: string): Promise<void> {
		const op = this.#need(id);
		if (op.wire.phase !== "awaiting_confirm") throw new Error("This switch is not waiting for confirmation.");
		const { transport } = this.options;
		const { wire, priv } = op;
		clearTimeout(op.timer ?? undefined);
		op.timer = null;
		wire.phase = "confirming";
		this.#changed(op, true);
		try {
			for (const [machine, link] of [
				[priv.sourceMachine, priv.sourceLink],
				[priv.targetMachine, priv.targetLink],
			] as const) {
				if (!transport.online(machine) || transport.linkId(machine) !== link) {
					throw new Error(`${transport.machineName(machine)} was disconnected during the switch.`);
				}
			}
			const alive = await transport.call(priv.targetMachine, "target.verify", {
				opId: wire.id,
				sessionId: priv.forkSessionId!,
			});
			if (!alive.alive) throw new Error(alive.detail ?? "The forked session is gone.");
		} catch (error) {
			await this.#undo(op, false, error instanceof Error ? error.message : String(error));
			throw new Error(`The switch could not be confirmed and was rolled back: ${wire.error ?? "unknown error"}`);
		}
		// The commit point: from here the thread lives in the target environment.
		const at = this.#now();
		wire.result = {
			sessionId: priv.forkSessionId!,
			worktree: wire.target.worktree!,
			branch: wire.target.branch ?? null,
			sourceMarked: false,
		};
		wire.phase = "completed";
		wire.expiresAt = undefined;
		wire.updatedAt = at;
		priv.pendingCleanup = ["source.finish", "source.commit", "target.commit"];
		this.#store.commitHandoff(
			{
				id: `hop_${wire.id}`,
				threadId: priv.threadId,
				handoffId: wire.id,
				at,
				from: {
					machine: priv.sourceMachine,
					machineName: transport.machineName(priv.sourceMachine),
					sessionId: wire.source.sessionId,
					cwd: wire.source.cwd,
				},
				to: {
					machine: priv.targetMachine,
					machineName: transport.machineName(priv.targetMachine),
					sessionId: priv.forkSessionId!,
					cwd: wire.target.worktree!,
					branch: wire.target.branch ?? null,
				},
				forecast: wire.forecast?.summary ?? null,
			},
			wire,
			priv,
		);
		this.#publish();
		this.options.sessionsChanged([priv.sourceMachine, priv.targetMachine]);
		await this.#finishCleanup(op);
	}

	/** Cleanups owed after the commit point; each one that cannot be done now is retried when its machine returns. */
	async #finishCleanup(op: Op): Promise<void> {
		const { wire, priv } = op;
		const { transport } = this.options;
		const warnings: string[] = [];
		const attempt = async (
			key: HandoffPrivate["pendingCleanup"][number],
			machine: string,
			run: () => Promise<void>,
		): Promise<void> => {
			if (!priv.pendingCleanup.includes(key)) return;
			if (!transport.online(machine)) {
				warnings.push(`${transport.machineName(machine)} is offline: its cleanup will run when it returns.`);
				return;
			}
			try {
				await run();
				priv.pendingCleanup = priv.pendingCleanup.filter(k => k !== key);
			} catch (error) {
				warnings.push(
					`${transport.machineName(machine)}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		};
		await attempt("source.finish", priv.sourceMachine, async () => {
			const label = `${transport.machineName(priv.targetMachine)}:${wire.target.worktree ?? ""}`;
			const finished = await transport.call(priv.sourceMachine, "source.finish", {
				opId: wire.id,
				sessionId: wire.source.sessionId,
				label,
			});
			if (wire.result) {
				wire.result.sourceMarked = finished.marked;
				if (finished.warning) warnings.push(finished.warning);
			}
		});
		await attempt("source.commit", priv.sourceMachine, async () => {
			await transport.call(priv.sourceMachine, "op.commit", { opId: wire.id, role: "source" });
		});
		await attempt("target.commit", priv.targetMachine, async () => {
			await transport.call(priv.targetMachine, "op.commit", { opId: wire.id, role: "target" });
		});
		if (wire.result) wire.result.warning = warnings.length > 0 ? warnings.join(" ") : undefined;
		wire.updatedAt = this.#now();
		this.#store.saveHandoff(wire.id, wire, priv);
		this.#publish();
		this.options.sessionsChanged([priv.sourceMachine, priv.targetMachine]);
	}

	async cancel(id: string): Promise<void> {
		const op = this.#need(id);
		const { phase } = op.wire;
		if (phase === "awaiting_confirm") {
			await this.#undo(op, true);
			return;
		}
		if (phase === "running") {
			op.stop ??= { byUser: true, reason: "Cancelled." };
			op.wire.phase = "rolling_back";
			op.priv.byUser = true;
			this.#changed(op, true);
			return;
		}
		if (phase === "rolling_back" || phase === "rollback_failed") {
			if (op.runner === null) await this.#undo(op, op.priv.byUser, op.wire.error);
			return;
		}
		throw new Error("This switch already finished.");
	}

	dismiss(id: string): void {
		const op = this.#need(id);
		if (HANDOFF_ACTIVE_PHASES.includes(op.wire.phase)) throw new Error("This switch is still active.");
		this.#store.dismissHandoff(id);
		this.#ops.delete(id);
		this.#publish();
	}

	// -- rollback ------------------------------------------------------------------------

	/**
	 * Removes what the operation created on every machine it touched and ends it as `rolled_back` (the user cancelled) or
	 * `failed` (something broke), or as `rollback_failed` when a machine could not finish; that one is retried by `machineBack`.
	 */
	async #undo(op: Op, byUser: boolean, error?: string): Promise<void> {
		if (op.undoing) return;
		op.undoing = true;
		clearTimeout(op.timer ?? undefined);
		op.timer = null;
		const { wire, priv } = op;
		const { transport } = this.options;
		priv.byUser = byUser;
		if (error && !byUser) wire.error = error;
		wire.phase = "rolling_back";
		wire.expiresAt = undefined;
		this.#changed(op, true);
		const leftovers: string[] = [];
		priv.pendingRollback = [];
		const machines = [
			...new Set([
				...(priv.involved.target ? [priv.targetMachine] : []),
				...(priv.involved.source ? [priv.sourceMachine] : []),
			]),
		];
		for (const machine of machines) {
			const name = transport.machineName(machine);
			if (!transport.online(machine)) {
				leftovers.push(
					`${name} is offline: what the switch created there is removed automatically when it returns.`,
				);
				priv.pendingRollback.push(machine);
				continue;
			}
			try {
				const done = await transport.call(machine, "op.rollback", { opId: wire.id }, 5 * 60_000);
				leftovers.push(...done.leftovers.map(l => `${name}: ${l}`));
				if (done.leftovers.length > 0) priv.pendingRollback.push(machine);
			} catch (e) {
				leftovers.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
				priv.pendingRollback.push(machine);
			}
		}
		if (priv.forkSessionId && leftovers.length === 0) {
			this.#store.unmapSession(priv.targetMachine, priv.forkSessionId);
		}
		if (leftovers.length === 0) {
			wire.phase = byUser ? "rolled_back" : "failed";
			wire.leftovers = undefined;
			if (!byUser && !wire.error) wire.error = "The switch failed.";
		} else {
			wire.phase = "rollback_failed";
			wire.leftovers = leftovers;
		}
		op.undoing = false;
		op.stop = null;
		this.#changed(op, true);
		this.options.sessionsChanged([...new Set([priv.sourceMachine, priv.targetMachine])]);
	}

	// -- machines coming and going ------------------------------------------------------

	/** A machine's link is gone: operations that depend on it and are not past the commit point roll back. */
	machineLost(machine: string): void {
		for (const op of this.#ops.values()) {
			const { wire, priv } = op;
			if (priv.sourceMachine !== machine && priv.targetMachine !== machine) continue;
			const name = this.options.transport.machineName(machine);
			if (wire.phase === "running") {
				op.stop ??= { byUser: false, reason: `${name} went offline during the switch.` };
			} else if (wire.phase === "awaiting_confirm") {
				void this.#undo(op, false, `${name} went offline during the switch, so it was rolled back.`);
			}
		}
	}

	/** A machine registered: rollbacks and cleanups that were waiting for it run now. */
	machineBack(machine: string): void {
		for (const op of this.#ops.values()) {
			const { wire, priv } = op;
			if (wire.phase === "rollback_failed" && priv.pendingRollback.includes(machine) && !op.undoing) {
				void this.#undo(op, priv.byUser, wire.error);
			} else if (wire.phase === "completed" && priv.pendingCleanup.length > 0) {
				void this.#finishCleanup(op);
			}
		}
	}

	/**
	 * After a gateway restart: operations that were running or waiting for the user roll back (the daemons still hold their
	 * records); one that was past the commit point finishes its cleanups. Rollbacks wait for their machines to register.
	 */
	recover(): void {
		const rows = this.#store.activeHandoffs();
		for (const wire of rows) {
			const stored = this.#store.handoff(wire.id);
			if (!stored) continue;
			const priv = stored.priv as HandoffPrivate;
			const op: Op = { wire, priv, runner: null, stop: null, undoing: false, timer: null, lastPublish: 0 };
			this.#ops.set(wire.id, op);
			if (wire.phase === "rolling_back" || wire.phase === "rollback_failed") {
				wire.phase = "rollback_failed";
				priv.pendingRollback = [priv.targetMachine, priv.sourceMachine];
				wire.leftovers = ["The gateway restarted during the rollback: it continues when the machines are back."];
			} else {
				wire.phase = "rollback_failed";
				wire.error = "The gateway restarted during the switch, so it is being rolled back.";
				priv.byUser = false;
				priv.pendingRollback = [priv.targetMachine, priv.sourceMachine];
				wire.leftovers = ["Waiting for the machines to register again to remove what the switch created."];
			}
			this.#store.saveHandoff(wire.id, wire, priv);
		}
		for (const wire of this.#store.visibleHandoffs(0)) {
			if (wire.phase !== "completed" || this.#ops.has(wire.id)) continue;
			const stored = this.#store.handoff(wire.id);
			const priv = stored?.priv as HandoffPrivate | undefined;
			if (priv && priv.pendingCleanup.length > 0)
				this.#ops.set(wire.id, {
					wire,
					priv,
					runner: null,
					stop: null,
					undoing: false,
					timer: null,
					lastPublish: 0,
				});
		}
		this.#publish();
		// A machine that is already linked (the gateway's own) starts the rollback now.
		for (const op of this.#ops.values()) {
			for (const machine of new Set([op.priv.sourceMachine, op.priv.targetMachine])) {
				if (this.options.transport.online(machine)) this.machineBack(machine);
			}
		}
	}

	// -- plumbing ---------------------------------------------------------------------------

	#need(id: string): Op {
		const cached = this.#ops.get(id);
		if (cached) return cached;
		const stored = this.#store.handoff(id);
		if (!stored) throw new Error("Unknown switch.");
		const op: Op = {
			wire: stored.wire,
			priv: stored.priv as HandoffPrivate,
			runner: null,
			stop: null,
			undoing: false,
			timer: null,
			lastPublish: 0,
		};
		this.#ops.set(id, op);
		return op;
	}

	/** Persists the operation and tells the clients; progress ticks (`force` false) are throttled. */
	#changed(op: Op, force: boolean): void {
		const now = this.#now();
		op.wire.updatedAt = now;
		if (!force && now - op.lastPublish < 250) return;
		op.lastPublish = now;
		this.#store.saveHandoff(op.wire.id, op.wire, op.priv);
		this.#publish();
	}

	#publish(): void {
		if (!this.#closed) this.options.publish(this.list());
	}
}

function carriedLine(carried: CarriedSummary): string {
	const parts = [`${carried.paths} path${carried.paths === 1 ? "" : "s"} carried`];
	if (carried.skipped.length > 0) parts.push(`${carried.skipped.length} not carried`);
	if (carried.ignored.count > 0) parts.push(`${carried.ignored.count} ignored left behind`);
	return parts.join(", ");
}

export type { CacheForecast, HandoffPhase };
