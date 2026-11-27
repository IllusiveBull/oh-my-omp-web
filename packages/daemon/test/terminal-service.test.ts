import { afterEach, describe, expect, test } from "bun:test";
import { TERM_ACK_WINDOW_CHARS, TERM_FRAME_CHARS, type TerminalClientMessage } from "@omp-web/protocol";
import { DISABLED_MESSAGE, TerminalError, TerminalService, type TerminalPort } from "../src/terminal-service";
import { fakePtyFactory, TestBrowser, TestSocket, until, type FakePty } from "./terminal-fixtures";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});

type Request = TerminalClientMessage extends infer M
	? M extends TerminalClientMessage
		? Omit<M, "reqId">
		: never
	: never;

interface Rig {
	service: TerminalService;
	ptys: FakePty[];
	audit: string[];
	client(who?: string): { port: TerminalPort; socket: TestSocket };
	/** Sends a request the way EnvClient does and returns the ack data (errors rethrown). */
	call(port: TerminalPort, msg: Request): Promise<any>;
	open(port: TerminalPort, cols?: number, rows?: number): Promise<string>;
}

function rig(options: Partial<ConstructorParameters<typeof TerminalService>[0]> = {}): Rig {
	const { factory, ptys } = fakePtyFactory();
	const audit: string[] = [];
	let tick = 1_000_000; // a clock that never repeats: who was active last is decided by order, not by the millisecond
	const service = new TerminalService({
		enabled: true,
		machineId: () => "m_test",
		shell: "/bin/sh",
		resolveShell: configured => configured ?? "/bin/sh",
		resolveCwd: async cwd => {
			if (!cwd.startsWith("/project")) throw new Error(`${cwd} is not inside a registered project root or worktree`);
			return cwd;
		},
		factory,
		audit: line => audit.push(line),
		now: () => ++tick,
		...options,
	});
	cleanups.push(() => service.close());
	const call: Rig["call"] = (port, msg) => port.handle({ reqId: "r", ...msg } as TerminalClientMessage);
	return {
		service,
		ptys,
		audit,
		client(who = "session:aaa") {
			const socket = new TestSocket();
			const port = service.port(socket, who);
			cleanups.push(() => port.dispose());
			return { port, socket };
		},
		call,
		open: async (port, cols = 80, rows = 24) => {
			const ack: { terminal: { id: string } } = await call(port, {
				t: "term.open",
				cols,
				rows,
				cwd: "/project/main",
			});
			return ack.terminal.id;
		},
	};
}

/** Lets every callback that is already scheduled (setImmediate pumps, microtasks) run: event-loop turns, not wall-clock time. */
async function flush(): Promise<void> {
	for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

describe("disabled machines", () => {
	test("capability says so, every other request is refused with the code, and nothing is ever spawned", async () => {
		const r = rig({ enabled: false });
		const { port } = r.client();
		const watch = await r.call(port, { t: "term.watch", open: true });
		expect(watch).toMatchObject({ capability: { enabled: false, shell: null }, terminals: [] });
		const refused: Request[] = [
			{ t: "term.open", cols: 80, rows: 24, cwd: "/project/main" },
			{ t: "term.attach", id: "t_x", offset: null, cols: 80, rows: 24 },
			{ t: "term.input", id: "t_x", data: "ls\r" },
			{ t: "term.kill", id: "t_x" },
		];
		for (const msg of refused) {
			const error = await r.call(port, msg).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(TerminalError);
			if (error instanceof TerminalError) {
				expect(error.code).toBe("terminal_disabled");
				expect(error.message).toBe(DISABLED_MESSAGE);
			}
		}
		expect(r.ptys).toHaveLength(0);
		expect(r.service.list()).toEqual([]);
	});
});

describe("opening", () => {
	test("spawns in a project directory, lists it, and writes an audit line with who, machine and cwd", async () => {
		const r = rig();
		const { port } = r.client("session:ab12cd34ef56");
		const id = await r.open(port, 100, 30);
		expect(r.ptys[0]!.launch).toMatchObject({ cwd: "/project/main", cols: 100, rows: 30 });
		expect(r.service.list()).toMatchObject([
			{ id, state: "running", cwd: "/project/main", cols: 100, rows: 30, name: "sh" },
		]);
		expect(r.audit).toHaveLength(1);
		expect(r.audit[0]).toContain("machine=m_test");
		expect(r.audit[0]).toContain(`terminal spawn id=${id}`);
		expect(r.audit[0]).toContain("cwd=/project/main");
		expect(r.audit[0]).toContain("by=session:ab12cd34ef56");
	});

	test("a directory outside the registered projects is refused and nothing is spawned", async () => {
		const r = rig();
		const { port } = r.client();
		await expect(r.call(port, { t: "term.open", cols: 80, rows: 24, cwd: "/etc" })).rejects.toThrow(
			/not inside a registered project/,
		);
		await expect(r.call(port, { t: "term.open", cols: 80, rows: 24 })).rejects.toThrow(/working directory/);
		expect(r.ptys).toHaveLength(0);
		expect(r.service.list()).toEqual([]);
	});

	test("the machine's terminal limit counts exited terminals until they are dismissed", async () => {
		const r = rig({ max: 2 });
		const { port } = r.client();
		const first = await r.open(port);
		await r.open(port);
		await expect(r.open(port)).rejects.toThrow(/already holds 2 terminals/);
		r.ptys[0]!.exit(0);
		await until(() => r.service.get(first)?.info.state === "exited");
		await expect(r.open(port)).rejects.toThrow(/already holds 2/);
		await r.call(port, { t: "term.dismiss", id: first });
		await r.open(port); // room again
		expect(r.service.list()).toHaveLength(2);
	});

	test("concurrent opens cannot exceed the limit", async () => {
		const r = rig({ max: 2 });
		const { port } = r.client();
		const results = await Promise.allSettled([r.open(port), r.open(port), r.open(port), r.open(port)]);
		expect(results.filter(x => x.status === "fulfilled")).toHaveLength(2);
		expect(r.ptys).toHaveLength(2);
	});

	test("a pty that cannot start is an error and leaves no terminal behind", async () => {
		const r = rig({
			factory: async () => {
				throw new Error("Failed to open PTY");
			},
		});
		const { port } = r.client();
		await expect(r.open(port)).rejects.toThrow(/Failed to open PTY/);
		expect(r.service.list()).toEqual([]);
		// and the slot is free again
		const again = rig({ max: 1 });
		await again.open(again.client().port);
	});

	test("a broker-login terminal runs where the daemon says and has the command typed but not run", async () => {
		const asked: unknown[] = [];
		const r = rig({
			purposeLaunch: async purpose => {
				asked.push(purpose);
				return { cwd: "/broker/home", input: "HOME='/broker/home' omp auth-broker login deepseek" };
			},
		});
		const { port } = r.client();
		const ack = (await r.call(port, {
			t: "term.open",
			cols: 80,
			rows: 24,
			purpose: { kind: "broker-login", provider: "deepseek" },
		})) as { terminal: { id: string; purpose: string; cwd: string; name: string } };
		expect(asked).toEqual([{ kind: "broker-login", provider: "deepseek" }]);
		expect(ack.terminal).toMatchObject({
			purpose: "broker-login",
			cwd: "/broker/home",
			name: "Broker login: deepseek",
		});
		expect(r.ptys[0]!.launch.cwd).toBe("/broker/home"); // not subject to the project rule: the daemon chose it
		expect(r.ptys[0]!.written).toEqual([]); // not before the shell's first prompt has settled
		r.ptys[0]!.emit("prompt$ ");
		await until(() => r.ptys[0]!.written.length > 0, 3000, "the pre-typed command");
		expect(r.ptys[0]!.written).toEqual(["HOME='/broker/home' omp auth-broker login deepseek"]); // no "\r": not executed
		expect(r.audit[0]).toContain("purpose=broker-login");
	});

	test("a purpose on a machine that hosts no broker is refused; the client cannot smuggle a cwd in with it", async () => {
		const r = rig({ purposeLaunch: async () => null });
		const { port } = r.client();
		await expect(
			r.call(port, {
				t: "term.open",
				cols: 80,
				rows: 24,
				cwd: "/etc",
				purpose: { kind: "broker-login", provider: "x" },
			}),
		).rejects.toThrow(/no auth broker/);
		expect(r.ptys).toHaveLength(0);
		const plain = rig();
		await expect(
			plain.call(plain.client().port, {
				t: "term.open",
				cols: 80,
				rows: 24,
				purpose: { kind: "broker-login", provider: "x" },
			}),
		).rejects.toThrow(/no auth broker/);
	});
});

describe("attach, replay and snapshot", () => {
	test("a fresh client gets a snapshot, the live output follows, and a second client sees the same", async () => {
		const r = rig();
		const a = r.client();
		const id = await r.open(a.port);
		r.ptys[0]!.emit("hello\r\n");
		await until(() => r.service.get(id)!.screen.parsed === 7, 4000, "the emulator to parse the output");
		const ack = await r.call(a.port, { t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		expect(ack).toMatchObject({ mode: "snapshot", offset: 7, head: 7 });
		const browser = new TestBrowser();
		cleanups.push(() => browser.dispose());
		await flush();
		r.ptys[0]!.emit("world\r\n");
		await flush();
		browser.apply(a.socket, id);
		await browser.settled();
		expect(browser.lines().join("\n")).toContain("hello");
		expect(browser.lines().join("\n")).toContain("world");
		expect(browser.expected).toBe(14);
		// the ack came before the first frame
		expect(a.socket.frames[0]!.t).not.toBe("ack");
		const b = r.client("session:bbb");
		await r.call(b.port, { t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		const other = new TestBrowser();
		cleanups.push(() => other.dispose());
		await flush();
		other.apply(b.socket, id);
		await other.settled();
		expect(other.lines().join("\n")).toBe(browser.lines().join("\n"));
	});

	test("reattaching with the offset it holds replays exactly what it missed, with no snapshot and no gap", async () => {
		const r = rig();
		const a = r.client();
		const id = await r.open(a.port);
		await r.call(a.port, { t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		const browser = new TestBrowser();
		cleanups.push(() => browser.dispose());
		r.ptys[0]!.emit("one\r\n");
		await flush();
		let applied = browser.apply(a.socket, id);
		await browser.settled();
		const held = browser.expected!;
		await r.call(a.port, { t: "term.detach", id });
		r.ptys[0]!.emit("two\r\nthree\r\n"); // while detached
		// a new connection (the old one dropped) comes back with its offset
		const back = r.client();
		const ack = await r.call(back.port, { t: "term.attach", id, offset: held, cols: 80, rows: 24 });
		expect(ack).toMatchObject({ mode: "replay", offset: held, head: held + 12 });
		await flush();
		applied = browser.apply(back.socket, id);
		await browser.settled();
		expect(back.socket.of("term.out", id).every(f => f.snapshot === undefined)).toBe(true);
		expect(browser.resets).toBe(1); // only the very first attach reset the screen
		expect(browser.gaps).toBe(0);
		expect(browser.lines().join("\n")).toMatch(/one[\s\S]*two[\s\S]*three/);
		expect(applied).toBeGreaterThan(0);
	});

	test("an offset the ring no longer holds gets a snapshot (reset) instead, and the result equals what a client that saw it all has", async () => {
		const r = rig({ ringChars: 4096, scrollbackLines: 200 });
		const a = r.client();
		const id = await r.open(a.port, 60, 10);
		await r.call(a.port, { t: "term.attach", id, offset: null, cols: 60, rows: 10 });
		const live = new TestBrowser(60, 10);
		cleanups.push(() => live.dispose());
		let index = 0;
		for (let i = 0; i < 300; i++) {
			r.ptys[0]!.emit(`line ${i} \x1b[3${i % 7}mcoloured\x1b[0m\r\n`);
			if (i % 20 === 0) {
				await flush();
				index = live.apply(a.socket, id, index);
				await a.port.handle({ t: "term.ack", reqId: "", id, bytes: live.consumed });
			}
		}
		await flush();
		index = live.apply(a.socket, id, index);
		await live.settled();
		// a client that was away since offset 10 comes back
		const late = r.client();
		const ack = await r.call(late.port, { t: "term.attach", id, offset: 10, cols: 60, rows: 10 });
		expect(ack.mode).toBe("snapshot");
		const back = new TestBrowser(60, 10);
		cleanups.push(() => back.dispose());
		await flush();
		back.apply(late.socket, id);
		await back.settled();
		expect(back.resets).toBe(1);
		expect(back.expected).toBe(r.service.get(id)!.ring.head);
		expect(back.lines().slice(-12).join("\n")).toBe(live.lines().slice(-12).join("\n"));
	});

	test("frames never end inside a surrogate pair or split a grapheme the client would have to repair, however the output was chunked", async () => {
		const r = rig({ ringChars: 1 << 20 });
		const a = r.client();
		const id = await r.open(a.port);
		await r.call(a.port, { t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		await flush();
		const text = "😀é你🎉".repeat(30_000); // ~ 180k characters, every astral character is two code units
		for (let at = 0; at < text.length; at += 4097) {
			let part = text.slice(at, at + 4097);
			if (/[\ud800-\udbff]$/.test(part)) {
				part = part.slice(0, -1); // the pty's decoder hands out whole characters; the pair continues in the next chunk
				at -= 1;
			}
			r.ptys[0]!.emit(part);
		}
		const frames = () => a.socket.of("term.out", id).filter(f => f.snapshot === undefined);
		let acked = 0;
		await until(
			async () => {
				const got = frames().reduce((n, f) => n + f.data.length, 0);
				if (got > acked) {
					acked = got;
					await a.port.handle({ t: "term.ack", reqId: "", id, bytes: got });
				}
				return got >= text.length;
			},
			5000,
			"all the output",
		);
		for (const frame of frames()) expect(frame.data).not.toMatch(/[\ud800-\udbff]$|^[\udc00-\udfff]/);
		expect(
			frames()
				.map(f => f.data)
				.join(""),
		).toBe(text);
	});

	test("an unknown terminal id is an error", async () => {
		const r = rig();
		const { port } = r.client();
		await expect(r.call(port, { t: "term.attach", id: "t_nope", offset: null, cols: 80, rows: 24 })).rejects.toThrow(
			/no terminal t_nope/,
		);
		await expect(r.call(port, { t: "term.input", id: "t_nope", data: "x" })).rejects.toThrow(/no terminal/);
	});
});

describe("flow control", () => {
	test("never more than the window in flight; acknowledgements release more", async () => {
		const r = rig();
		const a = r.client();
		const id = await r.open(a.port);
		await r.call(a.port, { t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		await flush();
		r.ptys[0]!.emit("z".repeat(900_000));
		await flush();
		const sentOf = () => a.socket.of("term.out", id).reduce((n, f) => n + f.data.length, 0);
		expect(sentOf()).toBeLessThanOrEqual(TERM_ACK_WINDOW_CHARS);
		expect(sentOf()).toBeGreaterThanOrEqual(TERM_ACK_WINDOW_CHARS - TERM_FRAME_CHARS);
		expect(a.socket.of("term.out", id).every(f => f.data.length <= TERM_FRAME_CHARS)).toBe(true);
		// acknowledge: more arrives, still bounded by the window beyond what was acked
		await a.port.handle({ t: "term.ack", reqId: "", id, bytes: sentOf() });
		await flush();
		expect(sentOf()).toBeGreaterThan(TERM_ACK_WINDOW_CHARS);
		expect(sentOf()).toBeLessThanOrEqual(2 * TERM_ACK_WINDOW_CHARS);
		// an ack for more than was sent is clamped, not trusted
		await a.port.handle({ t: "term.ack", reqId: "", id, bytes: 10 ** 12 });
		await flush();
		expect(sentOf()).toBeLessThanOrEqual(3 * TERM_ACK_WINDOW_CHARS);
	});

	test("a client that never reads does not slow the pty or another client, and costs the daemon nothing beyond its window", async () => {
		const r = rig();
		const slow = r.client("session:slow");
		const fast = r.client("session:fast");
		const id = await r.open(fast.port, 100, 30);
		await r.call(slow.port, { t: "term.attach", id, offset: null, cols: 100, rows: 30 });
		await r.call(fast.port, { t: "term.attach", id, offset: null, cols: 100, rows: 30 });
		await flush();
		const reader = new TestBrowser(100, 30);
		cleanups.push(() => reader.dispose());
		let index = 0;
		let produced = 0;
		const start = performance.now();
		for (let i = 0; i < 400; i++) {
			const chunk = `${"y".repeat(1000)}\r\n`.repeat(8); // 8 KB
			r.ptys[0]!.emit(chunk);
			produced += chunk.length;
			if (i % 10 === 0) {
				await flush();
				index = reader.apply(fast.socket, id, index);
				await reader.settled();
				await fast.port.handle({ t: "term.ack", reqId: "", id, bytes: reader.consumed });
			}
		}
		const producing = performance.now() - start;
		await until(
			async () => {
				index = reader.apply(fast.socket, id, index);
				await reader.settled();
				await fast.port.handle({ t: "term.ack", reqId: "", id, bytes: reader.consumed });
				return reader.expected === produced;
			},
			5000,
			"the fast client to receive everything",
		);
		// the fast client got it all (the ring is 1 MiB, nothing here exceeds it) and the producer never waited for the slow one
		expect(produced).toBeGreaterThan(3_000_000 - 100_000);
		expect(producing).toBeLessThan(5000);
		const slowSent = slow.socket.of("term.out", id).reduce((n, f) => n + f.data.length, 0);
		expect(slowSent).toBeLessThanOrEqual(TERM_ACK_WINDOW_CHARS);
		expect(reader.gaps).toBe(0);
	});

	test("a client that fell out of the ring is brought back with a snapshot when it finally reads", async () => {
		const r = rig({ ringChars: 8192 });
		const a = r.client();
		const id = await r.open(a.port, 60, 8);
		await r.call(a.port, { t: "term.attach", id, offset: null, cols: 60, rows: 8 });
		await flush();
		for (let i = 0; i < 100; i++) r.ptys[0]!.emit(`row ${i}\r\n`.padEnd(2000, "."));
		r.ptys[0]!.emit("\r\nTHE END\r\n");
		await flush();
		const browser = new TestBrowser(60, 8);
		cleanups.push(() => browser.dispose());
		let index = 0;
		await until(
			async () => {
				index = browser.apply(a.socket, id, index);
				await browser.settled();
				await a.port.handle({ t: "term.ack", reqId: "", id, bytes: browser.consumed });
				return browser.expected === r.service.get(id)!.ring.head;
			},
			6000,
			"the slow client to converge",
		);
		expect(browser.resets).toBeGreaterThanOrEqual(1); // it was reset to a snapshot at some point
		expect(browser.lines().join("\n")).toContain("THE END");
		expect(browser.gaps).toBe(0);
	});

	test("while the gateway reports the browser as backed up nothing is sent; resuming continues from where it stopped", async () => {
		const r = rig();
		const a = r.client();
		const id = await r.open(a.port);
		await r.call(a.port, { t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		await flush();
		a.socket.paused = true;
		r.ptys[0]!.emit("held back\r\n");
		await flush();
		const live = () => a.socket.of("term.out", id).filter(f => f.snapshot === undefined);
		expect(live()).toHaveLength(0);
		a.socket.paused = false;
		a.port.pump();
		expect(
			live()
				.map(f => f.data)
				.join(""),
		).toBe("held back\r\n");
	});
});

describe("resize policy: the pty follows the client that typed last", () => {
	test("the first attached client sets the size; a second one that only looks changes nothing; typing transfers it", async () => {
		const r = rig();
		const a = r.client("session:a");
		const b = r.client("session:b");
		const id = await r.open(a.port, 80, 24);
		await r.call(a.port, { t: "term.attach", id, offset: null, cols: 120, rows: 40 });
		expect(r.service.get(id)!.info).toMatchObject({ cols: 120, rows: 40 });
		await r.call(b.port, { t: "term.attach", id, offset: null, cols: 50, rows: 20 });
		expect(r.service.get(id)!.info).toMatchObject({ cols: 120, rows: 40 }); // b only looks
		await a.port.handle({ t: "term.resize", reqId: "", id, cols: 130, rows: 41 }); // owner resizes: applies
		expect(r.service.get(id)!.info).toMatchObject({ cols: 130, rows: 41 });
		await b.port.handle({ t: "term.resize", reqId: "", id, cols: 55, rows: 22 }); // non-owner: stored only
		expect(r.service.get(id)!.info).toMatchObject({ cols: 130, rows: 41 });
		await b.port.handle({ t: "term.input", reqId: "", id, data: "l" }); // b types: the pty adopts b's latest size
		expect(r.service.get(id)!.info).toMatchObject({ cols: 55, rows: 22 });
		expect(r.ptys[0]!.resizes.at(-1)).toEqual({ cols: 55, rows: 22 });
		await a.port.handle({ t: "term.input", reqId: "", id, data: "s" }); // and back
		expect(r.service.get(id)!.info).toMatchObject({ cols: 130, rows: 41 });
		expect(r.ptys[0]!.written).toEqual(["l", "s"]);
	});

	test("when the owner detaches, the most recently active client that remains takes over; sizes are clamped", async () => {
		const r = rig();
		const a = r.client("session:a");
		const b = r.client("session:b");
		const c = r.client("session:c");
		const id = await r.open(a.port);
		await r.call(a.port, { t: "term.attach", id, offset: null, cols: 100, rows: 30 });
		await r.call(b.port, { t: "term.attach", id, offset: null, cols: 60, rows: 20 });
		await r.call(c.port, { t: "term.attach", id, offset: null, cols: 9999, rows: 1 });
		await b.port.handle({ t: "term.input", reqId: "", id, data: "x" });
		await c.port.handle({ t: "term.input", reqId: "", id, data: "y" });
		expect(r.service.get(id)!.info).toMatchObject({ cols: 400, rows: 5 }); // c typed last; clamped to 400 x 5
		await c.port.handle({ t: "term.detach", reqId: "", id });
		expect(r.service.get(id)!.info).toMatchObject({ cols: 60, rows: 20 }); // b was active more recently than a
		b.port.dispose(); // a connection drop is a detach too
		expect(r.service.get(id)!.info).toMatchObject({ cols: 100, rows: 30 });
	});

	test("size changes travel in order with the output they apply to, to every attached client", async () => {
		const r = rig();
		const a = r.client();
		const b = r.client();
		const id = await r.open(a.port, 80, 24);
		await r.call(a.port, { t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		await r.call(b.port, { t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		await flush();
		r.ptys[0]!.emit("before");
		await a.port.handle({ t: "term.resize", reqId: "", id, cols: 90, rows: 30 });
		r.ptys[0]!.emit("after");
		await flush();
		for (const socket of [a.socket, b.socket]) {
			const kinds = socket.frames
				.filter(f => f.t === "term.out" || f.t === "term.size")
				.map(f => (f.t === "term.out" ? `out:${f.data}` : `size:${f.t === "term.size" ? f.cols : "?"}`));
			expect(kinds.slice(-3)).toEqual(["out:before", "size:90", "out:after"]);
		}
	});
});

describe("exit, kill, dismiss", () => {
	test("the output is delivered before the exit; the terminal stays listed with its exit code and scrollback; late clients still get both", async () => {
		const r = rig();
		const a = r.client();
		const id = await r.open(a.port);
		await r.call(a.port, { t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		await flush();
		r.ptys[0]!.emit("goodbye\r\n");
		r.ptys[0]!.exit(7);
		await until(() => a.socket.of("term.exit", id).length === 1);
		const kinds = a.socket.frames.filter(f => f.t === "term.out" || f.t === "term.exit").map(f => f.t);
		expect(kinds.at(-1)).toBe("term.exit");
		expect(a.socket.of("term.exit", id)[0]).toMatchObject({ code: 7, killed: false });
		expect(r.service.list()[0]).toMatchObject({ state: "exited", exit: { code: 7, killed: false } });
		await r.call(a.port, { t: "term.input", id, data: "ignored\r" }); // no error, no effect
		expect(r.ptys[0]!.written).toEqual([]);
		// a client that comes later sees the scrollback and the exit
		const late = r.client();
		await r.call(late.port, { t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		await until(() => late.socket.of("term.exit", id).length === 1);
		const browser = new TestBrowser();
		cleanups.push(() => browser.dispose());
		browser.apply(late.socket, id);
		await browser.settled();
		expect(browser.lines().join("\n")).toContain("goodbye");
	});

	test("kill answers after the process is gone and says it was killed", async () => {
		const r = rig();
		const a = r.client();
		const id = await r.open(a.port);
		const ack = (await r.call(a.port, { t: "term.kill", id })) as {
			terminal: { state: string; exit: { killed: boolean } };
		};
		expect(ack.terminal.state).toBe("exited");
		expect(ack.terminal.exit.killed).toBe(true);
		expect(r.ptys[0]!.killed).toBe(1);
		expect(r.audit.some(l => l.includes(`terminal kill id=${id}`))).toBe(true);
	});

	test("dismiss: refused while running; for an exited terminal it frees the slot and tells every attached client", async () => {
		const r = rig();
		const a = r.client();
		const b = r.client();
		const id = await r.open(a.port);
		await expect(r.call(a.port, { t: "term.dismiss", id })).rejects.toThrow(/kill it first/);
		await r.call(b.port, { t: "term.attach", id, offset: null, cols: 80, rows: 24 });
		r.ptys[0]!.exit(0);
		await until(() => r.service.get(id)?.info.state === "exited");
		await r.call(a.port, { t: "term.dismiss", id });
		expect(r.service.list()).toEqual([]);
		expect(b.socket.of("term.gone", id)).toMatchObject([{ id, reason: "dismissed" }]);
		await expect(r.call(b.port, { t: "term.input", id, data: "x" })).rejects.toThrow(/no terminal/);
	});

	test("close() (daemon shutdown) kills every running shell and refuses new terminals", async () => {
		const r = rig();
		const { port } = r.client();
		await r.open(port);
		await r.open(port);
		await r.service.close();
		expect(r.ptys.map(p => p.killed)).toEqual([1, 1]);
		expect(r.service.list()).toEqual([]);
		await expect(r.open(port)).rejects.toThrow(/stopping/);
	});
});

describe("the list", () => {
	test("watchers get the list pushed on changes (titles, state, size), coalesced; unwatching stops it", async () => {
		const r = rig();
		const a = r.client();
		const watcher = r.client();
		await r.call(watcher.port, { t: "term.watch", open: true });
		const id = await r.open(a.port);
		await until(() => watcher.socket.of("term.list").length >= 1);
		expect(watcher.socket.of("term.list").at(-1)!.terminals).toMatchObject([{ id, title: null }]);
		const before = watcher.socket.of("term.list").length;
		r.ptys[0]!.emit("\x1b]0;my title\x07");
		r.ptys[0]!.emit("\x1b]0;my title 2\x07");
		await until(() => watcher.socket.of("term.list").at(-1)!.terminals[0]!.title === "my title 2");
		expect(watcher.socket.of("term.list").length - before).toBeLessThanOrEqual(2);
		await r.call(watcher.port, { t: "term.watch", open: false });
		const frozen = watcher.socket.of("term.list").length;
		r.ptys[0]!.exit(0);
		await until(() => r.service.get(id)?.info.state === "exited");
		await flush();
		expect(watcher.socket.of("term.list").length).toBe(frozen);
		expect(a.socket.of("term.list")).toHaveLength(0); // never asked for
	});

	test("control characters in a title never reach the list", async () => {
		const r = rig();
		const { port } = r.client();
		const id = await r.open(port);
		r.ptys[0]!.emit("\x1b]0;evil\x1b[31m\x07title\x07");
		await until(() => r.service.get(id)!.info.title !== null);
		expect(r.service.get(id)!.info.title).not.toMatch(/\p{Cc}/u);
	});
});

describe("a shell that cannot be started", () => {
	test("the client gets a clear error, no terminal is listed and the slot is free again (max 1)", async () => {
		let attempts = 0;
		const { factory, ptys } = fakePtyFactory();
		const r = rig({
			max: 1,
			factory: async (launch, onData) => {
				if (++attempts === 1) {
					// what upstream's PtySession rejects with on Windows when CreateProcessW fails (note the NULs it leaves in)
					throw new Error(
						'Failed to spawn PTY command: CreateProcessW `"C:\\nope\\sh.exe\0"` in cwd `Some("/project/main\0")` failed: The system cannot find the file specified. (os error 2)\n code: "GenericFailure"',
					);
				}
				return factory(launch, onData);
			},
		});
		const { port } = r.client();
		const failed = await r.call(port, { t: "term.open", cols: 80, rows: 24, cwd: "/project/main" }).then(
			() => null,
			(e: unknown) => e,
		);
		expect(failed).toBeInstanceOf(TerminalError);
		expect((failed as TerminalError).message).toMatch(
			/^could not start the shell \/bin\/sh in \/project\/main: Failed to spawn PTY command/,
		);
		expect((failed as TerminalError).message).not.toContain("\0");
		expect(r.service.list()).toEqual([]);
		// max is 1: if the failed attempt had kept its slot this second open would be refused
		await expect(r.open(port)).resolves.toMatch(/^t_/);
		expect(ptys).toHaveLength(1);
		expect(r.audit.filter(l => l.includes("terminal spawn"))).toHaveLength(1); // the failure is not audited as a spawn
	});

	test("the shell kind is handed to the purpose launch (it decides how the command is typed)", async () => {
		const kinds: string[] = [];
		const r = rig({
			shell: "C:\\Windows\\System32\\cmd.exe",
			resolveShell: configured => configured ?? "/bin/sh",
			purposeLaunch: async (_purpose, shell) => {
				kinds.push(shell);
				return { cwd: "/project/main", input: "typed" };
			},
		});
		const { port } = r.client();
		await r.call(port, {
			t: "term.open",
			cols: 80,
			rows: 24,
			purpose: { kind: "broker-login", provider: "x" },
		});
		// the service passes shellKindOf(<resolved shell>) for the platform it runs on
		expect(kinds).toEqual([process.platform === "win32" ? "cmd" : "posix"]);
	});
});
