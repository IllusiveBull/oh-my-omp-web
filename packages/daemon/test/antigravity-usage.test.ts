import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AntigravityUsageProbe,
	antigravityUserAgent,
	decodeGoKeyringSecret,
	parseAntigravityAvailableModelsQuota,
	parseAntigravityQuotaSummary,
} from "../src/antigravity-usage";

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("decodeGoKeyringSecret", () => {
	test("decodes go-keyring base64, hex-encoded, macOS security hex, and raw UTF-8 secrets", () => {
		const payload = JSON.stringify({ token: { access_token: "ya29.test" } });
		expect(decodeGoKeyringSecret(payload)).toBe(payload);
		expect(decodeGoKeyringSecret(`go-keyring-base64:${Buffer.from(payload).toString("base64")}`)).toBe(payload);
		expect(decodeGoKeyringSecret(`go-keyring-encoded:${Buffer.from(payload).toString("hex")}`)).toBe(payload);
		const b64Prefixed = `go-keyring-base64:${Buffer.from(payload).toString("base64")}`;
		expect(decodeGoKeyringSecret(Buffer.from(b64Prefixed).toString("hex"))).toBe(payload);
	});
});

describe("parseAntigravityQuotaSummary", () => {
	test("parses grouped buckets, omits untouched rolling resets, skips disabled, and maps families", () => {
		const requestedAt = Date.parse("2026-10-21T10:16:04Z");
		const limits = parseAntigravityQuotaSummary(
			{
				groups: [
					{
						displayName: "Gemini Models",
						buckets: [
							{
								bucketId: "gemini-5h",
								window: "5h",
								remainingFraction: 0.85,
								resetTime: "2026-10-21T13:29:53Z",
								description: "5h window active",
							},
							{
								bucketId: "gemini-weekly",
								window: "weekly",
								remainingFraction: 0.15,
								resetTime: "2026-10-27T10:00:00Z",
							},
							{
								bucketId: "gemini-disabled",
								window: "5h",
								remainingFraction: 0.5,
								disabled: true,
							},
						],
					},
					{
						displayName: "Gemini Argon",
						buckets: [
							{
								bucketId: "gemini-argon-5h",
								window: "5h",
								remainingFraction: 0,
								resetTime: "2026-10-21T14:00:00Z",
							},
						],
					},
					{
						displayName: "Claude and GPT models",
						buckets: [
							{
								bucketId: "3p-5h",
								window: "5h",
								remainingFraction: 1,
								// Rolling full-window reset on an untouched bucket: should be omitted.
								resetTime: "2026-10-21T15:16:05Z",
							},
						],
					},
				],
			},
			requestedAt,
		);

		expect(limits.map(l => l.id)).toEqual(["gemini-5h", "gemini-weekly", "gemini-argon-5h", "3p-5h"]);
		expect(limits[0]).toMatchObject({
			label: "Gemini · 5-hour",
			status: "ok",
			resetsAt: Date.parse("2026-10-21T13:29:53Z"),
			durationMs: 5 * 3600_000,
			notes: ["5h window active"],
		});
		expect(limits[0]!.usedFraction).toBeCloseTo(0.15, 5);
		expect(limits[1]).toMatchObject({ label: "Gemini · Weekly", status: "warning" });
		expect(limits[2]).toMatchObject({ label: "Gemini Argon · 5-hour", status: "exhausted", usedFraction: 1 });
		expect(limits[3]).toMatchObject({ label: "Claude & GPT (shared) · 5-hour", usedFraction: 0 });
		expect(limits[3]!.resetsAt).toBeUndefined();
	});
});

describe("parseAntigravityAvailableModelsQuota", () => {
	test("aggregates quotaInfo and weeklyQuotaInfo by provider family keeping the highest usedFraction", () => {
		const limits = parseAntigravityAvailableModelsQuota({
			models: {
				"gemini-4-argon": {
					modelProvider: "MODEL_PROVIDER_GOOGLE",
					quotaInfo: { remainingFraction: 0.9, resetTime: "2026-10-21T14:00:00Z" },
				},
				"gemini-3.8-flash": {
					modelProvider: "MODEL_PROVIDER_GOOGLE",
					quotaInfo: { remainingFraction: 0.4, resetTime: "2026-10-21T13:00:00Z" },
					weeklyQuotaInfo: { remainingFraction: 0.7 },
				},
				"claude-opus-4-6": {
					modelProvider: "MODEL_PROVIDER_ANTHROPIC",
					quotaInfo: { remainingFraction: 0.25 },
				},
			},
		});
		const byId = new Map(limits.map(l => [l.id, l]));
		expect(byId.get("gemini-quota")?.usedFraction).toBeCloseTo(0.6, 5);
		expect(byId.get("gemini-weekly")?.usedFraction).toBeCloseTo(0.3, 5);
		expect(byId.get("claude-quota")?.usedFraction).toBeCloseTo(0.75, 5);
	});
});

describe("AntigravityUsageProbe", () => {
	test("reads CLI keyring token, fetches userinfo and merges daily+prod quota endpoints", async () => {
		const dir = tempDir("agy-usage-keyring-");
		const nowMs = Date.parse("2026-11-22T10:00:00Z");
		const seenUrls: string[] = [];
		const seenHeaders: Record<string, string>[] = [];

		const probe = new AntigravityUsageProbe({
			tokenDirs: [dir],
			now: () => nowMs,
			platform: "darwin",
			arch: "arm64",
			readKeyring: async () =>
				JSON.stringify({
					token: { access_token: "ya29.cli-token", expiry: "2026-11-22T11:00:00Z" },
				}),
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				seenUrls.push(url);
				seenHeaders.push((init?.headers as Record<string, string>) ?? {});
				if (url.endsWith("/userinfo")) {
					return Response.json({ id: "123", email: "dev@example.com" });
				}
				if (url.startsWith("https://daily-cloudcode-pa.googleapis.com")) {
					return Response.json({
						groups: [
							{
								displayName: "Gemini",
								buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.7 }],
							},
						],
					});
				}
				return Response.json({
					groups: [
						{
							displayName: "Gemini",
							buckets: [
								// Duplicate bucketId: daily must win for oauth-personal.
								{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.1 },
								{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.5 },
							],
						},
					],
				});
			}) as typeof fetch,
		});

		const ack = await probe.probe();
		expect(ack.unavailable).toBeUndefined();
		expect(ack.report?.identity).toBe("dev@example.com");
		expect(ack.report?.limits.map(l => l.id)).toEqual(["gemini-5h", "3p-weekly"]);
		expect(ack.report?.limits[0]!.usedFraction).toBeCloseTo(0.3, 5);
		expect(seenHeaders.some(h => h["User-Agent"] === antigravityUserAgent("darwin", "arm64"))).toBe(true);
		expect(seenUrls.some(u => u.includes("retrieveUserQuotaSummary"))).toBe(true);
	});

	test("refreshes legacy acp_token.json and falls back to fetchAvailableModels when summary is empty", async () => {
		const dir = tempDir("agy-usage-legacy-");
		writeFileSync(
			join(dir, "acp_token.json"),
			JSON.stringify({
				client_id: "cid",
				client_secret: "csec",
				refresh_token: "rtok",
				project_id: "proj-1",
			}),
		);
		let tokenRefreshes = 0;
		const nowMs = Date.parse("2026-11-22T10:00:00Z");
		const probe = new AntigravityUsageProbe({
			tokenDirs: [dir],
			now: () => nowMs,
			readKeyring: async () => undefined,
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.endsWith("/token")) {
					tokenRefreshes++;
					return Response.json({ access_token: "ya29.refreshed", expires_in: 3600 });
				}
				if (url.endsWith("/userinfo")) {
					return Response.json({ id: "u-1", email: "legacy@example.com" });
				}
				if (url.includes("retrieveUserQuotaSummary")) {
					expect(JSON.parse(String(init?.body))).toEqual({ project: "proj-1" });
					return Response.json({ groups: [] });
				}
				return Response.json({
					models: {
						"gemini-4-argon": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.6 } },
					},
				});
			}) as typeof fetch,
		});

		const first = await probe.probe();
		const second = await probe.probe();
		expect(tokenRefreshes).toBe(1);
		expect(first.report?.limits).toHaveLength(1);
		expect(first.report?.limits[0]!.usedFraction).toBeCloseTo(0.4, 5);
		expect(second.report?.identity).toBe("legacy@example.com");
	});

	test("reports expired, unauthenticated, and unsupported states cleanly", async () => {
		const emptyDir = tempDir("agy-usage-empty-");
		const unauth = await new AntigravityUsageProbe({
			tokenDirs: [emptyDir],
			readKeyring: async () => undefined,
		}).probe();
		expect(unauth.report).toBeNull();
		expect(unauth.unavailable?.reason).toBe("unauthenticated");

		const expiredDir = tempDir("agy-usage-expired-");
		writeFileSync(
			join(expiredDir, "antigravity-oauth-token"),
			JSON.stringify({ token: { access_token: "ya29.old", expiry: "2026-11-22T09:00:00Z" } }),
		);
		const expired = await new AntigravityUsageProbe({
			tokenDirs: [expiredDir],
			now: () => Date.parse("2026-11-22T10:00:00Z"),
			readKeyring: async () => undefined,
		}).probe();
		expect(expired.report).toBeNull();
		expect(expired.unavailable?.reason).toBe("expired");

		const apiKey = await new AntigravityUsageProbe({
			authMethod: "gemini-api-key",
			tokenDirs: [emptyDir],
		}).probe();
		expect(apiKey.report).toBeNull();
		expect(apiKey.unavailable?.reason).toBe("unsupported");
	});

	test("prefers a fresh OS keyring token when an expired antigravity-oauth-token file is also present", async () => {
		const dir = tempDir("agy-usage-mixed-");
		writeFileSync(
			join(dir, "antigravity-oauth-token"),
			JSON.stringify({ token: { access_token: "ya29.expired", expiry: "2026-11-22T09:00:00Z" } }),
		);
		const probe = new AntigravityUsageProbe({
			tokenDirs: [dir],
			now: () => Date.parse("2026-11-22T10:00:00Z"),
			readKeyring: async () =>
				JSON.stringify({ token: { access_token: "ya29.fresh", expiry: "2026-11-22T11:00:00Z" } }),
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer ya29.fresh");
				if (url.endsWith("/userinfo")) return Response.json({ id: "1", email: "fresh@example.com" });
				return Response.json({
					groups: [
						{
							displayName: "Gemini",
							buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9 }],
						},
					],
				});
			}) as typeof fetch,
		});
		const ack = await probe.probe();
		expect(ack.report?.identity).toBe("fresh@example.com");
		expect(ack.report?.limits[0]!.usedFraction).toBeCloseTo(0.1, 5);
	});
});
