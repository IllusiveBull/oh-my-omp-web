import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileError, parseRelPath } from "../src/file-path";
import type { FileContent } from "@omp-web/protocol";
import { FILE_SYMLINKS, SECRET, codeOf, commitAll, link, scratch, type Scratch } from "./file-fixtures";

// Links to files need the symlink privilege on Windows (Developer Mode / elevation); links to directories are junctions
// there and always run. Tests and lines that need a file link are gated on this.
const F = FILE_SYMLINKS;

let s: Scratch;

beforeAll(async () => {
	s = await scratch();
	await commitAll(s.root, {
		"a.txt": "inside\n",
		"dir/f.txt": "in dir\n",
		"dir/sub/g.txt": "deeper\n",
	});
	link(s.outside, join(s.root, "to-outside"));
	link("dir", join(s.root, "to-dir"));
	if (F) {
		link(join(s.outside, "secret.txt"), join(s.root, "to-secret"));
		link("a.txt", join(s.root, "to-a"));
		link(".git/config", join(s.root, "to-git-config"));
		link("loop-b", join(s.root, "loop-a"));
		link("loop-a", join(s.root, "loop-b"));
		link("nowhere", join(s.root, "dangling"));
	}
	link("..", join(s.root, "to-parent"));
	link(s.root, join(s.root, "to-self"));
});
afterAll(() => s.dispose());

const read = (path: string): Promise<FileContent> => s.service.read(s.root, path, 1, 100);

describe("relative path syntax", () => {
	test("accepts plain relative paths and the root", () => {
		expect(parseRelPath("")).toEqual([]);
		expect(parseRelPath("a/b/c.txt")).toEqual(["a", "b", "c.txt"]);
		expect(parseRelPath("日本語/ファイル.md")).toEqual(["日本語", "ファイル.md"]);
		expect(parseRelPath(".github/workflows/x.yml")).toEqual([".github", "workflows", "x.yml"]);
		expect(parseRelPath("..foo/.../bar")).toEqual(["..foo", "...", "bar"]);
	});

	test.each([
		["absolute", "/etc/passwd"],
		["backslash root", "\\windows"],
		["drive letter", "C:\\x"],
		["parent", "../x"],
		["parent in the middle", "a/../b"],
		["trailing parent", "a/.."],
		["dot segment", "a/./b"],
		["empty segment", "a//b"],
		["trailing slash", "a/"],
		["NUL", "a\0b"],
		["too long", "x".repeat(5000)],
	])("refuses %s", (_name, path) => {
		expect(() => parseRelPath(path)).toThrow(FileError);
		try {
			parseRelPath(path);
		} catch (error) {
			expect((error as FileError).code).toBe("bad_path");
		}
	});

	test("git's own directory is forbidden wherever it appears", () => {
		for (const path of [".git", ".git/config", "sub/.git/x", "a/.git"]) {
			try {
				parseRelPath(path);
				throw new Error("not refused");
			} catch (error) {
				expect((error as FileError).code).toBe("forbidden");
			}
		}
	});
});

describe("containment", () => {
	test("files and directories inside the root are served", async () => {
		expect(await read("a.txt")).toMatchObject({ kind: "text", text: "inside\n" });
		expect(await read("dir/sub/g.txt")).toMatchObject({ kind: "text", text: "deeper\n" });
		expect(await read("dir")).toEqual({ kind: "dir", path: "dir" });
		expect((await s.service.list(s.root, "dir", false)).entries.map(e => e.name)).toEqual(["sub", "f.txt"]);
	});

	test("every escape the syntax check misses is caught by the symlink resolution", async () => {
		for (const path of [
			...(F ? ["to-secret"] : []),
			"to-outside/secret.txt",
			"to-parent/outside/secret.txt",
			"to-outside",
		]) {
			expect(await codeOf(s.service.read(s.root, path, 1, 10))).toBe("outside_root");
		}
		// whether something exists beyond a link that leaves the root is not revealed either
		expect(await codeOf(s.service.read(s.root, "to-outside/no-such-file", 1, 10))).toBe("outside_root");
		expect(await codeOf(s.service.read(s.root, "to-outside/no/such/deep/file", 1, 10))).toBe("outside_root");
		expect(await codeOf(s.service.read(s.root, "dir/no-such-file", 1, 10))).toBe("not_found");
		expect(await codeOf(s.service.list(s.root, "to-outside", false))).toBe("outside_root");
		expect(await codeOf(s.service.list(s.root, "to-parent", false))).toBe("outside_root");
		if (F) expect(await codeOf(s.service.bytes(s.root, "to-secret", 0, 10))).toBe("outside_root");
		expect(await codeOf(s.service.diff(s.root, "to-outside/secret.txt", "untracked"))).toBe("outside_root");
	});

	test("a request never returns the content that sits outside", async () => {
		for (const path of [...(F ? ["to-secret"] : []), "to-outside/secret.txt"]) {
			const result = await s.service.read(s.root, path, 1, 10).catch(e => e);
			expect(JSON.stringify(result)).not.toContain("SECRET");
		}
		expect(SECRET).toContain("SECRET");
	});

	test("a symlink that stays inside the root is followed (to a file and to a directory)", async () => {
		if (F) expect(await read("to-a")).toMatchObject({ kind: "text", text: "inside\n" });
		expect(await read("to-dir/f.txt")).toMatchObject({ kind: "text", text: "in dir\n" });
		expect(await read("to-self/a.txt")).toMatchObject({ kind: "text", text: "inside\n" }); // a link to the root itself
		expect((await s.service.list(s.root, "to-dir", false)).entries.map(e => e.name)).toContain("f.txt");
	});

	test("the listing shows links as entries with their target text and where they end up, and never follows them out", async () => {
		const { entries } = await s.service.list(s.root, "", false);
		const byName = Object.fromEntries(entries.map(e => [e.name, e]));
		if (F) {
			expect(byName["to-secret"]).toMatchObject({
				kind: "symlink",
				link: { target: join(s.outside, "secret.txt"), resolves: "outside" },
			});
			expect(byName["dangling"]).toMatchObject({ link: { target: "nowhere", resolves: "broken" } });
			expect(byName["loop-a"]).toMatchObject({ link: { resolves: "broken" } });
			expect(byName["to-git-config"]).toMatchObject({ link: { target: ".git/config", resolves: "outside" } });
		}
		expect(byName["to-outside"]).toMatchObject({ kind: "symlink", link: { resolves: "outside" } });
		expect(byName["to-dir"]).toMatchObject({
			kind: "symlink",
			link: { target: F ? "dir" : join(s.root, "dir"), resolves: "dir" },
		}); // a junction's target is absolute
		expect(byName["to-parent"]).toMatchObject({ link: { target: F ? ".." : s.dir, resolves: "outside" } });
	});

	test("git's directory is not listed, not read, and not reachable through a link", async () => {
		expect((await s.service.list(s.root, "", true)).entries.some(e => e.name === ".git")).toBe(false);
		expect(await codeOf(s.service.read(s.root, ".git/config", 1, 10))).toBe("forbidden");
		expect(await codeOf(s.service.list(s.root, ".git", false))).toBe("forbidden");
		if (F) expect(await codeOf(s.service.read(s.root, "to-git-config", 1, 10))).toBe("forbidden");
		expect(await codeOf(s.service.read(s.root, "dir/.git", 1, 10))).toBe("forbidden");
	});

	test.skipIf(!F)("symlink loops and dangling links are refused with a reason, not a crash or a hang", async () => {
		expect(await codeOf(s.service.read(s.root, "loop-a", 1, 10))).toBe("forbidden");
		expect(await codeOf(s.service.read(s.root, "dangling", 1, 10))).toBe("not_found");
		expect(await codeOf(s.service.read(s.root, "missing.txt", 1, 10))).toBe("not_found");
		expect(await codeOf(s.service.read(s.root, "a.txt/inner", 1, 10))).toBe("not_found");
	});

	test("syntax violations are refused before the filesystem is touched", async () => {
		for (const path of ["../outside/secret.txt", "/etc/passwd", "a\0b", "dir/../a.txt"]) {
			expect(await codeOf(s.service.read(s.root, path, 1, 10))).toBe("bad_path");
			expect(await codeOf(s.service.list(s.root, path, false))).toBe("bad_path");
		}
	});

	test("a prefix-sharing sibling is not inside the root", async () => {
		const sibling = `${s.root}-sibling`;
		mkdirSync(sibling);
		writeFileSync(join(sibling, "x.txt"), "sibling\n");
		try {
			link(sibling, join(s.root, "to-sibling"));
			expect(await codeOf(s.service.read(s.root, "to-sibling/x.txt", 1, 10))).toBe("outside_root");
		} finally {
			rmSync(join(s.root, "to-sibling"), { force: true });
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	test("an unregistered root is refused", async () => {
		expect(await codeOf(s.service.handle({ t: "files.list", reqId: "1", root: s.outside, path: "" }))).toBe(
			"not_registered",
		);
	});
});

describe("special files", () => {
	test("a named pipe is never opened (it would block forever); it is listed as other", async () => {
		const fifo = join(s.root, "pipe");
		const made = Bun.spawnSync(["mkfifo", fifo]);
		if (process.platform === "win32" || made.exitCode !== 0) return; // Windows: Git's mkfifo makes an MSYS emulation file, not a pipe
		try {
			expect(await codeOf(s.service.read(s.root, "pipe", 1, 10))).toBe("forbidden");
			expect(await codeOf(s.service.bytes(s.root, "pipe", 0, 10))).toBe("forbidden");
			expect(await codeOf(s.service.diff(s.root, "pipe", "untracked"))).toBe("forbidden");
			expect((await s.service.list(s.root, "", false)).entries.find(e => e.name === "pipe")).toMatchObject({
				kind: "other",
			});
		} finally {
			rmSync(fifo, { force: true });
		}
	});

	test("a unix socket is refused", async () => {
		if (process.platform === "win32") return;
		const path = join(s.root, "sock");
		// bind through a relative name: the scratch path is longer than a socket path may be
		const made = Bun.spawnSync(["python3", "-c", "import socket; socket.socket(socket.AF_UNIX).bind('sock')"], {
			cwd: s.root,
		});
		if (made.exitCode !== 0) return; // no python3 here
		try {
			expect(await codeOf(s.service.read(s.root, "sock", 1, 10))).toBe("forbidden");
			expect(await codeOf(s.service.bytes(s.root, "sock", 0, 10))).toBe("forbidden");
			expect((await s.service.list(s.root, "", false)).entries.find(e => e.name === "sock")).toMatchObject({
				kind: "other",
			});
		} finally {
			rmSync(path, { force: true });
		}
	});

	test("a device file is refused", async () => {
		if (process.platform === "win32") return;
		symlinkSync("/dev/null", join(s.root, "devnull-link"));
		try {
			// the link leaves the root, so the escape check answers first; either way nothing is opened
			expect(["outside_root", "forbidden"]).toContain(await codeOf(s.service.read(s.root, "devnull-link", 1, 10)));
		} finally {
			rmSync(join(s.root, "devnull-link"), { force: true });
		}
	});
});

describe("a path swapped for a symlink between the check and the open", () => {
	test.skipIf(!F)("the file itself becomes a link to a secret outside: the open notices", async () => {
		const victim = join(s.root, "victim.txt");
		writeFileSync(victim, "harmless\n");
		let swapped = 0;
		s.hooks.afterResolve = real => {
			if (real !== victim) return;
			swapped++;
			rmSync(victim);
			symlinkSync(join(s.outside, "secret.txt"), victim);
		};
		try {
			const result = await s.service.read(s.root, "victim.txt", 1, 10).catch(e => e);
			expect(swapped).toBe(1);
			expect(result).toBeInstanceOf(FileError);
			expect(JSON.stringify(result)).not.toContain("SECRET");
			expect((result as FileError).code).toBe("forbidden"); // not a regular file any more: it is a symlink
		} finally {
			s.hooks.afterResolve = undefined;
			rmSync(victim, { force: true });
		}
	});

	test("the file is replaced by another regular file between the type check and the open: the identity check refuses", async () => {
		const victim = join(s.root, "swap.txt");
		writeFileSync(victim, "original\n");
		s.hooks.beforeOpen = real => {
			if (real !== victim) return;
			writeFileSync(`${victim}.new`, "replacement\n");
			renameSync(`${victim}.new`, victim); // a different inode now sits at the checked path
		};
		try {
			expect(await codeOf(s.service.read(s.root, "swap.txt", 1, 10))).toBe("changed");
		} finally {
			s.hooks.beforeOpen = undefined;
			rmSync(victim, { force: true });
		}
	});

	test("a directory swapped for a link to the outside between the type check and the open: the opened file is not the checked one", async () => {
		mkdirSync(join(s.root, "lateswap"));
		writeFileSync(join(s.root, "lateswap", "secret.txt"), "decoy\n");
		let swapped = false;
		s.hooks.beforeOpen = () => {
			if (swapped) return;
			swapped = true;
			renameSync(join(s.root, "lateswap"), join(s.root, "lateswap.bak"));
			link(s.outside, join(s.root, "lateswap"));
		};
		try {
			const result = await s.service.read(s.root, "lateswap/secret.txt", 1, 10).catch(e => e);
			expect(swapped).toBe(true);
			expect(result).toBeInstanceOf(FileError);
			expect(JSON.stringify(result)).not.toContain("SECRET");
			expect((result as FileError).code).toBe("changed");
		} finally {
			s.hooks.beforeOpen = undefined;
			rmSync(join(s.root, "lateswap"), { force: true });
			rmSync(join(s.root, "lateswap.bak"), { recursive: true, force: true });
		}
	});

	test("a directory on the path becomes a link to the outside directory: refused, nothing outside is read", async () => {
		mkdirSync(join(s.root, "swapdir"));
		writeFileSync(join(s.root, "swapdir", "secret.txt"), "decoy\n");
		let swapped = false;
		s.hooks.afterResolve = () => {
			if (swapped) return;
			swapped = true;
			renameSync(join(s.root, "swapdir"), join(s.root, "swapdir.bak"));
			link(s.outside, join(s.root, "swapdir"));
		};
		try {
			const result = await s.service.read(s.root, "swapdir/secret.txt", 1, 10).catch(e => e);
			expect(swapped).toBe(true);
			expect(result).toBeInstanceOf(FileError);
			expect(JSON.stringify(result)).not.toContain("SECRET");
			expect(["changed", "outside_root"]).toContain((result as FileError).code);
		} finally {
			s.hooks.afterResolve = undefined;
			rmSync(join(s.root, "swapdir"), { force: true });
			rmSync(join(s.root, "swapdir.bak"), { recursive: true, force: true });
		}
	});

	test("a listed directory swapped for a link to the outside is refused", async () => {
		mkdirSync(join(s.root, "listdir"));
		let swapped = false;
		s.hooks.afterResolve = () => {
			if (swapped) return;
			swapped = true;
			renameSync(join(s.root, "listdir"), join(s.root, "listdir.bak"));
			link(s.outside, join(s.root, "listdir"));
		};
		try {
			const result = await s.service.list(s.root, "listdir", false).catch(e => e);
			expect(result).toBeInstanceOf(FileError);
			expect(JSON.stringify(result)).not.toContain("secret.txt");
		} finally {
			s.hooks.afterResolve = undefined;
			rmSync(join(s.root, "listdir"), { force: true });
			rmSync(join(s.root, "listdir.bak"), { recursive: true, force: true });
		}
	});
});
