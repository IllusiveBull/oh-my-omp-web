import { describe, expect, test } from "bun:test";
import type { ModelOption } from "@omp-web/protocol";
import { ModelSearch, modelRef } from "../src/lib/model-search";

const m = (provider: string, id: string): ModelOption => ({ provider, id, thinking: [] });
const refs = (list: readonly ModelOption[]): string[] => list.map(modelRef);

describe("ModelSearch", () => {
	test("blank query keeps the given order", () => {
		const list = [m("b", "x"), m("a", "y")];
		expect(refs(new ModelSearch(list).rank("  "))).toEqual(["b/x", "a/y"]);
	});

	test("matches fuzzily, not only by substring, and drops non-matches", () => {
		const list = [m("anthropic", "claude-sonnet-4-6"), m("openai", "gpt-5")];
		expect(refs(new ModelSearch(list).rank("claude son"))).toEqual(["anthropic/claude-sonnet-4-6"]);
		expect(refs(new ModelSearch(list).rank("zzz"))).toEqual([]);
	});

	test("exact id, then contiguous, then fuzzy-only; punctuation ignored", () => {
		const list = [m("p", "gpt-4o-mini"), m("p", "g-p-t"), m("p", "gpt-4o"), m("p", "gpt4")];
		expect(refs(new ModelSearch(list).rank("gpt-4o"))).toEqual(["p/gpt-4o", "p/gpt-4o-mini"]);
		expect(refs(new ModelSearch(list).rank("gpt4"))[0]).toBe("p/gpt4");
	});

	test("role models then role providers win ties between equally relevant matches", () => {
		const list = [m("a", "model-1"), m("b", "model-1"), m("c", "model-1"), m("d", "model-1")];
		expect(refs(new ModelSearch(list).rank("model"))).toEqual(["a/model-1", "b/model-1", "c/model-1", "d/model-1"]);
		const ranked = new ModelSearch(list, { roleModels: ["c/model-1"] }).rank("model");
		expect(refs(ranked)).toEqual(["c/model-1", "a/model-1", "b/model-1", "d/model-1"]);
		const byProvider = new ModelSearch([m("a", "x-1"), m("c", "y-1"), m("c", "z-1")], { roleModels: ["c/q", "c/r"] });
		expect(refs(byProvider.rank("-1"))).toEqual(["c/y-1", "c/z-1", "a/x-1"]);
	});

	test("the current model stands in for recent use, after roles", () => {
		const list = [m("a", "model-1"), m("b", "model-1"), m("c", "model-1")];
		const ranked = new ModelSearch(list, { roleModels: ["b/model-1"], currentModel: "c/model-1" }).rank("model");
		expect(refs(ranked)).toEqual(["b/model-1", "c/model-1", "a/model-1"]);
	});

	test("base order: newer version first within a provider", () => {
		const list = [m("a", "claude-3-5"), m("a", "claude-4-6"), m("a", "claude-4-1")];
		expect(refs(new ModelSearch(list).rank("claude"))).toEqual(["a/claude-4-6", "a/claude-4-1", "a/claude-3-5"]);
	});

	test("returns every match: the tail of a large catalog is reachable", () => {
		const list = Array.from({ length: 500 }, (_, i) => m("p", `model-${i}`));
		const ranked = new ModelSearch(list).rank("model");
		expect(ranked).toHaveLength(500);
		expect(refs(new ModelSearch(list).rank("model-499"))[0]).toBe("p/model-499");
	});
});
