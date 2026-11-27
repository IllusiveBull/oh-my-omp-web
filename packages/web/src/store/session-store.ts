import {
	applySessionEvent,
	emptySessionView,
	fromSnapshot,
	type ReplicaInfo,
	type SequencedEvent,
	type SessionEvent,
	type SessionSnapshot,
	type SessionView,
} from "@omp-web/protocol";
import { type DraftAttachments, NO_ATTACHMENTS } from "../lib/draft-attachments";

/**
 * One-shot requests from an extension (`set_editor_text`, `open_url`). They are per-client state, not part of the shared
 * view: what to do about them is up to this client's user (see `AttentionBar`).
 */
export type AttentionItem =
	| { id: number; kind: "editor_text"; text: string }
	| { id: number; kind: "open_url"; url: string; launchUrl?: string; instructions?: string };

/** Pending attention items kept per session; the oldest is dropped beyond this. */
const MAX_ATTENTION = 5;

function toAttention(id: number, ev: SessionEvent): AttentionItem | null {
	switch (ev.k) {
		case "editor_text":
			return { id, kind: "editor_text", text: ev.text };
		case "open_url":
			return { id, kind: "open_url", url: ev.url, launchUrl: ev.launchUrl, instructions: ev.instructions };
		default:
			return null;
	}
}

export interface SessionState {
	view: SessionView;
	/** Unsent composer text, local to this client and retained when its view unmounts. */
	draft: string;
	/** What the draft's `[Image #N]` / `[Paste #N]` markers stand for; kept with the draft. */
	attachments: DraftAttachments;
	/** Highest seq applied; sent as `lastSeq` when (re)subscribing. 0 until the first snapshot. */
	lastSeq: number;
	/** Daemon log the seq belongs to (from the snapshot); a different epoch makes the daemon answer with a snapshot. */
	epoch: string | null;
	/** True until the first snapshot arrives. */
	loading: boolean;
	/** Set when the daemon no longer knows the session (restart, closed elsewhere). */
	lost: string | null;
	/**
	 * Set while the session's machine is offline: the replica is kept but nothing can be fetched or sent until the machine
	 * registers again (not an error, unlike `lost`). Cleared when it does.
	 */
	waiting: string | null;
	/**
	 * Set while the session is served from the gateway's copy of the transcript because its machine is offline (read-only,
	 * possibly behind the machine). Cleared when the machine's own snapshot arrives after it reconnected.
	 */
	replica: ReplicaInfo | null;
	/** Undismissed attention items, newest last, each identified by the seq of its event. Cleared by a snapshot. */
	attention: readonly AttentionItem[];
}

/** High-rate events whose publish may wait for the next animation frame; every other event publishes synchronously. */
function isCoalescable(ev: SessionEvent): boolean {
	return ev.k === "agent" && (ev.event.type === "message_update" || ev.event.type === "tool_execution_update");
}

type FrameScheduler = (callback: () => void) => () => void;

const rafScheduler: FrameScheduler = callback => {
	if (typeof requestAnimationFrame === "function") {
		const id = requestAnimationFrame(callback);
		return () => cancelAnimationFrame(id);
	}
	const timer = setTimeout(callback, 16);
	return () => clearTimeout(timer);
};

/**
 * Client-side replica of one session, folded from the daemon's snapshot + sequenced events with the same reducer the
 * daemon uses. Exposes a `useSyncExternalStore`-compatible subscribe/getSnapshot pair; the snapshot object changes
 * identity per publish. Streaming updates are applied immediately but published at most once per frame.
 */
export class SessionStore {
	#state: SessionState = {
		view: emptySessionView,
		draft: "",
		attachments: NO_ATTACHMENTS,
		lastSeq: 0,
		epoch: null,
		loading: true,
		lost: null,
		waiting: null,
		replica: null,
		attention: [],
	};
	#published: SessionState = this.#state;
	#listeners = new Set<() => void>();
	#cancelFrame: (() => void) | null = null;

	constructor(
		readonly id: string,
		private readonly schedule: FrameScheduler = rafScheduler,
		private readonly now: () => number = Date.now,
	) {}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): SessionState => this.#published;

	setDraft = (draft: string, attachments: DraftAttachments = this.#state.attachments): void => {
		if (this.#state.draft === draft && this.#state.attachments === attachments) return;
		this.#state = { ...this.#state, draft, attachments };
		this.#publish();
	};

	/** Current applied state, including changes not yet published (tests, resubscribe). */
	get lastSeq(): number {
		return this.#state.lastSeq;
	}

	get epoch(): string | null {
		return this.#state.epoch;
	}

	applySnapshot(seq: number, epoch: string, snapshot: SessionSnapshot): void {
		this.#state = {
			view: fromSnapshot(snapshot),
			draft: this.#state.draft,
			attachments: this.#state.attachments,
			lastSeq: seq,
			epoch,
			loading: false,
			lost: null,
			// A copy served by the gateway is a snapshot too, but its machine is still unreachable.
			waiting: this.#state.replica === null ? null : this.#state.waiting,
			replica: this.#state.replica,
			attention: [],
		};
		this.#publish();
	}

	applyEvents(events: readonly SequencedEvent[]): void {
		let view = this.#state.view;
		let attention = this.#state.attention;
		let lastSeq = this.#state.lastSeq;
		let urgent = false;
		let applied = false;
		for (const { seq, ev } of events) {
			if (seq <= lastSeq) continue; // duplicate from a replay overlapping live delivery
			view = applySessionEvent(view, ev, this.now());
			const item = toAttention(seq, ev);
			if (item) attention = [...attention, item].slice(-MAX_ATTENTION);
			lastSeq = seq;
			applied = true;
			if (!isCoalescable(ev)) urgent = true;
		}
		if (!applied) return;
		this.#state = { ...this.#state, view, attention, lastSeq, loading: false };
		if (urgent) this.#publish();
		else this.#scheduleFrame();
	}

	dismissAttention(id: number): void {
		if (!this.#state.attention.some(item => item.id === id)) return;
		this.#state = { ...this.#state, attention: this.#state.attention.filter(item => item.id !== id) };
		this.#publish();
	}

	markLost(reason: string): void {
		this.#state = { ...this.#state, loading: false, lost: reason };
		this.#publish();
	}

	/** The machine hosting the session is (un)reachable; `null` clears it. */
	setWaiting(reason: string | null): void {
		if (this.#state.waiting === reason) return;
		this.#state = { ...this.#state, waiting: reason };
		this.#publish();
	}

	/** The session is (`info`) or is no longer (`null`) served from the gateway's copy. */
	setReplica(info: ReplicaInfo | null): void {
		if (this.#state.replica === info) return;
		this.#state = { ...this.#state, replica: info };
		this.#publish();
	}

	/** Forces the next subscribe to request a full snapshot (the daemon sent one that could not be assembled). */
	resetSeq(): void {
		this.#state = { ...this.#state, lastSeq: 0, epoch: null };
	}

	#scheduleFrame(): void {
		if (this.#cancelFrame) return;
		this.#cancelFrame = this.schedule(() => {
			this.#cancelFrame = null;
			this.#publish();
		});
	}

	#publish(): void {
		if (this.#cancelFrame) {
			this.#cancelFrame();
			this.#cancelFrame = null;
		}
		this.#published = this.#state;
		for (const listener of this.#listeners) listener();
	}
}
