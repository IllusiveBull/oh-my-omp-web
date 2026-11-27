import { describe, expect, test } from "bun:test";
import type { SubagentTranscript } from "@omp-web/protocol";
import {
	AgentTranscriptPoller,
	type TranscriptPosition,
	type TranscriptRead,
	type TranscriptState,
} from "../src/lib/agent-transcript-poller";
import { userEntry } from "./fixtures";

function setup(running: boolean) {
	const reads: TranscriptPosition[] = [];
	const replies: TranscriptRead[] = [];
	const states: TranscriptState[] = [];
	const state = { running };
	const poller = new AgentTranscriptPoller(
		async position => {
			reads.push(position);
			const at = position.fromByte ?? 0;
			return replies.shift() ?? { ok: true, data: { entries: [], startByte: at, nextByte: at, reset: false } };
		},
		s => states.push(s),
		() => state.running,
		5,
	);
	const reply = (data: Partial<SubagentTranscript>): void => {
		replies.push({ ok: true, data: { entries: [], startByte: 0, nextByte: 0, reset: false, ...data } });
	};
	const ids = () => states.at(-1)!.entries.map(e => e.id);
	return { poller, reads, states, reply, state, replies, ids };
}

describe("AgentTranscriptPoller", () => {
	test("opens on the latest page, then reads on from the returned cursor; entries accumulate", async () => {
		const t = setup(true);
		expect(t.poller.polling).toBe(false);
		t.reply({ entries: [userEntry("1", "a")], startByte: 0, nextByte: 10 });
		t.reply({ entries: [userEntry("2", "b")], startByte: 10, nextByte: 25 });
		await t.poller.poll();
		await t.poller.poll();
		expect(t.reads).toEqual([{}, { fromByte: 10 }]);
		expect(t.ids()).toEqual(["1", "2"]);
		expect(t.states.at(-1)).toMatchObject({ loading: false, earlier: false });
	});

	test("older pages are read before the first entry and prepended, until the file's start", async () => {
		const t = setup(true);
		t.reply({ entries: [userEntry("3", "c")], startByte: 200, nextByte: 300 });
		await t.poller.poll();
		expect(t.states.at(-1)).toMatchObject({ earlier: true });
		t.reply({ entries: [userEntry("2", "b")], startByte: 90, nextByte: 200 });
		t.reply({ entries: [userEntry("1", "a")], startByte: 0, nextByte: 90 });
		await t.poller.loadEarlier();
		await t.poller.loadEarlier();
		expect(t.reads).toEqual([{}, { beforeByte: 200 }, { beforeByte: 90 }]);
		expect(t.ids()).toEqual(["1", "2", "3"]);
		expect(t.states.at(-1)).toMatchObject({ earlier: false, loadingEarlier: false });
		await t.poller.loadEarlier(); // nothing left before the start
		expect(t.reads).toHaveLength(3);
		await t.poller.poll(); // still follows the end
		expect(t.reads.at(-1)).toEqual({ fromByte: 300 });
	});

	test("an older page that arrives after the transcript was replaced is dropped", async () => {
		const states: TranscriptState[] = [];
		const stale = Promise.withResolvers<TranscriptRead>();
		const replies: (TranscriptRead | Promise<TranscriptRead>)[] = [
			{ ok: true, data: { entries: [userEntry("old", "a")], startByte: 100, nextByte: 200, reset: false } },
			stale.promise,
			{ ok: true, data: { entries: [userEntry("new", "x")], startByte: 0, nextByte: 12, reset: true } },
		];
		const poller = new AgentTranscriptPoller(
			async () => replies.shift()!,
			s => states.push(s),
			() => true,
		);
		await poller.poll();
		const earlier = poller.loadEarlier(); // in flight while the file is rewritten
		await poller.poll();
		stale.resolve({
			ok: true,
			data: { entries: [userEntry("stale", "s")], startByte: 0, nextByte: 100, reset: false },
		});
		await earlier;
		expect(states.at(-1)!.entries.map(e => e.id)).toEqual(["new"]);
	});

	test("a reset replaces what was read instead of appending", async () => {
		const t = setup(true);
		t.reply({ entries: [userEntry("1", "a"), userEntry("2", "b")], nextByte: 30 });
		t.reply({ entries: [userEntry("3", "c")], nextByte: 12, reset: true });
		await t.poller.poll();
		await t.poller.poll();
		expect(t.reads).toEqual([{}, { fromByte: 30 }]);
		expect(t.ids()).toEqual(["3"]);
		await t.poller.poll();
		expect(t.reads.at(-1)).toEqual({ fromByte: 12 });
	});

	test("a failed read is reported, keeps what was read, and the next success clears it", async () => {
		const t = setup(true);
		t.reply({ entries: [userEntry("1", "a")], nextByte: 10 });
		t.replies.push({ ok: false, error: "no transcript file" });
		t.reply({ startByte: 10, nextByte: 10 });
		await t.poller.poll();
		await t.poller.poll();
		expect(t.states.at(-1)).toMatchObject({ error: "no transcript file" });
		expect(t.states.at(-1)!.entries).toHaveLength(1);
		await t.poller.poll();
		expect(t.states.at(-1)!.error).toBeNull();
		expect(t.reads).toEqual([{}, { fromByte: 10 }, { fromByte: 10 }]);
	});

	test("a failed first read keeps it loading and retries the latest page", async () => {
		const t = setup(true);
		t.replies.push({ ok: false, error: "not connected" });
		await t.poller.poll();
		expect(t.states.at(-1)).toMatchObject({ loading: true, error: "not connected" });
		await t.poller.poll();
		expect(t.reads).toEqual([{}, {}]);
		expect(t.states.at(-1)).toMatchObject({ loading: false, error: null });
	});

	test("an unchanged poll does not report a new state", async () => {
		const t = setup(true);
		await t.poller.poll();
		const reported = t.states.length;
		await t.poller.poll();
		await t.poller.poll();
		expect(t.states).toHaveLength(reported);
	});

	test("stops after a few unchanged polls once the agent is not running, and resumes on request", async () => {
		const t = setup(false);
		t.poller.resume();
		await Bun.sleep(60);
		expect(t.poller.polling).toBe(false);
		const reads = t.reads.length;
		expect(reads).toBeGreaterThanOrEqual(4);
		expect(reads).toBeLessThan(8);
		t.poller.resume();
		await Bun.sleep(5);
		expect(t.reads.length).toBeGreaterThan(reads);
		t.poller.dispose();
	});

	test("keeps polling while the agent runs, even when nothing changes", async () => {
		const t = setup(true);
		t.poller.resume();
		await Bun.sleep(60);
		expect(t.poller.polling).toBe(true);
		expect(t.reads.length).toBeGreaterThan(5);
		t.poller.dispose();
		expect(t.poller.polling).toBe(false);
	});
});
