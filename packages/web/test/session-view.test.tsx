import "./dom-shim";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
	Ack,
	GatewaySessionInfo,
	MachineSummary,
	ReplicaInfo,
	SessionBackend,
	SessionStatus,
	SlashCommandWire,
} from "@omp-web/protocol";
import { SessionView } from "../src/components/session-view";
import type { DraftAttachments } from "../src/lib/draft-attachments";
import type { Selection } from "../src/lib/environment";
import { type ClientRequest, DaemonClient } from "../src/store/daemon-client";
import { type FakeDom, installFakeDom, type Mounted } from "./fake-dom";
import { emptySnapshot, gatewaySession, machineSummary, project, userEntry, worktree } from "./fixtures";

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

const ask = {
	id: "q1",
	method: "confirm",
	title: "Deploy?",
	message: "Really deploy?",
} as const;

interface Scene {
	machine?: MachineSummary;
	info?: GatewaySessionInfo;
	/** Snapshot the store holds before the view mounts (the copy or the machine's own). */
	snapshot?: boolean;
	replica?: ReplicaInfo;
	waiting?: boolean;
}

async function open(scene: Scene): Promise<{ view: Mounted; client: DaemonClient }> {
	const client = new DaemonClient("ws://x/ws"); // never connected: the store is driven directly
	const store = client.store("m1", "a");
	if (scene.snapshot) {
		store.applySnapshot(5, "e", emptySnapshot({ entries: [userEntry("e1", "hello there")], uiRequests: [ask] }));
	}
	if (scene.waiting) store.setWaiting("machine offline");
	if (scene.replica) store.setReplica(scene.replica);
	const machine = scene.machine ?? machineSummary({ id: "m1", name: "Laptop", online: false });
	const view = await dom.mount(
		<SessionView
			client={client}
			machine="m1"
			machineInfo={machine}
			sessionId="a"
			info={scene.info ?? gatewaySession({ id: "a" })}
			onOpen={() => {}}
			onShowList={() => {}}
			dockSlot={null}
			toolbar={() => null}
			machineSessions={[]}
			relocationTarget={null}
			onRelocate={() => {}}
			handoffs={[]}
			onSwitch={() => {}}
			onOpenHandoff={() => {}}
			onNewSession={async () => null}
			onShowDock={() => {}}
		/>,
	);
	return { view, client };
}

const text = (view: Mounted, selector: string): string => view.query(selector)?.textContent ?? "";

describe("SessionView of an offline machine", () => {
	const complete: ReplicaInfo = {
		state: "complete",
		asOf: Date.now() - 3 * 3_600_000,
		syncedAt: Date.now() - 600_000,
	};

	test("served from a copy it says so, with when it was synced and when the session last changed, and stays read-only", async () => {
		const { view } = await open({
			snapshot: true,
			waiting: true,
			replica: complete,
			info: gatewaySession({ id: "a", access: "free", replica: complete }),
		});
		const banner = view.query(".banner--replica");
		expect(banner?.getAttribute("data-state")).toBe("complete");
		expect(banner?.textContent).toContain("replica of Laptop (offline)");
		expect(banner?.textContent).toContain("last synced");
		expect(banner?.textContent).toContain("minutes ago");
		expect(banner?.textContent).toContain("The session last changed on Laptop");
		expect(banner?.textContent).toContain("3 hours ago");
		expect(banner?.textContent).not.toContain("newer data");
		expect(view.query(".banner--offline")).toBeNull();
		expect(view.query(".takeover")).toBeNull();
		expect(view.query(".composer")).toBeNull();
		expect(view.query(".uireq")).toBeNull();
		await view.unmount();
	});

	test("a partial copy says that the machine had newer data", async () => {
		const partial: ReplicaInfo = { ...complete, state: "partial" };
		const { view } = await open({
			snapshot: true,
			waiting: true,
			replica: partial,
			info: gatewaySession({ id: "a", replica: partial }),
		});
		expect(view.query(".banner--replica")?.getAttribute("data-state")).toBe("partial");
		expect(text(view, ".banner--replica")).toContain("newer data");
		await view.unmount();
	});

	test("while the announced copy is still on its way there is neither the offline banner nor a claim that it is unavailable", async () => {
		const { view } = await open({ waiting: true, info: gatewaySession({ id: "a", replica: complete }) });
		expect(view.query(".banner--replica")).toBeNull();
		expect(view.query(".banner--offline")).toBeNull();
		expect(text(view, ".session-offline-empty")).toContain("Loading the gateway's copy");
		await view.unmount();
	});

	test("without a copy the offline banner stays, and nothing can be sent", async () => {
		const { view } = await open({ waiting: true });
		expect(view.query(".banner--replica")).toBeNull();
		expect(text(view, ".banner--offline")).toContain("Machine Laptop is offline.");
		expect(text(view, ".session-offline-empty")).toContain("Transcript unavailable while Laptop is offline");
		expect(view.query(".composer")).toBeNull();
		await view.unmount();
	});

	test("an offline session without a copy that has a transcript keeps showing it under the offline banner", async () => {
		const { view } = await open({ snapshot: true, waiting: true });
		expect(text(view, ".banner--offline")).toContain("Showing the last transcript received");
		expect(view.query(".banner--replica")).toBeNull();
		await view.unmount();
	});
});

describe("SessionView of an online machine", () => {
	const online = machineSummary({ id: "m1", name: "Laptop" });

	test("a hosted session has the composer or the ui-request dialog, and no replica banner", async () => {
		const { view } = await open({
			machine: online,
			snapshot: true,
			info: gatewaySession({ id: "a", access: "hosted" }),
		});
		expect(view.query(".banner--replica")).toBeNull();
		expect(view.query(".banner--offline")).toBeNull();
		expect(view.query(".uireq")).not.toBeNull(); // the pending question replaces the composer
		await view.unmount();
	});

	test("a free session offers the takeover", async () => {
		const { view } = await open({
			machine: online,
			snapshot: true,
			info: gatewaySession({ id: "a", access: "free" }),
		});
		expect(view.query(".takeover")).not.toBeNull();
		await view.unmount();
	});

	test("a stale copy marker never shows the banner once the machine is online", async () => {
		const copy: ReplicaInfo = { state: "complete", asOf: 1, syncedAt: 2 };
		const { view } = await open({
			machine: online,
			snapshot: true,
			replica: copy,
			info: gatewaySession({ id: "a", access: "hosted" }),
		});
		expect(view.query(".banner--replica")).toBeNull();
		await view.unmount();
	});
});

test("composer text survives leaving the view, stays session-local, and clears only after a successful send", async () => {
	class DraftClient extends DaemonClient {
		accept = false;
		override request(_machine: string, request: ClientRequest): Promise<Ack> {
			return Promise.resolve(
				request.t === "prompt" && this.accept
					? { t: "ack", reqId: "", ok: true, data: undefined }
					: { t: "ack", reqId: "", ok: false, error: "refused" },
			);
		}
	}
	const client = new DraftClient("ws://x/ws");
	const session = (machine: string, id: string) => (
		<SessionView
			key={`${machine}/${id}`}
			client={client}
			machine={machine}
			machineInfo={machineSummary({ id: machine })}
			sessionId={id}
			info={gatewaySession({ id, access: "hosted" })}
			onOpen={() => {}}
			onShowList={() => {}}
			dockSlot={null}
			toolbar={() => null}
			machineSessions={[]}
			relocationTarget={null}
			onRelocate={() => {}}
			handoffs={[]}
			onSwitch={() => {}}
			onOpenHandoff={() => {}}
			onNewSession={async () => null}
			onShowDock={() => {}}
		/>
	);
	for (const [machine, id] of [
		["m1", "a"],
		["m1", "b"],
		["m2", "a"],
	] as const) {
		client.store(machine, id).applySnapshot(1, "e", emptySnapshot());
	}
	const view = await dom.mount(session("m1", "a"));
	const input = "textarea[name=message]";
	await view.type(input, "未发送的文字\nsecond line");
	expect(client.store("m1", "a").getSnapshot().draft).toBe("未发送的文字\nsecond line");
	await view.rerender(null);
	client.store("m1", "a").applySnapshot(2, "e", emptySnapshot());
	await view.rerender(session("m1", "b"));
	expect(view.query(input)?.value).toBe("");
	await view.type(input, "another session");
	await view.rerender(session("m2", "a"));
	expect(view.query(input)?.value).toBe("");
	await view.rerender(session("m1", "a"));
	expect(view.query(input)?.value).toBe("未发送的文字\nsecond line");
	await view.click(".composer .btn--primary");
	await view.rerender(null);
	await view.rerender(session("m1", "a"));
	expect(view.query(input)?.value).toBe("未发送的文字\nsecond line");
	client.accept = true;
	await view.click(".composer .btn--primary");
	await view.rerender(null);
	await view.rerender(session("m1", "a"));
	expect(view.query(input)?.value).toBe("");
	await view.rerender(session("m1", "b"));
	expect(view.query(input)?.value).toBe("another session");
	await view.unmount();
});

describe("omp's terminal-only builtins run as omp-web's own actions", () => {
	const COMMAND_REQUESTS: Record<string, true> = {
		"session.fork": true,
		"session.btw": true,
		"session.close": true,
		follow_up: true,
		prompt: true,
	};
	class CommandClient extends DaemonClient {
		requests: ClientRequest[] = [];
		override request(_machine: string, request: ClientRequest): Promise<Ack> {
			if (!COMMAND_REQUESTS[request.t]) {
				return Promise.resolve({ t: "ack", reqId: "", ok: false, error: "not in this test" });
			}
			this.requests.push(request);
			return Promise.resolve({ t: "ack", reqId: "", ok: true, data: { sessionId: "copy" } });
		}
	}
	async function run(text: string, commands: SlashCommandWire[] = []) {
		const client = new CommandClient("ws://x/ws");
		client.store("m1", "a").applySnapshot(1, "e", emptySnapshot({ commands }));
		const calls: string[] = [];
		const view = await dom.mount(
			<SessionView
				client={client}
				machine="m1"
				machineInfo={machineSummary({ id: "m1" })}
				sessionId="a"
				info={gatewaySession({ id: "a", access: "hosted" })}
				onOpen={id => calls.push(`open ${id}`)}
				onShowList={() => calls.push("list")}
				dockSlot={null}
				toolbar={() => null}
				machineSessions={[]}
				relocationTarget={null}
				onRelocate={() => {}}
				handoffs={[]}
				onSwitch={() => {}}
				onOpenHandoff={() => {}}
				onNewSession={async () => {
					calls.push("new");
					return null;
				}}
				onShowDock={tab => calls.push(`dock ${tab}`)}
			/>,
		);
		await view.type("textarea[name=message]", text);
		await view.click(".composer .btn--primary");
		const draft = view.query("textarea[name=message]")?.value;
		await view.unmount();
		return { sent: client.requests, calls, draft };
	}

	test("/new starts a session as the sidebar does, without prompting omp", async () => {
		expect(await run("/new")).toEqual({ sent: [], calls: ["new"], draft: "" });
	});

	test("/fork forks through the daemon and opens the copy", async () => {
		const { sent, calls } = await run("/fork");
		expect(sent).toEqual([{ t: "session.fork", sessionId: "a" }]);
		expect(calls).toEqual(["open copy"]);
	});

	test("/btw asks the side question and opens the BTW tab", async () => {
		const { sent, calls } = await run("/btw why is CI red?");
		expect(sent).toEqual([{ t: "session.btw", sessionId: "a", question: "why is CI red?" }]);
		expect(calls).toEqual(["dock btw"]);
	});

	test("/queue sends its message as a follow-up; /exit closes the session and leaves it", async () => {
		expect((await run("/queue then run the tests")).sent).toEqual([
			{ t: "follow_up", sessionId: "a", message: "then run the tests" },
		]);
		const exit = await run("/quit");
		expect(exit.sent).toEqual([{ t: "session.close", sessionId: "a" }]);
		expect(exit.calls).toEqual(["list"]);
	});

	test("a session command of the same name goes to omp", async () => {
		const { sent, calls } = await run("/new", [{ name: "new", source: "extension" }]);
		expect(sent).toEqual([{ t: "prompt", sessionId: "a", message: "/new" }]);
		expect(calls).toEqual([]);
	});
});

describe("SessionView of a fresh session moving to another project or worktree", () => {
	const app = project("/p/app", [worktree("/p/app", { main: true }), worktree("/wt/x", { branch: "x" })]);
	const solo = project("/p/solo");
	const online = machineSummary({ id: "m1", name: "Laptop", home: "/p", projects: [app, solo] });
	const hosted = gatewaySession({
		id: "a",
		access: "hosted",
		cwd: "/p/app",
		projectRoot: "/p/app",
		worktreeRoot: "/p/app",
	});
	const status = (overrides: Partial<SessionStatus> = {}): SessionStatus => ({
		sessionId: "a",
		cwd: "/p/app",
		model: "anthropic/claude-sonnet-4-5",
		thinkingLevel: "high",
		isStreaming: false,
		isCompacting: false,
		queue: { steering: [], followUp: [], liveSteered: 0 },
		todos: [],
		...overrides,
	});

	class RecordingClient extends DaemonClient {
		requests: ClientRequest[] = [];
		machines: string[] = [];
		/** Answers to session.create; everything the view asks on its own (theme, roles, ...) is refused. */
		created: Ack = { t: "ack", reqId: "", ok: true, data: { sessionId: "new1" } };
		/** When set, session.create waits for the test to release it. */
		hold: Promise<void> | null = null;
		override request(_machine: string, request: ClientRequest): Promise<Ack> {
			if (request.t === "session.create") {
				this.machines.push(_machine);
				this.requests.push(request);
				return (this.hold ?? Promise.resolve()).then(() => this.created);
			}
			if (request.t === "session.close") {
				this.requests.push(request);
				this.machines.push(_machine);
				return Promise.resolve({ t: "ack", reqId: "", ok: true, data: undefined });
			}
			return Promise.resolve({ t: "ack", reqId: "", ok: false, error: "not in this test" });
		}
	}

	interface Relocation {
		id: string;
		target: Selection;
		draft: string;
		attachments: DraftAttachments;
		backend: SessionBackend;
	}
	async function mount(options: {
		entries?: boolean;
		status?: SessionStatus | null;
		info?: GatewaySessionInfo;
		working?: boolean;
	}): Promise<{
		view: Mounted;
		client: RecordingClient;
		moved: Relocation[];
		choose(target: Selection): Promise<void>;
		/** Lets a sidebar choice stand long enough for the view to act on it. */
		settle(): Promise<void>;
	}> {
		const client = new RecordingClient("ws://x/ws");
		client.store("m1", "a").applySnapshot(
			5,
			"e",
			emptySnapshot({
				entries: options.entries ? [userEntry("e1", "hello there")] : [],
				status: options.status === undefined ? status() : options.status,
				working: options.working ?? false,
			}),
		);
		const moved: Relocation[] = [];
		const render = (target: Selection | null) => (
			<SessionView
				client={client}
				machine="m1"
				machineInfo={online}
				sessionId="a"
				info={options.info ?? hosted}
				onOpen={() => {}}
				onShowList={() => {}}
				dockSlot={null}
				toolbar={() => null}
				machineSessions={[]}
				relocationTarget={target}
				onRelocate={next => moved.push(next)}
				handoffs={[]}
				onSwitch={() => {}}
				onOpenHandoff={() => {}}
				onNewSession={async () => null}
				onShowDock={() => {}}
			/>
		);
		const view = await dom.mount(render(null));
		return {
			view,
			client,
			moved,
			choose: target => view.rerender(render(target)),
			settle: () => view.act(() => Bun.sleep(350)),
		};
	}

	test("before its first message the status line holds the project and worktree chips instead of the path", async () => {
		const { view } = await mount({});
		expect(view.query(".status-line .chip--button[title=Project]")?.textContent).toContain("app");
		expect(view.query(".status-line .chip--button[title='Worktree and branch']")?.textContent).toContain("main");
		expect(view.query(".status-line .status-path")).toBeNull();
		expect(view.query(".status-line .status-git")).toBeNull();
		await view.unmount();
	});

	test("picking a worktree creates a session there with the model and thinking level, closes this one, and hands over the draft", async () => {
		const { view, client, moved } = await mount({});
		await view.type("textarea[name=message]", "start with the tests");
		await view.click(".status-line .chip--button[title='Worktree and branch']");
		await view.click(".chip-option[data-worktree='/wt/x']");
		await view.until(() => moved.length > 0);
		expect(client.requests).toEqual([
			{ t: "session.create", cwd: "/wt/x", model: "anthropic/claude-sonnet-4-5:high" },
			{ t: "session.close", sessionId: "a" },
		]);
		expect(moved).toEqual([
			{
				id: "new1",
				target: { machine: "m1", project: "/p/app", worktree: "/wt/x" },
				draft: "start with the tests",
				attachments: { images: [], pastes: [] },
				backend: "omp",
			},
		]);
		await view.unmount();
	});

	test("picking another project lands on its main worktree; without a thinking level only the model is carried", async () => {
		const { view, client, moved } = await mount({ status: status({ thinkingLevel: undefined }) });
		await view.click(".status-line .chip--button[title=Project]");
		await view.click(".project-option[data-project='/p/solo']");
		await view.until(() => moved.length > 0);
		expect(client.requests[0]).toEqual({ t: "session.create", cwd: "/p/solo", model: "anthropic/claude-sonnet-4-5" });
		expect(moved[0]!.target).toEqual({ machine: "m1", project: "/p/solo", worktree: "/p/solo" });
		expect(moved[0]!.draft).toBe("");
		await view.unmount();
	});

	test("a sidebar project choice relocates the fresh session and preserves its draft", async () => {
		const { view, client, moved, choose, settle } = await mount({});
		await view.type("textarea[name=message]", "keep this draft");
		await choose({ machine: "m1", project: "/p/solo", worktree: "/p/solo" });
		await settle();
		await view.until(() => moved.length > 0);
		expect(client.requests).toEqual([
			{ t: "session.create", cwd: "/p/solo", model: "anthropic/claude-sonnet-4-5:high" },
			{ t: "session.close", sessionId: "a" },
		]);
		expect(moved[0]).toMatchObject({
			target: { machine: "m1", project: "/p/solo", worktree: "/p/solo" },
			draft: "keep this draft",
		});
		await view.unmount();
	});

	test("a sidebar machine choice creates on the target machine even when its worktree path is identical", async () => {
		const { view, client, moved, choose, settle } = await mount({});
		await choose({ machine: "m2", project: "/p/app", worktree: "/p/app" });
		await settle();
		await view.until(() => moved.length > 0);
		expect(client.machines).toEqual(["m2", "m1"]);
		expect(moved[0]!.target).toEqual({ machine: "m2", project: "/p/app", worktree: "/p/app" });
		await view.unmount();
	});

	test("flipping machines in the sidebar and back starts no session and stays here", async () => {
		const { view, client, moved, choose, settle } = await mount({});
		await choose({ machine: "m2", project: "/p/app", worktree: "/p/app" });
		await choose({ machine: "m1", project: "/p/app", worktree: "/p/app" });
		await settle();
		expect(client.requests).toEqual([]);
		expect(moved).toEqual([]);
		await view.unmount();
	});

	test("a sidebar move still being created when the choice changes back is closed, not followed", async () => {
		const { view, client, moved, choose, settle } = await mount({});
		const { promise, resolve: release } = Promise.withResolvers<void>();
		client.hold = promise;
		await choose({ machine: "m2", project: "/p/app", worktree: "/p/app" });
		await settle();
		await view.until(() => client.requests.length > 0);
		await choose({ machine: "m1", project: "/p/app", worktree: "/p/app" });
		release();
		await view.until(() => client.requests.length > 1);
		expect(client.requests[1]).toEqual({ t: "session.close", sessionId: "new1" });
		expect(client.machines).toEqual(["m2", "m2"]);
		await settle();
		expect(moved).toEqual([]);
		await view.unmount();
	});

	test("sidebar choices never relocate sessions with messages or active work", async () => {
		for (const options of [{ entries: true }, { working: true }]) {
			const { view, client, moved, choose, settle } = await mount(options);
			await choose({ machine: "m1", project: "/p/solo", worktree: "/p/solo" });
			await settle();
			expect(client.requests).toEqual([]);
			expect(moved).toEqual([]);
			await view.unmount();
		}
	});

	test("choosing the worktree it is already in changes nothing", async () => {
		const { view, client, moved } = await mount({});
		await view.click(".status-line .chip--button[title='Worktree and branch']");
		await view.click(".chip-option[data-worktree='/p/app']");
		expect(client.requests).toEqual([]);
		expect(moved).toEqual([]);
		await view.unmount();
	});

	test("a refused create keeps this session, shows the error and does not close it", async () => {
		const { view, client, moved } = await mount({});
		client.created = { t: "ack", reqId: "", ok: false, error: "no such directory" };
		await view.click(".status-line .chip--button[title='Worktree and branch']");
		await view.click(".chip-option[data-worktree='/wt/x']");
		await view.until(() => view.query(".session-move-error") !== null);
		expect(view.query(".session-move-error")?.textContent).toBe("no such directory");
		expect(client.requests.map(r => r.t)).toEqual(["session.create"]);
		expect(moved).toEqual([]);
		await view.unmount();
	});

	test("once the session has a message, or while it works, or when it is not hosted, the path is shown and the chips are not", async () => {
		const withMessage = await mount({ entries: true });
		expect(withMessage.view.query(".status-line .status-path")?.textContent).toContain("~/app");
		expect(withMessage.view.query(".status-line .chip-menu")).toBeNull();
		await withMessage.view.unmount();

		const working = await mount({ working: true });
		expect(working.view.query(".status-line .chip-menu")).toBeNull();
		expect(working.view.query(".status-line .status-path")).not.toBeNull();
		await working.view.unmount();

		const free = await mount({ info: gatewaySession({ id: "a", access: "free", cwd: "/p/app" }) });
		expect(free.view.query(".status-line .chip--button[title=Project]")).toBeNull();
		await free.view.unmount();
	});
});
