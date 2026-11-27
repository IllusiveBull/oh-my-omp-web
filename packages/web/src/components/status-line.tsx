import { formatNumber, normalizePremiumRequests } from "@oh-my-pi/pi-utils/format";
import type { GoalWire, LoopWire, MachineSummary, ModelRolesWire, SessionStatus } from "@omp-web/protocol";
import {
	Check,
	ChevronUp,
	Folder,
	Gauge,
	GitBranch,
	type LucideIcon,
	Pause,
	Repeat,
	RotateCcw,
	Target,
	Timer,
	TriangleAlert,
	X,
	Zap,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { displayPath } from "../lib/environment";
import { ChipMenu } from "./chip-menu";
import { useNow } from "../lib/use-now";
import { formatElapsed } from "../lib/time";

interface Props {
	status: SessionStatus;
	machineInfo?: MachineSummary;
	/** omp's model roles; the ones in its cycle order are offered in the role menu. Null: not loaded or read-only. */
	roles: ModelRolesWire | null;
	/** omp's effort levels: the `:level` suffixes a role selector may carry. */
	thinkingLevels: readonly string[];
	/** Switches this session to a role (`/switch @role`). Absent: read-only. */
	onUseRole?(role: string): void;
	/** Opens the model hub. Absent: read-only. */
	onOpenModels?(): void;
	/** Opens omp's `/context` report. Absent: read-only. */
	onOpenContext?(anchor: HTMLButtonElement): void;
	/** Shown instead of the directory and git segments: pickers that move a session that has no message yet. */
	location?: ReactNode;
	/** Pauses, resumes or drops the goal. Absent: read-only. */
	onGoal?(op: "pause" | "resume" | "drop"): void;
	/** Turns loop mode off. Absent: read-only. */
	onLoopOff?(): void;
}

/** CSS colour of an omp theme token, as the session view provides it (`--omp-<token>`). */
export const ompColor = (token: string): string => `var(--omp-${token})`;

/**
 * The same token for text: omp's palette is tuned for a terminal, so some of its status colours fall short of 4.5:1 on
 * the page. A quarter of the page's own text colour keeps the hue and clears AA in both schemes.
 */
export const ompText = (token: string): string => `color-mix(in oklch, var(--omp-${token}) 72%, var(--fg))`;

/** omp's colour of a thinking level (`thinkingHigh`); `auto` and `inherit` have none. */
export function thinkingToken(level: string): string | undefined {
	if (level === "auto" || level === "inherit") return undefined;
	const key = level === "minimal" ? "Minimal" : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
	return `thinking${key}`;
}

/** The colour omp's status line gives a context level (`getContextUsageThemeColor`). */
const CONTEXT_TOKEN: Record<string, string> = {
	normal: "statusLineContext",
	warning: "warning",
	purple: "thinkingHigh",
	error: "error",
};

/** `provider/id` and thinking level of a role selector (`provider/id[:level]`; model ids can contain `:` too). */
export function splitSelector(selector: string, levels: readonly string[]): { model: string; level?: string } {
	const colon = selector.lastIndexOf(":");
	if (colon > 0) {
		const level = selector.slice(colon + 1);
		if (level === "auto" || levels.includes(level)) return { model: selector.slice(0, colon), level };
	}
	return { model: selector };
}

/**
 * The cycle role the session is on: its model is the role's model; when several roles share it, the one whose thinking
 * level matches too.
 */
export function activeRole(
	roles: ModelRolesWire,
	model: string | undefined,
	thinkingLevel: string | undefined,
	levels: readonly string[],
): string | undefined {
	if (!model) return undefined;
	const candidates = roles.cycle.flatMap(id => {
		const selector = roles.roles.find(r => r.id === id)?.selector;
		const parsed = selector ? splitSelector(selector, levels) : undefined;
		return parsed?.model === model ? [{ id, level: parsed.level }] : [];
	});
	return (candidates.find(c => c.level === thinkingLevel) ?? candidates[0])?.id;
}

/**
 * The cycle roles (`smol` / `default` / `slow`) in a menu that opens upward; the chip names the role the session is
 * on (`current`). Nothing without a cycle.
 */
export function RoleMenu({
	roles,
	current,
	onUseRole,
}: {
	roles: ModelRolesWire;
	current: string | undefined;
	onUseRole(role: string): void;
}): ReactNode {
	if (roles.cycle.length === 0) return null;
	const color = roles.roles.find(r => r.id === current)?.color;
	return (
		<ChipMenu
			label={
				<span className="status-label" style={color ? { color: ompText(color) } : undefined}>
					{current ?? "role"}
					<ChevronUp aria-hidden="true" />
				</span>
			}
			title="Switch model role"
			placement="up"
		>
			{close => (
				<div className="chip-list" role="listbox" aria-label="Model roles">
					{roles.cycle.map(id => {
						const role = roles.roles.find(r => r.id === id);
						return (
							<button
								key={id}
								type="button"
								role="option"
								aria-selected={id === current}
								className="chip-option status-role"
								disabled={!role?.selector}
								title={role?.name ?? id}
								onClick={() => {
									close();
									onUseRole(id);
								}}
							>
								{id}
								<span className="faint"> {role?.selector ?? "not set"}</span>
							</button>
						);
					})}
				</div>
			)}
		</ChipMenu>
	);
}

/**
 * The sector of a thinking level, filled as far as the level goes (omp's `○ ◔ ◑ ◕ ●`): the status line's model segment
 * and the header's think menu show it. Half, omp's `◑`, for a level without a place on the ladder (`auto`) or none.
 * Drawn rather than typed: those glyphs come from fallback fonts at sizes of their own.
 */
const SECTOR: Record<string, number> = {
	off: 0,
	minimal: 0.25,
	low: 0.25,
	medium: 0.5,
	high: 0.75,
	xhigh: 1,
	max: 1,
};
export function ThinkingSector({
	level,
	style,
	title,
}: {
	level: string | undefined;
	style?: CSSProperties;
	title?: string;
}): ReactNode {
	const fill = SECTOR[level ?? ""] ?? 0.5;
	const angle = fill * 2 * Math.PI;
	const r = 6;
	const x = (8 + r * Math.sin(angle)).toFixed(3);
	const y = (8 - r * Math.cos(angle)).toFixed(3);
	return (
		<span className="status-sector" style={style} title={title} data-fill={fill}>
			<svg viewBox="0 0 16 16" aria-hidden="true">
				<circle
					cx="8"
					cy="8"
					r={r}
					fill={fill >= 1 ? "currentColor" : "none"}
					stroke="currentColor"
					strokeWidth="1.75"
				/>
				{fill > 0 && fill < 1 && (
					<path d={`M8 8V${8 - r}A${r} ${r} 0 ${fill > 0.5 ? 1 : 0} 1 ${x} ${y}Z`} fill="currentColor" />
				)}
			</svg>
		</span>
	);
}

/**
 * omp's status line `cost` segment: the session's own spend, its sub-agents' as `(+…)`, the scheduled tariff's period
 * as `↑` (peak) / `↓` (off-peak), Copilot premium requests as `★ …` (`formatBillingSummary` in omp's tui, metered
 * spend only).
 */
function billingSummary(
	status: Pick<SessionStatus, "cost" | "subagentCost" | "premiumRequests" | "pricingPeriod">,
): string | null {
	const cost = status.cost ?? 0;
	const subagentCost = status.subagentCost ?? 0;
	const premiumRequests = normalizePremiumRequests(status.premiumRequests ?? 0);
	const parts: string[] = [];
	if (cost || subagentCost || status.pricingPeriod) parts.push(`$${cost.toFixed(2)}`);
	if (subagentCost) parts.push(`(+${subagentCost.toFixed(2)})`);
	if (status.pricingPeriod) parts.push(status.pricingPeriod === "peak" ? "↑" : "↓");
	if (premiumRequests) parts.push(`★ ${formatNumber(premiumRequests)}`);
	return parts.length > 0 ? parts.join(" ") : null;
}

/** omp's goal segment: its icon and colour per status (`renderGoalMode`), with the tokens used of its budget. */
const GOAL_LOOK: Record<GoalWire["status"], { Icon: LucideIcon; token: string }> = {
	active: { Icon: Target, token: "accent" },
	paused: { Icon: Pause, token: "warning" },
	complete: { Icon: Check, token: "success" },
	"budget-limited": { Icon: TriangleAlert, token: "warning" },
	dropped: { Icon: X, token: "dim" },
};

function GoalSegment({ goal, onGoal }: { goal: GoalWire; onGoal?: Props["onGoal"] }): ReactNode {
	const look = GOAL_LOOK[goal.status];
	const tokens = `${formatNumber(goal.tokensUsed)}${goal.tokenBudget !== undefined ? `/${formatNumber(goal.tokenBudget)}` : ""}`;
	const label = (
		<span className="status-label" style={{ color: ompText(look.token) }}>
			<look.Icon aria-hidden="true" />
			<span className="status-text">
				Goal {goal.status === "active" ? "" : `${goal.status} `}
				<span className="status-line-dim">· {tokens}</span>
			</span>
		</span>
	);
	const title = `Goal (${goal.status}): ${goal.objective}`;
	const actions = !onGoal
		? []
		: goal.status === "active" && !goal.exiting
			? (["pause", "drop"] as const)
			: goal.status === "paused"
				? (["resume", "drop"] as const)
				: [];
	if (actions.length === 0)
		return (
			<span className="status-seg status-goal" title={title}>
				{label}
			</span>
		);
	return (
		<ChipMenu label={label} title={title} placement="up">
			{close => (
				<div className="chip-list" aria-label="Goal">
					<div className="chip-note">{goal.objective}</div>
					{actions.map(op => (
						<button
							key={op}
							type="button"
							className="chip-option"
							onClick={() => {
								close();
								onGoal?.(op);
							}}
						>
							{op === "pause" ? "Pause goal" : op === "resume" ? "Resume goal" : "Drop goal"}
						</button>
					))}
				</div>
			)}
		</ChipMenu>
	);
}

/** omp's `formatLoopLimit`: iterations as `remaining/initial`, a duration as the time left. */
function loopLimitText(limit: NonNullable<LoopWire["limit"]>, now: number): string {
	if (limit.kind === "iterations") return `${limit.remaining}/${limit.initial}`;
	const seconds = Math.max(0, Math.ceil((limit.deadlineMs - now) / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}h${m > 0 ? `${m}m` : ""} left`;
	if (m > 0) return `${m}m${s > 0 ? `${s}s` : ""} left`;
	return `${s}s left`;
}

/** omp's loop segment: `Loop: next prompt repeats` / `Loop running` / `Loop paused`, its limit and its condition. */
function LoopSegment({
	loop,
	now,
	onLoopOff,
}: {
	loop: LoopWire;
	now: number;
	onLoopOff?: Props["onLoopOff"];
}): ReactNode {
	const state = loop.state === "waiting" ? ": next prompt repeats" : ` ${loop.state}`;
	const bounds = [
		loop.limit && loopLimitText(loop.limit, now),
		loop.condition && `${loop.condition.until ? "until" : "while"}: ${loop.condition.command}`,
	].filter(Boolean);
	const label = (
		<span className="status-label" style={{ color: ompText(loop.state === "paused" ? "warning" : "accent") }}>
			<Repeat aria-hidden="true" />
			<span className="status-text">
				Loop{state}
				{bounds.length > 0 && <span className="status-line-dim"> · {bounds.join(" · ")}</span>}
			</span>
		</span>
	);
	const title = loop.prompt
		? `Loop repeats: ${loop.prompt}`
		: "Loop mode: the next prompt sent repeats after each run";
	if (!onLoopOff)
		return (
			<span className="status-seg status-loop" title={title}>
				{label}
			</span>
		);
	return (
		<ChipMenu label={label} title={title} placement="up">
			{close => (
				<div className="chip-list" aria-label="Loop">
					{loop.prompt && <div className="chip-note">{loop.prompt}</div>}
					<button
						type="button"
						className="chip-option"
						onClick={() => {
							close();
							onLoopOff();
						}}
					>
						Turn loop off
					</button>
				</div>
			)}
		</ChipMenu>
	);
}

/**
 * omp's status line under the composer — model and thinking level, directory, git, context use, time worked, spend —
 * and the cycle roles (`smol` / `default` / `slow`) in a menu, which the terminal UI steps through with ctrl+p.
 */
export function StatusLine({
	status,
	machineInfo,
	roles,
	thinkingLevels,
	onUseRole,
	onOpenModels,
	onOpenContext,
	location,
	onGoal,
	onLoopOff,
}: Props): ReactNode {
	const now = useNow(status.activeSince !== undefined || status.loop?.limit?.kind === "duration");
	const activeMs =
		(status.activeMs ?? 0) + (status.activeSince !== undefined ? Math.max(0, now - status.activeSince) : 0);
	const git = status.git;
	const billing = billingSummary(status);
	const current = roles ? activeRole(roles, status.model, status.thinkingLevel, thinkingLevels) : undefined;
	const level = status.thinkingLevel;
	const levelToken = level ? thinkingToken(level) : undefined;
	const levelColor = levelToken ? { color: ompText(levelToken) } : undefined;
	const model = (
		<>
			<ThinkingSector level={level} style={levelColor} title={level ? `thinking: ${level}` : undefined} />
			<span className="status-text">
				{status.modelName ?? status.model ?? "no model"}
				{level && (
					<>
						<span className="status-line-dim"> · </span>
						<span style={levelColor}>{level}</span>
					</>
				)}
			</span>
			{status.fastMode && <Zap aria-label="fast mode" />}
		</>
	);
	const context = status.contextUsage && (
		<>
			<Gauge aria-hidden="true" />
			{status.contextUsage.percent !== undefined && (
				<span className="status-meter" aria-hidden="true">
					<span
						className="status-meter-fill"
						style={{ width: `${Math.min(100, Math.max(0, status.contextUsage.percent))}%` }}
					/>
				</span>
			)}
			<span className="status-text">{status.contextUsage.label}</span>
			{status.autoCompaction && <RotateCcw aria-label="auto-compaction on" />}
		</>
	);
	const contextClass = "status-seg status-context";
	const contextStyle = {
		color: ompText(CONTEXT_TOKEN[status.contextUsage?.level ?? "normal"] ?? "statusLineContext"),
	};
	return (
		<div className="status-line" aria-label="Status">
			{status.goal && <GoalSegment goal={status.goal} onGoal={onGoal} />}
			{status.loop && <LoopSegment loop={status.loop} now={now} onLoopOff={onLoopOff} />}
			{activeMs >= 1000 && (
				<span className="status-seg status-time" title="Time the agent has worked in this session">
					<Timer aria-hidden="true" />
					<span className="status-text">{formatElapsed(activeMs)}</span>
				</span>
			)}
			{roles && onUseRole && <RoleMenu roles={roles} current={current} onUseRole={onUseRole} />}
			{onOpenModels ? (
				<button
					type="button"
					className="chip chip--button status-seg status-model"
					title={`${status.model ?? "no model"} · edit model roles (all sessions)`}
					onClick={onOpenModels}
				>
					{model}
				</button>
			) : (
				<span className="status-seg status-model" title={status.model}>
					{model}
				</span>
			)}
			{location ?? (
				<span className="status-seg status-path" title={displayPath(status.cwd, machineInfo)}>
					<Folder aria-hidden="true" />
					<span className="status-text">{displayPath(status.cwd, machineInfo)}</span>
				</span>
			)}
			{!location && git && (
				<span
					className="status-seg status-git"
					style={{
						color: ompText(
							git.staged + git.unstaged + git.untracked > 0 ? "statusLineGitDirty" : "statusLineGitClean",
						),
					}}
				>
					<GitBranch aria-hidden="true" />
					<span className="status-text">
						{git.branch ?? "detached"}
						{git.unstaged > 0 && <span style={{ color: ompText("statusLineDirty") }}> *{git.unstaged}</span>}
						{git.staged > 0 && <span style={{ color: ompText("statusLineStaged") }}> +{git.staged}</span>}
						{git.untracked > 0 && (
							<span style={{ color: ompText("statusLineUntracked") }}> ?{git.untracked}</span>
						)}
					</span>
				</span>
			)}
			{context &&
				(onOpenContext ? (
					<button
						type="button"
						className={`chip chip--button ${contextClass}`}
						style={contextStyle}
						title="What fills the context (/context)"
						aria-haspopup="dialog"
						onClick={event => onOpenContext(event.currentTarget)}
					>
						{context}
					</button>
				) : (
					<span className={contextClass} style={contextStyle}>
						{context}
					</span>
				))}
			{billing && (
				<span
					className="status-seg status-cost"
					title={
						status.backend === "antigravity"
							? "Estimate: Antigravity's token counts at the model's public API price (omp's catalog); a subscription bills differently"
							: undefined
					}
				>
					<span className="status-text">
						{status.backend === "antigravity" ? "~" : ""}
						{billing}
					</span>
				</span>
			)}
		</div>
	);
}
