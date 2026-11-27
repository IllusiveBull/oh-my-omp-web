import { chmodSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** `C:\x\y` as `C:/x/y`: backslashes are escapes inside a shell script, forward slashes work for every Windows API. */
export const posixPath = (path: string): string => path.replaceAll("\\", "/");

let gitSh: string | undefined;
/** Git for Windows' `sh.exe` (git is a hard requirement of the daemon, so the tests may rely on its shell). */
function windowsSh(): string {
	if (gitSh !== undefined) return gitSh;
	const git = Bun.which("git");
	if (git === null) throw new Error("git is not on PATH: the Windows test launchers use Git for Windows' sh.exe");
	// <root>\cmd\git.exe  ->  <root>\bin\sh.exe
	gitSh = resolve(dirname(git), "..", "bin", "sh.exe");
	return gitSh;
}

/**
 * Writes `script` (POSIX sh, no shebang) as an executable program and returns the path to run it by.
 * POSIX: `<path>` itself (`#!/bin/sh`, mode 755). Windows has neither shebangs nor mode bits, so the script goes to
 * `<path>.sh` and `<path>.cmd` starts it with Git for Windows' `sh.exe`; the returned path is the `.cmd` (the only
 * kind of script `Bun.spawn` can run). Scripts that name a Windows path must use {@link posixPath}.
 */
export function writeExecutable(path: string, script: string): string {
	if (process.platform !== "win32") {
		writeFileSync(path, `#!/bin/sh\n${script}\n`);
		chmodSync(path, 0o755);
		return path;
	}
	writeFileSync(`${path}.sh`, `${script}\n`);
	writeFileSync(`${path}.cmd`, `@"${windowsSh()}" "%~dp0${path.split(/[\\/]/).at(-1)}.sh" %*\r\n`);
	return `${path}.cmd`;
}
