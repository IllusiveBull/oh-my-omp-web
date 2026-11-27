import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SequencedEvent } from "@omp-web/protocol";
import type { Conversation } from "../src/session-index";
import { StoredSession } from "../src/stored-session";
import { assistant, user, writeSessionFile } from "./session-files";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompweb-stored-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const at = (n: number) => new Date(T0 + n * 1000).toISOString();

function conversationOf(path: string, id: string): Conversation {
	return {
		id,
		path,
		memberIds: [id],
		memberPaths: [path],
		files: 1,
		cwd: "/work/project",
		createdAt: T0,
		modifiedAt: T0,
		messageCount: 0,
		searchText: "",
	};
}

const texts = (snapshotEntries: readonly unknown[]): string[] =>
	(snapshotEntries as { message?: { content: { text: string }[] } }[]).map(e => e.message?.content[0]?.text ?? "");

describe("stored session transcript", () => {
	// u1 - a1 - u2 - a2          (abandoned)
	//        \- u2b - a2b        (active: its entries were appended last)
	const entries = () => [
		user("u1", null, "question", at(1)),
		assistant("a1", "u1", "answer", at(2)),
		user("u2", "a1", "follow-up", at(3)),
		assistant("a2", "u2", "first try", at(4)),
		user("u2b", "a1", "better follow-up", at(5)),
		assistant("a2b", "u2b", "second try", at(6)),
	];

	test("renders the active branch from the file, not every branch", async () => {
		const path = writeSessionFile(dir, { id: "S", created: at(0), title: "Branchy", entries: entries() });
		const stored = await StoredSession.open({ conversation: conversationOf(path, "S"), access: "free" });
		const { result } = stored.subscribe(() => {}, 0, undefined);
		if (result.kind !== "snapshot") throw new Error("expected snapshot");
		expect(texts(result.snapshot.entries)).toEqual(["question", "answer", "better follow-up", "second try"]);
		expect(result.snapshot.status).toMatchObject({ sessionId: "S", sessionName: "Branchy", isStreaming: false });
		expect(stored.info).toMatchObject({ phase: "stored", access: "free", id: "S" });
	});

	test("a session another process keeps writing (held) follows along: appended turns extend the view, a moved leaf replaces it", async () => {
		const path = writeSessionFile(dir, { id: "S", created: at(0), entries: entries().slice(0, 2) });
		const stored = await StoredSession.open({ conversation: conversationOf(path, "S"), access: "held" });
		const seen: SequencedEvent[] = [];
		const { result } = stored.subscribe(events => seen.push(...events), 0, undefined);
		if (result.kind !== "snapshot") throw new Error("expected snapshot");

		await stored.refresh();
		expect(seen).toEqual([]); // nothing changed on disk: nothing published

		appendFileSync(path, `${JSON.stringify(user("u2", "a1", "follow-up", at(3)))}\n`);
		await stored.refresh();
		expect(seen.map(e => e.ev)).toMatchObject([{ k: "entries", entries: [{ id: "u2" }] }]);
		expect(seen[0]!.ev).not.toHaveProperty("reset");

		// the writer rewinds to a1 and goes another way: the appended entry hangs off an older node
		appendFileSync(path, `${JSON.stringify(user("u2b", "a1", "better follow-up", at(5)))}\n`);
		await stored.refresh();
		const last = seen.at(-1)!.ev;
		expect(last).toMatchObject({ k: "entries", reset: true });
		expect(last.k === "entries" && last.entries.map(e => e.id)).toEqual(["u1", "a1", "u2b"]);

		// a client that joins now sees exactly what live subscribers converged on
		const late = stored.subscribe(() => {}, 0, undefined).result;
		expect(late.kind === "snapshot" && late.snapshot.entries.map(e => e.id)).toEqual(["u1", "a1", "u2b"]);
	});

	test("when the conversation moves to a newer file, the same object reloads from it", async () => {
		const first = writeSessionFile(dir, { id: "A", created: at(0), entries: entries().slice(0, 2) });
		const stored = await StoredSession.open({ conversation: conversationOf(first, "A"), access: "free" });
		const seen: SequencedEvent[] = [];
		stored.subscribe(events => seen.push(...events), 0, undefined);
		const second = writeSessionFile(dir, {
			id: "B",
			created: at(60),
			continuationOf: "A",
			parentSession: "A",
			entries: entries().slice(0, 4),
		});
		stored.update(
			{ ...conversationOf(second, "B"), memberIds: ["B", "A"], memberPaths: [second, first], files: 2 },
			"free",
		);
		await stored.refresh();
		const view = stored.subscribe(() => {}, 0, undefined).result;
		expect(view.kind === "snapshot" && view.snapshot.entries.map(e => e.id)).toEqual(["u1", "a1", "u2", "a2"]);
		expect(view.kind === "snapshot" && view.snapshot.status?.sessionFile).toBe(second);
		expect(seen.some(e => e.ev.k === "state")).toBe(true);
	});
});
