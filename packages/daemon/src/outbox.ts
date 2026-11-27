/**
 * Per-client outbound queue with a memory bound.
 *
 * A browser that stops reading (suspended tab, dead network the OS has not noticed) must not make the daemon buffer
 * without limit. Everything a client is sent goes through here, and the policy is, in this order:
 *
 * 1. While the socket's own buffer is below `highWater`, frames are written straight away.
 * 2. Above it, frames queue here. Frames that a later frame supersedes (`coalesce`: streaming snapshots of one
 *    session, the session list) keep only the newest; this is what is dropped first.
 * 3. Snapshots are queued as lazy frame iterators and serialized only when the socket can take them, so a large
 *    snapshot is neither one frame nor a pile of strings held for a client that is not reading.
 * 4. When the queued event frames exceed `queueCap`, they are discarded and the sessions they belonged to are marked
 *    stale: once the queue has drained, `onResync` asks the owner to send each of them a fresh snapshot (the client
 *    ends up consistent, and the memory held for it never exceeded the cap).
 * 5. If the socket's own buffer still grows past `hardLimit` (or small control frames pile up past `queueCap`), the
 *    client is closed; it reconnects and resubscribes.
 */

/** The part of Bun's `ServerWebSocket` the outbox needs. */
export interface OutboxSocket {
	/** Bytes sent; -1 when the frame was queued behind backpressure; 0 when the connection dropped it. */
	send(data: string): number;
	getBufferedAmount(): number;
	close(code?: number, reason?: string): void;
}

export interface OutboxLimits {
	/** Socket buffer size (bytes) above which frames queue here instead of being written. */
	highWater: number;
	/** Bytes of queued event frames after which the queue is dropped in favour of resync snapshots. */
	queueCap: number;
	/** Socket buffer size at which the client is closed. */
	hardLimit: number;
}

export const DEFAULT_OUTBOX_LIMITS: OutboxLimits = {
	highWater: 1024 * 1024,
	queueCap: 8 * 1024 * 1024,
	hardLimit: 32 * 1024 * 1024,
};

type Item =
	| { kind: "control"; frame: string; bytes: number }
	| { kind: "event"; sessionId: string; frame: string; bytes: number }
	| { kind: "coalesced"; key: string; sessionId?: string; frame: string; bytes: number; dead: boolean }
	| { kind: "snapshot"; sessionId: string; frames: Iterator<string> };

export class Outbox {
	#queue: Item[] = [];
	#queuedBytes = 0;
	#controlBytes = 0;
	readonly #latest = new Map<string, Extract<Item, { kind: "coalesced" }>>();
	readonly #stale = new Set<string>();
	#closed = false;

	constructor(
		private readonly socket: OutboxSocket,
		private readonly onResync: (sessionIds: string[]) => void,
		private readonly limits: OutboxLimits = DEFAULT_OUTBOX_LIMITS,
	) {}

	/** Bytes of event frames waiting (what `queueCap` bounds). */
	get queuedBytes(): number {
		return this.#queuedBytes;
	}

	/** Bytes of control frames (replies) waiting for the socket; what the per-client reply cap looks at. */
	get controlBacklog(): number {
		return this.#controlBytes;
	}

	get staleSessions(): readonly string[] {
		return [...this.#stale];
	}

	/** Replies and other small frames that must not be lost. */
	control(frame: string): void {
		if (this.#closed) return;
		if (this.#queue.length === 0 && this.#writable()) return this.#write(frame);
		this.#controlBytes += frame.length;
		if (this.#controlBytes > this.limits.queueCap) return this.#close("client is not reading");
		this.#queue.push({ kind: "control", frame, bytes: frame.length });
	}

	/** An event frame of `sessionId`; dropped, with a resync later, if the client falls too far behind. */
	event(sessionId: string, frame: string): void {
		if (this.#closed || this.#stale.has(sessionId)) return;
		if (this.#queue.length === 0 && this.#writable()) return this.#write(frame);
		this.#enqueueEvent({ kind: "event", sessionId, frame, bytes: frame.length });
	}

	/**
	 * A frame that supersedes the previous one with the same `key` (streaming snapshots, the session list): while
	 * the client is backed up only the newest is kept. `sessionId` ties it to a session for resync purposes.
	 */
	coalesced(key: string, frame: string, sessionId?: string): void {
		if (this.#closed || (sessionId !== undefined && this.#stale.has(sessionId))) return;
		if (this.#queue.length === 0 && this.#writable()) return this.#write(frame);
		const previous = this.#latest.get(key);
		if (previous) {
			previous.dead = true;
			this.#queuedBytes -= previous.bytes;
		}
		const item = { kind: "coalesced" as const, key, sessionId, frame, bytes: frame.length, dead: false };
		this.#latest.set(key, item);
		this.#enqueueEvent(item);
	}

	/** Queues a fresh snapshot of `sessionId`; everything older queued for it is obsolete. */
	snapshot(sessionId: string, frames: Iterator<string>): void {
		if (this.#closed) return;
		this.forget(sessionId);
		this.#queue.push({ kind: "snapshot", sessionId, frames });
		this.pump();
	}

	/** Drops everything queued for `sessionId` (unsubscribed, or about to be replaced by a snapshot). */
	forget(sessionId: string): void {
		this.#stale.delete(sessionId);
		this.#queue = this.#queue.filter(item => {
			if (item.kind === "control" || (item.kind === "coalesced" && item.sessionId === undefined)) return true;
			if (item.sessionId !== sessionId) return true;
			if (item.kind === "event" || item.kind === "coalesced") this.#queuedBytes -= item.bytes;
			if (item.kind === "coalesced") this.#latest.delete(item.key);
			return false;
		});
	}

	/** Writes queued frames while the socket can take them; call it from the websocket `drain` callback. */
	pump(): void {
		while (!this.#closed && this.#queue.length > 0) {
			if (!this.#writable()) return;
			const item = this.#queue[0]!;
			if (item.kind === "snapshot") {
				const next = item.frames.next();
				if (next.done) this.#queue.shift();
				else this.#write(next.value);
				continue;
			}
			this.#queue.shift();
			if (item.kind === "control") this.#controlBytes -= item.bytes;
			else if (item.kind === "event") this.#queuedBytes -= item.bytes;
			else {
				if (item.dead) continue;
				this.#queuedBytes -= item.bytes;
				if (this.#latest.get(item.key) === item) this.#latest.delete(item.key);
			}
			this.#write(item.frame);
		}
		if (!this.#closed && this.#queue.length === 0 && this.#stale.size > 0) {
			const sessions = [...this.#stale];
			this.#stale.clear();
			this.onResync(sessions);
		}
	}

	#writable(): boolean {
		return this.socket.getBufferedAmount() <= this.limits.highWater;
	}

	#write(frame: string): void {
		if (this.socket.send(frame) === 0) return this.#close("connection dropped a frame");
		if (this.socket.getBufferedAmount() > this.limits.hardLimit) this.#close("client is not reading");
	}

	#enqueueEvent(item: Extract<Item, { kind: "event" | "coalesced" }>): void {
		this.#queue.push(item);
		this.#queuedBytes += item.bytes;
		if (this.#queuedBytes > this.limits.queueCap) this.#cutOver();
	}

	/** Discards queued event frames and snapshots; their sessions get a fresh snapshot once the queue is empty. */
	#cutOver(): void {
		const kept: Item[] = [];
		for (const item of this.#queue) {
			if (item.kind === "coalesced" && item.dead) continue;
			if (item.kind === "control" || (item.kind === "coalesced" && item.sessionId === undefined)) {
				kept.push(item);
				continue;
			}
			this.#stale.add(item.sessionId!);
		}
		this.#queue = kept;
		this.#queuedBytes = kept.reduce((sum, item) => sum + (item.kind === "coalesced" ? item.bytes : 0), 0);
		for (const [key, item] of this.#latest) if (item.sessionId !== undefined) this.#latest.delete(key);
	}

	#close(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#queue = [];
		this.#latest.clear();
		this.#queuedBytes = 0;
		this.socket.close(1013, reason);
	}
}
