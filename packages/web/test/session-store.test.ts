import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-wire";
import type { SequencedEvent, SessionEvent } from "@omp-web/protocol";
import { SessionStore } from "../src/store/session-store";
import { emptySnapshot } from "./fixtures";

const msg = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	stopReason: "stop",
	timestamp: 1,
});
const update = (seq: number, text: string): SequencedEvent => ({
	seq,
	ev: { k: "agent", event: { type: "message_update", message: msg(text) } },
});
const other = (seq: number, ev: SessionEvent): SequencedEvent => ({ seq, ev });

function harness() {
	const frames: (() => void)[] = [];
	const store = new SessionStore(
		"s",
		cb => {
			frames.push(cb);
			return () => {
				frames.splice(frames.indexOf(cb), 1);
			};
		},
		() => 0,
	);
	let publishes = 0;
	store.subscribe(() => publishes++);
	return { store, frames, publishes: () => publishes, flush: () => frames.splice(0).forEach(f => f()) };
}

describe("SessionStore publishing", () => {
	test("streaming updates apply immediately but publish once per frame", () => {
		const h = harness();
		h.store.applySnapshot(0, "epoch-1", emptySnapshot({ working: true }));
		const before = h.publishes();
		for (let i = 1; i <= 50; i++) h.store.applyEvents([update(i, `t${i}`)]);
		expect(h.publishes()).toBe(before); // nothing published yet
		expect(h.store.lastSeq).toBe(50); // but applied
		expect(h.store.getSnapshot().view.stream).toBeNull(); // published state is still the old one
		h.flush();
		expect(h.publishes()).toBe(before + 1);
		expect(JSON.stringify(h.store.getSnapshot().view.stream)).toContain("t50");
	});

	test("any non-streaming event publishes synchronously and carries pending streaming state with it", () => {
		const h = harness();
		h.store.applyEvents([update(1, "partial")]);
		h.store.applyEvents([other(2, { k: "notify", level: "info", message: "hi" })]);
		const snap = h.store.getSnapshot();
		expect(JSON.stringify(snap.view.stream)).toContain("partial");
		expect(snap.view.notices).toHaveLength(1);
		expect(h.frames).toHaveLength(0); // the pending frame was cancelled by the synchronous publish
	});

	test("events at or below lastSeq are ignored (replay overlapping live delivery)", () => {
		const h = harness();
		h.store.applyEvents([
			other(1, { k: "notify", level: "info", message: "a" }),
			other(2, { k: "notify", level: "info", message: "b" }),
		]);
		h.store.applyEvents([
			other(2, { k: "notify", level: "info", message: "b" }),
			other(3, { k: "notify", level: "info", message: "c" }),
		]);
		expect(h.store.getSnapshot().view.notices.map(n => n.message)).toEqual(["a", "b", "c"]);
		expect(h.store.lastSeq).toBe(3);
	});
});

describe("SessionStore attention", () => {
	const editorText = (seq: number, text: string) => other(seq, { k: "editor_text", text });

	test("editor_text and open_url become per-client attention items and never enter the view", () => {
		const h = harness();
		const before = h.store.getSnapshot().view;
		h.store.applyEvents([
			editorText(1, "draft from an extension"),
			other(2, {
				k: "open_url",
				url: "https://example.com/auth",
				launchUrl: "https://example.com/launch",
				instructions: "sign in",
			}),
		]);
		const state = h.store.getSnapshot();
		expect(state.attention).toEqual([
			{ id: 1, kind: "editor_text", text: "draft from an extension" },
			{
				id: 2,
				kind: "open_url",
				url: "https://example.com/auth",
				launchUrl: "https://example.com/launch",
				instructions: "sign in",
			},
		]);
		expect(state.view).toEqual(before);
		expect(h.store.lastSeq).toBe(2);
	});

	test("keeps only the five newest items", () => {
		const h = harness();
		h.store.applyEvents([1, 2, 3, 4, 5, 6, 7].map(seq => editorText(seq, `t${seq}`)));
		expect(h.store.getSnapshot().attention.map(item => item.id)).toEqual([3, 4, 5, 6, 7]);
	});

	test("dismissing removes one item and publishes", () => {
		const h = harness();
		h.store.applyEvents([editorText(1, "a"), editorText(2, "b")]);
		const published = h.publishes();
		h.store.dismissAttention(1);
		expect(h.store.getSnapshot().attention.map(item => item.id)).toEqual([2]);
		expect(h.publishes()).toBe(published + 1);
		h.store.dismissAttention(99); // unknown id: nothing changes
		expect(h.publishes()).toBe(published + 1);
	});

	test("a snapshot clears them", () => {
		const h = harness();
		h.store.applyEvents([editorText(1, "a")]);
		h.store.applySnapshot(5, "epoch-1", emptySnapshot());
		expect(h.store.getSnapshot().attention).toEqual([]);
	});

	test("a replayed duplicate seq does not duplicate an item, nor bring back a dismissed one", () => {
		const h = harness();
		h.store.applyEvents([editorText(1, "a")]);
		h.store.applyEvents([editorText(1, "a")]);
		expect(h.store.getSnapshot().attention).toHaveLength(1);
		h.store.dismissAttention(1);
		h.store.applyEvents([editorText(1, "a")]);
		expect(h.store.getSnapshot().attention).toEqual([]);
	});
});

describe("SessionStore replica marker", () => {
	const copy = { state: "partial", asOf: 10, syncedAt: 20 } as const;

	test("starts without one, and setting or clearing it publishes", () => {
		const h = harness();
		expect(h.store.getSnapshot().replica).toBeNull();
		h.store.setReplica(copy);
		expect(h.store.getSnapshot().replica).toEqual(copy);
		expect(h.publishes()).toBe(1);
		h.store.setReplica(null);
		expect(h.store.getSnapshot().replica).toBeNull();
		h.store.setReplica(null); // nothing changed: nothing published
		expect(h.publishes()).toBe(2);
	});

	test("a snapshot served from a copy keeps the marker and the wait for the machine; a live one ends both", () => {
		const h = harness();
		h.store.setWaiting("machine offline");
		h.store.setReplica(copy);
		h.store.applySnapshot(5, "e", emptySnapshot({ entries: [] }));
		expect(h.store.getSnapshot()).toMatchObject({
			replica: copy,
			waiting: "machine offline",
			loading: false,
			lastSeq: 5,
		});

		h.store.setReplica(null);
		h.store.applySnapshot(9, "live", emptySnapshot());
		expect(h.store.getSnapshot()).toMatchObject({ replica: null, waiting: null, lastSeq: 9 });
	});
});
