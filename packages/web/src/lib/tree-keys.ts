import type { FilesSnapshot } from "./files-store";
import { joinPath, openKind } from "./files";

/** One visible row of the file tree, in display order. */
export interface TreeItem {
	path: string;
	depth: number;
	/** A directory that can be expanded. */
	dir: boolean;
	expanded: boolean;
}

export type TreeAction = { kind: "focus"; path: string } | { kind: "toggle"; path: string } | null;

/** The rows the tree shows now: listed directories, descending into expanded ones. */
export function visibleItems(snapshot: FilesSnapshot): TreeItem[] {
	const out: TreeItem[] = [];
	const walk = (dir: string, depth: number): void => {
		for (const entry of snapshot.dirs.get(dir)?.listing?.entries ?? []) {
			const path = joinPath(dir, entry.name);
			const dirRow = openKind(entry) === "dir";
			const expanded = dirRow && snapshot.expanded.has(path);
			out.push({ path, depth, dir: dirRow, expanded });
			if (expanded) walk(path, depth + 1);
		}
	};
	walk("", 0);
	return out;
}

/**
 * What a key does in the tree (the ARIA tree pattern): Up/Down move, Home/End jump, Right expands a collapsed directory
 * or moves into an expanded one, Left collapses an expanded directory or moves to the parent. Enter / Space activate the
 * focused row's button natively. `null`: the key is not ours or nothing happens.
 */
export function treeKey(key: string, items: readonly TreeItem[], current: string): TreeAction {
	const at = items.findIndex(i => i.path === current);
	if (at === -1) return items[0] ? { kind: "focus", path: items[0].path } : null;
	const item = items[at]!;
	switch (key) {
		case "ArrowDown":
			return items[at + 1] ? { kind: "focus", path: items[at + 1]!.path } : null;
		case "ArrowUp":
			return items[at - 1] ? { kind: "focus", path: items[at - 1]!.path } : null;
		case "Home":
			return { kind: "focus", path: items[0]!.path };
		case "End":
			return { kind: "focus", path: items.at(-1)!.path };
		case "ArrowRight":
			if (!item.dir) return null;
			if (!item.expanded) return { kind: "toggle", path: item.path };
			return items[at + 1] && items[at + 1]!.depth > item.depth
				? { kind: "focus", path: items[at + 1]!.path }
				: null;
		case "ArrowLeft": {
			if (item.dir && item.expanded) return { kind: "toggle", path: item.path };
			for (let i = at - 1; i >= 0; i--)
				if (items[i]!.depth < item.depth) return { kind: "focus", path: items[i]!.path };
			return null;
		}
		default:
			return null;
	}
}
