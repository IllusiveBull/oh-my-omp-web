import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { HandoffLimits, HandoffOpArgs, HandoffOpName, HandoffOpResult } from "@omp-web/protocol";
import { HandoffService, HandoffOpFailure } from "../src/handoff-service";
import { SessionManager, type SessionSpec } from "../src/manager";
import { ProjectRegistry } from "../src/projects";
import { createHandoffCommit } from "../src/handoff-git";
import { aclProblem } from "../src/file-acl";
import { FakeSource } from "./fake-source";
import { posixPath, writeExecutable } from "./fake-bin";
import { dirtyRepo, exists, snapshot, statusEntries, treeHash, world, type World } from "./handoff-git-fixtures";
import { assistant, user, writeSessionFile } from "./session-files";

const LIMITS: HandoffLimits = {
	maxFileBytes: 1 << 20,
	maxTotalBytes: 16 << 20,
	maxBundleBytes: 64 << 20,
	maxArchiveBytes: 64 << 20,
};
const SID = "01a1d235-fba4-7640-b01c-7cea4ff1c5c5";
const OP = "op000001";
const THREAD = "thread01";
setDefaultTimeout(60_000);

/** A stand-in for the `omp` binary: `session pack|unpack|moved` over plain copies, with failures injected through its environment. */
const FAKE_OMP = `#!/usr/bin/env bun
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const [, , group, action, ...rest] = process.argv;
const fail = process.env.FAKE_OMP_FAIL;
if (group !== "session") process.exit(2);
const flag = (name) => { const hit = rest.find(a => a.startsWith("--" + name + "=")); return hit ? hit.slice(name.length + 3) : undefined; };
const positional = rest.filter(a => !a.startsWith("--"));
if (fail === action) { process.stderr.write("error: injected failure of " + action + "\\n"); process.exit(1); }
if (action === "pack") {
	copyFileSync(positional[0], positional[1]);
	process.stdout.write(positional[1] + "\\n");
} else if (action === "unpack") {
	const lines = readFileSync(positional[0], "utf8").split("\\n");
	const header = JSON.parse(lines[1]);
	header.cwd = flag("cwd");
	header.previousSessionFiles = ["/tmp/omp-session-unpack-xyz/" + header.id + ".jsonl"];
	lines[1] = JSON.stringify(header);
	const dir = join(process.env.FAKE_OMP_SESSIONS, "bucket-" + Buffer.from(flag("cwd")).toString("hex").slice(-12));
	mkdirSync(dir, { recursive: true });
	const out = join(dir, "2026-11-13T00-00-00-000Z_" + header.id + ".jsonl");
	const body = lines.join("\\n").replace(/\\n+$/, "\\n") + JSON.stringify({ type: "custom_message", customType: "session-transfer", id: "arrive01", parentId: null, content: "moved here" }) + "\\n";
	writeFileSync(out, body);
	process.stderr.write("Unpacked session (" + header.id + ").\\n");
	process.stdout.write(out + "\\n");
} else if (action === "moved") {
	appendFileSync(positional[0], JSON.stringify({ type: "custom_message", customType: "session-transfer", id: "depart01", parentId: null, content: "moved to " + flag("to"), details: { kind: "departed", to: flag("to") } }) + "\\n");
}
`;

interface Side {
	name: string;
	repo: string;
	stateDir: string;
	sessionDir: string;
	manager: SessionManager;
	service: HandoffService;
	projects: ProjectRegistry;
	fakeEnv: Record<string, string>;
	sources: FakeSource[];
	hostedFile: string | null;
}

interface Rig {
	w: World;
	root: string;
	source: Side;
	target: Side;
	ompPath: string;
}

const rigs: Rig[] = [];
afterEach(async () => {
	for (const rig of rigs.splice(0)) {
		for (const side of [rig.source, rig.target]) {
			side.service.close();
			await side.manager.closeAll();
		}
		rig.w.dispose();
		rmSync(rig.root, { recursive: true, force: true });
	}
});

function stateFor(sessionFile: string | undefined): Partial<FakeSource["state"]> {
	return {
		sessionFile,
		model: { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" } as never,
		systemPrompt: ["static head", "volatile tail"],
		dumpTools: [{ name: "read", description: "reads", parameters: {} }],
		contextUsage: { tokens: 1234, contextWindow: 200000, percent: 1 } as never,
	};
}

async function makeSide(w: World, root: string, name: string, repo: string, ompPath: string): Promise<Side> {
	const stateDir = join(root, `${name}-state`);
	const sessionDir = join(root, `${name}-sessions`);
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	const projects = await ProjectRegistry.open(join(stateDir, "projects.json"));
	await projects.add(repo);
	const sources: FakeSource[] = [];
	const side = { sources, hostedFile: null } as unknown as Side;
	let forks = 0;
	const manager = new SessionManager({
		ompPath,
		sessionDir,
		resolveCwd: cwd => projects.resolveCwd(cwd),
		// A hosted session's FakeSource holds the lease until it is stopped.
		probeLeases: async () => ({
			held: new Set(
				sources.filter(s => !s.stopped && s.state.sessionId !== undefined).map(s => s.state.sessionId as string),
			),
			unknown: new Set(),
		}),
		createSource: async (spec: SessionSpec) => {
			let file = spec.resume;
			let id = SID;
			if (spec.fork) {
				// omp --fork: a new session file (new id, parentSession) in this machine's session dir, history copied.
				id = `fork-${name}-${++forks}`;
				const lines = readFileSync(spec.fork, "utf8").split("\n");
				const header = JSON.parse(lines[1]!) as Record<string, unknown>;
				const forked: Record<string, unknown> = { ...header, id, cwd: spec.cwd, parentSession: header.id };
				delete forked.previousSessionFiles;
				lines[1] = JSON.stringify(forked);
				file = join(sessionDir, `2026-11-13T01-00-0${forks}-000Z_${id}.jsonl`);
				writeFileSync(file, lines.join("\n"));
			} else if (!file) {
				// a new session: omp reports its file from the start but writes it only at the first reply
				id = `new-${name}-${++forks}`;
				file = join(sessionDir, `2026-11-13T02-00-0${forks}-000Z_${id}.jsonl`);
			}
			const source = new FakeSource([], id);
			Object.assign(source.state, stateFor(file));
			sources.push(source);
			return source;
		},
	});
	const fakeEnv: Record<string, string> = { FAKE_OMP_SESSIONS: sessionDir };
	const service = new HandoffService({
		manager,
		projects,
		ompPath,
		stateDir,
		ompVersion: "18.19.0",
		platform: "test",
		childEnv: () => fakeEnv,
		agentDb: () => join(root, "no-such-agent.db"),
		git: w.ctx,
		settle: { intervalMs: 1, stableForMs: 1, maxMs: 50 },
	});
	Object.assign(side, { name, repo, stateDir, sessionDir, manager, service, projects, fakeEnv });
	return side;
}

async function makeRig(): Promise<Rig> {
	const w = world();
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompweb-handoff-svc-")));
	const script = join(root, "fake-omp.ts");
	writeFileSync(script, FAKE_OMP);
	const ompPath = writeExecutable(
		join(root, "omp"),
		`exec "${posixPath(process.execPath)}" "${posixPath(script)}" "$@"`,
	);
	const dirty = await dirtyRepo(w, "src");
	const targetRepo = join(w.dir, "tgt");
	await w.git(w.dir, "clone", "-q", dirty.root, targetRepo);
	const source = await makeSide(w, root, "src", dirty.root, ompPath);
	const target = await makeSide(w, root, "tgt", targetRepo, ompPath);
	// the conversation (two turns) in the source's session dir, then hosted by the source daemon
	const file = writeSessionFile(source.sessionDir, {
		id: SID,
		created: "2026-11-13T00:00:00.000Z",
		cwd: dirty.root,
		slotTitle: "T",
		entries: [
			user("u1", null, "hello", "2026-11-13T00:00:01.000Z"),
			assistant("a1", "u1", "hi there", "2026-11-13T00:00:02.000Z"),
		],
	});
	await source.manager.restoreHosted(file, dirty.root);
	source.hostedFile = file;
	const rig = { w, root, source, target, ompPath };
	rigs.push(rig);
	return rig;
}

const call = <K extends HandoffOpName>(side: Side, op: K, args: HandoffOpArgs[K]): Promise<HandoffOpResult[K]> =>
	side.service.call(op, args);

/** Moves an offered file from one service to the other the way the gateway pump does, chunk by chunk. */
async function copyTransfer(from: Side, to: Side, info: { id: string; size: number }, toXfer: string): Promise<void> {
	let offset = 0;
	while (offset < info.size) {
		const { data } = await from.service.readChunk(info.id, offset, 100_000);
		await to.service.writeChunk(toXfer, offset, data);
		offset += data.length;
	}
}

type Step = "inspect" | "commit" | "capture" | "bundle" | "workspace" | "pack" | "unpack" | "fork";
const ORDER: Step[] = ["inspect", "commit", "capture", "bundle", "workspace", "pack", "unpack", "fork"];

interface Progress {
	commit?: HandoffOpResult["source.commit"];
	workspace?: HandoffOpResult["target.workspace"];
	fork?: HandoffOpResult["target.fork"];
	recvSession?: string;
	packed?: HandoffOpResult["source.pack"];
}

/** Runs the cross-machine operations in the gateway's order, up to and including `upTo`. */
async function run(
	rig: Rig,
	upTo: Step,
	choice: { mode: "new" } | { mode: "existing"; worktree: string } = { mode: "new" },
): Promise<Progress> {
	const { source, target } = rig;
	const p: Progress = {};
	const common = { opId: OP, threadId: THREAD };
	const upto = ORDER.indexOf(upTo);
	const doing = (s: Step): boolean => ORDER.indexOf(s) <= upto;
	const inspect = await call(source, "source.inspect", { sessionId: SID, limits: LIMITS });
	expect(inspect.sessionBlockers).toEqual([]);
	expect(inspect.repoBlockers).toEqual([]);
	const targetInspect = await call(target, "target.inspect", {
		projectId: inspect.project!.id,
		sourceHead: inspect.repo!.head,
		recent: inspect.repo!.recent,
		threadId: THREAD,
	});
	if (!doing("commit")) return p;
	p.commit = await call(source, "source.commit", { ...common, sessionId: SID, limits: LIMITS });
	if (!doing("capture")) return p;
	await call(source, "source.capture", { opId: OP, sessionId: SID });
	if (!doing("bundle")) return p;
	const bundle = await call(source, "source.bundle", { ...common, have: targetInspect.have, limits: LIMITS });
	const recv = await call(target, "target.receive", {
		opId: OP,
		threadId: THREAD,
		kind: "bundle",
		size: bundle.xfer.size,
		sha256: bundle.xfer.sha256,
	});
	await copyTransfer(source, target, bundle.xfer, recv.xfer);
	await call(target, "target.fetch", { ...common, xfer: recv.xfer, projectRoot: target.repo });
	if (!doing("workspace")) return p;
	p.workspace = await call(target, "target.workspace", {
		...common,
		projectId: inspect.project!.id,
		projectRoot: target.repo,
		choice,
		base: p.commit.base,
		commit: p.commit.commit,
		indexCommit: p.commit.indexCommit,
	});
	if (!doing("pack")) return p;
	p.packed = await call(source, "source.pack", { opId: OP, sessionId: SID, limits: LIMITS });
	const recvS = await call(target, "target.receive", {
		opId: OP,
		threadId: THREAD,
		kind: "session",
		size: p.packed.xfer.size,
		sha256: p.packed.xfer.sha256,
	});
	await copyTransfer(source, target, p.packed.xfer, recvS.xfer);
	p.recvSession = recvS.xfer;
	if (!doing("unpack")) return p;
	await call(target, "target.unpack", {
		opId: OP,
		xfer: recvS.xfer,
		cwd: p.workspace.worktree,
		subdir: "",
		clearAdditionalDirectories: true,
	});
	if (!doing("fork")) return p;
	p.fork = await call(target, "target.fork", {
		opId: OP,
		cwd: p.workspace.worktree,
		subdir: "",
		historyEntries: 2,
		fresh: false,
	});
	return p;
}

const rollbackBoth = async (rig: Rig): Promise<void> => {
	const t = await call(rig.target, "op.rollback", { opId: OP });
	const s = await call(rig.source, "op.rollback", { opId: OP });
	expect(t.leftovers).toEqual([]);
	expect(s.leftovers).toEqual([]);
};

const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []);
const branches = async (w: World, repo: string): Promise<string> =>
	w.git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/omp-web");
const worktrees = (w: World, repo: string): Promise<string> => w.git(repo, "worktree", "list", "--porcelain");

test.skipIf(process.platform !== "win32")(
	"handoff records and incoming session bytes are private and rollback cleans open transfers",
	async () => {
		const w = world();
		const root = realpathSync(mkdtempSync(join(tmpdir(), "ompweb-handoff-acl-")));
		const repo = await w.repo("private");
		const side = await makeSide(w, root, "private", repo, "unused");
		try {
			const bytes = Buffer.from("private session content");
			const receive = await call(side, "target.receive", {
				opId: OP,
				threadId: THREAD,
				kind: "session",
				size: bytes.length,
				sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
			});
			await side.service.writeChunk(receive.xfer, 0, bytes);
			const handoff = join(side.stateDir, "handoff");
			const record = join(handoff, "ops", `${OP}.json`);
			const transfer = join(handoff, "tmp", `${OP}.session.recv`);
			for (const path of [handoff, join(handoff, "ops"), join(handoff, "tmp"), record, transfer])
				expect(aclProblem(path)).toBeNull();
			expect(readFileSync(transfer)).toEqual(bytes);
			expect((await call(side, "op.rollback", { opId: OP })).leftovers).toEqual([]);
			expect(existsSync(transfer)).toBe(false);
			expect(existsSync(record)).toBe(false);
		} finally {
			side.service.close();
			await side.manager.closeAll();
			w.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform !== "win32")(
	"registered roots and prepared cwd accept Windows casing without accepting a foreign cwd",
	async () => {
		const w = world();
		const root = realpathSync(mkdtempSync(join(tmpdir(), "ompweb-handoff-case-")));
		const repo = await w.repo("MixedCaseProject", { "file.txt": "base\n" });
		const side = await makeSide(w, root, "case", repo, "unused");
		try {
			writeFileSync(join(repo, "file.txt"), "changed\n");
			const handoff = await createHandoffCommit(repo, THREAD, LIMITS, w.ctx);
			const project = (await side.projects.list())[0]!;
			const made = await call(side, "target.workspace", {
				opId: OP,
				threadId: THREAD,
				projectId: project.id,
				projectRoot: repo.toUpperCase(),
				choice: { mode: "new" },
				base: handoff.base,
				commit: handoff.commit,
				indexCommit: handoff.indexCommit,
			});
			await expect(
				call(side, "target.fork", {
					opId: OP,
					cwd: made.worktree.toUpperCase(),
					subdir: "",
					historyEntries: 0,
					fresh: false,
				}),
			).rejects.toThrow("there is no session copy to fork from");
			await expect(
				call(side, "target.fork", { opId: OP, cwd: repo, subdir: "", historyEntries: 0, fresh: false }),
			).rejects.toThrow("the session must continue in the worktree this operation prepared");
			expect((await call(side, "op.rollback", { opId: OP })).leftovers).toEqual([]);
		} finally {
			side.service.close();
			await side.manager.closeAll();
			w.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

describe("HandoffService: cross-machine flow with real git", () => {
	test("the target worktree equals the source's working tree, as uncommitted changes with the staged split, and the forked session continues there", async () => {
		const rig = await makeRig();
		const { w, source, target } = rig;
		const before = await snapshot(w, source.repo);
		const sourceStatus = await statusEntries(w, source.repo);
		const p = await run(rig, "fork");
		// the source repository is byte-identical (only the two handoff refs are new, and they are cleaned at commit)
		const after = await snapshot(w, source.repo);
		expect(after).toEqual(before);
		const worktree = p.workspace!.worktree;
		expect(worktree).toContain(".omp-worktrees");
		// the registry's cached scan knows the new worktree: sessions in it are attributed to the project at once
		expect(await target.projects.attribute(worktree)).toMatchObject({
			projectRoot: target.repo,
			worktreeRoot: worktree,
		});
		expect(p.workspace!.branch).toMatch(/^omp-web\//);
		const ignored = (rel: string): boolean => rel === "build" || rel.startsWith("build/") || rel.endsWith(".log");
		expect(treeHash(worktree, ignored)).toBe(treeHash(source.repo, ignored));
		expect(await statusEntries(w, worktree)).toEqual(sourceStatus);
		// the session: forked in the worktree, history preserved, the unpacked intermediate gone
		expect(p.fork!.sessionId).toStartWith("fork-tgt");
		expect(p.fork!.facts!.history.entries).toBeGreaterThan(0);
		const all = files(target.sessionDir).filter(f => f.endsWith(".jsonl"));
		expect(all.map(f => basename(f))).toEqual([basename(p.fork!.file)]);
		expect(files(join(rig.root, "tgt-sessions")).some(f => f.startsWith("bucket-"))).toBe(false);
		// the source's omp process was stopped for pack (it held the lease) and the file is untouched by it
		expect(source.sources[0]!.stopped).toBe(true);
		// commit: handoff refs removed on both sides, records and temp files gone
		await call(target, "op.commit", { opId: OP, role: "target" });
		await call(source, "op.commit", { opId: OP, role: "source" });
		expect(await branches(w, source.repo)).not.toContain("omp-web/handoff");
		expect(await w.git(target.repo, "for-each-ref", "refs/omp-web")).toBe("");
		expect(files(join(source.stateDir, "handoff", "tmp"))).toEqual([]);
		expect(files(join(target.stateDir, "handoff", "tmp"))).toEqual([]);
		expect(files(join(target.stateDir, "handoff", "ops"))).toEqual([]);
		// the worktree and the fork stay: that is the result of the switch
		expect(existsSync(worktree)).toBe(true);
		expect(target.manager.hosted(p.fork!.sessionId)).toBeDefined();
		// and the old session is marked as moved
		const finished = await call(source, "source.finish", { opId: OP, sessionId: SID, label: "laptop" }).catch(
			() => null,
		);
		expect(finished === null || finished.marked).toBe(true);
	});

	test("a rollback after EVERY step leaves both machines exactly as they were", async () => {
		for (const upTo of ORDER.slice(1)) {
			const rig = await makeRig();
			const { w, source, target } = rig;
			const srcBefore = await snapshot(w, source.repo);
			const srcRefs = await branches(w, source.repo);
			const tgtBranches = await branches(w, target.repo);
			const tgtTree = treeHash(target.repo);
			const tgtWorktrees = await worktrees(w, target.repo);
			const srcFileBytes = readFileSync(source.hostedFile!);
			const tgtSessions = files(target.sessionDir);

			await run(rig, upTo);
			await rollbackBoth(rig);

			const label = `after ${upTo}`;
			expect({ at: label, v: await snapshot(w, source.repo) }).toEqual({ at: label, v: srcBefore });
			expect({ at: label, v: await branches(w, source.repo) }).toEqual({ at: label, v: srcRefs });
			expect({ at: label, v: await w.git(source.repo, "for-each-ref", "refs/omp-web") }).toEqual({
				at: label,
				v: "",
			});
			expect({ at: label, v: await branches(w, target.repo) }).toEqual({ at: label, v: tgtBranches });
			expect({ at: label, v: await w.git(target.repo, "for-each-ref", "refs/omp-web") }).toEqual({
				at: label,
				v: "",
			});
			expect({ at: label, v: await worktrees(w, target.repo) }).toEqual({ at: label, v: tgtWorktrees });
			expect({ at: label, v: treeHash(target.repo) }).toEqual({ at: label, v: tgtTree });
			expect({ at: label, v: files(target.sessionDir) }).toEqual({ at: label, v: tgtSessions });
			expect({ at: label, v: files(join(rig.root, "tgt-worktrees")) }).toEqual({ at: label, v: [] });
			expect(exists(`${target.repo}.omp-worktrees/${THREAD}`)).toBe(false);
			expect(files(`${target.repo}.omp-worktrees`).filter(f => !f.includes("."))).toEqual([]);
			for (const side of [source, target]) {
				expect({ at: label, side: side.name, v: files(join(side.stateDir, "handoff", "tmp")) }).toEqual({
					at: label,
					side: side.name,
					v: [],
				});
				expect({ at: label, side: side.name, v: files(join(side.stateDir, "handoff", "ops")) }).toEqual({
					at: label,
					side: side.name,
					v: [],
				});
			}
			// the source session is byte-identical and hosted again when it was stopped for the archive
			expect(Buffer.compare(readFileSync(source.hostedFile!), srcFileBytes)).toBe(0);
			if (ORDER.indexOf(upTo) >= ORDER.indexOf("pack")) {
				expect(source.manager.hosted(SID)).toBeDefined();
			}
			expect(source.manager.isReserved(SID)).toBeUndefined();
			// a second rollback is a no-op
			const again = await call(target, "op.rollback", { opId: OP });
			expect(again).toEqual({ removed: [], leftovers: [] });
			rig.source.service.close();
		}
	}, 120_000);

	test("an internal failure rolls back to the same clean state: unpack fails in omp, fork cannot start", async () => {
		for (const failure of ["unpack", "fork"] as const) {
			const rig = await makeRig();
			const { w, source, target } = rig;
			const srcBefore = await snapshot(w, source.repo);
			const tgtBranches = await branches(w, target.repo);
			if (failure === "unpack") target.fakeEnv.FAKE_OMP_FAIL = "unpack";
			let failed: unknown = null;
			try {
				if (failure === "fork") {
					const real = target.manager.forkFile.bind(target.manager);
					target.manager.forkFile = async () => {
						throw new Error("omp could not start");
					};
					void real;
				}
				await run(rig, "fork");
			} catch (error) {
				failed = error;
			}
			expect(failed).toBeInstanceOf(HandoffOpFailure);
			expect((failed as Error).message).toContain(
				failure === "unpack" ? "injected failure of unpack" : "omp could not start",
			);
			await rollbackBoth(rig);
			expect(await snapshot(w, source.repo)).toEqual(srcBefore);
			expect(await branches(w, target.repo)).toEqual(tgtBranches);
			expect(files(target.sessionDir)).toEqual([]);
			expect(files(join(target.stateDir, "handoff", "tmp"))).toEqual([]);
			expect(source.manager.hosted(SID)).toBeDefined();
		}
	}, 60_000);

	test("a corrupted bundle is refused at verify: nothing is fetched and the rollback is clean", async () => {
		const rig = await makeRig();
		const { w, source, target } = rig;
		const inspect = await call(source, "source.inspect", { sessionId: SID, limits: LIMITS });
		await call(source, "source.commit", { opId: OP, threadId: THREAD, sessionId: SID, limits: LIMITS });
		const bundle = await call(source, "source.bundle", { opId: OP, threadId: THREAD, have: [], limits: LIMITS });
		expect(bundle.full).toBe(true);
		const recv = await call(target, "target.receive", {
			opId: OP,
			threadId: THREAD,
			kind: "bundle",
			size: bundle.xfer.size,
			sha256: bundle.xfer.sha256,
		});
		let offset = 0;
		while (offset < bundle.xfer.size) {
			const { data } = await source.service.readChunk(bundle.xfer.id, offset, 100_000);
			if (offset === 0) data[data.length - 1] = data[data.length - 1]! ^ 0xff; // one flipped byte
			await target.service.writeChunk(recv.xfer, offset, data);
			offset += data.length;
		}
		const error = await call(target, "target.fetch", {
			opId: OP,
			threadId: THREAD,
			xfer: recv.xfer,
			projectRoot: target.repo,
		}).catch((e: unknown) => e);
		expect((error as Error).message).toMatch(/corrupted|checksum/);
		expect(await w.git(target.repo, "for-each-ref", "refs/omp-web")).toBe("");
		await rollbackBoth(rig);
		expect(inspect.project).not.toBeNull();
		expect(files(join(target.stateDir, "handoff", "tmp"))).toEqual([]);
	});

	test("the gateway cannot make the daemon write outside its own record: unknown operation ids, other project roots, foreign worktree paths", async () => {
		const rig = await makeRig();
		const { source, target } = rig;
		await run(rig, "workspace");
		const strange = await call(target, "target.unpack", {
			opId: "opdoesnotexist",
			xfer: "x",
			cwd: "/etc",
			subdir: "",
			clearAdditionalDirectories: true,
		}).catch((e: unknown) => e);
		expect((strange as Error).message).toContain("unknown to the daemon");
		const other = await call(target, "target.fetch", {
			opId: OP,
			threadId: THREAD,
			xfer: "nope",
			projectRoot: "/etc",
		}).catch((e: unknown) => e);
		expect((other as Error).message).toContain("not a registered project root");
		const wrongCwd = await call(target, "target.unpack", {
			opId: OP,
			xfer: "nope",
			cwd: source.repo,
			subdir: "",
			clearAdditionalDirectories: true,
		}).catch((e: unknown) => e);
		expect((wrongCwd as Error).message).toContain("must continue in the worktree this operation prepared");
		await rollbackBoth(rig);
	});

	test("a busy session is refused before anything is written", async () => {
		const rig = await makeRig();
		const { source } = rig;
		source.sources[0]!.state.isStreaming = true;
		const inspect = await call(source, "source.inspect", { sessionId: SID, limits: LIMITS });
		expect(inspect.sessionBlockers.join(" ")).toContain("A run is in progress");
		const refused = await call(source, "source.commit", {
			opId: OP,
			threadId: THREAD,
			sessionId: SID,
			limits: LIMITS,
		}).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(HandoffOpFailure);
		expect((refused as HandoffOpFailure).kind).toBe("refused");
		expect(await rig.w.git(source.repo, "for-each-ref", "refs/omp-web")).toBe("");
		source.sources[0]!.state.isStreaming = false;
		source.sources[0]!.state.queuedMessageCount = 1;
		expect(
			(await call(source, "source.inspect", { sessionId: SID, limits: LIMITS })).sessionBlockers.join(" "),
		).toContain("queued");
	});

	test("a stored source (no hosted process) is captured through a short-lived fork whose own file is deleted", async () => {
		const rig = await makeRig();
		const { source } = rig;
		await source.manager.close(source.manager.hosted(SID)!.id);
		const before = files(source.sessionDir).filter(f => f.endsWith(".jsonl"));
		const inspect = await call(source, "source.inspect", { sessionId: SID, limits: LIMITS });
		expect(inspect.session.hosted).toBe(false);
		expect(inspect.sessionBlockers).toEqual([]);
		await call(source, "source.commit", { opId: OP, threadId: THREAD, sessionId: SID, limits: LIMITS });
		const captured = await call(source, "source.capture", { opId: OP, sessionId: SID });
		expect(captured.hosted).toBe(false);
		expect(captured.facts.origin).toBe("probe");
		expect(files(source.sessionDir).filter(f => f.endsWith(".jsonl"))).toEqual(before);
		await rollbackBoth(rig);
	});
});

describe("HandoffService: a switch within one machine", () => {
	test("no bundle and no session transfer: the new worktree comes from the same repository, the fork reads the source file", async () => {
		const rig = await makeRig();
		const { w, source } = rig;
		const before = await snapshot(w, source.repo);
		const sourceStatus = await statusEntries(w, source.repo);
		const common = { opId: OP, threadId: THREAD };
		const inspect = await call(source, "source.inspect", { sessionId: SID, limits: LIMITS });
		const target = await call(source, "target.inspect", {
			projectId: inspect.project!.id,
			sourceHead: inspect.repo!.head,
			recent: inspect.repo!.recent,
			sourceWorktree: inspect.project!.worktree,
			threadId: THREAD,
		});
		expect(target.worktrees.every(x => !x.eligible)).toBe(true); // the source's own worktree is never a target
		const commit = await call(source, "source.commit", { ...common, sessionId: SID, limits: LIMITS });
		await call(source, "source.capture", { opId: OP, sessionId: SID });
		const workspace = await call(source, "target.workspace", {
			...common,
			projectId: inspect.project!.id,
			projectRoot: source.repo,
			choice: { mode: "new" },
			base: commit.base,
			commit: commit.commit,
			indexCommit: commit.indexCommit,
		});
		const ignored = (rel: string): boolean => rel === "build" || rel.startsWith("build/") || rel.endsWith(".log");
		expect(treeHash(workspace.worktree, ignored)).toBe(treeHash(source.repo, ignored));
		const fork = await call(source, "target.fork", {
			opId: OP,
			cwd: workspace.worktree,
			subdir: "",
			historyEntries: 2,
			fresh: false,
		});
		// the source's hosted session is untouched (it is stopped only when the thread is confirmed moved)
		expect(source.sources[0]!.stopped).toBe(false);
		expect(source.manager.hosted(fork.sessionId)).toBeDefined();
		expect(source.manager.isReserved(fork.sessionId)).toBe(OP);
		// rollback removes the fork, its file, the worktree and the branch; the source's own session stays hosted
		const rolled = await call(source, "op.rollback", { opId: OP });
		expect(rolled.leftovers).toEqual([]);
		expect(source.manager.hosted(fork.sessionId)).toBeUndefined();
		expect(existsSync(fork.file)).toBe(false);
		expect(existsSync(workspace.worktree)).toBe(false);
		expect(await w.git(source.repo, "for-each-ref", "refs/omp-web", "refs/heads/omp-web")).toBe("");
		expect(await snapshot(w, source.repo)).toEqual(before);
		expect(await statusEntries(w, source.repo)).toEqual(sourceStatus);
		expect(source.manager.hosted(SID)).toBeDefined();
		expect(Buffer.compare(readFileSync(source.hostedFile!), readFileSync(source.hostedFile!))).toBe(0);
	}, 60_000);

	test("a session with no conversation and no file yet switches by starting a new session in the new worktree", async () => {
		const rig = await makeRig();
		const { w, source } = rig;
		const common = { opId: OP, threadId: THREAD };
		await source.manager.close(source.manager.hosted(SID)!.id);
		const fresh = await source.manager.create(source.repo);
		const freshFile = fresh.info.file!;
		expect(existsSync(freshFile)).toBe(false);
		const inspect = await call(source, "source.inspect", { sessionId: fresh.id, limits: LIMITS });
		expect(inspect.sessionBlockers).toEqual([]);
		const commit = await call(source, "source.commit", { ...common, sessionId: fresh.id, limits: LIMITS });
		expect(commit.fresh).toBe(true);
		await expect(call(source, "source.capture", { opId: OP, sessionId: fresh.id })).rejects.toThrow(
			"no history to capture",
		);
		const workspace = await call(source, "target.workspace", {
			...common,
			projectId: inspect.project!.id,
			projectRoot: source.repo,
			choice: { mode: "new" },
			base: commit.base,
			commit: commit.commit,
			indexCommit: commit.indexCommit,
		});
		const started = await call(source, "target.fork", {
			opId: OP,
			cwd: workspace.worktree,
			subdir: "",
			historyEntries: 0,
			fresh: true,
		});
		expect(started.facts).toBeNull();
		expect(started.sessionId).not.toBe(fresh.id);
		expect(source.manager.isReserved(started.sessionId)).toBe(OP);
		// after the confirm: the empty source just ends (nothing to mark), the new session stays in the worktree
		expect(await call(source, "source.finish", { opId: OP, sessionId: fresh.id, label: "here" })).toEqual({
			marked: false,
		});
		expect(source.manager.hosted(fresh.id)).toBeUndefined();
		expect(existsSync(freshFile)).toBe(false);
		await call(source, "op.commit", { opId: OP, role: "target" });
		await call(source, "op.commit", { opId: OP, role: "source" });
		expect(source.manager.hosted(started.sessionId)).toBeDefined();
		expect(source.manager.isReserved(started.sessionId)).toBeUndefined();
		expect(existsSync(workspace.worktree)).toBe(true);
		expect(await w.git(source.repo, "for-each-ref", "refs/omp-web")).toBe("");
	}, 60_000);

	test("a session whose messages are not on disk yet is refused", async () => {
		const rig = await makeRig();
		const { source } = rig;
		await source.manager.close(source.manager.hosted(SID)!.id);
		const fresh = await source.manager.create(source.repo);
		await fresh.prompt("hello");
		const inspect = await call(source, "source.inspect", { sessionId: fresh.id, limits: LIMITS });
		expect(inspect.sessionBlockers.join(" ")).toContain("not written to disk yet");
	});
});

describe("HandoffService: daemon restarts", () => {
	test("a restarted daemon still rolls the operation back from its records on disk", async () => {
		const rig = await makeRig();
		const { w, target } = rig;
		const tgtBranches = await branches(w, target.repo);
		await run(rig, "unpack");
		// "restart": a new service over the same state directory (the in-memory transfer state is gone)
		target.service.close();
		const revived = new HandoffService({
			manager: target.manager,
			projects: target.projects,
			ompPath: rig.ompPath,
			stateDir: target.stateDir,
			ompVersion: "18.19.0",
			childEnv: () => target.fakeEnv,
			git: w.ctx,
			settle: { intervalMs: 1, stableForMs: 1, maxMs: 50 },
		});
		const rolled = await revived.call("op.rollback", { opId: OP });
		expect(rolled.leftovers).toEqual([]);
		expect(await branches(w, target.repo)).toEqual(tgtBranches);
		expect(files(target.sessionDir)).toEqual([]);
		expect(files(join(target.stateDir, "handoff", "ops"))).toEqual([]);
		revived.close();
		await call(rig.source, "op.rollback", { opId: OP });
	});

	test("records nobody finished are rolled back by the sweep", async () => {
		const rig = await makeRig();
		const { w, source } = rig;
		let now = Date.now();
		source.service.close();
		const sweeping = new HandoffService({
			manager: source.manager,
			projects: source.projects,
			ompPath: rig.ompPath,
			stateDir: source.stateDir,
			ompVersion: "18.19.0",
			childEnv: () => source.fakeEnv,
			git: w.ctx,
			now: () => now,
			staleMs: 1000,
			settle: { intervalMs: 1, stableForMs: 1, maxMs: 50 },
		});
		await sweeping.call("source.commit", { opId: OP, threadId: THREAD, sessionId: SID, limits: LIMITS });
		expect(await w.git(source.repo, "for-each-ref", "refs/omp-web")).not.toBe("");
		now += 5000;
		await sweeping.sweepStale();
		expect(await w.git(source.repo, "for-each-ref", "refs/omp-web")).toBe("");
		expect(files(join(source.stateDir, "handoff", "ops"))).toEqual([]);
		sweeping.close();
	});
});
