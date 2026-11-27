import { describe, expect, test } from "bun:test";
import type { HandoffPhase, HandoffWire } from "@omp-web/protocol";
import {
	activeHandoff,
	canCancel,
	canConfirm,
	canDismiss,
	chipText,
	completedLocation,
	countdown,
	defaultChoice,
	environmentLabel,
	forecastView,
	formatBytes,
	hopText,
	INFERENCE_MARKER,
	isActive,
	limitList,
	listedSessions,
	moreText,
	phaseText,
	phaseTone,
	rewriteText,
	shortAgo,
	skippedText,
	stagedText,
	startBlockers,
	stepProgress,
	switchAvailability,
	trackedText,
	untrackedText,
	visibleHandoff,
} from "../src/lib/handoff";
import { carried, forecast, hop, plan, steps, wire } from "./handoff-fixtures";
import { gatewaySession, machineSummary, project, worktree } from "./fixtures";

const PHASES: HandoffPhase[] = [
	"running",
	"awaiting_confirm",
	"confirming",
	"rolling_back",
	"completed",
	"rolled_back",
	"failed",
	"rollback_failed",
];

const registered = { projectRoot: "/work/app", worktreeRoot: "/work/app" };
const online = machineSummary({ id: "desk", name: "Desktop" });

describe("formatBytes", () => {
	test("binary units with one decimal from KiB up", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1024)).toBe("1.0 KiB");
		expect(formatBytes(4.2 * 1024 * 1024)).toBe("4.2 MiB");
		expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GiB");
		expect(formatBytes(-1)).toBe("?");
	});
});

describe("phases", () => {
	test("every phase has a sentence and a tone; the issue's wordings are exact", () => {
		for (const phase of PHASES) {
			const w = wire({ phase, error: "boom" });
			expect(phaseText(w).length).toBeGreaterThan(10);
			expect(["run", "ok", "warn", "bad"]).toContain(phaseTone(phase));
		}
		expect(phaseText(wire({ phase: "failed", error: "bundle too large" }))).toBe(
			"Switch failed and was rolled back: bundle too large",
		);
		expect(phaseText(wire({ phase: "rolled_back" }))).toBe("Cancelled. Nothing was changed on either machine.");
		expect(phaseText(wire({ phase: "rollback_failed", error: "lost link" }))).toContain("did not finish: lost link");
		expect(phaseText(wire({ phase: "running" }))).toBe("Switching to Laptop: Transfer the repository…");
		expect(phaseText(wire({ phase: "completed" }))).toContain("Laptop");
	});

	test("confirm only while awaiting and not expired; cancel while running or awaiting; dismiss only when finished", () => {
		const allowed = (fn: (p: HandoffPhase) => boolean): HandoffPhase[] => PHASES.filter(fn);
		expect(allowed(p => canConfirm({ phase: p }, 0))).toEqual(["awaiting_confirm"]);
		expect(allowed(p => canCancel({ phase: p }))).toEqual(["running", "awaiting_confirm"]);
		expect(allowed(p => canDismiss({ phase: p }))).toEqual(["completed", "rolled_back", "failed"]);
		expect(canConfirm({ phase: "awaiting_confirm", expiresAt: 100 }, 99)).toBe(true);
		expect(canConfirm({ phase: "awaiting_confirm", expiresAt: 100 }, 100)).toBe(false);
	});

	test("active phases lock the thread; finished ones do not", () => {
		expect(PHASES.filter(p => isActive({ phase: p }))).toEqual([
			"running",
			"awaiting_confirm",
			"confirming",
			"rolling_back",
			"rollback_failed",
		]);
	});

	test("chip text exists for every phase", () => {
		for (const phase of PHASES) expect(chipText(wire({ phase })).length).toBeGreaterThan(5);
	});
});

describe("steps", () => {
	test("a transfer step has a percentage and sizes; a plain step has none", () => {
		expect(stepProgress({ bytes: { done: 1024 * 1024, total: 4 * 1024 * 1024 } })).toEqual({
			percent: 25,
			text: "1.0 MiB / 4.0 MiB (25%)",
		});
		expect(stepProgress({ bytes: { done: 5, total: 0 } })?.percent).toBe(0);
		expect(stepProgress({ bytes: { done: 9, total: 3 } })?.percent).toBe(100);
		expect(stepProgress({})).toBeNull();
	});
});

describe("forecast wording", () => {
	test("each summary has its own class and words", () => {
		expect(forecastView("hit")).toEqual({ className: "handoff-forecast--hit", word: "Cache likely hit" });
		expect(forecastView("partial").className).toBe("handoff-forecast--partial");
		expect(forecastView("miss").className).toBe("handoff-forecast--miss");
	});

	test("the token numbers are labelled as an estimate, and an unknown one says so", () => {
		expect(rewriteText(forecast())).toBe("~12,300 tokens would be written again (estimate)");
		expect(rewriteText({ rewriteTokens: 0 })).toBe(
			"None of the existing prompt would be written again (estimate); the new message is always written",
		);
		expect(rewriteText({ rewriteTokens: null })).toContain("cannot be estimated");
		expect(INFERENCE_MARKER).toBe("(inference)");
	});

	test("the countdown counts down to zero and then says expired", () => {
		expect(countdown(65_000, 0)).toEqual({ text: "1:05", expired: false });
		expect(countdown(1_000, 0)).toEqual({ text: "0:01", expired: false });
		expect(countdown(1_000, 1_000)).toEqual({ text: "0:00", expired: true });
	});
});

describe("lists", () => {
	test("limitList keeps the first N and counts the rest", () => {
		expect(limitList([1, 2, 3], 5)).toEqual({ shown: [1, 2, 3], more: 0 });
		expect(limitList([1, 2, 3, 4, 5, 6, 7], 3)).toEqual({ shown: [1, 2, 3], more: 4 });
		expect(moreText(4)).toBe("and 4 more");
	});

	test("carried summary texts", () => {
		expect(trackedText(carried().tracked)).toBe("3 modified, 1 added");
		expect(trackedText({ modified: 0, added: 0, deleted: 0, renamed: 0, typeChanged: 0, modeChanged: 0 })).toBe(
			"no tracked changes",
		);
		expect(untrackedText({ files: 2, bytes: 2048 })).toBe("2 untracked files (2.0 KiB)");
		expect(untrackedText({ files: 0, bytes: 0 })).toBe("no untracked files");
		expect(stagedText({ preserved: true, paths: 2 })).toBe("staged preserved (2 paths)");
		expect(stagedText({ preserved: false, paths: 0, note: "index unreadable" })).toContain("index unreadable");
		expect(skippedText({ path: "big.bin", reason: "too-large", size: 5 * 1024 * 1024 })).toBe(
			"big.bin (file too large, 5.0 MiB)",
		);
		expect(skippedText({ path: "vendor/x", reason: "submodule", detail: "modified content" })).toBe(
			"vendor/x (submodule change): modified content",
		);
	});
});

describe("time", () => {
	test("short ages", () => {
		const now = 10 * 24 * 3_600_000;
		expect(shortAgo(now - 10_000, now)).toBe("just now");
		expect(shortAgo(now - 5 * 60_000, now)).toBe("5 min ago");
		expect(shortAgo(now - 2 * 3_600_000, now)).toBe("2 h ago");
		expect(shortAgo(now - 3 * 24 * 3_600_000, now)).toBe("3 d ago");
	});

	test("a hop reads `from → to · forecast · age`", () => {
		const now = Date.now();
		expect(hopText(hop({ at: now - 2 * 3_600_000 }), now)).toBe("desktop → laptop · partial hit · 2 h ago");
		expect(hopText(hop({ forecast: null, at: now }), now)).toContain("no forecast");
		expect(hopText(hop({ forecast: "miss", at: now }), now)).toContain("cache miss");
		expect(hopText(hop({ forecast: "hit", at: now }), now)).toContain("full hit");
	});
});

describe("which handoff belongs to a thread", () => {
	const running = wire({ id: "h-run-1111", threadId: "t1" });
	const done = wire({ id: "h-done-111", threadId: "t2", phase: "completed" });
	const failedOld = wire({ id: "h-fail-111", threadId: "t3", phase: "failed", updatedAt: 1 });
	const failedNew = wire({ id: "h-fail-222", threadId: "t3", phase: "rolled_back", updatedAt: 5 });

	test("active lookup ignores finished operations; the banner also shows the newest failed or cancelled one", () => {
		const all = [running, done, failedOld, failedNew];
		expect(activeHandoff(all, "t1")?.id).toBe("h-run-1111");
		expect(activeHandoff(all, "t2")).toBeUndefined();
		expect(activeHandoff(all, undefined)).toBeUndefined();
		expect(visibleHandoff(all, "t2")).toBeUndefined(); // completed: the thread simply moved
		expect(visibleHandoff(all, "t3")?.id).toBe("h-fail-222");
		expect(visibleHandoff(all, "t1")?.id).toBe("h-run-1111");
	});

	test("completed location is the target machine and the new session id, only once completed", () => {
		const result = { sessionId: "new1", worktree: "/w", branch: "b", sourceMarked: true };
		expect(completedLocation(wire({ phase: "completed", result }))).toEqual({ machine: "lap", id: "new1" });
		expect(completedLocation(wire({ phase: "confirming", result }))).toBeNull();
		expect(completedLocation(wire({ phase: "completed" }))).toBeNull();
	});
});

describe("switchAvailability", () => {
	const idle = gatewaySession({ id: "a", phase: "idle", access: "hosted", ...registered });

	test("hosted-idle and stored-free sessions of a registered project can switch", () => {
		expect(switchAvailability(idle, [], online)).toEqual({ ok: true, reason: "" });
		expect(
			switchAvailability(gatewaySession({ phase: "stored", access: "free", ...registered }), [], online).ok,
		).toBe(true);
	});

	test("everything else is disabled with a reason", () => {
		const reason = (
			info: Parameters<typeof switchAvailability>[0],
			handoffs: HandoffWire[] = [],
			machine = online,
		): string => switchAvailability(info, handoffs, machine).reason;
		expect(reason(undefined)).toContain("not listed");
		expect(reason({ ...idle, phase: "working" })).toContain("working");
		expect(reason({ ...idle, phase: "starting" })).toContain("starting");
		expect(reason({ ...idle, phase: "closed" })).toContain("closed");
		expect(reason({ ...idle, access: "held" })).toContain("another omp process");
		expect(reason(gatewaySession({ id: "a", phase: "idle" }))).toContain("registered project");
		expect(reason({ ...idle, movedTo: { machine: "lap", machineName: "Laptop", sessionId: "b", at: 1 } })).toContain(
			"already moved to Laptop",
		);
		expect(reason({ ...idle, handoff: { id: "h", role: "source" } })).toContain("already in progress");
		expect(reason(idle, [wire({ threadId: idle.threadId })])).toContain("already in progress");
		expect(reason(idle, [], { ...online, online: false })).toBe("Desktop is offline");
	});

	test("a finished operation of the thread does not block a new one", () => {
		expect(switchAvailability(idle, [wire({ threadId: idle.threadId, phase: "failed" })], online).ok).toBe(true);
	});
});

describe("sessions and environments", () => {
	test("moved sessions and the copy being prepared are not listed", () => {
		const moved = gatewaySession({
			id: "m",
			movedTo: { machine: "lap", machineName: "Laptop", sessionId: "n", at: 1 },
		});
		const target = gatewaySession({ id: "t", handoff: { id: "h", role: "target" } });
		const source = gatewaySession({ id: "s", handoff: { id: "h", role: "source" } });
		const plain = gatewaySession({ id: "p" });
		expect(listedSessions([moved, target, source, plain]).map(s => s.id)).toEqual(["s", "p"]);
	});

	test("the environment is machine, worktree and branch", () => {
		const machine = machineSummary({
			id: "lap",
			name: "Laptop",
			projects: [
				project("/home/me/app", [
					worktree("/home/me/app", { main: true }),
					worktree("/home/me/wt/x", { branch: "omp-web/x" }),
				]),
			],
		});
		const info = gatewaySession({ cwd: "/home/me/wt/x", projectRoot: "/home/me/app", worktreeRoot: "/home/me/wt/x" });
		expect(environmentLabel(info, machine)).toBe("Laptop · x@omp-web/x");
		expect(environmentLabel(gatewaySession({ cwd: "/somewhere/else" }), machine)).toBe("Laptop · else");
	});
});

describe("plan helpers", () => {
	test("a new worktree is the default, when one can be made", () => {
		expect(defaultChoice(plan())).toEqual({ mode: "new" });
		expect(defaultChoice(plan({ target: { ...plan().target!, newWorktree: null } }))).toBeNull();
		expect(defaultChoice(plan({ target: null }))).toBeNull();
	});

	test("plan blockers come first and verbatim; nothing else is added then", () => {
		const blocker = "Project app not on Laptop: clone it there and register the project first";
		expect(startBlockers(plan({ blockers: [blocker] }), { mode: "new" })).toEqual([blocker]);
	});

	test("derived blockers", () => {
		const base = plan();
		expect(startBlockers(base, { mode: "new" })).toEqual([]);
		expect(startBlockers(base, null)).toEqual(["Pick where the thread continues"]);
		expect(startBlockers(plan({ repo: null }), { mode: "new" })[0]).toContain("registered project");
		expect(startBlockers(plan({ target: null }), { mode: "new" })[0]).toContain("unknown");
		expect(startBlockers(plan({ target: { ...base.target!, online: false } }), { mode: "new" })[0]).toBe(
			"Laptop is offline",
		);
		expect(startBlockers(plan({ target: { ...base.target!, newWorktree: null } }), { mode: "new" })[0]).toContain(
			"No new worktree",
		);
		const withWt = plan({
			target: {
				...base.target!,
				worktrees: [{ path: "/wt", branch: "x", head: "abc", eligible: false, reason: "dirty", isSource: false }],
			},
		});
		expect(startBlockers(withWt, { mode: "existing", worktree: "/wt" })[0]).toContain("cannot be used");
		expect(steps(0).length).toBe(8);
	});
});
