/**
 * Process trees on Windows. `omp.exe` there is a launcher (Bun's global-bin shim) whose child, `bun ... cli.js`, does the
 * work; a signal or a TerminateProcess aimed at the launcher leaves that child running. So
 * whatever the daemon starts and later has to stop is stopped as a tree, and an orphan left by a hard-killed daemon is
 * recognised by pid + creation time + command line before it is touched (a pid can be reused).
 */
import { Process } from "@oh-my-pi/pi-natives";

export interface ProcessInfo {
	/** Creation time, epoch ms. */
	startedAt: number;
	/** The full command line. */
	command: string;
}

/** Whether a process with this pid exists (signal 0 is "exists?" on every platform, `EPERM` meaning yes but not ours). */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

/** Every descendant of `pid` (children, grandchildren …) as upstream's native process handle sees them now; empty when `pid` is gone. */
export function descendantPids(pid: number): number[] {
	const out: number[] = [];
	const walk = (handle: Process): void => {
		for (const child of handle.children()) {
			out.push(child.pid);
			walk(child);
		}
	};
	try {
		const root = Process.fromPid(pid);
		if (root) walk(root);
	} catch {
		// gone, or not observable
	}
	return out;
}

/**
 * Ends `pid` and every descendant now (TerminateProcess, children first); there is no graceful tree stop on Windows. Uses
 * the native handle (it keeps the pid from being reused while held), `taskkill /T /F` if that is unavailable.
 */
export function killProcessTree(pid: number): void {
	try {
		const handle = Process.fromPid(pid);
		if (handle !== null) {
			handle.killTree();
			return;
		}
	} catch {
		// fall through to taskkill
	}
	try {
		Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
	} catch {
		// gone already
	}
}

/**
 * Creation time and command line of live processes by pid, from one PowerShell/CIM call (~400 ms, measured), keyed by pid;
 * a pid that is gone is absent. `{}` when PowerShell cannot answer.
 */
export async function inspectWindowsProcesses(pids: number[]): Promise<Map<number, ProcessInfo>> {
	const found = new Map<number, ProcessInfo>();
	const wanted = pids.filter(pid => Number.isInteger(pid) && pid > 0);
	if (wanted.length === 0) return found;
	const filter = wanted.map(pid => `ProcessId=${pid}`).join(" or ");
	const script =
		`Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { ` +
		`[string]$_.ProcessId + '|' + $_.CreationDate.ToUniversalTime().ToString('o') + '|' + $_.CommandLine }`;
	try {
		const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) return found;
		for (const line of out.split(/\r?\n/)) {
			const first = line.indexOf("|");
			const second = line.indexOf("|", first + 1);
			if (first < 0 || second < 0) continue;
			const startedAt = Date.parse(line.slice(first + 1, second));
			if (Number.isFinite(startedAt)) {
				found.set(Number(line.slice(0, first)), { startedAt, command: line.slice(second + 1).trim() });
			}
		}
	} catch {
		// PowerShell not runnable: the callers treat "unknown" as "not provably ours"
	}
	return found;
}
