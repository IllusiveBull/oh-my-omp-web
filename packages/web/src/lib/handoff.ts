import {
	type CacheForecast,
	type CarriedSummary,
	type ForecastItem,
	type ForecastSummary,
	type GatewaySessionInfo,
	HANDOFF_ACTIVE_PHASES,
	type HandoffPhase,
	type HandoffPlan,
	type HandoffStep,
	type HandoffStepStatus,
	type HandoffWire,
	type MachineSummary,
	type SkippedPath,
	type TargetChoice,
	type ThreadHop,
} from "@omp-web/protocol";
import { basename } from "./environment";
import type { SessionRef } from "./route";

// ---------------------------------------------------------------------------
// Which handoff belongs to what
// ---------------------------------------------------------------------------

/** The operation still owns its thread (running, waiting for the user, confirming, rolling back, or stuck rolling back). */
export function isActive(wire: Pick<HandoffWire, "phase">): boolean {
	return HANDOFF_ACTIVE_PHASES.includes(wire.phase);
}

/** The operation of a thread that locks it right now; the gateway allows one at a time. */
export function activeHandoff(handoffs: readonly HandoffWire[], threadId: string | undefined): HandoffWire | undefined {
	if (threadId === undefined) return undefined;
	return handoffs.find(h => h.threadId === threadId && isActive(h));
}

/**
 * What the thread's banner shows: the active operation, else one that ended without moving the thread and that nobody
 * dismissed yet (its error is still worth reading). A `completed` operation is not shown: the thread simply moved.
 */
export function visibleHandoff(
	handoffs: readonly HandoffWire[],
	threadId: string | undefined,
): HandoffWire | undefined {
	const active = activeHandoff(handoffs, threadId);
	if (active || threadId === undefined) return active;
	return handoffs
		.filter(h => h.threadId === threadId && (h.phase === "failed" || h.phase === "rolled_back"))
		.toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
}

export interface SwitchAvailability {
	ok: boolean;
	/** Why the action is disabled; empty when it is enabled. */
	reason: string;
}

const AVAILABLE: SwitchAvailability = { ok: true, reason: "" };
const no = (reason: string): SwitchAvailability => ({ ok: false, reason });

/**
 * Whether "Switch environment" can be offered for a session: it must be a hosted-idle or stored-free session of a
 * registered project, whose machine is reachable, that is neither being moved nor already moved.
 */
export function switchAvailability(
	info: GatewaySessionInfo | undefined,
	handoffs: readonly HandoffWire[],
	machine: Pick<MachineSummary, "name" | "online"> | undefined,
): SwitchAvailability {
	if (!info) return no("The session is not listed yet");
	if (info.backend === "antigravity") return no("Environment switching is not supported for Antigravity sessions");
	if (info.movedTo) return no(`This session already moved to ${info.movedTo.machineName}`);
	if (info.handoff || activeHandoff(handoffs, info.threadId))
		return no("An environment switch is already in progress");
	if (machine && !machine.online) return no(`${machine.name} is offline`);
	if (info.projectRoot === undefined || info.worktreeRoot === undefined) {
		return no("The session is not in a registered project: register the project first");
	}
	if (info.access === "held") return no("Open in another omp process: close it there first");
	if (info.access === "free") return AVAILABLE;
	if (info.phase === "idle") return AVAILABLE;
	if (info.phase === "working") return no("The agent is working: switch when it is idle");
	if (info.phase === "starting") return no("The session is still starting");
	return no("The session is closed");
}

// ---------------------------------------------------------------------------
// Sessions, environments and hops
// ---------------------------------------------------------------------------

/** Sessions the list shows: moved ones are history, and the copy being prepared by a switch is not usable yet. */
export function listedSessions(sessions: readonly GatewaySessionInfo[]): GatewaySessionInfo[] {
	return sessions.filter(s => s.movedTo === undefined && s.handoff?.role !== "target");
}

/** `Laptop · app.omp-worktrees/abc@omp-web/abc`: the machine, the worktree directory and its branch when known. */
export function environmentLabel(info: GatewaySessionInfo, machine: MachineSummary | undefined): string {
	const name = machine?.name ?? "";
	const worktreePath = info.worktreeRoot ?? info.cwd;
	const project = machine?.projects.find(p => p.root === info.projectRoot);
	const branch = project?.worktrees.find(w => w.path === worktreePath)?.branch;
	const where = `${basename(worktreePath)}${branch ? `@${branch}` : ""}`;
	return name === "" ? where : `${name} · ${where}`;
}

/** `#/m/<machine>/s/<id>` of the thread's new home once the operation completed. */
export function completedLocation(wire: HandoffWire): SessionRef | null {
	if (wire.phase !== "completed" || !wire.result) return null;
	return { machine: wire.target.machine, id: wire.result.sessionId };
}

const FORECAST_WORDS: Record<ForecastSummary, string> = {
	hit: "full hit",
	partial: "partial hit",
	miss: "cache miss",
};

/** `2 h ago`, `5 min ago`, `3 d ago`: compact, for the hop chips. */
export function shortAgo(at: number, now: number): string {
	const age = Math.max(0, now - at);
	const minutes = Math.floor(age / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	if (days < 60) return `${days} d ago`;
	return `${Math.floor(days / 30)} mo ago`;
}

/** `desktop → laptop · partial hit · 2 h ago` */
export function hopText(hop: ThreadHop, now: number): string {
	const forecast = hop.forecast === null ? "no forecast" : FORECAST_WORDS[hop.forecast];
	return `${hop.from.machineName} → ${hop.to.machineName} · ${forecast} · ${shortAgo(hop.at, now)}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** `512 B`, `4.2 MiB`: binary units, one decimal from KiB up. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** The first 7 characters of a commit hash. */
export const shortHead = (head: string): string => head.slice(0, 7);

/** `1:05`, `12:00`; `expired` once the time has passed. */
export function countdown(expiresAt: number, now: number): { text: string; expired: boolean } {
	const left = expiresAt - now;
	if (left <= 0) return { text: "0:00", expired: true };
	const seconds = Math.ceil(left / 1000);
	return { text: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`, expired: false };
}

/** The first `limit` entries and how many were left out. */
export function limitList<T>(items: readonly T[], limit: number): { shown: T[]; more: number } {
	return { shown: items.slice(0, limit), more: Math.max(0, items.length - limit) };
}

export const moreText = (n: number): string => `and ${n} more`;

// ---------------------------------------------------------------------------
// Steps and phases
// ---------------------------------------------------------------------------

/** What the icon of a step stands for in words (its accessible name, so state never relies on colour alone). */
export const STEP_STATUS_TEXT: Record<HandoffStepStatus, string> = {
	pending: "pending",
	running: "running",
	done: "done",
	skipped: "skipped",
	failed: "failed",
};

/** The byte progress of a transfer step: `1.0 MiB / 4.2 MiB (24%)`; null for steps without one. */
export function stepProgress(step: Pick<HandoffStep, "bytes">): { percent: number; text: string } | null {
	if (!step.bytes) return null;
	const { done, total } = step.bytes;
	const percent = total > 0 ? Math.min(100, Math.max(0, Math.floor((done / total) * 100))) : 0;
	return { percent, text: `${formatBytes(done)} / ${formatBytes(total)} (${percent}%)` };
}

export type PhaseTone = "run" | "ok" | "warn" | "bad";

export function phaseTone(phase: HandoffPhase): PhaseTone {
	switch (phase) {
		case "running":
		case "awaiting_confirm":
		case "confirming":
			return "run";
		case "completed":
			return "ok";
		case "rolling_back":
		case "rolled_back":
			return "warn";
		case "failed":
		case "rollback_failed":
			return "bad";
	}
}

/** The step the operation is working on: the running one, else the first still pending. */
export function currentStep(wire: Pick<HandoffWire, "steps">): HandoffStep | undefined {
	return wire.steps.find(s => s.status === "running") ?? wire.steps.find(s => s.status === "pending");
}

/** One sentence for the phase, with the error where the phase has one. */
export function phaseText(wire: HandoffWire): string {
	const target = wire.target.machineName;
	switch (wire.phase) {
		case "running": {
			const step = currentStep(wire);
			return step ? `Switching to ${target}: ${step.label}…` : `Switching to ${target}…`;
		}
		case "awaiting_confirm":
			return wire.freshSession
				? `The worktree is ready on ${target} and a new session is started there. Confirm the switch.`
				: `Everything is prepared on ${target}. Review the cache forecast, then confirm the switch.`;
		case "confirming":
			return `Moving the thread to ${target}…`;
		case "rolling_back":
			return `Rolling back what was created${wire.error ? ` (${wire.error})` : ""}…`;
		case "completed":
			return `Switched: the thread now lives on ${target}.`;
		case "rolled_back":
			return `Cancelled. Nothing was changed on either machine.${wire.error ? ` ${wire.error}` : ""}`;
		case "failed":
			return `Switch failed and was rolled back: ${wire.error ?? "unknown error"}`;
		case "rollback_failed":
			return `Switch failed and the rollback did not finish${wire.error ? `: ${wire.error}` : ""}. The thread stays locked until what is left below is cleaned up.`;
	}
}

/** The thread can move: everything is built and the user may commit (not after the gateway's own timeout). */
export function canConfirm(wire: Pick<HandoffWire, "phase" | "expiresAt">, now: number): boolean {
	return wire.phase === "awaiting_confirm" && (wire.expiresAt === undefined || wire.expiresAt > now);
}

/** A running or waiting operation can be cancelled; later phases are already finishing or undoing. */
export function canCancel(wire: Pick<HandoffWire, "phase">): boolean {
	return wire.phase === "running" || wire.phase === "awaiting_confirm";
}

/** Only a finished operation can be hidden; `rollback_failed` keeps blocking the thread until it is cleaned up. */
export function canDismiss(wire: Pick<HandoffWire, "phase">): boolean {
	return wire.phase === "completed" || wire.phase === "rolled_back" || wire.phase === "failed";
}

// ---------------------------------------------------------------------------
// The forecast
// ---------------------------------------------------------------------------

export function forecastView(summary: ForecastSummary): { className: string; word: string } {
	return {
		hit: { className: "handoff-forecast--hit", word: "Cache likely hit" },
		partial: { className: "handoff-forecast--partial", word: "Cache partially hit" },
		miss: { className: "handoff-forecast--miss", word: "Cache miss" },
	}[summary];
}

/** Always worded, never only coloured: an inferred status says so in text. */
export const INFERENCE_MARKER = "(inference)";

export const ITEM_STATUS_TEXT: Record<ForecastItem["status"], string> = {
	hit: "hit",
	miss: "miss",
	unknown: "unknown",
	na: "n/a",
};

/** `~12,300 tokens would be written again (estimate)`; a forecast that cannot estimate says so. */
export function rewriteText(forecast: Pick<CacheForecast, "rewriteTokens">): string {
	const tokens = forecast.rewriteTokens;
	if (tokens === null) return "Tokens written again: cannot be estimated";
	if (tokens <= 0)
		return "None of the existing prompt would be written again (estimate); the new message is always written";
	return `~${tokens.toLocaleString("en-US")} tokens would be written again (estimate)`;
}

// ---------------------------------------------------------------------------
// What is carried
// ---------------------------------------------------------------------------

export const SKIPPED_REASON_TEXT: Record<SkippedPath["reason"], string> = {
	"too-large": "file too large",
	"total-cap": "over the total size cap",
	submodule: "submodule change",
	"embedded-repo": "embedded repository",
	lfs: "Git LFS path",
	"special-file": "special file",
	unreadable: "unreadable",
};

export function skippedText(path: SkippedPath): string {
	const size = path.size === undefined ? "" : `, ${formatBytes(path.size)}`;
	const detail = path.detail ? `: ${path.detail}` : "";
	return `${path.path} (${SKIPPED_REASON_TEXT[path.reason]}${size})${detail}`;
}

/** `3 modified, 2 added`: only the kinds that occur. */
export function trackedText(tracked: CarriedSummary["tracked"]): string {
	const parts: [number, string][] = [
		[tracked.modified, "modified"],
		[tracked.added, "added"],
		[tracked.deleted, "deleted"],
		[tracked.renamed, "renamed"],
		[tracked.typeChanged, "type changed"],
		[tracked.modeChanged, "mode changed"],
	];
	const shown = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
	return shown.length === 0 ? "no tracked changes" : shown.join(", ");
}

export function untrackedText(untracked: CarriedSummary["untracked"]): string {
	return untracked.files === 0
		? "no untracked files"
		: `${untracked.files} untracked file${untracked.files === 1 ? "" : "s"} (${formatBytes(untracked.bytes)})`;
}

/** `staged preserved (3 paths)` or why the split is lost. */
export function stagedText(staged: CarriedSummary["staged"]): string {
	if (staged.preserved) return `staged preserved (${staged.paths} path${staged.paths === 1 ? "" : "s"})`;
	return `staged not preserved: everything arrives unstaged${staged.note ? ` (${staged.note})` : ""}`;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** What the picker preselects: a new worktree when one can be made. */
export function defaultChoice(plan: HandoffPlan): TargetChoice | null {
	return plan.target?.newWorktree ? { mode: "new" } : null;
}

/**
 * Every reason the Start button is disabled, in words. The plan's own blockers come first and verbatim; the rest
 * covers what the plan cannot say about the user's current choice.
 */
export function startBlockers(plan: HandoffPlan, choice: TargetChoice | null): string[] {
	const blockers = [...plan.blockers];
	if (plan.blockers.length > 0) return blockers;
	if (plan.repo === null) blockers.push("The session is not in a registered project: register the project first");
	if (plan.target === null) blockers.push("The target machine is unknown");
	else if (!plan.target.online) blockers.push(`${plan.target.machineName} is offline`);
	else if (choice === null) blockers.push("Pick where the thread continues");
	else if (choice.mode === "new" && plan.target.newWorktree === null)
		blockers.push("No new worktree can be created there");
	else if (choice.mode === "existing") {
		const chosen = plan.target.worktrees.find(w => w.path === choice.worktree);
		if (!chosen?.eligible) blockers.push("The chosen worktree cannot be used");
	}
	return blockers;
}

/** The one-line state on a thread's banner and list entry. */
export function chipText(wire: HandoffWire): string {
	const target = wire.target.machineName;
	switch (wire.phase) {
		case "running": {
			const step = currentStep(wire);
			return `Switching to ${target}${step ? `: ${step.label}` : ""}…`;
		}
		case "awaiting_confirm":
			return `Switch to ${target} waits for your confirmation`;
		case "confirming":
			return `Moving the thread to ${target}…`;
		case "rolling_back":
			return "Switch is being rolled back…";
		case "rollback_failed":
			return "Switch failed and the rollback did not finish";
		case "failed":
			return "Switch failed and was rolled back";
		case "rolled_back":
			return "Switch cancelled";
		case "completed":
			return `Switched to ${target}`;
	}
}
