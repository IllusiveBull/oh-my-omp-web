import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-wire";

type FieldValue = number | bigint | Uint8Array;
type Fields = Map<number, FieldValue[]>;

/** Lightweight protobuf wire decoder for Antigravity's `gen_metadata` and `steps` blobs. */
export function decodeProtoFields(bytes: Uint8Array): Fields {
	let offset = 0;
	const result: Fields = new Map();
	const varint = (): number | bigint => {
		let value = 0n;
		for (let shift = 0n; shift < 70n; shift += 7n) {
			const byte = bytes[offset++];
			if (byte === undefined || (shift === 63n && byte > 1)) {
				throw new Error("Invalid Antigravity protobuf varint");
			}
			value |= BigInt(byte & 127) << shift;
			if (byte < 128) {
				return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
			}
		}
		throw new Error("Invalid Antigravity protobuf varint");
	};

	while (offset < bytes.length) {
		const tag = varint();
		if (typeof tag !== "number") throw new Error("Invalid protobuf field");
		const number = Math.floor(tag / 8);
		const wire = tag % 8;
		if (number === 0) throw new Error("Invalid protobuf field");
		let value: FieldValue;
		if (wire === 0) {
			value = varint();
		} else if (wire === 1 || wire === 5 || wire === 2) {
			const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
			if (typeof length !== "number") throw new Error("Invalid protobuf field length");
			if (length > bytes.length - offset) throw new Error("Truncated protobuf field");
			value = bytes.subarray(offset, offset + length);
			offset += length;
			if (wire !== 2) continue;
		} else {
			throw new Error("Unsupported protobuf wire type");
		}
		const entries = result.get(number) ?? [];
		entries.push(value);
		result.set(number, entries);
	}
	return result;
}

const numberAt = (value: Fields, key: number): number => {
	const entry = value.get(key)?.[0];
	return typeof entry === "number" ? entry : 0;
};
const bytesAt = (value: Fields, key: number): Uint8Array | undefined => {
	const entry = value.get(key)?.[0];
	return entry instanceof Uint8Array ? entry : undefined;
};
const nested = (value: Fields, key: number): Fields => {
	const bytes = bytesAt(value, key);
	return bytes === undefined ? new Map<number, FieldValue[]>() : decodeProtoFields(bytes);
};
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const textAt = (value: Fields, key: number): string => {
	const bytes = bytesAt(value, key);
	return bytes === undefined ? "" : utf8Decoder.decode(bytes).trim();
};
const timestampAt = (value: Fields): number | null => {
	const seconds = numberAt(value, 1);
	return seconds > 0 ? seconds * 1000 + Math.floor(numberAt(value, 2) / 1_000_000) : null;
};

/** Offline fallback for Antigravity model enum IDs when metadata omits a concrete name. */
const MODEL_IDS: Record<number, string> = {
	246: "gemini-2.5-pro",
	312: "gemini-2.5-flash",
	313: "gemini-2.5-flash-thinking",
	329: "gemini-2.5-flash-thinking",
	330: "gemini-2.5-flash-lite",
	281: "claude-sonnet-4",
	282: "claude-sonnet-4",
	290: "claude-opus-4",
	291: "claude-opus-4",
	333: "claude-sonnet-4-5",
	334: "claude-sonnet-4-5",
	340: "claude-haiku-4-5",
	341: "claude-haiku-4-5",
	342: "gpt-oss-120b-medium",
	1026: "claude-opus-4-6",
	1035: "claude-sonnet-4-6",
	1016: "gemini-3.1-pro",
	1036: "gemini-3.1-pro",
	1037: "gemini-3.1-pro",
	1018: "gemini-3-flash-preview",
	1084: "gemini-3-flash-preview",
	1047: "gemini-3-flash-preview",
	1020: "gemini-3.5-flash-medium",
	1021: "gemini-3.1-flash-image",
	1050: "gemini-3.1-flash-lite",
	1071: "gemini-3.6-flash-high",
	1072: "gemini-3.6-flash-medium",
	1073: "gemini-3.6-flash-low",
	1132: "gemini-3.5-flash-high",
	1133: "gemini-3.5-flash-high",
	1187: "gemini-3.5-flash-extra-low",
	1196: "gemini-3.6-flash",
	1266: "gemini-3.6-flash",
	1298: "gemini-3.7-flash-high",
	1299: "gemini-3.7-flash-medium",
	1300: "gemini-3.7-flash-low",
	1301: "gemini-3.7-flash-tiered",
	1318: "gemini-3.8-flash-high",
	1319: "gemini-3.8-flash-medium",
	1320: "gemini-3.8-flash-low",
	1322: "gemini-3.8-flash-tiered",
	1402: "claude-opus-5-5",
	1417: "gemini-4-argon",
	1418: "gemini-4-argon",
	1419: "gemini-4-argon",
	1537: "gemini-pro-orchestrator-neon",
};

function normalizeModelName(name: string): string {
	if (!name) return "";
	const normalized = name
		.toLowerCase()
		.replace(/\s*\(([^)]*)\)\s*$/, "-$1")
		.replace(/\s+/g, "-");
	if (normalized.startsWith("claude-")) {
		return normalized.replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1").replaceAll(".", "-");
	}
	return normalized;
}

function isConcreteModel(model: string): boolean {
	return (
		/^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/.test(model) &&
		!/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
	);
}

interface ParsedMetadata {
	model: string;
	modelId: number;
	timestampMs: number | null;
	usages: Fields[];
}

function parseMetadataBlob(bytes: Uint8Array, isStep: boolean): ParsedMetadata | null {
	try {
		const root = decodeProtoFields(bytes);
		if (!isStep && bytesAt(root, 1) === undefined) return null;
		const data = isStep ? root : nested(root, 1);
		const modelFields = isStep ? nested(data, 24) : data;
		const usageBytes = bytesAt(data, isStep ? 9 : 4);
		const primaryUsage = usageBytes === undefined ? undefined : decodeProtoFields(usageBytes.slice());
		const usages = primaryUsage === undefined ? [] : [primaryUsage];
		for (const retry of data.get(isStep ? 28 : 17) ?? []) {
			if (!(retry instanceof Uint8Array)) continue;
			const retryUsage = bytesAt(decodeProtoFields(retry), 2);
			if (retryUsage !== undefined) usages.push(decodeProtoFields(retryUsage.slice()));
		}
		const names = [textAt(modelFields, isStep ? 12 : 19), textAt(modelFields, isStep ? 8 : 21)].map(
			normalizeModelName,
		);
		return {
			model: names.find(isConcreteModel) ?? names.find(n => n && !/^model[_-]/.test(n)) ?? "",
			modelId: numberAt(modelFields, isStep ? 1 : 3) || (primaryUsage === undefined ? 0 : numberAt(primaryUsage, 1)),
			timestampMs: isStep
				? (timestampAt(nested(data, 8)) ?? timestampAt(nested(data, 1)))
				: timestampAt(nested(nested(data, 9), 4)),
			usages,
		};
	} catch {
		return null;
	}
}

export interface AntigravityCallUsage {
	model: string;
	uncachedInputTokens: number;
	cachedInputTokens: number;
	cacheCreationTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	timestampMs: number | null;
}

export interface AntigravityConversationUsage {
	/** Deduplicated model calls in chronological order. */
	calls: AntigravityCallUsage[];
	/** Most recent model call (its total input + output approximates the live context fill). */
	latest: AntigravityCallUsage & { contextTokens: number };
	/** Cumulative token totals across every deduplicated model call in the DB. */
	totals: {
		uncachedInputTokens: number;
		cachedInputTokens: number;
		cacheCreationTokens: number;
		outputTokens: number;
		reasoningTokens: number;
		callCount: number;
	};
	/** Most concrete model observed in the latest call (if any). */
	model?: string;
}

interface UsageCandidate {
	call: AntigravityCallUsage;
	modelId: number;
	modelQuality: number;
	keys: string[];
	timestampQuality: number;
}

/**
 * Opens an Antigravity SQLite DB read-only. Cleanly-closed WAL databases without a `-shm` sidecar fail with
 * `SQLITE_CANTOPEN` under plain `readonly: true`; falling back to `immutable=1` reads them safely without touching disk.
 */
function openReadonlySqlite(dbPath: string): Database | null {
	const tryOpen = (uri: string): Database | null => {
		let db: Database | undefined;
		try {
			db = new Database(uri, { readonly: true });
			db.exec("PRAGMA busy_timeout = 100");
			db.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
			return db;
		} catch {
			try {
				db?.close();
			} catch {
				// Ignore close errors.
			}
			return null;
		}
	};
	const direct = tryOpen(dbPath);
	if (direct) return direct;
	if (!existsSync(`${dbPath}-wal`)) {
		return tryOpen(`file:${encodeURI(dbPath)}?mode=ro&immutable=1`);
	}
	return null;
}

/**
 * Reads and deduplicates model-call token usage from an Antigravity conversation SQLite database
 * (`conversations/<sessionId>.db`). Returns `null` when the file is missing, unreadable, or not a conversation DB.
 */
export function readAntigravityConversationUsage(dbPath: string): AntigravityConversationUsage | null {
	if (!dbPath || !existsSync(dbPath)) return null;
	const db = openReadonlySqlite(dbPath);
	if (!db) return null;

	try {
		const tableRows = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
		const tables = new Set(tableRows.map(r => r.name));
		if (!tables.has("gen_metadata") && !tables.has("steps")) return null;

		const readTable = (sql: string, isStep: boolean): { idx: number; entry: ParsedMetadata }[] => {
			const out: { idx: number; entry: ParsedMetadata }[] = [];
			const rows = db.query<{ idx: unknown; data: unknown }, []>(sql).all();
			for (const row of rows) {
				if (typeof row.idx !== "number" || !(row.data instanceof Uint8Array)) continue;
				const parsed = parseMetadataBlob(row.data, isStep);
				if (parsed) out.push({ idx: row.idx, entry: parsed });
			}
			return out.sort((a, b) => a.idx - b.idx);
		};

		const generations = tables.has("gen_metadata")
			? readTable("SELECT idx, data FROM gen_metadata ORDER BY rowid", false)
			: [];
		const steps = tables.has("steps")
			? readTable("SELECT idx, metadata AS data FROM steps WHERE metadata IS NOT NULL ORDER BY rowid", true)
			: [];

		let trajectoryTimestamp: number | null = null;
		if (tables.has("trajectory_metadata_blob")) {
			const metaRows = db.query<{ data: unknown }, []>("SELECT data FROM trajectory_metadata_blob").all();
			for (const row of metaRows) {
				if (!(row.data instanceof Uint8Array)) continue;
				try {
					trajectoryTimestamp ??= timestampAt(nested(decodeProtoFields(row.data), 2));
				} catch {
					// Ignore malformed trajectory metadata.
				}
			}
		}

		const learnedModels = new Map<number, string | null>();
		for (const { entry } of [...generations, ...steps]) {
			if (entry.modelId > 0 && isConcreteModel(entry.model)) {
				const prev = learnedModels.get(entry.modelId);
				learnedModels.set(entry.modelId, prev === undefined || prev === entry.model ? entry.model : null);
			}
		}

		const generationByIdx = new Map(generations.map(({ idx, entry }) => [idx, entry]));
		const candidates: UsageCandidate[] = [];

		for (const [source, list] of [
			["step", steps],
			["generation", generations],
		] as const) {
			for (const { idx, entry } of list) {
				for (const usage of entry.usages) {
					const modelId = numberAt(usage, 1) || entry.modelId;
					const gen = source === "step" ? generationByIdx.get(idx) : undefined;
					const matches = (m: ParsedMetadata): boolean => modelId === 0 || m.modelId === modelId;
					const rawModel = matches(entry) && entry.model ? entry.model : gen && matches(gen) ? gen.model : "";
					const learned = learnedModels.get(modelId);
					const fallback = learned === null ? undefined : MODEL_IDS[modelId];
					const modelQuality = isConcreteModel(rawModel) ? 4 : learned ? 3 : fallback ? 2 : rawModel ? 1 : 0;
					const model =
						(isConcreteModel(rawModel) ? rawModel : "") ||
						learned ||
						fallback ||
						rawModel ||
						(modelId > 0 ? `antigravity-model-${modelId}` : "");

					const outputTokens = Math.max(numberAt(usage, 3), numberAt(usage, 9) + numberAt(usage, 10));
					const uncachedInputTokens = numberAt(usage, 2);
					const cachedInputTokens = numberAt(usage, 5);
					const cacheCreationTokens = numberAt(usage, 4);
					const reasoningTokens = Math.min(outputTokens, numberAt(usage, 9));
					if (uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens === 0) continue;

					const keys: string[] = [];
					for (const field of [11, 12, 7] as const) {
						try {
							const id = textAt(usage, field);
							if (id) keys.push(`${field}:${id}`);
						} catch {
							// Non-UTF-8 field; skip key.
						}
					}

					candidates.push({
						call: {
							model,
							uncachedInputTokens,
							cachedInputTokens,
							cacheCreationTokens,
							outputTokens,
							reasoningTokens,
							timestampMs: entry.timestampMs ?? trajectoryTimestamp,
						},
						modelId,
						modelQuality,
						keys,
						timestampQuality: entry.timestampMs !== null ? 2 : trajectoryTimestamp !== null ? 1 : 0,
					});
				}
			}
		}

		if (candidates.length === 0) return null;

		// Deduplicate calls shared between `steps` and `gen_metadata` via Union-Find on response/request IDs.
		const groups = candidates.map((c, index) => ({ ...c, parent: index, size: 1, owner: index }));
		const find = (index: number): number => {
			let root = index;
			while (groups[root]!.parent !== root) root = groups[root]!.parent;
			let cur = index;
			while (cur !== root) {
				const parent = groups[cur]!.parent;
				groups[cur]!.parent = root;
				cur = parent;
			}
			return root;
		};
		const merge = (left: number, right: number): void => {
			let a = find(left);
			let b = find(right);
			if (a === b) return;
			if (groups[a]!.size < groups[b]!.size) [a, b] = [b, a];
			const target = groups[a]!;
			const source = groups[b]!;
			const first = target.owner < source.owner ? target : source;
			const bestModel =
				source.modelQuality === target.modelQuality
					? first
					: source.modelQuality > target.modelQuality
						? source
						: target;
			const bestTime =
				source.timestampQuality > target.timestampQuality ||
				(source.timestampQuality === target.timestampQuality &&
					(source.call.timestampMs ?? Infinity) < (target.call.timestampMs ?? Infinity))
					? source
					: target;
			target.call = {
				model: bestModel.call.model,
				timestampMs: bestTime.call.timestampMs,
				uncachedInputTokens: Math.max(target.call.uncachedInputTokens, source.call.uncachedInputTokens),
				cachedInputTokens: Math.max(target.call.cachedInputTokens, source.call.cachedInputTokens),
				cacheCreationTokens: Math.max(target.call.cacheCreationTokens, source.call.cacheCreationTokens),
				outputTokens: Math.max(target.call.outputTokens, source.call.outputTokens),
				reasoningTokens: Math.max(target.call.reasoningTokens, source.call.reasoningTokens),
			};
			target.modelQuality = bestModel.modelQuality;
			target.timestampQuality = bestTime.timestampQuality;
			target.owner = first.owner;
			target.size += source.size;
			source.parent = a;
		};

		const seenKeys = new Map<string, number>();
		for (let i = 0; i < groups.length; i++) {
			for (const key of groups[i]!.keys) {
				const existing = seenKeys.get(key);
				if (existing !== undefined) merge(i, existing);
				seenKeys.set(key, i);
			}
		}

		const calls = groups
			.filter((g, index) => g.parent === index)
			.sort((a, b) => (a.call.timestampMs ?? 0) - (b.call.timestampMs ?? 0) || a.owner - b.owner)
			.map(g => g.call);

		if (calls.length === 0) return null;

		const totals = {
			uncachedInputTokens: 0,
			cachedInputTokens: 0,
			cacheCreationTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			callCount: calls.length,
		};
		for (const c of calls) {
			totals.uncachedInputTokens += c.uncachedInputTokens;
			totals.cachedInputTokens += c.cachedInputTokens;
			totals.cacheCreationTokens += c.cacheCreationTokens;
			totals.outputTokens += c.outputTokens;
			totals.reasoningTokens += c.reasoningTokens;
		}
		const last = calls.at(-1)!;
		const contextTokens =
			last.uncachedInputTokens + last.cachedInputTokens + last.cacheCreationTokens + last.outputTokens;

		return {
			calls,
			latest: { ...last, contextTokens },
			totals,
			...(last.model ? { model: last.model } : {}),
		};
	} catch {
		return null;
	} finally {
		db.close();
	}
}

/** Locates `conversations/<sessionId>.db` from an optional transcript path or Antigravity's standard data roots. */
export function findAntigravityConversationDb(
	sessionId: string,
	options: {
		transcriptPath?: string;
		conversationsDirs?: readonly string[];
		env?: Record<string, string | undefined>;
	} = {},
): string | undefined {
	if (!sessionId || sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
		return undefined;
	}
	const candidates: string[] = [];
	if (options.conversationsDirs) {
		candidates.push(...options.conversationsDirs);
	}
	if (options.transcriptPath) {
		// Standard layout: <root>/brain/<sessionId>/.system_generated/logs/transcript.jsonl -> <root>/conversations/<sessionId>.db
		let dir = dirname(resolve(options.transcriptPath));
		for (let i = 0; i < 6; i++) {
			const parent = dirname(dir);
			if (parent === dir) break;
			if (dir.endsWith("/brain") || dir.endsWith("\\brain")) {
				candidates.push(join(parent, "conversations"));
				break;
			}
			candidates.push(join(dir, "conversations"));
			dir = parent;
		}
	}
	const env = options.env ?? Bun.env;
	const home = env.HOME ?? env.USERPROFILE ?? homedir();
	if (env.GEMINI_HOME) {
		candidates.push(
			join(env.GEMINI_HOME, "antigravity-acp", "conversations"),
			join(env.GEMINI_HOME, "antigravity-cli", "conversations"),
			join(env.GEMINI_HOME, "conversations"),
		);
	}
	for (const name of ["antigravity-cli", "antigravity", "antigravity-ide", "antigravity-acp"]) {
		candidates.push(join(home, ".gemini", name, "conversations"));
	}

	const seen = new Set<string>();
	for (const dir of candidates) {
		if (seen.has(dir)) continue;
		seen.add(dir);
		const file = join(dir, `${sessionId}.db`);
		if (existsSync(file)) return file;
	}
	return undefined;
}

/** Rough character count of visible transcript messages (~4 chars/token) for splitting Antigravity's total context. */
function estimateTranscriptTokens(entries: readonly SessionEntry[]): number {
	let chars = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "user") {
			if (typeof msg.content === "string") chars += msg.content.length;
			else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					chars += block.type === "image" ? 4800 : block.text.length;
				}
			}
		} else if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else if (block.type === "toolCall") {
					chars += block.name.length + (JSON.stringify(block.arguments) ?? "").length;
				}
			}
		} else if (msg.role === "toolResult") {
			for (const block of msg.content) {
				chars += block.type === "image" ? 4800 : block.text.length;
			}
		}
	}
	return Math.round(chars / 4);
}

export interface AntigravityContextReportInput {
	usedTokens?: number;
	contextWindow?: number;
	source?: "acp" | "db";
	entries: readonly SessionEntry[];
	lastTurn?: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
		output: number;
		reasoningTokens?: number;
	};
	sessionTotals?: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
		output: number;
		reasoningTokens?: number;
		callCount: number;
		costUsd?: number;
	};
}

function formatBar(percent: number): string {
	const width = 10;
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function fmtRow(label: string, tokens: number, windowTokens: number): string {
	const pct = windowTokens > 0 ? Math.round((tokens / windowTokens) * 100) : 0;
	return `  ${label.padEnd(18)} ${formatBar(pct)} ${pct}%  ${Math.max(0, Math.round(tokens))} tokens`;
}

/**
 * Formats an Antigravity context report using the same line structure as omp's `/context` so `ContextPanel` renders
 * bars, per-message/tool breakdowns (via `contextOverview`), and exact ACP/DB token counters cleanly.
 */
export function formatAntigravityContextReport(input: AntigravityContextReportInput): string {
	const estMessages = estimateTranscriptTokens(input.entries);
	const used =
		input.usedTokens !== undefined && Number.isFinite(input.usedTokens)
			? Math.max(0, Math.round(input.usedTokens))
			: undefined;
	const windowTokens =
		input.contextWindow !== undefined && Number.isFinite(input.contextWindow) && input.contextWindow > 0
			? Math.round(input.contextWindow)
			: undefined;

	if (used === undefined && windowTokens === undefined) {
		return "Context window: unknown\nSend a message to measure Antigravity context usage.";
	}

	const effectiveUsed = used ?? 0;
	const effectiveWindow = windowTokens ?? Math.max(effectiveUsed, 1);
	const usedPct = windowTokens ? Math.min(100, (effectiveUsed / windowTokens) * 100) : undefined;
	const title =
		windowTokens !== undefined
			? `Context window: ${windowTokens} tokens (${usedPct!.toFixed(1).replace(/\.0$/, "")}% used)`
			: `Context window: ${effectiveUsed} tokens used`;

	const lines: string[] = [title];
	if (used !== undefined) {
		const messageTokens = estMessages > 0 ? Math.min(effectiveUsed, estMessages) : 0;
		const overheadTokens = Math.max(0, effectiveUsed - messageTokens);
		if (overheadTokens > 0 || messageTokens === 0) {
			lines.push(fmtRow("System & tools", overheadTokens, effectiveWindow));
		}
		if (messageTokens > 0) {
			lines.push(fmtRow("Messages", messageTokens, effectiveWindow));
		}
		if (windowTokens !== undefined) {
			lines.push(fmtRow("Free", Math.max(0, windowTokens - effectiveUsed), windowTokens));
		}
	}

	const notes: string[] = [];
	if (used !== undefined) {
		const sourceNote =
			input.source === "acp"
				? "live ACP usage_update"
				: input.source === "db"
					? "restored from Antigravity session DB"
					: "Antigravity";
		notes.push(
			windowTokens !== undefined
				? `Used: ${effectiveUsed.toLocaleString("en-US")} / ${windowTokens.toLocaleString("en-US")} tokens (${sourceNote})`
				: `Used: ${effectiveUsed.toLocaleString("en-US")} tokens (${sourceNote})`,
		);
	}
	if (input.lastTurn) {
		const t = input.lastTurn;
		const parts = [`${t.input.toLocaleString("en-US")} input`];
		if (t.cacheRead > 0) parts.push(`${t.cacheRead.toLocaleString("en-US")} cached read`);
		if (t.cacheWrite > 0) parts.push(`${t.cacheWrite.toLocaleString("en-US")} cache write`);
		const outPart =
			t.reasoningTokens && t.reasoningTokens > 0
				? `${t.output.toLocaleString("en-US")} output (${t.reasoningTokens.toLocaleString("en-US")} thinking)`
				: `${t.output.toLocaleString("en-US")} output`;
		parts.push(outPart);
		notes.push(`Last turn: ${parts.join(" · ")}`);
	}
	if (input.sessionTotals && input.sessionTotals.callCount > 0) {
		const s = input.sessionTotals;
		const parts = [`${s.input.toLocaleString("en-US")} input`];
		if (s.cacheRead > 0) parts.push(`${s.cacheRead.toLocaleString("en-US")} cached`);
		if (s.cacheWrite > 0) parts.push(`${s.cacheWrite.toLocaleString("en-US")} cache write`);
		parts.push(`${s.output.toLocaleString("en-US")} output`);
		if (s.costUsd !== undefined && s.costUsd > 0) parts.push(`~$${s.costUsd.toFixed(2)}`);
		notes.push(`Session total (${s.callCount} ${s.callCount === 1 ? "call" : "calls"}): ${parts.join(" · ")}`);
	}
	if (used !== undefined) {
		notes.push(
			"Antigravity reports total context tokens only; System & tools and Message categories are estimated from the visible transcript.",
		);
	}

	return [...lines, ...notes].join("\n");
}
