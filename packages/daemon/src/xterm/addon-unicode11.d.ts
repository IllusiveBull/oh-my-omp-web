import type { ITerminalAddon, Terminal } from "./headless";

export class Unicode11Addon implements ITerminalAddon {
	constructor();
	activate(terminal: Terminal): void;
	dispose(): void;
}
