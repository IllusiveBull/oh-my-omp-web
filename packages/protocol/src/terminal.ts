/**
 * Terminal frames: persistent shells on a machine, independent of agent sessions. They travel the same way as session
 * frames (browser -> gateway -> daemon with `m`, the daemon's answers and streams back with `m` added), but the stream
 * itself is flow controlled differently from session events:
 *
 * - Offsets count UTF-16 code units (`string.length`) of the shell's output since it started. A client that holds
 *   everything up to offset N attaches with `offset: N` and receives exactly what follows, or, when the daemon no longer
 *   holds that part, a screen snapshot (`snapshot: "start"`) and the output from the snapshot's offset on.
 * - The daemon sends at most {@link TERM_ACK_WINDOW_CHARS} characters that the client has not acknowledged (`term.ack`),
 *   so a slow client never makes the daemon or the gateway buffer without limit.
 * - `term.input`, `term.resize`, `term.ack` and `term.detach` are one-way: no ack on success (an error ack, with the
 *   request's `reqId`, comes back when the terminal does not exist or terminals are disabled).
 */

export const TERM_MIN_COLS = 20;
export const TERM_MAX_COLS = 400;
export const TERM_MIN_ROWS = 5;
export const TERM_MAX_ROWS = 200;

/** Largest `data` of one `term.input` frame (a bigger paste is split by the client). */
export const TERM_MAX_INPUT_CHARS = 64 * 1024;
/** Largest `data` of one `term.out` frame (a snapshot or a replay is split into frames of about this size). */
export const TERM_FRAME_CHARS = 32 * 1024;
/** Characters the daemon may have in flight to one client for one terminal before it waits for `term.ack`. */
export const TERM_ACK_WINDOW_CHARS = 128 * 1024;
/** The client acknowledges after at least this many characters were written to its screen. */
export const TERM_ACK_EVERY_CHARS = 32 * 1024;

/** The size the pty accepts (upstream's `normalizePtyDimensions`: cols 20–400, rows 5–200). */
export function clampTerminalSize(cols: number, rows: number): { cols: number; rows: number } {
	return {
		cols: Math.min(TERM_MAX_COLS, Math.max(TERM_MIN_COLS, Math.trunc(cols))),
		rows: Math.min(TERM_MAX_ROWS, Math.max(TERM_MIN_ROWS, Math.trunc(rows))),
	};
}

/**
 * Why a terminal exists besides "the user wanted a shell".
 * - `broker-login`: opened on the gateway machine in the auth broker's home with `omp auth-broker login <provider>`
 *   typed but not run (the Accounts page's "Open in terminal").
 * - `antigravity-login`: opened on a machine with `agy acp --login` typed but not run.
 * The daemon decides the directory and the typed text; the client only names the purpose.
 */
export type TerminalPurpose =
	| {
			kind: "broker-login";
			provider: string;
	  }
	| {
			kind: "antigravity-login";
	  };

export interface TerminalExit {
	/** The shell's exit code; null when it did not report one (killed by a signal). */
	code: number | null;
	/** The daemon ended it (`term.kill`, shutdown) rather than the shell exiting on its own. */
	killed: boolean;
	at: number;
}

/** One terminal as every client lists it. Output progress (`head`) is not part of it: it would change on every byte. */
export interface TerminalInfo {
	id: string;
	/** Default label: the shell's name, or what the purpose says. */
	name: string;
	/** The title the shell or program set (OSC 0/2); null until one was set. */
	title: string | null;
	cwd: string;
	shell: string;
	pid: number | null;
	createdAt: number;
	/** The pty's current size. */
	cols: number;
	rows: number;
	state: "running" | "exited";
	exit: TerminalExit | null;
	purpose?: TerminalPurpose["kind"];
}

/** What a machine says about its terminals: whether they are allowed at all, and the limits. */
export interface TerminalCapability {
	enabled: boolean;
	/** Terminals (running and exited, until dismissed) one machine may hold. */
	max: number;
	/** The shell a new terminal starts; null while disabled. */
	shell: string | null;
	/** How much output the daemon keeps per terminal for a gap-free reattach, in characters. */
	ringChars: number;
	/** Lines of history in the screen snapshot a fresh client receives. */
	scrollbackLines: number;
}

export type TerminalClientMessage =
	/** Starts (or stops) pushing {@link TerminalEnvFrame} `term.list` to this client. Acks `{ capability, terminals }`. */
	| { t: "term.watch"; reqId: string; open: boolean }
	/** Starts a shell. `cwd` must be inside a registered project; `purpose` replaces it. Acks `{ terminal }`; attach separately. */
	| { t: "term.open"; reqId: string; cols: number; rows: number; cwd?: string; purpose?: TerminalPurpose }
	/**
	 * Receives the terminal's output. `offset`: how much of its output this client already holds (null: nothing, or it was
	 * reset). Acks `{ mode: "replay" | "snapshot", offset, head, terminal }`; `term.out` frames follow.
	 */
	| { t: "term.attach"; reqId: string; id: string; offset: number | null; cols: number; rows: number }
	| { t: "term.detach"; reqId: string; id: string }
	| { t: "term.input"; reqId: string; id: string; data: string }
	| { t: "term.resize"; reqId: string; id: string; cols: number; rows: number }
	/** The client has written `bytes` characters (cumulative since its attach) to its screen. */
	| { t: "term.ack"; reqId: string; id: string; bytes: number }
	/** Ends the shell (SIGHUP/SIGTERM, then SIGKILL). The terminal stays listed, exited, with its scrollback. */
	| { t: "term.kill"; reqId: string; id: string }
	/** Removes an exited terminal (and its scrollback) from the list. */
	| { t: "term.dismiss"; reqId: string; id: string };

const ONEWAY: Record<string, true> = { "term.detach": true, "term.input": true, "term.resize": true, "term.ack": true };

/** Requests the daemon answers only when they fail (the gateway does not wait for an ack either). */
export function isTerminalOneway(t: string): boolean {
	return Object.hasOwn(ONEWAY, t);
}

export function isTerminalType(t: string): boolean {
	return t.startsWith("term.");
}

export type TerminalEnvFrame =
	/** The machine's terminals, replaced wholesale; sent to clients that `term.watch`, on every change (coalesced). */
	| { t: "term.list"; terminals: TerminalInfo[] }
	/**
	 * Output at `offset`. `snapshot: "start"` first resets the client's screen (`offset` is then the offset the snapshot
	 * corresponds to), `"part"` continues a snapshot; snapshot frames do not advance the client's offset, the live frames
	 * that follow continue at the snapshot's offset.
	 */
	| { t: "term.out"; id: string; offset: number; data: string; snapshot?: "start" | "part" }
	/** The pty was resized; in order with `term.out`, so output drawn for the new size lands on the new size. */
	| { t: "term.size"; id: string; cols: number; rows: number }
	/** The shell ended; sent after all of its output. */
	| { t: "term.exit"; id: string; code: number | null; killed: boolean }
	/** The terminal was dismissed (by any client) or lost; no further frames. */
	| { t: "term.gone"; id: string; reason: string };

type Rec = Record<string, unknown>;

const str = (r: Rec, k: string, max = 256): string => {
	const v = r[k];
	if (typeof v !== "string") throw new Error(`${String(r.t)}: "${k}" must be a string`);
	if (v.length > max) throw new Error(`${String(r.t)}: "${k}" is longer than ${max} characters`);
	return v;
};
const dimension = (r: Rec, k: string): number => {
	const v = r[k];
	if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 100_000) {
		throw new Error(`${String(r.t)}: "${k}" must be a positive number`);
	}
	return Math.trunc(v);
};
const count = (r: Rec, k: string): number => {
	const v = r[k];
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
		throw new Error(`${String(r.t)}: "${k}" must be a non-negative integer`);
	}
	return v;
};

/** Validates one `term.*` client frame; throws an Error with a presentable message. */
export function parseTerminalMessage(raw: Rec): TerminalClientMessage {
	const reqId = typeof raw.reqId === "string" ? raw.reqId : str(raw, "reqId");
	switch (raw.t) {
		case "term.watch":
			if (typeof raw.open !== "boolean") throw new Error('term.watch: "open" must be a boolean');
			return { t: "term.watch", reqId, open: raw.open };
		case "term.open": {
			const purpose = raw.purpose;
			let parsed: TerminalPurpose | undefined;
			if (purpose !== undefined) {
				if (typeof purpose !== "object" || purpose === null || Array.isArray(purpose)) {
					throw new Error('term.open: "purpose" must be an object');
				}
				const p = purpose as Rec;
				if (p.kind === "broker-login") {
					const provider = str({ ...p, t: "term.open" }, "provider", 128);
					if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider))
						throw new Error('term.open: invalid purpose "provider"');
					parsed = { kind: "broker-login", provider };
				} else if (p.kind === "antigravity-login") {
					parsed = { kind: "antigravity-login" };
				} else {
					throw new Error('term.open: unknown purpose "kind"');
				}
			}
			const cwd = raw.cwd === undefined ? undefined : str(raw, "cwd", 4096);
			return {
				t: "term.open",
				reqId,
				cols: dimension(raw, "cols"),
				rows: dimension(raw, "rows"),
				...(cwd === undefined ? {} : { cwd }),
				...(parsed === undefined ? {} : { purpose: parsed }),
			};
		}
		case "term.attach": {
			const offset = raw.offset;
			if (offset !== null && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) {
				throw new Error('term.attach: "offset" must be a non-negative integer or null');
			}
			return {
				t: "term.attach",
				reqId,
				id: str(raw, "id", 64),
				offset,
				cols: dimension(raw, "cols"),
				rows: dimension(raw, "rows"),
			};
		}
		case "term.detach":
			return { t: "term.detach", reqId, id: str(raw, "id", 64) };
		case "term.input":
			return { t: "term.input", reqId, id: str(raw, "id", 64), data: str(raw, "data", TERM_MAX_INPUT_CHARS) };
		case "term.resize":
			return {
				t: "term.resize",
				reqId,
				id: str(raw, "id", 64),
				cols: dimension(raw, "cols"),
				rows: dimension(raw, "rows"),
			};
		case "term.ack":
			return { t: "term.ack", reqId, id: str(raw, "id", 64), bytes: count(raw, "bytes") };
		case "term.kill":
			return { t: "term.kill", reqId, id: str(raw, "id", 64) };
		case "term.dismiss":
			return { t: "term.dismiss", reqId, id: str(raw, "id", 64) };
		default:
			throw new Error(`unknown message type: ${String(raw.t)}`);
	}
}
