import {
	Heartbeat,
	LINK_PROTOCOL_VERSION,
	parseGatewayLinkMessage,
	type EnvLinkMessage,
	type GatewayLinkMessage,
} from "@omp-web/protocol";
import type { EnvEndpoint } from "./env-endpoint";
import type { EnvHost, EnvIdentity } from "./env-host";
import type { LinkEnd } from "./link-end";
import { linkProof, randomToken, secretsEqual } from "./secrets";

export interface DialerOptions {
	/** `ws://` / `wss://` URL of the gateway's `/env` endpoint. */
	url: string;
	identity: EnvIdentity;
	/** The machine's pre-shared key. */
	key: string;
	host: EnvHost;
	/**
	 * Whether this daemon takes the credential broker's bearer token over this link (see `linkProtection`). Declared in the
	 * registration and covered by both proofs, so the gateway cannot be tricked into sending the token over a link the
	 * daemon judged unsafe.
	 */
	acceptsBroker: boolean;
	heartbeat?: { intervalMs?: number; timeoutMs?: number };
	/** Delay between connection attempts: starts at `minMs`, doubles up to `maxMs`, with jitter. */
	backoff?: { minMs: number; maxMs: number };
	/** How long the challenge / registered exchange may take before the attempt is abandoned. */
	handshakeTimeoutMs?: number;
	/** Test seam. */
	socketFactory?: (url: string) => WebSocket;
}

const DEFAULT_BACKOFF = { minMs: 500, maxMs: 10_000 };

/**
 * Keeps this daemon registered with its gateway: dials out (the daemon listens on nothing), proves the pre-shared key,
 * serves the link through the {@link EnvHost}, and redials with backoff whenever the link ends or the heartbeat finds
 * it silent. A rejection (wrong key, unknown machine) is logged and retried: the operator may be fixing the gateway.
 */
export class EnvDialer {
	readonly #backoff: { minMs: number; maxMs: number };
	#delay: number;
	#stopped = false;
	#socket: WebSocket | null = null;
	#retry: ReturnType<typeof setTimeout> | null = null;
	#endpoint: EnvEndpoint | null = null;

	constructor(private readonly options: DialerOptions) {
		this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.#delay = this.#backoff.minMs;
	}

	/** True while registered and serving. */
	get registered(): boolean {
		return this.#endpoint !== null;
	}

	start(): void {
		this.#connect();
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#retry ?? undefined);
		this.#socket?.close();
	}

	#connect(): void {
		const { url, identity, key, host } = this.options;
		const ws = (this.options.socketFactory ?? (u => new WebSocket(u)))(url);
		this.#socket = ws;
		const cnonce = randomToken(16);
		let phase: "challenge" | "registered" | "live" | "down" = "challenge";
		let heartbeat: Heartbeat | null = null;
		let nonce = "";

		const handshakeTimer = setTimeout(() => {
			if (phase !== "live") {
				console.warn(`omp-webd: gateway ${url} did not complete the handshake in time`);
				down();
			}
		}, this.options.handshakeTimeoutMs ?? 10_000);

		const down = (): void => {
			if (phase === "down") return;
			phase = "down";
			clearTimeout(handshakeTimer);
			heartbeat?.stop();
			if (this.#endpoint) {
				host.detach(this.#endpoint);
				this.#endpoint = null;
				console.warn(`omp-webd: lost the link to the gateway ${url}`);
			}
			ws.terminate();
			if (this.#socket === ws) this.#socket = null;
			if (this.#stopped) return;
			const wait = this.#delay * (0.75 + Math.random() * 0.5);
			this.#delay = Math.min(this.#delay * 2, this.#backoff.maxMs);
			this.#retry = setTimeout(() => this.#connect(), wait);
		};

		const link: LinkEnd = {
			send: text => {
				if (ws.readyState === WebSocket.OPEN) ws.send(text);
			},
			bufferedAmount: () => ws.bufferedAmount,
			close: (code, reason) => ws.close(code, reason),
			terminate: down,
		};
		const send = (message: EnvLinkMessage): void => link.send(JSON.stringify(message));

		const onHandshake = (text: string): void => {
			let message: GatewayLinkMessage;
			try {
				message = parseGatewayLinkMessage(text);
			} catch (error) {
				console.warn(
					`omp-webd: bad handshake frame from the gateway: ${error instanceof Error ? error.message : String(error)}`,
				);
				return down();
			}
			if (phase === "challenge" && message.t === "challenge") {
				if (message.protocol !== LINK_PROTOCOL_VERSION) {
					console.warn(
						`omp-webd: gateway speaks link protocol ${message.protocol}, this daemon ${LINK_PROTOCOL_VERSION}`,
					);
					return down();
				}
				nonce = message.nonce;
				phase = "registered";
				send({
					t: "register",
					protocol: LINK_PROTOCOL_VERSION,
					machineId: identity.machineId,
					platform: identity.platform,
					hello: identity.hello,
					cnonce,
					acceptsBroker: this.options.acceptsBroker,
					proof: linkProof(key, "env", nonce, cnonce, identity.machineId, this.options.acceptsBroker),
				});
			} else if (phase === "registered" && message.t === "registered") {
				if (
					!secretsEqual(
						message.proof,
						linkProof(key, "gateway", nonce, cnonce, identity.machineId, this.options.acceptsBroker),
					)
				) {
					console.warn(`omp-webd: ${url} could not prove it knows this machine's key; not registering`);
					return down();
				}
				phase = "live";
				clearTimeout(handshakeTimer);
				this.#delay = this.#backoff.minMs;
				this.#endpoint = host.attach(link);
				heartbeat = new Heartbeat({ send: frame => link.send(frame), onDead: down, ...this.options.heartbeat });
				heartbeat.start();
				console.log(`omp-webd: registered with the gateway ${url} as machine ${identity.machineId}`);
			} else if (message.t === "rejected") {
				console.warn(`omp-webd: the gateway rejected this machine: ${message.reason}`);
				down();
			}
		};

		ws.onmessage = event => {
			if (phase === "down" || typeof event.data !== "string") return;
			if (phase !== "live") return onHandshake(event.data);
			if (heartbeat?.receive(event.data)) return;
			this.#endpoint?.receive(event.data);
		};
		ws.onclose = down;
		ws.onerror = () => {}; // a failed attempt is followed by `close`
	}
}
