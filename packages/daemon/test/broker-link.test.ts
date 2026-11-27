import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import {
	LINK_PROTOCOL_VERSION,
	type AuthFrame,
	type BrokerLinkConfig,
	type EnvLinkMessage,
	type GatewayLinkMessage,
	type MachineSummary,
} from "@omp-web/protocol";
import { EnvBroker } from "../src/env-broker";
import type { AuthPort } from "../src/gateway";
import { linkProof } from "../src/secrets";
import { HELLO, Harness, SELF, makeRepo, type TestClient } from "./gateway-harness";
import { startRemote as startRemoteOn, type Remote, type RemoteOptions } from "./remote-harness";

const TOKEN = "gateway-broker-token-for-tests";

/** An HTTP stand-in for the broker that environments probe. */
function fakeBrokerServer(): { url: string; setMode(mode: "ok" | "unauthorized"): void; stop(): Promise<void> } {
	let mode: "ok" | "unauthorized" = "ok";
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/v1/healthz") return Response.json({ ok: true });
			if (mode === "unauthorized" || req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			return Response.json({ generatedAt: 1, disabled: [] });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		setMode: m => {
			mode = m;
		},
		stop: async () => {
			await server.stop(true);
		},
	};
}

/** The gateway-side credential service reduced to what the relay needs: which broker each machine is told to use. */
class FakeAuth implements AuthPort {
	enabled = true;
	/** What the gateway machine itself uses, and what the other machines use. */
	constructor(
		public local: string,
		public advertised: string,
	) {}
	frames(): AuthFrame[] {
		return [];
	}
	async handle(): Promise<unknown> {
		return {};
	}
	released(): void {}
	brokerConfigFor(machineId: string): BrokerLinkConfig | null {
		if (!this.enabled) return null;
		return { url: machineId === SELF ? this.local : this.advertised, token: TOKEN };
	}
}

let repo: string;
let remoteRepo: string;
let h: Harness;
let selfBroker: EnvBroker;
let auth: FakeAuth;
let fake: ReturnType<typeof fakeBrokerServer>;
const remotes: Remote[] = [];

beforeAll(async () => {
	repo = await makeRepo();
	remoteRepo = await makeRepo();
});
afterAll(() => {
	rmSync(dirname(repo), { recursive: true, force: true });
	rmSync(dirname(remoteRepo), { recursive: true, force: true });
});
beforeEach(async () => {
	fake = fakeBrokerServer();
	auth = new FakeAuth(fake.url, fake.url);
	selfBroker = new EnvBroker({ timeoutMs: 500 });
	h = await Harness.start({
		repo,
		heartbeat: { intervalMs: 20, timeoutMs: 120 },
		handshakeTimeoutMs: 300,
		auth,
		broker: selfBroker,
	});
});
afterEach(async () => {
	for (const r of remotes.splice(0)) await r.stop();
	await h.stop();
	await fake.stop();
});

const until = async (predicate: () => boolean, ms = 3000): Promise<void> => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
};

const startRemote = async (options: RemoteOptions = {}): Promise<Remote> => {
	const remote = await startRemoteOn(h, remoteRepo, options);
	remotes.push(remote);
	return remote;
};

const machine = (c: TestClient, id: string): MachineSummary | undefined =>
	(c.frames.findLast(f => f.t === "machines") as { machines: MachineSummary[] } | undefined)?.machines.find(
		m => m.id === id,
	);

/** A daemon speaking the link by hand: registers (with the flags it is told to) and records what the gateway sends. */
async function rawDaemon(options: { accepts: boolean; proofAccepts?: boolean }): Promise<{
	id: string;
	received: GatewayLinkMessage[];
	rejected: () => string | null;
	send(m: EnvLinkMessage): void;
	close(): void;
}> {
	const added = await h.keys.add(`raw-${Math.random().toString(36).slice(2, 8)}`);
	const ws = new WebSocket(`ws://127.0.0.1:${h.port}/env`);
	const received: GatewayLinkMessage[] = [];
	let rejected: string | null = null;
	ws.onmessage = e => {
		const text = String(e.data);
		if (text === '{"t":"ping"}') {
			ws.send('{"t":"pong"}');
			return;
		}
		const msg = JSON.parse(text) as GatewayLinkMessage;
		if (msg.t === "rejected") rejected = msg.reason;
		else if (msg.t === "challenge") {
			const reg: EnvLinkMessage = {
				t: "register",
				protocol: LINK_PROTOCOL_VERSION,
				machineId: added.id,
				platform: "linux",
				hello: HELLO,
				cnonce: "c",
				acceptsBroker: options.accepts,
				proof: linkProof(added.key, "env", msg.nonce, "c", added.id, options.proofAccepts ?? options.accepts),
			};
			ws.send(JSON.stringify(reg));
		} else {
			received.push(msg);
		}
	};
	await new Promise<void>(resolve => {
		ws.onopen = () => resolve();
	});
	return {
		id: added.id,
		received,
		rejected: () => rejected,
		send: m => ws.send(JSON.stringify(m)),
		close: () => ws.close(),
	};
}

describe("handing the broker to environments", () => {
	test("a machine on a protected link is handed the advertised broker, probes it, and its omp children get the variables", async () => {
		const live = fakeBrokerServer(); // the advertised address, standing in for the tailnet one
		auth.advertised = live.url;
		try {
			const broker = new EnvBroker({ timeoutMs: 500 });
			const remote = await startRemote({ broker, acceptsBroker: true });
			await until(() => broker.config !== null);
			expect(broker.config).toEqual({ url: live.url, token: TOKEN, source: "gateway" });
			expect(broker.childEnv()).toEqual({ OMP_AUTH_BROKER_URL: live.url, OMP_AUTH_BROKER_TOKEN: TOKEN });
			await until(() => broker.status().state === "ok");
			const observer = await h.connect();
			await until(() => machine(observer, remote.id)?.broker?.state === "ok");
			expect(machine(observer, remote.id)?.broker).toMatchObject({ source: "gateway", state: "ok", url: live.url });
			expect(JSON.stringify(observer.rawFrames)).not.toContain(TOKEN); // never shown to a browser
		} finally {
			await live.stop();
		}
	});

	test("the gateway machine's own environment is handed the local address, over the in-process link", async () => {
		await until(() => selfBroker.config !== null);
		expect(selfBroker.config).toEqual({ url: fake.url, token: TOKEN, source: "gateway" });
		await until(() => selfBroker.status().state === "ok");
		const observer = await h.connect();
		await until(() => machine(observer, SELF)?.broker?.state === "ok");
	});

	test("a daemon that declared it does not take the token is never sent one, and the UI says why", async () => {
		const raw = await rawDaemon({ accepts: false });
		const observer = await h.connect();
		await until(() => machine(observer, raw.id)?.online === true);
		await Bun.sleep(150); // a message the gateway would send right after registering would be here by now
		expect(raw.received.filter(m => m.t === "broker.config")).toEqual([]);
		h.gateway.brokerConfigChanged();
		await Bun.sleep(100);
		expect(raw.received.filter(m => m.t === "broker.config")).toEqual([]);
		expect(machine(observer, raw.id)?.broker).toMatchObject({ source: "none", state: "withheld" });
		expect(machine(observer, raw.id)?.broker?.message).toContain("plain ws://");
		raw.close();
	});

	test("a daemon that accepts is sent the broker right after registering, and again when it changes or is withdrawn", async () => {
		const raw = await rawDaemon({ accepts: true });
		await until(() => raw.received.some(m => m.t === "broker.config"));
		expect(raw.received.find(m => m.t === "broker.config")).toEqual({
			t: "broker.config",
			config: { url: auth.advertised, token: TOKEN },
		});
		auth.enabled = false;
		h.gateway.brokerConfigChanged();
		await until(() => raw.received.filter(m => m.t === "broker.config").length === 2);
		expect(raw.received.filter(m => m.t === "broker.config").at(-1)).toEqual({ t: "broker.config", config: null });
		raw.close();
	});

	test("the accept flag is signed: flipping it in the registration fails the proof, before anything is sent", async () => {
		// the daemon declared `false` and signed `false`; a party on the path flips the flag to `true`
		const flipped = await rawDaemon({ accepts: true, proofAccepts: false });
		await until(() => flipped.rejected() !== null);
		expect(flipped.rejected()).toBe("unknown machine or wrong key");
		expect(flipped.received.filter(m => m.t === "broker.config")).toEqual([]);
		// and the other way round
		const other = await rawDaemon({ accepts: false, proofAccepts: true });
		await until(() => other.rejected() !== null);
		expect(other.rejected()).toBe("unknown machine or wrong key");
	});

	test("a daemon refuses a gateway whose proof does not cover the flag it declared", async () => {
		const added = await h.keys.add("flag-gateway");
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		let connections = 0;
		const rogue = Bun.serve<{ nonce: string }>({
			port: 0,
			fetch: (req, srv) => (srv.upgrade(req, { data: { nonce: "n1" } }) ? undefined : new Response("no")),
			websocket: {
				open(ws) {
					connections++;
					ws.send(
						JSON.stringify({
							t: "challenge",
							nonce: ws.data.nonce,
							protocol: LINK_PROTOCOL_VERSION,
						} satisfies GatewayLinkMessage),
					);
				},
				message(ws, data) {
					const msg = JSON.parse(String(data)) as EnvLinkMessage;
					if (msg.t !== "register") return;
					// a gateway that knows the key but signed a different flag than the daemon declared
					ws.send(
						JSON.stringify({
							t: "registered",
							proof: linkProof(
								added.key,
								"gateway",
								ws.data.nonce,
								msg.cnonce,
								msg.machineId,
								!msg.acceptsBroker,
							),
						} satisfies GatewayLinkMessage),
					);
				},
			},
		});
		try {
			const remote = await startRemote({
				url: `ws://127.0.0.1:${rogue.port}/env`,
				id: added.id,
				key: added.key,
				acceptsBroker: false,
			});
			// it refused the gateway (said so) and redialled instead of registering
			await until(() =>
				warn.mock.calls.some(c => String(c[0]).includes("could not prove it knows this machine's key")),
			);
			await until(() => connections >= 2);
			expect(remote.dialer.registered).toBe(false);
		} finally {
			warn.mockRestore();
			await rogue.stop(true);
		}
	});

	test("a machine with its own broker is not called withheld, and uses its own", async () => {
		const own = fakeBrokerServer();
		try {
			const broker = new EnvBroker({ local: { url: own.url, token: TOKEN }, timeoutMs: 500 });
			broker.start(); // what the daemon does at startup: a local broker is probed without waiting for the gateway
			const remote = await startRemote({ broker, acceptsBroker: false });
			const observer = await h.connect();
			await until(() => machine(observer, remote.id)?.broker?.state === "ok");
			expect(machine(observer, remote.id)?.broker).toMatchObject({ source: "local", state: "ok", url: own.url });
			broker.stop();
		} finally {
			await own.stop();
		}
	});

	test("an environment that cannot reach its broker says so in the machine list; a rejected token says that instead", async () => {
		const live = fakeBrokerServer();
		auth.advertised = live.url;
		const broker = new EnvBroker({ timeoutMs: 300 });
		const remote = await startRemote({ broker });
		const observer = await h.connect();
		await until(() => machine(observer, remote.id)?.broker?.state === "ok");
		live.setMode("unauthorized");
		await broker.probe();
		await until(() => machine(observer, remote.id)?.broker?.state === "unauthorized");
		await live.stop();
		await broker.probe();
		await until(() => machine(observer, remote.id)?.broker?.state === "unreachable");
		const status = machine(observer, remote.id)!.broker!;
		expect(status.message).toBeTruthy();
		expect(status.lastOkAt).not.toBeNull();
		expect(status.url).toBe(live.url);
	});

	test("an offline machine shows no broker status (it is not known any more)", async () => {
		const broker = new EnvBroker({ timeoutMs: 300 });
		const remote = await startRemote({ broker });
		const observer = await h.connect();
		await until(() => machine(observer, remote.id)?.broker !== undefined);
		await remote.stop();
		remotes.splice(remotes.indexOf(remote), 1);
		await until(() => machine(observer, remote.id)?.online === false);
		expect(machine(observer, remote.id)?.broker).toBeUndefined();
	});
});
