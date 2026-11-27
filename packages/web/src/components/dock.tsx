import { FileDiff, Folder, List, type LucideIcon, MessageCircleQuestionMark, SquareTerminal, X } from "lucide-react";
import { type PointerEvent, type ReactNode, useState } from "react";
import type { ChangeStats } from "../lib/files";
import type { DockTab } from "../lib/route";
import { changeSummary, DiffLines } from "./files/diff-stat";
import { IconButton } from "./ui/icon-button";
import type { AgentCounts } from "../lib/subagents";

/** `hint`: what the tab is for, the tooltip when there is no live state to report instead. */
const ITEMS: readonly { tab: DockTab; icon: LucideIcon; label: string; hint: string }[] = [
	{ tab: "agents", icon: List, label: "Agents", hint: "sub-agents of this session" },
	{ tab: "btw", icon: MessageCircleQuestionMark, label: "BTW", hint: "ask this session a side question" },
	{ tab: "terminal", icon: SquareTerminal, label: "Terminal", hint: "shells on this machine" },
	{ tab: "files", icon: Folder, label: "Files", hint: "browse the worktree" },
	{ tab: "changes", icon: FileDiff, label: "Changes", hint: "uncommitted changes of the worktree" },
];

interface ToolbarProps {
	/** The tab the dock shows, or null when it is closed. */
	open: DockTab | null;
	/** Opens a tab, or closes the dock when it is the one shown. */
	onToggle(tab: DockTab): void;
	/** Why a tab cannot be opened here (its tooltip), keyed by tab; absent tabs are available. */
	blocked?: Partial<Record<DockTab, string>>;
	/** Sub-agents of the open session: the running ones are the Agents badge, all of them are in its tooltip. */
	agents?: AgentCounts;
	/** Running terminals of the machine in context: the Terminal badge. */
	terminals?: number;
	/** The dock worktree's changes: while there are any, the Changes tab widens to show them GitHub style. */
	changes?: ChangeStats;
	/** The dock worktree's branch as the Files view names it (`main ↑1`), for the Files tooltip. */
	branch?: string;
}

/** The icon strip that opens the right-hand dock's tabs. */
export function DockToolbar({
	open,
	onToggle,
	blocked = {},
	agents = { total: 0, running: 0 },
	terminals = 0,
	changes,
	branch,
}: ToolbarProps): ReactNode {
	const changed = changes !== undefined && changes.files > 0;
	return (
		<div className="dock-toolbar icon-row" role="toolbar" aria-label="Panels">
			{ITEMS.map(({ tab, icon, label, hint }) => {
				const why = blocked[tab];
				const diff = tab === "changes" && changed;
				const badge = tab === "agents" ? agents.running : tab === "terminal" ? terminals : 0;
				const live = tab === "agents" && agents.running > 0;
				const state =
					tab === "agents" && agents.total > 0
						? `${agents.total} ${agents.total === 1 ? "sub-agent" : "sub-agents"}${live ? `, ${agents.running} running` : ""}`
						: tab === "terminal" && terminals > 0
							? `${terminals} running`
							: diff
								? changeSummary(changes)
								: tab === "files" && branch
									? `${hint} (${branch})`
									: hint;
				const title = why ?? `${label}: ${state}`;
				return (
					<IconButton
						key={tab}
						icon={icon}
						label={title}
						className={`dock-tab${tab === "files" ? " files-entry" : ""}${diff ? " dock-tab--diff" : ""}`}
						data-tab={tab}
						aria-pressed={open === tab}
						disabled={why !== undefined && open !== tab}
						onClick={() => onToggle(tab)}
					>
						{badge > 0 && (
							<span className="icon-btn-badge" data-live={live ? "true" : undefined} aria-hidden="true">
								{badge > 99 ? "99+" : badge}
							</span>
						)}
						{diff && (
							<span className="diffstat" aria-hidden="true">
								{changes.added === null || changes.removed === null ? (
									changes.files
								) : (
									<DiffLines added={changes.added} removed={changes.removed} />
								)}
							</span>
						)}
					</IconButton>
				);
			})}
		</div>
	);
}

const WIDTH_KEY = "omp-web.dock-width";
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 520;
const SIDEBAR_WIDTH = 272;
const MAIN_MIN_WIDTH = 400;

function storedWidth(): number {
	try {
		const n = Number(localStorage.getItem(WIDTH_KEY));
		return Number.isFinite(n) && n >= MIN_WIDTH ? n : DEFAULT_WIDTH;
	} catch {
		return DEFAULT_WIDTH;
	}
}

/** The widest the dock may be: the sidebar and a usable main view stay beside it (keep in step with shell.css). */
const maxWidth = (): number => Math.max(MIN_WIDTH, window.innerWidth - SIDEBAR_WIDTH - MAIN_MIN_WIDTH);

interface DockProps {
	tab: DockTab;
	onClose(): void;
	children?: ReactNode;
}

/**
 * The right-hand panel beside the main view: a header naming the tab, a close button, and a body that is a size
 * container named `dock` (views inside lay themselves out by its width, not the window's). Its left edge drags to
 * resize; the width is remembered per browser. On a phone it covers the screen.
 */
export function Dock({ tab, onClose, children }: DockProps): ReactNode {
	const label = ITEMS.find(i => i.tab === tab)!.label;
	const [width, setWidth] = useState(storedWidth);

	const startResize = (e: PointerEvent<HTMLDivElement>): void => {
		if (e.button !== 0) return;
		e.preventDefault();
		const handle = e.currentTarget;
		handle.setPointerCapture(e.pointerId);
		let next = width;
		const move = (ev: globalThis.PointerEvent): void => {
			next = Math.min(maxWidth(), Math.max(MIN_WIDTH, window.innerWidth - ev.clientX));
			setWidth(next);
		};
		const end = (): void => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
			try {
				localStorage.setItem(WIDTH_KEY, String(next));
			} catch {
				// storage disabled: the width lasts for this page only
			}
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	};

	return (
		<aside className="dock" data-tab={tab} aria-label={label} style={{ width: Math.min(width, maxWidth()) }}>
			<div
				className="dock-resize"
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize the panel"
				onPointerDown={startResize}
			/>
			<header className="dock-head">
				<span className="dock-title">{label}</span>
				<IconButton icon={X} label="Close panel" name="dock-close" onClick={onClose} />
			</header>
			<div className="dock-body">{children}</div>
		</aside>
	);
}
