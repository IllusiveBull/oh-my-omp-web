import { afterEach, describe, expect, test } from "bun:test";
import { OutputRing } from "../src/terminal-ring";
import { TerminalScreen } from "../src/terminal-screen";
import { TestBrowser, until } from "./terminal-fixtures";

const disposables: { dispose(): void }[] = [];
afterEach(() => {
	for (const d of disposables.splice(0)) d.dispose();
});

function rig(cols = 60, rows = 12, ringChars = 1 << 20) {
	const ring = new OutputRing(ringChars);
	const titles: string[] = [];
	const screen = new TerminalScreen(ring, { cols, rows, scrollback: 500, onTitle: t => titles.push(t) });
	disposables.push(screen);
	return {
		ring,
		screen,
		titles,
		async write(data: string): Promise<void> {
			ring.append(data);
			screen.pump();
			await until(() => screen.parsed === ring.head, 4000, "the emulator to catch up");
		},
	};
}

/** A browser that received the screen's snapshot and nothing else. */
async function restore(shot: { data: string; cols: number; rows: number }): Promise<TestBrowser> {
	const browser = new TestBrowser(shot.cols, shot.rows);
	disposables.push({ dispose: () => browser.dispose() });
	browser.term.reset();
	const done = Promise.withResolvers<void>();
	browser.term.write(shot.data, done.resolve);
	await done.promise;
	return browser;
}

const modes = (t: TestBrowser) => JSON.parse(JSON.stringify(t.term.modes)) as Record<string, unknown>;

/** A vim-like session: alternate screen, mouse tracking + SGR encoding, bracketed paste, hidden cursor, bar cursor, colours. */
const VIM = [
	"\x1b[?1049h\x1b[2J\x1b[H",
	"\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[6 q",
	"\x1b]0;vim: notes.txt\x07",
	"\x1b[1;1H\x1b[38;5;208mfn main() {\x1b[0m",
	"\x1b[2;3H\x1b[1;4;48;2;10;20;30mbold underline truecolor bg\x1b[0m",
	"\x1b[3;1H\u4f60\u597d \ud83d\ude00 wide and emoji",
	"\x1b[12;1H\x1b[7m-- INSERT --\x1b[0m\x1b[3;9H",
].join("");

describe("screen snapshot", () => {
	test("restores the alternate screen, its content and attributes, and the modes of a full-screen program in a fresh terminal", async () => {
		const r = rig();
		await r.write("$ ls\r\nfile-a  file-b\r\n$ vim notes.txt\r\n");
		await r.write(VIM);
		const shot = r.screen.snapshot();
		expect(shot.offset).toBe(r.ring.head);
		const client = await restore(shot);
		// the alternate buffer is the active one, with the same content, attributes and cursor
		expect(client.term.buffer.active.type).toBe("alternate");
		expect(client.term.buffer.active.getLine(0)?.translateToString(true)).toBe("fn main() {");
		expect(client.term.buffer.active.getLine(2)?.translateToString(true)).toContain(
			"\u4f60\u597d \ud83d\ude00 wide and emoji",
		);
		expect(client.term.buffer.active.cursorY).toBe(2);
		expect(client.term.buffer.active.cursorX).toBe(8);
		// the normal buffer (shell history under the program) survived too
		const normal: string[] = [];
		for (let i = 0; i < client.term.buffer.normal.length; i++)
			normal.push(client.term.buffer.normal.getLine(i)?.translateToString(true) ?? "");
		expect(normal.join("\n")).toContain("file-a  file-b");
		// modes
		expect(modes(client)).toMatchObject({ bracketedPasteMode: true, mouseTrackingMode: "drag" });
		// the same byte stream replayed into a fresh terminal gives the identical state (the strongest check we have)
		const reference = new TestBrowser(60, 12);
		disposables.push({ dispose: () => reference.dispose() });
		const done = Promise.withResolvers<void>();
		reference.term.write("$ ls\r\nfile-a  file-b\r\n$ vim notes.txt\r\n" + VIM, done.resolve);
		await done.promise;
		expect(client.serialize.serialize()).toBe(reference.serialize.serialize());
		expect(modes(client)).toEqual(modes(reference));
	});

	test("carries what the serializer leaves out: cursor visibility, the mouse encoding, the cursor style", async () => {
		const r = rig();
		await r.write(VIM);
		const shot = r.screen.snapshot();
		expect(shot.data).toContain("\x1b[?1006h");
		expect(shot.data).toContain("\x1b[6 q");
		expect(shot.data).toContain("\x1b[?25l");
		// and a program that put them back to normal does not leave them behind
		await r.write("\x1b[?25h\x1b[?1006l\x1b[0 q");
		const after = r.screen.snapshot();
		expect(after.data).not.toContain("\x1b[?25l");
		expect(after.data).not.toContain("\x1b[?1006h");
	});

	test("after a snapshot the live stream continues seamlessly: the restored terminal and one that saw everything stay identical", async () => {
		const r = rig();
		await r.write("$ top\r\n");
		await r.write(VIM);
		const shot = r.screen.snapshot();
		const restored = await restore(shot);
		const tail = "\x1b[4;1H\x1b[32mgreen line\x1b[0m\x1b[?1049l$ \r\nback in the shell\r\n";
		await r.write(tail);
		const done = Promise.withResolvers<void>();
		restored.term.write(r.ring.slice(shot.offset, 1 << 20), done.resolve);
		await done.promise;
		const live = r.screen.snapshot();
		const fresh = await restore(live);
		expect(restored.serialize.serialize()).toBe(fresh.serialize.serialize());
		expect(restored.term.buffer.active.type).toBe("normal");
		expect(restored.lines().join("\n")).toContain("back in the shell");
	});

	test("history survives: a client that attaches late gets the scrollback, not just the visible rows", async () => {
		const r = rig(40, 5);
		let text = "";
		for (let i = 0; i < 120; i++) text += `history line ${i}\r\n`;
		await r.write(text);
		const client = await restore(r.screen.snapshot());
		const lines = client.lines();
		expect(lines).toContain("history line 0");
		expect(lines).toContain("history line 119");
	});

	test("a resize is applied at its place in the stream, not when the emulator happens to see it", async () => {
		const r = rig(60, 8);
		await r.write(`${"a".repeat(70)}\r\n`); // wraps at 60 columns
		r.ring.append("x".repeat(30)); // arrives, unparsed so far
		r.screen.noteResize(r.ring.head, 30, 8); // from here on the pty is 30 wide
		r.ring.append("y".repeat(40));
		r.screen.pump();
		await until(() => r.screen.parsed === r.ring.head);
		const shot = r.screen.snapshot();
		expect([shot.cols, shot.rows]).toEqual([30, 8]);
		// a terminal that was resized at exactly that point of the stream ends in the same state
		const reference = new TestBrowser(60, 8);
		disposables.push({ dispose: () => reference.dispose() });
		const first = Promise.withResolvers<void>();
		reference.term.write(`${"a".repeat(70)}\r\n${"x".repeat(30)}`, first.resolve);
		await first.promise;
		reference.term.resize(30, 8);
		const second = Promise.withResolvers<void>();
		reference.term.write("y".repeat(40), second.resolve);
		await second.promise;
		const client = await restore(shot);
		expect(client.serialize.serialize()).toBe(reference.serialize.serialize());
		// a terminal that resized before the x's (what applying it on sight would do) is different
		const early = new TestBrowser(30, 8);
		disposables.push({ dispose: () => early.dispose() });
		const third = Promise.withResolvers<void>();
		early.term.write(`${"a".repeat(70)}\r\n${"x".repeat(30)}${"y".repeat(40)}`, third.resolve);
		await third.promise;
		expect(early.serialize.serialize()).not.toBe(reference.serialize.serialize());
	});

	test("the window title the program sets is reported", async () => {
		const r = rig();
		await r.write("\x1b]0;first\x07\x1b]2;second\x1b\\");
		expect(r.titles).toEqual(["first", "second"]);
	});
});

describe("screen under overload", () => {
	test("when the ring discards output the emulator has not read, it restarts at the ring's start instead of lying", async () => {
		const r = rig(80, 10, 8 * 1024);
		// 40 appends of 4 KiB with no chance for the emulator to run in between: the ring wraps several times
		for (let i = 0; i < 40; i++) r.ring.append(`${`${i}`.padEnd(100, "-")}\r\n`.repeat(40));
		r.ring.append("THE LAST LINE\r\n");
		r.screen.pump();
		await until(() => r.screen.parsed === r.ring.head);
		expect(r.screen.restarts).toBeGreaterThanOrEqual(1);
		const shot = r.screen.snapshot();
		expect(shot.offset).toBe(r.ring.head);
		const client = await restore(shot);
		expect(client.lines()).toContain("THE LAST LINE");
		// and the part that was skipped is simply not there: the oldest line the client has is from the ring, not from offset 0
		expect(client.lines()).not.toContain("0".padEnd(100, "-"));
	});

	test("a snapshot taken while the emulator is behind is of what it has parsed, with the offset to continue from", async () => {
		const r = rig();
		await r.write("first\r\n");
		const parsed = r.screen.parsed;
		r.ring.append("second\r\n".repeat(5)); // not pumped yet
		const shot = r.screen.snapshot();
		expect(shot.offset).toBe(parsed);
		const client = await restore(shot);
		expect(client.lines().join("\n")).toContain("first");
		expect(client.lines().join("\n")).not.toContain("second");
		// the rest comes from the ring at that offset
		const done = Promise.withResolvers<void>();
		client.term.write(r.ring.slice(shot.offset, 1 << 20), done.resolve);
		await done.promise;
		expect(client.lines().join("\n")).toContain("second");
	});
});
