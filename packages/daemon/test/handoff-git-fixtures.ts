import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GitContext } from "../src/handoff-git";

/** An isolated area for one test: temp repositories, a `HOME` without any git configuration, and the git seam for the code under test. */
export interface World {
	/** Canonical (`realpath`) directory every repository of the test lives in. */
	dir: string;
	/** `HOME`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`: no identity, no user configuration. */
	env: Record<string, string>;
	ctx: GitContext;
	/** Plain git (with an identity for the commits a test makes by hand); returns stdout. */
	git(cwd: string, ...args: string[]): Promise<string>;
	/** Plain git with extra environment (for `GIT_SEQUENCE_EDITOR` and the like); returns exit code and both streams. */
	gitRun(
		cwd: string,
		env: Record<string, string>,
		...args: string[]
	): Promise<{ code: number; out: string; err: string }>;
	/** Creates `<dir>/<name>` as a repository on branch `main` with an initial commit of `files`. */
	repo(name: string, files?: Record<string, string | Uint8Array>): Promise<string>;
	dispose(): void;
}

export function world(): World {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ompweb-handoff-git-")));
	const home = join(dir, "home");
	mkdirSync(home);
	const env = {
		HOME: home,
		USERPROFILE: home,
		APPDATA: home,
		LOCALAPPDATA: home,
		PI_CODING_AGENT_DIR: join(home, "agent"),
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const base: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.toUpperCase().startsWith("GIT_")) base[key] = value;
	}
	const gitRun: World["gitRun"] = async (cwd, extra, ...args) => {
		const proc = Bun.spawn(
			[
				"git",
				"-C",
				cwd,
				"-c",
				"user.name=Test User",
				"-c",
				"user.email=test@example.com",
				"-c",
				"protocol.file.allow=always",
				...args,
			],
			{
				env: { ...base, ...env, GIT_OPTIONAL_LOCKS: "0", ...extra },
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			},
		);
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, out, err };
	};
	const git: World["git"] = async (cwd, ...args) => {
		const result = await gitRun(cwd, {}, ...args);
		if (result.code !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${result.err}`);
		return result.out;
	};
	return {
		dir,
		env,
		ctx: { env },
		git,
		gitRun,
		async repo(name, files = { "README.md": "hello\n" }) {
			const root = join(dir, name);
			mkdirSync(root, { recursive: true });
			await git(root, "init", "-q", "-b", "main");
			put(root, files);
			await git(root, "add", "-A");
			await git(root, "commit", "-q", "-m", "initial");
			return root;
		},
		dispose: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** Writes files (parents created). */
export function put(root: string, files: Record<string, string | Uint8Array>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Every regular file and symlink under `root` (except top-level `.git` and what `skip` names): path, executable bit, bytes or link text. Empty directories do not count. */
export function treeHash(root: string, skip: (relative: string) => boolean = () => false): string {
	const hash = createHash("sha256");
	const walk = (relative: string): void => {
		const names = readdirSync(join(root, relative)).sort();
		for (const name of names) {
			const path = relative === "" ? name : `${relative}/${name}`;
			if (path === ".git" || skip(path)) continue;
			const stat = lstatSync(join(root, path));
			if (stat.isSymbolicLink()) hash.update(`L ${path} ${readlinkSync(join(root, path))}\n`);
			else if (stat.isDirectory()) walk(path);
			else if (stat.isFile()) {
				hash.update(`F ${path} ${stat.mode & 0o111 ? "x" : "-"} ${sha256(readFileSync(join(root, path)))}\n`);
			} else hash.update(`O ${path}\n`);
		}
	};
	walk("");
	return hash.digest("hex");
}

/** Everything that must not change when the source is handed off. */
export interface Snapshot {
	status: string;
	index: string;
	indexMtimeMs: number;
	head: string;
	refs: string;
	stash: string;
	tree: string;
}

export async function snapshot(w: World, root: string, skip?: (relative: string) => boolean): Promise<Snapshot> {
	const indexPath = join(root, ".git", "index");
	// The index first: nothing below may be the thing that changes it.
	const index = sha256(readFileSync(indexPath));
	const indexMtimeMs = statSync(indexPath).mtimeMs;
	return {
		status: await w.git(root, "status", "--porcelain=v2", "-z"),
		index,
		indexMtimeMs,
		head: await w.git(root, "rev-parse", "HEAD"),
		refs: await w.git(
			root,
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			"refs/heads",
			"refs/tags",
			"refs/stash",
		),
		stash: await w.git(root, "stash", "list"),
		tree: treeHash(root, skip),
	};
}

/** The index file's mtime moved into the past, so that any rewrite of it shows. */
export function ageIndex(root: string): void {
	const past = new Date(Date.now() - 3_600_000);
	utimesSync(join(root, ".git", "index"), past, past);
}

/** The entries of `git status --porcelain=v2` reduced to what a handoff must preserve: XY, path, origin (no object ids). */
export async function statusEntries(w: World, root: string): Promise<string[]> {
	const out = await w.git(root, "status", "--porcelain=v2", "-z", "--untracked-files=all");
	const records = out.split("\0");
	const entries: string[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (record === "") continue;
		const kind = record[0];
		if (kind === "?") entries.push(record);
		else if (kind === "1") entries.push(`1 ${record.split(" ")[1]} ${record.split(" ").slice(8).join(" ")}`);
		else if (kind === "2")
			entries.push(`2 ${record.split(" ")[1]} ${record.split(" ").slice(9).join(" ")} <- ${records[++i]}`);
		else entries.push(record);
	}
	return entries.sort();
}

/** `ls-tree -r` of a commit as `mode oid path` lines. */
export async function treeLines(w: World, root: string, commit: string): Promise<string[]> {
	const out = await w.git(root, "ls-tree", "-r", "-z", commit);
	return out
		.split("\0")
		.filter(entry => entry !== "")
		.map(entry => {
			const tab = entry.indexOf("\t");
			const [mode, , oid] = entry.slice(0, tab).split(" ");
			return `${mode} ${oid} ${entry.slice(tab + 1)}`;
		})
		.sort();
}

/** The repository used by most tests: every class of change at once, a stash, ignored files. Returns what the ignore rules hide. */
export interface Dirty {
	root: string;
	/** Paths (and directories) the repository ignores: never carried. */
	ignored: (relative: string) => boolean;
}

export const LARGE = Buffer.from(
	Array.from({ length: 4000 }, (_, i) => `line ${i} of a file that is long enough to be a rename\n`).join(""),
);

export async function dirtyRepo(w: World, name = "dirty"): Promise<Dirty> {
	const root = await w.repo(name, {
		".gitignore": "*.log\nbuild/\n",
		"a.txt": "one\n",
		"b.txt": "bee\n",
		"staged-mod.txt": "before\n",
		"rename-me.txt": LARGE,
		"exec.sh": "#!/bin/sh\necho hi\n",
		"mode.txt": "mode\n",
		"del.txt": "gone\n",
		"del2.txt": "gone too\n",
		"dir/inner.txt": "inner\n",
		"tc.txt": "regular\n",
		"stashed.txt": "base\n",
	});
	if (process.platform === "win32") {
		await w.git(root, "config", "core.symlinks", "false");
		await w.git(root, "config", "core.filemode", "false");
		await w.git(root, "update-index", "--chmod=+x", "exec.sh");
		writeFileSync(join(root, "link"), "a.txt");
		const oid = (await w.git(root, "hash-object", "-w", "link")).trim();
		await w.git(root, "update-index", "--add", "--cacheinfo", `120000,${oid},link`);
	} else {
		chmodSync(join(root, "exec.sh"), 0o755);
		await w.git(root, "add", "exec.sh");
		symlinkSync("a.txt", join(root, "link"));
		await w.git(root, "add", "link");
	}
	await w.git(root, "commit", "-q", "-m", "more");
	// a stash that must survive
	writeFileSync(join(root, "stashed.txt"), "stashed change\n");
	await w.git(root, "stash", "push", "-q");

	// ---- the mess
	writeFileSync(join(root, "a.txt"), "one, edited in the working tree\n"); // unstaged modification
	writeFileSync(join(root, "staged-mod.txt"), "after\n"); // staged modification
	await w.git(root, "add", "staged-mod.txt");
	writeFileSync(join(root, "b.txt"), "bee, staged\n"); // staged, then modified again
	await w.git(root, "add", "b.txt");
	writeFileSync(join(root, "b.txt"), "bee, staged and edited again\n");
	await w.git(root, "mv", "rename-me.txt", "renamed.txt"); // staged rename
	rmSync(join(root, "del.txt")); // unstaged deletion
	await w.git(root, "rm", "-q", "del2.txt"); // staged deletion
	if (process.platform === "win32") {
		await w.git(root, "update-index", "--chmod=+x", "mode.txt");
		writeFileSync(join(root, "link"), "b.txt");
		writeFileSync(join(root, "tc.txt"), "a.txt");
		const oid = (await w.git(root, "hash-object", "-w", "tc.txt")).trim();
		await w.git(root, "update-index", "--cacheinfo", `120000,${oid},tc.txt`);
	} else {
		chmodSync(join(root, "mode.txt"), 0o755);
		rmSync(join(root, "link"));
		symlinkSync("b.txt", join(root, "link"));
		rmSync(join(root, "tc.txt"));
		symlinkSync("a.txt", join(root, "tc.txt"));
	}
	writeFileSync(join(root, "staged-add.txt"), "new and staged\n");
	await w.git(root, "add", "staged-add.txt");
	// untracked: text, binary with CRLF and NUL, executable, symlinks (one dangling), in a new directory
	put(root, {
		"new.txt": "untracked\n",
		"crlf.txt": "windows\r\nline endings\r\n",
		"bin/blob.bin": Buffer.from([0, 1, 2, 13, 10, 255, 254, 0]),
		"bin/run.sh": "#!/bin/sh\n",
		[process.platform === "win32" ? "space dir/odd name.txt" : 'space dir/odd name "quoted".txt']: "odd\n",
	});
	chmodSync(join(root, "bin/run.sh"), 0o755);
	if (process.platform === "win32") {
		writeFileSync(join(root, "dangling"), "../outside-the-repo");
		writeFileSync(join(root, "bin/newlink"), "new.txt");
	} else {
		symlinkSync("../outside-the-repo", join(root, "dangling"));
		symlinkSync("new.txt", join(root, "bin/newlink"));
	}
	// ignored: never carried
	put(root, { "debug.log": "log\n", "build/out.bin": "out\n" });
	await w.git(root, "config", "core.autocrlf", "input"); // a CRLF-to-LF clean filter must not touch the carried bytes (checkout stays as it was)
	return {
		root,
		ignored: relative => relative === "debug.log" || relative === "build" || relative.startsWith("build/"),
	};
}
