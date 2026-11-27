import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { Harness, TOKEN, makeRepo } from "./gateway-harness";
import { secretsEqual } from "../src/secrets";

let repo: string;
let h: Harness;

beforeAll(async () => {
	repo = await makeRepo();
});
afterAll(() => rmSync(dirname(repo), { recursive: true, force: true }));
beforeEach(async () => {
	h = await Harness.start({ repo });
});
afterEach(async () => {
	await h.stop();
});

const UPGRADE = {
	Upgrade: "websocket",
	Connection: "Upgrade",
	"Sec-WebSocket-Version": "13",
	"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
};

const login = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
	fetch(`${h.http}/api/login`, { method: "POST", body: JSON.stringify(body), headers });

describe("auth gate: HTTP", () => {
	test("without a session cookie every route is 401; page navigations get the login page, other requests JSON", async () => {
		const page = await fetch(`${h.http}/`, { headers: { accept: "text/html" } });
		expect(page.status).toBe(401);
		expect(await page.text()).toBe("<html>login page</html>");
		const deep = await fetch(`${h.http}/m/abc/s/def`, { headers: { accept: "text/html" } });
		expect(deep.status).toBe(401);
		expect(await deep.text()).toBe("<html>login page</html>");
		for (const path of ["/app.js", "/api/session", "/api/health", "/sw.js", "/index.html", "/anything.json"]) {
			const res = await fetch(`${h.http}${path}`);
			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "unauthorized" });
		}
		// a POST to some other path is not a navigation either
		expect((await fetch(`${h.http}/api/other`, { method: "POST" })).status).toBe(401);
	});

	test("a bad, garbage, or revoked cookie is the same as none", async () => {
		const good = await h.login();
		expect((await fetch(`${h.http}/api/session`, { headers: { cookie: good } })).status).toBe(204);
		for (const cookie of [
			"omp_web_session=garbage",
			"omp_web_session=",
			"other=1",
			"omp_web_session",
			`x=1; omp_web_session=${good.split("=")[1]}x`,
		]) {
			const res = await fetch(`${h.http}/api/session`, { headers: { cookie } });
			expect(res.status).toBe(401);
		}
		const value = good.split("=")[1]!;
		expect(
			(await fetch(`${h.http}/api/session`, { headers: { cookie: `a=1; omp_web_session=${value}; b=2` } })).status,
		).toBe(204);
	});

	test("login: a wrong or malformed token is refused without a cookie; the right one sets an HttpOnly SameSite cookie", async () => {
		for (const body of [
			{ token: "nope" },
			{ token: TOKEN.slice(0, -1) },
			{ token: `${TOKEN}x` },
			{ token: 5 },
			{},
			"garbage",
		]) {
			const res = await login(body);
			expect(res.status).toBe(401);
			expect(res.headers.get("set-cookie")).toBeNull();
		}
		expect((await fetch(`${h.http}/api/login`, { method: "POST", body: "x".repeat(10_000) })).status).toBe(401);
		const ok = await login({ token: TOKEN });
		expect(ok.status).toBe(204);
		const cookie = ok.headers.get("set-cookie")!;
		expect(cookie).toMatch(/^omp_web_session=[\w-]{20,};/);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain("Max-Age=2592000");
		expect(cookie).not.toContain("Secure"); // plain http
		const behindProxy = await login({ token: TOKEN }, { "x-forwarded-proto": "https" });
		expect(behindProxy.headers.get("set-cookie")).toContain("; Secure");
	});

	test("with a valid cookie the app is served; the login page and its assets, the manifest and nothing else need none", async () => {
		const cookie = await h.login();
		const headers = { cookie };
		expect(await (await fetch(`${h.http}/`, { headers })).text()).toBe("<html>app shell</html>");
		expect(await (await fetch(`${h.http}/m/abc/s/def`, { headers })).text()).toBe("<html>app shell</html>");
		const js = await fetch(`${h.http}/app.js`, { headers });
		expect(js.headers.get("content-type")).toContain("javascript");
		expect((await fetch(`${h.http}/missing.js`, { headers })).status).toBe(404);
		const escape = await fetch(`${h.http}/..%2f${h.webDir.split("/").pop()}-secret.txt`, { headers });
		expect(escape.status).toBe(404);

		expect((await fetch(`${h.http}/login`)).status).toBe(200);
		expect(await (await fetch(`${h.http}/login/`)).text()).toBe("<html>login page</html>");
		expect(await (await fetch(`${h.http}/login/login.js`)).text()).toBe("console.log('login')");
		// the public prefix never falls back to the app shell
		expect((await fetch(`${h.http}/login/whatever`)).status).toBe(404);
		// traversal stays inside the login directory: this is its own index.html, not the app's
		expect(await (await fetch(`${h.http}/login/..%2findex.html`)).text()).toBe("<html>login page</html>");
		expect((await fetch(`${h.http}/manifest.json`)).status).toBe(200);
	});

	test("logout revokes the session on the server, so the old cookie stops working", async () => {
		const cookie = await h.login();
		const out = await fetch(`${h.http}/api/logout`, { method: "POST", headers: { cookie } });
		expect(out.status).toBe(204);
		expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
		expect((await fetch(`${h.http}/api/session`, { headers: { cookie } })).status).toBe(401);
		expect((await fetch(`${h.http}/api/logout`, { method: "POST" })).status).toBe(204); // idempotent without a cookie
	});

	test("posts from another origin are refused; the page's own origin (also behind an https proxy) is fine", async () => {
		expect((await login({ token: TOKEN }, { origin: "https://evil.example" })).status).toBe(403);
		expect((await login({ token: TOKEN }, { origin: h.http })).status).toBe(204);
		const proxied = await login(
			{ token: TOKEN },
			{ origin: "https://box.tailnet.ts.net", host: "box.tailnet.ts.net", "x-forwarded-proto": "https" },
		);
		expect(proxied.status).toBe(204);
		const cookie = await h.login();
		expect(
			(await fetch(`${h.http}/api/logout`, { method: "POST", headers: { cookie, origin: "https://evil.example" } }))
				.status,
		).toBe(403);
		expect((await fetch(`${h.http}/api/session`, { headers: { cookie } })).status).toBe(204); // not logged out by the forged post
	});
});

describe("auth gate: WebSocket", () => {
	test("the upgrade needs a valid cookie: none, garbage, and a revoked one are 401", async () => {
		const url = `${h.http}/ws`;
		expect((await fetch(url, { headers: UPGRADE })).status).toBe(401);
		expect((await fetch(url, { headers: { ...UPGRADE, cookie: "omp_web_session=garbage" } })).status).toBe(401);
		const cookie = await h.login();
		await fetch(`${h.http}/api/logout`, { method: "POST", headers: { cookie } });
		expect((await fetch(url, { headers: { ...UPGRADE, cookie } })).status).toBe(401);
		await expect(
			new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
				ws.onopen = () => resolve();
				ws.onerror = () => reject(new Error("refused"));
			}),
		).rejects.toThrow("refused");
	});

	test("with a cookie the upgrade works, but a cross-origin page still cannot open it", async () => {
		const cookie = await h.login();
		const evil = await fetch(`${h.http}/ws`, { headers: { ...UPGRADE, cookie, Origin: "https://evil.example" } });
		expect(evil.status).toBe(403);
		const same = await fetch(`${h.http}/ws`, { headers: { ...UPGRADE, cookie, Origin: h.http } });
		expect(same.status).not.toBe(403);
		expect(same.status).not.toBe(401);
		const client = await h.connect();
		await client.waitFor(m => m.t === "hello");
	});

	test("the registration endpoint refuses browsers (any Origin) and is not reachable with a session cookie instead of a key", async () => {
		const cookie = await h.login();
		const res = await fetch(`${h.http}/env`, { headers: { ...UPGRADE, cookie, Origin: h.http } });
		expect(res.status).toBe(403);
	});
});

describe("constant-time token comparison", () => {
	test("equal secrets match; any difference, including length, does not", () => {
		expect(secretsEqual("abc", "abc")).toBe(true);
		expect(secretsEqual("abc", "abd")).toBe(false);
		expect(secretsEqual("abc", "abcd")).toBe(false);
		expect(secretsEqual("", "")).toBe(true);
		expect(secretsEqual("", "a")).toBe(false);
	});
});
