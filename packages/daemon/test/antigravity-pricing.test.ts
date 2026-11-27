import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { antigravityModelContextWindow, antigravityModelCost, antigravityTurnUsage } from "../src/antigravity-pricing";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** An omp model cache of its own, never the machine's `<agent-dir>/models.db`. */
function modelDb(): string {
	const dir = mkdtempSync(join(tmpdir(), "agy-price-"));
	dirs.push(dir);
	return join(dir, "models.db");
}

describe("antigravityModelCost", () => {
	test("prices agy model ids (config and legacy per-level forms) at the vendor's API row", () => {
		const db = modelDb();
		const google = getBundledModel("google", "gemini-4-argon").cost;
		expect(antigravityModelCost("gemini-4-argon", db)).toBe(google);
		expect(antigravityModelCost("gemini-4-argon-xhigh", db)).toBe(google);
		expect(antigravityModelCost("gemini-3.8-flash-low", db)).toBe(getBundledModel("google", "gemini-3.8-flash").cost);
		expect(antigravityModelCost("claude-opus-5-5-high", db)).toBe(
			getBundledModel("anthropic", "claude-opus-5-5").cost,
		);
		expect(antigravityModelCost("gpt-oss-120b-medium", db)).toBe(
			getBundledModel("google-vertex", "openai/gpt-oss-120b-maas").cost,
		);
	});

	test("prefers omp's discovered model cache, which knows models the bundled catalog does not price", () => {
		const db = modelDb();
		expect(antigravityModelCost("gemini-4-unobtainium", db)).toBeUndefined();
		const neonCost = { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 };
		const argon = getBundledModel("google", "gemini-4-argon");
		expect(
			writeModelCache(
				"google",
				Date.now(),
				[{ ...argon, id: "gemini-4-unobtainium", cost: neonCost }],
				true,
				"",
				db,
			),
		).not.toBe("failed");
		expect(antigravityModelCost("gemini-4-unobtainium-high", db)).toEqual(neonCost);
	});

	test("prices Gemini 4 orchestrators at their base Gemini 4 rate and leaves unknown models unpriced", () => {
		const db = modelDb();
		const argon = getBundledModel("google", "gemini-4-argon");
		expect(antigravityModelCost("gemini-pro-orchestrator-g1-pro", db)).toBe(argon.cost);
		const neonCost = { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 };
		writeModelCache("google", Date.now(), [{ ...argon, id: "gemini-4-neon", cost: neonCost }], true, "", db);
		expect(antigravityModelCost("gemini-pro-orchestrator-neon", db)).toEqual(neonCost);
		expect(antigravityModelCost("some-future-model", db)).toBeUndefined();
	});

	test("resolves contextWindow for Antigravity models from omp's catalog", () => {
		const db = modelDb();
		const expected = getBundledModel("google", "gemini-4-argon").contextWindow ?? undefined;
		expect(expected).toBeGreaterThan(0);
		expect(antigravityModelContextWindow("gemini-4-argon", db)).toBe(expected);
		expect(antigravityModelContextWindow("gemini-4-argon-high", db)).toBe(expected);
		expect(antigravityModelContextWindow("some-future-model", db)).toBeUndefined();
	});
});

describe("antigravityTurnUsage", () => {
	test("maps an ACP prompt usage report and prices its buckets", () => {
		const cost = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
		const usage = antigravityTurnUsage(
			{ inputTokens: 13771, outputTokens: 416, cachedReadTokens: 14212, thoughtTokens: 332, totalTokens: 28399 },
			cost,
			0,
		);
		expect(usage).toMatchObject({ input: 13771, output: 416, cacheRead: 14212, cacheWrite: 0, totalTokens: 28399 });
		expect(usage?.reasoningTokens).toBe(332);
		expect(usage?.cost.total).toBeCloseTo((13771 * 2 + 416 * 10 + 14212 * 0.1) / 1e6, 10);
	});

	test("counts tokens without a price, and nothing without a report", () => {
		expect(antigravityTurnUsage({ inputTokens: 10, outputTokens: 5 }, undefined, 0)).toMatchObject({
			totalTokens: 15,
			cost: { total: 0 },
		});
		expect(antigravityTurnUsage(undefined, undefined, 0)).toBeUndefined();
		expect(antigravityTurnUsage({}, undefined, 0)).toBeUndefined();
	});
});
