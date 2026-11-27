import {
	Heartbeat,
	LINK_PROTOCOL_VERSION,
	parseEnvLinkMessage,
	type EnvLinkMessage,
	type GatewayLinkMessage,
} from "@omp-web/protocol";
import type { Gateway, EnvPeer, GatewayHeartbeat } from "./gateway";
import type { LinkEnd } from "./link-end";
import { linkProof, randomToken, secretsEqual, type MachineKeys } from "./secrets";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface AcceptorOptions {
	gateway: Gateway;
	keys: MachineKeys;
	link: LinkEnd;
	heartbeat?: GatewayHeartbeat;
	handshakeTimeoutMs?: number;
}

/**
 * The gateway's side of an incoming daemon connection (`/env`): challenge, verify the pre-shared-key proof, register the
 * machine, then carry the link (heartbeat, frames to the {@link EnvPeer}). An unknown machine id and a wrong key are
 * answered identically, so the endpoint does not reveal which machine ids exist.
 */
export class EnvAcceptor {
	readonly #nonce = randomToken(16);
	readonly #timeout: ReturnType<typeof setTimeout>;
	#state: "challenged" | "verifying" | "registered" | "done" = "challenged";
	#peer: EnvPeer | null = null;
	#heartbeat: Heartbeat | null = null;

	constructor(private readonly options: AcceptorOptions) {
		this.#timeout = setTimeout(
			() => this.#reject("handshake timed out"),
			options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
		);
	}

	/** Sends the challenge; call when the connection opens. */
	start(): void {
		this.#send({ t: "challenge", nonce: this.#nonce, protocol: LINK_PROTOCOL_VERSION });
	}

	/** One text frame from the daemon. */
	async receive(text: string): Promise<void> {
		if (this.#state === "registered") {
			if (this.#heartbeat?.receive(text)) return;
			this.#peer?.receive(text);
			return;
		}
		if (this.#state !== "challenged") return;
		this.#state = "verifying";
		await this.#register(text);
	}

	/** The connection is gone. */
	closed(): void {
		clearTimeout(this.#timeout);
		this.#heartbeat?.stop();
		this.#state = "done";
		this.#peer?.closed();
	}

	async #register(text: string): Promise<void> {
		let message: EnvLinkMessage;
		try {
			message = parseEnvLinkMessage(text);
		} catch (error) {
			return this.#reject(error instanceof Error ? error.message : String(error));
		}
		if (message.t !== "register") return this.#reject("expected a registration");
		if (message.protocol !== LINK_PROTOCOL_VERSION) {
			return this.#reject(
				`link protocol ${message.protocol} is not supported (gateway speaks ${LINK_PROTOCOL_VERSION})`,
			);
		}
		const machine = await this.options.keys.get(message.machineId).catch(error => {
			console.warn(
				`omp-webd: cannot read the machine keys: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		});
		const expected =
			machine &&
			linkProof(machine.key, "env", this.#nonce, message.cnonce, message.machineId, message.acceptsBroker);
		if (!machine || !expected || !secretsEqual(expected, message.proof)) {
			console.warn(`omp-webd: rejected a registration for machine id ${JSON.stringify(message.machineId)}`);
			return this.#reject("unknown machine or wrong key");
		}
		if (this.#state === "done") return; // the connection dropped while the key was being read
		this.#peer = this.options.gateway.attachEnv(
			{
				machineId: message.machineId,
				name: machine.name,
				platform: message.platform,
				hello: message.hello,
				acceptsBroker: message.acceptsBroker,
			},
			this.options.link,
		);
		this.#state = "registered";
		clearTimeout(this.#timeout);
		this.#send({
			t: "registered",
			proof: linkProof(
				machine.key,
				"gateway",
				this.#nonce,
				message.cnonce,
				message.machineId,
				message.acceptsBroker,
			),
		});
		this.#heartbeat = new Heartbeat({
			send: frame => this.options.link.send(frame),
			onDead: () => this.options.link.terminate(),
			...this.options.heartbeat,
		});
		this.#heartbeat.start();
		this.options.gateway.peerReady(this.#peer);
	}

	#reject(reason: string): void {
		if (this.#state === "registered" || this.#state === "done") return;
		this.#state = "done";
		clearTimeout(this.#timeout);
		this.#send({ t: "rejected", reason });
		this.options.link.close(4401, reason);
	}

	#send(message: GatewayLinkMessage): void {
		this.options.link.send(JSON.stringify(message));
	}
}
