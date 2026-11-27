import { expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { contextOverview } from "../src/lib/context-overview";

const base = (id: string) => ({ id, parentId: null, timestamp: "" });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };

test("splits omp's Messages total by the transcript after the last compaction, Tool Output per tool", () => {
	const entries = [
		// Before the compaction's first kept entry: not in the context.
		{ ...base("old"), type: "message", message: { role: "user", content: "x".repeat(10_000), timestamp: 0 } },
		{ ...base("c"), type: "compaction", summary: "s".repeat(100), firstKeptEntryId: "u", tokensBefore: 0 },
		{ ...base("u"), type: "message", message: { role: "user", content: "u".repeat(100), timestamp: 0 } },
		{
			...base("a"),
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "t".repeat(200) },
					{ type: "text", text: "a".repeat(200) },
					{ type: "toolCall", id: "1", name: "read", arguments: {} },
				],
				model: "m",
				usage,
				stopReason: "toolUse",
				timestamp: 0,
			},
		},
		{
			...base("r"),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "1",
				toolName: "read",
				content: [{ type: "text", text: "r".repeat(300) }],
				isError: false,
				timestamp: 0,
			},
		},
		{
			...base("g"),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "2",
				toolName: "grep",
				content: [{ type: "text", text: "g".repeat(94) }],
				isError: false,
				timestamp: 0,
			},
		},
	] as SessionEntry[];
	const { rows, split } = contextOverview(
		[
			{ label: "System prompt", percent: 1, tokens: 3000 },
			{ label: "System context", percent: 0, tokens: 100 },
			{ label: "System tools", percent: 5, tokens: 9600 },
			{ label: "Messages", percent: 1, tokens: 1000 },
			{ label: "Newer category", percent: 0, tokens: 5 },
			{ label: "Auto-compact buf", percent: 15, tokens: 30000 },
			{ label: "Free", percent: 70, tokens: 150000 },
		],
		entries,
	);
	expect(split).toBe(true);
	// Weights (chars): user 100 + 100 summary, assistant 200, thinking 200, calls 4 + 2, output 300 + 94 = 1000.
	expect(rows.map(r => [r.label, r.tokens, r.child ?? false])).toEqual([
		["System Prompt", 3100, false],
		["Instruction Files", 0, false],
		["Skills", 0, false],
		["Tools", 9600, false],
		["User / Developer Messages", 200, false],
		["Assistant Messages", 200, false],
		["Assistant Thinking", 200, false],
		["Tool Calls", 6, false],
		["Tool Output", 394, false],
		["read", 300, true],
		["grep", 94, true],
		["Newer category", 5, false],
		["Auto-Compact Buffer", 30000, false],
		["Free Space", 150000, false],
	]);
});

test("without a transcript to weigh by, Messages stays one row", () => {
	const { rows, split } = contextOverview([{ label: "Messages", percent: 1, tokens: 500 }], []);
	expect(split).toBe(false);
	expect(rows.find(r => r.key === "messages")?.tokens).toBe(500);
});

test("renders non-omp (Antigravity) reports without zeroed omp-only rows while still splitting Messages", () => {
	const entries = [
		{ ...base("u"), type: "message", message: { role: "user", content: "u".repeat(200), timestamp: 0 } },
		{
			...base("a"),
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "a".repeat(200) }],
				model: "antigravity/gemini-4-argon",
				usage,
				stopReason: "stop",
				timestamp: 0,
			},
		},
	] as SessionEntry[];
	const { rows, split, omp } = contextOverview(
		[
			{ label: "System & tools", percent: 2, tokens: 19_000 },
			{ label: "Messages", percent: 0, tokens: 1_000 },
			{ label: "Free", percent: 98, tokens: 980_000 },
		],
		entries,
	);
	expect(omp).toBe(false);
	expect(split).toBe(true);
	expect(rows.map(r => [r.label, r.tokens])).toEqual([
		["System & tools", 19_000],
		["User / Developer Messages", 500],
		["Assistant Messages", 500],
		["Assistant Thinking", 0],
		["Tool Calls", 0],
		["Tool Output", 0],
		["Free Space", 980_000],
	]);
});
