import { readModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { calculateUsageCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelCost, Usage } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Thinking suffix of agy's legacy per-level model ids (`gemini-4-argon-high`); config option ids carry none. */
const LEVEL_SUFFIX = /-(?:extra-low|low|medium|high|xhigh|tiered|control|thinking)$/;

/**
 * The omp catalog row an agy model is priced/sized as: the vendor's own API row for the same model (`google/…`,
 * `anthropic/…`), GPT-OSS at Vertex AI's (Google hosts it for agy), and Gemini 4 orchestrators at their base Gemini 4
 * rate. Agy's own rows (`antigravity-cli/…`) are $0 (subscription).
 */
function catalogRef(id: string): { provider: string; id: string } | undefined {
	if (id === "gemini-pro-orchestrator-neon") return { provider: "google", id: "gemini-4-neon" };
	if (id === "gemini-pro-orchestrator-g1-pro") return { provider: "google", id: "gemini-4-argon" };
	if (id.includes("orchestrator")) return undefined;
	if (id.startsWith("gemini-")) return { provider: "google", id };
	if (id.startsWith("claude-")) return { provider: "anthropic", id };
	if (id === "gpt-oss-120b") return { provider: "google-vertex", id: "openai/gpt-oss-120b-maas" };
	return undefined;
}

function lookupCatalogModel(ref: { provider: string; id: string } | undefined, modelDb: string | undefined) {
	if (!ref) return undefined;
	const cached = readModelCache(ref.provider, Number.POSITIVE_INFINITY, Date.now, modelDb)?.models.find(
		m => m.id === ref.id,
	);
	return cached ?? getBundledModel(ref.provider, ref.id);
}

/**
 * The row's price as omp itself would use it: its discovered model cache (`modelDb`, default `<agent-dir>/models.db`,
 * refreshed by omp and newer than the bundled catalog — e.g. Gemini 4 Neon), else the bundled catalog. A $0 row counts
 * as no price.
 */
function pricedCost(
	ref: { provider: string; id: string } | undefined,
	modelDb: string | undefined,
): ModelCost | undefined {
	const cost = lookupCatalogModel(ref, modelDb)?.cost;
	if (!cost) return undefined;
	return cost.input > 0 || cost.output > 0 ? cost : undefined;
}

/**
 * What omp's model data says an agy model id costs per million tokens at API rates; undefined when it has no price.
 * `modelDb` overrides omp's model cache path.
 */
export function antigravityModelCost(modelId: string, modelDb?: string): ModelCost | undefined {
	const id = modelId.toLowerCase();
	return (
		pricedCost(catalogRef(id), modelDb) ??
		(LEVEL_SUFFIX.test(id) ? pricedCost(catalogRef(id.replace(LEVEL_SUFFIX, "")), modelDb) : undefined)
	);
}

/**
 * Context window size (tokens) for an Antigravity model id from omp's model catalog, used as fallback before `agy`
 * emits a live `usage_update.size` (e.g. when restoring context usage from a conversation DB).
 */
export function antigravityModelContextWindow(modelId: string, modelDb?: string): number | undefined {
	const id = modelId.toLowerCase();
	const found =
		lookupCatalogModel(catalogRef(id), modelDb) ??
		(LEVEL_SUFFIX.test(id) ? lookupCatalogModel(catalogRef(id.replace(LEVEL_SUFFIX, "")), modelDb) : undefined);
	const windowTokens = found?.contextWindow;
	return typeof windowTokens === "number" && Number.isFinite(windowTokens) && windowTokens > 0
		? windowTokens
		: undefined;
}

/** Estimates API dollar cost for one decoded Antigravity model call. */
export function antigravityCallCostUsd(
	call: {
		model: string;
		uncachedInputTokens: number;
		cachedInputTokens: number;
		cacheCreationTokens: number;
		outputTokens: number;
		timestampMs?: number | null;
	},
	modelDb?: string,
): number {
	if (!call.model) return 0;
	const cost = antigravityModelCost(call.model, modelDb);
	if (!cost) return 0;
	const usage: Usage = {
		input: call.uncachedInputTokens,
		output: call.outputTokens,
		cacheRead: call.cachedInputTokens,
		cacheWrite: call.cacheCreationTokens,
		totalTokens: call.uncachedInputTokens + call.cachedInputTokens + call.cacheCreationTokens + call.outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateUsageCost(cost, usage, call.timestampMs ?? Date.now());
	return usage.cost.total;
}

const tokens = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * A `session/prompt` result's `usage` (summed over the turn's model calls: `inputTokens` uncached, `outputTokens`
 * thinking included) as omp usage, priced at `cost` when given. Undefined without a usage report.
 */
export function antigravityTurnUsage(raw: unknown, cost: ModelCost | undefined, timestamp: number): Usage | undefined {
	if (!isRecord(raw)) return undefined;
	const usage: Usage = {
		input: tokens(raw.inputTokens),
		output: tokens(raw.outputTokens),
		cacheRead: tokens(raw.cachedReadTokens),
		cacheWrite: tokens(raw.cachedWriteTokens),
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	usage.totalTokens = tokens(raw.totalTokens) || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const reasoning = tokens(raw.thoughtTokens);
	if (reasoning > 0) usage.reasoningTokens = reasoning;
	if (usage.totalTokens === 0) return undefined;
	if (cost) calculateUsageCost(cost, usage, timestamp);
	return usage;
}
