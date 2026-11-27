import { describe, expect, test } from "bun:test";
import type { Selection } from "../src/lib/environment";
import { parseSessionHash, parseTerminalHash, terminalHash } from "../src/lib/route";
import {
	disabledMessage,
	exitText,
	neighborTab,
	restartedMessage,
	tabsOf,
	tabTitle,
	terminalTarget,
	terminalViewState,
	themeFromTokens,
} from "../src/lib/terminal";
import {
	applyCtrl,
	countLines,
	ctrlChar,
	INPUT_FRAME_CHARS,
	KEY_BAR,
	keySequence,
	pasteDecision,
	splitInput,
} from "../src/lib/terminal-input";
import { machineSummary, project } from "./fixtures";
import { terminalInfo } from "./terminal-rig";

describe("terminal route", () => {
	test("formats and parses #/m/<machine>/t/<id>, with encoding", () => {
		expect(terminalHash({ machine: "m1", id: "t-1" })).toBe("#/m/m1/t/t-1");
		expect(parseTerminalHash("#/m/m1/t/t-1")).toEqual({ machine: "m1", id: "t-1" });
		const odd = { machine: "my box/1", id: "a b#c" };
		expect(parseTerminalHash(terminalHash(odd))).toEqual(odd);
	});

	test("is not a session, accounts or malformed hash", () => {
		expect(parseTerminalHash("#/m/m1/s/x")).toBeNull();
		expect(parseSessionHash("#/m/m1/t/x")).toBeNull();
		expect(parseTerminalHash("#/accounts")).toBeNull();
		expect(parseTerminalHash("#/m/m1/t/")).toBeNull();
		expect(parseTerminalHash("#/m/m1/t/a/b")).toBeNull();
		expect(parseTerminalHash("#/m/%E0%A4%A/t/x")).toBeNull();
		expect(parseTerminalHash("")).toBeNull();
	});
});

describe("key bar", () => {
	test("has exactly the keys of the contract, in order", () => {
		expect(KEY_BAR.map(k => k.id)).toEqual([
			"esc",
			"tab",
			"ctrl",
			"up",
			"down",
			"left",
			"right",
			"pipe",
			"tilde",
			"slash",
			"dash",
			"paste",
		]);
	});

	test("arrows follow the application cursor mode", () => {
		expect(keySequence("up", false)).toBe("\x1b[A");
		expect(keySequence("down", false)).toBe("\x1b[B");
		expect(keySequence("right", false)).toBe("\x1b[C");
		expect(keySequence("left", false)).toBe("\x1b[D");
		expect(keySequence("up", true)).toBe("\x1bOA");
		expect(keySequence("left", true)).toBe("\x1bOD");
	});

	test("literal keys and the buttons that are not keys", () => {
		expect(keySequence("esc", false)).toBe("\x1b");
		expect(keySequence("tab", true)).toBe("\t");
		expect(keySequence("pipe", false)).toBe("|");
		expect(keySequence("tilde", false)).toBe("~");
		expect(keySequence("slash", false)).toBe("/");
		expect(keySequence("dash", false)).toBe("-");
		expect(keySequence("ctrl", false)).toBeNull();
		expect(keySequence("paste", false)).toBeNull();
	});
});

describe("sticky Ctrl", () => {
	test("maps a-z, brackets, @ and space to control characters", () => {
		expect(ctrlChar("a")).toBe("\x01");
		expect(ctrlChar("c")).toBe("\x03");
		expect(ctrlChar("Z")).toBe("\x1a");
		expect(ctrlChar("[")).toBe("\x1b");
		expect(ctrlChar("\\")).toBe("\x1c");
		expect(ctrlChar("]")).toBe("\x1d");
		expect(ctrlChar("@")).toBe("\x00");
		expect(ctrlChar(" ")).toBe("\x00");
		expect(ctrlChar("1")).toBeNull();
		expect(ctrlChar("ab")).toBeNull();
	});

	test("applies to the next single character only, then disarms", () => {
		expect(applyCtrl("c", true)).toEqual({ data: "\x03", armed: false });
		expect(applyCtrl("c", false)).toEqual({ data: "c", armed: false });
		expect(applyCtrl("1", true)).toEqual({ data: "1", armed: false });
	});

	test("escape sequences and pastes pass through and keep it armed", () => {
		expect(applyCtrl("\x1b[A", true)).toEqual({ data: "\x1b[A", armed: true });
		expect(applyCtrl("hello", true)).toEqual({ data: "hello", armed: true });
	});
});

describe("paste", () => {
	test("counts lines; a trailing line break does not start another", () => {
		expect(countLines("one")).toBe(1);
		expect(countLines("one\ntwo")).toBe(2);
		expect(countLines("one\r\ntwo\r\nthree\r\n")).toBe(3);
		expect(countLines("a\rb")).toBe(2);
	});

	test("bracketed paste is sent as is; otherwise a line break asks first", () => {
		expect(pasteDecision("a\nb", true)).toEqual({ kind: "send" });
		expect(pasteDecision("single line", false)).toEqual({ kind: "send" });
		expect(pasteDecision("a\nb\nc", false)).toEqual({ kind: "confirm", lines: 3 });
		expect(pasteDecision("ls\n", false)).toEqual({ kind: "confirm", lines: 1 });
		expect(pasteDecision("a\rb", false)).toEqual({ kind: "confirm", lines: 2 });
	});

	test("splits into frames of at most 16 KiB without splitting a surrogate pair", () => {
		expect(splitInput("")).toEqual([]);
		expect(splitInput("abc")).toEqual(["abc"]);
		const parts = splitInput("x".repeat(40 * 1024));
		expect(parts.map(p => p.length)).toEqual([INPUT_FRAME_CHARS, INPUT_FRAME_CHARS, 8 * 1024]);
		expect(parts.join("")).toBe("x".repeat(40 * 1024));

		const emoji = "😀".repeat(20); // 40 code units
		const split = splitInput(emoji, 7);
		expect(split.join("")).toBe(emoji);
		for (const part of split) {
			expect(part.length).toBeLessThanOrEqual(7);
			expect(part.length % 2).toBe(0); // never half an emoji
			expect(part.codePointAt(0)).toBe(0x1f600);
		}
	});
});

describe("terminal view state and tabs", () => {
	const facts = { disabled: false, online: true, lost: false, exited: false };

	test("disabled beats offline beats lost beats exited", () => {
		expect(terminalViewState(facts)).toBe("running");
		expect(terminalViewState({ ...facts, exited: true })).toBe("exited");
		expect(terminalViewState({ ...facts, exited: true, lost: true })).toBe("lost");
		expect(terminalViewState({ ...facts, lost: true, online: false })).toBe("offline");
		expect(terminalViewState({ ...facts, online: false, disabled: true })).toBe("disabled");
	});

	test("a tab is titled by what the shell set, else the default name", () => {
		expect(tabTitle({ title: "vim notes.md", name: "zsh" })).toBe("vim notes.md");
		expect(tabTitle({ title: null, name: "zsh" })).toBe("zsh");
		expect(tabTitle({ title: "  ", name: "zsh" })).toBe("zsh");
	});

	test("tabs follow the list; a lost terminal stays as a lost tab", () => {
		const list = [terminalInfo("a", { title: "build" }), terminalInfo("b", { state: "exited" })];
		const lost = terminalInfo("c");
		const tabs = tabsOf(list, [lost], { disabled: false, online: true });
		expect(tabs.map(t => [t.id, t.title, t.state])).toEqual([
			["a", "build", "running"],
			["b", "zsh", "exited"],
			["c", "zsh", "lost"],
		]);
		// A lost terminal the list has again (never mind the stale copy) is not shown twice.
		expect(tabsOf(list, [terminalInfo("a")], { disabled: false, online: true })).toHaveLength(2);
		expect(tabsOf(list, [], { disabled: false, online: false }).every(t => t.state === "offline")).toBe(true);
		expect(tabsOf(list, [], { disabled: true, online: true }).every(t => t.state === "disabled")).toBe(true);
		const broker = tabsOf([terminalInfo("x", { purpose: "broker-login" })], [], { disabled: false, online: true });
		expect(broker[0]!.purpose).toBe("broker-login");
	});

	test("after a tab goes away, the next one, else the previous, else none", () => {
		const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];
		expect(neighborTab(tabs, "a")).toBe("b");
		expect(neighborTab(tabs, "b")).toBe("c");
		expect(neighborTab(tabs, "c")).toBe("b");
		expect(neighborTab([{ id: "a" }], "a")).toBeNull();
		expect(neighborTab(tabs, "zz")).toBe("a");
		expect(neighborTab([], "zz")).toBeNull();
	});
});

describe("terminal messages", () => {
	test("say plainly how to enable terminals and what a restart did", () => {
		const text = disabledMessage("Home");
		expect(text).toContain("Terminals are disabled on Home.");
		expect(text).toContain("--terminal");
		expect(text).toContain('"terminal": {"enabled": true}');
		expect(restartedMessage("Home")).toContain("omp-webd on Home restarted");
		expect(restartedMessage("Home")).toContain("The last output is kept here.");
	});

	test("exit text names the code or the kill", () => {
		expect(exitText({ code: 0, killed: false, at: 1_700_000_000_000 })).toStartWith("Exited with code 0 at ");
		expect(exitText({ code: 137, killed: false, at: 1_700_000_000_000 })).toContain("code 137");
		expect(exitText({ code: null, killed: true, at: 1_700_000_000_000 })).toStartWith("Killed at ");
		expect(exitText({ code: null, killed: false, at: 1_700_000_000_000 })).toStartWith("Exited at ");
		expect(exitText(null)).toBe("Exited");
	});
});

describe("new terminal target", () => {
	const proj = project("/work/app");
	const home = machineSummary({ id: "home", name: "Home", projects: [proj] });
	const selection = (patch: Partial<Selection> = {}): Selection => ({
		machine: "home",
		project: "/work/app",
		worktree: "/work/app",
		...patch,
	});

	test("opens in the selected worktree, like a new session", () => {
		expect(terminalTarget(home, selection())).toEqual({ ok: true, cwd: "/work/app" });
	});

	test("says why it cannot", () => {
		expect(terminalTarget(undefined, selection())).toMatchObject({ ok: false });
		expect(terminalTarget(home, selection({ worktree: "" }))).toEqual({ ok: false, reason: "Pick a worktree." });
		expect(terminalTarget(home, selection({ project: "" }))).toMatchObject({ ok: false });
		expect(terminalTarget({ ...home, online: false }, selection())).toEqual({
			ok: false,
			reason: "Home is offline.",
		});
		const elsewhere = terminalTarget(home, selection({ machine: "other" }));
		expect(elsewhere.ok).toBe(false);
		expect(!elsewhere.ok && elsewhere.reason).toContain("Home");
	});
});

describe("theme", () => {
	test("is built from the tokens and the palette, leaving unset colors out", () => {
		const values: Record<string, string> = {
			"--bg-inset": " #060607 ",
			"--fg": "#ededef",
			"--accent": "#f068c8",
			"--selected": "rgba(255, 255, 255, 0.075)",
			"--term-ansi-1": "#ff6166",
			"--term-ansi-9": "#ff8084",
			"--term-ansi-15": "#fff",
		};
		const theme = themeFromTokens(name => values[name] ?? "");
		expect(theme).toEqual({
			background: "#060607",
			foreground: "#ededef",
			cursor: "#f068c8",
			cursorAccent: "#060607",
			selectionBackground: "rgba(255, 255, 255, 0.075)",
			red: "#ff6166",
			brightRed: "#ff8084",
			brightWhite: "#fff",
		});
	});

	test("maps all sixteen palette slots", () => {
		const theme = themeFromTokens(name => (name.startsWith("--term-ansi-") ? name.slice(12) : ""));
		const names = [
			"black",
			"red",
			"green",
			"yellow",
			"blue",
			"magenta",
			"cyan",
			"white",
			"brightBlack",
			"brightRed",
			"brightGreen",
			"brightYellow",
			"brightBlue",
			"brightMagenta",
			"brightCyan",
			"brightWhite",
		];
		names.forEach((n, i) => {
			expect(theme[n]).toBe(String(i));
		});
	});
});
