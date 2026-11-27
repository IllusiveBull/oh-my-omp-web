import { describe, expect, test } from "bun:test";
import type { UsageResponse } from "@oh-my-pi/pi-ai/auth-broker";
import { parseUsageResponse } from "../src/broker-usage";

// Typed against upstream's own response type: if omp changes `UsageResponse` (or the report/limit types inside it) so that
// this literal no longer compiles, `bun run check` fails here, which is the point.
const upstream: UsageResponse = {
	generatedAt: 1_700_000_000_000,
	reports: [
		{
			provider: "anthropic",
			fetchedAt: 1_699_999_990_000,
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true, accountId: "acct-1" },
					window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 1_700_003_600_000 },
					amount: { used: 42, limit: 100, unit: "percent", usedFraction: 0.42 },
					status: "ok",
				},
				{
					id: "anthropic:7d:opus",
					label: "Claude 7 Day (Opus)",
					scope: { provider: "anthropic", windowId: "7d", modelId: "claude-opus", tier: "max" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 90, limit: 100, unit: "requests" },
					status: "warning",
					notes: ["Resets weekly"],
				},
				{
					id: "anthropic:credits",
					label: "Extra usage",
					scope: { provider: "anthropic" },
					amount: { remaining: 3, limit: 20, remainingFraction: 0.15, unit: "usd" },
					status: "exhausted",
				},
			],
			resetCredits: {
				availableCount: 2,
				redeemableCount: 1,
				credits: [
					{ id: "kept-private", expiresAt: "2099-12-10T00:00:00Z", remainingCount: 1 },
					{ expiresAt: "2099-01-01T00:00:00Z", status: "redeemed" },
				],
			},
			notes: ["OMP-observed spend only"],
			metadata: { email: "user1@example.invalid", accountId: "acct-1", orgId: "org-1" },
		},
		{
			provider: "openai-codex",
			fetchedAt: 1_699_999_000_000,
			limits: [
				{
					id: "codex:weekly",
					label: "Weekly",
					scope: { provider: "openai-codex", accountId: "only-this-one" },
					amount: { unit: "percent", used: 10 },
				},
			],
		},
	],
};

describe("parseUsageResponse", () => {
	test("maps upstream's UsageResponse to what the page shows: windows, used fractions by upstream's own rule, identity, notes", () => {
		const parsed = parseUsageResponse(JSON.parse(JSON.stringify(upstream)));
		expect(parsed.generatedAt).toBe(1_700_000_000_000);
		expect(parsed.skipped).toBe(0);
		expect(parsed.reports).toHaveLength(2);
		const [claude, codex] = parsed.reports;
		expect(claude).toMatchObject({
			provider: "anthropic",
			fetchedAt: 1_699_999_990_000,
			identity: "user1@example.invalid",
			notes: ["OMP-observed spend only"],
			orgName: "org-1",
			resetCredits: {
				availableCount: 2,
				redeemableCount: 1,
				credits: [{ expiresAt: "2099-12-10T00:00:00Z" }],
			},
		});
		expect(claude!.limits[0]).toEqual({
			id: "anthropic:5h",
			label: "Claude 5 Hour",
			windowLabel: "5 Hour",
			windowId: "5h",
			durationMs: 18_000_000,
			resetsAt: 1_700_003_600_000,
			usedFraction: 0.42,
			status: "ok",
			used: 42,
			limit: 100,
			unit: "percent",
		});
		// used/limit when no explicit fraction; model and tier from the scope; notes per limit
		expect(claude!.limits[1]).toMatchObject({
			usedFraction: 0.9,
			status: "warning",
			modelId: "claude-opus",
			tier: "max",
			notes: ["Resets weekly"],
			unit: "requests",
		});
		// inverted remaining fraction when nothing else is known
		expect(claude!.limits[2]).toMatchObject({ usedFraction: 0.85, status: "exhausted", unit: "usd" });
		// percent unit with only `used`: used / 100; identity from the single account id in the limits' scopes
		expect(codex).toMatchObject({ provider: "openai-codex", identity: "only-this-one" });
		expect(codex!.limits[0]).toMatchObject({ usedFraction: 0.1 });
	});

	test("an empty report list is a valid answer (a broker whose providers have no usage endpoint, or only fake credentials)", () => {
		expect(parseUsageResponse({ generatedAt: 5, reports: [] })).toEqual({ generatedAt: 5, reports: [], skipped: 0 });
	});

	test("fields a newer or older broker adds or drops are tolerated; what cannot be read is counted, not fatal", () => {
		const parsed = parseUsageResponse({
			generatedAt: 1,
			reports: [
				{
					provider: "x",
					fetchedAt: 1,
					limits: [
						{ id: "a", label: "A", amount: { unit: "weird-unit", used: "NaN" }, extra: { nested: true } },
						{ id: "b" },
						"junk",
					],
					futureField: 1,
				},
				{ provider: "y" },
				42,
				{ provider: "z", fetchedAt: 3, limits: [] },
			],
		});
		expect(parsed.reports.map(r => r.provider)).toEqual(["x", "z"]);
		expect(parsed.reports[0]!.limits).toEqual([{ id: "a", label: "A", unit: "unknown" }]);
		expect(parsed.skipped).toBe(4); // the second and third limit of x, the report without limits, the number
	});

	test("something that is not a usage response at all is an error", () => {
		for (const bad of [
			null,
			"text",
			[],
			{},
			{ generatedAt: "now", reports: [] },
			{ generatedAt: 1 },
			{ generatedAt: 1, reports: {} },
		]) {
			expect(() => parseUsageResponse(bad)).toThrow("not a usage response");
		}
	});

	test("never carries anything but the fields it maps (no raw provider bodies)", () => {
		const parsed = parseUsageResponse({
			generatedAt: 1,
			reports: [
				{
					provider: "x",
					fetchedAt: 1,
					limits: [],
					raw: { secretish: "sk-should-not-travel" },
					metadata: { token: "sk-nope", email: "a@b" },
				},
			],
		});
		expect(JSON.stringify(parsed)).not.toContain("sk-");
		expect(parsed.reports[0]).toEqual({ provider: "x", fetchedAt: 1, identity: "a@b", limits: [] });
	});
});
