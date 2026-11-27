import { describe, expect, test } from "bun:test";
import { activeBranchIds, compareBranches, selectActiveBranch } from "../src";

const e = (id: string, parentId: string | null) => ({ id, parentId });

describe("active branch selection", () => {
	// a - b - c - d        (abandoned after a retry)
	//      \- c2 - d2      (current)
	const entries = [e("a", null), e("b", "a"), e("c", "b"), e("d", "c"), e("c2", "b"), e("d2", "c2")];

	test("only the path from the root to the leaf is selected, in root-first order", () => {
		expect(selectActiveBranch(entries, "d2").map(x => x.id)).toEqual(["a", "b", "c2", "d2"]);
		expect(selectActiveBranch(entries, "d").map(x => x.id)).toEqual(["a", "b", "c", "d"]);
		expect(selectActiveBranch(entries, "b").map(x => x.id)).toEqual(["a", "b"]);
	});

	test("no leaf, an unknown leaf, a missing parent and a cycle all terminate", () => {
		expect(selectActiveBranch(entries, null)).toEqual([]);
		expect(selectActiveBranch(entries, "zzz")).toEqual([]);
		expect(selectActiveBranch([e("x", "gone"), e("y", "x")], "y").map(v => v.id)).toEqual(["x", "y"]);
		expect(selectActiveBranch([e("p", "q"), e("q", "p")], "p").length).toBeLessThanOrEqual(2);
	});

	test("activeBranchIds works over a bare parent map", () => {
		const parents = new Map<string, string | null>(entries.map(x => [x.id, x.parentId]));
		expect(activeBranchIds(parents, "d")).toEqual(["a", "b", "c", "d"]);
	});
});

describe("compareBranches", () => {
	test("distinguishes unchanged, appended at the leaf end, and a leaf that moved elsewhere", () => {
		expect(compareBranches(["a", "b"], ["a", "b"])).toEqual({ kind: "same" });
		expect(compareBranches(["a", "b"], ["a", "b", "c", "d"])).toEqual({ kind: "extend", appended: ["c", "d"] });
		expect(compareBranches([], ["a"])).toEqual({ kind: "extend", appended: ["a"] });
		// retry / rewind: the old leaf is replaced by a sibling
		expect(compareBranches(["a", "b", "c"], ["a", "b", "c2"])).toEqual({ kind: "switch" });
		// navigation back to an ancestor shortens the path
		expect(compareBranches(["a", "b", "c"], ["a", "b"])).toEqual({ kind: "switch" });
	});
});
