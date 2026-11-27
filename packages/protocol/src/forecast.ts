/**
 * Cache forecast for switching a thread to another environment.
 *
 * Pure classification: two {@link SessionFacts} (what the source would send next, what the target would send next) plus
 * the clock go in, a {@link CacheForecast} comes out. No I/O, no node/bun imports: the browser may run it too.
 *
 * The provider cache is keyed on the exact request prefix (tools, then system blocks, then messages) and is scoped to an
 * account. "Observed" below means decided from equality of the hashes in the facts; "inference" means the verdict also
 * rests on provider documentation or on reading omp's source, and the item carries `inference: true`.
 *
 * Items (always all present, always in this order) and their rules
 *
 * | id         | hit                                              | miss                                              | unknown / na                         | inference            |
 * |------------|--------------------------------------------------|---------------------------------------------------|--------------------------------------|----------------------|
 * | tools      | hashes equal                                     | hashes differ: invalidates everything after it    | unknown: either side has no tools    | no                   |
 * | systemHead | hashes equal                                     | hashes differ: invalidates everything after it    | unknown: either side has no head     | no                   |
 * | systemTail | hashes equal                                     | hashes differ: history cache lost, tools+head may | unknown: either side has no tail     | miss: yes            |
 * |            |                                                  | still hit (breakpoint after the static head)      |                                      |                      |
 * | history    | `history.hash` equal (the daemon fingerprints    | hashes differ                                     | -                                    | no                   |
 * |            | the target over exactly the source's entry count)|                                                   |                                      |                      |
 * | model      | provider + id equal (+ api when both known)      | any differs: models never share a cache           | unknown: either side has no model    | no                   |
 * | thinking   | levels equal (both unreported counts as equal)   | differ: message cache lost, tools+system survive  | unknown: only one side reported      | miss: yes            |
 * | tier       | (fastModeActive, slowModeEnabled) equal          | differ: same effect as thinking                   | na: neither side uses fast / slow    | miss: yes            |
 * | account    | source pin for the model's provider found among  | pin exists, target accounts known, no match       | unknown: no pin (API key / no OAuth) | miss: yes            |
 * |            | the target's account hashes                      |                                                   | or target accounts unavailable       |                      |
 * | ttl        | now - lastRequestAt < lifetime                   | now - lastRequestAt >= lifetime (strict: at the   | na: no assistant response yet        | always               |
 * |            |                                                  | boundary the entry is expiring: counted as lost)  |                                      |                      |
 * | cacheKey   | target key non-null and equal to the source's    | target key absent or different                    | na: Anthropic / non-OpenAI API       | miss: yes            |
 * |            | effective key (`promptCacheKey ?? sessionId`)    |                                                   |                                      |                      |
 *
 * Unsettled prompt: when `source.settled` or `target.settled` is `false` (the prompt was still changing when read: omp
 * rebuilds it after startup, MCP servers connect asynchronously), every tools / systemHead / systemTail item that is a
 * `miss` becomes an inference (`inference: true`), its detail says the difference may not be real, and a miss headline
 * therefore ends in `(inference)`. Hits are unaffected: equal hashes stay equal.
 *
 * Lifetime: 5 minutes; 1 hour when the provider is Anthropic and the session was served by an OAuth account (a pin exists
 * for the provider). Inference from `getCacheControl` in packages/ai anthropic.ts: API key -> short retention, OAuth ->
 * long where the model supports it. Not known here: an explicit `cacheRetention` / `PI_CACHE_RETENTION` override, and
 * whether the cache warmer kept the entry alive.
 *
 * Summary
 *  - nothing is cached yet (`lastRequestAt` null): `hit` (nothing to lose), headline says so, `rewriteTokens` 0. The items
 *    still show what would differ.
 *  - `miss`: tools, systemHead, model, account or ttl misses (each invalidates the whole prefix or the whole cache).
 *  - `partial`: none of those, but systemTail, history, thinking or tier misses (tools + static head still hit: inference).
 *  - `hit`: nothing misses. Unknown items never downgrade; they are named in the headline. When every item that compares
 *    prompt content (tools, head, tail, model) is unknown the headline says the state could not be determined.
 *  - `rewriteTokens`: `hit` 0; `miss` the whole context; `partial` the context minus the estimated tools + head
 *    (`ceil((systemHead.chars + tools.count * TOOL_CHARS_ESTIMATE) / 4)`). The facts carry the tool count, not the size of
 *    the tools JSON, so the tool part is a stated rough constant: a coarse estimate, nothing more. Null when the context
 *    size is unknown.
 */

import type { CacheForecast, ForecastItem, ForecastItemId, ForecastSummary, ModelRef, SessionFacts } from "./handoff";

/** Rough size of one tool definition (name, description, JSON schema, examples) when serialized: only a count is in the facts. */
export const TOOL_CHARS_ESTIMATE = 600;
/** Characters per token for the rewrite estimate. */
const CHARS_PER_TOKEN = 4;
const MINUTE = 60_000;
/** Default cache lifetime (Anthropic `ephemeral` without `ttl`, and the OpenAI-family in-memory cache range). */
export const SHORT_CACHE_LIFETIME_MS = 5 * MINUTE;
/** Anthropic one-hour retention, used for OAuth-served sessions. */
export const LONG_CACHE_LIFETIME_MS = 60 * MINUTE;

export interface ForecastOptions {
	now: number;
	/** The switch stays on one machine: same OS/arch, same object store; only the working directory differs. */
	sameMachine: boolean;
}

const LABELS: Record<ForecastItemId, string> = {
	tools: "Tools (incl. examples)",
	systemHead: "System prompt, static head",
	systemTail: "System prompt, volatile tail",
	history: "History prefix",
	model: "Model",
	thinking: "Thinking level",
	tier: "Fast / slow tier",
	account: "Account",
	ttl: "Cache lifetime",
	cacheKey: "Prompt cache key",
};

const ITEM_ORDER: readonly ForecastItemId[] = [
	"tools",
	"systemHead",
	"systemTail",
	"history",
	"model",
	"thinking",
	"tier",
	"account",
	"ttl",
	"cacheKey",
];

/** Items whose miss loses the whole cache. */
const FULL_MISS_ITEMS: readonly ForecastItemId[] = ["tools", "systemHead", "model", "account", "ttl"];
/** Items whose miss loses the messages but leaves tools + static head alone. */
const PARTIAL_MISS_ITEMS: readonly ForecastItemId[] = ["systemTail", "history", "thinking", "tier"];
/** Items that compare what the prompt contains: when none could be read, the forecast has nothing to go on. */
const MATTERS_ITEMS: readonly ForecastItemId[] = ["tools", "systemHead", "systemTail", "model"];

interface Ctx {
	source: SessionFacts;
	target: SessionFacts;
	options: ForecastOptions;
}

const make = (id: ForecastItemId, status: ForecastItem["status"], detail: string, inference = false): ForecastItem => ({
	id,
	label: LABELS[id],
	status,
	detail,
	inference,
});

const modelLabel = (m: ModelRef): string => `${m.provider}/${m.id}`;

function sameModel(a: ModelRef, b: ModelRef): boolean {
	if (a.provider !== b.provider || a.id !== b.id) return false;
	return a.api === undefined || b.api === undefined || a.api === b.api;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds} s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** `12,300`: estimates are never more precise than a hundred tokens (ten below a thousand). */
function formatTokens(n: number): string {
	const step = n >= 1000 ? 100 : 10;
	return (Math.round(n / step) * step).toLocaleString("en-US");
}

function ompNote(ctx: Ctx): string {
	const { source, target } = ctx;
	return source.omp === target.omp
		? ""
		: ` The omp versions differ (${source.omp} → ${target.omp}), which can change them.`;
}

function toolsItem(ctx: Ctx): ForecastItem {
	const { source, target } = ctx;
	if (!source.tools || !target.tools) {
		const missing = !source.tools && !target.tools ? "either side" : !source.tools ? "the source" : "the target";
		return make("tools", "unknown", `omp did not report the tool list for ${missing}: cannot compare it.`);
	}
	if (source.tools.hash === target.tools.hash) {
		return make("tools", "hit", `${source.tools.count} tools, descriptions, schemas and examples are identical.`);
	}
	return make(
		"tools",
		"miss",
		`The tool definitions differ (${source.tools.count} → ${target.tools.count} tools; names, descriptions, schemas or examples). ` +
			`Tools come first in the prompt prefix: a difference invalidates the system prompt and the history after it.${ompNote(ctx)}`,
	);
}

function systemHeadItem(ctx: Ctx): ForecastItem {
	const { source, target } = ctx;
	if (!source.systemHead || !target.systemHead) {
		const missing =
			!source.systemHead && !target.systemHead ? "either side" : !source.systemHead ? "the source" : "the target";
		return make(
			"systemHead",
			"unknown",
			`omp did not report the system prompt for ${missing}: cannot compare its head.`,
		);
	}
	if (source.systemHead.hash === target.systemHead.hash) {
		return make("systemHead", "hit", `The static head (${source.systemHead.chars} chars) is identical.`);
	}
	return make(
		"systemHead",
		"miss",
		`The static head of the system prompt differs (${source.systemHead.chars} → ${target.systemHead.chars} chars). ` +
			`It precedes the messages: a difference invalidates the history after it.${ompNote(ctx)}`,
	);
}

function systemTailItem(ctx: Ctx): ForecastItem {
	const { source, target, options } = ctx;
	if (!source.systemTail || !target.systemTail) {
		const missing =
			!source.systemTail && !target.systemTail ? "either side" : !source.systemTail ? "the source" : "the target";
		return make(
			"systemTail",
			"unknown",
			`omp did not report the system prompt for ${missing}: cannot compare its tail.`,
		);
	}
	if (source.systemTail.hash === target.systemTail.hash) {
		return make("systemTail", "hit", `The volatile tail (${source.systemTail.chars} chars) is identical.`);
	}
	const platform =
		source.platform === target.platform ? "" : ` The platform differs (${source.platform} → ${target.platform}).`;
	const what = options.sameMachine
		? "On the same machine the OS and architecture are the same, so the difference most likely comes from content that depends on the workspace roots / working directory (context files, skills, memories found there)."
		: "It holds the OS / architecture line, workspace roots, context files, skills and memories; any of them can differ between machines.";
	return make(
		"systemTail",
		"miss",
		`The volatile tail of the system prompt differs (${source.systemTail.chars} → ${target.systemTail.chars} chars). ${what}${platform} ` +
			"It sits before the messages, so the history cache is lost; Anthropic puts a cache breakpoint after the static head, so tools and head can still hit (inference).",
		true,
	);
}

function historyItem(ctx: Ctx): ForecastItem {
	const { source, target, options } = ctx;
	const h = source.history;
	const notes: string[] = [];
	if (h.compactions > 0) {
		notes.push(
			`The session has ${h.compactions} compaction${h.compactions === 1 ? "" : "s"}: history before the newest one is not sent, so the part that has to be rewritten is smaller.`,
		);
	}
	if (!options.sameMachine) {
		notes.push(
			"A switch to another machine appends one session-transfer notice after the cached prefix: it is written, not read.",
		);
	}
	const tail = notes.length > 0 ? ` ${notes.join(" ")}` : "";
	if (source.history.hash === target.history.hash) {
		return make("history", "hit", `The fork keeps all ${h.entries} history entries unchanged.${tail}`);
	}
	return make(
		"history",
		"miss",
		`The history of the target differs from the source (${h.entries} → ${target.history.entries} entries): its cached prefix does not match.${tail}`,
	);
}

function modelItem(ctx: Ctx): ForecastItem {
	const { source, target } = ctx;
	if (!source.model || !target.model) {
		const missing = !source.model && !target.model ? "either side" : !source.model ? "the source" : "the target";
		return make("model", "unknown", `omp did not report the model for ${missing}: cannot compare it.`);
	}
	if (sameModel(source.model, target.model)) return make("model", "hit", `Same model, ${modelLabel(source.model)}.`);
	return make(
		"model",
		"miss",
		`The model differs (${modelLabel(source.model)} → ${modelLabel(target.model)}). Different models never share a cache.`,
	);
}

function thinkingItem(ctx: Ctx): ForecastItem {
	const { source, target } = ctx;
	const a = source.thinkingLevel;
	const b = target.thinkingLevel;
	if (a === b) {
		return make(
			"thinking",
			"hit",
			a === null ? "No thinking level reported on either side." : `Thinking level ${a} on both sides.`,
		);
	}
	if (a === null || b === null) {
		return make(
			"thinking",
			"unknown",
			`The thinking level is reported on one side only (${a ?? "none"} → ${b ?? "none"}): cannot compare it.`,
		);
	}
	return make(
		"thinking",
		"miss",
		`The thinking level differs (${a} → ${b}). Changing it invalidates the cached messages; tools and system prompt survive (Anthropic documentation).`,
		true,
	);
}

function tierItem(ctx: Ctx): ForecastItem {
	const { source, target } = ctx;
	const describe = (f: SessionFacts): string => (f.fastModeActive ? "fast" : f.slowModeEnabled ? "slow" : "standard");
	if (!source.fastModeActive && !source.slowModeEnabled && !target.fastModeActive && !target.slowModeEnabled) {
		return make("tier", "na", "Neither side uses the fast or slow tier.");
	}
	if (source.fastModeActive === target.fastModeActive && source.slowModeEnabled === target.slowModeEnabled) {
		return make("tier", "hit", `The ${describe(source)} tier is active on both sides.`);
	}
	return make(
		"tier",
		"miss",
		`The service tier differs (${describe(source)} → ${describe(target)}). Like the thinking level, it invalidates the cached messages and spares tools and system prompt (Anthropic documentation).`,
		true,
	);
}

function accountItem(ctx: Ctx): ForecastItem {
	const { source, target } = ctx;
	const provider = source.model?.provider;
	if (!provider)
		return make(
			"account",
			"unknown",
			"The source model, and so its provider, is unknown: cannot look up its account.",
		);
	const pin = source.pins.find(p => p.provider === provider);
	if (!pin) {
		return make(
			"account",
			"unknown",
			`No OAuth account is pinned to this session (API-key credentials carry no pin): the target uses whatever ${provider} credential it ranks first; the cache hits only if it is the same key.`,
		);
	}
	if (target.accounts.via === "unavailable") {
		const reason = target.accounts.reason ? `: ${target.accounts.reason}` : "";
		return make(
			"account",
			"unknown",
			`The accounts of the target could not be read${reason}. The session is pinned to a ${provider} OAuth account.`,
		);
	}
	if (target.accounts.hashes.some(h => h.provider === provider && h.hash === pin.hash)) {
		return make("account", "hit", `The same ${provider} account is available on both machines.`);
	}
	return make(
		"account",
		"miss",
		`The target has no matching ${provider} account: provider caches are account-scoped; omp will pick another account.`,
		true,
	);
}

/** Cache lifetime in force for the source session, and why. */
function lifetimeOf(source: SessionFacts): { ms: number; why: string } {
	const provider = source.model?.provider;
	if (provider === "anthropic" && source.pins.some(p => p.provider === provider)) {
		return {
			ms: LONG_CACHE_LIFETIME_MS,
			why: "1 hour: Anthropic served through an OAuth account, where omp asks for long retention",
		};
	}
	return {
		ms: SHORT_CACHE_LIFETIME_MS,
		why:
			provider === "anthropic" ? "5 minutes: Anthropic through an API key (short retention)" : "5 minutes (default)",
	};
}

function ttlItem(ctx: Ctx): ForecastItem {
	const { source, options } = ctx;
	if (source.lastRequestAt === null) {
		return make("ttl", "na", "No request has been answered yet: nothing is cached.", true);
	}
	const { ms, why } = lifetimeOf(source);
	const elapsed = Math.max(0, options.now - source.lastRequestAt);
	const warmer =
		" The cache warmer (refreshes at 90 % of the lifetime, only while a run is active for the 1 h tier, idle warming capped at 30 min) may or may not have kept it alive.";
	if (elapsed < ms) {
		return make(
			"ttl",
			"hit",
			`The last response was ${formatDuration(elapsed)} ago, within the lifetime of ${why}.${warmer}`,
			true,
		);
	}
	return make(
		"ttl",
		"miss",
		`The last response was ${formatDuration(elapsed)} ago, beyond the lifetime of ${why}: the cache has probably expired.${warmer}`,
		true,
	);
}

/** Whether the model talks the OpenAI-family wire (the only family that keys its cache on `prompt_cache_key`). */
function usesPromptCacheKey(model: ModelRef | null): boolean {
	if (!model) return false;
	if (model.api !== undefined) return model.api.startsWith("openai");
	return model.provider !== "anthropic";
}

function cacheKeyItem(ctx: Ctx): ForecastItem {
	const { source, target } = ctx;
	if (!usesPromptCacheKey(source.model)) {
		return make("cacheKey", "na", "Only OpenAI-family providers key their cache on a prompt cache key.");
	}
	// A session without the header field sends (and a fork inherits) its own session id.
	const sourceKey = source.promptCacheKey ?? source.sessionId;
	if (target.promptCacheKey === null) {
		return make(
			"cacheKey",
			"miss",
			"The target session has no prompt cache key: its first request would not use the key the source's cache is stored under.",
			true,
		);
	}
	if (target.promptCacheKey === sourceKey) {
		return make("cacheKey", "hit", "The fork inherits the source's prompt cache key (its own, else its session id).");
	}
	return make(
		"cacheKey",
		"miss",
		"The target's prompt cache key differs from the source's: the provider routes it to another cache.",
		true,
	);
}

const joinList = (words: string[]): string =>
	words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** Estimated tokens the first request writes again, or null when the context size is unknown. */
function rewriteEstimate(ctx: Ctx, summary: ForecastSummary, nothingCached: boolean): number | null {
	if (nothingCached || summary === "hit") return 0;
	const { source, target } = ctx;
	const tokens = source.context?.tokens ?? target.context?.tokens ?? null;
	if (tokens === null) return null;
	if (summary === "miss") return tokens;
	const keptChars = (source.systemHead?.chars ?? 0) + (source.tools?.count ?? 0) * TOOL_CHARS_ESTIMATE;
	return Math.max(0, tokens - Math.ceil(keptChars / CHARS_PER_TOKEN));
}

/**
 * A tools / system-prompt miss may be an artefact when either end was read while its prompt was still changing. The
 * status stays `miss` (the summary is the pessimistic reading) but the item is flagged as an inference with a note.
 */
function markUnsettled(built: Record<ForecastItemId, ForecastItem>, ctx: Ctx): void {
	const ends = [ctx.source.settled === false ? "source" : null, ctx.target.settled === false ? "target" : null].filter(
		end => end !== null,
	);
	if (ends.length === 0) return;
	const note = ` The prompt of the ${ends.join(" and the ")} was still changing when it was read (tools / MCP servers connect after startup), so this may not be a real difference.`;
	for (const id of ["tools", "systemHead", "systemTail"] as const) {
		const item = built[id];
		if (item.status === "miss") built[id] = { ...item, detail: item.detail + note, inference: true };
	}
}

export function forecastCache(source: SessionFacts, target: SessionFacts, options: ForecastOptions): CacheForecast {
	const ctx: Ctx = { source, target, options };
	const built: Record<ForecastItemId, ForecastItem> = {
		tools: toolsItem(ctx),
		systemHead: systemHeadItem(ctx),
		systemTail: systemTailItem(ctx),
		history: historyItem(ctx),
		model: modelItem(ctx),
		thinking: thinkingItem(ctx),
		tier: tierItem(ctx),
		account: accountItem(ctx),
		ttl: ttlItem(ctx),
		cacheKey: cacheKeyItem(ctx),
	};
	markUnsettled(built, ctx);
	const items = ITEM_ORDER.map(id => built[id]);
	const missed = (ids: readonly ForecastItemId[]): ForecastItem[] =>
		ids.map(id => built[id]).filter(i => i.status === "miss");

	const nothingCached = source.lastRequestAt === null;
	const fullMisses = missed(FULL_MISS_ITEMS);
	const partialMisses = missed(PARTIAL_MISS_ITEMS);
	const summary: ForecastSummary = nothingCached
		? "hit"
		: fullMisses.length > 0
			? "miss"
			: partialMisses.length > 0
				? "partial"
				: "hit";
	const rewriteTokens = rewriteEstimate(ctx, summary, nothingCached);
	const rewritten =
		rewriteTokens !== null && rewriteTokens > 0 ? ` (~${formatTokens(rewriteTokens)} tokens rewritten)` : "";

	let headline: string;
	if (nothingCached) {
		headline = "Nothing is cached yet; nothing to lose";
	} else if (summary === "miss") {
		const reasons = fullMisses.map(item => reasonOf(item, ctx));
		const inferred = fullMisses.some(i => i.inference) ? " (inference)" : "";
		headline = `Cache miss: ${reasons.join("; ")}${rewritten}${inferred}`;
	} else if (summary === "partial") {
		const names = partialMisses.map(i => shortName(i.id));
		const verb = names.length === 1 ? "misses" : "miss";
		headline = `Partial hit: tools and system head hit, ${joinList(names)} ${verb}${rewritten} (inference)`;
	} else {
		const unknown = items.filter(i => i.status === "unknown");
		if (MATTERS_ITEMS.every(id => built[id].status === "unknown")) {
			headline = `Cache state could not be determined: every item that matters is unknown (${joinList(unknown.map(i => i.label))})`;
		} else {
			const inferred = items.some(i => i.status === "hit" && i.inference) ? " (inference)" : "";
			const unchecked = unknown.length > 0 ? `; could not check: ${joinList(unknown.map(i => i.label))}` : "";
			headline = `Full cache hit${inferred}${unchecked}`;
		}
	}
	return { summary, headline, rewriteTokens, items, computedAt: options.now };
}

function shortName(id: ForecastItemId): string {
	switch (id) {
		case "systemTail":
			return "system tail";
		case "thinking":
			return "thinking level";
		case "tier":
			return "service tier";
		default:
			return id;
	}
}

/** One clause of a miss headline. */
function reasonOf(item: ForecastItem, ctx: Ctx): string {
	const { source, target } = ctx;
	switch (item.id) {
		case "tools":
			return "tools differ";
		case "systemHead":
			return "system head differs";
		case "model":
			return source.model && target.model
				? `model differs (${modelLabel(source.model)} → ${modelLabel(target.model)})`
				: "model differs";
		case "account":
			return "no matching account on the target";
		case "ttl":
			return "cache probably expired";
		default:
			return `${item.label} misses`;
	}
}
