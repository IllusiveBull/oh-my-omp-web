/** One end of the daemon <-> gateway link as the protocol code sees it: text frames out, and the transport's state. */
export interface LinkEnd {
	send(text: string): void;
	/** Bytes accepted by `send` that the network has not taken yet (0 for an in-process link). */
	bufferedAmount(): number;
	close(code?: number, reason?: string): void;
	/** Drops the connection without a closing handshake: the peer may be gone without a FIN, so a graceful close never completes. */
	terminate(): void;
}

/** What receives a link's traffic. The transport calls these; `onClose` fires exactly once. */
export interface LinkSink {
	onMessage(text: string): void;
	onClose(): void;
}

/**
 * The gateway's own machine is an environment like any other, but it does not dial itself over a socket: both ends
 * live in this process and frames are handed across in order, asynchronously (like a socket would), so nothing may
 * rely on a reply arriving synchronously.
 */
export class MemoryLinkEnd implements LinkEnd {
	peer!: MemoryLinkEnd;
	sink: LinkSink | null = null;
	#closed = false;

	send(text: string): void {
		if (this.#closed) return;
		const peer = this.peer;
		queueMicrotask(() => {
			if (!peer.#closed) peer.sink?.onMessage(text);
		});
	}

	bufferedAmount(): number {
		return 0;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const peer = this.peer;
		queueMicrotask(() => {
			this.sink?.onClose();
			if (!peer.#closed) {
				peer.#closed = true;
				peer.sink?.onClose();
			}
		});
	}

	terminate(): void {
		this.close();
	}
}

/** A connected pair of in-process link ends; set `sink` on each before use. */
export function memoryLink(): [MemoryLinkEnd, MemoryLinkEnd] {
	const a = new MemoryLinkEnd();
	const b = new MemoryLinkEnd();
	a.peer = b;
	b.peer = a;
	return [a, b];
}
