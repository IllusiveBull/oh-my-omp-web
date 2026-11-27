import { describe, expect, test } from "bun:test";
import {
	clientFrame,
	parseBrowserMessage,
	parseClientFrame,
	parseEnvLinkMessage,
	parseGatewayLinkMessage,
	tagFrame,
	type ServerMessage,
} from "../src";

describe("tagFrame", () => {
	test("adds the machine id without touching the rest, so the frame stays valid JSON and keeps its type", () => {
		const frame = JSON.stringify({
			t: "events",
			sessionId: "s",
			events: [{ seq: 1, ev: { k: "closed", reason: 'x"}' } }],
		});
		const tagged = tagFrame(frame, 'm"1');
		expect(JSON.parse(tagged)).toEqual({ ...JSON.parse(frame), m: 'm"1' });
		expect(tagged.endsWith(frame.slice(1))).toBe(true);
		const message = JSON.parse(tagged) as ServerMessage;
		expect(message.t === "events" && message.m).toBe('m"1');
	});

	test("refuses anything that is not a JSON object frame", () => {
		expect(() => tagFrame("[1]", "m")).toThrow();
		expect(() => tagFrame("{}", "m")).toThrow();
		expect(() => tagFrame("", "m")).toThrow();
	});
});

describe("client frames on the link", () => {
	test("`<cid>\\n<frame>` round-trips, and control messages are never mistaken for it", () => {
		const frame = '{"t":"ack","reqId":"1","ok":true}';
		expect(parseClientFrame(clientFrame("c-1", frame))).toEqual({ cid: "c-1", frame });
		expect(parseClientFrame(clientFrame("c-1", `${frame}\nmore`))).toEqual({ cid: "c-1", frame: `${frame}\nmore` });
		expect(parseClientFrame('{"t":"sessions","sessions":[]}')).toBeNull();
		expect(parseClientFrame('{"t":"ping"}')).toBeNull();
		expect(parseClientFrame("no-newline")).toBeNull();
		expect(parseClientFrame("\nleading")).toBeNull();
	});
});

describe("link control messages", () => {
	test("gateway -> daemon messages parse and reject malformed input", () => {
		const ok: unknown[] = [
			{ t: "challenge", nonce: "n", protocol: 1 },
			{ t: "registered", proof: "p" },
			{ t: "rejected", reason: "r" },
			{ t: "open", cid: "c" },
			{ t: "close", cid: "c" },
			{ t: "req", cid: "c", text: "{}" },
			{ t: "pause", cid: "c" },
			{ t: "resume", cid: "c" },
			{ t: "broker.config", config: { url: "http://127.0.0.1:8765", token: "t" } },
			{ t: "broker.config", config: null },
		];
		for (const m of ok) expect(parseGatewayLinkMessage(JSON.stringify(m))).toEqual(m as never);
		for (const bad of [
			"{",
			"[]",
			'{"t":5}',
			'{"t":"open"}',
			'{"t":"challenge","nonce":"n","protocol":"1"}',
			'{"t":"teleport"}',
			'{"t":"broker.config"}',
			'{"t":"broker.config","config":{"url":"u"}}',
			'{"t":"broker.config","config":[]}',
		]) {
			expect(() => parseGatewayLinkMessage(bad)).toThrow();
		}
	});

	test("daemon -> gateway messages parse and reject malformed input", () => {
		const hello = {
			protocol: 3,
			daemonVersion: "1",
			omp: { version: "1", expectedVersion: "1", versionMismatch: false },
			leaseWarnings: [],
		};
		const register = {
			t: "register",
			protocol: 1,
			machineId: "m",
			platform: "linux",
			hello,
			cnonce: "c",
			acceptsBroker: true,
			proof: "p",
		};
		expect(parseEnvLinkMessage(JSON.stringify(register))).toEqual(register as never);
		expect(
			parseEnvLinkMessage(JSON.stringify({ ...register, hello: { ...hello, home: "/custom/home" } })),
		).toMatchObject({
			hello: { home: "/custom/home" },
		});
		expect(() => parseEnvLinkMessage(JSON.stringify({ ...register, hello: { ...hello, home: 42 } }))).toThrow(
			"hello.home",
		);
		expect(() => parseEnvLinkMessage(JSON.stringify({ ...register, acceptsBroker: "yes" }))).toThrow("acceptsBroker");
		const { acceptsBroker: _omitted, ...withoutFlag } = register;
		expect(() => parseEnvLinkMessage(JSON.stringify(withoutFlag))).toThrow("acceptsBroker");
		expect(parseEnvLinkMessage('{"t":"sessions","sessions":[]}')).toEqual({ t: "sessions", sessions: [] });
		expect(parseEnvLinkMessage('{"t":"projects","projects":[]}')).toEqual({ t: "projects", projects: [] });
		expect(parseEnvLinkMessage('{"t":"closed","cid":"c","reason":"r"}')).toEqual({
			t: "closed",
			cid: "c",
			reason: "r",
		});
		const status = { source: "gateway", state: "ok", url: "http://127.0.0.1:8765", checkedAt: 1, lastOkAt: 1 };
		expect(parseEnvLinkMessage(JSON.stringify({ t: "broker.status", status }))).toEqual({
			t: "broker.status",
			status,
		} as never);
		for (const bad of [
			'{"t":"broker.status"}',
			'{"t":"broker.status","status":[]}',
			'{"t":"sessions"}',
			'{"t":"register","protocol":1}',
			'{"t":"closed","cid":"c"}',
			'{"t":"nope"}',
		]) {
			expect(() => parseEnvLinkMessage(bad)).toThrow();
		}
	});
});

describe("browser messages", () => {
	test("an env request carries its machine and comes out without it; the gateway's own `read` has no env part", () => {
		const parsed = parseBrowserMessage(
			JSON.stringify({ t: "prompt", reqId: "1", m: "m_a", sessionId: "s", message: "hi" }),
		);
		expect(parsed).toEqual({
			kind: "env",
			machine: "m_a",
			message: { t: "prompt", reqId: "1", sessionId: "s", message: "hi" },
		});
		expect(JSON.stringify(parsed)).not.toContain('"m":"m_a"');
		expect(
			parseBrowserMessage(
				JSON.stringify({ t: "read", reqId: "2", m: "m_a", sessionId: "s", seq: 4, epoch: "e", modifiedAt: 9 }),
			),
		).toEqual({
			kind: "gateway",
			message: { t: "read", reqId: "2", m: "m_a", sessionId: "s", seq: 4, epoch: "e", modifiedAt: 9 },
		});
		expect(parseBrowserMessage(JSON.stringify({ t: "project.add", reqId: "3", m: "m_a", path: "/p" })).kind).toBe(
			"env",
		);
	});

	test("a missing machine, a missing reqId and bad read fields are errors", () => {
		expect(() =>
			parseBrowserMessage(JSON.stringify({ t: "prompt", reqId: "1", sessionId: "s", message: "x" })),
		).toThrow('"m"');
		expect(() =>
			parseBrowserMessage(JSON.stringify({ t: "read", m: "a", sessionId: "s", seq: 0, modifiedAt: 0 })),
		).toThrow("reqId");
		expect(() =>
			parseBrowserMessage(JSON.stringify({ t: "read", reqId: "1", m: "a", sessionId: "s", seq: -1, modifiedAt: 0 })),
		).toThrow("seq");
		expect(() =>
			parseBrowserMessage(
				JSON.stringify({ t: "read", reqId: "1", m: "a", sessionId: "s", seq: 0, modifiedAt: -1.5 }),
			),
		).toThrow("modifiedAt");
		expect(() => parseBrowserMessage("not json")).toThrow("JSON");
	});
});

describe("replica and attention link messages, view message", () => {
	test("gateway -> daemon replica.want, with and without what the gateway holds", () => {
		const have = { size: 300, slotLen: 256, headHash: "a", tailHash: "b" };
		expect(parseGatewayLinkMessage(JSON.stringify({ t: "replica.want", id: "f1", have }))).toEqual({
			t: "replica.want",
			id: "f1",
			have,
		});
		expect(parseGatewayLinkMessage('{"t":"replica.want","id":"f1","have":null}')).toEqual({
			t: "replica.want",
			id: "f1",
			have: null,
		});
		expect(() => parseGatewayLinkMessage('{"t":"replica.want","id":"f1"}')).toThrow("have");
		expect(() => parseGatewayLinkMessage('{"t":"replica.want","id":"f1","have":3}')).toThrow("have");
	});

	test("daemon -> gateway replica.manifest / data / skip and attention", () => {
		const data = {
			t: "replica.data",
			id: "f",
			restart: false,
			slot: "",
			offset: 256,
			data: "AAEC",
			size: 300,
			mtimeMs: 1.5,
			more: true,
		};
		expect(parseEnvLinkMessage(JSON.stringify(data))).toEqual(data as never);
		expect(parseEnvLinkMessage('{"t":"replica.manifest","files":[]}')).toEqual({ t: "replica.manifest", files: [] });
		expect(parseEnvLinkMessage('{"t":"replica.skip","id":"f","reason":"gone"}')).toEqual({
			t: "replica.skip",
			id: "f",
			reason: "gone",
		});
		const event = { sessionId: "s", kind: "turn_end", title: "t", detail: "d" };
		expect(parseEnvLinkMessage(JSON.stringify({ t: "attention", event }))).toEqual({
			t: "attention",
			event,
		} as never);
		for (const bad of [
			{ ...data, restart: "no" },
			{ ...data, offset: -1 },
			{ ...data, data: 5 },
			{ ...data, more: undefined },
			{ t: "attention" },
			{ t: "replica.manifest" },
		]) {
			expect(() => parseEnvLinkMessage(JSON.stringify(bad))).toThrow();
		}
	});

	test("the browser's view message", () => {
		expect(
			parseBrowserMessage(JSON.stringify({ t: "view", reqId: "1", m: "m_a", sessionId: "s", visible: true })),
		).toEqual({
			kind: "gateway",
			message: { t: "view", reqId: "1", m: "m_a", sessionId: "s", visible: true },
		});
		expect(
			parseBrowserMessage(JSON.stringify({ t: "view", reqId: "1", m: "m_a", sessionId: null, visible: false })),
		).toMatchObject({
			message: { sessionId: null, visible: false },
		});
		expect(() =>
			parseBrowserMessage(JSON.stringify({ t: "view", reqId: "1", m: "m_a", sessionId: 5, visible: true })),
		).toThrow("sessionId");
		expect(() => parseBrowserMessage(JSON.stringify({ t: "view", reqId: "1", m: "m_a", sessionId: "s" }))).toThrow(
			"visible",
		);
	});
});
