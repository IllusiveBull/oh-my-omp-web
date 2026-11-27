import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ModelRolesWire, SessionStatus } from "@omp-web/protocol";
import { parseContextReport } from "../src/lib/context-overview";
import { activeRole, splitSelector, StatusLine } from "../src/components/status-line";
import { type FakeDom, installFakeDom } from "./fake-dom";
import { machineSummary } from "./fixtures";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const ROLES: ModelRolesWire = {
	roles: [
		{ id: "default", name: "Default", selector: "bedrock/opus:medium" },
		{ id: "smol", name: "Fast", selector: "bedrock/sonnet" },
		{ id: "slow", name: "Thinking", selector: "bedrock/opus:high" },
		{ id: "plan", name: "Architect", selector: "bedrock/opus:high" },
	],
	cycle: ["smol", "default", "slow"],
};

describe("status line roles", () => {
	test("a selector's thinking suffix is split off, a model id's own colon is not", () => {
		expect(splitSelector("bedrock/opus:high", LEVELS)).toEqual({ model: "bedrock/opus", level: "high" });
		expect(splitSelector("bedrock/claude-3-v1:0", LEVELS)).toEqual({ model: "bedrock/claude-3-v1:0" });
		expect(splitSelector("a/b:auto", LEVELS)).toEqual({ model: "a/b", level: "auto" });
	});

	test("the active cycle role is the one with the session's model, and its thinking level among equals", () => {
		expect(activeRole(ROLES, "bedrock/opus", "high", LEVELS)).toBe("slow");
		expect(activeRole(ROLES, "bedrock/opus", "medium", LEVELS)).toBe("default");
		expect(activeRole(ROLES, "bedrock/opus", "low", LEVELS)).toBe("default"); // first by model
		expect(activeRole(ROLES, "bedrock/sonnet", "off", LEVELS)).toBe("smol");
		expect(activeRole(ROLES, "other/x", "high", LEVELS)).toBeUndefined();
	});
});

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

const STATUS: SessionStatus = {
	sessionId: "s",
	cwd: "/Users/me/develop/omp-web",
	model: "bedrock/opus",
	modelName: "Opus 5.5",
	thinkingLevel: "high",
	isStreaming: false,
	isCompacting: false,
	queue: { steering: [], followUp: [], liveSteered: 0 },
	todos: [],
	contextUsage: { label: "2.9%/1M", level: "normal" },
	autoCompaction: true,
	activeMs: 125_000,
	cost: 0,
	git: { branch: "main", staged: 0, unstaged: 32, untracked: 6 },
};

describe("StatusLine", () => {
	test("shows omp's segments, and the role menu switches the session to a role", async () => {
		const used: string[] = [];
		const view = await dom.mount(
			<StatusLine
				status={STATUS}
				machineInfo={machineSummary({ platform: "darwin", home: "/Users/me" })}
				roles={ROLES}
				thinkingLevels={LEVELS}
				onUseRole={r => used.push(r)}
				onOpenModels={() => {}}
			/>,
		);
		const text = view.query(".status-line")!.textContent;
		for (const part of ["Opus 5.5 · high", "~/develop/omp-web", "main *32 ?6", "2.9%/1M", "2m5s"]) {
			expect(text).toContain(part);
		}
		expect(text).not.toContain("$"); // no spend yet
		expect(text.startsWith("2m5s")).toBe(true); // time worked comes first
		expect(view.query(".status-context [aria-label='auto-compaction on']")).not.toBeNull();
		expect(view.query("button[title='Switch model role']")?.textContent).toBe("slow");
		expect(view.query(".status-role")).toBeNull(); // closed until clicked
		// omp's colours (mixed toward the foreground for contrast): the thinking level in its own, git counts in theirs
		const colored = view.queryAll(".status-line span").map(e => [e.textContent, e.style.color]);
		expect(colored).toContainEqual(["high", expect.stringContaining("var(--omp-thinkingHigh)")]);
		const sector = view.query(".status-sector") as HTMLElement | null;
		expect(sector?.style.color).toContain("var(--omp-thinkingHigh)"); // the sector fills with the level
		expect(colored).toContainEqual([" *32", expect.stringContaining("var(--omp-statusLineDirty)")]);
		await view.click("button[title='Switch model role']");
		expect(view.queryAll(".status-role").map(b => b.textContent)).toEqual([
			"smol bedrock/sonnet",
			"default bedrock/opus:medium",
			"slow bedrock/opus:high",
		]);
		expect(view.query(".status-role[aria-selected=true]")?.textContent).toBe("slow bedrock/opus:high");
		await view.click(".status-role");
		expect(used).toEqual(["smol"]);
		expect(view.query(".status-role")).toBeNull(); // picking closes the menu
		await view.unmount();
	});

	test("the context segment opens the /context report", async () => {
		let opened = 0;
		const view = await dom.mount(
			<StatusLine status={STATUS} roles={null} thinkingLevels={LEVELS} onOpenContext={() => opened++} />,
		);
		await view.click("button.status-context");
		expect(opened).toBe(1);
		await view.unmount();
	});

	test("spend reads like omp's: own spend, sub-agents' in parentheses, tariff period, premium requests starred", async () => {
		const spendOf = async (spend: Partial<SessionStatus>) => {
			const view = await dom.mount(
				<StatusLine status={{ ...STATUS, ...spend }} roles={null} thinkingLevels={LEVELS} />,
			);
			const text = view.query(".status-cost")?.textContent ?? null;
			await view.unmount();
			return text;
		};
		expect(await spendOf({ cost: 1.254, subagentCost: 0.4, premiumRequests: 3, pricingPeriod: "peak" })).toBe(
			"$1.25 (+0.40) ↑ ★ 3",
		);
		expect(await spendOf({ cost: 0, pricingPeriod: "off-peak" })).toBe("$0.00 ↓"); // the tariff before any spend
		expect(await spendOf({ cost: 0, subagentCost: 0.4 })).toBe("$0.00 (+0.40)");
		expect(await spendOf({ cost: 0, premiumRequests: 2 })).toBe("★ 2");
		expect(await spendOf({ cost: 0 })).toBeNull();
	});

	test("read-only: no role menu, the model is not a button", async () => {
		const view = await dom.mount(<StatusLine status={STATUS} roles={null} thinkingLevels={LEVELS} />);
		expect(view.query("button[title='Switch model role']")).toBeNull();
		expect(view.query("button.status-model")).toBeNull();
		expect(view.query("button.status-context")).toBeNull();
		await view.unmount();
	});

	test("the sector shows the thinking level: empty when off, half for auto or no level", async () => {
		for (const [thinkingLevel, fill] of [
			["off", "0"],
			["medium", "0.5"],
			["high", "0.75"],
			["xhigh", "1"],
			["auto", "0.5"],
			[undefined, "0.5"],
		] as const) {
			const view = await dom.mount(
				<StatusLine status={{ ...STATUS, thinkingLevel }} roles={null} thinkingLevels={LEVELS} />,
			);
			expect(view.query(".status-sector")?.getAttribute("data-fill")).toBe(fill);
			await view.unmount();
		}
	});
});

describe("parseContextReport", () => {
	test("reads omp's /context text into category rows and keeps the rest as notes", () => {
		const text = [
			"Context window: 200000 tokens (12% used)",
			"  System prompt    [\x1b[2m██\x1b[0m░░░░░░░░░░░░░░░░░░░░░░]   7%  14250 tokens",
			"  Messages         [█░░░░░░░░░░░░░░░░░░░░░░░]   4%  9800 tokens",
			"  Free             [█████████████████████░░░]  88%  175950 tokens",
			"Snapcompact: inactive (model has no image input)",
		].join("\n");
		expect(parseContextReport(text)).toEqual({
			title: "Context window: 200000 tokens (12% used)",
			rows: [
				{ label: "System prompt", percent: 7, tokens: 14250 },
				{ label: "Messages", percent: 4, tokens: 9800 },
				{ label: "Free", percent: 88, tokens: 175950 },
			],
			notes: ["Snapcompact: inactive (model has no image input)"],
		});
	});
});
