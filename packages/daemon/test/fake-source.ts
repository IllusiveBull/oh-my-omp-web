import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ModelInfo } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type {
	RpcAvailableSlashCommand,
	RpcBtwDeltaFrame,
	RpcBtwHistoryRecord,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcPromptResultFrame,
	RpcSessionState,
	RpcSubagentLifecycleFrame,
	RpcSubagentMessagesResult,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { RpcGoalOp, RpcGoalResult } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { RpcSource, SideChannelFrame } from "../src/rpc-source";

/** In-memory stand-in for the omp child: tests push events/entries and observe the commands the daemon sends. */
export class FakeSource implements RpcSource {
	committed: SessionEntry[];
	state: Partial<RpcSessionState> = {
		sessionId: "sess-1",
		isStreaming: false,
		isCompacting: false,
		queuedMessageCount: 0,
		queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
		todoPhases: [],
		thinkingLevel: ThinkingLevel.High,
	};
	/** Leaf `get_entries` reports; defaults to the last committed entry (omp's append-order leaf). */
	leafId: string | null | undefined;
	names: string[] = [];
	followUps: string[] = [];
	removed: { message: string; queue: string }[] = [];
	models: ModelInfo[] = [];
	thinkingLevels: string[] = ["off", "low", "high"];
	modelCalls: string[] = [];
	thinkingCalls: string[] = [];
	compactions: (string | undefined)[] = [];
	commands: RpcAvailableSlashCommand[] = [];
	subscription: RpcSubagentSubscriptionLevel = "off";
	subscriptionCalls: RpcSubagentSubscriptionLevel[] = [];
	subagents: RpcSubagentSnapshot[] = [];
	subagentTranscripts = new Map<string, RpcSubagentMessagesResult>();
	transcriptReads: { id: string; fromByte: number }[] = [];
	prompts: string[] = [];
	steers: string[] = [];
	aborts = 0;
	uiResponses: RpcExtensionUIResponse[] = [];
	entryRequests: (string | undefined)[] = [];
	stopped = false;
	#events: ((e: AgentSessionEvent) => void)[] = [];
	#ui: ((r: RpcExtensionUIRequest) => void)[] = [];
	#results: ((r: RpcPromptResultFrame) => void)[] = [];
	#exit: ((reason: string) => void)[] = [];
	#commands: ((c: RpcAvailableSlashCommand[]) => void)[] = [];
	#side: ((f: SideChannelFrame) => void)[] = [];
	#lifecycle: ((p: RpcSubagentLifecycleFrame["payload"]) => void)[] = [];
	#progress: ((p: RpcSubagentProgressFrame["payload"]) => void)[] = [];
	#btwRecord: ((r: RpcBtwHistoryRecord) => void)[] = [];
	#btwDelta: ((f: RpcBtwDeltaFrame) => void)[] = [];
	/** What `get_btw_history` returns; `btw` / `cancelBtw` calls are recorded. */
	btwHistory: RpcBtwHistoryRecord[] = [];
	btwCalls: { question: string; recordId?: string }[] = [];
	btwCancels: (string | undefined)[] = [];
	#settled: (() => void)[] = [];
	/** What `goal` answers (a test sets it); every call is recorded. */
	goalResult: RpcGoalResult = { goal: null, state: null };
	goalCalls: { op: RpcGoalOp; objective?: string; tokenBudget?: number }[] = [];

	constructor(initial: SessionEntry[] = [], sessionId = "sess-1") {
		this.committed = [...initial];
		this.state.sessionId = sessionId;
	}

	onSessionEvent(l: (e: AgentSessionEvent) => void): void {
		this.#events.push(l);
	}
	onExtensionUi(l: (r: RpcExtensionUIRequest) => void): void {
		this.#ui.push(l);
	}
	onPromptResult(l: (r: RpcPromptResultFrame) => void): void {
		this.#results.push(l);
	}
	onSessionSettled(l: () => void): void {
		this.#settled.push(l);
	}
	emitSettled(): void {
		for (const l of this.#settled) l();
	}
	async goal(op: RpcGoalOp, options?: { objective?: string; tokenBudget?: number }): Promise<RpcGoalResult> {
		this.goalCalls.push({ op, ...options });
		return this.goalResult;
	}
	onExit(l: (reason: string) => void): void {
		this.#exit.push(l);
	}
	onAvailableCommands(l: (c: RpcAvailableSlashCommand[]) => void): void {
		this.#commands.push(l);
	}
	onSideChannel(l: (f: SideChannelFrame) => void): void {
		this.#side.push(l);
	}
	onSubagentLifecycle(l: (p: RpcSubagentLifecycleFrame["payload"]) => void): void {
		this.#lifecycle.push(l);
	}
	onSubagentProgress(l: (p: RpcSubagentProgressFrame["payload"]) => void): void {
		this.#progress.push(l);
	}
	onBtwRecord(l: (r: RpcBtwHistoryRecord) => void): void {
		this.#btwRecord.push(l);
	}
	onBtwDelta(l: (f: RpcBtwDeltaFrame) => void): void {
		this.#btwDelta.push(l);
	}
	emitBtwRecord(record: RpcBtwHistoryRecord): void {
		for (const l of this.#btwRecord) l(record);
	}
	emitBtwDelta(recordId: string, delta: string): void {
		for (const l of this.#btwDelta) l({ type: "btw_delta", recordId, delta });
	}
	async btw(question: string, recordId?: string): Promise<RpcBtwHistoryRecord> {
		this.btwCalls.push({ question, ...(recordId === undefined ? {} : { recordId }) });
		const record: RpcBtwHistoryRecord = {
			id: recordId ?? `btw-${this.btwCalls.length}`,
			leafId: null,
			question,
			answer: "",
			status: "running",
			createdAt: 1,
			updatedAt: 1,
		};
		this.emitBtwRecord(record);
		return record;
	}
	async cancelBtw(recordId?: string): Promise<boolean> {
		this.btwCancels.push(recordId);
		return true;
	}
	async getBtwHistory(): Promise<readonly RpcBtwHistoryRecord[]> {
		return this.btwHistory;
	}
	emitCommands(commands: RpcAvailableSlashCommand[]): void {
		this.commands = commands;
		for (const l of this.#commands) l(commands);
	}
	emitSide(frame: SideChannelFrame): void {
		for (const l of this.#side) l(frame);
	}
	emitSubagentLifecycle(payload: RpcSubagentLifecycleFrame["payload"]): void {
		for (const l of this.#lifecycle) l(payload);
	}
	emitSubagentProgress(payload: RpcSubagentProgressFrame["payload"]): void {
		for (const l of this.#progress) l(payload);
	}
	async getAvailableCommands(): Promise<RpcAvailableSlashCommand[]> {
		return this.commands;
	}
	async getAvailableModels(): Promise<ModelInfo[]> {
		return this.models;
	}
	async getAvailableThinkingLevels(): Promise<string[]> {
		return this.thinkingLevels;
	}
	async setModel(provider: string, modelId: string): Promise<void> {
		this.modelCalls.push(`${provider}/${modelId}`);
		const model = this.models.find(m => m.provider === provider && m.id === modelId);
		this.state.model = model as never;
	}
	async setThinkingLevel(level: string): Promise<void> {
		this.thinkingCalls.push(level);
		this.state.thinkingLevel = level as never;
	}
	async compact(instructions?: string): Promise<void> {
		this.compactions.push(instructions);
	}
	async followUp(message: string): Promise<void> {
		this.followUps.push(message);
	}
	async removeQueuedMessage(message: string, queue: "steering" | "followUp"): Promise<{ removed: boolean }> {
		this.removed.push({ message, queue });
		return { removed: true };
	}
	async setSubagentSubscription(level: RpcSubagentSubscriptionLevel): Promise<void> {
		this.subscription = level;
		this.subscriptionCalls.push(level);
	}
	async getSubagents(): Promise<RpcSubagentSnapshot[]> {
		return this.subagents;
	}
	async getSubagentMessages(subagentId: string, fromByte: number): Promise<RpcSubagentMessagesResult> {
		this.transcriptReads.push({ id: subagentId, fromByte });
		const result = this.subagentTranscripts.get(subagentId);
		if (!result) throw new Error(`unknown subagent: ${subagentId}`);
		return result;
	}
	emit(event: AgentSessionEvent): void {
		for (const l of this.#events) l(event);
	}
	/** omp's queue changed: `get_state` and the `queue_update` event always agree. */
	emitQueue(steering: string[], followUp: string[], liveSteered = 0): void {
		this.state.queuedMessages = { steering, followUp, liveSteered };
		this.emit({ type: "queue_update", steering, followUp, liveSteered } as AgentSessionEvent);
	}
	emitUi(request: RpcExtensionUIRequest): void {
		for (const l of this.#ui) l(request);
	}
	emitPromptResult(result: RpcPromptResultFrame): void {
		for (const l of this.#results) l(result);
	}
	exit(reason: string): void {
		for (const l of this.#exit) l(reason);
	}
	async getState(): Promise<RpcSessionState> {
		return { ...this.state } as RpcSessionState;
	}
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		this.entryRequests.push(since);
		const leafId = this.leafId === undefined ? (this.committed.at(-1)?.id ?? null) : this.leafId;
		if (since === undefined) return { entries: [...this.committed], leafId };
		const index = this.committed.findIndex(e => e.id === since);
		if (index === -1) throw new Error(`Unknown entries cursor: ${since}`);
		return { entries: this.committed.slice(index + 1), leafId };
	}
	/** Runs when a prompt is accepted: lets a test change the session the way a slash command would. */
	onPrompt: ((message: string) => void) | undefined;
	async prompt(message: string): Promise<void> {
		this.prompts.push(message);
		this.onPrompt?.(message);
	}
	async steer(message: string): Promise<void> {
		this.steers.push(message);
	}
	async abort(): Promise<void> {
		this.aborts++;
	}
	respondUi(response: RpcExtensionUIResponse): void {
		this.uiResponses.push(response);
	}
	async enableAskDialog(): Promise<void> {}
	async setSessionName(name: string): Promise<void> {
		this.names.push(name);
		this.state.sessionName = name;
	}
	async stop(): Promise<void> {
		this.stopped = true;
	}
}

export interface TurnFixture {
	events: AgentSessionEvent[];
	entries: SessionEntry[];
}

/**
 * Replays a recorded turn into `source`. omp commits an entry when the corresponding message ends, so on each
 * `message_end` everything in the recorded entry list up to and including the next entry of that role becomes
 * visible to `get_entries`. `between` runs after every event (tests interleave assertions and extra clients).
 */
export async function replayTurn(
	source: FakeSource,
	fixture: TurnFixture,
	between?: (index: number, event: AgentSessionEvent) => Promise<void> | void,
): Promise<void> {
	let next = source.committed.length;
	for (const [index, event] of fixture.events.entries()) {
		if (event.type === "agent_start") source.state.isStreaming = true;
		if (event.type === "agent_end") source.state.isStreaming = false;
		if (event.type === "message_end") {
			const role = (event.message as { role: string }).role;
			while (next < fixture.entries.length) {
				const entry = fixture.entries[next++]!;
				source.committed.push(entry);
				if (entry.type === "message" && entry.message.role === role) break;
			}
		}
		source.emit(event);
		await between?.(index, event);
		await Bun.sleep(0);
	}
}

export async function loadTurn(): Promise<TurnFixture> {
	return Bun.file(new URL("./fixtures/turn.json", import.meta.url)).json();
}
