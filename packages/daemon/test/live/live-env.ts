import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateOmp, type OmpBinary } from "../../src/omp-binary";

/** Temp project cwd + isolated session dir; removed by `cleanup`. */
export interface LiveSandbox {
	root: string;
	cwd: string;
	sessionDir: string;
	cleanup(): void;
}

export function makeSandbox(prefix: string): LiveSandbox {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	const cwd = join(root, "project");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd);
	mkdirSync(sessionDir);
	return {
		root,
		cwd,
		sessionDir,
		// Windows holds a directory (and the files omp keeps open in it) until the last process using it has really gone; omp
		// also has background workers that outlive a session by a few seconds. Retry, and on Windows give up quietly: leaving
		// a temp directory behind is not a test failure (nothing is asserted about it).
		cleanup: () => {
			try {
				rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 });
			} catch (error) {
				if (process.platform !== "win32") throw error;
				console.warn(
					`live sandbox ${root} not removed: ${(error as NodeJS.ErrnoException).code} (a file is still held by an omp process)`,
				);
			}
		},
	};
}

/** Locates the installed omp; throws (the live test fails, never skips) when it is missing or too old. */
export function requireOmp(): Promise<OmpBinary> {
	return locateOmp();
}

// omp (the installed, compiled binary) unpacks its native addon into <natives dir>/<version>/ and keeps it loaded while any
// of its processes lives; under a sandbox HOME that is a 130 MB file inside the directory the tests then delete, and on
// Windows a loaded .node cannot be deleted (EPERM). A natives directory outside every sandbox is shared by all live tests.
Bun.env.PI_NATIVES_DIR ??= join(tmpdir(), "omp-web-live-natives");
