import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUTH_COOKIE,
	PROTOCOL_VERSION,
	SnapshotAssembler,
	applySessionEvent,
	emptySessionView,
	fromSnapshot,
	toSnapshot,
	type AddressedMessage,
	type AuthFrame,
	type AuthMessage,
	type DaemonHello,
	type EnvFrame,
	type ReadMessage,
	type SequencedEvent,
	type ServerMessage,
	type SessionView,
} from "@omp-web/protocol";
import { GatewayStore } from "../src/db";
import type { EnvBroker } from "../src/env-broker";
import type { AttentionSink } from "../src/attention";
import type { HandoffPort } from "../src/handoff-service";
import { EnvHost, type EnvIdentity, type ReplicaPolicy } from "../src/env-host";
import { Gateway, type AuthPort } from "../src/gateway";
import { startGatewayServer, type GatewayServerOptions } from "../src/gateway-server";
import { registerLocalEnv, type LocalEnv } from "../src/local-env";
import { SessionManager, type SessionSpec } from "../src/manager";
import type { OutboxLimits } from "../src/outbox";
import { ProjectRegistry } from "../src/projects";
import type { TerminalService } from "../src/terminal-service";
import type { RpcSource } from "../src/rpc-source";
import { MachineKeys } from "../src/secrets";
import { FakeSource } from "./fake-source";

export const TOKEN = "test-token-".padEnd(48, "x");
export const SELF = "m_self";

export const HELLO: DaemonHello = {
	protocol: PROTOCOL_VERSION,
	daemonVersion: "test",
	omp: { version: "1.0.0", expectedVersion: "1.0.0", versionMismatch: false },
	leaseWarnings: [],
};

export async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
	return out;
}

/** A temp git repository with one commit; returns its canonical path. */
export async function makeRepo(parent = tmpdir(), name = "repo"): Promise<string> {
	const dir = join(realpathSync(mkdtempSync(join(parent, "ompweb-git-"))), name);
	mkdirSync(dir);
	await git(dir, "init", "-q", "-b", "main");
	await Bun.write(join(dir, "README.md"), "hello\n");
	await git(dir, "add", ".");
	await git(dir, "commit", "-q", "-m", "first");
	return dir;
}

export interface HarnessOptions {
	frameBytes?: number;
	updateIntervalMs?: number;
	outbox?: OutboxLimits;
	heartbeat?: GatewayServerOptions["heartbeat"];
	push?: GatewayServerOptions["push"];
	handshakeTimeoutMs?: number;
	/** Replica policy of the gateway machine's environment (default: the daemon's). */
	replica?: ReplicaPolicy;
	/** The notifier the gateway reports attention events to. */
	attention?: AttentionSink;
	/** Credential management (default: none). */
	auth?: AuthPort;
	/** The gateway machine's persistent shells (default: none, i.e. disabled). */
	terminals?: TerminalService;
	/** The gateway machine's own view of the credential broker (default: none). */
	broker?: EnvBroker;
	createSource?: (spec: SessionSpec, index: number) => Promise<RpcSource>;
	/** The gateway machine's handoff implementation (default: none, so it refuses environment switches). */
	handoff?: HandoffPort;
	sessionDir?: string;
	/** Session ids reported as held by another omp process. */
	heldIds?: Set<string>;
	/** Project root registered on the gateway machine (and the default cwd of `createSession`). */
	repo: string;
}

/** A complete gateway on a free port with its own machine registered in-process, backed by fake omp sources. */
export class Harness {
	readonly clients: TestClient[] = [];
	readonly keys: MachineKeys;
	readonly webDir: string;
	readonly #cleanup: (() => Promise<void> | void)[] = [];

	private constructor(
		readonly store: GatewayStore,
		readonly gateway: Gateway,
		readonly host: EnvHost,
		readonly manager: SessionManager,
		readonly projects: ProjectRegistry,
		readonly server: ReturnType<typeof startGatewayServer>,
		readonly local: LocalEnv,
		readonly repo: string,
		readonly sources: FakeSource[],
		readonly sessionDir: string,
		private readonly root: string,
		keys: MachineKeys,
		webDir: string,
	) {
		this.keys = keys;
		this.webDir = webDir;
	}

	static async start(options: HarnessOptions): Promise<Harness> {
		const root = mkdtempSync(join(tmpdir(), "ompweb-harness-"));
		const sessionDir = options.sessionDir ?? join(root, "sessions");
		const webDir = join(root, "web");
		await Bun.write(join(webDir, "index.html"), "<html>app shell</html>");
		await Bun.write(join(webDir, "app.js"), "console.log(1)");
		await Bun.write(join(webDir, "manifest.json"), "{}");
		await Bun.write(join(webDir, "login", "index.html"), "<html>login page</html>");
		await Bun.write(join(webDir, "login", "login.js"), "console.log('login')");
		const sources: FakeSource[] = [];
		const projects = await ProjectRegistry.open(join(root, "projects.json"));
		await projects.add(options.repo);
		const manager = new SessionManager({
			ompPath: "unused",
			sessionDir,
			resolveCwd: cwd => projects.resolveCwd(cwd),
			probeLeases: async ids => ({
				held: new Set(ids.filter(id => options.heldIds?.has(id))),
				unknown: new Set(),
			}),
			createSource:
				options.createSource === undefined
					? async () => {
							const source = new FakeSource([], `sess-${sources.length + 1}`);
							sources.push(source);
							return source;
						}
					: async spec => {
							const source = await options.createSource!(spec, sources.length);
							if (source instanceof FakeSource) sources.push(source);
							return source;
						},
		});
		const host = new EnvHost(manager, projects, {
			frameBytes: options.frameBytes,
			updateIntervalMs: options.updateIntervalMs,
			outbox: options.outbox,
			replica: options.replica,
			broker: options.broker,
			terminals: options.terminals,
			handoff: options.handoff,
		});
		const store = GatewayStore.open(":memory:");
		const gateway = new Gateway({
			store,
			selfMachineId: SELF,
			gatewayVersion: "test",
			replicaDir: join(root, "replicas"),
			attention: options.attention,
			auth: options.auth,
			outbox: options.outbox,
			heartbeat: options.heartbeat,
		});
		const identity: EnvIdentity = { machineId: SELF, platform: process.platform, hello: HELLO };
		const local = registerLocalEnv(gateway, host, identity, "gateway-box");
		const keys = new MachineKeys(join(root, "machine-keys.json"));
		const server = startGatewayServer({
			gateway,
			store,
			keys,
			token: TOKEN,
			bind: "127.0.0.1",
			port: 0,
			webDir,
			heartbeat: options.heartbeat,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			loginFailureDelayMs: 0,
			push: options.push,
		});
		return new Harness(
			store,
			gateway,
			host,
			manager,
			projects,
			server,
			local,
			options.repo,
			sources,
			sessionDir,
			root,
			keys,
			webDir,
		);
	}

	/** Where the gateway keeps its copies of the machines' session files. */
	get replicaDir(): string {
		return join(this.root, "replicas");
	}

	get port(): number {
		return this.server.port!;
	}

	get http(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** `omp_web_session=…` for a fresh login. */
	async login(): Promise<string> {
		const res = await fetch(`${this.http}/api/login`, { method: "POST", body: JSON.stringify({ token: TOKEN }) });
		if (res.status !== 204) throw new Error(`login failed: ${res.status}`);
		return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
	}

	/** A logged-in browser connection addressed at `machine` (default: the gateway's own). */
	async connect(machine = SELF, cookie?: string): Promise<TestClient> {
		const c = await TestClient.connect(`ws://127.0.0.1:${this.port}/ws`, machine, cookie ?? (await this.login()));
		this.clients.push(c);
		return c;
	}

	async createSession(client: TestClient): Promise<string> {
		const ack = await client.call({ t: "session.create", cwd: this.repo });
		if (!ack.ok) throw new Error(ack.error);
		return (ack.data as { sessionId: string }).sessionId;
	}

	onStop(fn: () => Promise<void> | void): void {
		this.#cleanup.push(fn);
	}

	async stop(): Promise<void> {
		for (const c of this.clients.splice(0)) c.close();
		for (const fn of this.#cleanup.splice(0).reverse()) await fn();
		this.local.close();
		this.gateway.close();
		this.host.close();
		await this.host.terminals.close();
		await this.manager.closeAll();
		await this.server.stop(true);
		this.store.close();
		rmSync(this.root, { recursive: true, force: true });
	}
}

/** Comparable form of a view: notice timestamps come from each side's own clock. */
export const sig = (v: SessionView): string => {
	const snapshot = toSnapshot(v);
	// `status.sessionFile` is where the serving process keeps the file: a replica's differs from its source by design.
	const status = snapshot.status && { ...snapshot.status, sessionFile: undefined };
	return JSON.stringify({ ...snapshot, status, notices: snapshot.notices.map(n => ({ ...n, at: 0 })) });
};

/** An `auth.*` message minus the request id the client assigns. */
export type AuthRequest = AuthMessage extends infer M ? (M extends AuthMessage ? Omit<M, "reqId"> : never) : never;
type Request = AddressedMessage extends infer M ? (M extends AddressedMessage ? Omit<M, "reqId" | "m"> : never) : never;
/** An ack with every field optional, so tests can read `data` / `error` without narrowing on `ok` first. */
interface Ack {
	t: "ack";
	reqId: string;
	ok: boolean;
	data?: unknown;
	error?: string;
	code?: string;
	m?: string;
}

/** Minimal browser: folds the frames of one machine the way the web client does. */
export class TestClient {
	frames: ServerMessage[] = [];
	rawFrames: string[] = [];
	view: SessionView = emptySessionView;
	lastSeq = 0;
	epoch: string | undefined;
	updateFrames = 0;
	snapshots = 0;
	closedWith: { code: number; reason: string } | null = null;
	#seq = 0;
	#assembler = new SnapshotAssembler();
	#waiters: (() => void)[] = [];

	private constructor(
		private readonly ws: WebSocket,
		readonly machine: string,
	) {
		ws.onclose = e => {
			this.closedWith = { code: e.code, reason: e.reason };
			for (const w of this.#waiters.splice(0)) w();
		};
		ws.onmessage = e => {
			const text = String(e.data);
			if (text === '{"t":"ping"}') {
				ws.send('{"t":"pong"}');
				return;
			}
			this.rawFrames.push(text);
			const m = JSON.parse(text) as ServerMessage;
			this.frames.push(m);
			if (
				"m" in m &&
				m.m === this.machine &&
				(m.t === "snapshot.begin" || m.t === "snapshot.chunk" || m.t === "snapshot.end")
			) {
				const assembled = this.#assembler.push(m as EnvFrame);
				if (assembled && assembled !== "incomplete") {
					this.view = fromSnapshot(assembled.snapshot);
					this.lastSeq = assembled.seq;
					this.epoch = assembled.epoch;
					this.snapshots++;
				}
			} else if (m.t === "events" && m.m === this.machine) {
				for (const { seq, ev } of m.events as SequencedEvent[]) {
					if (ev.k === "agent" && ev.event.type === "message_update") this.updateFrames++;
					if (seq <= this.lastSeq) continue;
					this.view = applySessionEvent(this.view, ev, 0);
					this.lastSeq = seq;
				}
			}
			for (const w of this.#waiters.splice(0)) w();
		};
	}

	static async connect(url: string, machine: string, cookie?: string): Promise<TestClient> {
		const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error("ws error"));
		});
		return new TestClient(ws, machine);
	}

	raw(text: string): void {
		this.ws.send(text);
	}

	async call(req: Request): Promise<Ack> {
		const reqId = `t${++this.#seq}`;
		this.ws.send(JSON.stringify({ ...req, m: this.machine, reqId }));
		return (await this.waitFor(m => m.t === "ack" && m.reqId === reqId)) as unknown as Ack;
	}

	/** An `auth.*` request (no machine id). */
	async callAuth(req: AuthRequest): Promise<Ack> {
		const reqId = `a${++this.#seq}`;
		this.ws.send(JSON.stringify({ ...req, reqId }));
		return (await this.waitFor(m => m.t === "ack" && m.reqId === reqId)) as unknown as Ack;
	}

	/** The newest `auth.*` frame of a type, parsed. */
	latestAuth<T extends AuthFrame["t"]>(type: T): Extract<AuthFrame, { t: T }> | undefined {
		return this.frames.findLast(f => f.t === type) as Extract<AuthFrame, { t: T }> | undefined;
	}

	async callGateway(req: Omit<ReadMessage, "reqId" | "m"> & { m?: string }): Promise<Ack> {
		const reqId = `g${++this.#seq}`;
		this.ws.send(JSON.stringify({ m: this.machine, ...req, reqId }));
		return (await this.waitFor(m => m.t === "ack" && m.reqId === reqId)) as unknown as Ack;
	}

	async waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs = 3000): Promise<ServerMessage> {
		const start = Date.now();
		for (;;) {
			const hit = this.frames.find(predicate);
			if (hit) return hit;
			if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for frame");
			await new Promise<void>(r => {
				this.#waiters.push(r);
				setTimeout(r, 50);
			});
		}
	}

	async until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
		const start = Date.now();
		while (!predicate()) {
			if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
			await Bun.sleep(10);
		}
	}

	close(): void {
		this.ws.close();
	}
}

export { AUTH_COOKIE };
