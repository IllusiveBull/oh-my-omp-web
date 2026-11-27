import { describe, expect, test } from "bun:test";
import type { SlashCommandWire, SubagentWire } from "@omp-web/protocol";
import { ackedReplica } from "../src/lib/ack";
import { stripAnsi } from "../src/lib/ansi";
import { appendDraft, parseHttpUrl, previewText } from "../src/lib/attention";
import { textKeys } from "../src/lib/keys";
import { sessionLabel } from "../src/lib/session-label";
import { applySlashCommand, enterAction, filterSlashCommands, slashMenu, wantsModels } from "../src/lib/slash-menu";
import { countRunningAgents, orderAgents } from "../src/lib/subagents";
import { formatAbsolute, formatCountdown, formatRelative, formatStamp } from "../src/lib/time";

describe("sessionLabel", () => {
	const info = {
		title: "🛑 DAEMON: Fix omp-webd refusing to start",
		preview: "A different first prompt",
		createdAt: Date.UTC(2026, 10, 13, 12),
		modifiedAt: Date.UTC(2026, 10, 13, 13),
	};

	test("keeps omp's title rather than substituting the first prompt", () => {
		expect(sessionLabel(info)).toBe(info.title);
		expect(sessionLabel(info, "Renamed in omp")).toBe("Renamed in omp");
		expect(sessionLabel(info, "")).toBe(info.title);
	});

	test("an unnamed opened session uses the same first-prompt fallback as its list row", () => {
		const unnamed = { ...info, title: undefined, preview: "  First prompt\nsecond line" };
		expect(sessionLabel(unnamed)).toBe("First prompt");
		expect(sessionLabel(unnamed, "")).toBe("First prompt");
	});

	test("matches omp's untitled timestamp instead of exposing a project path or no-messages sentinel", () => {
		const unnamed = { ...info, title: " ", preview: "(no messages)" };
		const time = new Date(info.createdAt).toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		expect(sessionLabel(unnamed)).toBe(`Untitled · ${time}`);
		expect(sessionLabel(undefined)).toBe("Untitled");
	});
});

describe("stripAnsi", () => {
	test("removes colours, cursor moves, hyperlinks and titles but keeps the text", () => {
		expect(stripAnsi("\x1b[1;31mred\x1b[0m plain \x1b[2K\x1b[1Gdone")).toBe("red plain done");
		expect(stripAnsi("\x1b]8;;https://x.test\x07link\x1b]8;;\x07 and \x1b]0;title\x1b\\text")).toBe("link and text");
		expect(stripAnsi("no escapes: [31m stays")).toBe("no escapes: [31m stays");
	});
});

describe("slash menu", () => {
	const cmd = (name: string, extra: Partial<SlashCommandWire> = {}): SlashCommandWire => ({
		name,
		source: "builtin",
		...extra,
	});
	const commands = [
		cmd("model", { aliases: ["models"] }),
		cmd("compact", { aliases: ["summarize"] }),
		cmd("memory", { aliases: ["mem"] }),
		cmd("export"),
		cmd("new", { aliases: ["clear"] }),
	];
	const names = (draft: string): string[] => filterSlashCommands(commands, draft).map(c => c.name);

	test("lists everything for a bare slash and nothing for non-commands", () => {
		expect(names("/")).toEqual(["model", "compact", "memory", "export", "new"]);
		expect(names("hello")).toEqual([]);
		expect(names("")).toEqual([]);
		expect(names(" /mo")).toEqual([]);
	});

	test("closes once the command word is followed by whitespace", () => {
		expect(names("/model ")).toEqual([]);
		expect(names("/model gpt")).toEqual([]);
	});

	test("ranks name prefixes before alias prefixes before substrings, ignoring case", () => {
		const ranked = [
			cmd("reco"), // name substring
			cmd("x", { aliases: ["cobra"] }), // alias prefix
			cmd("cow"), // name prefix
			cmd("y", { aliases: ["recover"] }), // alias substring
			cmd("unrelated"),
		];
		expect(filterSlashCommands(ranked, "/CO").map(c => c.name)).toEqual(["cow", "x", "reco", "y"]);
	});

	test("matches aliases", () => {
		expect(names("/summ")).toEqual(["compact"]);
		expect(names("/clear")).toEqual(["new"]);
	});

	const effort = cmd("effort", {
		subcommands: [{ name: "low" }, { name: "high" }, { name: "xhigh" }],
	});
	const shake = cmd("shake", { subcommands: [{ name: "fast" }, { name: "focus", usage: "[focus]" }] });
	const all = [...commands, effort, shake, cmd("switch")];
	const models = ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-5-5", "openai/gpt-5"];
	const item = (draft: string, index = 0) => slashMenu(all, draft, models).items[index]!;

	test("Enter completes a partial command but runs one that was typed out in full", () => {
		expect(enterAction(all, "/com", item("/com"), false)).toBe("pick");
		expect(enterAction(all, "/summarize", item("/summarize"), false)).toBe("pick"); // alias → canonical name
		expect(enterAction(all, "/export", item("/export"), false)).toBe("send");
		expect(enterAction(all, "  /export ", item("/export"), false)).toBe("send");
	});

	test("/model opens the model hub; a model argument lists the session's models", () => {
		expect(enterAction(all, "/model", item("/model"), false)).toBe("pick");
		expect(item("/model").hub).toBe(true);
		expect(item("/models").hub).toBe(true); // alias
		expect(enterAction(all, "/switch", item("/switch"), false)).toBe("pick");
		expect(item("/switch").hub).toBeUndefined();
		expect(wantsModels(all, "/model ")).toBe(true);
		expect(wantsModels(all, "/models opus")).toBe(true); // alias
		expect(wantsModels(all, "/switch ")).toBe(true);
		expect(wantsModels(all, "/effort ")).toBe(false);
		expect(wantsModels(all, "/model a b")).toBe(false);
		expect(slashMenu(all, "/model ", null)).toEqual({ stage: "argument", items: [], loading: true });
		const menu = slashMenu(all, "/models OPUS", models);
		expect(menu.items.map(i => i.fill)).toEqual(["/models anthropic/claude-opus-5-5"]);
		expect(menu.items[0]!.submit).toBe(true);
		// Prefix matches first.
		expect(slashMenu(all, "/model a", models).items.map(i => i.label)).toEqual([
			"anthropic/claude-haiku-4-5",
			"anthropic/claude-opus-5-5",
			"openai/gpt-5",
		]);
		expect(slashMenu(all, "/model o", models).items[0]!.label).toBe("openai/gpt-5");
		expect(enterAction(all, "/model ", item("/model "), false)).toBe("pick");
	});

	test("other commands offer their subcommands; a bare command still runs on Enter", () => {
		expect(slashMenu(all, "/effort ", models).items.map(i => i.fill)).toEqual([
			"/effort low",
			"/effort high",
			"/effort xhigh",
		]);
		expect(slashMenu(all, "/effort h", models).items.map(i => i.label)).toEqual(["high", "xhigh"]);
		// A subcommand that takes more input leaves a space after it, which closes the menu.
		expect(item("/shake fo").fill).toBe("/shake focus ");
		expect(slashMenu(all, "/shake focus ", models).items).toEqual([]);
		expect(enterAction(all, "/shake ", item("/shake "), false)).toBe("send");
		expect(enterAction(all, "/shake ", item("/shake "), true)).toBe("pick");
		expect(enterAction(all, "/effort h", item("/effort h"), false)).toBe("pick");
		expect(enterAction(all, "/effort high", item("/effort high"), false)).toBe("send");
		expect(slashMenu(all, "/export ", models).items).toEqual([]);
		expect(slashMenu(all, "/unknown ", models).items).toEqual([]);
	});

	test("picking inserts the canonical name and a trailing space", () => {
		expect(applySlashCommand(cmd("compact", { aliases: ["summarize"] }))).toBe("/compact ");
	});
});

describe("attention helpers", () => {
	test("only http(s) urls parse", () => {
		expect(parseHttpUrl("https://example.com/a?b=1")?.host).toBe("example.com");
		expect(parseHttpUrl("http://localhost:3000/")?.host).toBe("localhost:3000");
		expect(parseHttpUrl("javascript:alert(1)")).toBeNull();
		expect(parseHttpUrl("file:///etc/passwd")).toBeNull();
		expect(parseHttpUrl("not a url")).toBeNull();
	});

	test("appendDraft never replaces a non-empty draft", () => {
		expect(appendDraft("", "suggested")).toBe("suggested");
		expect(appendDraft("typed", "suggested")).toBe("typed\nsuggested");
	});

	test("previewText flattens whitespace and truncates", () => {
		expect(previewText("a\n\n  b\tc")).toBe("a b c");
		expect(previewText("x".repeat(10), 4)).toBe("xxxx…");
	});
});

describe("textKeys", () => {
	test("repeated texts get distinct keys, stable by position among equals", () => {
		const keys = textKeys(["a", "b", "a", "a"]);
		expect(new Set(keys).size).toBe(4);
		expect(textKeys(["a", "b", "a"]).slice(0, 2)).toEqual(keys.slice(0, 2));
	});
});

describe("sub-agents", () => {
	const wire = (id: string, status: "running" | "idle", createdAt: number, lastActivity: number): SubagentWire => ({
		agent: { id, displayName: id, kind: "sub", status, hasSessionFile: true, createdAt, lastActivity },
	});

	test("orders running agents first, in spawn order, whatever their last activity", () => {
		const subagents = new Map([
			["done", wire("done", "idle", 1, 50)],
			["late", wire("late", "running", 3, 10)],
			["early", wire("early", "running", 2, 99)],
		]);
		expect(orderAgents(subagents).map(s => s.agent.id)).toEqual(["early", "late", "done"]);
		// A progress frame of "late" makes it the most recent one: nothing moves.
		subagents.set("late", wire("late", "running", 3, 200));
		expect(orderAgents(subagents).map(s => s.agent.id)).toEqual(["early", "late", "done"]);
	});

	test("counts running agents", () => {
		const subagents = new Map([
			["a", wire("a", "running", 1, 1)],
			["b", wire("b", "idle", 1, 1)],
			["c", wire("c", "running", 1, 1)],
		]);
		expect(countRunningAgents(subagents)).toBe(2);
		expect(countRunningAgents(new Map())).toBe(0);
	});
});

describe("ackedReplica", () => {
	test("reads the copy a gateway-served subscribe ack describes", () => {
		expect(ackedReplica({ mode: "snapshot", replica: { state: "partial", asOf: 1, syncedAt: 2 } })).toEqual({
			state: "partial",
			asOf: 1,
			syncedAt: 2,
		});
	});

	test("an ack from the machine itself, or a malformed one, has none", () => {
		for (const data of [undefined, null, "x", {}, { mode: "replay" }, { replica: null }, { replica: {} }]) {
			expect(ackedReplica(data)).toBeNull();
		}
		expect(ackedReplica({ replica: { state: "stale", asOf: 1, syncedAt: 2 } })).toBeNull();
		expect(ackedReplica({ replica: { state: "complete", asOf: "1", syncedAt: 2 } })).toBeNull();
		expect(ackedReplica({ replica: { state: "complete", asOf: 1 } })).toBeNull();
	});
});

describe("time formatting", () => {
	const now = Date.UTC(2026, 10, 12, 12, 0, 0);
	const MINUTE = 60_000;
	const HOUR = 60 * MINUTE;
	const DAY = 24 * HOUR;

	test("relative time picks the coarsest sensible unit", () => {
		expect(formatRelative(now - 10_000, now, "en")).toBe("now");
		expect(formatRelative(now - 5 * MINUTE, now, "en")).toBe("5 minutes ago");
		expect(formatRelative(now - 3 * HOUR, now, "en")).toBe("3 hours ago");
		expect(formatRelative(now - DAY, now, "en")).toBe("yesterday");
		expect(formatRelative(now - 10 * DAY, now, "en")).toBe("10 days ago");
		expect(formatRelative(now - 60 * DAY, now, "en")).toBe("2 months ago");
		expect(formatRelative(now - 800 * DAY, now, "en")).toBe("2 years ago");
		expect(formatRelative(now + 2 * HOUR, now, "en")).toBe("in 2 hours");
	});

	test("countdown keeps the hours under a day count and the minutes under an hour count", () => {
		expect(formatCountdown(now + 30_000, now)).toBe("now");
		expect(formatCountdown(now + 4 * DAY + 7 * HOUR + 59 * MINUTE, now)).toBe("in 4d 7h");
		expect(formatCountdown(now + 2 * DAY, now)).toBe("in 2d");
		expect(formatCountdown(now + 3 * HOUR + 12 * MINUTE, now)).toBe("in 3h 12m");
		expect(formatCountdown(now - 45 * MINUTE, now)).toBe("45m ago");
	});

	test("a list stamp is the time today, the day this year, and the full date before", () => {
		const local = new Date(2026, 10, 12, 15, 4).getTime();
		expect(formatStamp(new Date(2026, 10, 12, 9, 30).getTime(), local, "en-US")).toBe("09:30");
		expect(formatStamp(new Date(2026, 10, 11, 23, 59).getTime(), local, "en-US")).toBe("Nov 11");
		expect(formatStamp(new Date(2025, 0, 3).getTime(), local, "en-US")).toBe("Jan 3, 2025");
	});

	test("absolute time carries the date and the time of day", () => {
		const text = formatAbsolute(Date.UTC(2026, 10, 12, 15, 4), "en");
		expect(text).toContain("2026");
		expect(text).toMatch(/\d{2}:04/);
		expect(text).not.toMatch(/AM|PM/);
	});
});
