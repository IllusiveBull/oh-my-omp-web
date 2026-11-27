import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Whether this machine lets the tests create symbolic links to *files*. POSIX always; Windows only with Developer Mode
 * or an elevated shell (`SeCreateSymbolicLinkPrivilege`). Directory links do not need it: a junction is made instead.
 */
export const FILE_SYMLINKS: boolean = (() => {
	if (process.platform !== "win32") return true;
	const dir = mkdtempSync(join(tmpdir(), "ompweb-symprobe-"));
	try {
		writeFileSync(join(dir, "t"), "");
		symlinkSync("t", join(dir, "l"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
})();

/**
 * `ln -s target at`. Where a real symlink cannot be made (Windows without the privilege) a link to a directory becomes a
 * junction (a reparse point that `lstat`, `readlink` and `realpath` treat as a link; its target is always an absolute
 * path), so the escape checks are exercised without Developer Mode.
 * A link to a file (or to something that does not exist) needs the symlink privilege: callers gate on {@link FILE_SYMLINKS}.
 */
export function makeLink(target: string, at: string): void {
	try {
		symlinkSync(target, at);
	} catch (error) {
		if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
		const absolute = resolve(dirname(at), target);
		if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) throw error;
		symlinkSync(absolute, at, "junction");
	}
}
