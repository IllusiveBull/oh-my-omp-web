/**
 * The environment side of switching a thread to another environment: executes the named operations the gateway's
 * state machine sends (`op` link messages), serves and receives the binary transfers (`xfer.*`), and keeps a record on disk
 * of everything an operation created, so that a rollback after a crash or a lost link removes exactly that and nothing else.
 *
 * Layers (each tested on its own): `handoff-git.ts` (handoff commit, bundle, worktree), `handoff-session.ts` (omp's
 * `session pack|unpack|moved`, header normalization), `cache-facts.ts` (what the forecast compares). This file only decides
 * order, bookkeeping and who may do what: the gateway names an operation, never a path (the daemon derives every path from
 * its own record, and checks project roots and worktrees against its registry).
 */
import { open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	HANDOFF_ID_PATTERN,
	THREAD_ID_PATTERN,
	XFER_ID_PATTERN,
	type HandoffOpArgs,
	type HandoffOpError,
	type HandoffOpName,
	type HandoffOpResult,
	type SessionFacts,
	type SessionInfo,
	type SourceInspect,
	type TargetChoice,
	type TargetInspect,
	type TargetWorktree,
	type XferInfo,
} from "@omp-web/protocol";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	agentDbPathFor,
	buildSessionFacts,
	readAccountHashes,
	readSessionFileFacts,
	settledState,
	type SettledStateOptions,
} from "./cache-facts";
import {
	HandoffGitError,
	commitsPresent,
	createBundle,
	createHandoffCommit,
	createWorkspace,
	handoffRefs,
	inspectRepo,
	listTargetWorktrees,
	planNewWorktree,
	removeHandoffRefs,
	rollbackWorkspace,
	verifyAndFetchBundle,
	type GitContext,
	type WorkspaceRecord,
} from "./handoff-git";
import {
	SessionTransferError,
	markSessionMoved,
	normalizeHeader,
	packSessionFile,
	readSessionHeader,
	removeSessionCopy,
	unpackSessionArchive,
	type OmpRun,
} from "./handoff-session";
import type { SessionManager } from "./manager";
import type { HostedSession } from "./session";
import { isInside, type ProjectRegistry } from "./projects";
import { mkdirPrivate, randomToken, writeSecret } from "./secrets";
import { aclProblem, restrictPath } from "./file-acl";

/** An operation failed; `kind` tells the gateway whether anything may have changed (`failed`) or not (`refused`). */
export class HandoffOpFailure extends Error {
	constructor(
		message: string,
		readonly kind: "refused" | "failed",
	) {
		super(message);
		this.name = "HandoffOpFailure";
	}
}

const refused = (message: string): HandoffOpFailure => new HandoffOpFailure(message, "refused");

const isFile = (path: string | undefined): Promise<boolean> =>
	path
		? stat(path).then(
				s => s.isFile(),
				() => false,
			)
		: Promise.resolve(false);

/** What this daemon holds for one operation, on disk (`<state>/handoff/ops/<opId>.json`). */
export interface OpRecord {
	opId: string;
	threadId: string;
	/** The daemon process that wrote it: hosting a stopped session again is only meaningful inside that process's lifetime. */
	bootId: string;
	createdAt: number;
	source?: {
		sessionId: string;
		/** Every id the session answers to on this machine (reserved against clients while the switch runs). */
		sessionIds: string[];
		/** null: the session had no conversation and no file (a fresh session starts on the target; nothing is packed). */
		sessionFile: string | null;
		cwd: string;
		/** The worktree whose changes the handoff commit captured; refs live in its repository. */
		repoDir: string;
		refs: string[];
		tmp: string[];
		/** The omp process of the session was stopped for the archive (it was hosted before). */
		stopped: { hostedId: string; file: string; cwd: string } | null;
		entries: number | null;
	};
	target?: {
		repoDir: string | null;
		refs: string[];
		tmp: string[];
		workspace: WorkspaceRecord | null;
		/** The unpacked copy of the session (cross-machine); deleted as soon as the fork exists. */
		unpacked: string | null;
		fork: { sessionId: string; file: string } | null;
	};
}

interface SourceXfer {
	path: string;
	size: number;
}

interface Sink {
	path: string;
	size: number;
	sha256: string;
	received: number;
	hasher: Bun.CryptoHasher;
	handle: Awaited<ReturnType<typeof open>>;
	tail: Promise<void>;
	done: boolean;
}

export interface HandoffServiceOptions {
	manager: SessionManager;
	projects: ProjectRegistry;
	ompPath: string;
	/** Records and temporary files live under `<stateDir>/handoff`. */
	stateDir: string;
	ompVersion: string;
	platform?: string;
	/** Environment added to omp processes (the credential broker), read when needed. */
	childEnv?: () => Record<string, string>;
	/** Where new worktrees go when not next to the project (`handoff.worktreesDir`). */
	worktreesDir?: string;
	/** Whether the omp processes of this machine use a credential broker (its accounts are not on this machine's disk). */
	usesBroker?: () => boolean;
	/** The credential database to read account identities from (default: omp's for this daemon's environment). */
	agentDb?: () => string;
	/** Test seams. */
	git?: GitContext;
	/** How long a freshly started omp is polled until its prompt stops changing (default: 1.5 s stable, 20 s at most). */
	settle?: SettledStateOptions;
	now?: () => number;
	/** Records older than this are rolled back by the daemon itself (nobody came back for them); default 6 h. */
	staleMs?: number;
}

const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
const LEASE_WAIT_MS = 5000;

const sha256Of = async (path: string): Promise<{ sha256: string; size: number }> => {
	const hasher = new Bun.CryptoHasher("sha256");
	let size = 0;
	for await (const chunk of Bun.file(path).stream()) {
		hasher.update(chunk);
		size += chunk.byteLength;
	}
	return { sha256: hasher.digest("hex"), size };
};

function asRecord(args: unknown): Record<string, unknown> {
	if (typeof args !== "object" || args === null || Array.isArray(args))
		throw refused("bad request: arguments must be an object");
	return args as Record<string, unknown>;
}

function str(args: unknown, key: string): string {
	const value = asRecord(args)[key];
	if (typeof value !== "string" || value === "") throw refused(`bad request: "${key}" must be a non-empty string`);
	return value;
}

function checkIds(args: unknown): { opId: string; threadId?: string } {
	const opId = str(args, "opId");
	if (!HANDOFF_ID_PATTERN.test(opId)) throw refused("bad request: invalid operation id");
	const threadId = asRecord(args).threadId;
	if (threadId === undefined) return { opId };
	if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId))
		throw refused("bad request: invalid thread id");
	return { opId, threadId };
}

/** `subdir` is a relative path without `..`; the directory it names under `worktree` when that exists, else the worktree. */
async function sessionCwd(worktree: string, subdir: string): Promise<string> {
	if (subdir === "") return worktree;
	if (isAbsolute(subdir) || subdir.split(/[\\/]/).some(part => part === ".." || part === "")) return worktree;
	const candidate = join(worktree, ...subdir.split(/[\\/]/));
	const info = await stat(candidate).catch(() => null);
	if (!info?.isDirectory()) return worktree;
	const real = await realpath(candidate).catch(() => worktree);
	return isInside(worktree, real) ? real : worktree;
}

/** What the link layer needs from an environment's handoff implementation (the service; tests may stand in for it). */
export interface HandoffPort {
	call<K extends HandoffOpName>(op: K, args: unknown): Promise<HandoffOpResult[K]>;
	toWireError(error: unknown): HandoffOpError;
	readChunk(xfer: string, offset: number, len: number): Promise<{ data: Uint8Array; eof: boolean }>;
	writeChunk(xfer: string, offset: number, bytes: Uint8Array): Promise<void>;
	close(): void;
}

export class HandoffService implements HandoffPort {
	readonly #manager: SessionManager;
	readonly #projects: ProjectRegistry;
	readonly #bootId = randomToken(9);
	readonly #opsDir: string;
	readonly #tmpDir: string;
	readonly #now: () => number;
	readonly #staleMs: number;
	readonly #sources = new Map<string, SourceXfer>();
	readonly #sinks = new Map<string, Sink>();
	readonly #reads = new Map<string, Promise<unknown>>();
	/** One operation call at a time per operation id: a rollback never overlaps a step of the same operation. */
	readonly #chains = new Map<string, Promise<unknown>>();
	#sweeper: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly options: HandoffServiceOptions) {
		this.#manager = options.manager;
		this.#projects = options.projects;
		this.#opsDir = join(options.stateDir, "handoff", "ops");
		this.#tmpDir = join(options.stateDir, "handoff", "tmp");
		this.#now = options.now ?? Date.now;
		this.#staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	}

	/** Starts the sweep for records nobody came back for (daemon restarted, gateway gone for good). */
	start(): void {
		this.#sweeper ??= setInterval(() => void this.sweepStale().catch(() => {}), 10 * 60 * 1000);
		void this.sweepStale().catch(() => {});
	}

	close(): void {
		clearInterval(this.#sweeper ?? undefined);
		this.#sweeper = null;
		for (const sink of this.#sinks.values()) void sink.handle.close().catch(() => {});
		this.#sinks.clear();
	}

	// -- dispatch ------------------------------------------------------------

	/** Runs one operation of the gateway. Rejects with {@link HandoffOpFailure}. */
	call<K extends HandoffOpName>(op: K, args: unknown): Promise<HandoffOpResult[K]> {
		const opId = typeof args === "object" && args !== null && "opId" in args ? args.opId : undefined;
		const key = typeof opId === "string" ? opId : "";
		const previous = this.#chains.get(key) ?? Promise.resolve();
		const run = previous.catch(() => {}).then(() => this.#dispatch(op, args)) as Promise<HandoffOpResult[K]>;
		if (key !== "") {
			this.#chains.set(key, run);
			void run
				.catch(() => {})
				.finally(() => {
					if (this.#chains.get(key) === run) this.#chains.delete(key);
				});
		}
		return run.catch((error: unknown) => {
			throw this.#asFailure(error);
		});
	}

	/** An error as the gateway shows it: git and session layers already carry a user-facing message and a kind. */
	toWireError(error: unknown): HandoffOpError {
		const failure = this.#asFailure(error);
		return { message: failure.message, kind: failure.kind };
	}

	#asFailure(error: unknown): HandoffOpFailure {
		if (error instanceof HandoffOpFailure) return error;
		if (error instanceof HandoffGitError || error instanceof SessionTransferError) {
			return new HandoffOpFailure(error.message, error.kind);
		}
		return new HandoffOpFailure(error instanceof Error ? error.message : String(error), "failed");
	}

	async #dispatch(op: HandoffOpName, args: unknown): Promise<never> {
		switch (op) {
			case "source.inspect":
				return (await this.#sourceInspect(args as HandoffOpArgs["source.inspect"])) as never;
			case "source.commit":
				return (await this.#sourceCommit(args as HandoffOpArgs["source.commit"])) as never;
			case "source.capture":
				return (await this.#sourceCapture(args as HandoffOpArgs["source.capture"])) as never;
			case "source.bundle":
				return (await this.#sourceBundle(args as HandoffOpArgs["source.bundle"])) as never;
			case "source.pack":
				return (await this.#sourcePack(args as HandoffOpArgs["source.pack"])) as never;
			case "source.finish":
				return (await this.#sourceFinish(args as HandoffOpArgs["source.finish"])) as never;
			case "target.inspect":
				return (await this.#targetInspect(args as HandoffOpArgs["target.inspect"])) as never;
			case "target.receive":
				return (await this.#targetReceive(args as HandoffOpArgs["target.receive"])) as never;
			case "target.fetch":
				return (await this.#targetFetch(args as HandoffOpArgs["target.fetch"])) as never;
			case "target.workspace":
				return (await this.#targetWorkspace(args as HandoffOpArgs["target.workspace"])) as never;
			case "target.unpack":
				return (await this.#targetUnpack(args as HandoffOpArgs["target.unpack"])) as never;
			case "target.fork":
				return (await this.#targetFork(args as HandoffOpArgs["target.fork"])) as never;
			case "target.verify":
				return (await this.#targetVerify(args as HandoffOpArgs["target.verify"])) as never;
			case "op.commit":
				return (await this.#commit(args as HandoffOpArgs["op.commit"])) as never;
			case "op.rollback":
				return (await this.#rollback(args as HandoffOpArgs["op.rollback"])) as never;
		}
	}

	// -- records -------------------------------------------------------------

	#recordPath(opId: string): string {
		return join(this.#opsDir, `${opId}.json`);
	}

	async #load(opId: string): Promise<OpRecord | null> {
		try {
			return JSON.parse(await readFile(this.#recordPath(opId), "utf8")) as OpRecord;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw error;
		}
	}

	async #save(record: OpRecord): Promise<void> {
		await writeSecret(this.#recordPath(record.opId), `${JSON.stringify(record, null, "\t")}\n`);
	}

	async #ensure(opId: string, threadId: string): Promise<OpRecord> {
		const existing = await this.#load(opId);
		if (existing) return existing;
		const record: OpRecord = { opId, threadId, bootId: this.#bootId, createdAt: this.#now() };
		await this.#save(record);
		return record;
	}

	async #need(opId: string): Promise<OpRecord> {
		const record = await this.#load(opId);
		if (!record) throw refused("this operation is unknown to the daemon (it was rolled back or the daemon lost it)");
		return record;
	}

	#env(): OmpRun {
		return { ompPath: this.options.ompPath, env: this.options.childEnv?.() };
	}

	// -- session and project lookups -------------------------------------------

	#sessionInfo(sessionId: string): SessionInfo | undefined {
		return this.#manager
			.list()
			.find(i => i.id === sessionId || i.sessionId === sessionId || i.aliases.includes(sessionId));
	}

	async #projectOf(cwd: string): Promise<{ id: string; name: string; root: string; worktree: string } | null> {
		const where = await this.#projects.attribute(cwd);
		if (!where) return null;
		const project = (await this.#projects.list()).find(p => p.root === where.projectRoot);
		return project ? { id: project.id, name: project.name, root: project.root, worktree: where.worktreeRoot } : null;
	}

	/**
	 * Whether the session is a fresh one: hosted, no conversation started, and not on disk (omp writes the file at the first
	 * reply but reports its path from the start). Such a session switches by moving the workspace and starting a new session.
	 */
	async #isFresh(info: SessionInfo): Promise<boolean> {
		return this.#manager.hosted(info.id)?.isEmpty === true && !(await isFile(info.file));
	}

	async #sessionBlockers(info: SessionInfo): Promise<string[]> {
		const blockers: string[] = [];
		const hosted = this.#manager.hosted(info.id);
		if (hosted) {
			blockers.push(...(await hosted.handoffBlockers()));
		} else {
			if (info.access === "held") {
				blockers.push(
					"The session is open in another omp process (its ownership lease is held): close it there first.",
				);
			} else {
				try {
					if (await this.#manager.leaseHeld([info.id, info.sessionId, ...info.aliases])) {
						blockers.push("The session is open in another omp process (its ownership lease is held).");
					}
				} catch (error) {
					blockers.push(
						`Cannot tell whether another omp process owns the session: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
		if (!(await isFile(info.file)) && !(await this.#isFresh(info))) {
			blockers.push(
				"The session has messages omp has not written to disk yet (it writes after the first reply): wait for the reply, then switch.",
			);
		}
		const reservedBy = this.#manager.isReserved(info.id);
		if (reservedBy) blockers.push("An environment switch is already running for this session.");
		return blockers;
	}

	// -- source --------------------------------------------------------------

	async #sourceInspect(args: HandoffOpArgs["source.inspect"]): Promise<SourceInspect> {
		const sessionId = str(args, "sessionId");
		const info = this.#sessionInfo(sessionId);
		if (!info) throw refused(`unknown session: ${sessionId}`);
		const sessionBlockers = await this.#sessionBlockers(info);
		const project = await this.#projectOf(info.cwd);
		const repoBlockers: string[] = [];
		let repo: SourceInspect["repo"] = null;
		if (!project) {
			repoBlockers.push(
				"The session is not inside a registered project: there is no workspace to move. Register the project first.",
			);
		} else {
			const inspection = await inspectRepo(project.worktree, args.limits, this.options.git).catch(
				(error: unknown) => {
					repoBlockers.push(error instanceof Error ? error.message : String(error));
					return null;
				},
			);
			if (inspection) {
				repo = inspection;
				if (inspection.stateIssue) {
					repoBlockers.push(
						`A ${inspection.stateIssue} is in progress in ${project.worktree}: finish or abort it first.`,
					);
				}
				if (inspection.shallow) {
					repoBlockers.push("The repository is a shallow clone: its history cannot be bundled. Deepen it first.");
				}
			}
		}
		return {
			session: {
				id: info.id,
				sessionId: info.sessionId,
				cwd: info.cwd,
				file: info.file,
				hosted: this.#manager.hosted(info.id) !== undefined,
				access: info.access,
				phase: info.phase,
				title: info.title,
			},
			sessionBlockers,
			project,
			repo,
			repoBlockers,
		};
	}

	async #sourceCommit(args: HandoffOpArgs["source.commit"]): Promise<HandoffOpResult["source.commit"]> {
		const { opId, threadId } = checkIds(args);
		if (!threadId) throw refused("bad request: missing thread id");
		const info = this.#sessionInfo(str(args, "sessionId"));
		if (!info) throw refused("unknown session");
		const blockers = await this.#sessionBlockers(info);
		if (blockers.length > 0) throw refused(blockers.join(" "));
		const project = await this.#projectOf(info.cwd);
		if (!project) throw refused("The session is not inside a registered project.");
		const record = await this.#ensure(opId, threadId);
		const refs = handoffRefs(threadId);
		record.source = {
			sessionId: info.id,
			sessionIds: [...new Set([info.id, info.sessionId, ...info.aliases])],
			sessionFile: info.file ?? null,
			cwd: info.cwd,
			repoDir: project.worktree,
			refs: [refs.worktree, refs.index],
			tmp: [],
			stopped: null,
			entries: null,
		};
		// Recorded before anything is written: a crash after the refs exist still finds them to delete.
		await this.#save(record);
		this.#manager.reserve(opId, record.source.sessionIds);
		// Decided only now that clients cannot prompt it any more: a fresh session stays fresh for the whole switch.
		const fresh = await this.#isFresh(info);
		if (fresh) {
			record.source.sessionFile = null;
			await this.#save(record);
		} else if (!(await isFile(info.file))) {
			throw refused("The session's file is missing: there is nothing to move.");
		}
		const result = await createHandoffCommit(project.worktree, threadId, args.limits, this.options.git);
		return { ...result, fresh };
	}

	async #factsFor(
		state: RpcSessionState,
		origin: "live" | "probe",
		file: string,
		settled: boolean,
		historyEntries?: number,
	): Promise<SessionFacts> {
		const fileFacts = await readSessionFileFacts(file, historyEntries === undefined ? undefined : { historyEntries });
		const accounts = this.options.usesBroker?.()
			? { via: "broker" as const, hashes: [] }
			: readAccountHashes(this.options.agentDb?.() ?? agentDbPathFor(Bun.env));
		return buildSessionFacts({
			state,
			origin,
			file: fileFacts,
			accounts,
			omp: this.options.ompVersion,
			platform: this.options.platform ?? process.platform,
			now: this.#now(),
			settled,
		});
	}

	async #sourceCapture(args: HandoffOpArgs["source.capture"]): Promise<HandoffOpResult["source.capture"]> {
		const { opId } = checkIds(args);
		const record = await this.#need(opId);
		const source = record.source;
		if (!source) throw refused("the source commit was not made yet");
		const file = source.sessionFile;
		if (file === null) throw refused("a fresh session has no history to capture");
		const hosted = this.#manager.hosted(source.sessionId);
		let state: RpcSessionState;
		let settled: boolean;
		let probeFile: string | undefined;
		try {
			if (hosted) {
				({ state, settled } = await settledState(() => hosted.captureState(), this.options.settle));
			} else {
				({ state, settled } = await this.#manager.probeFork(file, source.cwd, this.options.settle));
				probeFile = state.sessionFile;
			}
		} finally {
			// The probe's own session file is scratch: gone whether or not reading its state worked.
			if (probeFile && probeFile !== file) {
				await removeSessionCopy(probeFile, { removeEmptyBucket: false }).catch(() => {});
			}
		}
		const facts = await this.#factsFor(state, hosted ? "live" : "probe", file, settled);
		source.entries = facts.history.entries;
		await this.#save(record);
		return { facts, hosted: hosted !== undefined };
	}

	async #sourceBundle(args: HandoffOpArgs["source.bundle"]): Promise<HandoffOpResult["source.bundle"]> {
		const { opId, threadId } = checkIds(args);
		const record = await this.#need(opId);
		if (!record.source || !threadId) throw refused("the source commit was not made yet");
		await this.#privateTmp();
		const out = join(this.#tmpDir, `${opId}.bundle`);
		record.source.tmp.push(out);
		await this.#save(record);
		const have = Array.isArray(args.have) ? args.have.filter(h => typeof h === "string") : [];
		const made = await createBundle(
			record.source.repoDir,
			out,
			threadId,
			have,
			args.limits.maxBundleBytes,
			this.options.git,
		);
		return { xfer: await this.#offer(out), full: made.full, prerequisites: made.prerequisites };
	}

	async #sourcePack(args: HandoffOpArgs["source.pack"]): Promise<HandoffOpResult["source.pack"]> {
		const { opId } = checkIds(args);
		const record = await this.#need(opId);
		const source = record.source;
		if (!source) throw refused("the source commit was not made yet");
		const file = source.sessionFile;
		if (file === null) throw refused("a fresh session has nothing to pack");
		let stoppedHosted = false;
		const hosted = this.#manager.hosted(source.sessionId);
		if (hosted) {
			// `omp session pack` refuses while any live omp process holds the lease, and a hosted session's own process does.
			source.stopped = { hostedId: hosted.id, file, cwd: source.cwd };
			await this.#save(record);
			await this.#manager.close(hosted.id);
			stoppedHosted = true;
		}
		await this.#waitLeaseFree(source.sessionIds);
		await this.#privateTmp();
		const tar = join(this.#tmpDir, `${opId}.session.tar`);
		source.tmp.push(tar);
		await this.#save(record);
		await packSessionFile(this.#env(), file, tar);
		const size = (await stat(tar)).size;
		if (size > args.limits.maxArchiveBytes) {
			await rm(tar, { force: true });
			throw refused(
				`The session archive is ${(size / 1048576).toFixed(1)} MiB, over the ${(args.limits.maxArchiveBytes / 1048576).toFixed(0)} MiB limit.`,
			);
		}
		const header = await readSessionHeader(file);
		const id = typeof header.header.id === "string" ? header.header.id : source.sessionId;
		return { xfer: await this.#offer(tar), file, id, cwd: source.cwd, stoppedHosted };
	}

	async #waitLeaseFree(ids: readonly string[]): Promise<void> {
		const deadline = this.#now() + LEASE_WAIT_MS;
		for (;;) {
			if (!(await this.#manager.leaseHeld(ids))) return;
			if (this.#now() > deadline) {
				throw refused(
					"The session's omp process did not release the session in time (another omp process may hold it).",
				);
			}
			await Bun.sleep(100);
		}
	}

	async #sourceFinish(args: HandoffOpArgs["source.finish"]): Promise<HandoffOpResult["source.finish"]> {
		const { opId } = checkIds(args);
		const record = await this.#need(opId);
		const source = record.source;
		if (!source) throw refused("the source commit was not made yet");
		const label = str(args, "label");
		const hosted = this.#manager.hosted(source.sessionId);
		const file = source.sessionFile;
		if (file === null) {
			// A fresh session has no file to mark: the thread continues in the target's new session, so this one just ends.
			if (hosted) await this.#manager.close(hosted.id);
			return { marked: false };
		}
		if (hosted) {
			source.stopped = { hostedId: hosted.id, file, cwd: source.cwd };
			await this.#save(record);
			await this.#manager.close(hosted.id);
		}
		try {
			await this.#waitLeaseFree(source.sessionIds);
			await markSessionMoved(this.#env(), file, label);
			return { marked: true };
		} catch (error) {
			const failure = this.#asFailure(error);
			return { marked: false, warning: `The old session could not be marked as moved: ${failure.message}` };
		}
	}

	// -- target --------------------------------------------------------------

	async #targetInspect(args: HandoffOpArgs["target.inspect"]): Promise<TargetInspect> {
		const projectId = str(args, "projectId");
		const sourceHead = str(args, "sourceHead");
		const threadId = str(args, "threadId");
		if (!THREAD_ID_PATTERN.test(threadId)) throw refused("bad request: invalid thread id");
		const project = (await this.#projects.list()).find(p => p.id === projectId);
		const gitVersion = (await Bun.$`git --version`.quiet().nothrow().text()).trim();
		if (!project) {
			return { project: null, worktrees: [], have: [], shallow: false, newWorktree: null, gitVersion };
		}
		const recent = Array.isArray(args.recent) ? args.recent.filter(c => typeof c === "string") : [];
		const sourceWorktree = typeof args.sourceWorktree === "string" ? args.sourceWorktree : undefined;
		const [worktrees, have, newWorktree] = await Promise.all([
			listTargetWorktrees(project.root, sourceHead, { sourceWorktree }, this.options.git),
			commitsPresent(project.root, recent, this.options.git),
			planNewWorktree(
				project.root,
				project.name,
				threadId,
				{ worktreesDir: this.options.worktreesDir },
				this.options.git,
			),
		]);
		const busy = await this.#withHostedSessions(worktrees);
		const shallow = (await this.#isShallow(project.root)) ?? false;
		return {
			project: { id: project.id, name: project.name, root: project.root },
			worktrees: busy,
			have,
			shallow,
			newWorktree,
			gitVersion,
		};
	}

	async #isShallow(root: string): Promise<boolean | null> {
		const run = await Bun.$`git -C ${root} rev-parse --is-shallow-repository`.quiet().nothrow();
		return run.exitCode === 0 ? run.text().trim() === "true" : null;
	}

	/** A worktree where one of this daemon's own omp sessions runs is not offered: its files would change under it. */
	async #withHostedSessions(worktrees: TargetWorktree[]): Promise<TargetWorktree[]> {
		const hosted = this.#manager.list().filter(i => i.phase !== "stored");
		return worktrees.map(w => {
			if (!w.eligible) return w;
			const inside = hosted.find(i => isInside(w.path, i.cwd));
			return inside
				? {
						...w,
						eligible: false,
						reason: "An omp session is running in this worktree: its files would change under it.",
					}
				: w;
		});
	}

	async #targetProject(root: string): Promise<{ id: string; name: string; root: string }> {
		const canonical = await realpath(root).catch(() => root);
		const project = (await this.#projects.list()).find(
			p => isInside(p.root, canonical) && isInside(canonical, p.root),
		);
		if (!project) throw refused(`${root} is not a registered project root of this machine`);
		return project;
	}

	async #privateTmp(): Promise<void> {
		await mkdirPrivate(this.#tmpDir);
		if (process.platform === "win32") {
			const problem = aclProblem(this.#tmpDir);
			if (problem) throw refused(`handoff temporary directory is not private: ${problem}`);
		} else if (((await stat(this.#tmpDir)).mode & 0o077) !== 0) {
			throw refused(`handoff temporary directory is not private: ${this.#tmpDir}`);
		}
	}

	async #targetReceive(args: HandoffOpArgs["target.receive"]): Promise<HandoffOpResult["target.receive"]> {
		const { opId, threadId } = checkIds(args);
		if (!threadId) throw refused("bad request: missing thread id");
		const record = await this.#ensure(opId, threadId);
		const size = args.size;
		if (!Number.isSafeInteger(size) || size < 0) throw refused("bad request: invalid size");
		if (!/^[0-9a-f]{64}$/.test(args.sha256)) throw refused("bad request: invalid checksum");
		if (args.kind !== "bundle" && args.kind !== "session") throw refused("bad request: invalid kind");
		await this.#privateTmp();
		const id = `x${randomToken(12)}`;
		const path = join(this.#tmpDir, `${opId}.${args.kind}.recv`);
		record.target ??= { repoDir: null, refs: [], tmp: [], workspace: null, unpacked: null, fork: null };
		if (!record.target.tmp.includes(path)) record.target.tmp.push(path);
		await this.#save(record);
		const handle = await open(path, "w", 0o600);
		if (process.platform === "win32") restrictPath(path);
		this.#sinks.set(id, {
			path,
			size,
			sha256: args.sha256,
			received: 0,
			hasher: new Bun.CryptoHasher("sha256"),
			handle,
			tail: Promise.resolve(),
			done: false,
		});
		return { xfer: id };
	}

	/** Appends one chunk of an incoming transfer; chunks must arrive in order. */
	writeChunk(xfer: string, offset: number, bytes: Uint8Array): Promise<void> {
		const sink = this.#sinks.get(xfer);
		if (!sink) return Promise.reject(new Error("unknown transfer"));
		const run = sink.tail.then(async () => {
			if (sink.done) throw new Error("the transfer is complete");
			if (offset !== sink.received)
				throw new Error(`out-of-order chunk (expected offset ${sink.received}, got ${offset})`);
			if (sink.received + bytes.byteLength > sink.size) throw new Error("more bytes than announced");
			await sink.handle.write(bytes);
			sink.hasher.update(bytes);
			sink.received += bytes.byteLength;
		});
		sink.tail = run.catch(() => {});
		return run;
	}

	/** The received file once complete and checked (size and SHA-256 as announced); closes the sink. */
	async #sinkFile(xfer: string): Promise<string> {
		const sink = this.#sinks.get(xfer);
		if (!sink) throw refused("unknown transfer");
		await sink.tail;
		if (!sink.done) {
			sink.done = true;
			await sink.handle.close();
		}
		if (sink.received !== sink.size) {
			throw new HandoffOpFailure(`the transfer is incomplete (${sink.received} of ${sink.size} bytes)`, "failed");
		}
		const digest = new Bun.CryptoHasher("sha256").update(await readFile(sink.path)).digest("hex");
		if (digest !== sink.sha256)
			throw new HandoffOpFailure("the transferred file is corrupted (checksum mismatch)", "failed");
		return sink.path;
	}

	async #targetFetch(args: HandoffOpArgs["target.fetch"]): Promise<HandoffOpResult["target.fetch"]> {
		const { opId, threadId } = checkIds(args);
		const record = await this.#need(opId);
		if (!threadId) throw refused("bad request: missing thread id");
		const project = await this.#targetProject(str(args, "projectRoot"));
		const path = await this.#sinkFile(str(args, "xfer"));
		record.target ??= { repoDir: null, refs: [], tmp: [], workspace: null, unpacked: null, fork: null };
		record.target.repoDir = project.root;
		const refs = handoffRefs(threadId);
		record.target.refs = [refs.worktree, refs.index];
		await this.#save(record);
		const fetched = await verifyAndFetchBundle(project.root, path, threadId, this.options.git);
		await rm(path, { force: true });
		return { refs: fetched };
	}

	async #targetWorkspace(args: HandoffOpArgs["target.workspace"]): Promise<HandoffOpResult["target.workspace"]> {
		const { opId, threadId } = checkIds(args);
		if (!threadId) throw refused("bad request: missing thread id");
		const record = await this.#ensure(opId, threadId);
		const project = await this.#targetProject(str(args, "projectRoot"));
		if (project.id !== args.projectId) throw refused("the project on this machine is not the project being moved");
		record.target ??= { repoDir: null, refs: [], tmp: [], workspace: null, unpacked: null, fork: null };
		record.target.repoDir = project.root;
		const refs = handoffRefs(threadId);
		if (record.target.refs.length === 0) record.target.refs = [refs.worktree, refs.index];
		await this.#save(record);
		if (args.choice.mode === "existing") {
			const wanted = args.choice.worktree;
			const chosen = (
				await this.#withHostedSessions(
					await listTargetWorktrees(
						project.root,
						args.base.commit,
						{ sourceWorktree: record.source?.repoDir },
						this.options.git,
					),
				)
			).find(w => isInside(w.path, wanted) && isInside(wanted, w.path));
			if (!chosen?.eligible) throw refused(chosen?.reason ?? "That worktree is not available for the switch.");
		}
		const done = await createWorkspace(
			{
				opId,
				threadId,
				projectRoot: project.root,
				choice: args.choice as TargetChoice,
				base: args.base,
				commit: args.commit,
				indexCommit: args.indexCommit,
				onRecord: async workspace => {
					record.target!.workspace = workspace;
					await this.#save(record);
				},
			},
			this.options.git,
		);
		// The new worktree belongs to the project from now on: sessions in it are attributed to it, clients list it.
		await this.#projects.rescan().catch(() => {});
		return {
			worktree: done.record.worktree,
			branch: done.record.branch,
			created: done.record.createdWorktree,
			applied: done.applied,
		};
	}

	/** The directory a session continues in: the operation's own worktree (checked against the record) plus the source's subdirectory. */
	async #targetCwd(record: OpRecord, cwd: string, subdir: string): Promise<string> {
		const workspace = record.target?.workspace;
		if (!workspace) throw refused("the worktree was not prepared yet");
		const [a, b] = await Promise.all([
			realpath(cwd).catch(() => cwd),
			realpath(workspace.worktree).catch(() => workspace.worktree),
		]);
		if (!isInside(a, b) || !isInside(b, a))
			throw refused("the session must continue in the worktree this operation prepared");
		return sessionCwd(b, subdir);
	}

	async #targetUnpack(args: HandoffOpArgs["target.unpack"]): Promise<HandoffOpResult["target.unpack"]> {
		const { opId } = checkIds(args);
		const record = await this.#need(opId);
		const cwd = await this.#targetCwd(record, str(args, "cwd"), typeof args.subdir === "string" ? args.subdir : "");
		const tar = await this.#sinkFile(str(args, "xfer"));
		const unpacked = await unpackSessionArchive(this.#env(), tar, cwd);
		record.target!.unpacked = unpacked.file;
		await this.#save(record);
		await rm(tar, { force: true });
		const normalized = await normalizeHeader(unpacked.file, {
			clearAdditionalDirectories: args.clearAdditionalDirectories === true,
		});
		return { file: unpacked.file, id: unpacked.id, dropped: normalized.dropped };
	}

	async #targetFork(args: HandoffOpArgs["target.fork"]): Promise<HandoffOpResult["target.fork"]> {
		const { opId } = checkIds(args);
		const record = await this.#need(opId);
		const cwd = await this.#targetCwd(record, str(args, "cwd"), typeof args.subdir === "string" ? args.subdir : "");
		const sameMachine = record.source !== undefined;
		let session: HostedSession;
		if (args.fresh === true) {
			if (sameMachine && record.source!.sessionFile !== null) throw refused("the source session is not a fresh one");
			session = await this.#manager.startFresh(cwd);
		} else {
			const from = sameMachine ? record.source!.sessionFile : record.target!.unpacked;
			if (!from) throw refused("there is no session copy to fork from");
			session = await this.#manager.forkFile(from, cwd);
		}
		// Reserved before anything else awaits: `create` closes unreserved empty sessions, and a fresh one is empty.
		this.#manager.reserve(opId, [session.id, session.info.sessionId]);
		const file = session.info.file;
		if (!file) throw new HandoffOpFailure("the forked session has no session file", "failed");
		record.target!.fork = { sessionId: session.id, file };
		await this.#save(record);
		if (args.fresh === true) return { sessionId: session.id, file, facts: null };
		// A fresh omp has not connected its MCP servers yet; its prompt is rebuilt when they do. Read it once it is stable.
		const { state, settled } = await settledState(() => session.captureState(), this.options.settle);
		const facts = await this.#factsFor(state, "live", file, settled, args.historyEntries);
		if (!sameMachine && record.target!.unpacked) {
			// The fork owns copies of everything now; the unpacked intermediate (same id as the source) must not linger as a second session.
			await removeSessionCopy(record.target!.unpacked, { removeEmptyBucket: true }).catch(() => {});
			record.target!.unpacked = null;
			await this.#save(record);
		}
		return { sessionId: session.id, file, facts };
	}

	async #targetVerify(args: HandoffOpArgs["target.verify"]): Promise<HandoffOpResult["target.verify"]> {
		const session = this.#manager.hosted(str(args, "sessionId"));
		if (!session) return { alive: false, detail: "the forked session's process is gone" };
		if (session.info.phase !== "idle") return { alive: false, detail: `the forked session is ${session.info.phase}` };
		return { alive: true };
	}

	// -- finishing -----------------------------------------------------------
	async #removeTransfers(paths: string[]): Promise<void> {
		for (const [id, sink] of this.#sinks) {
			if (!paths.includes(sink.path)) continue;
			await sink.tail;
			if (!sink.done) await sink.handle.close();
			this.#sinks.delete(id);
		}
		for (const [id, source] of this.#sources) {
			if (paths.includes(source.path)) this.#sources.delete(id);
		}
		for (const file of paths) await rm(file, { force: true });
	}

	async #commit(args: HandoffOpArgs["op.commit"]): Promise<HandoffOpResult["op.commit"]> {
		const { opId, threadId } = checkIds(args);
		const record = await this.#load(opId);
		const cleaned: string[] = [];
		const warnings: string[] = [];
		if (!record) return { cleaned, warnings };
		const tid = threadId ?? record.threadId;
		if (args.role === "target" && record.target) {
			const t = record.target;
			if (t.repoDir) {
				await removeHandoffRefs(t.repoDir, tid, this.options.git)
					.then(refs => cleaned.push(...refs))
					.catch(error =>
						warnings.push(`handoff refs: ${error instanceof Error ? error.message : String(error)}`),
					);
			}
			await this.#removeTransfers(t.tmp).catch(error => warnings.push(`temporary files: ${String(error)}`));
			if (t.fork) this.#manager.release(opId);
			delete record.target;
		} else if (args.role === "source" && record.source) {
			const s = record.source;
			await removeHandoffRefs(s.repoDir, tid, this.options.git)
				.then(refs => cleaned.push(...refs))
				.catch(error => warnings.push(`handoff refs: ${error instanceof Error ? error.message : String(error)}`));
			await this.#removeTransfers(s.tmp).catch(error => warnings.push(`temporary files: ${String(error)}`));
			delete record.source;
		}
		if (!record.source && !record.target) {
			this.#manager.release(opId);
			await rm(this.#recordPath(opId), { force: true });
		} else {
			await this.#save(record);
		}
		return { cleaned, warnings };
	}

	/**
	 * Removes everything this operation created on this machine, and nothing else: the forked session (process and files), the
	 * unpacked copy, the worktree and branch (only when the record's marker and tip still match), the handoff refs, the temporary
	 * files; and hosts the source session again when this daemon stopped it for the archive. Idempotent.
	 */
	async #rollback(args: HandoffOpArgs["op.rollback"]): Promise<HandoffOpResult["op.rollback"]> {
		const { opId } = checkIds(args);
		const record = await this.#load(opId);
		const removed: string[] = [];
		const leftovers: string[] = [];
		if (!record) return { removed, leftovers };
		const note = (what: string, error: unknown): void => {
			leftovers.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
		};
		const target = record.target;
		if (target) {
			if (target.fork) {
				const { sessionId, file } = target.fork;
				try {
					if (this.#manager.hosted(sessionId)) await this.#manager.close(sessionId);
				} catch (error) {
					note(`could not stop the forked session ${sessionId}`, error);
				}
				// Only a file this operation created: it is not the source's and its header id is the fork's.
				if (file !== record.source?.sessionFile && file !== record.target?.unpacked) {
					try {
						const header = await readSessionHeader(file).catch(() => null);
						if (header === null || header.header.id === sessionId) {
							removed.push(...(await removeSessionCopy(file, { removeEmptyBucket: false })));
						} else {
							leftovers.push(`${file}: not removed (its session id is not the fork's)`);
						}
					} catch (error) {
						note(`could not delete the forked session file ${file}`, error);
					}
				}
			}
			if (target.unpacked) {
				try {
					removed.push(...(await removeSessionCopy(target.unpacked, { removeEmptyBucket: true })));
				} catch (error) {
					note(`could not delete the unpacked session copy ${target.unpacked}`, error);
				}
			}
			if (target.workspace) {
				try {
					const done = await rollbackWorkspace(target.workspace, this.options.git);
					removed.push(...done.removed);
					leftovers.push(...done.leftovers);
					await this.#projects.rescan().catch(() => {});
				} catch (error) {
					note(`could not remove the worktree ${target.workspace.worktree}`, error);
				}
			}
			if (target.repoDir) {
				try {
					removed.push(...(await removeHandoffRefs(target.repoDir, record.threadId, this.options.git)));
				} catch (error) {
					note("could not delete the handoff refs on the target", error);
				}
			}
			await this.#removeTransfers(target.tmp).catch(error => note("could not remove target temporary files", error));
		}
		const source = record.source;
		if (source) {
			try {
				removed.push(...(await removeHandoffRefs(source.repoDir, record.threadId, this.options.git)));
			} catch (error) {
				note("could not delete the handoff refs on the source", error);
			}
			await this.#removeTransfers(source.tmp).catch(error => note("could not remove source temporary files", error));
			if (source.stopped) {
				if (record.bootId === this.#bootId) {
					try {
						await this.#manager.restoreHosted(source.stopped.file, source.stopped.cwd);
						removed.push("(hosted the source session again)");
					} catch (error) {
						note("the source session was not hosted again (take it over to continue)", error);
					}
				} else {
					removed.push("(the daemon restarted meanwhile: the source session is stored; take it over to continue)");
				}
			}
		}
		this.#manager.release(opId);
		if (leftovers.length === 0) await rm(this.#recordPath(opId), { force: true });
		return { removed, leftovers };
	}

	/** Rolls back records nobody finished for `staleMs` (the gateway that owned them is gone). */
	async sweepStale(): Promise<void> {
		let names: string[];
		try {
			names = await readdir(this.#opsDir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const opId = name.slice(0, -5);
			if (!HANDOFF_ID_PATTERN.test(opId)) continue;
			const record = await this.#load(opId).catch(() => null);
			if (record && this.#now() - record.createdAt > this.#staleMs) {
				await this.call("op.rollback", { opId }).catch(() => {});
			}
		}
	}

	// -- transfers -------------------------------------------------------------

	/** Registers a finished file for the gateway to pull in chunks. */
	async #offer(path: string): Promise<XferInfo> {
		const { sha256, size } = await sha256Of(path);
		const id = `x${randomToken(12)}`;
		if (!XFER_ID_PATTERN.test(id)) throw new Error("bad transfer id");
		this.#sources.set(id, { path, size });
		return { id, size, sha256 };
	}

	/** Reads `len` bytes of an offered file at `offset`; reads of one transfer are served in order. */
	readChunk(xfer: string, offset: number, len: number): Promise<{ data: Uint8Array; eof: boolean }> {
		const source = this.#sources.get(xfer);
		if (!source) return Promise.reject(new Error("unknown transfer"));
		const previous = this.#reads.get(xfer) ?? Promise.resolve();
		const run = previous
			.catch(() => {})
			.then(async () => {
				if (offset > source.size) throw new Error("offset beyond the end of the file");
				const take = Math.min(len, source.size - offset);
				const bytes = new Uint8Array(take);
				if (take > 0) {
					const handle = await open(source.path, "r");
					try {
						const { bytesRead } = await handle.read(bytes, 0, take, offset);
						if (bytesRead !== take) throw new Error("the file changed while it was being transferred");
					} finally {
						await handle.close();
					}
				}
				return { data: bytes, eof: offset + take >= source.size };
			});
		this.#reads.set(xfer, run);
		return run;
	}
}

/** Used by tests and the smoke to name the files this service left in `stateDir`. */
export function handoffDirs(stateDir: string): { ops: string; tmp: string } {
	return { ops: join(stateDir, "handoff", "ops"), tmp: join(stateDir, "handoff", "tmp") };
}
