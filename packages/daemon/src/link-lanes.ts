import type { LinkEnd } from "./link-end";

/** Bulk frames wait for the socket's own buffer to fall to this before they are written. */
export const BULK_HIGH_WATER_BYTES = 64 * 1024;
const POLL_MS = 2;

/**
 * The daemon's side of the link with two lanes. Everything the daemon sends is **bulk** (`send`: session snapshots and
 * events, the session and project lists, replica chunks, and whatever the other features add) except frames a person is
 * waiting on key by key (`sendPriority`: terminal output, acks and errors).
 *
 * A WebSocket is one ordered byte stream, so a frame cannot overtake bytes already handed to the socket. What can be
 * bounded is how many such bytes there are: a bulk frame is only handed to the socket while the socket's own buffer is at
 * or below {@link BULK_HIGH_WATER_BYTES}; otherwise it waits here, in order. A priority frame is written at once. So a
 * keystroke's echo waits behind at most the bulk bytes already in flight (<= 64 KiB plus the one frame that crossed
 * the line), not behind a replica upload, a large snapshot or a file read that is still queued. Waiting bulk bytes count in
 * `bufferedAmount()`, so the flow control the bulk senders already have (the Outbox's high-water mark, the replica
 * uploader's pause) sees the queue and keeps it small.
 *
 * Priority frames do not go through the queue, so order *between* the lanes is not preserved, and nothing in the
 * protocol depends on it: terminal frames only relate to other terminal frames.
 */
export class LaneLink implements LinkEnd {
	readonly #queue: string[] = [];
	#queued = 0;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#closed = false;

	constructor(
		private readonly inner: LinkEnd,
		private readonly highWater = BULK_HIGH_WATER_BYTES,
	) {}

	/** Bulk lane. */
	send(text: string): void {
		if (this.#closed) return;
		if (this.#queue.length === 0 && this.inner.bufferedAmount() <= this.highWater) {
			this.inner.send(text);
			return;
		}
		this.#queue.push(text);
		this.#queued += text.length;
		this.#schedule();
	}

	/** Priority lane: written immediately, ahead of every waiting bulk frame. */
	sendPriority(text: string): void {
		if (!this.#closed) this.inner.send(text);
	}

	bufferedAmount(): number {
		return this.inner.bufferedAmount() + this.#queued;
	}

	/** Bulk bytes waiting for the socket (for tests and diagnostics). */
	get queuedBytes(): number {
		return this.#queued;
	}

	close(code?: number, reason?: string): void {
		this.dispose();
		this.inner.close(code, reason);
	}

	terminate(): void {
		this.dispose();
		this.inner.terminate();
	}

	/** The link is gone: drop what waits. */
	dispose(): void {
		this.#closed = true;
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
		this.#queue.length = 0;
		this.#queued = 0;
	}

	#schedule(): void {
		this.#timer ??= setTimeout(() => {
			this.#timer = null;
			this.#drain();
		}, POLL_MS);
	}

	/** A WebSocket client has no `drain` event, so the queue polls the socket's buffer while it holds anything. */
	#drain(): void {
		if (this.#closed) return;
		while (this.#queue.length > 0 && this.inner.bufferedAmount() <= this.highWater) {
			const text = this.#queue.shift()!;
			this.#queued -= text.length;
			this.inner.send(text);
		}
		if (this.#queue.length > 0) this.#schedule();
	}
}
