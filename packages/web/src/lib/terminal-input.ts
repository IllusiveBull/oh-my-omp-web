/** Pure helpers for what the user types into a terminal: the mobile key bar, sticky Ctrl, and pastes. */

/** Largest `term.input` frame the client sends (the daemon accepts 64 KiB; smaller frames interleave fairly). */
export const INPUT_FRAME_CHARS = 16 * 1024;

export type KeyId =
	| "esc"
	| "tab"
	| "ctrl"
	| "up"
	| "down"
	| "left"
	| "right"
	| "pipe"
	| "tilde"
	| "slash"
	| "dash"
	| "paste";

export interface KeySpec {
	id: KeyId;
	label: string;
	/** Accessible name where the label is a symbol. */
	title: string;
}

/** The key bar, in order. */
export const KEY_BAR: readonly KeySpec[] = [
	{ id: "esc", label: "Esc", title: "Escape" },
	{ id: "tab", label: "Tab", title: "Tab" },
	{ id: "ctrl", label: "Ctrl", title: "Control: applies to the next character" },
	{ id: "up", label: "↑", title: "Up" },
	{ id: "down", label: "↓", title: "Down" },
	{ id: "left", label: "←", title: "Left" },
	{ id: "right", label: "→", title: "Right" },
	{ id: "pipe", label: "|", title: "Pipe" },
	{ id: "tilde", label: "~", title: "Tilde" },
	{ id: "slash", label: "/", title: "Slash" },
	{ id: "dash", label: "-", title: "Dash" },
	{ id: "paste", label: "Paste", title: "Paste from the clipboard" },
];

const ARROW_FINAL: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };
const LITERAL: Record<string, string> = { esc: "\x1b", tab: "\t", pipe: "|", tilde: "~", slash: "/", dash: "-" };

/**
 * The bytes a key bar button types, or null for the buttons that are not keys (Ctrl, Paste). Arrows follow the
 * application's cursor-key mode: `ESC O A` while it is on (vim, less, readline in some configs), `ESC [ A` otherwise.
 */
export function keySequence(id: KeyId, applicationCursor: boolean): string | null {
	const final = ARROW_FINAL[id];
	if (final !== undefined) return `\x1b${applicationCursor ? "O" : "["}${final}`;
	return LITERAL[id] ?? null;
}

/** The control character of one typed character (`a`–`z` → 0x01–0x1a, `[` `\` `]` → 0x1b–0x1d, `@` and space → 0), or null. */
export function ctrlChar(char: string): string | null {
	if (char.length !== 1) return null;
	if (/[a-zA-Z]/.test(char)) return String.fromCharCode(char.toLowerCase().charCodeAt(0) - 0x60);
	switch (char) {
		case "[":
			return "\x1b";
		case "\\":
			return "\x1c";
		case "]":
			return "\x1d";
		case "@":
		case " ":
			return "\x00";
		default:
			return null;
	}
}

/**
 * Sticky one-shot Ctrl: while `armed`, the next single character typed becomes its control character and disarms it
 * (a character without one is sent as typed, still disarming). Escape sequences and pastes (several characters) pass
 * through untouched and keep Ctrl armed.
 */
export function applyCtrl(data: string, armed: boolean): { data: string; armed: boolean } {
	if (!armed) return { data, armed };
	if (data.length !== 1) return { data, armed: true };
	return { data: ctrlChar(data) ?? data, armed: false };
}

/** Number of lines in pasted text (a trailing line break does not start another one). */
export function countLines(text: string): number {
	const lines = text.split(/\r\n|\r|\n/);
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines.length;
}

export type PasteDecision = { kind: "send" } | { kind: "confirm"; lines: number };

/**
 * Bracketed paste makes the shell treat the text as one paste, so it is sent as is. Without it every line break runs
 * what came before it: the user confirms first.
 */
export function pasteDecision(text: string, bracketedPasteMode: boolean): PasteDecision {
	if (bracketedPasteMode || !/[\r\n]/.test(text)) return { kind: "send" };
	return { kind: "confirm", lines: countLines(text) };
}

/** Splits `text` into frames of at most `max` characters, never between the halves of a surrogate pair. */
export function splitInput(text: string, max = INPUT_FRAME_CHARS): string[] {
	if (text.length <= max) return text === "" ? [] : [text];
	const parts: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(text.length, start + max);
		if (end < text.length) {
			const last = text.charCodeAt(end - 1);
			if (last >= 0xd800 && last <= 0xdbff) end--; // a high surrogate: its low half is the next code unit
		}
		parts.push(text.slice(start, end));
		start = end;
	}
	return parts;
}
