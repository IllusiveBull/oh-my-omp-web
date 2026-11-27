/**
 * Switching a thread to another environment: the gateway orchestrates a persisted state machine ("handoff")
 * across two environment daemons. Everything here is a wire type; behaviour lives in the daemon (`handoff-*.ts`) and the
 * web store.
 *
 * Three surfaces:
 * - browser <-> gateway: {@link HandoffMessage} requests and the `handoff.state` frame ({@link HandoffWire} list);
 * - gateway -> env daemon: named operations ({@link HandoffOpArgs} / {@link HandoffOpResult}) carried by the link's
 *   `op` / `op.result` messages, and the binary transfers (`xfer.*`, see `link.ts`);
 * - the cache forecast ({@link SessionFacts} of both ends -> {@link CacheForecast}, computed by `forecastCache`).
 */

// ---------------------------------------------------------------------------
// The operation as every client sees it
// ---------------------------------------------------------------------------

/** One step of the progress list, in this order. `bundle` and `session` are skipped for a switch within one machine. */
export const HANDOFF_STEP_IDS = [
	"preflight",
	"commit",
	"capture",
	"bundle",
	"worktree",
	"session",
	"fork",
	"forecast",
] as const;
export type HandoffStepId = (typeof HANDOFF_STEP_IDS)[number];

export type HandoffStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface HandoffStep {
	id: HandoffStepId;
	label: string;
	status: HandoffStepStatus;
	/** What the step did or why it failed, e.g. `12 files, 3 skipped` or `bundle 4.2 MiB (thin)`. */
	detail?: string;
	/** Progress of a transfer inside the step (bundle, session archive). */
	bytes?: { done: number; total: number };
}

/**
 * - `running`: a step is executing (or the gateway is between steps);
 * - `awaiting_confirm`: everything is built and the forecast is ready; waits for confirm / cancel (or the timeout);
 * - `confirming`: the user confirmed; the thread is being repointed and the source marked moved;
 * - `rolling_back`: cancelled or failed; the gateway is undoing what both sides created;
 * - `completed`: the thread now lives in the target environment;
 * - `rolled_back`: the user cancelled and both sides are clean again;
 * - `failed`: a step failed and both sides are clean again (`error` says why);
 * - `rollback_failed`: a step failed or was cancelled and the rollback itself did not finish: `leftovers` names what
 *   remains. The operation keeps blocking the thread until the rollback succeeds (retried when the machine returns).
 */
export type HandoffPhase =
	| "running"
	| "awaiting_confirm"
	| "confirming"
	| "rolling_back"
	| "completed"
	| "rolled_back"
	| "failed"
	| "rollback_failed";

/** Phases in which the thread is locked by the operation (one handoff per thread at a time). */
export const HANDOFF_ACTIVE_PHASES: readonly HandoffPhase[] = [
	"running",
	"awaiting_confirm",
	"confirming",
	"rolling_back",
	"rollback_failed",
];

export type TargetChoice = { mode: "new" } | { mode: "existing"; worktree: string };

/** A file the handoff did not carry, and why: nothing is dropped silently. */
export interface SkippedPath {
	path: string;
	reason: "too-large" | "total-cap" | "submodule" | "embedded-repo" | "lfs" | "special-file" | "unreadable";
	size?: number;
	detail?: string;
}

/** What the handoff commit carries and what it leaves behind (computed on the source, shown before and after the commit). */
export interface CarriedSummary {
	base: { commit: string; branch: string | null; detached: boolean };
	/** Tracked paths whose working-tree state differs from HEAD, by kind (a path counts once, under its primary kind). */
	tracked: {
		modified: number;
		added: number;
		deleted: number;
		renamed: number;
		typeChanged: number;
		modeChanged: number;
	};
	/** Untracked, not ignored: carried files and their total size. */
	untracked: { files: number; bytes: number };
	/**
	 * Whether the staged / unstaged split is restored on the target. `preserved: false` means every change arrives
	 * unstaged (`note` says why).
	 */
	staged: { preserved: boolean; paths: number; note?: string };
	/** Not carried, with reasons. Complete (capped at 500 entries; `skippedTruncated` says when). */
	skipped: SkippedPath[];
	skippedTruncated: boolean;
	/** Ignored files stay behind: how many and a sample of their (collapsed) paths. */
	ignored: { count: number; sample: string[] };
	/** The carried paths, first 40 only (for display). */
	sample: string[];
	/** Total number of carried paths. */
	paths: number;
}

export interface HandoffWire {
	id: string;
	threadId: string;
	source: {
		machine: string;
		machineName: string;
		sessionId: string;
		title?: string;
		cwd: string;
		worktree: string;
		projectId: string;
		projectName: string;
	};
	target: {
		machine: string;
		machineName: string;
		choice: TargetChoice;
		/** Filled in once the worktree exists: the directory the session continues in. */
		worktree?: string;
		branch?: string | null;
		/** Filled in once the fork runs: the (not yet visible) session that becomes the thread's current one on confirm. */
		sessionId?: string;
	};
	phase: HandoffPhase;
	steps: HandoffStep[];
	createdAt: number;
	updatedAt: number;
	/** Why it failed or was rolled back by the system (not by the user). */
	error?: string;
	/** `rollback_failed`: what is left on which machine. */
	leftovers?: string[];
	carried?: CarriedSummary;
	/** Bundle facts: size on the wire, whether it had to be a full one, how many prerequisites made it thin. */
	bundle?: { bytes: number; full: boolean; prerequisites: number };
	/** Session archive size on the wire (cross-machine only). */
	archiveBytes?: number;
	/** Present from `awaiting_confirm` on. */
	forecast?: CacheForecast;
	/** `awaiting_confirm`: when the gateway rolls the operation back by itself. */
	expiresAt?: number;
	/** `completed`: where the thread lives now. */
	result?: { sessionId: string; worktree: string; branch: string | null; sourceMarked: boolean; warning?: string };
	/** Additional directories of the session header that were dropped on the target (cross-machine). */
	droppedDirectories?: string[];
	/**
	 * The source session had no conversation yet (omp had not written it to disk): only the workspace moves, a new session
	 * starts on the target, and there is no cache to forecast.
	 */
	freshSession?: boolean;
}

/** One completed move of a thread, oldest first in {@link GatewaySessionInfo.hops}. */
export interface ThreadHop {
	id: string;
	handoffId: string;
	at: number;
	from: { machine: string; machineName: string; sessionId: string; cwd: string };
	to: { machine: string; machineName: string; sessionId: string; cwd: string; branch: string | null };
	forecast: ForecastSummary | null;
}

// ---------------------------------------------------------------------------
// Browser <-> gateway
// ---------------------------------------------------------------------------

export interface TargetWorktree {
	path: string;
	branch: string | null;
	head: string;
	/** An existing worktree can be chosen only when it is clean (no untracked files either), at the source's commit, and unused. */
	eligible: boolean;
	/** Why it is not eligible. */
	reason?: string;
	/** This is the source's own worktree (a same-machine switch cannot reuse it). */
	isSource: boolean;
}

/** What the picker shows before anything is created. */
export interface HandoffPlan {
	source: {
		machine: string;
		machineName: string;
		sessionId: string;
		threadId: string;
		title?: string;
		cwd: string;
		hosted: boolean;
	};
	/** The source repository as it is now; null when the session is not in a registered project. */
	repo: {
		project: { id: string; name: string; root: string; worktree: string };
		head: string;
		branch: string | null;
		detached: boolean;
		/** What would be carried / left behind right now (a preview: the real commit is made at start). */
		preview: CarriedSummary;
	} | null;
	sameMachine: boolean;
	target: {
		machine: string;
		machineName: string;
		online: boolean;
		/** The matching project (same first root commit) registered on the target; null: clone it first. */
		project: { name: string; root: string } | null;
		worktrees: TargetWorktree[];
		/** Where a new worktree would be created and the branch it would get. */
		newWorktree: { path: string; branch: string } | null;
	} | null;
	/** Everything that stops the switch, in words for the user. Empty: it can start. */
	blockers: string[];
}

export type HandoffMessage =
	/** Answers a {@link HandoffPlan}; creates nothing. `m` is the source machine. */
	| { t: "handoff.plan"; reqId: string; m: string; sessionId: string; targetMachine: string }
	/** Starts the operation (acks `{ id }`); progress arrives as `handoff.state` frames. */
	| {
			t: "handoff.start";
			reqId: string;
			m: string;
			sessionId: string;
			targetMachine: string;
			target: TargetChoice;
	  }
	/** Commits an `awaiting_confirm` operation: the thread moves. */
	| { t: "handoff.confirm"; reqId: string; id: string }
	/** Cancels a running or `awaiting_confirm` operation: everything it created is removed. */
	| { t: "handoff.cancel"; reqId: string; id: string }
	/** Hides a finished operation from every client's list. */
	| { t: "handoff.dismiss"; reqId: string; id: string };

export const HANDOFF_MESSAGE_TYPES = [
	"handoff.plan",
	"handoff.start",
	"handoff.confirm",
	"handoff.cancel",
	"handoff.dismiss",
] as const;

export function isHandoffType(t: string): t is (typeof HANDOFF_MESSAGE_TYPES)[number] {
	return (HANDOFF_MESSAGE_TYPES as readonly string[]).includes(t);
}

/** The gateway's list of operations (active and recently finished, not dismissed), replaced wholesale on each change. */
export interface HandoffFrame {
	t: "handoff.state";
	handoffs: HandoffWire[];
}

// ---------------------------------------------------------------------------
// The cache forecast
// ---------------------------------------------------------------------------

export interface ModelRef {
	provider: string;
	id: string;
	api?: string;
}

/**
 * What one end knows about the prompt it would send next, collected without sending anything: from the omp process's
 * `get_state` (system prompt blocks, tool dump, model, thinking level, context usage), from the session file (history,
 * credential pins, the time of the last response) and from the machine's account list (hashes only: identity fields never
 * leave the daemon). Hashes are SHA-256 hex of the exact strings / canonical JSON.
 */
export interface SessionFacts {
	sessionId: string;
	file?: string;
	/** `live`: asked from the omp process that runs the session. `probe`: from a short-lived fork of a stored session. */
	origin: "live" | "probe";
	capturedAt: number;
	omp: string;
	platform: string;
	model: ModelRef | null;
	thinkingLevel: string | null;
	fastModeActive: boolean;
	slowModeEnabled: boolean;
	/** `dumpTools` including each tool's `examples`. Null when omp did not report it. */
	tools: { hash: string; count: number } | null;
	/** `systemPrompt[0]`, the static head that sits before Anthropic's system cache breakpoint. */
	systemHead: { hash: string; chars: number } | null;
	/** `systemPrompt[1..]` joined: `<project-context>` (OS, arch, workspace roots, context files, skills, memories). */
	systemTail: { hash: string; chars: number } | null;
	/** `get_state.contextUsage`. */
	context: { tokens: number | null; window: number | null } | null;
	/** Epoch ms of the newest assistant response in the session file; null when there is none. */
	lastRequestAt: number | null;
	history: {
		/** Entries after the header, and a hash over their normalized JSON lines. */
		entries: number;
		hash: string;
		/** Compaction entries on the file, and the index (in `entries`) of the newest. */
		compactions: number;
		lastCompactionIndex: number | null;
	};
	/** Latest `credential_pin` per provider in the session file. */
	pins: { provider: string; hash: string }[];
	/** The machine's own accounts, as pin hashes (`credentialPinHash`); `via: "broker"` when the broker holds them. */
	accounts: {
		via: "local-db" | "broker" | "unavailable";
		hashes: { provider: string; hash: string }[];
		/** Why the list is unavailable (`via: "unavailable"`); shown in the forecast. */
		reason?: string;
	};
	/** The session header's `providerPromptCacheKey` (OpenAI-family caches key on it). */
	promptCacheKey: string | null;
	/**
	 * False when the prompt (system blocks, tool list) was still changing when it was read: omp rebuilds it after startup
	 * (MCP servers connect asynchronously), so a difference to the other end may not be a real one. Absent = not checked.
	 */
	settled?: boolean;
}

export type ForecastItemId =
	| "tools"
	| "systemHead"
	| "systemTail"
	| "history"
	| "model"
	| "thinking"
	| "tier"
	| "account"
	| "ttl"
	| "cacheKey";

export interface ForecastItem {
	id: ForecastItemId;
	label: string;
	/** `unknown`: could not be determined (said so in `detail`); `na`: does not apply to this provider / session. */
	status: "hit" | "miss" | "unknown" | "na";
	detail: string;
	/** The status is an inference from provider documentation or source reading, not something observed. Shown as such. */
	inference: boolean;
}

export type ForecastSummary = "hit" | "partial" | "miss";

export interface CacheForecast {
	summary: ForecastSummary;
	/** One line: `Full cache hit`, `Partial hit: tools and system head hit, history misses (~12,300 tokens rewritten)`, `Cache miss: …`. */
	headline: string;
	/** Estimate of the tokens the first request writes again; null when it cannot be estimated. An inference. */
	rewriteTokens: number | null;
	items: ForecastItem[];
	computedAt: number;
}

// ---------------------------------------------------------------------------
// Gateway -> env daemon operations (link messages `op` / `op.result`)
// ---------------------------------------------------------------------------

/** A file the daemon holds in its handoff directory and the gateway may pull in chunks (`xfer.read`). */
export interface XferInfo {
	/** Daemon-allocated id (`^[A-Za-z0-9_-]{8,80}$`). */
	id: string;
	size: number;
	/** SHA-256 hex of the bytes. */
	sha256: string;
}

export type RepoStateIssue = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export interface SourceInspect {
	session: {
		id: string;
		sessionId: string;
		cwd: string;
		file?: string;
		hosted: boolean;
		access: "hosted" | "free" | "held";
		phase: string;
		title?: string;
	};
	/** Why the session cannot be switched right now (busy, held, never written, ...). */
	sessionBlockers: string[];
	project: { id: string; name: string; root: string; worktree: string } | null;
	repo: {
		head: string;
		branch: string | null;
		detached: boolean;
		/** Set while a merge / rebase / cherry-pick / revert / bisect is in progress: the switch is refused. */
		stateIssue: RepoStateIssue | null;
		/** Up to 256 commits reachable from HEAD, newest first (the target reports which of them it has). */
		recent: string[];
		shallow: boolean;
		preview: CarriedSummary;
	} | null;
	repoBlockers: string[];
}

export interface TargetInspect {
	project: { id: string; name: string; root: string } | null;
	worktrees: TargetWorktree[];
	/** The subset of the source's `recent` commits (given in order) that this repository has completely (reachable closure present). */
	have: string[];
	shallow: boolean;
	newWorktree: { path: string; branch: string } | null;
	gitVersion: string;
}

export interface HandoffLimits {
	/** A carried file (untracked, or modified and tracked) larger than this is skipped and listed. */
	maxFileBytes: number;
	/** The carried bytes of all such files together; once reached the rest is skipped and listed. */
	maxTotalBytes: number;
	/** Bundle / archive size cap on the wire. */
	maxBundleBytes: number;
	maxArchiveBytes: number;
}

export interface HandoffOpArgs {
	"source.inspect": { sessionId: string; limits: HandoffLimits };
	"source.commit": { opId: string; threadId: string; sessionId: string; limits: HandoffLimits };
	"source.capture": { opId: string; sessionId: string };
	"source.bundle": { opId: string; threadId: string; have: string[]; limits: HandoffLimits };
	"source.pack": { opId: string; sessionId: string; limits: HandoffLimits };
	"source.finish": { opId: string; sessionId: string; label: string };
	"target.inspect": {
		projectId: string;
		sourceHead: string;
		recent: string[];
		/** The source's worktree when source and target are on one machine (it is never offered as a target). */
		sourceWorktree?: string;
		threadId: string;
	};
	"target.receive": { opId: string; threadId: string; kind: "bundle" | "session"; size: number; sha256: string };
	/** `projectRoot` must be the registered project root of the matching project; the daemon checks it. */
	"target.fetch": { opId: string; threadId: string; xfer: string; projectRoot: string };
	"target.workspace": {
		opId: string;
		threadId: string;
		projectId: string;
		projectRoot: string;
		choice: TargetChoice;
		base: { commit: string; branch: string | null };
		commit: string;
		indexCommit: string | null;
	};
	/**
	 * `cwd` is the worktree this operation created or reused (the daemon checks it against its record); `subdir` is the
	 * session's working directory relative to its worktree on the source ("" = the root; used when it exists on the target).
	 */
	"target.unpack": {
		opId: string;
		xfer: string;
		cwd: string;
		subdir: string;
		clearAdditionalDirectories: boolean;
	};
	/**
	 * Starts the forked session. The daemon forks from what its own record holds (the unpacked copy, or on a same-machine
	 * switch the source's session file); the gateway never names a path. `historyEntries` is the source's entry count: the
	 * target facts fingerprint exactly that many entries. `fresh`: the source session had no conversation (see
	 * `source.commit`): the daemon starts a new session in `cwd` instead of forking.
	 */
	"target.fork": { opId: string; cwd: string; subdir: string; historyEntries: number; fresh: boolean };
	"target.verify": { opId: string; sessionId: string };
	"op.commit": { opId: string; role: "source" | "target" };
	"op.rollback": { opId: string };
}

export interface HandoffOpResult {
	"source.inspect": SourceInspect;
	"source.commit": {
		commit: string;
		indexCommit: string | null;
		base: { commit: string; branch: string | null; detached: boolean };
		carried: CarriedSummary;
		/**
		 * The session has no conversation and no session file yet (decided once it is reserved): nothing to capture or pack;
		 * the target starts a new session.
		 */
		fresh: boolean;
	};
	"source.capture": { facts: SessionFacts; hosted: boolean };
	"source.bundle": { xfer: XferInfo; full: boolean; prerequisites: number };
	"source.pack": {
		xfer: XferInfo;
		file: string;
		id: string;
		cwd: string;
		/** The session was hosted by the source daemon and its omp process was stopped so the archive could be written. */
		stoppedHosted: boolean;
	};
	"source.finish": { marked: boolean; warning?: string };
	"target.inspect": TargetInspect;
	"target.receive": { xfer: string };
	"target.fetch": { refs: string[] };
	"target.workspace": {
		worktree: string;
		branch: string | null;
		created: boolean;
		/** Files written / removed to make the worktree equal the source's working tree. */
		applied: { written: number; removed: number };
	};
	"target.unpack": { file: string; id: string; dropped: string[] };
	/** `facts` is null for a fresh session: nothing was carried, there is nothing to compare. */
	"target.fork": { sessionId: string; file: string; facts: SessionFacts | null };
	"target.verify": { alive: boolean; detail?: string };
	"op.commit": { cleaned: string[]; warnings: string[] };
	"op.rollback": { removed: string[]; leftovers: string[] };
}

export type HandoffOpName = keyof HandoffOpArgs;

export const HANDOFF_OP_NAMES: readonly HandoffOpName[] = [
	"source.inspect",
	"source.commit",
	"source.capture",
	"source.bundle",
	"source.pack",
	"source.finish",
	"target.inspect",
	"target.receive",
	"target.fetch",
	"target.workspace",
	"target.unpack",
	"target.fork",
	"target.verify",
	"op.commit",
	"op.rollback",
];

export function isHandoffOpName(name: string): name is HandoffOpName {
	return (HANDOFF_OP_NAMES as readonly string[]).includes(name);
}

/** An op error as the daemon reports it: `message` is shown to the user as is. */
export interface HandoffOpError {
	message: string;
	/** `refused`: a precondition failed (nothing was changed); `failed`: a step broke (the operation rolls back). */
	kind: "refused" | "failed";
}

/** Bytes per `xfer.data` / `xfer.write` chunk before base64. */
export const XFER_CHUNK_BYTES = 256 * 1024;
/** Chunks the gateway keeps in flight between a source and a target (bounds its memory at `XFER_WINDOW * XFER_CHUNK_BYTES`). */
export const XFER_WINDOW = 4;

export const XFER_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
export const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
