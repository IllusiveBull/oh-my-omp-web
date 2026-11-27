import { describe, expect, test } from "bun:test";
import { type TreeItem, treeKey } from "../src/lib/tree-keys";

const item = (path: string, depth: number, dir = false, expanded = false): TreeItem => ({ path, depth, dir, expanded });
// src/            (expanded)
//   a.ts
//   lib/          (collapsed)
// docs/           (collapsed)
// README.md
const items = [
	item("src", 0, true, true),
	item("src/a.ts", 1),
	item("src/lib", 1, true),
	item("docs", 0, true),
	item("README.md", 0),
];

describe("tree keyboard navigation", () => {
	test("Up / Down move one row and stop at the ends; Home / End jump", () => {
		expect(treeKey("ArrowDown", items, "src")).toEqual({ kind: "focus", path: "src/a.ts" });
		expect(treeKey("ArrowUp", items, "src/a.ts")).toEqual({ kind: "focus", path: "src" });
		expect(treeKey("ArrowUp", items, "src")).toBeNull();
		expect(treeKey("ArrowDown", items, "README.md")).toBeNull();
		expect(treeKey("Home", items, "docs")).toEqual({ kind: "focus", path: "src" });
		expect(treeKey("End", items, "src")).toEqual({ kind: "focus", path: "README.md" });
	});

	test("Right expands a collapsed directory, enters an expanded one, and does nothing on a file", () => {
		expect(treeKey("ArrowRight", items, "docs")).toEqual({ kind: "toggle", path: "docs" });
		expect(treeKey("ArrowRight", items, "src")).toEqual({ kind: "focus", path: "src/a.ts" });
		expect(treeKey("ArrowRight", items, "README.md")).toBeNull();
		expect(treeKey("ArrowRight", [item("e", 0, true, true), item("f", 0)], "e")).toBeNull(); // expanded but empty
	});

	test("Left collapses an expanded directory, otherwise moves to the parent (none at the top level)", () => {
		expect(treeKey("ArrowLeft", items, "src")).toEqual({ kind: "toggle", path: "src" });
		expect(treeKey("ArrowLeft", items, "src/a.ts")).toEqual({ kind: "focus", path: "src" });
		expect(treeKey("ArrowLeft", items, "src/lib")).toEqual({ kind: "focus", path: "src" });
		expect(treeKey("ArrowLeft", items, "README.md")).toBeNull();
	});

	test("other keys are left alone; an unknown current row falls back to the first", () => {
		expect(treeKey("a", items, "src")).toBeNull();
		expect(treeKey("Enter", items, "src")).toBeNull(); // the row is a button: Enter activates it natively
		expect(treeKey("ArrowDown", items, "gone")).toEqual({ kind: "focus", path: "src" });
		expect(treeKey("ArrowDown", [], "x")).toBeNull();
	});
});
