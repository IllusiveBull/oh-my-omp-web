/**
 * The daemon <-> gateway link (one WebSocket per environment, dialed by the daemon, at `/env`; or an in-process pipe
 * for the gateway's own machine). Text frames, three kinds:
 *
 * - control messages, JSON objects: {@link GatewayLinkMessage} / {@link EnvLinkMessage};
 * - the heartbeat's `{"t":"ping"}` / `{"t":"pong"}` (see `heartbeat.ts`);
 * - frames for one virtual client (daemon -> gateway only): `<cid>\n<frame>` (see `relay.ts`). Every browser
 *   connection that uses a machine is one virtual client of that machine's daemon, identified by `cid`.
 */
import type { BrokerLinkConfig, EnvBrokerStatus } from "./broker";
import type { DaemonHello, ProjectInfo, SessionInfo } from "./messages";
import { type HandoffOpError, type HandoffOpName, isHandoffOpName } from "./handoff";
import type { AttentionEvent } from "./push";

/** Bumped on any incompatible change to the link messages. */
export const LINK_PROTOCOL_VERSION = 4;

/** Raw bytes per `replica.data` chunk (before base64): the unit of the upload's flow control. */
export const REPLICA_CHUNK_BYTES = 256 * 1024;
/** A chunk is extended to the end of the line it ends in, but never beyond this: a longer line is not replicated. */
export const REPLICA_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** Bytes hashed at each end of a replicated file to notice that it was rewritten rather than appended to. */
export const REPLICA_CHECK_BYTES = 4096;

/**
 * One session file the daemon wants the gateway to hold a copy of. `id` is a stable hash of its path on the machine;
 * `name` its base name (omp names files `<timestamp>_<session id>.jsonl`); `sessionId` the id in its header.
 */
export interface ReplicaFileMeta {
	id: string;
	name: string;
	sessionId: string;
	size: number;
	mtimeMs: number;
}

/**
 * What the gateway already holds of a file. `slotLen` is the length of omp's fixed-width title slot at the start (256
 * bytes, or 0 for files without one); `headHash` / `tailHash` are SHA-256 hex of up to {@link REPLICA_CHECK_BYTES}
 * right after the slot and ending at `size`, which is how the daemon tells an append from a rewrite.
 */
export interface ReplicaHave {
	size: number;
	slotLen: number;
	headHash: string;
	tailHash: string;
}

/** The daemon's first frame after the gateway's challenge. `proof` is an HMAC over both nonces with the pre-shared key. */
export interface EnvRegistration {
	t: "register";
	protocol: number;
	machineId: string;
	platform: string;
	hello: DaemonHello;
	/** The daemon's nonce; the gateway's `registered.proof` covers it, so the daemon can check who it is talking to. */
	cnonce: string;
	/**
	 * Whether this daemon will take the credential broker's bearer token over this link: its link is `wss://`, loopback
	 * or inside the tailnet (see `linkIsProtected` in the daemon), or it was told to. The flag is covered by both proofs,
	 * so a party on the path cannot flip it to make the gateway send the token over a link the daemon judged unsafe.
	 */
	acceptsBroker: boolean;
	proof: string;
}

export type GatewayLinkMessage =
	/** First frame of every connection. */
	| { t: "challenge"; nonce: string; protocol: number }
	| { t: "registered"; proof: string }
	| { t: "rejected"; reason: string }
	/**
	 * A browser connection started using this machine: the daemon creates a virtual client for it. `who` identifies the
	 * login (a prefix of the hash of its session cookie, never the cookie) for the daemon's audit log of terminals.
	 */
	| { t: "open"; cid: string; who?: string }
	/** The browser connection is gone: the daemon drops the virtual client's subscriptions. */
	| { t: "close"; cid: string }
	/** One browser frame (a serialized `ClientMessage`) for a virtual client; the daemon validates it again. */
	| { t: "req"; cid: string; text: string }
	/** The browser's socket is backed up: queue (coalesce, eventually resync) instead of writing. */
	| { t: "pause"; cid: string }
	| { t: "resume"; cid: string }
	/** Send the next chunk of this replicated file; `have` is what the gateway holds (null: nothing, start over). */
	| { t: "replica.want"; id: string; have: ReplicaHave | null }
	/**
	 * The credential broker this machine's omp processes should use, or null for none. Only sent to a daemon that
	 * registered with `acceptsBroker`; held in memory, never written to disk by the daemon. Sent after registration and
	 * whenever the broker (or its token) changes.
	 */
	| { t: "broker.config"; config: BrokerLinkConfig | null }
	/** A handoff operation for the daemon (`HandoffOpArgs[op]`); answered by `op.result` with the same `id`. */
	| { t: "op"; id: string; op: HandoffOpName; args: unknown }
	/** Read `len` bytes of transfer `xfer` from `offset`; answered by `xfer.data` (or `xfer.error`). */
	| { t: "xfer.read"; xfer: string; offset: number; len: number }
	/** Append a chunk to the transfer being received; `data` is base64. Answered by `xfer.ack`. */
	| { t: "xfer.write"; xfer: string; offset: number; data: string };

export type EnvLinkMessage =
	| EnvRegistration
	/** The daemon's current session list; sent when it changes, not on request. */
	| { t: "sessions"; sessions: SessionInfo[] }
	/** The registered projects with their worktrees; sent when they change. */
	| { t: "projects"; projects: ProjectInfo[] }
	/** The daemon gave up on a virtual client (it stopped reading): the gateway closes that browser connection. */
	| { t: "closed"; cid: string; reason: string }
	/** Every session file the daemon wants replicated, replacing the previous list (the gateway drops what is missing). */
	| { t: "replica.manifest"; files: ReplicaFileMeta[] }
	/**
	 * One piece of a file, answering `replica.want`. `slot` (base64, empty when the file has none) always carries the
	 * current title slot, which omp rewrites in place; `data` (base64) is the body from byte `offset` on and ends at a
	 * line end. `restart`: the gateway's copy is not a prefix of the file any more, drop it and take `data` from the
	 * slot's end. `size` / `mtimeMs` describe the file as it was before the read; `more`: bytes remain after this chunk.
	 */
	| {
			t: "replica.data";
			id: string;
			restart: boolean;
			slot: string;
			offset: number;
			data: string;
			size: number;
			mtimeMs: number;
			more: boolean;
	  }
	/** The file asked for does not exist (any more) or cannot be replicated (`reason`); the gateway forgets it. */
	| { t: "replica.skip"; id: string; reason: string }
	/** A hosted session needs a human; the gateway decides whether and where to push-notify. */
	| { t: "attention"; event: AttentionEvent }
	/** How this machine currently reaches the credential broker; sent on change and after registration. */
	| { t: "broker.status"; status: EnvBrokerStatus }
	/** The result of an `op`: `data` is `HandoffOpResult[op]`, or `error`. */
	| { t: "op.result"; id: string; ok: true; data: unknown }
	| { t: "op.result"; id: string; ok: false; error: HandoffOpError }
	/** A chunk answering `xfer.read`: `data` is base64, `eof` is true when the chunk ends the transfer. */
	| { t: "xfer.data"; xfer: string; offset: number; data: string; eof: boolean }
	/** Receipt of an `xfer.write` (`ok: false`: the chunk was not stored, the transfer is dead). */
	| { t: "xfer.ack"; xfer: string; offset: number; ok: true }
	| { t: "xfer.ack"; xfer: string; offset: number; ok: false; error: string }
	/** The transfer cannot be read (unknown id, the file is gone, I/O error). */
	| { t: "xfer.error"; xfer: string; error: string };

type Rec = Record<string, unknown>;

function parseRecord(text: string): Rec {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("link frame is not valid JSON");
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("link frame must be an object");
	const rec = raw as Rec; // a non-array object; its fields are checked by the callers
	if (typeof rec.t !== "string") throw new Error('link frame needs a string "t"');
	return rec;
}

const str = (r: Rec, k: string): string => {
	const v = r[k];
	if (typeof v !== "string") throw new Error(`link ${String(r.t)}: "${k}" must be a string`);
	return v;
};

const bool = (r: Rec, k: string): boolean => {
	const v = r[k];
	if (typeof v !== "boolean") throw new Error(`link ${String(r.t)}: "${k}" must be a boolean`);
	return v;
};

const nat = (r: Rec, k: string): number => {
	const v = r[k];
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
		throw new Error(`link ${String(r.t)}: "${k}" must be a non-negative number`);
	return v;
};

const arr = (r: Rec, k: string): unknown[] => {
	const v = r[k];
	if (!Array.isArray(v)) throw new Error(`link ${String(r.t)}: "${k}" must be an array`);
	return v;
};

export function parseGatewayLinkMessage(text: string): GatewayLinkMessage {
	const raw = parseRecord(text);
	switch (raw.t) {
		case "challenge": {
			const protocol = raw.protocol;
			if (typeof protocol !== "number") throw new Error('link challenge: "protocol" must be a number');
			return { t: "challenge", nonce: str(raw, "nonce"), protocol };
		}
		case "registered":
			return { t: "registered", proof: str(raw, "proof") };
		case "rejected":
			return { t: "rejected", reason: str(raw, "reason") };
		case "open":
			return {
				t: "open",
				cid: str(raw, "cid"),
				...(typeof raw.who === "string" ? { who: raw.who.slice(0, 64) } : {}),
			};
		case "close":
			return { t: "close", cid: str(raw, "cid") };
		case "req":
			return { t: "req", cid: str(raw, "cid"), text: str(raw, "text") };
		case "pause":
			return { t: "pause", cid: str(raw, "cid") };
		case "resume":
			return { t: "resume", cid: str(raw, "cid") };
		case "replica.want": {
			const have = raw.have;
			if (have !== null && (typeof have !== "object" || have === undefined)) {
				throw new Error('link replica.want: "have" must be an object or null');
			}
			return { t: "replica.want", id: str(raw, "id"), have: have as ReplicaHave | null };
		}
		case "broker.config": {
			const config = raw.config;
			if (config === null) return { t: "broker.config", config: null };
			if (typeof config !== "object" || Array.isArray(config)) {
				throw new Error('link broker.config: "config" must be an object or null');
			}
			const c = config as Rec;
			return { t: "broker.config", config: { url: str(c, "url"), token: str(c, "token") } };
		}
		case "op": {
			const op = str(raw, "op");
			if (!isHandoffOpName(op)) throw new Error(`link op: unknown operation "${op}"`);
			return { t: "op", id: str(raw, "id"), op, args: raw.args };
		}
		case "xfer.read":
			return { t: "xfer.read", xfer: str(raw, "xfer"), offset: nat(raw, "offset"), len: nat(raw, "len") };
		case "xfer.write":
			return { t: "xfer.write", xfer: str(raw, "xfer"), offset: nat(raw, "offset"), data: str(raw, "data") };
		default:
			throw new Error(`unknown gateway link message: ${String(raw.t)}`);
	}
}

/** Shallow validation: payloads are produced by an authenticated daemon of the same build family, not by a browser. */
export function parseEnvLinkMessage(text: string): EnvLinkMessage {
	const raw = parseRecord(text);
	switch (raw.t) {
		case "register": {
			const { protocol, hello } = raw;
			if (typeof protocol !== "number") throw new Error('link register: "protocol" must be a number');
			if (typeof hello !== "object" || hello === null) throw new Error('link register: "hello" must be an object');
			if ("home" in hello && hello.home !== undefined && typeof hello.home !== "string") {
				throw new Error('link register: "hello.home" must be a string');
			}
			return {
				t: "register",
				protocol,
				machineId: str(raw, "machineId"),
				platform: str(raw, "platform"),
				hello: hello as DaemonHello,
				cnonce: str(raw, "cnonce"),
				acceptsBroker: bool(raw, "acceptsBroker"),
				proof: str(raw, "proof"),
			};
		}
		case "sessions":
			return { t: "sessions", sessions: arr(raw, "sessions") as SessionInfo[] };
		case "projects":
			return { t: "projects", projects: arr(raw, "projects") as ProjectInfo[] };
		case "closed":
			return { t: "closed", cid: str(raw, "cid"), reason: str(raw, "reason") };
		case "replica.manifest":
			return { t: "replica.manifest", files: arr(raw, "files") as ReplicaFileMeta[] };
		case "replica.data":
			return {
				t: "replica.data",
				id: str(raw, "id"),
				restart: bool(raw, "restart"),
				slot: str(raw, "slot"),
				offset: nat(raw, "offset"),
				data: str(raw, "data"),
				size: nat(raw, "size"),
				mtimeMs: nat(raw, "mtimeMs"),
				more: bool(raw, "more"),
			};
		case "replica.skip":
			return { t: "replica.skip", id: str(raw, "id"), reason: str(raw, "reason") };
		case "attention": {
			const event = raw.event;
			if (typeof event !== "object" || event === null) throw new Error('link attention: "event" must be an object');
			return { t: "attention", event: event as AttentionEvent };
		}
		case "broker.status": {
			const status = raw.status;
			if (typeof status !== "object" || status === null || Array.isArray(status)) {
				throw new Error('link broker.status: "status" must be an object');
			}
			return { t: "broker.status", status: status as EnvBrokerStatus };
		}
		case "op.result": {
			const id = str(raw, "id");
			if (bool(raw, "ok")) return { t: "op.result", id, ok: true, data: raw.data };
			const error = raw.error;
			if (typeof error !== "object" || error === null || Array.isArray(error)) {
				throw new Error('link op.result: "error" must be an object');
			}
			const e = error as Rec;
			return {
				t: "op.result",
				id,
				ok: false,
				error: { message: str(e, "message"), kind: e.kind === "refused" ? "refused" : "failed" },
			};
		}
		case "xfer.data":
			return {
				t: "xfer.data",
				xfer: str(raw, "xfer"),
				offset: nat(raw, "offset"),
				data: str(raw, "data"),
				eof: bool(raw, "eof"),
			};
		case "xfer.ack":
			return bool(raw, "ok")
				? { t: "xfer.ack", xfer: str(raw, "xfer"), offset: nat(raw, "offset"), ok: true }
				: {
						t: "xfer.ack",
						xfer: str(raw, "xfer"),
						offset: nat(raw, "offset"),
						ok: false,
						error: str(raw, "error"),
					};
		case "xfer.error":
			return { t: "xfer.error", xfer: str(raw, "xfer"), error: str(raw, "error") };
		default:
			throw new Error(`unknown env link message: ${String(raw.t)}`);
	}
}
