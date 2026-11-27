const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
// CSI sequences (colours, cursor moves), OSC sequences (titles, hyperlinks; BEL or ST terminated) and two-byte escapes.
const ANSI = new RegExp(
	`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
	"g",
);

/** Removes ANSI escape sequences. Extension widgets and status lines arrive pre-styled for a terminal; the web drops that styling. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}
