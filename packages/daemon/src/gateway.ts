import {
	Heartbeat,
	PROTOCOL_VERSION,
	parseBrowserMessage,
	parseClientFrame,
	parseEnvLinkMessage,
	isTerminalOneway,
	isTerminalType,
	tagFrame,
	type AuthFrame,
	type AuthMessage,
	type BrokerLinkConfig,
	type DaemonHello,
	type EnvBrokerStatus,
	type EnvLinkMessage,
	type GatewayFrame,
	type MachineSummary,
	type ParsedBrowserMessage,
	type ProjectInfo,
	type SessionInfo,
	type AttentionEvent,
	type ReplicaInfo,
	type HandoffMessage,
	type HandoffLimits,
	type HandoffWire,
	type SessionFacts,
	snapshotFrames,
} from "@omp-web/protocol";
import { GatewayStore, UnknownSessionError, type ReadReport, type StoredMachine } from "./db";
import { DEFAULT_HANDOFF_LIMITS, HandoffCoordinator, type HandoffTransport } from "./handoff-gateway";
import { HandoffCallError, PeerRpc, pumpTransfer } from "./handoff-link";
import type { AttentionSink } from "./attention";
import type { LinkEnd } from "./link-end";
import { DEFAULT_OUTBOX_LIMITS, Outbox, type OutboxLimits, type OutboxSocket } from "./outbox";
import { ReplicaFiles, ReplicaSync } from "./replica-gateway";
import { scanConversations } from "./session-index";
import { StoredSession } from "./stored-session";

/** Session lists carrying replica state are re-sent at most this often while files are being copied. */
const REPLICA_BROADCAST_MS = 500;

/** The browser's WebSocket as the gateway uses it. */
export interface BrowserSocket extends OutboxSocket {
	/** Drops the connection without a closing handshake (the peer may be gone without a FIN). */
	terminate(): void;
}

/** Who a browser connection is: the login (cookie) it came in with. Its `id` is a prefix of the cookie's hash, never the cookie. */
export interface BrowserIdentity {
	id: string;
	/** Whether that login is still valid (not signed out, not expired). */
	valid(): boolean;
}

export interface GatewayHeartbeat {
	intervalMs?: number;
	timeoutMs?: number;
}

/**
 * What the gateway needs from the credential side (`AuthService`): the frames a connecting browser starts with, its
 * `auth.*` requests, and the broker an environment should use. An interface so the relay can be tested without a broker.
 */
export interface AuthPort {
	/** The current `auth.*` frames, sent to every browser that connects. */
	frames(): AuthFrame[];
	/** One `auth.*` request of a browser connection; returns the ack's data or throws an Error with a presentable message. */
	handle(connection: object, message: AuthMessage): Promise<unknown>;
	/** The browser connection ended: forget what it had open (the Accounts page). */
	released(connection: object): void;
	/** The broker URL and token machine `machineId` should use (the gateway's own machine reaches it locally); null when none is hosted. */
	brokerConfigFor(machineId: string): BrokerLinkConfig | null;
}

export interface GatewayOptions {
	store: GatewayStore;
	/** Id of the machine this gateway runs on; its env registers in-process like any other. */
	selfMachineId: string;
	gatewayVersion: string;
	/** Where the machines' transcript replicas live (`<dir>/<machine id>/<session file>`). */
	replicaDir: string;
	/** Told about hosted sessions that need a human and about threads that were read (Web Push). */
	attention?: AttentionSink;
	/** Credential management; without it `auth.*` requests are refused and no broker is handed to environments. */
	auth?: AuthPort;
	/** Limits for the frames the gateway itself queues per browser, and the pause threshold for relayed ones. */
	outbox?: OutboxLimits;
	heartbeat?: GatewayHeartbeat;
	now?: () => number;
	/** Environment switches: size limits and how long an unconfirmed switch waits. */
	handoff?: {
		limits?: Partial<HandoffLimits>;
		confirmTimeoutMs?: number;
		/** The broker's accounts as pin hashes (for forecasts when the target uses the gateway's broker). */
		brokerAccounts?: () => Promise<SessionFacts["accounts"] | null>;
		newId?: () => string;
	};
}

/** `snapshot.chunk` size of a replica snapshot, the same as a live one. */
const REPLICA_FRAME_BYTES = 256 * 1024;

/** What a daemon is when it registers. `name` comes from the gateway's own records, not from the daemon. */
export interface EnvRegistrationInfo {
	machineId: string;
	name: string;
	platform: string;
	hello: DaemonHello;
	/** The daemon takes the broker's bearer token over this link (declared in its signed registration). */
	acceptsBroker: boolean;
}

/** Shown for a machine that did not take the broker's token because its link is not protected. */
const WITHHELD_MESSAGE =
	"this machine's link to the gateway is plain ws:// over an address that is neither loopback nor in the tailnet, so the broker's token was not sent. Use wss:// (or a tailnet address), or give this machine its own `broker` section in config.json.";

interface MachineState {
	stored: StoredMachine;
	peer: EnvPeer | null;
	/** Counts registrations of this machine since the gateway started. */
	linkId: number;
	/** What the machine last reported about its broker (cleared when its link ends). */
	broker: EnvBrokerStatus | null;
}

/** The gateway's end of one daemon's link. */
export class EnvPeer {
	/** Browser connections that use this machine, by the virtual client id the daemon knows them under. */
	readonly clients = new Map<string, BrowserConn>();
	detached = false;

	constructor(
		readonly machineId: string,
		readonly linkId: number,
		readonly link: LinkEnd,
		private readonly gateway: Gateway,
		/** The transcript replica sync of this link. */
		readonly replica: ReplicaSync,
		/** The daemon declared it takes the broker's token over this link. */
		readonly acceptsBroker: boolean,
		/** Handoff operations and transfers over this link. */
		readonly rpc: PeerRpc,
	) {}

	/** One non-heartbeat frame from the daemon. */
	receive(text: string): void {
		const client = parseClientFrame(text);
		if (client) {
			this.clients.get(client.cid)?.relay(this.machineId, client.frame);
			return;
		}
		let message: EnvLinkMessage;
		try {
			message = parseEnvLinkMessage(text);
		} catch (error) {
			console.warn(
				`omp-webd: bad frame from machine ${this.machineId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		switch (message.t) {
			case "sessions":
				this.gateway.sessionsReported(this.machineId, message.sessions);
				break;
			case "projects":
				this.gateway.projectsReported(this.machineId, message.projects);
				break;
			case "closed":
				this.clients.get(message.cid)?.kick(message.reason);
				break;
			case "replica.manifest":
				this.replica.manifest(message.files);
				break;
			case "replica.data":
				this.replica.data(message);
				break;
			case "replica.skip":
				this.replica.skip(message.id, message.reason);
				break;
			case "attention":
				this.gateway.attentionReported(this.machineId, message.event);
				break;
			case "broker.status":
				this.gateway.brokerReported(this, message.status);
				break;
			case "op.result":
			case "xfer.data":
			case "xfer.ack":
			case "xfer.error":
				this.rpc.receive(message);
				break;
			case "register":
				break; // only valid during the handshake, which the transport completed before creating the peer
		}
	}

	/** The transport lost the link. */
	closed(): void {
		this.rpc.close(`${this.gateway.nameOf(this.machineId)} went offline`);
		this.gateway.envGone(this);
	}
}

/** One browser connection. For every machine it uses it is one virtual client of that machine's daemon. */
export class BrowserConn {
	readonly #outbox: Outbox;
	readonly #heartbeat: Heartbeat;
	readonly #cids = new Map<string, { cid: string; peer: EnvPeer }>();
	/** request id -> machine id, for requests forwarded and not answered yet. */
	readonly #pending = new Map<string, string>();
	#paused = false;
	#closed = false;
	#viewing: { machine: string; sessionId: string; visible: boolean } | null = null;
	/** Sessions this connection reads from the gateway's replica (their machine is offline), by outbox label. */
	readonly #replicaSubs = new Map<string, { machine: string; sessionId: string }>();

	constructor(
		private readonly gateway: Gateway,
		private readonly socket: BrowserSocket,
		private readonly limits: OutboxLimits,
		heartbeat: GatewayHeartbeat,
		/** The login of this connection (absent for in-process clients). */
		readonly identity?: BrowserIdentity,
	) {
		this.#outbox = new Outbox(socket, labels => this.#resync(labels), limits);
		this.#heartbeat = new Heartbeat({
			send: frame => socket.send(frame),
			onDead: () => socket.terminate(),
			...heartbeat,
		});
	}

	/** Sends the hello and the current state, and starts the heartbeat. */
	start(frames: GatewayFrame[]): void {
		for (const frame of frames) this.sendGateway(frame);
		this.#heartbeat.start();
	}

	/** A frame the gateway itself produced; list-like frames collapse while the browser is behind. */
	sendGateway(frame: GatewayFrame): void {
		const text = JSON.stringify(frame);
		if (frame.t === "machines") this.#outbox.coalesced("machines", text);
		else if (frame.t === "sessions") this.#outbox.coalesced(`sessions:${frame.m}`, text);
		else if (frame.t.startsWith("auth.")) this.#outbox.coalesced(frame.t, text);
		else if (frame.t === "handoff.state") this.#outbox.coalesced("handoff.state", text);
		else this.#outbox.control(text);
	}

	/** The socket can take more: flush what the gateway queued and let paused daemons write again. */
	drain(): void {
		this.#outbox.pump();
		if (this.#paused && this.socket.getBufferedAmount() <= this.limits.highWater) {
			this.#paused = false;
			for (const { cid, peer } of this.#cids.values()) peer.link.send(JSON.stringify({ t: "resume", cid }));
		}
	}

	/** A frame from the daemon of `machine` for this browser, relayed untouched except for the machine tag. */
	relay(machine: string, frame: string): void {
		if (this.#closed) return;
		if (frame.startsWith('{"t":"ack"')) {
			// The daemon writes `{"t":"ack","reqId":"<id>",…`; an ack can carry a ~350 KiB file page that is not worth parsing.
			const quoted = /^\{"t":"ack","reqId":("(?:[^"\\]|\\.)*")/.exec(frame.slice(0, 512))?.[1];
			const reqId: unknown = quoted === undefined ? undefined : JSON.parse(quoted);
			if (typeof reqId === "string") this.#pending.delete(reqId);
		}
		this.socket.send(tagFrame(frame, machine));
		const buffered = this.socket.getBufferedAmount();
		if (buffered > this.limits.hardLimit) {
			this.kick("client is not reading");
		} else if (buffered > this.limits.highWater && !this.#paused) {
			this.#paused = true;
			for (const { cid, peer } of this.#cids.values()) peer.link.send(JSON.stringify({ t: "pause", cid }));
		}
	}

	/** Ends this connection: the browser reconnects and resubscribes. */
	kick(reason: string): void {
		this.socket.close(1013, reason);
	}

	/** One text frame from the browser. */
	async receive(text: string): Promise<void> {
		if (this.#heartbeat.receive(text)) return;
		let parsed: ParsedBrowserMessage;
		try {
			parsed = parseBrowserMessage(text);
		} catch (error) {
			this.#failParse(text, error);
			return;
		}
		if (parsed.kind === "auth") {
			const { message } = parsed;
			try {
				const data = await this.gateway.handleAuth(this, message);
				this.sendGateway({ t: "ack", reqId: message.reqId, ok: true, ...(data === undefined ? {} : { data }) });
			} catch (error) {
				this.sendGateway({
					t: "ack",
					reqId: message.reqId,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		if (parsed.kind === "handoff") {
			const { message } = parsed;
			try {
				const data = await this.gateway.handleHandoff(message);
				this.sendGateway({ t: "ack", reqId: message.reqId, ok: true, ...(data === undefined ? {} : { data }) });
			} catch (error) {
				this.sendGateway({
					t: "ack",
					reqId: message.reqId,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		if (parsed.kind === "gateway") {
			const { message } = parsed;
			try {
				if (message.t === "view") {
					this.#viewing =
						message.sessionId === null
							? null
							: { machine: message.m, sessionId: message.sessionId, visible: message.visible };
					if (this.#viewing?.visible) this.gateway.seen(message.m, message.sessionId!);
					this.sendGateway({ t: "ack", reqId: message.reqId, ok: true, m: message.m });
					return;
				}
				this.gateway.markRead(message.m, message.sessionId, {
					seq: message.seq,
					epoch: message.epoch,
					modifiedAt: message.modifiedAt,
				});
				this.sendGateway({ t: "ack", reqId: message.reqId, ok: true, m: message.m });
			} catch (error) {
				const reason =
					error instanceof UnknownSessionError
						? error.message
						: `${message.t} failed: ${error instanceof Error ? error.message : String(error)}`;
				this.sendGateway({ t: "ack", reqId: message.reqId, ok: false, error: reason, m: message.m });
			}
			return;
		}
		const { machine, message } = parsed;
		// A shell is as good as the login: a sign-out or an expiry that happened while this socket stayed open ends it here.
		if (isTerminalType(message.t) && this.identity && !this.identity.valid()) {
			this.kick("signed out");
			return;
		}
		const oneway = isTerminalOneway(message.t);
		const peer = this.gateway.peerOf(machine);
		if (peer === "unknown") {
			this.sendGateway({
				t: "ack",
				reqId: message.reqId,
				ok: false,
				error: `unknown machine: ${machine}`,
				m: machine,
			});
			return;
		}
		if (peer === null) {
			if (oneway) return; // keystrokes for a machine that went away are dropped; the page shows it offline
			if (message.t === "subscribe") {
				await this.#subscribeReplica(machine, message.reqId, message.sessionId);
			} else if (message.t === "unsubscribe") {
				const label = `${machine}/${message.sessionId}`;
				this.#replicaSubs.delete(label);
				this.#outbox.forget(label);
				this.sendGateway({ t: "ack", reqId: message.reqId, ok: true, m: machine });
			} else {
				this.sendGateway({
					t: "ack",
					reqId: message.reqId,
					ok: false,
					error: `${this.gateway.nameOf(machine)} is offline`,
					m: machine,
				});
			}
			return;
		}
		this.#replicaSubs.delete(`${machine}/${"sessionId" in message ? message.sessionId : ""}`);
		if (!oneway) this.#pending.set(message.reqId, machine);
		peer.link.send(JSON.stringify({ t: "req", cid: this.#cidFor(machine, peer), text: JSON.stringify(message) }));
	}

	/** The daemon of `machine` went away: what was in flight to it will not be answered, and its virtual client is gone. */
	envGone(machine: string, name: string): void {
		this.#cids.delete(machine);
		for (const [reqId, target] of this.#pending) {
			if (target !== machine) continue;
			this.#pending.delete(reqId);
			this.sendGateway({ t: "ack", reqId, ok: false, error: `${name} went offline`, m: machine });
		}
	}

	/** The browser connection is gone: release its virtual clients. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#heartbeat.stop();
		for (const { cid, peer } of this.#cids.values()) {
			peer.clients.delete(cid);
			peer.link.send(JSON.stringify({ t: "close", cid }));
		}
		this.#cids.clear();
		this.#pending.clear();
		this.#replicaSubs.clear();
	}

	/** What this connection is looking at, for the notifier's "somebody is already reading it" rule. */
	get presence(): { machine: string; sessionId: string; visible: boolean } | null {
		return this.#viewing;
	}

	/** The machine's daemon is linked again: sessions this connection reads from the replica are served by the machine now. */
	envBack(machine: string): void {
		for (const [label, sub] of this.#replicaSubs) {
			if (sub.machine !== machine) continue;
			this.#replicaSubs.delete(label);
			this.#outbox.forget(label);
		}
	}

	/** Answers a `subscribe` for an offline machine from the gateway's copy of the session. */
	async #subscribeReplica(machine: string, reqId: string, sessionId: string): Promise<void> {
		const label = `${machine}/${sessionId}`;
		try {
			const { session, replica } = await this.gateway.replicaSession(machine, sessionId);
			const { result } = session.subscribe(() => {}, 0, undefined);
			if (result.kind !== "snapshot") throw new Error("a replica always answers with a snapshot");
			this.#replicaSubs.set(label, { machine, sessionId });
			const frames = snapshotFrames(
				sessionId,
				crypto.randomUUID(),
				result.seq,
				result.epoch,
				result.snapshot,
				REPLICA_FRAME_BYTES,
			);
			this.#outbox.snapshot(
				label,
				(function* () {
					for (const frame of frames) yield tagFrame(frame, machine);
				})(),
			);
			this.sendGateway({ t: "ack", reqId, ok: true, data: { mode: "snapshot", replica }, m: machine });
		} catch (error) {
			this.sendGateway({
				t: "ack",
				reqId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				m: machine,
			});
		}
	}

	/** The outbox dropped queued snapshot frames of slow-reading replica sessions: send them again from the start. */
	#resync(labels: string[]): void {
		for (const label of labels) {
			const sub = this.#replicaSubs.get(label);
			if (sub) void this.#subscribeReplica(sub.machine, "", sub.sessionId);
		}
	}

	#cidFor(machine: string, peer: EnvPeer): string {
		const existing = this.#cids.get(machine);
		if (existing?.peer === peer) return existing.cid;
		const cid = crypto.randomUUID();
		this.#cids.set(machine, { cid, peer });
		peer.clients.set(cid, this);
		peer.link.send(
			JSON.stringify({ t: "open", cid, ...(this.identity ? { who: `session:${this.identity.id}` } : {}) }),
		);
		if (this.#paused) peer.link.send(JSON.stringify({ t: "pause", cid }));
		return cid;
	}

	#failParse(text: string, error: unknown): void {
		let reqId = "";
		try {
			const raw = JSON.parse(text) as { reqId?: unknown };
			if (typeof raw.reqId === "string") reqId = raw.reqId;
		} catch {
			// not JSON: no reqId to echo
		}
		this.sendGateway({ t: "ack", reqId, ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * The gateway role: the registry of machines (live links plus what the database remembers), the browser connections,
 * and the relay between them. It keeps no per-session state: a browser's subscriptions live in the daemon, and after a
 * link comes back the browser resubscribes (`linkId` tells it to), so the daemon's own replay/snapshot logic decides
 * what to resend.
 */
export class Gateway {
	readonly #store: GatewayStore;
	readonly #machines = new Map<string, MachineState>();
	readonly #browsers = new Set<BrowserConn>();
	readonly #limits: OutboxLimits;
	readonly #heartbeat: GatewayHeartbeat;
	readonly #now: () => number;
	readonly #replicaFiles: ReplicaFiles;
	readonly #replicaBroadcast = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #handoffs: HandoffCoordinator;
	#closed = false;

	constructor(private readonly options: GatewayOptions) {
		this.#store = options.store;
		this.#replicaFiles = new ReplicaFiles(options.store, options.replicaDir);
		this.#limits = options.outbox ?? DEFAULT_OUTBOX_LIMITS;
		this.#heartbeat = options.heartbeat ?? {};
		this.#now = options.now ?? Date.now;
		for (const stored of this.#store.machines()) {
			this.#machines.set(stored.id, { stored, peer: null, linkId: 0, broker: null });
		}
		const transport: HandoffTransport = {
			online: machine => this.#machines.get(machine)?.peer != null,
			linkId: machine => {
				const state = this.#machines.get(machine);
				return state?.peer ? state.linkId : null;
			},
			machineName: machine => this.nameOf(machine),
			call: (machine, op, args, timeoutMs) => this.#peerRpc(machine).call(op, args, timeoutMs),
			transfer: (from, info, to, toXfer, opts) =>
				pumpTransfer(this.#peerRpc(from), info, this.#peerRpc(to), toXfer, {
					onProgress: opts.onProgress,
					aborted: opts.aborted,
				}),
		};
		this.#handoffs = new HandoffCoordinator({
			store: this.#store,
			transport,
			projects: machine => this.#store.projects(machine),
			sessions: machine => this.#store.sessions(machine),
			publish: handoffs => this.#broadcast({ t: "handoff.state", handoffs }),
			sessionsChanged: machines => {
				for (const machine of machines)
					this.#broadcast({ t: "sessions", m: machine, sessions: this.#store.sessions(machine) });
			},
			limits: { ...DEFAULT_HANDOFF_LIMITS, ...options.handoff?.limits },
			confirmTimeoutMs: options.handoff?.confirmTimeoutMs ?? 30 * 60_000,
			brokerAccounts: options.handoff?.brokerAccounts,
			now: this.#now,
			newId: options.handoff?.newId,
		});
		this.#handoffs.recover();
	}

	#peerRpc(machine: string): PeerRpc {
		const peer = this.#machines.get(machine)?.peer;
		if (!peer) throw new HandoffCallError(`${this.nameOf(machine)} is offline`, "link");
		return peer.rpc;
	}

	/** A browser's environment-switch request. Returns the ack's data; throws an Error with a presentable message. */
	async handleHandoff(message: HandoffMessage): Promise<unknown> {
		switch (message.t) {
			case "handoff.plan":
				return this.#handoffs.plan(message.m, message.sessionId, message.targetMachine);
			case "handoff.start":
				return this.#handoffs.start(message.m, message.sessionId, message.targetMachine, message.target);
			case "handoff.confirm":
				await this.#handoffs.confirm(message.id);
				return undefined;
			case "handoff.cancel":
				await this.#handoffs.cancel(message.id);
				return undefined;
			case "handoff.dismiss":
				this.#handoffs.dismiss(message.id);
				return undefined;
		}
	}

	/** The environment switches clients currently see. */
	handoffs(): HandoffWire[] {
		return this.#handoffs.list();
	}

	/** The files of the machines' transcript replicas (also removed with the machine). */
	get replicaFiles(): ReplicaFiles {
		return this.#replicaFiles;
	}

	// -- environments --------------------------------------------------------

	/**
	 * Registers a daemon's link. A second link for the same machine replaces the first (the first may be a half-open
	 * connection the gateway has not noticed yet). Returns the peer the transport feeds frames into.
	 */
	attachEnv(info: EnvRegistrationInfo, link: LinkEnd): EnvPeer {
		const previous = this.#machines.get(info.machineId)?.peer;
		if (previous) {
			this.envGone(previous);
			previous.link.terminate();
		}
		const stored: StoredMachine = {
			id: info.machineId,
			name: info.name,
			nickname: this.#machines.get(info.machineId)?.stored.nickname,
			platform: info.platform,
			home: info.hello.home,
			daemonVersion: info.hello.daemonVersion,
			omp: info.hello.omp,
			...(info.hello.antigravity === undefined ? {} : { antigravity: info.hello.antigravity }),
			leaseWarnings: info.hello.leaseWarnings,
			lastSeen: this.#now(),
		};
		this.#store.upsertMachine(stored);
		const state = this.#machines.get(info.machineId) ?? { stored, peer: null, linkId: 0, broker: null };
		state.stored = stored;
		state.linkId += 1;
		state.broker = null;
		const sync = new ReplicaSync(
			info.machineId,
			this.#store,
			this.#replicaFiles,
			message => link.send(JSON.stringify(message)),
			() => this.replicaChanged(info.machineId),
		);
		const rpc = new PeerRpc(
			message => link.send(JSON.stringify(message)),
			() => link.bufferedAmount(),
			() => this.nameOf(info.machineId),
		);
		const peer = new EnvPeer(info.machineId, state.linkId, link, this, sync, info.acceptsBroker, rpc);
		state.peer = peer;
		this.#machines.set(info.machineId, state);
		for (const conn of this.#browsers) conn.envBack(info.machineId);
		this.#broadcastMachines();
		queueMicrotask(() => this.#handoffs.machineBack(info.machineId));
		return peer;
	}

	/**
	 * The transport finished the handshake and the peer can be spoken to (a daemon only reads link messages after
	 * `registered`): hands it the credential broker when it declared it takes it.
	 */
	peerReady(peer: EnvPeer): void {
		if (peer.acceptsBroker && !peer.detached) this.#sendBrokerConfig(peer.machineId, peer.link);
	}

	/** A link ended (or was replaced). Idempotent. */
	envGone(peer: EnvPeer): void {
		if (peer.detached) return;
		peer.detached = true;
		const state = this.#machines.get(peer.machineId);
		if (!state || state.peer !== peer) return;
		state.peer = null;
		state.broker = null;
		peer.rpc.close(`${this.nameOf(peer.machineId)} went offline`);
		state.stored = { ...state.stored, lastSeen: this.#now() };
		this.#store.touchMachine(peer.machineId, state.stored.lastSeen);
		for (const conn of new Set(peer.clients.values())) conn.envGone(peer.machineId, this.nameOf(peer.machineId));
		peer.clients.clear();
		this.#broadcastMachines();
		this.#handoffs.machineLost(peer.machineId);
	}

	/** Drops a machine's live link (the daemon will dial again). */
	disconnectEnv(machineId: string, reason: string): void {
		const peer = this.#machines.get(machineId)?.peer;
		if (!peer) return;
		this.envGone(peer);
		peer.link.close(1000, reason);
	}

	peerOf(machineId: string): EnvPeer | null | "unknown" {
		const state = this.#machines.get(machineId);
		return state ? state.peer : "unknown";
	}

	nameOf(machineId: string): string {
		const stored = this.#machines.get(machineId)?.stored;
		return stored?.nickname ?? stored?.name ?? machineId;
	}

	/** Changes only the gateway's display override, including for offline machines. */
	setMachineNickname(machineId: string, nickname: string | null): boolean {
		const state = this.#machines.get(machineId);
		if (!state) return false;
		this.#store.setMachineNickname(machineId, nickname);
		state.stored = { ...state.stored, nickname: nickname ?? undefined };
		this.#broadcastMachines();
		return true;
	}

	/** The daemon pushed its session list. */
	sessionsReported(machineId: string, sessions: SessionInfo[]): void {
		const decorated = this.#store.syncSessions(machineId, sessions);
		this.#broadcast({ t: "sessions", m: machineId, sessions: decorated });
	}

	projectsReported(machineId: string, projects: ProjectInfo[]): void {
		this.#store.setProjects(machineId, projects);
		this.#broadcastMachines();
	}

	/** A client read a session; every client's list is re-sent when that changes the unread state. */
	markRead(machineId: string, sessionId: string, report: ReadReport): void {
		if (!this.#machines.has(machineId)) throw new UnknownSessionError(`unknown machine: ${machineId}`);
		if (this.#store.markRead(machineId, sessionId, report)) {
			this.#broadcast({ t: "sessions", m: machineId, sessions: this.#store.sessions(machineId) });
		}
		this.seen(machineId, sessionId);
	}

	/** A client reads or looks at the session: devices that show a notification for it can drop it. */
	seen(machineId: string, sessionId: string): void {
		this.options.attention?.seen(machineId, sessionId);
	}

	/** A hosted session on a machine needs a human (reported over the link). */
	attentionReported(machineId: string, event: AttentionEvent): void {
		this.options.attention?.attention(machineId, event);
	}

	/** Is a visible browser tab currently showing this session? Then there is nothing to notify about. */
	isViewed(machineId: string, sessionId: string): boolean {
		for (const conn of this.#browsers) {
			const view = conn.presence;
			if (view?.visible && view.machine === machineId && view.sessionId === sessionId) return true;
		}
		return false;
	}

	/** The gateway's copy of a session of a machine, ready to serve read-only (the machine is offline). */
	async replicaSession(
		machineId: string,
		sessionId: string,
	): Promise<{ session: StoredSession; replica: ReplicaInfo }> {
		const replica = this.#store.sessions(machineId).find(s => s.id === sessionId)?.replica;
		if (!replica) throw new Error("the gateway holds no copy of this session");
		const conversations = await scanConversations(this.#replicaFiles.dir(machineId));
		const conversation = conversations.find(c => c.memberIds.includes(sessionId));
		if (!conversation) throw new Error("the gateway holds no copy of this session");
		return { session: await StoredSession.open({ conversation, access: "free", replica: true }), replica };
	}

	/** Replica files of a machine changed: its session list (which carries the replica state) is re-sent, batched. */
	replicaChanged(machineId: string): void {
		if (this.#closed || this.#replicaBroadcast.has(machineId)) return;
		const timer = setTimeout(() => {
			this.#replicaBroadcast.delete(machineId);
			this.#broadcast({ t: "sessions", m: machineId, sessions: this.#store.sessions(machineId) });
		}, REPLICA_BROADCAST_MS);
		this.#replicaBroadcast.set(machineId, timer);
	}

	/** A browser connection's `auth.*` request. */
	async handleAuth(connection: BrowserConn, message: AuthMessage): Promise<unknown> {
		if (!this.options.auth) throw new Error("credential management is not available on this gateway");
		return this.options.auth.handle(connection, message);
	}

	/** Sends every machine that takes the broker's token its current `broker.config` (the broker started, stopped or changed). */
	brokerConfigChanged(): void {
		for (const [machineId, state] of this.#machines) {
			if (state.peer?.acceptsBroker) this.#sendBrokerConfig(machineId, state.peer.link);
		}
		this.#broadcastMachines();
	}

	/** A machine reported how it reaches its broker. */
	brokerReported(peer: EnvPeer, status: EnvBrokerStatus): void {
		const state = this.#machines.get(peer.machineId);
		if (!state || state.peer !== peer) return;
		state.broker = status;
		this.#broadcastMachines();
	}

	/** Broadcasts a frame the gateway itself produced (credential state) to every browser. */
	publish(frame: GatewayFrame): void {
		this.#broadcast(frame);
	}

	#sendBrokerConfig(machineId: string, link: LinkEnd): void {
		link.send(JSON.stringify({ t: "broker.config", config: this.options.auth?.brokerConfigFor(machineId) ?? null }));
	}

	/** What the UI shows about a machine's broker: its own report, except that a machine that withheld the token says so. */
	#brokerView(machineId: string, state: MachineState): EnvBrokerStatus | undefined {
		if (!state.peer) return undefined;
		const reported = state.broker ?? undefined;
		if (!state.peer.acceptsBroker && reported?.source !== "local" && this.options.auth?.brokerConfigFor(machineId)) {
			return { source: "none", state: "withheld", message: WITHHELD_MESSAGE, checkedAt: null, lastOkAt: null };
		}
		return reported;
	}

	/** Stops timers; the gateway is shutting down. */
	close(): void {
		this.#handoffs.close();
		this.#closed = true; // a link's last frames may still arrive after this: they must not start timers on a closed store
		for (const timer of this.#replicaBroadcast.values()) clearTimeout(timer);
		this.#replicaBroadcast.clear();
	}

	machines(): MachineSummary[] {
		return [...this.#machines.values()]
			.map((state): MachineSummary => {
				const { stored } = state;
				const broker = this.#brokerView(stored.id, state);
				return {
					id: stored.id,
					name: stored.nickname ?? stored.name,
					...(stored.nickname === undefined ? {} : { originalName: stored.name }),
					platform: stored.platform,
					...(stored.home === undefined ? {} : { home: stored.home }),
					daemonVersion: stored.daemonVersion,
					omp: stored.omp,
					...(stored.antigravity === undefined ? {} : { antigravity: stored.antigravity }),
					leaseWarnings: stored.leaseWarnings,
					online: state.peer !== null,
					linkId: state.linkId,
					lastSeen: stored.lastSeen,
					gateway: stored.id === this.options.selfMachineId,
					projects: this.#store.projects(stored.id),
					...(broker ? { broker } : {}),
				};
			})
			.toSorted((a, b) => Number(b.gateway) - Number(a.gateway) || a.name.localeCompare(b.name));
	}

	// -- browsers ------------------------------------------------------------

	attachBrowser(socket: BrowserSocket, identity?: BrowserIdentity): BrowserConn {
		const conn = new BrowserConn(this, socket, this.#limits, this.#heartbeat, identity);
		this.#browsers.add(conn);
		const frames: GatewayFrame[] = [
			{
				t: "hello",
				protocol: PROTOCOL_VERSION,
				gatewayVersion: this.options.gatewayVersion,
				machine: this.options.selfMachineId,
			},
			{ t: "machines", machines: this.machines() },
			...(this.options.auth?.frames() ?? []),
			{ t: "handoff.state", handoffs: this.#handoffs.list() },
		];
		for (const id of this.#machines.keys()) frames.push({ t: "sessions", m: id, sessions: this.#store.sessions(id) });
		conn.start(frames);
		return conn;
	}

	/** A login was signed out: its open connections end (they reconnect, and are refused at the door). */
	revokeLogin(id: string): void {
		for (const conn of this.#browsers) if (conn.identity?.id === id) conn.kick("signed out");
	}

	detachBrowser(conn: BrowserConn): void {
		this.#browsers.delete(conn);
		conn.close();
		this.options.auth?.released(conn);
	}

	get browserCount(): number {
		return this.#browsers.size;
	}

	#broadcast(frame: GatewayFrame): void {
		for (const conn of this.#browsers) conn.sendGateway(frame);
	}

	#broadcastMachines(): void {
		this.#broadcast({ t: "machines", machines: this.machines() });
	}
}
