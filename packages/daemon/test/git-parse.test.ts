import { describe, expect, test } from "bun:test";
import { cutAtLine, parseStatusV2, summarizeDiff } from "../src/git-parse";

const nul = (...records: string[]): string => `${records.join("\0")}\0`;
const OID = "a".repeat(40);
const H = "b".repeat(40);

describe("parseStatusV2 (porcelain v2, -z)", () => {
	test("branch headers: oid, head, upstream, ahead/behind; detached and initial", () => {
		const text = nul(
			`# branch.oid ${OID}`,
			"# branch.head main",
			"# branch.upstream origin/main",
			"# branch.ab +3 -1",
		);
		expect(parseStatusV2(text).branch).toEqual({
			head: "main",
			oid: OID,
			upstream: "origin/main",
			ahead: 3,
			behind: 1,
		});
		expect(parseStatusV2(nul(`# branch.oid ${OID}`, "# branch.head (detached)")).branch).toMatchObject({
			head: null,
			oid: OID,
		});
		expect(parseStatusV2(nul("# branch.oid (initial)", "# branch.head main")).branch).toMatchObject({
			head: "main",
			oid: null,
		});
	});

	test("ordinary, renamed, conflicted and untracked entries", () => {
		const text = nul(
			`1 .M N... 100644 100644 100644 ${H} ${H} src/a.ts`,
			`1 A. N... 000000 100644 100644 ${"0".repeat(40)} ${H} added.txt`,
			`1 D. N... 100644 000000 000000 ${H} ${"0".repeat(40)} gone.txt`,
			`2 R. N... 100644 100644 100644 ${H} ${H} R100 new name.ts`,
			"old name.ts",
			`2 RM N... 100644 100644 100644 ${H} ${H} R87 b.ts`,
			"a.ts",
			`u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.txt`,
			"? untracked.txt",
			"? newdir/",
		);
		const { entries, truncated } = parseStatusV2(text);
		expect(truncated).toBe(false);
		expect(entries).toEqual([
			{ path: "src/a.ts", kind: "changed", x: ".", y: "M" },
			{ path: "added.txt", kind: "changed", x: "A", y: "." },
			{ path: "gone.txt", kind: "changed", x: "D", y: "." },
			{ path: "new name.ts", origPath: "old name.ts", kind: "renamed", x: "R", y: "." },
			{ path: "b.ts", origPath: "a.ts", kind: "renamed", x: "R", y: "M" },
			{ path: "conflict.txt", kind: "unmerged", x: "U", y: "U" },
			{ path: "untracked.txt", kind: "untracked", x: "?", y: "?" },
			{ path: "newdir/", kind: "untracked", x: "?", y: "?", dir: true },
		]);
	});

	test("paths with spaces, unicode, quotes and newlines come through raw (-z: nothing is quoted)", () => {
		const weird = [
			"with space.txt",
			"日本語/ファイル.md",
			'quote".txt',
			"tab\there",
			"line\nbreak.txt",
			"back\\slash",
		];
		const text = nul(...weird.map(p => `1 .M N... 100644 100644 100644 ${H} ${H} ${p}`), "? ünï cödé.txt");
		expect(parseStatusV2(text).entries.map(e => e.path)).toEqual([...weird, "ünï cödé.txt"]);
	});

	test("a rename whose old path contains a newline keeps the two paths apart", () => {
		const text = nul(`2 R. N... 100644 100644 100644 ${H} ${H} R100 to\nnew.txt`, "from\nold.txt", "? after.txt");
		expect(parseStatusV2(text).entries).toEqual([
			{ path: "to\nnew.txt", origPath: "from\nold.txt", kind: "renamed", x: "R", y: "." },
			{ path: "after.txt", kind: "untracked", x: "?", y: "?" },
		]);
	});

	test("the entry cap truncates and says so; unknown record types and garbage are skipped", () => {
		const many = nul(...Array.from({ length: 10 }, (_, i) => `? f${i}`));
		const capped = parseStatusV2(many, 4);
		expect(capped.entries).toHaveLength(4);
		expect(capped.truncated).toBe(true);
		expect(parseStatusV2(nul("! ignored.txt", "x what", "1 too short")).entries).toEqual([]);
		expect(parseStatusV2("").entries).toEqual([]);
	});
});

describe("summarizeDiff", () => {
	test("counts hunk lines only (headers with + and - are not changes) and finds the rename source", () => {
		const diff = [
			"diff --git a/old.ts b/new.ts",
			"similarity index 90%",
			"rename from old.ts",
			"rename to new.ts",
			"--- a/old.ts",
			"+++ b/new.ts",
			"@@ -1,3 +1,3 @@",
			" keep",
			"-gone",
			"+came",
			"+extra",
			"",
		].join("\n");
		expect(summarizeDiff(diff)).toEqual({ binary: false, added: 2, removed: 1, renamedFrom: "old.ts" });
	});

	test("binary markers", () => {
		expect(summarizeDiff("diff --git a/x b/x\nBinary files a/x and b/x differ\n")).toMatchObject({
			binary: true,
			added: 0,
		});
		expect(summarizeDiff("diff --git a/x b/x\nGIT binary patch\nliteral 3\n")).toMatchObject({ binary: true });
	});

	test("a quoted rename source is unquoted", () => {
		expect(summarizeDiff('diff --git "a/a\\"b" b/c\nrename from "a\\"b"\nrename to c\n').renamedFrom).toBe('a"b');
	});

	test("cutAtLine drops the partial last line", () => {
		expect(cutAtLine("one\ntwo\nthr")).toBe("one\ntwo\n");
		expect(cutAtLine("no newline")).toBe("");
		expect(cutAtLine("whole\n")).toBe("whole\n");
	});
});
