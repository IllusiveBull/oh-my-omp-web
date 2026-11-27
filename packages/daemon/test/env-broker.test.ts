import { afterEach, describe, expect, test } from "bun:test";
import { EnvBroker, linkProtection } from "../src/env-broker";

const TOKEN = "tok-env-broker-test";

interface FakeBroker {
	url: string;
	setMode(mode: "ok" | "unauthorized" | "error" | "hang"): void;
	requests: { path: string; auth: string | null }[];
	stop(): Promise<void>;
}

const servers: FakeBroker[] = [];

afterEach(async () => {
	for (const s of servers.splice(0)) await s.stop();
});

function fakeBroker(): FakeBroker {
	let mode: "ok" | "unauthorized" | "error" | "hang" = "ok";
	const requests: FakeBroker["requests"] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			requests.push({ path: url.pathname, auth: req.headers.get("authorization") });
			if (mode === "hang") return new Promise<Response>(() => {});
			if (url.pathname === "/v1/healthz") return Response.json({ ok: true, version: "x" });
			if (mode === "unauthorized" || req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			if (mode === "error") return Response.json({ error: "boom" }, { status: 500 });
			return Response.json({ generatedAt: 1, disabled: [] });
		},
	});
	const fake: FakeBroker = {
		url: `http://127.0.0.1:${server.port}`,
		setMode: m => {
			mode = m;
		},
		requests,
		stop: async () => {
			await server.stop(true);
		},
	};
	servers.push(fake);
	return fake;
}

describe("linkProtection", () => {
	test("wss, loopback and tailnet addresses may carry the token; plain ws elsewhere may not", () => {
		const cases: [string, ReturnType<typeof linkProtection>][] = [
			["wss://gateway.example.com/env", "tls"],
			["wss://box.tail1234.ts.net/env", "tls"],
			["ws://127.0.0.1:7777/env", "loopback"],
			["ws://localhost:7777/env", "loopback"],
			["ws://[::1]:7777/env", "loopback"],
			["ws://100.64.0.1:7777/env", "tailnet"],
			["ws://100.101.102.103:7777/env", "tailnet"],
			["ws://100.127.255.254:7777/env", "tailnet"],
			["ws://box.tail1234.ts.net:7777/env", "tailnet"],
			["ws://[fd7a:115c:a1e0::1]:7777/env", "tailnet"],
			["ws://100.63.0.1:7777/env", null], // just below the CGNAT range
			["ws://100.128.0.1:7777/env", null], // just above it
			["ws://192.168.1.10:7777/env", null],
			["ws://gateway.example.com:7777/env", null],
			["ws://desktop:7777/env", null], // a short MagicDNS name cannot be told from any other name
			["http://127.0.0.1:7777/env", null],
			["not a url", null],
		];
		for (const [url, expected] of cases) expect([url, linkProtection(url)]).toEqual([url, expected]);
	});
});

describe("EnvBroker", () => {
	test("nothing configured: unconfigured, no environment for omp children", () => {
		const broker = new EnvBroker();
		expect(broker.status()).toEqual({ source: "none", state: "unconfigured", checkedAt: null, lastOkAt: null });
		expect(broker.config).toBeNull();
		expect(broker.childEnv()).toEqual({});
	});

	test("the gateway's broker becomes OMP_AUTH_BROKER_URL / OMP_AUTH_BROKER_TOKEN for children and is probed at once", async () => {
		const fake = fakeBroker();
		const broker = new EnvBroker({ now: () => 1000 });
		const changes: string[] = [];
		broker.onChange(() => changes.push(broker.status().state));
		broker.setGateway({ url: fake.url, token: TOKEN });
		expect(broker.childEnv()).toEqual({ OMP_AUTH_BROKER_URL: fake.url, OMP_AUTH_BROKER_TOKEN: TOKEN });
		expect(broker.config).toEqual({ url: fake.url, token: TOKEN, source: "gateway" });
		await broker.probe();
		expect(broker.status()).toEqual({
			source: "gateway",
			state: "ok",
			url: fake.url,
			checkedAt: 1000,
			lastOkAt: 1000,
		});
		expect(changes).toEqual(["ok"]);
		// the probe is /v1/healthz without credentials, then one authenticated read with the token
		expect(fake.requests.map(r => [r.path, r.auth])).toEqual([
			["/v1/healthz", null],
			["/v1/credentials/disabled", `Bearer ${TOKEN}`],
		]);
		expect(JSON.stringify(broker.status())).not.toContain(TOKEN);
	});

	test("withdrawing the gateway's broker returns to unconfigured and empties the child environment", async () => {
		const fake = fakeBroker();
		const broker = new EnvBroker();
		broker.setGateway({ url: fake.url, token: TOKEN });
		await broker.probe();
		broker.setGateway(null);
		expect(broker.status().state).toBe("unconfigured");
		expect(broker.childEnv()).toEqual({});
	});

	test("a machine's own broker wins over the gateway's", async () => {
		const own = fakeBroker();
		const theirs = fakeBroker();
		const broker = new EnvBroker({ local: { url: own.url, token: TOKEN } });
		broker.setGateway({ url: theirs.url, token: "other" });
		await broker.probe();
		expect(broker.config).toEqual({ url: own.url, token: TOKEN, source: "local" });
		expect(broker.childEnv().OMP_AUTH_BROKER_URL).toBe(own.url);
		expect(broker.status()).toMatchObject({ source: "local", state: "ok" });
		expect(theirs.requests).toHaveLength(0);
	});

	test("unreachable: nothing listens; the message says so, and lastOkAt keeps the last good time", async () => {
		const fake = fakeBroker();
		let now = 10;
		const broker = new EnvBroker({ now: () => now, timeoutMs: 500 });
		broker.setGateway({ url: fake.url, token: TOKEN });
		await broker.probe();
		expect(broker.status().state).toBe("ok");
		await fake.stop();
		now = 20;
		await broker.probe();
		expect(broker.status()).toMatchObject({ state: "unreachable", checkedAt: 20, lastOkAt: 10 });
		expect(broker.status().message).toBeTruthy();
	});

	test("a broker that does not answer in time is unreachable, not a hang", async () => {
		const fake = fakeBroker();
		fake.setMode("hang");
		const broker = new EnvBroker({ timeoutMs: 100 });
		broker.setGateway({ url: fake.url, token: TOKEN });
		await broker.probe();
		expect(broker.status()).toMatchObject({ state: "unreachable", message: "the broker did not answer in time" });
	});

	test("a rejected token is `unauthorized`, distinct from unreachable", async () => {
		const fake = fakeBroker();
		const broker = new EnvBroker();
		broker.setGateway({ url: fake.url, token: "a-stale-token" });
		await broker.probe();
		expect(broker.status().state).toBe("unauthorized");
		expect(broker.status().message).toContain("rejected this machine's token");
		fake.setMode("error");
		broker.setGateway({ url: fake.url, token: TOKEN });
		await broker.probe();
		expect(broker.status()).toMatchObject({ state: "unreachable", message: "the broker answered HTTP 500" });
	});

	test("listeners hear about state changes only, not about every probe", async () => {
		const fake = fakeBroker();
		const broker = new EnvBroker();
		let heard = 0;
		broker.onChange(() => heard++);
		broker.setGateway({ url: fake.url, token: TOKEN });
		await broker.probe();
		await broker.probe();
		await broker.probe();
		expect(heard).toBe(1);
		fake.setMode("unauthorized");
		await broker.probe();
		expect(heard).toBe(2);
	});

	test("a probe that was overtaken by a new configuration does not overwrite its result", async () => {
		const slow = fakeBroker();
		slow.setMode("hang");
		const good = fakeBroker();
		const broker = new EnvBroker({ timeoutMs: 300 });
		broker.setGateway({ url: slow.url, token: TOKEN });
		const stale = broker.probe();
		broker.setGateway({ url: good.url, token: TOKEN });
		await stale;
		await broker.probe();
		expect(broker.status()).toMatchObject({ state: "ok", url: good.url });
	});

	test("a failed omp start gets the broker named as the likely cause when it is unreachable, and is left alone otherwise", async () => {
		const fake = fakeBroker();
		const broker = new EnvBroker({ timeoutMs: 300 });
		const original = new Error("Agent process exited with code 1. Stderr: fetch failed");
		expect(broker.explainSpawnError(original)).toBeNull(); // unconfigured
		broker.setGateway({ url: fake.url, token: TOKEN });
		await broker.probe();
		expect(broker.explainSpawnError(original)).toBeNull(); // healthy: not the broker's fault
		await fake.stop();
		await broker.probe();
		const explained = broker.explainSpawnError(original);
		expect(explained?.message).toContain("Agent process exited with code 1");
		expect(explained?.message).toContain(`cannot use the auth broker at ${fake.url}`);
		expect(explained?.message).not.toContain(TOKEN);
	});
});
