import { formatNumber } from "@oh-my-pi/pi-utils/format";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { contextOverview, contextWindow, parseContextReport } from "../lib/context-overview";
import type { DaemonClient } from "../store/daemon-client";
import { IconButton } from "./ui/icon-button";

interface Props {
	client: DaemonClient;
	machine: string;
	sessionId: string;
	/** The transcript, to split omp's Messages total the way the terminal view does. */
	entries: readonly SessionEntry[];
	anchor: HTMLButtonElement;
	onClose(): void;
}

/** Share of the window as the terminal shows it: one decimal, `<0.1%` for a sliver. */
function share(tokens: number, window: number | null): string {
	if (!window) return "";
	const percent = (tokens / window) * 100;
	return percent > 0 && percent < 0.05 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

/** omp's `/context` (the status line's context segment): what fills the session's context window. */
export function ContextPanel({ client, machine, sessionId, entries, anchor, onClose }: Props): ReactNode {
	const panel = useRef<HTMLDivElement>(null);
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Follow the anchor rather than close: the transcript scrolls by itself while the agent streams.
	useLayoutEffect(() => {
		const element = panel.current;
		if (!element) return;
		const place = (): void => {
			const rect = anchor.getBoundingClientRect();
			const gap = 8;
			element.style.left = `${Math.max(gap, Math.min(rect.left, window.innerWidth - element.offsetWidth - gap))}px`;
			element.style.bottom = `${Math.max(gap, window.innerHeight - rect.top + gap)}px`;
			element.style.maxHeight = `${Math.max(0, rect.top - gap * 2)}px`;
		};
		place();
		element.focus({ preventScroll: true });
		window.addEventListener("resize", place);
		// Capture: the scrolling element is an ancestor (the transcript), not the window.
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [anchor]);

	useEffect(() => {
		let current = true;
		void client.request(machine, { t: "session.context", sessionId }, 15_000).then(ack => {
			if (!current) return;
			const data = ack.ok ? ack.data : undefined;
			if (typeof data === "object" && data !== null && "text" in data && typeof data.text === "string")
				setText(data.text);
			else setError(ack.ok ? "omp sent no context report" : ack.error);
		});
		return () => {
			current = false;
		};
	}, [client, machine, sessionId]);

	useEffect(() => {
		const outside = (event: Event): void => {
			const target = event.target as Node | null;
			if (target && !panel.current?.contains(target) && !anchor.contains(target)) onClose();
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			onClose();
			anchor.focus({ preventScroll: true });
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		document.addEventListener("keydown", onKey);
		window.addEventListener("blur", onClose);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("blur", onClose);
		};
	}, [anchor, onClose]);

	const report = text === null ? null : parseContextReport(text);
	const windowTokens = report && contextWindow(report.title);
	const overview = report && report.rows.length > 0 ? contextOverview(report.rows, entries) : null;
	return (
		<div
			ref={panel}
			className="context-panel"
			data-testid="context-panel"
			role="dialog"
			aria-label="Context"
			tabIndex={-1}
		>
			<div className="handoff-head">
				<h2>Context</h2>
				<IconButton icon={X} className="handoff-close" label="Close" onClick={onClose} />
			</div>
			{report && <div className="handoff-title">{report.title}</div>}
			<div className="handoff-body">
				{error && (
					<div className="form-error" role="alert">
						{error}
					</div>
				)}
				{!report && !error && <div className="faint">Loading…</div>}
				{overview && (
					<ul className="context-rows">
						{overview.rows.map(row => (
							<li
								key={row.key}
								className={`context-row${row.child ? " context-row--child" : ""}`}
								data-row={row.key}
							>
								<span className="context-label">{row.label}</span>
								<span className="context-bar" aria-hidden>
									<span
										className="context-fill"
										style={{
											width: `${windowTokens ? Math.min(100, (row.tokens / windowTokens) * 100) : 0}%`,
										}}
									/>
								</span>
								<span className="context-num">{formatNumber(row.tokens)}</span>
								<span className="context-num">{share(row.tokens, windowTokens)}</span>
							</li>
						))}
					</ul>
				)}
				{overview?.split && overview.omp && (
					<p className="context-notes">
						Message categories split omp's Messages total by estimated share of the transcript; the other rows are
						omp's own totals.
					</p>
				)}
				{report && report.notes.length > 0 && <pre className="context-notes">{report.notes.join("\n")}</pre>}
			</div>
		</div>
	);
}
