import { describe, expect, test } from "bun:test";
import {
	filesHash,
	isAccountsHash,
	isFilesHash,
	parseFilesHash,
	parseSessionHash,
	parseRoute,
	parseTerminalHash,
	routeHash,
	sessionHash,
	terminalHash,
} from "../src/lib/route";

/** Which of the app's views a hash selects: the app renders the first match, so exactly one must match. */
const matches = (hash: string): string[] =>
	[
		parseSessionHash(hash) && "session",
		parseTerminalHash(hash) && "terminal",
		parseFilesHash(hash) && "files",
		isAccountsHash(hash) && "accounts",
	].filter((v): v is string => typeof v === "string");

describe("the four views never claim the same hash", () => {
	test("each view's own hash selects only that view, including ids that look like another view's segment", () => {
		expect(matches(sessionHash({ machine: "m_1", id: "t" }))).toEqual(["session"]);
		expect(matches(sessionHash({ machine: "m/t/x", id: "s/f/y" }))).toEqual(["session"]);
		expect(matches(terminalHash({ machine: "m_1", id: "s" }))).toEqual(["terminal"]);
		expect(matches(terminalHash({ machine: "f", id: "t_abc/def" }))).toEqual(["terminal"]);
		expect(matches(filesHash({ machine: "m_1", root: "/r/t/x", path: "s/t.ts" }))).toEqual(["files"]);
		expect(matches("#/accounts")).toEqual(["accounts"]);
		expect(matches("")).toEqual([]);
		expect(isFilesHash(terminalHash({ machine: "m", id: "t" }))).toBe(false);
	});

	test("hand-edited and malformed hashes select nothing rather than the wrong view", () => {
		for (const hash of ["#/m/m_1/t", "#/m/m_1/t/", "#/m/%E0/t/x", "#/m/m_1/x/y", "#/t/m_1/x", "#/m/m_1/s/a/b"]) {
			expect(matches(hash).length).toBeLessThanOrEqual(1);
		}
		expect(matches("#/m/%E0%A4%A/t/x")).toEqual([]);
	});
});

describe("the app route: main view plus dock", () => {
	const session = { kind: "session", ref: { machine: "m|1", id: "s/|x" } } as const;
	const files = { machine: "m", root: "/r|oot", path: "src/a|b.ts", line: 3, diff: undefined };

	test("main view and dock round-trip, ids holding `|` included", () => {
		for (const route of [
			{ main: session, dock: null },
			{ main: session, dock: { tab: "agents" } },
			{ main: session, dock: { tab: "terminal", ref: { machine: "m", id: "t_1" } } },
			{ main: session, dock: { tab: "changes", ref: { machine: "m", root: "/r", path: "x.ts", diff: "head" } } },
			{ main: { kind: "accounts" }, dock: { tab: "terminal", ref: null } },
			{ main: null, dock: { tab: "files", ref: { machine: "m", root: "/r", path: "" } } },
			{ main: null, dock: null },
		] as const) {
			expect(parseRoute(routeHash(route))).toEqual(route);
		}
		const withLine = parseRoute(routeHash({ main: session, dock: { tab: "files", ref: files } }));
		expect(withLine.dock).toEqual({
			tab: "files",
			ref: { machine: "m", root: "/r|oot", path: "src/a|b.ts", line: 3 },
		});
	});

	test("a bare Files or terminal hash opens that view in the dock beside nothing", () => {
		expect(parseRoute(filesHash({ machine: "m", root: "/r", path: "a.ts" }))).toEqual({
			main: null,
			dock: { tab: "files", ref: { machine: "m", root: "/r", path: "a.ts" } },
		});
		expect(parseRoute(terminalHash({ machine: "m", id: "t" }))).toEqual({
			main: null,
			dock: { tab: "terminal", ref: { machine: "m", id: "t" } },
		});
	});

	test("a malformed dock part closes the dock but keeps the main view", () => {
		for (const part of ["nope", "agents/m/x/t/y", "terminal/m/x", "files/m/%E0/f/r"]) {
			expect(parseRoute(`${sessionHash(session.ref)}|${part}`)).toEqual({ main: session, dock: null });
		}
	});
});
