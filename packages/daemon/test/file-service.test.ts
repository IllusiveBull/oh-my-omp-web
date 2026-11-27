import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	FILE_CHUNK_BYTES,
	FILE_IMAGE_MAX_BYTES,
	FILE_LIST_LIMIT,
	HIGHLIGHT_KINDS,
	type FileContent,
} from "@omp-web/protocol";
import { FileError } from "../src/file-path";
import { FileService } from "../src/file-service";
import { git } from "./gateway-harness";
import { codeOf, commitAll, scratch, type Scratch } from "./file-fixtures";

/** NTFS cannot hold these names (`:`, `*`, a newline); the daemon refuses `:` and `\\` in a request path on Windows. */
const NTFS = process.platform === "win32";

type Text = Extract<FileContent, { kind: "text" }>;
const text = (c: FileContent): Text => {
	if (c.kind !== "text") throw new Error(`expected text, got ${c.kind}`);
	return c;
};

// A 1x1 PNG.
const PNG = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
		"base64",
	),
);

let s: Scratch;
beforeAll(async () => {
	s = await scratch();
});
afterAll(() => s.dispose());

describe("directory listings and git's ignore rules", () => {
	beforeAll(async () => {
		await commitAll(s.root, {
			".gitignore": "node_modules/\n*.log\n.env\n!keep.log\ndist/\n",
			"src/app.ts": "export const x = 1;\n",
			"src/lib/util.ts": "export {};\n",
			"README.md": "# readme\n",
			"keep.log": "tracked although it matches *.log\n",
			"a b/ünï cödé.txt": "spaces and unicode\n",
			"Zeta.txt": "z\n",
			"alpha.txt": "a\n",
			"file10.txt": "10\n",
			"file2.txt": "2\n",
		});
		mkdirSync(join(s.root, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(s.root, "node_modules/pkg/index.js"), "module.exports = 1;\n");
		mkdirSync(join(s.root, "dist"));
		writeFileSync(join(s.root, "dist/out.js"), "built\n");
		writeFileSync(join(s.root, ".env"), "TOKEN=abc\n");
		writeFileSync(join(s.root, "debug.log"), "noise\n");
		writeFileSync(join(s.root, "untracked.txt"), "new\n");
		if (!NTFS) {
			writeFileSync(join(s.root, ":(glob)*.txt"), "a name that looks like pathspec magic\n");
			writeFileSync(join(s.root, "new\nline.txt"), "a newline in the name\n");
		}
	});

	test("ignored entries are hidden by default and counted; tracked files that match an ignore pattern stay", async () => {
		const listing = await s.service.list(s.root, "", false);
		const names = listing.entries.map(e => e.name);
		expect(names).not.toContain("node_modules");
		expect(names).not.toContain("dist");
		expect(names).not.toContain(".env");
		expect(names).not.toContain("debug.log");
		expect(names).toContain("keep.log");
		expect(names).toContain("untracked.txt");
		expect(listing).toMatchObject({ ignoredHidden: 4, ignoreChecked: true, truncated: false });
		expect(listing.entries.every(e => e.ignored !== true)).toBe(true);
	});

	test("showIgnored reveals them, flagged", async () => {
		const listing = await s.service.list(s.root, "", true);
		const flagged = listing.entries.filter(e => e.ignored).map(e => e.name);
		expect(flagged.toSorted()).toEqual([".env", "debug.log", "dist", "node_modules"]);
		expect(listing.ignoredHidden).toBe(0);
		expect(listing.entries.find(e => e.name === "keep.log")?.ignored).toBeUndefined();
	});

	test("inside an ignored directory nothing is hidden (it would look empty) and everything is flagged", async () => {
		const listing = await s.service.list(s.root, "node_modules/pkg", false);
		expect(listing.entries).toMatchObject([{ name: "index.js", kind: "file", ignored: true, size: 20 }]);
		expect(listing.ignoredHidden).toBe(0);
	});

	test("directories first, then files, each in natural order; sizes for files; no .git", async () => {
		const names = (await s.service.list(s.root, "", false)).entries.map(
			e => `${e.kind === "dir" ? "d" : "f"}:${e.name}`,
		);
		expect(names.slice(0, 2)).toEqual(["d:a b", "d:src"]);
		const files = names.filter(n => n.startsWith("f:")).map(n => n.slice(2));
		expect(files.indexOf("alpha.txt")).toBeLessThan(files.indexOf("Zeta.txt"));
		expect(files.indexOf("file2.txt")).toBeLessThan(files.indexOf("file10.txt"));
		expect(names).not.toContain("d:.git");
		expect((await s.service.list(s.root, "src", false)).entries.find(e => e.name === "app.ts")).toMatchObject({
			size: 20,
		});
	});

	test("names with spaces, unicode, newlines and a leading colon list and read like any other", async () => {
		const names = (await s.service.list(s.root, "", false)).entries.map(e => e.name);
		if (!NTFS) {
			expect(names).toContain("new\nline.txt");
			expect(names).toContain(":(glob)*.txt");
		}
		expect((await s.service.list(s.root, "a b", false)).entries.map(e => e.name)).toEqual(["ünï cödé.txt"]);
		expect(text(await s.service.read(s.root, "a b/ünï cödé.txt", 1, 10)).text).toBe("spaces and unicode\n");
		if (NTFS) return;
		expect(text(await s.service.read(s.root, ":(glob)*.txt", 1, 10)).text).toContain("pathspec magic");
		// ignore detection works for such a name too (the colon name is not ignored, and was not hidden)
		expect(
			(await s.service.list(s.root, "", false)).entries.find(e => e.name === ":(glob)*.txt")?.ignored,
		).toBeUndefined();
	});

	test("a file's own ignored state is reported when it is opened", async () => {
		expect((await s.service.read(s.root, ".env", 1, 10)).kind).toBe("text");
		expect(await s.service.read(s.root, ".env", 1, 10)).toMatchObject({ ignored: true });
		expect(await s.service.read(s.root, "keep.log", 1, 10)).toMatchObject({ ignored: false });
	});

	test("a submodule's contents: git cannot answer for paths inside it, so nothing is hidden and the listing says so", async () => {
		const nested = join(s.root, "nested");
		mkdirSync(nested);
		await git(nested, "init", "-q", "-b", "main");
		writeFileSync(join(nested, "inner.txt"), "i\n");
		await git(nested, "add", ".");
		await git(nested, "commit", "-q", "-m", "inner");
		await git(s.root, "add", "nested"); // an embedded repository becomes a gitlink
		try {
			const listing = await s.service.list(s.root, "nested", false);
			expect(listing.entries.map(e => e.name)).toEqual(["inner.txt"]);
			expect(listing.ignoreChecked).toBe(false);
			// reading a file in it still works (the path is inside the worktree)
			expect(text(await s.service.read(s.root, "nested/inner.txt", 1, 10)).text).toBe("i\n");
		} finally {
			await git(s.root, "rm", "-q", "-f", "--cached", "nested");
			rmSync(nested, { recursive: true, force: true });
		}
	});
});

describe("listing caps", () => {
	test("more entries than the listing limit are cut off, and it says so; a huge directory is not read to the end", async () => {
		const dir = join(s.root, "many");
		mkdirSync(dir);
		for (let i = 0; i < 5100; i++) writeFileSync(join(dir, `f${String(i).padStart(5, "0")}.txt`), "");
		const listing = await s.service.list(s.root, "many", false);
		expect(listing.entries).toHaveLength(FILE_LIST_LIMIT);
		expect(listing).toMatchObject({ truncated: true, scanned: 5000 });
		rmSync(dir, { recursive: true, force: true });

		mkdirSync(dir);
		for (let i = 0; i < FILE_LIST_LIMIT + 5; i++) writeFileSync(join(dir, `g${i}.txt`), "");
		const mid = await s.service.list(s.root, "many", false);
		expect(mid.entries).toHaveLength(FILE_LIST_LIMIT);
		expect(mid).toMatchObject({ truncated: true, scanned: FILE_LIST_LIMIT + 5 });
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("reading", () => {
	test("text: highlighted spans tile the text exactly", async () => {
		const source = 'import { a } from "x";\n// comment\nfunction f(n: number): string {\n\treturn `v${n}`;\n}\n';
		await commitAll(s.root, { "code.ts": source });
		const c = text(await s.service.read(s.root, "code.ts", 1, 100));
		expect(c).toMatchObject({
			text: source,
			startLine: 1,
			endLine: 5,
			nextLine: null,
			totalLines: 5,
			lang: "ts",
			lossy: false,
			crlf: false,
			bom: false,
		});
		expect(c.spans).not.toBeNull();
		const runs = c.spans!;
		expect(runs.length % 2).toBe(0);
		let total = 0;
		for (let i = 0; i < runs.length; i += 2) {
			expect(runs[i]).toBeGreaterThanOrEqual(0);
			expect(runs[i]).toBeLessThanOrEqual(HIGHLIGHT_KINDS.length);
			total += runs[i + 1]!;
		}
		expect(total).toBe(source.length);
		// the keyword `function` is coloured as a keyword
		let at = 0;
		const kindAt = (index: number): number => {
			at = 0;
			for (let i = 0; i < runs.length; i += 2) {
				if (index < at + runs[i + 1]!) return runs[i]!;
				at += runs[i + 1]!;
			}
			return -1;
		};
		expect(HIGHLIGHT_KINDS[kindAt(source.indexOf("function")) - 1]).toBe("keyword");
		expect(HIGHLIGHT_KINDS[kindAt(source.indexOf("// comment")) - 1]).toBeDefined();
	});

	test("unknown file types and text that would confuse the markers are not highlighted", async () => {
		writeFileSync(join(s.root, "notes.zzz"), "plain\n");
		writeFileSync(join(s.root, "esc.ts"), "const a = '\u001b[31m';\n");
		expect(text(await s.service.read(s.root, "notes.zzz", 1, 10))).toMatchObject({ lang: null, spans: null });
		expect(text(await s.service.read(s.root, "esc.ts", 1, 10))).toMatchObject({ lang: "ts", spans: null });
	});

	test("an empty file, a file without a trailing newline, CRLF and a UTF-8 BOM", async () => {
		writeFileSync(join(s.root, "empty.txt"), "");
		writeFileSync(join(s.root, "nonl.txt"), "one\ntwo");
		writeFileSync(join(s.root, "crlf.txt"), "a\r\nb\r\n");
		writeFileSync(join(s.root, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo\n")]));
		expect(text(await s.service.read(s.root, "empty.txt", 1, 10))).toMatchObject({
			text: "",
			startLine: 1,
			endLine: 0,
			nextLine: null,
			totalLines: 0,
		});
		expect(text(await s.service.read(s.root, "nonl.txt", 1, 10))).toMatchObject({
			text: "one\ntwo",
			endLine: 2,
			nextLine: null,
			totalLines: 2,
		});
		expect(text(await s.service.read(s.root, "crlf.txt", 1, 10))).toMatchObject({
			text: "a\r\nb\r\n",
			crlf: true,
			totalLines: 2,
		});
		expect(text(await s.service.read(s.root, "bom.txt", 1, 10))).toMatchObject({ text: "héllo\n", bom: true });
	});

	test("bytes that are not valid UTF-8 are shown with U+FFFD and flagged, never thrown at", async () => {
		writeFileSync(join(s.root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6f, 0x6b, 0x0a])); // "café\nok\n" in Latin-1
		const c = text(await s.service.read(s.root, "latin1.txt", 1, 10));
		expect(c.lossy).toBe(true);
		expect(c.text).toBe("caf\uFFFD\nok\n");
		expect(text(await s.service.read(s.root, "latin1.txt", 2, 10)).text).toBe("ok\n");
	});

	test("binary content is classified and not dumped: NUL bytes, UTF-16, and a binary-looking blob", async () => {
		writeFileSync(join(s.root, "data.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x41, 0x00]));
		writeFileSync(
			join(s.root, "utf16.txt"),
			Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("h\0i\0", "latin1")]),
		);
		writeFileSync(join(s.root, "ctrl.dat"), Buffer.alloc(200, 0x03));
		for (const path of ["data.bin", "utf16.txt", "ctrl.dat"]) {
			const c = await s.service.read(s.root, path, 1, 10);
			expect(c.kind).toBe("binary");
			expect(JSON.stringify(c)).not.toContain("\\u0000");
			expect("text" in c).toBe(false);
		}
		expect(await s.service.read(s.root, "utf16.txt", 1, 10)).toMatchObject({
			reason: expect.stringContaining("UTF-16"),
		});
	});

	test("images are recognized by content, previewed in chunks that reassemble to the file, and capped", async () => {
		writeFileSync(join(s.root, "pic.png"), PNG);
		writeFileSync(join(s.root, "renamed.txt"), PNG); // the content decides, not the extension
		expect(await s.service.read(s.root, "pic.png", 1, 10)).toMatchObject({
			kind: "image",
			mime: "image/png",
			size: PNG.length,
		});
		expect(await s.service.read(s.root, "renamed.txt", 1, 10)).toMatchObject({ kind: "image", mime: "image/png" });
		const part = await s.service.bytes(s.root, "pic.png", 0, 10);
		expect(part).toMatchObject({ offset: 0, length: 10, size: PNG.length, eof: false });
		const rest = await s.service.bytes(s.root, "pic.png", 10, FILE_CHUNK_BYTES);
		expect(rest.eof).toBe(true);
		expect(Buffer.concat([Buffer.from(part.data, "base64"), Buffer.from(rest.data, "base64")])).toEqual(
			Buffer.from(PNG),
		);
		expect((await s.service.bytes(s.root, "pic.png", PNG.length, 10)).length).toBe(0);

		// bigger than the preview cap: not served as an image
		const big = Buffer.alloc(FILE_IMAGE_MAX_BYTES + 1);
		PNG.slice(0, 16).forEach((b, i) => (big[i] = b));
		writeFileSync(join(s.root, "big.png"), big);
		expect(await s.service.read(s.root, "big.png", 1, 10)).toMatchObject({
			kind: "binary",
			reason: expect.stringContaining("8 MiB"),
		});
		expect(await codeOf(s.service.bytes(s.root, "big.png", 0, 10))).toBe("too_large");
		// raw bytes are an image feature only
		expect(await codeOf(s.service.bytes(s.root, "code.ts", 0, 10))).toBe("forbidden");
		expect(await codeOf(s.service.bytes(s.root, "data.bin", 0, 10))).toBe("forbidden");
	});
});

describe("paging a large text file", () => {
	const LINES = 20_000;
	const line = (n: number): string => `line ${String(n).padStart(5, "0")} ${"x".repeat(60)}\n`;
	beforeAll(() => {
		writeFileSync(join(s.root, "large.txt"), Array.from({ length: LINES }, (_, i) => line(i + 1)).join(""));
	});

	test("pages of the requested line count; jumping anywhere gives the right lines; the total is known", async () => {
		const first = text(await s.service.read(s.root, "large.txt", 1, 1000));
		expect(first).toMatchObject({ startLine: 1, endLine: 1000, nextLine: 1001, totalLines: LINES });
		expect(first.text).toBe(Array.from({ length: 1000 }, (_, i) => line(i + 1)).join(""));
		const jump = text(await s.service.read(s.root, "large.txt", 15_001, 3));
		expect(jump).toMatchObject({
			startLine: 15_001,
			endLine: 15_003,
			nextLine: 15_004,
			text: line(15_001) + line(15_002) + line(15_003),
		});
		const last = text(await s.service.read(s.root, "large.txt", LINES, 10));
		expect(last).toMatchObject({ startLine: LINES, endLine: LINES, nextLine: null, text: line(LINES) });
		const past = text(await s.service.read(s.root, "large.txt", LINES + 50, 10));
		expect(past).toMatchObject({ text: "", nextLine: null, totalLines: LINES });
	});

	test("a page is capped by bytes as well as lines; following nextLine rebuilds the file exactly", async () => {
		let at: number | null = 1;
		let rebuilt = "";
		let pages = 0;
		while (at !== null) {
			const page = text(await s.service.read(s.root, "large.txt", at, 5000));
			expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(FILE_CHUNK_BYTES);
			expect(page.startLine).toBe(at);
			rebuilt += page.text;
			at = page.nextLine;
			pages++;
		}
		expect(pages).toBeGreaterThan(1);
		expect(rebuilt).toBe(Array.from({ length: LINES }, (_, i) => line(i + 1)).join(""));
	});

	test("one line longer than a page is cut, flagged, and paging continues after it", async () => {
		writeFileSync(join(s.root, "longline.txt"), `${"y".repeat(FILE_CHUNK_BYTES + 500)}\nsecond\nthird\n`);
		const first = text(await s.service.read(s.root, "longline.txt", 1, 100));
		expect(first).toMatchObject({ cut: true, startLine: 1, endLine: 1, nextLine: 2 });
		expect(first.text.length).toBeLessThanOrEqual(FILE_CHUNK_BYTES);
		expect(text(await s.service.read(s.root, "longline.txt", 2, 100))).toMatchObject({
			text: "second\nthird\n",
			nextLine: null,
			cut: false,
		});
		writeFileSync(join(s.root, "longlast.txt"), "a\n" + "z".repeat(FILE_CHUNK_BYTES + 10));
		expect(text(await s.service.read(s.root, "longlast.txt", 2, 100))).toMatchObject({ cut: true, nextLine: null });
	});

	test("multi-byte characters are never split by a page boundary", async () => {
		const char = "日本"; // 6 bytes per pair
		writeFileSync(join(s.root, "wide.txt"), `${char.repeat(Math.ceil((FILE_CHUNK_BYTES + 100) / 6))}\nend\n`);
		const page = text(await s.service.read(s.root, "wide.txt", 1, 10));
		expect(page.cut).toBe(true);
		expect(page.lossy).toBe(false);
		expect(page.text).not.toContain("\uFFFD");
	});

	test("files over 32 MiB are paged without an index or a total; over 64 MiB they are not opened", async () => {
		const mib = (n: number): Buffer => Buffer.alloc(n * 1024 * 1024, "abcdefghi\n");
		writeFileSync(join(s.root, "huge.txt"), mib(33));
		const page = text(await s.service.read(s.root, "huge.txt", 1000, 3));
		expect(page).toMatchObject({ startLine: 1000, endLine: 1002, totalLines: null });
		expect(page.nextLine).toBe(1003);
		expect(
			page.text
				.split("\n")
				.slice(0, 3)
				.every(l => l.length === 9 || l.length === 0 || l.length === 8 || l.length === 10),
		).toBe(true);
		writeFileSync(join(s.root, "toobig.txt"), mib(65));
		expect(await s.service.read(s.root, "toobig.txt", 1, 10)).toMatchObject({ kind: "too_large" });
		rmSync(join(s.root, "huge.txt"));
		rmSync(join(s.root, "toobig.txt"));
	});
});

describe("git status", () => {
	test("staged, unstaged, untracked, renamed, deleted and conflicted files, with awkward names", async () => {
		await commitAll(s.root, {
			"st/tracked.txt": "one\n",
			"st/to-rename.txt":
				"rename me, with enough content to be recognized as the same file\nsecond line\nthird line\n",
			"st/to-delete.txt": "bye\n",
			"st/with space.txt": "x\n",
			"st/日本語.txt": "x\n",
			"st/to-stage.txt": "x\n",
		});
		writeFileSync(join(s.root, "st/tracked.txt"), "one\ntwo\n"); // unstaged
		writeFileSync(join(s.root, "st/to-stage.txt"), "x\ny\n");
		await git(s.root, "add", "st/to-stage.txt"); // staged
		await git(s.root, "mv", "st/to-rename.txt", "st/renamed file.txt");
		rmSync(join(s.root, "st/to-delete.txt"));
		writeFileSync(join(s.root, "st/with space.txt"), "changed\n");
		writeFileSync(join(s.root, "st/日本語.txt"), "changed\n");
		if (!NTFS) writeFileSync(join(s.root, "st/new\nname.txt"), "untracked with a newline in its name\n");
		mkdirSync(join(s.root, "st/newdir"));
		writeFileSync(join(s.root, "st/newdir/inner.txt"), "i\n");

		const status = await s.service.status(s.root);
		expect(status.branch.head).toBe("main");
		expect(status.truncated).toBe(false);
		const by = Object.fromEntries(status.entries.map(e => [e.path, e]));
		expect(by["st/tracked.txt"]).toMatchObject({ kind: "changed", x: ".", y: "M" });
		expect(by["st/to-stage.txt"]).toMatchObject({ kind: "changed", x: "M", y: "." });
		expect(by["st/renamed file.txt"]).toMatchObject({ kind: "renamed", origPath: "st/to-rename.txt", x: "R" });
		expect(by["st/to-delete.txt"]).toMatchObject({ kind: "changed", x: ".", y: "D" });
		expect(by["st/with space.txt"]).toMatchObject({ y: "M" });
		expect(by["st/日本語.txt"]).toMatchObject({ y: "M" });
		if (!NTFS) expect(by["st/new\nname.txt"]).toMatchObject({ kind: "untracked" });
		expect(by["st/newdir/"]).toMatchObject({ kind: "untracked", dir: true });
		// each side of a change counts its own lines; an untracked directory sums its files
		expect(by["st/tracked.txt"]).toMatchObject({ unstaged: { added: 1, removed: 0 } });
		expect(by["st/tracked.txt"]!.staged).toBeUndefined();
		expect(by["st/to-stage.txt"]).toMatchObject({ staged: { added: 1, removed: 0 } });
		expect(by["st/to-stage.txt"]!.unstaged).toBeUndefined();
		expect(by["st/renamed file.txt"]).toMatchObject({ staged: { added: 0, removed: 0 } });
		expect(by["st/to-delete.txt"]).toMatchObject({ unstaged: { added: 0, removed: 1 } });
		expect(by["st/日本語.txt"]).toMatchObject({ unstaged: { added: 1, removed: 1 } });
		if (!NTFS) expect(by["st/new\nname.txt"]).toMatchObject({ unstaged: { added: 1, removed: 0 } });
		expect(by["st/newdir/"]).toMatchObject({ unstaged: { added: 1, removed: 0 } });
		// ignored files are not part of status
		expect(Object.keys(by)).not.toContain(".env");
	});

	test("a merge conflict is reported as unmerged, and its diff is the combined one", async () => {
		await git(s.root, "add", "-A");
		await git(s.root, "commit", "-q", "-m", "wip");
		await commitAll(s.root, { "conflict.txt": "base\n" });
		await git(s.root, "checkout", "-q", "-b", "other");
		await commitAll(s.root, { "conflict.txt": "other side\n" });
		await git(s.root, "checkout", "-q", "main");
		await commitAll(s.root, { "conflict.txt": "main side\n" });
		await git(s.root, "merge", "other").catch(() => {}); // exits 1 on conflict
		const status = await s.service.status(s.root);
		expect(status.entries.find(e => e.path === "conflict.txt")).toMatchObject({ kind: "unmerged", x: "U", y: "U" });
		const diff = await s.service.diff(s.root, "conflict.txt", "unstaged");
		expect(diff.diff).toContain("<<<<<<<");
		await git(s.root, "merge", "--abort");
	});
});

describe("git diff", () => {
	beforeAll(async () => {
		await commitAll(s.root, {
			"d/file.txt": "line 1\nline 2\nline 3\n",
			"d/moved-from.txt":
				"the content of a file that is going to be renamed, long enough for similarity\nsecond line of it\nthird line of it\n",
			"d/bin.dat": Uint8Array.from([0, 1, 2, 3, 4, 5, 0, 0]),
			"d/with space.txt": "a\n",
		});
	});

	test("unstaged, staged and against HEAD are three different views of the same file", async () => {
		writeFileSync(join(s.root, "d/file.txt"), "line 1\nline 2 staged\nline 3\n");
		await git(s.root, "add", "d/file.txt");
		writeFileSync(join(s.root, "d/file.txt"), "line 1\nline 2 staged\nline 3 unstaged\n");
		const unstaged = await s.service.diff(s.root, "d/file.txt", "unstaged");
		const staged = await s.service.diff(s.root, "d/file.txt", "staged");
		const head = await s.service.diff(s.root, "d/file.txt", "head");
		expect(unstaged.diff).toContain("+line 3 unstaged");
		expect(unstaged.diff).not.toContain("line 2 staged\n+");
		expect(unstaged).toMatchObject({ added: 1, removed: 1, binary: false, truncated: false });
		expect(staged.diff).toContain("+line 2 staged");
		expect(staged.diff).not.toContain("unstaged");
		expect(head.diff).toContain("+line 2 staged");
		expect(head.diff).toContain("+line 3 unstaged");
		expect(head).toMatchObject({ added: 2, removed: 2 });
	});

	test("a rename is detected when both paths are given; its similarity is reported", async () => {
		await git(s.root, "mv", "d/moved-from.txt", "d/moved to.txt");
		writeFileSync(
			join(s.root, "d/moved to.txt"),
			"the content of a file that is going to be renamed, long enough for similarity\nsecond line of it\nthird line EDITED\n",
		);
		const diff = await s.service.diff(s.root, "d/moved to.txt", "head", "d/moved-from.txt");
		expect(diff.renamedFrom).toBe("d/moved-from.txt");
		expect(diff.origPath).toBe("d/moved-from.txt");
		expect(diff.diff).toContain("rename to d/moved to.txt");
		expect(diff).toMatchObject({ added: 1, removed: 1 });
		const staged = await s.service.diff(s.root, "d/moved to.txt", "staged", "d/moved-from.txt");
		expect(staged.diff).toContain("rename from d/moved-from.txt");
		expect(staged).toMatchObject({ added: 0, removed: 0 });
	});

	test("a changed binary file is marked, with no content", async () => {
		writeFileSync(join(s.root, "d/bin.dat"), Uint8Array.from([9, 9, 0, 0, 1]));
		const diff = await s.service.diff(s.root, "d/bin.dat", "unstaged");
		expect(diff).toMatchObject({ binary: true, added: 0, removed: 0 });
		expect(diff.diff).toContain("Binary files");
	});

	test("an untracked file is shown as an all-added file; binary and empty ones too; never from outside", async () => {
		writeFileSync(join(s.root, "d/fresh.txt"), "alpha\nbeta");
		const diff = await s.service.diff(s.root, "d/fresh.txt", "untracked");
		expect(diff).toMatchObject({ added: 2, removed: 0, binary: false, truncated: false });
		expect(diff.diff).toContain("new file mode 100644");
		expect(diff.diff).toContain("@@ -0,0 +1,2 @@\n+alpha\n+beta\n\\ No newline at end of file");
		writeFileSync(join(s.root, "d/fresh.bin"), Uint8Array.from([0, 1, 2]));
		expect(await s.service.diff(s.root, "d/fresh.bin", "untracked")).toMatchObject({ binary: true });
		writeFileSync(join(s.root, "d/fresh-empty.txt"), "");
		expect(await s.service.diff(s.root, "d/fresh-empty.txt", "untracked")).toMatchObject({ added: 0, binary: false });
		expect(await codeOf(s.service.diff(s.root, "../outside/secret.txt", "untracked"))).toBe("bad_path");
	});

	test("paths with spaces; magic in a name is not pathspec magic; a path that matches nothing is an empty diff", async () => {
		writeFileSync(join(s.root, "d/with space.txt"), "a\nb\n");
		expect((await s.service.diff(s.root, "d/with space.txt", "unstaged")).added).toBe(1);
		if (NTFS) {
			// a colon cannot be part of a Windows name, so the request is refused before git sees it
			expect(await codeOf(s.service.diff(s.root, ":(glob)d/**", "unstaged"))).toBe("bad_path");
		} else {
			const magic = await s.service.diff(s.root, ":(glob)d/**", "unstaged");
			expect(magic).toMatchObject({ diff: "", added: 0 });
		}
		expect((await s.service.diff(s.root, "d/*.txt", "unstaged")).diff).toBe(""); // a glob is a literal name here
	});

	test("the output is bounded: a huge change is cut at a line boundary and flagged", async () => {
		await commitAll(s.root, { "d/big.txt": "start\n" });
		writeFileSync(
			join(s.root, "d/big.txt"),
			Array.from({ length: 60_000 }, (_, i) => `changed line ${i} ${"z".repeat(40)}\n`).join(""),
		);
		const diff = await s.service.diff(s.root, "d/big.txt", "unstaged");
		expect(diff.truncated).toBe(true);
		expect(diff.diff.length).toBeLessThanOrEqual(512 * 1024);
		expect(diff.diff.endsWith("\n")).toBe(true);
		const untracked = await (async () => {
			writeFileSync(
				join(s.root, "d/big-new.txt"),
				Array.from({ length: 60_000 }, (_, i) => `new line ${i} ${"z".repeat(40)}\n`).join(""),
			);
			return s.service.diff(s.root, "d/big-new.txt", "untracked");
		})();
		expect(untracked.truncated).toBe(true);
		expect(untracked.diff.length).toBeLessThanOrEqual(600 * 1024); // the added "+" per line comes on top of the 512 KiB read
		expect(untracked.diff.endsWith("\n")).toBe(true);
	});

	test("syntax violations in either path are refused", async () => {
		expect(await codeOf(s.service.diff(s.root, "../x", "unstaged"))).toBe("bad_path");
		expect(await codeOf(s.service.diff(s.root, "d/file.txt", "staged", "/etc/passwd"))).toBe("bad_path");
		expect(await codeOf(s.service.diff(s.root, ".git/config", "unstaged"))).toBe("forbidden");
		expect(await codeOf(s.service.diff(s.root, "", "unstaged"))).toBe("bad_path");
	});
});

describe("omp URLs (files.locate)", () => {
	test("the located file's directory becomes browsable; other directories stay refused", async () => {
		const artifacts = join(s.dir, "session-artifacts");
		mkdirSync(join(artifacts, "local"), { recursive: true });
		writeFileSync(join(artifacts, "local", "plan.md"), "# Plan\n");
		const asked: string[] = [];
		const service = new FileService({
			resolveRoot: async root => {
				throw new FileError("not_registered", `${root} is not registered`);
			},
			locateUrl: async (sessionId, url) => {
				asked.push(`${sessionId} ${url}`);
				if (url === "local://plan.md") return join(artifacts, "local", "plan.md");
				if (url === "local://") return join(artifacts, "local");
				throw new FileError("not_found", `${url} has no file on this machine`);
			},
		});
		const read = (root: string, path: string): Promise<unknown> =>
			service.handle({ t: "files.read", reqId: "r", root, path });

		expect(await codeOf(read(join(artifacts, "local"), "plan.md"))).toBe("not_registered");
		const file = await service.handle({ t: "files.locate", reqId: "l", sessionId: "s1", url: "local://plan.md" });
		expect(file).toEqual({ root: join(artifacts, "local"), path: "plan.md" });
		expect(text((await read(join(artifacts, "local"), "plan.md")) as FileContent).text).toBe("# Plan\n");
		// Only the directory itself, not what lies above it.
		expect(await codeOf(read(join(artifacts, "local"), "../../outside/secret.txt"))).toBe("bad_path");
		expect(await codeOf(read(artifacts, "local/plan.md"))).toBe("not_registered");

		expect(await service.handle({ t: "files.locate", reqId: "l", sessionId: "s1", url: "local://" })).toEqual({
			root: join(artifacts, "local"),
			path: "",
		});
		expect(
			await codeOf(service.handle({ t: "files.locate", reqId: "l", sessionId: "s1", url: "local://gone.md" })),
		).toBe("not_found");
		expect(asked).toEqual(["s1 local://plan.md", "s1 local://", "s1 local://gone.md"]);
	});
});
