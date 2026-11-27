import type { ProjectInfo, ReplicaInfo, TerminalCapability, TerminalInfo } from "@omp-web/protocol";

/** The `{ sessionId }` that `session.create` / `session.fork` / `session.resume` ack with. */
export function ackedSessionId(data: unknown): string | null {
	if (typeof data !== "object" || data === null || !("sessionId" in data)) return null;
	return typeof data.sessionId === "string" ? data.sessionId : null;
}

/** The {@link ProjectInfo} that `project.add` acks with. */
export function ackedProject(data: unknown): ProjectInfo | null {
	if (typeof data !== "object" || data === null) return null;
	if (!("root" in data) || typeof data.root !== "string") return null;
	if (!("worktrees" in data) || !Array.isArray(data.worktrees)) return null;
	return data as ProjectInfo;
}

/**
 * The {@link ReplicaInfo} a `subscribe` ack carries when the gateway answered from its own copy of the transcript
 * (machine offline); null for an answer from the machine itself, which has no `replica` key.
 */
export function ackedReplica(data: unknown): ReplicaInfo | null {
	if (typeof data !== "object" || data === null || !("replica" in data)) return null;
	const replica = data.replica;
	if (typeof replica !== "object" || replica === null) return null;
	if (!("state" in replica) || (replica.state !== "complete" && replica.state !== "partial")) return null;
	if (!("asOf" in replica) || typeof replica.asOf !== "number") return null;
	if (!("syncedAt" in replica) || typeof replica.syncedAt !== "number") return null;
	return { state: replica.state, asOf: replica.asOf, syncedAt: replica.syncedAt };
}

function isTerminalInfo(value: unknown): value is TerminalInfo {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value) || typeof value.id !== "string") return false;
	if (!("state" in value) || (value.state !== "running" && value.state !== "exited")) return false;
	return "cols" in value && typeof value.cols === "number" && "rows" in value && typeof value.rows === "number";
}

/** The {@link TerminalInfo} that `term.open` acks with (`{ terminal }`). */
export function ackedTerminal(data: unknown): TerminalInfo | null {
	if (typeof data !== "object" || data === null || !("terminal" in data)) return null;
	return isTerminalInfo(data.terminal) ? data.terminal : null;
}

/** What `term.watch` acks with: the machine's capability and its terminals. */
export function ackedTerminalWatch(
	data: unknown,
): { capability: TerminalCapability; terminals: TerminalInfo[] } | null {
	if (typeof data !== "object" || data === null) return null;
	if (!("capability" in data) || typeof data.capability !== "object" || data.capability === null) return null;
	if (!("enabled" in data.capability) || typeof data.capability.enabled !== "boolean") return null;
	if (!("terminals" in data) || !Array.isArray(data.terminals) || !data.terminals.every(isTerminalInfo)) return null;
	return { capability: data.capability as TerminalCapability, terminals: data.terminals };
}

/** What `term.attach` acks with: how the output follows, where it starts, and the terminal. */
export function ackedTerminalAttach(
	data: unknown,
): { mode: "replay" | "snapshot"; offset: number; terminal: TerminalInfo } | null {
	if (typeof data !== "object" || data === null) return null;
	if (!("mode" in data) || (data.mode !== "replay" && data.mode !== "snapshot")) return null;
	if (!("offset" in data) || typeof data.offset !== "number") return null;
	if (!("terminal" in data) || !isTerminalInfo(data.terminal)) return null;
	return { mode: data.mode, offset: data.offset, terminal: data.terminal };
}
