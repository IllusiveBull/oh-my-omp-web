import type { ITerminalAddon, Terminal } from "./headless";

export class SerializeAddon implements ITerminalAddon {
	constructor();
	activate(terminal: Terminal): void;
	serialize(options?: { scrollback?: number; excludeModes?: boolean; excludeAltBuffer?: boolean }): string;
	dispose(): void;
}
