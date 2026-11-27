import { beforeEach, describe, expect, test } from "bun:test";
import {
	PING_FRAME,
	PONG_FRAME,
	clientFrame,
	type EnvLinkMessage,
	type GatewayLinkMessage,
	type ServerMessage,
	type SessionInfo,
} from "@omp-web/protocol";
import { GatewayStore } from "../src/db";
import { Gateway, type BrowserConn, type BrowserSocket, type EnvPeer } from "../src/gateway";
import type { LinkEnd } from "../src/link-end";
import type { OutboxLimits } from "../src/outbox";
import { HELLO } from "./gateway-harness";

class FakeLink implements LinkEnd {
	sent: string[] = [];
	closed: { code?: number; reason?: string } | null = null;
	terminated = false;
	send(text: string): void {
		this.sent.push(text);
	}
	bufferedAmount(): number {
		return 0;
	}
	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}
	terminate(): void {
		this.terminated = true;
	}
	/** Control messages the gateway sent (client frames and heartbeats filtered out). */
	get control(): GatewayLinkMessage[] {
		return this.sent
			.filter(t => t.startsWith("{") && t !== PING_FRAME && t !== PONG_FRAME)
			.map(t => JSON.parse(t) as GatewayLinkMessage);
	}
}

class FakeBrowser implements BrowserSocket {
	sent: string[] = [];
	buffered = 0;
	closed: { code?: number; reason?: string } | null = null;
	terminated = false;
	send(text: string): number {
		this.sent.push(text);
		return text.length;
	}
	getBufferedAmount(): number {
		return this.buffered;
	}
	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}
	terminate(): void {
		this.terminated = true;
	}
	get frames(): ServerMessage[] {
		return this.sent.filter(t => t !== PING_FRAME && t !== PONG_FRAME).map(t => JSON.parse(t) as ServerMessage);
	}
}

const limits: OutboxLimits = { highWater: 1000, queueCap: 50_000, hardLimit: 20_000 };
const info = (id: string, modifiedAt = 1): SessionInfo => ({
	id,
	sessionId: id,
	access: "free",
	cwd: "/p",
	phase: "stored",
	createdAt: 1,
	modifiedAt,
	files: 1,
	aliases: [],
});

let gateway: Gateway;
let store: GatewayStore;
let now: number;
/** These tests never copy a file, so the replica directory is never created. */
const replicaRoot = "/nonexistent/omp-web-replicas";

beforeEach(() => {
	now = 1_000;
	store = GatewayStore.open(":memory:");
	gateway = new Gateway({
		store,
		selfMachineId: "m_a",
		gatewayVersion: "t",
		replicaDir: replicaRoot,
		outbox: limits,
		heartbeat: { intervalMs: 3_600_000, timeoutMs: 7_200_000 },
		now: () => now,
	});
});

const register = (id: string, link = new FakeLink()): { link: FakeLink; peer: EnvPeer } => ({
	link,
	peer: gateway.attachEnv(
		{ machineId: id, name: `box-${id}`, platform: "linux", hello: HELLO, acceptsBroker: false },
		link,
	),
});

const browser = (): { socket: FakeBrowser; conn: BrowserConn } => {
	const socket = new FakeBrowser();
	return { socket, conn: gateway.attachBrowser(socket) };
};

const request = (reqId: string, m: string, extra: object = {}): string =>
	JSON.stringify({ t: "sessions.list", reqId, m, ...extra });
const lastMachines = (socket: FakeBrowser) => socket.frames.findLast(f => f.t === "machines");

describe("registry", () => {
	test("machine home survives offline restart but is cleared by a legacy reconnect", () => {
		const peer = gateway.attachEnv(
			{
				machineId: "m_b",
				name: "remote",
				platform: "win32",
				hello: { ...HELLO, home: "D:\\Profiles\\Me" },
				acceptsBroker: false,
			},
			new FakeLink(),
		);
		const { socket, conn } = browser();
		expect(lastMachines(socket)).toMatchObject({ machines: [{ id: "m_b", home: "D:\\Profiles\\Me" }] });
		peer.closed();
		gateway.detachBrowser(conn);
		gateway.close();
		const restarted = new Gateway({ store, selfMachineId: "m_a", gatewayVersion: "t", replicaDir: replicaRoot });
		expect(restarted.machines()).toMatchObject([{ id: "m_b", home: "D:\\Profiles\\Me", online: false }]);
		const afterRestartSocket = new FakeBrowser();
		const afterRestartConn = restarted.attachBrowser(afterRestartSocket);
		restarted.attachEnv(
			{ machineId: "m_b", name: "remote", platform: "win32", hello: HELLO, acceptsBroker: false },
			new FakeLink(),
		);
		expect(lastMachines(afterRestartSocket)).toMatchObject({ machines: [{ id: "m_b", online: true }] });
		const frame = lastMachines(afterRestartSocket);
		expect(frame?.t === "machines" && frame.machines[0]?.home).toBeUndefined();
		expect(store.machines()[0]?.home).toBeUndefined();
		restarted.detachBrowser(afterRestartConn);
		restarted.close();
		store.close();
	});

	test("nicknames broadcast to browsers, survive reconnect and restart, and clear back to the registered name", () => {
		const first = register("m_b");
		const a = browser();
		const b = browser();
		expect(gateway.setMachineNickname("m_b", "Work laptop")).toBe(true);
		for (const { socket } of [a, b]) {
			expect(lastMachines(socket)).toMatchObject({
				machines: [{ name: "Work laptop", originalName: "box-m_b" }],
			});
		}
		expect(gateway.nameOf("m_b")).toBe("Work laptop");
		first.peer.closed();
		register("m_b");
		expect(gateway.machines()[0]).toMatchObject({ name: "Work laptop", originalName: "box-m_b" });
		const restarted = new Gateway({ store, selfMachineId: "m_a", gatewayVersion: "t", replicaDir: replicaRoot });
		try {
			expect(restarted.machines()[0]).toMatchObject({ name: "Work laptop", online: false });
			expect(restarted.setMachineNickname("m_b", null)).toBe(true);
			expect(restarted.machines()[0]!.name).toBe("box-m_b");
			expect(restarted.machines()[0]!.originalName).toBeUndefined();
			expect(store.machines()[0]!.nickname).toBeUndefined();
			expect(restarted.setMachineNickname("missing", "x")).toBe(false);
		} finally {
			restarted.close();
			for (const { conn } of [a, b]) gateway.detachBrowser(conn);
			gateway.close();
			store.close();
		}
	});

	test("machines come online with a link id that grows on every registration, and go offline when the link ends", () => {
		const { peer } = register("m_b");
		const { socket } = browser();
		expect(lastMachines(socket)).toMatchObject({
			machines: [{ id: "m_b", online: true, linkId: 1, name: "box-m_b", platform: "linux" }],
		});
		now = 5_000;
		peer.closed();
		expect(lastMachines(socket)).toMatchObject({
			machines: [{ id: "m_b", online: false, linkId: 1, lastSeen: 5_000 }],
		});
		register("m_b");
		expect(lastMachines(socket)).toMatchObject({ machines: [{ id: "m_b", online: true, linkId: 2 }] });
		// persisted: a restarted gateway still lists it, offline
		const restarted = new Gateway({ store, selfMachineId: "m_a", gatewayVersion: "t", replicaDir: replicaRoot });
		expect(restarted.machines()).toMatchObject([{ id: "m_b", online: false, linkId: 0 }]);
	});

	test("a second link for the same machine replaces the first (a half-open one may not have been noticed yet)", () => {
		const first = register("m_b");
		const second = register("m_b");
		expect(first.link.terminated).toBe(true);
		expect(first.peer.detached).toBe(true);
		expect(gateway.peerOf("m_b")).toBe(second.peer);
		first.peer.closed(); // the old socket finally closes: must not take the machine offline
		expect(gateway.machines()[0]).toMatchObject({ online: true, linkId: 2 });
	});

	test("the gateway's own machine is listed first and flagged", () => {
		register("m_z");
		register("m_a");
		register("m_b");
		expect(gateway.machines().map(m => [m.id, m.gateway])).toEqual([
			["m_a", true],
			["m_b", false],
			["m_z", false],
		]);
	});

	test("session lists are cached: an offline machine's list is still sent, with unread flags", () => {
		const { peer } = register("m_b");
		peer.receive(JSON.stringify({ t: "sessions", sessions: [info("s1")] } satisfies EnvLinkMessage));
		peer.closed();
		const { socket } = browser();
		const sessions = socket.frames.find(f => f.t === "sessions");
		expect(sessions).toMatchObject({ m: "m_b", sessions: [{ id: "s1", unread: false }] });
		expect(lastMachines(socket)).toMatchObject({ machines: [{ online: false }] });
	});
});

describe("relay", () => {
	test("requests are forwarded to the right daemon without the machine tag; answers come back tagged", async () => {
		const { link } = register("m_b");
		const { socket, conn } = browser();
		await conn.receive(request("r1", "m_b"));
		const [open, req] = link.control;
		expect(open).toMatchObject({ t: "open" });
		const cid = (open as { cid: string }).cid;
		expect(req).toEqual({ t: "req", cid, text: JSON.stringify({ t: "sessions.list", reqId: "r1" }) });
		// second request reuses the virtual client
		await conn.receive(request("r2", "m_b"));
		expect(link.control.filter(m => m.t === "open")).toHaveLength(1);

		const peer = gateway.peerOf("m_b") as EnvPeer;
		peer.receive(clientFrame(cid, JSON.stringify({ t: "ack", reqId: "r1", ok: true })));
		peer.receive(clientFrame(cid, JSON.stringify({ t: "events", sessionId: "s", events: [] })));
		expect(socket.sent.slice(-2)).toEqual([
			'{"m":"m_b","t":"ack","reqId":"r1","ok":true}',
			'{"m":"m_b","t":"events","sessionId":"s","events":[]}',
		]);
		// frames for a client id nobody holds are dropped
		const count = socket.sent.length;
		peer.receive(clientFrame("ghost", JSON.stringify({ t: "ack", reqId: "x", ok: true })));
		expect(socket.sent).toHaveLength(count);
	});

	test("a request for an unknown or offline machine is refused at once", async () => {
		const { peer } = register("m_b");
		const { socket, conn } = browser();
		await conn.receive(request("r1", "m_nobody"));
		expect(socket.frames.at(-1)).toMatchObject({
			t: "ack",
			reqId: "r1",
			ok: false,
			error: "unknown machine: m_nobody",
		});
		peer.closed();
		await conn.receive(request("r2", "m_b"));
		expect(socket.frames.at(-1)).toMatchObject({
			t: "ack",
			reqId: "r2",
			ok: false,
			error: "box-m_b is offline",
			m: "m_b",
		});
		await conn.receive("not json");
		expect(socket.frames.at(-1)).toMatchObject({ t: "ack", reqId: "", ok: false });
	});

	test("when a daemon goes away, requests in flight to it fail, and its virtual client is reopened on the next link", async () => {
		const { link, peer } = register("m_b");
		const { socket, conn } = browser();
		await conn.receive(request("r1", "m_b"));
		peer.closed();
		expect(socket.frames.findLast(f => f.t === "ack")).toMatchObject({
			reqId: "r1",
			ok: false,
			error: "box-m_b went offline",
			m: "m_b",
		});
		expect(link.control.at(-1)).toMatchObject({ t: "req" }); // nothing was sent to the dead link after it ended

		const next = register("m_b");
		await conn.receive(request("r2", "m_b"));
		expect(next.link.control.map(m => m.t)).toEqual(["open", "req"]);
		expect((next.link.control[0] as { cid: string }).cid).not.toBe((link.control[0] as { cid: string }).cid);
	});

	test("closing the browser connection closes its virtual clients on every daemon", async () => {
		const b = register("m_b");
		const c = register("m_c");
		const { conn } = browser();
		await conn.receive(request("r1", "m_b"));
		await conn.receive(request("r2", "m_c"));
		gateway.detachBrowser(conn);
		expect(b.link.control.at(-1)).toMatchObject({ t: "close" });
		expect(c.link.control.at(-1)).toMatchObject({ t: "close" });
		expect(gateway.browserCount).toBe(0);
		expect((gateway.peerOf("m_b") as EnvPeer).clients.size).toBe(0);
	});

	test("a daemon giving up on a virtual client closes that browser connection (it reconnects and resubscribes)", async () => {
		const { link, peer } = register("m_b");
		const { socket, conn } = browser();
		await conn.receive(request("r1", "m_b"));
		const cid = (link.control[0] as { cid: string }).cid;
		peer.receive(JSON.stringify({ t: "closed", cid, reason: "client is not reading" } satisfies EnvLinkMessage));
		expect(socket.closed).toEqual({ code: 1013, reason: "client is not reading" });
	});
});

describe("backpressure", () => {
	test("a backed-up browser socket pauses its daemon-side clients; draining resumes them; a hopeless one is closed", async () => {
		const { link, peer } = register("m_b");
		const { socket, conn } = browser();
		await conn.receive(request("r1", "m_b"));
		const cid = (link.control[0] as { cid: string }).cid;
		const frame = (n: number) =>
			clientFrame(cid, JSON.stringify({ t: "events", sessionId: "s", events: [], pad: "x".repeat(n) }));

		peer.receive(frame(10));
		expect(link.control.some(m => m.t === "pause")).toBe(false);
		socket.buffered = 5_000; // above highWater
		peer.receive(frame(10));
		expect(link.control.filter(m => m.t === "pause")).toEqual([{ t: "pause", cid }]);
		peer.receive(frame(10)); // still backed up: no second pause
		expect(link.control.filter(m => m.t === "pause")).toHaveLength(1);

		conn.drain(); // still above the mark
		expect(link.control.some(m => m.t === "resume")).toBe(false);
		socket.buffered = 0;
		conn.drain();
		expect(link.control.filter(m => m.t === "resume")).toEqual([{ t: "resume", cid }]);

		socket.buffered = 30_000; // above hardLimit
		peer.receive(frame(10));
		expect(socket.closed?.code).toBe(1013);
	});

	test("a daemon client opened while the browser is backed up starts paused", async () => {
		const b = register("m_b");
		const c = register("m_c");
		const { socket, conn } = browser();
		await conn.receive(request("r1", "m_b"));
		const cid = (b.link.control[0] as { cid: string }).cid;
		socket.buffered = 5_000;
		(gateway.peerOf("m_b") as EnvPeer).receive(
			clientFrame(cid, JSON.stringify({ t: "events", sessionId: "s", events: [] })),
		);
		await conn.receive(request("r2", "m_c"));
		expect(c.link.control.map(m => m.t)).toEqual(["open", "pause", "req"]);
	});
});

describe("read positions through the gateway", () => {
	test("a read report goes to every browser's list; a report for an unknown session or machine is an error ack", async () => {
		const { peer } = register("m_b");
		peer.receive(JSON.stringify({ t: "sessions", sessions: [info("s1", 10)] } satisfies EnvLinkMessage));
		const a = browser();
		const b = browser();
		peer.receive(JSON.stringify({ t: "sessions", sessions: [info("s1", 20)] } satisfies EnvLinkMessage));
		const unread = (s: FakeBrowser): boolean | undefined => {
			const last = s.frames.findLast(f => f.t === "sessions");
			return last?.t === "sessions" ? last.sessions[0]?.unread : undefined;
		};
		expect(unread(a.socket)).toBe(true);
		expect(unread(b.socket)).toBe(true);
		await a.conn.receive(
			JSON.stringify({ t: "read", reqId: "r", m: "m_b", sessionId: "s1", seq: 7, epoch: "e", modifiedAt: 20 }),
		);
		expect(a.socket.frames.findLast(f => f.t === "ack")).toMatchObject({ reqId: "r", ok: true });
		expect(unread(a.socket)).toBe(false);
		expect(unread(b.socket)).toBe(false);

		await a.conn.receive(
			JSON.stringify({ t: "read", reqId: "r2", m: "m_b", sessionId: "zzz", seq: 0, modifiedAt: 1 }),
		);
		expect(a.socket.frames.findLast(f => f.t === "ack")).toMatchObject({
			reqId: "r2",
			ok: false,
			error: "unknown session: zzz",
		});
		await a.conn.receive(
			JSON.stringify({ t: "read", reqId: "r3", m: "m_x", sessionId: "s1", seq: 0, modifiedAt: 1 }),
		);
		expect(a.socket.frames.findLast(f => f.t === "ack")).toMatchObject({ reqId: "r3", ok: false });
	});

	test("reading an Antigravity transcript clears its unread marker even with a fractional file mtime", async () => {
		const { peer } = register("m_b");
		const publish = (modifiedAt: number) =>
			peer.receive(
				JSON.stringify({
					t: "sessions",
					sessions: [{ ...info("agy", modifiedAt), backend: "antigravity" }],
				} satisfies EnvLinkMessage),
			);
		publish(10.25);
		const { socket, conn } = browser();
		const unread = () => {
			const last = socket.frames.findLast(f => f.t === "sessions");
			return last?.t === "sessions" ? last.sessions[0]?.unread : undefined;
		};
		publish(10.5);
		expect(unread()).toBe(true);
		await conn.receive(
			JSON.stringify({ t: "read", reqId: "r", m: "m_b", sessionId: "agy", seq: 0, epoch: "e", modifiedAt: 10.5 }),
		);
		expect(unread()).toBe(false);
		publish(10.75);
		expect(unread()).toBe(true);
	});
});

describe("presence and read notifications", () => {
	class Sink {
		seenIds: string[] = [];
		attention(): void {}
		seen(machine: string, sessionId: string): void {
			this.seenIds.push(`${machine}/${sessionId}`);
		}
	}

	test("a session is viewed only while a visible connection has it open; leaving, hiding and closing end it", async () => {
		const sink = new Sink();
		const g = new Gateway({
			store,
			selfMachineId: "m_a",
			gatewayVersion: "t",
			replicaDir: replicaRoot,
			attention: sink,
		});
		const a = g.attachBrowser(new FakeBrowser());
		const b = g.attachBrowser(new FakeBrowser());
		const view = (conn: BrowserConn, sessionId: string | null, visible: boolean) =>
			conn.receive(JSON.stringify({ t: "view", reqId: "v", m: "m_b", sessionId, visible }));
		expect(g.isViewed("m_b", "s1")).toBe(false);
		await view(a, "s1", true);
		expect(g.isViewed("m_b", "s1")).toBe(true);
		expect(g.isViewed("m_c", "s1")).toBe(false); // same session id on another machine
		expect(g.isViewed("m_b", "s2")).toBe(false);
		await view(a, "s1", false); // tab hidden
		expect(g.isViewed("m_b", "s1")).toBe(false);
		await view(b, "s1", true);
		expect(g.isViewed("m_b", "s1")).toBe(true);
		await view(b, null, true); // session closed
		expect(g.isViewed("m_b", "s1")).toBe(false);
		await view(a, "s1", true);
		g.detachBrowser(a);
		expect(g.isViewed("m_b", "s1")).toBe(false);
		// looking at it (visible) tells the notifier to clear other devices' notifications; hiding does not
		expect(sink.seenIds).toEqual(["m_b/s1", "m_b/s1", "m_b/s1"]);
		g.close();
	});

	test("a read report tells the notifier, whether or not it changed the unread state; a bad view frame is an error ack", async () => {
		const sink = new Sink();
		const g = new Gateway({
			store,
			selfMachineId: "m_a",
			gatewayVersion: "t",
			replicaDir: replicaRoot,
			attention: sink,
		});
		const link = new FakeLink();
		const peer = g.attachEnv(
			{ machineId: "m_b", name: "box", platform: "linux", hello: HELLO, acceptsBroker: false },
			link,
		);
		peer.receive(JSON.stringify({ t: "sessions", sessions: [info("s1", 10)] } satisfies EnvLinkMessage));
		const socket = new FakeBrowser();
		const conn = g.attachBrowser(socket);
		await conn.receive(JSON.stringify({ t: "read", reqId: "r", m: "m_b", sessionId: "s1", seq: 0, modifiedAt: 10 }));
		expect(sink.seenIds).toEqual(["m_b/s1"]);
		await conn.receive(JSON.stringify({ t: "view", reqId: "v", m: "m_b", sessionId: 5, visible: true }));
		expect(socket.frames.at(-1)).toMatchObject({ t: "ack", reqId: "v", ok: false });
		g.close();
	});
});
