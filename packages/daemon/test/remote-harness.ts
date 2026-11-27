import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvBroker } from "../src/env-broker";
import { EnvDialer } from "../src/env-dialer";
import { EnvHost, type ReplicaPolicy } from "../src/env-host";
import type { HandoffPort } from "../src/handoff-service";
import { SessionManager } from "../src/manager";
import { ProjectRegistry } from "../src/projects";
import type { TerminalService } from "../src/terminal-service";
import { FakeSource } from "./fake-source";
import { HELLO, type Harness } from "./gateway-harness";

/** A second machine: its own daemon pieces and a dialer registering with the gateway under its pre-shared key. */
export interface Remote {
	id: string;
	key: string;
	sources: FakeSource[];
	host: EnvHost;
	dialer: EnvDialer;
	projects: ProjectRegistry;
	manager: SessionManager;
	/** Where this machine's omp keeps its session files. */
	sessionDir: string;
	stop(): Promise<void>;
}

export interface RemoteOptions {
	key?: string;
	id?: string;
	url?: string;
	heartbeat?: { intervalMs: number; timeoutMs: number };
	start?: boolean;
	backoff?: { minMs: number; maxMs: number };
	replica?: ReplicaPolicy;
	/** Directory to use as the machine's state and session store (kept after `stop` when given: the machine "restarts"). */
	dir?: string;
	/** Whether the daemon takes the credential broker's token over its link (default true: the link is loopback). */
	acceptsBroker?: boolean;
	/** The machine's view of the credential broker (default: none). */
	broker?: EnvBroker;
	/** The machine's persistent shells (default: none, i.e. disabled). */
	terminals?: TerminalService;
	/** The machine's handoff implementation (default: none). */
	handoff?: HandoffPort;
}

/** Starts the second machine against `h`; `repo` is its registered project. */
export async function startRemote(h: Harness, repo: string, options: RemoteOptions = {}): Promise<Remote> {
	const added = await h.keys.add(`remote-${Object.keys(await h.keys.list()).length}`);
	const id = options.id ?? added.id;
	const key = options.key ?? added.key;
	const sources: FakeSource[] = [];
	const scratch = options.dir ?? mkdtempSync(join(tmpdir(), "ompweb-remote-"));
	const projects = await ProjectRegistry.open(join(scratch, "projects.json"));
	await projects.add(repo);
	const sessionDir = join(scratch, "sessions");
	const manager = new SessionManager({
		ompPath: "unused",
		sessionDir,
		resolveCwd: cwd => projects.resolveCwd(cwd),
		probeLeases: async () => ({ held: new Set(), unknown: new Set() }),
		createSource: async () => {
			const source = new FakeSource([], `remote-sess-${sources.length + 1}`);
			sources.push(source);
			return source;
		},
	});
	const host = new EnvHost(manager, projects, {
		replica: options.replica,
		broker: options.broker,
		terminals: options.terminals,
		handoff: options.handoff,
	});
	const dialer = new EnvDialer({
		url: options.url ?? `ws://127.0.0.1:${h.port}/env`,
		identity: { machineId: id, platform: "linux", hello: HELLO },
		key,
		host,
		acceptsBroker: options.acceptsBroker ?? true,
		backoff: options.backoff ?? { minMs: 10, maxMs: 30 },
		heartbeat: options.heartbeat ?? { intervalMs: 20, timeoutMs: 120 },
		handshakeTimeoutMs: 300,
	});
	if (options.start !== false) dialer.start();
	return {
		id,
		key,
		sources,
		host,
		dialer,
		projects,
		manager,
		sessionDir,
		stop: async () => {
			dialer.stop();
			host.close();
			await host.terminals.close();
			await manager.closeAll();
			if (options.dir === undefined) rmSync(scratch, { recursive: true, force: true });
		},
	};
}
