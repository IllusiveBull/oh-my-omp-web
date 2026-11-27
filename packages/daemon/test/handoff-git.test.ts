/**
 * The git layer of "switch environment" against real (temporary) repositories: what the handoff commit carries and
 * leaves alone, that a repository's own configuration never makes the daemon run anything, bundle negotiation,
 * materialization on the target and rollback. Each case asserts concrete bytes and state.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import type { RepoStateIssue } from "@omp-web/protocol";
import { join } from "node:path";
import {
	commitsPresent,
	createBundle,
	createHandoffCommit,
	createWorkspace,
	handoffRefs,
	HandoffGitError,
	inspectRepo,
	listTargetWorktrees,
	planNewWorktree,
	removeHandoffRefs,
	rollbackWorkspace,
	verifyAndFetchBundle,
	type HandoffCommitResult,
	type WorkspaceRecord,
} from "../src/handoff-git";
import {
	ageIndex,
	dirtyRepo,
	exists,
	put,
	snapshot,
	statusEntries,
	treeHash,
	treeLines,
	world,
	type World,
} from "./handoff-git-fixtures";
import { posixPath } from "./fake-bin";
import { FILE_SYMLINKS, makeLink as directoryLink } from "./links";

const LIMITS = { maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 };
const THREAD = "thread-1";
// Each case drives real git in several temporary repositories; a loaded machine needs more than bun's 5 s.
setDefaultTimeout(60_000);

let w: World;
beforeEach(() => {
	w = world();
});
afterEach(() => w.dispose());

async function omp(root: string): Promise<string[]> {
	const out = await w.git(root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/omp-web");
	return out.split("\n").filter(line => line !== "");
}

/** What a `rejects` assertion hands back, typed. */
async function failure(promise: Promise<unknown>): Promise<HandoffGitError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof HandoffGitError) return error;
		throw error;
	}
	throw new Error("expected the call to fail");
}

/** `mode oid path` lines of the real index (stage 0). */
async function indexLines(root: string): Promise<string[]> {
	const out = await w.git(root, "ls-files", "-s", "-z");
	return out
		.split("\0")
		.filter(entry => entry !== "")
		.map(entry => {
			const tab = entry.indexOf("\t");
			const [mode, oid] = entry.slice(0, tab).split(" ");
			return `${mode} ${oid} ${entry.slice(tab + 1)}`;
		})
		.sort();
}

function fileCount(dir: string): number {
	let count = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		count += entry.isDirectory() ? fileCount(join(dir, entry.name)) : 1;
	}
	return count;
}

async function commitAll(
	root: string,
	message: string,
	files: Record<string, string | Uint8Array> = {},
): Promise<string> {
	put(root, files);
	await w.git(root, "add", "-A");
	await w.git(root, "commit", "-q", "-m", message);
	return (await w.git(root, "rev-parse", "HEAD")).trim();
}

describe("Windows Git checkout semantics", () => {
	test("plain symlink checkouts, executable index modes and CRLF survive materialization and rollback", async () => {
		const root = await w.repo("MixedCaseRepo", {
			link: "first-target",
			"run.sh": "original\n",
			"text.txt": "original\n",
		});
		await w.git(root, "config", "core.symlinks", "false");
		await w.git(root, "config", "core.filemode", "false");
		await w.git(root, "config", "core.autocrlf", "true");
		const linkOid = (await w.git(root, "hash-object", "-w", "link")).trim();
		await w.git(root, "update-index", "--cacheinfo", `120000,${linkOid},link`);
		await w.git(root, "update-index", "--chmod=+x", "run.sh");
		await w.git(root, "commit", "-q", "-m", "modes");
		const target = join(w.dir, "MixedCaseTarget");
		await w.git(root, "worktree", "add", "-q", "-b", "target", target);
		const beforeText = readFileSync(join(target, "text.txt"));
		const beforeLink = readFileSync(join(target, "link"));
		put(root, { link: "staged-target", "run.sh": "staged\n", "text.txt": "staged\r\n" });
		await w.git(root, "add", "link", "run.sh", "text.txt");
		put(root, { link: "unstaged-target", "run.sh": "unstaged\r\n", "text.txt": "unstaged\r\n" });
		const before = await snapshot(w, root);
		const handoff = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		expect(await snapshot(w, root)).toEqual(before);
		const tree = await treeLines(w, root, handoff.commit);
		expect(tree.find(line => line.endsWith(" link"))).toStartWith("120000 ");
		expect(tree.find(line => line.endsWith(" run.sh"))).toStartWith("100755 ");
		const chosen = process.platform === "win32" ? target.toUpperCase() : target;
		const made = await createWorkspace(
			{
				opId: "op-modes",
				threadId: THREAD,
				projectRoot: root,
				choice: { mode: "existing", worktree: chosen },
				base: handoff.base,
				commit: handoff.commit,
				indexCommit: handoff.indexCommit,
				onRecord: () => {},
			},
			w.ctx,
		);
		expect(readFileSync(join(target, "link"), "utf8")).toBe("unstaged-target");
		expect(readFileSync(join(target, "text.txt"), "utf8")).toBe("unstaged\r\n");
		expect((await indexLines(target)).find(line => line.endsWith(" run.sh"))).toStartWith("100755 ");
		expect((await indexLines(target)).find(line => line.endsWith(" link"))).toStartWith("120000 ");
		expect((await rollbackWorkspace(made.record, w.ctx)).leftovers).toEqual([]);
		expect(readFileSync(join(target, "text.txt"))).toEqual(beforeText);
		expect(readFileSync(join(target, "link"))).toEqual(beforeLink);
		expect(await statusEntries(w, target)).toEqual([]);
	});

	test.skipIf(process.platform !== "win32")(
		"refuses Windows-reserved tree names before creating a worktree",
		async () => {
			const root = await w.repo("reserved");
			const base = (await w.git(root, "rev-parse", "HEAD")).trim();
			const blob = (await w.git(root, "rev-parse", "HEAD:README.md")).trim();
			const treeFile = join(w.dir, "tree-object");
			writeFileSync(treeFile, Buffer.concat([Buffer.from("100644 CON.txt\0"), Buffer.from(blob, "hex")]));
			const tree = (await w.git(root, "hash-object", "-t", "tree", "-w", treeFile)).trim();
			const bad = (await w.git(root, "commit-tree", tree, "-p", base, "-m", "bad path")).trim();
			const plan = await planNewWorktree(root, "reserved", THREAD, {}, w.ctx);
			const error = await failure(
				createWorkspace(
					{
						opId: "op-reserved",
						threadId: THREAD,
						projectRoot: root,
						choice: { mode: "new" },
						base: { commit: base, branch: "main" },
						commit: bad,
						indexCommit: null,
						plan,
						onRecord: () => {},
					},
					w.ctx,
				),
			);
			expect(error.message).toContain("CON.txt");
			expect(exists(plan.path)).toBe(false);
			expect(await w.git(root, "for-each-ref", `refs/heads/${plan.branch}`)).toBe("");
		},
	);
});

describe("the handoff commit", () => {
	test("carries every kind of change and leaves branch, index, stash and working tree byte-identical", async () => {
		const d = await dirtyRepo(w);
		ageIndex(d.root);
		const before = await snapshot(w, d.root);
		const objectsBefore = fileCount(join(d.root, ".git", "objects"));

		const result = await createHandoffCommit(d.root, THREAD, LIMITS, w.ctx);

		const after = await snapshot(w, d.root);
		expect(after).toEqual(before); // status, index sha + mtime, HEAD, branches/tags/stash, every file with modes and link targets
		expect(after.stash).toContain("stash@{0}");
		expect(fileCount(join(d.root, ".git", "objects"))).toBeGreaterThan(objectsBefore); // objects were written, and nothing else
		expect(await omp(d.root)).toEqual([
			`refs/omp-web/handoff-index/${THREAD} ${result.indexCommit}`,
			`refs/omp-web/handoff/${THREAD} ${result.commit}`,
		]);

		// The commit's tree is the working tree: every carried file's bytes and mode.
		const head = (await w.git(d.root, "rev-parse", "HEAD")).trim();
		expect(result.base).toEqual({ commit: head, branch: "main", detached: false });
		expect((await w.git(d.root, "rev-parse", `${result.commit}^`)).trim()).toBe(head);
		const lines = await treeLines(w, d.root, result.commit);
		const entry = (path: string): string | undefined => lines.find(line => line.endsWith(` ${path}`));
		const blob = async (path: string): Promise<string> =>
			(await w.git(d.root, "hash-object", "--no-filters", join(d.root, path))).trim();
		expect(entry("a.txt")).toBe(`100644 ${await blob("a.txt")} a.txt`);
		expect(entry("b.txt")).toBe(`100644 ${await blob("b.txt")} b.txt`);
		expect(entry("crlf.txt")).toBe(`100644 ${await blob("crlf.txt")} crlf.txt`); // raw bytes, CRLF kept despite core.autocrlf
		expect(entry("bin/blob.bin")).toBe(`100644 ${await blob("bin/blob.bin")} bin/blob.bin`);
		expect(entry("bin/run.sh")).toBe(
			`${process.platform === "win32" ? "100644" : "100755"} ${await blob("bin/run.sh")} bin/run.sh`,
		);
		expect(entry("mode.txt")).toBe(`100755 ${await blob("mode.txt")} mode.txt`);
		expect(entry("exec.sh")?.startsWith("100755 ")).toBe(true);
		expect(entry("renamed.txt")).toBeDefined();
		expect(entry("rename-me.txt")).toBeUndefined();
		expect(entry("del.txt")).toBeUndefined();
		expect(entry("del2.txt")).toBeUndefined();
		expect(entry("staged-add.txt")).toBeDefined();
		// symlinks: mode 120000, blob = the link text (also a dangling one, and a regular file turned into a link)
		for (const [path, target] of [
			["link", "b.txt"],
			["tc.txt", "a.txt"],
			["dangling", "../outside-the-repo"],
			["bin/newlink", "new.txt"],
		] as const) {
			const found = entry(path)!;
			expect(
				found.startsWith(
					process.platform === "win32" && (path === "dangling" || path === "bin/newlink") ? "100644 " : "120000 ",
				),
			).toBe(true);
			expect(await w.git(d.root, "cat-file", "blob", found.split(" ")[1]!)).toBe(target);
		}
		expect(
			entry(process.platform === "win32" ? "space dir/odd name.txt" : 'space dir/odd name "quoted".txt'),
		).toBeDefined();
		// ignored files are not in it
		expect(lines.filter(line => line.includes("debug.log") || line.includes("build/"))).toEqual([]);
		// all of it, no more: the tree equals what the working tree holds minus the ignored files
		const working = (await w.git(d.root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"))
			.split("\0")
			.filter(p => p !== "");
		const missing = new Set((await w.git(d.root, "ls-files", "-z", "--deleted")).split("\0").filter(p => p !== ""));
		expect(lines.map(line => line.split(" ").slice(2).join(" ")).sort()).toEqual(
			working.filter(p => !missing.has(p)).sort(),
		);

		// The index commit is the real index.
		expect(await treeLines(w, d.root, result.indexCommit!)).toEqual(await indexLines(d.root));
		expect((await w.git(d.root, "rev-parse", `${result.indexCommit}^`)).trim()).toBe(head);

		// The summary.
		const untrackedSizes = [
			"untracked\n".length,
			"windows\r\nline endings\r\n".length,
			8,
			"#!/bin/sh\n".length,
			"odd\n".length,
			"../outside-the-repo".length,
			"new.txt".length,
		];
		expect(result.carried.tracked).toEqual({
			modified: 4,
			added: 1,
			deleted: 2,
			renamed: 1,
			typeChanged: 1,
			modeChanged: 1,
		});
		expect(result.carried.untracked).toEqual({ files: 7, bytes: untrackedSizes.reduce((a, b) => a + b, 0) });
		expect(result.carried.staged).toEqual({ preserved: true, paths: process.platform === "win32" ? 7 : 5 });
		expect(result.carried.paths).toBe(18);
		expect(result.carried.sample.length).toBe(18);
		expect(result.carried.skipped).toEqual([]);
		expect(result.carried.skippedTruncated).toBe(false);
		expect(result.carried.ignored).toEqual({ count: 2, sample: ["build/", "debug.log"] });

		// identity and message
		const log = (await w.git(d.root, "log", "-1", "--format=%an|%ae|%cn|%ce|%s", result.commit)).trim();
		expect(log).toBe(`omp-web handoff|omp-web@localhost|omp-web handoff|omp-web@localhost|omp-web handoff ${THREAD}`);
	});

	test("the preview equals the commit's summary and writes no object, ref or index", async () => {
		const d = await dirtyRepo(w);
		ageIndex(d.root);
		const before = await snapshot(w, d.root);
		const objects = fileCount(join(d.root, ".git", "objects"));

		const inspection = await inspectRepo(d.root, LIMITS, w.ctx);

		expect(await snapshot(w, d.root)).toEqual(before);
		expect(fileCount(join(d.root, ".git", "objects"))).toBe(objects);
		expect(await omp(d.root)).toEqual([]);
		const head = (await w.git(d.root, "rev-parse", "HEAD")).trim();
		expect(inspection).toMatchObject({ head, branch: "main", detached: false, stateIssue: null, shallow: false });
		expect(inspection.recent).toEqual((await w.git(d.root, "rev-list", "HEAD")).split("\n").filter(Boolean));
		const result = await createHandoffCommit(d.root, THREAD, LIMITS, w.ctx);
		expect(inspection.preview).toEqual(result.carried);
	});

	test("works with no git identity at all (empty HOME, no global or system config)", async () => {
		const root = await w.repo("noident");
		put(root, { "x.txt": "x\n" });
		const probe = await w.gitRun(root, {}, "-c", "user.name=", "-c", "user.email=", "config", "user.name");
		expect(probe.out.trim()).toBe("");
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		expect((await w.git(root, "log", "-1", "--format=%an <%ae>", result.commit)).trim()).toBe(
			"omp-web handoff <omp-web@localhost>",
		);
		const when = Number((await w.git(root, "log", "-1", "--format=%at", result.commit)).trim());
		expect(Math.abs(when - Date.now() / 1000)).toBeLessThan(120);
	});

	test("a detached HEAD is carried too", async () => {
		const root = await w.repo("detached");
		await w.git(root, "checkout", "-q", "--detach");
		put(root, { "x.txt": "x\n" });
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		const head = (await w.git(root, "rev-parse", "HEAD")).trim();
		expect(result.base).toEqual({ commit: head, branch: null, detached: true });
		expect(result.carried.base).toEqual(result.base);
		expect((await inspectRepo(root, LIMITS, w.ctx)).detached).toBe(true);
	});

	test("a repository without commits and a directory that is not a repository are refused", async () => {
		const empty = `${w.dir}/empty`;
		await Bun.$`mkdir ${empty}`.quiet();
		await w.git(empty, "init", "-q", "-b", "main");
		expect((await failure(createHandoffCommit(empty, THREAD, LIMITS, w.ctx))).kind).toBe("refused");
		const plain = `${w.dir}/plain`;
		await Bun.$`mkdir ${plain}`.quiet();
		const error = await failure(createHandoffCommit(plain, THREAD, LIMITS, w.ctx));
		expect(error.kind).toBe("refused");
		expect(error.message).toContain("not a git repository");
	});

	test("an invalid thread id is rejected before anything runs", async () => {
		const root = await w.repo("ids");
		expect(() => handoffRefs("../escape")).toThrow(HandoffGitError);
		expect(() => handoffRefs("")).toThrow(HandoffGitError);
		await expect(createHandoffCommit(root, "a b", LIMITS, w.ctx)).rejects.toBeInstanceOf(HandoffGitError);
		expect(handoffRefs("t_1-x")).toEqual({
			worktree: "refs/omp-web/handoff/t_1-x",
			index: "refs/omp-web/handoff-index/t_1-x",
		});
	});

	test("a second handoff of the thread moves the refs, and removeHandoffRefs is idempotent", async () => {
		const root = await w.repo("again");
		put(root, { "x.txt": "1\n" });
		const first = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		put(root, { "x.txt": "2\n" });
		const second = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		expect(second.commit).not.toBe(first.commit);
		expect(await omp(root)).toContain(`refs/omp-web/handoff/${THREAD} ${second.commit}`);
		expect(await removeHandoffRefs(root, THREAD, w.ctx)).toEqual([
			`refs/omp-web/handoff/${THREAD}`,
			`refs/omp-web/handoff-index/${THREAD}`,
		]);
		expect(await omp(root)).toEqual([]);
		expect(await removeHandoffRefs(root, THREAD, w.ctx)).toEqual([]);
	});

	test("an index git cannot turn into a tree is reported: everything arrives unstaged, no stale index ref survives", async () => {
		const root = await w.repo("brokenindex");
		put(root, { "x.txt": "1\n" });
		const first = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		expect(first.indexCommit).not.toBeNull();
		await w.git(root, "update-index", "--add", "--cacheinfo", `100644,${"1".repeat(40)},ghost.txt`);
		const second = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		expect(second.indexCommit).toBeNull();
		expect(second.carried.staged.preserved).toBe(false);
		expect(second.carried.staged.note).toContain("unstaged");
		expect(await omp(root)).toEqual([`refs/omp-web/handoff/${THREAD} ${second.commit}`]);
		expect((await treeLines(w, root, second.commit)).some(line => line.endsWith("ghost.txt"))).toBe(false);
	});
});

describe("what is refused", () => {
	async function refused(root: string, pattern: RegExp, issue: RepoStateIssue): Promise<void> {
		const before = await snapshot(w, root);
		const error = await failure(createHandoffCommit(root, THREAD, LIMITS, w.ctx));
		expect(error.kind).toBe("refused");
		expect(error.message).toMatch(pattern);
		expect(await omp(root)).toEqual([]); // nothing written
		expect(await snapshot(w, root)).toEqual(before);
		expect((await inspectRepo(root, LIMITS, w.ctx)).stateIssue).toBe(issue);
	}

	async function conflicting(name: string): Promise<string> {
		const root = await w.repo(name, { "f.txt": "base\n" });
		await w.git(root, "checkout", "-q", "-b", "other");
		await commitAll(root, "other", { "f.txt": "other\n" });
		await w.git(root, "checkout", "-q", "main");
		await commitAll(root, "main", { "f.txt": "main\n" });
		return root;
	}

	test("a merge in progress (with unmerged paths)", async () => {
		const root = await conflicting("merge");
		expect((await w.gitRun(root, {}, "merge", "other")).code).toBe(1);
		await refused(root, /merge is in progress/, "merge");
	});

	test("an interactive rebase stopped at an edit", async () => {
		const root = await w.repo("rebase", { "f.txt": "0\n" });
		await commitAll(root, "c1", { "f.txt": "1\n" });
		await commitAll(root, "c2", { "f.txt": "2\n" });
		const run = await w.gitRun(
			root,
			{ GIT_SEQUENCE_EDITOR: "sed -i.bak 's/^pick/edit/'", GIT_EDITOR: "true" },
			"rebase",
			"-i",
			"HEAD~2",
		);
		expect(run.code).toBe(0);
		await refused(root, /rebase/, "rebase");
	});

	test("a cherry-pick in progress", async () => {
		const root = await conflicting("cherry");
		expect((await w.gitRun(root, {}, "cherry-pick", "other")).code).toBe(1);
		await refused(root, /cherry-pick is in progress/, "cherry-pick");
	});

	test("a revert in progress", async () => {
		const root = await w.repo("revert", { "f.txt": "0\n" });
		await commitAll(root, "c1", { "f.txt": "1\n" });
		await commitAll(root, "c2", { "f.txt": "2\n" });
		expect((await w.gitRun(root, {}, "revert", "--no-edit", "HEAD~1")).code).toBe(1);
		await refused(root, /revert is in progress/, "revert");
	});

	test("a bisect in progress", async () => {
		const root = await w.repo("bisect");
		await commitAll(root, "c1", { "f.txt": "1\n" });
		await w.git(root, "bisect", "start");
		await refused(root, /bisect is in progress/, "bisect");
	});

	test("unmerged paths without any operation marker", async () => {
		const root = await w.repo("unmerged", { "f.txt": "base\n" });
		const base = (await w.git(root, "rev-parse", "HEAD:f.txt")).trim();
		const proc = Bun.spawn(["git", "-C", root, "hash-object", "-w", "--stdin"], {
			stdin: new Blob(["theirs\n"]),
			stdout: "pipe",
			env: { ...process.env, ...w.env },
		});
		const theirs = (await new Response(proc.stdout).text()).trim();
		const index = Bun.spawn(["git", "-C", root, "update-index", "--index-info"], {
			stdin: new Blob([`0 ${"0".repeat(40)}\tf.txt\n100644 ${base} 1\tf.txt\n100644 ${theirs} 3\tf.txt\n`]),
			env: { ...process.env, ...w.env },
		});
		expect(await index.exited).toBe(0);
		expect((await w.git(root, "status", "--porcelain=v2")).startsWith("u ")).toBe(true);
		await refused(root, /unresolved merge conflicts \(f\.txt\)/, "merge");
	});
});

describe("what is not carried", () => {
	test("files over the per-file cap and beyond the total cap are skipped and listed, in path order", async () => {
		const root = await w.repo("caps", { "tracked-big.txt": "small\n", "staged-big.txt": "small\n" });
		put(root, {
			"big.bin": Buffer.alloc(5000, 1),
			f1: Buffer.alloc(600, 2),
			f2: Buffer.alloc(600, 3),
			f3: Buffer.alloc(600, 4),
			f4: "tiny\n",
			"tracked-big.txt": Buffer.alloc(3000, 5),
			"staged-big.txt": Buffer.alloc(3000, 6),
		});
		await w.git(root, "add", "staged-big.txt");
		const limits = { maxFileBytes: 1000, maxTotalBytes: 1500 };
		const result = await createHandoffCommit(root, THREAD, limits, w.ctx);
		expect(result.carried.skipped).toEqual([
			expect.objectContaining({ path: "big.bin", reason: "too-large", size: 5000 }),
			expect.objectContaining({ path: "f3", reason: "total-cap", size: 600 }),
			expect.objectContaining({ path: "f4", reason: "total-cap", size: 5 }),
			expect.objectContaining({ path: "staged-big.txt", reason: "too-large", size: 3000 }),
			expect.objectContaining({ path: "tracked-big.txt", reason: "too-large", size: 3000 }),
		]);
		expect(result.carried.untracked).toEqual({ files: 2, bytes: 1200 });
		expect(result.carried.paths).toBe(2);
		expect(result.carried.sample).toEqual(["f1", "f2"]);
		// a skipped path keeps its HEAD state, in the working tree's tree and in the index's
		const headLines = await treeLines(w, root, "HEAD");
		const tree = await treeLines(w, root, result.commit);
		const index = await treeLines(w, root, result.indexCommit!);
		for (const lines of [tree, index]) {
			expect(lines.filter(line => line.endsWith("tracked-big.txt"))).toEqual(
				headLines.filter(line => line.endsWith("tracked-big.txt")),
			);
			expect(lines.filter(line => line.endsWith("staged-big.txt"))).toEqual(
				headLines.filter(line => line.endsWith("staged-big.txt")),
			);
			expect(lines.some(line => / (big\.bin|f3|f4)$/.test(line))).toBe(false);
		}
		expect(tree.some(line => line.endsWith(" f1"))).toBe(true);
		expect(result.carried.staged.paths).toBe(0); // the staged path was left behind, so it is not "staged on arrival"
		expect(await w.git(root, "status", "--porcelain")).toContain("staged-big.txt"); // the source still has it
	});

	test("more than 500 skipped paths are truncated and flagged", async () => {
		const root = await w.repo("many");
		const files: Record<string, string> = {};
		for (let i = 0; i < 520; i++) files[`f${String(i).padStart(4, "0")}`] = "xx";
		put(root, files);
		const result = await createHandoffCommit(root, THREAD, { maxFileBytes: 1, maxTotalBytes: 1000 }, w.ctx);
		expect(result.carried.skipped).toHaveLength(500);
		expect(result.carried.skippedTruncated).toBe(true);
		expect(result.carried.paths).toBe(0);
	});

	test("git-lfs tracked paths are skipped, never as pointer text", async () => {
		const root = await w.repo("lfs", {
			".gitattributes": "*.lfs filter=lfs diff=lfs merge=lfs -text\n",
			"tracked.lfs": "version https://git-lfs.github.com/spec/v1\n",
		});
		put(root, { "new.lfs": "real big content", "tracked.lfs": "real modified big content", "plain.txt": "plain\n" });
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		expect(result.carried.skipped.map(s => [s.path, s.reason])).toEqual([
			["new.lfs", "lfs"],
			["tracked.lfs", "lfs"],
		]);
		const tree = await treeLines(w, root, result.commit);
		expect(tree.some(line => line.endsWith("new.lfs"))).toBe(false);
		expect(tree.filter(line => line.endsWith("tracked.lfs"))).toEqual(
			(await treeLines(w, root, "HEAD")).filter(line => line.endsWith("tracked.lfs")),
		);
		expect(result.carried.untracked.files).toBe(1);
	});

	test("a nested repository is skipped and listed", async () => {
		const root = await w.repo("outer");
		const nested = join(root, "vendor-clone");
		await w.git(root, "init", "-q", "-b", "main", nested);
		writeFileSync(join(nested, "n.txt"), "n\n");
		await w.git(nested, "add", "-A");
		await w.git(nested, "commit", "-q", "-m", "n");
		put(root, { "keep.txt": "k\n" });
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		expect(result.carried.skipped).toEqual([
			expect.objectContaining({ path: "vendor-clone", reason: "embedded-repo" }),
		]);
		const tree = await treeLines(w, root, result.commit);
		expect(tree.some(line => line.includes("vendor-clone"))).toBe(false);
		expect(tree.some(line => line.endsWith("keep.txt"))).toBe(true);
	});

	test("a changed submodule is skipped and listed; its HEAD state stays in both trees", async () => {
		const lib = await w.repo("lib", { "lib.txt": "lib\n" });
		const root = await w.repo("host");
		await w.git(root, "submodule", "add", "-q", lib, "sub");
		await w.git(root, "commit", "-q", "-m", "add submodule");
		const gitlink = (await treeLines(w, root, "HEAD")).filter(line => line.endsWith(" sub"));
		expect(gitlink[0]!.startsWith("160000 ")).toBe(true);
		await commitAll(join(root, "sub"), "inside the submodule", { "lib.txt": "changed\n" });
		put(root, { "keep.txt": "k\n" });
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		expect(result.carried.skipped).toEqual([expect.objectContaining({ path: "sub", reason: "submodule" })]);
		expect((await treeLines(w, root, result.commit)).filter(line => line.endsWith(" sub"))).toEqual(gitlink);
		expect((await treeLines(w, root, result.indexCommit!)).filter(line => line.endsWith(" sub"))).toEqual(gitlink);
		// a staged submodule update is not carried either
		await w.git(root, "add", "sub");
		const staged = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		expect((await treeLines(w, root, staged.indexCommit!)).filter(line => line.endsWith(" sub"))).toEqual(gitlink);
		expect(staged.carried.staged.paths).toBe(0);
	});

	test.skipIf(process.platform === "win32")(
		"a file replaced by a named pipe is skipped as a special file (HEAD state kept)",
		async () => {
			const root = await w.repo("special", { "f.txt": "regular\n" });
			rmSync(join(root, "f.txt"));
			Bun.spawnSync(["mkfifo", join(root, "f.txt")]);
			const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
			expect(result.carried.skipped).toEqual([expect.objectContaining({ path: "f.txt", reason: "special-file" })]);
			expect(await treeLines(w, root, result.commit)).toEqual(await treeLines(w, root, "HEAD"));
		},
	);

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"an unreadable file is skipped as unreadable",
		async () => {
			const root = await w.repo("unreadable");
			put(root, { "secret.txt": "nope\n", "ok.txt": "ok\n" });
			chmodSync(join(root, "secret.txt"), 0o000);
			try {
				const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
				expect(result.carried.skipped).toEqual([
					expect.objectContaining({ path: "secret.txt", reason: "unreadable" }),
				]);
				expect((await treeLines(w, root, result.commit)).some(line => line.endsWith("ok.txt"))).toBe(true);
			} finally {
				chmodSync(join(root, "secret.txt"), 0o644);
			}
		},
	);

	test("a tracked directory replaced by a symlink to outside: nothing behind the link is read, the files count as deleted", async () => {
		const root = await w.repo("dirlink", { "dir/x.txt": "inside\n", "keep.txt": "k\n" });
		const outside = join(w.dir, "outside-secret");
		put(outside, { "x.txt": "SECRET OUTSIDE THE WORKTREE\n" });
		rmSync(join(root, "dir"), { recursive: true });
		directoryLink(outside, join(root, "dir"));
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		const tree = await treeLines(w, root, result.commit);
		expect(tree.some(line => line.endsWith(" dir/x.txt"))).toBe(false);
		// A junction (Windows without the symlink privilege) is a directory reparse point for git, not a 120000 entry: only
		// the property that nothing behind it is read can be asserted there.
		if (FILE_SYMLINKS) {
			const link = tree.find(line => line.endsWith(" dir"))!;
			expect(link.startsWith("120000 ")).toBe(true);
			expect(await w.git(root, "cat-file", "blob", link.split(" ")[1]!)).toBe(outside);
		}
		const objects = await w.git(root, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)");
		const secret = (await w.git(outside, "hash-object", "--no-filters", "x.txt")).trim();
		expect(objects).not.toContain(secret);
	});

	test("names with newlines, quotes, backslashes and non-ASCII characters survive", async () => {
		const root = await w.repo("odd-names");
		const names = [
			...(process.platform === "win32" ? [] : ["line\nbreak.txt", 'quote".txt', "back\\slash.txt", "tab\there.txt"]),
			"caf\u00e9 \u65e5\u672c.txt",
			" leading space.txt",
		];
		for (const name of names) put(root, { [name]: `content of ${JSON.stringify(name)}\n` });
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		const tree = (await w.git(root, "ls-tree", "-r", "--name-only", "-z", result.commit)).split("\0").filter(Boolean);
		expect(tree.sort()).toEqual([...names, "README.md"].sort());
		for (const name of names) {
			expect(await w.git(root, "cat-file", "blob", `${result.commit}:${name}`)).toBe(
				`content of ${JSON.stringify(name)}\n`,
			);
		}
		expect(result.carried.untracked.files).toBe(names.length);
	});

	test("a source that is a linked worktree: its own index and operation state are the ones used", async () => {
		const main = await w.repo("main-wt", { "a.txt": "a\n" });
		const linked = join(w.dir, "linked-wt");
		await w.git(main, "worktree", "add", "-q", "-b", "linked-b", linked);
		put(linked, { "a.txt": "linked change\n", "only-here.txt": "x\n" });
		await w.git(linked, "add", "a.txt");
		put(main, { "main-only.txt": "m\n" });
		const result = await createHandoffCommit(linked, THREAD, LIMITS, w.ctx);
		expect(result.base.branch).toBe("linked-b");
		const carried = (await treeLines(w, linked, result.commit))
			.map(line => line.split(" ").slice(2).join(" "))
			.sort();
		expect(carried).toEqual(["a.txt", "only-here.txt"]);
		expect(await treeLines(w, linked, result.indexCommit!)).toEqual(await indexLines(linked));
		expect((await treeLines(w, linked, result.indexCommit!)).some(line => line.endsWith("only-here.txt"))).toBe(
			false,
		);
		// a merge in the linked worktree is found through its own git directory, the main worktree being fine
		await w.git(linked, "stash", "push", "-q", "--include-untracked");
		await commitAll(linked, "linked c2", { "a.txt": "linked 2\n" });
		await w.git(main, "checkout", "-q", "-b", "side", "HEAD~0");
		await commitAll(main, "side", { "a.txt": "side\n" });
		expect((await w.gitRun(linked, {}, "merge", "side")).code).toBe(1);
		expect((await failure(createHandoffCommit(linked, THREAD, LIMITS, w.ctx))).message).toMatch(
			/merge is in progress/,
		);
		expect((await inspectRepo(main, LIMITS, w.ctx)).stateIssue).toBeNull();
	});

	test("a rename whose destination is skipped is not a rename: the origin keeps its HEAD state", async () => {
		const root = await w.repo("renamed-big", { "old.txt": Buffer.from("x".repeat(3000)) });
		await w.git(root, "mv", "old.txt", "new.txt");
		const result = await createHandoffCommit(root, THREAD, { maxFileBytes: 1000, maxTotalBytes: 100_000 }, w.ctx);
		expect(result.carried.skipped).toEqual([expect.objectContaining({ path: "new.txt", reason: "too-large" })]);
		expect(await treeLines(w, root, result.commit)).toEqual(await treeLines(w, root, "HEAD"));
		expect(await treeLines(w, root, result.indexCommit!)).toEqual(await treeLines(w, root, "HEAD"));
		expect(result.carried.paths).toBe(0);
	});
});

describe("hostile repository configuration", () => {
	/** An executable shell program that touches `marker` and then does `rest` (its path is `/`-separated: git hands it to sh). */
	function program(name: string, marker: string, rest = ""): string {
		const path = join(w.dir, name);
		writeFileSync(path, `#!/bin/sh\ntouch '${posixPath(marker)}'\n${rest}\n`, { mode: 0o755 });
		return posixPath(path);
	}

	/** Plants every way a repository's own files make git run a program; returns marker file by vector. */
	async function plant(root: string, hooksDir: string): Promise<Record<string, string>> {
		const markers: Record<string, string> = {};
		const marker = (name: string): string => (markers[name] = join(w.dir, `marker-${name}`));
		for (const hook of [
			"pre-commit",
			"post-commit",
			"post-checkout",
			"reference-transaction",
			"post-index-change",
			"pre-auto-gc",
			"post-merge",
		]) {
			rmSync(join(hooksDir, hook), { force: true });
			put(hooksDir, {});
			writeFileSync(join(hooksDir, hook), `#!/bin/sh\ntouch '${posixPath(marker(`hook-${hook}`))}'\nexit 0\n`, {
				mode: 0o755,
			});
		}
		await w.git(root, "config", "core.fsmonitor", program("fsmonitor.sh", marker("fsmonitor"), "printf '\\0'"));
		await w.git(root, "config", "commit.gpgsign", "true");
		await w.git(root, "config", "gpg.program", program("gpg.sh", marker("gpg"), "exit 1"));
		put(root, { ".gitattributes": "*.txt filter=evil diff=evil\n" });
		await w.git(root, "config", "filter.evil.clean", program("clean.sh", marker("filter-clean"), "cat"));
		await w.git(root, "config", "filter.evil.smudge", program("smudge.sh", marker("filter-smudge"), "cat"));
		await w.git(root, "config", "diff.evil.textconv", program("textconv.sh", marker("textconv"), 'cat "$1"'));
		await w.git(root, "config", "diff.external", program("external.sh", marker("diff-external")));

		return markers;
	}

	for (const variant of ["default hooks directory", "core.hooksPath"] as const) {
		test(`never runs a hook, program or filter of the repository (${variant})`, async () => {
			const root = await w.repo("hostile", { "a.txt": "a\n", "b.txt": "b\n" });
			const hooksDir = variant === "core.hooksPath" ? join(w.dir, "evil-hooks") : join(root, ".git", "hooks");
			if (variant === "core.hooksPath") {
				mkdirSync(hooksDir, { recursive: true });
				await w.git(root, "config", "core.hooksPath", hooksDir);
			}
			const markers = await plant(root, hooksDir);
			await w.git(root, "add", ".gitattributes");
			await w.git(
				root,
				"-c",
				"commit.gpgsign=false",
				"-c",
				`core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
				"commit",
				"-q",
				"-m",
				"attrs",
			);
			for (const marker of Object.values(markers)) rmSync(marker, { force: true });

			// Control: the plain git a careless daemon would run really does execute every one of them (on a copy).
			const copy = join(w.dir, "control");
			cpSync(root, copy, { recursive: true });
			writeFileSync(join(copy, "a.txt"), "touched\n");
			writeFileSync(join(copy, "fresh.txt"), "fresh\n");
			await w.gitRun(copy, {}, "-c", "commit.gpgsign=false", "commit", "-q", "-a", "-m", "control");
			await w.gitRun(copy, {}, "commit", "-q", "--allow-empty", "-m", "signed control");
			await w.gitRun(copy, {}, "add", "-A");
			await w.gitRun(copy, {}, "checkout", "-q", "-b", "control");
			await w.gitRun(copy, {}, "worktree", "add", "-q", join(w.dir, "control-wt"));
			await w.gitRun(copy, {}, "status");
			await w.gitRun(copy, {}, "diff", "HEAD~1");
			await w.gitRun(copy, {}, "log", "-p", "-1");
			for (const [name, marker] of Object.entries(markers)) {
				if (name === "hook-pre-auto-gc" || name === "hook-post-merge" || name === "post-index-change") continue; // not reached by the commands above
				expect(exists(marker), `control: ${name} ran under plain git`).toBe(true);
			}
			for (const marker of Object.values(markers)) rmSync(marker, { force: true });

			// The handoff, end to end in the hostile repository: nothing runs.
			writeFileSync(join(root, "a.txt"), "changed\n");
			put(root, { "fresh.txt": "fresh\n", "dir/x.txt": "x\n" });
			await inspectRepo(root, LIMITS, w.ctx);
			const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
			expect(result.carried.paths).toBe(3);
			const plan = await planNewWorktree(root, "hostile", THREAD, {}, w.ctx);
			const records: WorkspaceRecord[] = [];
			const created = await createWorkspace(
				{
					opId: "op-hostile",
					threadId: THREAD,
					projectRoot: root,
					choice: { mode: "new" },
					base: result.base,
					commit: result.commit,
					indexCommit: result.indexCommit,
					plan,
					onRecord: r => void records.push(r),
				},
				w.ctx,
			);
			expect(readFileSync(join(created.record.worktree, "a.txt"), "utf8")).toBe("changed\n");
			await listTargetWorktrees(root, result.base.commit, {}, w.ctx);
			const bundle = join(w.dir, "hostile.bundle");
			await createBundle(root, bundle, THREAD, [], 50 * 1024 * 1024, w.ctx);
			const clone = join(w.dir, "hostile-clone");
			await w.git(w.dir, "clone", "-q", "--no-local", root, clone);
			await verifyAndFetchBundle(clone, bundle, THREAD, w.ctx);
			await rollbackWorkspace(created.record, w.ctx);

			for (const [name, marker] of Object.entries(markers))
				expect(exists(marker), `${name} must not have run`).toBe(false);
		});
	}
});

describe("bundles", () => {
	/** A repository with a big incompressible file in its history, cloned; then the source moves on and has uncommitted work. */
	async function pair(): Promise<{ src: string; tgt: string; result: HandoffCommitResult; recent: string[] }> {
		const src = await w.repo("src", { "big.bin": randomBytes(300_000), "a.txt": "a\n" });
		await commitAll(src, "c2", { "a.txt": "a2\n" });
		await commitAll(src, "c3", { "a.txt": "a3\n" });
		const tgt = join(w.dir, "tgt");
		await w.git(w.dir, "clone", "-q", "--no-local", src, tgt);
		await commitAll(src, "c4 (not on the target)", { "a.txt": "a4\n" });
		put(src, { "a.txt": "a4 + dirty\n", "new.txt": "new\n" });
		const result = await createHandoffCommit(src, THREAD, LIMITS, w.ctx);
		const { recent } = await inspectRepo(src, LIMITS, w.ctx);
		return { src, tgt, result, recent };
	}

	test("a target with common history gets a thin bundle, strictly smaller than the full one", async () => {
		const { src, tgt, result, recent } = await pair();
		const have = await commitsPresent(tgt, recent, w.ctx);
		const refsBefore = (await w.git(tgt, "for-each-ref", "refs/heads", "refs/tags", "refs/remotes"))
			.split("\n")
			.filter(Boolean);
		expect(have).toEqual(recent.slice(1)); // everything but the newest commit, in the given order
		const before = await snapshot(w, src);
		const thin = await createBundle(src, join(w.dir, "thin.bundle"), THREAD, have, 50 * 1024 * 1024, w.ctx);
		const full = await createBundle(src, join(w.dir, "full.bundle"), THREAD, [], 50 * 1024 * 1024, w.ctx);
		expect(await snapshot(w, src)).toEqual(before); // creating bundles leaves the source alone
		expect(thin.full).toBe(false);
		expect(thin.prerequisites).toBeGreaterThanOrEqual(1);
		expect(full).toMatchObject({ full: true, prerequisites: 0 });
		expect(thin.bytes).toBeLessThan(full.bytes / 4);
		expect(full.bytes).toBeGreaterThan(300_000);
		expect(Bun.file(join(w.dir, "thin.bundle")).size).toBe(thin.bytes);

		const refs = await verifyAndFetchBundle(tgt, join(w.dir, "thin.bundle"), THREAD, w.ctx);
		expect(refs).toEqual([`refs/omp-web/handoff/${THREAD}`, `refs/omp-web/handoff-index/${THREAD}`]);
		expect(await omp(tgt)).toEqual([
			`refs/omp-web/handoff-index/${THREAD} ${result.indexCommit}`,
			`refs/omp-web/handoff/${THREAD} ${result.commit}`,
		]);
		expect((await w.git(tgt, "rev-parse", `${result.commit}^`)).trim()).toBe(result.base.commit);
		// no FETCH_HEAD was written, no tag or branch was touched
		expect(exists(join(tgt, ".git", "FETCH_HEAD"))).toBe(false);
		expect(
			(await w.git(tgt, "for-each-ref", "refs/heads", "refs/tags", "refs/remotes")).split("\n").filter(Boolean),
		).toEqual(refsBefore);
	});

	test("a target without the commits gets a full bundle", async () => {
		const { src, recent, result } = await pair();
		const other = await w.repo("unrelated", { "other.txt": "other\n" });
		expect(await commitsPresent(other, recent, w.ctx)).toEqual([]);
		const bundle = await createBundle(src, join(w.dir, "full.bundle"), THREAD, [], 50 * 1024 * 1024, w.ctx);
		expect(bundle.full).toBe(true);
		await verifyAndFetchBundle(other, join(w.dir, "full.bundle"), THREAD, w.ctx);
		expect((await omp(other)).length).toBe(2);
		expect((await w.git(other, "rev-parse", result.commit)).trim()).toBe(result.commit);
	});

	test("commitsPresent: only commits the repository has completely, reachable from a ref; input order kept; ids validated", async () => {
		const { tgt, recent } = await pair();
		const absent = "1".repeat(40);
		const shuffled = [recent[2]!, absent, recent[1]!, recent[3]!];
		expect(await commitsPresent(tgt, shuffled, w.ctx)).toEqual([recent[2]!, recent[1]!, recent[3]!]);
		expect(await commitsPresent(tgt, [], w.ctx)).toEqual([]);
		await expect(commitsPresent(tgt, ["not-an-id"], w.ctx)).rejects.toBeInstanceOf(HandoffGitError);
		await expect(commitsPresent(tgt, ["--all"], w.ctx)).rejects.toBeInstanceOf(HandoffGitError);
		// an object that exists but hangs off no ref (an interrupted or pruned history) is not claimed
		const loose = await commitAll(tgt, "dangling", { "d.txt": "d\n" });
		await w.git(tgt, "reset", "-q", "--hard", "HEAD~1");
		await w.git(tgt, "reflog", "expire", "--expire=now", "--all");
		expect(await commitsPresent(tgt, [loose, recent[1]!], w.ctx)).toEqual([recent[1]!]);
	});

	test("a shallow repository claims no commits (a bundle against it would be unsound)", async () => {
		const { src, recent } = await pair();
		const shallow = join(w.dir, "shallow");
		await w.git(w.dir, "clone", "-q", "--no-local", "--depth", "1", src, shallow);
		expect(await commitsPresent(shallow, recent, w.ctx)).toEqual([]);
		expect((await inspectRepo(shallow, LIMITS, w.ctx)).shallow).toBe(true);
	});

	test("a damaged bundle, and a thin bundle on a repository without its prerequisites, leave no ref behind", async () => {
		const { src, tgt, recent } = await pair();
		const other = await w.repo("lacking", { "other.txt": "o\n" });
		const have = await commitsPresent(tgt, recent, w.ctx);
		await createBundle(src, join(w.dir, "thin.bundle"), THREAD, have, 50 * 1024 * 1024, w.ctx);
		const error = await failure(verifyAndFetchBundle(other, join(w.dir, "thin.bundle"), THREAD, w.ctx));
		expect(error.kind).toBe("refused");
		expect(error.message).toContain("does not apply");
		expect(await omp(other)).toEqual([]);

		await createBundle(src, join(w.dir, "full.bundle"), THREAD, [], 50 * 1024 * 1024, w.ctx);
		const bytes = readFileSync(join(w.dir, "full.bundle"));
		const damaged = Buffer.from(bytes);
		damaged[Math.floor(damaged.length * 0.6)] ^= 0xff;
		writeFileSync(join(w.dir, "damaged.bundle"), damaged);
		await expect(verifyAndFetchBundle(other, join(w.dir, "damaged.bundle"), THREAD, w.ctx)).rejects.toBeInstanceOf(
			HandoffGitError,
		);
		expect(await omp(other)).toEqual([]);
		writeFileSync(join(w.dir, "cut.bundle"), bytes.subarray(0, Math.floor(bytes.length / 2)));
		await expect(verifyAndFetchBundle(other, join(w.dir, "cut.bundle"), THREAD, w.ctx)).rejects.toBeInstanceOf(
			HandoffGitError,
		);
		writeFileSync(join(w.dir, "junk.bundle"), "this is not a bundle");
		await expect(verifyAndFetchBundle(other, join(w.dir, "junk.bundle"), THREAD, w.ctx)).rejects.toBeInstanceOf(
			HandoffGitError,
		);
		expect(await omp(other)).toEqual([]);
		// a bundle of another thread does not hold this thread's commit
		const wrong = await failure(verifyAndFetchBundle(other, join(w.dir, "full.bundle"), "another-thread", w.ctx));
		expect(wrong.kind).toBe("refused");
		expect(await omp(other)).toEqual([]);
	});

	test("the size cap refuses with MiB numbers, before and after creating, and leaves no file", async () => {
		const { src } = await pair();
		const huge = join(w.dir, "huge.bundle");
		const hopeless = await failure(createBundle(src, huge, THREAD, [], 100_000, w.ctx));
		expect(hopeless.kind).toBe("refused");
		expect(hopeless.message).toMatch(/about \d+\.\d MiB, over the 0\.1 MiB limit/);
		expect(exists(huge)).toBe(false);
		const over = await failure(createBundle(src, huge, THREAD, [], 200_000, w.ctx));
		expect(over.kind).toBe("refused");
		expect(over.message).toMatch(/is \d+\.\d MiB, over the 0\.2 MiB limit/);
		expect(exists(huge)).toBe(false);
		expect(exists(`${huge}.lock`)).toBe(false);
		const ok = await createBundle(src, huge, THREAD, [], 1024 * 1024, w.ctx);
		expect(ok.bytes).toBeGreaterThan(300_000);
	});

	test("createBundle needs a handoff commit, valid ids, and ignores haves the source does not know", async () => {
		const root = await w.repo("nobundle");
		const out = join(w.dir, "n.bundle");
		await expect(createBundle(root, out, THREAD, [], 1e6, w.ctx)).rejects.toBeInstanceOf(HandoffGitError);
		put(root, { "x.txt": "x\n" });
		await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		await expect(createBundle(root, out, THREAD, ["nope"], 1e6, w.ctx)).rejects.toBeInstanceOf(HandoffGitError);
		const result = await createBundle(root, out, THREAD, ["2".repeat(40)], 1e6, w.ctx);
		expect(result.full).toBe(true);
	});
});

describe("target worktrees", () => {
	async function projectWithWorktrees(): Promise<{ root: string; head: string; paths: Record<string, string> }> {
		const root = await w.repo("proj", { "f.txt": "f\n", "dir/g.txt": "g\n" });
		const older = (await w.git(root, "rev-parse", "HEAD")).trim();
		const head = await commitAll(root, "second", { "f.txt": "f2\n" });
		const paths: Record<string, string> = {};
		const add = async (name: string, ...args: string[]): Promise<string> => {
			paths[name] = join(w.dir, `wt-${name}`);
			await w.git(root, "worktree", "add", "-q", ...args.map(a => (a === "PATH" ? paths[name]! : a)));
			return paths[name]!;
		};
		await add("clean", "-b", "clean-b", "PATH");
		await add("dirty", "-b", "dirty-b", "PATH");
		writeFileSync(join(paths.dirty!, "f.txt"), "dirty\n");
		await add("untracked", "-b", "untracked-b", "PATH");
		writeFileSync(join(paths.untracked!, "stray.txt"), "stray\n");
		await add("old", "--detach", "PATH", older);
		await add("locked", "-b", "locked-b", "PATH");
		await w.git(root, "worktree", "lock", "--reason", "busy", paths.locked!);
		await add("gone", "-b", "gone-b", "PATH");
		rmSync(paths.gone!, { recursive: true });
		return { root, head, paths };
	}

	test("eligibility: clean, at the source's commit, unlocked, not the source itself", async () => {
		const { root, head, paths } = await projectWithWorktrees();
		const listed = await listTargetWorktrees(root, head, { sourceWorktree: root }, w.ctx);
		const by = (path: string) => listed.find(entry => entry.path === path)!;
		expect(listed).toHaveLength(7);
		expect(by(root)).toMatchObject({ eligible: false, isSource: true, branch: "main", head });
		expect(by(root).reason).toContain("source's own");
		expect(by(paths.clean!)).toMatchObject({ eligible: true, isSource: false, branch: "clean-b", head });
		expect(by(paths.clean!).reason).toBeUndefined();
		expect(by(paths.dirty!).eligible).toBe(false);
		expect(by(paths.dirty!).reason).toContain("uncommitted");
		expect(by(paths.untracked!).eligible).toBe(false);
		expect(by(paths.untracked!).reason).toMatch(/1 untracked/);
		expect(by(paths.old!)).toMatchObject({ eligible: false, branch: null });
		expect(by(paths.old!).reason).toMatch(/is at [0-9a-f]{8}, the source is at/);
		expect(by(paths.locked!).eligible).toBe(false);
		expect(by(paths.locked!).reason).toContain("locked (busy)");
		expect(by(paths.gone!).eligible).toBe(false);
		expect(by(paths.gone!).reason).toContain("missing");
		// without a source worktree the main one is just another candidate
		const plain = await listTargetWorktrees(root, head, {}, w.ctx);
		expect(plain.find(entry => entry.path === root)).toMatchObject({ eligible: true, isSource: false });
	});

	test("a worktree with a staged change, or mid-operation, is not eligible", async () => {
		const { root, head, paths } = await projectWithWorktrees();
		await w.git(paths.clean!, "rm", "-q", "--cached", "f.txt");
		const listed = await listTargetWorktrees(root, head, {}, w.ctx);
		expect(listed.find(entry => entry.path === paths.clean)!.eligible).toBe(false);
	});

	test("naming a new worktree: free path and branch, suffixes on collision, nothing created", async () => {
		const root = await w.repo("naming");
		const plan = await planNewWorktree(root, "naming", "abcdef0123456789", {}, w.ctx);
		expect(plan).toEqual({ path: join(w.dir, "naming.omp-worktrees", "abcdef01"), branch: "omp-web/abcdef01" });
		expect(exists(join(w.dir, "naming.omp-worktrees"))).toBe(false);
		// the branch exists: suffix
		await w.git(root, "branch", "omp-web/abcdef01");
		expect((await planNewWorktree(root, "naming", "abcdef0123456789", {}, w.ctx)).branch).toBe("omp-web/abcdef01-2");
		// the directory exists too: next suffix
		Bun.spawnSync(["mkdir", "-p", join(w.dir, "naming.omp-worktrees", "abcdef01-2")]);
		const third = await planNewWorktree(root, "naming", "abcdef0123456789", {}, w.ctx);
		expect(third).toEqual({ path: join(w.dir, "naming.omp-worktrees", "abcdef01-3"), branch: "omp-web/abcdef01-3" });
		// a configured directory: <worktreesDir>/<project name>/<short thread>
		const configured = await planNewWorktree(
			root,
			"My Project/../x",
			"t-1",
			{ worktreesDir: join(w.dir, "trees") },
			w.ctx,
		);
		expect(configured.path).toBe(join(w.dir, "trees", "My_Project_.._x", "t-1"));
		expect(configured.branch).toBe("omp-web/t-1");
		expect(exists(join(w.dir, "trees"))).toBe(false);
		await expect(planNewWorktree(root, "naming", "../x", {}, w.ctx)).rejects.toBeInstanceOf(HandoffGitError);
	});

	test("a branch named omp-web blocks the omp-web/ namespace and is reported", async () => {
		const root = await w.repo("blocked");
		await w.git(root, "branch", "omp-web");
		const error = await failure(planNewWorktree(root, "blocked", THREAD, {}, w.ctx));
		expect(error.kind).toBe("refused");
	});
});

describe("materialization", () => {
	/** The same working tree on both sides: file bytes, modes, link targets, and git's own view of staged / unstaged. */
	async function expectSameWorkspace(src: string, target: string, ignored: (p: string) => boolean): Promise<void> {
		expect(treeHash(target, ignored)).toBe(treeHash(src, ignored));
		expect(await statusEntries(w, target)).toEqual(await statusEntries(w, src));
	}

	test("a new worktree in the same repository (same-machine switch, no bundle) equals the source, staged/unstaged split included", async () => {
		const d = await dirtyRepo(w);
		const result = await createHandoffCommit(d.root, THREAD, LIMITS, w.ctx);
		const before = await snapshot(w, d.root);
		const plan = await planNewWorktree(d.root, "dirty", THREAD, {}, w.ctx);
		const records: WorkspaceRecord[] = [];
		const created = await createWorkspace(
			{
				opId: "op-1",
				threadId: THREAD,
				projectRoot: d.root,
				choice: { mode: "new" },
				base: result.base,
				commit: result.commit,
				indexCommit: result.indexCommit,
				plan,
				onRecord: r => void records.push(r),
			},
			w.ctx,
		);

		expect(created.record.worktree).toBe(plan.path);
		expect(created.record.branch).toBe(plan.branch);
		expect(created.record).toMatchObject({
			createdWorktree: true,
			createdBranch: true,
			startCommit: result.base.commit,
			opId: "op-1",
			threadId: THREAD,
		});
		expect(created.applied).toEqual({ written: 15, removed: 3 });
		// the branch is new, at the base commit; the source's branch did not move
		expect((await w.git(d.root, "rev-parse", `refs/heads/${plan.branch}`)).trim()).toBe(result.base.commit);
		expect((await w.git(plan.path, "symbolic-ref", "--short", "HEAD")).trim()).toBe(plan.branch);
		const marker = JSON.parse(readFileSync(created.record.marker!, "utf8")) as { opId: string; branch: string };
		expect(marker).toMatchObject({ opId: "op-1", branch: plan.branch });
		expect(created.record.marker).toBe(
			join((await w.git(plan.path, "rev-parse", "--absolute-git-dir")).trim(), "omp-web-handoff"),
		);

		await expectSameWorkspace(d.root, plan.path, d.ignored);
		const entries = await statusEntries(w, plan.path);
		expect(entries.some(line => line.startsWith("2 R. ") && line.endsWith("renamed.txt <- rename-me.txt"))).toBe(
			true,
		);
		expect(entries).toContain("1 MM b.txt");
		expect(entries).toContain("1 M. staged-mod.txt");
		expect(entries).toContain("1 .M a.txt");
		expect(entries).toContain(process.platform === "win32" ? "1 T. tc.txt" : "1 .T tc.txt");
		expect(entries).toContain("1 .D del.txt");
		expect(entries).toContain("1 D. del2.txt");
		expect(entries).toContain("1 A. staged-add.txt");
		expect(entries).toContain(process.platform === "win32" ? "1 M. mode.txt" : "1 .M mode.txt");
		expect(entries).toContain("? bin/run.sh");
		// the ignored files and the stash stayed where they were
		expect(exists(join(plan.path, "debug.log"))).toBe(false);
		expect((await w.git(plan.path, "stash", "list")).includes("stash@{0}")).toBe(true); // shared by the repository, untouched

		// the source is unchanged except for the new branch
		const after = await snapshot(w, d.root);
		expect({ ...after, refs: "" }).toEqual({ ...before, refs: "" });
		expect(
			after.refs
				.split("\n")
				.filter(l => !l.includes("omp-web/"))
				.join("\n")
				.trim(),
		).toBe(before.refs.trim());
		// the record was persisted before the worktree existed, and again after each phase
		expect(records.length).toBeGreaterThanOrEqual(4);
		expect(records[0]).toMatchObject({ createdWorktree: true, createdBranch: true, marker: null, written: [] });
		expect(records[0]!.worktree).toBe(plan.path);
		expect(records.at(-1)).toEqual(created.record);
		expect(records.some(r => r.marker !== null && r.written.length === 0)).toBe(true);
	});

	test("no staged state recorded: every change arrives unstaged", async () => {
		const root = await w.repo("unstaged-only", { "a.txt": "a\n" });
		put(root, { "a.txt": "changed\n", "n.txt": "n\n" });
		await w.git(root, "add", "a.txt");
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		const plan = await planNewWorktree(root, "p", THREAD, {}, w.ctx);
		await createWorkspace(
			{
				opId: "op-2",
				threadId: THREAD,
				projectRoot: root,
				choice: { mode: "new" },
				base: result.base,
				commit: result.commit,
				indexCommit: null,
				plan,
				onRecord: () => {},
			},
			w.ctx,
		);
		expect(await statusEntries(w, plan.path)).toEqual(["1 .M a.txt", "? n.txt"]);
		expect(readFileSync(join(plan.path, "a.txt"), "utf8")).toBe("changed\n");
	});

	test("across repositories: a thin bundle fetched into a different clone materializes the same workspace", async () => {
		const src = await w.repo("origin", { "big.bin": randomBytes(100_000), "a.txt": "a\n" });
		const tgt = join(w.dir, "clone");
		await w.git(w.dir, "clone", "-q", "--no-local", src, tgt);
		await commitAll(src, "ahead", { "a.txt": "ahead\n" });
		put(src, { "a.txt": "ahead and dirty\n", "new/deep/file.txt": "deep\n" });
		if (process.platform === "win32") {
			await w.git(src, "update-index", "--chmod=+x", "big.bin");
			put(src, { alias: "a.txt" });
		} else {
			chmodSync(join(src, "big.bin"), 0o755);
			symlinkSync("a.txt", join(src, "alias"));
		}
		const result = await createHandoffCommit(src, THREAD, LIMITS, w.ctx);
		const { recent } = await inspectRepo(src, LIMITS, w.ctx);
		const have = await commitsPresent(tgt, recent, w.ctx);
		expect(have).toHaveLength(1);
		const bundle = await createBundle(src, join(w.dir, "x.bundle"), THREAD, have, 10 * 1024 * 1024, w.ctx);
		expect(bundle.full).toBe(false);
		await verifyAndFetchBundle(tgt, join(w.dir, "x.bundle"), THREAD, w.ctx);
		const created = await createWorkspace(
			{
				opId: "op-3",
				threadId: THREAD,
				projectRoot: tgt,
				choice: { mode: "new" },
				base: result.base,
				commit: result.commit,
				indexCommit: result.indexCommit,
				onRecord: () => {},
			},
			w.ctx,
		);
		expect(created.record.worktree).toBe(join(w.dir, "clone.omp-worktrees", "thread-1"));
		await expectSameWorkspace(src, created.record.worktree, () => false);
		if (process.platform === "win32") {
			expect((await indexLines(created.record.worktree)).find(line => line.endsWith(" big.bin"))).toStartWith(
				"100755 ",
			);
			expect(readFileSync(join(created.record.worktree, "alias"), "utf8")).toBe("a.txt");
		} else {
			expect(statSync(join(created.record.worktree, "big.bin")).mode & 0o111).not.toBe(0);
			expect(readlinkSync(join(created.record.worktree, "alias"))).toBe("a.txt");
		}
	});

	test("an existing clean worktree receives the workspace; rollback restores exactly what was touched (and is idempotent)", async () => {
		const d = await dirtyRepo(w);
		const target = join(w.dir, "wt-existing");
		await w.git(d.root, "worktree", "add", "-q", "-b", "existing-b", target);
		const cleanHash = treeHash(target);
		put(target, { "debug.log": "ignored, mine\n" }); // an ignored file elsewhere stays untouched
		const result = await createHandoffCommit(d.root, THREAD, LIMITS, w.ctx);
		const sentinelWt = join(w.dir, "wt-sentinel");
		await w.git(d.root, "worktree", "add", "-q", "-b", "sentinel-b", sentinelWt);

		const records: WorkspaceRecord[] = [];
		const created = await createWorkspace(
			{
				opId: "op-4",
				threadId: THREAD,
				projectRoot: d.root,
				choice: { mode: "existing", worktree: target },
				base: result.base,
				commit: result.commit,
				indexCommit: result.indexCommit,
				onRecord: r => void records.push(r),
			},
			w.ctx,
		);
		expect(created.record).toMatchObject({
			createdWorktree: false,
			createdBranch: false,
			marker: null,
			branch: "existing-b",
			worktree: target,
		});
		expect(created.record.written.length).toBe(15);
		expect(created.record.removed.map(r => r.path).sort()).toEqual(["del.txt", "del2.txt", "rename-me.txt"]);
		expect(created.record.removed.every(r => r.restoreBlob !== null && r.mode === "100644")).toBe(true);
		expect(created.record.indexReplaced).toBe(true);
		await expectSameWorkspace(d.root, target, d.ignored);

		const first = await rollbackWorkspace(created.record, w.ctx);
		expect(first.leftovers).toEqual([]);
		expect(first.removed).toContain(`ref refs/omp-web/handoff/${THREAD}`);
		expect(first.removed.some(line => line.startsWith("index of "))).toBe(true);
		expect(first.removed).toContain("restored a.txt");
		expect(first.removed).toContain("file new.txt (written by the handoff)");
		expect(await w.git(target, "status", "--porcelain=v2", "-z", "--untracked-files=all")).toBe("");
		expect(treeHash(target, p => p === "debug.log")).toBe(cleanHash);
		expect(readFileSync(join(target, "debug.log"), "utf8")).toBe("ignored, mine\n");
		expect(await omp(d.root)).toEqual([]);
		// the other worktree, the branch of the existing worktree and the source are untouched
		expect((await w.git(d.root, "worktree", "list")).includes("wt-sentinel")).toBe(true);
		expect((await w.git(d.root, "rev-parse", "refs/heads/existing-b")).trim()).toBe(result.base.commit);
		expect(treeHash(sentinelWt)).toBe(cleanHash);
		const second = await rollbackWorkspace(created.record, w.ctx);
		expect(second).toEqual({ removed: [], leftovers: [] });
	});

	test("a worktree that is not eligible is refused with its reason, nothing touched", async () => {
		const root = await w.repo("refuse-existing", { "f.txt": "f\n" });
		put(root, { "f.txt": "src change\n" });
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		const dirty = join(w.dir, "wt-dirty");
		await w.git(root, "worktree", "add", "-q", "-b", "dirty-b", dirty);
		writeFileSync(join(dirty, "f.txt"), "their work\n");
		const error = await failure(
			createWorkspace(
				{
					opId: "op-5",
					threadId: THREAD,
					projectRoot: root,
					choice: { mode: "existing", worktree: dirty },
					base: result.base,
					commit: result.commit,
					indexCommit: result.indexCommit,
					onRecord: () => {},
				},
				w.ctx,
			),
		);
		expect(error.kind).toBe("refused");
		expect(error.message).toContain("uncommitted");
		expect(readFileSync(join(dirty, "f.txt"), "utf8")).toBe("their work\n");
		const notAWorktree = await failure(
			createWorkspace(
				{
					opId: "op-5",
					threadId: THREAD,
					projectRoot: root,
					choice: { mode: "existing", worktree: w.dir },
					base: result.base,
					commit: result.commit,
					indexCommit: null,
					onRecord: () => {},
				},
				w.ctx,
			),
		);
		expect(notAWorktree.message).toContain("not a worktree");
	});

	test("an ignored file in the way of a carried path stops the workspace before anything is written", async () => {
		const root = await w.repo("collision", { ".gitignore": "*.cache\n", "a.txt": "a\n" });
		const target = join(w.dir, "wt-collide");
		await w.git(root, "worktree", "add", "-q", "-b", "collide-b", target);
		writeFileSync(join(target, "x.cache"), "precious ignored data\n");
		expect(await w.git(target, "status", "--porcelain")).toBe(""); // still "clean"
		writeFileSync(join(root, ".gitignore"), "");
		put(root, { "x.cache": "carried\n", "a.txt": "changed\n" });
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		const records: WorkspaceRecord[] = [];
		const error = await failure(
			createWorkspace(
				{
					opId: "op-6",
					threadId: THREAD,
					projectRoot: root,
					choice: { mode: "existing", worktree: target },
					base: result.base,
					commit: result.commit,
					indexCommit: result.indexCommit,
					onRecord: r => void records.push(r),
				},
				w.ctx,
			),
		);
		expect(error.kind).toBe("refused");
		expect(error.message).toContain("x.cache");
		expect(readFileSync(join(target, "x.cache"), "utf8")).toBe("precious ignored data\n");
		expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("a\n");
		// the record the failure carries rolls back cleanly (nothing to restore) and the file survives
		expect(error.record?.written).toEqual([]);
		expect(await rollbackWorkspace(error.record!, w.ctx)).toEqual({
			removed: [`ref refs/omp-web/handoff/${THREAD}`, `ref refs/omp-web/handoff-index/${THREAD}`],
			leftovers: [],
		});
		expect(readFileSync(join(target, "x.cache"), "utf8")).toBe("precious ignored data\n");
	});

	/** A commit whose tree holds `file` under the nested directories `segments` (`git mktree` accepts names `update-index` refuses). */
	async function craft(root: string, segments: readonly string[], file: string): Promise<string> {
		const mktree = async (line: string): Promise<string> => {
			const proc = Bun.spawn(["git", "-C", root, "mktree"], {
				stdin: new Blob([line]),
				stdout: "pipe",
				env: { ...process.env, ...w.env },
			});
			return (await new Response(proc.stdout).text()).trim();
		};
		const blob = (await w.git(root, "rev-parse", "HEAD:a.txt")).trim();
		let tree = await mktree(`100644 blob ${blob}\t${file}\n`);
		for (const segment of segments.toReversed().slice(0, -1))
			tree = await mktree(`040000 tree ${tree}\t${segment}\n`);
		const top = await mktree(`100644 blob ${blob}\ta.txt\n040000 tree ${tree}\t${segments[0]}\n`);
		return (await w.git(root, "commit-tree", top, "-p", "HEAD", "-m", "crafted")).trim();
	}

	for (const [name, segments, file] of [
		["into .git", [".git", "hooks"], "post-checkout"],
		["into .GIT (case-insensitive file systems)", [".GIT", "hooks"], "post-checkout"],
		["outside through ..", ["..", "escaped"], "x.txt"],
	] as const) {
		test(`a crafted commit cannot write ${name}`, async () => {
			const root = await w.repo("hostile-tree", { "a.txt": "a\n" });
			const head = (await w.git(root, "rev-parse", "HEAD")).trim();
			const bad = await craft(root, segments, file);
			const plan = await planNewWorktree(root, "p", "evil-1", {}, w.ctx);
			const error = await failure(
				createWorkspace(
					{
						opId: "op-7",
						threadId: "evil-1",
						projectRoot: root,
						choice: { mode: "new" },
						base: { commit: head, branch: "main" },
						commit: bad,
						indexCommit: null,
						plan,
						onRecord: () => {},
					},
					w.ctx,
				),
			);
			expect(error.message).toContain("unsafe path");
			expect(exists(join(w.dir, "escaped"))).toBe(false);
			expect(exists(join(plan.path, ".git", "hooks", "post-checkout"))).toBe(false);
			if (process.platform === "win32") {
				// The complete tree is rejected before a worktree or operation record exists.
				expect(error.record).toBeUndefined();
				expect(exists(plan.path)).toBe(false);
				expect(await w.git(root, "for-each-ref", `refs/heads/${plan.branch}`)).toBe("");
			} else {
				const rolled = await rollbackWorkspace(error.record!, w.ctx);
				expect(rolled.leftovers).toEqual([]);
				expect(exists(plan.path)).toBe(false);
			}
		});
	}

	test("a symlinked parent directory in the target is refused, never followed", async () => {
		const root = await w.repo("linkparent", { "a.txt": "a\n" });
		const outside = join(w.dir, "outside");
		mkdirSync(outside);
		const target = join(w.dir, "wt-link");
		await w.git(root, "worktree", "add", "-q", "-b", "link-b", target);
		put(root, { "sub/inside.txt": "payload\n" });
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		// the target's `sub` becomes a symlink to somewhere else, ignored by git through info/exclude so the worktree stays "clean"
		directoryLink(outside, join(target, "sub"));
		await w.git(root, "config", "--local", "core.excludesFile", process.platform === "win32" ? "NUL" : "/dev/null");
		writeFileSync(join(root, ".git", "info", "exclude"), "/sub\n");
		expect(await w.git(target, "status", "--porcelain")).toBe("");
		const error = await failure(
			createWorkspace(
				{
					opId: "op-8",
					threadId: THREAD,
					projectRoot: root,
					choice: { mode: "existing", worktree: target },
					base: result.base,
					commit: result.commit,
					indexCommit: null,
					onRecord: () => {},
				},
				w.ctx,
			),
		);
		expect(error.message).toMatch(/sub/);
		expect(readdirSync(outside)).toEqual([]);
	});
});

describe("creating and rolling back a new worktree", () => {
	async function made(): Promise<{
		root: string;
		result: HandoffCommitResult;
		record: WorkspaceRecord;
		plan: { path: string; branch: string };
		sentinel: string;
	}> {
		const root = await w.repo("rb", { "a.txt": "a\n" });
		put(root, { "a.txt": "changed\n", "n.txt": "n\n" });
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		const plan = await planNewWorktree(root, "rb", THREAD, {}, w.ctx);
		// a worktree and a branch of the test's own, next to the one the operation makes
		const sentinel = join(w.dir, "rb.omp-worktrees", "sentinel");
		Bun.spawnSync(["mkdir", "-p", join(w.dir, "rb.omp-worktrees")]);
		await w.git(root, "worktree", "add", "-q", "-b", "omp-web/sentinel", sentinel);
		const created = await createWorkspace(
			{
				opId: "op-rb",
				threadId: THREAD,
				projectRoot: root,
				choice: { mode: "new" },
				base: result.base,
				commit: result.commit,
				indexCommit: result.indexCommit,
				plan,
				onRecord: () => {},
			},
			w.ctx,
		);
		return { root, result, record: created.record, plan, sentinel };
	}

	test("removes exactly the worktree, branch and refs the operation made; a sentinel worktree and branch survive; idempotent", async () => {
		const { root, record, plan, sentinel } = await made();
		expect(exists(plan.path)).toBe(true);
		const outcome = await rollbackWorkspace(record, w.ctx);
		expect(outcome.leftovers).toEqual([]);
		expect(outcome.removed).toEqual([
			`worktree ${plan.path}`,
			`branch ${plan.branch}`,
			`ref refs/omp-web/handoff/${THREAD}`,
			`ref refs/omp-web/handoff-index/${THREAD}`,
		]);
		expect(exists(plan.path)).toBe(false);
		expect((await w.git(root, "branch", "--list", plan.branch)).trim()).toBe("");
		expect(await omp(root)).toEqual([]);
		const listed = await w.git(root, "worktree", "list", "--porcelain");
		expect(listed).toContain(posixPath(sentinel));
		expect(listed).not.toContain(posixPath(plan.path));
		expect((await w.git(root, "branch", "--list", "omp-web/sentinel")).trim()).toContain("omp-web/sentinel");
		expect(exists(join(sentinel, "a.txt"))).toBe(true);
		expect(exists(join(root, ".git", "worktrees", basenameOf(plan.path)))).toBe(false);
		// idempotent
		expect(await rollbackWorkspace(record, w.ctx)).toEqual({ removed: [], leftovers: [] });
	});

	test("removes the directories it created above the worktree only when empty", async () => {
		const root = await w.repo("dirs", { "a.txt": "a\n" });
		put(root, { "b.txt": "b\n" });
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		const plan = { path: join(w.dir, "deep", "er", "wt"), branch: "omp-web/wt" };
		const created = await createWorkspace(
			{
				opId: "op-dirs",
				threadId: THREAD,
				projectRoot: root,
				choice: { mode: "new" },
				base: result.base,
				commit: result.commit,
				indexCommit: result.indexCommit,
				plan,
				onRecord: () => {},
			},
			w.ctx,
		);
		expect(created.record.createdDirs).toEqual([join(w.dir, "deep"), join(w.dir, "deep", "er")]);
		const outcome = await rollbackWorkspace(created.record, w.ctx);
		expect(outcome.leftovers).toEqual([]);
		expect(exists(join(w.dir, "deep"))).toBe(false);

		const second = await createWorkspace(
			{
				opId: "op-dirs2",
				threadId: THREAD,
				projectRoot: root,
				choice: { mode: "new" },
				base: result.base,
				commit: result.commit,
				indexCommit: result.indexCommit,
				plan,
				onRecord: () => {},
			},
			w.ctx,
		);
		writeFileSync(join(w.dir, "deep", "er", "someone-elses.txt"), "keep\n");
		const kept = await rollbackWorkspace(second.record, w.ctx);
		expect(kept.leftovers).toEqual([]);
		expect(exists(join(w.dir, "deep", "er", "someone-elses.txt"))).toBe(true);
		expect(exists(plan.path)).toBe(false);
	});

	test("refuses (leftovers) when the marker is missing or belongs to another operation", async () => {
		const { root, record, plan } = await made();
		const foreign = await rollbackWorkspace({ ...record, opId: "op-someone-else" }, w.ctx);
		expect(foreign.removed).toEqual([
			`ref refs/omp-web/handoff/${THREAD}`,
			`ref refs/omp-web/handoff-index/${THREAD}`,
		]);
		expect(foreign.leftovers).toEqual([
			expect.stringContaining(
				`worktree ${plan.path}: not removed, its marker file is missing or belongs to another operation`,
			),
			expect.stringContaining(`branch ${plan.branch}`),
		]);
		expect(exists(plan.path)).toBe(true);
		expect((await w.git(root, "branch", "--list", plan.branch)).trim()).toContain(plan.branch);

		rmSync(record.marker!);
		const missing = await rollbackWorkspace(record, w.ctx);
		expect(missing.leftovers.length).toBe(2);
		expect(exists(plan.path)).toBe(true);
		// a record without any marker proves nothing either
		const bare = await rollbackWorkspace({ ...record, marker: null }, w.ctx);
		expect(bare.leftovers.length).toBe(2);
		expect(exists(plan.path)).toBe(true);
	});

	test("refuses when work was committed in the worktree since", async () => {
		const { root, record, plan } = await made();
		await commitAll(plan.path, "their work", { "mine.txt": "mine\n" });
		const outcome = await rollbackWorkspace(record, w.ctx);
		expect(outcome.leftovers[0]).toContain("its HEAD moved");
		expect(exists(join(plan.path, "mine.txt"))).toBe(true);
		expect((await w.git(root, "branch", "--list", plan.branch)).trim()).toContain(plan.branch);
	});

	test("never removes a worktree at the recorded path that is not the recorded one", async () => {
		const { root, record, plan } = await made();
		// the created worktree vanished and somebody else's directory stands at its path
		await w.git(root, "worktree", "remove", "--force", plan.path);
		Bun.spawnSync(["mkdir", "-p", plan.path]);
		writeFileSync(join(plan.path, "theirs.txt"), "theirs\n");
		const outcome = await rollbackWorkspace(record, w.ctx);
		expect(exists(join(plan.path, "theirs.txt"))).toBe(true);
		expect(outcome.leftovers.length).toBeGreaterThan(0);
	});

	test("a worktree whose directory is gone loses its (marked) entry, and nothing else", async () => {
		const { root, record, plan, sentinel } = await made();
		rmSync(plan.path, { recursive: true });
		const outcome = await rollbackWorkspace(record, w.ctx);
		expect(outcome.leftovers).toEqual([]);
		expect(outcome.removed.some(line => line.startsWith("worktree entry "))).toBe(true);
		expect(outcome.removed).toContain(`branch ${plan.branch}`);
		const listed = await w.git(root, "worktree", "list", "--porcelain");
		expect(listed).toContain(posixPath(sentinel));
		expect(listed).not.toContain(posixPath(plan.path));
	});

	test("never uses --force: an existing branch or directory stops the creation with nothing changed", async () => {
		const root = await w.repo("force", { "a.txt": "a\n" });
		put(root, { "b.txt": "b\n" });
		const result = await createHandoffCommit(root, THREAD, LIMITS, w.ctx);
		const args = {
			opId: "op-f",
			threadId: THREAD,
			projectRoot: root,
			choice: { mode: "new" } as const,
			base: result.base,
			commit: result.commit,
			indexCommit: result.indexCommit,
			onRecord: () => {},
		};
		await w.git(root, "branch", "omp-web/taken");
		const tip = (await w.git(root, "rev-parse", "omp-web/taken")).trim();
		const branchError = await failure(
			createWorkspace({ ...args, plan: { path: join(w.dir, "forced"), branch: "omp-web/taken" } }, w.ctx),
		);
		expect(branchError.kind).toBe("refused");
		expect(exists(join(w.dir, "forced"))).toBe(false);
		expect((await w.git(root, "rev-parse", "omp-web/taken")).trim()).toBe(tip);
		Bun.spawnSync(["mkdir", join(w.dir, "occupied")]);
		writeFileSync(join(w.dir, "occupied", "mine.txt"), "mine\n");
		const pathError = await failure(
			createWorkspace({ ...args, plan: { path: join(w.dir, "occupied"), branch: "omp-web/free" } }, w.ctx),
		);
		expect(pathError.kind).toBe("refused");
		expect(readFileSync(join(w.dir, "occupied", "mine.txt"), "utf8")).toBe("mine\n");
		expect((await w.git(root, "branch", "--list", "omp-web/free")).trim()).toBe("");
		// a rollback of the failure's record removes nothing of those (and drops the handoff refs only)
		const rolled = await rollbackWorkspace(branchError.record!, w.ctx);
		expect(rolled.leftovers).toEqual([]);
		expect((await w.git(root, "rev-parse", "omp-web/taken")).trim()).toBe(tip);
	});
});

function basenameOf(path: string): string {
	return path.split(/[\\/]/).pop()!;
}
