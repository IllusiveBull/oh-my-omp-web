import type { Terminal } from "@xterm/xterm";
import { type TerminalClient, type TerminalTransport, terminalsOf } from "../../store/terminal-client";
import { terminalXterm } from "./terminal-screen";

/** What the browser smoke reads through `window.__ompTerminals` (only with `?debug` in the page URL). */
export interface TerminalsDebug {
	client: TerminalClient;
	/** The xterm showing a terminal, if one is mounted. */
	xterm(id: string): Terminal | undefined;
}

export function exposeTerminals(transport: TerminalTransport): void {
	const debug: TerminalsDebug = { client: terminalsOf(transport), xterm: terminalXterm };
	Object.assign(window, { __ompTerminals: debug });
}
