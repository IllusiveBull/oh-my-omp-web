import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { EscapeScanner, OutputRing } from "../src/terminal-ring";

describe("OutputRing offsets", () => {
	test("offsets count characters and only grow; a slice from any retained offset is gap free", () => {
		const ring = new OutputRing(1024);
		ring.append("hello ");
		ring.append("world\r\n");
		expect([ring.start, ring.head, ring.size]).toEqual([0, 13, 13]);
		expect(ring.slice(0, 100)).toBe("hello world\r\n");
		expect(ring.slice(6, 5)).toBe("world");
		expect(ring.slice(13, 5)).toBe("");
		expect(() => ring.slice(14, 1)).toThrow(RangeError);
	});

	test("old output is discarded in whole chunks once the ring holds the capacity; start moves, head never does", () => {
		const ring = new OutputRing(2048);
		const line = `${"x".repeat(1023)}\n`;
		for (let i = 0; i < 64; i++) ring.append(line.repeat(20)); // 20 KiB per append: one chunk each
		expect(ring.head).toBe(64 * 20 * 1024);
		expect(ring.size).toBeGreaterThanOrEqual(2048);
		expect(ring.size).toBeLessThan(2048 + 20 * 1024 + 1);
		expect(ring.start).toBeGreaterThan(0);
		expect(() => ring.slice(0, 10)).toThrow(RangeError); // gone
		// what is retained is exactly the tail of the stream
		const tail = ring.slice(ring.start, Number.MAX_SAFE_INTEGER);
		expect(tail.length).toBe(ring.size);
		expect(tail.endsWith("\n")).toBe(true);
	});

	test("small appends are merged into larger chunks and still slice correctly across them", () => {
		const ring = new OutputRing(8192);
		let expected = "";
		for (let i = 0; i < 500; i++) {
			const piece = `${i},`;
			ring.append(piece);
			expected += piece;
		}
		expect(ring.slice(0, expected.length)).toBe(expected);
		expect(ring.slice(100, 50)).toBe(expected.slice(100, 150));
	});
});

describe("OutputRing boundary safety", () => {
	test("a slice never ends between the halves of a surrogate pair", () => {
		const ring = new OutputRing(1024);
		const text = "a😀b😀c";
		ring.append(text);
		const first = ring.slice(0, 2); // "a" + high surrogate of 😀
		expect(first).toBe("a");
		const second = ring.slice(1, 2);
		expect(second).toBe("😀");
		let at = 0;
		let joined = "";
		while (at < ring.head) {
			const part = ring.slice(at, 2);
			expect(part.length).toBeGreaterThan(0);
			joined += part;
			at += part.length;
		}
		expect(joined).toBe(text);
	});

	test("eviction keeps a chunk that starts inside an escape sequence until a clean boundary exists", () => {
		const ring = new OutputRing(1024);
		const filler = "a".repeat(20 * 1024);
		ring.append(filler);
		ring.append(`${filler}\x1b[38;5;`); // the chunk ends inside a CSI
		ring.append(`196mred\x1b[0m${filler}`); // the next chunk starts in the middle of it
		ring.append(filler); // clean boundary again
		ring.append(filler);
		// whatever is retained begins outside every sequence: replaying from `start` cannot garble a terminal
		const scanner = new EscapeScanner();
		expect(ring.startsClean(ring.start)).toBe(true);
		scanner.push(ring.slice(ring.start, 100));
		expect(scanner.ground).toBe(true);
		expect(ring.size).toBeGreaterThanOrEqual(1024);
	});

	test("replaying from the ring's start renders what a terminal that saw everything shows after a full reset of the screen", async () => {
		// the stream: coloured lines with sequences that straddle chunk boundaries
		const ring = new OutputRing(4096);
		let all = "";
		for (let i = 0; i < 400; i++) {
			const line = `\x1b[${30 + (i % 8)}mline ${i}\x1b[0m \x1b]0;title ${i}\x07\r\n`;
			all += line;
		}
		// feed in odd-sized pieces so sequences are cut at arbitrary places
		for (let at = 0; at < all.length; at += 4099) ring.append(all.slice(at, at + 4099));
		const replayed = new Terminal({ cols: 60, rows: 6, scrollback: 50, allowProposedApi: true });
		const written = Promise.withResolvers<void>();
		replayed.write(ring.slice(ring.start, Number.MAX_SAFE_INTEGER), written.resolve);
		await written.promise;
		const rows: string[] = [];
		for (let i = 0; i < replayed.buffer.active.length; i++)
			rows.push(replayed.buffer.active.getLine(i)?.translateToString(true) ?? "");
		// no stray fragments of a cut escape sequence ("38;5;196m", "31m", "]0;") appear in the visible text
		for (const row of rows) expect(row).toMatch(/^(line \d+ ?)?$/);
		expect(rows.some(row => row === "line 399" || row === "line 399 ")).toBe(true);
		replayed.dispose();
	});
});

describe("EscapeScanner", () => {
	test("tracks CSI, OSC (BEL and ST terminated), DCS and two-character escapes across chunks", () => {
		const s = new EscapeScanner();
		for (const [chunk, ground] of [
			["text", true],
			["\x1b", false],
			["[3", false],
			["8;5;1m", true],
			["\x1b]0;ti", false],
			["tle\x07", true],
			["\x1b]2;a\x1b", false],
			["\\", true],
			["\x1bPq#0", false],
			["\x1b\\", true],
			["\x1b(B", true],
			["\x1b[31m\x18\x1b[", false],
			["\x1a", true],
		] as [string, boolean][]) {
			s.push(chunk);
			expect(s.ground).toBe(ground);
		}
	});

	test("reports complete CSI sequences, however the chunks fall", () => {
		const seen: string[] = [];
		const s = new EscapeScanner((params, final) => seen.push(`${params}|${final}`));
		const stream = "ab\x1b[?25l\x1b[5 q\x1b[?1006;1002h\x1b[2J";
		for (const ch of stream) s.push(ch);
		expect(seen).toEqual(["?25|l", "5 |q", "?1006;1002|h", "2|J"]);
	});
});
