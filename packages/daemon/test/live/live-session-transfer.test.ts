import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
	markSessionMoved,
	normalizeHeader,
	type OmpRun,
	packSessionFile,
	readSessionHeader,
	removeSessionCopy,
	SessionTransferError,
	sessionBodyFingerprint,
	sessionCopyFiles,
	unpackSessionArchive,
} from "../../src/handoff-session";
import { OmpRpcSource } from "../../src/omp-source";
import { makeSandbox, requireOmp } from "./live-env";

// Live contract for what the daemon's session layer (src/handoff-session.ts) depends on in `omp session pack|unpack|moved`
// and in `omp --mode rpc-ui --fork`: lease refusals, archive layout, where unpack lands,
// what it writes into the header and transcript, and what a fork inherits. Real omp, isolated by PI_CODING_AGENT_DIR, a fake
// API key and a local fake Anthropic server; nothing is read from or written to ~/.omp (even the ownership leases are
// redirected into the sandbox through PI_TEST_SESSION_OWNERS_DIR).

const sandbox = makeSandbox("omp-web-live-transfer-");
const MODEL = "anthropic/claude-opus-5-5";
const PROMPT = "remember the word pelican";
const agentDir = join(sandbox.root, "agent");
const ownersDir = join(sandbox.root, "owners");
const dirB = join(sandbox.root, "project-b");
const dirC = join(sandbox.root, "project-c");
const forkSessions = join(sandbox.root, "sessions-fork");
const sameMachineSessions = join(sandbox.root, "sessions-same-machine");
const tarPath = join(sandbox.root, "transfer.tar");

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const server = Bun.serve({
	port: 0,
	fetch(req) {
		if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/v1/messages")) {
			return new Response("not found", { status: 404 });
		}
		const body = [
			sse("message_start", {
				type: "message_start",
				message: {
					id: "msg_fake",
					type: "message",
					role: "assistant",
					model: "claude-opus-5-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "ok" },
			}),
			sse("content_block_stop", { type: "content_block_stop", index: 0 }),
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			}),
			sse("message_stop", { type: "message_stop" }),
		].join("");
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	},
});
// Refuse accidental outbound provider requests: the contract only uses the loopback fake.
const proxy = Bun.listen({
	hostname: "127.0.0.1",
	port: 0,
	socket: {
		data(socket) {
			socket.end();
		},
	},
});
const installedOmp =
	process.platform === "win32" ? join(process.env.USERPROFILE!, ".bun", "bin", "omp.exe") : undefined;

const saved: Record<string, string | undefined> = {};
const overrides: Record<string, string> = {
	// OmpRpcSource and the session wrappers spawn omp with the daemon's own environment, so isolate by overriding it.
	PI_CODING_AGENT_DIR: agentDir,
	PI_TEST_SESSION_OWNERS_DIR: ownersDir,
	ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
	ANTHROPIC_API_KEY: "sk-ant-fake-live-contract",
	HOME: sandbox.root,
	USERPROFILE: sandbox.root,
	APPDATA: join(sandbox.root, "AppData", "Roaming"),
	LOCALAPPDATA: join(sandbox.root, "AppData", "Local"),
	HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
	HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
	http_proxy: `http://127.0.0.1:${proxy.port}`,
	https_proxy: `http://127.0.0.1:${proxy.port}`,
	NO_PROXY: "127.0.0.1,localhost",
	no_proxy: "127.0.0.1,localhost",
	...(installedOmp ? { OMP_BIN: installedOmp } : {}),
};

let ompPath: string;
let run: OmpRun;
let source: OmpRpcSource | undefined;
const extraSources: OmpRpcSource[] = [];

const sha = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const fileHash = (file: string): string => sha(readFileSync(file));
const withoutExt = (file: string): string => file.slice(0, -".jsonl".length);
const lines = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter(Boolean);

async function turn(src: OmpRpcSource, text: string): Promise<void> {
	const done = Promise.withResolvers<void>();
	src.onPromptResult(r => (r.status === "error" ? done.reject(new Error(r.error?.message)) : done.resolve()));
	await src.prompt(text);
	await done.promise;
}

async function tarMembers(tar: string): Promise<string[]> {
	const proc = Bun.spawn(["tar", "-tf", tar], { stdout: "pipe", stderr: "pipe" });
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(code).toBe(0);
	return out
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean);
}

async function omp(args: string[]): Promise<{ code: number; text: string }> {
	const proc = Bun.spawn([ompPath, ...args], { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, ...run.env } });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, text: out + err };
}

/** Shared state of the sequential steps below. */
const world: {
	srcFile: string;
	srcId: string;
	srcMessageCount: number;
	srcEntries: number;
	unpacked: string;
} = { srcFile: "", srcId: "", srcMessageCount: 0, srcEntries: 0, unpacked: "" };

beforeAll(async () => {
	for (const [k, v] of Object.entries(overrides)) {
		saved[k] = Bun.env[k];
		Bun.env[k] = v;
	}
	for (const key of [
		"PI_PROFILE",
		"OMP_PROFILE",
		"PI_CONFIG_FILES",
		"OMP_AUTH_BROKER_URL",
		"OMP_AUTH_BROKER_TOKEN",
		"ANTHROPIC_OAUTH_TOKEN",
		"OPENAI_API_KEY",
		"GEMINI_API_KEY",
	]) {
		saved[key] = Bun.env[key];
		delete Bun.env[key];
	}
	mkdirSync(overrides.APPDATA!, { recursive: true });
	mkdirSync(overrides.LOCALAPPDATA!, { recursive: true });
	// omp insists on a private lease directory it owns.
	mkdirSync(ownersDir, { recursive: true, mode: 0o700 });
	chmodSync(ownersDir, 0o700);
	for (const dir of [dirB, dirC, forkSessions, sameMachineSessions]) mkdirSync(dir, { recursive: true });
	ompPath = (await requireOmp()).path;
	run = { ompPath, timeoutMs: 60_000 };

	source = new OmpRpcSource({ ompPath, cwd: sandbox.cwd, sessionDir: sandbox.sessionDir, model: MODEL });
	await source.start();
	await turn(source, PROMPT);
	const state = await source.getState();
	expect(state.sessionFile, "omp reports the session file after the first turn").toBeDefined();
	world.srcFile = state.sessionFile!;
	world.srcId = state.sessionId;
	world.srcMessageCount = state.messageCount;
	// An artifact omp would have spilled next to the journal; pack/fork must carry it.
	mkdirSync(withoutExt(world.srcFile), { recursive: true });
	writeFileSync(join(withoutExt(world.srcFile), "0.artifact.txt"), "artifact bytes\n");
}, 90_000);

afterAll(async () => {
	await source?.stop().catch(() => {});
	for (const extra of extraSources) await extra.stop().catch(() => {});
	await server.stop(true);
	proxy.stop();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete Bun.env[k];
		else Bun.env[k] = v;
	}
	// Everything omp wrote (sessions, unpacked copies, leases, blobs) lies inside the sandbox.
	sandbox.cleanup();
});

describe("omp session transfer (live)", () => {
	test("the CLI help names the flags the daemon passes", async () => {
		for (const action of ["pack", "unpack", "moved"]) {
			const { code, text } = await omp(["session", action, "--help"]);
			expect(code, action).toBe(0);
			expect(text, action).toContain("--cwd");
			expect(text, action).toContain("--to");
			expect(text, action).toContain(`omp session ${action}`);
		}
	});

	test("pack and moved are refused while the hosting omp process holds the session, and change nothing", async () => {
		const before = fileHash(world.srcFile);
		const packError = await packSessionFile(run, world.srcFile, tarPath).catch(e => e);
		expect(packError).toBeInstanceOf(SessionTransferError);
		expect(packError.kind).toBe("refused");
		expect(packError.message).toContain("another live omp process");
		expect(existsSync(tarPath)).toBe(false);

		const movedError = await markSessionMoved(run, world.srcFile, "elsewhere").catch(e => e);
		expect(movedError).toBeInstanceOf(SessionTransferError);
		expect(movedError.kind).toBe("refused");
		expect(fileHash(world.srcFile)).toBe(before);
	}, 60_000);

	test("a fork straight from the source file works while its omp process is alive and idle, and leaves the source byte-identical", async () => {
		const before = fileHash(world.srcFile);
		const sourcePrint = await sessionBodyFingerprint(world.srcFile);
		const sameMachine = new OmpRpcSource({
			ompPath,
			cwd: dirC,
			sessionDir: sameMachineSessions,
			fork: world.srcFile,
		});
		extraSources.push(sameMachine);
		await sameMachine.start();
		const state = await sameMachine.getState();
		expect(state.sessionFile).toBeDefined();
		expect(state.sessionId).not.toBe(world.srcId);
		expect(state.messageCount).toBe(world.srcMessageCount);

		const header = await readSessionHeader(state.sessionFile!);
		// omp records the process's cwd, which on macOS may be the /var spelling of a /private/var path.
		expect(realpathSync(String(header.header.cwd))).toBe(dirC);
		expect(header.header.parentSession).toBeDefined();
		expect(await sessionBodyFingerprint(state.sessionFile!, sourcePrint.entries)).toEqual(sourcePrint);
		expect(readFileSync(join(withoutExt(state.sessionFile!), "0.artifact.txt"), "utf8")).toBe("artifact bytes\n");
		await sameMachine.stop();
		expect(fileHash(world.srcFile)).toBe(before);
	}, 60_000);

	test("pack succeeds once the process is gone, leaves the source untouched, and writes manifest.json + session.jsonl + artifacts/", async () => {
		await source!.stop();
		// Stopping appends to the journal (omp's exit record), so the history to compare is measured after it.
		world.srcEntries = (await sessionBodyFingerprint(world.srcFile)).entries;
		const before = fileHash(world.srcFile);
		// The lease is released by the kernel when the process exits; poll the real condition (the refusal going away)
		// instead of guessing a delay. A timer is unavoidable here: nothing signals the release to another process.
		let result: { missingBlobs: number } | undefined;
		for (let attempt = 0; attempt < 50 && !result; attempt++) {
			try {
				result = await packSessionFile(run, world.srcFile, tarPath);
			} catch (error) {
				if (!(error instanceof SessionTransferError) || error.kind !== "refused") throw error;
				await Bun.sleep(100);
			}
		}
		expect(result).toEqual({ missingBlobs: 0 });
		expect(fileHash(world.srcFile)).toBe(before);

		const members = await tarMembers(tarPath);
		expect(members).toContain("manifest.json");
		expect(members).toContain("session.jsonl");
		const artifacts = members.filter(m => m.startsWith("artifacts/") && !m.endsWith("/"));
		expect(artifacts.some(m => m.endsWith("0.artifact.txt"))).toBe(true);
		for (const member of members) {
			expect(
				member === "manifest.json" || member === "session.jsonl" || member.startsWith("artifacts/"),
				member,
			).toBe(true);
		}
	}, 60_000);

	test("unpack --cwd lands under the sandbox agent dir with the same id, the new cwd, previousSessionFiles and an arrival notice", async () => {
		const result = await unpackSessionArchive(run, tarPath, dirB);
		world.unpacked = result.file;
		expect(result.file.startsWith(join(agentDir, "sessions") + sep)).toBe(true);
		expect(result.file.endsWith(".jsonl")).toBe(true);
		expect(result.id).toBe(world.srcId);
		expect(result.mode).toBe("created");

		const info = await readSessionHeader(result.file);
		expect(info.header.id).toBe(world.srcId);
		expect(info.header.cwd).toBe(dirB);
		expect(info.previousSessionFiles.length).toBeGreaterThan(0);

		const last = JSON.parse(lines(result.file).at(-1)!);
		expect(last.type).toBe("custom_message");
		expect(last.customType).toBe("session-transfer");
		expect(last.details.kind).toBe("arrived");
		expect(last.details.cwd).toBe(dirB);
		// The artifacts directory travels next to the journal.
		expect(readFileSync(join(withoutExt(result.file), "0.artifact.txt"), "utf8")).toBe("artifact bytes\n");
		// Entries of the source are the first ones of the unpacked copy.
		expect(await sessionBodyFingerprint(result.file, world.srcEntries)).toEqual(
			await sessionBodyFingerprint(world.srcFile),
		);
	}, 60_000);

	test("a second unpack meets the local copy, which is not a prefix of the archive (the arrival notice), and unpacks as a fork with a new id", async () => {
		const again = await unpackSessionArchive(run, tarPath, dirB);
		expect(again.mode).toBe("forked");
		expect(again.file).not.toBe(world.unpacked);
		expect(again.id).not.toBe(world.srcId);
		expect((await readSessionHeader(again.file)).header.id).toBe(again.id);
		// The first copy is untouched; the fork is the daemon's to clean up like any other intermediate.
		expect(existsSync(world.unpacked)).toBe(true);
		await removeSessionCopy(again.file);
		expect(existsSync(again.file)).toBe(false);
		expect(existsSync(world.unpacked)).toBe(true);
	}, 60_000);

	test("the normalized copy forks with its history, inherits the cache key and drops previousSessionFiles; the intermediate is then removable", async () => {
		const normalized = await normalizeHeader(world.unpacked, { clearAdditionalDirectories: true });
		expect(normalized.removedPreviousSessionFiles).toBe(true);
		expect((await readSessionHeader(world.unpacked)).previousSessionFiles).toEqual([]);

		const srcHeader = (await readSessionHeader(world.srcFile)).header;
		const forked = new OmpRpcSource({ ompPath, cwd: dirB, sessionDir: forkSessions, fork: world.unpacked });
		extraSources.push(forked);
		await forked.start();
		const state = await forked.getState();
		expect(state.sessionFile).toBeDefined();
		const forkFile = state.sessionFile!;
		expect(forkFile.startsWith(forkSessions)).toBe(true);
		// The source's messages plus the arrival notice.
		expect(state.messageCount).toBe(world.srcMessageCount + 1);

		const forkHeader = (await readSessionHeader(forkFile)).header;
		expect(forkHeader.id).not.toBe(world.srcId);
		expect(typeof forkHeader.parentSession).toBe("string");
		expect(realpathSync(String(forkHeader.cwd))).toBe(dirB);
		expect("previousSessionFiles" in forkHeader).toBe(false);
		// A fork keeps the source's prompt-cache key (omp's own: the header's key, or the session id when it has none), so the
		// provider-side cache prefix survives the move.
		expect(forkHeader.providerPromptCacheKey).toBe(srcHeader.providerPromptCacheKey ?? srcHeader.id);
		expect(forkHeader.providerPromptCacheKey).toBe(world.srcId);

		expect(readFileSync(join(withoutExt(forkFile), "0.artifact.txt"), "utf8")).toBe("artifact bytes\n");
		expect(await sessionBodyFingerprint(forkFile, world.srcEntries)).toEqual(
			await sessionBodyFingerprint(world.srcFile),
		);
		await forked.stop();

		// The intermediate goes: journal, artifacts, and the bucket omp created for it (nothing else was in it).
		const bucket = join(world.unpacked, "..");
		// Whatever omp left beside the copy (its hidden lock files, ...) is on the removal list.
		const planned = await sessionCopyFiles(world.unpacked);
		const name = world.unpacked.slice(bucket.length + 1);
		for (const entry of readdirSync(bucket)) {
			if (entry === name || entry === name.slice(0, -".jsonl".length) || entry.startsWith(`.${name}.`)) {
				expect(planned, entry).toContain(join(bucket, entry));
			}
		}
		const removed = await removeSessionCopy(world.unpacked, { removeEmptyBucket: true });
		expect(removed).toContain(world.unpacked);
		expect(removed).toContain(withoutExt(world.unpacked));
		expect(existsSync(world.unpacked)).toBe(false);
		expect(existsSync(withoutExt(world.unpacked))).toBe(false);
		expect(existsSync(bucket)).toBe(false);
		expect(existsSync(forkFile)).toBe(true);
	}, 90_000);

	test("moved appends a departed notice to the stale copy once no process holds it", async () => {
		const before = lines(world.srcFile).length;
		await markSessionMoved(run, world.srcFile, "other-machine\nwith a newline");
		const after = lines(world.srcFile);
		expect(after.length).toBe(before + 1);
		const last = JSON.parse(after.at(-1)!);
		expect(last.type).toBe("custom_message");
		expect(last.customType).toBe("session-transfer");
		expect(last.details).toEqual({ kind: "departed", to: "other-machine with a newline" });
	}, 60_000);
});
