import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileError } from "../src/file-path";
import { FileService } from "../src/file-service";
import type { PathHooks } from "../src/file-path";
import { git } from "./gateway-harness";
import { makeLink } from "./links";

/** A scratch area with one canonical root, a sibling `outside` directory with a secret, and a file service over the root. */
export interface Scratch {
	/** Parent of `root` and `outside`; removed by `dispose`. */
	dir: string;
	root: string;
	outside: string;
	service: FileService;
	/** Test seam of the service (see `PathHooks`). */
	hooks: PathHooks;
	dispose(): void;
}

export const SECRET = "TOP SECRET OUTSIDE THE WORKTREE\n";

export async function scratch(): Promise<Scratch> {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ompweb-files-")));
	const root = join(dir, "repo");
	const outside = join(dir, "outside");
	mkdirSync(root);
	mkdirSync(outside);
	await Bun.write(join(outside, "secret.txt"), SECRET);
	await git(root, "init", "-q", "-b", "main");
	const hooks: PathHooks = {};
	const service = new FileService({
		resolveRoot: async path => {
			if (path !== root) throw new FileError("not_registered", `${path} is not registered`);
			return root;
		},
		hooks,
	});
	return { dir, root, outside, service, hooks, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Writes files (parents created), stages everything and commits. */
export async function commitAll(
	root: string,
	files: Record<string, string | Uint8Array>,
	message = "snapshot",
): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		await Bun.write(join(root, path), content);
	}
	await git(root, "add", "-A");
	await git(root, "commit", "-q", "-m", message);
}

export { FILE_SYMLINKS } from "./links";
export const link = makeLink;

/** The error code a promise rejects with (or "ok"). */
export async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "ok";
	} catch (error) {
		return error instanceof FileError ? error.code : `other: ${String(error)}`;
	}
}
