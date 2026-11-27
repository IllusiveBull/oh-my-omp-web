import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { clampTerminalSize } from "@omp-web/protocol";
import { type ReactNode, useEffect, useRef } from "react";
import { themeFromTokens } from "../../lib/terminal";
import type { Binding, Sink, TerminalClient } from "../../store/terminal-client";

/** What the view needs of the xterm it hosts. */
export interface ScreenHandle {
	focus(): void;
	/** The selected text ("" when nothing is selected). */
	selection(): string;
	/** Pastes as xterm does: bracketed when the application asked for it, with line breaks as carriage returns. */
	paste(text: string): void;
	bracketedPasteMode(): boolean;
	applicationCursorKeys(): boolean;
}

interface Props {
	terminals: TerminalClient;
	machine: string;
	id: string;
	/** The page is visible: attach; otherwise detach (the screen keeps its content). */
	visible: boolean;
	/** The shell is running: the screen takes input. */
	interactive: boolean;
	/** Everything the user types (and what the terminal answers to the shell's queries). */
	onData(data: string): void;
	/** Text pasted with the keyboard shortcut or the menu; the screen does not paste it itself. */
	onPaste(text: string): void;
	onReady(handle: ScreenHandle | null): void;
}

const RESIZE_DEBOUNCE_MS = 100;

const xterms = new Map<string, Terminal>();

/** The xterm showing terminal `id`, if one is mounted (the browser smoke reads it through `?debug`). */
export function terminalXterm(id: string): Terminal | undefined {
	return xterms.get(id);
}

function openLink(_event: MouseEvent, uri: string): void {
	if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener,noreferrer");
}

/**
 * One xterm bound to one terminal of the daemon. The grid is always the pty's size (the client resizes it from the
 * daemon's frames); the pane only reports what it could show, so a pty bigger than the pane scrolls and a smaller one
 * leaves room. Raw colors come from the page's tokens, re-read when the theme changes.
 */
export function TerminalScreen({
	terminals,
	machine,
	id,
	visible,
	interactive,
	onData,
	onPaste,
	onReady,
}: Props): ReactNode {
	const host = useRef<HTMLDivElement>(null);
	const term = useRef<Terminal | null>(null);
	const binding = useRef<Binding | null>(null);
	const latest = useRef({ visible, interactive, onData, onPaste, onReady });
	latest.current = { visible, interactive, onData, onPaste, onReady };

	useEffect(() => {
		const element = host.current;
		if (!element) return;
		const root = document.documentElement;
		const token = (name: string): string => getComputedStyle(root).getPropertyValue(name);
		const listed = terminals.getSnapshot().machines[machine]?.terminals.find(t => t.id === id);
		const known = listed ?? terminals.preferredSize;
		const xterm = new Terminal({
			scrollback: 5000,
			cursorBlink: true,
			allowProposedApi: true,
			fontFamily: token("--font-mono").trim() || "monospace",
			fontSize: 13,
			cols: known.cols,
			rows: known.rows,
			theme: themeFromTokens(token),
		});
		const fit = new FitAddon();
		xterm.loadAddon(fit);
		xterm.loadAddon(new Unicode11Addon());
		xterm.unicode.activeVersion = "11";
		xterm.loadAddon(new WebLinksAddon(openLink));
		xterm.open(element);
		const area = xterm.textarea;
		if (area) {
			area.setAttribute("autocapitalize", "off");
			area.setAttribute("autocorrect", "off");
			area.setAttribute("autocomplete", "off");
			area.setAttribute("spellcheck", "false");
		}
		term.current = xterm;
		xterms.set(id, xterm);
		let disposed = false;

		// The screen applies resets and resizes in the order of the writes before them (xterm parses writes later).
		const sink: Sink = {
			reset: () =>
				xterm.write("", () => {
					if (!disposed) xterm.reset();
				}),
			write: (data, done) => xterm.write(data, done),
			resize: (cols, rows) =>
				xterm.write("", () => {
					if (!disposed) xterm.resize(cols, rows);
				}),
		};

		const proposed = (): { cols: number; rows: number } | undefined => {
			const dims = fit.proposeDimensions();
			if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return undefined;
			return clampTerminalSize(dims.cols, dims.rows);
		};
		const bound = terminals.bind(machine, id, sink, { visible: latest.current.visible, desired: proposed() });
		binding.current = bound;
		const measure = (): void => {
			const size = proposed();
			if (!size) return;
			terminals.setPreferredSize(size);
			bound.setDesired(size);
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const observer = new ResizeObserver(() => {
			clearTimeout(timer);
			timer = setTimeout(measure, RESIZE_DEBOUNCE_MS);
		});
		observer.observe(element);

		const data = xterm.onData(d => latest.current.onData(d));
		const paste = (event: ClipboardEvent): void => {
			const text = event.clipboardData?.getData("text/plain") ?? "";
			event.preventDefault();
			event.stopPropagation();
			if (text !== "") latest.current.onPaste(text);
		};
		element.addEventListener("paste", paste, true);
		const focus = (): void => xterm.focus();
		element.addEventListener("click", focus);

		const applyTheme = (): void => {
			xterm.options.theme = themeFromTokens(token);
		};
		const themeObserver = new MutationObserver(applyTheme);
		themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
		const scheme = window.matchMedia?.("(prefers-color-scheme: light)");
		scheme?.addEventListener("change", applyTheme);

		latest.current.onReady({
			focus,
			selection: () => xterm.getSelection(),
			paste: text => xterm.paste(text),
			bracketedPasteMode: () => xterm.modes.bracketedPasteMode,
			applicationCursorKeys: () => xterm.modes.applicationCursorKeysMode,
		});
		if (latest.current.visible) xterm.focus();

		return () => {
			disposed = true;
			latest.current.onReady(null);
			clearTimeout(timer);
			observer.disconnect();
			themeObserver.disconnect();
			scheme?.removeEventListener("change", applyTheme);
			element.removeEventListener("paste", paste, true);
			element.removeEventListener("click", focus);
			data.dispose();
			bound.release();
			binding.current = null;
			xterms.delete(id);
			term.current = null;
			xterm.dispose();
		};
	}, [terminals, machine, id]);

	useEffect(() => {
		binding.current?.setVisible(visible);
		if (visible) term.current?.focus();
	}, [visible, terminals, machine, id]);

	useEffect(() => {
		if (term.current) term.current.options.disableStdin = !interactive;
	}, [interactive, terminals, machine, id]);

	return (
		<div className="term-body">
			<div className="term-host" ref={host} />
		</div>
	);
}
