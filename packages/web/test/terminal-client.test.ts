import { describe, expect, test } from "bun:test";
import { TERM_ACK_EVERY_CHARS, type TerminalInfo } from "@omp-web/protocol";
import { type AttachmentState, TerminalClient, terminalKey } from "../src/store/terminal-client";
import { FakeSink, FakeTransport, sleep, terminalInfo, tick } from "./terminal-rig";

const M = "m1";
const A = "a";

interface Rig {
	t: FakeTransport;
	c: TerminalClient;
	sink: FakeSink;
}

function rig(options: { terminals?: TerminalInfo[]; link?: string | null } = {}): Rig {
	const t = new FakeTransport();
	t.list = options.terminals ?? [terminalInfo(A)];
	t.setLink(M, options.link === undefined ? "1:1" : options.link);
	return { t, c: new TerminalClient(t, { ackDelayMs: 5 }), sink: new FakeSink() };
}

const att = (c: TerminalClient, id = A): AttachmentState | undefined => c.getSnapshot().attachments[terminalKey(M, id)];

/** Binds terminal `a` and waits for the attach to be acknowledged. */
async function attached(r: Rig, desired = { cols: 100, rows: 30 }) {
	const binding = r.c.bind(M, A, r.sink, { visible: true, desired });
	await tick();
	return binding;
}

const out = (offset: number, data: string, snapshot?: "start" | "part") => ({
	t: "term.out",
	id: A,
	offset,
	data,
	...(snapshot ? { snapshot } : {}),
});

describe("TerminalClient: watching a machine", () => {
	test("watch asks once, keeps capability and list, and follows term.list pushes", async () => {
		const { t, c } = rig({ terminals: [terminalInfo("a"), terminalInfo("b")] });
		const off1 = c.watch(M);
		const off2 = c.watch(M);
		await tick();
		expect(t.sent("term.watch")).toHaveLength(1);
		expect(t.sent("term.watch")[0]!.request).toEqual({ t: "term.watch", open: true });
		const machine = c.getSnapshot().machines[M]!;
		expect(machine.capability?.enabled).toBe(true);
		expect(machine.terminals.map(x => x.id)).toEqual(["a", "b"]);
		expect(machine.synced && machine.online).toBe(true);

		t.frame(M, { t: "term.list", terminals: [terminalInfo("b"), terminalInfo("c", { title: "vim" })] });
		expect(c.getSnapshot().machines[M]!.terminals.map(x => x.id)).toEqual(["b", "c"]);

		off1();
		off1(); // idempotent
		expect(t.sent("term.watch")).toHaveLength(1);
		off2();
		expect(t.sent("term.watch")).toHaveLength(2);
		expect(t.sent("term.watch")[1]!.request).toEqual({ t: "term.watch", open: false });
	});

	test("an offline machine is watched once its link comes up", async () => {
		const { t, c } = rig({ link: null });
		c.watch(M);
		await tick();
		expect(t.requests).toEqual([]);
		expect(c.getSnapshot().machines[M]!.online).toBe(false);
		t.setLink(M, "1:1");
		await tick();
		expect(t.sent("term.watch")).toHaveLength(1);
		expect(c.getSnapshot().machines[M]!.online).toBe(true);
	});

	test("disabled terminals: the capability says so and a refused open marks the machine disabled", async () => {
		const { t, c } = rig();
		t.capability = { ...t.capability, enabled: false, shell: null };
		c.watch(M);
		await tick();
		expect(c.getSnapshot().machines[M]!.capability?.enabled).toBe(false);

		t.capability = { ...t.capability, enabled: true };
		const other = new TerminalClient(t);
		other.watch(M);
		await tick();
		expect(other.getSnapshot().machines[M]!.capability?.enabled).toBe(true);
		t.answer = ({ request }) =>
			request.t === "term.open"
				? { t: "ack", reqId: "", ok: false, error: "terminals are disabled", code: "terminal_disabled" }
				: undefined;
		const result = await other.open(M, { cwd: "/work/app" });
		expect(result).toEqual({ ok: false, error: "terminals are disabled", code: "terminal_disabled" });
		expect(other.getSnapshot().machines[M]!.capability?.enabled).toBe(false);
	});

	test("open sends the size, cwd and purpose, and lists the new terminal", async () => {
		const { t, c } = rig({ terminals: [] });
		c.watch(M);
		await tick();
		t.answer = ({ request }) =>
			request.t === "term.open"
				? { t: "ack", reqId: "", ok: true, data: { terminal: terminalInfo("n1", { purpose: "broker-login" }) } }
				: undefined;
		c.setPreferredSize({ cols: 120, rows: 40 });
		const result = await c.open(M, { purpose: { kind: "broker-login", provider: "deepseek" } });
		expect(result.ok && result.terminal.id).toBe("n1");
		expect(t.sent("term.open")[0]!.request).toEqual({
			t: "term.open",
			cols: 120,
			rows: 40,
			purpose: { kind: "broker-login", provider: "deepseek" },
		});
		expect(c.getSnapshot().machines[M]!.terminals.map(x => x.id)).toEqual(["n1"]);
		const withCwd = await c.open(M, { cwd: "/work/app", size: { cols: 1, rows: 1 } });
		expect(withCwd.ok).toBe(true);
		// The pty accepts 20x5 at least: the client never asks for less.
		expect(t.sent("term.open")[1]!.request).toMatchObject({ cwd: "/work/app", cols: 20, rows: 5 });
	});
});

describe("TerminalClient: output", () => {
	test("attaches with the pane's size and no offset, then a snapshot resets the screen and live frames follow it", async () => {
		const r = rig();
		await attached(r);
		const attach = r.t.sent("term.attach");
		expect(attach).toHaveLength(1);
		expect(attach[0]!.request).toEqual({ t: "term.attach", id: A, offset: null, cols: 100, rows: 30 });
		expect(att(r.c)?.status).toBe("attached");
		// The grid is the pty's size (80x24 in the ack), never the pane's.
		expect(r.sink.ops).toEqual(["resize:80x24"]);

		r.t.frame(M, out(40, "screen", "start"));
		r.t.frame(M, out(40, " more", "part"));
		expect(r.sink.ops.slice(1)).toEqual(["reset", "write:screen", "write: more"]);
		expect(r.c.expectedOffset(M, A)).toBe(40); // snapshot frames do not advance it
		r.t.frame(M, out(40, "abc"));
		r.t.frame(M, out(43, "de"));
		expect(r.c.expectedOffset(M, A)).toBe(45);
		expect(r.sink.ops.slice(-2)).toEqual(["write:abc", "write:de"]);
	});

	test("a duplicate is ignored and a gap attaches again from where the screen is", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "hello", "start"));
		r.t.frame(M, out(0, "abc"));
		r.t.frame(M, out(0, "abc")); // duplicate
		expect(r.sink.ops.filter(o => o === "write:abc")).toHaveLength(1);
		expect(r.c.expectedOffset(M, A)).toBe(3);

		r.t.attach = "replay";
		r.t.attachOffset = 3;
		r.t.frame(M, out(9, "late")); // a gap: 3..9 is missing
		expect(r.sink.ops.filter(o => o === "write:late")).toHaveLength(0);
		expect(r.t.sent("term.attach")).toHaveLength(2);
		expect(r.t.sent("term.attach")[1]!.request).toMatchObject({ offset: 3 });
		await tick();
		// Replay: no reset, the missing part arrives in order.
		r.t.frame(M, out(3, "123456"));
		r.t.frame(M, out(9, "late"));
		expect(r.sink.ops.filter(o => o === "reset")).toHaveLength(1);
		expect(r.c.expectedOffset(M, A)).toBe(13);
	});

	test("a second gap frame while the new attach is unanswered does not attach again", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "x", "start"));
		r.t.frame(M, out(0, "abc"));
		r.t.frame(M, out(10, "gap1"));
		r.t.frame(M, out(20, "gap2"));
		expect(r.t.sent("term.attach")).toHaveLength(2);
	});

	test("offsets count UTF-16 code units", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "", "start"));
		r.t.frame(M, out(0, "😀é"));
		expect(r.c.expectedOffset(M, A)).toBe("😀é".length);
		r.t.frame(M, out("😀é".length, "x"));
		expect(r.sink.ops.at(-1)).toBe("write:x");
	});

	test("term.size resizes the screen in order with the output", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "a", "start"));
		r.t.frame(M, out(0, "b"));
		r.t.frame(M, { t: "term.size", id: A, cols: 132, rows: 50 });
		r.t.frame(M, out(1, "c"));
		expect(r.sink.ops.slice(-3)).toEqual(["write:b", "resize:132x50", "write:c"]);
		expect(att(r.c)?.size).toEqual({ cols: 132, rows: 50 });
	});

	test("a pane size that changes is reported; the same size is not", async () => {
		const r = rig();
		const binding = await attached(r, { cols: 100, rows: 30 });
		binding.setDesired({ cols: 100, rows: 30 });
		expect(r.t.posted("term.resize")).toEqual([]);
		binding.setDesired({ cols: 90, rows: 28 });
		expect(r.t.posted("term.resize").map(p => p.request)).toEqual([{ t: "term.resize", id: A, cols: 90, rows: 28 }]);
		binding.setDesired({ cols: 1000, rows: 1000 });
		expect(r.t.posted("term.resize")[1]!.request).toMatchObject({ cols: 400, rows: 200 });
	});
});

describe("TerminalClient: flow control", () => {
	const acks = (r: Rig): number[] => r.t.ackedBytes();

	test("never acknowledges before the screen processed the write", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "x".repeat(TERM_ACK_EVERY_CHARS * 2), "start"));
		await sleep(20);
		expect(acks(r)).toEqual([]);
		r.sink.flush();
		expect(acks(r)).toEqual([TERM_ACK_EVERY_CHARS * 2]);
	});

	test("acknowledges every 32 KiB written, cumulative per attach, and what is left shortly after", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "", "start"));
		const chunk = "y".repeat(TERM_ACK_EVERY_CHARS / 2);
		r.t.frame(M, out(0, chunk));
		r.sink.flush();
		expect(acks(r)).toEqual([]); // below the threshold: the timer decides
		r.t.frame(M, out(chunk.length, chunk));
		r.sink.flush();
		expect(acks(r)).toEqual([TERM_ACK_EVERY_CHARS]);
		r.t.frame(M, out(chunk.length * 2, "tail"));
		r.sink.flush();
		await sleep(20);
		expect(acks(r)).toEqual([TERM_ACK_EVERY_CHARS, TERM_ACK_EVERY_CHARS + 4]);
	});

	test("a re-attach starts the count again, and writes of the old attach no longer count", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "", "start"));
		r.t.frame(M, out(0, "z".repeat(100)));
		r.t.attach = "replay";
		r.t.attachOffset = 100;
		r.t.frame(M, out(500, "gap")); // re-attach
		await tick();
		r.sink.flush(); // callbacks of the old attach
		await sleep(20);
		expect(acks(r)).toEqual([]);
		r.t.frame(M, out(100, "new"));
		r.sink.flush();
		await sleep(20);
		expect(acks(r)).toEqual([3]);
	});
});

describe("TerminalClient: visibility, input, lifecycle", () => {
	test("hidden: detaches and ignores frames; visible again: attaches from the screen's offset", async () => {
		const r = rig();
		const binding = await attached(r);
		r.t.frame(M, out(0, "", "start"));
		r.t.frame(M, out(0, "abc"));
		binding.setVisible(false);
		expect(r.t.posted("term.detach").map(p => p.request)).toEqual([{ t: "term.detach", id: A }]);
		expect(att(r.c)?.status).toBe("detached");
		r.t.frame(M, out(3, "ignored"));
		expect(r.c.expectedOffset(M, A)).toBe(3);
		expect(r.sink.ops.filter(o => o === "write:ignored")).toHaveLength(0);
		r.t.attach = "replay";
		r.t.attachOffset = 3;
		binding.setVisible(true);
		expect(r.t.sent("term.attach")[1]!.request).toMatchObject({ offset: 3 });
		await tick();
		expect(att(r.c)?.status).toBe("attached");
	});

	test("a view that starts hidden attaches when it becomes visible", async () => {
		const r = rig();
		const binding = r.c.bind(M, A, r.sink, { visible: false });
		await tick();
		expect(r.t.sent("term.attach")).toEqual([]);
		binding.setVisible(true);
		await tick();
		expect(r.t.sent("term.attach")).toHaveLength(1);
	});

	test("input is posted in frames of at most 16 KiB, and only while it can reach a running shell", async () => {
		const r = rig();
		expect(r.c.input(M, A, "x")).toBe(false); // not bound
		const binding = await attached(r);
		expect(r.c.input(M, A, "ls\r")).toBe(true);
		expect(r.c.input(M, A, "")).toBe(false);
		r.c.input(M, A, "p".repeat(40 * 1024));
		const sizes = r.t.inputSizes();
		expect(sizes).toEqual([3, 16384, 16384, 8192]);
		r.t.frame(M, { t: "term.exit", id: A, code: 0, killed: false });
		expect(r.c.input(M, A, "after exit")).toBe(false);
		expect(r.t.posted("term.input")).toHaveLength(4);
		binding.release();
	});

	test("exit: the screen is kept, the state says exited and input stops", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "", "start"));
		r.t.frame(M, out(0, "bye"));
		r.t.frame(M, { t: "term.exit", id: A, code: 3, killed: false });
		const state = att(r.c)!;
		expect(state.status).toBe("exited");
		expect(state.exit).toMatchObject({ code: 3, killed: false });
		expect(r.c.expectedOffset(M, A)).toBe(3);
	});

	test("an exited terminal is attached once for its output and not again after a reconnect", async () => {
		const r = rig({ terminals: [terminalInfo(A, { state: "exited", exit: { code: 0, killed: false, at: 5 } })] });
		await attached(r);
		expect(att(r.c)?.status).toBe("exited");
		r.t.frame(M, out(0, "", "start"));
		r.t.frame(M, out(0, "history"));
		r.t.setLink(M, "2:1");
		await tick();
		expect(r.t.sent("term.attach")).toHaveLength(1);
		expect(att(r.c)?.status).toBe("exited");
	});

	test("term.gone drops the terminal, tells the user, and is no news after our own dismiss", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, { t: "term.gone", id: A, reason: "dismissed" });
		expect(att(r.c)?.status).toBe("gone");
		expect(r.c.getSnapshot().machines[M]!.terminals).toEqual([]);
		const { notices } = r.c.getSnapshot();
		expect(notices).toHaveLength(1);
		expect(notices[0]!.message).toContain("zsh");
		r.c.dismissNotice(notices[0]!.id);
		expect(r.c.getSnapshot().notices).toEqual([]);

		const own = rig({ terminals: [terminalInfo(A, { state: "exited", exit: { code: 0, killed: false, at: 1 } })] });
		await attached(own);
		const done = own.c.dismiss(M, A);
		own.t.frame(M, { t: "term.gone", id: A, reason: "dismissed" }); // before the ack
		expect(await done).toBeNull();
		expect(att(own.c)?.status).toBe("gone");
		expect(own.c.getSnapshot().notices).toEqual([]);
		expect(own.t.sent("term.dismiss")).toHaveLength(1);
	});

	test("kill resolves with the daemon's answer", async () => {
		const r = rig();
		expect(await r.c.kill(M, A)).toBeNull();
		expect(r.t.sent("term.kill")[0]!.request).toEqual({ t: "term.kill", id: A });
		r.t.answer = () => ({ t: "ack", reqId: "", ok: false, error: "no such terminal" });
		expect(await r.c.kill(M, A)).toBe("no such terminal");
	});

	test("releasing a view detaches and forgets it; the machine's last watcher stops the watch", async () => {
		const r = rig();
		const binding = await attached(r);
		binding.release();
		binding.release();
		expect(r.t.posted("term.detach")).toHaveLength(1);
		expect(att(r.c)).toBeUndefined();
		expect(r.t.sent("term.watch").at(-1)!.request).toEqual({ t: "term.watch", open: false });
	});

	test("a failed attach is reported and leaves the view detached", async () => {
		const r = rig();
		r.t.list = [terminalInfo(A)];
		r.t.answer = ({ request }) =>
			request.t === "term.attach" ? { t: "ack", reqId: "", ok: false, error: "too many attachments" } : undefined;
		await attached(r);
		expect(att(r.c)).toMatchObject({ status: "detached", error: "too many attachments" });
	});
});

describe("TerminalClient: the link to the machine", () => {
	test("while the machine is offline the screen is kept and the state says offline", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "", "start"));
		r.t.frame(M, out(0, "abc"));
		r.t.setLink(M, null);
		expect(att(r.c)?.status).toBe("offline");
		expect(r.c.getSnapshot().machines[M]!.online).toBe(false);
		expect(r.c.expectedOffset(M, A)).toBe(3);
		expect(r.c.input(M, A, "x")).toBe(false);
		expect(r.sink.ops.filter(o => o === "reset")).toHaveLength(1);
	});

	test("a new link re-sends the watch and re-attaches from the screen's offset: replay adds, no reset", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "", "start"));
		r.t.frame(M, out(0, "abc"));
		r.t.setLink(M, null);
		r.t.setLink(M, "2:1");
		await tick();
		expect(r.t.sent("term.watch")).toHaveLength(2);
		const attach = r.t.sent("term.attach");
		expect(attach).toHaveLength(2);
		expect(attach[1]!.request).toMatchObject({ offset: 3, cols: 100, rows: 30 });
		expect(att(r.c)?.status).toBe("attached");
		r.t.frame(M, out(3, "def"));
		expect(r.c.expectedOffset(M, A)).toBe(6);
		expect(r.sink.ops.filter(o => o === "reset")).toHaveLength(1);
	});

	test("a link key that changes while online (the machine registered again) re-attaches as well", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "", "start"));
		r.t.frame(M, out(0, "abc"));
		r.t.attach = "snapshot";
		r.t.setLink(M, "1:2");
		await tick();
		expect(r.t.sent("term.watch")).toHaveLength(2);
		expect(r.t.sent("term.attach")[1]!.request).toMatchObject({ offset: 3 });
		// The daemon no longer holds that part: a snapshot replaces the screen.
		r.t.frame(M, out(7, "fresh", "start"));
		expect(r.sink.ops.filter(o => o === "reset")).toHaveLength(2);
		expect(r.c.expectedOffset(M, A)).toBe(7);
	});

	test("an answer that arrives after the link changed again is dropped", async () => {
		const r = rig();
		r.c.watch(M);
		r.t.setLink(M, "1:2"); // before the first watch answered
		await tick();
		expect(r.t.sent("term.watch")).toHaveLength(2);
		expect(r.c.getSnapshot().machines[M]!.synced).toBe(true);
	});

	test("a terminal the daemon no longer lists after a restart is lost: no attach, screen and info kept", async () => {
		const r = rig();
		await attached(r);
		r.t.frame(M, out(0, "", "start"));
		r.t.frame(M, out(0, "abc"));
		r.t.list = [];
		r.t.setLink(M, "2:2");
		await tick();
		expect(att(r.c)?.status).toBe("lost");
		expect(att(r.c)?.info?.id).toBe(A);
		expect(r.t.sent("term.attach")).toHaveLength(1);
		expect(r.c.expectedOffset(M, A)).toBe(3);
		expect(r.c.input(M, A, "x")).toBe(false);
		// Dismissing a lost terminal is local: the daemon has nothing to dismiss.
		expect(await r.c.dismiss(M, A)).toBeNull();
		expect(r.t.sent("term.dismiss")).toEqual([]);
		expect(att(r.c)?.status).toBe("gone");
	});

	test("a list push without the viewed terminal also marks it lost", async () => {
		const r = rig({ terminals: [terminalInfo(A), terminalInfo("b")] });
		await attached(r);
		r.t.frame(M, { t: "term.list", terminals: [terminalInfo("b")] });
		expect(att(r.c)?.status).toBe("lost");
	});

	test("binding a terminal that is not listed (a stale link) is lost without asking the daemon", async () => {
		const r = rig({ terminals: [terminalInfo("b")] });
		r.c.bind(M, "zz", r.sink, { visible: true });
		await tick();
		expect(r.t.sent("term.attach")).toEqual([]);
		expect(att(r.c, "zz")?.status).toBe("lost");
		expect(att(r.c, "zz")?.info).toBeNull();
	});

	test("a view that is bound before the machine is reachable attaches once it is", async () => {
		const r = rig({ link: null });
		r.c.bind(M, A, r.sink, { visible: true });
		await tick();
		expect(att(r.c)?.status).toBe("offline");
		r.t.setLink(M, "1:1");
		await tick();
		expect(att(r.c)?.status).toBe("attached");
		expect(r.t.sent("term.attach")[0]!.request).toMatchObject({ offset: null, cols: 80, rows: 24 });
	});

	test("a second binding of the same terminal starts from an empty screen", async () => {
		const r = rig();
		const first = await attached(r);
		r.t.frame(M, out(0, "", "start"));
		r.t.frame(M, out(0, "abc"));
		const second = new FakeSink();
		const binding = r.c.bind(M, A, second, { visible: true });
		await tick();
		expect(r.t.sent("term.attach")[1]!.request).toMatchObject({ offset: null });
		expect(r.t.posted("term.detach")).toHaveLength(1);
		first.release(); // the old view going away must not tear down the new one
		expect(att(r.c)?.status).toBe("attached");
		binding.release();
	});
});
