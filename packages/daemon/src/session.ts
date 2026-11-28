import { basename } from "node:path";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type {
	CredentialPinEntry,
	SessionEntry as OmpSessionEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getNextTimeBasedPricingTransition, getTimeBasedPricingPeriod } from "@oh-my-pi/pi-catalog/models";
import type { ModelCost } from "@oh-my-pi/pi-catalog/types";
import { contextLevel, formatContextUsage } from "@oh-my-pi/pi-coding-agent/ui/status/format";
import type { AgentEvent } from "@oh-my-pi/pi-wire";
import {
	activeBranchIds,
	attentionOf,
	type BtwRecordWire,
	type GoalWire,
	compareBranches,
	defaultCapabilities,
	emptySessionView,
	type GitSummaryWire,
	type PermissionMode,
	type SequencedEvent,
	type SessionBackend,
	type SessionCapabilities,
	type SessionEvent,
	type SessionInfo,
	type SessionOptions,
	type SessionStatus,
	type StatusPatch,
	type SubagentTranscript,
	type UiRequest,
	type UiResponseBody,
} from "@omp-web/protocol";
import type { EventLogOptions } from "./event-log";
import { branchPins } from "./cache-facts";
import { BtwRelay, toBtwWire } from "./btw-relay";
import type { RpcSource } from "./rpc-source";
import { ViewChannel, type SessionHandle, type SessionListener, type SubscribeResult } from "./session-channel";
import { mapUiRequest, toRpcUiResponse } from "./ui-request";
import { serializeWireEvent, toWireEntries } from "./wire-entries";
import { SubagentTracker, toModelOptions, toQueue, toSlashCommands, toTodos } from "./wire-map";
import { terminalOnlyCommand } from "./terminal-commands";
import { gitSummary } from "./git-summary";
import { addSpend, emptySpend, type Spend, SubagentTree } from "./spend";
import { readTranscriptForward, readTranscriptPage } from "./subagent-transcript";
import { LoopMode } from "./loop";

export type { SessionListener, SubscribeResult } from "./session-channel";

/** Agent-event types of pi-wire's `AgentEvent`; the rest of omp's session events are not forwarded. */
const WIRE_EVENT_TYPES = new Set<string>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"notice",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"thinking_level_changed",
]);

/** Events after which committed entries (or the active leaf) may have changed. */
const ENTRY_SYNC_EVENTS = new Set<string>([
	"message_end",
	"turn_end",
	"agent_end",
	"auto_compaction_end",
	"manual_compaction_end",
	"auto_retry_end",
	"thinking_level_changed",
]);

export interface HostedSessionOptions {
	source: RpcSource;
	cwd: string;
	log?: EventLogOptions;
	now?: () => number;
	/** Called when phase, model, title or the session file changed. */
	onInfoChange?: () => void;
	/** Sub-agent frames are batched per agent for this long before they are published (ms). */
	subagentFlushMs?: number;
	/**
	 * Whether omp continues an active goal between runs in RPC mode (`goal.continuationModes` includes `rpc`, as seen
	 * from the session's directory). Absent: assumed not.
	 */
	goalContinuesOverRpc?: () => Promise<boolean>;
}

function modelId(state: RpcSessionState): string | undefined {
	return state.model ? `${state.model.provider}/${state.model.id}` : undefined;
}

function toGoalWire(state: RpcSessionState["goal"]): GoalWire | undefined {
	if (!state) return undefined;
	const { goal } = state;
	return {
		objective: goal.objective,
		status: goal.status,
		...(state.mode === "exiting" ? { exiting: true } : {}),
		tokensUsed: goal.tokensUsed,
		...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
	};
}

/** How often `get_state` is asked again while omp has background work pending (see `#trackBackground`). */
const BACKGROUND_POLL_MS = 5_000;

/** What a loop repeats: plain prompts and skills, not other slash commands (they change the session, not ask the model). */
const loopable = (message: string): boolean => {
	const text = message.trimStart();
	return !text.startsWith("/") || text.startsWith("/skill:");
};

/**
 * One omp session hosted by the daemon: owns the RPC source and the channel (event log + folded view for snapshots).
 *
 * `id` is the omp session id at attach time and never changes: when omp moves the session to a sibling file (another
 * process owned the original) the hosted session keeps its identity and follows the new file
 * (`info.sessionId` / `info.file`, a `notify` event, and an `entries` reset).
 */
export class HostedSession implements SessionHandle {
	readonly #source: RpcSource;
	readonly #backend: SessionBackend;
	readonly #capabilities: SessionCapabilities;
	readonly #channel: ViewChannel;
	readonly #now: () => number;
	readonly #onInfoChange: (() => void) | undefined;
	#pendingUi = new Map<string, UiRequest>();
	/** Append-order cursor for `get_entries(since)`. */
	#lastEntryId: string | undefined;
	/** `id -> parentId` of every entry of the session file (all branches); small, lets leaf changes be resolved locally. */
	#parents = new Map<string, string | null>();
	/** Ids on the active branch, root first, as last published. */
	#branch: string[] = [];
	/** The session file's `credential_pin` entries by id (all branches); {@link #pins} picks those on the active branch. */
	#pinEntries = new Map<string, CredentialPinEntry>();
	#current: { sessionId: string; file: string | undefined };
	#syncRunning = false;
	#syncDirty = false;
	#syncIdle: Promise<void> = Promise.resolve();
	#statusAfterSync = false;
	#info: SessionInfo;
	#closed = false;
	/** Set as soon as a client sends any prompt / interaction so an in-flight first turn is never treated as empty. */
	#prompted = false;
	/** Clients that watch the sub-agents; omp only writes sub-agent frames while there is at least one. */
	#panelOwners = new Set<unknown>();
	/** Whether omp currently sends sub-agent frames and the registry snapshot was published; what the owners are reconciled against. */
	#panelWatching = false;
	#panelChain: Promise<void> = Promise.resolve();
	readonly #subagents = new SubagentTracker();
	/** Transcript paths omp resolved for sub-agents the tracker does not name one for (see {@link agentTranscript}). */
	readonly #transcriptFiles = new Map<string, string>();
	/** Each event carries a whole topic: its size, not the default estimate, goes against the log's byte cap. */
	readonly #btw = new BtwRelay(record => this.#emit({ k: "btw", record }, JSON.stringify(record).length));
	#subagentDirty = new Set<string>();
	#subagentTimer: ReturnType<typeof setTimeout> | null = null;
	readonly #subagentFlushMs: number;
	/** The current model's prices, when they follow a peak/off-peak schedule; the timer flips the period at its edges. */
	#pricingCost: ModelCost | undefined;
	#pricingTimer: ReturnType<typeof setTimeout> | undefined;
	/** What the status line shows besides `get_state`: git refreshed at start and after each run, not per event. */
	#git: GitSummaryWire | undefined;
	/** Spend of every entry seen through `get_entries`, all branches (see {@link addSpend}). */
	#spend: Spend = emptySpend();
	/** The sub-agent transcripts on disk (see {@link SubagentTree}): their spend and agents survive restarts. */
	readonly #tree = new SubagentTree();
	#treeCost = 0;
	#treeScan: Promise<void> | undefined;
	#treeDirty = false;
	#footerRunning = false;
	/** Takes the next builtin command output instead of the shared notices (a report one client asked for). */
	#captureOutput: ((text: string) => void) | undefined;
	#reports: Promise<unknown> = Promise.resolve();
	/** Status line `time_spent`: closed run windows, and the start of the open one. */
	#activeMs = 0;
	#activeSince: number | undefined;
	readonly #loop: LoopMode;
	readonly #goalContinuesOverRpc: (() => Promise<boolean>) | undefined;
	/** Shown when the current run ends (a notice emitted before it would be cleared by its start). */
	#noticeAfterRun: string | undefined;
	/** omp reports background work that will wake the session (see {@link #trackBackground}). */
	#background = false;
	#backgroundTimer: ReturnType<typeof setTimeout> | undefined;

	private constructor(options: HostedSessionOptions, state: RpcSessionState) {
		this.#source = options.source;
		this.#backend = options.source.backend ?? "omp";
		this.#capabilities = defaultCapabilities(this.#backend);
		this.#now = options.now ?? Date.now;
		this.#onInfoChange = options.onInfoChange;
		this.#subagentFlushMs = options.subagentFlushMs ?? 250;
		this.#goalContinuesOverRpc = options.goalContinuesOverRpc;
		this.#channel = new ViewChannel({
			log: options.log,
			now: this.#now,
			afterApply: () => this.#refreshInfo(),
		});
		this.#current = { sessionId: state.sessionId, file: state.sessionFile };
		const now = this.#now();
		this.#info = {
			id: state.sessionId,
			sessionId: state.sessionId,
			access: "hosted",
			cwd: options.cwd,
			phase: "starting",
			createdAt: now,
			modifiedAt: now,
			file: state.sessionFile,
			files: 1,
			aliases: [],
			...(this.#backend !== "omp" ? { backend: this.#backend } : {}),
		};
		this.#loop = new LoopMode({
			cwd: options.cwd,
			sessionId: () => this.#current.sessionId,
			isBusy: async () => {
				const state = await this.#source.getState();
				return state.isStreaming || state.isCompacting || state.queuedMessageCount > 0;
			},
			submit: prompt => this.#source.prompt(prompt),
			notify: (level, message) => this.#emit({ k: "notify", level, message }),
			changed: loop => this.#setStatus({ loop }),
		});
	}

	/**
	 * Attaches to a started source: loads the existing transcript and status into the initial view (not logged:
	 * subscribers get it through a snapshot), then wires live events.
	 */
	static async attach(options: HostedSessionOptions): Promise<HostedSession> {
		const state = await options.source.getState();
		const session = new HostedSession(options, state);
		await session.#init(state);
		return session;
	}

	async #init(state: RpcSessionState): Promise<void> {
		const source = this.#source;
		const entries = await this.#loadActiveBranch();
		await this.#loadFooter();
		const status = this.#statusOf(state);
		this.#trackBackground(state.hasPendingAsyncWork === true);
		const commands = toSlashCommands(await source.getAvailableCommands().catch(() => []));
		const btw = await this.#loadBtw();
		this.#channel.seed({ ...emptySessionView, entries, status, working: status.isStreaming, commands, btw });
		this.#refreshInfo();
		// Listeners attach only now: the child is idle until we send a prompt, and registering earlier would let events
		// fold into a view that the seed above then overwrites.
		source.onSessionEvent(event => this.#onAgentEvent(event));
		source.onExtensionUi(request => this.#onUiRequest(request));
		source.onSessionSettled(() => void this.#loop.settled());
		source.onPromptResult(result => {
			this.#emit({
				k: "prompt_result",
				status: result.status,
				error: result.status === "error" ? (result.error?.message ?? "prompt failed") : undefined,
			});
			// An extension command that finished without starting a turn may have moved the leaf (`navigateTree`).
			if (!result.agentInvoked) this.#afterLocalCommand();
		});
		source.onExit(reason => this.#onExit(reason));
		source.onBtwRecord(record => this.#btw.record(record));
		source.onBtwDelta(frame => this.#btw.delta(frame.recordId, frame.delta));
		source.onAvailableCommands(commands => this.#emit({ k: "commands", commands: toSlashCommands(commands) }));
		source.onSideChannel(frame => {
			if (frame.type !== "command_output") void this.#refreshStatus();
			else if (this.#captureOutput) {
				this.#captureOutput(frame.text);
				this.#captureOutput = undefined;
			} else this.#emit({ k: "notify", level: "info", message: frame.text });
		});
		source.onSubagentProgress(payload => {
			if (this.#panelOwners.size > 0)
				this.#touchSubagent(this.#subagents.applyProgress(payload, this.#now()).agent.id);
		});
		source.onSubagentLifecycle(payload => {
			if (this.#panelOwners.size > 0)
				this.#touchSubagent(this.#subagents.applyLifecycle(payload, this.#now()).agent.id);
		});
		await source.enableAskDialog().catch(() => {
			// Older omp without the opt-in: ask falls back to select/input requests, which are handled too.
		});
		// An ACP server pushes usage and title right after `session/new`/`session/load`, possibly before the listeners
		// above existed; omp's child stays idle until prompted.
		if (this.#backend !== "omp") await this.#refreshStatus();
	}

	get info(): SessionInfo {
		return this.#info;
	}

	get backend(): SessionBackend {
		return this.#backend;
	}

	get capabilities(): SessionCapabilities {
		return this.#capabilities;
	}

	get id(): string {
		return this.#info.id;
	}

	/** Whether no conversation has started in this session yet (fresh, idle, unprompted). */
	get isEmpty(): boolean {
		if (this.#closed || this.#prompted || this.#loop.enabled) return false;
		const view = this.#channel.view;
		if (view.closed !== null || view.working) return false;
		if (this.#info.phase !== "idle") return false;
		if (view.entries.some(e => e.type === "message")) return false;
		const queue = view.status?.queue;
		if (queue && (queue.steering.length > 0 || queue.followUp.length > 0)) return false;
		if (view.uiRequests.length > 0) return false;
		return true;
	}

	get headSeq(): number {
		return this.#channel.headSeq;
	}

	get epoch(): string {
		return this.#channel.epoch;
	}

	/** Retained log events with `seq > lastSeq`, or null when some were evicted. */
	eventsAfter(lastSeq: number): SequencedEvent[] | null {
		return this.#channel.eventsAfter(lastSeq);
	}

	/** Subscribes `listener`; returns what the client needs to reach the current state, then live events follow. */
	subscribe(
		listener: SessionListener,
		lastSeq: number,
		epoch: string | undefined,
	): { result: SubscribeResult; unsubscribe: () => void } {
		return this.#channel.subscribe(listener, lastSeq, epoch);
	}

	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#assertRunnable(message);
		await this.#source.prompt(message, images);
		this.#prompted = true;
		if (loopable(message)) this.#loop.recordPrompt(message);
		// A slash command can change the session without any event omp forwards (tree navigation, a new session,
		// a rename): its acknowledgement is the signal to look again.
		if (message.trimStart().startsWith("/")) this.#afterLocalCommand();
	}

	/** Open, and not a terminal-UI-only command that omp would hand to the model as text. */
	async #assertRunnable(message: string): Promise<void> {
		this.#assertOpen();
		if (this.#backend !== "omp") return;
		const refused = await terminalOnlyCommand(message, this.#channel.view.commands);
		if (refused) throw new Error(refused);
	}

	#afterLocalCommand(): void {
		this.#requestSync(false);
		void this.#refreshFooter();
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		if (!this.#capabilities.steer) {
			throw new Error("This session backend does not support mid-turn steering; use Queue (follow-up) instead.");
		}
		await this.#assertRunnable(message);
		await this.#source.steer(message, images);
		this.#prompted = true;
	}

	/** Stopping a run also pauses the loop (as Esc does in omp's terminal UI): the next prompt sent resumes it. */
	async abort(): Promise<void> {
		this.#assertOpen();
		this.#loop.pause();
		await this.#source.abort();
	}

	/**
	 * Goal mode through omp's RPC `goal`; not together with a loop (both would start the next run). Creating a goal starts
	 * work on it as the terminal UI does: omp itself when it continues goals over RPC, otherwise the objective is sent as
	 * the next prompt (and a notice says the goal then waits for the user's prompts between runs).
	 */
	async goal(
		op: "create" | "pause" | "resume" | "drop",
		options: { objective?: string; tokenBudget?: number } = {},
	): Promise<GoalWire | null> {
		this.#assertOpen();
		if (!this.#capabilities.goal) throw new Error("This session backend does not support /goal mode.");
		const starting = op === "create" || op === "resume";
		if (starting && this.#loop.enabled) throw new Error("Turn loop mode off (/loop) before starting a goal.");
		// Unreadable settings count as "not": the user is then told how to have it continue, never left guessing.
		const continues = starting ? await (this.#goalContinuesOverRpc?.().catch(() => false) ?? false) : true;
		const result = await this.#source.goal(op, options);
		this.#prompted = true;
		const goal = toGoalWire(result.state) ?? null;
		this.#setStatus({ goal: goal ?? undefined });
		if (!continues && goal?.status === "active") {
			const notice =
				'omp continues a goal on its own only in run modes listed in goal.continuationModes, and omp-web sessions run in `rpc` mode: between runs this goal waits for your next prompt. To have it keep going: omp config set goal.continuationModes \'["interactive","rpc"]\'';
			const objective = options.objective?.trim();
			if (op === "create" && objective) {
				// A run's start clears the notices: this one is shown when the run it starts has ended.
				this.#noticeAfterRun = notice;
				if (this.#channel.view.status?.isStreaming) await this.#source.steer(objective);
				else await this.#source.prompt(objective);
			} else this.#emit({ k: "notify", level: "info", message: notice });
		}
		return goal;
	}

	/** `/loop args` (see {@link LoopMode}); an inline prompt starts the first run. */
	async loop(args: string): Promise<void> {
		this.#assertOpen();
		if (!this.#loop.enabled) {
			const goal = this.#channel.view.status?.goal;
			if (goal?.status === "active") throw new Error("Pause or drop the goal (/goal) before starting a loop.");
		}
		const prompt = this.#loop.toggle(args);
		if (prompt !== undefined) await this.prompt(prompt);
	}

	async rename(title: string): Promise<void> {
		this.#assertOpen();
		await this.#source.setSessionName(title);
		await this.#refreshStatus();
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#assertRunnable(message);
		await this.#source.followUp(message, images);
		this.#prompted = true;
	}

	async removeQueued(message: string, queue: "steering" | "followUp"): Promise<boolean> {
		this.#assertOpen();
		return (await this.#source.removeQueuedMessage(message, queue)).removed;
	}

	/**
	 * omp's `/context` report, for the client that asked only: the command's output is taken off the side channel
	 * instead of becoming a notice everyone sees. One report at a time.
	 */
	context(): Promise<string> {
		this.#assertOpen();
		if (!this.#capabilities.context) {
			return Promise.reject(new Error("This session backend does not provide an omp /context report."));
		}
		if (this.#source.getContextReport) {
			return this.#source.getContextReport();
		}
		const run = this.#reports.then(async () => {
			const output = new Promise<string>(resolve => {
				this.#captureOutput = resolve;
			});
			try {
				await this.#source.prompt("/context");
				// The output frame and the command's answer travel separately: give the frame a moment.
				const timeout = Bun.sleep(5_000).then(() => {
					throw new Error("omp did not report the context");
				});
				return await Promise.race([output, timeout]);
			} finally {
				this.#captureOutput = undefined;
			}
		});
		this.#reports = run.catch(() => {});
		return run;
	}

	/** What the pickers offer: models, thinking levels, and (when supported) ACP execution & permission modes. */
	async options(): Promise<SessionOptions> {
		this.#assertOpen();
		const [models, thinkingLevels, modes] = await Promise.all([
			this.#source.getAvailableModels(),
			this.#source.getAvailableThinkingLevels(),
			this.#source.getAvailableModes ? this.#source.getAvailableModes() : Promise.resolve([]),
		]);
		return {
			models: toModelOptions(models),
			thinkingLevels,
			...(modes.length > 0 ? { modes } : {}),
			...(this.#source.setPermissionMode ? { permissionModes: ["ask", "edits", "auto"] as PermissionMode[] } : {}),
		};
	}

	/** Header state follows through omp's own events (`model_changed`); the refresh makes the ack and the state agree. */
	async setModel(provider: string, modelId: string): Promise<void> {
		this.#assertOpen();
		await this.#source.setModel(provider, modelId);
		await this.#refreshStatus();
	}

	async setThinking(level: string): Promise<void> {
		this.#assertOpen();
		const levels = await this.#source.getAvailableThinkingLevels();
		if (!levels.includes(level)) throw new Error(`thinking level "${level}" is not available (${levels.join(", ")})`);
		await this.#source.setThinkingLevel(level);
		await this.#refreshStatus();
	}

	async setMode(modeId: string): Promise<void> {
		this.#assertOpen();
		if (!this.#source.setMode) throw new Error("This session backend does not support switching execution modes.");
		await this.#source.setMode(modeId);
		await this.#refreshStatus();
	}

	async setPermissionMode(mode: PermissionMode): Promise<void> {
		this.#assertOpen();
		if (!this.#source.setPermissionMode) {
			throw new Error("This session backend does not support permission mode selection.");
		}
		await this.#source.setPermissionMode(mode);
		await this.#refreshStatus();
	}

	/** Every client sees the `compaction` events and the new `compaction` entry; the ack only tells the caller. */
	async compact(instructions?: string): Promise<void> {
		this.#assertOpen();
		if (!this.#capabilities.compact) throw new Error("This session backend does not support manual compaction.");
		await this.#source.compact(instructions);
	}

	/**
	 * `owner` (one client connection) starts or stops watching the sub-agents. omp is asked for sub-agent frames
	 * (`"progress"` level: lifecycle and progress, not the raw event stream, which the transcript read does not need)
	 * only while at least one owner watches, and for the registry snapshot when watching starts. Each call reconciles
	 * omp with the owners, one at a time: a failed step (omp busy past the command timeout) leaves `#panelWatching`
	 * unchanged, so the next call (a reopened panel, a resubscribe) tries again instead of failing forever.
	 */
	setAgentPanel(owner: unknown, open: boolean): Promise<void> {
		if (!this.#capabilities.subagents) return Promise.resolve();
		if (open) this.#panelOwners.add(owner);
		else this.#panelOwners.delete(owner);
		const reconcile = async (): Promise<void> => {
			if (this.#closed || this.#channel.view.closed !== null) return;
			const watch = this.#panelOwners.size > 0;
			if (watch === this.#panelWatching) return;
			if (watch) {
				await this.#source.setSubagentSubscription("progress");
				// omp lists only the agents it still runs; the transcripts on disk add every finished or killed one.
				const [live] = await Promise.all([this.#source.getSubagents(), this.#rescanTree()]);
				const onDisk = this.#tree.agents;
				for (const { id, file } of onDisk) this.#transcriptFiles.set(id, file);
				const agents = this.#subagents.replace(live, onDisk, this.#now());
				this.#panelWatching = true;
				this.#emit({ k: "subagents", agents }, 4096);
			} else {
				await this.#source.setSubagentSubscription("off");
				this.#panelWatching = false;
				this.#subagents.clear();
				this.#emit({ k: "subagents", agents: [] });
				// What the watched sub-agents reported is gone with them: the transcripts on disk take over.
				void this.#rescanTree();
			}
			this.#patch(this.#spendStatus());
		};
		const step = this.#panelChain.then(reconcile);
		this.#panelChain = step.catch(() => {});
		return step;
	}

	/**
	 * A read of a sub-agent's transcript: from `fromByte` to the end, the page before `beforeByte`, or (neither) the
	 * latest page, so a long transcript opens at its end without carrying all of it. The daemon reads the file itself once
	 * it knows the path (omp's frames name it); otherwise omp resolves `agentId` and returns everything from `fromByte`.
	 */
	async agentTranscript(
		agentId: string,
		position: { fromByte?: number; beforeByte?: number } = {},
	): Promise<SubagentTranscript> {
		this.#assertOpen();
		if (!this.#capabilities.subagents) {
			throw new Error("This session backend does not expose sub-agent transcripts.");
		}
		const tracked = this.#subagents.get(agentId);
		const file =
			tracked?.progress?.sessionFile ?? tracked?.lifecycle?.sessionFile ?? this.#transcriptFiles.get(agentId);
		if (file) {
			return position.fromByte !== undefined
				? readTranscriptForward(file, position.fromByte)
				: readTranscriptPage(file, position.beforeByte);
		}
		const fromByte = position.fromByte ?? 0;
		const result = await this.#source.getSubagentMessages(agentId, fromByte);
		this.#transcriptFiles.set(agentId, result.sessionFile);
		return {
			entries: toWireEntries(
				result.entries.filter(entry => entry.type !== "session") as { id: string; type: string }[],
			),
			startByte: result.reset ? 0 : result.fromByte,
			nextByte: result.nextByte,
			reset: result.reset,
		};
	}

	#touchSubagent(id: string): void {
		this.#subagentDirty.add(id);
		this.#subagentTimer ??= setTimeout(() => this.#flushSubagents(), this.#subagentFlushMs);
	}

	#flushSubagents(): void {
		this.#subagentTimer = null;
		const ids = [...this.#subagentDirty];
		this.#subagentDirty.clear();
		for (const id of ids) {
			const agent = this.#subagents.get(id);
			if (agent && this.#panelOwners.size > 0) this.#emit({ k: "subagent", agent }, JSON.stringify(agent).length);
		}
		this.#patch(this.#spendStatus());
	}

	/**
	 * The status line's spend, as omp splits it: the session's own, and its sub-agents' — the largest of what finished
	 * `task` results carry, what the watched sub-agents report so far (running ones included) and what the sub-agent
	 * transcripts on disk record (background ones included, whose `task` results carry no usage).
	 */
	#spendStatus(): Pick<SessionStatus, "cost" | "subagentCost" | "premiumRequests"> {
		const { cost, taskCost, premiumRequests } = this.#spend;
		const subagentCost = Math.max(taskCost, this.#subagents.cost, this.#treeCost);
		return {
			cost: Math.max(0, cost - taskCost),
			subagentCost: subagentCost > 0 ? subagentCost : undefined,
			premiumRequests: premiumRequests > 0 ? premiumRequests : undefined,
		};
	}

	/**
	 * Rescans the sub-agent transcripts, one scan at a time (a request during one runs another after it). Resolves once a
	 * scan that started after the call has finished.
	 */
	#rescanTree(): Promise<void> {
		if (!this.#capabilities.subagents) return Promise.resolve();
		this.#treeDirty = true;
		this.#treeScan ??= (async () => {
			const before = this.#treeCost;
			while (this.#treeDirty && !this.#closed) {
				this.#treeDirty = false;
				try {
					this.#treeCost = await this.#tree.scan(this.#current.file);
				} catch {
					// An unreadable transcript tree keeps the last scan; the next run's end retries.
				}
			}
			this.#treeScan = undefined;
			// Only a changed total is news: the rest of the spend follows its own events.
			if (this.#treeCost !== before && !this.#closed && this.#channel.view.closed === null) {
				this.#patch(this.#spendStatus());
			}
		})();
		return this.#treeScan;
	}

	/**
	 * omp's peak/off-peak tariff mark (`↑`/`↓`) for `cost`'s schedule, and a timer that patches it at the next
	 * transition (the status is otherwise only re-read on events).
	 */
	#pricingPeriod(cost: ModelCost | undefined): SessionStatus["pricingPeriod"] {
		this.#pricingCost = cost;
		clearTimeout(this.#pricingTimer);
		this.#pricingTimer = undefined;
		if (!cost || this.#closed) return undefined;
		const now = this.#now();
		const next = getNextTimeBasedPricingTransition(cost, now);
		if (next !== undefined) {
			this.#pricingTimer = setTimeout(() => {
				if (this.#pricingCost === cost) this.#patch({ pricingPeriod: this.#pricingPeriod(cost) });
			}, next - now);
			this.#pricingTimer.unref?.();
		}
		return getTimeBasedPricingPeriod(cost, now);
	}

	respondUi(requestId: string, body: UiResponseBody): void {
		this.#assertOpen();
		if (!this.#pendingUi.delete(requestId)) throw new Error(`unknown or already answered request: ${requestId}`);
		this.#source.respondUi(toRpcUiResponse(requestId, body));
		this.#emit({ k: "ui_end", requestId });
	}

	/** omp's own `get_state` (system prompt blocks, tool dump, model, context usage): what the cache forecast compares. */
	async captureState(): Promise<RpcSessionState> {
		this.#assertOpen();
		return this.#source.getState();
	}

	/**
	 * Why this session cannot be handed to another environment right now, in words for the user; empty when it can: a run or
	 * compaction in progress, queued messages, background work that could wake it, a question waiting for a human.
	 */
	async handoffBlockers(): Promise<string[]> {
		if (!this.#capabilities.handoff) return ["Environment switching is not supported for Antigravity sessions."];
		if (this.#closed || this.#channel.view.closed !== null) return ["The session is closed."];
		const state = await this.#source.getState();
		const blockers: string[] = [];
		if (state.isStreaming) blockers.push("A run is in progress: wait for it to finish or stop it first.");
		if (state.isCompacting) blockers.push("A compaction is in progress: wait for it to finish.");
		if (state.queuedMessageCount > 0)
			blockers.push("Messages are queued for this session: send or remove them first.");
		if (state.hasPendingAsyncWork) blockers.push("Background work is still pending and could wake the session.");
		if (this.#pendingUi.size > 0)
			blockers.push("The session is waiting for an answer to a question: answer it first.");
		return blockers;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#subagentTimer) clearTimeout(this.#subagentTimer);
		this.#subagentTimer = null;
		clearTimeout(this.#pricingTimer);
		clearTimeout(this.#backgroundTimer);
		this.#loop.close();
		await this.#source.stop();
		this.#emit({ k: "closed", reason: "closed by user" });
	}

	/** Resolves when the in-flight entry sync (if any) has finished; for tests and orderly shutdown. */
	whenSynced(): Promise<void> {
		return this.#syncIdle;
	}

	#assertOpen(): void {
		if (this.#closed || this.#channel.view.closed !== null) throw new Error("session is closed");
	}

	#statusOf(state: RpcSessionState): SessionStatus {
		const usage = state.contextUsage;
		const modeState = this.#source.getModeState?.();
		return {
			sessionId: state.sessionId,
			sessionFile: state.sessionFile,
			cwd: this.#info.cwd,
			model: modelId(state),
			pins: this.#pins(),
			modelName: state.model?.name,
			thinkingLevel: state.thinkingLevel,
			sessionName: state.sessionName,
			// A `get_state` answered just before omp flags the run it already announced still counts as running.
			isStreaming: state.isStreaming || this.#activeSince !== undefined,
			isCompacting: state.isCompacting,
			queue: toQueue(state.queuedMessages),
			todos: toTodos(state.todoPhases),
			contextUsage: usage
				? {
						label: formatContextUsage(usage.percent, usage.contextWindow, usage.tokens),
						level: contextLevel(usage.percent, usage.contextWindow),
						...(Number.isFinite(usage.percent) && usage.contextWindow > 0 ? { percent: usage.percent } : {}),
					}
				: undefined,
			autoCompaction: state.autoCompactionEnabled,
			fastMode: state.fastModeActive,
			activeMs: this.#activeMs > 0 ? this.#activeMs : undefined,
			activeSince: this.#activeSince,
			...this.#spendStatus(),
			pricingPeriod: this.#pricingPeriod(state.model?.cost),
			git: this.#git,
			goal: toGoalWire(state.goal),
			loop: this.#loop.wire,
			...(this.#backend !== "omp" ? { backend: this.#backend, capabilities: this.#capabilities } : {}),
			...(modeState?.agentMode ? { agentMode: modeState.agentMode } : {}),
			...(modeState?.agentModeName ? { agentModeName: modeState.agentModeName } : {}),
			...(modeState?.permissionMode ? { permissionMode: modeState.permissionMode } : {}),
		};
	}

	/** Reads the working tree's git state. */
	async #loadFooter(): Promise<void> {
		this.#git = await gitSummary(this.#info.cwd).catch(() => undefined);
	}

	/** {@link #loadFooter}, then the status (one run at a time). */
	async #refreshFooter(): Promise<void> {
		if (this.#footerRunning) return;
		this.#footerRunning = true;
		try {
			await this.#loadFooter();
		} finally {
			this.#footerRunning = false;
		}
		await this.#refreshStatus();
	}

	#refreshInfo(): void {
		const view = this.#channel.view;
		const status = view.status;
		const attention = attentionOf(view);
		const { attention: _previous, ...rest } = this.#info;
		const next: SessionInfo = {
			...rest,
			sessionId: status?.sessionId ?? this.#info.sessionId,
			file: status?.sessionFile ?? this.#info.file,
			model: status?.model,
			title: status?.sessionName,
			// Background work that will wake the run (sub-agents, async jobs) keeps it working after the reply.
			phase: view.closed !== null ? "closed" : view.working || this.#background ? "working" : "idle",
			...(attention ? { attention } : {}),
		};
		const changed =
			next.model !== this.#info.model ||
			next.title !== this.#info.title ||
			next.phase !== this.#info.phase ||
			next.attention !== this.#info.attention ||
			next.sessionId !== this.#info.sessionId ||
			next.file !== this.#info.file;
		// Strictly increasing, so a change in the same millisecond as the previous one still reads as newer (unread markers compare it).
		this.#info = changed ? { ...next, modifiedAt: Math.max(this.#now(), this.#info.modifiedAt + 1) } : this.#info;
		if (changed) this.#onInfoChange?.();
	}

	#emit(ev: SessionEvent, bytes = 256): void {
		this.#channel.emit(ev, bytes);
	}

	/** Replaces some of the status fields as a whole `state` event: a patch cannot clear a field (JSON drops `undefined`). */
	#setStatus(fields: Pick<SessionStatus, "goal" | "loop" | "pins">): void {
		const status = this.#channel.view.status;
		if (!status) return;
		const next = { ...status, ...fields };
		if (JSON.stringify(next) !== JSON.stringify(status)) this.#emit({ k: "state", status: next });
	}

	/**
	 * State that omp announces through its own events is patched from them (no `get_state` round trip); what has no
	 * event carrying the value (model, todos, name) triggers one refresh when its signal event arrives.
	 */
	#trackState(raw: AgentSessionEvent): void {
		switch (raw.type) {
			case "queue_update":
				this.#patch({ queue: { steering: raw.steering, followUp: raw.followUp, liveSteered: raw.liveSteered } });
				break;
			case "auto_compaction_start":
				this.#patch({ isCompacting: true });
				break;
			case "auto_compaction_end":
				this.#patch({ isCompacting: false });
				break;
			case "manual_compaction_start":
				this.#patch({ isCompacting: true });
				this.#emit({ k: "compaction", phase: "start" });
				break;
			case "manual_compaction_end":
				this.#patch({ isCompacting: false });
				this.#emit({
					k: "compaction",
					phase: "end",
					outcome: raw.aborted ? "aborted" : raw.skipped ? "skipped" : raw.errorMessage ? "failed" : "compacted",
					message: raw.errorMessage,
				});
				break;
			case "model_changed":
			case "thinking_level_changed":
			case "todo_auto_clear":
			case "goal_updated":
				void this.#refreshStatus();
				break;
			case "agent_end":
				// A failed run is not a loop yield: repeating the prompt would only add another user turn.
				if (raw.messages.findLast(message => message.role === "assistant")?.stopReason === "error")
					this.#loop.pause();
				break;
			case "tool_execution_end":
				if (raw.toolName === "todo") void this.#refreshStatus();
				break;
		}
	}

	#patch(patch: StatusPatch): void {
		const status = this.#channel.view.status;
		if (!status) return;
		const changed = (Object.keys(patch) as (keyof StatusPatch)[]).filter(
			key => JSON.stringify(status[key]) !== JSON.stringify(patch[key]),
		);
		if (changed.length === 0) return;
		this.#emit({ k: "status_patch", patch }, JSON.stringify(patch).length);
	}

	#onAgentEvent(raw: AgentSessionEvent): void {
		this.#trackState(raw);
		if (raw.type === "manual_compaction_end") this.#requestSync(false);
		if (!WIRE_EVENT_TYPES.has(raw.type)) return;
		const event = this.#toWireEvent(raw);
		const serialized = serializeWireEvent(event);
		this.#emit({ k: "agent", event: serialized.value as unknown as AgentEvent }, serialized.json.length);
		if (raw.type === "agent_start") {
			this.#activeSince ??= this.#now();
			void this.#refreshStatus();
		}
		// Context use, spend and the working tree change with a run.
		if (raw.type === "agent_end") {
			if (this.#activeSince !== undefined) this.#activeMs += Math.max(0, this.#now() - this.#activeSince);
			this.#activeSince = undefined;
			void this.#refreshFooter();
			if (this.#noticeAfterRun !== undefined) {
				this.#emit({ k: "notify", level: "info", message: this.#noticeAfterRun });
				this.#noticeAfterRun = undefined;
			}
		}
		// omp moved this session to a sibling file because another process owned the original.
		if (raw.type === "notice" && raw.source === "session-persistence") void this.#refreshStatus();
		if (ENTRY_SYNC_EVENTS.has(raw.type)) this.#requestSync(raw.type === "agent_end");
	}

	/** Streaming frames carry a duplicate cumulative snapshot (`assistantMessageEvent.partial`) and a `messageId`; drop them. */
	#toWireEvent(raw: AgentSessionEvent): AgentSessionEvent {
		if (raw.type === "message_update") return { type: "message_update", message: raw.message } as AgentSessionEvent;
		return raw;
	}

	#onUiRequest(raw: Parameters<typeof mapUiRequest>[0]): void {
		const mapped = mapUiRequest(raw);
		switch (mapped.kind) {
			case "request":
				this.#pendingUi.set(mapped.request.id, mapped.request);
				this.#emit({ k: "ui", request: mapped.request }, JSON.stringify(mapped.request).length);
				break;
			case "cancel":
				if (this.#pendingUi.delete(mapped.targetId)) this.#emit({ k: "ui_end", requestId: mapped.targetId });
				break;
			case "notify":
				this.#emit({ k: "notify", level: mapped.level, message: mapped.message });
				break;
			case "status":
				this.#emit({ k: "ui_status", key: mapped.key, text: mapped.text });
				break;
			case "widget":
				this.#emit(
					{ k: "ui_widget", key: mapped.key, lines: mapped.lines, placement: mapped.placement },
					256 + (mapped.lines?.join("\n").length ?? 0),
				);
				break;
			case "title":
				this.#emit({ k: "ui_title", title: mapped.title });
				break;
			case "editor_text":
				this.#emit({ k: "editor_text", text: mapped.text }, 256 + mapped.text.length);
				break;
			case "open_url":
				this.#emit({
					k: "open_url",
					url: mapped.url,
					launchUrl: mapped.launchUrl,
					instructions: mapped.instructions,
				});
				break;
			case "unsupported":
				// omp may be waiting on it (a dialog method newer than this daemon): answer it so the turn does not hang.
				this.#source.respondUi({ type: "extension_ui_response", id: mapped.id, cancelled: true });
				this.#emit({
					k: "notify",
					level: "warning",
					message: `omp asked for "${mapped.method}", which omp-web cannot show; it was cancelled.`,
				});
				break;
		}
	}

	#onExit(reason: string): void {
		if (this.#channel.view.closed !== null) return;
		this.#loop.close();
		this.#btw.close();
		this.#pendingUi.clear();
		clearTimeout(this.#pricingTimer);
		clearTimeout(this.#backgroundTimer);
		this.#emit({ k: "closed", reason });
	}

	/** Fetches the whole entry list, rebuilds the parent map, cursor and branch, and returns the active branch's renderable entries. */
	async #loadActiveBranch(): Promise<ReturnType<typeof toWireEntries>> {
		const { entries, leafId } = await this.#source.getEntries();
		this.#parents = new Map(entries.map(entry => [entry.id, entry.parentId]));
		this.#pinEntries = new Map();
		this.#trackPins(entries);
		this.#spend = emptySpend();
		addSpend(this.#spend, entries);
		void this.#rescanTree();
		this.#lastEntryId = entries.at(-1)?.id;
		this.#branch = activeBranchIds(this.#parents, leafId);
		const onBranch = new Set(this.#branch);
		return toWireEntries(entries.filter(entry => onBranch.has(entry.id)));
	}

	#trackPins(entries: readonly OmpSessionEntry[]): void {
		for (const entry of entries) if (entry.type === "credential_pin") this.#pinEntries.set(entry.id, entry);
	}

	/** The latest OAuth account per provider on the active branch (`SessionStatus.pins`). */
	#pins(): SessionStatus["pins"] {
		return branchPins(this.#branch.flatMap(id => this.#pinEntries.get(id) ?? []));
	}

	/** The session file's `/btw` topics by id, newest first; none when omp cannot list them (older omp). */
	async #loadBtw(): Promise<Map<string, BtwRecordWire>> {
		const records = await this.#source.getBtwHistory().catch(() => []);
		return new Map(records.map(record => [record.id, toBtwWire(record)]));
	}

	/**
	 * Asks a `/btw` side question: a new topic, or a follow-up in `recordId`. Resolves with the running topic; its answer
	 * reaches every client as `btw` events.
	 */
	async btw(question: string, recordId?: string): Promise<BtwRecordWire> {
		this.#assertOpen();
		if (!this.#capabilities.btw) throw new Error("This session backend does not support /btw side questions.");
		const record = await this.#source.btw(question, recordId);
		this.#prompted = true;
		return toBtwWire(record);
	}

	async cancelBtw(recordId?: string): Promise<boolean> {
		this.#assertOpen();
		return await this.#source.cancelBtw(recordId);
	}

	/** Replaces the rendered list with the current active branch (leaf moved, or the session file changed). */
	async #reload(): Promise<void> {
		this.#emit({ k: "entries", entries: await this.#loadActiveBranch(), reset: true });
		this.#setStatus({ pins: this.#pins() });
	}

	/**
	 * Entry sync: `get_entries(since=cursor)` after events that may have committed entries or moved the leaf. Responses
	 * arrive in the child's stdout order relative to its events, so the `entries` event lands in the log at the right
	 * point. Requests coalesce: one in flight, a dirty flag re-runs it. `agent_end` additionally refreshes status *after*
	 * entries so a finished ghost is replaced by its entry before the idle state clears ghosts.
	 */
	#requestSync(refreshStatusAfter: boolean): void {
		this.#syncDirty = true;
		if (refreshStatusAfter) this.#statusAfterSync = true;
		if (this.#syncRunning) return;
		this.#syncRunning = true;
		this.#syncIdle = this.#runSync().finally(() => {
			this.#syncRunning = false;
		});
	}

	async #runSync(): Promise<void> {
		while (this.#syncDirty) {
			this.#syncDirty = false;
			try {
				await this.#syncEntries();
			} catch (error) {
				if (this.#channel.view.closed !== null) return;
				this.#emit({
					k: "notify",
					level: "warning",
					message: `entry sync failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
			if (this.#statusAfterSync && !this.#syncDirty) {
				this.#statusAfterSync = false;
				void this.#rescanTree();
				await this.#refreshStatus();
			}
		}
	}

	/** Publishes what changed on the active branch: new entries at its end, or a replacement when the leaf moved elsewhere. */
	async #syncEntries(): Promise<void> {
		let reply: Awaited<ReturnType<RpcSource["getEntries"]>>;
		try {
			reply = await this.#source.getEntries(this.#lastEntryId);
		} catch (error) {
			// The cursor entry is gone (the file was rewritten): start over from the whole list.
			if (this.#lastEntryId !== undefined && /unknown entries cursor/i.test(String(error))) return this.#reload();
			throw error;
		}
		const { entries, leafId } = reply;
		for (const entry of entries) this.#parents.set(entry.id, entry.parentId);
		this.#trackPins(entries);
		addSpend(this.#spend, entries);
		if (entries.length > 0) this.#lastEntryId = entries.at(-1)!.id;
		const next = activeBranchIds(this.#parents, leafId);
		const change = compareBranches(this.#branch, next);
		if (change.kind === "same") return;
		if (change.kind === "extend") {
			const fresh = new Map(entries.map(entry => [entry.id, entry]));
			const appended = change.appended.map(id => fresh.get(id));
			if (appended.every(entry => entry !== undefined)) {
				this.#branch = next;
				const wire = toWireEntries(appended);
				if (wire.length > 0) this.#emit({ k: "entries", entries: wire }, JSON.stringify(wire).length);
				this.#setStatus({ pins: this.#pins() });
				return;
			}
		}
		await this.#reload();
	}

	/**
	 * Whether omp has background work that will wake the session (`hasPendingAsyncWork`: running sub-agents and async
	 * jobs, a delivered result not injected yet). While it has, the session counts as working, and `get_state` is asked
	 * again every {@link BACKGROUND_POLL_MS}: work that ends without waking a run sends no event.
	 */
	#trackBackground(pending: boolean): void {
		clearTimeout(this.#backgroundTimer);
		this.#backgroundTimer = undefined;
		if (pending !== this.#background) {
			this.#background = pending;
			this.#refreshInfo();
		}
		if (!pending || this.#closed || this.#channel.view.closed !== null) return;
		this.#backgroundTimer = setTimeout(() => void this.#refreshStatus(), BACKGROUND_POLL_MS);
		this.#backgroundTimer.unref?.();
	}

	async #refreshStatus(): Promise<void> {
		let state: RpcSessionState;
		try {
			state = await this.#source.getState();
		} catch {
			// Process gone: the exit handler reports it.
			return;
		}
		const status = this.#statusOf(state);
		this.#trackBackground(state.hasPendingAsyncWork === true);
		if (JSON.stringify(status) === JSON.stringify(this.#channel.view.status)) return;
		if (state.sessionId !== this.#current.sessionId || state.sessionFile !== this.#current.file) {
			const from = this.#current;
			this.#current = { sessionId: state.sessionId, file: state.sessionFile };
			this.#emit({
				k: "notify",
				level: "warning",
				message: `The session now continues in ${state.sessionFile ? basename(state.sessionFile) : state.sessionId} (session ${state.sessionId}); ${
					from.file ? basename(from.file) : from.sessionId
				} was left unchanged.`,
			});
			try {
				await this.#reload();
				this.#emit({ k: "btw_history", records: [...(await this.#loadBtw()).values()] });
			} catch (error) {
				this.#emit({
					k: "notify",
					level: "warning",
					message: `reloading the moved session failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		this.#emit({ k: "state", status });
	}
}
