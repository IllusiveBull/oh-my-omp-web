/** Parsers for what the file browser reads from git: `status --porcelain=v2 -z` and unified diffs. Pure. */
import type { GitStatus, GitStatusEntry, LineCounts } from "@omp-web/protocol";

/** First `count` space-separated fields of `line` and the remainder (which may contain spaces: it is a path). */
function splitFields(line: string, count: number): { fields: string[]; rest: string } | null {
	const fields: string[] = [];
	let at = 0;
	for (let i = 0; i < count; i++) {
		const space = line.indexOf(" ", at);
		if (space < 0) return null;
		fields.push(line.slice(at, space));
		at = space + 1;
	}
	return { fields, rest: line.slice(at) };
}

const EMPTY_BRANCH: GitStatus["branch"] = { head: null, oid: null, upstream: null, ahead: null, behind: null };

/**
 * `git status --porcelain=v2 -z --branch` output. With `-z` entries end in NUL, paths are raw (spaces, newlines, non-ASCII
 * all legal), and a rename's old path is the field after its own. `maxEntries` bounds the result (`truncated`).
 */
export function parseStatusV2(text: string, maxEntries = 10_000): GitStatus {
	const branch = { ...EMPTY_BRANCH };
	const entries: GitStatusEntry[] = [];
	let truncated = false;
	const records = text.split("\0");
	const push = (entry: GitStatusEntry): void => {
		if (entries.length >= maxEntries) truncated = true;
		else entries.push(entry);
	};
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (record === "") continue;
		if (record.startsWith("# ")) {
			const [key, ...value] = record.slice(2).split(" ");
			const joined = value.join(" ");
			if (key === "branch.oid") branch.oid = joined === "(initial)" ? null : joined;
			else if (key === "branch.head") branch.head = joined === "(detached)" ? null : joined;
			else if (key === "branch.upstream") branch.upstream = joined;
			else if (key === "branch.ab") {
				const ab = /^\+(\d+) -(\d+)$/.exec(joined);
				if (ab) {
					branch.ahead = Number(ab[1]);
					branch.behind = Number(ab[2]);
				}
			}
			continue;
		}
		const kind = record[0];
		if (kind === "1") {
			const parts = splitFields(record, 8);
			if (parts) push({ path: parts.rest, kind: "changed", x: parts.fields[1]![0]!, y: parts.fields[1]![1]! });
		} else if (kind === "2") {
			const parts = splitFields(record, 9);
			const origPath = records[++i];
			if (parts && origPath !== undefined) {
				push({ path: parts.rest, origPath, kind: "renamed", x: parts.fields[1]![0]!, y: parts.fields[1]![1]! });
			}
		} else if (kind === "u") {
			const parts = splitFields(record, 10);
			if (parts) push({ path: parts.rest, kind: "unmerged", x: parts.fields[1]![0]!, y: parts.fields[1]![1]! });
		} else if (kind === "?") {
			const path = record.slice(2);
			push({ path, kind: "untracked", x: "?", y: "?", ...(path.endsWith("/") ? { dir: true } : {}) });
		}
		// "!" (ignored) is not asked for; anything else is a format this parser does not know and is skipped
	}
	return { branch, entries, truncated };
}

export interface DiffSummary {
	binary: boolean;
	added: number;
	removed: number;
	renamedFrom?: string;
}

/** Unquotes a path as git prints it in `rename from` lines (quoted with C escapes when it holds odd characters). */
function unquote(path: string): string {
	if (!(path.startsWith('"') && path.endsWith('"'))) return path;
	try {
		return JSON.parse(path) as string;
	} catch {
		return path.slice(1, -1);
	}
}

/** Binary marker, changed-line counts (hunk lines only) and rename source of a unified diff. */
export function summarizeDiff(diff: string): DiffSummary {
	let added = 0;
	let removed = 0;
	let inHunk = false;
	let binary = false;
	let renamedFrom: string | undefined;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ") || line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
			inHunk = false;
		} else if (line.startsWith("@@")) {
			inHunk = true;
		} else if (inHunk) {
			if (line.startsWith("+")) added++;
			else if (line.startsWith("-")) removed++;
		} else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			binary = true;
		} else if (line.startsWith("rename from ")) {
			renamedFrom = unquote(line.slice("rename from ".length));
		}
	}
	return { binary, added, removed, ...(renamedFrom === undefined ? {} : { renamedFrom }) };
}

/**
 * `git diff --numstat -z` as counts per path (a rename's new path). Binary files (`-\t-\t…`) count no lines and are
 * left out. With `-z` a record is `added\tremoved\tpath`, or `added\tremoved\t` followed by the old and new paths.
 */
export function parseNumstat(text: string): Map<string, LineCounts> {
	const counts = new Map<string, LineCounts>();
	const records = text.split("\0");
	for (let i = 0; i < records.length; i++) {
		const parsed = /^(-|\d+)\t(-|\d+)\t/.exec(records[i]!);
		if (!parsed) continue;
		let path = records[i]!.slice(parsed[0].length);
		if (path === "") {
			i += 2;
			path = records[i] ?? "";
		}
		if (path === "" || parsed[1] === "-" || parsed[2] === "-") continue;
		counts.set(path, { added: Number(parsed[1]), removed: Number(parsed[2]) });
	}
	return counts;
}

/** The sum of per-path counts. */
export function sumCounts(counts: Iterable<LineCounts>): LineCounts {
	let added = 0;
	let removed = 0;
	for (const count of counts) {
		added += count.added;
		removed += count.removed;
	}
	return { added, removed };
}

/** Drops a trailing partial line: output cut at a byte cap ends mid-line. */
export function cutAtLine(text: string): string {
	const last = text.lastIndexOf("\n");
	return last < 0 ? "" : text.slice(0, last + 1);
}
