import { afterEach, describe, expect, test } from "bun:test";
import type { UsageResponse } from "@oh-my-pi/pi-ai/auth-broker";
import type {
	AccountWire,
	AuthFrame,
	AuthMessage,
	BrokerStatus,
	LoginFlowWire,
	UiResponseBody,
} from "@omp-web/protocol";
import type { AuthProcess, LoginEvent, LoginProviderInfo, LoginRun, LogoutAccountInfo } from "../src/auth-process";
import { AuthService, type BrokerControl } from "../src/auth-service";

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

const HOME = "/srv/omp-web/auth-broker";

function runningStatus(patch: Partial<BrokerStatus> = {}): BrokerStatus {
	return {
		phase: "running",
		healthy: true,
		url: "http://127.0.0.1:8765",
		advertisedUrl: "http://100.64.0.2:8765",
		bind: "127.0.0.1:8765",
		home: HOME,
		agentDb: `${HOME}/.omp/agent/agent.db`,
		tokenFile: `${HOME}/.omp/auth-broker.token`,
		pid: 4242,
		version: "18.19.0",
		startedAt: 1,
		checkedAt: 1,
		restarts: 0,
		nextRetryAt: null,
		lastError: null,
		...patch,
	};
}

class FakeBroker implements BrokerControl {
	token: string | null = "broker-bearer-token";
	url = "http://127.0.0.1:8765";
	advertisedUrl = "http://100.64.0.2:8765";
	#status = runningStatus();
	#listeners = new Set<() => void>();
	status(): BrokerStatus {
		return this.#status;
	}
	set(patch: Partial<BrokerStatus>): void {
		this.#status = { ...this.#status, ...patch };
		for (const l of this.#listeners) l();
	}
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	async stop(): Promise<void> {}
}

interface PendingLogin {
	providerId: string;
	emit(event: LoginEvent): void;
	succeed(): void;
	fail(message: string): void;
	answers: { promptId: string; response: UiResponseBody }[];
}

class FakeProcess implements AuthProcess {
	killed = false;
	logins: PendingLogin[] = [];
	logoutCalls: { providerId: string; credentialId: number }[] = [];
	exitListeners: ((reason: string) => void)[] = [];
	constructor(
		readonly env: Record<string, string | undefined>,
		private readonly world: World,
	) {}
	async providers(): Promise<LoginProviderInfo[]> {
		return this.world.providers;
	}
	async accounts(providerId: string): Promise<LogoutAccountInfo[]> {
		return this.world.accounts[this.world.storedAs(providerId)] ?? [];
	}
	async logout(providerId: string, credentialId: number): Promise<{ remainingSource?: string }> {
		this.logoutCalls.push({ providerId, credentialId });
		const stored = this.world.storedAs(providerId);
		this.world.accounts[stored] = (this.world.accounts[stored] ?? []).filter(a => a.credentialId !== credentialId);
		if (this.world.accounts[stored]!.length === 0) {
			for (const info of this.world.providers)
				if (this.world.storedAs(info.id) === stored) info.authenticated = false;
		}
		return {};
	}
	login(providerId: string, onEvent: (event: LoginEvent) => void): LoginRun {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const login: PendingLogin = {
			providerId,
			emit: onEvent,
			succeed: () => {
				this.world.signedIn(providerId);
				resolve();
			},
			fail: message => reject(new Error(message)),
			answers: [],
		};
		this.logins.push(login);
		return {
			done: promise,
			answer: (promptId, response) => {
				login.answers.push({ promptId, response });
			},
		};
	}
	onExit(listener: (reason: string) => void): void {
		this.exitListeners.push(listener);
	}
	async kill(): Promise<void> {
		this.killed = true;
		for (const login of this.logins) login.fail("Client stopped");
	}
	async stop(): Promise<void> {
		await this.kill();
	}
}

class World {
	providers: LoginProviderInfo[] = [
		{ id: "anthropic", name: "Anthropic (Claude Pro/Max)", available: true, authenticated: false },
		{ id: "kimi-code", name: "Kimi Code", available: true, authenticated: false },
		{ id: "deepseek", name: "DeepSeek", available: true, authenticated: false },
		{ id: "github-copilot", name: "GitHub Copilot", available: true, authenticated: false },
		{ id: "stencil", name: "Stencil", available: true, authenticated: false },
		{ id: "off-provider", name: "Off", available: false, authenticated: false },
		{ id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)", available: true, authenticated: false },
		{
			id: "openai-codex-device",
			name: "ChatGPT Plus/Pro (Codex, headless/device)",
			available: true,
			authenticated: false,
		},
	];
	accounts: Record<string, LogoutAccountInfo[]> = {};
	/** Sign-in aliases and the provider their credentials are stored under (omp's `store-as`). */
	readonly aliases: Record<string, string> = { "openai-codex-device": "openai-codex" };
	nextId = 1;
	disabled: unknown[] = [];
	usage: UsageResponse | "error" = { generatedAt: 5, reports: [] };
	snapshot: unknown[] = [];
	fetchLog: { url: string; auth: string | null }[] = [];
	storedAs(providerId: string): string {
		return this.aliases[providerId] ?? providerId;
	}
	signedIn(providerId: string, label?: string): void {
		const stored = this.storedAs(providerId);
		// every provider that stores under `stored` is authenticated through the one credential, as omp reports it
		for (const info of this.providers) if (this.storedAs(info.id) === stored) info.authenticated = true;
		const id = this.nextId++;
		this.accounts[stored] = [
			...(this.accounts[stored] ?? []),
			{
				credentialId: id,
				provider: stored,
				label: label ?? `user${id}@example.invalid`,
				detail: `oauth #${id}`,
				type: "oauth",
				active: true,
			},
		];
	}
	fetch = async (url: string, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(init?.headers);
		this.fetchLog.push({ url, auth: headers.get("authorization") });
		if (url.endsWith("/v1/credentials/disabled")) return Response.json({ generatedAt: 1, disabled: this.disabled });
		if (url.endsWith("/v1/snapshot")) return Response.json({ credentials: this.snapshot });
		if (url.endsWith("/v1/usage")) {
			return this.usage === "error" ? Response.json({ error: "502" }, { status: 502 }) : Response.json(this.usage);
		}
		return new Response("nope", { status: 404 });
	};
}

class Browser {
	readonly conn = {};
	frames: AuthFrame[];
	constructor(private readonly rig: Rig) {
		this.frames = rig.service.frames();
		rig.browsers.push(this);
	}
	latest<T extends AuthFrame["t"]>(type: T): Extract<AuthFrame, { t: T }> {
		return this.frames.findLast(f => f.t === type) as Extract<AuthFrame, { t: T }>;
	}
	get flow(): LoginFlowWire | null {
		return this.latest("auth.flow").flow;
	}
	send(message: Omit<AuthMessage, "reqId"> & Record<string, unknown>): Promise<unknown> {
		return this.rig.service.handle(this.conn, { ...message, reqId: "r" } as AuthMessage);
	}
	leave(): void {
		this.rig.service.released(this.conn);
		this.rig.browsers.splice(this.rig.browsers.indexOf(this), 1);
	}
}

interface Rig {
	service: AuthService;
	broker: FakeBroker;
	world: World;
	processes: FakeProcess[];
	browsers: Browser[];
	configChanges: { count: number };
	now: { value: number };
}

const rigs: Rig[] = [];
afterEach(async () => {
	for (const rig of rigs.splice(0)) await rig.service.stop();
});

function makeRig(
	options: { disabled?: boolean; localAgentDb?: string | null; tickMs?: number; createDelayMs?: number } = {},
): Rig {
	const broker = new FakeBroker();
	const world = new World();
	const processes: FakeProcess[] = [];
	const browsers: Browser[] = [];
	const configChanges = { count: 0 };
	const now = { value: 1_000_000 };
	const service = new AuthService({
		supervisor: options.disabled ? null : broker,
		selfMachineId: "m_self",
		publish: frame => {
			for (const b of browsers) b.frames.push(frame);
		},
		brokerConfigChanged: () => {
			configChanges.count++;
		},
		createProcess: async env => {
			if (options.createDelayMs) await Bun.sleep(options.createDelayMs);
			const p = new FakeProcess(env, world);
			processes.push(p);
			return p;
		},
		baseEnv: { PATH: "/bin" },
		localAgentDb: options.localAgentDb ?? null,
		userHome: "/home/someone",
		platform: "linux",
		fetch: world.fetch,
		now: () => now.value,
		tickMs: options.tickMs ?? 3_600_000, // no housekeeping unless a test asks for it
	});
	service.start();
	const rig: Rig = { service, broker, world, processes, browsers, configChanges, now };
	rigs.push(rig);
	return rig;
}

const until = async (predicate: () => boolean, ms = 2000): Promise<void> => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await Bun.sleep(5);
	}
};

/** Opens the Accounts page on a browser and waits for the first listing. */
async function openAccounts(rig: Rig, browser: Browser): Promise<void> {
	await browser.send({ t: "auth.watch", open: true });
	await until(() => rig.service.frames().some(f => f.t === "auth.accounts" && f.loadedAt !== null));
}

const accountLabels = (b: Browser): string[] => b.latest("auth.accounts").accounts.map((a: AccountWire) => a.label);

// ---------------------------------------------------------------------------

describe("without a hosted broker", () => {
	test("everything reports `disabled`, and nothing credential-related can be done (with the way to enable it)", async () => {
		const rig = makeRig({ disabled: true });
		const browser = new Browser(rig);
		expect(browser.latest("auth.broker").broker).toMatchObject({ phase: "disabled", url: null });
		expect(rig.service.brokerConfigFor("m_self")).toBeNull();
		await expect(browser.send({ t: "auth.login.start", providerId: "anthropic" })).rejects.toThrow("--broker");
		await expect(browser.send({ t: "auth.refresh" })).rejects.toThrow("not enabled");
		expect(await browser.send({ t: "auth.watch", open: true })).toEqual({});
	});
});

describe("the broker handed to machines", () => {
	test("the gateway machine gets the local address, the others the advertised one; before the token is known, nobody", () => {
		const rig = makeRig();
		rig.broker.token = null;
		expect(rig.service.brokerConfigFor("m_self")).toBeNull();
		rig.broker.token = "broker-bearer-token";
		expect(rig.service.brokerConfigFor("m_self")).toEqual({
			url: "http://127.0.0.1:8765",
			token: "broker-bearer-token",
		});
		expect(rig.service.brokerConfigFor("m_other")).toEqual({
			url: "http://100.64.0.2:8765",
			token: "broker-bearer-token",
		});
	});

	test("the machines are told when the url or token changes, not on every status flap", () => {
		const rig = makeRig();
		rig.broker.set({ pid: 1 }); // first change with a token known: pushed once
		expect(rig.configChanges.count).toBe(1);
		rig.broker.set({ healthy: false });
		rig.broker.set({ healthy: true });
		rig.broker.set({ checkedAt: 9 });
		expect(rig.configChanges.count).toBe(1);
		rig.broker.token = "regenerated";
		rig.broker.set({ restarts: 1 });
		expect(rig.configChanges.count).toBe(2);
	});

	test("broker status changes reach every browser", () => {
		const rig = makeRig();
		const a = new Browser(rig);
		const b = new Browser(rig);
		rig.broker.set({ phase: "restarting", healthy: false, lastError: { message: "exited with code 3", at: 7 } });
		for (const browser of [a, b]) {
			expect(browser.latest("auth.broker").broker).toMatchObject({
				phase: "restarting",
				lastError: { message: "exited with code 3" },
			});
		}
	});
});

describe("providers and accounts", () => {
	test("login timestamps follow durable provider/credential ids without exposing snapshot secrets", async () => {
		const rig = makeRig();
		rig.world.signedIn("anthropic");
		rig.world.snapshot = [
			{
				provider: "anthropic",
				id: 1,
				credential: { authorizedAt: 1234, access: "private-access", refresh: "private-refresh" },
			},
			{ provider: "other", id: 1, credential: { authorizedAt: 9999 } },
		];
		const browser = new Browser(rig);
		await openAccounts(rig, browser);
		const frame = browser.latest("auth.accounts");
		expect(frame.accounts[0]?.authorizedAt).toBe(1234);
		expect(JSON.stringify(frame)).not.toContain("private-");
	});

	test("opening the Accounts page lists providers (with how they sign in) and the accounts omp reports, for every browser", async () => {
		const rig = makeRig();
		rig.world.signedIn("anthropic");
		const a = new Browser(rig);
		const b = new Browser(rig);
		await openAccounts(rig, a);
		for (const browser of [a, b]) {
			const frame = browser.latest("auth.accounts");
			expect(frame.error).toBeNull();
			expect(frame.providers?.find(p => p.id === "anthropic")).toMatchObject({ kind: "oauth", authenticated: true });
			expect(frame.providers?.find(p => p.id === "kimi-code")?.kind).toBe("device");
			expect(frame.providers?.find(p => p.id === "stencil")?.kind).toBe("oauth");
			expect(frame.accounts).toEqual([
				{
					provider: "anthropic",
					providerName: "Anthropic (Claude Pro/Max)",
					credentialId: 1,
					label: "user1@example.invalid",
					detail: "oauth #1",
					type: "oauth",
					active: true,
				},
			]);
		}
	});

	test("the omp process for credential work gets the broker's URL and token in its environment", async () => {
		const rig = makeRig();
		await openAccounts(rig, new Browser(rig));
		expect(rig.processes).toHaveLength(1);
		expect(rig.processes[0]!.env).toMatchObject({
			PATH: "/bin",
			OMP_AUTH_BROKER_URL: "http://127.0.0.1:8765",
			OMP_AUTH_BROKER_TOKEN: "broker-bearer-token",
		});
	});

	test("API-key providers carry the exact terminal command, with the broker's HOME in front when its state is not the user's own", async () => {
		const rig = makeRig();
		await openAccounts(rig, new Browser(rig));
		const providers = rig.browsers[0]!.latest("auth.accounts").providers!;
		expect(providers.find(p => p.id === "deepseek")).toMatchObject({
			kind: "api-key",
			terminalCommand: `HOME='${HOME}' omp auth-broker login deepseek`,
		});
		expect(providers.find(p => p.id === "github-copilot")).toMatchObject({ kind: "custom" });
		expect(providers.find(p => p.id === "anthropic")?.terminalCommand).toBeUndefined();
	});

	test("a credential the broker disabled shows up with its cause, so the user knows to sign in again", async () => {
		const rig = makeRig();
		rig.world.disabled = [
			{
				id: 9,
				provider: "anthropic",
				type: "oauth",
				email: "gone@example.invalid",
				orgName: "Team",
				cause: "refresh token revoked",
				disabledAtMs: 55,
			},
			{ nonsense: true },
		];
		await openAccounts(rig, new Browser(rig));
		expect(rig.browsers[0]!.latest("auth.accounts").disabled).toEqual([
			{
				provider: "Anthropic (Claude Pro/Max)",
				type: "oauth",
				label: "gone@example.invalid (Team)",
				cause: "refresh token revoked",
				disabledAt: 55,
			},
		]);
		expect(rig.world.fetchLog.every(r => r.auth === "Bearer broker-bearer-token")).toBe(true);
	});

	test("when the broker is down the listing says so instead of showing an empty list, and the old list is kept", async () => {
		const rig = makeRig();
		rig.world.signedIn("anthropic");
		const browser = new Browser(rig);
		await openAccounts(rig, browser);
		rig.broker.set({ phase: "restarting", healthy: false, lastError: { message: "killed by SIGKILL", at: 1 } });
		await expect(browser.send({ t: "auth.refresh" })).rejects.toThrow("not running (restarting: killed by SIGKILL)");
		expect(browser.latest("auth.accounts").error).toContain("not running");
		expect(accountLabels(browser)).toEqual(["user1@example.invalid"]);
	});

	test("the omp process is dropped when the broker goes away and started afresh when it is back", async () => {
		const rig = makeRig();
		const browser = new Browser(rig);
		await openAccounts(rig, browser);
		rig.broker.set({ phase: "restarting", healthy: false });
		await until(() => rig.processes[0]!.killed);
		rig.broker.set({ phase: "running", healthy: true });
		await until(() => rig.processes.length === 2); // reopened by the Accounts page that is still open
		await until(() => browser.latest("auth.accounts").error === null);
	});

	test("one stored credential reached through a sign-in alias is listed once, under the provider it is stored as", async () => {
		const rig = makeRig();
		rig.world.signedIn("openai-codex-device", "codex@example.invalid");
		const browser = new Browser(rig);
		await openAccounts(rig, browser);
		const frame = browser.latest("auth.accounts");
		// both ways to sign in stay offered, and both read as signed in
		expect(frame.providers?.filter(p => p.id.startsWith("openai-codex")).map(p => [p.id, p.authenticated])).toEqual([
			["openai-codex", true],
			["openai-codex-device", true],
		]);
		expect(frame.accounts).toEqual([
			{
				provider: "openai-codex",
				providerName: "ChatGPT Plus/Pro (Codex Subscription)",
				credentialId: 1,
				label: "codex@example.invalid",
				detail: "oauth #1",
				type: "oauth",
				active: true,
			},
		]);
	});

	test("distinct credentials of one stored provider all stay, whichever alias signed them in", async () => {
		const rig = makeRig();
		rig.world.signedIn("openai-codex", "work@example.invalid");
		rig.world.signedIn("openai-codex-device", "home@example.invalid");
		rig.world.signedIn("anthropic", "claude@example.invalid");
		const browser = new Browser(rig);
		await openAccounts(rig, browser);
		expect(
			browser.latest("auth.accounts").accounts.map((a: AccountWire) => [a.provider, a.credentialId, a.label]),
		).toEqual([
			["anthropic", 3, "claude@example.invalid"],
			["openai-codex", 1, "work@example.invalid"],
			["openai-codex", 2, "home@example.invalid"],
		]);
	});
});

describe("signing in", () => {
	test("the sign-in link reaches every browser as a link (http(s) as omp gave it), with omp's instructions and progress", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		const b = new Browser(rig);
		await openAccounts(rig, a);
		const ack = (await a.send({ t: "auth.login.start", providerId: "anthropic" })) as { flowId: string };
		expect(a.flow).toMatchObject({ id: ack.flowId, providerId: "anthropic", status: "running", link: null });
		const login = rig.processes[0]!.logins[0]!;
		login.emit({
			kind: "link",
			url: "https://claude.ai/oauth/authorize?code_challenge=x",
			launchUrl: "http://localhost:54545/launch",
			instructions: "Complete login in your browser.",
		});
		login.emit({ kind: "progress", level: "info", message: "Waiting for browser authentication..." });
		for (const browser of [a, b]) {
			expect(browser.flow).toMatchObject({
				status: "running",
				link: {
					url: "https://claude.ai/oauth/authorize?code_challenge=x",
					launchUrl: "http://localhost:54545/launch",
					instructions: "Complete login in your browser.",
				},
				progress: ["Waiting for browser authentication..."],
			});
		}
	});

	test("the callback path: omp finishes by itself, the flow succeeds with the account it stored, and the account list is already updated", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		const b = new Browser(rig);
		await openAccounts(rig, a);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		const login = rig.processes[0]!.logins[0]!;
		login.emit({ kind: "link", url: "https://claude.ai/oauth/authorize" });
		login.succeed();
		await until(() => b.flow?.status === "succeeded");
		expect(b.flow).toMatchObject({ status: "succeeded", identity: "user1@example.invalid", prompt: null });
		expect(b.flow?.endedAt).not.toBeNull();
		expect(accountLabels(b)).toEqual(["user1@example.invalid"]);
		// any client may clear the finished flow, for all of them
		await b.send({ t: "auth.login.dismiss", flowId: b.flow!.id });
		expect(a.flow).toBeNull();
		expect(b.flow).toBeNull();
	});

	test("a sign-in through an alias succeeds with the new credential, which omp stores under the target provider", async () => {
		const rig = makeRig();
		rig.world.signedIn("openai-codex", "work@example.invalid");
		const a = new Browser(rig);
		await openAccounts(rig, a);
		await a.send({ t: "auth.login.start", providerId: "openai-codex-device" });
		rig.processes[0]!.logins[0]!.succeed();
		await until(() => a.flow?.status === "succeeded");
		expect(a.flow).toMatchObject({ providerId: "openai-codex-device", identity: "user2@example.invalid" });
		expect(accountLabels(a)).toEqual(["work@example.invalid", "user2@example.invalid"]);
	});

	test("the manual path: the authorization-code prompt appears for everyone; the first answer wins and reaches omp as typed", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		const b = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		const login = rig.processes[0]!.logins[0]!;
		login.emit({ kind: "link", url: "https://claude.ai/oauth/authorize" });
		login.emit({
			kind: "prompt",
			id: "ui-1",
			title: "Paste the authorization code (or full redirect URL):",
			secret: false,
		});
		const flowId = a.flow!.id;
		expect(b.flow?.prompt).toEqual({
			id: "ui-1",
			title: "Paste the authorization code (or full redirect URL):",
			placeholder: undefined,
			submitted: false,
		});
		const redirect = "http://localhost:54545/callback?code=abc&state=xyz";
		const results = await Promise.allSettled([
			a.send({ t: "auth.login.input", flowId, promptId: "ui-1", value: `  ${redirect}  ` }),
			b.send({ t: "auth.login.input", flowId, promptId: "ui-1", value: "someone-elses-code" }),
		]);
		expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.message).toContain(
			"already submitted",
		);
		expect(login.answers).toEqual([{ promptId: "ui-1", response: { value: redirect } }]);
		expect(b.flow?.prompt?.submitted).toBe(true);
		login.succeed();
		await until(() => a.flow?.status === "succeeded");
	});

	test("an answer for another flow, another prompt, an ended flow, or nothing is refused", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		const login = rig.processes[0]!.logins[0]!;
		const flowId = a.flow!.id;
		await expect(a.send({ t: "auth.login.input", flowId, promptId: "ui-1", value: "x" })).rejects.toThrow(
			"not asking for anything",
		);
		login.emit({ kind: "link", url: "https://claude.ai/oauth/authorize" });
		login.emit({ kind: "prompt", id: "ui-1", title: "Paste", secret: false });
		await expect(a.send({ t: "auth.login.input", flowId: "stale", promptId: "ui-1", value: "x" })).rejects.toThrow(
			"no longer the current",
		);
		await expect(a.send({ t: "auth.login.input", flowId, promptId: "ui-9", value: "x" })).rejects.toThrow(
			"not asking for anything",
		);
		await expect(a.send({ t: "auth.login.input", flowId, promptId: "ui-1", value: "   " })).rejects.toThrow("paste");
		expect(login.answers).toEqual([]);
		await a.send({ t: "auth.login.cancel", flowId });
		await expect(a.send({ t: "auth.login.input", flowId, promptId: "ui-1", value: "x" })).rejects.toThrow(
			"already ended",
		);
	});

	test("cancel from any browser ends the flow for all, drops the omp process, and a new sign-in can start", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		const b = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		rig.processes[0]!.logins[0]!.emit({ kind: "link", url: "https://claude.ai/oauth/authorize" });
		const flowId = a.flow!.id;
		await b.send({ t: "auth.login.cancel", flowId });
		for (const browser of [a, b]) expect(browser.flow).toMatchObject({ status: "cancelled", prompt: null });
		expect(rig.processes[0]!.killed).toBe(true);
		// the cancelled login's rejection ("Client stopped") must not turn the outcome into a failure
		await Bun.sleep(30);
		expect(a.flow?.status).toBe("cancelled");
		// cancelling again is harmless (two tabs clicked at once)
		await a.send({ t: "auth.login.cancel", flowId });
		await a.send({ t: "auth.login.dismiss", flowId });
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		expect(rig.processes).toHaveLength(2); // a fresh process: the killed one is not reused
		expect(a.flow?.status).toBe("running");
	});

	test("a list refresh that runs while a sign-in is starting does not replace the process the sign-in is about to use", async () => {
		const rig = makeRig({ createDelayMs: 60 });
		const a = new Browser(rig);
		await openAccounts(rig, a);
		for (const listener of rig.processes[0]!.exitListeners) listener("omp exited"); // the idle process died: the next use starts one
		const first = rig.processes.length;
		const starting = a.send({ t: "auth.login.start", providerId: "anthropic" });
		await Bun.sleep(10); // the sign-in is waiting for its process; a refresh arrives now
		const refreshing = a.send({ t: "auth.refresh" });
		await Promise.all([starting, refreshing]);
		const login = rig.processes.flatMap(p => p.logins)[0]!;
		expect(rig.processes.filter(p => p.killed && p.logins.length > 0)).toEqual([]);
		login.emit({ kind: "link", url: "https://claude.ai/oauth/authorize" });
		expect(a.flow).toMatchObject({ status: "running", link: { url: "https://claude.ai/oauth/authorize" } });
		expect(rig.processes.length).toBeGreaterThanOrEqual(first);
	});

	test("one sign-in at a time: a second start is refused while one runs, and says which", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		const b = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		await expect(b.send({ t: "auth.login.start", providerId: "stencil" })).rejects.toThrow(
			"sign-in for Anthropic (Claude Pro/Max) is already in progress",
		);
		await expect(b.send({ t: "auth.login.dismiss", flowId: a.flow!.id })).rejects.toThrow("cancel it first");
		rig.processes[0]!.logins[0]!.succeed();
		await until(() => a.flow?.status === "succeeded");
		await b.send({ t: "auth.login.start", providerId: "stencil" }); // a finished flow does not block the next one
		expect(b.flow).toMatchObject({ providerId: "stencil", status: "running" });
	});

	test("the flow survives a browser reconnecting: a new connection starts with the running flow and can answer it", async () => {
		const rig = makeRig();
		const first = new Browser(rig);
		await first.send({ t: "auth.login.start", providerId: "anthropic" });
		const login = rig.processes[0]!.logins[0]!;
		login.emit({ kind: "link", url: "https://claude.ai/oauth/authorize?s=1" });
		login.emit({ kind: "prompt", id: "ui-1", title: "Paste", secret: false });
		first.leave(); // the tab closes or its socket drops
		const second = new Browser(rig);
		expect(second.flow).toMatchObject({
			status: "running",
			link: { url: "https://claude.ai/oauth/authorize?s=1" },
			prompt: { id: "ui-1", submitted: false },
		});
		await second.send({
			t: "auth.login.input",
			flowId: second.flow!.id,
			promptId: "ui-1",
			value: "code-from-second-tab",
		});
		expect(login.answers).toEqual([{ promptId: "ui-1", response: { value: "code-from-second-tab" } }]);
	});

	test("a provider error is shown as omp reported it", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		rig.processes[0]!.logins[0]!.fail("anthropic token exchange failed: 400 Invalid code");
		await until(() => a.flow?.status === "failed");
		expect(a.flow?.failure).toEqual({
			kind: "provider",
			message: "anthropic token exchange failed: 400 Invalid code",
		});
	});

	test("a provider that is not available, or unknown, cannot be started", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		await expect(a.send({ t: "auth.login.start", providerId: "off-provider" })).rejects.toThrow("not available");
		await expect(a.send({ t: "auth.login.start", providerId: "nope" })).rejects.toThrow("unknown provider");
	});

	test("the broker dying during a sign-in fails it with that cause and leaves nothing running", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		rig.broker.set({ phase: "restarting", healthy: false, lastError: { message: "killed by SIGKILL", at: 1 } });
		expect(a.flow).toMatchObject({ status: "failed", failure: { kind: "broker" } });
		expect(a.flow?.failure?.message).toContain("killed by SIGKILL");
		await until(() => rig.processes[0]!.killed);
	});

	test("a sign-in that fails while the broker is unreachable says the vault is the problem", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		rig.broker.set({ healthy: false }); // still `running` for the supervisor, but not answering
		rig.processes[0]!.logins[0]!.fail("fetch failed");
		await until(() => a.flow?.status === "failed");
		expect(a.flow?.failure?.kind).toBe("broker");
	});
});

describe("secrets are never accepted through the web", () => {
	test("a provider that signs in with a pasted API key cannot be started at all; the answer is the exact command to run", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		const error = await a.send({ t: "auth.login.start", providerId: "deepseek" }).then(
			() => null,
			(e: Error) => e,
		);
		expect(error?.message).toContain("does not accept through the browser");
		expect(error?.message).toContain(`HOME='${HOME}' omp auth-broker login deepseek`);
		expect(a.flow).toBeNull();
		expect(rig.processes.every(p => p.logins.length === 0)).toBe(true);
	});

	test("a prompt marked secret ends the flow at once with the command to run, is never shown, and the process is dropped", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		const b = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		const login = rig.processes[0]!.logins[0]!;
		login.emit({ kind: "link", url: "https://claude.ai/oauth/authorize" });
		login.emit({ kind: "prompt", id: "ui-1", title: "Enter your password", secret: true });
		for (const browser of [a, b]) {
			expect(browser.flow).toMatchObject({
				status: "failed",
				prompt: null,
				failure: { kind: "secret_input", terminalCommand: `HOME='${HOME}' omp auth-broker login anthropic` },
			});
		}
		await until(() => rig.processes[0]!.killed);
		await expect(
			a.send({ t: "auth.login.input", flowId: a.flow!.id, promptId: "ui-1", value: "hunter2" }),
		).rejects.toThrow("already ended");
		expect(login.answers).toEqual([]);
		expect(JSON.stringify(b.frames)).not.toContain("hunter2");
	});

	test("a non-secret input prompt before any sign-in link (nothing it could be an authorization code for) is refused", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		rig.processes[0]!.logins[0]!.emit({ kind: "prompt", id: "ui-1", title: "Paste your API key", secret: false });
		expect(a.flow).toMatchObject({ status: "failed", failure: { kind: "secret_input" } });
		expect(a.flow?.prompt).toBeNull();
	});

	test("a provider whose sign-in is not an OAuth code flow gets no input field: an input prompt there is refused even after a link", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "github-copilot" }); // `custom`
		const login = rig.processes[0]!.logins[0]!;
		login.emit({ kind: "link", url: "https://github.com/login/device" });
		login.emit({
			kind: "prompt",
			id: "ui-1",
			title: "GitHub Enterprise URL/domain (blank for github.com)",
			secret: false,
		});
		expect(a.flow).toMatchObject({ status: "failed", failure: { kind: "secret_input" } });
		expect(a.flow?.failure?.message).toContain("does not accept API keys or other secrets");
	});

	test("a device-code sign-in works without any input at all", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "kimi-code" });
		const login = rig.processes[0]!.logins[0]!;
		login.emit({
			kind: "link",
			url: "https://auth.kimi.com/device?user_code=ABCD",
			instructions: "Enter code: ABCD",
		});
		expect(a.flow).toMatchObject({ status: "running", link: { instructions: "Enter code: ABCD" } });
		login.succeed();
		await until(() => a.flow?.status === "succeeded");
	});

	test("any other interactive request (select, confirm, …) cannot be carried and ends the flow", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		rig.processes[0]!.logins[0]!.emit({ kind: "unsupported", method: "select" });
		expect(a.flow).toMatchObject({ status: "failed", failure: { kind: "unsupported" } });
	});

	test("omp's own refusal (RPC rejects secret and pre-link prompts) is mapped to the same guidance", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		await a.send({ t: "auth.login.start", providerId: "anthropic" });
		rig.processes[0]!.logins[0]!.fail(
			"Provider 'anthropic' requires secret input, which is not supported in RPC mode. Use the terminal UI to log in.",
		);
		await until(() => a.flow?.status === "failed");
		expect(a.flow?.failure).toMatchObject({
			kind: "secret_input",
			terminalCommand: `HOME='${HOME}' omp auth-broker login anthropic`,
		});
		await a.send({ t: "auth.login.dismiss", flowId: a.flow!.id });
		await a.send({ t: "auth.login.start", providerId: "github-copilot" });
		rig.processes[1]!.logins[0]!.fail(
			"Provider 'github-copilot' requires interactive prompts which are not supported in RPC mode.",
		);
		await until(() => a.flow?.status === "failed");
		expect(a.flow?.failure?.kind).toBe("unsupported");
	});
});

describe("logging out", () => {
	test("removes the account through omp (so the broker), updates the list for everyone, and never accepts an account not on the list", async () => {
		const rig = makeRig();
		rig.world.signedIn("anthropic");
		const a = new Browser(rig);
		const b = new Browser(rig);
		await openAccounts(rig, a);
		await expect(a.send({ t: "auth.logout", providerId: "anthropic", credentialId: 99 })).rejects.toThrow(
			"not in the list",
		);
		await a.send({ t: "auth.logout", providerId: "anthropic", credentialId: 1 });
		expect(rig.processes[0]!.logoutCalls).toEqual([{ providerId: "anthropic", credentialId: 1 }]);
		expect(accountLabels(b)).toEqual([]);
		expect(b.latest("auth.accounts").providers?.find(p => p.id === "anthropic")?.authenticated).toBe(false);
	});

	test("an account reached through an alias is removed once, as the provider it is listed under", async () => {
		const rig = makeRig();
		rig.world.signedIn("openai-codex-device", "codex@example.invalid");
		const a = new Browser(rig);
		await openAccounts(rig, a);
		await a.send({ t: "auth.logout", providerId: "openai-codex", credentialId: 1 });
		expect(rig.processes[0]!.logoutCalls).toEqual([{ providerId: "openai-codex", credentialId: 1 }]);
		const frame = a.latest("auth.accounts");
		expect(frame.accounts).toEqual([]);
		expect(frame.providers?.filter(p => p.id.startsWith("openai-codex")).map(p => p.authenticated)).toEqual([
			false,
			false,
		]);
	});

	test("is refused while a sign-in is in progress", async () => {
		const rig = makeRig();
		rig.world.signedIn("anthropic");
		const a = new Browser(rig);
		await openAccounts(rig, a);
		await a.send({ t: "auth.login.start", providerId: "stencil" });
		await expect(a.send({ t: "auth.logout", providerId: "anthropic", credentialId: 1 })).rejects.toThrow(
			"sign-in is in progress",
		);
	});
});

describe("usage", () => {
	const sample: UsageResponse = {
		generatedAt: 1234,
		reports: [
			{
				provider: "anthropic",
				fetchedAt: 1200,
				limits: [
					{
						id: "anthropic:5h",
						label: "Claude 5 Hour",
						scope: { provider: "anthropic", windowId: "5h", shared: true },
						window: { id: "5h", label: "5 Hour", resetsAt: 99_000 },
						amount: { used: 42, limit: 100, unit: "percent", usedFraction: 0.42 },
						status: "ok",
					},
				],
				metadata: { email: "user1@example.invalid" },
			},
		],
	};

	test("the broker's /v1/usage answer reaches every browser, requested with the bearer token", async () => {
		const rig = makeRig();
		rig.world.usage = sample;
		const a = new Browser(rig);
		const b = new Browser(rig);
		expect(await a.send({ t: "auth.usage.refresh" })).toEqual({ refreshed: true });
		for (const browser of [a, b]) {
			const usage = browser.latest("auth.usage");
			expect(usage.error).toBeNull();
			expect(usage.generatedAt).toBe(1234);
			expect(usage.reports[0]).toMatchObject({ provider: "anthropic", identity: "user1@example.invalid" });
			expect(usage.reports[0]!.limits[0]).toMatchObject({
				id: "anthropic:5h",
				windowLabel: "5 Hour",
				resetsAt: 99_000,
				usedFraction: 0.42,
				status: "ok",
				unit: "percent",
			});
		}
		expect(rig.world.fetchLog.at(-1)).toEqual({
			url: "http://127.0.0.1:8765/v1/usage",
			auth: "Bearer broker-bearer-token",
		});
	});

	test("refreshing is rate limited: a second request within the minimum interval does not reach the broker", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		await a.send({ t: "auth.usage.refresh" });
		const calls = rig.world.fetchLog.filter(r => r.url.endsWith("/v1/usage")).length;
		rig.now.value += 5_000;
		expect(await a.send({ t: "auth.usage.refresh" })).toMatchObject({ refreshed: false, retryInMs: 10_000 });
		expect(rig.world.fetchLog.filter(r => r.url.endsWith("/v1/usage")).length).toBe(calls);
		rig.now.value += 10_001;
		expect(await a.send({ t: "auth.usage.refresh" })).toEqual({ refreshed: true });
	});

	test("a failing broker keeps the last reports and reports the error", async () => {
		const rig = makeRig();
		const a = new Browser(rig);
		rig.world.usage = sample;
		await a.send({ t: "auth.usage.refresh" });
		rig.world.usage = "error";
		rig.now.value += 60_000;
		await a.send({ t: "auth.usage.refresh" });
		const usage = a.latest("auth.usage");
		expect(usage.error).toContain("HTTP 502");
		expect(usage.reports).toHaveLength(1);
	});

	test("nothing is requested from the broker while no browser has the Accounts page open; while one does, at the bounded rate", async () => {
		const rig = makeRig({ tickMs: 10 });
		rig.world.usage = sample;
		await Bun.sleep(60); // (real time: the housekeeping timer only exists while a page is open)
		expect(rig.world.fetchLog).toEqual([]);
		const a = new Browser(rig);
		await a.send({ t: "auth.watch", open: true });
		await until(() => rig.world.fetchLog.some(r => r.url.endsWith("/v1/usage")));
		const afterOpen = rig.world.fetchLog.filter(r => r.url.endsWith("/v1/usage")).length;
		expect(afterOpen).toBe(1);
		await Bun.sleep(80); // many ticks, but the clock has not moved past the refresh periods
		expect(rig.world.fetchLog.filter(r => r.url.endsWith("/v1/usage")).length).toBe(afterOpen);
		rig.now.value += 301_000; // five minutes later the next tick refreshes it, once
		await until(() => rig.world.fetchLog.filter(r => r.url.endsWith("/v1/usage")).length === afterOpen + 1);
		a.leave();
		const before = rig.world.fetchLog.length;
		rig.now.value += 1_000_000;
		await Bun.sleep(80);
		expect(rig.world.fetchLog).toHaveLength(before); // the page closed: the timer stopped
	});
});
