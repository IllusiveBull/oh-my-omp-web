import { type ReactNode, useState } from "react";
import { parseHttpUrl, previewText } from "../lib/attention";
import type { AttentionItem } from "../store/session-store";

interface Props {
	items: readonly AttentionItem[];
	onUseText(text: string): void;
	onDismiss(id: number): void;
}

/**
 * Requests an extension made of this client, each answered by the user and never acted on automatically:
 * suggested composer text goes into the local draft only on Use (so nothing typed in another client is clobbered), and a
 * URL opens only through a link the user clicks (http(s) only; any other scheme is shown as text without a link).
 */
export function AttentionBar({ items, onUseText, onDismiss }: Props): ReactNode {
	if (items.length === 0) return null;
	return (
		<div className="attention">
			{items.map(item =>
				item.kind === "editor_text" ? (
					<div key={item.id} className="attention-item" role="status">
						<span className="attention-text">
							An extension suggests this composer text: <q>{previewText(item.text)}</q>
						</span>
						<button
							type="button"
							className="btn btn--small btn--primary"
							onClick={() => {
								onUseText(item.text);
								onDismiss(item.id);
							}}
						>
							Use
						</button>
						<button type="button" className="btn btn--small btn--ghost" onClick={() => onDismiss(item.id)}>
							Dismiss
						</button>
					</div>
				) : (
					<OpenUrl key={item.id} item={item} onDismiss={() => onDismiss(item.id)} />
				),
			)}
		</div>
	);
}

function OpenUrl({
	item,
	onDismiss,
}: {
	item: Extract<AttentionItem, { kind: "open_url" }>;
	onDismiss(): void;
}): ReactNode {
	const [copy, setCopy] = useState<"copied" | "failed" | null>(null);
	const parsed = parseHttpUrl(item.url);
	const copyTarget = item.launchUrl ?? item.url;
	return (
		<div className="attention-item" role="status">
			<span className="attention-text">
				omp wants you to open <strong>{parsed?.host ?? item.url}</strong>
				{item.instructions && <span className="attention-note"> — {item.instructions}</span>}
			</span>
			{parsed && (
				<a className="btn btn--small btn--primary" href={parsed.href} target="_blank" rel="noopener noreferrer">
					Open
				</a>
			)}
			<button
				type="button"
				className="btn btn--small"
				onClick={() => {
					// `navigator.clipboard` does not exist outside secure contexts (the daemon may be served over plain http).
					(navigator.clipboard?.writeText(copyTarget) ?? Promise.reject(new Error("clipboard unavailable"))).then(
						() => setCopy("copied"),
						() => setCopy("failed"),
					);
				}}
			>
				{copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy link"}
			</button>
			<button type="button" className="btn btn--small btn--ghost" onClick={onDismiss}>
				Dismiss
			</button>
		</div>
	);
}
