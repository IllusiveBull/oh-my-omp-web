import {
	type Ack,
	type AuthAccountsWire,
	type AuthMessage,
	type BrokerStatus,
	type BrowserMessage,
	type ClientMessage,
	type GatewayHello,
	type GatewaySessionInfo,
	Heartbeat,
	type HandoffMessage,
	type HandoffWire,
	type LoginFlowWire,
	type HeartbeatOptions,
	isServerMessage,
	type MachineSummary,
	type ReadMessage,
	type ServerMessage,
	SnapshotAssembler,
	type UsageWire,
} from "@omp-web/protocol";
import { ackedReplica } from "../lib/ack";
import { probeSession, type SessionCheck } from "../lib/auth";
import { SessionStore } from "./session-store";
import { type NotificationSound, soundOfEvent } from "../lib/notification-sound";

export type ConnectionPhase = "connecting" | "open" | "reconnecting";

/** Credentials as the gateway last reported them (frames `auth.*`, each replaced wholesale). */
export interface AuthViewState {
	/** The managed broker; null until the gateway's first `auth.broker` frame. */
	broker: BrokerStatus | null;
	accounts: AuthAccountsWire;
	/** The sign-in in progress or just finished, the same for every client. */
	flow: LoginFlowWire | null;
	usage: UsageWire;
}

export interface DaemonState {
	phase: ConnectionPhase;
	hello: GatewayHello | null;
	/** Every machine the gateway knows, offline ones with their cached projects. Replaced wholesale by the gateway. */
	machines: readonly MachineSummary[];
	/** Session list per machine id; an offline machine's list is the gateway's cached copy. */
	sessions: Readonly<Record<string, readonly GatewaySessionInfo[]>>;
	auth: AuthViewState;
	/** The environment switches in progress and recently finished, replaced wholesale by each `handoff.state` frame. */
	handoffs: readonly HandoffWire[];
}

/** What the browser knows before the gateway has said anything about credentials. */
export const EMPTY_AUTH: AuthViewState = {
	broker: null,
	accounts: { providers: null, accounts: [], disabled: [], error: null, loadedAt: null, migration: null },
	flow: null,
	usage: { fetchedAt: null, generatedAt: null, reports: [], error: null },
};

/** `AuthMessage` minus what the client assigns (`reqId`). */
export type AuthRequest = AuthMessage extends infer M ? (M extends AuthMessage ? Omit<M, "reqId"> : never) : never;

/** `HandoffMessage` minus what the client assigns (`reqId`). */
export type HandoffRequest = HandoffMessage extends infer M
	? M extends HandoffMessage
		? Omit<M, "reqId">
		: never
	: never;

/** `ClientMessage` minus what the client assigns (`reqId`); the machine is a separate argument. */
export type ClientRequest = ClientMessage extends infer M
	? M extends ClientMessage
		? Omit<M, "reqId">
		: never
	: never;

/** Where a client has read a session up to (see `ReadMessage`). */
type ReadPosition = Omit<ReadMessage, "t" | "reqId" | "m" | "sessionId">;

export interface DaemonClientOptions {
	socketFactory?: (url: string) => WebSocket;
	reconnect?: Partial<{ minMs: number; maxMs: number }>;
	heartbeat?: Pick<HeartbeatOptions, "intervalMs" | "timeoutMs" | "now">;
	/** Asked whenever the socket is lost; `"expired"` stops reconnecting and reloads. Defaults to `GET /api/session`. */
	authProbe?: () => Promise<SessionCheck>;
	/** Called when the session expired (the gateway answers a reload with the login page). Defaults to `location.reload()`. */
	reload?: () => void;
	/** Fresh events of subscribed sessions only; snapshots and reconnect replay never notify. */
	onSound?: (sound: NotificationSound) => void;
}

/** What this client last told the gateway it is looking at (see `ViewMessage`). */
interface Presence {
	machine: string;
	sessionId: string | null;
	visible: boolean;
}

/** One session of one machine, as the client keeps it. */
interface Replica {
	key: string;
	machine: string;
	id: string;
	store: SessionStore;
}

const DEFAULT_RECONNECT = { minMs: 500, maxMs: 5_000 };
const REQUEST_TIMEOUT_MS = 90_000;
const OFFLINE = "machine offline";

/** Sessions are only unique per machine, so everything is keyed by both. */
const keyOf = (machine: string, sessionId: string): string => `${machine}/${sessionId}`;

/**
 * Connection to the gateway: request/ack plumbing, heartbeat, automatic reconnect, and one {@link SessionStore} per
 * opened session of a machine. The gateway relays frames to the machines' daemons and keeps no memory of this client's
 * subscriptions across a reconnect, so every wanted session is resubscribed with its own `lastSeq` (the daemon then
 * replays only what was missed, or sends a snapshot) whenever the WebSocket reconnected, or a machine registers again
 * (its `linkId` changed). While a machine is offline, a wanted session the gateway holds a copy of (`replica` in the
 * list) is still subscribed, through the gateway, and served read-only from that copy.
 */
export class DaemonClient {
	#ws: WebSocket | null = null;
	#heartbeat: Heartbeat | null = null;
	#state: DaemonState = {
		phase: "connecting",
		hello: null,
		machines: [],
		sessions: {},
		auth: EMPTY_AUTH,
		handoffs: [],
	};
	#listeners = new Set<() => void>();
	#pending = new Map<string, { resolve: (ack: Ack) => void; timer: ReturnType<typeof setTimeout> }>();
	#replicas = new Map<string, Replica>();
	/** Snapshot frames in flight, per session: frames of different sessions interleave. */
	#assemblers = new Map<string, SnapshotAssembler>();
	/** Sessions whose subscribe was acked on the current socket and link. */
	#live = new Set<string>();
	/** Sessions whose sub-agents the UI watches; the daemon forgets it with the link, so it is re-sent on resubscribe. */
	#agentsWatched = new Set<string>();
	/** Sessions the UI currently wants live updates for. */
	#wanted = new Set<string>();
	/** The `linkId` each machine's wanted sessions were last subscribed under on this socket. */
	#subscribedLink = new Map<string, number>();
	/** True once this socket delivered a `machines` frame: before that the machine list is a stale copy. */
	#machinesFresh = false;
	/** The Accounts page is open: the gateway keeps its lists fresh while a connection says so, so it is re-sent per socket. */
	#accountsOpen = false;
	/** Wanted sessions of offline machines that are subscribed through the gateway's copy (not the machine). */
	#viaGateway = new Set<string>();
	/** Last presence reported through {@link reportView}, and what became of sending it on the current socket. */
	#presence: Presence | null = null;
	#presenceSync: { presence: Presence; ws: WebSocket; result: Promise<boolean> } | null = null;
	/** `modifiedAt` of the newest read position reported per session, so the same state is not reported twice. */
	#reported = new Map<string, number>();
	/** Incremented per `connect()`: a new socket means the daemon forgot every terminal attachment of this client. */
	#generation = 0;
	#frameListeners = new Set<(frame: ServerMessage) => void>();
	#seq = 0;
	#backoff: number;
	readonly #reconnect: { minMs: number; maxMs: number };
	readonly #socketFactory: (url: string) => WebSocket;
	readonly #heartbeatOptions: DaemonClientOptions["heartbeat"];
	readonly #authProbe: () => Promise<SessionCheck>;
	readonly #reload: () => void;
	readonly #onSound: DaemonClientOptions["onSound"];
	#retry: ReturnType<typeof setTimeout> | null = null;
	#closed = false;

	constructor(
		private readonly url: string,
		options: DaemonClientOptions = {},
	) {
		this.#socketFactory = options.socketFactory ?? (socketUrl => new WebSocket(socketUrl));
		this.#reconnect = { ...DEFAULT_RECONNECT, ...options.reconnect };
		this.#heartbeatOptions = options.heartbeat;
		this.#authProbe = options.authProbe ?? (() => probeSession());
		this.#reload = options.reload ?? (() => location.reload());
		this.#onSound = options.onSound;
		this.#backoff = this.#reconnect.minMs;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): DaemonState => this.#state;

	connect(): void {
		this.#generation++;
		const ws = this.#socketFactory(this.url);
		this.#ws = ws;
		const heartbeat = new Heartbeat({
			send: frame => ws.send(frame),
			// A half-open socket may never report its close: treat it as closed now and ignore it from here on.
			onDead: () => {
				this.#lost(ws);
				ws.close();
			},
			...this.#heartbeatOptions,
		});
		this.#heartbeat = heartbeat;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#backoff = this.#reconnect.minMs;
			heartbeat.start();
			this.#setState({ phase: "open" });
			if (this.#accountsOpen) void this.authRequest({ t: "auth.watch", open: true });
			// Subscriptions follow the gateway's `machines` frame: only it says which machines are online and under which link.
		};
		ws.onmessage = event => {
			if (this.#ws !== ws) return;
			const frame = String(event.data);
			if (heartbeat.receive(frame)) return;
			let message: unknown;
			try {
				message = JSON.parse(frame);
			} catch {
				return;
			}
			if (isServerMessage(message)) this.#onMessage(message);
		};
		ws.onclose = () => this.#lost(ws);
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#retry ?? undefined);
		this.#retry = null;
		this.#ws?.close();
	}

	/**
	 * Fire-and-forget request for the machine's daemon (`reqId: ""`, no ack awaited): terminal input, resize, ack and
	 * detach. False when the socket is not open or the machine is offline; nothing is sent then.
	 */
	post(machine: string, request: ClientRequest): boolean {
		const ws = this.#ws;
		if (!ws || ws.readyState !== WebSocket.OPEN || !this.#isOnline(machine)) return false;
		ws.send(JSON.stringify({ ...request, reqId: "", m: machine }));
		return true;
	}

	/** Called for every `term.*` frame the gateway relays (the frame carries `m`). */
	onFrame = (listener: (frame: ServerMessage) => void): (() => void) => {
		this.#frameListeners.add(listener);
		return () => this.#frameListeners.delete(listener);
	};

	/**
	 * Identifies the link to a machine's daemon as this client sees it: changes whenever the socket reconnected or the
	 * machine registered again, `null` while requests cannot be sent (socket not open, list stale, machine offline).
	 */
	linkKey(machine: string): string | null {
		if (!this.#isOnline(machine)) return null;
		return `${this.#generation}:${this.#machine(machine)?.linkId}`;
	}

	/** The replica of session `id` of `machine` (created on first use). Pure lookup: safe to call during render. */
	store(machine: string, id: string): SessionStore {
		return this.#replica(machine, id).store;
	}

	/** Starts live updates for the session (subscribing now, and again after every reconnect or machine re-registration). */
	open(machine: string, id: string): SessionStore {
		const replica = this.#replica(machine, id);
		if (!this.#wanted.has(replica.key)) {
			this.#wanted.add(replica.key);
			this.#start(replica);
		}
		return replica.store;
	}

	/** Stops live updates; the replica is kept so reopening resumes from its `lastSeq`. */
	release(machine: string, id: string): void {
		const key = keyOf(machine, id);
		if (!this.#wanted.delete(key)) return;
		this.#assemblers.delete(key);
		this.setAgentsWatched(machine, id, false);
		this.#live.delete(key);
		void this.#relay(machine, { t: "unsubscribe", sessionId: id }, REQUEST_TIMEOUT_MS, this.#viaGateway.delete(key));
	}

	/**
	 * Tells the daemon whether this client watches the session's sub-agents. The request goes out once the session is
	 * subscribed on the current link, and again after every resubscribe for as long as the watch lasts.
	 */
	setAgentsWatched(machine: string, id: string, open: boolean): void {
		const key = keyOf(machine, id);
		if (open) this.#agentsWatched.add(key);
		else this.#agentsWatched.delete(key);
		if (this.#live.has(key)) void this.request(machine, { t: "session.agents", sessionId: id, open });
	}

	/** Sends `request` to the machine's daemon through the gateway. An offline machine fails at once, nothing is sent. */
	request(machine: string, request: ClientRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Ack> {
		return this.#relay(machine, request, timeoutMs, false);
	}

	/** Sends a credential request (`auth.*`) to the gateway; there is no machine, the vault is the gateway's. */
	authRequest(request: AuthRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Ack> {
		return this.#send(reqId => ({ ...request, reqId }) as AuthMessage, timeoutMs);
	}

	/**
	 * Sends an environment-switch request (`handoff.*`) to the gateway, which orchestrates both machines. `plan` acks a
	 * `HandoffPlan` in `data`, `start` acks `{ id }`; progress arrives in {@link DaemonState.handoffs}.
	 */
	handoffRequest(request: HandoffRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Ack> {
		return this.#send(reqId => ({ ...request, reqId }) as HandoffMessage, timeoutMs);
	}

	/**
	 * Tells the gateway whether the Accounts page is open here. While any client has it open the gateway keeps the
	 * provider/account lists and the usage fresh (and stops when none does); it forgets this with the socket, so it is
	 * sent again whenever the socket reopens.
	 */
	setAccountsOpen(open: boolean): void {
		if (this.#accountsOpen === open) return;
		this.#accountsOpen = open;
		void this.authRequest({ t: "auth.watch", open });
	}

	/**
	 * Tells the gateway which session this client is looking at and whether its page is visible, so the gateway does not
	 * notify a thread somebody is reading. Re-sent whenever a socket opens (a new connection starts with no presence);
	 * the same state is not sent twice on one socket, and a failed send is retried at the next call or reconnect.
	 * `sessionId: null` = no session open. Resolves to whether the gateway acked the current state.
	 */
	reportView(machine: string, sessionId: string | null, visible: boolean): Promise<boolean> {
		const last = this.#presence;
		if (!last || last.machine !== machine || last.sessionId !== sessionId || last.visible !== visible) {
			this.#presence = { machine, sessionId, visible };
		}
		return this.#syncPresence();
	}

	/**
	 * Reports that the user is reading the session up to the replica's current position, so every client sees it as
	 * read. Sent only when the user can actually see the transcript (`visible`, snapshot present, machine online, or the
	 * snapshot is the gateway's copy and the gateway reachable) and only for a session state (`modifiedAt`) newer than
	 * what was reported before. Resolves to whether it was sent and
	 * acked; a failed report is forgotten so the next trigger retries.
	 */
	async reportRead(
		machine: string,
		info: Pick<GatewaySessionInfo, "id" | "modifiedAt">,
		visible: boolean,
	): Promise<boolean> {
		const key = keyOf(machine, info.id);
		const replica = this.#replicas.get(key);
		const state = replica?.store.getSnapshot();
		if (!replica || !state || !visible || state.loading || state.lost !== null) return false;
		if (!this.#isOnline(machine) && !(state.replica !== null && this.#gatewayReady())) return false;
		if (info.modifiedAt <= (this.#reported.get(key) ?? 0)) return false;
		this.#reported.set(key, info.modifiedAt);
		const position: ReadPosition = {
			seq: replica.store.lastSeq,
			epoch: replica.store.epoch ?? undefined,
			modifiedAt: info.modifiedAt,
		};
		const ack = await this.#send(reqId => ({ t: "read", reqId, m: machine, sessionId: info.id, ...position }));
		if (!ack.ok && this.#reported.get(key) === info.modifiedAt) this.#reported.delete(key);
		return ack.ok;
	}

	#replica(machine: string, id: string): Replica {
		const key = keyOf(machine, id);
		let replica = this.#replicas.get(key);
		if (!replica) {
			replica = { key, machine, id, store: new SessionStore(id) };
			this.#replicas.set(key, replica);
		}
		return replica;
	}

	#replicasOf(machine: string): Replica[] {
		return [...this.#replicas.values()].filter(r => r.machine === machine);
	}

	#machine(id: string): MachineSummary | undefined {
		return this.#state.machines.find(m => m.id === id);
	}

	/** The socket is open and the machine list is this socket's own. */
	#gatewayReady(): boolean {
		return this.#ws !== null && this.#state.phase === "open" && this.#machinesFresh;
	}

	/** Requests for this machine can be sent now: socket open, machine list current, machine registered. */
	#isOnline(machine: string): boolean {
		return this.#gatewayReady() && this.#machine(machine)?.online === true;
	}

	/** The gateway's copy of the session, as the machine's session list announces it. */
	#hasCopy(replica: Replica): boolean {
		return this.#state.sessions[replica.machine]?.find(s => s.id === replica.id)?.replica !== undefined;
	}

	/** Like {@link request}; `offlineOk` lets it through to the gateway even though the machine is offline. */
	#relay(machine: string, request: ClientRequest, timeoutMs: number, offlineOk: boolean): Promise<Ack> {
		const info = this.#machine(machine);
		if (!offlineOk && this.#machinesFresh && info && !info.online) {
			return Promise.resolve({ t: "ack", reqId: "", ok: false, error: `machine ${info.name} is offline` });
		}
		return this.#send(reqId => ({ ...request, reqId, m: machine }), timeoutMs);
	}

	#syncPresence(): Promise<boolean> {
		const presence = this.#presence;
		const ws = this.#ws;
		if (!presence || !ws) return Promise.resolve(false);
		const current = this.#presenceSync;
		if (current?.presence === presence && current.ws === ws) return current.result;
		const result = this.#send(reqId => ({
			t: "view",
			reqId,
			m: presence.machine,
			sessionId: presence.sessionId,
			visible: presence.visible,
		})).then(ack => {
			if (!ack.ok && this.#presenceSync?.result === result) this.#presenceSync = null; // retried at the next trigger
			return ack.ok;
		});
		this.#presenceSync = { presence, ws, result };
		return result;
	}

	/** Gets a newly wanted replica going, as far as the current knowledge of its machine allows. */
	#start(replica: Replica): void {
		if (!this.#machinesFresh) return; // the machines frame of this socket reconciles it
		const machine = this.#machine(replica.machine);
		if (!machine) replica.store.markLost(`unknown machine ${replica.machine}`);
		else if (!machine.online) this.#park(replica);
		else void this.#subscribe(replica);
	}

	/** The machine is offline: nothing live can happen; the gateway's copy, when there is one, is shown instead. */
	#park(replica: Replica): void {
		replica.store.setWaiting(OFFLINE);
		if (!this.#viaGateway.has(replica.key)) {
			this.#live.delete(replica.key);
			this.#assemblers.delete(replica.key);
		}
		this.#subscribeCopy(replica);
	}

	/**
	 * Subscribes a wanted session of an offline machine through the gateway's copy, once. A session that already holds
	 * the machine's own data keeps it (the copy can only be as old or older) and just waits.
	 */
	#subscribeCopy(replica: Replica): void {
		if (!this.#wanted.has(replica.key) || this.#viaGateway.has(replica.key) || !this.#hasCopy(replica)) return;
		const { epoch, replica: served } = replica.store.getSnapshot();
		if (epoch !== null && served === null) return;
		void this.#subscribeViaGateway(replica);
	}

	/**
	 * Brings subscriptions in line with the machine list: an offline machine parks its sessions (replicas stay, nothing
	 * is sent); a machine seen online under a link this client has not subscribed under yet gets every wanted session
	 * (re)subscribed, since its daemon-side state belonged to the old link.
	 */
	#reconcile(): void {
		for (const machine of this.#state.machines) {
			if (!machine.online) {
				this.#subscribedLink.delete(machine.id);
				for (const replica of this.#replicasOf(machine.id)) this.#park(replica);
				continue;
			}
			if (this.#subscribedLink.get(machine.id) === machine.linkId) continue;
			this.#subscribedLink.set(machine.id, machine.linkId);
			this.#forgetLive(machine.id);
			for (const replica of this.#replicasOf(machine.id)) {
				this.#viaGateway.delete(replica.key);
				// The copy's position means nothing to the machine: ask for a full snapshot, which replaces the copy.
				if (replica.store.getSnapshot().replica !== null) replica.store.resetSeq();
				replica.store.setWaiting(null);
				if (this.#wanted.has(replica.key)) void this.#subscribe(replica);
			}
		}
		for (const key of this.#wanted) {
			const replica = this.#replicas.get(key);
			if (replica && !this.#machine(replica.machine)) replica.store.markLost(`unknown machine ${replica.machine}`);
		}
	}

	#forgetLive(machine: string): void {
		for (const replica of this.#replicasOf(machine)) {
			this.#live.delete(replica.key);
			this.#assemblers.delete(replica.key);
		}
	}

	async #subscribe(replica: Replica): Promise<void> {
		const { key, machine, id, store } = replica;
		const ws = this.#ws;
		const link = this.#subscribedLink.get(machine);
		const ack = await this.request(machine, {
			t: "subscribe",
			sessionId: id,
			lastSeq: store.lastSeq,
			epoch: store.epoch ?? undefined,
		});
		// The socket or the machine's link changed while waiting: whatever replaced them subscribes again.
		if (!this.#wanted.has(key) || this.#ws !== ws || this.#subscribedLink.get(machine) !== link) return;
		if (!ack.ok) {
			store.markLost(ack.error);
			return;
		}
		this.#live.add(key);
		store.setReplica(ackedReplica(ack.data));
		if (this.#agentsWatched.has(key)) void this.request(machine, { t: "session.agents", sessionId: id, open: true });
	}

	/**
	 * Subscribes through the gateway while the machine is offline: it answers from its copy of the transcript, always
	 * with a snapshot (never a replay), and the ack says how complete and how old that copy is.
	 */
	async #subscribeViaGateway(replica: Replica): Promise<void> {
		const { key, machine, id, store } = replica;
		const ws = this.#ws;
		this.#viaGateway.add(key);
		const ack = await this.#relay(machine, { t: "subscribe", sessionId: id, lastSeq: 0 }, REQUEST_TIMEOUT_MS, true);
		// Closed, socket replaced, or the machine came back (which resubscribes live) while waiting.
		if (!this.#wanted.has(key) || this.#ws !== ws || !this.#viaGateway.has(key)) return;
		if (!ack.ok) {
			store.markLost(ack.error);
			return;
		}
		store.setReplica(ackedReplica(ack.data));
	}

	#send(build: (reqId: string) => BrowserMessage, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Ack> {
		const ws = this.#ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return Promise.resolve({ t: "ack", reqId: "", ok: false, error: "not connected" });
		}
		const reqId = `c${++this.#seq}`;
		return new Promise<Ack>(resolve => {
			const timer = setTimeout(() => {
				this.#pending.delete(reqId);
				resolve({ t: "ack", reqId, ok: false, error: "request timed out" });
			}, timeoutMs);
			this.#pending.set(reqId, { resolve, timer });
			ws.send(JSON.stringify(build(reqId)));
		});
	}

	/** The socket is gone (closed, or silent for too long): drop everything tied to it and schedule the reconnect. */
	#lost(ws: WebSocket): void {
		if (this.#ws !== ws) return;
		this.#ws = null;
		this.#heartbeat?.stop();
		this.#heartbeat = null;
		this.#assemblers.clear();
		this.#live.clear();
		this.#subscribedLink.clear();
		this.#viaGateway.clear();
		this.#machinesFresh = false;
		for (const [reqId, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.resolve({ t: "ack", reqId, ok: false, error: "connection lost" });
		}
		this.#pending.clear();
		if (this.#closed) return;
		this.#setState({ phase: "reconnecting" });
		void this.#checkSession();
		this.#retry = setTimeout(() => this.connect(), this.#backoff);
		this.#backoff = Math.min(this.#backoff * 2, this.#reconnect.maxMs);
	}

	/** A rejected session cookie makes reconnecting pointless: reload to get the gateway's login page. */
	async #checkSession(): Promise<void> {
		const result = await this.#authProbe();
		if (result !== "expired" || this.#closed || this.#state.phase === "open") return;
		this.close();
		this.#reload();
	}

	#onMessage(message: ServerMessage): void {
		if (message.t.startsWith("term.")) for (const listener of Array.from(this.#frameListeners)) listener(message);
		switch (message.t) {
			case "hello":
				// A new connection starts from what the gateway sends next: a list kept from the old socket must not outlive it.
				this.#setState({ hello: message, handoffs: [] });
				break;
			case "handoff.state":
				this.#setState({ handoffs: message.handoffs });
				break;
			case "machines":
				this.#machinesFresh = true;
				this.#setState({ machines: message.machines });
				this.#reconcile();
				if (this.#presence) void this.#syncPresence(); // a new connection starts with no presence
				break;
			case "auth.broker":
				this.#setAuth({ broker: message.broker });
				break;
			case "auth.accounts": {
				const { t: _t, ...accounts } = message;
				this.#setAuth({ accounts });
				break;
			}
			case "auth.flow":
				this.#setAuth({ flow: message.flow });
				break;
			case "auth.usage": {
				const { t: _t, ...usage } = message;
				this.#setAuth({ usage });
				break;
			}
			case "sessions":
				this.#setState({ sessions: { ...this.#state.sessions, [message.m]: message.sessions } });
				// A session of an offline machine may just have been announced as copied: its copy can be opened now.
				if (this.#machinesFresh && this.#machine(message.m)?.online === false) {
					for (const replica of this.#replicasOf(message.m)) this.#subscribeCopy(replica);
				}
				break;
			case "ack": {
				const pending = this.#pending.get(message.reqId);
				if (!pending) break;
				this.#pending.delete(message.reqId);
				clearTimeout(pending.timer);
				pending.resolve(message);
				break;
			}
			case "snapshot.begin":
			case "snapshot.chunk":
			case "snapshot.end":
				this.#onSnapshotFrame(message);
				break;
			case "events": {
				const key = keyOf(message.m, message.sessionId);
				const store = this.#replicas.get(key)?.store;
				if (!store) break;
				let lastSeq = store.lastSeq;
				if (this.#onSound && this.#live.has(key) && !this.#viaGateway.has(key)) {
					for (const { seq, ev } of message.events) {
						if (seq <= lastSeq) continue;
						lastSeq = seq;
						const sound = soundOfEvent(ev);
						if (sound) this.#onSound(sound);
					}
				}
				store.applyEvents(message.events);
				break;
			}
		}
	}

	/** A snapshot reaches the store only when its `end` frame has arrived and the entry count checks out. */
	#onSnapshotFrame(frame: Extract<ServerMessage, { t: "snapshot.begin" | "snapshot.chunk" | "snapshot.end" }>): void {
		const key = keyOf(frame.m, frame.sessionId);
		const replica = this.#replicas.get(key);
		if (!replica) return;
		let assembler = this.#assemblers.get(key);
		if (!assembler) {
			assembler = new SnapshotAssembler();
			this.#assemblers.set(key, assembler);
		}
		const result = assembler.push(frame);
		if (result === null) return;
		if (result === "incomplete") {
			replica.store.resetSeq();
			if (!this.#wanted.has(key)) return;
			if (this.#isOnline(replica.machine)) void this.#subscribe(replica);
			else if (this.#viaGateway.has(key)) void this.#subscribeViaGateway(replica);
			return;
		}
		// A snapshot of a machine that is online is the machine's own, whatever the copy it replaces was.
		if (this.#machine(replica.machine)?.online === true) replica.store.setReplica(null);
		replica.store.applySnapshot(result.seq, result.epoch, result.snapshot);
	}

	#setAuth(patch: Partial<AuthViewState>): void {
		this.#setState({ auth: { ...this.#state.auth, ...patch } });
	}

	#setState(patch: Partial<DaemonState>): void {
		this.#state = { ...this.#state, ...patch };
		for (const listener of this.#listeners) listener();
	}
}
