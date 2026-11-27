import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromBase64Url } from "../src/push/encrypt";
import { loadVapid, vapidHeaders } from "../src/push/vapid";
import { ConfigError } from "../src/secrets";

const dirs: string[] = [];
const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ompweb-vapid-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const decode = (part: string): unknown => JSON.parse(new TextDecoder().decode(fromBase64Url(part)!));

describe("loadVapid", () => {
	test("generates a P-256 key pair on first use, stores it readable by the owner only, and loads the same one afterwards", async () => {
		const dir = tempDir();
		const first = await loadVapid(dir);
		const point = fromBase64Url(first.publicKey)!;
		expect(point.length).toBe(65);
		expect(point[0]).toBe(0x04);
		if (process.platform !== "win32") expect(statSync(join(dir, "vapid.json")).mode & 0o777).toBe(0o600);
		const second = await loadVapid(dir);
		expect(second.publicKey).toBe(first.publicKey);
		// the loaded private key signs for the same public key
		const header = await vapidHeaders(second, "https://push.example", "mailto:a@b.c");
		expect(header).toContain(`k=${first.publicKey}`);
		expect((await loadVapid(tempDir())).publicKey).not.toBe(first.publicKey);
	});

	test("a key file other users can read is refused", async () => {
		if (process.platform === "win32") return;
		const dir = tempDir();
		await loadVapid(dir);
		chmodSync(join(dir, "vapid.json"), 0o644);
		await expect(loadVapid(dir)).rejects.toThrow("chmod 600");
	});

	test("a key file whose public key does not belong to its private key, or that is not JSON, is a configuration error", async () => {
		const dir = tempDir();
		const other = await loadVapid(tempDir());
		await loadVapid(dir);
		const file = join(dir, "vapid.json");
		const stored = JSON.parse(await Bun.file(file).text()) as { privateJwk: object; publicKey: string };
		await Bun.write(file, JSON.stringify({ ...stored, publicKey: other.publicKey }));
		chmodSync(file, 0o600);
		await expect(loadVapid(dir)).rejects.toBeInstanceOf(ConfigError);
		await Bun.write(file, "garbage");
		chmodSync(file, 0o600);
		await expect(loadVapid(dir)).rejects.toThrow("not a valid VAPID key file");
	});
});

describe("vapidHeaders", () => {
	test("is `vapid t=<ES256 JWT>, k=<public key>` whose signature verifies with the public key", async () => {
		const keys = await loadVapid(tempDir());
		const now = Date.UTC(2026, 10, 12, 9, 0, 0);
		const header = await vapidHeaders(keys, "https://push.example.com", "mailto:ops@example.com", now);
		const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
		expect(match).not.toBeNull();
		const [, head, claims, signature, k] = match!;
		expect(k).toBe(keys.publicKey);
		expect(decode(head!)).toEqual({ typ: "JWT", alg: "ES256" });
		expect(decode(claims!)).toEqual({
			aud: "https://push.example.com",
			exp: now / 1000 + 12 * 3600 - 300,
			sub: "mailto:ops@example.com",
		});
		const raw = fromBase64Url(signature!)!;
		expect(raw.length).toBe(64);
		const verifyKey = await crypto.subtle.importKey(
			"raw",
			fromBase64Url(keys.publicKey)!,
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const signed = new TextEncoder().encode(`${head}.${claims}`);
		expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, raw, signed)).toBe(true);
		signed[0] = signed[0]! ^ 1;
		expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, raw, signed)).toBe(false);
	});

	test("the token expires strictly less than 24 hours after it is made, and follows the clock it is given", async () => {
		const keys = await loadVapid(tempDir());
		for (const now of [0, 1_700_000_000_123]) {
			const token = (await vapidHeaders(keys, "https://p", "https://example.com", now))
				.split(" ")[1]!
				.split(".")[1]!;
			const { exp } = decode(token) as { exp: number };
			expect(exp).toBeGreaterThan(Math.floor(now / 1000) + 11 * 3600);
			expect(exp).toBeLessThanOrEqual(Math.floor(now / 1000) + 12 * 3600);
		}
	});
});
