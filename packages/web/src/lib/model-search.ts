import type { ModelOption } from "@omp-web/protocol";
import { FuzzyCorpus } from "@oh-my-pi/pi-tui/fuzzy";

/**
 * omp's model search (`modelSearchText` / `ModelItemRanker` of the terminal UI's model browser), over the models the
 * daemon offers. The protocol carries no price, MRU list or catalog priority, so `free` is not in the haystack and the
 * base order is provider, then version (newest first), then recency suffix, then id.
 */

/** `provider/id`: the selector omp shows and matches. */
export const modelRef = (m: ModelOption): string => `${m.provider}/${m.id}`;

/** What the ranker knows about the user beyond the model list. */
export interface ModelSearchOptions {
	/**
	 * `provider/id` of every model a role is configured with, in role order (the same model once per role holding it).
	 * Those models, and then their providers, win ties between equally relevant matches.
	 */
	roleModels?: readonly string[];
	/**
	 * The session's current `provider/id`, standing in for omp's MRU list (which the protocol does not carry): after the
	 * role models, then after the role providers, as the most recently used model and provider.
	 */
	currentModel?: string;
}

/** The fuzzy haystack of a model: exactly what the picker shows. Must stay a pure function of the model. */
export function modelSearchText(m: ModelOption): string {
	return modelRef(m);
}

/** Collapse punctuation so exact and contiguous model-name matches form stable relevance tiers. */
function compactModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^\p{Letter}\p{Mark}\p{Number}]+/gu, "");
}

/** Exact id/selector → contiguous literal → fuzzy-only. */
function modelSearchTier(query: string, id: string, selector: string): number {
	if (!query) return 2;
	if (query === id || query === selector) return 0;
	if (id.includes(query) || selector.includes(query)) return 1;
	return 2;
}

/** The first version number of a model id (`gemini-2.5-pro` → 2.5, `claude-sonnet-4-6` → 4.6, `gpt-4o` → 4). */
function extractVersionNumber(id: string): number {
	const dotMatch = id.match(/(?:^|[-_])(\d+\.\d+)/);
	if (dotMatch) return Number.parseFloat(dotMatch[1]!);
	const dashMatch = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
	if (dashMatch) return Number.parseFloat(`${dashMatch[1]}.${dashMatch[2]}`);
	const singleMatch = id.match(/(?:^|[-_])(\d+)/);
	if (singleMatch) return Number.parseFloat(singleMatch[1]!);
	return 0;
}

const DATE_RE = /-(\d{8})$/;
const LATEST_RE = /-latest$/;

/** omp's base model order (`modelItemComparator` without role rank or MRU): provider, version desc, recency, id. */
function compareModels(a: ModelOption, b: ModelOption): number {
	const providerCmp = a.provider.localeCompare(b.provider);
	if (providerCmp !== 0) return providerCmp;

	const aVer = extractVersionNumber(a.id);
	const bVer = extractVersionNumber(b.id);
	if (aVer !== bVer) return bVer - aVer;

	const aIsLatest = LATEST_RE.test(a.id);
	const bIsLatest = LATEST_RE.test(b.id);
	const aDate = a.id.match(DATE_RE)?.[1] ?? "";
	const bDate = b.id.match(DATE_RE)?.[1] ?? "";
	const aHasRecency = aIsLatest || aDate !== "";
	const bHasRecency = bIsLatest || bDate !== "";
	if (aHasRecency !== bHasRecency) return aHasRecency ? -1 : 1;
	if (!aHasRecency) return a.id.localeCompare(b.id);
	if (aIsLatest !== bIsLatest) return aIsLatest ? -1 : 1;
	if (aDate && bDate) return bDate.localeCompare(aDate);
	return a.id.localeCompare(b.id);
}

interface RankKeys {
	compactId: string;
	compactSelector: string;
	modelAffinity: number;
	providerAffinity: number;
	/** Position class in the base order; comparator-equal models share it. */
	orderGroup: number;
}

/** Affinity ranks (lowercased `provider/id` and provider → rank) from the role-configured models, as omp's `buildSearchAffinity`. */
function buildAffinity(
	roleModels: readonly string[],
	currentModel: string | undefined,
): { models: Map<string, number>; providers: Map<string, number> } {
	const models = new Map<string, number>();
	const stats = new Map<string, { count: number; firstRole: number }>();
	roleModels.forEach((selector, roleIndex) => {
		const key = selector.toLowerCase();
		if (!models.has(key)) models.set(key, models.size);
		const slash = key.indexOf("/");
		if (slash <= 0) return;
		const provider = key.slice(0, slash);
		const current = stats.get(provider);
		if (current) current.count++;
		else stats.set(provider, { count: 1, firstRole: roleIndex });
	});
	const providers = new Map<string, number>();
	const ordered = [...stats.entries()].sort(([, a], [, b]) => b.count - a.count || a.firstRole - b.firstRole);
	for (const [provider] of ordered) providers.set(provider, providers.size);
	if (currentModel) {
		const key = currentModel.toLowerCase();
		if (!models.has(key)) models.set(key, models.size);
		const slash = key.indexOf("/");
		const provider = slash > 0 ? key.slice(0, slash) : "";
		if (provider && !providers.has(provider)) providers.set(provider, providers.size);
	}
	return { models, providers };
}

/**
 * Ranks one model list by text relevance (exact, contiguous, fuzzy), then role affinity, fuzzy quality bucket and base
 * order. The fuzzy index and the query-independent keys are built once, so hold one per model list and call
 * {@link rank} on every keystroke.
 */
export class ModelSearch {
	readonly models: readonly ModelOption[];
	readonly #corpus: FuzzyCorpus<ModelOption>;
	readonly #keys = new Map<ModelOption, RankKeys>();

	constructor(models: readonly ModelOption[], options: ModelSearchOptions = {}) {
		this.models = models;
		this.#corpus = new FuzzyCorpus(models, modelSearchText);
		const affinity = buildAffinity(options.roleModels ?? [], options.currentModel);
		const ordered = [...models].sort(compareModels);
		let group = 0;
		for (let i = 0; i < ordered.length; i++) {
			const model = ordered[i]!;
			if (i > 0 && compareModels(ordered[i - 1]!, model) !== 0) group++;
			this.#keys.set(model, {
				compactId: compactModelSearchText(model.id),
				compactSelector: compactModelSearchText(modelRef(model)),
				modelAffinity: affinity.models.get(modelRef(model).toLowerCase()) ?? Number.MAX_SAFE_INTEGER,
				providerAffinity: affinity.providers.get(model.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER,
				orderGroup: group,
			});
		}
	}

	/** Every matching model, best first; a blank query keeps the list as given. */
	rank(query: string): ModelOption[] {
		if (!query.trim()) return [...this.models];
		const queryKey = compactModelSearchText(query);
		const rows = this.#corpus.rank(query).map((result, fuzzyIndex) => {
			const keys = this.#keys.get(result.item)!;
			return {
				model: result.item,
				keys,
				tier: modelSearchTier(queryKey, keys.compactId, keys.compactSelector),
				bucket: Math.round(result.score / 10),
				fuzzyIndex,
			};
		});
		rows.sort(
			(a, b) =>
				a.tier - b.tier ||
				a.keys.modelAffinity - b.keys.modelAffinity ||
				a.keys.providerAffinity - b.keys.providerAffinity ||
				a.bucket - b.bucket ||
				a.keys.orderGroup - b.keys.orderGroup ||
				a.fuzzyIndex - b.fuzzyIndex,
		);
		return rows.map(row => row.model);
	}
}
