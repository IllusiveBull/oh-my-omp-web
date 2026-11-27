import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
	Ack,
	GatewaySessionInfo,
	MachineSummary,
	QueueWire,
	TodoPhaseWire,
	UiResponseBody,
} from "@omp-web/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { AttentionBar } from "../src/components/attention-bar";
import { Banners } from "../src/components/banners";
import { ExtensionWidgets } from "../src/components/extension-widgets";
import { QueueList } from "../src/components/queue-list";
import { ReplicaBanner } from "../src/components/replica-banner";
import { SessionList } from "../src/components/session-list";
import { TodoPanel } from "../src/components/todo-panel";
import { UiRequestDialog } from "../src/components/ui-request";
import type { Selection } from "../src/lib/environment";
import type { SessionRef } from "../src/lib/route";
import { type ClientRequest, DaemonClient } from "../src/store/daemon-client";
import { type FakeDom, installFakeDom, type Mounted, makeEvent } from "./fake-dom";
import { gatewaySession, machineSummary, project, worktree } from "./fixtures";

const noop = (): void => {};
const noAccounts = { open: false, attention: "off" as const, onToggle: noop };
const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("QueueList", () => {
	const queue: QueueWire = { steering: ["sent one", "pending", "pending"], followUp: ["later"], liveSteered: 1 };

	test("only entries that were not sent yet can be removed", () => {
		const html = renderToStaticMarkup(<QueueList queue={queue} onRemove={async () => ({ ok: true })} />);
		expect(count(html, ' queue-x"')).toBe(3); // two pending steering entries and the follow-up
		expect(html).toContain("steering · sent");
		expect(html).toContain("follow-up");
	});

	test("is display-only without a remove handler and empty queues render nothing", () => {
		expect(renderToStaticMarkup(<QueueList queue={queue} />)).not.toContain("Remove from queue");
		expect(renderToStaticMarkup(<QueueList queue={{ steering: [], followUp: [], liveSteered: 0 }} />)).toBe("");
	});
});

describe("TodoPanel", () => {
	const todos: TodoPhaseWire[] = [
		{
			name: "Build",
			tasks: [
				{ content: "design", status: "completed" },
				{ content: "code", status: "in_progress" },
				{ content: "ship", status: "pending" },
				{ content: "old idea", status: "abandoned" },
			],
		},
	];

	test("shows completed/total in the header and an icon per status", () => {
		const html = renderToStaticMarkup(<TodoPanel todos={todos} />);
		expect(html).toContain("1/4");
		for (const status of ["completed", "in_progress", "pending", "abandoned"])
			expect(html).toContain(`aria-label="${status}"`);
		expect(html).toContain("Build");
	});

	test("is hidden without tasks", () => {
		expect(renderToStaticMarkup(<TodoPanel todos={[]} />)).toBe("");
		expect(renderToStaticMarkup(<TodoPanel todos={[{ name: "Empty", tasks: [] }]} />)).toBe("");
	});
});

describe("ExtensionWidgets", () => {
	test("renders only the requested placement, without ANSI styling", () => {
		const widgets = new Map([
			["a", { lines: ["\x1b[32mgreen\x1b[0m", "line2"], placement: "aboveEditor" as const }],
			["b", { lines: ["below"], placement: "belowEditor" as const }],
		]);
		const html = renderToStaticMarkup(<ExtensionWidgets widgets={widgets} placement="aboveEditor" />);
		expect(html).toContain("green\nline2");
		expect(html).not.toContain("\x1b");
		expect(html).not.toContain("below");
	});
});

describe("AttentionBar", () => {
	test("an http(s) url gets an Open link that opens a new tab safely", () => {
		const html = renderToStaticMarkup(
			<AttentionBar
				items={[{ id: 1, kind: "open_url", url: "https://example.com/login", instructions: "Sign in" }]}
				onUseText={noop}
				onDismiss={noop}
			/>,
		);
		expect(html).toContain('href="https://example.com/login"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain("example.com");
		expect(html).toContain("Sign in");
	});

	test("any other scheme is shown as text only, without a link", () => {
		const html = renderToStaticMarkup(
			<AttentionBar
				items={[{ id: 1, kind: "open_url", url: "javascript:alert(1)" }]}
				onUseText={noop}
				onDismiss={noop}
			/>,
		);
		expect(html).not.toContain("<a ");
		expect(html).toContain("javascript:alert(1)");
	});

	test("suggested composer text is offered, not applied", () => {
		const html = renderToStaticMarkup(
			<AttentionBar
				items={[{ id: 1, kind: "editor_text", text: "run the tests" }]}
				onUseText={noop}
				onDismiss={noop}
			/>,
		);
		expect(html).toContain("run the tests");
		expect(html).toContain("Use");
		expect(html).toContain("Dismiss");
	});
});

describe("SessionList", () => {
	let dom: FakeDom;
	beforeAll(async () => {
		dom = await installFakeDom();
	});
	afterAll(() => dom.uninstall());

	const client = new DaemonClient("ws://x/ws");
	const app = project("/p/app", [worktree("/p/app", { main: true }), worktree("/wt/x", { branch: "x" })]);
	const home = machineSummary({ id: "home", name: "Home Mac", gateway: true, projects: [app] });
	const away = machineSummary({
		id: "away",
		name: "Laptop",
		online: false,
		linkId: 0,
		projects: [project("/p/solo")],
	});
	const sessions = {
		home: [
			gatewaySession({ id: "a", projectRoot: "/p/app", worktreeRoot: "/p/app", unread: true }),
			gatewaySession({ id: "b", projectRoot: "/p/app", worktreeRoot: "/wt/x" }),
			gatewaySession({ id: "c" }),
		],
		away: [gatewaySession({ id: "a", projectRoot: "/p/solo", worktreeRoot: "/p/solo" })],
	};
	const render = (machine: string, projectRoot: string, worktreePath: string): string =>
		renderToStaticMarkup(
			<SessionList
				client={client}
				machines={[home, away]}
				sessions={sessions}
				selection={{ machine, project: projectRoot, worktree: worktreePath }}
				selected={null}
				onSelection={noop}
				onSelect={noop}
				accounts={noAccounts}
				onOpenHandoff={noop}
			/>,
		);

	test("lists the machines with their state, the gateway's own labelled", () => {
		const html = render("home", "", "");
		expect(html).toContain("3 active sessions");
		expect(html).toContain("offline · cached");
		expect(count(html, 'class="machine-tag"')).toBe(1);
	});

	test("the focus filter is the project chip, naming the focused project or all of them; worktrees and project management live in its menu", () => {
		const focused = render("home", "/p/app", "");
		expect(focused).toMatch(/title="Project"[^>]*>.*?app<\/button>/);
		expect(render("home", "", "")).toMatch(/title="Project"[^>]*>.*?All projects<\/button>/);
		expect(focused).not.toContain("<select");
		expect(focused).not.toContain('name="worktree"');
		expect(focused).not.toContain('name="project-path"');
	});

	test("scopes the rows by project (all its worktrees), and marks only unread ones", () => {
		const all = render("home", "", "");
		expect(count(all, 'class="side-item')).toBe(3);
		expect(count(all, 'class="side-unread"')).toBe(1);
		expect(all).toContain('data-session="c" data-machine="home"');

		const inProject = render("home", "/p/app", "");
		expect(count(inProject, 'class="side-item')).toBe(2);
		expect(inProject).not.toContain('data-session="c"');

		// a worktree in the selection does not narrow the list further
		const inWorktree = render("home", "/p/app", "/wt/x");
		expect(count(inWorktree, 'class="side-item')).toBe(2);
		expect(inWorktree).toContain('data-session="a" data-machine="home"');
		expect(inWorktree).toContain('data-session="b" data-machine="home"');
	});

	test("an offline machine shows its cached sessions dimmed, with a note", () => {
		const html = render("away", "", "");
		expect(html).toContain("side-item--cached");
		expect(html).toContain('data-session="a" data-machine="away"');
		expect(html).toContain("Laptop is offline. The sessions below are the gateway&#x27;s cached list.");
	});

	test("rows of an offline machine whose session has a copy are marked and stay openable; the rest are only dimmed", () => {
		const replicaSessions = {
			away: [
				gatewaySession({ id: "a", replica: { state: "complete", asOf: 5_000, syncedAt: 6_000 } }),
				gatewaySession({ id: "b", replica: { state: "partial", asOf: 5_000, syncedAt: 6_000 } }),
				gatewaySession({ id: "c" }),
			],
			home: [gatewaySession({ id: "a", replica: { state: "complete", asOf: 5_000, syncedAt: 6_000 } })],
		};
		const html = (machine: string): string =>
			renderToStaticMarkup(
				<SessionList
					client={client}
					machines={[home, away]}
					sessions={replicaSessions}
					selection={{ machine, project: "", worktree: "" }}
					selected={null}
					onSelection={noop}
					onSelect={noop}
					accounts={noAccounts}
					onOpenHandoff={noop}
				/>,
			);
		const offlineHtml = html("away");
		expect(offlineHtml).toContain('data-session="a" data-machine="away" data-replica="complete"');
		expect(offlineHtml).toContain('data-session="b" data-machine="away" data-replica="partial"');
		expect(offlineHtml).not.toContain('data-session="c" data-machine="away" data-replica');
		expect(count(offlineHtml, 'class="side-replica"')).toBe(2);
		expect(offlineHtml).toContain("Copy held by the gateway, as of");
		expect(offlineHtml).toContain("incomplete: newer data was not copied");
		expect(count(offlineHtml, "side-item--replica")).toBe(2);
		expect(count(offlineHtml, "side-item--cached")).toBe(3);

		const onlineHtml = html("home"); // a copy only matters while the machine is away
		expect(onlineHtml).not.toContain("data-replica");
		expect(onlineHtml).not.toContain("side-replica");
	});

	test("hosted sessions lead the list, without their model; every row shows when it was created", () => {
		const rows = {
			home: [
				gatewaySession({ id: "stored", access: "free", phase: "stored", model: "a/old" }),
				gatewaySession({ id: "live", access: "hosted", phase: "idle", model: "a/live" }),
			],
		};
		const html = renderToStaticMarkup(
			<SessionList
				client={client}
				machines={[home]}
				sessions={rows}
				selection={{ machine: "home", project: "", worktree: "" }}
				selected={null}
				onSelection={noop}
				onSelect={noop}
				accounts={noAccounts}
				onOpenHandoff={noop}
			/>,
		);
		expect(html.indexOf('data-session="live"')).toBeLessThan(html.indexOf('data-session="stored"'));
		expect(html).not.toContain("a/live");
		expect(html).toContain("a/old");
		expect(count(html, 'class="side-created"')).toBe(2);
	});
});

describe("SessionList: New session", () => {
	class RecordingClient extends DaemonClient {
		requests: { machine: string; request: ClientRequest }[] = [];
		answer: Ack = { t: "ack", reqId: "", ok: true, data: { sessionId: "new1" } };
		override request(machine: string, request: ClientRequest): Promise<Ack> {
			this.requests.push({ machine, request });
			return Promise.resolve(this.answer);
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

	interface Rig {
		client: RecordingClient;
		selected: (SessionRef | null)[];
		selections: Selection[];
		mount(options: {
			machine?: MachineSummary;
			sessions?: GatewaySessionInfo[];
			selection: Selection;
		}): Promise<Mounted>;
	}
	const rig = (): Rig => {
		const r: Rig = {
			client: new RecordingClient("ws://x/ws"),
			selected: [],
			selections: [],
			mount: ({ machine = home, sessions = [], selection }) =>
				dom.mount(
					<SessionList
						client={r.client}
						machines={[machine]}
						sessions={{ [machine.id]: sessions }}
						selection={selection}
						selected={null}
						onSelection={next => r.selections.push(next)}
						onSelect={ref => r.selected.push(ref)}
						accounts={noAccounts}
						onOpenHandoff={noop}
					/>,
				),
		};
		return r;
	};
	const button = (view: Mounted) => view.query(".side-section .side-new-button")!;

	test("rename cancels on a second pencil click or blur, and only submit sends the draft", async () => {
		Object.assign(dom.document.documentElement, { dataset: {} });
		const r = rig();
		const view = await r.mount({
			sessions: [gatewaySession({ id: "a", title: "Original" })],
			selection: { machine: "home", project: "", worktree: "" },
		});
		const pencil = '.side-item [aria-label="Rename"]';
		await view.click(pencil);
		await view.type("input[name=title]", "Discarded");
		await view.click(pencil);
		expect(view.query(".side-rename")).toBeNull();
		expect(view.query(".side-name")?.textContent).toContain("Original");
		expect(r.client.requests).toEqual([]);

		await view.click(pencil);
		await view.type("input[name=title]", "Also discarded");
		await view.act(() => {
			view.query("input[name=title]")!.dispatchEvent(makeEvent("focusout"));
		});
		expect(view.query(".side-rename")).toBeNull();
		expect(r.client.requests).toEqual([]);

		await view.click(pencil);
		await view.type("input[name=title]", "Saved");
		await view.act(() => {
			view.query(".side-rename")!.dispatchEvent(makeEvent("submit"));
		});
		await view.until(() => view.query(".side-rename") === null);
		expect(r.client.requests).toEqual([
			{ machine: "home", request: { t: "session.rename", sessionId: "a", title: "Saved" } },
		]);
		await view.unmount();
	});

	test("creates at once in the selection's worktree of the focused project, and opens the new session", async () => {
		const r = rig();
		const view = await r.mount({ selection: { machine: "home", project: "/p/app", worktree: "/wt/x" } });
		expect(button(view).getAttribute("type")).toBe("button");
		expect(button(view).hasAttribute("disabled")).toBe(false);
		expect(button(view).getAttribute("title")).toBe("New session in /wt/x");
		expect(view.query(".side-new-hint")).toBeNull();
		await view.click(".side-section .side-new-button");
		await view.until(() => r.selected.length > 0);
		expect(r.client.requests).toEqual([{ machine: "home", request: { t: "session.create", cwd: "/wt/x" } }]);
		expect(r.selected).toEqual([{ machine: "home", id: "new1" }]);
		await view.unmount();
	});

	test("a focused project without a chosen worktree starts at its main worktree", async () => {
		const r = rig();
		const view = await r.mount({ selection: { machine: "home", project: "/p/app", worktree: "" } });
		await view.click(".side-section .side-new-button");
		await view.until(() => r.selected.length > 0);
		expect(r.client.requests[0]!.request).toEqual({ t: "session.create", cwd: "/p/app" });
		await view.unmount();
	});

	test("a worktree the focused project does not have gives way to its main one", async () => {
		const r = rig();
		const view = await r.mount({ selection: { machine: "home", project: "/p/app", worktree: "/elsewhere" } });
		expect(button(view).getAttribute("title")).toBe("New session in /p/app");
		await view.unmount();
	});

	test("with all projects focused, it starts in the project of the most recently modified session that is registered, whatever the list order", async () => {
		const r = rig();
		const sessions = [
			gatewaySession({ id: "o", cwd: "/p/app", projectRoot: "/p/app", worktreeRoot: "/p/app", modifiedAt: 10 }),
			gatewaySession({ id: "loose", cwd: "/home/me/notes", modifiedAt: 99 }), // outside every project
			gatewaySession({ id: "n", cwd: "/p/solo", projectRoot: "/p/solo", worktreeRoot: "/p/solo", modifiedAt: 50 }),
		];
		const view = await r.mount({ sessions, selection: { machine: "home", project: "", worktree: "" } });
		expect(button(view).getAttribute("title")).toBe("New session in /p/solo");
		await view.click(".side-section .side-new-button");
		await view.until(() => r.selected.length > 0);
		expect(r.client.requests).toEqual([{ machine: "home", request: { t: "session.create", cwd: "/p/solo" } }]);
		await view.unmount();
	});

	test("with all projects focused and no session to go by, the machine's only project is the target", async () => {
		const r = rig();
		const only = machineSummary({ id: "home", name: "Home", projects: [solo] });
		const view = await r.mount({ machine: only, selection: { machine: "home", project: "", worktree: "" } });
		expect(button(view).getAttribute("title")).toBe("New session in /p/solo");
		await view.unmount();
	});

	test("without a target it is disabled with the reason; the focus chip above picks a project or all of them", async () => {
		const r = rig();
		const view = await r.mount({ selection: { machine: "home", project: "", worktree: "" } });
		expect(button(view).hasAttribute("disabled")).toBe(true);
		expect(button(view).getAttribute("title")).toBe("Pick a project.");
		expect(view.query(".side-new-hint")?.textContent).toContain("Pick a project.");
		await view.click(".env .chip--button[title=Project]");
		await view.click(".env .project-option[data-project='/p/app']");
		expect(r.selections).toEqual([{ machine: "home", project: "/p/app", worktree: "" }]);
		await view.click(".env .chip--button[title=Project]");
		expect(view.query(".env .project-option[aria-selected=true]")?.textContent).toBe("All projects");
		await view.click(".env .project-option[data-project='']");
		expect(r.selections.at(-1)).toEqual({ machine: "home", project: "", worktree: "" });
		expect(r.client.requests).toEqual([]); // nothing is created by picking
		await view.click(".side-section .side-new-button");
		expect(r.client.requests).toEqual([]);
		await view.unmount();
	});

	test("a machine with no project says to add one, and the focus chip can add the first one", async () => {
		const r = rig();
		r.client.answer = { t: "ack", reqId: "", ok: true, data: project("/home/me/blog") };
		const bare = machineSummary({ id: "home", name: "Home" });
		const view = await r.mount({ machine: bare, selection: { machine: "home", project: "", worktree: "" } });
		expect(button(view).getAttribute("title")).toBe("Add a project first.");
		expect(view.query(".side-new-hint")?.textContent).toContain("Add a project first.");
		await view.click(".env .chip--button[title=Project]");
		await view.type("input[name=project-path]", "~/blog");
		await view.act(() => {
			view.query(".project-add")!.dispatchEvent(makeEvent("submit"));
		});
		await view.until(() => r.selections.length > 0);
		expect(r.client.requests).toEqual([{ machine: "home", request: { t: "project.add", path: "~/blog" } }]);
		expect(r.selections).toEqual([{ machine: "home", project: "/home/me/blog", worktree: "/home/me/blog" }]);
		expect(r.selected).toEqual([]);
		await view.unmount();
	});

	test("an offline machine cannot start one: disabled, the reason in the tooltip, no hint", async () => {
		const r = rig();
		const offline = machineSummary({ ...home, online: false });
		const view = await r.mount({
			machine: offline,
			selection: { machine: "home", project: "/p/solo", worktree: "/p/solo" },
		});
		expect(button(view).hasAttribute("disabled")).toBe(true);
		expect(button(view).getAttribute("title")).toBe("Home is offline.");
		expect(view.query(".side-new-hint")).toBeNull(); // a project cannot be added to a machine that is away
		await view.click(".side-section .side-new-button");
		expect(r.client.requests).toEqual([]);
		await view.unmount();
	});

	test("a refused create shows the error in the sidebar and opens nothing", async () => {
		const r = rig();
		r.client.answer = { t: "ack", reqId: "", ok: false, error: "omp is not installed" };
		const view = await r.mount({ selection: { machine: "home", project: "/p/solo", worktree: "/p/solo" } });
		await view.click(".side-section .side-new-button");
		await view.until(() => view.query(".form-error") !== null);
		expect(view.query(".form-error")?.textContent).toBe("omp is not installed");
		expect(r.selected).toEqual([]);
		expect(button(view).hasAttribute("disabled")).toBe(false); // can retry
		await view.unmount();
	});

	test("an ack without a session id is reported, not followed", async () => {
		const r = rig();
		r.client.answer = { t: "ack", reqId: "", ok: true, data: {} };
		const view = await r.mount({ selection: { machine: "home", project: "/p/solo", worktree: "/p/solo" } });
		await view.click(".side-section .side-new-button");
		await view.until(() => view.query(".form-error") !== null);
		expect(view.query(".form-error")?.textContent).toBe("the daemon did not report the new session");
		expect(r.selected).toEqual([]);
		await view.unmount();
	});
});

describe("Banners", () => {
	test("shows the connection state", () => {
		expect(renderToStaticMarkup(<Banners phase="open" machine={undefined} />)).toBe("");
		expect(renderToStaticMarkup(<Banners phase="reconnecting" machine={undefined} />)).toContain("Connection lost");
	});

	test("shows the omp warnings of the machine being looked at, named", () => {
		const machine = machineSummary({
			id: "m",
			name: "Laptop",
			omp: { version: "2.0.0", expectedVersion: "1.0.0", versionMismatch: true },
			leaseWarnings: ["HOME differs"],
		});
		const html = renderToStaticMarkup(<Banners phase="open" machine={machine} />);
		expect(html).toContain("Laptop: installed omp 2.0.0 differs");
		expect(html).toContain("Laptop: session ownership checks may be unreliable: HOME differs");
		expect(renderToStaticMarkup(<Banners phase="open" machine={machineSummary()} />)).toBe("");
	});
});

describe("ReplicaBanner", () => {
	const now = Date.UTC(2026, 10, 12, 12, 0, 0);

	test("names the machine, says it is offline, and gives both times relative and absolute", () => {
		const html = renderToStaticMarkup(
			<ReplicaBanner
				machine="Laptop"
				replica={{ state: "complete", asOf: now - 3 * 3_600_000, syncedAt: now - 5 * 60_000 }}
				now={now}
			/>,
		);
		expect(html).toContain('data-state="complete"');
		expect(html).toContain("replica of Laptop (offline)");
		expect(html).toContain("5 minutes ago");
		expect(html).toContain("3 hours ago");
		expect(html).toContain(`dateTime="${new Date(now - 5 * 60_000).toISOString()}"`);
		expect(html).toContain("2026"); // the absolute time
		expect(html).not.toContain("newer data");
	});

	test("a partial copy warns that the end of the transcript may be missing", () => {
		const html = renderToStaticMarkup(
			<ReplicaBanner machine="Laptop" replica={{ state: "partial", asOf: now, syncedAt: now }} now={now} />,
		);
		expect(html).toContain('data-state="partial"');
		expect(html).toContain("Laptop had newer data that was not copied");
	});
});

describe("UiRequestDialog: ask tool selects", () => {
	let dom: FakeDom;
	beforeAll(async () => {
		dom = await installFakeDom();
	});
	afterAll(() => dom.uninstall());

	const isChecked = (view: Mounted, value: string): boolean => {
		const input = view
			.queryAll(".uireq-opt")
			.find(l => l.textContent === value)
			?.querySelector("input");
		return input !== null && input !== undefined && "checked" in input && input.checked === true;
	};
	const pick = async (view: Mounted, value: string): Promise<void> => {
		const input = view
			.queryAll(".uireq-opt")
			.find(l => l.textContent === value)!
			.querySelector("input")!;
		await view.act(() => {
			Object.assign(input, { checked: !("checked" in input && input.checked) }); // as the browser does before the click's change
			input.click();
		});
	};

	test("a checkbox prompt shows what is checked, and a toggle shows at once while omp re-asks", async () => {
		const answers: UiResponseBody[] = [];
		const view = await dom.mount(
			<UiRequestDialog
				request={{
					id: "u1",
					method: "select",
					title: "(1 selected) Fruits",
					options: ["Apple", "Banana", "Other (type your own)", "✓ Done selecting"],
					selectionMarker: "checkbox",
					checkedIndices: [1],
					markableCount: 3,
				}}
				onRespond={a => answers.push(a)}
			/>,
		);
		expect(isChecked(view, "Apple")).toBe(false);
		expect(isChecked(view, "Banana")).toBe(true);
		expect(view.queryAll(".uireq-opt")).toHaveLength(3); // Done is an action, not a row
		await pick(view, "Apple");
		expect(answers).toEqual([{ value: "Apple" }]);
		expect(isChecked(view, "Apple")).toBe(true);
		await view.unmount();
	});

	test("a radio prompt opens on omp's row and answers only on Submit", async () => {
		const answers: UiResponseBody[] = [];
		const view = await dom.mount(
			<UiRequestDialog
				request={{
					id: "u2",
					method: "select",
					title: "Drink",
					options: ["Tea", "Coffee", "Other (type your own)"],
					selectionMarker: "radio",
					initialIndex: 0,
				}}
				onRespond={a => answers.push(a)}
			/>,
		);
		expect(isChecked(view, "Tea")).toBe(true);
		await pick(view, "Coffee");
		expect(isChecked(view, "Tea")).toBe(false);
		expect(answers).toEqual([]);
		await view.click(".uireq-options .btn--primary");
		expect(answers).toEqual([{ value: "Coffee" }]);
		await view.unmount();
	});
});
