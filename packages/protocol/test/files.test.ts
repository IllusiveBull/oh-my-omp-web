import { describe, expect, test } from "bun:test";
import { FILE_CHUNK_BYTES, FILE_MAX_PAGE_LINES, parseBrowserMessage, parseClientMessage } from "../src";

const parse = (frame: Record<string, unknown>) => parseClientMessage(JSON.stringify(frame));

describe("files.* frames", () => {
	test("valid frames of every type parse into their typed form", () => {
		expect(parse({ t: "files.list", reqId: "1", root: "/r", path: "src", showIgnored: true })).toEqual({
			t: "files.list",
			reqId: "1",
			root: "/r",
			path: "src",
			showIgnored: true,
		});
		expect(
			parse({ t: "files.read", reqId: "2", root: "/r", path: "a.ts", fromLine: 40, maxLines: 500 }),
		).toMatchObject({
			t: "files.read",
			fromLine: 40,
			maxLines: 500,
		});
		expect(parse({ t: "files.read", reqId: "2", root: "/r", path: "" })).toMatchObject({ fromLine: undefined });
		expect(
			parse({ t: "files.bytes", reqId: "3", root: "/r", path: "a.png", offset: 0, length: FILE_CHUNK_BYTES }),
		).toMatchObject({ t: "files.bytes" });
		expect(parse({ t: "files.status", reqId: "4", root: "/r" })).toEqual({
			t: "files.status",
			reqId: "4",
			root: "/r",
		});
		expect(
			parse({ t: "files.diff", reqId: "5", root: "/r", path: "a", mode: "staged", origPath: "b" }),
		).toMatchObject({ mode: "staged", origPath: "b" });
	});

	test("type, range and size violations are refused with a message naming the field", () => {
		const bad: [Record<string, unknown>, RegExp][] = [
			[{ t: "files.list", reqId: "1", root: "/r" }, /"path"/],
			[{ t: "files.list", reqId: "1", root: "", path: "" }, /"root"/],
			[{ t: "files.list", reqId: "1", root: "/r", path: 4 }, /"path" must be a string/],
			[{ t: "files.list", reqId: "1", root: "/r", path: "", showIgnored: "yes" }, /"showIgnored"/],
			[{ t: "files.read", reqId: "1", root: "/r", path: "a", fromLine: 0 }, /"fromLine"/],
			[{ t: "files.read", reqId: "1", root: "/r", path: "a", fromLine: 1.5 }, /"fromLine"/],
			[{ t: "files.read", reqId: "1", root: "/r", path: "a", maxLines: FILE_MAX_PAGE_LINES + 1 }, /"maxLines"/],
			[{ t: "files.bytes", reqId: "1", root: "/r", path: "a", offset: -1, length: 1 }, /"offset"/],
			[{ t: "files.bytes", reqId: "1", root: "/r", path: "a", offset: 0, length: FILE_CHUNK_BYTES + 1 }, /"length"/],
			[{ t: "files.bytes", reqId: "1", root: "/r", path: "a", offset: 0, length: 0 }, /"length"/],
			[{ t: "files.diff", reqId: "1", root: "/r", path: "a", mode: "all" }, /"mode"/],
			[{ t: "files.diff", reqId: "1", root: "/r", path: "a" }, /"mode"/],
			[{ t: "files.status", reqId: "1", root: "x".repeat(5000) }, /longer than/],
			[{ t: "files.unknown", reqId: "1", root: "/r" }, /unknown message type/],
		];
		for (const [frame, message] of bad) expect(() => parse(frame)).toThrow(message);
	});

	test("through the gateway's parser they are addressed to a machine like any other request", () => {
		const parsed = parseBrowserMessage(JSON.stringify({ t: "files.status", reqId: "1", root: "/r", m: "m_x" }));
		expect(parsed).toMatchObject({ kind: "env", machine: "m_x", message: { t: "files.status", root: "/r" } });
		expect(() => parseBrowserMessage(JSON.stringify({ t: "files.status", reqId: "1", root: "/r" }))).toThrow();
	});
});
