import { describe, expect, test } from "bun:test";
import type { AccountWire, UsageReportWire } from "@omp-web/protocol";
import {
	accountsAttention,
	barWidth,
	canSignInOnWeb,
	describeBroker,
	describeMachineBroker,
	percent,
	unmatchedReports,
	usageForAccount,
} from "../src/lib/accounts";
import { brokerStatus, machineSummary } from "./fixtures";

const account = (overrides: Partial<AccountWire> = {}): AccountWire => ({
	provider: "anthropic",
	providerName: "Anthropic",
	credentialId: 1,
	label: "me@example.invalid",
	detail: "account acct-1 · oauth #1",
	type: "oauth",
	active: true,
	...overrides,
});
const report = (overrides: Partial<UsageReportWire> = {}): UsageReportWire => ({
	provider: "anthropic",
	fetchedAt: 1,
	identity: "me@example.invalid",
	limits: [],
	...overrides,
});

describe("describeBroker", () => {
	test("each phase says what it is; a restarting broker says why and when it tries again", () => {
		expect(describeBroker(brokerStatus({ phase: "disabled" }), 0)).toMatchObject({
			tone: "off",
			headline: "Not enabled",
		});
		expect(describeBroker(brokerStatus(), 0)).toMatchObject({ tone: "ok", headline: "Running" });
		expect(describeBroker(brokerStatus({ healthy: false }), 0)).toMatchObject({
			tone: "bad",
			headline: "Running but not answering",
		});
		const down = describeBroker(
			brokerStatus({
				phase: "restarting",
				healthy: false,
				nextRetryAt: 12_000,
				lastError: { message: "killed by SIGKILL", at: 1 },
			}),
			10_000,
		);
		expect(down).toMatchObject({ tone: "bad", headline: "Down — restarting" });
		expect(down.detail).toBe("killed by SIGKILL; next attempt in 2s");
		expect(describeBroker(brokerStatus({ phase: "starting", healthy: false }), 0).tone).toBe("warn");
	});
});

describe("describeMachineBroker", () => {
	const status = (state: "ok" | "unreachable" | "unauthorized" | "withheld" | "unconfigured", message?: string) => ({
		source: "gateway" as const,
		state,
		url: "http://100.64.0.2:8765",
		message,
		checkedAt: 1,
		lastOkAt: null,
	});

	test("nothing to say when the machine has no broker or is fine", () => {
		expect(describeMachineBroker(undefined, "laptop")).toBeNull();
		expect(describeMachineBroker(status("unconfigured"), "laptop")).toBeNull();
		expect(describeMachineBroker(status("ok"), "laptop")?.tone).toBe("ok");
	});

	test("an unreachable broker is explained with what still works and what will not (the one-hour cache), not as an obscure failure", () => {
		const text = describeMachineBroker(status("unreachable", "connection refused"), "laptop")!;
		expect(text.tone).toBe("bad");
		expect(text.text).toContain("laptop cannot reach the auth broker at http://100.64.0.2:8765: connection refused");
		expect(text.text).toContain("up to an hour");
		expect(text.text).toContain("new sessions may fail");
	});

	test("a rejected token and a withheld one are told apart", () => {
		expect(describeMachineBroker(status("unauthorized", "stale"), "laptop")?.text).toContain(
			"token for the auth broker is not accepted",
		);
		expect(describeMachineBroker(status("withheld", "plain ws://"), "laptop")).toMatchObject({ tone: "warn" });
	});
});

describe("accountsAttention (the dot on the sidebar button)", () => {
	const online = (state: "ok" | "unreachable" | "withheld" | "unauthorized") =>
		machineSummary({ id: state, broker: { source: "gateway", state, checkedAt: 1, lastOkAt: 1 } });
	test("off without a broker; ok when everything answers; bad when the broker or any online machine's view of it is bad", () => {
		expect(accountsAttention(null, [])).toBe("off");
		expect(accountsAttention(brokerStatus({ phase: "disabled" }), [])).toBe("off");
		expect(accountsAttention(brokerStatus(), [online("ok")])).toBe("ok");
		expect(accountsAttention(brokerStatus({ phase: "restarting", healthy: false }), [])).toBe("bad");
		expect(accountsAttention(brokerStatus({ healthy: false }), [])).toBe("bad");
		expect(accountsAttention(brokerStatus(), [online("ok"), online("unreachable")])).toBe("bad");
		expect(accountsAttention(brokerStatus(), [online("unauthorized")])).toBe("bad");
		expect(accountsAttention(brokerStatus(), [online("withheld")])).toBe("warn");
		// an offline machine's old status does not count
		expect(
			accountsAttention(brokerStatus(), [
				machineSummary({
					online: false,
					broker: { source: "gateway", state: "unreachable", checkedAt: 1, lastOkAt: 1 },
				}),
			]),
		).toBe("ok");
	});
});

describe("usage matching", () => {
	test("a report belongs to the account whose label or detail carries the report's identity, for the same provider", () => {
		const mine = report();
		const other = report({ identity: "other@example.invalid" });
		const codex = report({ provider: "openai-codex" });
		const me = account();
		expect(usageForAccount(me, [other, codex, mine], [me])).toBe(mine);
		const otherAccount = account({ label: "OTHER@example.invalid" });
		expect(usageForAccount(otherAccount, [other], [otherAccount])).toBe(other);
		const byId = account({ label: "Account acct-9", detail: "account acct-9 · oauth #2" });
		expect(usageForAccount(byId, [report({ identity: "acct-9" })], [byId])).toBeTruthy();
		expect(usageForAccount(me, [codex], [me])).toBeNull();
	});

	test("a sole provider account receives usage even when its stored credential has no provider identity", () => {
		const copilot = account({ provider: "github-copilot", label: "OAuth credential #4", detail: "oauth #4" });
		const usage = report({ provider: "github-copilot", identity: "donuts-fuxiangyu" });
		expect(usageForAccount(copilot, [usage], [copilot, account()])).toBe(usage);
		expect(unmatchedReports([copilot, account()], [usage])).toEqual([]);
		const anonymous = report({ provider: "github-copilot", identity: undefined });
		expect(usageForAccount(copilot, [anonymous], [copilot])).toBe(anonymous);
	});

	test("ambiguous accounts or reports stay unassigned, including shared account ids", () => {
		const a = account();
		const b = account({ credentialId: 2, label: "other@example.invalid" });
		const shared = report({ identity: "acct-1" });
		expect(usageForAccount(a, [shared], [a, b])).toBeNull();
		expect(usageForAccount(b, [shared], [a, b])).toBeNull();
		expect(unmatchedReports([a, b], [shared])).toEqual([shared]);
		const unknown = report({ identity: "unknown" });
		expect(usageForAccount(a, [unknown], [a, b])).toBeNull();
		expect(usageForAccount(a, [unknown, report({ identity: undefined })], [a])).toBeNull();
		const mine = report();
		expect(usageForAccount(a, [mine, unknown], [a, b])).toBe(mine);
	});

	test("reports no account claims stay visible in the usage section", () => {
		const mine = report();
		const stray = report({ identity: "nobody@example.invalid" });
		expect(unmatchedReports([account()], [mine, stray])).toEqual([stray]);
		expect(unmatchedReports([], [mine])).toEqual([mine]);
	});
});

describe("small helpers", () => {
	test("percent and bar width clamp sensibly (overage shows as a full bar and a number above 100)", () => {
		expect(percent(0.4213)).toBe("42%");
		expect(percent(1.25)).toBe("125%");
		expect(barWidth(0.5)).toBe(50);
		expect(barWidth(1.25)).toBe(100);
		expect(barWidth(-1)).toBe(0);
		expect(barWidth(undefined)).toBe(0);
	});

	test("the web offers a sign-in button for every kind but pasted API keys (and unavailable providers)", () => {
		const provider = (kind: "oauth" | "device" | "api-key" | "custom" | "unknown", available = true) => ({
			id: "x",
			name: "X",
			available,
			authenticated: false,
			kind,
		});
		for (const kind of ["oauth", "device", "custom", "unknown"] as const)
			expect(canSignInOnWeb(provider(kind))).toBe(true);
		expect(canSignInOnWeb(provider("api-key"))).toBe(false);
		expect(canSignInOnWeb(provider("oauth", false))).toBe(false);
	});
});
