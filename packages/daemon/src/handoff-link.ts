/**
 * The gateway's side of the handoff traffic with one environment daemon: named operations (`op` → `op.result`) and the
 * binary transfers (`xfer.*`), plus the pump that moves a file from one daemon to another through the gateway.
 *
 * Memory: a transfer never lands on the gateway's disk or in one buffer. The pump keeps at most {@link XFER_WINDOW} chunks of
 * {@link XFER_CHUNK_BYTES} between the two daemons (requested from the source, not yet acknowledged by the target), and only
 * hands the target a chunk while the target's link has little unsent data (`BULK_HIGH_WATER_BYTES`), so a keystroke frame
 * for the same machine waits behind at most that backlog plus one chunk, exactly like the daemon-side bulk lane.
 */
import {
	XFER_CHUNK_BYTES,
	XFER_WINDOW,
	type EnvLinkMessage,
	type GatewayLinkMessage,
	type HandoffOpArgs,
	type HandoffOpName,
	type HandoffOpResult,
	type XferInfo,
} from "@omp-web/protocol";
import { BULK_HIGH_WATER_BYTES } from "./link-lanes";

/**
 * A call that did not give a result. `kind`: `refused` (the daemon declined; nothing changed), `failed` (it broke; things may
 * have been created), `link` (the daemon's link went away or timed out: whatever it was doing is unknown).
 */
export class HandoffCallError extends Error {
	constructor(
		message: string,
		readonly kind: "refused" | "failed" | "link",
	) {
		super(message);
		this.name = "HandoffCallError";
	}
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const CHUNK_TIMEOUT_MS = 60_000;
const GATE_POLL_MS = 2;

interface Pending<T> {
	resolve(value: T): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/** What the gateway can do with one daemon's link for handoffs. */
export class PeerRpc {
	readonly #calls = new Map<string, Pending<unknown>>();
	/** Reads and writes in flight, keyed `<xfer>@<offset>`. */
	readonly #reads = new Map<string, Pending<{ data: string; eof: boolean }>>();
	readonly #writes = new Map<string, Pending<void>>();
	#seq = 0;
	#closed: string | null = null;

	constructor(
		private readonly send: (message: GatewayLinkMessage) => void,
		private readonly bufferedAmount: () => number,
		private readonly name: () => string,
	) {}

	get closed(): boolean {
		return this.#closed !== null;
	}

	/** Runs `op` on the daemon. Rejects with a {@link HandoffCallError}. */
	call<K extends HandoffOpName>(
		op: K,
		args: HandoffOpArgs[K],
		timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
	): Promise<HandoffOpResult[K]> {
		if (this.#closed) return Promise.reject(new HandoffCallError(this.#closed, "link"));
		const id = `c${++this.#seq}`;
		return new Promise<HandoffOpResult[K]>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#calls.delete(id);
				reject(new HandoffCallError(`${this.name()} did not answer ${op} in time`, "link"));
			}, timeoutMs);
			this.#calls.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			this.send({ t: "op", id, op, args });
		});
	}

	/** One daemon frame about a call or a transfer. */
	receive(message: EnvLinkMessage): void {
		switch (message.t) {
			case "op.result": {
				const pending = this.#calls.get(message.id);
				if (!pending) return;
				this.#calls.delete(message.id);
				clearTimeout(pending.timer);
				if (message.ok) pending.resolve(message.data);
				else pending.reject(new HandoffCallError(message.error.message, message.error.kind));
				return;
			}
			case "xfer.data": {
				const key = `${message.xfer}@${message.offset}`;
				const pending = this.#reads.get(key);
				if (!pending) return;
				this.#reads.delete(key);
				clearTimeout(pending.timer);
				pending.resolve({ data: message.data, eof: message.eof });
				return;
			}
			case "xfer.ack": {
				const key = `${message.xfer}@${message.offset}`;
				const pending = this.#writes.get(key);
				if (!pending) return;
				this.#writes.delete(key);
				clearTimeout(pending.timer);
				if (message.ok) pending.resolve();
				else pending.reject(new HandoffCallError(`${this.name()} refused a chunk: ${message.error}`, "failed"));
				return;
			}
			case "xfer.error": {
				const error = new HandoffCallError(`${this.name()} cannot read the transfer: ${message.error}`, "failed");
				for (const [key, pending] of this.#reads) {
					if (!key.startsWith(`${message.xfer}@`)) continue;
					this.#reads.delete(key);
					clearTimeout(pending.timer);
					pending.reject(error);
				}
				return;
			}
			default:
				return;
		}
	}

	/** The link is gone: every call and chunk in flight fails at once (and later ones are refused). */
	close(reason: string): void {
		this.#closed = reason;
		const error = new HandoffCallError(reason, "link");
		for (const pending of [...this.#calls.values(), ...this.#reads.values(), ...this.#writes.values()]) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#calls.clear();
		this.#reads.clear();
		this.#writes.clear();
	}

	/** Asks the daemon for `len` bytes of an offered file; resolves with them (base64) once they arrive. */
	readChunk(xfer: string, offset: number, len: number): Promise<{ data: string; eof: boolean }> {
		if (this.#closed) return Promise.reject(new HandoffCallError(this.#closed, "link"));
		return new Promise((resolve, reject) => {
			const key = `${xfer}@${offset}`;
			const timer = setTimeout(() => {
				this.#reads.delete(key);
				reject(new HandoffCallError(`${this.name()} did not send a chunk in time`, "link"));
			}, CHUNK_TIMEOUT_MS);
			this.#reads.set(key, { resolve, reject, timer });
			this.send({ t: "xfer.read", xfer, offset, len });
		});
	}

	/**
	 * Hands the daemon one chunk once its link has drained below the bulk threshold. Resolves when the frame was handed to the
	 * link; `ack` settles when the daemon acknowledged the write (a box, because a promise of a promise would be flattened).
	 */
	async writeChunk(xfer: string, offset: number, data: string): Promise<{ ack: Promise<void> }> {
		while (this.bufferedAmount() > BULK_HIGH_WATER_BYTES) {
			if (this.#closed) throw new HandoffCallError(this.#closed, "link");
			await Bun.sleep(GATE_POLL_MS);
		}
		if (this.#closed) throw new HandoffCallError(this.#closed, "link");
		const ack = new Promise<void>((resolve, reject) => {
			const key = `${xfer}@${offset}`;
			const timer = setTimeout(() => {
				this.#writes.delete(key);
				reject(new HandoffCallError(`${this.name()} did not acknowledge a chunk in time`, "link"));
			}, CHUNK_TIMEOUT_MS);
			this.#writes.set(key, { resolve, reject, timer });
		});
		// An ack that fails while nobody awaits it yet must not become an unhandled rejection; the pump awaits it later.
		ack.catch(() => {});
		this.send({ t: "xfer.write", xfer, offset, data });
		return { ack };
	}
}

export interface PumpOptions {
	/** Bytes acknowledged by the target so far. */
	onProgress?: (done: number, total: number) => void;
	/** Checked between chunks: true ends the transfer with an error. */
	aborted?: () => boolean;
	window?: number;
	chunkBytes?: number;
}

/**
 * Moves `info.size` bytes from `source`'s offered file to `target`'s receiving file, in order, with the memory bound described
 * above. Resolves when the target acknowledged the last byte; any failure (a link dropped, a refused chunk, abort) rejects.
 */
export async function pumpTransfer(
	source: PeerRpc,
	info: XferInfo,
	target: PeerRpc,
	targetXfer: string,
	options: PumpOptions = {},
): Promise<void> {
	const window = options.window ?? XFER_WINDOW;
	const chunk = options.chunkBytes ?? XFER_CHUNK_BYTES;
	const total = info.size;
	const reads: { offset: number; len: number; promise: Promise<{ data: string; eof: boolean }> }[] = [];
	const writes: { len: number; ack: Promise<void> }[] = [];
	let next = 0;
	let acked = 0;
	const failIfAborted = (): void => {
		if (options.aborted?.()) throw new HandoffCallError("the transfer was cancelled", "failed");
	};
	try {
		while (acked < total) {
			failIfAborted();
			while (reads.length + writes.length < window && next < total) {
				const len = Math.min(chunk, total - next);
				const promise = source.readChunk(info.id, next, len);
				promise.catch(() => {});
				reads.push({ offset: next, len, promise });
				next += len;
			}
			const read = reads[0];
			if (read && writes.length < window) {
				const { data } = await read.promise;
				reads.shift();
				if (Buffer.from(data, "base64").byteLength !== read.len) {
					throw new HandoffCallError("the source sent a chunk of the wrong size", "failed");
				}
				writes.push({ len: read.len, ...(await target.writeChunk(targetXfer, read.offset, data)) });
				continue;
			}
			const write = writes.shift();
			if (!write) break;
			await write.ack;
			acked += write.len;
			options.onProgress?.(acked, total);
		}
	} catch (error) {
		// Whatever is still in flight is abandoned: it is bounded by the window and the daemons drop it with the operation.
		for (const read of reads) read.promise.catch(() => {});
		for (const write of writes) write.ack.catch(() => {});
		throw error;
	}
	if (acked !== total) throw new HandoffCallError("the transfer ended early", "failed");
}
