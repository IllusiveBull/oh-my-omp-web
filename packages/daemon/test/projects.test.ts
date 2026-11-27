import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ProjectError, ProjectRegistry, expandHome, isInside, parseWorktrees } from "../src/projects";
import { git, makeRepo } from "./gateway-harness";
import { makeLink } from "./links";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ompweb-projects-")));
let repo: string;
let registryFile: string;
let n = 0;

beforeAll(async () => {
	repo = await makeRepo(scratch);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const open = async (): Promise<ProjectRegistry> => {
	registryFile = join(scratch, `projects-${++n}.json`);
	return ProjectRegistry.open(registryFile);
};

describe("registering projects", () => {
	test("identity is the first root commit; the root is the repository's top level even when a subdirectory is given", async () => {
		const registry = await open();
		const sub = join(repo, "pkg");
		mkdirSync(sub, { recursive: true });
		const project = await registry.add(sub);
		const rootCommit = (await git(repo, "rev-list", "--max-parents=0", "HEAD")).trim();
		expect(project).toMatchObject({ id: rootCommit, name: "repo", root: repo });
		expect(project.worktrees).toEqual([{ path: repo, branch: "main", main: true }]);
		// idempotent
		await registry.add(repo);
		expect(await registry.list()).toHaveLength(1);
	});

	test("with several root commits the smallest hash identifies the project, so every clone agrees", async () => {
		const dir = await makeRepo(scratch, "multi");
		await git(dir, "checkout", "-q", "--orphan", "other");
		await Bun.write(join(dir, "other.txt"), "x");
		await git(dir, "add", ".");
		await git(dir, "commit", "-q", "-m", "second root");
		await git(dir, "checkout", "-q", "main");
		await git(dir, "merge", "-q", "--allow-unrelated-histories", "-m", "merge", "other");
		const roots = (await git(dir, "rev-list", "--max-parents=0", "HEAD")).split("\n").filter(Boolean).toSorted();
		expect(roots).toHaveLength(2);
		expect((await (await open()).add(dir)).id).toBe(roots[0]!);
	});

	test("refuses relative paths, missing paths, non-repositories and repositories without commits, with a readable reason", async () => {
		const registry = await open();
		await expect(registry.add("relative/dir")).rejects.toThrow("absolute");
		await expect(registry.add(join(scratch, "nope"))).rejects.toThrow("no such directory");
		const plain = join(scratch, "plain");
		mkdirSync(plain);
		await expect(registry.add(plain)).rejects.toThrow("not inside a git working tree");
		const empty = join(scratch, "empty");
		mkdirSync(empty);
		await git(empty, "init", "-q");
		await expect(registry.add(empty)).rejects.toThrow("no commits");
		await expect(registry.add(plain)).rejects.toBeInstanceOf(ProjectError);
		expect(await registry.list()).toEqual([]);
	});

	test("a path under ~ is the same directory under the home directory; ~user and ~ elsewhere are left alone", () => {
		const home = join(scratch, "home");
		expect(expandHome("~", home)).toBe(home);
		expect(expandHome("~/code/app", home)).toBe(join(home, "code", "app"));
		expect(expandHome("~bob/app", home)).toBe("~bob/app");
		expect(expandHome("/a/~/b", home)).toBe("/a/~/b");
	});

	test("the registry survives a restart, and removing a project forgets it", async () => {
		const registry = await open();
		await registry.add(repo);
		const reopened = await ProjectRegistry.open(registryFile);
		expect((await reopened.list()).map(p => p.root)).toEqual([repo]);
		await reopened.remove(repo);
		expect(await (await ProjectRegistry.open(registryFile)).list()).toEqual([]);
		await expect(reopened.remove(repo)).rejects.toThrow("not a registered project");
	});

	test("listeners hear about additions and removals", async () => {
		const registry = await open();
		let changes = 0;
		const off = registry.onChange(() => changes++);
		await registry.add(repo);
		await registry.add(repo); // no change
		await registry.remove(repo);
		off();
		await registry.add(repo);
		expect(changes).toBe(2);
	});
});

describe("worktrees", () => {
	test("git worktree list is discovered, including worktrees outside the root, and a new one counts immediately", async () => {
		const dir = await makeRepo(scratch, "wt-main");
		const registry = await open();
		await registry.add(dir);
		const outside = join(scratch, "wt-feature");
		await git(dir, "worktree", "add", "-q", "-b", "feature", outside);
		const [project] = await registry.list();
		expect(project!.worktrees).toEqual([
			{ path: dir, branch: "main", main: true },
			{ path: realpathSync(outside), branch: "feature", main: false },
		]);
		expect(await registry.resolveCwd(outside)).toBe(realpathSync(outside));
		expect(await registry.attribute(join(outside))).toEqual({
			projectRoot: dir,
			worktreeRoot: realpathSync(outside),
		});
		expect(
			parseWorktrees(
				"worktree /a\nHEAD x\nbranch refs/heads/main\n\nworktree /b\nHEAD y\ndetached\n\nworktree /c\nbare\n\nworktree /d\nHEAD z\nprunable gone\n",
			),
		).toEqual([
			{ path: "/a", branch: "main", main: true },
			{ path: "/b", branch: null, main: false },
		]);
	});
});

describe("where omp may run", () => {
	test("inside a registered root (and its subdirectories) yes; outside no; a registered root nested name prefix is not inside", async () => {
		const registry = await open();
		await registry.add(repo);
		const sub = join(repo, "deep", "er");
		mkdirSync(sub, { recursive: true });
		expect(await registry.resolveCwd(repo)).toBe(repo);
		expect(await registry.resolveCwd(sub)).toBe(sub);
		const sibling = `${repo}-sibling`; // shares a string prefix with the root, is not inside it
		mkdirSync(sibling);
		await expect(registry.resolveCwd(sibling)).rejects.toThrow("not inside a registered project");
		await expect(registry.resolveCwd(scratch)).rejects.toThrow("not inside a registered project");
		await expect(registry.resolveCwd(join(repo, "missing"))).rejects.toThrow("cwd does not exist");
		const at = (path: string): string => resolve(path); // "/a/b" is "C:\\a\\b" on Windows
		expect(isInside(at("/a/b"), at("/a/b/c"))).toBe(true);
		expect(isInside(at("/a/b"), at("/a/bc"))).toBe(false);
		expect(isInside(at("/"), at("/anything"))).toBe(true);
		if (process.platform === "win32") {
			expect(isInside("C:\\Work\\Repo", "c:\\work\\repo\\Sub")).toBe(true); // NTFS paths compare case-insensitively
			expect(isInside("C:\\Work\\Repo", "D:\\Work\\Repo\\Sub")).toBe(false);
		}
	});

	test("a symlink inside the project that points outside is refused; one pointing inside resolves to its target", async () => {
		const registry = await open();
		await registry.add(repo);
		const outside = join(scratch, "secrets");
		mkdirSync(outside);
		const escape = join(repo, "escape");
		makeLink(outside, escape);
		await expect(registry.resolveCwd(escape)).rejects.toThrow("not inside a registered project");
		// `..` after a link walks up from the link's target, not lexically back into the project
		if (process.platform === "win32") {
			// Windows collapses `..` in the path text before it reaches the file system: `link\\..` is the link's lexical parent.
			expect(await registry.resolveCwd(`${escape}\\..`)).toBe(repo);
		} else {
			await expect(registry.resolveCwd(`${escape}/..`)).rejects.toThrow("not inside a registered project");
		}
		const inner = join(repo, "inner");
		mkdirSync(inner);
		const alias = join(repo, "alias");
		makeLink(inner, alias);
		expect(await registry.resolveCwd(alias)).toBe(inner);
		// and the other direction: a link from outside into the project is fine, and is resolved
		const door = join(scratch, "door");
		makeLink(repo, door);
		expect(await registry.resolveCwd(door)).toBe(repo);
	});

	test("attribution finds the project and worktree of a directory, or none", async () => {
		const registry = await open();
		await registry.add(repo);
		expect(await registry.attribute(join(repo, "deep"))).toEqual({ projectRoot: repo, worktreeRoot: repo });
		expect(await registry.attribute(scratch)).toBeNull();
		expect(await registry.attribute(join(scratch, "does-not-exist"))).toBeNull();
	});

	test("a project whose directory vanished stays listed (so it can be removed) and allows nothing", async () => {
		const gone = await makeRepo(scratch, "gone");
		const registry = await open();
		await registry.add(gone);
		rmSync(gone, { recursive: true });
		const [project] = await registry.list();
		expect(project).toMatchObject({ root: gone, worktrees: [] });
		await expect(registry.resolveCwd(gone)).rejects.toThrow("cwd does not exist");
		await registry.remove(gone);
		expect(dirname(gone)).toContain("ompweb-projects-");
	});
});

describe("the file browser's scope (worktree roots, not directories inside them)", () => {
	test("a registered root or one of its worktrees is accepted (canonical); a subdirectory, a sibling, a stranger and a relative path are not", async () => {
		const dir = await makeRepo(scratch, "scope-main");
		const registry = await open();
		await registry.add(dir);
		const feature = join(scratch, "scope-feature");
		await git(dir, "worktree", "add", "-q", "-b", "scope-feature", feature);
		expect(await registry.resolveWorktreeRoot(dir)).toBe(dir);
		// a worktree created after the last scan is found by rescanning once
		expect(await registry.resolveWorktreeRoot(feature)).toBe(realpathSync(feature));
		const door = join(scratch, "scope-door");
		makeLink(dir, door);
		expect(await registry.resolveWorktreeRoot(door)).toBe(dir); // named through a link: canonicalized
		const sub = join(dir, "sub");
		mkdirSync(sub);
		await expect(registry.resolveWorktreeRoot(sub)).rejects.toThrow("not a registered project root or worktree");
		await expect(registry.resolveWorktreeRoot(scratch)).rejects.toThrow("not a registered project root or worktree");
		await expect(registry.resolveWorktreeRoot(`${dir}-sibling`)).rejects.toThrow("no such directory");
		await expect(registry.resolveWorktreeRoot("relative/path")).rejects.toThrow("absolute");
		await expect(registry.resolveWorktreeRoot(dir)).resolves.toBe(dir);
		// removing the project withdraws the scope immediately
		await registry.remove(dir);
		await expect(registry.resolveWorktreeRoot(dir)).rejects.toThrow("not a registered project root or worktree");
	});
});
