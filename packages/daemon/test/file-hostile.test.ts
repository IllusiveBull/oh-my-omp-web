/**
 * A repository's own configuration must not make the daemon execute anything. Each case plants a program that touches a
 * marker file in one of the places git runs programs from (`core.fsmonitor`, `diff.external`, a per-attribute diff driver,
 * textconv, a clean/smudge filter, a hooks directory), first proves with plain `git` that the planted program
 * really runs (so the case is a real attack, not a typo), then runs every file-browser operation and asserts the marker
 * stayed absent while the results were still produced.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTrustedFilterValue } from "../src/git-run";
import { FileService } from "../src/file-service";
import { commitAll, scratch, type Scratch } from "./file-fixtures";
import { posixPath } from "./fake-bin";
import { git } from "./gateway-harness";

let s: Scratch;
beforeAll(async () => {
	s = await scratch();
});
afterAll(() => s.dispose());

/**
 * An executable shell program that touches `marker` and then does `rest`. Git runs a configured program through the
 * shell (Git for Windows: its bundled sh.exe, which honours the shebang), so on Windows both paths are written with
 * forward slashes: a backslash path inside a config value or a single-quoted shell word is mangled.
 */
function program(name: string, marker: string, rest = ""): string {
	const path = posixPath(join(s.dir, name));
	writeFileSync(path, `#!/bin/sh\ntouch '${posixPath(marker)}'\n${rest}\n`, { mode: 0o755 });
	return path;
}

/** The unprotected git a careless daemon would run. */
function plain(root: string, ...args: string[]): void {
	Bun.spawnSync(["git", "-C", root, ...args], {
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
}

interface Vector {
	name: string;
	/** Writes the hostile configuration into the repository and returns the marker the planted program touches. */
	plant(root: string): Promise<string>;
	/** What plain git does that runs the program (proving the vector works at all). */
	control: string[][];
}

const config = (root: string, key: string, value: string): Promise<string> => git(root, "config", key, value);

const vectors: Vector[] = [
	{
		name: "core.fsmonitor",
		plant: async root => {
			const marker = join(root, "..", "m-fsmonitor");
			await config(root, "core.fsmonitor", program("fsmonitor.sh", marker, "printf '\\0'"));
			return marker;
		},
		control: [["status"]],
	},
	{
		name: "diff.external",
		plant: async root => {
			const marker = join(root, "..", "m-external");
			await config(root, "diff.external", program("external.sh", marker));
			return marker;
		},
		control: [["diff"]],
	},
	{
		name: "a diff driver's command (diff.<driver>.command, chosen by .gitattributes)",
		plant: async root => {
			const marker = join(root, "..", "m-command");
			writeFileSync(join(root, ".gitattributes"), "*.txt diff=evil\n");
			await config(root, "diff.evil.command", program("command.sh", marker));
			return marker;
		},
		control: [["diff"]],
	},
	{
		name: "textconv (diff.<driver>.textconv)",
		plant: async root => {
			const marker = join(root, "..", "m-textconv");
			writeFileSync(join(root, ".gitattributes"), "*.txt diff=evil\n");
			await config(root, "diff.evil.textconv", program("textconv.sh", marker, 'cat "$1"'));
			return marker;
		},
		control: [["diff"]],
	},
	{
		name: "a clean filter (filter.<name>.clean, chosen by .gitattributes)",
		plant: async root => {
			const marker = join(root, "..", "m-clean");
			writeFileSync(join(root, ".gitattributes"), "*.txt filter=evil\n");
			await config(root, "filter.evil.clean", program("clean.sh", marker, "cat"));
			await config(root, "filter.evil.smudge", program("smudge.sh", `${marker}-smudge`, "cat"));
			return marker;
		},
		control: [["status"], ["diff"]],
	},
	{
		name: "a hooks directory (core.hooksPath)",
		plant: async root => {
			const marker = join(root, "..", "m-hook");
			const hooks = join(s.dir, "hooks");
			mkdirSync(hooks, { recursive: true });
			for (const hook of ["post-index-change", "pre-commit", "post-checkout", "reference-transaction"]) {
				writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
			}
			await config(root, "core.hooksPath", hooks);
			return marker;
		},
		control: [["status"], ["add", "-A"]],
	},
];

describe("hostile repository configuration", () => {
	for (const vector of vectors) {
		test(
			vector.name,
			async () => {
				const dir = join(s.dir, `hostile-${vectors.indexOf(vector)}`);
				mkdirSync(dir);
				const root = join(dir, "repo");
				mkdirSync(root);
				await git(root, "init", "-q", "-b", "main");
				await commitAll(root, { "a.txt": "AAAA\n", "b.txt": "same length one\n", "keep.dat": "data\n" });
				const marker = await vector.plant(root);
				const service = new FileService({ resolveRoot: async path => path });
				// same-length edits: git has to look at the content (through the filters) to see that they changed
				writeFileSync(join(root, "a.txt"), "BBBB\n");
				writeFileSync(join(root, "b.txt"), "same length two\n");
				writeFileSync(join(root, "new.txt"), "untracked\n");

				// 1. the attack is real: plain git runs the planted program
				rmSync(marker, { force: true });
				for (const args of vector.control) plain(root, ...args);
				const works = existsSync(marker);
				// `git add -A` of the control may have changed the index; restore the dirty state for the real run
				await git(root, "reset", "-q");
				rmSync(marker, { force: true });
				rmSync(`${marker}-smudge`, { force: true });
				writeFileSync(join(root, "a.txt"), "BBBB\n");
				writeFileSync(join(root, "b.txt"), "same length two\n");

				// 2. nothing the file browser does runs it
				const status = await service.status(root);
				const unstaged = await service.diff(root, "a.txt", "unstaged");
				const head = await service.diff(root, "b.txt", "head");
				const staged = await service.diff(root, "a.txt", "staged");
				await service.list(root, "", false);
				await service.read(root, "a.txt", 1, 10);
				await service.diff(root, "new.txt", "untracked");
				expect(existsSync(marker)).toBe(false);
				expect(existsSync(`${marker}-smudge`)).toBe(false);

				// 3. and it still works
				expect(status.entries.map(e => e.path)).toEqual(expect.arrayContaining(["a.txt", "b.txt", "new.txt"]));
				expect(unstaged.diff).toContain("+BBBB");
				expect(unstaged.diff).toContain("-AAAA");
				expect(head.diff).toContain("+same length two");
				expect(staged.diff).toBe("");
				// A vector that did not run under plain git on this machine is reported rather than silently passing.
				expect({ vector: vector.name, runsUnderPlainGit: works }).toEqual({
					vector: vector.name,
					runsUnderPlainGit: true,
				});
			},
			20_000,
		);
	}

	test("core.worktree cannot point the file browser at another directory", async () => {
		const dir = join(s.dir, "redirect");
		mkdirSync(join(dir, "elsewhere"), { recursive: true });
		writeFileSync(join(dir, "elsewhere", "leak.txt"), "not in this worktree\n");
		const root = join(dir, "repo");
		mkdirSync(root);
		await git(root, "init", "-q", "-b", "main");
		await commitAll(root, { "a.txt": "a\n" });
		await config(root, "core.worktree", join(dir, "elsewhere"));
		const service = new FileService({ resolveRoot: async path => path });
		const status = await service.status(root);
		expect(status.entries.map(e => e.path)).not.toContain("leak.txt");
		expect(status.entries.map(e => e.path)).toEqual([]); // the registered worktree is clean
	});

	test("a submodule's own hostile configuration is not run by the git status of the parent (the overrides travel in the environment)", async () => {
		const dir = join(s.dir, "submodule");
		mkdirSync(dir);
		const sh = (cwd: string, ...args: string[]): void => {
			const done = Bun.spawnSync(
				["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args],
				{ cwd },
			);
			if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
		};
		const inner = join(dir, "inner");
		mkdirSync(inner);
		sh(inner, "init", "-q", "-b", "main");
		writeFileSync(join(inner, "f.txt"), "one\n");
		sh(inner, "add", ".");
		sh(inner, "commit", "-qm", "inner");
		const outer = join(dir, "outer");
		mkdirSync(outer);
		sh(outer, "init", "-q", "-b", "main");
		sh(outer, "submodule", "add", "-q", inner, "sub");
		sh(outer, "commit", "-qm", "outer");
		const marker = join(dir, "m-submodule");
		const hook = program("submodule-fsmonitor.sh", marker, "printf '\\0'");
		sh(join(outer, "sub"), "config", "core.fsmonitor", hook);
		writeFileSync(join(outer, "sub", "f.txt"), "two\n");
		plain(outer, "status");
		expect(existsSync(marker)).toBe(true); // the attack is real
		rmSync(marker, { force: true });
		const status = await new FileService({ resolveRoot: async path => path }).status(outer);
		expect(existsSync(marker)).toBe(false);
		expect(status.entries).toMatchObject([{ path: "sub", kind: "changed", y: "M" }]);
	});

	test("a hostile filter name cannot slip through an unusual spelling (= and . in the name)", async () => {
		const dir = join(s.dir, "odd");
		mkdirSync(dir);
		const root = join(dir, "repo");
		mkdirSync(root);
		await git(root, "init", "-q", "-b", "main");
		await commitAll(root, { "a.txt": "AAAA\n" });
		const marker = join(dir, "m-odd");
		writeFileSync(join(root, ".gitattributes"), "*.txt filter=a=b.c\n");
		await config(root, "filter.a=b.c.clean", program("odd.sh", marker, "cat"));
		writeFileSync(join(root, "a.txt"), "BBBB\n");
		const service = new FileService({ resolveRoot: async path => path });
		await service.status(root);
		await service.diff(root, "a.txt", "unstaged");
		expect(existsSync(marker)).toBe(false);
	});
});

describe("which filters are let through", () => {
	test("only git-lfs's own fixed command lines (and empty values)", () => {
		for (const ok of [
			"git-lfs clean -- %f",
			"git-lfs smudge -- %f",
			"git-lfs filter-process",
			"git-lfs smudge --skip -- %f",
			"",
		]) {
			expect(isTrustedFilterValue(ok)).toBe(true);
		}
		for (const bad of ["./evil.sh", "git-lfs clean -- %f; rm -rf ~", "sh -c 'touch x'", "git-lfs clean", "cat"]) {
			expect(isTrustedFilterValue(bad)).toBe(false);
		}
	});
});
