/**
 * Wire protocol between browser clients and the `omp-webd` gateway (JSON text frames over one WebSocket at `/ws`).
 *
 * The browser talks only to the gateway. Frames for an environment carry the machine id in `m`; the gateway relays
 * them to that machine's daemon (see `link.ts`) and tags the daemon's answers with the same `m`. The frames an
 * environment daemon itself speaks ({@link ClientMessage}, {@link EnvFrame}) are the pre-gateway session protocol.
 *
 * Reuses upstream's dependency-free `@oh-my-pi/pi-wire` types for everything omp already defines
 * (agent events, session entries). The extension-UI shapes mirror omp's `RpcExtensionUIRequest`
 * structurally: importing it here would drag the whole coding-agent source graph into the web
 * typecheck. The daemon checks the mirror at compile time (`packages/daemon/src/ui-request.ts`).
 */
import type { AuthFrame, AuthMessage, EnvBrokerStatus, UsageReportWire } from "./broker";
import type { FilesClientMessage, FilesErrorCode } from "./files";
import type { HandoffFrame, HandoffMessage, ThreadHop } from "./handoff";
import type { TerminalClientMessage, TerminalEnvFrame } from "./terminal";
import type {
	AgentEvent,
	AgentSnapshot,
	AssistantMessage,
	SessionEntry,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";

/** Bumped on any incompatible change to the frames below. */
export const PROTOCOL_VERSION = 6;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface AntigravityAuthMethodWire {
	id: string;
	name: string;
	description?: string;
}

/** Ack data of `antigravity.auth.status`: what ACP authentication methods this machine's `agy` advertises. */
export interface AntigravityAuthStatusAck {
	available: boolean;
	version?: string;
	authMethods: AntigravityAuthMethodWire[];
	configuredMethod?: string;
	hasGeminiApiKey: boolean;
	loginCommand?: string;
}

/** Ack data of `antigravity.auth.login`. */
export interface AntigravityAuthLoginAck {
	methodId: string;
	authenticated: boolean;
}

/** Ack data of `antigravity.usage`: subscription quota windows read from this machine's Antigravity sign-in. */
export interface AntigravityUsageAck {
	fetchedAt: number;
	report: UsageReportWire | null;
	/** Why quota could not be read (not signed in, expired token, API error); absent when `report` succeeded. */
	unavailable?: {
		reason: "unsupported" | "unauthenticated" | "expired" | "probe_failed";
		message: string;
	};
}

/** Which agent RPC backend drives a session (`omp --mode rpc-ui` or `agy acp`). Absent means `"omp"`. */
export type SessionBackend = "omp" | "antigravity";

/**
 * How Antigravity ACP `session/request_permission` callbacks are handled:
 * - `ask`: prompt the user for every tool permission request.
 * - `edits`: auto-approve reads & file edits, still ask for shell execution / delete / move.
 * - `auto`: auto-approve all permission requests without prompting.
 */
export type PermissionMode = "ask" | "edits" | "auto";

/** One execution mode advertised by an ACP agent (`default`, `accept-edits`, `auto`, `plan`, …). */
export interface SessionModeOption {
	id: string;
	name: string;
	description?: string;
}

/** Interactive features the session's backend supports; older daemons omit it (all omp features enabled). */
export interface SessionCapabilities {
	steer: boolean;
	followUp: boolean;
	compact: boolean;
	btw: boolean;
	goal: boolean;
	loop: boolean;
	subagents: boolean;
	roles: boolean;
	context: boolean;
	fork: boolean;
	handoff: boolean;
}

const OMP_CAPABILITIES: SessionCapabilities = {
	steer: true,
	followUp: true,
	compact: true,
	btw: true,
	goal: true,
	loop: true,
	subagents: true,
	roles: true,
	context: true,
	fork: true,
	handoff: true,
};

const ANTIGRAVITY_CAPABILITIES: SessionCapabilities = {
	steer: true,
	followUp: true,
	compact: false,
	btw: false,
	goal: false,
	loop: true,
	subagents: false,
	roles: false,
	context: true,
	fork: false,
	handoff: false,
};

export function defaultCapabilities(backend: SessionBackend = "omp"): SessionCapabilities {
	return backend === "antigravity" ? { ...ANTIGRAVITY_CAPABILITIES } : { ...OMP_CAPABILITIES };
}

/** `stored`: no omp process of this daemon runs it (it is only a file on disk). */
export type SessionPhase = "starting" | "idle" | "working" | "closed" | "stored";
export type SessionAttention = "input" | "error";

/**
 * Who may write the session right now.
 * - `hosted`: an omp process of this daemon runs it; fully interactive.
 * - `free`: on disk and no live omp process owns it; can be taken over.
 * - `held`: another omp process (typically the TUI) owns its lease; the web shows it read-only.
 */
export type SessionAccess = "hosted" | "free" | "held";

export interface SessionInfo {
	/**
	 * What clients subscribe with. Hosted: the omp session id at attach time, stable when the session later moves to a
	 * sibling file. Stored: the id of the newest file of the conversation; any older file's id resolves to it too.
	 */
	id: string;
	/** omp session id currently written (hosted) or of the newest file of the conversation (stored). */
	sessionId: string;
	access: SessionAccess;
	cwd: string;
	/** `provider/modelId` when known. */
	model?: string;
	title?: string;
	/** First user message, for sessions without a title. */
	preview?: string;
	phase: SessionPhase;
	/** A hosted session waits on a human: an open question (`input`) or its last run ended in an error. */
	attention?: SessionAttention;
	createdAt: number;
	/** Last time the session changed (file mtime on disk, last phase/model/title change when hosted). */
	modifiedAt: number;
	/** Session file currently written / newest file of the conversation. */
	file?: string;
	/** Files folded into this entry (the conversation moved to sibling files, see `continuationOf`). */
	files: number;
	/**
	 * Every other id that names this conversation on its machine (older files, the omp session id of a hosted session
	 * after it moved to a sibling file). The gateway uses them to keep one thread per conversation.
	 */
	aliases: string[];
	/** Registered project root containing `cwd` (set by the daemon from its project registry); absent when none does. */
	projectRoot?: string;
	/** The worktree of that project containing `cwd`. */
	worktreeRoot?: string;
	/** Agent backend driving this session; absent means `"omp"`. */
	backend?: SessionBackend;
}

/** `data` of the ack of `sessions.search`. */
export interface SessionSearchAck {
	/**
	 * Ids of the sessions matching the query, best first (the full ranking, see `rankSessionSearchMatches`, with the
	 * sessions whose recorded prompts matched leading). An id may be any of a listed session's `id` / `aliases`.
	 */
	matches: string[];
}

/** A session as the gateway lists it: the env's entry plus thread identity and the shared unread marker. */
export interface GatewaySessionInfo extends SessionInfo {
	/** The conversation's thread (stable across the ids a conversation goes through). */
	threadId: string;
	/** The session changed after the newest read position any client reported (`read`). Same on every client. */
	unread: boolean;
	/**
	 * The gateway holds a copy of the session's transcript (see {@link ReplicaInfo}); while the machine is offline the
	 * session can still be opened, read-only, from it. Absent when nothing was replicated.
	 */
	replica?: ReplicaInfo;
	/** Every completed move of this thread across environments, oldest first; absent when it never moved. */
	hops?: ThreadHop[];
	/**
	 * This session is the old end of a completed move: the conversation continues at `to`, and this copy is only history
	 * (read-only; the web links to the new location and hides the entry from the list).
	 */
	movedTo?: { machine: string; machineName: string; sessionId: string; at: number };
	/**
	 * An environment switch is in progress for this session (`source`: it is the session being moved; `target`: it is the
	 * forked copy being prepared and is not usable yet). The daemon refuses commands to it meanwhile (`code: "handoff"`).
	 */
	handoff?: { id: string; role: "source" | "target" };
}

/** How much of a session the gateway has copied from its machine, and how old that copy is. */
export interface ReplicaInfo {
	/** `complete`: every file of the conversation is copied up to the version the machine last reported; else catching up. */
	state: "complete" | "partial";
	/** Epoch ms of the newest source file version the copy contains (the file's mtime on the machine). */
	asOf: number;
	/** Epoch ms the gateway last received bytes of it. */
	syncedAt: number;
}

export interface WorktreeInfo {
	path: string;
	/** Branch name, or null for a detached HEAD. */
	branch: string | null;
	/** True for the repository's main worktree. */
	main: boolean;
}

/** A registered project root on one machine. Identity across machines is the first root commit. */
export interface ProjectInfo {
	/** Hash of the repository's first root commit (smallest hash when there are several roots). */
	id: string;
	name: string;
	/** Canonical (symlink-resolved) root path. */
	root: string;
	/** `git worktree list` at the time the daemon last looked. */
	worktrees: WorktreeInfo[];
}

export interface MachineInfo {
	id: string;
	name: string;
	/** The configured/registered name, present when `name` is overridden by a gateway nickname. */
	originalName?: string;
	platform: string;
	/** Home directory reported by this machine, if known; used only for display. */
	home?: string;
	daemonVersion: string;
	omp: DaemonHello["omp"];
	/** Availability of Antigravity ACP (`agy acp`) on this machine; absent on older daemons. */
	antigravity?: DaemonHello["antigravity"];
	/** Why lease probes may be false-negative on that machine; empty when nothing suspicious. */
	leaseWarnings: string[];
	online: boolean;
	/** Registration counter of the live link, bumped on every (re)registration; 0 while the machine never registered. */
	linkId: number;
	/** Epoch ms the machine was last known connected: when it registered, or when its link went away. */
	lastSeen: number;
	/** The machine that hosts this gateway (its env registers in-process). */
	gateway: boolean;
	/** How this machine reaches the credential broker, as it last reported over its link; absent while offline. */
	broker?: EnvBrokerStatus;
}

/** A machine with its registered projects (cached on the gateway, so an offline machine still shows them). */
export interface MachineSummary extends MachineInfo {
	projects: ProjectInfo[];
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

/** Structural mirror of omp's `TodoPhase` (details and notes dropped); the daemon checks it at compile time. */
export interface TodoPhaseWire {
	name: string;
	tasks: { content: string; status: TodoStatus }[];
}

/** The steering / follow-up queue as omp reports it (`queue_update`, `get_state.queuedMessages`). */
export interface QueueWire {
	steering: string[];
	followUp: string[];
	/** The leading `steering` entries already sent into the streaming response; they can no longer be removed. */
	liveSteered: number;
}

/** Structural mirror of omp's `RpcAvailableSlashCommand`; the daemon checks it at compile time. */
export interface SlashCommandWire {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: { name: string; description?: string; usage?: string }[];
	source: "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";
}

/** A model the session can switch to (omp's `ModelInfo`, reduced to what a picker needs). */
export interface ModelOption {
	provider: string;
	id: string;
	contextWindow?: number;
	reasoning?: boolean;
	/**
	 * Thinking settings a model role on this model can carry, as omp's model hub offers them: `inherit` (no suffix: the
	 * session default), `off`, `auto` (not for an unverified ladder), then the model's own efforts. Empty for a model that
	 * does not reason.
	 */
	thinking: ThinkingOptionWire[];
}

/** One thinking setting with omp's label and description (`min`: "Very brief reasoning (~1k tokens)"). */
export interface ThinkingOptionWire {
	value: string;
	label: string;
	description: string;
}

/** Ack data of `session.options`. */
export interface SessionOptions {
	models: ModelOption[];
	/** Selectable thinking levels of the live model, `off` first. */
	thinkingLevels: string[];
	/** Execution modes advertised by the agent (ACP `modes` / `configOptions[category="mode"]`), when supported. */
	modes?: SessionModeOption[];
	/** Selectable permission approval policies for backends that support client-side permission handling. */
	permissionModes?: PermissionMode[];
}

/** One model role of omp's settings (`modelRoles`): what the terminal UI's model hub lists. */
export interface ModelRoleWire {
	/** `default`, `smol`, `slow`, `plan`, …, or a custom role. */
	id: string;
	/** omp's display name (`Fast` for `smol`, …); the id for custom roles. */
	name: string;
	/** omp theme token the terminal UI paints the role's tag in (`success` for `default`, …). */
	color?: string;
	/** As configured (`provider/id`, optionally `:thinking`), effective in the session's directory; absent when unset. */
	selector?: string;
}

/** One omp theme's colours as CSS hex, by omp theme token (`statusLineModel`, `thinkingHigh`, `warning`, …). */
export interface OmpPaletteWire {
	/** The theme's name (`titanium`). */
	name: string;
	[token: string]: string;
}

/** Ack data of `omp.theme`: the terminal UI's dark and light themes as the machine's omp settings name them. */
export interface OmpThemeWire {
	dark: OmpPaletteWire;
	light: OmpPaletteWire;
}

/** Ack data of `session.roles`. */
export interface ModelRolesWire {
	roles: ModelRoleWire[];
	/** omp's `cycleOrder`: the roles its quick switch steps through. */
	cycle: string[];
}

/**
 * One sub-agent as the Agents list shows it: upstream's collab-web `AgentSnapshot` plus the latest progress /
 * lifecycle payloads.
 */
export interface SubagentWire {
	agent: AgentSnapshot;
	progress?: SubagentProgressPayload;
	lifecycle?: SubagentLifecyclePayload;
}

/** One question and its answer in a `/btw` side-question topic (omp's `BtwHistoryTurn`; images are not carried). */
export interface BtwTurnWire {
	question: string;
	answer: string;
	status: "running" | "complete" | "cancelled" | "error" | "interrupted";
	createdAt: number;
	updatedAt: number;
	error?: string;
}

/**
 * A `/btw` topic: its opening turn and the follow-ups asked in it (omp's RPC `RpcBtwHistoryRecord`). Side questions
 * are answered from the session's context without entering its transcript; omp keeps them in a sidecar of the session
 * file, shared with the terminal UI.
 */
export interface BtwRecordWire extends BtwTurnWire {
	id: string;
	/** The session entry the topic was asked at. */
	leafId: string | null;
	followUps?: BtwTurnWire[];
}

/** Ack data of `session.agent_transcript`: the renderable entries of the byte range `[startByte, nextByte)`. */
export interface SubagentTranscript {
	entries: SessionEntry[];
	/** Where `entries` start; pass as `beforeByte` for the page before them (0: there is none). Absent from daemons that
	 * predate paging, which send everything from `fromByte`. */
	startByte?: number;
	/** Pass as `fromByte` next time. */
	nextByte: number;
	/** The file shrank: `entries` replace everything read before. */
	reset: boolean;
}

/** An image attached to a message (pasted into the composer); omp resizes it for the model. */
export interface ImageWire {
	/** Base64 of the bytes. */
	data: string;
	mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/** Largest total of base64 image data in one message: the gateway's frames are capped at 16 MiB. */
export const MAX_MESSAGE_IMAGE_CHARS = 12 * 1024 * 1024;

/** The working directory's git state, as omp's status line shows it (`⑂ main *3 +1 ?2`). */
export interface GitSummaryWire {
	/** Null when detached. */
	branch: string | null;
	staged: number;
	unstaged: number;
	untracked: number;
}

/** The session's goal (omp's goal mode, `/goal`), as its status line shows it. */
export interface GoalWire {
	objective: string;
	status: "active" | "paused" | "budget-limited" | "complete" | "dropped";
	/** omp is still winding a completed goal down. */
	exiting?: boolean;
	tokensUsed: number;
	tokenBudget?: number;
}

/**
 * The session's loop (`/loop`, run by the daemon: omp's RPC mode has none): `waiting` for the prompt to repeat (the
 * next one sent), `running` (repeating `prompt` after each run), `paused` (a stop or a failed run; the next prompt sent
 * resumes it). `limit`: what is left of its count, or when its time runs out (epoch ms); `condition`: its
 * `--while`/`--until` command (`until`: repeats while the command fails).
 */
export interface LoopWire {
	state: "waiting" | "running" | "paused";
	prompt?: string;
	limit?: { kind: "iterations"; remaining: number; initial: number } | { kind: "duration"; deadlineMs: number };
	condition?: { command: string; until: boolean };
}

/** Header-level session state, refreshed by the daemon from `get_state` and patched by omp's own events. */
export interface SessionStatus {
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	model?: string;
	/** The model's display name (`Claude Opus 4.5`). */
	modelName?: string;
	thinkingLevel?: string;
	sessionName?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	queue: QueueWire;
	todos: TodoPhaseWire[];
	/**
	 * Context window use (omp's estimate) as its status line writes it (`2.9%/1M`), the level that colours it there, and
	 * the share of the window used (0–100; absent when the window is unknown) for the progress bar.
	 */
	contextUsage?: { label: string; level: "normal" | "warning" | "purple" | "error"; percent?: number };
	autoCompaction?: boolean;
	fastMode?: boolean;
	/**
	 * How long the agent has worked while this daemon hosted the session (omp's `time_spent`: the union of its
	 * `agent_start`→`agent_end` windows), not counting a run still going; that one started at `activeSince` (epoch ms).
	 */
	activeMs?: number;
	activeSince?: number;
	/** The session's own spend so far (sub-agents not included), in dollars; omp's status line `$…`. */
	cost?: number;
	/** Its sub-agents' spend (finished and, while some client watches them, running ones); omp's `(+…)`. */
	subagentCost?: number;
	/** GitHub Copilot premium requests used; omp's `★ …`. */
	premiumRequests?: number;
	/** Whether the model's scheduled tariff is in its peak or off-peak period now; omp's `↑` / `↓`. */
	pricingPeriod?: "peak" | "off-peak";
	git?: GitSummaryWire;
	/** Absent when the session has no goal. */
	goal?: GoalWire;
	/** Absent while loop mode is off. */
	loop?: LoopWire;
	/**
	 * The OAuth account that served the session last, per provider: the latest `credential_pin` of each provider on the
	 * active branch (`credentialPinHash`, a digest of the account's identity). Absent when no OAuth account served it.
	 */
	pins?: { provider: string; hash: string }[];
	/** Agent backend driving this session; absent means `"omp"`. */
	backend?: SessionBackend;
	/** Capabilities supported by this session's backend; absent means all omp capabilities. */
	capabilities?: SessionCapabilities;
	/** Active ACP agent mode id (`default`, `accept-edits`, `auto`, `plan`, …), when exposed by the agent. */
	agentMode?: string;
	/** Human-readable name of `agentMode`, when different from its id. */
	agentModeName?: string;
	/** Client-side permission approval policy for Antigravity ACP sessions (`ask`, `edits`, `auto`). */
	permissionMode?: PermissionMode;
}

// ---------------------------------------------------------------------------
// Extension UI (omp asks the human something)
// ---------------------------------------------------------------------------

export interface AskQuestion {
	id: string;
	question: string;
	header?: string;
	options: { label: string; description?: string; preview?: string }[];
	multi?: boolean;
	/** Index of the recommended option. */
	recommended?: number;
}

/** Interactive requests only; display-only methods (`setStatus`, `setWidget`, …) are not forwarded. */
export type UiRequest =
	| {
			id: string;
			method: "select";
			title: string;
			options: string[];
			optionDetails?: { description?: string }[];
			/** Index into `options` focused first; for `radio` the row the TUI shows filled. */
			initialIndex?: number;
			/** The ask tool's choice prompts: the first `markableCount` options get a radio or checkbox marker. */
			selectionMarker?: "radio" | "checkbox";
			/** For `checkbox`: indices into `options` currently checked. */
			checkedIndices?: number[];
			/** Leading options that get a marker (default: all); the rest are actions such as "Done selecting". */
			markableCount?: number;
			timeout?: number;
	  }
	| { id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { id: string; method: "input"; title: string; placeholder?: string; secret?: boolean; timeout?: number }
	| { id: string; method: "editor"; title: string; prefill?: string; promptStyle?: boolean }
	| { id: string; method: "ask"; questions: AskQuestion[]; timeout?: number }
	/** omp's `form` dialog: the `ask` tool's whole HTML `<form>`, rendered by the client and answered with `data`. */
	| { id: string; method: "form"; html: string; timeout?: number };

/** Submitted value of one form control: text, a number for `number`/`range` inputs, or a group's checked values. */
export type FormValue = string | number | string[];

/** The human's answer; the daemon turns it into omp's `extension_ui_response`. */
export type UiResponseBody =
	| { value: string }
	| { confirmed: boolean }
	| { cancelled: true }
	| { answers: { id: string; selectedOptions: string[]; customInput?: string }[] }
	/** Answers a `form` request: submitted values by control `name`. */
	| { data: Record<string, FormValue> };

// ---------------------------------------------------------------------------
// Sequenced session events (daemon event log)
// ---------------------------------------------------------------------------

export type PromptOutcome = "completed" | "aborted" | "error";

/**
 * One entry of a session's event log. `seq` is assigned by the daemon, strictly increasing per session
 * (gaps are legal: superseded `message_update` snapshots are dropped from the log).
 */
export type SessionEvent =
	/** omp `AgentSessionEvent`s the transcript renders (pi-wire's `AgentEvent` subset). */
	| { k: "agent"; event: AgentEvent }
	/** Committed session entries, authoritative ids. `reset` replaces the whole list (session attach, branch switch). */
	| { k: "entries"; entries: SessionEntry[]; reset?: boolean }
	/** Full header state from `get_state`. Also carries `isStreaming`, which drives `working`. */
	| { k: "state"; status: SessionStatus }
	/** Fields that omp announces through its own events (`queue_update`, `thinking_level_changed`, compaction); never touches `working`. */
	| { k: "status_patch"; patch: StatusPatch }
	| { k: "ui"; request: UiRequest }
	/** A pending UI request is over (answered by any client, cancelled, or timed out). */
	| { k: "ui_end"; requestId: string }
	/** `setStatus`: one keyed status line of an extension; `text: null` clears it. Session state. */
	| { k: "ui_status"; key: string; text: string | null }
	/** `setWidget`: keyed block of lines of an extension; `lines: null` clears it. Session state. */
	| { k: "ui_widget"; key: string; lines: string[] | null; placement: WidgetPlacement }
	/** `setTitle`. Session state. */
	| { k: "ui_title"; title: string }
	/** `set_editor_text`. One-shot (not in snapshots); the web only ever offers it. */
	| { k: "editor_text"; text: string }
	/** `open_url`. One-shot (not in snapshots); the web shows a prompt the user clicks, never navigates. http(s) only. */
	| { k: "open_url"; url: string; launchUrl?: string; instructions?: string }
	/** The slash-command list (`available_commands_update`). Session state. */
	| { k: "commands"; commands: SlashCommandWire[] }
	/** A manual compaction (`/compact`, RPC `compact`) started or ended; automatic ones arrive as `agent` events. */
	| { k: "compaction"; phase: "start" }
	| { k: "compaction"; phase: "end"; outcome: "compacted" | "aborted" | "skipped" | "failed"; message?: string }
	/** Sub-agents, present only while some client watches them: the whole list. */
	| { k: "subagents"; agents: SubagentWire[] }
	/** One sub-agent changed (progress / lifecycle), coalesced by the daemon. */
	| { k: "subagent"; agent: SubagentWire }
	/** The session's `/btw` topics, newest first (read from omp when the session is attached). Session state. */
	| { k: "btw_history"; records: BtwRecordWire[] }
	/** One `/btw` topic changed (asked, streaming, finished); a newer event for a topic supersedes the older one. */
	| { k: "btw"; record: BtwRecordWire }
	/** Terminal result of one prompt; `error` carries the provider message on failure. */
	| { k: "prompt_result"; status: PromptOutcome; error?: string }
	| { k: "notify"; level: "info" | "warning" | "error"; message: string }
	/** The omp child exited; no further events. */
	| { k: "closed"; reason: string };

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface WidgetWire {
	lines: string[];
	placement: WidgetPlacement;
}

/** The header fields omp reports through events instead of `get_state`, and the spend fields that move between reads. */
export type StatusPatch = Partial<
	Pick<
		SessionStatus,
		"queue" | "thinkingLevel" | "isCompacting" | "cost" | "subagentCost" | "premiumRequests" | "pricingPeriod"
	>
>;

export interface SequencedEvent {
	seq: number;
	ev: SessionEvent;
}

/** JSON-safe form of the folded session state (see `session-view.ts`). */
export interface SessionSnapshot {
	entries: SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ActiveToolWire[];
	working: boolean;
	status: SessionStatus | null;
	uiRequests: UiRequest[];
	notices: NoticeWire[];
	closed: string | null;
	statuses: { key: string; text: string }[];
	widgets: ({ key: string } & WidgetWire)[];
	title: string | null;
	commands: SlashCommandWire[];
	subagents: SubagentWire[];
	/** `/btw` topics, newest first. Absent from daemons older than the BTW panel. */
	btw?: BtwRecordWire[];
}

/** A snapshot without its entries, which travel in `snapshot.chunk` frames. */
export type SnapshotHead = Omit<SessionSnapshot, "entries">;

export interface ActiveToolWire {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

/**
 * A line under the transcript. Notices describe the current turn: the next run (`agent_start`) clears them all. Those
 * tagged with `op` belong to a running operation (a compaction, an automatic retry): when the operation ends they are
 * replaced by its outcome, so no "compacting…" or intermediate warning outlives it.
 */
export interface NoticeWire {
	level: "info" | "warning" | "error";
	message: string;
	at: number;
	op?: "compaction" | "retry";
}

// ---------------------------------------------------------------------------
// Client -> environment daemon (the browser addresses it with `m`, see BrowserMessage)
// ---------------------------------------------------------------------------

export type ClientMessage =
	| { t: "sessions.list"; reqId: string }
	/**
	 * Searches the machine's stored sessions by their transcript text, titles, directories and omp's prompt history.
	 * Acks a {@link SessionSearchAck}.
	 */
	| { t: "sessions.search"; reqId: string; query: string }
	| {
			t: "session.create";
			reqId: string;
			cwd: string;
			model?: string;
			backend?: SessionBackend;
			permissionMode?: PermissionMode;
	  }
	| { t: "session.close"; reqId: string; sessionId: string }
	/**
	 * Takes over a stored session: starts `omp --resume` on it. Refused while another omp process holds its lease
	 * (`code: "held"`) and, for sessions this daemon did not create, until `confirm` is true (`code: "confirm_takeover"`).
	 * Acks `{ sessionId }`, the id to subscribe with.
	 */
	| { t: "session.resume"; reqId: string; sessionId: string; confirm?: boolean }
	/** Copies a session (hosted: must be idle; stored: held or free) into a new hosted session. Acks `{ sessionId }`. */
	| { t: "session.fork"; reqId: string; sessionId: string }
	| { t: "session.rename"; reqId: string; sessionId: string; title: string }
	/**
	 * `lastSeq` 0, a different `epoch` than the daemon's log, or a `lastSeq` outside the retained log yields a snapshot
	 * instead of a replay.
	 */
	| { t: "subscribe"; reqId: string; sessionId: string; lastSeq: number; epoch?: string }
	| { t: "unsubscribe"; reqId: string; sessionId: string }
	| { t: "prompt"; reqId: string; sessionId: string; message: string; images?: ImageWire[] }
	/** Interrupt a running turn with a new message. */
	| { t: "steer"; reqId: string; sessionId: string; message: string; images?: ImageWire[] }
	/** Queue a message for after the running turn. */
	| { t: "follow_up"; reqId: string; sessionId: string; message: string; images?: ImageWire[] }
	/** Withdraws a still-pending queued message (the text shown in the queue). Acks `{ removed }`. */
	| { t: "queue.remove"; reqId: string; sessionId: string; message: string; queue: "steering" | "followUp" }
	| { t: "abort"; reqId: string; sessionId: string }
	| { t: "ui.response"; reqId: string; sessionId: string; requestId: string; response: UiResponseBody }
	/** Models and thinking levels the session can switch to now. Acks a {@link SessionOptions}. */
	| { t: "session.options"; reqId: string; sessionId: string }
	| { t: "session.set_model"; reqId: string; sessionId: string; provider: string; modelId: string }
	| { t: "session.set_thinking"; reqId: string; sessionId: string; level: string }
	/** Switches an ACP session's execution mode (`session/set_mode` or `configOptions[category="mode"]`). */
	| { t: "session.set_mode"; reqId: string; sessionId: string; mode: string }
	/** Changes how an Antigravity ACP session handles `session/request_permission` (`ask`, `edits`, `auto`). */
	| { t: "session.set_permission_mode"; reqId: string; sessionId: string; mode: PermissionMode }
	/** The colours of the machine's omp themes, so the web shows omp's status line as the terminal does. Acks {@link OmpThemeWire}. */
	| { t: "omp.theme"; reqId: string }
	/** omp's `/context` report for the session (what fills the context window). Acks `{ text }`. */
	| { t: "session.context"; reqId: string; sessionId: string }
	/** The model roles as seen from the session's directory. Acks a {@link ModelRolesWire}. */
	| { t: "session.roles"; reqId: string; sessionId: string }
	/**
	 * Assigns `selector` to a role in omp's global settings (null clears it). Acks `{ warning? }` when another settings
	 * layer still decides the role in the session's directory. Does not change the session's own model.
	 */
	| { t: "session.set_role"; reqId: string; sessionId: string; role: string; selector: string | null }
	/** Manual compaction. Acks when it ends; every client sees it through the `compaction` events either way. */
	| { t: "session.compact"; reqId: string; sessionId: string; instructions?: string }
	/**
	 * Whether this client watches the session's sub-agents (the web UI does while it shows a hosted session). The daemon
	 * asks omp for sub-agent frames (`set_subagent_subscription: "progress"`) while at least one client does, and turns
	 * them off when the last one stops or disconnects.
	 */
	| { t: "session.agents"; reqId: string; sessionId: string; open: boolean }
	/**
	 * Asks a `/btw` side question (a new topic, or a follow-up in topic `recordId`). Acks `{ record }` once it runs; the
	 * answer streams to every client as `btw` events. omp runs one side question at a time.
	 */
	| { t: "session.btw"; reqId: string; sessionId: string; question: string; recordId?: string }
	/** Cancels the running side question (only if it is `recordId`, when given). Acks `{ cancelled }`. */
	| { t: "session.btw_cancel"; reqId: string; sessionId: string; recordId?: string }
	/**
	 * Goal mode (omp's RPC `goal`): `create` sets `objective` (with an optional token budget) and starts working on it,
	 * `pause`/`resume`/`drop` act on the current goal. Acks `{ goal }` (a {@link GoalWire}, or null); every client sees
	 * the change in the status.
	 */
	| {
			t: "session.goal";
			reqId: string;
			sessionId: string;
			op: "create" | "pause" | "resume" | "drop";
			objective?: string;
			tokenBudget?: number;
	  }
	/**
	 * `/loop [count|duration] [--while|--until '<cmd>'] [prompt]` (omp's argument syntax): turns loop mode on (a given
	 * prompt starts its first run), or off when it is on. Acks nothing; every client sees the change in the status.
	 */
	| { t: "session.loop"; reqId: string; sessionId: string; args: string }
	/**
	 * A read of a sub-agent's transcript: everything from `fromByte`, the page that ends at `beforeByte`, or (neither) the
	 * latest page. Acks a {@link SubagentTranscript}.
	 */
	| {
			t: "session.agent_transcript";
			reqId: string;
			sessionId: string;
			agentId: string;
			fromByte?: number;
			beforeByte?: number;
	  }
	/**
	 * Registers a git repository as a project on the machine: `path` is resolved (symlinks) and must be a directory inside
	 * a git worktree with at least one commit; the project root is that worktree's top level. Acks a {@link ProjectInfo}.
	 */
	| { t: "project.add"; reqId: string; path: string }
	/** Forgets a registered project root (sessions on disk stay). Acks nothing. */
	| { t: "project.remove"; reqId: string; root: string }
	/** Re-reads `git worktree list` of every registered project and pushes the result. Acks the list. */
	| { t: "project.list"; reqId: string }
	/** Queries ACP auth methods advertised by this machine's Antigravity CLI. Acks {@link AntigravityAuthStatusAck}. */
	| { t: "antigravity.auth.status"; reqId: string }
	/** Runs ACP `authenticate` with `methodId` on this machine. Acks {@link AntigravityAuthLoginAck}. */
	| { t: "antigravity.auth.login"; reqId: string; methodId: string }
	/** Queries Antigravity subscription quota limits on this machine. Acks {@link AntigravityUsageAck}. */
	| { t: "antigravity.usage"; reqId: string }
	/** Persistent shells (`term.*`), see terminal.ts. */
	| TerminalClientMessage
	/** Read-only file browsing of a registered worktree (`files.*`), see files.ts. */
	| FilesClientMessage;

export type ClientMessageType = ClientMessage["t"];

// ---------------------------------------------------------------------------
// Environment daemon -> client
// ---------------------------------------------------------------------------

/** What a daemon reports about itself and its omp when it registers with the gateway. */
export interface DaemonHello {
	protocol: number;
	daemonVersion: string;
	/** This daemon's home directory, for machine-specific path labels. */
	home?: string;
	omp: {
		/** `omp --version` of the installed binary. */
		version: string;
		/** Version of the vendored upstream tag this build was typed against. */
		expectedVersion: string;
		/** True when the two differ: the UI should warn (functionality may drift). */
		versionMismatch: boolean;
	};
	/** Availability of Antigravity ACP (`agy acp`) on this machine; absent on older daemons. */
	antigravity?: {
		available: boolean;
		version?: string;
	};
	/** Why lease probes (held/free) may be false-negative on this machine; empty when nothing suspicious. */
	leaseWarnings: string[];
}

/** Machine-readable reason of a failed request that the UI reacts to. */
export type AckErrorCode =
	| "held"
	| "confirm_takeover"
	| "terminal_disabled"
	| "handoff"
	| "auth_required"
	| FilesErrorCode;

/** What an environment daemon sends one client (virtual or real): answers and the session streams. */
export type EnvFrame =
	| { t: "ack"; reqId: string; ok: true; data?: unknown }
	| { t: "ack"; reqId: string; ok: false; error: string; code?: AckErrorCode }
	/**
	 * A snapshot is sent as `snapshot.begin`, one or more `snapshot.chunk`, `snapshot.end`, so that no frame carries the
	 * whole of a large session. The client assembles them and applies the snapshot atomically at `end`
	 * (see `SnapshotAssembler`); events for the session only follow after `end`. `epoch` identifies the daemon-side log
	 * `seq` belongs to; clients send it back with `lastSeq`.
	 */
	| {
			t: "snapshot.begin";
			sessionId: string;
			snapshotId: string;
			seq: number;
			epoch: string;
			head: SnapshotHead;
			entryCount: number;
	  }
	| { t: "snapshot.chunk"; sessionId: string; snapshotId: string; entries: SessionEntry[] }
	| { t: "snapshot.end"; sessionId: string; snapshotId: string }
	/** Replay of a gap-free tail after `lastSeq`, or live events. Delivered in seq order. */
	| { t: "events"; sessionId: string; events: SequencedEvent[] }
	/** Terminal list, output and lifecycle (`term.*`), see terminal.ts. */
	| TerminalEnvFrame;

// ---------------------------------------------------------------------------
// Browser <-> gateway
// ---------------------------------------------------------------------------

/** A request for one machine's daemon: any {@link ClientMessage} with the machine id. The gateway relays it. */
export type AddressedMessage = ClientMessage extends infer M
	? M extends ClientMessage
		? M & { m: string }
		: never
	: never;

/**
 * A client reports how far it has read a session. The gateway keeps the newest per thread and tells every client
 * through the `unread` flag of the session list. `modifiedAt` is the session's `modifiedAt` as the client last
 * saw it, in milliseconds on the session's machine (possibly fractional for a file mtime). `seq` / `epoch`
 * are the event position.
 */
export interface ReadMessage {
	t: "read";
	reqId: string;
	m: string;
	sessionId: string;
	seq: number;
	epoch?: string;
	modifiedAt: number;
}

/**
 * Which session this connection is looking at, and whether its page is visible. The gateway does not push-notify a
 * thread that a visible client is looking at. `sessionId: null` = no session open. Acks `{}`.
 */
export interface ViewMessage {
	t: "view";
	reqId: string;
	m: string;
	sessionId: string | null;
	visible: boolean;
}

export type BrowserMessage = AddressedMessage | ReadMessage | ViewMessage | AuthMessage | HandoffMessage;

/** First frame the gateway sends a browser. `machine` is the id of the machine the gateway itself runs on. */
export interface GatewayHello {
	t: "hello";
	protocol: number;
	gatewayVersion: string;
	machine: string;
}

/** Frames the gateway originates (not relayed from a daemon). */
export type GatewayFrame =
	| GatewayHello
	/** Broker status, accounts, the login flow and usage (see `broker.ts`); each replaced wholesale, sent on connect and on change. */
	| AuthFrame
	/** The environment switches in progress and recently finished (`handoff.ts`), replaced wholesale on every change. */
	| HandoffFrame
	/** Every machine, replaced wholesale on each change. Reconnecting daemons change `linkId` (see {@link MachineInfo}). */
	| { t: "machines"; machines: MachineSummary[] }
	/** One machine's session list, replaced wholesale; for an offline machine it is the gateway's cached copy. */
	| { t: "sessions"; m: string; sessions: GatewaySessionInfo[] }
	/** Answer to a request the gateway handled itself (`read`) or could not forward (machine offline). */
	| { t: "ack"; reqId: string; ok: true; data?: unknown; m?: string }
	| { t: "ack"; reqId: string; ok: false; error: string; code?: AckErrorCode; m?: string };

/** A daemon's answer or stream frame as the browser receives it: the daemon's frame plus the machine id. */
export type RelayedFrame = EnvFrame extends infer F ? (F extends EnvFrame ? F & { m: string } : never) : never;

/** Everything a browser can receive over `/ws`. */
export type ServerMessage = GatewayFrame | RelayedFrame;

export type Ack = Extract<ServerMessage, { t: "ack" }>;

export function isServerMessage(value: unknown): value is ServerMessage {
	return typeof value === "object" && value !== null && typeof (value as { t?: unknown }).t === "string";
}
