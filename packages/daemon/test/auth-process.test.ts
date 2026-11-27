import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthFrame, AuthMessage, BrokerStatus, LoginFlowWire } from "@omp-web/protocol";
import { OmpAuthProcess, PLACEHOLDER_MODEL, PLACEHOLDER_MODELS_YML, type LoginEvent } from "../src/auth-process";
import { AuthService, type BrokerControl } from "../src/auth-service";
import { posixPath, writeExecutable } from "./fake-bin";

const dir = mkdtempSync(join(tmpdir(), "ompweb-authproc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FIXTURE = join(import.meta.dir, "fixtures", "fake-omp-auth.ts");
const OMP = writeExecutable(join(dir, "omp"), `exec "${posixPath(process.execPath)}" "${posixPath(FIXTURE)}" "$@"`);

let logSeq = 0;
const newLog = (): string => join(dir, `fake-omp-${++logSeq}.log`);
const logLines = (file: string): string[] => {
	try {
		return readFileSync(file, "utf8").trim().split("\n");
	} catch {
		return [];
	}
};
const pidOf = (file: string): number =>
	Number(/pid=(\d+)/.exec(logLines(file).find(l => l.startsWith("start")) ?? "")?.[1]);
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const until = async (predicate: () => boolean, ms = 8000): Promise<void> => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
};

const procs: OmpAuthProcess[] = [];
afterEach(async () => {
	for (const p of procs.splice(0)) await p.stop();
});

/** Which scripted scenario each provider id plays (see the fixture). */
const SCENARIOS = JSON.stringify({
	anthropic: "oauth",
	stencil: "callback",
	"kimi-code": "badurl",
	"a-provider-from-the-future": "typed",
});

async function start(file: string, extraEnv: Record<string, string> = {}): Promise<OmpAuthProcess> {
	const p = new OmpAuthProcess({
		ompPath: OMP,
		cwd: dir,
		agentDir: join(dir, "auth-agent"),
		env: {
			...Bun.env,
			FAKE_OMP_LOG: file,
			FAKE_SCENARIOS: SCENARIOS,
			OMP_AUTH_BROKER_URL: "http://127.0.0.1:8765",
			OMP_AUTH_BROKER_TOKEN: "tok",
			...extraEnv,
		},
	});
	await p.start();
	procs.push(p);
	return p;
}

describe("OmpAuthProcess (the real tap, frame decoder and request mapping, against a scripted omp)", () => {
	test("runs omp with the broker in its environment and lists providers, accounts and logs out through omp's own commands", async () => {
		const file = newLog();
		const p = await start(file);
		expect(logLines(file)[0]).toContain("url=http://127.0.0.1:8765 token=set");
		expect((await p.providers()).map(x => x.id)).toEqual([
			"anthropic",
			"stencil",
			"kimi-code",
			"deepseek",
			"a-provider-from-the-future",
			"fail",
		]);
		expect(await p.accounts("anthropic")).toEqual([
			{
				credentialId: 7,
				provider: "anthropic",
				label: "me@example.invalid",
				detail: "oauth #7",
				type: "oauth",
				active: true,
			},
		]);
		expect(await p.accounts("stencil")).toEqual([]);
		await p.logout("anthropic", 7);
		expect(logLines(file)).toContain("logout anthropic 7");
	});

	test("starts with a placeholder model in its own agent directory (omp will not start without a model, and a fresh broker offers none)", async () => {
		const file = newLog();
		await start(file, { PI_PROFILE: "work" });
		const started = logLines(file)[0]!;
		expect(started).toContain(`agentdir=${join(dir, "auth-agent")}`);
		expect(started).toContain("profile=-"); // a profile would move the agent directory elsewhere
		expect(started).toContain(`--model ${PLACEHOLDER_MODEL}`);
		expect(started).toContain("--no-session");
		expect(readFileSync(join(dir, "auth-agent", "models.yml"), "utf8")).toBe(PLACEHOLDER_MODELS_YML);
		expect(PLACEHOLDER_MODELS_YML).not.toMatch(/sk-|api[_-]?key:\s*[A-Za-z0-9]{30,}/); // the key is a literal marker, not a credential
	});

	test("a sign-in's link, progress and authorization-code prompt come out as events; the answer goes back to omp", async () => {
		const file = newLog();
		const p = await start(file);
		const events: LoginEvent[] = [];
		const run = p.login("anthropic", e => events.push(e));
		await until(() => events.some(e => e.kind === "prompt"));
		expect(events).toEqual([
			{
				kind: "link",
				url: "https://claude.ai/oauth/authorize?x=1",
				launchUrl: "http://localhost:54545/launch",
				instructions: "Complete login in your browser.",
			},
			{ kind: "progress", level: "info", message: "Waiting for browser authentication..." },
			{
				kind: "prompt",
				id: "ui-1",
				title: "Paste the authorization code (or full redirect URL):",
				placeholder: undefined,
				secret: false,
			},
		]);
		run.answer("ui-1", { value: "http://localhost:54545/callback?code=c&state=s" });
		await run.done;
		expect(logLines(file)).toContain("answer http://localhost:54545/callback?code=c&state=s");
	});

	test("a non-http(s) URL omp asks to open is never offered as a link (it becomes a warning), the http one after it is", async () => {
		const p = await start(newLog());
		const events: LoginEvent[] = [];
		await p.login("kimi-code", e => events.push(e)).done;
		expect(events.filter(e => e.kind === "link")).toEqual([
			{ kind: "link", url: "https://example.invalid/ok", launchUrl: undefined, instructions: undefined },
		]);
		const warning = events.find(e => e.kind === "progress");
		expect(warning).toMatchObject({ kind: "progress", level: "warning" });
		expect(JSON.stringify(warning)).toContain("not http(s)");
	});

	test("an error response from omp rejects `done` with omp's message", async () => {
		const p = await start(newLog());
		// Settled first, then asserted: on Windows (Bun 1.4.4) `expect(<promise still waiting on the child's stdout pipe>).rejects`
		// did not return within the test timeout here, while the same test passes once anything delays the matcher.
		const error = await p
			.login("fail", () => {})
			.done.then(
				() => null,
				(e: unknown) => e,
			);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Unknown OAuth provider: fail");
	});

	test("kill() ends the process: its pending login rejects, and no exit callback fires for a deliberate kill", async () => {
		const file = newLog();
		const p = await start(file);
		let exits = 0;
		p.onExit(() => exits++);
		const run = p.login("anthropic", () => {});
		const rejected = run.done.then(
			() => null,
			(e: Error) => e,
		);
		await until(() => logLines(file).length > 0);
		const pid = pidOf(file);
		await p.kill();
		expect((await rejected)?.message).toContain("Client stopped");
		await until(() => !alive(pid));
		expect(exits).toBe(0);
	});

	test("a process that dies by itself tells its listeners", async () => {
		const file = newLog();
		const p = await start(file);
		const reasons: string[] = [];
		p.onExit(r => reasons.push(r));
		process.kill(pidOf(file), "SIGKILL");
		await until(() => reasons.length === 1);
		expect(reasons[0]).toContain("omp exited");
	});
});

// ---------------------------------------------------------------------------
// The whole path: AuthService over the real process (secrets refused end to end)
// ---------------------------------------------------------------------------

function brokerStub(): BrokerControl {
	const status: BrokerStatus = {
		phase: "running",
		healthy: true,
		url: "http://127.0.0.1:8765",
		advertisedUrl: "http://127.0.0.1:8765",
		bind: "127.0.0.1:8765",
		home: "/srv/broker",
		agentDb: "/srv/broker/.omp/agent/agent.db",
		tokenFile: "/srv/broker/.omp/auth-broker.token",
		pid: 1,
		version: "18.19.0",
		startedAt: 1,
		checkedAt: 1,
		restarts: 0,
		nextRetryAt: null,
		lastError: null,
	};
	return {
		status: () => status,
		token: "tok",
		url: "http://127.0.0.1:8765",
		advertisedUrl: "http://127.0.0.1:8765",
		onChange: () => () => {},
		stop: async () => {},
	};
}

interface Rig {
	service: AuthService;
	frames: AuthFrame[];
	log: string;
	flow(): LoginFlowWire | null;
	send(message: Record<string, unknown>): Promise<unknown>;
}

const services: AuthService[] = [];
afterEach(async () => {
	for (const s of services.splice(0)) await s.stop();
});

function rig(scenarios: Record<string, string> = {}): Rig {
	const log = newLog();
	const frames: AuthFrame[] = [];
	const service = new AuthService({
		supervisor: brokerStub(),
		selfMachineId: "m",
		publish: f => frames.push(f),
		brokerConfigChanged: () => {},
		createProcess: async env => {
			const p = new OmpAuthProcess({
				ompPath: OMP,
				cwd: dir,
				agentDir: join(dir, "auth-agent"),
				env: {
					...env,
					FAKE_OMP_LOG: log,
					FAKE_SCENARIOS: JSON.stringify({ ...JSON.parse(SCENARIOS), ...scenarios }),
				},
			});
			await p.start();
			return p;
		},
		baseEnv: { ...Bun.env },
		localAgentDb: null,
		userHome: "/home/u",
		platform: "linux",
		fetch: async () => Response.json({ generatedAt: 1, disabled: [] }),
	});
	services.push(service);
	const conn = {};
	return {
		service,
		frames,
		log,
		flow: () =>
			(frames.findLast(f => f.t === "auth.flow") as Extract<AuthFrame, { t: "auth.flow" }> | undefined)?.flow ??
			null,
		send: message => service.handle(conn, { reqId: "r", ...message } as AuthMessage),
	};
}

describe("AuthService over the real omp RPC process", () => {
	test("the OAuth manual-code flow end to end: link, prompt, answer, success with the stored account", async () => {
		const r = rig();
		await r.send({ t: "auth.login.start", providerId: "anthropic" });
		await until(() => r.flow()?.prompt !== null && r.flow() !== null);
		expect(r.flow()).toMatchObject({
			status: "running",
			link: { url: "https://claude.ai/oauth/authorize?x=1" },
			progress: ["Waiting for browser authentication..."],
		});
		await r.send({ t: "auth.login.input", flowId: r.flow()!.id, promptId: r.flow()!.prompt!.id, value: "the-code" });
		await until(() => r.flow()?.status === "succeeded");
		expect(r.flow()?.identity).toBe("me@example.invalid");
		expect(logLines(r.log)).toContain("answer the-code");
	});

	test("an OAuth callback that completes by itself ends the flow while the browser still shows the link", async () => {
		const r = rig();
		await r.send({ t: "auth.login.start", providerId: "stencil" });
		await until(() => r.flow()?.status === "succeeded");
	});

	test("a javascript: URL from omp never becomes a link in the flow", async () => {
		const r = rig();
		await r.send({ t: "auth.login.start", providerId: "kimi-code" });
		await until(() => r.flow()?.status === "succeeded");
		const links = r.frames.flatMap(f => (f.t === "auth.flow" && f.flow?.link ? [f.flow.link.url] : []));
		expect(links.length).toBeGreaterThan(0);
		expect(links.every(url => url.startsWith("https://"))).toBe(true);
	});

	test("a secret input frame ends the flow without anything reaching a browser, and the omp process is killed", async () => {
		const r = rig({ anthropic: "secret" });
		await r.send({ t: "auth.login.start", providerId: "anthropic" });
		await until(() => r.flow()?.status === "failed");
		expect(r.flow()).toMatchObject({ prompt: null, failure: { kind: "secret_input" } });
		expect(r.flow()?.failure?.terminalCommand).toBe("HOME='/srv/broker' omp auth-broker login anthropic");
		const pid = pidOf(r.log);
		await until(() => !alive(pid));
		expect(logLines(r.log).some(l => l.startsWith("secret answered"))).toBe(false);
	});

	test("what omp 18.19 sends for API-key providers (an input not marked secret, after a docs link) is refused too: no field is ever shown", async () => {
		const r = rig();
		// a provider id this build's catalog does not know is `unknown`, i.e. not an OAuth code flow
		await r.send({ t: "auth.login.start", providerId: "a-provider-from-the-future" });
		await until(() => r.flow()?.status === "failed");
		expect(r.flow()).toMatchObject({ prompt: null, failure: { kind: "secret_input" } });
		expect(JSON.stringify(r.frames.filter(f => f.t === "auth.flow"))).not.toContain('"prompt":{');
		await until(() => !alive(pidOf(r.log)));
		expect(logLines(r.log).some(l => l.startsWith("typed answered"))).toBe(false);
	});

	test("cancel kills the omp process; the next sign-in runs in a new one", async () => {
		const r = rig();
		await r.send({ t: "auth.login.start", providerId: "anthropic" });
		await until(() => r.flow()?.prompt !== null && r.flow() !== null);
		const first = pidOf(r.log);
		await r.send({ t: "auth.login.cancel", flowId: r.flow()!.id });
		expect(r.flow()?.status).toBe("cancelled");
		await until(() => !alive(first));
		await r.send({ t: "auth.login.dismiss", flowId: r.flow()!.id });
		await r.send({ t: "auth.login.start", providerId: "stencil" });
		await until(() => r.flow()?.status === "succeeded");
		expect(logLines(r.log).filter(l => l.startsWith("start"))).toHaveLength(2);
	});

	test("an omp process that dies during a sign-in fails the flow with that reason", async () => {
		const r = rig();
		await r.send({ t: "auth.login.start", providerId: "anthropic" });
		await until(() => r.flow()?.prompt !== null && r.flow() !== null);
		process.kill(pidOf(r.log), "SIGKILL");
		await until(() => r.flow()?.status === "failed");
		expect(r.flow()?.failure?.message).toContain("omp exited");
	});
});
