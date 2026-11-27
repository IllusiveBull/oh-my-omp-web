import type { MachineSummary } from "@omp-web/protocol";
import { ChevronLeft, ClipboardPaste, Copy } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { displayPath, type Selection } from "../../lib/environment";
import {
	disabledMessage,
	exitText,
	neighborTab,
	OFFLINE_MESSAGE,
	restartedMessage,
	copyToClipboard,
	readClipboard,
	tabsOf,
	tabTitle,
	terminalTarget,
	terminalViewState,
} from "../../lib/terminal";
import { applyCtrl, type KeyId, keySequence, pasteDecision } from "../../lib/terminal-input";
import { terminalKey, type TerminalClient } from "../../store/terminal-client";
import { KeyBar } from "./key-bar";
import { PasteConfirm } from "./paste-confirm";
import { type ScreenHandle, TerminalScreen } from "./terminal-screen";
import { TerminalNotices } from "./terminal-nav";
import { TerminalTabs } from "./terminal-tabs";
import { IconButton } from "../ui/icon-button";

interface Props {
	terminals: TerminalClient;
	machine: string;
	machineInfo: MachineSummary | undefined;
	terminalId: string;
	/** The sidebar's selection: "New terminal" opens in its worktree. */
	selection: Selection;
	/** Shows another terminal, or (null) leaves for the list. Never ends a shell. */
	onSelect(id: string | null): void;
}

const COARSE_QUERY = "(max-width: 720px), (pointer: coarse)";

/** The phone layout: where the key bar is shown (a narrow window or a touch screen). */
function useCoarseLayout(): boolean {
	const [coarse, setCoarse] = useState(() => window.matchMedia?.(COARSE_QUERY).matches ?? false);
	useEffect(() => {
		const query = window.matchMedia?.(COARSE_QUERY);
		if (!query) return;
		const update = (): void => setCoarse(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	return coarse;
}

function usePageVisible(): boolean {
	const [visible, setVisible] = useState(() => document.visibilityState === "visible");
	useEffect(() => {
		const update = (): void => setVisible(document.visibilityState === "visible");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return visible;
}

/**
 * One terminal of a machine, on screen: the tab strip of the machine's terminals, the xterm, and the notices that say
 * what became of the shell (exited, ended with its daemon, dismissed elsewhere, machine offline, terminals disabled).
 * Attached only while this view is mounted and the page is visible.
 */
export function TerminalView({ terminals, machine, machineInfo, terminalId, selection, onSelect }: Props): ReactNode {
	const state = useSyncExternalStore(terminals.subscribe, terminals.getSnapshot);
	const root = useRef<HTMLDivElement>(null);
	const handle = useRef<ScreenHandle | null>(null);
	const ctrl = useRef(false);
	const [ctrlOn, setCtrlOn] = useState(false);
	const [paste, setPaste] = useState<{ text: string; lines: number } | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const coarse = useCoarseLayout();
	const pageVisible = usePageVisible();

	useEffect(() => terminals.watch(machine), [terminals, machine]);

	const name = machineInfo?.name ?? machine;
	const view = state.machines[machine];
	const attachment = state.attachments[terminalKey(machine, terminalId)];
	const status = attachment?.status;
	const info = attachment?.info ?? view?.terminals.find(t => t.id === terminalId) ?? null;
	const disabled = view?.capability?.enabled === false;
	const online = view?.online ?? false;
	const lost = status === "lost";
	const exited = status === "exited" || (status === undefined && info?.state === "exited");
	const viewState = terminalViewState({ disabled, online, lost, exited });
	const interactive = viewState === "running";
	const tabs = tabsOf(view?.terminals ?? [], lost && info ? [info] : [], { disabled, online });
	const target = terminalTarget(machineInfo, selection);

	// The terminal was dismissed (here or from another browser): show the tab that follows it, else the list.
	const lastTabs = useRef(tabs);
	if (tabs.some(t => t.id === terminalId)) lastTabs.current = tabs;
	useEffect(() => {
		if (status === "gone") onSelect(neighborTab(lastTabs.current, terminalId));
	}, [status, onSelect, terminalId]);

	// Notes ("Copied.", a refused clipboard read) fade by themselves.
	useEffect(() => {
		if (note === null) return;
		const timer = setTimeout(() => setNote(null), 4000);
		return () => clearTimeout(timer);
	}, [note]);

	// On a phone the soft keyboard shrinks the visual viewport, not the layout one: follow it.
	useEffect(() => {
		const viewport = window.visualViewport;
		const element = root.current;
		if (!viewport || !element) return;
		const apply = (): void => element.style.setProperty("--term-vv", `${viewport.height}px`);
		apply();
		viewport.addEventListener("resize", apply);
		viewport.addEventListener("scroll", apply);
		return () => {
			viewport.removeEventListener("resize", apply);
			viewport.removeEventListener("scroll", apply);
			element.style.removeProperty("--term-vv");
		};
	}, []);

	const send = useCallback(
		(raw: string): void => {
			const typed = applyCtrl(raw, ctrl.current);
			if (typed.armed !== ctrl.current) {
				ctrl.current = typed.armed;
				setCtrlOn(typed.armed);
			}
			terminals.input(machine, terminalId, typed.data);
		},
		[terminals, machine, terminalId],
	);

	const requestPaste = useCallback((text: string): void => {
		const decision = pasteDecision(text, handle.current?.bracketedPasteMode() ?? false);
		if (decision.kind === "send") handle.current?.paste(text);
		else setPaste({ text, lines: decision.lines });
	}, []);

	const pasteFromClipboard = (): void => {
		readClipboard().then(requestPaste, (error: Error) => setNote(error.message));
	};

	const copy = (): void => {
		const text = handle.current?.selection() ?? "";
		if (text === "") {
			setNote("Select some text first.");
			return;
		}
		copyToClipboard(text).then(
			() => setNote("Copied."),
			(error: Error) => setNote(error.message),
		);
	};

	const onKey = (id: KeyId): void => {
		if (id === "ctrl") {
			ctrl.current = !ctrl.current;
			setCtrlOn(ctrl.current);
		} else if (id === "paste") {
			pasteFromClipboard();
		} else {
			const sequence = keySequence(id, handle.current?.applicationCursorKeys() ?? false);
			if (sequence !== null) send(sequence);
		}
		handle.current?.focus();
	};

	const messages: { kind: string; text: string }[] = [];
	if (disabled) {
		messages.push({ kind: "disabled", text: disabledMessage(name) });
	} else if (!online) {
		messages.push({ kind: "offline", text: `${name}: ${OFFLINE_MESSAGE}. The screen shows what was received.` });
	}
	if (lost) {
		const missing = `This terminal does not exist on ${name}. It was dismissed, or its omp-webd restarted.`;
		messages.push({ kind: "lost", text: info ? restartedMessage(name) : missing });
	}
	if (view?.error && !disabled) {
		messages.push({ kind: "error", text: `Terminals are not available on ${name}: ${view.error}` });
	}
	if (attachment?.error) messages.push({ kind: "error", text: attachment.error });
	if (info?.purpose === "broker-login" && interactive) {
		messages.push({ kind: "broker-login", text: "The command is typed but not run. Review it and press Enter." });
	}
	if (note !== null) messages.push({ kind: "local", text: note });

	const title = info ? tabTitle(info) : terminalId;
	const mounted = !disabled && info !== null;
	let newBlocked: string | null = null;
	if (!online) newBlocked = OFFLINE_MESSAGE;
	else if (disabled) newBlocked = "Terminals are disabled on this machine.";
	else if (!target.ok) newBlocked = target.reason;

	return (
		<div
			ref={root}
			className="term"
			data-view="terminal"
			data-terminal={terminalId}
			data-state={viewState}
			data-attached={String(status === "attached")}
		>
			<TerminalTabs
				tabs={tabs}
				active={terminalId}
				newBlocked={newBlocked}
				onSelect={id => onSelect(id)}
				onCreate={async () => {
					if (!target.ok) return target.reason;
					const result = await terminals.open(machine, { cwd: target.cwd, size: terminals.preferredSize });
					if (!result.ok) return result.code === "terminal_disabled" ? disabledMessage(name) : result.error;
					onSelect(result.terminal.id);
					return null;
				}}
				onKill={id => terminals.kill(machine, id)}
				onDismiss={id => terminals.dismiss(machine, id)}
			/>
			<div className="term-bar">
				<IconButton
					icon={ChevronLeft}
					label="All terminals (the shell keeps running)"
					data-role="term-detach"
					onClick={() => onSelect(null)}
				/>
				<span className="term-title" title={info ? displayPath(info.cwd, machineInfo) : undefined}>
					{title}
				</span>
				{info?.purpose === "broker-login" && <span className="term-badge">broker login</span>}
				<span className="term-machine faint">{name}</span>
				<span className="term-tools icon-row">
					<IconButton icon={Copy} label="Copy the selection" data-role="term-copy" onClick={copy} />
					<IconButton
						icon={ClipboardPaste}
						label="Paste from the clipboard"
						data-role="term-paste"
						disabled={!interactive}
						onClick={pasteFromClipboard}
					/>
				</span>
			</div>
			{messages.map(m => (
				<div
					key={`${m.kind}:${m.text}`}
					className="term-notice"
					role="status"
					data-role="term-notice"
					data-notice={m.kind}
				>
					{m.text}
				</div>
			))}
			<TerminalNotices terminals={terminals} machine={machine} />
			{paste && (
				<PasteConfirm
					lines={paste.lines}
					onPaste={() => {
						handle.current?.paste(paste.text);
						setPaste(null);
						handle.current?.focus();
					}}
					onCancel={() => {
						setPaste(null);
						handle.current?.focus();
					}}
				/>
			)}
			{mounted ? (
				<TerminalScreen
					terminals={terminals}
					machine={machine}
					id={terminalId}
					visible={pageVisible}
					interactive={interactive}
					onData={send}
					onPaste={requestPaste}
					onReady={next => {
						handle.current = next;
					}}
				/>
			) : (
				<div className="term-body term-body--empty">
					{disabled ? null : view?.synced || status === "lost" ? "Terminal not found." : "Loading…"}
				</div>
			)}
			{exited && (
				<div className="term-exit" role="status" data-role="term-notice" data-notice="exit">
					{exitText(attachment?.exit ?? info?.exit ?? null)}
				</div>
			)}
			{coarse && interactive && <KeyBar ctrl={ctrlOn} onKey={onKey} />}
		</div>
	);
}
