import type { SequencedEvent, SessionEvent } from "@omp-web/protocol";

export interface EventLogOptions {
	/** Retained events cap (oldest evicted first). */
	maxEvents: number;
	/** Retained payload bytes cap (oldest evicted first). */
	maxBytes: number;
}

/**
 * Per-session event log with a monotonically increasing `seq`.
 *
 * Streaming `message_update`s each carry the full accumulating message, so only the latest snapshot of the
 * in-flight message is retained: appending a newer update drops the previous one, and `message_end`
 * (authoritative, full message) drops the pending update. A `btw` event carries a side-question topic in full, so it
 * likewise drops the previous `btw` event of the same topic. Dropped events leave gaps in `seq`, which is legal.
 *
 * Replay is gap-free within the retained window: `since(lastSeq)` returns everything after `lastSeq`, or `null`
 * when events newer than `lastSeq` were evicted (the caller must send a snapshot instead).
 */
export class EventLog {
	#events: { event: SequencedEvent; bytes: number }[] = [];
	#bytes = 0;
	#head = 0;
	/** Highest seq ever evicted by the caps; replay from below it is impossible. */
	#evictedThrough = 0;
	#pendingUpdateSeq: number | null = null;
	/** Seq of the retained `btw` event of each side-question topic. */
	#btwSeq = new Map<string, number>();
	/** Identifies this log; `seq` is only comparable within one epoch (a new log starts at 1 again, e.g. after a daemon restart). */
	readonly epoch: string = crypto.randomUUID();

	constructor(private readonly options: EventLogOptions) {}

	get headSeq(): number {
		return this.#head;
	}

	get size(): number {
		return this.#events.length;
	}

	get bytes(): number {
		return this.#bytes;
	}

	/** Appends one event; `bytes` is its serialized size (cap accounting only). Returns the sequenced event. */
	append(ev: SessionEvent, bytes: number): SequencedEvent {
		if (ev.k === "agent") {
			const type = ev.event.type;
			if (type === "message_update" || type === "message_end") this.#dropPendingUpdate();
		}
		if (ev.k === "btw") {
			const previous = this.#btwSeq.get(ev.record.id);
			if (previous !== undefined) this.#drop(previous);
		}
		const event: SequencedEvent = { seq: ++this.#head, ev };
		this.#events.push({ event, bytes });
		this.#bytes += bytes;
		if (ev.k === "agent" && ev.event.type === "message_update") this.#pendingUpdateSeq = event.seq;
		if (ev.k === "btw") this.#btwSeq.set(ev.record.id, event.seq);
		this.#evict();
		return event;
	}

	/** Events with `seq > lastSeq`, or `null` if some of them were evicted. */
	since(lastSeq: number): SequencedEvent[] | null {
		if (lastSeq > this.#head || lastSeq < this.#evictedThrough) return null;
		// Binary search: events are in ascending seq order.
		let lo = 0;
		let hi = this.#events.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.#events[mid]!.event.seq <= lastSeq) lo = mid + 1;
			else hi = mid;
		}
		return this.#events.slice(lo).map(e => e.event);
	}

	#dropPendingUpdate(): void {
		const seq = this.#pendingUpdateSeq;
		if (seq === null) return;
		this.#pendingUpdateSeq = null;
		this.#drop(seq);
	}

	/** Removes the retained event `seq`, if it was not evicted already (searched from the tail, where superseded events usually are). */
	#drop(seq: number): void {
		for (let i = this.#events.length - 1; i >= 0; i--) {
			const entry = this.#events[i]!;
			if (entry.event.seq === seq) {
				this.#events.splice(i, 1);
				this.#bytes -= entry.bytes;
				return;
			}
			if (entry.event.seq < seq) return;
		}
	}

	#evict(): void {
		let drop = 0;
		while (
			this.#events.length - drop > 1 &&
			(this.#events.length - drop > this.options.maxEvents || this.#bytes > this.options.maxBytes)
		) {
			const entry = this.#events[drop]!;
			this.#bytes -= entry.bytes;
			this.#evictedThrough = entry.event.seq;
			drop++;
		}
		if (drop > 0) this.#events.splice(0, drop);
	}
}
