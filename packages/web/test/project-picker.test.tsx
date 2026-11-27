import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Ack, GatewaySessionInfo } from "@omp-web/protocol";
import { ProjectPanel, ProjectPicker, WorktreePicker } from "../src/components/project-picker";
import type { Selection } from "../src/lib/environment";
import { type ClientRequest, DaemonClient } from "../src/store/daemon-client";
import { type FakeDom, installFakeDom, type Mounted, makeEvent } from "./fake-dom";
import { gatewaySession, machineSummary, project, worktree } from "./fixtures";

class RecordingClient extends DaemonClient {
	requests: { machine: string; request: ClientRequest }[] = [];
	/** What the acks carry. */
	data: unknown = undefined;
	/** A refusal to answer with instead of success. */
	error: string | null = null;
	override request(machine: string, request: ClientRequest): Promise<Ack> {
		this.requests.push({ machine, request });
		if (this.error !== null) return Promise.resolve({ t: "ack", reqId: "", ok: false, error: this.error });
		return Promise.resolve({ t: "ack", reqId: "", ok: true, data: this.data });
	}
}

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

const app = project("/p/app", [worktree("/p/app", { main: true }), worktree("/wt/x", { branch: "x" })]);
const solo = project("/p/solo");
const home = machineSummary({ id: "home", name: "Home", projects: [app, solo] });
const onApp: Selection = { machine: "home", project: "/p/app", worktree: "" };
const onSolo: Selection = { machine: "home", project: "/p/solo", worktree: "" };
const noop = (): void => {};

/** Submits the add-project form as its button's click would in a browser (the fake DOM does not do that itself). */
const submit = (view: Mounted): Promise<void> =>
	view.act(() => {
		view.query(".project-add")!.dispatchEvent(makeEvent("submit"));
	});

interface PanelOptions {
	machine?: typeof home;
	sessions?: readonly GatewaySessionInfo[];
	onSelection?: (next: Selection) => void;
	close?: () => void;
}

const panel = (client: DaemonClient, selection: Selection, options: PanelOptions = {}) => (
	<ProjectPanel
		client={client}
		machine={options.machine ?? home}
		target={selection}
		sessions={options.sessions ?? []}
		onSelection={options.onSelection ?? noop}
		close={options.close ?? noop}
	/>
);

describe("ProjectPanel picking a project", () => {
	test("lists the machine's projects, marks the target's, and picking one selects it (its sole worktree comes along) and closes", async () => {
		const client = new RecordingClient("ws://x/ws");
		const picked: Selection[] = [];
		let closed = 0;
		const view = await dom.mount(
			panel(client, onApp, { onSelection: next => picked.push(next), close: () => closed++ }),
		);
		const options = view.queryAll(".project-option");
		expect(options.map(o => o.getAttribute("data-project"))).toEqual(["/p/app", "/p/solo"]);
		expect(options.map(o => o.getAttribute("aria-selected"))).toEqual(["true", "false"]);
		await view.click(".project-option[data-project='/p/solo']");
		expect(picked).toEqual([{ machine: "home", project: "/p/solo", worktree: "/p/solo" }]);
		expect(closed).toBe(1);
		await view.click(".project-option[data-project='/p/app']");
		expect(picked.at(-1)).toEqual({ machine: "home", project: "/p/app", worktree: "" }); // several worktrees: none preselected
		expect(client.requests).toEqual([]);
		await view.unmount();
	});

	test("says so when the machine has no projects", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(
			panel(
				client,
				{ machine: "home", project: "", worktree: "" },
				{ machine: machineSummary({ id: "home", name: "Home" }) },
			),
		);
		expect(view.queryAll(".project-option")).toEqual([]);
		expect(view.container.textContent).toContain("No projects on Home yet");
		await view.unmount();
	});
});

describe("ProjectPanel adding a project", () => {
	test("the typed path is registered on that machine, the project the daemon reports selected, the menu closed and the field cleared", async () => {
		const client = new RecordingClient("ws://x/ws");
		client.data = project("/home/me/blog");
		const picked: Selection[] = [];
		let closed = 0;
		const view = await dom.mount(
			panel(client, onApp, { onSelection: next => picked.push(next), close: () => closed++ }),
		);
		expect(view.query(".project-add button[type=submit]")?.hasAttribute("disabled")).toBe(true); // nothing typed
		await view.type("input[name=project-path]", "  ~/blog ");
		expect(view.query(".project-add button[type=submit]")?.hasAttribute("disabled")).toBe(false);
		await submit(view);
		await view.until(() => picked.length > 0);
		expect(client.requests).toEqual([{ machine: "home", request: { t: "project.add", path: "~/blog" } }]);
		expect(picked).toEqual([{ machine: "home", project: "/home/me/blog", worktree: "/home/me/blog" }]);
		expect(closed).toBe(1);
		await view.until(() => view.query("input[name=project-path]")!.value === "");
		await view.unmount();
	});

	test("a refusal is shown and nothing is selected; an ack without a project is reported too", async () => {
		const client = new RecordingClient("ws://x/ws");
		client.error = "not a git repository";
		const picked: Selection[] = [];
		let closed = 0;
		const view = await dom.mount(
			panel(client, onApp, { onSelection: next => picked.push(next), close: () => closed++ }),
		);
		await view.type("input[name=project-path]", "/tmp/nope");
		await submit(view);
		await view.until(() => view.query(".form-error") !== null);
		expect(view.query(".form-error")?.textContent).toBe("not a git repository");
		client.error = null;
		await submit(view);
		await view.until(() => view.query(".form-error")?.textContent?.includes("did not report") === true);
		expect(picked).toEqual([]);
		expect(closed).toBe(0);
		await view.unmount();
	});

	test("an offline machine cannot take a path", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(panel(client, onApp, { machine: machineSummary({ ...home, online: false }) }));
		expect(view.query("input[name=project-path]")?.hasAttribute("disabled")).toBe(true);
		expect(view.query(".project-add button[type=submit]")?.hasAttribute("disabled")).toBe(true);
		await view.unmount();
	});
});

describe("ProjectPanel adding a session's directory", () => {
	const inApp = gatewaySession({ id: "a", cwd: "/p/app", projectRoot: "/p/app", worktreeRoot: "/p/app" });
	const loose = gatewaySession({ id: "b", cwd: "/home/me/blog/src" });
	const looseAgain = gatewaySession({ id: "c", cwd: "/home/me/blog/src" });
	const other = gatewaySession({ id: "d", cwd: "/home/me/notes" });
	// Antigravity sessions may carry no directory: nothing to offer for them.
	const noDir = gatewaySession({ id: "e", cwd: "" });

	test("offers each directory of a session outside every project once, and none when the machine is offline", async () => {
		const client = new RecordingClient("ws://x/ws");
		const sessions = [inApp, loose, looseAgain, other, noDir];
		const view = await dom.mount(panel(client, onApp, { sessions }));
		const offered = view.queryAll(".project-dir").map(o => o.getAttribute("data-dir"));
		expect(offered).toEqual(["/home/me/blog/src", "/home/me/notes"]);
		expect(view.queryAll(".project-dir").map(o => o.textContent)).toEqual(["/home/me/blog/src", "/home/me/notes"]);
		await view.rerender(panel(client, onApp, { sessions, machine: machineSummary({ ...home, online: false }) }));
		expect(view.query(".project-dir")).toBeNull();
		await view.unmount();
	});

	test("picking one registers it on that machine, selects the project the daemon reports and closes", async () => {
		const client = new RecordingClient("ws://x/ws");
		client.data = project("/home/me/blog");
		const picked: Selection[] = [];
		let closed = 0;
		const view = await dom.mount(
			panel(client, onApp, { sessions: [loose], onSelection: next => picked.push(next), close: () => closed++ }),
		);
		await view.click(".project-dir[data-dir='/home/me/blog/src']");
		await view.until(() => picked.length > 0);
		expect(client.requests).toEqual([{ machine: "home", request: { t: "project.add", path: "/home/me/blog/src" } }]);
		expect(picked).toEqual([{ machine: "home", project: "/home/me/blog", worktree: "/home/me/blog" }]);
		expect(closed).toBe(1);
		await view.unmount();
	});
});

describe("ProjectPanel refreshing", () => {
	test("sends project.list, and needs an online machine", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(panel(client, onApp));
		await view.click("button[aria-label='Refresh projects']");
		expect(client.requests).toEqual([{ machine: "home", request: { t: "project.list" } }]);
		await view.rerender(panel(client, onApp, { machine: machineSummary({ ...home, online: false }) }));
		expect(view.query("button[aria-label='Refresh projects']")?.hasAttribute("disabled")).toBe(true);
		await view.unmount();
	});
});

describe("ProjectPanel project removal", () => {
	test("the first click only asks, naming the project; nothing is sent", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(panel(client, onApp));
		expect(view.query(".env-confirm")).toBeNull();
		await view.click("button[aria-label='Remove project']");
		expect(view.query(".env-confirm-label")?.textContent).toBe("Remove app?");
		expect(view.query(".env-confirm-yes")).not.toBeNull();
		expect(view.query(".env-confirm-no")).not.toBeNull();
		expect(view.query("button[aria-label='Remove project']")).toBeNull(); // the pair replaced it
		expect(client.requests).toEqual([]);
		await view.unmount();
	});

	test("cancel puts the button back and sends nothing", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(panel(client, onApp));
		await view.click("button[aria-label='Remove project']");
		await view.click(".env-confirm-no");
		expect(view.query(".env-confirm")).toBeNull();
		expect(view.query("button[aria-label='Remove project']")).not.toBeNull();
		expect(client.requests).toEqual([]);
		await view.unmount();
	});

	test("only the confirming click sends project.remove, for that project, and then asks again next time", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(panel(client, onApp));
		await view.click("button[aria-label='Remove project']");
		await view.click(".env-confirm-yes");
		expect(client.requests).toEqual([{ machine: "home", request: { t: "project.remove", root: "/p/app" } }]);
		expect(view.query(".env-confirm")).toBeNull();
		await view.click("button[aria-label='Remove project']");
		expect(client.requests).toHaveLength(1); // armed again, not removed again
		await view.unmount();
	});

	test("choosing another project cancels the pending removal for good, even when coming back", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(panel(client, onApp));
		await view.click("button[aria-label='Remove project']");
		await view.rerender(panel(client, onSolo));
		expect(view.query(".env-confirm")).toBeNull();
		await view.rerender(panel(client, onApp));
		expect(view.query(".env-confirm")).toBeNull();
		expect(view.query("button[aria-label='Remove project']")).not.toBeNull();
		expect(client.requests).toEqual([]);
		await view.unmount();
	});

	test("the trash button needs a project and an online machine", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(panel(client, { machine: "home", project: "", worktree: "" }));
		expect(view.query("button[aria-label='Remove project']")?.hasAttribute("disabled")).toBe(true);
		await view.rerender(panel(client, onApp, { machine: machineSummary({ ...home, online: false }) }));
		expect(view.query("button[aria-label='Remove project']")?.hasAttribute("disabled")).toBe(true);
		await view.unmount();
	});

	test("a refusal of project.remove is shown", async () => {
		const client = new RecordingClient("ws://x/ws");
		client.error = "project has live sessions";
		const view = await dom.mount(panel(client, onApp));
		await view.click("button[aria-label='Remove project']");
		await view.click(".env-confirm-yes");
		await view.until(() => view.query(".form-error") !== null);
		expect(view.query(".form-error")?.textContent).toBe("project has live sessions");
		await view.unmount();
	});
});

describe("ProjectPicker and WorktreePicker chips", () => {
	test("the project chip names the target's project and opens the panel", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(
			<ProjectPicker client={client} machine={home} target={onApp} sessions={[]} onSelection={noop} />,
		);
		expect(view.query(".chip--button[title=Project]")?.textContent).toContain("app");
		expect(view.query(".project-panel")).toBeNull();
		await view.click(".chip--button[title=Project]");
		expect(view.query(".project-panel")).not.toBeNull();
		await view.rerender(
			<ProjectPicker
				client={client}
				machine={home}
				target={{ ...onApp, project: "" }}
				sessions={[]}
				onSelection={noop}
			/>,
		);
		expect(view.query(".chip--button[title=Project]")?.textContent).toContain("Pick a project");
		await view.unmount();
	});

	test("without a machine the project chip is disabled", async () => {
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(
			<ProjectPicker client={client} machine={undefined} target={onApp} sessions={[]} onSelection={noop} />,
		);
		expect(view.query(".chip--button[title=Project]")?.hasAttribute("disabled")).toBe(true);
		await view.unmount();
	});

	test("the worktree chip lists the project's worktrees, picking one keeps the project and closes the menu", async () => {
		const picked: Selection[] = [];
		const view = await dom.mount(
			<WorktreePicker machine={home} target={onApp} onSelection={next => picked.push(next)} />,
		);
		expect(view.query(".chip--button[title='Worktree and branch']")?.textContent).toContain("Pick a worktree");
		await view.click(".chip--button[title='Worktree and branch']");
		expect(view.queryAll(".chip-option").map(o => o.getAttribute("data-worktree"))).toEqual(["/p/app", "/wt/x"]);
		await view.click(".chip-option[data-worktree='/wt/x']");
		expect(picked).toEqual([{ machine: "home", project: "/p/app", worktree: "/wt/x" }]);
		expect(view.query(".chip-option")).toBeNull(); // closed
		await view.rerender(
			<WorktreePicker machine={home} target={{ ...onApp, worktree: "/wt/x" }} onSelection={noop} />,
		);
		expect(view.query(".chip--button[title='Worktree and branch']")?.textContent).toContain("x");
		await view.unmount();
	});

	test("the worktree chip needs a project", async () => {
		const view = await dom.mount(
			<WorktreePicker machine={home} target={{ machine: "home", project: "", worktree: "" }} onSelection={noop} />,
		);
		expect(view.query(".chip--button[title='Worktree and branch']")?.hasAttribute("disabled")).toBe(true);
		await view.unmount();
	});
});
