import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@omp-web/protocol";
import { EventLog } from "../src/event-log";

const update = (n: number): SessionEvent => ({
	k: "agent",
	event: {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "x".repeat(n) }] },
	} as never,
});
const end = (): SessionEvent => ({
	k: "agent",
	event: { type: "message_end", message: { role: "assistant", content: [] } } as never,
});
const notify = (m: string): SessionEvent => ({ k: "notify", level: "info", message: m });

describe("EventLog", () => {
	test("assigns strictly increasing seq and replays only newer events", () => {
		const log = new EventLog({ maxEvents: 100, maxBytes: 1e6 });
		const seqs = [notify("a"), notify("b"), notify("c")].map(e => log.append(e, 10).seq);
		expect(seqs).toEqual([1, 2, 3]);
		expect(log.since(1)?.map(e => e.seq)).toEqual([2, 3]);
		expect(log.since(3)).toEqual([]);
		expect(log.since(4)).toBeNull(); // client claims to be ahead of the daemon (daemon restarted): must resync
	});

	test("keeps only the latest message_update of the in-flight message", () => {
		const log = new EventLog({ maxEvents: 100, maxBytes: 1e6 });
		log.append(notify("before"), 1);
		for (let i = 1; i <= 50; i++) log.append(update(i), 100);
		const kept = log.since(0)!;
		expect(kept.filter(e => e.ev.k === "agent")).toHaveLength(1);
		const only = kept.find(e => e.ev.k === "agent")!;
		expect(JSON.stringify(only.ev)).toContain("x".repeat(50));
		expect(only.seq).toBe(51); // gaps are legal: superseded snapshots vanish, seq does not rewind
		expect(log.bytes).toBe(1 + 100);
	});

	test("message_end drops the pending update; the next message starts a fresh one", () => {
		const log = new EventLog({ maxEvents: 100, maxBytes: 1e6 });
		log.append(update(1), 5);
		log.append(update(2), 5);
		log.append(end(), 5);
		expect(log.since(0)!.map(e => (e.ev.k === "agent" ? e.ev.event.type : e.ev.k))).toEqual(["message_end"]);
		log.append(update(3), 5);
		log.append(update(4), 5);
		expect(log.since(0)!.filter(e => e.ev.k === "agent" && e.ev.event.type === "message_update")).toHaveLength(1);
	});

	test("a client whose lastSeq was a superseded update still replays everything newer", () => {
		const log = new EventLog({ maxEvents: 100, maxBytes: 1e6 });
		const first = log.append(update(1), 5).seq;
		log.append(update(2), 5);
		log.append(notify("n"), 5);
		const replay = log.since(first)!;
		expect(replay.map(e => e.ev.k)).toEqual(["agent", "notify"]);
	});

	test("count and byte caps evict oldest events; replay below the evicted point is refused", () => {
		const byCount = new EventLog({ maxEvents: 3, maxBytes: 1e6 });
		for (let i = 0; i < 6; i++) byCount.append(notify(String(i)), 1);
		expect(byCount.size).toBe(3);
		expect(byCount.since(3)?.map(e => e.seq)).toEqual([4, 5, 6]);
		expect(byCount.since(2)).toBeNull(); // seq 3 was evicted: gap
		const byBytes = new EventLog({ maxEvents: 100, maxBytes: 25 });
		for (let i = 0; i < 5; i++) byBytes.append(notify(String(i)), 10);
		expect(byBytes.bytes).toBeLessThanOrEqual(25);
		expect(byBytes.since(0)).toBeNull();
		expect(byBytes.since(byBytes.headSeq - 1)).toHaveLength(1);
	});

	test("never evicts the newest event even if it alone exceeds the byte cap", () => {
		const log = new EventLog({ maxEvents: 10, maxBytes: 5 });
		log.append(notify("huge"), 1000);
		expect(log.size).toBe(1);
	});
});
