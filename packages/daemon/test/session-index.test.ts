import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanConversations } from "../src/session-index";
import { turns, writeSessionFile } from "./session-files";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompweb-index-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

describe("session index folding", () => {
	test("files of one conversation (continuationOf chain) fold into one entry represented by the newest copy; forks stay separate", async () => {
		// A is the original file; B continues A in a sibling (another process owned A); C continues B.
		const a = writeSessionFile(dir, {
			id: "A",
			created: iso(0),
			title: "Refactor parser",
			entries: turns("a", ["first question", "first answer"], T0 + 1000),
		});
		const b = writeSessionFile(dir, {
			id: "B",
			created: iso(60_000),
			title: "Refactor parser",
			continuationOf: "A",
			parentSession: "A",
			entries: turns("a", ["first question", "first answer", "second question", "second answer"], T0 + 1000),
		});
		const c = writeSessionFile(dir, {
			id: "C",
			created: iso(120_000),
			title: "Refactor parser",
			continuationOf: "B",
			parentSession: "B",
			entries: turns(
				"a",
				["first question", "first answer", "second question", "second answer", "third question", "third answer"],
				T0 + 1000,
			),
		});
		// A deliberate fork of A: parentSession only. It is its own conversation.
		writeSessionFile(dir, {
			id: "F",
			created: iso(180_000),
			title: "Parser, other approach",
			parentSession: "A",
			entries: turns("f", ["first question", "first answer"], T0 + 1000),
		});
		// An unrelated conversation.
		writeSessionFile(dir, {
			id: "Z",
			created: iso(5_000),
			cwd: "/other",
			entries: turns("z", ["hello", "hi"], T0 + 5000),
		});

		const conversations = await scanConversations(dir);
		const byId = new Map(conversations.map(conv => [conv.id, conv]));
		expect([...byId.keys()].toSorted()).toEqual(["C", "F", "Z"]);
		const folded = byId.get("C")!;
		expect(folded.path).toBe(c);
		expect(folded.files).toBe(3);
		expect(folded.memberIds.toSorted()).toEqual(["A", "B", "C"]);
		expect(folded.title).toBe("Refactor parser");
		expect(folded.preview).toBe("first question");
		expect(byId.get("F")!.files).toBe(1);
		expect(byId.get("Z")!.cwd).toBe("/other");
		// the older files are not separate entries
		expect([a, b].some(path => conversations.some(conv => conv.path === path))).toBe(false);
	});

	test("the newest copy is chosen by conversation activity, not by file mtime (a process that exits late touches its old file)", async () => {
		writeSessionFile(dir, {
			id: "A",
			created: iso(0),
			entries: turns("a", ["q", "a"], T0 + 1000),
			mtime: new Date(T0 + 3_600_000), // the old owner wrote its exit record an hour later
		});
		const b = writeSessionFile(dir, {
			id: "B",
			created: iso(60_000),
			continuationOf: "A",
			parentSession: "A",
			entries: turns("a", ["q", "a", "q2", "a2"], T0 + 1000),
			mtime: new Date(T0 + 120_000),
		});
		const [only] = await scanConversations(dir);
		expect(only!.id).toBe("B");
		expect(only!.path).toBe(b);
		expect(only!.files).toBe(2);
		// ...while the list still sorts it by the latest write on any of its files
		expect(only!.modifiedAt).toBe(T0 + 3_600_000);
	});

	test("the exit record a closing omp appends is not activity: the entry before it dates the conversation", async () => {
		const exit = (at: number) => ({
			type: "custom",
			customType: "session_exit",
			data: { reason: "dispose", kind: "normal", recordedAt: new Date(at).toISOString() },
			id: `x${at}`,
			parentId: "a1",
			timestamp: new Date(at).toISOString(),
		});
		writeSessionFile(dir, {
			id: "closed",
			created: iso(0),
			entries: [...turns("a", ["q", "a"], T0 + 1000), exit(T0 + 600_000), exit(T0 + 900_000)],
			mtime: new Date(T0 + 900_000),
		});
		writeSessionFile(dir, {
			id: "open",
			created: iso(1),
			entries: turns("b", ["q", "a"], T0 + 1000),
			mtime: new Date(T0 + 900_000),
		});
		const byId = new Map((await scanConversations(dir)).map(conv => [conv.id, conv.modifiedAt]));
		expect(byId.get("closed")).toBe(T0 + 2000); // the assistant reply, not the two exits after it
		expect(byId.get("open")).toBe(T0 + 900_000); // no exit record: the file's mtime
	});

	test("content-less stubs are not listed, and a continuation whose parent file is gone stands alone", async () => {
		writeSessionFile(dir, { id: "EMPTY", created: iso(0), entries: [] });
		writeSessionFile(dir, {
			id: "ORPHAN",
			created: iso(1000),
			continuationOf: "DELETED",
			parentSession: "DELETED",
			entries: turns("o", ["q", "a"], T0 + 2000),
		});
		const conversations = await scanConversations(dir);
		expect(conversations.map(conv => conv.id)).toEqual(["ORPHAN"]);
		expect(conversations[0]!.files).toBe(1);
	});
});
