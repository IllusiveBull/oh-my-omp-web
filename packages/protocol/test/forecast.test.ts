import { describe, expect, test } from "bun:test";
import {
	type CacheForecast,
	forecastCache,
	LONG_CACHE_LIFETIME_MS,
	SHORT_CACHE_LIFETIME_MS,
	TOOL_CHARS_ESTIMATE,
	type ForecastItem,
	type ForecastItemId,
	type SessionFacts,
} from "../src";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const PIN = "pin-hash-1";

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
	sessionId: "sess-source",
	origin: "live",
	capturedAt: NOW,
	omp: "18.19.0",
	platform: "darwin-arm64",
	model: { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" },
	thinkingLevel: "high",
	fastModeActive: false,
	slowModeEnabled: false,
	tools: { hash: "tools-a", count: 10 },
	systemHead: { hash: "head-a", chars: 4000 },
	systemTail: { hash: "tail-a", chars: 1200 },
	context: { tokens: 20_000, window: 200_000 },
	lastRequestAt: NOW - MIN,
	history: { entries: 40, hash: "hist-a", compactions: 0, lastCompactionIndex: null },
	pins: [{ provider: "anthropic", hash: PIN }],
	accounts: { via: "local-db", hashes: [] },
	promptCacheKey: null,
	...over,
});

/** The target of a clean switch: everything the source has, plus the account list that contains the pin. */
const twin = (over: Partial<SessionFacts> = {}): SessionFacts =>
	facts({
		sessionId: "sess-target",
		accounts: { via: "local-db", hashes: [{ provider: "anthropic", hash: PIN }] },
		...over,
	});

const forecast = (source: SessionFacts, target: SessionFacts, sameMachine = false) =>
	forecastCache(source, target, { now: NOW, sameMachine });

const item = (f: CacheForecast, id: ForecastItemId): ForecastItem => {
	const found = f.items.find(i => i.id === id);
	if (!found) throw new Error(`no item ${id}`);
	return found;
};

describe("forecast shape", () => {
	test("all ten items are always present, in order, with the documented labels", () => {
		const f = forecast(facts(), twin());
		expect(f.items.map(i => [i.id, i.label])).toEqual([
			["tools", "Tools (incl. examples)"],
			["systemHead", "System prompt, static head"],
			["systemTail", "System prompt, volatile tail"],
			["history", "History prefix"],
			["model", "Model"],
			["thinking", "Thinking level"],
			["tier", "Fast / slow tier"],
			["account", "Account"],
			["ttl", "Cache lifetime"],
			["cacheKey", "Prompt cache key"],
		]);
		expect(f.computedAt).toBe(NOW);
	});

	test("a clean switch is a full hit with nothing to rewrite; only the lifetime is an inference", () => {
		const f = forecast(facts(), twin());
		expect(f.summary).toBe("hit");
		expect(f.rewriteTokens).toBe(0);
		expect(f.headline).toBe("Full cache hit (inference)");
		expect(f.items.map(i => [i.id, i.status, i.inference])).toEqual([
			["tools", "hit", false],
			["systemHead", "hit", false],
			["systemTail", "hit", false],
			["history", "hit", false],
			["model", "hit", false],
			["thinking", "hit", false],
			["tier", "na", false],
			["account", "hit", false],
			["ttl", "hit", true],
			["cacheKey", "na", false],
		]);
	});
});

describe("tools", () => {
	test("different hashes miss and lose everything: summary miss, whole context rewritten", () => {
		const f = forecast(facts(), twin({ tools: { hash: "tools-b", count: 11 } }));
		expect(item(f, "tools")).toMatchObject({ status: "miss", inference: false });
		expect(item(f, "tools").detail).toContain("10 → 11 tools");
		expect(f.summary).toBe("miss");
		expect(f.rewriteTokens).toBe(20_000);
		expect(f.headline).toBe("Cache miss: tools differ (~20,000 tokens rewritten)");
	});

	test("a missing list on either side is unknown, and does not downgrade the summary", () => {
		for (const [source, target] of [
			[facts({ tools: null }), twin()],
			[facts(), twin({ tools: null })],
		] as const) {
			const f = forecast(source, target);
			expect(item(f, "tools").status).toBe("unknown");
			expect(f.summary).toBe("hit");
			expect(f.headline).toContain("could not check: Tools (incl. examples)");
		}
	});

	test("a differing omp version is named as a likely cause", () => {
		const f = forecast(facts(), twin({ omp: "18.20.0", tools: { hash: "tools-b", count: 10 } }));
		expect(item(f, "tools").detail).toContain("18.19.0 → 18.20.0");
	});
});

describe("system prompt", () => {
	test("a different head misses everything", () => {
		const f = forecast(facts(), twin({ systemHead: { hash: "head-b", chars: 4100 } }));
		expect(item(f, "systemHead")).toMatchObject({ status: "miss", inference: false });
		expect(f.summary).toBe("miss");
		expect(f.headline.startsWith("Cache miss: system head differs")).toBe(true);
	});

	test("an unreported head is unknown", () => {
		const f = forecast(facts({ systemHead: null }), twin());
		expect(item(f, "systemHead").status).toBe("unknown");
		expect(item(f, "systemTail").status).toBe("hit");
	});

	test("a different tail is a partial hit: the history is lost, tools and head survive (inference)", () => {
		const f = forecast(facts(), twin({ systemTail: { hash: "tail-b", chars: 1300 } }));
		expect(item(f, "systemTail")).toMatchObject({ status: "miss", inference: true });
		expect(item(f, "systemTail").detail).toContain("breakpoint");
		expect(f.summary).toBe("partial");
		// 20000 - ceil((4000 + 10 * TOOL_CHARS_ESTIMATE) / 4)
		expect(TOOL_CHARS_ESTIMATE).toBe(600);
		expect(f.rewriteTokens).toBe(20_000 - 2500);
		expect(f.headline).toBe(
			"Partial hit: tools and system head hit, system tail misses (~17,500 tokens rewritten) (inference)",
		);
	});

	test("across machines the tail difference lists the candidates without picking one; on one machine it points at the workspace", () => {
		const target = twin({ systemTail: { hash: "tail-b", chars: 1300 }, platform: "linux-x64" });
		const cross = item(forecast(facts(), target, false), "systemTail").detail;
		for (const word of ["OS / architecture", "workspace roots", "context files", "skills", "memories"]) {
			expect(cross).toContain(word);
		}
		expect(cross).toContain("darwin-arm64 → linux-x64");
		const same = item(
			forecast(facts(), twin({ systemTail: { hash: "tail-b", chars: 1300 } }), true),
			"systemTail",
		).detail;
		expect(same).toContain("same machine");
		expect(same).toContain("workspace roots / working directory");
		expect(same).not.toContain("OS / architecture line");
	});

	test("an unreported tail is unknown", () => {
		expect(item(forecast(facts(), twin({ systemTail: null })), "systemTail").status).toBe("unknown");
	});
});

describe("history", () => {
	test("a target whose fingerprint over the source's entries differs is a partial miss", () => {
		const f = forecast(
			facts(),
			twin({ history: { entries: 38, hash: "hist-b", compactions: 0, lastCompactionIndex: null } }),
		);
		expect(item(f, "history")).toMatchObject({ status: "miss", inference: false });
		expect(item(f, "history").detail).toContain("40 → 38 entries");
		expect(f.summary).toBe("partial");
		expect(f.headline).toBe(
			"Partial hit: tools and system head hit, history misses (~17,500 tokens rewritten) (inference)",
		);
	});

	test("compactions and the cross-machine notice are explained", () => {
		const source = facts({ history: { entries: 40, hash: "hist-a", compactions: 2, lastCompactionIndex: 30 } });
		const cross = item(forecast(source, twin({ history: source.history })), "history").detail;
		expect(cross).toContain("2 compactions");
		expect(cross).toContain("session-transfer");
		const same = item(forecast(source, twin({ history: source.history }), true), "history").detail;
		expect(same).toContain("2 compactions");
		expect(same).not.toContain("session-transfer");
		expect(item(forecast(facts(), twin()), "history").detail).not.toContain("compaction");
	});
});

describe("model", () => {
	test("a different model is a full miss and the headline names both", () => {
		const f = forecast(
			facts(),
			twin({ model: { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" } }),
		);
		expect(item(f, "model")).toMatchObject({ status: "miss", inference: false });
		expect(f.summary).toBe("miss");
		expect(f.headline).toBe(
			"Cache miss: model differs (anthropic/claude-opus-4-5 → anthropic/claude-haiku-4-5) (~20,000 tokens rewritten)",
		);
	});

	test("a different provider misses; api only counts when both sides know it", () => {
		expect(
			item(forecast(facts(), twin({ model: { provider: "openai", id: "claude-opus-4-5" } })), "model").status,
		).toBe("miss");
		expect(
			item(forecast(facts(), twin({ model: { provider: "anthropic", id: "claude-opus-4-5" } })), "model").status,
		).toBe("hit");
		expect(
			item(
				forecast(facts(), twin({ model: { provider: "anthropic", id: "claude-opus-4-5", api: "other" } })),
				"model",
			).status,
		).toBe("miss");
	});

	test("an unreported model is unknown", () => {
		expect(item(forecast(facts({ model: null }), twin()), "model").status).toBe("unknown");
		expect(item(forecast(facts(), twin({ model: null })), "model").status).toBe("unknown");
	});
});

describe("thinking and tier", () => {
	test("a different thinking level is a partial miss (inference)", () => {
		const f = forecast(facts(), twin({ thinkingLevel: "low" }));
		expect(item(f, "thinking")).toMatchObject({ status: "miss", inference: true });
		expect(item(f, "thinking").detail).toContain("high → low");
		expect(f.summary).toBe("partial");
		expect(f.headline).toContain("thinking level misses");
	});

	test("both unreported counts as equal; one side unreported is unknown", () => {
		expect(item(forecast(facts({ thinkingLevel: null }), twin({ thinkingLevel: null })), "thinking").status).toBe(
			"hit",
		);
		const f = forecast(facts({ thinkingLevel: null }), twin());
		expect(item(f, "thinking").status).toBe("unknown");
		expect(f.summary).toBe("hit");
	});

	test("tier: na when neither side uses fast or slow; equal is a hit; any difference is a partial miss", () => {
		expect(item(forecast(facts(), twin()), "tier").status).toBe("na");
		expect(item(forecast(facts({ fastModeActive: true }), twin({ fastModeActive: true })), "tier").status).toBe(
			"hit",
		);
		expect(item(forecast(facts({ slowModeEnabled: true }), twin({ slowModeEnabled: true })), "tier").status).toBe(
			"hit",
		);
		for (const [source, target] of [
			[facts({ fastModeActive: true }), twin()],
			[facts(), twin({ slowModeEnabled: true })],
			[facts({ fastModeActive: true }), twin({ slowModeEnabled: true })],
		] as const) {
			const f = forecast(source, target);
			expect(item(f, "tier")).toMatchObject({ status: "miss", inference: true });
			expect(f.summary).toBe("partial");
			expect(f.headline).toContain("service tier misses");
		}
	});

	test("tail + thinking together: both listed, still partial", () => {
		const f = forecast(facts(), twin({ systemTail: { hash: "tail-b", chars: 1 }, thinkingLevel: "low" }));
		expect(f.summary).toBe("partial");
		expect(f.headline).toContain("system tail and thinking level miss");
	});
});

describe("account", () => {
	test("the pin is among the target's accounts: hit", () => {
		const f = forecast(facts(), twin());
		expect(item(f, "account")).toMatchObject({ status: "hit", inference: false });
		expect(item(f, "account").detail).toContain("same");
	});

	test("matches by provider and hash: the same hash under another provider is no match", () => {
		const f = forecast(facts(), twin({ accounts: { via: "broker", hashes: [{ provider: "openai", hash: PIN }] } }));
		expect(item(f, "account").status).toBe("miss");
		const viaBroker = forecast(
			facts(),
			twin({ accounts: { via: "broker", hashes: [{ provider: "anthropic", hash: PIN }] } }),
		);
		expect(item(viaBroker, "account").status).toBe("hit");
	});

	test("target accounts known but without the pinned one: miss, whole cache", () => {
		for (const hashes of [[], [{ provider: "anthropic", hash: "someone-else" }]]) {
			const f = forecast(facts(), twin({ accounts: { via: "local-db", hashes } }));
			expect(item(f, "account")).toMatchObject({ status: "miss", inference: true });
			expect(item(f, "account").detail).toContain("account-scoped");
			expect(f.summary).toBe("miss");
			expect(f.headline).toContain("no matching account on the target");
			expect(f.headline.endsWith("(inference)")).toBe(true);
		}
	});

	test("target accounts unavailable: unknown, with the reason; the summary is not downgraded", () => {
		const f = forecast(facts(), twin({ accounts: { via: "unavailable", hashes: [], reason: "database is locked" } }));
		expect(item(f, "account").status).toBe("unknown");
		expect(item(f, "account").detail).toContain("database is locked");
		expect(f.summary).toBe("hit");
		expect(f.headline).toContain("could not check: Account");
	});

	test("no pin on the source (API key): unknown, says the key must be the same", () => {
		const f = forecast(facts({ pins: [] }), twin({ accounts: { via: "local-db", hashes: [] } }));
		expect(item(f, "account").status).toBe("unknown");
		expect(item(f, "account").detail).toContain("API-key credentials carry no pin");
		expect(item(f, "account").detail).toContain("same key");
		expect(f.summary).toBe("hit");
	});

	test("a pin for another provider does not count; no model means unknown", () => {
		const f = forecast(facts({ pins: [{ provider: "openai", hash: PIN }] }), twin());
		expect(item(f, "account").status).toBe("unknown");
		expect(item(forecast(facts({ model: null }), twin()), "account").status).toBe("unknown");
	});

	test("model + account together: model leads the headline order, both are named", () => {
		const f = forecast(
			facts(),
			twin({
				model: { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" },
				accounts: { via: "local-db", hashes: [] },
			}),
		);
		expect(f.summary).toBe("miss");
		expect(f.headline).toContain("model differs (anthropic/claude-opus-4-5 → anthropic/claude-haiku-4-5)");
		expect(f.headline).toContain("no matching account on the target");
	});
});

describe("ttl", () => {
	const at = (elapsed: number, source: Partial<SessionFacts> = {}) =>
		forecast(facts({ lastRequestAt: NOW - elapsed, ...source }), twin());

	test("OAuth Anthropic: one hour; just inside hits, exactly at the lifetime misses", () => {
		expect(item(at(LONG_CACHE_LIFETIME_MS - 1), "ttl").status).toBe("hit");
		const edge = at(LONG_CACHE_LIFETIME_MS);
		expect(item(edge, "ttl")).toMatchObject({ status: "miss", inference: true });
		expect(item(edge, "ttl").detail).toContain("1 hour");
		expect(edge.summary).toBe("miss");
		expect(edge.headline).toContain("cache probably expired");
		expect(item(at(10 * MIN), "ttl").status).toBe("hit");
	});

	test("API key or any other provider: five minutes", () => {
		const noPin = { pins: [] };
		expect(item(at(SHORT_CACHE_LIFETIME_MS - 1, noPin), "ttl").status).toBe("hit");
		expect(item(at(SHORT_CACHE_LIFETIME_MS, noPin), "ttl").status).toBe("miss");
		expect(item(at(SHORT_CACHE_LIFETIME_MS, noPin), "ttl").detail).toContain("API key");
		const openai = { model: { provider: "openai", id: "gpt-5" }, pins: [{ provider: "openai", hash: PIN }] };
		expect(item(at(6 * MIN, openai), "ttl").status).toBe("miss");
	});

	test("the cache warmer caveat is always stated, and the item is always an inference", () => {
		for (const f of [at(MIN), at(2 * LONG_CACHE_LIFETIME_MS), at(0, { lastRequestAt: null })]) {
			expect(item(f, "ttl").inference).toBe(true);
		}
		expect(item(at(MIN), "ttl").detail).toContain("cache warmer");
		expect(item(at(2 * LONG_CACHE_LIFETIME_MS), "ttl").detail).toContain("cache warmer");
	});

	test("a clock a little behind the source counts as zero elapsed", () => {
		const f = forecast(facts({ lastRequestAt: NOW + 5000 }), twin());
		expect(item(f, "ttl").status).toBe("hit");
	});

	test("nothing cached yet: summary hit, headline says nothing to lose, no rewrite, even when other items differ", () => {
		const f = forecast(facts({ lastRequestAt: null }), twin({ tools: { hash: "x", count: 1 } }));
		expect(item(f, "ttl")).toMatchObject({ status: "na" });
		expect(item(f, "ttl").detail).toContain("nothing is cached");
		expect(item(f, "tools").status).toBe("miss");
		expect(f.summary).toBe("hit");
		expect(f.headline).toBe("Nothing is cached yet; nothing to lose");
		expect(f.rewriteTokens).toBe(0);
	});
});

describe("cacheKey", () => {
	const openai = { model: { provider: "openai", id: "gpt-5", api: "openai-responses" }, pins: [] };

	test("na for Anthropic, by provider or by api", () => {
		expect(item(forecast(facts(), twin()), "cacheKey").status).toBe("na");
		expect(
			item(
				forecast(
					facts({ model: { provider: "anthropic", id: "x" } }),
					twin({ model: { provider: "anthropic", id: "x" } }),
				),
				"cacheKey",
			).status,
		).toBe("na");
		const google = { model: { provider: "google", id: "gemini", api: "google-generative-ai" } };
		expect(item(forecast(facts(google), twin(google)), "cacheKey").status).toBe("na");
		expect(item(forecast(facts({ model: null }), twin()), "cacheKey").status).toBe("na");
	});

	test("equal explicit keys hit", () => {
		const f = forecast(facts({ ...openai, promptCacheKey: "key-1" }), twin({ ...openai, promptCacheKey: "key-1" }));
		expect(item(f, "cacheKey")).toMatchObject({ status: "hit", inference: false });
	});

	test("a source without a header key sends its session id, which the fork inherits: hit", () => {
		const f = forecast(
			facts({ ...openai, promptCacheKey: null }),
			twin({ ...openai, promptCacheKey: "sess-source" }),
		);
		expect(item(f, "cacheKey").status).toBe("hit");
	});

	test("a target without a key misses, and so does a different key; both are partial", () => {
		for (const target of [null, "other-key"]) {
			const f = forecast(facts({ ...openai, promptCacheKey: "key-1" }), twin({ ...openai, promptCacheKey: target }));
			expect(item(f, "cacheKey")).toMatchObject({ status: "miss", inference: true });
		}
	});

	test("the key alone does not change the summary: it is listed, not decisive", () => {
		const f = forecast(facts({ ...openai, promptCacheKey: "key-1" }), twin({ ...openai, promptCacheKey: null }));
		expect(f.summary).toBe("hit");
	});
});

describe("summary and rewrite estimate", () => {
	test("an unknown context makes the rewrite null for partial and miss, and 0 for a hit", () => {
		const noContext = { context: null };
		expect(
			forecast(facts(noContext), twin({ ...noContext, systemTail: { hash: "b", chars: 1 } })).rewriteTokens,
		).toBeNull();
		expect(
			forecast(facts(noContext), twin({ ...noContext, tools: { hash: "b", count: 1 } })).rewriteTokens,
		).toBeNull();
		expect(forecast(facts(noContext), twin(noContext)).rewriteTokens).toBe(0);
		const noTokens = { context: { tokens: null, window: 200_000 } };
		expect(forecast(facts(noTokens), twin({ ...noTokens, tools: { hash: "b", count: 1 } })).rewriteTokens).toBeNull();
		// the target's size is used when the source's is unknown
		const f = forecast(facts({ context: null }), twin({ tools: { hash: "b", count: 1 } }));
		expect(f.rewriteTokens).toBe(20_000);
	});

	test("the partial estimate never goes below zero", () => {
		const f = forecast(
			facts({ context: { tokens: 100, window: 200_000 } }),
			twin({ systemTail: { hash: "b", chars: 1 }, context: { tokens: 100, window: 200_000 } }),
		);
		expect(f.rewriteTokens).toBe(0);
	});

	test("tokens are shown rounded to a hundred in the headline, the field stays exact", () => {
		const f = forecast(
			facts({ context: { tokens: 12_345, window: 200_000 } }),
			twin({ tools: { hash: "b", count: 1 } }),
		);
		expect(f.rewriteTokens).toBe(12_345);
		expect(f.headline).toContain("~12,300 tokens");
	});

	test("some unknown items never downgrade a hit; they are named in the headline", () => {
		const blank = { tools: null, systemHead: null };
		const f = forecast(facts(blank), twin(blank));
		expect(f.summary).toBe("hit");
		expect(f.headline).toContain("Full cache hit");
		expect(f.headline).toContain("could not check: Tools (incl. examples) and System prompt, static head");
	});

	test("none of tools, head, tail, model readable: the headline says the state could not be determined, summary stays hit", () => {
		const blank = { tools: null, systemHead: null, systemTail: null, model: null };
		const f = forecast(facts(blank), twin(blank));
		expect(f.summary).toBe("hit");
		expect(f.headline.startsWith("Cache state could not be determined")).toBe(true);
	});

	test("a miss from an observed item carries no inference suffix; a miss from the lifetime does", () => {
		expect(forecast(facts(), twin({ tools: { hash: "b", count: 10 } })).headline.endsWith("(inference)")).toBe(false);
		expect(
			forecast(facts({ lastRequestAt: NOW - 2 * LONG_CACHE_LIFETIME_MS }), twin()).headline.endsWith("(inference)"),
		).toBe(true);
	});

	test("a miss item outranks partial ones: tools + tail + thinking is a miss", () => {
		const f = forecast(
			facts(),
			twin({ tools: { hash: "b", count: 10 }, systemTail: { hash: "b", chars: 1 }, thinkingLevel: "low" }),
		);
		expect(f.summary).toBe("miss");
		expect(f.rewriteTokens).toBe(20_000);
	});

	test("the facts are not mutated", () => {
		const source = facts();
		const target = twin();
		const before = JSON.stringify([source, target]);
		forecast(source, target);
		expect(JSON.stringify([source, target])).toBe(before);
	});
});

describe("unsettled prompt", () => {
	const NOTE = "was still changing when it was read";

	test("a tools / head / tail miss on an unsettled target is an inference with a note, and the miss headline says so", () => {
		for (const [over, id] of [
			[{ tools: { hash: "b", count: 10 } }, "tools"],
			[{ systemHead: { hash: "b", chars: 1 } }, "systemHead"],
			[{ systemTail: { hash: "b", chars: 1 } }, "systemTail"],
		] as const) {
			const f = forecast(facts(), twin({ ...over, settled: false }));
			expect(item(f, id)).toMatchObject({ status: "miss", inference: true });
			expect(item(f, id).detail).toContain(`The prompt of the target ${NOTE}`);
			expect(item(f, id).detail).toContain("may not be a real difference");
			expect(f.headline.endsWith("(inference)")).toBe(true);
		}
	});

	test("the same miss on settled facts stays an observation (tools: no inference, no note)", () => {
		for (const settled of [true, undefined]) {
			const f = forecast(facts(), twin({ tools: { hash: "b", count: 10 }, settled }));
			expect(item(f, "tools")).toMatchObject({ status: "miss", inference: false });
			expect(item(f, "tools").detail).not.toContain(NOTE);
			expect(f.headline.endsWith("(inference)")).toBe(false);
		}
	});

	test("an unsettled source is named as the source, both as source and target", () => {
		const source = forecast(facts({ settled: false }), twin({ tools: { hash: "b", count: 10 } }));
		expect(item(source, "tools").detail).toContain(`The prompt of the source ${NOTE}`);
		const both = forecast(facts({ settled: false }), twin({ tools: { hash: "b", count: 10 }, settled: false }));
		expect(item(both, "tools").detail).toContain(`The prompt of the source and the target ${NOTE}`);
	});

	test("only tools / head / tail misses are touched; hits and other misses are not", () => {
		const f = forecast(facts(), twin({ settled: false, thinkingLevel: "low", systemTail: { hash: "b", chars: 1 } }));
		expect(item(f, "tools")).toMatchObject({ status: "hit", inference: false });
		expect(item(f, "tools").detail).not.toContain(NOTE);
		expect(item(f, "thinking").detail).not.toContain(NOTE);
		expect(item(f, "systemTail").detail).toContain(NOTE);
		const model = forecast(
			facts(),
			twin({ settled: false, model: { provider: "anthropic", id: "other", api: "anthropic-messages" } }),
		);
		expect(item(model, "model")).toMatchObject({ status: "miss", inference: false });
		expect(item(model, "model").detail).not.toContain(NOTE);
		expect(model.headline.endsWith("(inference)")).toBe(false);
	});

	test("unsettled facts that match change nothing", () => {
		expect(forecast(facts({ settled: false }), twin({ settled: false })).headline).toBe("Full cache hit (inference)");
	});
});
