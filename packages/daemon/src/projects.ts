import { mkdir, realpath, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type { ProjectInfo, WorktreeInfo } from "@omp-web/protocol";

/** `~` and `~/…` (also `~\…` on Windows) as paths under `home`; anything else unchanged. `~user` is not supported. */
export function expandHome(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/") || (sep === "\\" && path.startsWith("~\\"))) return join(home, path.slice(2));
	return path;
}

/** A refusal the user can act on (bad path, not a repository, outside every registered project). */
export class ProjectError extends Error {}

async function git(cwd: string, args: string[]): Promise<string> {
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(["git", "-C", cwd, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...Bun.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
		});
	} catch (error) {
		throw new ProjectError(`cannot run git: ${error instanceof Error ? error.message : String(error)}`);
	}
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new ProjectError(err.trim() || `git ${args[0]} exited with code ${code}`);
	return out;
}

/** Hash of the repository's first root commit; with several roots (merged histories) the smallest hash, so every clone agrees. */
async function rootCommit(root: string): Promise<string> {
	let out: string;
	try {
		out = await git(root, ["rev-list", "--max-parents=0", "HEAD"]);
	} catch {
		throw new ProjectError(
			"the repository has no commits yet; make one first (the project is identified by its first commit)",
		);
	}
	const roots = out.split("\n").filter(Boolean).toSorted();
	if (roots.length === 0) throw new ProjectError("the repository has no root commit");
	return roots[0]!;
}

/** `git worktree list --porcelain`, without bare and prunable (directory gone) entries. */
export function parseWorktrees(porcelain: string): WorktreeInfo[] {
	const worktrees: WorktreeInfo[] = [];
	for (const [index, block] of porcelain.split(/\n\s*\n/).entries()) {
		const lines = block.split("\n").filter(Boolean);
		const path = lines.find(l => l.startsWith("worktree "))?.slice("worktree ".length);
		if (!path || lines.includes("bare") || lines.some(l => l.startsWith("prunable"))) continue;
		const branch = lines.find(l => l.startsWith("branch "))?.slice("branch ".length);
		worktrees.push({ path, branch: branch ? branch.replace(/^refs\/heads\//, "") : null, main: index === 0 });
	}
	return worktrees;
}

const fold = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path);

/** `child` is `parent` or lies below it (canonical paths). */
export function isInside(parent: string, child: string): boolean {
	const [p, c] = [fold(parent), fold(child)];
	if (c === p) return true;
	return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

interface StoredProject {
	root: string;
	id: string;
	name: string;
}

interface Scanned {
	info: ProjectInfo;
	/** Canonical path of the root and of every worktree, same order as `info.worktrees`. */
	roots: string[];
}

/** Where a working directory sits among the registered projects. */
export interface Attribution {
	projectRoot: string;
	worktreeRoot: string;
}

/**
 * The project roots registered on this machine (persisted in `file`) and the single rule that decides where omp may run:
 * a directory is allowed only inside a registered project root or one of that project's git worktrees, after
 * resolving symlinks, so a link inside a project that points elsewhere does not escape it.
 */
export class ProjectRegistry {
	#stored: StoredProject[];
	#scan: Scanned[] | null = null;
	readonly #listeners = new Set<() => void>();

	private constructor(
		private readonly file: string,
		stored: StoredProject[],
	) {
		this.#stored = stored;
	}

	static async open(file: string): Promise<ProjectRegistry> {
		const existing = Bun.file(file);
		if (!(await existing.exists())) return new ProjectRegistry(file, []);
		let parsed: unknown;
		try {
			parsed = await existing.json();
		} catch {
			throw new ProjectError(`${file} is not valid JSON; fix or delete it`);
		}
		const list = (parsed as { projects?: unknown }).projects;
		if (!Array.isArray(list)) throw new ProjectError(`${file} has no "projects" array`);
		const stored = list.filter(
			(p): p is StoredProject =>
				typeof p === "object" &&
				p !== null &&
				typeof (p as StoredProject).root === "string" &&
				typeof (p as StoredProject).id === "string" &&
				typeof (p as StoredProject).name === "string",
		);
		return new ProjectRegistry(file, stored);
	}

	/** Fires after the set of registered projects changed. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Registered projects with a fresh `git worktree list`. */
	async list(): Promise<ProjectInfo[]> {
		this.#scan = await this.#scanAll();
		return this.#scan.map(s => s.info);
	}

	/**
	 * Looks at `git worktree list` again and tells the listeners: a worktree was created or removed behind the registry's
	 * back (an environment switch), so sessions in it must be attributed to its project and clients must see it.
	 */
	async rescan(): Promise<void> {
		this.#scan = await this.#scanAll();
		this.#notify();
	}

	/** Registers the repository containing `path` (an absolute directory, or one under `~`). Idempotent. */
	async add(input: string): Promise<ProjectInfo> {
		const path = expandHome(input.trim());
		if (!isAbsolute(path)) throw new ProjectError("the project path must be absolute (or start with ~)");
		const real = await realpath(path).catch(() => {
			throw new ProjectError(`no such directory: ${path}`);
		});
		if (!(await stat(real)).isDirectory()) throw new ProjectError(`not a directory: ${path}`);
		let top: string;
		try {
			top = (await git(real, ["rev-parse", "--show-toplevel"])).trim();
		} catch {
			throw new ProjectError(`${path} is not inside a git working tree`);
		}
		const root = await realpath(top);
		const existing = this.#stored.find(p => p.root === root);
		if (!existing) {
			this.#stored.push({ root, id: await rootCommit(root), name: basename(root) });
			await this.#save();
			this.#scan = null;
			this.#notify();
		}
		const project = (await this.list()).find(p => p.root === root);
		if (!project) throw new ProjectError(`${root} could not be listed after registering`);
		return project;
	}

	async remove(root: string): Promise<void> {
		const before = this.#stored.length;
		this.#stored = this.#stored.filter(p => p.root !== root);
		if (this.#stored.length === before) throw new ProjectError(`not a registered project: ${root}`);
		await this.#save();
		this.#scan = null;
		this.#notify();
	}

	/**
	 * The canonical form of `cwd` when it is a registered project root or lies inside one of its worktrees; throws a
	 * {@link ProjectError} otherwise. Looks at the worktrees as they are now, so a worktree created a second ago counts.
	 */
	async resolveCwd(cwd: string): Promise<string> {
		const real = await realpath(cwd).catch(() => {
			throw new ProjectError(`cwd does not exist: ${cwd}`);
		});
		const scan = await this.#scanAll();
		if (!scan.some(s => s.roots.some(root => isInside(root, real)))) {
			throw new ProjectError(
				`${cwd} is not inside a registered project root or worktree; register the project on this machine first`,
			);
		}
		return real;
	}

	/**
	 * The canonical form of `root` when it is exactly a registered project root or one of that project's worktrees (the
	 * scope of the file browser: not a directory inside one); throws a {@link ProjectError} otherwise. Uses the worktrees
	 * of the last scan and rescans once when `root` is not among them, so a polled file view costs no extra `git worktree list`.
	 */
	async resolveWorktreeRoot(root: string): Promise<string> {
		if (!isAbsolute(root)) throw new ProjectError("the worktree root must be an absolute path");
		const real = await realpath(root).catch(() => {
			throw new ProjectError(`no such directory: ${root}`);
		});
		const known = (scan: Scanned[]): boolean => scan.some(s => s.roots.some(r => fold(r) === fold(real)));
		if (this.#scan !== null && known(this.#scan)) return real;
		this.#scan = await this.#scanAll();
		if (!known(this.#scan)) {
			throw new ProjectError(
				`${root} is not a registered project root or worktree of this machine; register the project first`,
			);
		}
		return real;
	}

	/** Which registered project root / worktree contains `cwd`, using the worktrees of the last scan; null when none does. */
	async attribute(cwd: string): Promise<Attribution | null> {
		const real = await realpath(cwd).catch(() => null);
		if (real === null) return null;
		const scan = (this.#scan ??= await this.#scanAll());
		let best: (Attribution & { depth: number }) | null = null;
		for (const { info, roots } of scan) {
			for (const [index, root] of roots.entries()) {
				if (!isInside(root, real) || (best && root.length <= best.depth)) continue;
				// roots[0] is the project root itself; the rest are its worktrees.
				best = {
					projectRoot: info.root,
					worktreeRoot: index === 0 ? info.root : info.worktrees[index - 1]!.path,
					depth: root.length,
				};
			}
		}
		return best && { projectRoot: best.projectRoot, worktreeRoot: best.worktreeRoot };
	}

	async #scanAll(): Promise<Scanned[]> {
		return Promise.all(this.#stored.map(project => this.#scanOne(project)));
	}

	async #scanOne(project: StoredProject): Promise<Scanned> {
		let worktrees: WorktreeInfo[] = [];
		try {
			worktrees = parseWorktrees(await git(project.root, ["worktree", "list", "--porcelain"]));
		} catch {
			// The directory is gone or not a repository any more: keep the project listed (so it can be removed), without worktrees.
		}
		const present: WorktreeInfo[] = [];
		const reals: string[] = [project.root];
		for (const worktree of worktrees) {
			const real = await realpath(worktree.path).catch(() => null);
			if (real === null) continue;
			present.push({ ...worktree, path: real });
			reals.push(real);
		}
		return { info: { id: project.id, name: project.name, root: project.root, worktrees: present }, roots: reals };
	}

	async #save(): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		await Bun.write(tmp, `${JSON.stringify({ projects: this.#stored }, null, "\t")}\n`);
		await rename(tmp, this.file);
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}
