import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Ack } from "@omp-web/protocol";
import { AccountsPanel } from "../src/components/accounts-panel";
import { KeyBar } from "../src/components/terminal/key-bar";
import { PasteConfirm } from "../src/components/terminal/paste-confirm";
import { TerminalNav } from "../src/components/terminal/terminal-nav";
import { TerminalTabs } from "../src/components/terminal/terminal-tabs";
import type { Selection } from "../src/lib/environment";
import type { TerminalRef } from "../src/lib/route";
import type { TerminalTab } from "../src/lib/terminal";
import { KEY_BAR } from "../src/lib/terminal-input";
import {
	type AuthRequest,
	type AuthViewState,
	type ClientRequest,
	DaemonClient,
	EMPTY_AUTH,
} from "../src/store/daemon-client";
import { TerminalClient } from "../src/store/terminal-client";
import { type FakeDom, installFakeDom } from "./fake-dom";
import { brokerStatus, loginFlow, machineSummary, project } from "./fixtures";
import { CAPABILITY, FakeTransport, terminalInfo, tick } from "./terminal-rig";

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

const tab = (id: string, patch: Partial<TerminalTab> = {}): TerminalTab => ({
	id,
	title: `shell ${id}`,
	state: "running",
	purpose: undefined,
	...patch,
});

interface TabCalls {
	selected: string[];
	killed: string[];
	dismissed: string[];
	created: number;
}

function mountTabs(
	tabs: TerminalTab[],
	options: { active?: string; newBlocked?: string | null; kill?: string | null; create?: string | null } = {},
) {
	const calls: TabCalls = { selected: [], killed: [], dismissed: [], created: 0 };
	const view = dom.mount(
		<TerminalTabs
			tabs={tabs}
			active={options.active ?? tabs[0]?.id ?? null}
			newBlocked={options.newBlocked ?? null}
			onSelect={id => calls.selected.push(id)}
			onCreate={async () => {
				calls.created++;
				return options.create ?? null;
			}}
			onKill={async id => {
				calls.killed.push(id);
				return options.kill ?? null;
			}}
			onDismiss={async id => {
				calls.dismissed.push(id);
				return null;
			}}
		/>,
	);
	return view.then(mounted => ({ view: mounted, calls }));
}

describe("TerminalTabs", () => {
	test("one tab per terminal with its state, title and the broker login badge", async () => {
		const { view } = await mountTabs(
			[tab("a"), tab("b", { state: "exited", title: "vim" }), tab("c", { purpose: "broker-login" })],
			{ active: "b" },
		);
		expect(view.queryAll(".term-tab").map(t => t.getAttribute("data-state"))).toEqual([
			"running",
			"exited",
			"running",
		]);
		expect(view.queryAll(".term-tab").map(t => t.getAttribute("data-terminal"))).toEqual(["a", "b", "c"]);
		expect(view.query(".term-tab[data-terminal='b'] .term-tab-title")?.textContent).toBe("vim");
		expect(view.query(".term-tab--on")?.getAttribute("data-terminal")).toBe("b");
		expect(view.query(".term-tab[data-terminal='c'] .term-badge")?.textContent).toBe("broker login");
		expect(view.query(".term-tab[data-terminal='a'] .term-badge")).toBeNull();
		await view.unmount();
	});

	test("clicking a tab selects it", async () => {
		const { view, calls } = await mountTabs([tab("a"), tab("b")]);
		await view.click(".term-tab[data-terminal='b'] .term-tab-pick");
		expect(calls.selected).toEqual(["b"]);
		await view.unmount();
	});

	test("× on a running shell asks first, then kills; cancelling kills nothing", async () => {
		const { view, calls } = await mountTabs([tab("a"), tab("b")]);
		expect(view.query("[data-role=term-confirm]")).toBeNull();
		await view.click(".term-tab[data-terminal='b'] [data-role=term-kill]");
		expect(view.query("[data-role=term-confirm]")?.textContent).toContain(
			"Kill this shell? Programs running in it are terminated.",
		);
		expect(calls.killed).toEqual([]);
		await view.click("[data-role=term-confirm-no]");
		expect(view.query("[data-role=term-confirm]")).toBeNull();
		expect(calls.killed).toEqual([]);

		await view.click(".term-tab[data-terminal='b'] [data-role=term-kill]");
		await view.click("[data-role=term-confirm-yes]");
		expect(calls.killed).toEqual(["b"]);
		expect(view.query("[data-role=term-confirm]")).toBeNull();
		expect(calls.dismissed).toEqual([]);
		await view.unmount();
	});

	test("× on an exited or lost terminal removes it at once", async () => {
		const { view, calls } = await mountTabs([tab("a", { state: "exited" }), tab("b", { state: "lost" })]);
		expect(view.query(".term-tab[data-terminal='a'] [data-role=term-kill]")).toBeNull();
		await view.click(".term-tab[data-terminal='a'] [data-role=term-dismiss]");
		await view.click(".term-tab[data-terminal='b'] [data-role=term-dismiss]");
		expect(calls.dismissed).toEqual(["a", "b"]);
		expect(view.query("[data-role=term-confirm]")).toBeNull();
		await view.unmount();
	});

	test("an offline machine's tabs cannot be ended", async () => {
		const { view } = await mountTabs([tab("a", { state: "offline" })]);
		expect(view.query(".term-tab-x")?.hasAttribute("disabled")).toBe(true);
		await view.unmount();
	});

	test("a refused kill shows its error", async () => {
		const { view } = await mountTabs([tab("a")], { kill: "no such terminal" });
		await view.click("[data-role=term-kill]");
		await view.click("[data-role=term-confirm-yes]");
		expect(view.query("[data-role=term-error]")?.textContent).toBe("no such terminal");
		await view.unmount();
	});

	test("+ creates a terminal, shows why it cannot, and shows the error of a failed start", async () => {
		const { view, calls } = await mountTabs([tab("a")], { create: "too many terminals" });
		await view.click("[data-role=term-new]");
		expect(calls.created).toBe(1);
		expect(view.query("[data-role=term-error]")?.textContent).toBe("too many terminals");
		await view.unmount();

		const blocked = await mountTabs([tab("a")], { newBlocked: "Pick a worktree." });
		const plus = blocked.view.query("[data-role=term-new]")!;
		expect(plus.hasAttribute("disabled")).toBe(true);
		expect(plus.getAttribute("title")).toBe("Pick a worktree.");
		await blocked.view.click("[data-role=term-new]");
		expect(blocked.calls.created).toBe(0);
		await blocked.view.unmount();
	});
});

describe("KeyBar", () => {
	test("has every key with data-key, calls back with the key, and shows Ctrl armed", async () => {
		const pressed: string[] = [];
		const view = await dom.mount(<KeyBar ctrl={false} onKey={id => pressed.push(id)} />);
		expect(view.queryAll(".term-keys [data-key]").map(b => b.getAttribute("data-key"))).toEqual(
			KEY_BAR.map(k => k.id),
		);
		await view.click("[data-key=esc]");
		await view.click("[data-key=up]");
		await view.click("[data-key=ctrl]");
		await view.click("[data-key=paste]");
		expect(pressed).toEqual(["esc", "up", "ctrl", "paste"]);
		expect(view.query("[data-key=ctrl]")?.getAttribute("aria-pressed")).toBe("false");
		expect(view.query("[data-key=esc]")?.hasAttribute("aria-pressed")).toBe(false);
		await view.rerender(<KeyBar ctrl onKey={() => {}} />);
		expect(view.query("[data-key=ctrl]")?.getAttribute("aria-pressed")).toBe("true");
		expect(view.query("[data-key=ctrl]")?.className).toContain("term-key--on");
		await view.unmount();
	});

	test("buttons never take focus: tab stop removed", async () => {
		const view = await dom.mount(<KeyBar ctrl={false} onKey={() => {}} />);
		for (const button of view.queryAll(".term-keys button")) expect(button.getAttribute("tabindex")).toBe("-1");
		await view.unmount();
	});
});

describe("PasteConfirm", () => {
	test("says how many lines and offers Paste and Cancel", async () => {
		const log: string[] = [];
		const view = await dom.mount(
			<PasteConfirm lines={3} onPaste={() => log.push("paste")} onCancel={() => log.push("cancel")} />,
		);
		expect(view.query("[data-role=paste-confirm]")?.textContent).toContain(
			"Paste 3 lines? Each line runs as soon as the shell reads it.",
		);
		await view.click("[data-role=paste-confirm] [data-action=paste]");
		await view.click("[data-role=paste-confirm] [data-action=cancel]");
		expect(log).toEqual(["paste", "cancel"]);
		await view.rerender(<PasteConfirm lines={1} onPaste={() => {}} onCancel={() => {}} />);
		expect(view.query("[data-role=paste-confirm]")?.textContent).toContain("Paste 1 line?");
		await view.unmount();
	});
});

describe("TerminalNav", () => {
	const proj = project("/work/app");
	const home = machineSummary({ id: "home", name: "Home", projects: [proj] });
	const selection: Selection = { machine: "home", project: "/work/app", worktree: "/work/app" };

	function rig(list = [terminalInfo("a"), terminalInfo("b", { state: "exited", title: "make" })]) {
		const transport = new FakeTransport();
		transport.list = list;
		transport.setLink("home", "1:1");
		const terminals = new TerminalClient(transport);
		const opened: TerminalRef[] = [];
		const mount = (patch: { selection?: Selection; selected?: TerminalRef | null } = {}) =>
			dom.mount(
				<TerminalNav
					terminals={terminals}
					machine={home}
					selection={patch.selection ?? selection}
					selected={patch.selected ?? null}
					onOpen={ref => opened.push(ref)}
				/>,
			);
		return { transport, terminals, opened, mount };
	}

	test("lists the selected machine's terminals with their state and marks the one on screen", async () => {
		const r = rig();
		const view = await r.mount({ selected: { machine: "home", id: "a" } });
		await view.until(() => view.queryAll("li[data-terminal]").length === 2);
		expect(view.queryAll("li[data-terminal]").map(li => li.getAttribute("data-state"))).toEqual([
			"running",
			"exited",
		]);
		expect(view.query("li[data-terminal='b'] .side-name")?.textContent).toBe("make");
		expect(view.query("li[data-terminal='a']")?.className).toContain("side-item--on");
		expect(view.query("li[data-terminal='b']")?.className).not.toContain("side-item--on");
		expect(r.transport.sent("term.watch")).toHaveLength(1);
		await view.click("li[data-terminal='b'] .side-pick");
		expect(r.opened).toEqual([{ machine: "home", id: "b" }]);
		await view.unmount();
		expect(r.transport.sent("term.watch").at(-1)!.request).toEqual({ t: "term.watch", open: false });
	});

	test("New terminal opens a shell in the selected worktree and shows it", async () => {
		const r = rig([]);
		r.transport.answer = ({ request }) =>
			request.t === "term.open"
				? { t: "ack", reqId: "", ok: true, data: { terminal: terminalInfo("n1") } }
				: undefined;
		const view = await r.mount();
		await view.until(() => !view.query("[data-role=term-new]")!.hasAttribute("disabled"));
		await view.click("[data-role=term-new]");
		await view.until(() => r.opened.length === 1);
		expect(r.opened).toEqual([{ machine: "home", id: "n1" }]);
		expect(r.transport.sent("term.open")[0]!.request).toMatchObject({ t: "term.open", cwd: "/work/app" });
		await view.unmount();
	});

	test("says why it cannot start one, and shows the daemon's refusal", async () => {
		const r = rig([]);
		const view = await r.mount({ selection: { ...selection, worktree: "" } });
		await view.until(
			() => view.query(".term-nav") !== null && r.terminals.getSnapshot().machines.home?.synced === true,
		);
		expect(view.query("[data-role=term-new]")?.hasAttribute("disabled")).toBe(true);
		expect(view.query(".term-nav-hint")?.textContent).toBe("Pick a worktree.");
		await view.unmount();

		const refusing = rig([]);
		refusing.transport.answer = ({ request }) =>
			request.t === "term.open"
				? { t: "ack", reqId: "", ok: false, error: "terminal limit reached (8)" }
				: undefined;
		const second = await refusing.mount();
		await second.until(() => !second.query("[data-role=term-new]")!.hasAttribute("disabled"));
		await second.click("[data-role=term-new]");
		await second.until(() => second.query("[data-role=term-error]") !== null);
		expect(second.query("[data-role=term-error]")?.textContent).toBe("terminal limit reached (8)");
		expect(refusing.opened).toEqual([]);
		await second.unmount();
	});

	test("disabled terminals: says so plainly and offers nothing", async () => {
		const r = rig([]);
		r.transport.capability = { ...CAPABILITY, enabled: false, shell: null };
		const view = await r.mount();
		await view.until(() => view.query("[data-role=term-notice][data-notice=disabled]") !== null);
		const text = view.query("[data-role=term-notice]")?.textContent ?? "";
		expect(text).toContain("Terminals are disabled on Home.");
		expect(text).toContain("--terminal");
		expect(view.query("[data-role=term-new]")?.hasAttribute("disabled")).toBe(true);
		await view.unmount();
	});

	test("a machine that is offline lists nothing new and cannot start a shell", async () => {
		const r = rig();
		r.transport.setLink("home", null);
		const view = await r.mount();
		await tick();
		expect(r.transport.requests).toEqual([]);
		expect(view.query("[data-role=term-new]")?.hasAttribute("disabled")).toBe(true);
		await view.unmount();
	});

	test("a terminal dismissed from another browser is announced where no terminal is on screen", async () => {
		const r = rig();
		const view = await r.mount();
		await view.until(() => view.queryAll("li[data-terminal]").length === 2);
		const bound = r.terminals.bind(
			"home",
			"a",
			{ reset() {}, write: (_d, done) => done(), resize() {} },
			{ visible: true },
		);
		await tick();
		await view.act(() => r.transport.frame("home", { t: "term.gone", id: "a", reason: "dismissed" }));
		await view.until(() => view.query("[data-role=term-notice][data-notice=gone]") !== null);
		expect(view.query("[data-role=term-notice][data-notice=gone]")?.textContent).toContain("was dismissed");
		bound.release();
		await view.unmount();
	});
});

describe("Accounts: Open in terminal", () => {
	interface Sent {
		machine: string;
		request: ClientRequest;
	}

	class TermClient extends DaemonClient {
		sent: Sent[] = [];
		next: Ack = {
			t: "ack",
			reqId: "",
			ok: true,
			data: { terminal: terminalInfo("t9", { purpose: "broker-login" }) },
		};
		override request(machine: string, request: ClientRequest): Promise<Ack> {
			this.sent.push({ machine, request });
			return Promise.resolve(this.next);
		}
		authSent: AuthRequest[] = [];
		override authRequest(request: AuthRequest): Promise<Ack> {
			this.authSent.push(request);
			return Promise.resolve({ t: "ack", reqId: "", ok: true });
		}
		override setAccountsOpen(): void {}
	}

	const deepseek = {
		id: "deepseek",
		name: "DeepSeek",
		available: true,
		authenticated: false,
		kind: "api-key" as const,
		terminalCommand: "HOME='/srv/omp-web/auth-broker' omp auth-broker login deepseek",
	};
	const auth: AuthViewState = {
		...EMPTY_AUTH,
		broker: brokerStatus(),
		accounts: { providers: [deepseek], accounts: [], disabled: [], error: null, loadedAt: 1, migration: null },
	};
	const gateway = machineSummary({ id: "home", name: "Home", gateway: true });

	function mountPanel(client: TermClient, opened: TerminalRef[], machines = [gateway], view = auth) {
		return dom.mount(
			<AccountsPanel
				client={client}
				auth={view}
				machines={machines}
				onClose={() => {}}
				onOpenTerminal={ref => opened.push(ref)}
			/>,
		);
	}

	test("opens the broker login shell on the gateway machine and shows it; the command stays typed-not-run", async () => {
		const client = new TermClient("ws://x/ws");
		const opened: TerminalRef[] = [];
		const view = await mountPanel(client, opened);
		const text = view.query("[data-provider='deepseek'] .acct-terminal")?.textContent ?? "";
		expect(text).not.toContain("P7");
		expect(text).toContain("The command is typed but not run. Review it and press Enter.");
		expect(view.query("[data-provider='deepseek'] .acct-command code")?.textContent).toContain(
			"auth-broker login deepseek",
		);
		await view.click("[data-provider='deepseek'] [data-action=open-terminal]");
		await view.until(() => opened.length === 1);
		expect(opened).toEqual([{ machine: "home", id: "t9" }]);
		expect(client.sent).toEqual([
			{
				machine: "home",
				request: {
					t: "term.open",
					cols: 80,
					rows: 24,
					purpose: { kind: "broker-login", provider: "deepseek" },
				},
			},
		]);
		await view.unmount();
	});

	test("from a refused sign-in it opens the shell and dismisses the dialog so it does not cover the terminal", async () => {
		const client = new TermClient("ws://x/ws");
		const opened: TerminalRef[] = [];
		const flow = loginFlow({
			providerId: "deepseek",
			status: "failed",
			endedAt: 9,
			failure: { kind: "secret_input", message: "typed credential", terminalCommand: deepseek.terminalCommand },
		});
		const view = await mountPanel(client, opened, [gateway], { ...auth, flow });
		await view.click("[data-failure='secret_input'] [data-action=open-terminal]");
		await view.until(() => client.authSent.length === 1);
		expect(opened).toEqual([{ machine: "home", id: "t9" }]);
		expect(client.authSent).toEqual([{ t: "auth.login.dismiss", flowId: flow.id }]);
		await view.unmount();
	});

	test("a machine with terminals disabled: the error says how to enable them, inline", async () => {
		const client = new TermClient("ws://x/ws");
		client.next = { t: "ack", reqId: "", ok: false, error: "terminals are disabled", code: "terminal_disabled" };
		const opened: TerminalRef[] = [];
		const view = await mountPanel(client, opened);
		await view.click("[data-action=open-terminal]");
		await view.until(() => view.query("[data-role=open-terminal-error]") !== null);
		expect(view.query("[data-role=open-terminal-error]")?.textContent).toContain("Terminals are disabled on Home.");
		expect(view.query("[data-role=open-terminal-error]")?.textContent).toContain("--terminal");
		expect(opened).toEqual([]);
		await view.unmount();
	});

	test("other refusals (broker not hosted, machine offline) show the daemon's words", async () => {
		const client = new TermClient("ws://x/ws");
		client.next = { t: "ack", reqId: "", ok: false, error: "the auth broker is not hosted on this machine" };
		const view = await mountPanel(client, []);
		await view.click("[data-action=open-terminal]");
		await view.until(() => view.query("[data-role=open-terminal-error]") !== null);
		expect(view.query("[data-role=open-terminal-error]")?.textContent).toBe(
			"the auth broker is not hosted on this machine",
		);
		await view.unmount();
	});

	test("without a known gateway machine nothing is sent", async () => {
		const client = new TermClient("ws://x/ws");
		const view = await mountPanel(client, [], [machineSummary({ id: "other", name: "Other" })]);
		await view.click("[data-action=open-terminal]");
		await view.until(() => view.query("[data-role=open-terminal-error]") !== null);
		expect(client.sent).toEqual([]);
		await view.unmount();
	});
});
