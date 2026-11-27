import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	AssistantContent,
	AssistantMessage,
	ImageContent,
	MessageEntry,
	SessionEntry,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-wire";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	extractReadLineRange,
	pathFromInput,
	readLocalFileFallback,
	readLocalImageAttachment,
} from "./antigravity-read";
import type { Conversation } from "./session-index";

/** Persisted metadata for an Antigravity ACP session hosted or renamed by `omp-web`. */
export interface AntigravitySessionRecord {
	id: string;
	cwd: string;
	title?: string;
	preview?: string;
	model?: string;
	messageCount?: number;
	createdAt: number;
	modifiedAt: number;
	transcriptPath?: string;
}

/**
 * Lightweight JSON store (`<state dir>/antigravity-sessions.json`) that remembers every Antigravity session
 * `omp-web` created, resumed, or renamed — including its `cwd` and custom title, which Antigravity's on-disk
 * transcript does not always record.
 */
export class AntigravitySessionRegistry {
	readonly #records = new Map<string, AntigravitySessionRecord>();

	constructor(private readonly file?: string) {
		this.#load();
	}

	#load(): void {
		if (!this.file || !existsSync(this.file)) return;
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
			if (!Array.isArray(raw)) return;
			for (const item of raw) {
				if (
					isRecord(item) &&
					typeof item.id === "string" &&
					item.id !== "" &&
					typeof item.cwd === "string" &&
					typeof item.createdAt === "number" &&
					typeof item.modifiedAt === "number"
				) {
					this.#records.set(item.id, {
						id: item.id,
						cwd: item.cwd,
						...(typeof item.title === "string" ? { title: item.title } : {}),
						...(typeof item.preview === "string" ? { preview: agyUserText(item.preview) } : {}),
						...(typeof item.model === "string" ? { model: item.model } : {}),
						...(typeof item.messageCount === "number" &&
						Number.isFinite(item.messageCount) &&
						item.messageCount > 0
							? { messageCount: item.messageCount }
							: {}),
						createdAt: item.createdAt,
						modifiedAt: item.modifiedAt,
						...(typeof item.transcriptPath === "string" ? { transcriptPath: item.transcriptPath } : {}),
					});
				}
			}
		} catch {
			// Corrupt or unreadable metadata file: start fresh rather than blocking daemon startup.
		}
	}

	#save(): void {
		if (!this.file) return;
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			writeFileSync(this.file, `${JSON.stringify([...this.#records.values()], null, 2)}\n`, "utf8");
		} catch {
			// Persistence failures are non-fatal; the live session still works in memory.
		}
	}

	get(id: string): AntigravitySessionRecord | undefined {
		return this.#records.get(id);
	}

	all(): AntigravitySessionRecord[] {
		return [...this.#records.values()];
	}

	upsert(patch: Partial<AntigravitySessionRecord> & { id: string }): AntigravitySessionRecord {
		const prev = this.#records.get(patch.id);
		const now = Date.now();
		const messageCount = Math.max(prev?.messageCount ?? 0, patch.messageCount ?? 0);
		const next: AntigravitySessionRecord = {
			id: patch.id,
			cwd: patch.cwd ?? prev?.cwd ?? "",
			title: patch.title ?? prev?.title,
			preview: patch.preview ?? prev?.preview,
			model: patch.model ?? prev?.model,
			...(messageCount > 0 ? { messageCount } : {}),
			createdAt: prev?.createdAt ?? patch.createdAt ?? now,
			modifiedAt: Math.max(prev?.modifiedAt ?? 0, patch.modifiedAt ?? now),
			transcriptPath: patch.transcriptPath ?? prev?.transcriptPath,
		};
		this.#records.set(patch.id, next);
		this.#save();
		return next;
	}

	rename(
		id: string,
		title: string,
		fallback?: { cwd: string; transcriptPath?: string },
	): AntigravitySessionRecord | null {
		const prev = this.#records.get(id);
		if (!prev && !fallback) return null;
		return this.upsert({
			id,
			cwd: prev?.cwd ?? fallback!.cwd,
			title,
			transcriptPath: prev?.transcriptPath ?? fallback?.transcriptPath,
			modifiedAt: Date.now(),
		});
	}
}

/** Default locations where Antigravity CLI / ACP stores session brain directories. */
export function defaultAntigravityBrainDirs(env: Record<string, string | undefined> = Bun.env): string[] {
	const home = env.HOME ?? env.USERPROFILE ?? homedir();
	const dirs = [join(home, ".gemini", "antigravity-cli", "brain")];
	if (env.AGY_SESSION_DIR) dirs.unshift(env.AGY_SESSION_DIR);
	return [...new Set(dirs)];
}

/** Locates the transcript JSONL file inside a single Antigravity session directory, if present. */
export function findAntigravityTranscript(sessionDir: string): string | undefined {
	const candidates = [
		join(sessionDir, ".system_generated", "logs", "transcript.jsonl"),
		join(sessionDir, "system_generated", "logs", "transcript.jsonl"),
		join(sessionDir, "transcript.jsonl"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Reads optional metadata (`metadata.json` / `session.json` / `conversation.json`) beside a transcript. */
function readDirMetadata(sessionDir: string): { cwd?: string; title?: string; model?: string } {
	for (const name of ["metadata.json", "session.json", "conversation.json"]) {
		const file = join(sessionDir, name);
		if (!existsSync(file)) continue;
		try {
			const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
			if (!isRecord(raw)) continue;
			const cwd =
				typeof raw.cwd === "string"
					? raw.cwd
					: typeof raw.workingDirectory === "string"
						? raw.workingDirectory
						: typeof raw.workspace === "string"
							? raw.workspace
							: undefined;
			const title = typeof raw.title === "string" ? raw.title : typeof raw.name === "string" ? raw.name : undefined;
			const model = typeof raw.model === "string" ? raw.model : undefined;
			return { cwd, title, model };
		} catch {
			// Ignore malformed metadata files.
		}
	}
	return {};
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { total: 0 },
};

function isoFrom(value: unknown, fallbackMs: number): { iso: string; ms: number } {
	if (typeof value === "string") {
		const ms = Date.parse(value);
		if (Number.isFinite(ms)) return { iso: new Date(ms).toISOString(), ms };
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return { iso: new Date(value).toISOString(), ms: value };
	}
	return { iso: new Date(fallbackMs).toISOString(), ms: fallbackMs };
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") parts.push(block);
		else if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function formatToolOutput(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function normalizeTranscriptToolName(rawName: string): string {
	switch (rawName) {
		case "read_file":
		case "view_file":
			return "read";
		case "run_command":
			return "bash";
		case "edit_file":
		case "replace_file_content":
		case "multi_replace_file_content":
			return "edit";
		case "write_file":
		case "write_to_file":
			return "write";
		case "grep_search":
			return "grep";
		case "find_by_name":
			return "glob";
		default:
			return rawName;
	}
}

/**
 * Antigravity's on-disk `transcript.jsonl` stores `tool_calls[].args` values as JSON-encoded strings
 * (e.g. `{ Path: "\"/repo/file.ts\"", StartLine: "1" }`). Unwrap quoted strings and normalize common
 * fields (`path`, `offset`, `limit`, `command`) for collab-web's tool renderers.
 */
function normalizeTranscriptToolArgs(rawArgs: unknown): Record<string, unknown> {
	if (!isRecord(rawArgs)) return rawArgs !== undefined ? { value: rawArgs } : {};
	const args: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rawArgs)) {
		if (typeof value === "string" && value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
			try {
				const parsed: unknown = JSON.parse(value);
				if (typeof parsed === "string") {
					args[key] = parsed;
					continue;
				}
			} catch {
				// Leave malformed string untouched.
			}
		}
		args[key] = value;
	}
	if (typeof args.path !== "string" || args.path.length === 0) {
		const resolved = pathFromInput(args);
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
	return args;
}

/** Strips Antigravity's `Created At:` / `Completed At:` envelope lines from `GENERIC` tool result content. */
function stripGenericStepHeaders(text: string): string {
	return text.replace(/^(?:(?:Created At|Completed At):[^\n]*\r?\n)+/, "");
}

/** The closing tag may be missing from a stored preview cut at 200 characters. */
const USER_REQUEST_RE = /<USER_REQUEST>\r?\n?([\s\S]*?)(?:\r?\n?<\/USER_REQUEST>|$)/;

/**
 * What the user typed, from an Antigravity `USER_INPUT` step: the IDE wraps it in `<USER_REQUEST>` and appends
 * blocks for the model (`<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`, …). Unwrapped text is returned as is.
 */
export function agyUserText(text: string): string {
	const request = USER_REQUEST_RE.exec(text);
	return request ? request[1]! : text;
}

const BINARY_READ_NOTICE_RE = /^Showing binary file of type\s+\S+\s*$/i;

export interface ParseAntigravityTranscriptOptions {
	/** Working directory for resolving relative paths when hydrating local reads. */
	cwd?: string;
	/** Load local files / `media` images for `read` tool results (enabled for viewing, disabled for sidebar scanning). */
	hydrateLocalReads?: boolean;
}

export interface ParsedAntigravityTranscript {
	entries: SessionEntry[];
	cwd?: string;
	title?: string;
	preview?: string;
	model?: string;
	createdAt?: number;
	modifiedAt?: number;
	searchText: string;
}

/**
 * Parses an Antigravity `transcript.jsonl` file into `omp-web` `SessionEntry[]` for read-only viewing in
 * `StoredSession` and history seeding on resume. Supports Antigravity's native step records (`USER_INPUT`,
 * `PLANNER_RESPONSE`, `GENERIC`, `TOOL_RESULT`) as well as generic role-based JSONL records.
 */
export function parseAntigravityTranscript(
	rawText: string,
	fallbackMs = Date.now(),
	options: ParseAntigravityTranscriptOptions = {},
): ParsedAntigravityTranscript {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	let seq = 0;
	let cwd: string | undefined = options.cwd;
	let title: string | undefined;
	let preview: string | undefined;
	let model: string | undefined;
	let createdAt: number | undefined;
	let modifiedAt: number | undefined;
	const searchParts: string[] = [];
	const pendingCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

	const pushEntry = (message: UserMessage | AssistantMessage | ToolResultMessage, iso: string): void => {
		const id = `agy_t_${++seq}`;
		const entry: MessageEntry = {
			type: "message",
			id,
			parentId,
			timestamp: iso,
			message,
		};
		parentId = id;
		entries.push(entry);
	};

	const lines = rawText.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(obj)) continue;

		if (typeof obj.cwd === "string" && obj.cwd && !cwd) cwd = obj.cwd;
		if (typeof obj.title === "string" && obj.title) title = obj.title;
		if (typeof obj.model === "string" && obj.model) model = obj.model;

		const { iso, ms } = isoFrom(obj.created_at ?? obj.timestamp, fallbackMs);
		createdAt = createdAt === undefined ? ms : Math.min(createdAt, ms);
		modifiedAt = modifiedAt === undefined ? ms : Math.max(modifiedAt, ms);

		const stepType = typeof obj.type === "string" ? obj.type.toUpperCase() : "";
		const role = typeof obj.role === "string" ? obj.role.toLowerCase() : "";
		const source = typeof obj.source === "string" ? obj.source.toUpperCase() : "";

		if (stepType === "USER_INPUT" || role === "user" || (stepType === "" && source === "USER_EXPLICIT")) {
			pendingCalls.length = 0;
			const text = agyUserText(textFromContent(obj.content));
			if (!text.trim()) continue;
			if (!preview) preview = text.trim().slice(0, 200);
			searchParts.push(text);
			const userMessage: UserMessage = {
				role: "user",
				content: text,
				timestamp: ms,
			};
			pushEntry(userMessage, iso);
			continue;
		}

		if (stepType === "PLANNER_RESPONSE" || role === "assistant" || (stepType === "" && source === "MODEL")) {
			pendingCalls.length = 0;
			const blocks: AssistantContent[] = [];
			if (typeof obj.thinking === "string" && obj.thinking.trim() !== "") {
				blocks.push({ type: "thinking", thinking: obj.thinking });
			}
			const text = textFromContent(obj.content);
			if (text.trim() !== "") {
				blocks.push({ type: "text", text });
				searchParts.push(text);
			}
			const toolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
			const inlineResults: ToolResultMessage[] = [];
			for (let i = 0; i < toolCalls.length; i++) {
				const rawCall = toolCalls[i];
				if (!isRecord(rawCall)) continue;
				const callId =
					typeof rawCall.id === "string" && rawCall.id ? rawCall.id : `agy_call_${obj.step_index ?? seq}_${i + 1}`;
				const rawName =
					typeof rawCall.name === "string" && rawCall.name
						? rawCall.name
						: typeof rawCall.tool_name === "string"
							? rawCall.tool_name
							: "tool";
				const name = normalizeTranscriptToolName(rawName);
				const rawArgs = rawCall.arguments ?? rawCall.args ?? rawCall.input;
				const args = normalizeTranscriptToolArgs(rawArgs);
				blocks.push({ type: "toolCall", id: callId, name, arguments: args });
				if ("result" in rawCall || "output" in rawCall || "error" in rawCall) {
					const outText = formatToolOutput(rawCall.error ?? rawCall.result ?? rawCall.output);
					const isError = rawCall.is_error === true || rawCall.isError === true || rawCall.error !== undefined;
					inlineResults.push({
						role: "toolResult",
						toolCallId: callId,
						toolName: name,
						content: [{ type: "text", text: outText }],
						isError,
						timestamp: ms,
					});
				} else {
					pendingCalls.push({ id: callId, name, args });
				}
			}
			if (blocks.length === 0) continue;
			const status = typeof obj.status === "string" ? obj.status.toUpperCase() : "DONE";
			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: blocks,
				model: model ? (model.includes("/") ? model : `antigravity/${model}`) : "antigravity/default",
				usage: ZERO_USAGE,
				stopReason: status === "ERROR" ? "error" : toolCalls.length > 0 ? "toolUse" : "stop",
				...(status === "ERROR" && typeof obj.error === "string" ? { errorMessage: obj.error } : {}),
				timestamp: ms,
			};
			pushEntry(assistantMessage, iso);
			for (const result of inlineResults) pushEntry(result, iso);
			continue;
		}

		if (stepType === "GENERIC" && pendingCalls.length > 0) {
			const call = pendingCalls.shift()!;
			let outText = stripGenericStepHeaders(formatToolOutput(obj.content ?? obj.output ?? obj.result ?? obj.error));
			const isError =
				obj.is_error === true ||
				obj.isError === true ||
				(typeof obj.status === "string" && obj.status.toUpperCase() === "ERROR") ||
				/^Encountered error in step execution:/m.test(outText);
			const images: ImageContent[] = [];
			const effectiveCwd = cwd || process.cwd();
			let details: Record<string, unknown> | undefined;

			if (options.hydrateLocalReads) {
				if (Array.isArray(obj.media)) {
					for (const item of obj.media) {
						if (!isRecord(item) || typeof item.uri !== "string" || !item.uri) continue;
						const local = readLocalImageAttachment(item.uri, effectiveCwd);
						if (local) images.push(local);
					}
				}
				if (!isError && call.name === "read") {
					const truncatedFields = Array.isArray(obj.truncated_fields) ? obj.truncated_fields : [];
					const contentTruncated = truncatedFields.includes("content");
					const isBinaryNotice = BINARY_READ_NOTICE_RE.test(outText.trim());
					if (isBinaryNotice && images.length > 0) outText = "";
					const needImages = images.length === 0;
					const needText = (!outText && images.length === 0) || contentTruncated;
					if (needImages || needText) {
						const targetPath = pathFromInput(call.args);
						if (targetPath) {
							const local = readLocalFileFallback(targetPath, effectiveCwd, call.args, {
								needText,
								needImages,
							});
							if (local.images.length > 0) {
								images.push(...local.images);
								if (isBinaryNotice) outText = "";
							}
							if (needText && local.text) outText = local.text;
							if (local.truncated) details = { truncation: { truncated: true } };
						}
					}
				}
			}

			const content: (TextContent | ImageContent)[] = [];
			if (outText || images.length === 0) content.push({ type: "text", text: outText });
			content.push(...images);
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content,
				...(details !== undefined ? { details } : {}),
				isError,
				timestamp: ms,
			};
			pushEntry(toolResult, iso);
			continue;
		}

		if (stepType === "TOOL_RESULT" || stepType === "TOOL_RESPONSE" || role === "tool" || role === "toolresult") {
			const callId =
				typeof obj.tool_call_id === "string"
					? obj.tool_call_id
					: typeof obj.toolCallId === "string"
						? obj.toolCallId
						: `agy_res_${seq + 1}`;
			const rawToolName =
				typeof obj.tool_name === "string"
					? obj.tool_name
					: typeof obj.toolName === "string"
						? obj.toolName
						: typeof obj.name === "string"
							? obj.name
							: "tool";
			const toolName = normalizeTranscriptToolName(rawToolName);
			const outText = formatToolOutput(obj.content ?? obj.output ?? obj.result ?? obj.error);
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: outText }];
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: callId,
				toolName,
				content,
				isError:
					obj.is_error === true ||
					obj.isError === true ||
					(typeof obj.status === "string" && obj.status.toUpperCase() === "ERROR"),
				timestamp: ms,
			};
			pushEntry(toolResult, iso);
		}
	}

	return {
		entries,
		cwd,
		title,
		preview,
		model,
		createdAt,
		modifiedAt,
		searchText: searchParts.join(" ").toLowerCase(),
	};
}

/** Loads and parses an Antigravity transcript file from disk. Returns an empty transcript when the path is missing. */
export function loadAntigravityTranscript(
	path: string,
	options: ParseAntigravityTranscriptOptions = {},
): ParsedAntigravityTranscript {
	if (!path || !existsSync(path)) {
		return { entries: [], searchText: "" };
	}
	const stat = statSync(path);
	const raw = readFileSync(path, "utf8");
	return parseAntigravityTranscript(raw, stat.mtimeMs, options);
}

export interface ScanAntigravityOptions {
	/** Extra or custom brain directory (`--antigravity-session-dir` / `config.antigravity.sessionDir`). */
	sessionDir?: string;
	/** Daemon-side registry of Antigravity sessions created/renamed by `omp-web`. */
	registry?: AntigravitySessionRegistry;
	/** Override the directories scanned (for tests). */
	brainDirs?: string[];
}

/**
 * Discovers Antigravity sessions by merging:
 * 1. Disk transcripts under `<brainDir>/<sessionId>/.system_generated/logs/transcript.jsonl` (or `transcript.jsonl`), and
 * 2. Sessions recorded in `AntigravitySessionRegistry` (so newly created or ACP-stored sessions always appear with their `cwd` and title).
 */
export function scanAntigravityConversations(options: ScanAntigravityOptions = {}): Conversation[] {
	const registry = options.registry;
	const byId = new Map<string, Conversation>();
	const dirs = options.brainDirs
		? options.brainDirs
		: options.sessionDir
			? [options.sessionDir]
			: defaultAntigravityBrainDirs();

	// 1. Scan on-disk Antigravity brain directories.
	for (const root of dirs) {
		if (!existsSync(root)) continue;
		let children: string[];
		try {
			children = readdirSync(root);
		} catch {
			continue;
		}
		for (const id of children) {
			const dir = join(root, id);
			let dirStat;
			try {
				dirStat = statSync(dir);
			} catch {
				continue;
			}
			if (!dirStat.isDirectory()) continue;
			const transcriptPath = findAntigravityTranscript(dir);
			if (!transcriptPath) continue;
			let fileStat;
			try {
				fileStat = statSync(transcriptPath);
			} catch {
				continue;
			}
			const parsed = loadAntigravityTranscript(transcriptPath);
			if (parsed.entries.length === 0) continue;
			const meta = readDirMetadata(dir);
			const reg = registry?.get(id);
			const cwd = reg?.cwd || meta.cwd || parsed.cwd || "";
			const title = reg?.title ?? meta.title ?? parsed.title;
			const preview = parsed.preview ?? reg?.preview;
			const createdAt = Math.min(
				...[parsed.createdAt, reg?.createdAt, fileStat.birthtimeMs || fileStat.mtimeMs].filter(
					(n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0,
				),
			);
			const modifiedAt = Math.max(fileStat.mtimeMs, parsed.modifiedAt ?? 0, reg?.modifiedAt ?? 0);
			byId.set(id, {
				id,
				backend: "antigravity",
				path: transcriptPath,
				memberIds: [id],
				memberPaths: [transcriptPath],
				files: 1,
				cwd,
				title,
				preview,
				createdAt,
				modifiedAt,
				messageCount: parsed.entries.length,
				searchText: [id, title, cwd, preview, parsed.searchText, transcriptPath]
					.filter(Boolean)
					.join(" ")
					.toLowerCase(),
			});
		}
	}

	// 2. Include sessions recorded in the daemon registry that do not yet have a scanned brain transcript.
	// Skip empty sessions (no messages and no preview) just like omp's `foldConversations` drops empty files.
	if (registry) {
		for (const rec of registry.all()) {
			if (byId.has(rec.id)) continue;
			const transcriptPath = rec.transcriptPath && existsSync(rec.transcriptPath) ? rec.transcriptPath : "";
			const parsed = transcriptPath ? loadAntigravityTranscript(transcriptPath) : null;
			const preview = parsed?.preview ?? rec.preview;
			const messageCount = parsed?.entries.length || rec.messageCount || 0;
			if (messageCount === 0 && !preview) continue;
			byId.set(rec.id, {
				id: rec.id,
				backend: "antigravity",
				path: transcriptPath,
				memberIds: [rec.id],
				memberPaths: transcriptPath ? [transcriptPath] : [],
				files: transcriptPath ? 1 : 0,
				cwd: rec.cwd,
				title: rec.title ?? parsed?.title,
				preview,
				createdAt: rec.createdAt,
				modifiedAt: Math.max(rec.modifiedAt, parsed?.modifiedAt ?? 0),
				messageCount,
				searchText: [rec.id, rec.title, rec.cwd, preview, parsed?.searchText]
					.filter(Boolean)
					.join(" ")
					.toLowerCase(),
			});
		}
	}

	return [...byId.values()].toSorted((a, b) => b.modifiedAt - a.modifiedAt);
}
