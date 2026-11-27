import { describe, expect, test } from "bun:test";
import {
	editKey,
	editedLines,
	ompUrlCandidate,
	pathCandidate,
	resolveToolPath,
	rootsOfMachine,
	tokenAt,
} from "../src/lib/files-links";
import { machineSummary, project, worktree } from "./fixtures";

const ctx = {
	roots: ["/Users/me/proj", "/Users/me/proj-wt", "/a/repo", "/a/repo/.wt/feature"],
	cwd: "/Users/me/proj/packages/web",
};

describe("resolveToolPath", () => {
	test("an absolute path inside a root", () => {
		expect(resolveToolPath("/Users/me/proj/src/a.ts", ctx)).toEqual({ root: "/Users/me/proj", path: "src/a.ts" });
	});

	test("the root itself is the empty path", () => {
		expect(resolveToolPath("/Users/me/proj", ctx)).toEqual({ root: "/Users/me/proj", path: "" });
		expect(resolveToolPath("/Users/me/proj/", ctx)).toEqual({ root: "/Users/me/proj", path: "" });
	});

	test("home-shortened paths match a root by its own shortened form", () => {
		expect(resolveToolPath("~/proj/src/a.ts", ctx)).toEqual({ root: "/Users/me/proj", path: "src/a.ts" });
		expect(resolveToolPath("~/proj", ctx)).toEqual({ root: "/Users/me/proj", path: "" });
		expect(resolveToolPath("~/proj-wt/x.ts", ctx)).toEqual({ root: "/Users/me/proj-wt", path: "x.ts" });
		expect(resolveToolPath("~/other/x.ts", ctx)).toBeNull();
		expect(resolveToolPath("~/proj/../other/x.ts", ctx)).toBeNull();
	});

	test("a ~ path fitting several roots prefers the session's worktree", () => {
		const roots = ["/Users/a/work", "/home/b/work"];
		expect(resolveToolPath("~/work/x.ts", { roots, cwd: "/Users/a/work" })?.root).toBe("/Users/a/work");
		expect(resolveToolPath("~/work/x.ts", { roots, cwd: "/", preferredRoot: "/home/b/work" })?.root).toBe(
			"/home/b/work",
		);
	});

	test("relative paths are joined with the session's cwd", () => {
		expect(resolveToolPath("src/a.ts", ctx)).toEqual({ root: "/Users/me/proj", path: "packages/web/src/a.ts" });
		expect(resolveToolPath("./src/a.ts", ctx)).toEqual({ root: "/Users/me/proj", path: "packages/web/src/a.ts" });
	});

	test("dot-dot segments are resolved textually and may leave a root", () => {
		expect(resolveToolPath("../daemon/x.ts", ctx)).toEqual({ root: "/Users/me/proj", path: "packages/daemon/x.ts" });
		expect(resolveToolPath("../../../outside.ts", ctx)).toBeNull();
		expect(resolveToolPath("/Users/me/proj/src/../lib/b.ts", ctx)).toEqual({
			root: "/Users/me/proj",
			path: "lib/b.ts",
		});
		expect(resolveToolPath("/Users/me/proj/../../../../x", ctx)).toBeNull();
	});

	test("paths outside every root are not resolved", () => {
		expect(resolveToolPath("/etc/passwd", ctx)).toBeNull();
		expect(resolveToolPath("/Users/me/other/a.ts", ctx)).toBeNull();
		expect(resolveToolPath("", ctx)).toBeNull();
	});

	test("omp's internal URLs and web URLs are not files, though a relative join would land inside the cwd's root", () => {
		for (const url of [
			"local://report.md",
			"plan://current",
			"proc://bg_1",
			"artifact://12:5",
			"https://x.dev/a.ts",
		]) {
			expect(resolveToolPath(url, ctx)).toBeNull();
		}
		expect(resolveToolPath("C://Users/me/proj", { roots: ["C:\\Users\\me\\proj"], cwd: "C:\\" })).toEqual({
			root: "C:\\Users\\me\\proj",
			path: "",
		});
	});

	test("a sibling that only shares the root's prefix is outside it", () => {
		expect(resolveToolPath("/a/repo-sibling/x.ts", ctx)).toBeNull();
		expect(resolveToolPath("/a/repository", ctx)).toBeNull();
		expect(resolveToolPath("/a/repo/x.ts", ctx)).toEqual({ root: "/a/repo", path: "x.ts" });
	});

	test("the innermost root wins, a nested worktree over its parent", () => {
		expect(resolveToolPath("/a/repo/.wt/feature/x.ts", ctx)).toEqual({ root: "/a/repo/.wt/feature", path: "x.ts" });
		expect(resolveToolPath("/a/repo/.wt/other/x.ts", ctx)).toEqual({ root: "/a/repo", path: ".wt/other/x.ts" });
	});

	test("line suffixes: line, range and line:column", () => {
		expect(resolveToolPath("/Users/me/proj/src/a.ts:12", ctx)).toEqual({
			root: "/Users/me/proj",
			path: "src/a.ts",
			line: 12,
		});
		expect(resolveToolPath("~/proj/src/a.ts:12-20", ctx)).toEqual({
			root: "/Users/me/proj",
			path: "src/a.ts",
			line: 12,
		});
		expect(resolveToolPath("src/a.ts:7:3", ctx)).toEqual({
			root: "/Users/me/proj",
			path: "packages/web/src/a.ts",
			line: 7,
		});
	});

	test("Windows paths: drive letters, backslashes, case-insensitive, relative to a Windows cwd", () => {
		const win = { roots: ["C:\\Users\\me\\repo", "D:/data/proj"], cwd: "C:\\Users\\me\\repo\\pkg" };
		expect(resolveToolPath("C:\\Users\\me\\repo\\src\\a.ts", win)).toEqual({
			root: "C:\\Users\\me\\repo",
			path: "src/a.ts",
		});
		expect(resolveToolPath("c:/users/ME/repo/src/a.ts:5", win)).toEqual({
			root: "C:\\Users\\me\\repo",
			path: "src/a.ts",
			line: 5,
		});
		expect(resolveToolPath("src\\b.ts", win)).toEqual({ root: "C:\\Users\\me\\repo", path: "pkg/src/b.ts" });
		expect(resolveToolPath("..\\x.ts", win)).toEqual({ root: "C:\\Users\\me\\repo", path: "x.ts" });
		expect(resolveToolPath("D:\\data\\proj\\y.ts", win)).toEqual({ root: "D:/data/proj", path: "y.ts" });
		expect(resolveToolPath("C:\\Users\\me\\repo-two\\a.ts", win)).toBeNull();
		expect(resolveToolPath("E:\\elsewhere\\a.ts", win)).toBeNull();
	});

	test("an unusable cwd leaves relative paths alone but absolute ones work", () => {
		const noCwd = { roots: ["/r"], cwd: "" };
		expect(resolveToolPath("a.ts", noCwd)).toBeNull();
		expect(resolveToolPath("/r/a.ts", noCwd)).toEqual({ root: "/r", path: "a.ts" });
	});
});

describe("rootsOfMachine", () => {
	test("lists project roots and every worktree once", () => {
		const machine = machineSummary({
			projects: [project("/p/app", [worktree("/p/app", { main: true }), worktree("/p/app-wt")]), project("/p/solo")],
		});
		expect(rootsOfMachine(machine)).toEqual(["/p/app", "/p/app-wt", "/p/solo"]);
		expect(rootsOfMachine(undefined)).toEqual([]);
	});
});

describe("tokens in plain output", () => {
	test("tokenAt finds the word around a caret position", () => {
		const text = "match in src/a.ts:12: text";
		expect(tokenAt(text, 12)).toBe("src/a.ts:12:");
		expect(tokenAt(text, 9)).toBe("src/a.ts:12:"); // first character
		expect(tokenAt(text, 21)).toBe("src/a.ts:12:"); // just after the word
		expect(tokenAt(text, 0)).toBe("match");
		expect(tokenAt("a  b", 1)).toBe("a"); // just after the word
		expect(tokenAt("a  b", 2)).toBeNull(); // between two words
		expect(tokenAt("   ", 1)).toBeNull();
		expect(tokenAt("", 0)).toBeNull();
	});

	test("pathCandidate accepts absolute paths, paths with a separator, and file:line", () => {
		expect(pathCandidate("src/a.ts")).toEqual({ text: "src/a.ts" });
		expect(pathCandidate("/abs/b.ts:12")).toEqual({ text: "/abs/b.ts", line: 12 });
		expect(pathCandidate("a.ts:12:5")).toEqual({ text: "a.ts", line: 12 });
		expect(pathCandidate("(src/a.ts:12)")).toEqual({ text: "src/a.ts", line: 12 });
		expect(pathCandidate('"src/a.ts",')).toEqual({ text: "src/a.ts" });
		expect(pathCandidate("src/a.ts:12:const")).toEqual({ text: "src/a.ts", line: 12 });
		expect(pathCandidate("~/proj/a.ts")).toEqual({ text: "~/proj/a.ts" });
		expect(pathCandidate("C:\\x\\a.ts:3")).toEqual({ text: "C:\\x\\a.ts", line: 3 });
	});

	test("pathCandidate rejects words that are not paths", () => {
		for (const token of [
			"hello",
			"a.ts",
			"12:30",
			"https://example.com/a.ts",
			"--flag",
			"-rf",
			"a=b/c",
			"*.ts",
			"",
			"()",
			"$HOME/x",
		]) {
			expect(pathCandidate(token)).toBeNull();
		}
	});

	test("omp URLs the machine can locate, with the first line of their read selector", () => {
		expect(ompUrlCandidate("local://plan.md")).toEqual({ url: "local://plan.md" });
		expect(ompUrlCandidate("(local://notes/a.md:40-60),")).toEqual({ url: "local://notes/a.md", line: 40 });
		expect(ompUrlCandidate("artifact://12:raw")).toEqual({ url: "artifact://12" });
		expect(ompUrlCandidate("agent://Parent.Child")).toEqual({ url: "agent://Parent.Child" });
		expect(ompUrlCandidate("skill://cf-cli")).toEqual({ url: "skill://cf-cli" });
		for (const token of ["proc://bg_1", "vault://key", "xd://lsp", "https://x.dev/a.md", "pr://12", "local:/x"]) {
			expect(ompUrlCandidate(token)).toBeNull();
		}
	});

	test("a candidate resolves like any other path", () => {
		const candidate = pathCandidate("[src/a.ts:12],");
		expect(candidate).not.toBeNull();
		expect(resolveToolPath(`${candidate!.text}:${candidate!.line}`, ctx)).toEqual({
			root: "/Users/me/proj",
			path: "packages/web/src/a.ts",
			line: 12,
		});
	});
});

describe("editedLines", () => {
	const result = (details: unknown, extra: Record<string, unknown> = {}) => ({
		type: "message",
		message: { role: "toolResult", toolName: "edit", details, ...extra },
	});

	test("the first changed line of the newest successful edit of each file, by resolved path", () => {
		const lines = editedLines(
			[
				result({ path: "/Users/me/proj/src/a.ts", firstChangedLine: 10 }),
				result({ path: "/Users/me/proj/src/a.ts", firstChangedLine: 42 }),
				result({ path: "src/rel.ts", firstChangedLine: 7 }), // relative: against the session's cwd
				result({ path: "/elsewhere/x.ts", firstChangedLine: 3 }), // outside every root
				result({ path: "/Users/me/proj/src/b.ts" }), // no line
				result({ path: "/Users/me/proj/src/c.ts", firstChangedLine: 5 }, { isError: true }),
				result({ path: "/Users/me/proj/src/d.ts", firstChangedLine: 0 }),
				result({ path: "/Users/me/proj/src/e.ts", firstChangedLine: 1.5 }),
				{
					type: "message",
					message: { role: "assistant", details: { path: "/Users/me/proj/src/f.ts", firstChangedLine: 9 } },
				},
				{ type: "compaction" },
				"junk",
				null,
			],
			ctx,
		);
		expect([...lines]).toEqual([
			[editKey("/Users/me/proj", "src/a.ts"), 42],
			[editKey("/Users/me/proj", "packages/web/src/rel.ts"), 7],
		]);
	});

	test("a multi-file edit contributes every file that succeeded", () => {
		const lines = editedLines(
			[
				result({
					perFileResults: [
						{ path: "/Users/me/proj/src/one.ts", firstChangedLine: 4 },
						{ path: "/Users/me/proj/src/two.ts", firstChangedLine: 8, isError: true },
						{ path: "/Users/me/proj/src/three.ts", firstChangedLine: 12 },
					],
				}),
			],
			ctx,
		);
		expect(lines.get(editKey("/Users/me/proj", "src/one.ts"))).toBe(4);
		expect(lines.has(editKey("/Users/me/proj", "src/two.ts"))).toBe(false);
		expect(lines.get(editKey("/Users/me/proj", "src/three.ts"))).toBe(12);
	});
});

describe("macOS links into /private", () => {
	const mac = { roots: ["/private/var/folders/x/T/proj"], cwd: "/private/var/folders/x/T/proj" };

	test("a path printed as /var/... fits the canonical /private/var/... root, only when the text itself fits none", () => {
		expect(resolveToolPath("/var/folders/x/T/proj/src/a.ts", mac)).toEqual({
			root: "/private/var/folders/x/T/proj",
			path: "src/a.ts",
		});
		expect(resolveToolPath("/tmp/other/a.ts", mac)).toBeNull();
		// a real /var/www project on another OS is not rewritten: the literal text wins
		const linux = { roots: ["/var/www/site"], cwd: "/var/www/site" };
		expect(resolveToolPath("/var/www/site/index.php", linux)).toEqual({ root: "/var/www/site", path: "index.php" });
		expect(resolveToolPath("/var/www/other/index.php", linux)).toBeNull();
	});
});
