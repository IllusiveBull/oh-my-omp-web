/**
 * Liveness check for a WebSocket whose peer can vanish without a FIN (NAT timeout, a laptop lid, a pulled cable): the
 * kernel then keeps the connection "open" for minutes. Both ends of every long-lived link (browser <-> gateway,
 * gateway <-> daemon) run one {@link Heartbeat}: it sends {@link PING_FRAME} on an interval, answers the peer's ping
 * with {@link PONG_FRAME}, and declares the link dead when nothing at all (any frame counts) arrived for `timeoutMs`.
 *
 * The frames are fixed strings so the hot relay path can recognise them with one comparison instead of parsing.
 */
export const PING_FRAME = '{"t":"ping"}';
export const PONG_FRAME = '{"t":"pong"}';

export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Silence after which a link is considered dead: it tolerates two lost pings. */
export const HEARTBEAT_TIMEOUT_MS = 25_000;

export interface HeartbeatOptions {
	/** Writes a frame to the peer. */
	send(frame: string): void;
	/** The link has been silent too long: close it (and reconnect, where the caller owns the dialing side). */
	onDead(): void;
	intervalMs?: number;
	timeoutMs?: number;
	/** Test seam. */
	now?: () => number;
}

export class Heartbeat {
	readonly #send: (frame: string) => void;
	readonly #onDead: () => void;
	readonly #intervalMs: number;
	readonly #timeoutMs: number;
	readonly #now: () => number;
	#lastRx: number;
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: HeartbeatOptions) {
		this.#send = options.send;
		this.#onDead = options.onDead;
		this.#intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
		this.#timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
		this.#now = options.now ?? Date.now;
		this.#lastRx = this.#now();
	}

	/** Starts pinging; the silence clock starts now. */
	start(): void {
		this.#lastRx = this.#now();
		this.#timer ??= setInterval(() => this.tick(), this.#intervalMs);
	}

	stop(): void {
		clearInterval(this.#timer ?? undefined);
		this.#timer = null;
	}

	/**
	 * Feed every inbound frame. Any frame proves the peer is alive; a ping is answered here. Returns true for the
	 * heartbeat's own frames, which the caller must not process further.
	 */
	receive(frame: string): boolean {
		this.#lastRx = this.#now();
		if (frame === PING_FRAME) {
			this.#send(PONG_FRAME);
			return true;
		}
		return frame === PONG_FRAME;
	}

	/** One interval step: declare the link dead after too much silence, else ping. Public for tests. */
	tick(): void {
		if (this.#now() - this.#lastRx > this.#timeoutMs) {
			this.stop();
			this.#onDead();
			return;
		}
		this.#send(PING_FRAME);
	}
}
