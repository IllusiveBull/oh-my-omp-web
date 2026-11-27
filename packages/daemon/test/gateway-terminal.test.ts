import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { AUTH_COOKIE, type MachineSummary, type ServerMessage, type TerminalEnvFrame } from "@omp-web/protocol";
import { EnvHost } from "../src/env-host";
import type { LinkEnd } from "../src/link-end";
import { SessionManager } from "../src/manager";
import { ProjectRegistry } from "../src/projects";
import { TerminalService } from "../src/terminal-service";
import { Harness, makeRepo, type TestClient } from "./gateway-harness";
import { startRemote as startRemoteOn, type Remote } from "./remote-harness";
import { fakePtyFactory, TestBrowser, until, type FakePty } from "./terminal-fixtures";
import { makeLink } from "./links";

let repo: string;
let remoteRepo: string;
let h: Harness | undefined;
const remotes: Remote[] = [];
const browsers: TestBrowser[] = [];

beforeAll(async () => {
	repo = await makeRepo();
	remoteRepo = await makeRepo();
});
afterAll(() => {
	rmSync(dirname(repo), { recursive: true, force: true });
	rmSync(dirname(remoteRepo), { recursive: true, force: true });
});
afterEach(async () => {
	for (const b of browsers.splice(0)) b.dispose();
	for (const r of remotes.splice(0)) await r.stop();
	await h?.stop();
	h = undefined;
});

interface Terminals {
	service: TerminalService;
	ptys: FakePty[];
	audit: string[];
}

/** A terminal service whose directory rule is the harness's project registry (bound late: the harness needs the service first). */
function terminals(enabled: boolean, wire: { projects?: ProjectRegistry }): Terminals {
	const { factory, ptys } = fakePtyFactory();
	const audit: string[] = [];
	const service = new TerminalService({
		enabled,
		machineId: () => "m_test",
		resolveShell: () => "/bin/sh",
		resolveCwd: cwd => wire.projects!.resolveCwd(cwd),
		factory,
		audit: line => audit.push(line),
	});
	return { service, ptys, audit };
}

const termFrames = (c: TestClient): (ServerMessage & { t: string })[] => c.frames.filter(f => f.t.startsWith("term."));
const machine = (c: TestClient, id: string): MachineSummary | undefined =>
	(c.frames.findLast(f => f.t === "machines") as { machines: MachineSummary[] } | undefined)?.machines.find(
		m => m.id === id,
	);

/** One-way requests have no ack: the client just writes them. */
const post = (c: TestClient, msg: Record<string, unknown>): void =>
	c.raw(JSON.stringify({ reqId: "", m: c.machine, ...msg }));

describe("terminals through the gateway", () => {
	test("watch, open, attach, output, input, resize, kill: the frames reach the browser tagged with the machine, one-way requests are not acked", async () => {
		const wire: { projects?: ProjectRegistry } = {};
		const t = terminals(true, wire);
		h = await Harness.start({ repo, terminals: t.service });
		wire.projects = h.projects;
		const c = await h.connect();
		const watch = await c.call({ t: "term.watch", open: true });
		expect(watch).toMatchObject({ ok: true, data: { capability: { enabled: true }, terminals: [] } });
		const open = await c.call({ t: "term.open", cols: 90, rows: 30, cwd: repo });
		expect(open.ok).toBe(true);
		const id = (open.data as { terminal: { id: string } }).terminal.id;
		await until(() => termFrames(c).some(f => f.t === "term.list"));
		const attach = await c.call({ t: "term.attach", id, offset: null, cols: 90, rows: 30 });
		expect(attach).toMatchObject({ ok: true, data: { mode: "snapshot" } });
		t.ptys[0]!.emit("hi from the shell\r\n");
		await c.waitFor(f => f.t === "term.out" && f.m === c.machine && f.data.includes("hi from"));
		const acksBefore = c.frames.filter(f => f.t === "ack").length;
		post(c, { t: "term.input", id, data: "ls\r" });
		post(c, { t: "term.resize", id, cols: 100, rows: 40 });
		post(c, { t: "term.ack", id, bytes: 10 });
		await until(() => t.ptys[0]!.written.length === 1 && t.ptys[0]!.resizes.length === 1);
		expect(t.ptys[0]!.written).toEqual(["ls\r"]);
		expect(t.ptys[0]!.resizes).toEqual([{ cols: 100, rows: 40 }]);
		expect(c.frames.filter(f => f.t === "ack")).toHaveLength(acksBefore); // nothing acked
		// an error for a one-way request does come back (the id does not exist)
		post(c, { reqId: "bad-1", t: "term.input", id: "t_nope", data: "x" });
		const err = await c.waitFor(f => f.t === "ack" && f.reqId === "bad-1");
		expect(err).toMatchObject({ ok: false });
		const kill = await c.call({ t: "term.kill", id });
		expect(kill).toMatchObject({ ok: true, data: { terminal: { state: "exited" } } });
		await c.waitFor(f => f.t === "term.exit" && f.id === id);
	});

	test("a shell starts only inside a registered project: elsewhere, outside through a symlink, and through .. are refused; a subdirectory is fine", async () => {
		const wire: { projects?: ProjectRegistry } = {};
		const t = terminals(true, wire);
		h = await Harness.start({ repo, terminals: t.service });
		wire.projects = h.projects;
		const c = await h.connect();
		mkdirSync(join(repo, "sub"));
		makeLink(tmpdir(), join(repo, "escape"));
		for (const cwd of [tmpdir(), "/", join(repo, "escape"), join(repo, "sub", "..", "..")]) {
			const refused = await c.call({ t: "term.open", cols: 80, rows: 24, cwd });
			expect(refused).toMatchObject({ ok: false });
			expect(refused.error).toMatch(/not inside a registered project|cwd does not exist/);
		}
		expect(t.ptys).toHaveLength(0);
		const ok = await c.call({ t: "term.open", cols: 80, rows: 24, cwd: join(repo, "sub") });
		expect(ok.ok).toBe(true);
		expect(t.ptys[0]!.launch.cwd).toBe(join(repo, "sub"));
		rmSync(join(repo, "sub"), { recursive: true });
		rmSync(join(repo, "escape"));
	});

	test("a machine with terminals disabled refuses everything with a code the UI can show, and nothing runs", async () => {
		const wire: { projects?: ProjectRegistry } = {};
		const t = terminals(false, wire);
		h = await Harness.start({ repo, terminals: t.service });
		wire.projects = h.projects;
		const c = await h.connect();
		expect(await c.call({ t: "term.watch", open: true })).toMatchObject({
			ok: true,
			data: { capability: { enabled: false } },
		});
		const refused = await c.call({ t: "term.open", cols: 80, rows: 24, cwd: repo });
		expect(refused).toMatchObject({ ok: false, code: "terminal_disabled" });
		expect(refused.error).toMatch(/disabled on this machine/);
		const attach = await c.call({ t: "term.attach", id: "t_x", offset: null, cols: 80, rows: 24 });
		expect(attach).toMatchObject({ ok: false, code: "terminal_disabled" });
		expect(t.ptys).toHaveLength(0);
	});

	test("a machine without any terminal service (the default) is disabled too", async () => {
		h = await Harness.start({ repo });
		const c = await h.connect();
		expect(await c.call({ t: "term.open", cols: 80, rows: 24, cwd: repo })).toMatchObject({
			ok: false,
			code: "terminal_disabled",
		});
	});

	test("two browsers on one terminal both see the output and either can type", async () => {
		const wire: { projects?: ProjectRegistry } = {};
		const t = terminals(true, wire);
		h = await Harness.start({ repo, terminals: t.service });
		wire.projects = h.projects;
		const a = await h.connect();
		const b = await h.connect();
		const id = (
			(await a.call({ t: "term.open", cols: 80, rows: 24, cwd: repo })).data as { terminal: { id: string } }
		).terminal.id;
		await a.call({ t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		await b.call({ t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		t.ptys[0]!.emit("shared output\r\n");
		for (const c of [a, b]) await c.waitFor(f => f.t === "term.out" && f.data.includes("shared output"));
		post(a, { t: "term.input", id, data: "from-a" });
		post(b, { t: "term.input", id, data: "from-b" });
		await until(() => t.ptys[0]!.written.length === 2);
		expect(t.ptys[0]!.written.toSorted()).toEqual(["from-a", "from-b"]);
		// each connection is its own virtual client with its own audit identity
		expect(t.audit.filter(l => l.includes("terminal attach"))).toHaveLength(2);
		const who = t.audit.map(l => /by=(\S+)/.exec(l)?.[1]).filter(Boolean);
		expect(new Set(who).size).toBe(2);
		for (const w of who) expect(w).toMatch(/^session:[0-9a-f]{12}$/);
	});

	test("the audit line names the login (a hash prefix, never the cookie), the machine and the directory", async () => {
		const wire: { projects?: ProjectRegistry } = {};
		const t = terminals(true, wire);
		h = await Harness.start({ repo, terminals: t.service });
		wire.projects = h.projects;
		const cookie = await h.login();
		const c = await h.connect(undefined, cookie);
		await c.call({ t: "term.open", cols: 80, rows: 24, cwd: repo });
		const line = t.audit.find(l => l.includes("terminal spawn"))!;
		expect(line).toContain("machine=m_test");
		expect(line).toContain(`cwd=${repo}`);
		expect(line).not.toContain(cookie.split("=")[1]!);
		expect(line).toMatch(/by=session:[0-9a-f]{12}/);
	});
});

describe("logins and terminals", () => {
	test("signing out ends the open connections of that login, and a login that was revoked cannot use a terminal on a socket that stayed open", async () => {
		const wire: { projects?: ProjectRegistry } = {};
		const t = terminals(true, wire);
		h = await Harness.start({ repo, terminals: t.service });
		wire.projects = h.projects;
		const cookie = await h.login();
		const keep = await h.connect(undefined, await h.login()); // another login: untouched
		const gone = await h.connect(undefined, cookie);
		expect((await gone.call({ t: "term.watch", open: true })).ok).toBe(true);
		const res = await fetch(`${h.http}/api/logout`, { method: "POST", headers: { cookie } });
		expect(res.status).toBe(204);
		await until(() => gone.closedWith !== null);
		expect(gone.closedWith?.reason).toBe("signed out");
		expect((await keep.call({ t: "term.watch", open: true })).ok).toBe(true);

		// revoked behind the socket's back (expiry, `auth_sessions` cleared): the next terminal request ends the connection
		const second = await h.login();
		const stale = await h.connect(undefined, second);
		h.store.deleteAuthSession(second.slice(AUTH_COOKIE.length + 1));
		post(stale, { t: "term.input", id: "t_x", data: "rm -rf /\r" });
		await until(() => stale.closedWith !== null);
		expect(stale.closedWith?.reason).toBe("signed out");
		expect(t.ptys).toHaveLength(0);
	});
});

describe("a link that drops mid-output", () => {
	test("the shell keeps running, and the browser converges by replay from the offset it holds: no reload, no gap, no duplicate", async () => {
		h = await Harness.start({ repo, heartbeat: { intervalMs: 20, timeoutMs: 120 }, handshakeTimeoutMs: 300 });
		const wire: { projects?: ProjectRegistry } = {};
		const t = terminals(true, wire);
		const remote = await startRemoteOn(h, remoteRepo, { terminals: t.service });
		remotes.push(remote);
		wire.projects = remote.projects;
		const c = await h.connect(remote.id);
		await until(() => machine(c, remote.id)?.online === true);
		const id = (
			(await c.call({ t: "term.open", cols: 80, rows: 24, cwd: remoteRepo })).data as { terminal: { id: string } }
		).terminal.id;
		await c.call({ t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		const browser = new TestBrowser();
		browsers.push(browser);
		const view = { frames: [] as TerminalEnvFrame[] };
		let applied = 0;
		const sync = async (): Promise<void> => {
			view.frames = termFrames(c) as unknown as TerminalEnvFrame[];
			applied = browser.apply(view as never, id, applied);
			await browser.settled();
			post(c, { t: "term.ack", id, bytes: browser.consumed });
		};
		for (let i = 0; i < 10; i++) t.ptys[0]!.emit(`before ${i}\r\n`);
		await until(async () => (await sync(), browser.expected === t.service.get(id)!.ring.head));
		const pid = t.service.get(id)!.info.pid;
		const linkBefore = machine(c, remote.id)!.linkId;

		// the link drops; the shell goes on producing output meanwhile
		h.gateway.disconnectEnv(remote.id, "test");
		await until(() => machine(c, remote.id)?.online === false);
		for (let i = 0; i < 10; i++) t.ptys[0]!.emit(`during ${i}\r\n`);
		await until(
			() => machine(c, remote.id)?.online === true && machine(c, remote.id)!.linkId > linkBefore,
			5000,
			"reconnect",
		);

		// the process outlived the link
		expect(t.service.get(id)!.info).toMatchObject({ state: "running", pid });
		// the page re-attaches with what it holds
		const held = browser.expected!;
		const ack = await c.call({ t: "term.attach", id, offset: held, cols: 80, rows: 24 });
		expect(ack).toMatchObject({ ok: true, data: { mode: "replay", offset: held } });
		t.ptys[0]!.emit("after\r\n");
		await until(async () => (await sync(), browser.expected === t.service.get(id)!.ring.head));
		expect(browser.gaps).toBe(0);
		expect(browser.resets).toBe(1);
		const text = browser.lines().join("\n");
		for (const needle of ["before 0", "before 9", "during 0", "during 9", "after"]) expect(text).toContain(needle);
		expect(text.match(/before 3/g)).toHaveLength(1); // nothing twice
	});
});

describe("echo is not queued behind bulk traffic on the link", () => {
	/** A link whose socket is slow: what is written stays buffered. */
	class SlowLink implements LinkEnd {
		readonly sent: string[] = [];
		buffered = 0;
		send(text: string): void {
			this.sent.push(text);
			this.buffered += text.length;
		}
		bufferedAmount(): number {
			return this.buffered;
		}
		close(): void {}
		terminate(): void {}
	}

	test("with a large bulk backlog on the daemon's side of the link, terminal output is written at once and the bulk waits", async () => {
		const projects = await ProjectRegistry.open(`${dirname(repo)}/projects-lane.json`);
		await projects.add(repo);
		const { factory, ptys } = fakePtyFactory();
		const service = new TerminalService({
			enabled: true,
			machineId: () => "m_lane",
			resolveShell: () => "/bin/sh",
			resolveCwd: cwd => projects.resolveCwd(cwd),
			factory,
			audit: () => {},
		});
		const manager = new SessionManager({
			ompPath: "unused",
			sessionDir: `${dirname(repo)}/sessions-lane`,
			resolveCwd: c => projects.resolveCwd(c),
		});
		const host = new EnvHost(manager, projects, { terminals: service });
		const link = new SlowLink();
		const endpoint = host.attach(link);
		const req = (cid: string, msg: unknown): void =>
			endpoint.receive(JSON.stringify({ t: "req", cid, text: JSON.stringify(msg) }));
		endpoint.receive(JSON.stringify({ t: "open", cid: "c1", who: "session:test" }));
		req("c1", { t: "term.open", reqId: "1", cols: 80, rows: 24, cwd: repo });
		await until(() => link.sent.some(s => s.startsWith("c1\n") && s.includes('"ok":true')));
		const id = service.list()[0]!.id;
		req("c1", { t: "term.attach", reqId: "2", id, offset: null, cols: 80, rows: 24 });
		await until(() => link.sent.some(s => s.includes('"mode"')));

		// a replica upload / big snapshot starts: far more than the socket takes
		const bulk = "b".repeat(256 * 1024);
		for (let i = 0; i < 16; i++) endpoint.send(bulk);
		const bulkOnSocket = link.sent.filter(s => s === bulk).length;
		expect(bulkOnSocket).toBeLessThan(16); // the rest is held back, not piled onto the socket

		const before = link.sent.length;
		ptys[0]!.emit("typed-echo");
		await until(() => link.sent.length > before);
		const echoed = link.sent.slice(before).find(s => s.includes("typed-echo"));
		expect(echoed).toBeDefined(); // written immediately, ahead of every waiting bulk frame
		expect(link.sent.filter(s => s === bulk).length).toBe(bulkOnSocket);
		host.detach(endpoint);
		host.close();
		await service.close();
		await manager.closeAll();
	});
	test("file-page replies ride the bulk lane: held while the link is congested, while terminal output is not", async () => {
		const projects = await ProjectRegistry.open(`${dirname(repo)}/projects-lane2.json`);
		await projects.add(repo);
		const { factory, ptys } = fakePtyFactory();
		const service = new TerminalService({
			enabled: true,
			machineId: () => "m_lane2",
			resolveShell: () => "/bin/sh",
			resolveCwd: cwd => projects.resolveCwd(cwd),
			factory,
			audit: () => {},
		});
		const manager = new SessionManager({
			ompPath: "unused",
			sessionDir: `${dirname(repo)}/sessions-lane2`,
			resolveCwd: c => projects.resolveCwd(c),
		});
		const host = new EnvHost(manager, projects, { terminals: service });
		const link = new SlowLink();
		const endpoint = host.attach(link);
		const req = (msg: unknown): void =>
			endpoint.receive(JSON.stringify({ t: "req", cid: "c1", text: JSON.stringify(msg) }));
		endpoint.receive(JSON.stringify({ t: "open", cid: "c1", who: "session:test" }));
		req({ t: "term.open", reqId: "1", cols: 80, rows: 24, cwd: repo });
		await until(() => link.sent.some(s => s.startsWith("c1\n") && s.includes('"ok":true')));
		const id = service.list()[0]!.id;
		req({ t: "term.attach", reqId: "2", id, offset: null, cols: 80, rows: 24 });
		await until(() => link.sent.some(s => s.includes('"mode"')));
		// congest the link with bulk, then ask for a directory listing (a file reply)
		for (let i = 0; i < 4; i++) endpoint.send("b".repeat(256 * 1024));
		req({ t: "files.list", reqId: "files-1", root: repo, path: "" });
		const before = link.sent.length;
		ptys[0]!.emit("typed-echo");
		await until(() => link.sent.slice(before).some(s => s.includes("typed-echo")));
		const isFileAck = (s: string): boolean => s.includes('"reqId":"files-1"');
		await Bun.sleep(150); // the listing is long done; only the lane can be holding its reply
		expect(link.sent.some(isFileAck)).toBe(false);
		// the network catches up (and keeps up)
		await until(
			() => {
				link.buffered = 0;
				return link.sent.some(isFileAck);
			},
			3000,
			"the held file reply",
		);
		host.detach(endpoint);
		host.close();
		await service.close();
		await manager.closeAll();
	});
});
