import { describe, expect, test } from "bun:test";
import { FILE_CHUNK_BYTES, type FileContent, type GitStatus, type GitStatusEntry } from "@omp-web/protocol";
import {
	ancestorsOf,
	decodeBytes,
	decodeContent,
	decodeDiff,
	decodeListing,
	decodeStatus,
	decorationOf,
	defaultDiffMode,
	describeBranch,
	diffBody,
	diffModesFor,
	entryFor,
	formatSize,
	groupChanges,
	highlightLines,
	indexStatus,
	inertReason,
	loadShowIgnored,
	openKind,
	pageInfo,
	planChunks,
	saveShowIgnored,
	signatureOf,
	validSpans,
} from "../src/lib/files";

const kinds = (lines: ReturnType<typeof highlightLines>): (readonly (string | null)[])[] =>
	lines.map(line => line.map(segment => `${segment.kind ?? "-"}:${segment.text}`));

describe("highlightLines", () => {
	test("plain text becomes one plain segment per line; a final newline starts no new line", () => {
		expect(kinds(highlightLines("a\nb\n", null, false))).toEqual([["-:a"], ["-:b"]]);
		expect(kinds(highlightLines("a\nb", null, false))).toEqual([["-:a"], ["-:b"]]);
		expect(highlightLines("", null, false)).toEqual([]);
		expect(highlightLines("\n\n", null, false)).toEqual([[], []]);
	});

	test("spans colour segments; kind k is HIGHLIGHT_KINDS[k - 1]", () => {
		const text = "let x = 1;\n// c";
		// keyword(2) "let", plain " x = 1;\n", comment(1) "// c"
		expect(kinds(highlightLines(text, [2, 3, 0, 8, 1, 4], false))).toEqual([
			["keyword:let", "-: x = 1;"],
			["comment:// c"],
		]);
	});

	test("a span that crosses line breaks is split at them", () => {
		const text = "/* a\nb */\nx";
		expect(kinds(highlightLines(text, [1, 9, 0, 2], false))).toEqual([["comment:/* a"], ["comment:b */"], ["-:x"]]);
	});

	test("neighbouring spans of one kind merge", () => {
		expect(kinds(highlightLines("abcd", [5, 2, 5, 2], false))).toEqual([["string:abcd"]]);
	});

	test("spans that do not cover the text exactly are ignored", () => {
		expect(kinds(highlightLines("abcd", [2, 3], false))).toEqual([["-:abcd"]]);
		expect(kinds(highlightLines("abcd", [2, 5], false))).toEqual([["-:abcd"]]);
		expect(kinds(highlightLines("abcd", [2], false))).toEqual([["-:abcd"]]);
		expect(kinds(highlightLines("abcd", [99, 4], false))).toEqual([["-:abcd"]]);
		expect(kinds(highlightLines("abcd", [1, -1, 0, 5], false))).toEqual([["-:abcd"]]);
	});

	test("CRLF: the carriage return is dropped from each line when the file is CRLF", () => {
		expect(kinds(highlightLines("a\r\nb\r\n", null, true))).toEqual([["-:a"], ["-:b"]]);
		expect(kinds(highlightLines("a\r\nb\r\n", null, false))).toEqual([["-:a\r"], ["-:b\r"]]);
		expect(kinds(highlightLines("x\r\n", [2, 1, 0, 2], true))).toEqual([["keyword:x"]]);
	});

	test("validSpans", () => {
		expect(validSpans([0, 2, 1, 3], 5)).toBe(true);
		expect(validSpans([], 0)).toBe(true);
		expect(validSpans(null, 0)).toBe(false);
		expect(validSpans([0, 2, 1], 2)).toBe(false);
		expect(validSpans([12, 2], 2)).toBe(false);
		expect(validSpans([0, 1.5, 0, 0.5], 2)).toBe(false);
	});
});

const entry = (e: Partial<GitStatusEntry> & Pick<GitStatusEntry, "path" | "kind" | "x" | "y">): GitStatusEntry => e;

const status: GitStatus = {
	branch: { head: "main", oid: "abc", upstream: null, ahead: null, behind: null },
	truncated: false,
	entries: [
		entry({ path: "src/a.ts", kind: "changed", x: ".", y: "M" }),
		entry({ path: "src/b.ts", kind: "changed", x: "M", y: "." }),
		entry({ path: "c.ts", kind: "changed", x: "A", y: "M" }),
		entry({ path: "old.ts", origPath: "was.ts", kind: "renamed", x: "R", y: "." }),
		entry({ path: "newdir/", dir: true, kind: "untracked", x: "?", y: "?" }),
		entry({ path: "u.txt", kind: "untracked", x: "?", y: "?" }),
		entry({ path: "conf.ts", kind: "unmerged", x: "U", y: "U" }),
		entry({ path: "gone.ts", kind: "changed", x: ".", y: "D" }),
	],
};

describe("git status decorations", () => {
	const index = indexStatus(status);

	test("a file carries its change and the raw XY code", () => {
		expect(decorationOf(index, "src/a.ts", false)).toEqual({ status: "modified", xy: ".M", letter: "M" });
		expect(decorationOf(index, "src/b.ts", false)).toMatchObject({ status: "staged-modified", xy: "M." });
		expect(decorationOf(index, "c.ts", false)).toMatchObject({ status: "added", xy: "AM" });
		expect(decorationOf(index, "old.ts", false)).toMatchObject({ status: "renamed", xy: "R." });
		expect(decorationOf(index, "gone.ts", false)).toMatchObject({ status: "deleted", xy: ".D" });
		expect(decorationOf(index, "conf.ts", false)).toMatchObject({ status: "conflicted", xy: "UU" });
		expect(decorationOf(index, "u.txt", false)).toMatchObject({ status: "untracked", xy: "??" });
		expect(decorationOf(index, "clean.ts", false)).toBeNull();
	});

	test("directories count the changes below them", () => {
		expect(decorationOf(index, "src", true)).toEqual({ status: "changed", count: 2 });
		expect(decorationOf(index, "other", true)).toBeNull();
		expect(index.dirCounts.get("")).toBe(8);
	});

	test("an untracked directory decorates itself and everything below it", () => {
		expect(decorationOf(index, "newdir", true)).toMatchObject({ status: "untracked", xy: "??" });
		expect(decorationOf(index, "newdir/deep/x.ts", false)).toMatchObject({ status: "untracked", xy: "??" });
		expect(decorationOf(index, "newdir/deep", true)).toMatchObject({ status: "untracked" });
		expect(decorationOf(index, "newdir-other", true)).toBeNull();
		expect(entryFor(index, "newdir/deep/x.ts")?.kind).toBe("untracked");
	});

	test("no status: nothing is decorated", () => {
		expect(decorationOf(indexStatus(null), "src", true)).toBeNull();
	});

	test("changes are grouped; a file changed in the index and the worktree is in both groups", () => {
		const groups = groupChanges(status);
		expect(groups.conflicted.map(c => c.path)).toEqual(["conf.ts"]);
		expect(groups.staged.map(c => [c.path, c.mode])).toEqual([
			["src/b.ts", "staged"],
			["c.ts", "staged"],
			["old.ts", "staged"],
		]);
		expect(groups.unstaged.map(c => [c.path, c.mode])).toEqual([
			["src/a.ts", "unstaged"],
			["c.ts", "unstaged"],
			["gone.ts", "unstaged"],
		]);
		expect(groups.untracked.map(c => [c.path, c.mode])).toEqual([
			["newdir", null], // a directory opens in the tree
			["u.txt", "untracked"],
		]);
		expect(groups.staged.find(c => c.path === "old.ts")?.origPath).toBe("was.ts");
		expect(groupChanges(null).staged).toEqual([]);
	});

	test("which diff modes a file offers, and which one opens first", () => {
		const e = (x: string, y: string, kind: GitStatusEntry["kind"] = "changed") => entry({ path: "f", kind, x, y });
		expect(diffModesFor(e(".", "M"))).toEqual(["unstaged", "head"]);
		expect(diffModesFor(e("M", "."))).toEqual(["staged", "head"]);
		expect(diffModesFor(e("M", "M"))).toEqual(["unstaged", "staged", "head"]);
		expect(diffModesFor(e("?", "?", "untracked"))).toEqual(["untracked"]);
		expect(diffModesFor(e("U", "U", "unmerged"))).toEqual(["unstaged", "head"]);
		expect(diffModesFor(undefined)).toEqual([]);
		expect(defaultDiffMode(e(".", "M"))).toBe("unstaged");
		expect(defaultDiffMode(e("M", "."))).toBe("staged");
		expect(defaultDiffMode(e("M", "M"))).toBe("unstaged");
		expect(defaultDiffMode(e("?", "?", "untracked"))).toBe("untracked");
		expect(defaultDiffMode(e("U", "U", "unmerged"))).toBe("unstaged");
	});

	test("the signature changes with the file's git state", () => {
		const before = signatureOf(index, "src/a.ts");
		const after = signatureOf(
			indexStatus({ ...status, entries: [entry({ path: "src/a.ts", kind: "changed", x: "M", y: "M" })] }),
			"src/a.ts",
		);
		expect(before).not.toBe(after);
		expect(signatureOf(index, "clean.ts")).toBe("");
		expect(signatureOf(index, "newdir/x")).toBe(signatureOf(index, "newdir/y"));
	});
});

describe("decoding answers", () => {
	test("listings drop entries that could not be paths and default what is missing", () => {
		const listing = decodeListing({
			path: "",
			entries: [
				{ name: "a.ts", kind: "file", size: 3 },
				{ name: "bad/name", kind: "file" },
				{ name: "", kind: "dir" },
				{ name: "d", kind: "dir", ignored: true },
				{ name: "l", kind: "symlink", link: { target: "a.ts", resolves: "file" } },
				{ name: "weird", kind: "pipe" },
				"junk",
			],
		});
		expect(listing?.entries.map(e => e.name)).toEqual(["a.ts", "d", "l"]);
		expect(listing?.entries[1]?.ignored).toBe(true);
		expect(listing?.entries[2]?.link).toEqual({ target: "a.ts", resolves: "file" });
		expect(listing).toMatchObject({ truncated: false, ignoreChecked: true, ignoredHidden: 0 });
		expect(decodeListing(null)).toBeNull();
		expect(decodeListing({ path: "x" })).toBeNull();
	});

	test("content of every kind", () => {
		const meta = { path: "a", size: 1, mtimeMs: 2, ignored: false };
		expect(decodeContent({ kind: "dir", path: "src" })).toEqual({ kind: "dir", path: "src" });
		const text = decodeContent({
			...meta,
			kind: "text",
			text: "x",
			startLine: 1,
			endLine: 1,
			nextLine: null,
			totalLines: 1,
			lossy: false,
			crlf: true,
			bom: false,
			cut: false,
			lang: "ts",
			spans: [0, 1],
		});
		expect(text).toMatchObject({ kind: "text", crlf: true, lang: "ts", spans: [0, 1] });
		expect(decodeContent({ ...meta, kind: "image", mime: "image/png" })).toMatchObject({ kind: "image" });
		expect(decodeContent({ ...meta, kind: "binary", reason: "NUL bytes" })).toMatchObject({ reason: "NUL bytes" });
		expect(decodeContent({ ...meta, kind: "too_large", limit: 9 })).toMatchObject({ limit: 9 });
		expect(decodeContent({ ...meta, kind: "text" })).toBeNull(); // no text
		expect(decodeContent({ ...meta, kind: "mystery" })).toBeNull();
		expect(decodeContent("x")).toBeNull();
	});

	test("bytes, status and diff", () => {
		expect(decodeBytes({ offset: 0, length: 1, size: 1, mtimeMs: 1, eof: true, data: "AA==" })).toMatchObject({
			eof: true,
		});
		expect(decodeBytes({ offset: 0 })).toBeNull();
		expect(
			decodeStatus({
				branch: { head: "main" },
				entries: [{ path: "a", kind: "changed", x: ".", y: "M" }, { path: "b" }],
			}),
		).toEqual({
			branch: { head: "main", oid: null, upstream: null, ahead: null, behind: null },
			entries: [{ path: "a", kind: "changed", x: ".", y: "M" }],
			truncated: false,
		});
		expect(decodeStatus({ entries: [] })).toBeNull();
		const diff = decodeDiff({
			mode: "head",
			path: "a",
			diff: "@@",
			truncated: true,
			binary: false,
			added: 1,
			removed: 2,
		});
		expect(diff).toMatchObject({ mode: "head", truncated: true, added: 1, removed: 2 });
		expect(decodeDiff({ mode: "weird", path: "a", diff: "" })).toBeNull();
	});
});

describe("pages, images and diffs", () => {
	const text = (patch: Partial<Extract<FileContent, { kind: "text" }>>): Extract<FileContent, { kind: "text" }> => ({
		kind: "text",
		path: "a",
		size: 1,
		mtimeMs: 1,
		ignored: false,
		text: "",
		startLine: 1,
		endLine: 1000,
		nextLine: 1001,
		totalLines: 5000,
		lossy: false,
		crlf: false,
		bom: false,
		cut: false,
		lang: null,
		spans: null,
		...patch,
	});

	test("page info", () => {
		expect(pageInfo(text({}))).toBe("lines 1–1000 of 5000");
		expect(pageInfo(text({ totalLines: null }))).toBe("lines 1–1000 of at least 1000");
		expect(pageInfo(text({ totalLines: null, nextLine: null, startLine: 1001, endLine: 1200 }))).toBe(
			"lines 1001–1200 (end of file)",
		);
		expect(pageInfo(text({ startLine: 1, endLine: 0, nextLine: null, totalLines: 0 }))).toBe("empty file");
		expect(pageInfo(text({ startLine: 50, endLine: 49, nextLine: null }))).toBe("past the end of the file");
	});

	test("image chunks cover the file in order, none larger than a frame", () => {
		expect(planChunks(0)).toEqual([]);
		expect(planChunks(1)).toEqual([{ offset: 0, length: 1 }]);
		const chunks = planChunks(FILE_CHUNK_BYTES * 2 + 5);
		expect(chunks).toEqual([
			{ offset: 0, length: FILE_CHUNK_BYTES },
			{ offset: FILE_CHUNK_BYTES, length: FILE_CHUNK_BYTES },
			{ offset: FILE_CHUNK_BYTES * 2, length: 5 },
		]);
		expect(planChunks(FILE_CHUNK_BYTES)).toHaveLength(1);
	});

	test("the diff body starts at the first hunk", () => {
		const diff = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
		expect(diffBody(diff)).toBe("@@ -1 +1 @@\n-a\n+b\n");
		expect(diffBody("@@ -1 +1 @@\n-a")).toBe("@@ -1 +1 @@\n-a");
		expect(diffBody("diff --git a/x b/x\nBinary files differ\n")).toBe("");
		expect(diffBody("")).toBe("");
	});
});

describe("small helpers", () => {
	test("ancestors", () => {
		expect(ancestorsOf("a/b/c.ts")).toEqual(["", "a", "a/b"]);
		expect(ancestorsOf("c.ts")).toEqual([""]);
		expect(ancestorsOf("")).toEqual([]);
	});

	test("sizes", () => {
		expect(formatSize(0)).toBe("0 B");
		expect(formatSize(1023)).toBe("1023 B");
		expect(formatSize(1536)).toBe("1.5 KiB");
		expect(formatSize(8 * 1024 * 1024)).toBe("8.0 MiB");
	});

	test("branch line", () => {
		expect(describeBranch({ head: "main", oid: "a", upstream: "origin/main", ahead: 2, behind: 1 })).toBe(
			"main ↑2 ↓1",
		);
		expect(describeBranch({ head: "main", oid: "a", upstream: null, ahead: 0, behind: null })).toBe("main");
		expect(describeBranch({ head: null, oid: "abcdef1234", upstream: null, ahead: null, behind: null })).toBe(
			"detached abcdef1",
		);
	});

	test("symlinks open only when they stay in the worktree", () => {
		const link = (resolves: "file" | "dir" | "outside" | "broken" | "other") => ({
			name: "l",
			kind: "symlink" as const,
			link: { target: "t", resolves },
		});
		expect(openKind(link("file"))).toBe("file");
		expect(openKind(link("dir"))).toBe("dir");
		expect(openKind(link("outside"))).toBeNull();
		expect(openKind(link("broken"))).toBeNull();
		expect(openKind(link("other"))).toBeNull();
		expect(openKind({ name: "p", kind: "other" })).toBeNull();
		expect(openKind({ name: "d", kind: "dir" })).toBe("dir");
		expect(inertReason(link("outside"))).toContain("outside the worktree");
		expect(inertReason(link("broken"))).toContain("does not exist");
	});

	test("the show-ignored preference survives broken storage", () => {
		const store = new Map<string, string>();
		const storage = {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
		};
		expect(loadShowIgnored(storage)).toBe(false);
		saveShowIgnored(storage, true);
		expect(store.get("omp-web.files.showIgnored")).toBe("true");
		expect(loadShowIgnored(storage)).toBe(true);
		const broken = {
			getItem: (): string | null => {
				throw new Error("denied");
			},
			setItem: (): void => {
				throw new Error("denied");
			},
		};
		expect(loadShowIgnored(broken)).toBe(false);
		expect(() => saveShowIgnored(broken, true)).not.toThrow();
		expect(loadShowIgnored(null)).toBe(false);
	});
});
