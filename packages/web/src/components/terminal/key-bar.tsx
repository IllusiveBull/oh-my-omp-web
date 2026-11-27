import type { ReactNode } from "react";
import { KEY_BAR, type KeyId } from "../../lib/terminal-input";

interface Props {
	/** Ctrl is armed: the next character typed becomes its control character. */
	ctrl: boolean;
	onKey(id: KeyId): void;
}

/**
 * The keys a phone's keyboard lacks. The buttons never take focus (pointer and mouse down are cancelled), so the
 * terminal's input element keeps it and the soft keyboard stays up.
 */
export function KeyBar({ ctrl, onKey }: Props): ReactNode {
	return (
		<div className="term-keys" role="toolbar" aria-label="Terminal keys">
			{KEY_BAR.map(key => (
				<button
					key={key.id}
					type="button"
					tabIndex={-1}
					className={`term-key${key.id === "ctrl" && ctrl ? " term-key--on" : ""}`}
					data-key={key.id}
					aria-pressed={key.id === "ctrl" ? ctrl : undefined}
					title={key.title}
					onPointerDown={e => e.preventDefault()}
					onMouseDown={e => e.preventDefault()}
					onClick={() => onKey(key.id)}
				>
					{key.label}
				</button>
			))}
		</div>
	);
}
