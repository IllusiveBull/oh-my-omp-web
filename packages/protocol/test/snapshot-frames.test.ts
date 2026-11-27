import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import {
	SnapshotAssembler,
	emptySessionView,
	isServerMessage,
	snapshotFrames,
	toSnapshot,
	type EnvFrame,
	type SessionSnapshot,
} from "../src";

const entry = (i: number, text: string): SessionEntry => ({
	type: "message",
	id: `e${i}`,
	parentId: i === 0 ? null : `e${i - 1}`,
	timestamp: "2026-01-01T00:00:00Z",
	message: { role: "user", content: [{ type: "text", text }], timestamp: i },
});

function snapshotOf(entries: SessionEntry[]): SessionSnapshot {
	return { ...toSnapshot(emptySessionView), entries, title: "T", working: true };
}

const parse = (frames: Iterable<string>): EnvFrame[] =>
	[...frames].map(f => JSON.parse(f)).filter((f): f is EnvFrame => isServerMessage(f));

describe("snapshot frames", () => {
	test("a large snapshot is split into bounded chunks and reassembles exactly, applied only at the end", () => {
		const entries = Array.from({ length: 200 }, (_, i) => entry(i, "x".repeat(10_000)));
		const snapshot = snapshotOf(entries);
		const raw = [...snapshotFrames("s", "snap-1", 42, "epoch-1", snapshot, 100_000)];
		const frames = parse(raw);

		expect(frames[0]!.t).toBe("snapshot.begin");
		expect(frames.at(-1)!.t).toBe("snapshot.end");
		const chunks = frames.filter(f => f.t === "snapshot.chunk");
		expect(chunks.length).toBeGreaterThan(10);
		// no frame carries the whole session: every frame stays near the chunk size (one entry of slack)
		expect(Math.max(...raw.map(f => f.length))).toBeLessThan(100_000 + 10_500 + 400);
		// the head (everything but entries) travels in `begin`
		expect(frames[0]).toMatchObject({
			seq: 42,
			epoch: "epoch-1",
			entryCount: 200,
			head: { title: "T", working: true },
		});

		const assembler = new SnapshotAssembler();
		const results = frames.map(f => assembler.push(f));
		expect(results.slice(0, -1).every(r => r === null)).toBe(true);
		expect(results.at(-1)).toEqual({ sessionId: "s", seq: 42, epoch: "epoch-1", snapshot });
	});

	test("an entry bigger than the chunk size travels alone; an empty session still gets begin and end", () => {
		const frames = parse(
			snapshotFrames("s", "x", 1, "e", snapshotOf([entry(0, "y".repeat(5000)), entry(1, "z")]), 1000),
		);
		expect(frames.map(f => f.t)).toEqual(["snapshot.begin", "snapshot.chunk", "snapshot.chunk", "snapshot.end"]);
		const empty = parse(snapshotFrames("s", "x", 1, "e", snapshotOf([]), 1000));
		expect(empty.map(f => f.t)).toEqual(["snapshot.begin", "snapshot.end"]);
	});

	test("a new begin discards a half-assembled snapshot; frames of a superseded snapshot are ignored", () => {
		const old = parse(snapshotFrames("s", "old", 1, "e", snapshotOf([entry(0, "a"), entry(1, "b")]), 10));
		const fresh = parse(snapshotFrames("s", "new", 2, "e", snapshotOf([entry(5, "c")]), 10));
		const assembler = new SnapshotAssembler();
		// begin + first chunk of `old`, then `new` starts
		expect(old.slice(0, 2).map(f => assembler.push(f))).toEqual([null, null]);
		const out = fresh.map(f => assembler.push(f)).at(-1);
		expect(out).toMatchObject({ seq: 2, snapshot: { entries: [{ id: "e5" }] } });
		// the leftover tail of `old` arriving late changes nothing
		expect(old.slice(2).map(f => assembler.push(f))).toEqual([null, null]);
	});

	test("a snapshot missing entries is reported incomplete instead of being applied", () => {
		const frames = parse(snapshotFrames("s", "x", 1, "e", snapshotOf([entry(0, "a"), entry(1, "b")]), 10));
		const withoutChunk = frames.filter((f, i) => !(f.t === "snapshot.chunk" && i === 2));
		const assembler = new SnapshotAssembler();
		expect(withoutChunk.map(f => assembler.push(f)).at(-1)).toBe("incomplete");
	});
});
