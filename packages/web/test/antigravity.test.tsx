import "./dom-shim";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	defaultCapabilities,
	type Ack,
	type GatewaySessionInfo,
	type SessionBackend,
	type SessionStatus,
} from "@omp-web/protocol";
import { act } from "react";
import { AccountsPanel } from "../src/components/accounts-panel";
import { SessionList } from "../src/components/session-list";
import { SessionView } from "../src/components/session-view";
import type { Selection } from "../src/lib/environment";
import { switchAvailability } from "../src/lib/handoff";
import { parseWebCommand, withWebCommands } from "../src/lib/web-commands";
import { type ClientRequest, DaemonClient } from "../src/store/daemon-client";
import { type FakeDom, installFakeDom } from "./fake-dom";
import { brokerStatus, emptySnapshot, gatewaySession, machineSummary, project, worktree } from "./fixtures";

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
beforeEach(() => {
	globalThis.localStorage?.clear();
});
afterAll(() => dom.uninstall());

const noop = (): void => {};
const noAccounts = { open: false, attention: "off" as const, onToggle: noop };

describe("Antigravity web UI", () => {
	test("SessionList shares one unified list for omp and antigravity sessions without sidebar backend toggle", async () => {
		const client = new DaemonClient("ws://x/ws");
		const sent: { machine: string; request: ClientRequest }[] = [];
		client.request = (async (machine: string, request: ClientRequest): Promise<Ack> => {
			sent.push({ machine, request });
			if (request.t === "session.create") return { t: "ack", reqId: "1", ok: true, data: { sessionId: "agy-new" } };
			return { t: "ack", reqId: "1", ok: true };
		}) as DaemonClient["request"];

		const machine = machineSummary({
			id: "m1",
			name: "Local",
			online: true,
			antigravity: { available: true, version: "1.2.3" },
			projects: [project("/p/app", [worktree("/p/app", { branch: "main", main: true })])],
		});
		const sessions: Record<string, GatewaySessionInfo[]> = {
			m1: [
				gatewaySession({
					id: "s-omp",
					cwd: "/p/app",
					projectRoot: "/p/app",
					worktreeRoot: "/p/app",
					title: "OMP task",
				}),
				gatewaySession({
					id: "s-agy",
					cwd: "/p/app",
					projectRoot: "/p/app",
					worktreeRoot: "/p/app",
					title: "AGY task",
					backend: "antigravity",
				}),
			],
		};
		const selection: Selection = { machine: "m1", project: "/p/app", worktree: "/p/app" };

		const mounted = await dom.mount(
			<SessionList
				client={client}
				machines={[machine]}
				sessions={sessions}
				selection={selection}
				selected={null}
				onSelection={noop}
				onSelect={noop}
				accounts={noAccounts}
				onOpenHandoff={noop}
				backend="antigravity"
			/>,
		);
		try {
			// Both omp and antigravity sessions are visible together in one shared list
			const rows = mounted.container.querySelectorAll(".side-item");
			expect(rows.length).toBe(2);
			expect(mounted.container.textContent).toContain("OMP task");
			expect(mounted.container.textContent).toContain("AGY task");
			// Every row shows its backend badge (`omp` or `agy`) in the bottom-right grid cell, outside `.side-name`.
			expect(mounted.query('[data-session="s-omp"] .side-backend')?.textContent).toBe("omp");
			expect(mounted.query('[data-session="s-agy"] .side-backend')?.textContent).toBe("agy");
			expect(mounted.query('[data-session="s-agy"] .side-name .side-backend')).toBeNull();

			// Sidebar no longer renders a backend toggle button; New session still respects the preferred backend
			expect(mounted.query('[data-testid="backend-toggle"]')).toBeNull();

			await mounted.click(".side-new-button");
			await mounted.until(() => sent.length > 0);
			expect(sent).toEqual([
				{ machine: "m1", request: { t: "session.create", cwd: "/p/app", backend: "antigravity" } },
			]);
		} finally {
			await mounted.unmount();
		}
	});

	test("Fresh empty session switches omp <-> antigravity in-place via status line while preserving draft", async () => {
		const client = new DaemonClient("ws://x/ws");
		const requests: ClientRequest[] = [];
		const created = Promise.withResolvers<void>();
		client.request = (async (_machine: string, request: ClientRequest): Promise<Ack> => {
			requests.push(request);
			if (request.t === "session.create") {
				await created.promise;
				return { t: "ack", reqId: "1", ok: true, data: { sessionId: "agy-2" } };
			}
			return { t: "ack", reqId: "1", ok: true };
		}) as DaemonClient["request"];

		const status: SessionStatus = {
			sessionId: "omp-1",
			cwd: "/p/app",
			model: "anthropic/claude-sonnet-4-5",
			isStreaming: false,
			isCompacting: false,
			queue: { steering: [], followUp: [], liveSteered: 0 },
			todos: [],
		};
		const store = client.store("m1", "omp-1");
		store.applySnapshot(1, "e", emptySnapshot({ entries: [], status }));
		store.setDraft("keep my draft");

		const machine = machineSummary({
			id: "m1",
			name: "Local",
			online: true,
			antigravity: { available: true },
			projects: [project("/p/app", [worktree("/p/app", { branch: "main", main: true })])],
		});
		const relocated: { id: string; draft: string; backend: SessionBackend }[] = [];

		const mounted = await dom.mount(
			<SessionView
				client={client}
				machine="m1"
				machineInfo={machine}
				sessionId="omp-1"
				info={gatewaySession({ id: "omp-1", cwd: "/p/app", projectRoot: "/p/app", worktreeRoot: "/p/app" })}
				onOpen={noop}
				onShowList={noop}
				dockSlot={null}
				toolbar={() => null}
				machineSessions={[]}
				relocationTarget={null}
				onRelocate={next => {
					relocated.push({ id: next.id, draft: next.draft, backend: next.backend });
				}}
				handoffs={[]}
				onSwitch={noop}
				onOpenHandoff={noop}
				onNewSession={async () => null}
				onShowDock={noop}
			/>,
		);
		try {
			const switchBtn = mounted.query('[data-testid="fresh-backend-switch"]');
			expect(switchBtn).not.toBeNull();
			expect(switchBtn?.textContent).toBe("omp");
			expect((switchBtn?.getAttribute("class") ?? "").split(/\s+/)).toContain("chip--button");
			await mounted.click('[data-testid="fresh-backend-switch"]');
			// Starting the other agent takes seconds: the toggle says so and refuses a second click meanwhile.
			await mounted.until(
				() => mounted.query('[data-testid="fresh-backend-switch"]')?.hasAttribute("disabled") ?? false,
			);
			expect(mounted.query('[data-testid="fresh-backend-switch"]')?.textContent).toBe("switching to agy…");
			created.resolve();
			await mounted.until(() => relocated.length > 0);
			expect(requests).toContainEqual({ t: "session.create", cwd: "/p/app", backend: "antigravity" });
			expect(requests).toContainEqual({ t: "session.close", sessionId: "omp-1" });
			expect(relocated).toEqual([{ id: "agy-2", draft: "keep my draft", backend: "antigravity" }]);
		} finally {
			await mounted.unmount();
		}
	});

	test("Antigravity SessionView adapts capabilities: badge, Steer/Queue composer while working, disabled handoff, filtered commands", async () => {
		const client = new DaemonClient("ws://x/ws");
		const requests: ClientRequest[] = [];
		client.request = (async (_machine: string, request: ClientRequest): Promise<Ack> => {
			requests.push(request);
			return { t: "ack", reqId: "1", ok: true };
		}) as DaemonClient["request"];

		const caps = defaultCapabilities("antigravity");
		const agyStatus: SessionStatus = {
			sessionId: "agy-1",
			cwd: "/p/app",
			model: "antigravity/gemini-2.5-pro",
			thinkingLevel: "high",
			isStreaming: true,
			isCompacting: false,
			queue: { steering: [], followUp: [], liveSteered: 0 },
			todos: [],
			backend: "antigravity",
			capabilities: caps,
		};
		const store = client.store("m1", "agy-1");
		store.applySnapshot(2, "e", emptySnapshot({ entries: [], status: agyStatus, working: true }));

		const machine = machineSummary({
			id: "m1",
			name: "Local",
			online: true,
			antigravity: { available: true },
			projects: [project("/p/app", [worktree("/p/app", { branch: "main", main: true })])],
		});
		const agyInfo = gatewaySession({
			id: "agy-1",
			cwd: "/p/app",
			projectRoot: "/p/app",
			worktreeRoot: "/p/app",
			backend: "antigravity",
			phase: "working",
		});

		let switched = 0;
		const mounted = await dom.mount(
			<SessionView
				client={client}
				machine="m1"
				machineInfo={machine}
				sessionId="agy-1"
				info={agyInfo}
				onOpen={noop}
				onShowList={noop}
				dockSlot={null}
				toolbar={() => null}
				machineSessions={[]}
				relocationTarget={null}
				onRelocate={noop}
				handoffs={[]}
				onSwitch={() => {
					switched++;
				}}
				onOpenHandoff={noop}
				onNewSession={async () => null}
				onShowDock={noop}
			/>,
		);
		try {
			// Header does not show a separate Antigravity badge; Switch environment reason is only shown as alert on click
			expect(mounted.query('[data-testid="session-backend"]')).toBeNull();
			const switchBtn = mounted.query('[data-testid="switch-environment"]');
			expect(switchBtn?.getAttribute("aria-disabled")).toBe("true");
			expect(mounted.query('[data-testid="switch-reason"]')).toBeNull();

			await mounted.click('[data-testid="switch-environment"]');
			expect(switched).toBe(0);
			const alert = mounted.query('[data-testid="switch-reason"]');
			expect(alert?.getAttribute("role")).toBe("alert");
			expect(alert?.textContent).toContain("Environment switching is not supported for Antigravity sessions");

			// Composer supports both Steer and Queue while working
			expect(mounted.query(".send-mode")).not.toBeNull();
			expect(mounted.query('button[aria-label="Steer"]')).not.toBeNull();

			// Never asks daemon for omp roles or subagents
			expect(requests.some(r => r.t === "session.roles")).toBe(false);
			expect(requests.some(r => r.t === "session.agents")).toBe(false);
		} finally {
			await mounted.unmount();
		}

		// Capability filtering for web commands & handoff
		expect(switchAvailability(agyInfo, [], machine)).toEqual({
			ok: false,
			reason: "Environment switching is not supported for Antigravity sessions",
		});
		const agyCommands = withWebCommands([], caps).map(c => c.name);
		expect(agyCommands).toEqual(["new", "queue", "copy", "loop", "exit"]);
		expect(parseWebCommand("/btw hi", [], caps)).toBeNull();
		expect(parseWebCommand("/goal ship", [], caps)).toBeNull();
		expect(parseWebCommand("/queue next", [], caps)).toEqual({ name: "queue", args: "next" });
	});

	test("AccountsPanel renders Antigravity ACP login card even with omp broker disabled and triggers ACP login + terminal login", async () => {
		const client = new DaemonClient("ws://x/ws");
		const requests: { machine: string; request: ClientRequest }[] = [];
		client.request = (async (machine: string, request: ClientRequest): Promise<Ack> => {
			requests.push({ machine, request });
			if (request.t === "antigravity.auth.status") {
				return {
					t: "ack",
					reqId: "1",
					ok: true,
					data: {
						available: true,
						version: "1.2.3",
						authMethods: [{ id: "oauth-personal", name: "Google Account" }],
						hasGeminiApiKey: false,
						loginCommand: "agy acp --login",
					},
				};
			}
			if (request.t === "antigravity.auth.login") {
				return { t: "ack", reqId: "1", ok: true, data: { methodId: request.methodId, authenticated: true } };
			}
			if (request.t === "antigravity.usage") {
				return {
					t: "ack",
					reqId: "1",
					ok: true,
					data: {
						fetchedAt: 1_760_000_000_000,
						report: {
							provider: "antigravity",
							fetchedAt: 1_760_000_000_000,
							identity: "agy-user@example.com",
							limits: [
								{
									id: "gemini-5h",
									label: "Gemini · 5-hour",
									windowLabel: "5-hour",
									usedFraction: 0.25,
									status: "ok",
									unit: "percent",
								},
								{
									id: "3p-weekly",
									label: "Claude & GPT (shared) · Weekly",
									windowLabel: "Weekly",
									usedFraction: 0.85,
									status: "warning",
									unit: "percent",
								},
							],
						},
					},
				};
			}
			if (request.t === "term.open") {
				return {
					t: "ack",
					reqId: "1",
					ok: true,
					data: {
						terminal: {
							id: "term-agy-1",
							name: "Antigravity login",
							title: null,
							cwd: "/home/u",
							shell: "/bin/zsh",
							pid: 1,
							createdAt: 1,
							cols: 80,
							rows: 24,
							state: "running",
							exit: null,
							purpose: "antigravity-login",
						},
					},
				};
			}
			return { t: "ack", reqId: "1", ok: true };
		}) as DaemonClient["request"];

		const openedTerminals: { machine: string; id: string }[] = [];
		const machine = machineSummary({
			id: "m1",
			name: "Local",
			online: true,
			antigravity: { available: true, version: "1.2.3" },
		});

		const mounted = await dom.mount(
			<AccountsPanel
				client={client}
				auth={{
					broker: brokerStatus({ phase: "disabled" }),
					accounts: { providers: null, accounts: [], disabled: [], error: null, loadedAt: null, migration: null },
					flow: null,
					usage: { fetchedAt: null, generatedAt: null, reports: [], error: null },
				}}
				machines={[machine]}
				onClose={noop}
				onOpenTerminal={ref => openedTerminals.push(ref)}
			/>,
		);
		try {
			await mounted.until(() => mounted.query('[data-testid="antigravity-auth-oauth-personal"]') !== null);
			await mounted.until(() => mounted.query('[data-section="accounts"] [data-provider="antigravity"]') !== null);
			expect(mounted.query('[data-testid="antigravity-auth-card"]')).not.toBeNull();
			// The sign-in state is visible on the machine's row; the quota lives with the other accounts' usage.
			expect(mounted.query('[data-testid="antigravity-identity-m1"]')?.textContent).toBe(
				"Signed in · agy-user@example.com",
			);
			expect(mounted.query('[data-testid="antigravity-auth-card"] [data-limit="gemini-5h"]')).toBeNull();
			expect(mounted.query('[data-section="accounts"] [data-limit="gemini-5h"]')?.textContent).toContain("25%");
			expect(mounted.query('[data-section="accounts"] [data-limit="3p-weekly"]')?.textContent).toContain("85%");

			await mounted.click('[data-testid="antigravity-auth-oauth-personal"]');
			await mounted.until(() =>
				requests.some(r => r.request.t === "antigravity.auth.login" && r.request.methodId === "oauth-personal"),
			);
			// Signing in re-checks the sign-in at once.
			await mounted.until(() => requests.filter(r => r.request.t === "antigravity.usage").length >= 2);

			await mounted.click('[data-testid="antigravity-open-terminal"]');
			await mounted.until(() => openedTerminals.length > 0);
			expect(openedTerminals).toEqual([{ machine: "m1", id: "term-agy-1" }]);
			expect(
				requests.some(
					r =>
						r.machine === "m1" && r.request.t === "term.open" && r.request.purpose?.kind === "antigravity-login",
				),
			).toBe(true);
		} finally {
			await mounted.unmount();
		}
	});

	test("AccountsPanel says when a machine's Antigravity CLI is not signed in", async () => {
		const client = new DaemonClient("ws://x/ws");
		client.request = (async (_machine: string, request: ClientRequest): Promise<Ack> => {
			if (request.t === "antigravity.usage") {
				return {
					t: "ack",
					reqId: "1",
					ok: true,
					data: {
						fetchedAt: 1,
						report: null,
						unavailable: { reason: "unauthenticated", message: "Sign in with Google to see quota." },
					},
				};
			}
			return { t: "ack", reqId: "1", ok: true, data: { available: true, authMethods: [], hasGeminiApiKey: false } };
		}) as DaemonClient["request"];
		const machine = machineSummary({ id: "m1", online: true, antigravity: { available: true } });
		const mounted = await dom.mount(
			<AccountsPanel
				client={client}
				auth={{
					broker: brokerStatus({ phase: "disabled" }),
					accounts: { providers: null, accounts: [], disabled: [], error: null, loadedAt: null, migration: null },
					flow: null,
					usage: { fetchedAt: null, generatedAt: null, reports: [], error: null },
				}}
				machines={[machine]}
				onClose={noop}
			/>,
		);
		try {
			await mounted.until(
				() => mounted.query('[data-testid="antigravity-identity-m1"]')?.textContent === "Not signed in",
			);
			expect(mounted.query('[data-testid="antigravity-identity-m1"] [data-tone="bad"]')).not.toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	test("Antigravity SessionView exposes permission mode selector and one-click auto-approve on open permission prompts", async () => {
		const client = new DaemonClient("ws://x/ws");
		const requests: ClientRequest[] = [];
		client.request = (async (_machine: string, request: ClientRequest): Promise<Ack> => {
			requests.push(request);
			return { t: "ack", reqId: "1", ok: true };
		}) as DaemonClient["request"];

		const caps = defaultCapabilities("antigravity");
		const agyStatus: SessionStatus = {
			sessionId: "agy-perm",
			cwd: "/p/app",
			model: "antigravity/gemini-2.5-pro",
			agentMode: "default",
			agentModeName: "Default",
			permissionMode: "ask",
			isStreaming: true,
			isCompacting: false,
			queue: { steering: [], followUp: [], liveSteered: 0 },
			todos: [],
			backend: "antigravity",
			capabilities: caps,
		};
		const store = client.store("m1", "agy-perm");
		store.applySnapshot(
			2,
			"e",
			emptySnapshot({
				entries: [],
				status: agyStatus,
				working: true,
				uiRequests: [{ id: "acp_perm_1", method: "select", title: "Run tests", options: ["Allow once", "Reject"] }],
			}),
		);

		const machine = machineSummary({
			id: "m1",
			name: "Local",
			online: true,
			antigravity: { available: true },
			projects: [project("/p/app", [worktree("/p/app", { branch: "main", main: true })])],
		});
		const agyInfo = gatewaySession({
			id: "agy-perm",
			cwd: "/p/app",
			projectRoot: "/p/app",
			worktreeRoot: "/p/app",
			backend: "antigravity",
			phase: "working",
		});

		const mounted = await dom.mount(
			<SessionView
				client={client}
				machine="m1"
				machineInfo={machine}
				sessionId="agy-perm"
				info={agyInfo}
				onOpen={noop}
				onShowList={noop}
				dockSlot={null}
				toolbar={() => null}
				machineSessions={[]}
				relocationTarget={null}
				onRelocate={noop}
				handoffs={[]}
				onSwitch={noop}
				onOpenHandoff={noop}
				onNewSession={async () => null}
				onShowDock={noop}
			/>,
		);
		try {
			expect(mounted.container.textContent).toContain("mode: Default");
			expect(mounted.container.textContent).toContain("perm: ask");
			expect(mounted.query('[data-testid="ui-perm-quick-actions"]')).not.toBeNull();

			await mounted.click('[data-testid="ui-perm-auto"]');
			await mounted.until(() =>
				requests.some(
					r => r.t === "session.set_permission_mode" && r.sessionId === "agy-perm" && r.mode === "auto",
				),
			);

			// When permissionMode switches to auto, the chip button keeps pill classes (`chip chip--button chip--backend`)
			await act(async () => {
				store.applySnapshot(
					3,
					"e2",
					emptySnapshot({
						entries: [],
						status: { ...agyStatus, permissionMode: "auto" },
						working: true,
					}),
				);
			});
			const autoPermBtn = [...mounted.queryAll("button")].find(b => b.textContent === "perm: auto");
			expect(autoPermBtn).toBeDefined();
			const classes = (autoPermBtn?.getAttribute("class") ?? "").split(/\s+/);
			expect(classes).toContain("chip");
			expect(classes).toContain("chip--button");
			expect(classes).toContain("chip--backend");
		} finally {
			await mounted.unmount();
		}
	});
});
