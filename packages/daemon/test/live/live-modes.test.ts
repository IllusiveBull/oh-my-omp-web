import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { SequencedEvent } from "@omp-web/protocol";
import { OmpRpcSource } from "../../src/omp-source";
import { ompConfigRunner } from "../../src/model-roles";
import { HostedSession } from "../../src/session";
import { makeSandbox, requireOmp } from "./live-env";

// Live contract for the daemon's `/loop` and `/goal`: the loop is driven by omp's `session_settled` frame and goal mode by
// its RPC `goal` command. A local fake Anthropic server answers every request with "ok"; omp is isolated via
// PI_CODING_AGENT_DIR and a fake API key.

const sandbox = makeSandbox("omp-web-live-modes-");
const MODEL = "anthropic/claude-opus-5-5";

/** Prompts of the main requests (the ones carrying tools; title generation and the like have none), in order. */
const turns: string[] = [];
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/v1/messages"))
			return new Response("not found", { status: 404 });
		const body = (await req.json()) as { tools?: unknown[]; messages?: { role: string; content: unknown }[] };
		if ((body.tools?.length ?? 0) > 0) turns.push(JSON.stringify(body.messages?.at(-1)?.content ?? ""));
		const events = [
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
		return new Response(events, { headers: { "content-type": "text/event-stream" } });
	},
});

const saved: Record<string, string | undefined> = {};
const overrides: Record<string, string> = {
	PI_CODING_AGENT_DIR: join(sandbox.root, "agent"),
	ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
	ANTHROPIC_API_KEY: "sk-ant-fake-live-modes",
};

async function hosted(): Promise<{ session: HostedSession; events: SequencedEvent[] }> {
	const omp = await requireOmp();
	const source = new OmpRpcSource({
		ompPath: omp.path,
		cwd: sandbox.cwd,
		sessionDir: sandbox.sessionDir,
		model: MODEL,
	});
	await source.start();
	const config = ompConfigRunner(omp.path, () => ({}));
	const session = await HostedSession.attach({
		source,
		cwd: sandbox.cwd,
		goalContinuesOverRpc: async () => {
			const result = (await config(["get", "goal.continuationModes"], sandbox.cwd)) as { value?: unknown };
			return Array.isArray(result.value) && result.value.includes("rpc");
		},
	});
	const events: SequencedEvent[] = [];
	session.subscribe(batch => events.push(...batch), 0, undefined);
	return { session, events };
}

async function until(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50); // polls a real omp process: there is no single signal for "these requests reached the server"
	}
}

beforeAll(() => {
	for (const [k, v] of Object.entries(overrides)) {
		saved[k] = Bun.env[k];
		Bun.env[k] = v;
	}
});

afterAll(async () => {
	await server.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete Bun.env[k];
		else Bun.env[k] = v;
	}
	sandbox.cleanup();
});

describe("goal and loop modes against the installed omp", () => {
	test("`/loop 2 <prompt>` sends the prompt, repeats it twice on omp's session_settled, then turns itself off", async () => {
		turns.length = 0;
		const { session, events } = await hosted();
		try {
			await session.loop("2 say ok");
			const ended = (): boolean =>
				events.some(e => e.ev.k === "notify" && e.ev.message === "Loop limit reached. Loop mode disabled.");
			await until(ended, "the loop to end");
			expect(turns.filter(t => t.includes("say ok"))).toHaveLength(3);
		} finally {
			await session.close();
		}
	}, 90_000);

	test("with omp's default goal.continuationModes, `/goal` sends the objective as the first run and says why it stops there", async () => {
		turns.length = 0;
		const { session, events } = await hosted();
		try {
			const goal = await session.goal("create", { objective: "say ok" });
			expect(goal).toMatchObject({ objective: "say ok", status: "active" });
			await until(() => turns.length > 0 && session.info.phase === "idle", "the objective's run");
			expect(turns.filter(t => t.includes("say ok"))).toHaveLength(1);
			expect(events.some(e => e.ev.k === "notify" && e.ev.message.includes("goal.continuationModes"))).toBe(true);
			await session.goal("drop");
		} finally {
			await session.close();
		}
	}, 90_000);

	test("with `rpc` in goal.continuationModes omp starts the goal's runs itself, and drop ends it", async () => {
		turns.length = 0;
		const omp = await requireOmp();
		await ompConfigRunner(omp.path, () => ({}))(
			["set", "goal.continuationModes", '["interactive","rpc"]'],
			sandbox.cwd,
		);
		const { session, events } = await hosted();
		try {
			await session.goal("create", { objective: "say ok" });
			// omp's own hidden continuation prompt, not the objective sent by the daemon
			await until(() => turns.some(t => t.includes("Continue active goal")), "omp's goal run");
			expect(turns.filter(t => t.includes("say ok") && !t.includes("Continue active goal"))).toEqual([]);
			expect(events.some(e => e.ev.k === "notify" && e.ev.message.includes("goal.continuationModes"))).toBe(false);
			await session.goal("drop");
			await until(() => session.info.phase === "idle", "the session to go idle");
			const joined = session.subscribe(() => {}, 0, undefined).result;
			if (joined.kind !== "snapshot") throw new Error("a fresh subscriber gets a snapshot");
			expect(joined.snapshot.status?.goal?.status ?? "none").not.toBe("active");
		} finally {
			await session.close();
		}
	}, 90_000);
});
