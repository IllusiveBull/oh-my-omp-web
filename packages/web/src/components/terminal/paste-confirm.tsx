import type { ReactNode } from "react";

interface Props {
	lines: number;
	onPaste(): void;
	onCancel(): void;
}

/** Asks before a multi-line paste into a shell that did not ask for bracketed paste: each line runs as it is read. */
export function PasteConfirm({ lines, onPaste, onCancel }: Props): ReactNode {
	return (
		<div className="term-confirm" role="alertdialog" data-role="paste-confirm" data-lines={lines}>
			<span>
				Paste {lines} {lines === 1 ? "line" : "lines"}? Each line runs as soon as the shell reads it.
			</span>
			<button type="button" className="btn btn--small btn--primary" data-action="paste" onClick={onPaste}>
				Paste
			</button>
			<button type="button" className="btn btn--small" data-action="cancel" onClick={onCancel}>
				Cancel
			</button>
		</div>
	);
}
