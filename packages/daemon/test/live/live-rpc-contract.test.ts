import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { probeRpcProtocol, type OmpBinary } from "../../src/omp-binary";
import { OmpRpcSource } from "../../src/omp-source";
import { makeSandbox, requireOmp } from "./live-env";

// Live contract: the installed `omp` against what the daemon and packages/protocol read. No model call is made.
// Run with `bun run test:live`; excluded from `bun run test`.

const sandbox = makeSandbox("omp-web-live-rpc-");
let omp: OmpBinary;
let source: OmpRpcSource;

beforeAll(async () => {
	omp = await requireOmp();
	source = new OmpRpcSource({ ompPath: omp.path, cwd: sandbox.cwd, sessionDir: sandbox.sessionDir });
	await source.start(); // throws unless the ready frame offers protocol v2
}, 60_000);

afterAll(async () => {
	await source?.stop();
	sandbox.cleanup();
});

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === "string");

describe("installed omp rpc-ui contract", () => {
	test("ready frame offers protocol v2", async () => {
		await probeRpcProtocol(omp); // throws OmpStartupError otherwise; OmpRpcSource.start() above checks the same on the real path
	}, 60_000);

	test("get_state has the fields the daemon and session view read", async () => {
		const state = await source.getState();
		// Read by HostedSession (#statusOf, create) and surfaced in SessionStatus.
		expect(typeof state.sessionId).toBe("string");
		expect(state.sessionId.length).toBeGreaterThan(0);
		expect(typeof state.isStreaming).toBe("boolean");
		expect(typeof state.queuedMessageCount).toBe("number");
		expect(state.queuedMessageCount).toBeGreaterThanOrEqual(0);
		expect(["string", "undefined"]).toContain(typeof state.thinkingLevel);
		expect(["string", "undefined"]).toContain(typeof state.sessionName);
		// model is optional (no model configured in the isolated environment is legal), but its shape feeds `provider/id`.
		if (state.model !== undefined) {
			expect(typeof state.model.provider).toBe("string");
			expect(typeof state.model.id).toBe("string");
		}
		expect(typeof state.sessionFile).toBe("string");
		expect(state.sessionFile!.startsWith(sandbox.sessionDir)).toBe(true);
		// Queue/state snapshot fields declared by RpcSessionState.
		expect(typeof state.isCompacting).toBe("boolean");
		expect(typeof state.messageCount).toBe("number");
		expect(typeof state.isSettled).toBe("boolean");
		expect(state.queuedMessages).toBeDefined();
		expect(isStringArray(state.queuedMessages.steering)).toBe(true);
		expect(isStringArray(state.queuedMessages.followUp)).toBe(true);
		expect(typeof state.queuedMessages.liveSteered).toBe("number");
		expect(Array.isArray(state.todoPhases)).toBe(true);
		// The request-prefix cache preview depends on these two.
		expect(isStringArray(state.systemPrompt)).toBe(true);
		expect(state.systemPrompt!.length).toBeGreaterThan(0);
		expect(Array.isArray(state.dumpTools)).toBe(true);
		for (const tool of state.dumpTools!) {
			expect(typeof tool.name).toBe("string");
			expect(typeof tool.description).toBe("string");
			expect(tool).toHaveProperty("parameters");
		}
	}, 60_000);

	test("get_btw_history answers with the session's /btw topics (none yet)", async () => {
		// HostedSession seeds the BTW panel from it; an omp without /btw over RPC would throw here.
		expect(await source.getBtwHistory()).toEqual([]);
	});

	test("get_entries returns { entries, leafId }", async () => {
		const result = await source.getEntries();
		expect(Array.isArray(result.entries)).toBe(true);
		expect(result.leafId === null || typeof result.leafId === "string").toBe(true);
		for (const entry of result.entries) {
			expect(typeof entry.id).toBe("string");
			expect(typeof entry.type).toBe("string");
		}
		if (result.entries.length > 0) expect(typeof result.leafId).toBe("string");
	}, 60_000);

	test("`omp session lease --json` reports a free session id as neither held nor unknown", async () => {
		const id = crypto.randomUUID();
		const proc = Bun.spawn([omp.path, "session", "lease", "--json", "--", id], {
			cwd: sandbox.cwd,
			env: { ...Bun.env, PI_CODING_AGENT_DIR: join(sandbox.root, "agent") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code, err).toBe(0);
		const parsed = JSON.parse(out) as { held: unknown; unknown: unknown };
		expect(Object.keys(parsed).sort()).toEqual(["held", "unknown"]);
		expect(Array.isArray(parsed.held)).toBe(true);
		expect(Array.isArray(parsed.unknown)).toBe(true);
		expect(parsed.held).not.toContain(id);
	}, 60_000);
});
