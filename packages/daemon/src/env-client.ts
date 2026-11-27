import {
	parseClientMessage,
	snapshotFrames,
	type BrokerLinkConfig,
	type ClientMessage,
	type EnvFrame,
	type FilesClientMessage,
	type ImageWire,
	type ProjectInfo,
	type SequencedEvent,
	type SessionSearchAck,
	isTerminalOneway,
	isTerminalType,
	type TerminalClientMessage,
} from "@omp-web/protocol";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { FileError } from "./file-path";
import type { HandoffPort } from "./handoff-service";
import type { FileService } from "./file-service";
import { SessionActionError, type SessionManager } from "./manager";
import { DEFAULT_OUTBOX_LIMITS, Outbox, type OutboxLimits, type OutboxSocket } from "./outbox";
import type { ProjectRegistry } from "./projects";
import type { HostedSession } from "./session";
import { TerminalError, type TerminalPort, type TerminalService, type TerminalSocket } from "./terminal-service";

export interface EnvClientOptions {
	/** Max delay between flushed `message_update` snapshots per client (ms). */
	updateIntervalMs?: number;
	/** Per-client backpressure limits, see `Outbox`. */
	outbox?: OutboxLimits;
	/** Approximate size cap of one `snapshot.chunk` / replayed `events` frame (bytes). */
	frameBytes?: number;
	/** How this client's terminal frames travel (priority lane) and who it is for the audit log; none: no terminals. */
	terminal?: { socket: TerminalSocket; who?: string };
}

/** What a client needs from the daemon it is a client of. */
export interface ClientHost {
	readonly manager: SessionManager;
	readonly projects: ProjectRegistry;
	/** Read-only file access to the registered worktrees. */
	readonly files: FileService;
	/** Persistent shells of this machine (disabled unless the operator enabled them). */
	readonly terminals: TerminalService;
	/** Environment switches (the gateway's `op` messages); absent: this daemon refuses them. */
	readonly handoff?: HandoffPort;
	/** A client re-read the projects (worktrees may have changed): tell the gateway. */
	projectsRefreshed(projects: ProjectInfo[]): void;
	/** The gateway handed over (or withdrew) the credential broker this machine's omp processes should use. */
	brokerConfig(config: BrokerLinkConfig | null): void;
}

interface Subscription {
	unsubscribe: () => void;
	/** Latest unsent streaming snapshot; only the newest matters. */
	pendingUpdate: SequencedEvent | null;
	timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_FRAME_BYTES = 256 * 1024;
/** File requests one client may have running, and the reply bytes it may have queued (a file page is ~256 KiB). */
const MAX_FILE_REQUESTS = 4;
const MAX_FILE_BACKLOG_BYTES = 2 * 1024 * 1024;

/** Splits `events` into serialized `events` frames of about `maxBytes` each (one oversized event travels alone). */
/** A message's pasted images as omp's `prompt` / `steer` / `follow_up` take them. */
function imagesOf(images: ImageWire[] | undefined): ImageContent[] | undefined {
	return images?.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

function eventFrames(sessionId: string, events: SequencedEvent[], maxBytes: number): string[] {
	const prefix = `{"t":"events","sessionId":${JSON.stringify(sessionId)},"events":[`;
	const frames: string[] = [];
	let parts: string[] = [];
	let bytes = 0;
	for (const event of events) {
		const json = JSON.stringify(event);
		if (parts.length > 0 && bytes + json.length > maxBytes) {
			frames.push(`${prefix}${parts.join(",")}]}`);
			parts = [];
			bytes = 0;
		}
		parts.push(json);
		bytes += json.length;
	}
	if (parts.length > 0) frames.push(`${prefix}${parts.join(",")}]}`);
	return frames;
}

/**
 * One client of the daemon's session protocol: its subscriptions, its sub-agent panels, its outbound queue. In gateway
 * mode every browser connection is one of these per machine (a "virtual client", fed through the link); the policy for
 * a slow reader is unchanged: everything goes through the {@link Outbox}, whose socket is the link and which the
 * gateway pauses while the browser's own socket is backed up.
 */
export class EnvClient {
	readonly #subs = new Map<string, Subscription>();
	/** Sessions whose sub-agent panel this client has open (see `session.agents`). */
	readonly #panels = new Set<string>();
	readonly #outbox: Outbox;
	readonly #terminal: TerminalPort | null;
	readonly #terminalSocket: TerminalSocket | undefined;
	#fileRequests = 0;
	readonly #updateIntervalMs: number;
	readonly #frameBytes: number;

	constructor(
		private readonly host: ClientHost,
		socket: OutboxSocket,
		options: EnvClientOptions = {},
	) {
		this.#updateIntervalMs = options.updateIntervalMs ?? 33;
		this.#frameBytes = options.frameBytes ?? DEFAULT_FRAME_BYTES;
		this.#terminalSocket = options.terminal?.socket;
		this.#terminal = options.terminal ? host.terminals.port(options.terminal.socket, options.terminal.who) : null;
		// The client fell too far behind and its queued events were dropped: start it over with snapshots.
		this.#outbox = new Outbox(
			socket,
			ids => {
				for (const id of ids) this.resubscribe(id);
			},
			options.outbox ?? DEFAULT_OUTBOX_LIMITS,
		);
	}

	/** Called when the transport can take more frames again. */
	pump(): void {
		this.#outbox.pump();
		this.#terminal?.pump();
	}

	/** Releases everything this client holds in the daemon (its connection is gone). */
	dispose(): void {
		this.#terminal?.dispose();
		for (const id of Array.from(this.#panels)) this.#closePanel(id);
		for (const id of this.#subs.keys()) this.#drop(id);
	}

	/** A session id now names a different object (stored <-> hosted) or the client is behind: send a fresh snapshot. */
	resubscribe(sessionId: string): void {
		if (!this.#subs.has(sessionId)) return;
		void this.#subscribeTo(sessionId, 0, undefined).catch(() => this.#drop(sessionId));
	}

	/** One frame from the client. Always answers with an ack, success or failure. */
	async receive(text: string): Promise<void> {
		let msg: ClientMessage;
		try {
			msg = parseClientMessage(text);
		} catch (error) {
			let reqId = "";
			try {
				const raw = JSON.parse(text) as { reqId?: unknown };
				if (typeof raw.reqId === "string") reqId = raw.reqId;
			} catch {
				// not JSON: no reqId to echo
			}
			this.#send({ t: "ack", reqId, ok: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (isTerminalType(msg.t)) {
			await this.#receiveTerminal(msg as TerminalClientMessage);
			return;
		}
		try {
			const data = await this.#handle(msg);
			this.#send({ t: "ack", reqId: msg.reqId, ok: true, ...(data === undefined ? {} : { data }) });
		} catch (error) {
			this.#send({
				t: "ack",
				reqId: msg.reqId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				...(error instanceof SessionActionError && error.code ? { code: error.code } : {}),
				...(error instanceof FileError ? { code: error.code } : {}),
			});
		}
	}

	/**
	 * A `term.*` request. Its ack travels the priority lane like the terminal's own frames (so an attach is acknowledged
	 * before its first output); one-way requests (input, resize, ack, detach) are answered only when they fail.
	 */
	async #receiveTerminal(msg: TerminalClientMessage): Promise<void> {
		const reply = (frame: EnvFrame): void => {
			const text = JSON.stringify(frame);
			if (this.#terminalSocket) this.#terminalSocket.sendPriority(text);
			else this.#outbox.control(text);
		};
		try {
			if (!this.#terminal) throw new TerminalError("terminals are not available on this connection");
			const data = await this.#terminal.handle(msg);
			if (!isTerminalOneway(msg.t)) {
				reply({ t: "ack", reqId: msg.reqId, ok: true, ...(data === undefined ? {} : { data }) });
			}
		} catch (error) {
			reply({
				t: "ack",
				reqId: msg.reqId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				...(error instanceof TerminalError && error.code ? { code: error.code } : {}),
			});
		}
	}

	#send(frame: EnvFrame): void {
		this.#outbox.control(JSON.stringify(frame));
	}

	#flushUpdate(sessionId: string, sub: Subscription): void {
		clearTimeout(sub.timer ?? undefined);
		sub.timer = null;
		const pending = sub.pendingUpdate;
		sub.pendingUpdate = null;
		// A streaming snapshot supersedes the previous one: a client that is falling behind only keeps the newest.
		if (pending) {
			const frame = eventFrames(sessionId, [pending], Number.MAX_SAFE_INTEGER)[0]!;
			this.#outbox.coalesced(`stream:${sessionId}`, frame, sessionId);
		}
	}

	/** Live delivery: immediate, except streaming snapshots, which collapse to one per interval. */
	#deliver(sessionId: string, sub: Subscription, events: SequencedEvent[]): void {
		const out: SequencedEvent[] = [];
		for (const event of events) {
			const isUpdate = event.ev.k === "agent" && event.ev.event.type === "message_update";
			if (isUpdate) {
				sub.pendingUpdate = event;
				sub.timer ??= setTimeout(() => this.#flushUpdate(sessionId, sub), this.#updateIntervalMs);
				continue;
			}
			const supersedesUpdate = event.ev.k === "agent" && event.ev.event.type === "message_end";
			if (sub.pendingUpdate) {
				if (supersedesUpdate) {
					sub.pendingUpdate = null;
					clearTimeout(sub.timer ?? undefined);
					sub.timer = null;
				} else {
					out.push(sub.pendingUpdate);
					sub.pendingUpdate = null;
					clearTimeout(sub.timer ?? undefined);
					sub.timer = null;
				}
			}
			out.push(event);
		}
		for (const frame of eventFrames(sessionId, out, this.#frameBytes)) this.#outbox.event(sessionId, frame);
	}

	#session(id: string): HostedSession {
		this.#assertNotSwitching(id);
		return this.host.manager.get(id);
	}

	/** An environment switch owns the session (or its forked copy): commands wait for it to end. */
	#assertNotSwitching(id: string): void {
		if (this.host.manager.isReserved(id) !== undefined) {
			throw new SessionActionError(
				"This session is being switched to another environment. Wait for the switch to finish, or cancel it.",
				"handoff",
			);
		}
	}

	/** Closes this client's sub-agent panel for `sessionId` (and so stops omp's sub-agent frames if it was the last). */
	#closePanel(sessionId: string): void {
		if (!this.#panels.delete(sessionId)) return;
		try {
			void this.#session(sessionId)
				.setAgentPanel(this, false)
				.catch(() => {});
		} catch {
			// The session is gone; there is nothing to switch off.
		}
	}

	#drop(sessionId: string): void {
		const sub = this.#subs.get(sessionId);
		if (!sub) return;
		sub.unsubscribe();
		clearTimeout(sub.timer ?? undefined);
		this.#subs.delete(sessionId);
		this.#outbox.forget(sessionId);
	}

	/** (Re)subscribes to whatever object `sessionId` names now; replaces an existing subscription. */
	async #subscribeTo(sessionId: string, lastSeq: number, epoch: string | undefined): Promise<"snapshot" | "replay"> {
		const session = await this.host.manager.view(sessionId);
		this.#drop(sessionId);
		const sub: Subscription = { unsubscribe: () => {}, pendingUpdate: null, timer: null };
		const { result, unsubscribe } = session.subscribe(
			events => this.#deliver(sessionId, sub, events),
			lastSeq,
			epoch,
		);
		sub.unsubscribe = unsubscribe;
		this.#subs.set(sessionId, sub);
		if (result.kind === "snapshot") {
			// Lazily serialized chunks: a slow client holds the snapshot, not its JSON (see Outbox).
			this.#outbox.snapshot(
				sessionId,
				snapshotFrames(sessionId, crypto.randomUUID(), result.seq, result.epoch, result.snapshot, this.#frameBytes),
			);
		} else {
			for (const frame of eventFrames(sessionId, result.events, this.#frameBytes))
				this.#outbox.event(sessionId, frame);
		}
		return result.kind;
	}

	async #handle(msg: ClientMessage): Promise<unknown> {
		const { manager, projects } = this.host;
		switch (msg.t) {
			case "sessions.list":
				// The result reaches the gateway through the daemon's own session-list push, not through this client.
				await manager.refresh();
				return undefined;
			case "sessions.search":
				return { matches: await manager.searchSessions(msg.query) } satisfies SessionSearchAck;
			case "session.create": {
				const session = await manager.create(msg.cwd, msg.model, msg.backend, msg.permissionMode);
				return { sessionId: session.id };
			}
			case "session.resume":
				this.#assertNotSwitching(msg.sessionId);
				return { sessionId: (await manager.resume(msg.sessionId, msg.confirm === true)).id };
			case "session.fork":
				this.#assertNotSwitching(msg.sessionId);
				return { sessionId: (await manager.fork(msg.sessionId)).id };
			case "session.rename":
				this.#assertNotSwitching(msg.sessionId);
				await manager.rename(msg.sessionId, msg.title);
				return undefined;
			case "session.close":
				this.#assertNotSwitching(msg.sessionId);
				await manager.close(msg.sessionId);
				return undefined;
			case "subscribe":
				return { mode: await this.#subscribeTo(msg.sessionId, msg.lastSeq, msg.epoch) };
			case "unsubscribe":
				this.#closePanel(msg.sessionId);
				this.#drop(msg.sessionId);
				return undefined;
			case "prompt":
				await this.#session(msg.sessionId).prompt(msg.message, imagesOf(msg.images));
				return undefined;
			case "steer":
				await this.#session(msg.sessionId).steer(msg.message, imagesOf(msg.images));
				return undefined;
			case "follow_up":
				await this.#session(msg.sessionId).followUp(msg.message, imagesOf(msg.images));
				return undefined;
			case "queue.remove":
				return { removed: await this.#session(msg.sessionId).removeQueued(msg.message, msg.queue) };
			case "abort":
				await this.#session(msg.sessionId).abort();
				return undefined;
			case "session.options":
				return await this.#session(msg.sessionId).options();
			case "session.set_model":
				await this.#session(msg.sessionId).setModel(msg.provider, msg.modelId);
				return undefined;
			case "session.set_thinking":
				await this.#session(msg.sessionId).setThinking(msg.level);
				return undefined;
			case "session.set_mode":
				await this.#session(msg.sessionId).setMode(msg.mode);
				return undefined;
			case "session.set_permission_mode":
				await this.#session(msg.sessionId).setPermissionMode(msg.mode);
				return undefined;
			case "omp.theme":
				return await manager.theme();
			case "session.context":
				return { text: await this.#session(msg.sessionId).context() };
			case "session.roles":
				return await manager.roles(msg.sessionId);
			case "session.set_role": {
				this.#assertNotSwitching(msg.sessionId);
				const warning = await manager.setRole(msg.sessionId, msg.role, msg.selector);
				return warning === undefined ? undefined : { warning };
			}
			case "session.compact":
				await this.#session(msg.sessionId).compact(msg.instructions);
				return undefined;
			case "session.agents": {
				const session = this.#session(msg.sessionId);
				if (msg.open) this.#panels.add(msg.sessionId);
				else this.#panels.delete(msg.sessionId);
				await session.setAgentPanel(this, msg.open);
				return undefined;
			}
			case "session.btw":
				return { record: await this.#session(msg.sessionId).btw(msg.question, msg.recordId) };
			case "session.btw_cancel":
				return { cancelled: await this.#session(msg.sessionId).cancelBtw(msg.recordId) };
			case "session.goal":
				return {
					goal: await this.#session(msg.sessionId).goal(msg.op, {
						objective: msg.objective,
						tokenBudget: msg.tokenBudget,
					}),
				};
			case "session.loop":
				await this.#session(msg.sessionId).loop(msg.args);
				return undefined;
			case "session.agent_transcript":
				return await this.#session(msg.sessionId).agentTranscript(msg.agentId, {
					fromByte: msg.fromByte,
					beforeByte: msg.beforeByte,
				});
			case "ui.response":
				this.#session(msg.sessionId).respondUi(msg.requestId, msg.response);
				return undefined;
			case "project.add":
				return await projects.add(msg.path);
			case "project.remove":
				await projects.remove(msg.root);
				return undefined;
			case "project.list": {
				const list = await projects.list();
				this.host.projectsRefreshed(list);
				return list;
			}
			case "antigravity.auth.status":
				return await manager.antigravityAuthStatus();
			case "antigravity.auth.login":
				return await manager.antigravityAuthLogin(msg.methodId);
			case "antigravity.usage":
				return await manager.antigravityUsage();
			case "files.list":
			case "files.read":
			case "files.bytes":
			case "files.status":
			case "files.diff":
			case "files.locate":
				return await this.#files(msg);
		}
	}

	/**
	 * One `files.*` request. The reply is a bounded frame that waits in the outbox when the browser is behind, so a
	 * client with many requests running or a pile of unsent replies is turned away instead of served (it retries).
	 */
	async #files(msg: FilesClientMessage): Promise<unknown> {
		if (this.#fileRequests >= MAX_FILE_REQUESTS || this.#outbox.controlBacklog > MAX_FILE_BACKLOG_BYTES) {
			throw new FileError("busy", "too many file requests at once; try again in a moment");
		}
		this.#fileRequests++;
		try {
			return await this.host.files.handle(msg);
		} finally {
			this.#fileRequests--;
		}
	}
}
