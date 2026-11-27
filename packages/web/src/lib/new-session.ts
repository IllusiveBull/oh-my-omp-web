import type { AckErrorCode, PermissionMode, SessionBackend } from "@omp-web/protocol";
import type { DaemonClient } from "../store/daemon-client";
import { ackedSessionId } from "./ack";

const BACKEND_KEY = "omp-web.backend";
const PERMISSION_MODE_KEY = "omp-web.antigravity.permission-mode";

export function loadBackendPreference(storage: Pick<Storage, "getItem"> | undefined): SessionBackend {
	try {
		return storage?.getItem(BACKEND_KEY) === "antigravity" ? "antigravity" : "omp";
	} catch {
		return "omp";
	}
}

export function saveBackendPreference(storage: Pick<Storage, "setItem"> | undefined, backend: SessionBackend): void {
	try {
		storage?.setItem(BACKEND_KEY, backend);
	} catch {
		// Ignore storage failures (private browsing / disabled storage).
	}
}

export function loadPermissionModePreference(
	storage: Pick<Storage, "getItem"> | undefined,
): PermissionMode | undefined {
	try {
		const value = storage?.getItem(PERMISSION_MODE_KEY);
		return value === "ask" || value === "edits" || value === "auto" ? value : undefined;
	} catch {
		return undefined;
	}
}

export function savePermissionModePreference(
	storage: Pick<Storage, "setItem"> | undefined,
	mode: PermissionMode,
): void {
	try {
		storage?.setItem(PERMISSION_MODE_KEY, mode);
	} catch {
		// Ignore storage failures (private browsing / disabled storage).
	}
}

/** Starts a session in `cwd` on `machine` ("New session" and `/new`): its id, or why it did not start. */
export async function startSession(
	client: DaemonClient,
	machine: string,
	cwd: string,
	backend?: SessionBackend,
	permissionMode?: PermissionMode,
): Promise<{ ok: true; id: string } | { ok: false; error: string; code?: AckErrorCode }> {
	const ack = await client.request(machine, {
		t: "session.create",
		cwd,
		...(backend && backend !== "omp" ? { backend } : {}),
		...(backend === "antigravity" && permissionMode ? { permissionMode } : {}),
	});
	if (!ack.ok) return { ok: false, error: ack.error, ...(ack.code ? { code: ack.code } : {}) };
	const id = ackedSessionId(ack.data);
	return id === null ? { ok: false, error: "the daemon did not report the new session" } : { ok: true, id };
}
