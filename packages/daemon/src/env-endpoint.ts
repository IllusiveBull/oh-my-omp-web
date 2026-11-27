import {
	XFER_CHUNK_BYTES,
	clientFrame,
	parseGatewayLinkMessage,
	type EnvLinkMessage,
	type GatewayLinkMessage,
	type HandoffOpName,
} from "@omp-web/protocol";
import { EnvClient, type ClientHost, type EnvClientOptions } from "./env-client";
import type { LinkEnd } from "./link-end";
import { LaneLink } from "./link-lanes";
import { DEFAULT_OUTBOX_LIMITS, type OutboxLimits, type OutboxSocket } from "./outbox";
import { ReplicaUploader, type ReplicaSource } from "./replica-env";
import type { TerminalSocket } from "./terminal-service";

/**
 * The Outbox's socket for one virtual client: frames go onto the shared link, tagged with the client id. It is also the
 * terminal channel of that client: those frames take the link's priority lane and are paused by the same gateway signal.
 */
class LinkClientSocket implements OutboxSocket, TerminalSocket {
	paused = false;

	constructor(
		private readonly cid: string,
		private readonly link: LaneLink,
		private readonly limits: OutboxLimits,
		private readonly onClosed: (reason: string) => void,
		/** The link itself (not the gateway's pause) is over the high-water mark: somebody has to pump when it drains. */
		private readonly onCongested: () => void,
	) {}

	send(frame: string): number {
		this.link.send(clientFrame(this.cid, frame));
		return frame.length;
	}

	sendPriority(frame: string): void {
		this.link.sendPriority(clientFrame(this.cid, frame));
	}

	isPaused(): boolean {
		return this.paused;
	}

	/** While the gateway reports the browser's socket as backed up, look full so the Outbox queues instead of writing. */
	getBufferedAmount(): number {
		const link = this.link.bufferedAmount();
		if (link > this.limits.highWater) this.onCongested();
		return this.paused ? Math.max(link, this.limits.highWater + 1) : link;
	}

	close(_code: number | undefined, reason: string | undefined): void {
		this.onClosed(reason ?? "closed");
	}
}

/**
 * The daemon's side of one link to the gateway: turns the gateway's control messages into virtual clients, and carries
 * the daemon's own pushes (session list, projects). When the link goes away every virtual client is disposed, so
 * nothing of a gone gateway stays subscribed; the browsers resubscribe through the gateway when the link is back.
 */
export class EnvEndpoint {
	readonly #clients = new Map<string, { client: EnvClient; socket: LinkClientSocket }>();
	/** The link with its two lanes: terminal frames are written at once, everything else behind the bulk threshold. */
	private readonly link: LaneLink;
	readonly #limits: OutboxLimits;
	readonly #uploader: ReplicaUploader;
	/** Serialized manifest last sent on this link; an unchanged file list is not announced again. */
	#announced: string | null = null;
	#congestion: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly host: ClientHost,
		link: LinkEnd,
		private readonly options: EnvClientOptions = {},
	) {
		this.link = new LaneLink(link);
		this.#limits = options.outbox ?? DEFAULT_OUTBOX_LIMITS;
		this.#uploader = new ReplicaUploader(
			message => this.link.send(JSON.stringify(message)),
			() => this.link.bufferedAmount(),
		);
	}

	/** Offers the files to replicate to this link's gateway, unless it was offered exactly this list already. */
	announce(sources: ReplicaSource[], signature: string): void {
		if (signature === this.#announced) return;
		this.#announced = signature;
		this.#uploader.announce(sources);
	}

	get clientCount(): number {
		return this.#clients.size;
	}

	/** Sends a push frame (already serialized) to the gateway. */
	send(frame: string): void {
		this.link.send(frame);
	}

	/** Resubscribes every virtual client that looks at one of `ids` (those ids name a different object now). */
	resubscribe(ids: readonly string[]): void {
		for (const { client } of this.#clients.values()) for (const id of ids) client.resubscribe(id);
	}

	/** One non-heartbeat frame from the gateway. Malformed control messages are ignored: the gateway is authenticated. */
	receive(text: string): void {
		let msg: GatewayLinkMessage;
		try {
			msg = parseGatewayLinkMessage(text);
		} catch (error) {
			console.warn(
				`omp-webd: bad frame from the gateway: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		switch (msg.t) {
			case "open":
				this.#open(msg.cid, msg.who);
				break;
			case "close":
				this.#drop(msg.cid);
				break;
			case "req":
				void this.#clients.get(msg.cid)?.client.receive(msg.text);
				break;
			case "pause":
				this.#setPaused(msg.cid, true);
				break;
			case "resume":
				this.#setPaused(msg.cid, false);
				break;
			case "replica.want":
				void this.#uploader.want(msg.id, msg.have);
				break;
			case "broker.config":
				this.host.brokerConfig(msg.config);
				break;
			case "op":
				void this.#runOp(msg.id, msg.op, msg.args);
				break;
			case "xfer.read":
				void this.#readChunk(msg.xfer, msg.offset, msg.len);
				break;
			case "xfer.write":
				void this.#writeChunk(msg.xfer, msg.offset, msg.data);
				break;
			default:
				// challenge / registered / rejected belong to the handshake, which the transport finished already.
				break;
		}
	}

	/** One handoff operation of the gateway. Results are small control frames: they take the priority lane. */
	async #runOp(id: string, op: HandoffOpName, args: unknown): Promise<void> {
		const handoff = this.host.handoff;
		if (!handoff) {
			this.link.sendPriority(
				JSON.stringify({
					t: "op.result",
					id,
					ok: false,
					error: { message: "this daemon cannot switch environments", kind: "refused" },
				} satisfies EnvLinkMessage),
			);
			return;
		}
		let frame: EnvLinkMessage;
		try {
			frame = { t: "op.result", id, ok: true, data: await handoff.call(op, args) };
		} catch (error) {
			frame = { t: "op.result", id, ok: false, error: handoff.toWireError(error) };
		}
		this.link.sendPriority(JSON.stringify(frame));
	}

	/** One chunk of an offered file, on the bulk lane: it never waits ahead of a keystroke's echo. */
	async #readChunk(xfer: string, offset: number, len: number): Promise<void> {
		const handoff = this.host.handoff;
		try {
			if (!handoff) throw new Error("this daemon cannot switch environments");
			const { data, eof } = await handoff.readChunk(xfer, offset, Math.min(len, XFER_CHUNK_BYTES));
			this.link.send(
				JSON.stringify({
					t: "xfer.data",
					xfer,
					offset,
					data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"),
					eof,
				} satisfies EnvLinkMessage),
			);
		} catch (error) {
			this.link.sendPriority(
				JSON.stringify({
					t: "xfer.error",
					xfer,
					error: error instanceof Error ? error.message : String(error),
				} satisfies EnvLinkMessage),
			);
		}
	}

	async #writeChunk(xfer: string, offset: number, data: string): Promise<void> {
		const handoff = this.host.handoff;
		let frame: EnvLinkMessage;
		try {
			if (!handoff) throw new Error("this daemon cannot switch environments");
			await handoff.writeChunk(xfer, offset, Buffer.from(data, "base64"));
			frame = { t: "xfer.ack", xfer, offset, ok: true };
		} catch (error) {
			frame = {
				t: "xfer.ack",
				xfer,
				offset,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		this.link.sendPriority(JSON.stringify(frame));
	}

	#setPaused(cid: string, paused: boolean): void {
		const entry = this.#clients.get(cid);
		if (!entry) return;
		entry.socket.paused = paused;
		if (!paused) entry.client.pump();
	}

	/** The link is gone. */
	dispose(): void {
		this.#uploader.close();
		for (const cid of Array.from(this.#clients.keys())) this.#drop(cid);
		clearInterval(this.#congestion ?? undefined);
		this.#congestion = null;
		this.link.dispose();
	}

	/**
	 * A client's Outbox queued frames because the link's own buffer was full. A WebSocket client has no drain event and the
	 * gateway's pause/resume only covers a backed-up *browser*, so without this nothing would ever pump those queues once
	 * the link drained: every reply behind the congestion (a file page, an ack) would wait for an unrelated `resume`.
	 */
	#watchCongestion(): void {
		if (this.#congestion !== null) return;
		this.#congestion = setInterval(() => {
			if (this.link.bufferedAmount() > this.#limits.highWater) return;
			clearInterval(this.#congestion ?? undefined);
			this.#congestion = null;
			for (const { client, socket } of this.#clients.values()) if (!socket.paused) client.pump();
		}, 10);
	}

	#open(cid: string, who?: string): void {
		if (this.#clients.has(cid)) return;
		const socket = new LinkClientSocket(
			cid,
			this.link,
			this.#limits,
			reason => {
				this.link.send(JSON.stringify({ t: "closed", cid, reason }));
				this.#drop(cid);
			},
			() => this.#watchCongestion(),
		);
		const client = new EnvClient(this.host, socket, { ...this.options, terminal: { socket, who } });
		this.#clients.set(cid, { client, socket });
	}

	#drop(cid: string): void {
		const entry = this.#clients.get(cid);
		if (!entry) return;
		this.#clients.delete(cid);
		entry.client.dispose();
	}
}
