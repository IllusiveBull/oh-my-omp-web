import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ModelInfo } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type {
	RpcAvailableSlashCommand,
	RpcBtwDeltaFrame,
	RpcBtwHistoryRecord,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcPromptResultFrame,
	RpcRemoveQueuedMessageResult,
	RpcSessionState,
	RpcSubagentLifecycleFrame,
	RpcSubagentMessagesResult,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { RpcGoalOp, RpcGoalResult } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import type { SessionEntry as OmpSessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { PermissionMode, SessionBackend, SessionModeOption } from "@omp-web/protocol";

/**
 * Frames omp writes for builtin slash commands (`rpc-mode.ts`: `command_output`, `session_info_update`,
 * `config_update`). `RpcClient` does not surface them, so the source taps them from stdout.
 */
export type SideChannelFrame =
	| { type: "command_output"; text: string }
	| { type: "session_info_update" }
	| { type: "config_update" };

/** What a hosted session needs from the agent process; real implementations are `OmpRpcSource` and `AntigravityAcpSource`. */
export interface RpcSource {
	/** Which agent backend this source drives; absent means `"omp"`. */
	readonly backend?: SessionBackend;
	onSessionEvent(listener: (event: AgentSessionEvent) => void): void;
	onExtensionUi(listener: (request: RpcExtensionUIRequest) => void): void;
	/** omp's `session_settled`: the run ended (waits on background subagents included) and nothing is queued. */
	onSessionSettled(listener: () => void): void;
	onPromptResult(listener: (result: RpcPromptResultFrame) => void): void;
	/** Slash-command list, pushed at startup and whenever command metadata changes. */
	onAvailableCommands(listener: (commands: RpcAvailableSlashCommand[]) => void): void;
	onSideChannel(listener: (frame: SideChannelFrame) => void): void;
	/** Sub-agent frames; omp only writes them while the subscription level is not `off`. */
	onSubagentLifecycle(listener: (payload: RpcSubagentLifecycleFrame["payload"]) => void): void;
	onSubagentProgress(listener: (payload: RpcSubagentProgressFrame["payload"]) => void): void;
	/** `/btw` side questions: the full topic on every lifecycle change, and text appended to the running answer. */
	onBtwRecord(listener: (record: RpcBtwHistoryRecord) => void): void;
	onBtwDelta(listener: (frame: RpcBtwDeltaFrame) => void): void;
	/** Fires once when the omp child exits or its output stream ends. */
	onExit(listener: (reason: string) => void): void;
	getState(): Promise<RpcSessionState>;
	getEntries(since?: string): Promise<{ entries: OmpSessionEntry[]; leafId: string | null }>;
	getAvailableCommands(): Promise<RpcAvailableSlashCommand[]>;
	getAvailableModels(): Promise<ModelInfo[]>;
	getAvailableThinkingLevels(): Promise<string[]>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	/** ACP execution modes advertised by the agent (`default`, `accept-edits`, `auto`, `plan`, …), when supported. */
	getAvailableModes?(): Promise<SessionModeOption[]>;
	/** Switches the active ACP execution mode. */
	setMode?(modeId: string): Promise<void>;
	/** Changes client-side permission auto-approval policy (`ask`, `edits`, `auto`). */
	setPermissionMode?(mode: PermissionMode): Promise<void>;
	/** Current ACP mode and permission approval policy, for header status. */
	getModeState?(): { agentMode?: string; agentModeName?: string; permissionMode?: PermissionMode };
	/** Custom `/context`-style text report when the backend generates it without running omp's `/context` slash command. */
	getContextReport?(): Promise<string>;
	/** Resolves when the compaction ended (it can take a minute); failures reject. */
	compact(instructions?: string): Promise<void>;
	prompt(message: string, images?: ImageContent[]): Promise<void>;
	steer(message: string, images?: ImageContent[]): Promise<void>;
	followUp(message: string, images?: ImageContent[]): Promise<void>;
	removeQueuedMessage(message: string, queue: "steering" | "followUp"): Promise<RpcRemoveQueuedMessageResult>;
	abort(): Promise<void>;
	respondUi(response: RpcExtensionUIResponse): void;
	/** Opt in to omp's structured `ask` dialog (otherwise it falls back to select/input). */
	enableAskDialog(): Promise<void>;
	/** `set_session_name`: renames the running session (omp writes the title into the session file). */
	setSessionName(name: string): Promise<void>;
	setSubagentSubscription(level: RpcSubagentSubscriptionLevel): Promise<void>;
	/** Asks a side question (a follow-up in topic `recordId` when given); resolves with the running topic. */
	btw(question: string, recordId?: string): Promise<RpcBtwHistoryRecord>;
	cancelBtw(recordId?: string): Promise<boolean>;
	/** The session's side-question topics, newest first. */
	getBtwHistory(): Promise<readonly RpcBtwHistoryRecord[]>;
	getSubagents(): Promise<RpcSubagentSnapshot[]>;
	/** omp's RPC `goal` (goal mode, `/goal`). */
	goal(op: RpcGoalOp, options?: { objective?: string; tokenBudget?: number }): Promise<RpcGoalResult>;
	getSubagentMessages(subagentId: string, fromByte: number): Promise<RpcSubagentMessagesResult>;
	stop(): Promise<void>;
}
