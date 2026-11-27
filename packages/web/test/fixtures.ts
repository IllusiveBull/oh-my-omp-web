import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type {
	BrokerStatus,
	GatewaySessionInfo,
	LoginFlowWire,
	MachineSummary,
	ProjectInfo,
	SessionSnapshot,
	WorktreeInfo,
} from "@omp-web/protocol";

export function emptySnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		entries: [],
		stream: null,
		streamDone: false,
		activeTools: [],
		working: false,
		status: null,
		uiRequests: [],
		notices: [],
		closed: null,
		statuses: [],
		widgets: [],
		title: null,
		commands: [],
		subagents: [],
		btw: [],
		...overrides,
	};
}

export const userEntry = (id: string, text: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", content: text, timestamp: 1 },
});

export function worktree(path: string, overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
	return { path, branch: "main", main: false, ...overrides };
}

export function project(root: string, worktrees: WorktreeInfo[] = [worktree(root, { main: true })]): ProjectInfo {
	return { id: `id-${root}`, name: root.split("/").at(-1) ?? root, root, worktrees };
}

export function machineSummary(overrides: Partial<MachineSummary> = {}): MachineSummary {
	const id = overrides.id ?? "m1";
	return {
		id,
		name: id,
		platform: "darwin",
		daemonVersion: "0.0.0",
		omp: { version: "1.0.0", expectedVersion: "1.0.0", versionMismatch: false },
		leaseWarnings: [],
		online: true,
		linkId: 1,
		lastSeen: 0,
		gateway: false,
		projects: [],
		...overrides,
	};
}

export function gatewaySession(overrides: Partial<GatewaySessionInfo> = {}): GatewaySessionInfo {
	const id = overrides.id ?? "s1";
	return {
		id,
		sessionId: id,
		access: "hosted",
		cwd: "/work/app",
		phase: "idle",
		createdAt: 1,
		modifiedAt: 1,
		files: 1,
		aliases: [],
		threadId: `thread-${id}`,
		unread: false,
		...overrides,
	};
}

/** A running, healthy broker as the gateway reports it. */
export function brokerStatus(overrides: Partial<BrokerStatus> = {}): BrokerStatus {
	return {
		phase: "running",
		healthy: true,
		url: "http://127.0.0.1:8765",
		advertisedUrl: "http://100.64.0.2:8765",
		bind: "127.0.0.1:8765",
		home: "/srv/omp-web/auth-broker",
		agentDb: "/srv/omp-web/auth-broker/.omp/agent/agent.db",
		tokenFile: "/srv/omp-web/auth-broker/.omp/auth-broker.token",
		pid: 4242,
		version: "18.19.0",
		startedAt: 1_000,
		checkedAt: 2_000,
		restarts: 0,
		nextRetryAt: null,
		lastError: null,
		...overrides,
	};
}

export function loginFlow(overrides: Partial<LoginFlowWire> = {}): LoginFlowWire {
	return {
		id: "flow-1",
		providerId: "anthropic",
		providerName: "Anthropic (Claude Pro/Max)",
		startedAt: 1_000,
		status: "running",
		link: null,
		prompt: null,
		progress: [],
		failure: null,
		endedAt: null,
		...overrides,
	};
}
