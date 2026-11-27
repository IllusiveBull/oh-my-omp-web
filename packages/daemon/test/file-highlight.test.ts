import { describe, expect, test } from "bun:test";
import { HIGHLIGHT_KINDS } from "@omp-web/protocol";
import { HIGHLIGHT_MAX_CHARS, highlightSpans, languageFor } from "../src/file-highlight";

const kindsOf = (text: string, runs: number[]): string[] => {
	const out: string[] = [];
	let at = 0;
	for (let i = 0; i < runs.length; i += 2) {
		const piece = text.slice(at, at + runs[i + 1]!);
		at += runs[i + 1]!;
		out.push(`${runs[i] === 0 ? "plain" : HIGHLIGHT_KINDS[runs[i]! - 1]}:${piece}`);
	}
	return out;
};

describe("languageFor", () => {
	test("by extension and well-known file names; unknown and extensionless files have none", () => {
		expect(languageFor("src/a.ts")).toBe("ts");
		expect(languageFor("a/b/Cargo.toml")).toBe("toml");
		expect(languageFor("Dockerfile")).toBe("dockerfile");
		expect(languageFor("sub/Makefile")).toBe("makefile");
		expect(languageFor(".gitignore")).toBe(".gitignore");
		expect(languageFor("notes.zzz")).toBeNull();
		expect(languageFor("LICENSE")).toBeNull();
		expect(languageFor("dir.d/file")).toBeNull();
	});
});

describe("highlightSpans", () => {
	test("runs cover the text exactly, with the expected classes", () => {
		const code = "const n = 42; // hi\n";
		const runs = highlightSpans(code, "ts")!;
		expect(runs.length % 2).toBe(0);
		expect(runs.reduce((sum, v, i) => (i % 2 === 1 ? sum + v : sum), 0)).toBe(code.length);
		const named = kindsOf(code, runs);
		expect(named).toContain("keyword:const");
		expect(named).toContain("number:42");
		expect(named.some(p => p.startsWith("comment:") && p.includes("hi"))).toBe(true);
	});

	test("multi-line constructs and non-BMP characters keep the lengths in UTF-16 units", () => {
		const code = '/* one\n two 😀 */\nlet s = "😀";\n';
		const runs = highlightSpans(code, "js")!;
		expect(runs.reduce((sum, v, i) => (i % 2 === 1 ? sum + v : sum), 0)).toBe(code.length);
		// the comment body spans a line break and a surrogate pair, in one run of 13 units
		expect(kindsOf(code, runs)).toContain("comment: one\n two 😀 ");
	});

	test("no language, empty text, text with the markers' control characters, or nothing coloured: no spans", () => {
		expect(highlightSpans("let x = 1;", null)).toBeNull();
		expect(highlightSpans("", "ts")).toBeNull();
		expect(highlightSpans("let x = '\u001b[31m';", "ts")).toBeNull();
		expect(highlightSpans("let x = '\u0001K\u0002';", "ts")).toBeNull();
		expect(highlightSpans("just words\n", "txt")).toBeNull();
		// a page too big to highlight without stalling the daemon is shown plain
		expect(highlightSpans("let x = 1;\n".repeat(Math.ceil(HIGHLIGHT_MAX_CHARS / 10) + 10), "ts")).toBeNull();
	});
});
