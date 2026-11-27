import {
	type Ack,
	clampTerminalSize,
	type ServerMessage,
	TERM_ACK_EVERY_CHARS,
	type TerminalCapability,
	type TerminalExit,
	type TerminalInfo,
	type TerminalPurpose,
} from "@omp-web/protocol";
import { ackedTerminal, ackedTerminalAttach, ackedTerminalWatch } from "../lib/ack";
import { tabTitle } from "../lib/terminal";
import { splitInput } from "../lib/terminal-input";
import type { ClientRequest } from "./daemon-client";

/**
 * What the terminal client needs of the connection to the gateway (`DaemonClient` is one; tests use a fake). Requests
 * are addressed to a machine's daemon; `post` is the one-way kind (input, resize, ack, detach).
 */
export interface TerminalTransport {
	request(machine: string, request: ClientRequest): Promise<Ack>;
	post(machine: string, request: ClientRequest): boolean;
	/** Called for every `term.*` frame (the frame carries `m`). */
	onFrame(listener: (frame: ServerMessage) => void): () => void;
	/** Changes whenever the link to the machine's daemon was re-established; null while it cannot be used. */
	linkKey(machine: string): string | null;
	/** Called whenever the connection state changed (the machine list, the socket). */
	subscribe(listener: () => void): () => void;
}

export interface Size {
	cols: number;
	rows: number;
}

/**
 * What a view gives the client to draw on (an xterm in the browser). The client calls these in the order the daemon's
 * frames arrive, and the sink must apply them in that order (`resize` after the `write`s before it has been parsed).
 */
export interface Sink {
	reset(): void;
	/** `done` is called once the data has been processed (not merely queued). */
	write(data: string, done: () => void): void;
	resize(cols: number, rows: number): void;
}

export type AttachStatus = "detached" | "attaching" | "attached" | "lost" | "exited" | "gone" | "offline";

export interface MachineTerminals {
	/** What the machine said when watched; null before that. */
	capability: TerminalCapability | null;
	terminals: readonly TerminalInfo[];
	/** The list is current: the watch was acknowledged on the present link. */
	synced: boolean;
	/** The link to the machine's daemon can be used now. */
	online: boolean;
	/** Why the machine's terminals could not be listed (an old daemon, a failed request), or null. */
	error: string | null;
}

/** One terminal this client has a view on. */
export interface AttachmentState {
	status: AttachStatus;
	/** The terminal as last listed (kept after the daemon stops listing it, for the lost state). */
	info: TerminalInfo | null;
	exit: TerminalExit | null;
	/** The pty's size, which is also the size of the screen. */
	size: Size | null;
	/** Why attaching failed, or null. */
	error: string | null;
	/** `term.gone`'s reason once the terminal was dismissed. */
	reason: string | null;
}

export interface TerminalNotice {
	id: number;
	machine: string;
	message: string;
}

export interface TerminalsState {
	machines: Readonly<Record<string, MachineTerminals>>;
	/** Keyed by {@link terminalKey}. */
	attachments: Readonly<Record<string, AttachmentState>>;
	notices: readonly TerminalNotice[];
}

export type OpenResult = { ok: true; terminal: TerminalInfo } | { ok: false; error: string; code?: string };

export interface OpenOptions {
	cwd?: string;
	purpose?: TerminalPurpose;
	/** The size to start the pty at; defaults to the last size a view measured. */
	size?: Size;
}

export interface Binding {
	/** The view is on screen (and the page visible): attach; otherwise detach and keep what is on the screen. */
	setVisible(visible: boolean): void;
	/** The size the view's pane could show; sent with attach and, when it changes, as a resize. */
	setDesired(size: Size): void;
	release(): void;
}

export interface TerminalClientOptions {
	/** Delay before a pending acknowledgement is sent although fewer than `TERM_ACK_EVERY_CHARS` are unacknowledged. */
	ackDelayMs?: number;
	now?: () => number;
}

export const ACK_DELAY_MS = 30;
const DEFAULT_SIZE: Size = { cols: 80, rows: 24 };

export const terminalKey = (machine: string, id: string): string => `${machine}/${id}`;

/** The daemon-side view of one terminal: everything the client tracks about one attachment. */
interface Attachment {
	machine: string;
	id: string;
	sink: Sink;
	visible: boolean;
	desired: Size | null;
	info: TerminalInfo | null;
	exit: TerminalExit | null;
	size: Size | null;
	error: string | null;
	reason: string | null;
	lost: boolean;
	gone: boolean;
	/** The user dismissed it here: the daemon's `term.gone` is not news. */
	dismissing: boolean;
	/** An attach was sent on the present link and not detached since. */
	engaged: boolean;
	/** The attach was acknowledged. */
	ready: boolean;
	/** Output the screen holds, in the daemon's offsets; null = nothing (a fresh screen). */
	expected: number | null;
	/** Identifies the current attach; writes and replies of an older one are dropped. */
	attachId: number;
	consumed: number;
	acked: number;
	ackTimer: ReturnType<typeof setTimeout> | null;
	/** The size last told to the daemon (attach or resize). */
	sent: Size | null;
}

interface MachineEntry {
	watchers: number;
	link: string | null;
	view: MachineTerminals;
}

const exited = (a: Attachment): boolean => a.exit !== null || a.info?.state === "exited";

/**
 * Terminals of the machines this browser looks at: the machine's list and capability (watch, ref-counted), and the
 * attachments of the terminals views have bound. UI agnostic: output goes to a {@link Sink}. It owns the output
 * protocol: offsets and gaps, snapshots, acknowledgements (flow control), size, exit, and the re-attach after the
 * link to a machine was lost. See `packages/protocol/src/terminal.ts` for the frames.
 */
export class TerminalClient {
	#machines = new Map<string, MachineEntry>();
	#attachments = new Map<string, Attachment>();
	#notices: TerminalNotice[] = [];
	#noticeSeq = 0;
	#attachSeq = 0;
	#state: TerminalsState = { machines: {}, attachments: {}, notices: [] };
	#listeners = new Set<() => void>();
	#preferred: Size | null = null;
	readonly #unsubscribe: (() => void)[];
	readonly #ackDelay: number;
	readonly #now: () => number;

	constructor(
		private readonly transport: TerminalTransport,
		options: TerminalClientOptions = {},
	) {
		this.#ackDelay = options.ackDelayMs ?? ACK_DELAY_MS;
		this.#now = options.now ?? Date.now;
		this.#unsubscribe = [transport.subscribe(() => this.#sync()), transport.onFrame(frame => this.#onFrame(frame))];
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): TerminalsState => this.#state;

	dispose(): void {
		for (const off of this.#unsubscribe) off();
		for (const a of this.#attachments.values()) this.#clearAckTimer(a);
		this.#attachments.clear();
		this.#listeners.clear();
	}

	/** Output offset the screen of a terminal holds (null: nothing yet). For tests and the browser smoke. */
	expectedOffset(machine: string, id: string): number | null {
		return this.#attachments.get(terminalKey(machine, id))?.expected ?? null;
	}

	/** The size a new terminal starts at when its opener does not know better: what a view last measured. */
	get preferredSize(): Size {
		return this.#preferred ?? DEFAULT_SIZE;
	}

	setPreferredSize(size: Size): void {
		this.#preferred = clampTerminalSize(size.cols, size.rows);
	}

	/** Starts listing the machine's terminals (and keeps the list current) until the returned function is called. */
	watch(machine: string): () => void {
		const entry = this.#entry(machine);
		entry.watchers++;
		if (entry.watchers === 1) {
			// A link that did not change since the last watch has to be asked again; a new or changed one is #sync's.
			if (entry.link !== null && entry.link === this.transport.linkKey(machine)) {
				void this.#watchRequest(machine, entry, entry.link);
			} else {
				this.#sync();
			}
			this.#emit();
		}
		let done = false;
		return () => {
			if (done) return;
			done = true;
			this.#unwatch(machine);
		};
	}

	/** Starts a shell. It is not attached: the view that shows it binds it. */
	async open(machine: string, options: OpenOptions = {}): Promise<OpenResult> {
		const size = options.size ?? this.preferredSize;
		const { cols, rows } = clampTerminalSize(size.cols, size.rows);
		const ack = await this.transport.request(machine, {
			t: "term.open",
			cols,
			rows,
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			...(options.purpose === undefined ? {} : { purpose: options.purpose }),
		});
		if (!ack.ok) {
			if (ack.code === "terminal_disabled") this.#markDisabled(machine);
			return { ok: false, error: ack.error, code: ack.code };
		}
		const terminal = ackedTerminal(ack.data);
		if (terminal === null) return { ok: false, error: "the daemon did not report the new terminal" };
		const entry = this.#entry(machine);
		if (!entry.view.terminals.some(t => t.id === terminal.id)) {
			entry.view = { ...entry.view, terminals: [...entry.view.terminals, terminal] };
			this.#emit();
		}
		return { ok: true, terminal };
	}

	/**
	 * Shows a terminal on `sink`. The screen is the view's: a new binding starts from an empty screen (the daemon sends
	 * a snapshot), and the previous binding of the same terminal is replaced. Implies {@link watch} of the machine.
	 */
	bind(machine: string, id: string, sink: Sink, initial: { visible: boolean; desired?: Size }): Binding {
		const key = terminalKey(machine, id);
		this.#drop(key);
		const unwatch = this.watch(machine);
		const entry = this.#entry(machine);
		const info = entry.view.terminals.find(t => t.id === id) ?? null;
		const a: Attachment = {
			machine,
			id,
			sink,
			visible: initial.visible,
			desired: initial.desired ? clampTerminalSize(initial.desired.cols, initial.desired.rows) : null,
			info,
			exit: info?.exit ?? null,
			size: info ? { cols: info.cols, rows: info.rows } : null,
			error: null,
			reason: null,
			lost: false,
			gone: false,
			dismissing: false,
			engaged: false,
			ready: false,
			expected: null,
			attachId: 0,
			consumed: 0,
			acked: 0,
			ackTimer: null,
			sent: null,
		};
		this.#attachments.set(key, a);
		if (entry.view.synced && info === null) this.#markLost(a);
		else this.#attach(a);
		this.#emit();
		let released = false;
		return {
			setVisible: visible => {
				if (this.#attachments.get(key) !== a || a.visible === visible) return;
				a.visible = visible;
				if (visible) this.#attach(a);
				else this.#detach(a);
				this.#emit();
			},
			setDesired: size => {
				if (this.#attachments.get(key) !== a) return;
				const next = clampTerminalSize(size.cols, size.rows);
				a.desired = next;
				if (a.engaged && a.ready) this.#sendSize(a);
			},
			release: () => {
				if (released) return;
				released = true;
				if (this.#attachments.get(key) === a) this.#drop(key);
				unwatch();
				this.#emit();
			},
		};
	}

	/** Types into the terminal. False when nothing was sent (not attached, exited, offline). */
	input(machine: string, id: string, data: string): boolean {
		const a = this.#attachments.get(terminalKey(machine, id));
		if (!a || !a.engaged || exited(a) || a.lost || a.gone || data === "") return false;
		let ok = true;
		for (const part of splitInput(data)) ok = this.transport.post(machine, { t: "term.input", id, data: part }) && ok;
		return ok;
	}

	/** Ends the shell. Resolves to an error message, or null once the daemon says it died. */
	async kill(machine: string, id: string): Promise<string | null> {
		const ack = await this.transport.request(machine, { t: "term.kill", id });
		return ack.ok ? null : ack.error;
	}

	/**
	 * Removes a terminal: an exited one from the daemon (and every client), a lost one (the daemon no longer has it)
	 * only here. Resolves to an error message, or null.
	 */
	async dismiss(machine: string, id: string): Promise<string | null> {
		const a = this.#attachments.get(terminalKey(machine, id));
		if (a?.lost) {
			this.#markGone(a, "dismissed", false);
			return null;
		}
		if (a) a.dismissing = true;
		const ack = await this.transport.request(machine, { t: "term.dismiss", id });
		if (!ack.ok) {
			if (a) a.dismissing = false;
			return ack.error;
		}
		this.#removeFromList(machine, id);
		if (a) this.#markGone(a, "dismissed", false);
		else this.#emit();
		return null;
	}

	dismissNotice(id: number): void {
		this.#notices = this.#notices.filter(n => n.id !== id);
		this.#emit();
	}

	// -- machines ----------------------------------------------------------------------------------------------

	#entry(machine: string): MachineEntry {
		let entry = this.#machines.get(machine);
		if (!entry) {
			entry = {
				watchers: 0,
				link: null,
				view: { capability: null, terminals: [], synced: false, online: false, error: null },
			};
			this.#machines.set(machine, entry);
		}
		return entry;
	}

	#unwatch(machine: string): void {
		const entry = this.#entry(machine);
		if (--entry.watchers > 0) return;
		entry.watchers = 0;
		entry.view = { ...entry.view, synced: false };
		if (entry.link !== null) void this.transport.request(machine, { t: "term.watch", open: false });
		this.#emit();
	}

	/** Brings the machines in line with the connection: a link that went away or was replaced re-establishes everything. */
	#sync(): void {
		let changed = false;
		for (const [machine, entry] of this.#machines) {
			const key = this.transport.linkKey(machine);
			if (key === entry.link) continue;
			changed = true;
			entry.link = key;
			this.#linkLost(machine, entry);
			if (key !== null) this.#linkUp(machine, entry, key);
		}
		// Called on every change of the connection's state: only a changed link is news for the views.
		if (changed) this.#emit();
	}

	/** The daemon forgot every attachment of this client with the old link; what is on the screens stays. */
	#linkLost(machine: string, entry: MachineEntry): void {
		entry.view = { ...entry.view, online: false, synced: false };
		for (const a of this.#attachments.values()) {
			if (a.machine !== machine) continue;
			a.engaged = false;
			a.ready = false;
			a.attachId = ++this.#attachSeq;
			this.#clearAckTimer(a);
		}
	}

	#linkUp(machine: string, entry: MachineEntry, key: string): void {
		entry.view = { ...entry.view, online: true };
		if (entry.watchers > 0) void this.#watchRequest(machine, entry, key);
	}

	async #watchRequest(machine: string, entry: MachineEntry, key: string): Promise<void> {
		const ack = await this.transport.request(machine, { t: "term.watch", open: true });
		if (entry.link !== key || entry.watchers === 0) return; // the link changed (a newer watch follows) or nobody looks
		if (!ack.ok) {
			if (ack.code === "terminal_disabled") this.#markDisabled(machine);
			else entry.view = { ...entry.view, error: ack.error };
			this.#emit();
			return;
		}
		const watched = ackedTerminalWatch(ack.data);
		if (watched === null) {
			entry.view = { ...entry.view, error: "the daemon sent an unreadable terminal list" };
			this.#emit();
			return;
		}
		const { capability, terminals } = watched;
		entry.view = { ...entry.view, capability, terminals, synced: true, error: null };
		this.#reconcileList(machine, terminals);
		for (const a of this.#attachments.values()) if (a.machine === machine) this.#attach(a);
		this.#emit();
	}

	#markDisabled(machine: string): void {
		const entry = this.#entry(machine);
		const capability = entry.view.capability;
		entry.view = {
			...entry.view,
			capability: capability
				? { ...capability, enabled: false }
				: { enabled: false, max: 0, shell: null, ringChars: 0, scrollbackLines: 0 },
		};
		this.#emit();
	}

	#removeFromList(machine: string, id: string): void {
		const entry = this.#entry(machine);
		entry.view = { ...entry.view, terminals: entry.view.terminals.filter(t => t.id !== id) };
	}

	/** The daemon's list replaced ours: attachments follow it (exit, a terminal the daemon no longer has). */
	#reconcileList(machine: string, terminals: readonly TerminalInfo[]): void {
		for (const a of this.#attachments.values()) {
			if (a.machine !== machine || a.gone || a.lost) continue;
			const info = terminals.find(t => t.id === a.id);
			if (!info) {
				this.#markLost(a);
				continue;
			}
			a.info = info;
			a.size ??= { cols: info.cols, rows: info.rows };
			if (info.state === "exited" && a.exit === null) a.exit = info.exit;
		}
	}

	// -- frames ------------------------------------------------------------------------------------------------

	#onFrame(frame: ServerMessage): void {
		switch (frame.t) {
			case "term.list": {
				const entry = this.#entry(frame.m);
				if (entry.watchers === 0) return;
				entry.view = { ...entry.view, terminals: frame.terminals };
				this.#reconcileList(frame.m, frame.terminals);
				this.#emit();
				return;
			}
			case "term.out":
				this.#onOut(frame);
				return;
			case "term.size": {
				const a = this.#attachments.get(terminalKey(frame.m, frame.id));
				if (!a || !a.engaged) return;
				a.size = { cols: frame.cols, rows: frame.rows };
				a.sink.resize(frame.cols, frame.rows);
				this.#emit();
				return;
			}
			case "term.exit": {
				const a = this.#attachments.get(terminalKey(frame.m, frame.id));
				if (!a) return;
				a.exit = { code: frame.code, killed: frame.killed, at: this.#now() };
				this.#emit();
				return;
			}
			case "term.gone": {
				this.#removeFromList(frame.m, frame.id);
				const a = this.#attachments.get(terminalKey(frame.m, frame.id));
				if (a) this.#markGone(a, frame.reason, !a.dismissing);
				else this.#emit();
				return;
			}
		}
	}

	#onOut(frame: Extract<ServerMessage, { t: "term.out" }>): void {
		const a = this.#attachments.get(terminalKey(frame.m, frame.id));
		if (!a || !a.engaged) return;
		if (frame.snapshot === "start") {
			a.sink.reset();
			a.expected = frame.offset;
			this.#write(a, frame.data);
			return;
		}
		if (frame.snapshot === "part") {
			this.#write(a, frame.data);
			return;
		}
		a.expected ??= frame.offset;
		if (frame.offset < a.expected) return; // a duplicate of what the screen already has
		if (frame.offset > a.expected) {
			// A gap: ask again from where the screen is. While that attach is unanswered the daemon is already doing so.
			if (a.ready) this.#attach(a);
			return;
		}
		a.expected += frame.data.length;
		this.#write(a, frame.data);
	}

	/** Writes to the screen; the daemon is told once the screen has processed it, never before (flow control). */
	#write(a: Attachment, data: string): void {
		if (data === "") return;
		const sink = a.sink;
		const id = a.attachId;
		sink.write(data, () => {
			if (a.sink !== sink || a.attachId !== id || !a.engaged) return;
			a.consumed += data.length;
			if (a.consumed - a.acked >= TERM_ACK_EVERY_CHARS) this.#flushAck(a);
			else this.#scheduleAck(a);
		});
	}

	#scheduleAck(a: Attachment): void {
		this.#clearAckTimer(a);
		a.ackTimer = setTimeout(() => {
			a.ackTimer = null;
			this.#flushAck(a);
		}, this.#ackDelay);
	}

	#flushAck(a: Attachment): void {
		this.#clearAckTimer(a);
		if (!a.engaged || a.consumed === a.acked) return;
		if (this.transport.post(a.machine, { t: "term.ack", id: a.id, bytes: a.consumed })) a.acked = a.consumed;
	}

	#clearAckTimer(a: Attachment): void {
		clearTimeout(a.ackTimer ?? undefined);
		a.ackTimer = null;
	}

	// -- attachments -------------------------------------------------------------------------------------------

	/**
	 * Asks the daemon for the terminal's output from where the screen is. Does nothing while the view is hidden, the
	 * link is down or the list is not current, the daemon does not have the terminal, or it exited and the screen
	 * already shows everything it ever printed.
	 */
	#attach(a: Attachment): void {
		const entry = this.#entry(a.machine);
		if (!a.visible || !entry.view.online || !entry.view.synced || a.lost || a.gone) return;
		if (exited(a) && a.expected !== null) return;
		const attachId = ++this.#attachSeq;
		a.attachId = attachId;
		a.engaged = true;
		a.ready = false;
		a.consumed = 0;
		a.acked = 0;
		a.error = null;
		this.#clearAckTimer(a);
		const want = a.desired ?? a.size ?? DEFAULT_SIZE;
		const size = clampTerminalSize(want.cols, want.rows);
		a.sent = size;
		void this.transport
			.request(a.machine, { t: "term.attach", id: a.id, offset: a.expected, cols: size.cols, rows: size.rows })
			.then(ack => this.#attached(a, attachId, ack));
	}

	#attached(a: Attachment, attachId: number, ack: Ack): void {
		if (a.attachId !== attachId || !a.engaged || this.#attachments.get(terminalKey(a.machine, a.id)) !== a) return;
		if (!ack.ok) {
			a.engaged = false;
			a.error = ack.error;
			if (ack.code === "terminal_disabled") this.#markDisabled(a.machine);
			else if (this.#entry(a.machine).view.synced && !this.#listed(a)) this.#markLost(a);
			this.#emit();
			return;
		}
		const attach = ackedTerminalAttach(ack.data);
		if (attach) {
			const terminal = attach.terminal;
			a.info = terminal;
			if (terminal.state === "exited" && a.exit === null) a.exit = terminal.exit;
			a.size = { cols: terminal.cols, rows: terminal.rows };
			a.sink.resize(terminal.cols, terminal.rows);
			if (attach.mode === "replay" && a.expected === null) a.expected = attach.offset;
		}
		a.ready = true;
		this.#sendSize(a);
		this.#emit();
	}

	#listed(a: Attachment): boolean {
		return this.#entry(a.machine).view.terminals.some(t => t.id === a.id);
	}

	/** Reports the size the view's pane can show when it differs from what the daemon last heard. */
	#sendSize(a: Attachment): void {
		if (!a.desired || (a.sent && a.sent.cols === a.desired.cols && a.sent.rows === a.desired.rows)) return;
		if (this.transport.post(a.machine, { t: "term.resize", id: a.id, cols: a.desired.cols, rows: a.desired.rows })) {
			a.sent = a.desired;
		}
	}

	#detach(a: Attachment): void {
		if (!a.engaged) return;
		a.engaged = false;
		a.ready = false;
		a.attachId = ++this.#attachSeq;
		this.#clearAckTimer(a);
		this.transport.post(a.machine, { t: "term.detach", id: a.id });
	}

	/** Forgets an attachment (the view went away): the daemon stops sending to it. */
	#drop(key: string): void {
		const a = this.#attachments.get(key);
		if (!a) return;
		this.#detach(a);
		this.#attachments.delete(key);
	}

	#markLost(a: Attachment): void {
		a.lost = true;
		a.engaged = false;
		a.ready = false;
		a.attachId = ++this.#attachSeq;
		this.#clearAckTimer(a);
	}

	#markGone(a: Attachment, reason: string, notify: boolean): void {
		if (a.gone) return;
		a.gone = true;
		a.reason = reason;
		a.engaged = false;
		a.ready = false;
		a.attachId = ++this.#attachSeq;
		this.#clearAckTimer(a);
		if (notify) {
			const label = a.info ? tabTitle(a.info) : a.id;
			this.#notices = [
				...this.#notices,
				{ id: ++this.#noticeSeq, machine: a.machine, message: `Terminal "${label}" was dismissed (${reason}).` },
			];
		}
		this.#emit();
	}

	// -- state -------------------------------------------------------------------------------------------------

	#statusOf(a: Attachment): AttachStatus {
		if (a.gone) return "gone";
		if (a.lost) return "lost";
		if (exited(a)) return "exited";
		if (!this.#entry(a.machine).view.online) return "offline";
		if (!a.engaged) return "detached";
		return a.ready ? "attached" : "attaching";
	}

	#emit(): void {
		const machines: Record<string, MachineTerminals> = {};
		for (const [id, entry] of this.#machines) machines[id] = entry.view;
		const attachments: Record<string, AttachmentState> = {};
		for (const [key, a] of this.#attachments) {
			attachments[key] = {
				status: this.#statusOf(a),
				info: a.info,
				exit: a.exit,
				size: a.size,
				error: a.error,
				reason: a.reason,
			};
		}
		this.#state = { machines, attachments, notices: this.#notices };
		for (const listener of Array.from(this.#listeners)) listener();
	}
}

const clients = new WeakMap<object, TerminalClient>();

/** The one terminal client of a connection (created on first use). */
export function terminalsOf(transport: TerminalTransport): TerminalClient {
	let client = clients.get(transport);
	if (!client) {
		client = new TerminalClient(transport);
		clients.set(transport, client);
	}
	return client;
}
