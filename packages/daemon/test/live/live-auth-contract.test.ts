import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { OmpAuthProcess, type LoginEvent } from "../../src/auth-process";
import { BrokerSupervisor } from "../../src/broker-supervisor";
import { parseUsageResponse } from "../../src/broker-usage";
import { makeSandbox, requireOmp } from "./live-env";

// Live contract for credentials: the installed `omp` against what the broker supervisor, the credential process and the
// usage parser read. Everything runs in a temp HOME with fake credentials: the broker is `omp auth-broker serve` on a loopback
// port with its own agent.db and token, the sign-in is omp's real `stencil` OAuth flow pointed at a local fake authorization
// server (STENCIL_AUTH_URL), and no provider's real endpoint is contacted. The user's own ~/.omp is never opened.

const sandbox = makeSandbox("omp-web-live-auth-");
const home = join(sandbox.root, "home");

/** A stand-in for stencil.so's OIDC issuer: authorize redirects (answered as JSON here), token, userinfo. */
let nextEmail = "";
const issuer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/oauth/authorize") {
			const redirect = new URL(url.searchParams.get("redirect_uri")!);
			redirect.searchParams.set("code", "fake-code");
			redirect.searchParams.set("state", url.searchParams.get("state")!);
			return Response.json({ redirect: redirect.toString() });
		}
		if (url.pathname === "/oauth/token") {
			await req.text();
			return Response.json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 });
		}
		if (url.pathname === "/oauth/userinfo") return Response.json({ email: nextEmail, sub: `sub-${nextEmail}` });
		return new Response("not found", { status: 404 });
	},
});

const bind = { host: "127.0.0.1", port: 0 };
let supervisor: BrokerSupervisor;
let authEnv: Record<string, string | undefined>;
let process_: OmpAuthProcess;

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = probe.port!;
	await probe.stop(true);
	return port;
}

const until = async (predicate: () => boolean, ms = 30_000): Promise<void> => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await Bun.sleep(25);
	}
};

beforeAll(async () => {
	const omp = await requireOmp();
	bind.port = await freePort();
	const clean: Record<string, string | undefined> = { ...Bun.env };
	for (const name of [
		"PI_CODING_AGENT_DIR",
		"PI_PROFILE",
		"OMP_PROFILE",
		"OMP_AUTH_BROKER_URL",
		"OMP_AUTH_BROKER_TOKEN",
		"PI_CONFIG_FILES",
	]) {
		delete clean[name];
	}
	supervisor = new BrokerSupervisor({ ompPath: omp.path, bind, home, env: clean });
	supervisor.start();
	await until(() => supervisor.status().phase === "running" && supervisor.status().healthy);
	authEnv = {
		...clean,
		HOME: home,
		USERPROFILE: home,
		OMP_AUTH_BROKER_URL: supervisor.url,
		OMP_AUTH_BROKER_TOKEN: supervisor.token!,
		STENCIL_AUTH_URL: `http://127.0.0.1:${issuer.port}`,
		STENCIL_BASE_URL: `http://127.0.0.1:${issuer.port}`,
	};
	process_ = new OmpAuthProcess({
		ompPath: omp.path,
		cwd: sandbox.cwd,
		agentDir: join(sandbox.root, "auth-agent"),
		env: authEnv,
	});
	await process_.start();
}, 90_000);

afterAll(async () => {
	await process_?.stop();
	await supervisor?.stop();
	await issuer.stop(true);
	sandbox.cleanup();
});

describe("the managed broker (omp auth-broker serve)", () => {
	test("comes up in the temp home with its own token file (mode 600) and database, and reports its version", () => {
		const status = supervisor.status();
		expect(status).toMatchObject({ phase: "running", healthy: true, url: `http://127.0.0.1:${bind.port}` });
		expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(status.tokenFile).toBe(join(home, ".omp", "auth-broker.token"));
		expect(status.agentDb).toBe(join(home, ".omp", "agent", "agent.db"));
		if (process.platform !== "win32") expect(statSync(status.tokenFile!).mode & 0o777).toBe(0o600); // Windows has no mode bits
		expect(supervisor.token).toMatch(/\S{20,}/);
		expect(JSON.stringify(status)).not.toContain(supervisor.token!);
	});

	test("/v1/usage has the shape the parser reads (an empty vault: no reports)", async () => {
		const response = await fetch(`${supervisor.url}/v1/usage`, {
			headers: { authorization: `Bearer ${supervisor.token}` },
		});
		expect(response.status).toBe(200);
		const parsed = parseUsageResponse(await response.json());
		expect(parsed.reports).toEqual([]);
		expect(parsed.generatedAt).toBeGreaterThan(0);
	});

	test("an unauthenticated request is refused; /v1/healthz needs no token (what the probes rely on)", async () => {
		expect((await fetch(`${supervisor.url}/v1/credentials/disabled`)).status).toBe(401);
		expect((await fetch(`${supervisor.url}/v1/healthz`)).status).toBe(200);
		const disabled = await fetch(`${supervisor.url}/v1/credentials/disabled?provider=omp-web-probe`, {
			headers: { authorization: `Bearer ${supervisor.token}` },
		});
		expect(disabled.status).toBe(200);
		expect(await disabled.json()).toMatchObject({ disabled: [] });
	});
});

describe("the credential process (omp --mode rpc against that broker)", () => {
	test("get_login_providers answers what the daemon maps: id, name, available, authenticated", async () => {
		const providers = await process_.providers();
		expect(providers.length).toBeGreaterThan(20);
		for (const p of providers) {
			expect(typeof p.id).toBe("string");
			expect(typeof p.name).toBe("string");
			expect(typeof p.available).toBe("boolean");
			expect(typeof p.authenticated).toBe("boolean");
		}
		expect(providers.find(p => p.id === "stencil")).toMatchObject({ authenticated: false });
		expect(providers.find(p => p.id === "anthropic")).toBeDefined();
	});

	test("a real OAuth sign-in (stencil, against the local fake issuer) emits the link and the code prompt, and completing it stores the account in the broker", async () => {
		nextEmail = "first@example.invalid";
		const events: LoginEvent[] = [];
		const run = process_.login("stencil", e => events.push(e));
		await until(() => events.some(e => e.kind === "prompt"));
		const link = events.find(e => e.kind === "link");
		expect(link).toMatchObject({ kind: "link" });
		expect(new URL((link as { url: string }).url).origin).toBe(`http://127.0.0.1:${issuer.port}`);
		const prompt = events.find(e => e.kind === "prompt") as Extract<LoginEvent, { kind: "prompt" }>;
		expect(prompt.secret).toBe(false);
		// the manual path: follow the authorization URL like a browser would and paste the redirect it ends in
		const { redirect } = (await (await fetch((link as { url: string }).url)).json()) as { redirect: string };
		run.answer(prompt.id, { value: redirect });
		await run.done;
		expect(await process_.accounts("stencil")).toMatchObject([
			{ provider: "stencil", label: "first@example.invalid", type: "oauth", active: true },
		]);
		expect((await process_.providers()).find(p => p.id === "stencil")?.authenticated).toBe(true);
	}, 60_000);

	test("the broker holds it (a second, fresh omp process sees the same account), and logout removes it for both", async () => {
		const omp = await requireOmp();
		const second = new OmpAuthProcess({
			ompPath: omp.path,
			cwd: sandbox.cwd,
			agentDir: join(sandbox.root, "auth-agent-2"),
			env: authEnv,
		});
		await second.start();
		try {
			const accounts = await second.accounts("stencil");
			expect(accounts.map(a => a.label)).toEqual(["first@example.invalid"]);
			await second.logout("stencil", accounts[0]!.credentialId);
			expect(await second.accounts("stencil")).toEqual([]);
		} finally {
			await second.stop();
		}
		expect(await process_.accounts("stencil")).toEqual([]);
	}, 60_000);

	test("API-key providers still ask for typed input over RPC, which is why the gateway refuses by provider kind and by prompt", async () => {
		const events: LoginEvent[] = [];
		const run = process_.login("deepseek", e => events.push(e));
		const settled = run.done.then(
			() => "completed",
			() => "failed",
		);
		await until(() => events.some(e => e.kind === "prompt"));
		const prompt = events.find(e => e.kind === "prompt") as Extract<LoginEvent, { kind: "prompt" }>;
		expect(prompt.title.toLowerCase()).toContain("api key");
		// the key page is offered as a link too: there is nothing here an OAuth code could be
		expect(events.some(e => e.kind === "link")).toBe(true);
		await process_.kill(); // nothing is answered: no key is sent anywhere
		expect(await settled).toBe("failed");
	}, 60_000);
});

describe("stopping", () => {
	// POSIX: SIGINT, the broker's graceful path. Windows: a tree kill of omp.exe and the broker below it (no graceful stop there);
	// either way nothing may still be listening once stop() has resolved.
	test("stop() shuts the broker down (SIGINT on POSIX, a tree kill on Windows) and the supervisor does not restart it", async () => {
		await supervisor.stop();
		expect(supervisor.status()).toMatchObject({ phase: "stopped", healthy: false, pid: null });
		const answer = await fetch(`${supervisor.url}/v1/healthz`).then(
			r => r.status,
			() => "refused",
		);
		expect(answer).toBe("refused");
	}, 30_000);
});
