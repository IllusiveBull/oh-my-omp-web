/**
 * The slice of `@xterm/headless` the daemon uses, mapped over the package in tsconfig.json (`paths`).
 *
 * The packages' own typings reference the browser's DOM lib (`/// <reference lib="dom"/>` via `@xterm/xterm`), which
 * would join the whole daemon program and shadow Bun's `WebSocket` (`terminate`, the `headers` option) in unrelated files.
 */
export interface ITerminalOptions {
	cols?: number;
	rows?: number;
	scrollback?: number;
	allowProposedApi?: boolean;
}

export interface IBufferLine {
	translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface IBuffer {
	readonly type: "normal" | "alternate";
	readonly length: number;
	readonly cursorX: number;
	readonly cursorY: number;
	readonly baseY: number;
	getLine(y: number): IBufferLine | undefined;
}

export interface ITerminalAddon {
	activate(terminal: Terminal): void;
	dispose(): void;
}

export class Terminal {
	constructor(options?: ITerminalOptions);
	readonly cols: number;
	readonly rows: number;
	readonly buffer: { readonly active: IBuffer; readonly normal: IBuffer; readonly alternate: IBuffer };
	readonly modes: {
		readonly applicationCursorKeysMode: boolean;
		readonly bracketedPasteMode: boolean;
		readonly mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any";
		readonly sendFocusMode: boolean;
		readonly originMode: boolean;
		readonly wraparoundMode: boolean;
	};
	readonly unicode: { activeVersion: string };
	write(data: string | Uint8Array, callback?: () => void): void;
	resize(columns: number, rows: number): void;
	reset(): void;
	loadAddon(addon: ITerminalAddon): void;
	onTitleChange(listener: (title: string) => void): { dispose(): void };
	dispose(): void;
}
