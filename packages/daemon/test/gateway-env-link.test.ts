import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	LINK_PROTOCOL_VERSION,
	type EnvLinkMessage,
	type GatewayLinkMessage,
	type MachineSummary,
} from "@omp-web/protocol";
import { linkProof } from "../src/secrets";
import { loadTurn, replayTurn } from "./fake-source";
import { HELLO, Harness, makeRepo, sig, type TestClient } from "./gateway-harness";
import { startRemote as startRemoteOn, type Remote, type RemoteOptions } from "./remote-harness";
import { makeLink } from "./links";

let repo: string;
let remoteRepo: string;
let h: Harness;
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
	h = await Harness.start({ repo, heartbeat: { intervalMs: 20, timeoutMs: 120 }, handshakeTimeoutMs: 300 });
});
afterEach(async () => {
	for (const r of remotes.splice(0)) await r.stop();
	await h.stop();
});

const startRemote = async (options: RemoteOptions = {}): Promise<Remote> => {
	const remote = await startRemoteOn(h, remoteRepo, options);
	remotes.push(remote);
	return remote;
};

const until = async (predicate: () => boolean, ms = 3000): Promise<void> => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
};

const machine = (c: TestClient, id: string): MachineSummary | undefined =>
	(c.frames.findLast(f => f.t === "machines") as { machines: MachineSummary[] } | undefined)?.machines.find(
		m => m.id === id,
	);

describe("registration", () => {
	test("a daemon with the right key registers: the machine shows online with its details, and a session on it streams through the gateway", async () => {
		const remote = await startRemote();
		const client = await h.connect(remote.id);
		await until(() => machine(client, remote.id)?.online === true);
		expect(machine(client, remote.id)).toMatchObject({
			name: "remote-0",
			platform: "linux",
			online: true,
			gateway: false,
			linkId: 1,
		});
		expect(remote.dialer.registered).toBe(true);

		const created = await client.call({ t: "session.create", cwd: remoteRepo });
		expect(created.ok).toBe(true);
		const id = (created.data as { sessionId: string }).sessionId;
		await client.waitFor(m => m.t === "sessions" && m.m === remote.id && m.sessions.some(s => s.id === id));
		await client.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		await replayTurn(remote.sources[0]!, await loadTurn());
		await client.until(() => client.view.status?.isStreaming === false && client.view.entries.length === 6);
		expect(remote.sources[0]!.state.sessionId).toBe("remote-sess-1");

		// the same machine id on the gateway's own machine is a different session namespace: nothing leaked there
		const own = await h.connect();
		await own.waitFor(m => m.t === "sessions" && m.m === remote.id);
		expect(
			(own.frames.findLast(f => f.t === "sessions" && f.m === own.machine) as { sessions: unknown[] }).sessions,
		).toHaveLength(0);
	});

	test("a wrong key, and an unknown machine id, are rejected with the same answer and never appear online", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const real = await h.keys.add("real");
			const wrongKey = await startRemote({ id: real.id, key: "not-the-key" });
			const unknown = await startRemote({ id: "m_unknown", key: real.key });
			await until(() => warn.mock.calls.filter(c => String(c[0]).includes("gateway rejected")).length >= 2);
			const reasons = new Set(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes("gateway rejected")));
			expect([...reasons]).toEqual(["omp-webd: the gateway rejected this machine: unknown machine or wrong key"]);
			expect(wrongKey.dialer.registered).toBe(false);
			expect(unknown.dialer.registered).toBe(false);
			expect(h.gateway.machines().map(m => m.id)).toEqual(["m_self"]);
		} finally {
			warn.mockRestore();
		}
	});

	test("a gateway that cannot prove it knows the key is not trusted by the daemon", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const fake = Bun.serve<{ nonce: string }>({
			port: 0,
			fetch: (req, srv) => (srv.upgrade(req, { data: { nonce: "n1" } }) ? undefined : new Response("no")),
			websocket: {
				open(ws) {
					ws.send(
						JSON.stringify({
							t: "challenge",
							nonce: ws.data.nonce,
							protocol: LINK_PROTOCOL_VERSION,
						} satisfies GatewayLinkMessage),
					);
				},
				message(ws) {
					ws.send(JSON.stringify({ t: "registered", proof: "forged" } satisfies GatewayLinkMessage));
				},
			},
		});
		try {
			const remote = await startRemote({ url: `ws://127.0.0.1:${fake.port}/env` });
			await until(() => warn.mock.calls.some(c => String(c[0]).includes("could not prove")));
			expect(remote.dialer.registered).toBe(false);
			expect(remote.host.clientCount).toBe(0);
		} finally {
			warn.mockRestore();
			await fake.stop(true);
		}
	});

	test("a daemon that never answers the challenge is dropped after the handshake timeout", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${h.port}/env`);
		const closed = new Promise<{ code: number; reason: string }>(resolve => {
			ws.onclose = e => resolve({ code: e.code, reason: e.reason });
		});
		expect(await closed).toEqual({ code: 4401, reason: "handshake timed out" });
	});
});

describe("projects and the cwd restriction, end to end through the gateway", () => {
	test("sessions can only start inside a registered project; escapes through symlinks are refused; registering a project opens it up", async () => {
		const remote = await startRemote();
		const client = await h.connect(remote.id);
		// "online" comes with registration; the daemon pushes its project list a moment later (after its first session scan)
		await until(() => (machine(client, remote.id)?.projects.length ?? 0) > 0);
		expect(machine(client, remote.id)?.projects).toMatchObject([{ root: remoteRepo, name: "repo" }]);

		const outside = mkdtempSync(join(tmpdir(), "ompweb-outside-"));
		const refused = await client.call({ t: "session.create", cwd: outside });
		expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("not inside a registered project") });
		const link = join(remoteRepo, "escape-link");
		makeLink(outside, link);
		expect(await client.call({ t: "session.create", cwd: link })).toMatchObject({
			ok: false,
			error: expect.stringContaining("not inside a registered project"),
		});
		expect(remote.sources).toHaveLength(0);
		const sub = join(remoteRepo, "src");
		mkdirSync(sub);
		expect((await client.call({ t: "session.create", cwd: sub })).ok).toBe(true);

		// register the other directory as a project (it must be a repository), then it is allowed
		expect(await client.call({ t: "project.add", path: outside })).toMatchObject({ ok: false });
		const elsewhere = await makeRepo();
		try {
			const added = await client.call({ t: "project.add", path: elsewhere });
			expect(added).toMatchObject({ ok: true, data: { root: elsewhere, name: "repo" } });
			await until(() => machine(client, remote.id)?.projects.length === 2);
			expect((await client.call({ t: "session.create", cwd: elsewhere })).ok).toBe(true);
			expect(await client.call({ t: "project.remove", root: elsewhere })).toMatchObject({ ok: true });
			await until(() => machine(client, remote.id)?.projects.length === 1);
			expect((await client.call({ t: "session.create", cwd: elsewhere })).ok).toBe(false);
		} finally {
			rmSync(dirname(elsewhere), { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("the link drops mid-stream", () => {
	test("after the daemon re-registers, a browser that resubscribes with lastSeq/epoch gets a replay and ends identical to a fresh one; the machine's cached lists stay visible meanwhile", async () => {
		const remote = await startRemote({ backoff: { minMs: 400, maxMs: 400 } }); // slow redial: the offline window is observable
		const client = await h.connect(remote.id);
		await until(() => machine(client, remote.id)?.online === true);
		const created = await client.call({ t: "session.create", cwd: remoteRepo });
		const id = (created.data as { sessionId: string }).sessionId;
		await client.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		const fixture = await loadTurn();
		const half = Math.floor(fixture.events.length / 2);
		const source = remote.sources[0]!;
		await replayTurn(source, { events: fixture.events.slice(0, half), entries: fixture.entries });
		await client.until(() => client.view.entries.length > 0);
		const seenSeq = client.lastSeq;
		const epoch = client.epoch;
		const snapshotsBefore = client.snapshots;

		// the link goes away in the middle of the turn; omp keeps running on the machine
		h.gateway.disconnectEnv(remote.id, "test: link drop");
		await client.until(() => machine(client, remote.id)?.online === false);
		const offline = await client.call({ t: "sessions.list" });
		expect(offline).toMatchObject({ ok: false, error: "remote-0 is offline" });
		await replayTurn(source, { events: fixture.events.slice(half), entries: fixture.entries });
		// the cached session list is still what a new browser sees, marked by the machine being offline
		const late = await h.connect(remote.id);
		await late.waitFor(m => m.t === "sessions" && m.m === remote.id && m.sessions.some(s => s.id === id));
		expect(machine(late, remote.id)).toMatchObject({ online: false });

		// the daemon redials; the browser sees the new link id and resubscribes as the web client does
		await until(() => machine(client, remote.id)?.online === true && machine(client, remote.id)?.linkId === 2);
		const ack = await client.call({ t: "subscribe", sessionId: id, lastSeq: seenSeq, epoch });
		expect(ack).toMatchObject({ ok: true, data: { mode: "replay" } });
		expect(client.snapshots).toBe(snapshotsBefore); // no snapshot: the gap-free tail was enough
		await client.until(() => client.view.status?.isStreaming === false && client.view.entries.length === 6);
		const fresh = await h.connect(remote.id);
		await fresh.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		await fresh.until(() => fresh.view.entries.length === 6);
		expect(sig(client.view)).toBe(sig(fresh.view));
	});

	test("requests in flight when the link drops are answered with an error instead of hanging", async () => {
		const remote = await startRemote();
		const client = await h.connect(remote.id);
		await until(() => machine(client, remote.id)?.online === true);
		const created = await client.call({ t: "session.create", cwd: remoteRepo });
		const id = (created.data as { sessionId: string }).sessionId;
		// a compaction that never finishes on the machine
		const source = remote.sources[0]!;
		source.compact = async instructions => {
			source.compactions.push(instructions);
			await new Promise<never>(() => {});
		};
		const pending = client.call({ t: "session.compact", sessionId: id });
		await until(() => source.compactions.length === 1);
		h.gateway.disconnectEnv(remote.id, "test: link drop");
		expect(await pending).toMatchObject({ ok: false, error: "remote-0 went offline" });
	});

	test("a daemon restart (a new process behind the same machine id) gives the browser a snapshot, not a bogus replay", async () => {
		const remote = await startRemote();
		const client = await h.connect(remote.id);
		await until(() => machine(client, remote.id)?.online === true);
		const created = await client.call({ t: "session.create", cwd: remoteRepo });
		const id = (created.data as { sessionId: string }).sessionId;
		await client.call({ t: "subscribe", sessionId: id, lastSeq: 0 });
		remote.sources[0]!.emit({ type: "agent_start" } as never);
		await client.until(() => client.lastSeq > 0);
		const stale = { lastSeq: client.lastSeq, epoch: client.epoch };
		await remote.stop();
		await until(() => machine(client, remote.id)?.online === false);
		const restarted = await startRemote({ id: remote.id, key: remote.key });
		await until(() => machine(client, remote.id)?.online === true && machine(client, remote.id)?.linkId === 2);
		// the restarted process does not know the session any more
		const ack = await client.call({ t: "subscribe", sessionId: id, ...stale });
		expect(ack.ok).toBe(false);
		expect(restarted.sources).toHaveLength(0);
	});
});

describe("heartbeat", () => {
	/** Registers a machine by hand and then never answers anything, like a peer whose network vanished. */
	async function silentDaemon(): Promise<{ id: string; ws: WebSocket; pings: () => number }> {
		const { id, key } = await h.keys.add("silent");
		const ws = new WebSocket(`ws://127.0.0.1:${h.port}/env`);
		let pings = 0;
		ws.onmessage = e => {
			const text = String(e.data);
			if (text === '{"t":"ping"}') {
				pings++;
				return;
			}
			const msg = JSON.parse(text) as GatewayLinkMessage;
			if (msg.t === "challenge") {
				const reg: EnvLinkMessage = {
					t: "register",
					protocol: LINK_PROTOCOL_VERSION,
					machineId: id,
					platform: "linux",
					hello: HELLO,
					cnonce: "c",
					acceptsBroker: false,
					proof: linkProof(key, "env", msg.nonce, "c", id, false),
				};
				ws.send(JSON.stringify(reg));
			}
		};
		await new Promise<void>(resolve => {
			ws.onopen = () => resolve();
		});
		return { id, ws, pings: () => pings };
	}

	test("the gateway takes a machine offline when its link goes silent (no FIN needed)", async () => {
		const observer = await h.connect();
		const silent = await silentDaemon();
		await until(() => machine(observer, silent.id)?.online === true);
		await until(() => machine(observer, silent.id)?.online === false);
		expect(silent.pings()).toBeGreaterThan(0); // it was pinged before being given up on
		silent.ws.close();
	});

	test("a daemon whose gateway goes silent drops the link and dials again", async () => {
		let connections = 0;
		const fake = Bun.serve<{ nonce: string }>({
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
					if (msg.t !== "register") return; // after the handshake this gateway answers nothing, not even pings
					ws.send(
						JSON.stringify({
							t: "registered",
							proof: linkProof(
								remote.key,
								"gateway",
								ws.data.nonce,
								msg.cnonce,
								msg.machineId,
								msg.acceptsBroker,
							),
						} satisfies GatewayLinkMessage),
					);
				},
			},
		});
		const remote = await startRemote({ url: `ws://127.0.0.1:${fake.port}/env`, start: false });
		try {
			remote.dialer.start();
			await until(() => remote.dialer.registered);
			await until(() => !remote.dialer.registered); // heartbeat found the link dead
			await until(() => connections >= 2); // and it redialed
		} finally {
			await fake.stop(true);
		}
	});

	test("a browser connection that stops answering is closed; one that answers is kept", async () => {
		const cookie = await h.login();
		const deaf = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, { headers: { cookie } } as never);
		const closed = new Promise<number>(resolve => {
			deaf.onclose = e => resolve(e.code);
		});
		const alive = await h.connect();
		await closed; // TestClient answers pings, so only the deaf one is dropped
		await Bun.sleep(150); // a negative assertion: the answering client is still open after several intervals
		expect(alive.closedWith).toBeNull();
		await alive.waitFor(m => m.t === "hello");
	});
});
