import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccountWire, Ack, MigrationWire, UsageWire } from "@omp-web/protocol";
import { AccountsPanel } from "../src/components/accounts-panel";
import { Banners } from "../src/components/banners";
import { type AuthRequest, type AuthViewState, DaemonClient, EMPTY_AUTH } from "../src/store/daemon-client";
import { type FakeDom, installFakeDom, makeEvent } from "./fake-dom";
import { brokerStatus, loginFlow, machineSummary } from "./fixtures";

class RecordingClient extends DaemonClient {
	requests: AuthRequest[] = [];
	watched: boolean[] = [];
	next: Ack | ((request: AuthRequest) => Ack) = { t: "ack", reqId: "", ok: true };
	override authRequest(request: AuthRequest): Promise<Ack> {
		this.requests.push(request);
		return Promise.resolve(typeof this.next === "function" ? this.next(request) : this.next);
	}
	override setAccountsOpen(open: boolean): void {
		this.watched.push(open);
	}
}

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

const noop = (): void => {};
const anthropic = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	available: true,
	authenticated: true,
	kind: "oauth" as const,
};
const deepseek = {
	id: "deepseek",
	name: "DeepSeek",
	available: true,
	authenticated: false,
	kind: "api-key" as const,
	terminalCommand: "HOME='/srv/omp-web/auth-broker' omp auth-broker login deepseek",
};
const kimi = { id: "kimi-code", name: "Kimi Code", available: true, authenticated: false, kind: "device" as const };
const mine: AccountWire = {
	provider: "anthropic",
	providerName: "Anthropic (Claude Pro/Max)",
	credentialId: 3,
	label: "me@example.invalid",
	detail: "account acct-1 · oauth #3",
	type: "oauth",
	active: true,
};

function auth(patch: Partial<AuthViewState> = {}): AuthViewState {
	return {
		...EMPTY_AUTH,
		broker: brokerStatus(),
		accounts: {
			providers: [anthropic, deepseek, kimi],
			accounts: [mine],
			disabled: [],
			error: null,
			loadedAt: 1,
			migration: null,
		},
		...patch,
	};
}

const mountPanel = (
	client: RecordingClient,
	state: AuthViewState,
	machines = [machineSummary({ id: "home", name: "Home", gateway: true })],
) => dom.mount(<AccountsPanel client={client} auth={state} machines={machines} onClose={noop} />);

const submit = (view: Awaited<ReturnType<typeof mountPanel>>, selector: string): Promise<void> =>
	view.act(() => {
		view.query(selector)!.dispatchEvent(makeEvent("submit"));
	});

describe("AccountsPanel: the broker", () => {
	test("tells the gateway the page is open while mounted and closed when it goes away", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await mountPanel(client, auth());
		expect(client.watched).toEqual([true]);
		await view.unmount();
		expect(client.watched).toEqual([true, false]);
	});

	test("a disabled broker explains how to turn it on and offers nothing to do", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await mountPanel(
			client,
			auth({ broker: brokerStatus({ phase: "disabled", url: null, pid: null }) }),
		);
		expect(view.query("[data-section='broker'][data-phase='disabled']")).not.toBeNull();
		expect(view.container.textContent).toContain("--broker");
		expect(view.query("[data-section='providers']")).toBeNull();
		expect(view.query("[data-section='accounts']")).toBeNull();
		await view.unmount();
	});

	test("a running broker shows where its state lives (never the token) and each machine's view of it", async () => {
		const client = new RecordingClient("ws://x/ws");
		const machines = [
			machineSummary({
				id: "home",
				name: "Home",
				gateway: true,
				broker: { source: "gateway", state: "ok", checkedAt: 1, lastOkAt: 1 },
			}),
			machineSummary({
				id: "lap",
				name: "Laptop",
				broker: {
					source: "gateway",
					state: "unreachable",
					message: "connection refused",
					url: "http://100.64.0.2:8765",
					checkedAt: 1,
					lastOkAt: 1,
				},
			}),
			machineSummary({ id: "off", name: "Desk", online: false }),
		];
		const view = await mountPanel(client, auth(), machines);
		const text = view.container.textContent ?? "";
		expect(text).toContain("/srv/omp-web/auth-broker/.omp");
		expect(text).toContain("auth-broker.token");
		expect(view.query("[data-machine='home']")?.getAttribute("data-broker-state")).toBe("ok");
		expect(view.query("[data-machine='lap']")?.getAttribute("data-broker-state")).toBe("unreachable");
		expect(view.query("[data-machine='lap']")?.textContent).toContain("cannot reach the auth broker");
		expect(view.query("[data-machine='off']")?.getAttribute("data-broker-state")).toBe("offline");
		await view.unmount();
	});

	test("a broker that died says so with its restart", async () => {
		const client = new RecordingClient("ws://x/ws");
		const down = brokerStatus({
			phase: "restarting",
			healthy: false,
			pid: null,
			nextRetryAt: Date.now() + 3000,
			lastError: { message: "killed by SIGKILL", at: Date.now() },
		});
		const view = await mountPanel(client, auth({ broker: down }));
		expect(view.query("[data-section='broker']")?.getAttribute("data-phase")).toBe("restarting");
		expect(view.container.textContent).toContain("Down — restarting");
		expect(view.container.textContent).toContain("killed by SIGKILL");
		await view.unmount();
	});
});

describe("AccountsPanel: signing in", () => {
	test("API-key providers get no button, only the exact command to run on the gateway; the others get Sign in", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await mountPanel(client, auth());
		expect(view.query("[data-provider='deepseek'] [data-action='signin']")).toBeNull();
		expect(view.query("[data-provider='deepseek'] .acct-command code")?.textContent).toBe(
			"HOME='/srv/omp-web/auth-broker' omp auth-broker login deepseek",
		);
		expect(view.query("[data-provider='deepseek']")?.textContent).toContain(
			"does not accept secrets through the browser",
		);
		expect(view.query("[data-provider='kimi-code'] [data-action='signin']")).not.toBeNull();
		expect(view.query("[data-provider='anthropic'] [data-action='signin']")?.textContent).toBe("Add another");
		await view.unmount();
	});

	test("Sign in sends auth.login.start for that provider and shows a refusal where it happened", async () => {
		const client = new RecordingClient("ws://x/ws");
		client.next = { t: "ack", reqId: "", ok: false, error: "a sign-in for Kimi is already in progress" };
		const view = await mountPanel(client, auth());
		await view.click("[data-provider='kimi-code'] [data-action='signin']");
		expect(client.requests).toEqual([{ t: "auth.login.start", providerId: "kimi-code" }]);
		await view.until(() => view.query("[data-section='providers'] .form-error") !== null);
		expect(view.query("[data-section='providers'] .form-error")?.textContent).toContain("already in progress");
		await view.unmount();
	});

	test("the sign-in link is a link the user clicks: http(s) only, new tab, no opener; nothing navigates by itself", async () => {
		const client = new RecordingClient("ws://x/ws");
		const flow = loginFlow({
			link: {
				url: "https://claude.ai/oauth/authorize?code_challenge=abc&state=s",
				instructions: "Complete login in your browser.",
			},
		});
		const view = await mountPanel(client, auth({ flow }));
		const link = view.query("a[data-role='signin-link']")!;
		expect(link.getAttribute("href")).toBe("https://claude.ai/oauth/authorize?code_challenge=abc&state=s");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(view.query("[role='dialog'][aria-modal='true'] a[data-role='signin-link']")).not.toBeNull();
		expect(view.container.textContent).toContain("Complete login in your browser.");
		expect(client.requests).toEqual([]); // rendering a link sent nothing and clicked nothing
		await view.unmount();
	});

	test("a link that is not http(s) never becomes an anchor (defence in depth: the gateway already refuses it)", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await mountPanel(client, auth({ flow: loginFlow({ link: { url: "javascript:alert(1)" } }) }));
		expect(view.query("a[data-role='signin-link']")).toBeNull();
		expect(view.queryAll("a").filter(a => (a.getAttribute("href") ?? "").startsWith("javascript:"))).toEqual([]);
		expect(view.container.textContent).not.toContain("javascript:");
		await view.unmount();
	});

	test("the authorization-code field sends auth.login.input with the flow's and the prompt's ids, trimmed by the gateway, and clears", async () => {
		const client = new RecordingClient("ws://x/ws");
		const flow = loginFlow({
			link: { url: "https://claude.ai/oauth/authorize" },
			prompt: { id: "ui-7", title: "Paste the authorization code (or full redirect URL):", submitted: false },
		});
		const view = await mountPanel(client, auth({ flow }));
		expect(view.query("[data-role='code-form']")?.getAttribute("data-submitted")).toBe("false");
		await view.type("input[name='code']", "http://localhost:54545/callback?code=abc&state=xyz");
		await submit(view, "[data-role='code-form']");
		expect(client.requests).toEqual([
			{
				t: "auth.login.input",
				flowId: "flow-1",
				promptId: "ui-7",
				value: "http://localhost:54545/callback?code=abc&state=xyz",
			},
		]);
		await view.until(() => (view.query("input[name='code']") as { value?: string } | null)?.value === "");
		await view.unmount();
	});

	test("an empty field sends nothing; once somebody submitted, the field gives way to a waiting line for everyone", async () => {
		const client = new RecordingClient("ws://x/ws");
		const open = loginFlow({
			link: { url: "https://x.invalid/a" },
			prompt: { id: "ui-7", title: "Paste", submitted: false },
		});
		const view = await mountPanel(client, auth({ flow: open }));
		await submit(view, "[data-role='code-form']");
		expect(client.requests).toEqual([]);
		await view.rerender(
			<AccountsPanel
				client={client}
				auth={auth({ flow: { ...open, prompt: { id: "ui-7", title: "Paste", submitted: true } } })}
				machines={[]}
				onClose={noop}
			/>,
		);
		expect(view.query("input[name='code']")).toBeNull();
		expect(view.query("[data-role='code-form']")?.getAttribute("data-submitted")).toBe("true");
		expect(view.container.textContent).toContain("waiting for the provider");
		await view.unmount();
	});

	test("a refused answer (somebody else was first) is shown and the field stays", async () => {
		const client = new RecordingClient("ws://x/ws");
		client.next = { t: "ack", reqId: "", ok: false, error: "somebody already submitted the code for this sign-in" };
		const flow = loginFlow({
			link: { url: "https://x.invalid/a" },
			prompt: { id: "ui-7", title: "Paste", submitted: false },
		});
		const view = await mountPanel(client, auth({ flow }));
		await view.type("input[name='code']", "late");
		await submit(view, "[data-role='code-form']");
		await view.until(() => view.query(".acct-flow .form-error") !== null);
		expect(view.query(".acct-flow .form-error")?.textContent).toContain("already submitted");
		await view.unmount();
	});

	test("cancel and dismiss send the flow id; the buttons depend on whether it still runs", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await mountPanel(client, auth({ flow: loginFlow() }));
		expect(view.container.textContent).toContain("Waiting for omp to produce the sign-in link");
		await view.click(".acct-actions button");
		expect(client.requests).toEqual([{ t: "auth.login.cancel", flowId: "flow-1" }]);
		await view.rerender(
			<AccountsPanel
				client={client}
				auth={auth({ flow: loginFlow({ status: "cancelled", endedAt: 5 }) })}
				machines={[]}
				onClose={noop}
			/>,
		);
		expect(view.query("[data-section='flow']")?.getAttribute("data-status")).toBe("cancelled");
		await view.click(".acct-actions button");
		expect(client.requests.at(-1)).toEqual({ t: "auth.login.dismiss", flowId: "flow-1" });
		await view.unmount();
	});

	test("while a sign-in runs, starting another and logging out are disabled", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await mountPanel(client, auth({ flow: loginFlow() }));
		expect(view.query("[data-provider='kimi-code'] [data-action='signin']")?.getAttribute("disabled")).not.toBeNull();
		expect(view.query("[data-action='logout']")?.getAttribute("disabled")).not.toBeNull();
		await view.unmount();
	});

	test("success names the account; a refused secret shows why, the command to run and Open in terminal", async () => {
		const client = new RecordingClient("ws://x/ws");
		const ok = await mountPanel(
			client,
			auth({ flow: loginFlow({ status: "succeeded", identity: "me@example.invalid", endedAt: 9 }) }),
		);
		expect(ok.query("[data-section='flow']")?.textContent).toContain("Signed in as me@example.invalid");
		await ok.unmount();
		const refused = await mountPanel(
			client,
			auth({
				flow: loginFlow({
					status: "failed",
					endedAt: 9,
					failure: {
						kind: "secret_input",
						message: "Anthropic asks you to type a credential. Nothing was stored.",
						terminalCommand: "omp auth-broker login anthropic",
					},
				}),
			}),
		);
		const text = refused.query("[data-failure='secret_input']")?.textContent ?? "";
		expect(text).toContain("does not take API keys, passwords or other secrets through the browser");
		expect(text).not.toContain("P7");
		expect(refused.query("[data-failure='secret_input'] [data-action='open-terminal']")).not.toBeNull();
		expect(refused.query("[data-failure='secret_input'] .acct-command code")?.textContent).toBe(
			"omp auth-broker login anthropic",
		);
		expect(refused.query("input[name='code']")).toBeNull();
		await refused.unmount();
	});
});

describe("AccountsPanel: accounts", () => {
	test("log out takes two clicks and names the account; only the second sends auth.logout", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await mountPanel(client, auth());
		await view.click("[data-action='logout']");
		expect(view.query(".env-confirm-label")?.textContent).toBe("Log out me@example.invalid?");
		expect(client.requests).toEqual([]);
		await view.click(".env-confirm-no");
		expect(view.query(".env-confirm")).toBeNull();
		await view.click("[data-action='logout']");
		await view.click(".env-confirm-yes");
		expect(client.requests).toEqual([{ t: "auth.logout", providerId: "anthropic", credentialId: 3 }]);
		await view.unmount();
	});

	test("accounts are grouped by provider with their kind and whether they are the one in use; disabled ones ask to sign in again", async () => {
		const client = new RecordingClient("ws://x/ws");
		const second: AccountWire = {
			...mine,
			credentialId: 4,
			label: "second@example.invalid",
			active: false,
			type: "api_key",
			detail: "stored API key #4",
		};
		const view = await mountPanel(
			client,
			auth({
				accounts: {
					providers: [anthropic],
					accounts: [mine, second],
					disabled: [
						{
							provider: "Anthropic (Claude Pro/Max)",
							type: "oauth",
							label: "gone@example.invalid",
							cause: "refresh token revoked",
							disabledAt: Date.now(),
						},
					],
					error: null,
					loadedAt: 1,
					migration: null,
				},
			}),
		);
		expect(
			view.queryAll("[data-section='accounts'] .acct-group[data-provider='anthropic'] li[data-account]"),
		).toHaveLength(2);
		expect(view.query("[data-account='anthropic#3']")?.textContent).toContain("in use");
		expect(view.query("[data-account='anthropic#4']")?.textContent).toContain("API key");
		expect(view.query("[data-section='disabled']")?.textContent).toContain("refresh token revoked");
		await view.unmount();
	});

	test("a listing error is shown and the old list stays", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await mountPanel(
			client,
			auth({ accounts: { ...auth().accounts, error: "the auth broker is not running (restarting)" } }),
		);
		expect(view.query("[data-role='accounts-error']")?.textContent).toContain("not running");
		expect(view.query("[data-account='anthropic#3']")).not.toBeNull();
		await view.unmount();
	});
});

describe("AccountsPanel: usage", () => {
	const usage: UsageWire = {
		fetchedAt: Date.now(),
		generatedAt: Date.now(),
		error: null,
		reports: [
			{
				provider: "anthropic",
				fetchedAt: 1,
				identity: "me@example.invalid",
				orgName: "Example Organization",
				planType: "max",
				resetCredits: { availableCount: 2, redeemableCount: 1, credits: [{ expiresAt: "2099-12-10T00:00:00Z" }] },
				limits: [
					{
						id: "anthropic:5h",
						label: "Claude 5 Hour",
						windowLabel: "5 Hour",
						windowId: "5h",
						durationMs: 18_000_000,
						usedFraction: 0.42,
						status: "ok",
						unit: "percent",
						resetsAt: Date.now() + 3_600_000,
					},
					{ id: "anthropic:7d", label: "Claude 7 Day", usedFraction: 0.93, status: "warning", unit: "percent" },
				],
				notes: ["OMP-observed spend only"],
			},
			{
				provider: "openai-codex",
				fetchedAt: 1,
				identity: "stray@example.invalid",
				limits: [{ id: "c", label: "Weekly", unit: "percent" }],
			},
		],
	};

	test("usage and unassigned reports share the account card, grouped by provider with metadata", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await mountPanel(client, auth({ usage }));
		const bars = view.queryAll("[data-account='anthropic#3'] [data-limit]");
		expect(bars.map(b => b.getAttribute("data-limit"))).toEqual(["anthropic:5h", "anthropic:7d"]);
		expect(bars[0]!.getAttribute("data-status")).toBe("ok");
		expect(bars[1]!.getAttribute("data-status")).toBe("warning");
		expect(bars[0]!.textContent).toContain("42%");
		expect(bars[1]!.textContent).toContain("93%");
		expect(bars[0]!.textContent).not.toContain("5 Hour · 5 Hour"); // the window label is already in the label
		expect(view.query("[data-account='anthropic#3']")?.textContent).toContain("Example Organization");
		expect(view.query("[data-account='anthropic#3']")?.textContent).toContain("plan: max");
		expect(view.query("[data-account='anthropic#3']")?.textContent).toContain("2 saved resets · 1 usable now");
		// One account per window: pooled capacity would only repeat its bars.
		expect(view.query("[data-provider='anthropic'] [data-role='capacity']")).toBeNull();
		expect(view.query("[data-section='accounts'] [data-usage-provider='openai-codex']")?.textContent).toContain(
			"stray@example.invalid",
		);
		expect(view.query("[data-usage-provider='openai-codex'] [data-limit='c']")?.textContent).toContain("?");
		expect(view.query("[data-usage-provider='anthropic']")).toBeNull(); // already shown on the account
		await view.unmount();
	});

	test("a provider with several accounts shows the pooled capacity left per window", async () => {
		const second = {
			...usage.reports[0]!,
			identity: "other@example.invalid",
			resetCredits: undefined,
			limits: [{ ...usage.reports[0]!.limits[0]!, usedFraction: 0.5 }],
		};
		const view = await mountPanel(
			new RecordingClient("ws://x/ws"),
			auth({ usage: { ...usage, reports: [usage.reports[0]!, second] } }),
		);
		expect(view.query("[data-provider='anthropic'] [data-role='capacity']")?.textContent).toContain(
			"5h 1.08× left (0.92/2 used)",
		);
		await view.unmount();
	});

	test("Copilot usage stays on its sole credential without a duplicate report", async () => {
		const copilot: AccountWire = {
			...mine,
			provider: "github-copilot",
			providerName: "GitHub Copilot",
			credentialId: 4,
			label: "OAuth credential #4",
			detail: "oauth #4",
		};
		const state = auth();
		const view = await mountPanel(new RecordingClient("ws://x/ws"), {
			...state,
			accounts: { ...state.accounts, accounts: [mine, copilot] },
			usage: {
				...usage,
				reports: [
					usage.reports[0]!,
					{ ...usage.reports[1]!, provider: "github-copilot", identity: "donuts-fuxiangyu" },
				],
			},
		});
		expect(view.query("[data-account='github-copilot#4'] [data-limit='c']")).not.toBeNull();
		expect(view.query("[data-account='github-copilot#4']")?.textContent).toContain(
			"Usage reported for donuts-fuxiangyu",
		);
		expect(view.query("[data-usage-provider='github-copilot']")).toBeNull();
		await view.unmount();
	});

	test("Hide masks emails, organizations and reported identities but keeps rows and usage; Show brings them back", async () => {
		const disabledRow = {
			provider: "OpenAI",
			type: "oauth" as const,
			label: "gone@example.invalid",
			cause: "refresh failed",
			disabledAt: null,
		};
		const view = await mountPanel(
			new RecordingClient("ws://x/ws"),
			auth({ usage, accounts: { ...auth().accounts, disabled: [disabledRow] } }),
		);
		const card = (): string => view.query("[data-section='accounts']")?.textContent ?? "";
		await view.click("[data-action='hide-private']");
		for (const secret of [
			"me@example.invalid",
			"Example Organization",
			"stray@example.invalid",
			"gone@example.invalid",
		])
			expect(card()).not.toContain(secret);
		expect(view.query("[data-account='anthropic#3'] .acct-account-name")?.textContent).toBe("OAuth #3");
		expect(view.queryAll("[data-account='anthropic#3'] [data-limit]")).toHaveLength(2);
		expect(card()).toContain("plan: max");
		expect(view.query("[data-action='hide-private']")?.getAttribute("aria-pressed")).toBe("true");
		await view.click("[data-action='hide-private']");
		expect(card()).toContain("me@example.invalid");
		expect(card()).toContain("Example Organization");
		await view.unmount();
	});

	test("an empty answer says the broker reported nothing instead of leaving the section blank", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await mountPanel(
			client,
			auth({ usage: { fetchedAt: Date.now(), generatedAt: Date.now(), reports: [], error: null } }),
		);
		expect(view.query("[data-role='no-usage']")?.textContent).toContain("reported no usage");
		await view.unmount();
	});

	test("Refresh asks the gateway; a too-soon answer says when to try again; a failure keeps the old bars and shows the error", async () => {
		const client = new RecordingClient("ws://x/ws");
		client.next = { t: "ack", reqId: "", ok: true, data: { refreshed: false, retryInMs: 9_200 } };
		const view = await mountPanel(
			client,
			auth({ usage: { ...usage, error: "the broker answered HTTP 502 to /v1/usage" } }),
		);
		expect(view.query("[data-section='accounts'] .form-error")?.textContent).toContain("HTTP 502");
		expect(view.query("[data-account='anthropic#3'] [data-limit]")).not.toBeNull();
		await view.click("[data-section='accounts'] h3 button");
		expect(client.requests).toEqual([{ t: "auth.usage.refresh" }]);
		await view.until(() =>
			(view.query("[data-section='accounts']")?.textContent ?? "").includes("try again in 10 s"),
		);
		await view.unmount();
	});
});

describe("AccountsPanel: migration guide", () => {
	const migration: MigrationWire = {
		state: "available",
		localDb: "/home/me/.omp/agent/agent.db",
		entries: [
			{ provider: "anthropic", type: "oauth", identity: "me@example.invalid" },
			{ provider: "deepseek", type: "api_key", identity: "(api key)" },
		],
		dryRunCommand:
			"OMP_AUTH_BROKER_URL='http://127.0.0.1:8765' OMP_AUTH_BROKER_TOKEN=\"$(cat '/t')\" omp auth-broker migrate --from-local --include-oauth --dry-run",
		command:
			"OMP_AUTH_BROKER_URL='http://127.0.0.1:8765' OMP_AUTH_BROKER_TOKEN=\"$(cat '/t')\" omp auth-broker migrate --from-local --include-oauth",
		note: "OAuth accounts are skipped unless --include-oauth is given.",
	};

	test("local credential migration stays out of the account page even when credentials are available", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await mountPanel(client, auth({ accounts: { ...auth().accounts, migration } }));
		expect(view.query("[data-section='migration']")).toBeNull();
		expect(client.requests).toEqual([]);
		await view.unmount();
	});
});

describe("Banners: this machine's broker", () => {
	const status = (state: "ok" | "unreachable" | "unauthorized" | "withheld", message?: string) => ({
		source: "gateway" as const,
		state,
		url: "http://100.64.0.2:8765",
		message,
		checkedAt: 1,
		lastOkAt: null,
	});

	test("an unreachable broker is a banner on the machine being looked at, naming the cause; a healthy one shows nothing", async () => {
		const bad = await dom.mount(
			<Banners
				phase="open"
				machine={machineSummary({ name: "Laptop", broker: status("unreachable", "connection refused") })}
			/>,
		);
		const banner = bad.query("[data-banner='broker']");
		expect(banner?.getAttribute("data-broker-state")).toBe("unreachable");
		expect(banner?.textContent).toContain("Laptop cannot reach the auth broker");
		expect(banner?.textContent).toContain("connection refused");
		await bad.unmount();
		const good = await dom.mount(<Banners phase="open" machine={machineSummary({ broker: status("ok") })} />);
		expect(good.query("[data-banner='broker']")).toBeNull();
		await good.unmount();
		const offline = await dom.mount(
			<Banners phase="open" machine={machineSummary({ online: false, broker: status("unreachable") })} />,
		);
		expect(offline.query("[data-banner='broker']")).toBeNull(); // an offline machine's last report is not news
		await offline.unmount();
	});
});
