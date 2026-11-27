import {
	applySessionEvent,
	emptySessionView,
	toSnapshot,
	type SequencedEvent,
	type SessionEvent,
	type SessionInfo,
	type SessionSnapshot,
	type SessionView,
} from "@omp-web/protocol";
import { EventLog, type EventLogOptions } from "./event-log";

export type SubscribeResult =
	| { kind: "snapshot"; seq: number; epoch: string; snapshot: SessionSnapshot }
	| { kind: "replay"; events: SequencedEvent[] };

export type SessionListener = (events: SequencedEvent[]) => void;

/** What the websocket server needs from any session a client can look at: a hosted one or one read from disk. */
export interface SessionHandle {
	readonly id: string;
	readonly info: SessionInfo;
	subscribe(
		listener: SessionListener,
		lastSeq: number,
		epoch: string | undefined,
	): { result: SubscribeResult; unsubscribe: () => void };
}

export const DEFAULT_LOG: EventLogOptions = { maxEvents: 5_000, maxBytes: 32 * 1024 * 1024 };

/**
 * The event log, the folded view and the subscriber set of one session. Every change goes through {@link emit}, so
 * log, view and subscribers cannot diverge. Shared by hosted sessions (events come from an omp process) and stored
 * sessions (events come from re-reading the file).
 */
export class ViewChannel {
	readonly #log: EventLog;
	readonly #now: () => number;
	readonly #afterApply: (() => void) | undefined;
	readonly #listeners = new Set<SessionListener>();
	#view: SessionView = emptySessionView;

	constructor(options: { log?: EventLogOptions; now: () => number; afterApply?: () => void }) {
		this.#log = new EventLog(options.log ?? DEFAULT_LOG);
		this.#now = options.now;
		this.#afterApply = options.afterApply;
	}

	get view(): SessionView {
		return this.#view;
	}

	get epoch(): string {
		return this.#log.epoch;
	}

	get headSeq(): number {
		return this.#log.headSeq;
	}

	get listenerCount(): number {
		return this.#listeners.size;
	}

	/** Replaces the view without logging: subscribers get it through a snapshot (initial load only). */
	seed(view: SessionView): void {
		this.#view = view;
	}

	/** Retained log events with `seq > lastSeq`, or null when some were evicted. */
	eventsAfter(lastSeq: number): SequencedEvent[] | null {
		return this.#log.since(lastSeq);
	}

	/** Folds into the view, appends to the log, fans out. */
	emit(ev: SessionEvent, bytes = 256): void {
		this.#view = applySessionEvent(this.#view, ev, this.#now());
		const sequenced = this.#log.append(ev, bytes);
		this.#afterApply?.();
		for (const listener of this.#listeners) listener([sequenced]);
	}

	/** Returns what the client needs to reach the current state; live events follow through `listener`. */
	subscribe(
		listener: SessionListener,
		lastSeq: number,
		epoch: string | undefined,
	): { result: SubscribeResult; unsubscribe: () => void } {
		const replay = lastSeq > 0 && epoch === this.#log.epoch ? this.#log.since(lastSeq) : null;
		// Synchronous from here to the listener registration: no event can fall between result and live stream.
		const result: SubscribeResult = replay
			? { kind: "replay", events: replay }
			: { kind: "snapshot", seq: this.#log.headSeq, epoch: this.#log.epoch, snapshot: toSnapshot(this.#view) };
		this.#listeners.add(listener);
		return { result, unsubscribe: () => this.#listeners.delete(listener) };
	}
}
