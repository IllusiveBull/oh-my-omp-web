import type { ImageContent } from "@oh-my-pi/pi-ai";
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
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry as OmpSessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type {
	AssistantContent,
	AssistantMessage,
	MessageEntry,
	SessionEntry,
	StopReason,
	TextContent,
	ToolResultMessage,
	UserMessage,
	WireMessage,
} from "@oh-my-pi/pi-wire";
import type {
	AntigravityAuthLoginAck,
	AntigravityAuthMethodWire,
	AntigravityAuthStatusAck,
	PermissionMode,
	SessionBackend,
	SessionModeOption,
} from "@omp-web/protocol";
import pkg from "../package.json";
import type { AntigravityBinary } from "./antigravity-binary";
import {
	findAntigravityConversationDb,
	formatAntigravityContextReport,
	readAntigravityConversationUsage,
	type AntigravityConversationUsage,
} from "./antigravity-db";
import { loadAntigravityTranscript } from "./antigravity-sessions";
import {
	antigravityCallCostUsd,
	antigravityModelContextWindow,
	antigravityModelCost,
	antigravityTurnUsage,
} from "./antigravity-pricing";
import { extractReadLineRange, pathFromInput, readLocalFileFallback } from "./antigravity-read";
import { posixQuote } from "./login-kinds";
import type { RpcSource, SideChannelFrame } from "./rpc-source";

/** JSON-RPC 2.0 error returned by an ACP server (code -32000 indicates authentication required in ACP v1). */
export class AcpRpcError extends Error {
	constructor(
		message: string,
		readonly rpcCode?: number,
		readonly data?: unknown,
	) {
		super(message);
	}
}

/** Raised when `agy acp` requires authentication before creating or resuming a session. */
export class AntigravityAuthError extends Error {
	readonly code = "auth_required" as const;
	constructor(
		message: string,
		readonly authMethods: AntigravityAuthMethodWire[],
		readonly loginCommand: string,
	) {
		super(message);
	}
}

const ACP_AUTH_REQUIRED_CODE = -32000;

export function antigravityLoginCommand(binary: Pick<AntigravityBinary, "path" | "args">): string {
	const bin = /^[A-Za-z0-9._/@:-]+$/.test(binary.path) ? binary.path : posixQuote(binary.path);
	const args = binary.args.length > 0 ? binary.args : ["acp"];
	const withLogin = args.includes("--login") ? args : [...args, "--login"];
	return [bin, ...withLogin.map(a => (/^[A-Za-z0-9._/@:-]+$/.test(a) ? a : posixQuote(a)))].join(" ");
}

function parseAuthMethods(raw: unknown): AntigravityAuthMethodWire[] {
	if (!Array.isArray(raw)) return [];
	const out: AntigravityAuthMethodWire[] = [];
	for (const item of raw) {
		if (!isRecord(item) || typeof item.id !== "string" || !item.id) continue;
		out.push({
			id: item.id,
			name: typeof item.name === "string" && item.name ? item.name : item.id,
			...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
		});
	}
	return out;
}

function isAuthRequiredError(error: unknown): boolean {
	if (error instanceof AcpRpcError && error.rpcCode === ACP_AUTH_REQUIRED_CODE) return true;
	const text = error instanceof Error ? error.message : String(error);
	return /auth(?:entication)?\s+required|unauthenticated|not\s+authenticated|please\s+log\s*in/i.test(text);
}

export interface AntigravityAcpOptions {
	/** Absolute path of the `agy` binary (or custom ACP wrapper). */
	binaryPath: string;
	/** Arguments to start ACP mode (default `["acp"]`). */
	args?: string[];
	/** Preferred ACP `authenticate` methodId (e.g. `oauth-personal` or `gemini-api-key`). */
	authMethod?: string;
	/** Initial ACP execution mode id (e.g. `auto`, `accept-edits`, `plan`), when supported by the server. */
	mode?: string;
	/** Initial client-side permission approval policy (`ask`, `edits`, `auto`; default `auto`). */
	permissionMode?: PermissionMode;
	cwd: string;
	/** Optional initial model selector (`antigravity/<id>` or `antigravity/<id>:<thinking>`). */
	model?: string;
	/** Existing Antigravity session ID to resume via `session/load`. */
	resumeSessionId?: string;
	/** Optional local transcript path used as history fallback when `session/load` does not replay turns. */
	transcriptPath?: string;
	/** Optional override for locating Antigravity conversation SQLite DBs (tests). */
	conversationsDirs?: string[];
	/** Optional persisted title override (e.g. renamed via `omp-web`). */
	initialTitle?: string;
	/** Extra environment variables for the child process. */
	env?: Record<string, string>;
	/** Called when session metadata (title, preview, model, activity) changes so the daemon registry can persist it. */
	onMetadata?: (patch: {
		id: string;
		cwd: string;
		title?: string;
		preview?: string;
		model?: string;
		messageCount?: number;
	}) => void;
	/** Timeout for non-prompt JSON-RPC control requests (ms). */
	requestTimeoutMs?: number;
}

interface AcpOptionItem {
	value: string;
	name: string;
	description?: string;
}

interface AcpConfigOption {
	id: string;
	name: string;
	category?: string;
	type?: string;
	currentValue?: string;
	options: AcpOptionItem[];
}

interface PendingRpcRequest {
	method: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

interface PendingPermission {
	rpcId: number | string;
	toolKind?: string;
	options: { label: string; optionId: string; kind?: string }[];
}

interface TrackedToolCall {
	toolCallId: string;
	toolName: string;
	title?: string;
	args: Record<string, unknown>;
	status: string;
	outputText: string;
	outputImages: ImageContent[];
	details?: unknown;
	completed: boolean;
}

interface QueuedFollowUp {
	message: string;
	images?: ImageContent[];
}

interface PendingSteer {
	message: string;
	images?: ImageContent[];
	timestamp: number;
}

const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const ACP_PROTOCOL_VERSION = 1;
const PROVIDER_NAME = "antigravity";
/** Quiet time after a model call (`usage_update`) that ends a run agy started on its own: a step's tool calls follow at once. */
const WAKE_SETTLE_MS = 1_500;
/** Quiet time that ends such a run without a closing model call; a later update simply starts another one. */
const WAKE_IDLE_MS = 60_000;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { total: 0 },
};

function flattenConfigOptions(raw: unknown): AcpOptionItem[] {
	if (!Array.isArray(raw)) return [];
	const out: AcpOptionItem[] = [];
	for (const item of raw) {
		if (!isRecord(item)) continue;
		if (Array.isArray(item.options)) {
			// Grouped select options ({ group, name, options: [...] }).
			for (const nested of item.options) {
				if (isRecord(nested) && typeof nested.value === "string") {
					out.push({
						value: nested.value,
						name: typeof nested.name === "string" ? nested.name : nested.value,
						...(typeof nested.description === "string" ? { description: nested.description } : {}),
					});
				}
			}
		} else if (typeof item.value === "string") {
			out.push({
				value: item.value,
				name: typeof item.name === "string" ? item.name : item.value,
				...(typeof item.description === "string" ? { description: item.description } : {}),
			});
		}
	}
	return out;
}

function parseConfigOptions(raw: unknown): AcpConfigOption[] {
	if (!Array.isArray(raw)) return [];
	const out: AcpConfigOption[] = [];
	for (const item of raw) {
		if (!isRecord(item) || typeof item.id !== "string") continue;
		out.push({
			id: item.id,
			name: typeof item.name === "string" ? item.name : item.id,
			...(typeof item.category === "string" ? { category: item.category } : {}),
			...(typeof item.type === "string" ? { type: item.type } : {}),
			...(typeof item.currentValue === "string" ? { currentValue: item.currentValue } : {}),
			options: flattenConfigOptions(item.options),
		});
	}
	return out;
}

function parseLegacyModes(raw: unknown): { currentModeId?: string; modes: SessionModeOption[] } | null {
	if (!isRecord(raw)) return null;
	const available = Array.isArray(raw.availableModes) ? raw.availableModes : [];
	const modes: SessionModeOption[] = [];
	for (const item of available) {
		if (!isRecord(item) || typeof item.id !== "string" || !item.id) continue;
		modes.push({
			id: item.id,
			name: typeof item.name === "string" && item.name ? item.name : item.id,
			...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
		});
	}
	const currentModeId = typeof raw.currentModeId === "string" ? raw.currentModeId : undefined;
	return modes.length > 0 || currentModeId ? { currentModeId, modes } : null;
}

function shouldAutoApprovePermission(mode: PermissionMode, toolKind: string | undefined): boolean {
	if (mode === "auto") return true;
	if (mode === "edits") {
		const k = toolKind?.toLowerCase();
		return k !== "execute" && k !== "delete" && k !== "move";
	}
	return false;
}

function pickAllowOptionId(options: readonly { optionId: string; kind?: string }[]): string | undefined {
	const allowOnce = options.find(
		o => o.kind === "allow_once" || (o.kind === undefined && /allow.*once/i.test(o.optionId)),
	);
	if (allowOnce) return allowOnce.optionId;
	const allowAlways = options.find(
		o => o.kind === "allow_always" || (o.kind === undefined && /allow/i.test(o.optionId)),
	);
	if (allowAlways) return allowAlways.optionId;
	return options.find(o => !o.kind?.startsWith("reject") && !/reject|deny|cancel/i.test(o.optionId))?.optionId;
}

function parseLegacyModels(raw: unknown): { currentModelId?: string; options: AcpOptionItem[] } | null {
	if (!isRecord(raw)) return null;
	const available = Array.isArray(raw.availableModels) ? raw.availableModels : [];
	const options: AcpOptionItem[] = [];
	for (const item of available) {
		if (!isRecord(item)) continue;
		const id = typeof item.modelId === "string" ? item.modelId : typeof item.id === "string" ? item.id : undefined;
		if (!id) continue;
		options.push({
			value: id,
			name: typeof item.name === "string" ? item.name : id,
			...(typeof item.description === "string" ? { description: item.description } : {}),
		});
	}
	const currentModelId = typeof raw.currentModelId === "string" ? raw.currentModelId : undefined;
	return options.length > 0 || currentModelId ? { currentModelId, options } : null;
}

function mapPermissionKindLabel(kind: string | undefined): string | undefined {
	switch (kind) {
		case "allow_once":
			return "Allow once";
		case "allow_always":
			return "Always allow";
		case "reject_once":
			return "Reject once";
		case "reject_always":
			return "Always reject";
		default:
			return kind;
	}
}

function extractImageBlock(item: Record<string, unknown>): ImageContent | null {
	if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string" && item.data) {
		return { type: "image", data: item.data, mimeType: item.mimeType };
	}
	return null;
}

function extractToolContent(content: unknown, rawOutput: unknown): { text: string; images: ImageContent[] } {
	const parts: string[] = [];
	const images: ImageContent[] = [];
	if (Array.isArray(content)) {
		for (const item of content) {
			if (!isRecord(item)) continue;
			if (item.type === "content" && isRecord(item.content)) {
				if (item.content.type === "text" && typeof item.content.text === "string") {
					parts.push(item.content.text);
				} else {
					const image = extractImageBlock(item.content);
					if (image) images.push(image);
				}
			} else if (item.type === "diff" && typeof item.path === "string") {
				const oldText = typeof item.oldText === "string" ? item.oldText : "";
				const newText = typeof item.newText === "string" ? item.newText : "";
				parts.push(`Edited ${item.path}${oldText || newText ? `\n${newText}` : ""}`);
			} else if (item.type === "terminal" && typeof item.terminalId === "string") {
				parts.push(`[terminal ${item.terminalId}]`);
			} else if (item.type === "text" && typeof item.text === "string") {
				parts.push(item.text);
			} else {
				const image = extractImageBlock(item);
				if (image) images.push(image);
			}
		}
	} else if (typeof content === "string") {
		parts.push(content);
	}
	if (parts.length === 0 && images.length === 0 && rawOutput !== undefined && rawOutput !== null) {
		if (typeof rawOutput === "string") parts.push(rawOutput);
		else {
			try {
				parts.push(JSON.stringify(rawOutput, null, 2));
			} catch {
				parts.push(String(rawOutput));
			}
		}
	}
	return { text: parts.join("\n"), images };
}

function extractTextBlock(content: unknown): string {
	if (typeof content === "string") return content;
	if (!isRecord(content)) return "";
	if (content.type === "text" && typeof content.text === "string") return content.text;
	if (content.type === "resource_link" && typeof content.uri === "string") {
		return typeof content.name === "string" ? `[${content.name}](${content.uri})` : content.uri;
	}
	return "";
}

function normalizeToolName(kind: unknown, title: unknown, rawInput: unknown): string {
	if (isRecord(rawInput) && typeof rawInput.tool === "string" && rawInput.tool) return rawInput.tool;
	if (typeof kind === "string" && kind) {
		switch (kind) {
			case "execute":
				return "bash";
			case "read":
				return "read";
			case "edit":
				return "edit";
			case "delete":
				return "delete";
			case "move":
				return "move";
			case "search":
				return "grep";
			case "fetch":
				return "fetch";
			case "think":
				return "think";
			default:
				return kind;
		}
	}
	if (typeof title === "string" && title.trim()) return title.trim().slice(0, 48);
	return "tool";
}

function normalizeArgs(rawInput: unknown, locations: unknown): Record<string, unknown> {
	const args: Record<string, unknown> = isRecord(rawInput) ? { ...rawInput } : {};
	if (!isRecord(rawInput) && rawInput !== undefined && rawInput !== null) args.input = rawInput;
	const locationPath =
		Array.isArray(locations) &&
		locations.length > 0 &&
		isRecord(locations[0]) &&
		typeof locations[0].path === "string"
			? locations[0].path
			: undefined;
	if (typeof args.path !== "string" || args.path.length === 0) {
		const resolved = locationPath ?? (isRecord(rawInput) ? pathFromInput(rawInput) : undefined);
		if (resolved) args.path = resolved;
	}
	if (typeof args.command !== "string" && typeof args.CommandLine === "string" && args.CommandLine.length > 0) {
		args.command = args.CommandLine;
	}
	const { startLine, endLine } = extractReadLineRange(args);
	if (args.offset === undefined && startLine !== undefined) args.offset = startLine;
	if (args.limit === undefined && endLine !== undefined) {
		args.limit = Math.max(1, endLine - (startLine ?? 1) + 1);
	}
	if (!isRecord(rawInput) && Array.isArray(locations) && locations.length > 0) {
		args.locations = locations;
	}
	return args;
}

function mapStopReason(stopReason: unknown): StopReason {
	switch (stopReason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
		case "max_turn_requests":
			return "length";
		case "cancelled":
			return "aborted";
		case "refusal":
			return "error";
		default:
			return "stop";
	}
}

function stripProviderPrefix(selector: string): { modelId: string; thinking?: string } {
	const cleaned = selector.startsWith(`${PROVIDER_NAME}/`) ? selector.slice(PROVIDER_NAME.length + 1) : selector;
	const colon = cleaned.lastIndexOf(":");
	if (colon > 0) {
		const candidate = cleaned.slice(colon + 1);
		if (/^[a-zA-Z_-]+$/.test(candidate)) {
			return { modelId: cleaned.slice(0, colon), thinking: candidate };
		}
	}
	return { modelId: cleaned };
}

/**
 * `RpcSource` implementation driving Antigravity CLI over the Agent Client Protocol (`agy acp`, JSON-RPC 2.0 over stdio).
 *
 * Translates ACP's `session/update` notifications and `session/request_permission` callbacks into the `omp-web`
 * `AgentSessionEvent` / `RpcExtensionUIRequest` / synthetic `SessionEntry` stream that `HostedSession` already consumes.
 */
export class AntigravityAcpSource implements RpcSource {
	readonly backend: SessionBackend = "antigravity";

	#child: ReturnType<typeof ptree.spawn> | null = null;
	#stdin: { write(data: string): unknown } | null = null;
	#nextRpcId = 0;
	#pendingRpc = new Map<number, PendingRpcRequest>();
	#pendingPermissions = new Map<string, PendingPermission>();
	#permSeq = 0;

	#sessionListeners = new Set<(event: AgentSessionEvent) => void>();
	#uiListeners = new Set<(request: RpcExtensionUIRequest) => void>();
	#settledListeners = new Set<() => void>();
	#promptResultListeners = new Set<(result: RpcPromptResultFrame) => void>();
	#commandListeners = new Set<(commands: RpcAvailableSlashCommand[]) => void>();
	#sideListeners = new Set<(frame: SideChannelFrame) => void>();
	#exitListeners = new Set<(reason: string) => void>();

	#sessionId = "";
	#sessionName: string | undefined;
	#preview: string | undefined;
	#configOptions: AcpConfigOption[] = [];
	#legacyModels: { currentModelId?: string; options: AcpOptionItem[] } | null = null;
	#legacyModes: { currentModeId?: string; modes: SessionModeOption[] } | null = null;
	#permissionMode: PermissionMode;
	#commands: RpcAvailableSlashCommand[] = [];
	#todos: RpcSessionState["todoPhases"] = [];
	#contextUsage: RpcSessionState["contextUsage"] | undefined;
	#knownContextWindow: number | undefined;
	#contextSource: "acp" | "db" | undefined;
	#lastTurnUsage:
		| {
				input: number;
				cacheRead: number;
				cacheWrite: number;
				output: number;
				reasoningTokens?: number;
		  }
		| undefined;
	#sessionTotals = {
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		output: 0,
		reasoningTokens: 0,
		callCount: 0,
		costUsd: 0,
	};
	#dbUsage: AntigravityConversationUsage | null = null;
	#agentCapabilities: Record<string, unknown> = {};

	#entries: SessionEntry[] = [];
	#entrySeq = 0;
	#leafId: string | null = null;

	#replaying = false;
	#replayUserText = "";
	#isStreaming = false;
	#currentAssistant: AssistantMessage | null = null;
	#activeTools = new Map<string, TrackedToolCall>();
	/**
	 * Tool calls still running when their run ended (agy's async `run_command`). agy wakes the agent on its own when one
	 * finishes, so until then the session has pending background work.
	 */
	#backgroundTools = new Map<string, TrackedToolCall>();
	/** Whether the current run is one agy started without a `session/prompt` (it has no response to end it). */
	#wakeRun = false;
	#wakeTimer: ReturnType<typeof setTimeout> | undefined;
	#pendingToolResults: ToolResultMessage[] = [];
	#followUpQueue: QueuedFollowUp[] = [];
	/** Incremented on each `session/prompt` (start or mid-turn steer); earlier responses are superseded, not run-ending. */
	#activeTurnSeq = 0;
	/** Steered messages already sent via concurrent `session/prompt`, awaiting the step boundary to enter the transcript. */
	#pendingSteers: PendingSteer[] = [];
	#abortRequested = false;

	#exited = false;
	#stopping = false;

	constructor(private readonly options: AntigravityAcpOptions) {
		this.#sessionName = options.initialTitle;
		this.#permissionMode = options.permissionMode ?? "auto";
	}

	/** Spawns `agy acp`, performs the ACP `initialize` handshake, and creates or resumes the session. */
	async start(): Promise<void> {
		const args = this.options.args && this.options.args.length > 0 ? this.options.args : ["acp"];
		const child = ptree.spawn([this.options.binaryPath, ...args], {
			cwd: this.options.cwd,
			env: { ...Bun.env, ...this.options.env },
			stdin: "pipe",
		});
		this.#child = child;
		this.#stdin = child.stdin;
		void this.#readStdout(child.stdout);
		void child.exited.then(
			code => this.#handleExit(`antigravity acp exited with code ${code}`),
			err => this.#handleExit(`antigravity acp exited: ${err instanceof Error ? err.message : String(err)}`),
		);

		try {
			const initResult = await this.#request("initialize", {
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: {},
				clientInfo: { name: "omp-web", version: pkg.version },
			});
			const authMethods = isRecord(initResult) ? parseAuthMethods(initResult.authMethods) : [];
			if (isRecord(initResult) && isRecord(initResult.agentCapabilities)) {
				this.#agentCapabilities = initResult.agentCapabilities;
			}

			const env = { ...Bun.env, ...this.options.env };
			const loginCmd = antigravityLoginCommand({ path: this.options.binaryPath, args });
			let triedAuthMethod: string | undefined;

			if (this.options.authMethod) {
				triedAuthMethod = this.options.authMethod;
				try {
					await this.#request("authenticate", { methodId: this.options.authMethod }, 120_000);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					throw new AntigravityAuthError(
						`Antigravity authentication (${this.options.authMethod}) failed: ${reason}. Sign in from Accounts or run \`${loginCmd}\`.`,
						authMethods,
						loginCmd,
					);
				}
			}

			const openSession = async (): Promise<void> => {
				if (this.options.resumeSessionId) {
					if (this.#agentCapabilities.loadSession === false) {
						throw new Error("Antigravity ACP server does not advertise session/load capability");
					}
					this.#replaying = true;
					try {
						const loadResult = await this.#request("session/load", {
							sessionId: this.options.resumeSessionId,
							cwd: this.options.cwd,
							mcpServers: [],
						});
						this.#sessionId = this.options.resumeSessionId;
						this.#applySessionSetup(loadResult);
					} finally {
						this.#flushReplayBuffers();
						this.#replaying = false;
					}
					// If ACP session/load did not replay message chunks, seed entries from the local transcript file.
					if (this.#entries.length === 0 && this.options.transcriptPath) {
						this.#seedFromTranscript(this.options.transcriptPath);
					}
					// `session/load` omits or zeroes context usage until the next turn; recover the last fill & totals from SQLite.
					this.#seedUsageFromDb();
				} else {
					const newResult = await this.#request("session/new", {
						cwd: this.options.cwd,
						mcpServers: [],
					});
					if (!isRecord(newResult) || typeof newResult.sessionId !== "string" || !newResult.sessionId) {
						throw new Error("Antigravity ACP session/new did not return a sessionId");
					}
					this.#sessionId = newResult.sessionId;
					this.#applySessionSetup(newResult);
				}
			};

			try {
				await openSession();
			} catch (error) {
				if (!isAuthRequiredError(error)) throw error;
				// If GEMINI_API_KEY is available and the agent advertises gemini-api-key, authenticate automatically and retry once.
				const canUseApiKey =
					Boolean(env.GEMINI_API_KEY) &&
					triedAuthMethod !== "gemini-api-key" &&
					authMethods.some(m => m.id === "gemini-api-key");
				if (canUseApiKey) {
					await this.#request("authenticate", { methodId: "gemini-api-key" });
					await openSession();
				} else {
					const methodList = authMethods.length > 0 ? ` (${authMethods.map(m => m.id).join(", ")})` : "";
					throw new AntigravityAuthError(
						`Antigravity requires authentication${methodList}. Sign in from Accounts → Antigravity or run \`${loginCmd}\` on this machine.`,
						authMethods,
						loginCmd,
					);
				}
			}

			if (this.options.model) {
				const parsed = stripProviderPrefix(this.options.model);
				if (parsed.modelId) {
					await this.setModel(PROVIDER_NAME, parsed.modelId).catch(() => {});
				}
				if (parsed.thinking) {
					await this.setThinkingLevel(parsed.thinking).catch(() => {});
				}
			}
			if (this.options.mode) {
				await this.setMode(this.options.mode).catch(() => {});
			}

			this.#reportMetadata();
		} catch (error) {
			await this.stop().catch(() => {});
			throw error;
		}
	}

	#seedFromTranscript(path: string): void {
		const parsed = loadAntigravityTranscript(path, { cwd: this.options.cwd, hydrateLocalReads: true });
		for (const entry of parsed.entries) {
			if (entry.type !== "message") continue;
			this.#appendEntry(entry.message, entry.timestamp);
		}
		if (!this.#preview && parsed.preview) this.#preview = parsed.preview;
		if (!this.#sessionName && parsed.title) this.#sessionName = parsed.title;
	}

	#resolvedContextWindow(): number | undefined {
		if (this.#knownContextWindow !== undefined && this.#knownContextWindow > 0) return this.#knownContextWindow;
		const modelId = this.#currentModel()?.id ?? this.#dbUsage?.model;
		return modelId ? antigravityModelContextWindow(modelId) : undefined;
	}

	#seedUsageFromDb(): void {
		if (!this.#sessionId) return;
		const dbPath = findAntigravityConversationDb(this.#sessionId, {
			transcriptPath: this.options.transcriptPath,
			conversationsDirs: this.options.conversationsDirs,
			env: this.options.env,
		});
		if (!dbPath) return;
		const dbUsage = readAntigravityConversationUsage(dbPath);
		if (!dbUsage) return;
		this.#dbUsage = dbUsage;
		const totalCost = dbUsage.calls.reduce((sum, call) => sum + antigravityCallCostUsd(call), 0);
		this.#sessionTotals = {
			input: dbUsage.totals.uncachedInputTokens,
			cacheRead: dbUsage.totals.cachedInputTokens,
			cacheWrite: dbUsage.totals.cacheCreationTokens,
			output: dbUsage.totals.outputTokens,
			reasoningTokens: dbUsage.totals.reasoningTokens,
			callCount: dbUsage.totals.callCount,
			costUsd: totalCost,
		};
		this.#lastTurnUsage ??= {
			input: dbUsage.latest.uncachedInputTokens,
			cacheRead: dbUsage.latest.cachedInputTokens,
			cacheWrite: dbUsage.latest.cacheCreationTokens,
			output: dbUsage.latest.outputTokens,
			...(dbUsage.latest.reasoningTokens > 0 ? { reasoningTokens: dbUsage.latest.reasoningTokens } : {}),
		};
		if (!this.#contextUsage || this.#contextUsage.tokens === 0) {
			const windowTokens = this.#resolvedContextWindow();
			if (windowTokens !== undefined && windowTokens > 0) {
				this.#contextUsage = {
					tokens: dbUsage.latest.contextTokens,
					contextWindow: windowTokens,
					percent: (dbUsage.latest.contextTokens / windowTokens) * 100,
				};
				this.#contextSource = "db";
			}
		}
		// Attach historical spend onto the last assistant message when replayed/seeded history had no usage counters.
		const hasRecordedCost = this.#entries.some(
			entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.usage.totalTokens > 0,
		);
		if (!hasRecordedCost && totalCost > 0) {
			const lastAssistant = this.#entries.findLast(
				entry => entry.type === "message" && entry.message.role === "assistant",
			);
			if (lastAssistant?.type === "message" && lastAssistant.message.role === "assistant") {
				lastAssistant.message.usage = {
					input: dbUsage.totals.uncachedInputTokens,
					output: dbUsage.totals.outputTokens,
					cacheRead: dbUsage.totals.cachedInputTokens,
					cacheWrite: dbUsage.totals.cacheCreationTokens,
					totalTokens:
						dbUsage.totals.uncachedInputTokens +
						dbUsage.totals.cachedInputTokens +
						dbUsage.totals.cacheCreationTokens +
						dbUsage.totals.outputTokens,
					...(dbUsage.totals.reasoningTokens > 0 ? { reasoningTokens: dbUsage.totals.reasoningTokens } : {}),
					cost: { total: totalCost },
				};
			}
		}
	}

	#applySessionSetup(result: unknown): void {
		if (!isRecord(result)) return;
		if (typeof result.sessionId === "string" && result.sessionId) {
			this.#sessionId = result.sessionId;
		}
		if (Array.isArray(result.configOptions)) {
			this.#configOptions = parseConfigOptions(result.configOptions);
		}
		const legacy = parseLegacyModels(result.models);
		if (legacy) this.#legacyModels = legacy;
		const legacyModes = parseLegacyModes(result.modes);
		if (legacyModes) this.#legacyModes = legacyModes;
	}

	#modeConfigOption(): AcpConfigOption | undefined {
		return this.#configOptions.find(
			opt => opt.category === "mode" || opt.id === "mode" || opt.id === "agent_mode" || opt.id === "permission_mode",
		);
	}

	#currentAgentMode(): { id: string; name: string } | undefined {
		const opt = this.#modeConfigOption();
		if (opt?.currentValue) {
			const match = opt.options.find(item => item.value === opt.currentValue);
			return { id: opt.currentValue, name: match?.name ?? opt.currentValue };
		}
		if (this.#legacyModes?.currentModeId) {
			const id = this.#legacyModes.currentModeId;
			const match = this.#legacyModes.modes.find(item => item.id === id);
			return { id, name: match?.name ?? id };
		}
		return undefined;
	}

	#modelConfigOption(): AcpConfigOption | undefined {
		return this.#configOptions.find(opt => opt.category === "model" || opt.id === "model");
	}

	#thinkingConfigOption(): AcpConfigOption | undefined {
		return this.#configOptions.find(
			opt =>
				opt.category === "thought_level" ||
				opt.id === "thinking_level" ||
				opt.id === "thinking" ||
				opt.id === "reasoning_effort",
		);
	}

	#currentModel(): { id: string; name: string } | undefined {
		const opt = this.#modelConfigOption();
		if (opt?.currentValue) {
			const match = opt.options.find(item => item.value === opt.currentValue);
			return { id: opt.currentValue, name: match?.name ?? opt.currentValue };
		}
		if (this.#legacyModels?.currentModelId) {
			const id = this.#legacyModels.currentModelId;
			const match = this.#legacyModels.options.find(item => item.value === id);
			return { id, name: match?.name ?? id };
		}
		return undefined;
	}

	#currentThinkingLevel(): string | undefined {
		return this.#thinkingConfigOption()?.currentValue;
	}

	#reportMetadata(): void {
		if (!this.#sessionId) return;
		// Do not persist empty brand-new sessions to the registry until the user actually sends a message.
		if (this.#entries.length === 0 && !this.options.resumeSessionId) return;
		const model = this.#currentModel();
		this.options.onMetadata?.({
			id: this.#sessionId,
			cwd: this.options.cwd,
			title: this.#sessionName,
			preview: this.#preview,
			model: model ? `${PROVIDER_NAME}/${model.id}` : undefined,
			messageCount: this.#entries.length,
		});
	}

	async #readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		try {
			for await (const frame of readJsonl(stream)) {
				if (!isRecord(frame)) continue;
				this.#handleFrame(frame);
			}
		} catch {
			// Stream closed or errored; child.exited triggers #handleExit.
		}
	}

	#handleFrame(frame: Record<string, unknown>): void {
		const hasId = typeof frame.id === "number" || typeof frame.id === "string";
		const hasMethod = typeof frame.method === "string";

		// 1. Response to one of our outgoing JSON-RPC requests.
		if (hasId && !hasMethod) {
			const id = typeof frame.id === "number" ? frame.id : Number(frame.id);
			const pending = this.#pendingRpc.get(id);
			if (!pending) return;
			this.#pendingRpc.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
			if (isRecord(frame.error)) {
				const code = typeof frame.error.code === "number" ? frame.error.code : undefined;
				const message =
					typeof frame.error.message === "string"
						? frame.error.message
						: `ACP ${pending.method} failed (${String(frame.error.code ?? "error")})`;
				pending.reject(new AcpRpcError(message, code, frame.error.data));
			} else {
				pending.resolve(frame.result);
			}
			return;
		}

		// 2. Incoming request from the ACP agent (expects a JSON-RPC response).
		if (hasId && hasMethod) {
			this.#handleAgentRequest(frame.id as number | string, frame.method as string, frame.params);
			return;
		}

		// 3. Incoming notification from the ACP agent.
		if (hasMethod) {
			this.#handleNotification(frame.method as string, frame.params);
		}
	}

	#handleAgentRequest(rpcId: number | string, method: string, params: unknown): void {
		if (method === "session/request_permission") {
			this.#handlePermissionRequest(rpcId, params);
			return;
		}
		// Unknown or unsupported client callback (e.g., fs/* or terminal/* when clientCapabilities is empty).
		this.#writeJson({
			jsonrpc: "2.0",
			id: rpcId,
			error: { code: -32601, message: `Method not supported by omp-web ACP client: ${method}` },
		});
	}

	#handlePermissionRequest(rpcId: number | string, params: unknown): void {
		const rec = isRecord(params) ? params : {};
		const toolCall = isRecord(rec.toolCall) ? rec.toolCall : undefined;
		const rawOptions = Array.isArray(rec.options) ? rec.options : [];

		const baseTitle =
			(typeof rec.title === "string" && rec.title.trim()) ||
			(typeof toolCall?.title === "string" && toolCall.title.trim()) ||
			"Permission requested";
		let detail = "";
		if (toolCall && isRecord(toolCall.rawInput)) {
			const cmd = toolCall.rawInput.command ?? toolCall.rawInput.path ?? toolCall.rawInput.file_path;
			if (typeof cmd === "string" && cmd.trim()) detail = ` — ${cmd.trim().slice(0, 140)}`;
		}

		const seen = new Set<string>();
		const mappedOptions: { label: string; optionId: string; kind?: string; description?: string }[] = [];
		for (const raw of rawOptions) {
			if (!isRecord(raw) || typeof raw.optionId !== "string") continue;
			let label = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : raw.optionId;
			if (seen.has(label)) label = `${label} (${raw.optionId})`;
			seen.add(label);
			const kind = typeof raw.kind === "string" ? raw.kind : undefined;
			mappedOptions.push({
				label,
				optionId: raw.optionId,
				kind,
				description: mapPermissionKindLabel(kind),
			});
		}

		if (mappedOptions.length === 0) {
			this.#writeJson({
				jsonrpc: "2.0",
				id: rpcId,
				result: { outcome: { outcome: "cancelled" } },
			});
			return;
		}

		const toolKind = typeof toolCall?.kind === "string" ? toolCall.kind : undefined;
		if (shouldAutoApprovePermission(this.#permissionMode, toolKind)) {
			const allowId = pickAllowOptionId(mappedOptions);
			if (allowId) {
				this.#writeJson({
					jsonrpc: "2.0",
					id: rpcId,
					result: { outcome: { outcome: "selected", optionId: allowId } },
				});
				return;
			}
		}

		const uiId = `acp_perm_${++this.#permSeq}`;
		this.#pendingPermissions.set(uiId, {
			rpcId,
			toolKind,
			options: mappedOptions.map(o => ({ label: o.label, optionId: o.optionId, kind: o.kind })),
		});

		const request: RpcExtensionUIRequest = {
			type: "extension_ui_request",
			id: uiId,
			method: "select",
			title: `${baseTitle}${detail}`,
			options: mappedOptions.map(o => o.label),
			optionDetails: mappedOptions.map(o => (o.description ? { description: o.description } : {})),
		};
		for (const listener of this.#uiListeners) listener(request);
	}

	#handleNotification(method: string, params: unknown): void {
		if (method !== "session/update" || !isRecord(params)) return;
		const update = isRecord(params.update) ? params.update : null;
		if (!update || typeof update.sessionUpdate !== "string") return;

		const kind = update.sessionUpdate;
		if (kind === "agent_thought_chunk" || kind === "agent_message_chunk" || kind === "tool_call")
			this.#beginWakeRun();
		switch (kind) {
			case "user_message_chunk":
				this.#onUserChunk(extractTextBlock(update.content));
				break;
			case "agent_thought_chunk":
				this.#onThoughtChunk(extractTextBlock(update.content));
				break;
			case "agent_message_chunk":
				this.#onAgentChunk(extractTextBlock(update.content));
				break;
			case "tool_call":
				this.#onToolCall(update);
				break;
			case "tool_call_update":
				this.#onToolCallUpdate(update);
				break;
			case "plan":
				this.#onPlanUpdate(update);
				break;
			case "available_commands_update":
				this.#onAvailableCommandsUpdate(update);
				break;
			case "config_option_update":
				this.#onConfigOptionUpdate(update);
				break;
			case "current_mode_update":
				this.#onCurrentModeUpdate(update);
				break;
			case "session_info_update":
				this.#onSessionInfoUpdate(update);
				break;
			case "usage_update":
				this.#onUsageUpdate(update);
				break;
			default:
				break;
		}
		if (this.#wakeRun) this.#scheduleWakeEnd(kind === "usage_update");
	}

	/** Opens a run for output agy produces between prompts (its report after a background command finished). */
	#beginWakeRun(): void {
		if (this.#isStreaming || this.#replaying || this.#exited) return;
		this.#isStreaming = true;
		this.#wakeRun = true;
		this.#abortRequested = false;
		this.#emitAgent({ type: "agent_start" });
		this.#emitAgent({ type: "turn_start" });
		this.#scheduleWakeEnd(false);
	}

	/** ACP sends no end for a run agy started itself: it ends once updates go quiet. */
	#scheduleWakeEnd(afterModelCall: boolean): void {
		clearTimeout(this.#wakeTimer);
		this.#wakeTimer = setTimeout(
			() => {
				// A permission dialog waits on the user, not on agy.
				if (this.#pendingPermissions.size > 0) this.#scheduleWakeEnd(false);
				else this.#finishWakeRun("stop");
			},
			afterModelCall ? WAKE_SETTLE_MS : WAKE_IDLE_MS,
		);
		this.#wakeTimer.unref?.();
	}

	#finishWakeRun(stopReason: "stop" | "aborted"): void {
		clearTimeout(this.#wakeTimer);
		this.#wakeTimer = undefined;
		this.#wakeRun = false;
		this.#parkRunningTools(stopReason === "stop");
		this.#commitStep(stopReason);
		if (stopReason === "aborted") this.#killBackgroundTools();
		this.#endRun();
		this.#afterRun(stopReason === "stop");
	}

	/**
	 * Tools still running at the end of a run keep running in the background when the run ended normally; otherwise
	 * they are closed so the UI never stays stuck on a spinning tool card.
	 */
	#parkRunningTools(keep: boolean): void {
		for (const tool of this.#activeTools.values()) {
			if (tool.completed) continue;
			if (keep) this.#backgroundTools.set(tool.toolCallId, tool);
			else this.#completeToolCall(tool, true);
		}
	}

	/** Cancelling stops agy's background tasks too (`kill_background_tasks`), with no update for them. */
	#killBackgroundTools(): void {
		for (const tool of this.#backgroundTools.values()) {
			this.#activeTools.set(tool.toolCallId, tool);
			this.#completeToolCall(tool, true);
		}
		this.#backgroundTools.clear();
	}

	#onUserChunk(text: string): void {
		if (!text) return;
		if (this.#replaying) {
			// A user turn boundary ends any preceding replayed assistant turn.
			this.#flushReplayAssistantAndTools();
			this.#replayUserText += text;
		}
	}

	#flushReplayUser(): void {
		if (!this.#replayUserText) return;
		const text = this.#replayUserText;
		this.#replayUserText = "";
		if (!this.#preview) this.#preview = text.trim().slice(0, 200);
		const msg: UserMessage = { role: "user", content: text, timestamp: Date.now() };
		this.#appendEntry(msg);
	}

	#flushReplayAssistantAndTools(): void {
		if (this.#currentAssistant) {
			const msg = this.#currentAssistant;
			this.#currentAssistant = null;
			this.#appendEntry(msg);
		}
		if (this.#pendingToolResults.length > 0) {
			for (const res of this.#pendingToolResults) this.#appendEntry(res);
			this.#pendingToolResults = [];
		}
		this.#activeTools.clear();
	}

	#flushReplayBuffers(): void {
		this.#flushReplayUser();
		this.#flushReplayAssistantAndTools();
	}

	#ensureAssistantMessage(): AssistantMessage {
		if (this.#replaying) this.#flushReplayUser();
		if (!this.#replaying && !this.#currentAssistant && this.#pendingSteers.length > 0) {
			this.#flushPendingSteers();
		}
		if (!this.#currentAssistant) {
			const current = this.#currentModel();
			this.#currentAssistant = {
				role: "assistant",
				content: [],
				model: current ? `${PROVIDER_NAME}/${current.id}` : `${PROVIDER_NAME}/default`,
				usage: { ...ZERO_USAGE, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
			if (!this.#replaying) {
				this.#emitAgent({ type: "message_start", message: this.#cloneAssistant(this.#currentAssistant) });
			}
		}
		return this.#currentAssistant;
	}

	#cloneAssistant(msg: AssistantMessage): AssistantMessage {
		return {
			...msg,
			content: msg.content.map(block => ({ ...block })),
			usage: { ...msg.usage, cost: { ...msg.usage.cost } },
		};
	}

	#onThoughtChunk(text: string): void {
		if (!text) return;
		const msg = this.#ensureAssistantMessage();
		const last = msg.content.at(-1);
		if (last && last.type === "thinking") {
			last.thinking += text;
		} else {
			msg.content.push({ type: "thinking", thinking: text });
		}
		if (!this.#replaying) {
			this.#emitAgent({ type: "message_update", message: this.#cloneAssistant(msg) });
		}
	}

	#onAgentChunk(text: string): void {
		if (!text) return;
		const msg = this.#ensureAssistantMessage();
		const last = msg.content.at(-1);
		if (last && last.type === "text") {
			last.text += text;
		} else {
			msg.content.push({ type: "text", text });
		}
		if (!this.#replaying) {
			this.#emitAgent({ type: "message_update", message: this.#cloneAssistant(msg) });
		}
	}

	#onToolCall(update: Record<string, unknown>): void {
		const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : `acp_tool_${++this.#entrySeq}`;
		const title = typeof update.title === "string" ? update.title : undefined;
		const rawInput = update.rawInput ?? update.args;
		const toolName = normalizeToolName(update.kind, title, rawInput);
		const args = normalizeArgs(rawInput, update.locations);
		const status = typeof update.status === "string" ? update.status : "pending";

		const extracted = extractToolContent(update.content, update.rawOutput);
		const tracked: TrackedToolCall = {
			toolCallId,
			toolName,
			title,
			args,
			status,
			outputText: extracted.text,
			outputImages: extracted.images,
			completed: false,
		};
		this.#activeTools.set(toolCallId, tracked);

		const msg = this.#ensureAssistantMessage();
		const block: AssistantContent = {
			type: "toolCall",
			id: toolCallId,
			name: toolName,
			arguments: args,
			...(title ? { intent: title } : {}),
		};
		msg.content.push(block);
		if (!this.#replaying) {
			this.#emitAgent({ type: "message_update", message: this.#cloneAssistant(msg) });
			this.#emitAgent({
				type: "tool_execution_start",
				toolCallId,
				toolName,
				args,
				...(title ? { intent: title } : {}),
			});
		}

		if (status === "completed" || status === "failed") {
			this.#completeToolCall(tracked, status === "failed");
		}
	}

	#onToolCallUpdate(update: Record<string, unknown>): void {
		const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
		if (!toolCallId) return;
		let tracked = this.#activeTools.get(toolCallId);
		const background = tracked ? undefined : this.#backgroundTools.get(toolCallId);
		if (background) {
			tracked = background;
		} else if (!tracked) {
			// A late update for a tool its run already closed (cancelled): nothing left to show it on.
			if (!this.#isStreaming && !this.#replaying) return;
			// Some agents emit tool_call_update without a preceding tool_call.
			this.#onToolCall(update);
			tracked = this.#activeTools.get(toolCallId);
			if (!tracked) return;
		}
		const rawInput = update.rawInput ?? update.args;
		if (typeof update.title === "string" && update.title) tracked.title = update.title;
		if (rawInput !== undefined || update.locations !== undefined) {
			tracked.args = { ...tracked.args, ...normalizeArgs(rawInput, update.locations) };
		}
		if (typeof update.kind === "string" && update.kind && tracked.toolName === "tool") {
			tracked.toolName = normalizeToolName(update.kind, tracked.title, rawInput);
		}
		// Keep the in-flight assistant toolCall block aligned if late updates fill in path/args/title.
		if (this.#currentAssistant) {
			for (const block of this.#currentAssistant.content) {
				if (block.type === "toolCall" && block.id === toolCallId) {
					block.name = tracked.toolName;
					block.arguments = tracked.args;
					if (tracked.title) block.intent = tracked.title;
				}
			}
		}
		if (typeof update.status === "string") tracked.status = update.status;
		const extracted = extractToolContent(update.content, update.rawOutput);
		if (extracted.text) tracked.outputText = extracted.text;
		if (extracted.images.length > 0) tracked.outputImages = extracted.images;

		if (tracked.status === "completed" || tracked.status === "failed") {
			if (background) {
				this.#backgroundTools.delete(toolCallId);
				// agy wakes the agent to report a finished command; a daemon (a server it left running) has nothing to report.
				if (background.args.IsDaemon !== true) this.#beginWakeRun();
				this.#activeTools.set(toolCallId, background);
			}
			this.#completeToolCall(tracked, tracked.status === "failed");
		} else if (!this.#replaying) {
			this.#emitAgent({
				type: "tool_execution_update",
				toolCallId: tracked.toolCallId,
				toolName: tracked.toolName,
				args: tracked.args,
				partialResult: tracked.outputText ? { content: [{ type: "text", text: tracked.outputText }] } : undefined,
			});
		}
	}

	#completeToolCall(tracked: TrackedToolCall, isError: boolean): void {
		if (tracked.completed) return;
		tracked.completed = true;
		let outputText = tracked.outputText;
		const images: ImageContent[] = [...tracked.outputImages];
		let details = tracked.details;
		if (!isError && tracked.toolName === "read") {
			const needImages = images.length === 0;
			const needText = !outputText;
			if (needImages || needText) {
				const targetPath = pathFromInput(tracked.args);
				if (targetPath) {
					const local = readLocalFileFallback(targetPath, this.options.cwd, tracked.args, {
						needText,
						needImages,
					});
					if (local.images.length > 0) images.push(...local.images);
					if (needText && local.text) outputText = local.text;
					if (local.truncated && details === undefined) details = { truncation: { truncated: true } };
				}
			}
		}
		const resultContent: (TextContent | ImageContent)[] = [];
		if (outputText || images.length === 0) {
			resultContent.push({ type: "text", text: outputText });
		}
		resultContent.push(...images);
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: tracked.toolCallId,
			toolName: tracked.toolName,
			content: resultContent,
			...(details !== undefined ? { details } : {}),
			isError,
			timestamp: Date.now(),
		};
		this.#pendingToolResults.push(toolResult);

		if (!this.#replaying) {
			this.#emitAgent({
				type: "tool_execution_end",
				toolCallId: tracked.toolCallId,
				toolName: tracked.toolName,
				result: { content: resultContent, ...(details !== undefined ? { details } : {}) },
				isError,
			});
		}

		// When all tool calls of the current assistant step have finished, commit the step and its tool results
		// so subsequent agent_message_chunk frames begin a fresh assistant turn in the transcript.
		const anyRunning = [...this.#activeTools.values()].some(t => !t.completed);
		if (!anyRunning) {
			this.#commitStep("toolUse");
			if (!this.#replaying && this.#pendingSteers.length > 0) {
				this.#flushPendingSteers();
			}
		}
	}

	#commitStep(stopReason: StopReason, errorMessage?: string): void {
		if (this.#currentAssistant) {
			const msg: AssistantMessage = {
				...this.#cloneAssistant(this.#currentAssistant),
				stopReason,
				...(errorMessage ? { errorMessage } : {}),
			};
			this.#currentAssistant = null;
			this.#appendEntry(msg);
			if (!this.#replaying) {
				this.#emitAgent({ type: "message_end", message: msg });
			}
		}
		if (this.#pendingToolResults.length > 0) {
			const results = this.#pendingToolResults;
			this.#pendingToolResults = [];
			for (const res of results) {
				this.#appendEntry(res);
				if (!this.#replaying) {
					this.#emitAgent({ type: "message_start", message: res });
					this.#emitAgent({ type: "message_end", message: res });
				}
			}
		}
		this.#activeTools.clear();
	}

	#onPlanUpdate(update: Record<string, unknown>): void {
		const rawEntries = Array.isArray(update.entries) ? update.entries : [];
		const tasks = rawEntries
			.filter(isRecord)
			.filter(item => typeof item.content === "string")
			.map((item, idx) => ({
				id: `plan_${idx + 1}`,
				content: item.content as string,
				status:
					item.status === "in_progress" || item.status === "completed" || item.status === "pending"
						? (item.status as "pending" | "in_progress" | "completed")
						: ("pending" as const),
			}));
		this.#todos = (tasks.length > 0 ? [{ name: "Plan", tasks }] : []) as unknown as RpcSessionState["todoPhases"];
		if (!this.#replaying) {
			for (const listener of this.#sideListeners) listener({ type: "session_info_update" });
		}
	}

	#onAvailableCommandsUpdate(update: Record<string, unknown>): void {
		const raw = Array.isArray(update.availableCommands) ? update.availableCommands : [];
		const commands: RpcAvailableSlashCommand[] = [];
		for (const item of raw) {
			if (!isRecord(item) || typeof item.name !== "string" || !item.name) continue;
			commands.push({
				name: item.name,
				...(typeof item.description === "string" ? { description: item.description } : {}),
				...(isRecord(item.input) && typeof item.input.hint === "string"
					? { input: { hint: item.input.hint } }
					: {}),
				source: "custom",
			});
		}
		this.#commands = commands;
		if (!this.#replaying) {
			for (const listener of this.#commandListeners) listener(commands);
		}
	}

	#onConfigOptionUpdate(update: Record<string, unknown>): void {
		if (!Array.isArray(update.configOptions)) return;
		const prevModel = this.#currentModel()?.id;
		const prevThinking = this.#currentThinkingLevel();
		this.#configOptions = parseConfigOptions(update.configOptions);
		const nextModel = this.#currentModel()?.id;
		const nextThinking = this.#currentThinkingLevel();
		this.#reportMetadata();
		if (this.#replaying) return;
		if (nextModel !== prevModel) {
			this.#emitAgent({ type: "model_changed" } as unknown as AgentSessionEvent);
		}
		if (nextThinking !== prevThinking) {
			this.#emitAgent({
				type: "thinking_level_changed",
				thinkingLevel: nextThinking,
			} as unknown as AgentSessionEvent);
		}
		for (const listener of this.#sideListeners) listener({ type: "config_update" });
	}

	#onCurrentModeUpdate(update: Record<string, unknown>): void {
		const modeId = typeof update.currentModeId === "string" ? update.currentModeId : undefined;
		if (!modeId) return;
		const opt = this.#modeConfigOption();
		if (opt) opt.currentValue = modeId;
		if (this.#legacyModes) this.#legacyModes.currentModeId = modeId;
		else this.#legacyModes = { currentModeId: modeId, modes: [{ id: modeId, name: modeId }] };
		if (!this.#replaying) {
			for (const listener of this.#sideListeners) listener({ type: "config_update" });
		}
	}

	#onSessionInfoUpdate(update: Record<string, unknown>): void {
		if (typeof update.title === "string" && update.title.trim()) {
			this.#sessionName = update.title.trim();
			this.#reportMetadata();
			if (!this.#replaying) {
				for (const listener of this.#sideListeners) listener({ type: "session_info_update" });
			}
		}
	}

	#onUsageUpdate(update: Record<string, unknown>): void {
		const used =
			typeof update.used === "number" && Number.isFinite(update.used) && update.used >= 0 ? update.used : undefined;
		const size =
			typeof update.size === "number" && Number.isFinite(update.size) && update.size > 0 ? update.size : undefined;
		if (size !== undefined) this.#knownContextWindow = size;
		const contextWindow = size ?? this.#resolvedContextWindow();
		// During `session/load` replay, `agy` emits `used: 0` with the real `size`; keep `size` without clobbering restored DB tokens.
		if (used === 0 && this.#contextUsage && (this.#contextUsage.tokens ?? 0) > 0 && this.#replaying) {
			if (contextWindow !== undefined && contextWindow > 0 && this.#contextUsage.tokens !== null) {
				this.#contextUsage = {
					tokens: this.#contextUsage.tokens,
					contextWindow,
					percent: (this.#contextUsage.tokens / contextWindow) * 100,
				};
			}
			return;
		}
		if (used !== undefined && contextWindow !== undefined && contextWindow > 0) {
			this.#contextUsage = {
				tokens: used,
				contextWindow,
				percent: (used / contextWindow) * 100,
			};
			this.#contextSource = "acp";
			if (!this.#replaying) {
				for (const listener of this.#sideListeners) listener({ type: "session_info_update" });
			}
		}
	}

	#appendEntry(message: WireMessage, timestamp?: string): MessageEntry {
		const id = `agy_${++this.#entrySeq}`;
		const entry: MessageEntry = {
			type: "message",
			id,
			parentId: this.#leafId,
			timestamp: timestamp ?? new Date(message.timestamp).toISOString(),
			message,
		};
		this.#leafId = id;
		this.#entries.push(entry);
		return entry;
	}

	#emitAgent(event: unknown): void {
		for (const listener of this.#sessionListeners) listener(event as AgentSessionEvent);
	}

	#emitQueueUpdate(): void {
		this.#emitAgent({
			type: "queue_update",
			steering: this.#pendingSteers.map(item => item.message),
			followUp: this.#followUpQueue.map(item => item.message),
			liveSteered: this.#pendingSteers.length,
		});
	}

	#writeJson(payload: Record<string, unknown>): void {
		if (!this.#stdin || this.#exited) throw new Error("antigravity acp process is not running");
		this.#stdin.write(`${JSON.stringify(payload)}\n`);
	}

	#request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
		if (!this.#stdin || this.#exited) return Promise.reject(new Error("antigravity acp process is not running"));
		const id = ++this.#nextRpcId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const entry: PendingRpcRequest = { method, resolve, reject };
		const effectiveTimeout =
			timeoutMs === undefined ? (this.options.requestTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS) : timeoutMs;
		if (effectiveTimeout > 0) {
			entry.timer = setTimeout(() => {
				if (this.#pendingRpc.delete(id)) {
					reject(new Error(`timeout waiting for Antigravity ACP ${method}`));
				}
			}, effectiveTimeout);
		}
		this.#pendingRpc.set(id, entry);
		try {
			this.#writeJson({ jsonrpc: "2.0", id, method, params });
		} catch (error) {
			this.#pendingRpc.delete(id);
			if (entry.timer) clearTimeout(entry.timer);
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	#notify(method: string, params: Record<string, unknown>): void {
		this.#writeJson({ jsonrpc: "2.0", method, params });
	}

	#handleExit(reason: string): void {
		if (this.#exited) return;
		this.#exited = true;
		for (const pending of this.#pendingRpc.values()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.#pendingRpc.clear();
		this.#pendingPermissions.clear();
		if (this.#wakeRun) this.#finishWakeRun("aborted");
		this.#backgroundTools.clear();
		this.#pendingSteers = [];
		this.#isStreaming = false;
		if (this.#stopping) return;
		for (const listener of this.#exitListeners) listener(reason);
	}

	// ---------------------------------------------------------------------------
	// RpcSource implementation
	// ---------------------------------------------------------------------------

	onSessionEvent: RpcSource["onSessionEvent"] = listener => {
		this.#sessionListeners.add(listener);
	};
	onExtensionUi: RpcSource["onExtensionUi"] = listener => {
		this.#uiListeners.add(listener);
	};
	onSessionSettled: RpcSource["onSessionSettled"] = listener => {
		this.#settledListeners.add(listener);
	};
	onPromptResult: RpcSource["onPromptResult"] = listener => {
		this.#promptResultListeners.add(listener);
	};
	onAvailableCommands: RpcSource["onAvailableCommands"] = listener => {
		this.#commandListeners.add(listener);
	};
	onSideChannel: RpcSource["onSideChannel"] = listener => {
		this.#sideListeners.add(listener);
	};
	onSubagentLifecycle: RpcSource["onSubagentLifecycle"] = (
		_listener: (payload: RpcSubagentLifecycleFrame["payload"]) => void,
	) => {};
	onSubagentProgress: RpcSource["onSubagentProgress"] = (
		_listener: (payload: RpcSubagentProgressFrame["payload"]) => void,
	) => {};
	onBtwRecord: RpcSource["onBtwRecord"] = (_listener: (record: RpcBtwHistoryRecord) => void) => {};
	onBtwDelta: RpcSource["onBtwDelta"] = (_listener: (frame: RpcBtwDeltaFrame) => void) => {};
	onExit: RpcSource["onExit"] = listener => {
		this.#exitListeners.add(listener);
	};

	async getState(): Promise<RpcSessionState> {
		const current = this.#currentModel();
		return {
			sessionId: this.#sessionId,
			sessionFile: this.options.transcriptPath,
			sessionName: this.#sessionName,
			model: current
				? ({
						provider: PROVIDER_NAME,
						id: current.id,
						name: current.name,
						cost: antigravityModelCost(current.id),
					} as unknown as RpcSessionState["model"])
				: undefined,
			thinkingLevel: this.#currentThinkingLevel() as RpcSessionState["thinkingLevel"],
			isStreaming: this.#isStreaming,
			isCompacting: false,
			queuedMessageCount: this.#pendingSteers.length + this.#followUpQueue.length,
			queuedMessages: {
				steering: this.#pendingSteers.map(item => item.message),
				followUp: this.#followUpQueue.map(item => item.message),
				liveSteered: this.#pendingSteers.length,
			},
			todoPhases: this.#todos,
			// `session/load` reports `used: 0` for a session with history until its next turn: no reading beats a false 0%.
			contextUsage:
				this.#contextUsage?.tokens === 0 &&
				this.#entries.some(entry => entry.type === "message" && entry.message.role === "assistant")
					? undefined
					: this.#contextUsage,
			autoCompactionEnabled: false,
			fastModeActive: false,
			hasPendingAsyncWork: [...this.#backgroundTools.values()].some(tool => tool.args.IsDaemon !== true),
		} as unknown as RpcSessionState;
	}

	async getEntries(since?: string): Promise<{ entries: OmpSessionEntry[]; leafId: string | null }> {
		if (since === undefined) {
			return { entries: this.#entries as unknown as OmpSessionEntry[], leafId: this.#leafId };
		}
		const index = this.#entries.findIndex(entry => entry.id === since);
		if (index < 0) throw new Error(`unknown entries cursor: ${since}`);
		return {
			entries: this.#entries.slice(index + 1) as unknown as OmpSessionEntry[],
			leafId: this.#leafId,
		};
	}

	async getAvailableCommands(): Promise<RpcAvailableSlashCommand[]> {
		return [...this.#commands];
	}

	async getAvailableModels(): Promise<ModelInfo[]> {
		const opt = this.#modelConfigOption();
		const items = opt?.options.length ? opt.options : (this.#legacyModels?.options ?? []);
		const hasThinking = (this.#thinkingConfigOption()?.options.length ?? 0) > 0;
		return items.map(
			item =>
				({
					provider: PROVIDER_NAME,
					id: item.value,
					name: item.name,
					reasoning: hasThinking,
				}) as unknown as ModelInfo,
		);
	}

	async getAvailableThinkingLevels(): Promise<string[]> {
		const opt = this.#thinkingConfigOption();
		return opt ? opt.options.map(item => item.value) : [];
	}

	async getAvailableModes(): Promise<SessionModeOption[]> {
		const opt = this.#modeConfigOption();
		if (opt && opt.options.length > 0) {
			return opt.options.map(item => ({
				id: item.value,
				name: item.name,
				...(item.description ? { description: item.description } : {}),
			}));
		}
		return this.#legacyModes?.modes ? [...this.#legacyModes.modes] : [];
	}

	getModeState(): { agentMode?: string; agentModeName?: string; permissionMode?: PermissionMode } {
		const mode = this.#currentAgentMode();
		return {
			...(mode ? { agentMode: mode.id, agentModeName: mode.name } : {}),
			permissionMode: this.#permissionMode,
		};
	}

	async getContextReport(): Promise<string> {
		if (!this.#contextUsage || this.#contextUsage.tokens === 0) {
			this.#seedUsageFromDb();
		}
		const usedTokens =
			this.#contextUsage?.tokens !== null && this.#contextUsage?.tokens !== undefined
				? this.#contextUsage.tokens
				: undefined;
		const contextWindow = this.#contextUsage?.contextWindow ?? this.#resolvedContextWindow();
		return formatAntigravityContextReport({
			usedTokens,
			contextWindow,
			source: this.#contextSource,
			entries: this.#entries,
			lastTurn: this.#lastTurnUsage,
			sessionTotals: this.#sessionTotals.callCount > 0 ? this.#sessionTotals : undefined,
		});
	}

	async setMode(modeId: string): Promise<void> {
		const opt = this.#modeConfigOption();
		if (opt) {
			const result = await this.#request("session/set_config_option", {
				sessionId: this.#sessionId,
				configId: opt.id,
				value: modeId,
			});
			if (isRecord(result) && Array.isArray(result.configOptions)) {
				this.#configOptions = parseConfigOptions(result.configOptions);
			} else {
				opt.currentValue = modeId;
			}
		} else {
			await this.#request("session/set_mode", {
				sessionId: this.#sessionId,
				modeId,
			});
			if (this.#legacyModes) this.#legacyModes.currentModeId = modeId;
			else this.#legacyModes = { currentModeId: modeId, modes: [{ id: modeId, name: modeId }] };
		}
		for (const listener of this.#sideListeners) listener({ type: "config_update" });
	}

	async setPermissionMode(mode: PermissionMode): Promise<void> {
		this.#permissionMode = mode;
		// Immediately approve any currently open permission prompts that the new mode permits,
		// and cancel their UI dialogs so every connected browser dismisses the popup at once.
		for (const [uiId, pending] of Array.from(this.#pendingPermissions)) {
			if (!shouldAutoApprovePermission(mode, pending.toolKind)) continue;
			const allowId = pickAllowOptionId(pending.options);
			if (!allowId) continue;
			this.#pendingPermissions.delete(uiId);
			try {
				this.#writeJson({
					jsonrpc: "2.0",
					id: pending.rpcId,
					result: { outcome: { outcome: "selected", optionId: allowId } },
				});
			} catch {
				// Ignore write errors if child already exited.
			}
			const cancelReq: RpcExtensionUIRequest = {
				type: "extension_ui_request",
				id: `acp_cancel_${++this.#permSeq}`,
				method: "cancel",
				targetId: uiId,
			};
			for (const listener of this.#uiListeners) listener(cancelReq);
		}
		for (const listener of this.#sideListeners) listener({ type: "config_update" });
	}

	async setModel(_provider: string, modelId: string): Promise<void> {
		const opt = this.#modelConfigOption();
		if (opt) {
			const result = await this.#request("session/set_config_option", {
				sessionId: this.#sessionId,
				configId: opt.id,
				value: modelId,
			});
			if (isRecord(result) && Array.isArray(result.configOptions)) {
				this.#configOptions = parseConfigOptions(result.configOptions);
			} else {
				opt.currentValue = modelId;
			}
		} else {
			await this.#request("session/set_model", {
				sessionId: this.#sessionId,
				modelId,
			});
			if (this.#legacyModels) this.#legacyModels.currentModelId = modelId;
			else this.#legacyModels = { currentModelId: modelId, options: [{ value: modelId, name: modelId }] };
		}
		this.#reportMetadata();
		this.#emitAgent({ type: "model_changed" } as unknown as AgentSessionEvent);
	}

	async setThinkingLevel(level: string): Promise<void> {
		const opt = this.#thinkingConfigOption();
		if (!opt) throw new Error("This Antigravity session does not expose thinking level options");
		const result = await this.#request("session/set_config_option", {
			sessionId: this.#sessionId,
			configId: opt.id,
			value: level,
		});
		if (isRecord(result) && Array.isArray(result.configOptions)) {
			this.#configOptions = parseConfigOptions(result.configOptions);
		} else {
			opt.currentValue = level;
		}
		this.#emitAgent({
			type: "thinking_level_changed",
			thinkingLevel: level,
		} as unknown as AgentSessionEvent);
	}

	async compact(): Promise<void> {
		throw new Error("Antigravity ACP sessions do not support manual compaction");
	}

	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		if (this.#exited) throw new Error("antigravity acp process is not running");
		if (this.#isStreaming) {
			// Treat a prompt while busy as a follow-up so rapid messages are never silently dropped.
			await this.followUp(message, images);
			return;
		}
		this.#startTurn(message, images);
	}

	#recordUserMessage(message: string, images: ImageContent[] | undefined, timestamp: number): UserMessage {
		const hadEntries = this.#entries.length > 0;
		const setPreview = !this.#preview && Boolean(message.trim());
		if (setPreview) {
			this.#preview = message.trim().slice(0, 200);
		}
		const userContent: UserMessage["content"] =
			images && images.length > 0
				? [
						...(message ? [{ type: "text" as const, text: message }] : []),
						...images.map(img => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
					]
				: message;
		const userMessage: UserMessage = { role: "user", content: userContent, timestamp };
		this.#appendEntry(userMessage);
		if (!hadEntries || setPreview) {
			this.#reportMetadata();
		}
		return userMessage;
	}

	#promptBlocks(message: string, images?: ImageContent[]): Record<string, unknown>[] {
		const promptBlocks: Record<string, unknown>[] = [];
		if (message) promptBlocks.push({ type: "text", text: message });
		if (images) {
			for (const image of images) {
				promptBlocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
			}
		}
		return promptBlocks;
	}

	#flushPendingSteers(): void {
		if (this.#pendingSteers.length === 0) return;
		const steers = this.#pendingSteers;
		this.#pendingSteers = [];
		for (const item of steers) {
			const userMessage = this.#recordUserMessage(item.message, item.images, item.timestamp);
			if (!this.#replaying) {
				this.#emitAgent({ type: "message_start", message: userMessage });
				this.#emitAgent({ type: "message_end", message: userMessage });
			}
		}
		this.#emitQueueUpdate();
	}

	#recordTurnUsage(result: unknown): ReturnType<typeof antigravityTurnUsage> {
		const current = this.#currentModel();
		// The turn's usage (all its model calls) rides on its last assistant step, as omp records a run's spend; priced at
		// the model's API rates from omp's catalog when it has them.
		const usage = antigravityTurnUsage(
			isRecord(result) ? result.usage : undefined,
			current ? antigravityModelCost(current.id) : undefined,
			Date.now(),
		);
		if (usage) {
			this.#lastTurnUsage = {
				input: usage.input,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				output: usage.output,
				...(usage.reasoningTokens !== undefined && usage.reasoningTokens > 0
					? { reasoningTokens: usage.reasoningTokens }
					: {}),
			};
			this.#sessionTotals.input += usage.input;
			this.#sessionTotals.cacheRead += usage.cacheRead;
			this.#sessionTotals.cacheWrite += usage.cacheWrite;
			this.#sessionTotals.output += usage.output;
			this.#sessionTotals.reasoningTokens += usage.reasoningTokens ?? 0;
			this.#sessionTotals.callCount += 1;
			this.#sessionTotals.costUsd += usage.cost.total;
		}
		return usage;
	}

	#startTurn(message: string, images?: ImageContent[]): void {
		const turnSeq = ++this.#activeTurnSeq;
		this.#isStreaming = true;
		this.#abortRequested = false;
		const userMessage = this.#recordUserMessage(message, images, Date.now());

		this.#emitAgent({ type: "agent_start" });
		this.#emitAgent({ type: "turn_start" });
		this.#emitAgent({ type: "message_start", message: userMessage });
		this.#emitAgent({ type: "message_end", message: userMessage });

		// Prompt turns can run arbitrarily long (tool execution, reasoning, permission waits): no request timeout.
		void this.#request(
			"session/prompt",
			{ sessionId: this.#sessionId, prompt: this.#promptBlocks(message, images) },
			0,
		).then(
			result => this.#onPromptSettled(turnSeq, result, undefined),
			error => this.#onPromptSettled(turnSeq, undefined, error instanceof Error ? error : new Error(String(error))),
		);
	}

	/**
	 * When a concurrent `session/prompt` steers an active turn, `agy acp` resolves the earlier prompt immediately while
	 * keeping any in-flight tool running and handing the turn over to the newer prompt. Only the latest `turnSeq` closes
	 * the run; superseded responses record their usage and commit/flush steers if no tool is still running.
	 */
	#onPromptSettled(turnSeq: number, result: unknown, error: Error | undefined): void {
		if (turnSeq !== this.#activeTurnSeq) {
			if (result !== undefined) {
				const usage = this.#recordTurnUsage(result);
				if (usage && this.#currentAssistant) this.#currentAssistant.usage = usage;
			}
			const anyRunning = [...this.#activeTools.values()].some(t => !t.completed);
			if (!anyRunning) {
				this.#commitStep("stop");
				this.#flushPendingSteers();
			}
			return;
		}
		this.#finishTurn(result, error);
	}

	#finishTurn(result: unknown, error: Error | undefined): void {
		this.#flushPendingSteers();
		const stopReason: StopReason = error
			? this.#abortRequested
				? "aborted"
				: "error"
			: mapStopReason(isRecord(result) ? result.stopReason : undefined);

		const errorMessage = error && stopReason === "error" ? error.message : undefined;
		this.#parkRunningTools(stopReason !== "aborted" && stopReason !== "error");
		const current = this.#currentModel();
		const usage = this.#recordTurnUsage(result);
		if ((errorMessage || usage) && !this.#currentAssistant) {
			this.#currentAssistant = {
				role: "assistant",
				content: [],
				model: current ? `${PROVIDER_NAME}/${current.id}` : `${PROVIDER_NAME}/default`,
				usage: { ...ZERO_USAGE, cost: { total: 0 } },
				stopReason,
				...(errorMessage ? { errorMessage } : {}),
				timestamp: Date.now(),
			};
			this.#emitAgent({ type: "message_start", message: this.#cloneAssistant(this.#currentAssistant) });
		}
		if (usage && this.#currentAssistant) this.#currentAssistant.usage = usage;
		this.#commitStep(stopReason, errorMessage);
		if (stopReason === "aborted") this.#killBackgroundTools();
		this.#endRun();

		const promptStatus = stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "completed";
		const frame: RpcPromptResultFrame = {
			type: "prompt_result",
			status: promptStatus,
			agentInvoked: true,
			...(promptStatus === "error" ? { error: { message: errorMessage ?? "Antigravity prompt failed" } } : {}),
		} as unknown as RpcPromptResultFrame;
		for (const listener of this.#promptResultListeners) listener(frame);

		this.#afterRun(promptStatus === "completed");
	}

	#endRun(): void {
		const lastEntry = this.#entries.at(-1);
		const lastMsg = lastEntry?.type === "message" ? [lastEntry.message] : [];
		this.#isStreaming = false;
		this.#emitAgent({ type: "turn_end" });
		this.#emitAgent({ type: "agent_end", messages: lastMsg });
	}

	/** After a run: the next queued follow-up starts (only after a clean finish), else the session has settled. */
	#afterRun(drainQueue: boolean): void {
		this.#reportMetadata();
		if (drainQueue && this.#followUpQueue.length > 0 && !this.#exited) {
			const next = this.#followUpQueue.shift()!;
			this.#emitQueueUpdate();
			this.#startTurn(next.message, next.images);
			return;
		}
		if (this.#followUpQueue.length === 0) {
			for (const listener of this.#settledListeners) listener();
		}
	}

	/**
	 * Mid-turn steering via concurrent `session/prompt`: `agy acp` injects the prompt at the next tool/step boundary
	 * without killing running tools, resolves the superseded prompt immediately, and finishes the turn on this one.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		if (this.#exited) throw new Error("antigravity acp process is not running");
		if (!this.#isStreaming) {
			this.#startTurn(message, images);
			return;
		}
		const wasWakeRun = this.#wakeRun;
		if (wasWakeRun) {
			clearTimeout(this.#wakeTimer);
			this.#wakeTimer = undefined;
			this.#wakeRun = false;
		}
		const turnSeq = ++this.#activeTurnSeq;
		this.#abortRequested = false;
		this.#pendingSteers.push({ message, images, timestamp: Date.now() });
		this.#emitQueueUpdate();

		void this.#request(
			"session/prompt",
			{ sessionId: this.#sessionId, prompt: this.#promptBlocks(message, images) },
			0,
		).then(
			result => this.#onPromptSettled(turnSeq, result, undefined),
			error => this.#onPromptSettled(turnSeq, undefined, error instanceof Error ? error : new Error(String(error))),
		);

		if (wasWakeRun && ![...this.#activeTools.values()].some(t => !t.completed)) {
			this.#commitStep("stop");
			this.#flushPendingSteers();
		}
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		if (this.#exited) throw new Error("antigravity acp process is not running");
		if (!this.#isStreaming) {
			this.#startTurn(message, images);
			return;
		}
		this.#followUpQueue.push({ message, images });
		this.#emitQueueUpdate();
	}

	async removeQueuedMessage(message: string, queue: "steering" | "followUp"): Promise<RpcRemoveQueuedMessageResult> {
		if (queue !== "followUp") return { removed: false } as unknown as RpcRemoveQueuedMessageResult;
		const idx = this.#followUpQueue.findIndex(item => item.message === message);
		if (idx < 0) return { removed: false } as unknown as RpcRemoveQueuedMessageResult;
		this.#followUpQueue.splice(idx, 1);
		this.#emitQueueUpdate();
		return { removed: true } as unknown as RpcRemoveQueuedMessageResult;
	}

	async abort(): Promise<void> {
		if (!this.#isStreaming || this.#exited) return;
		this.#abortRequested = true;
		if (this.#pendingSteers.length > 0) {
			this.#pendingSteers = [];
			this.#emitQueueUpdate();
		}
		// Cancel any pending permission requests so the agent can unwind cleanly.
		for (const [uiId, pending] of this.#pendingPermissions) {
			this.#pendingPermissions.delete(uiId);
			try {
				this.#writeJson({
					jsonrpc: "2.0",
					id: pending.rpcId,
					result: { outcome: { outcome: "cancelled" } },
				});
			} catch {
				// Ignore write errors while aborting.
			}
		}
		this.#notify("session/cancel", { sessionId: this.#sessionId });
		// No `session/prompt` response will end a run agy started itself.
		if (this.#wakeRun) this.#finishWakeRun("aborted");
	}

	respondUi(response: RpcExtensionUIResponse): void {
		const pending = this.#pendingPermissions.get(response.id);
		if (!pending) return;
		this.#pendingPermissions.delete(response.id);
		if ("value" in response && typeof response.value === "string") {
			const chosen = pending.options.find(opt => opt.label === response.value);
			if (chosen) {
				this.#writeJson({
					jsonrpc: "2.0",
					id: pending.rpcId,
					result: { outcome: { outcome: "selected", optionId: chosen.optionId } },
				});
				return;
			}
		}
		this.#writeJson({
			jsonrpc: "2.0",
			id: pending.rpcId,
			result: { outcome: { outcome: "cancelled" } },
		});
	}

	async enableAskDialog(): Promise<void> {
		// No-op for ACP; permission prompts use select dialogs.
	}

	async setSessionName(name: string): Promise<void> {
		this.#sessionName = name;
		this.#reportMetadata();
		for (const listener of this.#sideListeners) listener({ type: "session_info_update" });
	}

	async setSubagentSubscription(_level: RpcSubagentSubscriptionLevel): Promise<void> {
		// No-op: ACP does not expose omp subagent streams.
	}

	async btw(): Promise<RpcBtwHistoryRecord> {
		throw new Error("Antigravity ACP sessions do not support /btw side questions");
	}

	async cancelBtw(): Promise<boolean> {
		return false;
	}

	async getBtwHistory(): Promise<readonly RpcBtwHistoryRecord[]> {
		return [];
	}

	async getSubagents(): Promise<RpcSubagentSnapshot[]> {
		return [];
	}

	async goal(): Promise<never> {
		throw new Error("Antigravity ACP sessions do not support /goal mode");
	}

	async getSubagentMessages(): Promise<RpcSubagentMessagesResult> {
		throw new Error("Antigravity ACP sessions do not expose sub-agent transcripts");
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		this.#followUpQueue = [];
		clearTimeout(this.#wakeTimer);
		for (const pending of this.#pendingRpc.values()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new Error("antigravity acp stopped"));
		}
		this.#pendingRpc.clear();
		this.#pendingPermissions.clear();
		if (this.#child && !this.#exited) {
			try {
				await this.#child.kill(undefined, 2000);
			} catch {
				// Process already exited.
			}
		}
		this.#exited = true;
	}
}

/**
 * Spawns a short-lived `agy acp` process, performs `initialize`, and optionally invokes `authenticate`.
 * Used by `antigravity.auth.status` and `antigravity.auth.login` on the machine that runs `agy`.
 */
async function runAcpControl<T>(
	binary: AntigravityBinary,
	options: { env?: Record<string, string | undefined>; timeoutMs?: number },
	fn: (
		call: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>,
		initResult: unknown,
	) => Promise<T>,
): Promise<T> {
	const args = binary.args.length > 0 ? binary.args : ["acp"];
	const child = ptree.spawn([binary.path, ...args], {
		cwd: process.cwd(),
		env: { ...Bun.env, ...options.env },
		stdin: "pipe",
	});
	const pending = new Map<number, PendingRpcRequest>();
	let nextId = 0;
	let exited = false;

	const failAll = (reason: string): void => {
		if (exited) return;
		exited = true;
		for (const p of pending.values()) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(new Error(reason));
		}
		pending.clear();
	};

	void child.exited.then(
		code => failAll(`antigravity acp exited with code ${code}`),
		err => failAll(`antigravity acp exited: ${err instanceof Error ? err.message : String(err)}`),
	);

	void (async () => {
		try {
			for await (const frame of readJsonl(child.stdout)) {
				if (!isRecord(frame)) continue;
				const hasId = typeof frame.id === "number" || typeof frame.id === "string";
				const hasMethod = typeof frame.method === "string";
				if (hasId && !hasMethod) {
					const id = typeof frame.id === "number" ? frame.id : Number(frame.id);
					const req = pending.get(id);
					if (!req) continue;
					pending.delete(id);
					if (req.timer) clearTimeout(req.timer);
					if (isRecord(frame.error)) {
						const code = typeof frame.error.code === "number" ? frame.error.code : undefined;
						const msg =
							typeof frame.error.message === "string"
								? frame.error.message
								: `ACP ${req.method} failed (${String(frame.error.code ?? "error")})`;
						req.reject(new AcpRpcError(msg, code, frame.error.data));
					} else {
						req.resolve(frame.result);
					}
				} else if (hasId && hasMethod) {
					try {
						child.stdin.write(
							`${JSON.stringify({
								jsonrpc: "2.0",
								id: frame.id,
								error: { code: -32601, message: `Method not supported during auth probe: ${frame.method}` },
							})}\n`,
						);
					} catch {
						// Ignore write errors while closing.
					}
				}
			}
		} catch {
			// Stream closed.
		}
	})();

	const call = (
		method: string,
		params: Record<string, unknown>,
		timeoutMs = options.timeoutMs ?? 20_000,
	): Promise<unknown> => {
		if (exited) return Promise.reject(new Error("antigravity acp process is not running"));
		const id = ++nextId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const entry: PendingRpcRequest = { method, resolve, reject };
		if (timeoutMs > 0) {
			entry.timer = setTimeout(() => {
				if (pending.delete(id)) reject(new Error(`timeout waiting for Antigravity ACP ${method}`));
			}, timeoutMs);
		}
		pending.set(id, entry);
		try {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		} catch (error) {
			pending.delete(id);
			if (entry.timer) clearTimeout(entry.timer);
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	};

	try {
		const initResult = await call("initialize", {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientCapabilities: {},
			clientInfo: { name: "omp-web", version: pkg.version },
		});
		return await fn(call, initResult);
	} finally {
		exited = true;
		for (const p of pending.values()) {
			if (p.timer) clearTimeout(p.timer);
		}
		pending.clear();
		try {
			await child.kill(undefined, 1500);
		} catch {
			// Already exited.
		}
	}
}

/** Queries ACP `initialize` on `binary` to list supported `authMethods` and environment auth status. */
export async function probeAntigravityAuth(
	binary: AntigravityBinary | null | undefined,
	options: { configuredMethod?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<AntigravityAuthStatusAck> {
	const env = options.env ?? Bun.env;
	if (!binary) {
		return {
			available: false,
			authMethods: [],
			hasGeminiApiKey: Boolean(env.GEMINI_API_KEY),
		};
	}
	const authMethods = await runAcpControl(binary, options, async (_call, initResult) =>
		isRecord(initResult) ? parseAuthMethods(initResult.authMethods) : [],
	);
	return {
		available: true,
		...(binary.version ? { version: binary.version } : {}),
		authMethods,
		...(options.configuredMethod ? { configuredMethod: options.configuredMethod } : {}),
		hasGeminiApiKey: Boolean(env.GEMINI_API_KEY),
		loginCommand: antigravityLoginCommand(binary),
	};
}

/** Invokes ACP `authenticate` for `methodId` on `binary`. */
export async function authenticateAntigravity(
	binary: AntigravityBinary,
	methodId: string,
	options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<AntigravityAuthLoginAck> {
	return runAcpControl(binary, { ...options, timeoutMs: options.timeoutMs ?? 120_000 }, async (call, initResult) => {
		const methods = isRecord(initResult) ? parseAuthMethods(initResult.authMethods) : [];
		if (methods.length > 0 && !methods.some(m => m.id === methodId)) {
			throw new Error(
				`Antigravity ACP does not advertise auth method "${methodId}" (available: ${methods.map(m => m.id).join(", ")})`,
			);
		}
		await call("authenticate", { methodId }, options.timeoutMs ?? 120_000);
		return { methodId, authenticated: true };
	});
}
