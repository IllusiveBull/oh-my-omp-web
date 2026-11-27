import { describe, expect, test } from "bun:test";
import type { FileDiffMode } from "@omp-web/protocol";
import { filesHash, isAccountsHash, isFilesHash, parseFilesHash, parseSessionHash } from "../src/lib/route";

describe("Files route", () => {
	test("a worktree root is one encoded segment, the path one segment per level", () => {
		const hash = filesHash({ machine: "home", root: "/src/my repo", path: "src/lib/a b.ts" });
		expect(hash).toBe("#/m/home/f/%2Fsrc%2Fmy%20repo/src/lib/a%20b.ts");
		expect(parseFilesHash(hash)).toEqual({ machine: "home", root: "/src/my repo", path: "src/lib/a b.ts" });
	});

	test("the root itself has no path segments", () => {
		const hash = filesHash({ machine: "m", root: "/r", path: "" });
		expect(hash).toBe("#/m/m/f/%2Fr");
		expect(parseFilesHash(hash)).toEqual({ machine: "m", root: "/r", path: "" });
	});

	test("line and diff travel in the query", () => {
		const hash = filesHash({ machine: "m", root: "/r", path: "a.ts", line: 42, diff: "staged" });
		expect(hash).toBe("#/m/m/f/%2Fr/a.ts?line=42&diff=staged");
		expect(parseFilesHash(hash)).toEqual({ machine: "m", root: "/r", path: "a.ts", line: 42, diff: "staged" });
	});

	test("segments and names with separators, unicode and percent signs round-trip", () => {
		const ref = { machine: "m/1", root: "C:\\Users\\me\\repo", path: "dir/100%/日本語 #1?.ts" };
		expect(parseFilesHash(filesHash(ref))).toEqual(ref);
	});

	test("bad query values are ignored, not fatal", () => {
		expect(parseFilesHash("#/m/m/f/%2Fr/a.ts?line=0&diff=bogus")).toEqual({ machine: "m", root: "/r", path: "a.ts" });
		expect(parseFilesHash("#/m/m/f/%2Fr/a.ts?line=abc")).toEqual({ machine: "m", root: "/r", path: "a.ts" });
		expect(parseFilesHash("#/m/m/f/%2Fr/a.ts?line=-3")).toEqual({ machine: "m", root: "/r", path: "a.ts" });
		const modes: FileDiffMode[] = ["unstaged", "staged", "head", "untracked"];
		for (const diff of modes) {
			expect(parseFilesHash(`#/m/m/f/%2Fr/a.ts?diff=${diff}`)?.diff).toBe(diff);
		}
	});

	test("malformed or unrelated hashes are null", () => {
		for (const hash of [
			"",
			"#",
			"#/accounts",
			"#/m/home/s/abc",
			"#/m/home/f",
			"#/m/home/f/",
			"#/m/home/f/%E0%A4%A", // malformed percent-encoding
			"#/m/home/f/%2Fr/%E0%A4%A",
			"#/m/home/f/%2Fr//a.ts", // empty segment
			"#/m/home/f/%2Fr/a%2Fb",
			"#/m/home/f/%2Fr/a%00b",
			"/m/home/f/%2Fr",
		]) {
			expect(parseFilesHash(hash)).toBeNull();
		}
	});

	test("`.` and `..` segments are kept so that the daemon's refusal (and its message) is what the page shows", () => {
		expect(parseFilesHash("#/m/m/f/%2Fr/../etc")).toEqual({ machine: "m", root: "/r", path: "../etc" });
		expect(parseFilesHash("#/m/m/f/%2Fr/%2E%2E/%2e%2e/x")?.path).toBe("../../x");
		expect(parseFilesHash("#/m/m/f/%2Fr/./a")?.path).toBe("./a");
	});

	test("a trailing slash is tolerated", () => {
		expect(parseFilesHash("#/m/m/f/%2Fr/src/")).toEqual({ machine: "m", root: "/r", path: "src" });
	});

	test("a Files hash is neither a session nor the accounts page, and the reverse", () => {
		const hash = filesHash({ machine: "m", root: "/r", path: "a" });
		expect(isFilesHash(hash)).toBe(true);
		expect(isAccountsHash(hash)).toBe(false);
		expect(parseSessionHash(hash)).toBeNull();
		expect(isFilesHash("#/accounts")).toBe(false);
		expect(isFilesHash("#/m/m/s/1")).toBe(false);
	});
});
