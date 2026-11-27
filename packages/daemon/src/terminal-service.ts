import {
	clampTerminalSize,
	TERM_ACK_WINDOW_CHARS,
	TERM_FRAME_CHARS,
	type TerminalCapability,
	type TerminalClientMessage,
	type TerminalEnvFrame,
	type TerminalInfo,
	type TerminalPurpose,
} from "@omp-web/protocol";
import {
	nativePty,
	PtyTerminal,
	resolveShell,
	shellKindOf,
	shellName,
	type PtyFactory,
	type ShellKind,
	type SizeEvent,
} from "./pty-host";

export class TerminalError extends Error {
	constructor(
		message: string,
		readonly code?: "terminal_disabled",
	) {
		super(message);
	}
}

export const DISABLED_MESSAGE =
	'terminals are disabled on this machine: an operator enables them there with `omp-webd --terminal` (or "terminal": { "enabled": true } in config.json)';

export const DEFAULT_TERMINAL_MAX = 16;
export const DEFAULT_RING_CHARS = 1024 * 1024;
export const DEFAULT_SCROLLBACK_LINES = 2000;

/** What a terminal opened for a purpose runs in: decided by the daemon, never by the client. */
export interface PurposeLaunch {
	cwd: string;
	/** Typed into the shell without a line break: the user presses Enter. */
	input: string;
}

export interface TerminalServiceOptions {
	/** Per-machine switch (`terminal.enabled`, default false). While false nothing is ever spawned. */
	enabled: boolean;
	/** This machine's id, for the audit log (known only after the daemon registered or loaded its identity). */
	machineId(): string;
	/** Terminals (running and exited) one machine may hold. */
	max?: number;
	/** Configured shell; else the user's login shell. */
	shell?: string;
	ringChars?: number;
	scrollbackLines?: number;
	/** The containment rule of sessions: a registered project root/worktree, canonical. */
	resolveCwd(cwd: string): Promise<string>;
	/** The gateway machine's broker login terminal (directory and pre-typed command); null when no broker is hosted. */
	purposeLaunch?(purpose: TerminalPurpose, shell: ShellKind): Promise<PurposeLaunch | null>;
	factory?: PtyFactory;
	/** The environment shells inherit from (default: the daemon's own, minus its secrets). */
	env?: Record<string, string | undefined>;
	/** Resolves the shell once at start (tests). */
	resolveShell?: (configured: string | undefined) => string;
	audit?: (line: string) => void;
	now?: () => number;
}

/** How a port talks to its client: frames are serialized JSON; `isPaused` is the gateway's backpressure signal. */
export interface TerminalSocket {
	/** Sent ahead of bulk traffic (see link-lanes.ts). */
	sendPriority(frame: string): void;
	isPaused(): boolean;
}

interface Entry {
	terminal: PtyTerminal;
	attachments: Set<Attachment>;
	/** The attachment whose size the pty follows. */
	owner: Attachment | null;
	unsubscribe: (() => void)[];
}

const LIST_COALESCE_MS = 40;

/** One client's attachment to one terminal: where it is in the output, and how much is unacknowledged. */
class Attachment {
	cursor = 0;
	sent = 0;
	acked = 0;
	lastSizeN = -1;
	exitSent = false;
	snapshot: { data: string; pos: number; cols: number; rows: number; started: boolean } | null = null;
	lastActive: number;
	#sending = false;

	constructor(
		readonly port: TerminalPort,
		readonly entry: Entry,
		public cols: number,
		public rows: number,
		now: number,
	) {
		this.lastActive = now;
	}

	get id(): string {
		return this.entry.terminal.info.id;
	}

	/** Starts from a snapshot of the screen instead of from an offset the client holds. */
	startSnapshot(): void {
		const terminal = this.entry.terminal;
		const shot = terminal.screen.snapshot();
		this.snapshot = { data: shot.data, pos: 0, cols: shot.cols, rows: shot.rows, started: false };
		this.cursor = shot.offset;
		this.lastSizeN = terminal.sizes.findLast(e => e.offset <= shot.offset)?.n ?? -1;
	}

	/** Starts from `offset`, which the ring still holds: sizes that took effect before it are known to the client. */
	startReplay(offset: number): void {
		this.cursor = offset;
		this.snapshot = null;
		this.lastSizeN = this.entry.terminal.sizes.findLast(e => e.offset < offset)?.n ?? -1;
	}

	/** Sends what the window and the gateway allow: pending snapshot, size changes, output, finally the exit. */
	pump(): void {
		if (this.#sending) return;
		this.#sending = true;
		try {
			const terminal = this.entry.terminal;
			const socket = this.port.socket;
			for (;;) {
				if (socket.isPaused() || this.sent - this.acked >= TERM_ACK_WINDOW_CHARS) return;
				if (this.snapshot) {
					this.#sendSnapshotPart(this.snapshot);
					continue;
				}
				const ring = terminal.ring;
				if (this.cursor < ring.start) {
					this.startSnapshot(); // the client fell further behind than the ring holds
					continue;
				}
				const nextSize: SizeEvent | undefined = terminal.sizes.find(e => e.n > this.lastSizeN);
				if (nextSize && nextSize.offset <= this.cursor) {
					this.lastSizeN = nextSize.n;
					this.#send({ t: "term.size", id: this.id, cols: nextSize.cols, rows: nextSize.rows });
					continue;
				}
				if (this.cursor >= ring.head) {
					if (!terminal.running && !this.exitSent) {
						this.exitSent = true;
						const exit = terminal.info.exit;
						this.#send({ t: "term.exit", id: this.id, code: exit?.code ?? null, killed: exit?.killed ?? false });
					}
					return;
				}
				let max = Math.min(TERM_FRAME_CHARS, TERM_ACK_WINDOW_CHARS - (this.sent - this.acked));
				if (nextSize) max = Math.min(max, nextSize.offset - this.cursor);
				const data = ring.slice(this.cursor, Math.max(2, max));
				if (data === "") return;
				this.#send({ t: "term.out", id: this.id, offset: this.cursor, data });
				this.cursor += data.length;
				this.sent += data.length;
			}
		} finally {
			this.#sending = false;
		}
	}

	#sendSnapshotPart(snapshot: NonNullable<Attachment["snapshot"]>): void {
		if (!snapshot.started) {
			// The client's screen must have the snapshot's size before the snapshot is written onto it.
			this.#send({ t: "term.size", id: this.id, cols: snapshot.cols, rows: snapshot.rows });
		}
		let end = Math.min(snapshot.data.length, snapshot.pos + TERM_FRAME_CHARS);
		if (end < snapshot.data.length && end - snapshot.pos > 1) {
			const last = snapshot.data.charCodeAt(end - 1);
			if (last >= 0xd800 && last <= 0xdbff) end--; // keep a surrogate pair in one frame
		}
		const data = snapshot.data.slice(snapshot.pos, end);
		this.#send({
			t: "term.out",
			id: this.id,
			offset: this.cursor,
			data,
			snapshot: snapshot.started ? "part" : "start",
		});
		snapshot.started = true;
		snapshot.pos = end;
		this.sent += data.length;
		if (snapshot.pos >= snapshot.data.length) this.snapshot = null;
	}

	#send(frame: TerminalEnvFrame): void {
		this.port.socket.sendPriority(JSON.stringify(frame));
	}
}

/**
 * The terminals of one machine: the table, the limits, the shell and its environment, and a {@link TerminalPort} per
 * connected client. Disabled (the default) it answers capability queries and refuses everything else; it never starts a
 * process.
 */
export class TerminalService {
	readonly #entries = new Map<string, Entry>();
	readonly #listeners = new Set<() => void>();
	readonly #options: TerminalServiceOptions;
	readonly #factory: PtyFactory;
	readonly #now: () => number;
	readonly #shell: string | null;
	readonly #env: Record<string, string | undefined>;
	#closing = false;
	#opening = 0;

	constructor(options: TerminalServiceOptions) {
		this.#options = options;
		this.#factory = options.factory ?? nativePty;
		this.#now = options.now ?? Date.now;
		this.#env = options.env ?? Bun.env;
		this.#shell = options.enabled ? (options.resolveShell ?? resolveShell)(options.shell) : null;
	}

	get enabled(): boolean {
		return this.#options.enabled;
	}

	capability(): TerminalCapability {
		return {
			enabled: this.#options.enabled,
			max: this.#options.max ?? DEFAULT_TERMINAL_MAX,
			shell: this.#shell,
			ringChars: this.#options.ringChars ?? DEFAULT_RING_CHARS,
			scrollbackLines: this.#options.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES,
		};
	}

	list(): TerminalInfo[] {
		return [...this.#entries.values()].map(e => e.terminal.info).toSorted((a, b) => a.createdAt - b.createdAt);
	}

	/** A terminal's process, for tests and for the shutdown report. */
	get(id: string): PtyTerminal | undefined {
		return this.#entries.get(id)?.terminal;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	audit(line: string): void {
		(this.#options.audit ?? (l => console.log(`omp-webd: audit: ${l}`)))(
			`machine=${this.#options.machineId()} ${line}`,
		);
	}

	/** Serves one client (a virtual client of the gateway link, or a test). */
	port(socket: TerminalSocket, who = "unknown"): TerminalPort {
		return new TerminalPort(this, socket, who, this.#now);
	}

	/** Ends every shell and releases the screens; the daemon is stopping. Terminals do not survive it. */
	async close(): Promise<void> {
		this.#closing = true;
		const entries = [...this.#entries.values()];
		await Promise.all(entries.map(e => e.terminal.kill()));
		for (const entry of entries) this.#remove(entry, "the daemon is stopping");
	}

	// -- used by ports -------------------------------------------------------------------------------------------

	entry(id: string): Entry {
		const entry = this.#entries.get(id);
		if (!entry)
			throw new TerminalError(
				`no terminal ${id} on this machine (it may have been dismissed or the daemon restarted)`,
			);
		return entry;
	}

	async open(
		size: { cols: number; rows: number },
		request: { cwd?: string; purpose?: TerminalPurpose },
		who: string,
	): Promise<TerminalInfo> {
		if (!this.#options.enabled || this.#shell === null)
			throw new TerminalError(DISABLED_MESSAGE, "terminal_disabled");
		if (this.#closing) throw new TerminalError("the daemon is stopping");
		const max = this.#options.max ?? DEFAULT_TERMINAL_MAX;
		if (this.#entries.size + this.#opening >= max) {
			throw new TerminalError(`this machine already holds ${max} terminals; kill or dismiss one first`);
		}
		this.#opening++;
		try {
			let cwd: string;
			let initialInput: string | undefined;
			let name = shellName(this.#shell);
			if (request.purpose) {
				const launch = await this.#options.purposeLaunch?.(request.purpose, shellKindOf(this.#shell));
				if (!launch) {
					throw new TerminalError(
						request.purpose.kind === "antigravity-login"
							? "Antigravity is not available on this machine, so there is no Antigravity login to open"
							: "this machine hosts no auth broker, so there is no broker login to open",
					);
				}
				cwd = launch.cwd;
				initialInput = launch.input;
				name =
					request.purpose.kind === "antigravity-login"
						? "Antigravity login"
						: `Broker login: ${request.purpose.provider}`;
			} else {
				if (request.cwd === undefined || request.cwd === "")
					throw new TerminalError("a terminal needs a working directory");
				cwd = await this.#options.resolveCwd(request.cwd);
			}
			const id = `t_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
			let terminal: PtyTerminal;
			try {
				terminal = await PtyTerminal.spawn({
					id,
					factory: this.#factory,
					shell: this.#shell,
					cwd,
					cols: size.cols,
					rows: size.rows,
					ringChars: this.#options.ringChars ?? DEFAULT_RING_CHARS,
					scrollbackLines: this.#options.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES,
					name,
					purpose: request.purpose?.kind,
					env: this.#env,
					now: this.#now,
					initialInput,
				});
			} catch (error) {
				// POSIX starts the shell through `env`, which prints its own error and exits 127; Windows rejects the spawn itself.
				// Nothing is in the table yet and `#opening` is released below, so a failed start holds no slot.
				const reason = (error instanceof Error ? error.message : String(error)).replaceAll("\0", "").split("\n")[0];
				throw new TerminalError(`could not start the shell ${this.#shell} in ${cwd}: ${reason}`);
			}
			const entry: Entry = { terminal, attachments: new Set(), owner: null, unsubscribe: [] };
			entry.unsubscribe.push(
				terminal.onOutput(() => this.#pumpAll(entry)),
				terminal.onExit(() => {
					this.audit(
						`terminal exit id=${id} code=${terminal.info.exit?.code ?? "none"} killed=${terminal.info.exit?.killed ?? false}`,
					);
					this.#pumpAll(entry);
					this.#changed();
				}),
				terminal.onSize(() => this.#pumpAll(entry)),
				terminal.onInfo(() => this.#changed()),
			);
			this.#entries.set(id, entry);
			this.audit(
				`terminal spawn id=${id} pid=${terminal.info.pid ?? "?"} cwd=${cwd} shell=${this.#shell} by=${who}${request.purpose ? ` purpose=${request.purpose.kind}` : ""}`,
			);
			this.#changed();
			return terminal.info;
		} finally {
			this.#opening--;
		}
	}

	attach(entry: Entry, attachment: Attachment): void {
		entry.attachments.add(attachment);
		entry.owner ??= attachment;
		this.applyOwnerSize(entry);
	}

	detach(attachment: Attachment): void {
		const entry = attachment.entry;
		if (!entry.attachments.delete(attachment)) return;
		if (entry.owner === attachment) {
			entry.owner = [...entry.attachments].sort((a, b) => b.lastActive - a.lastActive)[0] ?? null;
			this.applyOwnerSize(entry);
		}
	}

	/** The pty follows the owner: the client that typed last (or the first to attach). */
	applyOwnerSize(entry: Entry): void {
		if (entry.owner) entry.terminal.resize(entry.owner.cols, entry.owner.rows);
	}

	dismiss(id: string): void {
		const entry = this.entry(id);
		if (entry.terminal.running) throw new TerminalError("this terminal is still running: kill it first");
		this.#remove(entry, "dismissed");
	}

	changed(): void {
		this.#changed();
	}

	#remove(entry: Entry, reason: string): void {
		for (const off of entry.unsubscribe) off();
		for (const attachment of entry.attachments) {
			attachment.port.socket.sendPriority(JSON.stringify({ t: "term.gone", id: entry.terminal.info.id, reason }));
			attachment.port.forget(attachment);
		}
		entry.attachments.clear();
		this.#entries.delete(entry.terminal.info.id);
		entry.terminal.dispose();
		this.#changed();
	}

	#pumpAll(entry: Entry): void {
		for (const attachment of entry.attachments) attachment.pump();
	}

	#changed(): void {
		for (const listener of this.#listeners) listener();
	}
}

/** One client's view of the service: its attachments, its list subscription, the requests it makes. */
export class TerminalPort {
	readonly #attachments = new Map<string, Attachment>();
	#watching = false;
	#listTimer: ReturnType<typeof setTimeout> | null = null;
	#unsubscribe: (() => void) | null = null;
	#disposed = false;

	constructor(
		private readonly service: TerminalService,
		readonly socket: TerminalSocket,
		private readonly who: string,
		private readonly now: () => number,
	) {}

	/** The gateway can take frames again (or the client acknowledged): continue every stream. */
	pump(): void {
		for (const attachment of this.#attachments.values()) attachment.pump();
	}

	forget(attachment: Attachment): void {
		if (this.#attachments.get(attachment.id) === attachment) this.#attachments.delete(attachment.id);
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#listTimer ?? undefined);
		this.#unsubscribe?.();
		for (const attachment of this.#attachments.values()) this.service.detach(attachment);
		this.#attachments.clear();
	}

	/** Handles one request; the returned value is the ack's data (ignored for one-way requests). */
	async handle(msg: TerminalClientMessage): Promise<unknown> {
		if (this.#disposed) return undefined;
		if (!this.service.enabled && msg.t !== "term.watch")
			throw new TerminalError(DISABLED_MESSAGE, "terminal_disabled");
		switch (msg.t) {
			case "term.watch": {
				this.#watch(msg.open);
				return { capability: this.service.capability(), terminals: this.service.list() };
			}
			case "term.open": {
				const size = clampTerminalSize(msg.cols, msg.rows);
				return { terminal: await this.service.open(size, { cwd: msg.cwd, purpose: msg.purpose }, this.who) };
			}
			case "term.attach":
				return this.#attach(msg);
			case "term.detach": {
				const attachment = this.#attachments.get(msg.id);
				if (attachment) {
					this.#attachments.delete(msg.id);
					this.service.detach(attachment);
				}
				return undefined;
			}
			case "term.input": {
				const entry = this.service.entry(msg.id);
				const attachment = this.#attachments.get(msg.id);
				if (attachment) {
					attachment.lastActive = this.now();
					if (entry.owner !== attachment) {
						entry.owner = attachment;
						this.service.applyOwnerSize(entry);
					}
				}
				entry.terminal.write(msg.data);
				return undefined;
			}
			case "term.resize": {
				const attachment = this.#attachments.get(msg.id);
				if (!attachment) return undefined;
				({ cols: attachment.cols, rows: attachment.rows } = clampTerminalSize(msg.cols, msg.rows));
				if (attachment.entry.owner === attachment) this.service.applyOwnerSize(attachment.entry);
				return undefined;
			}
			case "term.ack": {
				const attachment = this.#attachments.get(msg.id);
				if (!attachment) return undefined;
				attachment.acked = Math.max(attachment.acked, Math.min(msg.bytes, attachment.sent));
				attachment.pump();
				return undefined;
			}
			case "term.kill": {
				const entry = this.service.entry(msg.id);
				this.service.audit(`terminal kill id=${msg.id} by=${this.who}`);
				await entry.terminal.kill();
				return { terminal: entry.terminal.info };
			}
			case "term.dismiss":
				this.service.audit(`terminal dismiss id=${msg.id} by=${this.who}`);
				this.service.dismiss(msg.id);
				return undefined;
		}
	}

	#attach(msg: Extract<TerminalClientMessage, { t: "term.attach" }>): unknown {
		const entry = this.service.entry(msg.id);
		const previous = this.#attachments.get(msg.id);
		const wasOwner = previous !== undefined && entry.owner === previous;
		if (previous) {
			this.#attachments.delete(msg.id);
			entry.attachments.delete(previous);
			if (wasOwner) entry.owner = null;
		}
		const size = clampTerminalSize(msg.cols, msg.rows);
		const attachment = new Attachment(this, entry, size.cols, size.rows, this.now());
		const ring = entry.terminal.ring;
		const replay = msg.offset !== null && msg.offset >= ring.start && msg.offset <= ring.head;
		if (replay) attachment.startReplay(msg.offset!);
		else attachment.startSnapshot();
		this.#attachments.set(msg.id, attachment);
		// Re-attaching keeps ownership; a client that only looks never takes the size from the one that types.
		this.service.attach(entry, attachment);
		this.service.audit(`terminal attach id=${msg.id} mode=${replay ? "replay" : "snapshot"} by=${this.who}`);
		// The ack is written by the caller after this returns; the first frames follow it.
		setImmediate(() => attachment.pump());
		return {
			mode: replay ? "replay" : "snapshot",
			offset: attachment.cursor,
			head: ring.head,
			terminal: entry.terminal.info,
		};
	}

	#watch(open: boolean): void {
		this.#watching = open;
		if (open && !this.#unsubscribe) {
			this.#unsubscribe = this.service.onChange(() => {
				if (!this.#watching || this.#listTimer !== null) return;
				this.#listTimer = setTimeout(() => {
					this.#listTimer = null;
					if (this.#disposed || !this.#watching) return;
					this.socket.sendPriority(JSON.stringify({ t: "term.list", terminals: this.service.list() }));
				}, LIST_COALESCE_MS);
			});
		} else if (!open) {
			this.#unsubscribe?.();
			this.#unsubscribe = null;
		}
	}
}
