import "./dom-shim";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Ack, GatewaySessionInfo, HandoffPlan, HandoffWire } from "@omp-web/protocol";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HandoffChip } from "../src/components/handoff/handoff-chip";
import { HopHistory } from "../src/components/handoff/hop-history";
import { MovedBanner } from "../src/components/handoff/moved-banner";
import { SwitchEnvironment, type SwitchTarget } from "../src/components/handoff/switch-environment";
import { useHandoffNavigation } from "../src/components/handoff/use-handoff-navigation";
import { SessionList } from "../src/components/session-list";
import { SessionView } from "../src/components/session-view";
import type { SessionRef } from "../src/lib/route";
import { DaemonClient, type HandoffRequest } from "../src/store/daemon-client";
import { type FakeDom, installFakeDom, type Mounted } from "./fake-dom";
import { gatewaySession, machineSummary } from "./fixtures";
import { carried, forecast, hop, plan, steps, wire } from "./handoff-fixtures";

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

const noop = (): void => {};

class RecordingClient extends DaemonClient {
	requests: HandoffRequest[] = [];
	answer: (request: HandoffRequest) => Ack = () => ({ t: "ack", reqId: "", ok: true });
	override handoffRequest(request: HandoffRequest): Promise<Ack> {
		this.requests.push(request);
		return Promise.resolve(this.answer(request));
	}
}

const desk = machineSummary({ id: "desk", name: "Desktop" });
const lap = machineSummary({ id: "lap", name: "Laptop" });
const off = machineSummary({ id: "off", name: "Server", online: false });
const machines = [desk, lap, off];

const planTarget: SwitchTarget = { kind: "plan", machine: "desk", sessionId: "a", title: "Fix the build" };
const text = (view: Mounted, selector: string): string => view.query(selector)?.textContent ?? "";
const testid = (id: string): string => `[data-testid='${id}']`;

async function mountDialog(
	client: RecordingClient,
	target: SwitchTarget,
	handoffs: readonly HandoffWire[] = [],
	confirmedHere = new Set<string>(),
): Promise<{
	view: Mounted;
	show(list: readonly HandoffWire[]): Promise<void>;
	confirmedHere: Set<string>;
	closed: { count: number };
}> {
	const closed = { count: 0 };
	const element = (list: readonly HandoffWire[]): ReactNode => (
		<SwitchEnvironment
			client={client}
			machines={machines}
			handoffs={list}
			target={target}
			onClose={() => closed.count++}
			confirmedHere={confirmedHere}
		/>
	);
	const view = await dom.mount(element(handoffs));
	return { view, show: (list: readonly HandoffWire[]) => view.rerender(element(list)), confirmedHere, closed };
}

const planAck = (data: HandoffPlan): Ack => ({ t: "ack", reqId: "", ok: true, data });

describe("SwitchEnvironment: picking the target", () => {
	test("every machine is a row, the current one included (a worktree switch) and an offline one disabled with 'offline'", async () => {
		const { view } = await mountDialog(new RecordingClient("ws://x"), planTarget);
		expect(view.query(testid("handoff-dialog"))).not.toBeNull();
		expect(text(view, ".handoff-title")).toBe("Fix the build");
		expect(view.query(testid("handoff-machine-desk"))?.disabled).toBe(false);
		expect(text(view, testid("handoff-machine-desk"))).toContain("this machine");
		expect(view.query(testid("handoff-machine-lap"))?.disabled).toBe(false);
		const server = view.query(testid("handoff-machine-off"))!;
		expect(server.disabled).toBe(true);
		expect(server.getAttribute("data-online")).toBe("false");
		expect(server.textContent).toContain("offline");
		await view.unmount();
	});

	test("picking a machine asks for the plan of this session on that machine", async () => {
		const client = new RecordingClient("ws://x");
		client.answer = () => planAck(plan());
		const { view } = await mountDialog(client, planTarget);
		await view.click(testid("handoff-machine-lap"));
		expect(client.requests).toEqual([{ t: "handoff.plan", m: "desk", sessionId: "a", targetMachine: "lap" }]);
		await view.until(() => view.query(testid("handoff-plan")) !== null);
		await view.unmount();
	});

	test("a refused plan request is shown and offers no start", async () => {
		const client = new RecordingClient("ws://x");
		client.answer = () => ({ t: "ack", reqId: "", ok: false, error: "session not found" });
		const { view } = await mountDialog(client, planTarget);
		await view.click(testid("handoff-machine-lap"));
		await view.until(() => view.query(testid("handoff-plan-error")) !== null);
		expect(text(view, testid("handoff-plan-error"))).toBe("session not found");
		expect(view.query(testid("handoff-start"))).toBeNull();
		await view.unmount();
	});
});

describe("SwitchEnvironment: the plan", () => {
	const blocker = "Project app not on Laptop: clone it there and register the project first";

	async function planned(
		next: HandoffPlan,
		client = new RecordingClient("ws://x"),
	): Promise<{ view: Mounted; client: RecordingClient }> {
		client.answer = request =>
			request.t === "handoff.plan" ? planAck(next) : { t: "ack", reqId: "", ok: true, data: { id: "h-new-0001" } };
		const { view } = await mountDialog(client, planTarget);
		await view.click(testid("handoff-machine-lap"));
		await view.until(() => view.query(testid("handoff-plan")) !== null);
		return { view, client };
	}

	test("blockers are shown verbatim and prominently, and Start stays disabled", async () => {
		const { view } = await planned(plan({ blockers: [blocker], target: { ...plan().target!, project: null } }));
		expect(view.query(testid("handoff-blockers"))?.getAttribute("role")).toBe("alert");
		expect(text(view, testid("handoff-blockers"))).toBe(blocker);
		expect(view.query(testid("handoff-start"))?.disabled).toBe(true);
		expect(view.query(testid("handoff-targets"))).toBeNull(); // no project there: nothing to choose
		await view.unmount();
	});

	test("an ok plan shows the project, the source preview and the staged note, and Start is enabled", async () => {
		const { view } = await planned(plan());
		expect(view.query(testid("handoff-blockers"))).toBeNull();
		expect(text(view, testid("handoff-project"))).toContain("/home/me/app");
		const source = text(view, testid("handoff-source"));
		expect(source).toContain("branch main");
		expect(source).toContain("0123456"); // short head
		expect(source).not.toContain("0123456789abcdef");
		expect(text(view, testid("handoff-counts"))).toContain("3 modified, 1 added");
		expect(text(view, testid("handoff-counts"))).toContain("2 untracked files");
		expect(text(view, testid("handoff-staged"))).toBe("staged preserved (2 paths)");
		expect(view.query(testid("handoff-start"))?.disabled).toBe(false);
		await view.unmount();
	});

	test("Not carried lists skipped paths with reasons and the ignored files, each cut with 'and N more'", async () => {
		const skipped = Array.from({ length: 12 }, (_, i) => ({
			path: `big${i}.bin`,
			reason: "too-large" as const,
			size: 5 * 1024 * 1024,
		}));
		const next = plan({
			repo: {
				...plan().repo!,
				preview: carried({
					skipped,
					ignored: { count: 100, sample: ["node_modules/", "dist/", "a/", "b/", "c/", "d/", "e/"] },
				}),
			},
		});
		const { view } = await planned(next);
		const rows = view.queryAll(`${testid("handoff-skipped")} li`);
		expect(rows.length).toBe(9);
		expect(rows[0]?.textContent).toBe("big0.bin (file too large, 5.0 MiB)");
		expect(rows[8]?.textContent).toBe("and 4 more");
		const ignored = view.queryAll(`${testid("handoff-ignored")} li`);
		expect(ignored.map(li => li.textContent)).toEqual(["node_modules/", "dist/", "a/", "b/", "c/", "and 95 more"]);
		expect(text(view, testid("handoff-ignored"))).toContain("100 ignored files stay behind");
		await view.unmount();
	});

	test("a new worktree is preselected; ineligible worktrees are greyed with their reason and cannot be picked", async () => {
		const base = plan();
		const next = plan({
			target: {
				...base.target!,
				worktrees: [
					{ path: "/home/me/wt1", branch: "feature", head: "0123456789", eligible: true, isSource: false },
					{
						path: "/home/me/wt2",
						branch: "other",
						head: "9999999999",
						eligible: false,
						reason: "has uncommitted changes",
						isSource: false,
					},
				],
			},
		});
		const { view, client } = await planned(next);
		expect(text(view, testid("handoff-target-new"))).toContain(
			"New worktree /home/me/app.omp-worktrees/abc123 on branch omp-web/abc123",
		);
		expect(view.query(`${testid("handoff-target-new")} input`)?.hasAttribute("checked")).toBe(false); // property, not attribute
		const off = view.query("[data-worktree='/home/me/wt2']")!;
		expect(off.getAttribute("data-eligible")).toBe("false");
		expect(off.className).toContain("handoff-choice--off");
		expect(off.textContent).toContain("not usable: has uncommitted changes");
		expect(view.query("[data-worktree='/home/me/wt2'] input")?.disabled).toBe(true);
		expect(view.query("[data-worktree='/home/me/wt1'] input")?.disabled).toBe(false);

		await view.click(testid("handoff-start")); // the default: a new worktree
		expect(client.requests.at(-1)).toEqual({
			t: "handoff.start",
			m: "desk",
			sessionId: "a",
			targetMachine: "lap",
			target: { mode: "new" },
		});
		await view.until(() => view.query(testid("handoff-starting")) !== null);
		await view.unmount();
	});

	test("choosing an existing worktree starts with it", async () => {
		const base = plan();
		const { view, client } = await planned(
			plan({
				target: {
					...base.target!,
					worktrees: [
						{ path: "/home/me/wt1", branch: "feature", head: "0123456789", eligible: true, isSource: false },
					],
				},
			}),
		);
		const radio = view.query("[data-worktree='/home/me/wt1'] input")!;
		await view.act(() => {
			Object.assign(radio, { checked: true }); // as the browser does before it fires the click's change
			radio.click();
		});
		await view.click(testid("handoff-start"));
		expect(client.requests.at(-1)).toMatchObject({
			t: "handoff.start",
			target: { mode: "existing", worktree: "/home/me/wt1" },
		});
		await view.unmount();
	});

	test("a refused start is shown where the button is and nothing else changes", async () => {
		const client = new RecordingClient("ws://x");
		client.answer = request =>
			request.t === "handoff.plan"
				? planAck(plan())
				: { t: "ack", reqId: "", ok: false, error: "thread is locked", code: "handoff" };
		const { view } = await mountDialog(client, planTarget);
		await view.click(testid("handoff-machine-lap"));
		await view.until(() => view.query(testid("handoff-start")) !== null);
		await view.click(testid("handoff-start"));
		await view.until(() => view.query(testid("handoff-request-error")) !== null);
		expect(text(view, testid("handoff-request-error"))).toBe("thread is locked");
		expect(view.query(testid("handoff-start"))?.disabled).toBe(false);
		await view.unmount();
	});

	test("once the gateway lists the started operation the dialog shows its progress", async () => {
		const client = new RecordingClient("ws://x");
		client.answer = request =>
			request.t === "handoff.plan" ? planAck(plan()) : { t: "ack", reqId: "", ok: true, data: { id: "h-new-0001" } };
		const { view, show } = await mountDialog(client, planTarget);
		await view.click(testid("handoff-machine-lap"));
		await view.until(() => view.query(testid("handoff-start")) !== null);
		await view.click(testid("handoff-start"));
		await view.until(() => view.query(testid("handoff-starting")) !== null);
		await show([wire({ id: "h-new-0001" })]);
		expect(view.query(testid("handoff-progress"))?.getAttribute("data-phase")).toBe("running");
		await view.unmount();
	});
});

describe("SwitchEnvironment: progress, driven by the wire only", () => {
	const open = (w: HandoffWire, client = new RecordingClient("ws://x")) =>
		mountDialog(client, { kind: "handoff", id: w.id }, [w]);

	test("the eight steps with icon, state in words, detail, and a byte bar for a transfer", async () => {
		const running = wire({
			steps: steps(3, true, {
				preflight: { detail: "both machines ready" },
				bundle: {
					status: "running",
					detail: "bundle 4.2 MiB (thin)",
					bytes: { done: 1024 * 1024, total: 4 * 1024 * 1024 },
				},
			}),
		});
		// steps(3): preflight, commit, capture done, bundle running
		const { view } = await open(running);
		expect(view.queryAll(`${testid("handoff-steps")} li`).length).toBe(8);
		expect(view.query(testid("handoff-step-preflight"))?.getAttribute("data-status")).toBe("done");
		expect(text(view, testid("handoff-step-preflight"))).toContain("both machines ready");
		expect(view.query(testid("handoff-step-bundle"))?.getAttribute("data-status")).toBe("running");
		expect(view.query(testid("handoff-step-worktree"))?.getAttribute("data-status")).toBe("pending");
		const bar = view.query(testid("handoff-bar-bundle"))!;
		expect(bar.getAttribute("aria-valuenow")).toBe("25");
		expect(text(view, testid("handoff-step-bundle"))).toContain("1.0 MiB / 4.0 MiB (25%)");
		expect(view.query(testid("handoff-bar-commit"))).toBeNull();
		expect(text(view, testid("handoff-phase"))).toBe("Switching to Laptop: Transfer the repository…");
		await view.unmount();
	});

	test("while running, Cancel sends handoff.cancel; there is no confirm and no dismiss", async () => {
		const client = new RecordingClient("ws://x");
		const { view } = await open(wire(), client);
		expect(view.query(testid("handoff-confirm"))).toBeNull();
		expect(view.query(testid("handoff-dismiss"))).toBeNull();
		await view.click(testid("handoff-cancel"));
		expect(client.requests).toEqual([{ t: "handoff.cancel", id: "h-0001-aaaa" }]);
		await view.unmount();
	});

	test("a refused cancel shows the gateway's words", async () => {
		const client = new RecordingClient("ws://x");
		client.answer = () => ({ t: "ack", reqId: "", ok: false, error: "already rolling back", code: "handoff" });
		const { view } = await open(wire(), client);
		await view.click(testid("handoff-cancel"));
		await view.until(() => view.query(testid("handoff-request-error")) !== null);
		expect(text(view, testid("handoff-request-error"))).toBe("already rolling back");
		await view.unmount();
	});

	const confirmable = wire({
		phase: "awaiting_confirm",
		steps: steps(8, false),
		forecast: forecast(),
		expiresAt: Date.now() + 4 * 60_000 + 30_000,
		carried: carried({ skipped: [{ path: "x.bin", reason: "lfs" }], ignored: { count: 3, sample: ["dist/"] } }),
		droppedDirectories: ["/extra/one", "/extra/two"],
		bundle: { bytes: 4_400_000, full: false, prerequisites: 3 },
	});

	test("the forecast panel: headline class, estimate, every item as a row, '(inference)' in words, carried, dropped dirs, countdown", async () => {
		const { view } = await open(confirmable);
		const panel = view.query(testid("handoff-forecast"))!;
		expect(panel.getAttribute("data-summary")).toBe("partial");
		expect(panel.className).toContain("handoff-forecast--partial");
		expect(text(view, testid("handoff-forecast-headline"))).toBe(forecast().headline);
		expect(text(view, testid("handoff-forecast-word"))).toBe("Cache partially hit");
		expect(text(view, testid("handoff-forecast-rewrite"))).toBe("~12,300 tokens would be written again (estimate)");

		const rows = view.queryAll(`${testid("handoff-forecast-items")} li`);
		expect(rows.length).toBe(10);
		for (const id of [
			"tools",
			"systemHead",
			"systemTail",
			"history",
			"model",
			"thinking",
			"tier",
			"account",
			"ttl",
			"cacheKey",
		]) {
			expect(view.query(testid(`handoff-forecast-item-${id}`))).not.toBeNull();
		}
		expect(view.query(testid("handoff-forecast-item-systemTail"))?.getAttribute("data-status")).toBe("miss");
		expect(text(view, testid("handoff-forecast-item-tools"))).toContain("Tool definitions detail");
		// Flagged items carry the marker as text; unflagged ones do not.
		for (const id of ["account", "ttl", "cacheKey"]) {
			expect(view.query(testid(`handoff-forecast-item-${id}`))?.getAttribute("data-inference")).toBe("true");
			expect(text(view, testid(`handoff-forecast-item-${id}`))).toContain("(inference)");
		}
		for (const id of ["tools", "history", "model"]) {
			expect(text(view, testid(`handoff-forecast-item-${id}`))).not.toContain("(inference)");
		}
		expect(text(view, testid("handoff-forecast-carried"))).toContain("x.bin (Git LFS path)");
		expect(text(view, testid("handoff-dropped-dirs"))).toContain("/extra/two");
		expect(text(view, testid("handoff-expiry"))).toMatch(/Rolls back by itself in 4:[23]\d unless you confirm/);
		expect(view.query(testid("handoff-confirm"))?.disabled).toBe(false);
		expect(text(view, testid("handoff-confirm"))).toBe("Confirm switch");
		expect(text(view, testid("handoff-cancel"))).toBe("Cancel switch");
		await view.unmount();
	});

	test("hit and miss summaries get their own class; a forecast that cannot estimate says so", async () => {
		const hit = await open(
			wire({
				phase: "awaiting_confirm",
				steps: steps(8, false),
				forecast: forecast({ summary: "hit", rewriteTokens: 0 }),
			}),
		);
		expect(hit.view.query(testid("handoff-forecast"))?.className).toContain("handoff-forecast--hit");
		expect(text(hit.view, testid("handoff-forecast-rewrite"))).toBe(
			"None of the existing prompt would be written again (estimate); the new message is always written",
		);
		await hit.view.unmount();
		const miss = await open(
			wire({
				phase: "awaiting_confirm",
				steps: steps(8, false),
				forecast: forecast({ summary: "miss", rewriteTokens: null }),
			}),
		);
		expect(miss.view.query(testid("handoff-forecast"))?.className).toContain("handoff-forecast--miss");
		expect(text(miss.view, testid("handoff-forecast-rewrite"))).toContain("cannot be estimated");
		await miss.view.unmount();
	});

	test("Confirm switch marks this tab as the one that confirmed and sends handoff.confirm; a refusal unmarks it", async () => {
		const client = new RecordingClient("ws://x");
		const { view, confirmedHere } = await open(confirmable, client);
		await view.click(testid("handoff-confirm"));
		expect(client.requests).toEqual([{ t: "handoff.confirm", id: "h-0001-aaaa" }]);
		expect(confirmedHere.has("h-0001-aaaa")).toBe(true);
		await view.unmount();

		const refused = new RecordingClient("ws://x");
		refused.answer = () => ({ t: "ack", reqId: "", ok: false, error: "expired", code: "handoff" });
		const second = await open(confirmable, refused);
		await second.view.click(testid("handoff-confirm"));
		await second.view.until(() => second.view.query(testid("handoff-request-error")) !== null);
		expect(second.confirmedHere.has("h-0001-aaaa")).toBe(false);
		await second.view.unmount();
	});

	test("Cancel switch sends handoff.cancel", async () => {
		const client = new RecordingClient("ws://x");
		const { view } = await open(confirmable, client);
		await view.click(testid("handoff-cancel"));
		expect(client.requests).toEqual([{ t: "handoff.cancel", id: "h-0001-aaaa" }]);
		await view.unmount();
	});

	test("an expired countdown says so and disables Confirm", async () => {
		const { view } = await open({ ...confirmable, expiresAt: Date.now() - 1000 });
		expect(view.query(testid("handoff-expiry"))?.getAttribute("data-expired")).toBe("true");
		expect(view.query(testid("handoff-confirm"))?.disabled).toBe(true);
		await view.unmount();
	});

	test("failed: the exact sentence, the failed step, no cancel; Dismiss hides it and closes", async () => {
		const client = new RecordingClient("ws://x");
		const failed = wire({
			phase: "failed",
			error: "bundle exceeds 512 MiB",
			steps: steps(3, false, { bundle: { status: "failed", detail: "bundle exceeds 512 MiB" } }),
		});
		const { view, closed } = await open(failed, client);
		expect(text(view, testid("handoff-phase"))).toBe("Switch failed and was rolled back: bundle exceeds 512 MiB");
		expect(view.query(testid("handoff-phase"))?.className).toContain("handoff-phase--bad");
		expect(view.query(testid("handoff-step-bundle"))?.getAttribute("data-status")).toBe("failed");
		expect(view.query(testid("handoff-cancel"))).toBeNull();
		await view.click(testid("handoff-dismiss"));
		expect(client.requests).toEqual([{ t: "handoff.dismiss", id: "h-0001-aaaa" }]);
		expect(closed.count).toBe(1);
		await view.unmount();
	});

	test("rolled back: 'Cancelled. Nothing was changed on either machine.'", async () => {
		const { view } = await open(wire({ phase: "rolled_back" }));
		expect(text(view, testid("handoff-phase"))).toBe("Cancelled. Nothing was changed on either machine.");
		expect(view.query(testid("handoff-dismiss"))).not.toBeNull();
		await view.unmount();
	});

	test("rolling back shows what is being undone and offers neither confirm, cancel nor dismiss", async () => {
		const { view } = await open(wire({ phase: "rolling_back", error: "link lost" }));
		expect(text(view, testid("handoff-phase"))).toContain("Rolling back");
		expect(view.query(testid("handoff-cancel"))).toBeNull();
		expect(view.query(testid("handoff-confirm"))).toBeNull();
		expect(view.query(testid("handoff-dismiss"))).toBeNull();
		await view.unmount();
	});

	test("rollback failed: the error and every leftover are shown, the thread stays locked (no dismiss)", async () => {
		const stuck = wire({
			phase: "rollback_failed",
			error: "could not remove the worktree",
			leftovers: ["Laptop: worktree /home/me/app.omp-worktrees/abc123", "Laptop: branch omp-web/abc123"],
		});
		const { view } = await open(stuck);
		expect(text(view, testid("handoff-phase"))).toContain(
			"the rollback did not finish: could not remove the worktree",
		);
		const leftovers = view.queryAll(`${testid("handoff-leftovers")} li`).map(li => li.textContent);
		expect(leftovers).toEqual(stuck.leftovers!);
		expect(view.query(testid("handoff-dismiss"))).toBeNull();
		expect(view.query(testid("handoff-cancel"))).toBeNull();
		await view.unmount();
	});

	test("completed: the new location is a link, a warning of the result is shown, Dismiss is offered", async () => {
		const done = wire({
			phase: "completed",
			steps: steps(8, false),
			result: {
				sessionId: "new1",
				worktree: "/home/me/wt",
				branch: "omp-web/x",
				sourceMarked: false,
				warning: "old copy still open",
			},
		});
		const { view } = await open(done);
		expect(view.query(testid("handoff-open-new"))?.getAttribute("href")).toBe("#/m/lap/s/new1");
		expect(text(view, testid("handoff-warning"))).toBe("old copy still open");
		expect(view.container.textContent).toContain("could not be marked as moved");
		expect(view.query(testid("handoff-dismiss"))).not.toBeNull();
		await view.unmount();
	});

	test("an operation that vanished from the list says so instead of showing stale data", async () => {
		const client = new RecordingClient("ws://x");
		const { view } = await mountDialog(client, { kind: "handoff", id: "h-gone-0001" }, []);
		expect(view.query(testid("handoff-missing"))).not.toBeNull();
		expect(view.query(testid("handoff-progress"))).toBeNull();
		await view.unmount();
	});

	test("the same wire renders the same screen on a fresh mount (reload / second tab)", async () => {
		const w = wire({ steps: steps(2) });
		const a = await open(w);
		const b = await open(w);
		expect(b.view.container.textContent).toBe(a.view.container.textContent);
		await a.view.unmount();
		await b.view.unmount();
	});

	test("Escape and the close button close the dialog without touching the operation", async () => {
		const client = new RecordingClient("ws://x");
		const { view, closed } = await open(wire(), client);
		await view.click(testid("handoff-close"));
		expect(closed.count).toBe(1);
		expect(client.requests).toEqual([]);
		await view.unmount();
	});
});

describe("navigation after completion", () => {
	function Harness({
		list,
		confirmed,
		onNavigate,
	}: {
		list: readonly HandoffWire[];
		confirmed: Set<string>;
		onNavigate(to: SessionRef): void;
	}): ReactNode {
		useHandoffNavigation(list, confirmed, onNavigate);
		return null;
	}
	const result = { sessionId: "new1", worktree: "/w", branch: "b", sourceMarked: true };

	test("the tab that confirmed navigates to the new location once; another tab does not", async () => {
		const here: SessionRef[] = [];
		const other: SessionRef[] = [];
		const completed = wire({ phase: "completed", result });
		const confirming = wire({ phase: "confirming" });
		const mine = new Set(["h-0001-aaaa"]);
		const a = await dom.mount(<Harness list={[confirming]} confirmed={mine} onNavigate={to => here.push(to)} />);
		const b = await dom.mount(
			<Harness list={[confirming]} confirmed={new Set()} onNavigate={to => other.push(to)} />,
		);
		expect(here).toEqual([]);
		await a.rerender(<Harness list={[completed]} confirmed={mine} onNavigate={to => here.push(to)} />);
		await b.rerender(<Harness list={[completed]} confirmed={new Set()} onNavigate={to => other.push(to)} />);
		expect(here).toEqual([{ machine: "lap", id: "new1" }]);
		expect(other).toEqual([]);
		expect(mine.size).toBe(0);
		await a.rerender(<Harness list={[{ ...completed }]} confirmed={mine} onNavigate={to => here.push(to)} />);
		expect(here.length).toBe(1); // not twice
		await a.unmount();
		await b.unmount();
	});

	test("a list that is empty for a moment (reconnect) does not forget the confirmation; a failure does", async () => {
		const here: SessionRef[] = [];
		const mine = new Set(["h-0001-aaaa"]);
		const navigate = (to: SessionRef): void => void here.push(to);
		const view = await dom.mount(
			<Harness list={[wire({ phase: "confirming" })]} confirmed={mine} onNavigate={navigate} />,
		);
		await view.rerender(<Harness list={[]} confirmed={mine} onNavigate={navigate} />);
		expect(mine.has("h-0001-aaaa")).toBe(true);
		await view.rerender(
			<Harness list={[wire({ phase: "completed", result })]} confirmed={mine} onNavigate={navigate} />,
		);
		expect(here).toEqual([{ machine: "lap", id: "new1" }]);

		const failing = new Set(["h-0001-aaaa"]);
		await view.rerender(
			<Harness list={[wire({ phase: "failed", error: "x" })]} confirmed={failing} onNavigate={navigate} />,
		);
		expect(failing.size).toBe(0);
		expect(here.length).toBe(1);
		await view.unmount();
	});
});

describe("thread banner and hop chips", () => {
	test("the chip names what the operation is doing and reopens the dialog", async () => {
		const opened: string[] = [];
		const view = await dom.mount(<HandoffChip wire={wire()} onOpen={id => opened.push(id)} />);
		expect(text(view, testid("handoff-chip"))).toContain("Switching to Laptop: Transfer the repository…");
		expect(view.query(testid("handoff-chip"))?.getAttribute("data-phase")).toBe("running");
		await view.click(testid("handoff-chip-open"));
		expect(opened).toEqual(["h-0001-aaaa"]);
		await view.unmount();
	});

	test("hop chips show where the thread has been; older ones collapse", () => {
		const now = Date.now();
		const hops = [1, 2, 3, 4].map(n => hop({ id: `hop-${n}`, at: now - n * 3_600_000 }));
		const html = renderToStaticMarkup(<HopHistory hops={hops} now={now} limit={2} />);
		expect(html.match(/data-testid="hop-chip"/g)?.length).toBe(2);
		expect(html).toContain("+2 earlier");
		expect(html).toContain("desktop → laptop · partial hit · 3 h ago");
		expect(renderToStaticMarkup(<HopHistory hops={[]} now={now} />)).toBe("");
	});

	test("the moved banner names the machine and when, and links to the new location", () => {
		const html = renderToStaticMarkup(
			<MovedBanner
				movedTo={{ machine: "lap", machineName: "Laptop", sessionId: "new 1", at: Date.now() - 3_600_000 }}
				now={Date.now()}
			/>,
		);
		expect(html).toContain("This session moved to Laptop (");
		expect(html).toContain("1 hour ago");
		expect(html).toContain('href="#/m/lap/s/new%201"');
	});
});

describe("SessionList: moved sessions, the switching badge and hop history", () => {
	const away = machineSummary({ id: "away", name: "Away", projects: [] });
	const render = (sessions: Parameters<typeof SessionList>[0]["sessions"], opened: string[] = []): string =>
		renderToStaticMarkup(
			<SessionList
				client={new DaemonClient("ws://x")}
				machines={[away]}
				sessions={sessions}
				selection={{ machine: "away", project: "", worktree: "" }}
				selected={null}
				onSelection={noop}
				onSelect={noop}
				accounts={{ open: false, attention: "ok", onToggle: noop }}
				onOpenHandoff={id => opened.push(id)}
			/>,
		);

	test("moved entries are history and are not listed; the copy being prepared is hidden; the source shows 'switching…'", () => {
		const html = render({
			away: [
				gatewaySession({ id: "plain" }),
				gatewaySession({ id: "moved", movedTo: { machine: "lap", machineName: "Laptop", sessionId: "n", at: 1 } }),
				gatewaySession({ id: "target", handoff: { id: "h-0001-aaaa", role: "target" } }),
				gatewaySession({ id: "source", handoff: { id: "h-0001-aaaa", role: "source" } }),
			],
		});
		expect(html).toContain('data-session="plain"');
		expect(html).toContain('data-session="source"');
		expect(html).not.toContain('data-session="moved"');
		expect(html).not.toContain('data-session="target"');
		expect(html.match(/data-testid="session-switching"/g)?.length).toBe(1);
		expect(html).toContain("switching…");
		expect(html).toContain('<span class="section-head-count">2</span>');
	});

	test("a thread that moved shows its environment and a compact hop history on its current entry", () => {
		const now = Date.now();
		const html = render({
			away: [
				gatewaySession({
					id: "cur",
					cwd: "/home/me/wt/x",
					projectRoot: "/home/me/app",
					worktreeRoot: "/home/me/wt/x",
					hops: [hop({ at: now - 2 * 3_600_000 })],
				}),
				gatewaySession({ id: "never" }),
			],
		});
		expect(html.match(/data-testid="side-env"/g)?.length).toBe(1);
		expect(html).toContain("Away · x");
		expect(html).toContain("desktop → laptop · partial hit · 2 h ago");
	});
});

describe("SessionView: moved sessions, the banner and the switch action", () => {
	const online = machineSummary({ id: "m1", name: "Laptop" });

	async function open(
		info: GatewaySessionInfo,
		handoffs: readonly HandoffWire[] = [],
		callbacks: { onSwitch?(): void; onOpenHandoff?(id: string): void } = {},
	): Promise<Mounted> {
		const client = new DaemonClient("ws://x/ws");
		return dom.mount(
			<SessionView
				client={client}
				machine="m1"
				machineInfo={online}
				sessionId="a"
				info={info}
				handoffs={handoffs}
				onOpen={noop}
				onShowList={noop}
				dockSlot={null}
				toolbar={() => null}
				machineSessions={[]}
				relocationTarget={null}
				onRelocate={noop}
				onSwitch={callbacks.onSwitch ?? noop}
				onOpenHandoff={callbacks.onOpenHandoff ?? noop}
				onNewSession={async () => null}
				onShowDock={noop}
			/>,
		);
	}
	const registered = { projectRoot: "/work/app", worktreeRoot: "/work/app" };
	const moved = { machine: "lap", machineName: "Laptop 2", sessionId: "new1", at: Date.now() - 2 * 3_600_000 };

	test("a hosted idle session of a registered project can switch, and the button opens the dialog", async () => {
		let switched = 0;
		const view = await open(gatewaySession({ id: "a", phase: "idle", ...registered }), [], {
			onSwitch: () => switched++,
		});
		const button = view.query(testid("switch-environment"))!;
		expect(button.disabled).toBe(false);
		expect(button.getAttribute("aria-disabled")).toBeNull();
		expect(view.query(testid("switch-reason"))).toBeNull();
		await view.click(testid("switch-environment"));
		expect(switched).toBe(1);
		expect(view.query(".composer")).not.toBeNull();
		await view.unmount();
	});

	test("a stored free session of a registered project can switch too", async () => {
		const view = await open(gatewaySession({ id: "a", phase: "stored", access: "free", ...registered }));
		expect(view.query(testid("switch-environment"))?.getAttribute("aria-disabled")).toBeNull();
		await view.unmount();
	});

	for (const [name, info, reason] of [
		["working", gatewaySession({ id: "a", phase: "working", ...registered }), "working"],
		["held", gatewaySession({ id: "a", access: "held", phase: "stored", ...registered }), "another omp process"],
		["unregistered", gatewaySession({ id: "a", phase: "idle" }), "registered project"],
		[
			"moved",
			gatewaySession({ id: "a", phase: "stored", access: "free", movedTo: moved, ...registered }),
			"already moved to Laptop 2",
		],
		[
			"switching",
			gatewaySession({ id: "a", phase: "idle", handoff: { id: "h", role: "source" }, ...registered }),
			"already in progress",
		],
	] as const) {
		test(`the switch action is marked unavailable for a ${name} session, does not always display the reason, and shows an alert on click`, async () => {
			let switched = 0;
			const view = await open(info, [], { onSwitch: () => switched++ });
			const button = view.query(testid("switch-environment"))!;
			expect(button.getAttribute("aria-disabled")).toBe("true");
			expect(button.getAttribute("title")).toContain(reason);
			expect(button.getAttribute("data-reason")).toContain(reason);
			expect(view.query(testid("switch-reason"))).toBeNull();

			await view.click(testid("switch-environment"));
			expect(switched).toBe(0);
			const alert = view.query(testid("switch-reason"));
			expect(alert?.getAttribute("role")).toBe("alert");
			expect(alert?.textContent).toContain(reason);

			await view.click(`${testid("switch-reason")} button`);
			expect(view.query(testid("switch-reason"))).toBeNull();
			await view.unmount();
		});
	}

	test("an active handoff of the thread (from the list) blocks the action and shows the chip with its button", async () => {
		const opened: string[] = [];
		const info = gatewaySession({ id: "a", phase: "idle", ...registered });
		const view = await open(info, [wire({ threadId: info.threadId })], { onOpenHandoff: id => opened.push(id) });
		expect(view.query(testid("switch-environment"))?.getAttribute("aria-disabled")).toBe("true");
		expect(view.query(testid("handoff-chip"))).not.toBeNull();
		await view.click(testid("handoff-chip-open"));
		expect(opened).toEqual(["h-0001-aaaa"]);
		await view.unmount();
	});

	test("a failed handoff stays visible as a chip but does not block a new switch", async () => {
		const info = gatewaySession({ id: "a", phase: "idle", ...registered });
		const view = await open(info, [wire({ threadId: info.threadId, phase: "failed", error: "x" })]);
		expect(text(view, testid("handoff-chip"))).toContain("Switch failed and was rolled back");
		expect(view.query(testid("switch-environment"))?.getAttribute("aria-disabled")).toBeNull();
		await view.unmount();
	});

	test("a moved session is read-only: the banner with its link is shown and nothing can be sent or taken over", async () => {
		const view = await open(
			gatewaySession({ id: "a", access: "free", phase: "stored", movedTo: moved, ...registered }),
		);
		const banner = view.query(testid("moved-banner"))!;
		expect(banner.textContent).toContain("This session moved to Laptop 2 (2 hours ago)");
		expect(view.query(testid("moved-link"))?.getAttribute("href")).toBe("#/m/lap/s/new1");
		expect(view.query(".composer")).toBeNull();
		expect(view.query(".takeover")).toBeNull();
		await view.unmount();
	});

	test("even a hosted session that is marked moved cannot be written to", async () => {
		const view = await open(
			gatewaySession({ id: "a", access: "hosted", phase: "idle", movedTo: moved, ...registered }),
		);
		expect(view.query(testid("moved-banner"))).not.toBeNull();
		expect(view.query(".composer")).toBeNull();
		await view.unmount();
	});

	test("the session being switched is locked: no composer", async () => {
		const view = await open(
			gatewaySession({
				id: "a",
				access: "hosted",
				phase: "idle",
				handoff: { id: "h", role: "source" },
				...registered,
			}),
		);
		expect(view.query(".composer")).toBeNull();
		await view.unmount();
	});

	test("the hop history of the thread is shown under the header", async () => {
		const view = await open(
			gatewaySession({ id: "a", phase: "idle", hops: [hop(), hop({ id: "hop-2" })], ...registered }),
		);
		expect(view.queryAll(testid("hop-chip")).length).toBe(2);
		await view.unmount();
	});
});
