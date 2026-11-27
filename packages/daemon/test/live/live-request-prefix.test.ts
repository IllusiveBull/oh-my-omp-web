import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OmpRpcSource } from "../../src/omp-source";
import { makeSandbox, requireOmp } from "./live-env";

// Live contract: what omp puts on the wire for the cacheable request prefix must stay in step with
// what it reports over RPC (`get_state.systemPrompt`, `dumpTools`), which the daemon's cache preview relies on.
// A local fake Anthropic Messages server captures the body; omp is isolated via PI_CODING_AGENT_DIR + a fake API key.

const sandbox = makeSandbox("omp-web-live-prefix-");
const MODEL = "anthropic/claude-opus-5-5";
const PROMPT = "hi";

interface WireBlock {
	type?: string;
	text?: string;
	cache_control?: unknown;
}
interface WireBody {
	system?: string | WireBlock[];
	tools?: Array<{ name: string }>;
	messages?: unknown[];
}

const captured: WireBody[] = [];
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/v1/messages"))
			return new Response("not found", { status: 404 });
		captured.push((await req.json()) as WireBody);
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

const saved: Record<string, string | undefined> = {};
const overrides: Record<string, string> = {
	// OmpRpcSource spawns omp with the daemon's own environment, so isolate by overriding it for the duration of the test.
	PI_CODING_AGENT_DIR: join(sandbox.root, "agent"),
	ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
	ANTHROPIC_API_KEY: "sk-ant-fake-live-contract",
};
let source: OmpRpcSource;

beforeAll(async () => {
	for (const [k, v] of Object.entries(overrides)) {
		saved[k] = Bun.env[k];
		Bun.env[k] = v;
	}
	const omp = await requireOmp();
	source = new OmpRpcSource({ ompPath: omp.path, cwd: sandbox.cwd, sessionDir: sandbox.sessionDir, model: MODEL });
	await source.start();
}, 60_000);

afterAll(async () => {
	await source?.stop();
	await server.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete Bun.env[k];
		else Bun.env[k] = v;
	}
	sandbox.cleanup();
});

describe("omp request prefix vs RPC-reported prefix", () => {
	test("wire `system` and `tools` match get_state.systemPrompt / dumpTools", async () => {
		const done = Promise.withResolvers<void>();
		source.onPromptResult(r => (r.status === "error" ? done.reject(new Error(r.error?.message)) : done.resolve()));
		await source.prompt(PROMPT);
		await done.promise;
		const state = await source.getState();

		// The main request is the one carrying tools; auxiliary calls (e.g. title generation) have none.
		const main = captured.find(b => (b.tools?.length ?? 0) > 0 && JSON.stringify(b.messages).includes(PROMPT));
		expect(main, `captured ${captured.length} request(s)`).toBeDefined();

		expect(Array.isArray(main!.system)).toBe(true);
		const wireSystem = (main!.system as WireBlock[]).map(b => b.text);
		expect(wireSystem).toEqual(state.systemPrompt!);

		// Names and order only: the wire tools add the intent field `i`, `strict`, rendered examples and cache_control
		// that dumpTools omits (verify-4), so schemas/descriptions are not comparable byte-for-byte.
		expect(main!.tools!.map(t => t.name)).toEqual(state.dumpTools!.map(t => t.name));
	}, 60_000);
});
