import { describe, expect, test } from "bun:test";
import {
	clampTerminalSize,
	isTerminalOneway,
	parseBrowserMessage,
	parseClientMessage,
	parseGatewayLinkMessage,
	TERM_MAX_INPUT_CHARS,
} from "../src";

describe("terminal frames", () => {
	test("every term.* request validates and survives parseClientMessage and parseBrowserMessage", () => {
		const ok: Record<string, unknown>[] = [
			{ t: "term.watch", reqId: "1", open: true },
			{ t: "term.open", reqId: "1", cols: 80, rows: 24, cwd: "/work/repo" },
			{ t: "term.open", reqId: "1", cols: 80, rows: 24, purpose: { kind: "broker-login", provider: "deepseek" } },
			{ t: "term.open", reqId: "1", cols: 80, rows: 24, purpose: { kind: "antigravity-login" } },
			{ t: "term.attach", reqId: "1", id: "t1", offset: null, cols: 80, rows: 24 },
			{ t: "term.attach", reqId: "1", id: "t1", offset: 1234, cols: 120.9, rows: 30 },
			{ t: "term.detach", reqId: "", id: "t1" },
			{ t: "term.input", reqId: "", id: "t1", data: "ls\r" },
			{ t: "term.resize", reqId: "", id: "t1", cols: 100, rows: 40 },
			{ t: "term.ack", reqId: "", id: "t1", bytes: 65536 },
			{ t: "term.kill", reqId: "1", id: "t1" },
			{ t: "term.dismiss", reqId: "1", id: "t1" },
		];
		for (const msg of ok) {
			const parsed = parseClientMessage(JSON.stringify(msg));
			expect(parsed.t).toBe(msg.t as typeof parsed.t);
			const browser = parseBrowserMessage(JSON.stringify({ ...msg, m: "m_x" }));
			expect(browser).toMatchObject({ kind: "env", machine: "m_x", message: { t: msg.t } });
		}
		// sizes are integers after parsing (the daemon clamps them to the pty's limits)
		expect(
			parseClientMessage('{"t":"term.attach","reqId":"1","id":"t","offset":0,"cols":120.9,"rows":30}'),
		).toMatchObject({
			cols: 120,
		});
	});

	test("malformed frames are refused with a readable error", () => {
		const bad: [Record<string, unknown>, RegExp][] = [
			[{ t: "term.open", reqId: "1", cols: 80 }, /rows/],
			[{ t: "term.open", reqId: "1", cols: 0, rows: 24 }, /cols/],
			[{ t: "term.open", reqId: "1", cols: 80, rows: 24, purpose: { kind: "other", provider: "x" } }, /purpose/],
			[
				{
					t: "term.open",
					reqId: "1",
					cols: 80,
					rows: 24,
					purpose: { kind: "broker-login", provider: "a b; rm -rf /" },
				},
				/provider/,
			],
			[{ t: "term.attach", reqId: "1", id: "t", offset: -1, cols: 80, rows: 24 }, /offset/],
			[{ t: "term.attach", reqId: "1", id: "t", offset: 1.5, cols: 80, rows: 24 }, /offset/],
			[{ t: "term.input", reqId: "", id: "t", data: "x".repeat(TERM_MAX_INPUT_CHARS + 1) }, /longer/],
			[{ t: "term.input", reqId: "", id: "t", data: 5 }, /data/],
			[{ t: "term.ack", reqId: "", id: "t", bytes: -4 }, /bytes/],
			[{ t: "term.nope", reqId: "1" }, /unknown message type/],
			[{ t: "term.kill", reqId: "1" }, /id/],
		];
		for (const [msg, pattern] of bad) expect(() => parseClientMessage(JSON.stringify(msg))).toThrow(pattern);
	});

	test("one-way requests are exactly the high-rate ones", () => {
		for (const t of ["term.input", "term.resize", "term.ack", "term.detach"]) expect(isTerminalOneway(t)).toBe(true);
		for (const t of [
			"term.open",
			"term.attach",
			"term.kill",
			"term.dismiss",
			"term.watch",
			"sessions.list",
			"toString",
		]) {
			expect(isTerminalOneway(t)).toBe(false);
		}
	});

	test("sizes are clamped to the pty's limits", () => {
		expect(clampTerminalSize(5, 2)).toEqual({ cols: 20, rows: 5 });
		expect(clampTerminalSize(1000, 1000)).toEqual({ cols: 400, rows: 200 });
		expect(clampTerminalSize(120.7, 40.2)).toEqual({ cols: 120, rows: 40 });
	});

	test("the link's open message carries who, truncated; an old open without it still parses", () => {
		expect(parseGatewayLinkMessage(JSON.stringify({ t: "open", cid: "c", who: "abc" }))).toEqual({
			t: "open",
			cid: "c",
			who: "abc",
		});
		expect(parseGatewayLinkMessage(JSON.stringify({ t: "open", cid: "c" }))).toEqual({ t: "open", cid: "c" });
		const long = parseGatewayLinkMessage(JSON.stringify({ t: "open", cid: "c", who: "x".repeat(500) }));
		expect(long.t === "open" && long.who?.length).toBe(64);
	});
});
