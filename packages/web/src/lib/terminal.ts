import type { MachineSummary, TerminalExit, TerminalInfo } from "@omp-web/protocol";
import { newSessionTarget, type Selection } from "./environment";
import { formatAbsolute } from "./time";

/** Why terminals cannot be used on a machine, in the words the operator needs. */
export function disabledMessage(machineName: string): string {
	return `Terminals are disabled on ${machineName}. The operator enables them on that machine: start omp-webd with --terminal (or "terminal": {"enabled": true} in config.json).`;
}

/** The shell is gone because its omp-webd restarted: the daemon stops its shells when it stops. */
export function restartedMessage(machineName: string): string {
	return `This terminal ended because the omp-webd on ${machineName} restarted (its shells are stopped when it stops). The last output is kept here.`;
}

export const OFFLINE_MESSAGE = "machine offline";

/** The label of a terminal: what the shell titled itself, else the daemon's default name. */
export function tabTitle(info: Pick<TerminalInfo, "title" | "name">): string {
	return info.title && info.title.trim() !== "" ? info.title : info.name;
}

/** `data-state` of a terminal in the views and the tab strip. */
export type TerminalViewState = "running" | "exited" | "lost" | "offline" | "disabled";

export interface TerminalViewFacts {
	/** The machine's capability says terminals are off. */
	disabled: boolean;
	/** The machine is reachable now. */
	online: boolean;
	lost: boolean;
	exited: boolean;
}

/** Most severe first: disabled, then offline (nothing can happen), then lost, then exited. */
export function terminalViewState(facts: TerminalViewFacts): TerminalViewState {
	if (facts.disabled) return "disabled";
	if (!facts.online) return "offline";
	if (facts.lost) return "lost";
	return facts.exited ? "exited" : "running";
}

/** "Exited with code 0" / "Exited (no code)" / "Killed", with the time it happened. */
export function exitText(exit: TerminalExit | null): string {
	if (exit === null) return "Exited";
	const what = exit.killed ? "Killed" : exit.code === null ? "Exited" : `Exited with code ${exit.code}`;
	return `${what} at ${formatAbsolute(exit.at)}`;
}

export interface TerminalTab {
	id: string;
	title: string;
	state: TerminalViewState;
	purpose: TerminalInfo["purpose"];
}

/**
 * The tab strip of a machine: its terminals in list order, plus `lost` ones (the viewed terminal the daemon no longer
 * lists after a restart), which are kept so the user sees what happened and can dismiss them.
 */
export function tabsOf(
	terminals: readonly TerminalInfo[],
	lost: readonly TerminalInfo[],
	facts: { disabled: boolean; online: boolean },
): TerminalTab[] {
	const listed = new Set(terminals.map(t => t.id));
	const tab = (info: TerminalInfo, isLost: boolean): TerminalTab => ({
		id: info.id,
		title: tabTitle(info),
		state: terminalViewState({ ...facts, lost: isLost, exited: info.state === "exited" }),
		purpose: info.purpose,
	});
	return [...terminals.map(t => tab(t, false)), ...lost.filter(t => !listed.has(t.id)).map(t => tab(t, true))];
}

/** The tab to show after `id` goes away: the one after it, else the one before it, else none. */
export function neighborTab(tabs: readonly { id: string }[], id: string): string | null {
	const at = tabs.findIndex(t => t.id === id);
	if (at === -1) return tabs[0]?.id ?? null;
	return tabs[at + 1]?.id ?? tabs[at - 1]?.id ?? null;
}

export type TerminalTarget = { ok: true; cwd: string } | { ok: false; reason: string };

/** Where "New terminal" opens a shell: the selected worktree, the same rule as "New session". */
export function terminalTarget(machine: MachineSummary | undefined, selection: Selection): TerminalTarget {
	if (!machine) return { ok: false, reason: "No machine selected." };
	if (selection.machine !== machine.id) {
		return { ok: false, reason: `Pick a project and worktree on ${machine.name} in the sidebar.` };
	}
	return newSessionTarget(machine, selection);
}

/** The 16 ANSI colors of the terminal palette, as CSS custom properties defined in terminal.css. */
const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

export type TerminalTheme = Record<string, string>;

/**
 * The xterm theme from the page's design tokens: background `--bg-inset`, foreground `--fg`, cursor `--accent`,
 * selection `--selected`, the palette from `--term-ansi-0` … `--term-ansi-15`. `read` returns a custom property's value.
 * A property that is not set is left out, so xterm keeps its own default for it.
 */
export function themeFromTokens(read: (name: string) => string): TerminalTheme {
	const theme: TerminalTheme = {};
	const put = (key: string, name: string): void => {
		const value = read(name).trim();
		if (value !== "") theme[key] = value;
	};
	put("background", "--bg-inset");
	put("foreground", "--fg");
	put("cursor", "--accent");
	put("cursorAccent", "--bg-inset");
	put("selectionBackground", "--selected");
	ANSI_NAMES.forEach((name, i) => {
		put(name, `--term-ansi-${i}`);
		put(`bright${name[0]!.toUpperCase()}${name.slice(1)}`, `--term-ansi-${i + 8}`);
	});
	return theme;
}

/**
 * Copies `text`: the async clipboard where the page may use it, else a hidden textarea and `execCommand("copy")` (the
 * gateway may be served over plain http, where `navigator.clipboard` does not exist). Rejects when neither works.
 */
export async function copyToClipboard(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {
			// Permission denied or not focused: fall through to the legacy path.
		}
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} finally {
		area.remove();
	}
	if (!ok) throw new Error("copy is not available here");
}

/** Reads the clipboard as text; rejects with a presentable message where the page may not read it. */
export async function readClipboard(): Promise<string> {
	if (!navigator.clipboard?.readText) {
		throw new Error(
			"Reading the clipboard is not available here (it needs https). Use your keyboard's paste instead.",
		);
	}
	try {
		return await navigator.clipboard.readText();
	} catch {
		throw new Error("The browser did not allow reading the clipboard. Use your keyboard's paste instead.");
	}
}
