/**
 * Runs in a child process whose environment the test controls (as a daemon's would be): starts one real shell through
 * `PtyTerminal`, asks it for its environment and prints it as JSON. Exercises the real `env -u` scrubbing.
 */
import { PtyTerminal, nativePty, shellKindOf, shellName } from "../../src/pty-host";

const [shell, cwd] = process.argv.slice(2);
const terminal = await PtyTerminal.spawn({
	id: "t_probe",
	factory: nativePty,
	shell: shell!,
	cwd: cwd!,
	cols: 100,
	rows: 30,
	ringChars: 1 << 20,
	scrollbackLines: 100,
	name: shellName(shell!),
	env: Bun.env,
	now: Date.now,
});
const win = process.platform === "win32";
// ConPTY re-draws the screen with cursor movements instead of plain line breaks: compare the text without escape sequences.
// (`^V` keeps the echoed command line from containing the marker the output is waited for by.)
// oxlint-disable-next-line no-control-regex -- matching ESC/BEL is the point
const plain = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");
const ringText = (): string => terminal.ring.slice(terminal.ring.start, Number.MAX_SAFE_INTEGER);
const kind = shellKindOf(shell!);
await Bun.sleep(kind === "powershell" ? 3000 : win ? 1500 : 300);
terminal.write(
	kind === "cmd"
		? "echo BEGIN-EN^V& set& echo FINISH-EN^V& exit 0\r"
		: kind === "powershell"
			? "'BEGIN-EN'+'V'; Get-ChildItem Env: | ForEach-Object { $_.Name + '=' + $_.Value }; 'FINISH-EN'+'V'; exit 0\r"
			: "printf 'BEGIN-%s\\n' ENV; env; printf 'FINISH-%s\\n' ENV; exit 0\r",
);
for (let i = 0; i < 1000 && !plain(ringText()).includes(win ? "FINISH-ENV" : "FINISH-ENV\r\n"); i++)
	await Bun.sleep(10);
await terminal.kill().catch(() => {});
const text = plain(ringText());
const body = text.slice(text.indexOf("BEGIN-ENV") + "BEGIN-ENV".length, text.indexOf("FINISH-ENV"));
const env: Record<string, string> = {};
for (const line of body.split(/\r?\n/)) {
	const eq = line.indexOf("=");
	if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
}
console.log(JSON.stringify({ env, pid: terminal.info.pid }));
process.exit(0);
