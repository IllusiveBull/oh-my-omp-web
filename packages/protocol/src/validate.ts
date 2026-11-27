import { type AuthMessage, MAX_LOGIN_INPUT_CHARS } from "./broker";
import {
	type ClientMessage,
	type ImageWire,
	MAX_MESSAGE_IMAGE_CHARS,
	type PermissionMode,
	type ReadMessage,
	type SessionBackend,
	type UiResponseBody,
	type ViewMessage,
} from "./messages";
import { isFilesMessageType, parseFilesMessage } from "./files";
import { HANDOFF_ID_PATTERN, type HandoffMessage, isHandoffType, type TargetChoice } from "./handoff";
import { isTerminalType, parseTerminalMessage } from "./terminal";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (r: Rec, k: string): string => {
	const v = r[k];
	if (typeof v !== "string") throw new Error(`${String(r.t)}: "${k}" must be a string`);
	return v;
};
const IMAGE_TYPES: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
};

/** `images` of a prompt / steer / follow_up: absent, or 1+ base64 images of a known type within the size cap. */
function imagesOf(r: Rec): ImageWire[] | undefined {
	const raw = r.images;
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${String(r.t)}: "images" must be a non-empty array`);
	let chars = 0;
	const images = raw.map((image: unknown): ImageWire => {
		if (typeof image !== "object" || image === null) throw new Error(`${String(r.t)}: malformed image`);
		const { data, mimeType } = image as Rec;
		if (typeof mimeType !== "string" || !IMAGE_TYPES[mimeType])
			throw new Error(`${String(r.t)}: image type must be png, jpeg, gif or webp`);
		if (typeof data !== "string" || data === "" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
			throw new Error(`${String(r.t)}: image data must be base64`);
		chars += data.length;
		return { data, mimeType: mimeType as ImageWire["mimeType"] };
	});
	if (chars > MAX_MESSAGE_IMAGE_CHARS)
		throw new Error(`${String(r.t)}: images exceed ${MAX_MESSAGE_IMAGE_CHARS} characters`);
	return images;
}

const optStr = (r: Rec, k: string): string | undefined => {
	const v = r[k];
	if (v === undefined) return undefined;
	if (typeof v !== "string") throw new Error(`${String(r.t)}: "${k}" must be a string`);
	return v;
};

function parseUiResponse(v: unknown): UiResponseBody {
	if (!isRec(v)) throw new Error("ui.response: response must be an object");
	if (typeof v.value === "string") return { value: v.value };
	if (typeof v.confirmed === "boolean") return { confirmed: v.confirmed };
	if (v.cancelled === true) return { cancelled: true };
	if (Array.isArray(v.answers)) {
		const answers = v.answers.map(a => {
			if (!isRec(a) || typeof a.id !== "string" || !Array.isArray(a.selectedOptions)) {
				throw new Error("ui.response: malformed answer");
			}
			if (!a.selectedOptions.every(o => typeof o === "string")) throw new Error("ui.response: malformed answer");
			if (a.customInput !== undefined && typeof a.customInput !== "string")
				throw new Error("ui.response: malformed answer");
			return {
				id: a.id,
				selectedOptions: a.selectedOptions as string[],
				...(a.customInput !== undefined ? { customInput: a.customInput } : {}),
			};
		});
		return { answers };
	}
	if (isRec(v.data)) {
		// A null prototype keeps a control named `__proto__` an ordinary key.
		const data: Record<string, string | number | string[]> = Object.create(null);
		for (const [name, value] of Object.entries(v.data)) {
			const ok =
				typeof value === "string" ||
				(typeof value === "number" && Number.isFinite(value)) ||
				(Array.isArray(value) && value.every(item => typeof item === "string"));
			if (!ok) throw new Error("ui.response: malformed form data");
			data[name] = value as string | number | string[];
		}
		return { data };
	}
	throw new Error("ui.response: unrecognised response shape");
}

function parseFrame(text: string): Rec {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("frame is not valid JSON");
	}
	if (!isRec(raw) || typeof raw.t !== "string") throw new Error('frame must be an object with a string "t"');
	return raw;
}

/** Parses and validates one client frame. Throws an Error with a user-presentable message; the caller acks it. */
export function parseClientMessage(text: string): ClientMessage {
	return parseClientRecord(parseFrame(text));
}

function parseClientRecord(raw: Rec): ClientMessage {
	if (isTerminalType(String(raw.t))) return parseTerminalMessage(raw);
	if (isFilesMessageType(String(raw.t))) return parseFilesMessage(raw);
	const reqId = str(raw, "reqId");
	switch (raw.t) {
		case "sessions.list":
			return { t: "sessions.list", reqId };
		case "sessions.search":
			return { t: "sessions.search", reqId, query: str(raw, "query") };
		case "session.create": {
			const backend = raw.backend;
			if (backend !== undefined && backend !== "omp" && backend !== "antigravity") {
				throw new Error('session.create: "backend" must be "omp" or "antigravity"');
			}
			const permissionMode = raw.permissionMode;
			if (
				permissionMode !== undefined &&
				permissionMode !== "ask" &&
				permissionMode !== "edits" &&
				permissionMode !== "auto"
			) {
				throw new Error('session.create: "permissionMode" must be "ask", "edits" or "auto"');
			}
			return {
				t: "session.create",
				reqId,
				cwd: str(raw, "cwd"),
				model: optStr(raw, "model"),
				...(backend !== undefined ? { backend: backend as SessionBackend } : {}),
				...(permissionMode !== undefined ? { permissionMode: permissionMode as PermissionMode } : {}),
			};
		}
		case "session.close":
			return { t: "session.close", reqId, sessionId: str(raw, "sessionId") };
		case "session.resume": {
			const confirm = raw.confirm;
			if (confirm !== undefined && typeof confirm !== "boolean") {
				throw new Error('session.resume: "confirm" must be a boolean');
			}
			return { t: "session.resume", reqId, sessionId: str(raw, "sessionId"), confirm };
		}
		case "session.fork":
			return { t: "session.fork", reqId, sessionId: str(raw, "sessionId") };
		case "session.rename": {
			const title = str(raw, "title");
			if (title.trim() === "") throw new Error('session.rename: "title" must not be empty');
			return { t: "session.rename", reqId, sessionId: str(raw, "sessionId"), title };
		}
		case "subscribe": {
			const lastSeq = raw.lastSeq;
			if (typeof lastSeq !== "number" || !Number.isInteger(lastSeq) || lastSeq < 0) {
				throw new Error('subscribe: "lastSeq" must be a non-negative integer');
			}
			return { t: "subscribe", reqId, sessionId: str(raw, "sessionId"), lastSeq, epoch: optStr(raw, "epoch") };
		}
		case "unsubscribe":
			return { t: "unsubscribe", reqId, sessionId: str(raw, "sessionId") };
		case "prompt":
		case "steer":
		case "follow_up": {
			const images = imagesOf(raw);
			return {
				t: raw.t,
				reqId,
				sessionId: str(raw, "sessionId"),
				message: str(raw, "message"),
				...(images ? { images } : {}),
			};
		}
		case "queue.remove": {
			const queue = raw.queue;
			if (queue !== "steering" && queue !== "followUp")
				throw new Error('queue.remove: "queue" must be "steering" or "followUp"');
			return { t: "queue.remove", reqId, sessionId: str(raw, "sessionId"), message: str(raw, "message"), queue };
		}
		case "session.options":
			return { t: "session.options", reqId, sessionId: str(raw, "sessionId") };
		case "session.set_model":
			return {
				t: "session.set_model",
				reqId,
				sessionId: str(raw, "sessionId"),
				provider: str(raw, "provider"),
				modelId: str(raw, "modelId"),
			};
		case "session.set_thinking":
			return { t: "session.set_thinking", reqId, sessionId: str(raw, "sessionId"), level: str(raw, "level") };
		case "session.set_mode": {
			const mode = str(raw, "mode");
			if (mode.trim() === "") throw new Error('session.set_mode: "mode" must not be empty');
			return { t: "session.set_mode", reqId, sessionId: str(raw, "sessionId"), mode };
		}
		case "session.set_permission_mode": {
			const mode = raw.mode;
			if (mode !== "ask" && mode !== "edits" && mode !== "auto") {
				throw new Error('session.set_permission_mode: "mode" must be "ask", "edits" or "auto"');
			}
			return { t: "session.set_permission_mode", reqId, sessionId: str(raw, "sessionId"), mode };
		}
		case "omp.theme":
			return { t: "omp.theme", reqId };
		case "session.context":
			return { t: "session.context", reqId, sessionId: str(raw, "sessionId") };
		case "session.roles":
			return { t: "session.roles", reqId, sessionId: str(raw, "sessionId") };
		case "session.set_role": {
			const selector = raw.selector;
			if (selector !== null && (typeof selector !== "string" || selector.trim() === ""))
				throw new Error('session.set_role: "selector" must be a non-empty string or null');
			const role = str(raw, "role");
			if (!/^[\w-]+$/.test(role)) throw new Error('session.set_role: "role" must be a role name');
			return { t: "session.set_role", reqId, sessionId: str(raw, "sessionId"), role, selector };
		}
		case "session.compact":
			return {
				t: "session.compact",
				reqId,
				sessionId: str(raw, "sessionId"),
				instructions: optStr(raw, "instructions"),
			};
		case "session.agents": {
			if (typeof raw.open !== "boolean") throw new Error('session.agents: "open" must be a boolean');
			return { t: "session.agents", reqId, sessionId: str(raw, "sessionId"), open: raw.open };
		}
		case "session.btw": {
			const question = str(raw, "question");
			if (question.trim() === "") throw new Error('session.btw: "question" must not be empty');
			return {
				t: "session.btw",
				reqId,
				sessionId: str(raw, "sessionId"),
				question,
				recordId: optStr(raw, "recordId"),
			};
		}
		case "session.btw_cancel":
			return { t: "session.btw_cancel", reqId, sessionId: str(raw, "sessionId"), recordId: optStr(raw, "recordId") };
		case "session.goal": {
			const op = str(raw, "op");
			if (op !== "create" && op !== "pause" && op !== "resume" && op !== "drop")
				throw new Error('session.goal: "op" must be create, pause, resume or drop');
			const objective = optStr(raw, "objective");
			if (op === "create" && (objective === undefined || objective.trim() === ""))
				throw new Error('session.goal: "objective" is required to create a goal');
			const tokenBudget = raw.tokenBudget;
			if (
				tokenBudget !== undefined &&
				(typeof tokenBudget !== "number" || !Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
			)
				throw new Error('session.goal: "tokenBudget" must be a positive integer');
			return { t: "session.goal", reqId, sessionId: str(raw, "sessionId"), op, objective, tokenBudget };
		}
		case "session.loop": {
			if (typeof raw.args !== "string") throw new Error('session.loop: "args" must be a string');
			return { t: "session.loop", reqId, sessionId: str(raw, "sessionId"), args: raw.args };
		}
		case "session.agent_transcript": {
			const byte = (key: "fromByte" | "beforeByte"): number | undefined => {
				const value = raw[key];
				if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
					throw new Error(`session.agent_transcript: "${key}" must be a non-negative integer`);
				}
				return value;
			};
			const fromByte = byte("fromByte");
			const beforeByte = byte("beforeByte");
			if (fromByte !== undefined && beforeByte !== undefined) {
				throw new Error('session.agent_transcript: "fromByte" and "beforeByte" are exclusive');
			}
			return {
				t: "session.agent_transcript",
				reqId,
				sessionId: str(raw, "sessionId"),
				agentId: str(raw, "agentId"),
				fromByte,
				beforeByte,
			};
		}
		case "abort":
			return { t: "abort", reqId, sessionId: str(raw, "sessionId") };
		case "ui.response":
			return {
				t: "ui.response",
				reqId,
				sessionId: str(raw, "sessionId"),
				requestId: str(raw, "requestId"),
				response: parseUiResponse(raw.response),
			};
		case "project.add":
			return { t: "project.add", reqId, path: str(raw, "path") };
		case "project.remove":
			return { t: "project.remove", reqId, root: str(raw, "root") };
		case "project.list":
			return { t: "project.list", reqId };
		case "antigravity.auth.status":
			return { t: "antigravity.auth.status", reqId };
		case "antigravity.auth.login": {
			const methodId = str(raw, "methodId");
			if (methodId.trim() === "") throw new Error('antigravity.auth.login: "methodId" must not be empty');
			return { t: "antigravity.auth.login", reqId, methodId };
		}
		case "antigravity.usage":
			return { t: "antigravity.usage", reqId };
		default:
			throw new Error(`unknown message type: ${raw.t}`);
	}
}

const nonNegativeInt = (r: Rec, k: string): number => {
	const v = r[k];
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
		throw new Error(`${String(r.t)}: "${k}" must be a non-negative integer`);
	}
	return v;
};

export type ParsedBrowserMessage =
	| { kind: "env"; machine: string; message: ClientMessage }
	| { kind: "gateway"; message: ReadMessage | ViewMessage }
	| { kind: "auth"; message: AuthMessage }
	| { kind: "handoff"; message: HandoffMessage };

function handoffId(raw: Rec): string {
	const id = str(raw, "id");
	if (!HANDOFF_ID_PATTERN.test(id)) throw new Error(`${String(raw.t)}: invalid "id"`);
	return id;
}

/** The environment-switch requests: they concern two machines, so the gateway handles them itself. */
function parseHandoffMessage(raw: Rec): HandoffMessage {
	const reqId = str(raw, "reqId");
	switch (raw.t) {
		case "handoff.plan":
			return {
				t: "handoff.plan",
				reqId,
				m: str(raw, "m"),
				sessionId: str(raw, "sessionId"),
				targetMachine: str(raw, "targetMachine"),
			};
		case "handoff.start": {
			const target = raw.target;
			if (!isRec(target)) throw new Error('handoff.start: "target" must be an object');
			let choice: TargetChoice;
			if (target.mode === "new") choice = { mode: "new" };
			else if (target.mode === "existing") {
				const worktree = str(target, "worktree");
				if (worktree === "" || worktree.length > 4096) throw new Error('handoff.start: invalid "worktree"');
				choice = { mode: "existing", worktree };
			} else throw new Error('handoff.start: "target.mode" must be "new" or "existing"');
			return {
				t: "handoff.start",
				reqId,
				m: str(raw, "m"),
				sessionId: str(raw, "sessionId"),
				targetMachine: str(raw, "targetMachine"),
				target: choice,
			};
		}
		case "handoff.confirm":
			return { t: "handoff.confirm", reqId, id: handoffId(raw) };
		case "handoff.cancel":
			return { t: "handoff.cancel", reqId, id: handoffId(raw) };
		case "handoff.dismiss":
			return { t: "handoff.dismiss", reqId, id: handoffId(raw) };
		default:
			throw new Error(`unknown message type: ${String(raw.t)}`);
	}
}

/** The `auth.*` requests: about the credential vault, not an environment, so they carry no machine id. */
function parseAuthMessage(raw: Rec): AuthMessage | null {
	if (typeof raw.t !== "string" || !raw.t.startsWith("auth.")) return null;
	const reqId = str(raw, "reqId");
	switch (raw.t) {
		case "auth.watch":
			if (typeof raw.open !== "boolean") throw new Error('auth.watch: "open" must be a boolean');
			return { t: "auth.watch", reqId, open: raw.open };
		case "auth.refresh":
			return { t: "auth.refresh", reqId };
		case "auth.usage.refresh":
			return { t: "auth.usage.refresh", reqId };
		case "auth.login.start": {
			const providerId = str(raw, "providerId");
			if (providerId === "" || providerId.length > 128) throw new Error('auth.login.start: invalid "providerId"');
			return { t: "auth.login.start", reqId, providerId };
		}
		case "auth.login.input": {
			const value = str(raw, "value");
			if (value.length > MAX_LOGIN_INPUT_CHARS) {
				throw new Error(`auth.login.input: "value" is longer than ${MAX_LOGIN_INPUT_CHARS} characters`);
			}
			return { t: "auth.login.input", reqId, flowId: str(raw, "flowId"), promptId: str(raw, "promptId"), value };
		}
		case "auth.login.cancel":
			return { t: "auth.login.cancel", reqId, flowId: str(raw, "flowId") };
		case "auth.login.dismiss":
			return { t: "auth.login.dismiss", reqId, flowId: str(raw, "flowId") };
		case "auth.logout": {
			const credentialId = raw.credentialId;
			if (typeof credentialId !== "number" || !Number.isSafeInteger(credentialId) || credentialId < 0) {
				throw new Error('auth.logout: "credentialId" must be a non-negative integer');
			}
			return { t: "auth.logout", reqId, providerId: str(raw, "providerId"), credentialId };
		}
		default:
			throw new Error(`unknown message type: ${raw.t}`);
	}
}

/**
 * Parses a browser frame: either a {@link ClientMessage} addressed to a machine (`m`) or one the gateway answers
 * itself. Throws like {@link parseClientMessage}; the caller acks the error.
 */
export function parseBrowserMessage(text: string): ParsedBrowserMessage {
	const raw = parseFrame(text);
	const auth = parseAuthMessage(raw);
	if (auth !== null) return { kind: "auth", message: auth };
	if (isHandoffType(String(raw.t))) return { kind: "handoff", message: parseHandoffMessage(raw) };
	if (raw.t === "view") {
		const sessionId = raw.sessionId;
		if (sessionId !== null && typeof sessionId !== "string") {
			throw new Error('view: "sessionId" must be a string or null');
		}
		if (typeof raw.visible !== "boolean") throw new Error('view: "visible" must be a boolean');
		return {
			kind: "gateway",
			message: { t: "view", reqId: str(raw, "reqId"), m: str(raw, "m"), sessionId, visible: raw.visible },
		};
	}
	if (raw.t === "read") {
		const reqId = str(raw, "reqId");
		const modifiedAt = raw.modifiedAt;
		if (typeof modifiedAt !== "number" || !Number.isFinite(modifiedAt) || modifiedAt < 0) {
			throw new Error('read: "modifiedAt" must be a non-negative number');
		}
		return {
			kind: "gateway",
			message: {
				t: "read",
				reqId,
				m: str(raw, "m"),
				sessionId: str(raw, "sessionId"),
				seq: nonNegativeInt(raw, "seq"),
				epoch: optStr(raw, "epoch"),
				modifiedAt,
			},
		};
	}
	const message = parseClientRecord(raw);
	return { kind: "env", machine: str(raw, "m"), message };
}
