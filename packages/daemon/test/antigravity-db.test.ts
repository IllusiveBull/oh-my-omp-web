import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import {
	findAntigravityConversationDb,
	formatAntigravityContextReport,
	readAntigravityConversationUsage,
} from "../src/antigravity-db";

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function varint(value: number): number[] {
	const out: number[] = [];
	let v = value;
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
	return out;
}

function fieldVarint(field: number, value: number): Uint8Array {
	return Uint8Array.from([...varint(field * 8), ...varint(value)]);
}

function fieldBytes(field: number, payload: Uint8Array | string): Uint8Array {
	const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
	return Uint8Array.from([...varint(field * 8 + 2), ...varint(bytes.length), ...bytes]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

function makeUsageBlob(input: {
	modelId?: number;
	uncachedInput: number;
	output: number;
	cacheWrite?: number;
	cachedRead?: number;
	thinking?: number;
	responseId?: string;
}): Uint8Array {
	const parts: Uint8Array[] = [];
	if (input.modelId) parts.push(fieldVarint(1, input.modelId));
	if (input.uncachedInput) parts.push(fieldVarint(2, input.uncachedInput));
	if (input.output) parts.push(fieldVarint(3, input.output));
	if (input.cacheWrite) parts.push(fieldVarint(4, input.cacheWrite));
	if (input.cachedRead) parts.push(fieldVarint(5, input.cachedRead));
	if (input.thinking) parts.push(fieldVarint(9, input.thinking));
	if (input.responseId) parts.push(fieldBytes(11, input.responseId));
	return concat(...parts);
}

function makeGenMetadataBlob(input: {
	modelId: number;
	modelName?: string;
	timestampSec: number;
	usage: Uint8Array;
}): Uint8Array {
	const ts = fieldVarint(1, input.timestampSec);
	const inner = concat(
		fieldVarint(3, input.modelId),
		fieldBytes(4, input.usage),
		fieldBytes(9, fieldBytes(4, ts)),
		...(input.modelName ? [fieldBytes(19, input.modelName)] : []),
	);
	return fieldBytes(1, inner);
}

function makeStepMetadataBlob(input: {
	modelId: number;
	modelName?: string;
	timestampSec: number;
	usage: Uint8Array;
}): Uint8Array {
	const ts = fieldVarint(1, input.timestampSec);
	const model = concat(fieldVarint(1, input.modelId), ...(input.modelName ? [fieldBytes(12, input.modelName)] : []));
	return concat(fieldBytes(8, ts), fieldBytes(9, input.usage), fieldBytes(24, model));
}

describe("antigravity-db", () => {
	test("reads gen_metadata and steps, deduplicates shared response IDs, and computes latest context & totals", () => {
		const dir = tempDir("agy-db-");
		const dbPath = join(dir, "conv-1.db");
		const db = new Database(dbPath);
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB);");

		const call1Gen = makeGenMetadataBlob({
			modelId: 1417,
			modelName: "gemini-4-argon",
			timestampSec: 1_760_000_000,
			usage: makeUsageBlob({
				modelId: 1417,
				uncachedInput: 10_000,
				cachedRead: 0,
				output: 500,
				thinking: 200,
				responseId: "resp-1",
			}),
		});
		// Same response ID in `steps` with higher cached count: union-find merges & takes max.
		const call1Step = makeStepMetadataBlob({
			modelId: 1417,
			timestampSec: 1_760_000_000,
			usage: makeUsageBlob({
				modelId: 1417,
				uncachedInput: 10_000,
				cachedRead: 2_000,
				output: 500,
				thinking: 200,
				responseId: "resp-1",
			}),
		});
		const call2Gen = makeGenMetadataBlob({
			modelId: 1417,
			timestampSec: 1_760_000_060,
			usage: makeUsageBlob({
				modelId: 1417,
				uncachedInput: 5_000,
				cachedRead: 12_000,
				cacheWrite: 1_000,
				output: 800,
				thinking: 300,
				responseId: "resp-2",
			}),
		});
		db.query("INSERT INTO gen_metadata VALUES (?, ?)").run(1, call1Gen);
		db.query("INSERT INTO steps VALUES (?, ?)").run(1, call1Step);
		db.query("INSERT INTO gen_metadata VALUES (?, ?)").run(2, call2Gen);
		db.close();

		// Remove WAL/SHM sidecars after clean close (simulates cleanly closed WAL DB where plain readonly open fails).
		rmSync(`${dbPath}-wal`, { force: true });
		rmSync(`${dbPath}-shm`, { force: true });

		const usage = readAntigravityConversationUsage(dbPath);
		expect(usage).not.toBeNull();
		expect(usage!.calls).toHaveLength(2);
		expect(usage!.model).toBe("gemini-4-argon");
		expect(usage!.latest).toMatchObject({
			model: "gemini-4-argon",
			uncachedInputTokens: 5_000,
			cachedInputTokens: 12_000,
			cacheCreationTokens: 1_000,
			outputTokens: 800,
			reasoningTokens: 300,
			contextTokens: 18_800,
		});
		expect(usage!.totals).toEqual({
			uncachedInputTokens: 15_000,
			cachedInputTokens: 14_000,
			cacheCreationTokens: 1_000,
			outputTokens: 1_300,
			reasoningTokens: 500,
			callCount: 2,
		});
	});

	test("returns null for non-conversation index databases like conversation_summaries.db", () => {
		const dir = tempDir("agy-index-db-");
		const dbPath = join(dir, "conversation_summaries.db");
		const db = new Database(dbPath);
		db.exec("CREATE TABLE summaries (id TEXT PRIMARY KEY, data BLOB);");
		db.close();
		expect(readAntigravityConversationUsage(dbPath)).toBeNull();
	});

	test("locates sibling conversations/<id>.db from a brain transcript path", () => {
		const dir = tempDir("agy-layout-");
		const logsDir = join(dir, "brain", "sess-abc", ".system_generated", "logs");
		const convDir = join(dir, "conversations");
		mkdirSync(logsDir, { recursive: true });
		mkdirSync(convDir, { recursive: true });
		const transcript = join(logsDir, "transcript.jsonl");
		const dbPath = join(convDir, "sess-abc.db");
		writeFileSync(transcript, "");
		writeFileSync(dbPath, "");
		expect(findAntigravityConversationDb("sess-abc", { transcriptPath: transcript })).toBe(dbPath);
	});

	test("formats a /context-compatible report with System & tools, Messages, Free, and token notes", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: "",
				message: { role: "user", content: "a".repeat(400), timestamp: 0 },
			},
			{
				type: "message",
				id: "2",
				parentId: "1",
				timestamp: "",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "b".repeat(800) }],
					model: "antigravity/gemini-4-argon",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
					stopReason: "stop",
					timestamp: 0,
				},
			},
		];
		const text = formatAntigravityContextReport({
			usedTokens: 20_000,
			contextWindow: 1_000_000,
			source: "acp",
			entries,
			lastTurn: { input: 5_000, cacheRead: 14_000, cacheWrite: 0, output: 1_000, reasoningTokens: 400 },
			sessionTotals: {
				input: 15_000,
				cacheRead: 25_000,
				cacheWrite: 0,
				output: 2_500,
				reasoningTokens: 900,
				callCount: 3,
				costUsd: 0.12,
			},
		});
		expect(text).toContain("Context window: 1000000 tokens (2% used)");
		expect(text).toContain("System & tools");
		expect(text).toContain("Messages");
		expect(text).toContain("300 tokens");
		expect(text).toContain("Free");
		expect(text).toContain("980000 tokens");
		expect(text).toContain("Used: 20,000 / 1,000,000 tokens (live ACP usage_update)");
		expect(text).toContain("Last turn: 5,000 input · 14,000 cached read · 1,000 output (400 thinking)");
		expect(text).toContain("Session total (3 calls): 15,000 input · 25,000 cached · 2,500 output · ~$0.12");
	});
});
