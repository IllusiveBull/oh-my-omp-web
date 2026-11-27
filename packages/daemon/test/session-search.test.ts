import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/manager";
import { scanConversations } from "../src/session-index";
import { searchConversations } from "../src/session-search";
import { turns, writeSessionFile } from "./session-files";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompweb-search-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** Four conversations; modified (oldest to newest) A, B, C, D. */
function seed(): void {
	writeSessionFile(dir, {
		id: "A",
		created: iso(0),
		title: "Parser rewrite plan",
		entries: turns("a", ["start", "the xylophone tokenizer is slow"], T0 + 1000),
		mtime: new Date(T0 + 10_000),
	});
	writeSessionFile(dir, {
		id: "B",
		created: iso(1000),
		title: "Docs",
		entries: turns("b", ["parser rewrite notes", "ok"], T0 + 2000),
		mtime: new Date(T0 + 20_000),
	});
	writeSessionFile(dir, {
		id: "C",
		created: iso(2000),
		title: "parser rewrite",
		entries: turns("c", ["hello", "hi"], T0 + 3000),
		mtime: new Date(T0 + 30_000),
	});
	writeSessionFile(dir, {
		id: "D",
		created: iso(3000),
		title: "Unrelated",
		entries: turns("d", ["rewrite the parser", "sure"], T0 + 4000),
		mtime: new Date(T0 + 40_000),
	});
}

describe("searchConversations", () => {
	test("finds text that is neither the title nor the first prompt (the transcript body)", async () => {
		seed();
		const conversations = await scanConversations(dir);
		expect(await searchConversations(conversations, "xylophone")).toEqual(["A"]);
	});

	test("every token must match; exact titles lead partial titles, then other literal matches newest first", async () => {
		seed();
		const conversations = await scanConversations(dir);
		// C: exact title (case-insensitive). A: title contains it (partial). D, B: only the text, newest first.
		expect(await searchConversations(conversations, "Parser  Rewrite")).toEqual(["C", "A", "D", "B"]);
		expect(await searchConversations(conversations, "parser xylophone")).toEqual(["A"]);
		expect(await searchConversations(conversations, "parser zzzzqqq")).toEqual([]);
		expect(await searchConversations(conversations, "   ")).toEqual([]);
	});

	test("prompt-history matches lead in history order, named by any file of a conversation; unknown ids are ignored", async () => {
		writeSessionFile(dir, {
			id: "OLD",
			created: iso(0),
			entries: turns("o", ["q", "a"], T0 + 1000),
			mtime: new Date(T0 + 10_000),
		});
		writeSessionFile(dir, {
			id: "NEW",
			created: iso(60_000),
			continuationOf: "OLD",
			parentSession: "OLD",
			entries: turns("o", ["q", "a", "needle in the text"], T0 + 1000),
			mtime: new Date(T0 + 20_000),
		});
		writeSessionFile(dir, {
			id: "X",
			created: iso(1000),
			entries: turns("x", ["deep prompt only history knows", "a"], T0 + 5000),
			mtime: new Date(T0 + 30_000),
		});
		const conversations = await scanConversations(dir);
		const asked: string[] = [];
		const history = (query: string) => {
			asked.push(query);
			return ["gone", "OLD", "OLD", "X"];
		};
		// OLD is the id of a folded file: the conversation (id NEW) leads, then X, no duplicate.
		expect(await searchConversations(conversations, "deep", history)).toEqual(["NEW", "X"]);
		expect(await searchConversations(conversations, "needle", history)).toEqual(["NEW", "X"]);
		expect(asked).toEqual(["deep", "needle"]);
	});

	test("a one-character query does not consult the prompt history", async () => {
		seed();
		const conversations = await scanConversations(dir);
		const asked: string[] = [];
		await searchConversations(conversations, "p", query => (asked.push(query), []));
		expect(asked).toEqual([]);
	});
});

describe("SessionManager.searchSessions", () => {
	test("searches the indexed conversations with the configured prompt history", async () => {
		seed();
		const manager = new SessionManager({
			ompPath: "unused",
			sessionDir: dir,
			resolveCwd: async cwd => cwd,
			probeLeases: async () => ({ held: new Set(), unknown: new Set() }),
			historyMatcher: () => ["B"],
		});
		await manager.refresh();
		expect(await manager.searchSessions("xylophone")).toEqual(["B", "A"]);
		await manager.closeAll();
	});
});
