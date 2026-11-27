/**
 * Active-branch selection over omp's session entry tree.
 *
 * omp's `get_entries` returns every entry in append order, across all branches (tree navigation, rewind, retry and
 * `/fork` leave the abandoned ones in the file). The transcript shows only the path from the root to the current
 * leaf, which is what the TUI shows too.
 */

export interface EntryLink {
	id: string;
	parentId: string | null;
}

/** Ids on the path root -> `leafId` (inclusive). Stops at an unknown parent; a cycle cannot loop. Empty for no leaf. */
export function activeBranchIds(parents: ReadonlyMap<string, string | null>, leafId: string | null): string[] {
	const path: string[] = [];
	const seen = new Set<string>();
	let cursor: string | null = leafId;
	while (cursor !== null && parents.has(cursor) && !seen.has(cursor)) {
		seen.add(cursor);
		path.push(cursor);
		cursor = parents.get(cursor) ?? null;
	}
	return path.reverse();
}

/** The entries on the active branch, root first. */
export function selectActiveBranch<E extends EntryLink>(entries: readonly E[], leafId: string | null): E[] {
	const byId = new Map<string, E>();
	const parents = new Map<string, string | null>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
		parents.set(entry.id, entry.parentId);
	}
	return activeBranchIds(parents, leafId).map(id => byId.get(id)!);
}

export type BranchChange =
	| { kind: "same" }
	/** The new path only grew at the leaf end: `appended` are the new ids, root side first. */
	| { kind: "extend"; appended: string[] }
	/** The leaf moved elsewhere (navigation, rewind, retry): the rendered list must be replaced. */
	| { kind: "switch" };

export function compareBranches(previous: readonly string[], next: readonly string[]): BranchChange {
	if (next.length >= previous.length && previous.every((id, i) => next[i] === id)) {
		return next.length === previous.length
			? { kind: "same" }
			: { kind: "extend", appended: next.slice(previous.length) };
	}
	return { kind: "switch" };
}
