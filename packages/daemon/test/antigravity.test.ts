import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applySessionEvent,
	defaultCapabilities,
	emptySessionView,
	fromSnapshot,
	type SessionEvent,
} from "@omp-web/protocol";
import {
	AntigravityAcpSource,
	AntigravityAuthError,
	authenticateAntigravity,
	probeAntigravityAuth,
} from "../src/antigravity-acp";
import { locateAntigravity } from "../src/antigravity-binary";
import {
	AntigravitySessionRegistry,
	parseAntigravityTranscript,
	scanAntigravityConversations,
} from "../src/antigravity-sessions";
import { parseFileConfig, resolveConfig } from "../src/config";
import { GatewayStore } from "../src/db";
import { SessionActionError, SessionManager } from "../src/manager";
import { HostedSession } from "../src/session";
import { StoredSession } from "../src/stored-session";

const dirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/**
 * Writes a real executable fake `agy` script that speaks ACP JSON-RPC 2.0 over stdin/stdout (and `--version`).
 * Supports `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`,
 * `session/set_config_option`, `session/request_permission`, and `session/update` streaming.
 */
function writeFakeAgy(dir: string, options: { uniqueSessionIds?: boolean } = {}): string {
	const scriptPath = join(dir, "fake-agy.ts");
	const binPath = join(dir, "fake-agy");
	const newSessionIdExpr = options.uniqueSessionIds ? "`agy-sess-${process.pid}-${Date.now()}`" : '"agy-sess-new"';
	const script = `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.includes("--version")) {
	console.log("agy 1.2.3");
	process.exit(0);
}

let model = "gemini-2.5-pro";
let thinking = "medium";
let agentMode = "default";
let sessionId = "agy-sess-1";
let nextReqId = 100;
const pendingClientReplies = new Map<number, (result: any) => void>();
let activePromptResolve: (() => void) | null = null;
let activeCancelled = false;
let authenticated = process.env.FAKE_AGY_REQUIRE_AUTH !== "1";

function send(obj: Record<string, unknown>) {
	process.stdout.write(JSON.stringify(obj) + "\\n");
}

function configOptions() {
	return [
		{
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: model,
			options: [
				{ value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
				{ value: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
			],
		},
		{
			id: "thinking_level",
			name: "Thinking",
			category: "thought_level",
			type: "select",
			currentValue: thinking,
			options: [
				{ value: "low", name: "Low" },
				{ value: "medium", name: "Medium" },
				{ value: "high", name: "High" },
			],
		},
		{
			id: "mode",
			name: "Mode",
			category: "mode",
			type: "select",
			currentValue: agentMode,
			options: [
				{ value: "default", name: "Default", description: "Ask before risky actions" },
				{ value: "auto", name: "Auto", description: "Approve safe actions automatically" },
				{ value: "plan", name: "Plan", description: "Read-only planning" },
			],
		},
	];
}

function sendUpdate(update: Record<string, unknown>) {
	send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

let steerWaiter: ((steeredId: number, steeredText: string) => void) | null = null;

function askPermission(title: string, command: string, kind = "execute"): Promise<any> {
	const id = ++nextReqId;
	return new Promise(resolve => {
		pendingClientReplies.set(id, resolve);
		send({
			jsonrpc: "2.0",
			id,
			method: "session/request_permission",
			params: {
				sessionId,
				toolCall: { toolCallId: "tc-perm", title, kind, rawInput: { command } },
				options: [
					{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
					{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
				],
			},
		});
	});
}

async function handlePrompt(id: number, params: any) {
	const text = (params.prompt ?? []).map((b: any) => (b.type === "text" ? b.text : "")).join("");
	if (steerWaiter) {
		const cb = steerWaiter;
		steerWaiter = null;
		cb(id, text);
		return;
	}
	activeCancelled = false;

	if (text.includes("STEER_TOOL")) {
		sendUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "tc-steer",
			title: "sleep 3",
			kind: "execute",
			rawInput: { CommandLine: "sleep 3" },
			status: "in_progress",
		});
		const steered = await new Promise<{ id: number; text: string }>(resolve => {
			steerWaiter = (steeredId, steeredText) => resolve({ id: steeredId, text: steeredText });
		});
		// Mirrors real agy acp: superseded prompt resolves immediately while the running tool completes.
		send({
			jsonrpc: "2.0",
			id,
			result: {
				stopReason: "end_turn",
				usage: { inputTokens: 100, cachedReadTokens: 0, outputTokens: 20, thoughtTokens: 0, totalTokens: 120 },
			},
		});
		await new Promise(resolve => setTimeout(resolve, 60));
		sendUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-steer",
			kind: "execute",
			status: "completed",
			rawOutput: "tool finished",
		});
		sendUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: \`Steered: \${steered.text}\` },
		});
		send({
			jsonrpc: "2.0",
			id: steered.id,
			result: {
				stopReason: "end_turn",
				usage: { inputTokens: 200, cachedReadTokens: 50, outputTokens: 30, thoughtTokens: 0, totalTokens: 230 },
			},
		});
		return;
	}

	if (text.startsWith("READ_IMAGE:")) {
		const imgPath = text.slice("READ_IMAGE:".length).trim();
		sendUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "tc-read-img",
			title: \`File \${imgPath}\`,
			kind: "read",
			locations: [{ path: imgPath }],
			rawInput: { Path: imgPath },
			status: "in_progress",
		});
		sendUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-read-img",
			title: \`File \${imgPath}\`,
			kind: "read",
			locations: [{ path: imgPath }],
			rawInput: { Path: imgPath },
			status: "completed",
		});
		sendUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "tc-inline-img",
			title: "Render chart",
			kind: "other",
			status: "in_progress",
		});
		sendUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-inline-img",
			status: "completed",
			content: [
				{ type: "content", content: { type: "text", text: "chart ready" } },
				{ type: "content", content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } },
			],
		});
		sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Read images." } });
		send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
		return;
	}

	if (text.startsWith("READ_FILES:")) {
		const spec = JSON.parse(text.slice("READ_FILES:".length).trim()) as Array<{
			id: string;
			path: string;
			startLine?: number;
			endLine?: number;
		}>;
		for (const item of spec) {
			const input: Record<string, unknown> = { Path: item.path };
			if (item.startLine !== undefined) input.StartLine = item.startLine;
			if (item.endLine !== undefined) input.EndLine = item.endLine;
			sendUpdate({
				sessionUpdate: "tool_call",
				toolCallId: item.id,
				title: \`File \${item.path}\`,
				kind: "read",
				locations: [{ path: item.path }],
				rawInput: input,
				status: "in_progress",
			});
			sendUpdate({
				sessionUpdate: "tool_call_update",
				toolCallId: item.id,
				title: \`File \${item.path}\`,
				kind: "read",
				locations: [{ path: item.path }],
				rawInput: input,
				status: "completed",
			});
		}
		sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Read files." } });
		send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
		return;
	}

	if (text.includes("ASK_EDIT")) {
		sendUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "tc-edit",
			title: "Edit README.md",
			kind: "edit",
			rawInput: { path: "README.md" },
			status: "pending",
		});
		const reply = await askPermission("Edit README.md", "README.md", "edit");
		const allowed = reply?.outcome?.outcome === "selected" && reply?.outcome?.optionId === "allow_once";
		sendUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-edit",
			status: allowed ? "completed" : "failed",
			rawOutput: allowed ? "edited" : "denied",
		});
		sendUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: allowed ? "Edit approved." : "Edit denied." },
		});
		send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
		return;
	}

	if (text.includes("ASK_PERM")) {
		sendUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Need permission." } });
		sendUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "tc-perm",
			title: "Run tests",
			kind: "execute",
			rawInput: { command: "bun test" },
			status: "pending",
		});
		const reply = await askPermission("Run tests", "bun test");
		const allowed = reply?.outcome?.outcome === "selected" && reply?.outcome?.optionId === "allow_once";
		sendUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-perm",
			status: allowed ? "completed" : "failed",
			rawOutput: allowed ? "tests passed" : "permission denied",
		});
		sendUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: allowed ? "Done: tests passed." : "Stopped: permission denied." },
		});
		send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
		return;
	}

	if (text.includes("SLOW_TURN")) {
		sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working..." } });
		await new Promise<void>(resolve => {
			activePromptResolve = resolve;
			setTimeout(resolve, 120);
		});
		activePromptResolve = null;
		send({ jsonrpc: "2.0", id, result: { stopReason: activeCancelled ? "cancelled" : "end_turn" } });
		return;
	}

	if (text.includes("BG_JOB")) {
		// agy's async run_command: the reply ends the turn while the command runs; when it finishes, agy reports
		// it in a run of its own, with no session/prompt and no response closing it.
		const command = { CommandLine: "ping -n 5 127.0.0.1", IsDaemon: false, WaitMsBeforeAsync: 500 };
		sendUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-bg", title: command.CommandLine, kind: "execute", rawInput: command, status: "in_progress" });
		sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "started" } });
		sendUpdate({ sessionUpdate: "usage_update", used: 900, size: 100000 });
		send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
		await new Promise(resolve => setTimeout(resolve, 300));
		sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc-bg", kind: "execute", rawInput: command, status: "completed", rawOutput: { output: "job output" } });
		await new Promise(resolve => setTimeout(resolve, 100));
		sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Job finished." } });
		sendUpdate({ sessionUpdate: "usage_update", used: 1000, size: 100000 });
		return;
	}

	sendUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Analyzing request." } });
	sendUpdate({
		sessionUpdate: "plan",
		entries: [
			{ content: "Inspect workspace", status: "completed" },
			{ content: "Reply to user", status: "in_progress" },
		],
	});
	sendUpdate({
		sessionUpdate: "tool_call",
		toolCallId: "tc-1",
		title: "Read package.json",
		kind: "read",
		rawInput: { path: "package.json" },
		status: "in_progress",
	});
	sendUpdate({
		sessionUpdate: "tool_call_update",
		toolCallId: "tc-1",
		status: "completed",
		content: [{ type: "content", content: { type: "text", text: '{"name":"omp-web"}' } }],
	});
	sendUpdate({
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text: \`Echo[\${model}/\${thinking}]: \${text}\` },
	});
	sendUpdate({ sessionUpdate: "usage_update", used: 1200, size: 100000 });
	sendUpdate({ sessionUpdate: "session_info_update", title: "ACP Demo Title" });
	send({
		jsonrpc: "2.0",
		id,
		result: {
			stopReason: "end_turn",
			usage: { inputTokens: 800, cachedReadTokens: 200, outputTokens: 200, thoughtTokens: 50, totalTokens: 1200 },
		},
	});
}

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += decoder.decode(chunk, { stream: true });
	for (;;) {
		const nl = buf.indexOf("\\n");
		if (nl < 0) break;
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		const msg = JSON.parse(line);
		if (msg.id !== undefined && !msg.method) {
			const waiter = pendingClientReplies.get(msg.id);
			if (waiter) {
				pendingClientReplies.delete(msg.id);
				waiter(msg.result);
			}
			continue;
		}
		switch (msg.method) {
			case "initialize":
				send({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						protocolVersion: 1,
						agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
						authMethods: [
							{ id: "oauth-personal", name: "Google Account", description: "Sign in with Google" },
							{ id: "gemini-api-key", name: "Gemini API Key", description: "Use GEMINI_API_KEY" },
						],
					},
				});
				break;
			case "authenticate":
				if (msg.params?.methodId === "gemini-api-key" && !process.env.GEMINI_API_KEY) {
					send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "GEMINI_API_KEY is not set" } });
					break;
				}
				authenticated = true;
				send({ jsonrpc: "2.0", id: msg.id, result: {} });
				break;
			case "session/new":
				if (!authenticated) {
					send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Authentication required" } });
					break;
				}
				sessionId = ${newSessionIdExpr};
				send({ jsonrpc: "2.0", id: msg.id, result: { sessionId, configOptions: configOptions() } });
				sendUpdate({
					sessionUpdate: "available_commands_update",
					availableCommands: [{ name: "plan", description: "Create a plan" }],
				});
				break;
			case "session/load":
				sessionId = msg.params.sessionId;
				if (sessionId === "agy-replay") {
					sendUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Previous question" } });
					sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Previous answer" } });
				}
				send({ jsonrpc: "2.0", id: msg.id, result: { sessionId, configOptions: configOptions() } });
				break;
			case "session/set_config_option":
				if (msg.params.configId === "model") model = msg.params.value;
				if (msg.params.configId === "thinking_level") thinking = msg.params.value;
				if (msg.params.configId === "mode") agentMode = msg.params.value;
				send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: configOptions() } });
				sendUpdate({ sessionUpdate: "config_option_update", configOptions: configOptions() });
				break;
			case "session/set_mode":
				agentMode = msg.params.modeId;
				send({ jsonrpc: "2.0", id: msg.id, result: {} });
				sendUpdate({ sessionUpdate: "current_mode_update", currentModeId: agentMode });
				break;
			case "session/prompt":
				void handlePrompt(msg.id, msg.params);
				break;
			case "session/cancel":
				activeCancelled = true;
				activePromptResolve?.();
				break;
			default:
				if (msg.id !== undefined) {
					send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } });
				}
		}
	}
}
`;
	writeFileSync(scriptPath, script, "utf8");
	writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, "utf8");
	chmodSync(binPath, 0o755);
	return binPath;
}

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("Antigravity ACP RPC end-to-end", () => {
	test("HostedSession over AntigravityAcpSource streams thinking, tools, plan, permissions, model switch, and follow-up queue", async () => {
		const dir = tempDir("agy-acp-");
		const agyBin = writeFakeAgy(dir);
		const registry = new AntigravitySessionRegistry(join(dir, "registry.json"));

		const source = new AntigravityAcpSource({
			binaryPath: agyBin,
			cwd: dir,
			onMetadata: patch => registry.upsert(patch),
		});
		await source.start();
		const session = await HostedSession.attach({ source, cwd: dir });

		try {
			expect(session.backend).toBe("antigravity");
			expect(session.info.backend).toBe("antigravity");
			expect(session.capabilities).toEqual(defaultCapabilities("antigravity"));

			const events: SessionEvent[] = [];
			let view = emptySessionView;
			const sub = session.subscribe(
				batch => {
					for (const item of batch) {
						events.push(item.ev);
						view = applySessionEvent(view, item.ev, Date.now());
					}
				},
				0,
				undefined,
			);
			expect(sub.result.kind).toBe("snapshot");
			if (sub.result.kind === "snapshot") view = fromSnapshot(sub.result.snapshot);

			// 1. Model and thinking options from ACP configOptions
			const opts = await session.options();
			expect(opts.models.map(m => `${m.provider}/${m.id}`)).toEqual([
				"antigravity/gemini-2.5-pro",
				"antigravity/gemini-2.5-flash",
			]);
			expect(opts.thinkingLevels).toEqual(["low", "medium", "high"]);

			await session.setModel("antigravity", "gemini-2.5-flash");
			await session.setThinking("high");
			expect(session.info.model).toBe("antigravity/gemini-2.5-flash");

			// 2. Prompt turn with thinking + tool call + plan + usage + title update
			const done1 = new Promise<void>(resolve => {
				const check = setInterval(() => {
					if (events.some(e => e.k === "prompt_result")) {
						clearInterval(check);
						resolve();
					}
				}, 10);
			});
			await session.prompt("Hello Antigravity");
			await done1;
			await session.whenSynced();

			expect(view.entries.length).toBeGreaterThanOrEqual(4); // user, assistant(toolCall), toolResult, assistant(final)
			const finalAssistant = view.entries.findLast(e => e.type === "message" && e.message.role === "assistant");
			expect(finalAssistant?.type).toBe("message");
			if (finalAssistant?.type === "message" && finalAssistant.message.role === "assistant") {
				const text = finalAssistant.message.content.find(c => c.type === "text");
				expect(text?.type === "text" ? text.text : "").toContain("Echo[gemini-2.5-flash/high]: Hello Antigravity");
			}
			expect(view.status?.todos[0]?.tasks).toHaveLength(2);
			expect(view.status?.sessionName).toBe("ACP Demo Title");
			expect(view.status?.contextUsage?.percent).toBeCloseTo(1.2, 1);
			expect(registry.get("agy-sess-new")?.title).toBe("ACP Demo Title");

			// 3. Permission request round-trip via extension UI
			const permSeen = new Promise<string>(resolve => {
				const check = setInterval(() => {
					const ui = events.find(e => e.k === "ui");
					if (ui && ui.k === "ui") {
						clearInterval(check);
						resolve(ui.request.id);
					}
				}, 10);
			});
			const resultsBefore = events.filter(e => e.k === "prompt_result").length;
			await session.prompt("ASK_PERM");
			const permId = await permSeen;
			session.respondUi(permId, { value: "Allow once" });
			await new Promise<void>(resolve => {
				const check = setInterval(() => {
					if (events.filter(e => e.k === "prompt_result").length > resultsBefore) {
						clearInterval(check);
						resolve();
					}
				}, 10);
			});
			await session.whenSynced();
			const afterPerm = view.entries.findLast(e => e.type === "message" && e.message.role === "assistant");
			if (afterPerm?.type === "message" && afterPerm.message.role === "assistant") {
				const text = afterPerm.message.content.find(c => c.type === "text");
				expect(text?.type === "text" ? text.text : "").toContain("Done: tests passed.");
			}

			// 4. Follow-up queue while working (and queue removal)
			const resultsBeforeQueue = events.filter(e => e.k === "prompt_result").length;
			await session.prompt("SLOW_TURN");
			await session.followUp("discard me");
			await session.followUp("queued follow-up");
			expect(await session.removeQueued("discard me", "followUp")).toBe(true);
			await new Promise<void>(resolve => {
				const check = setInterval(() => {
					if (events.filter(e => e.k === "prompt_result").length >= resultsBeforeQueue + 2) {
						clearInterval(check);
						resolve();
					}
				}, 10);
			});
			await session.whenSynced();
			const afterQueue = view.entries.findLast(e => e.type === "message" && e.message.role === "assistant");
			if (afterQueue?.type === "message" && afterQueue.message.role === "assistant") {
				const text = afterQueue.message.content.find(c => c.type === "text");
				expect(text?.type === "text" ? text.text : "").toContain("queued follow-up");
			}

			// 5. Capability guards for unsupported omp-only commands, and Antigravity /context report
			await expect(session.compact()).rejects.toThrow(/compaction/i);
			await expect(session.btw("side")).rejects.toThrow(/btw/i);
			await expect(session.goal("create", { objective: "x" })).rejects.toThrow(/goal/i);
			const contextReport = await session.context();
			expect(contextReport).toContain("Context window: 100000 tokens");
			expect(contextReport).toContain("Used: 1,200 / 100,000 tokens (live ACP usage_update)");
			expect(contextReport).toContain("Last turn: 800 input · 200 cached read · 200 output (50 thinking)");
			expect(await session.handoffBlockers()).toEqual([
				"Environment switching is not supported for Antigravity sessions.",
			]);

			sub.unsubscribe();
		} finally {
			await session.close();
		}
	});

	test("permissionMode (edits / auto) auto-approves permissions and switching mid-prompt unblocks pending dialogs", async () => {
		const dir = tempDir("agy-perm-");
		const agyBin = writeFakeAgy(dir);
		const source = new AntigravityAcpSource({
			binaryPath: agyBin,
			cwd: dir,
			permissionMode: "edits",
		});
		await source.start();
		const session = await HostedSession.attach({ source, cwd: dir });

		try {
			const opts = await session.options();
			expect(opts.modes?.map(m => m.id)).toEqual(["default", "auto", "plan"]);
			expect(opts.permissionModes).toEqual(["ask", "edits", "auto"]);

			const events: SessionEvent[] = [];
			let view = emptySessionView;
			const sub = session.subscribe(
				batch => {
					for (const item of batch) {
						events.push(item.ev);
						view = applySessionEvent(view, item.ev, Date.now());
					}
				},
				0,
				undefined,
			);
			if (sub.result.kind === "snapshot") view = fromSnapshot(sub.result.snapshot);
			expect(view.status?.agentMode).toBe("default");
			expect(view.status?.permissionMode).toBe("edits");

			// Switching ACP native mode updates status.agentMode
			await session.setMode("auto");
			expect(view.status?.agentMode).toBe("auto");

			// In `edits` mode, edit permission requests are auto-approved with zero UI popups
			await session.prompt("ASK_EDIT");
			await new Promise<void>(resolve => {
				const check = setInterval(() => {
					if (events.some(e => e.k === "prompt_result")) {
						clearInterval(check);
						resolve();
					}
				}, 10);
			});
			await session.whenSynced();
			expect(events.some(e => e.k === "ui")).toBe(false);
			const editReply = view.entries.findLast(e => e.type === "message" && e.message.role === "assistant");
			if (editReply?.type === "message" && editReply.message.role === "assistant") {
				const text = editReply.message.content.find(c => c.type === "text");
				expect(text?.type === "text" ? text.text : "").toContain("Edit approved.");
			}

			// In `edits` mode, shell execute STILL prompts — and switching to `auto` immediately approves & closes the popup
			const resultsBefore = events.filter(e => e.k === "prompt_result").length;
			await session.prompt("ASK_PERM");
			await new Promise<void>(resolve => {
				const check = setInterval(() => {
					if (view.uiRequests.length > 0) {
						clearInterval(check);
						resolve();
					}
				}, 10);
			});
			expect(view.uiRequests).toHaveLength(1);

			await session.setPermissionMode("auto");
			await new Promise<void>(resolve => {
				const check = setInterval(() => {
					if (events.filter(e => e.k === "prompt_result").length > resultsBefore) {
						clearInterval(check);
						resolve();
					}
				}, 10);
			});
			await session.whenSynced();
			expect(view.uiRequests).toHaveLength(0);
			expect(view.status?.permissionMode).toBe("auto");
			const execReply = view.entries.findLast(e => e.type === "message" && e.message.role === "assistant");
			if (execReply?.type === "message" && execReply.message.role === "assistant") {
				const text = execReply.message.content.find(c => c.type === "text");
				expect(text?.type === "text" ? text.text : "").toContain("Done: tests passed.");
			}

			sub.unsubscribe();
		} finally {
			await session.close();
		}
	});

	test("a command left running past the reply keeps the session working until agy's own follow-up run ends", async () => {
		const dir = tempDir("agy-bg-");
		writeFakeAgy(dir);
		// Bun runs the fake directly, so this also works where the `#!/bin/sh` wrapper cannot.
		const source = new AntigravityAcpSource({
			binaryPath: process.execPath,
			args: [join(dir, "fake-agy.ts"), "acp"],
			cwd: dir,
		});
		await source.start();
		const session = await HostedSession.attach({ source, cwd: dir });
		const until = async (what: string, check: () => boolean, ms = 5_000): Promise<void> => {
			const deadline = Date.now() + ms;
			while (!check()) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
				await Bun.sleep(10);
			}
		};
		try {
			const events: SessionEvent[] = [];
			let view = emptySessionView;
			const sub = session.subscribe(
				batch => {
					for (const item of batch) {
						events.push(item.ev);
						view = applySessionEvent(view, item.ev, Date.now());
					}
				},
				0,
				undefined,
			);
			if (sub.result.kind === "snapshot") view = fromSnapshot(sub.result.snapshot);

			await session.prompt("BG_JOB");
			await until("the reply", () => events.some(e => e.k === "prompt_result"));
			await session.whenSynced();
			// The reply is in, the command is not: still working.
			await until("background work", () => session.info.phase === "working");
			expect((await source.getState()).hasPendingAsyncWork).toBe(true);

			await until("agy's follow-up run to end", () => session.info.phase === "idle");
			await session.whenSynced();
			expect((await source.getState()).hasPendingAsyncWork).toBe(false);
			const texts = view.entries.flatMap(e =>
				e.type === "message" && e.message.role === "assistant"
					? e.message.content.flatMap(c => (c.type === "text" ? [c.text] : []))
					: [],
			);
			expect(texts).toEqual(["started", "Job finished."]);
			const result = view.entries.find(e => e.type === "message" && e.message.role === "toolResult");
			expect(
				result?.type === "message" && result.message.role === "toolResult" ? result.message : undefined,
			).toMatchObject({
				toolCallId: "tc-bg",
				isError: false,
				content: [{ type: "text", text: expect.stringContaining("job output") }],
			});
			sub.unsubscribe();
		} finally {
			await session.close();
		}
	});

	test("mid-turn steer sends a concurrent session/prompt and commits the steered message after the in-flight tool finishes", async () => {
		const dir = tempDir("agy-steer-");
		const agyBin = writeFakeAgy(dir);
		const source = new AntigravityAcpSource({ binaryPath: agyBin, cwd: dir });
		await source.start();
		const session = await HostedSession.attach({ source, cwd: dir });
		try {
			const workingTrace: boolean[] = [];
			const queueEvents: { steering: string[]; liveSteered: number }[] = [];
			let view = emptySessionView;
			const sub = session.subscribe(
				batch => {
					for (const item of batch) {
						view = applySessionEvent(view, item.ev, Date.now());
						workingTrace.push(view.working);
						if (item.ev.k === "status_patch" && item.ev.patch.queue) {
							queueEvents.push({
								steering: item.ev.patch.queue.steering,
								liveSteered: item.ev.patch.queue.liveSteered,
							});
						}
					}
				},
				0,
				undefined,
			);

			await session.prompt("STEER_TOOL");
			// Wait for the in-progress tool to appear.
			await new Promise<void>(resolve => {
				const t = setInterval(() => {
					if (view.activeTools.has("tc-steer")) {
						clearInterval(t);
						resolve();
					}
				}, 10);
			});

			await session.steer("change course");
			// Wait for the steered turn to settle completely.
			await new Promise<void>(resolve => {
				const t = setInterval(() => {
					if (!view.working && view.entries.length >= 5) {
						clearInterval(t);
						resolve();
					}
				}, 15);
			});
			await session.whenSynced();

			// Steering queue showed the live-steered prompt until the tool finished, then cleared.
			expect(queueEvents.some(q => q.steering.includes("change course") && q.liveSteered === 1)).toBe(true);
			expect(view.status?.queue.steering).toEqual([]);
			expect(view.status?.queue.liveSteered).toBe(0);

			// Transcript order: initial prompt -> toolCall -> toolResult -> steered user message -> steered reply.
			const roles = view.entries.map(e => (e.type === "message" ? e.message.role : e.type));
			expect(roles).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
			const steeredUser = view.entries[3];
			expect(
				steeredUser?.type === "message" && steeredUser.message.role === "user" ? steeredUser.message.content : "",
			).toBe("change course");
			const steeredReply = view.entries[4];
			const replyText =
				steeredReply?.type === "message" && steeredReply.message.role === "assistant"
					? steeredReply.message.content.find(c => c.type === "text")
					: undefined;
			expect(replyText?.type === "text" ? replyText.text : "").toBe("Steered: change course");

			// Session stayed continuously working from agent_start until the steered turn completed.
			const firstTrue = workingTrace.indexOf(true);
			const lastTrue = workingTrace.lastIndexOf(true);
			expect(firstTrue).toBeGreaterThanOrEqual(0);
			expect(workingTrace.slice(firstTrue, lastTrue + 1).every(Boolean)).toBe(true);
			sub.unsubscribe();
		} finally {
			await session.close();
		}
	});

	test("read tool normalizes Path -> path and attaches local raster images + ACP inline image blocks", async () => {
		const dir = tempDir("agy-read-img-");
		const agyBin = writeFakeAgy(dir);
		// Minimal valid 1x1 PNG header + bytes
		const pngBytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		);
		const imgPath = join(dir, "sample.png");
		writeFileSync(imgPath, pngBytes);

		const source = new AntigravityAcpSource({ binaryPath: agyBin, cwd: dir });
		await source.start();
		const session = await HostedSession.attach({ source, cwd: dir });
		try {
			let view = emptySessionView;
			const sub = session.subscribe(
				batch => {
					for (const item of batch) view = applySessionEvent(view, item.ev, Date.now());
				},
				0,
				undefined,
			);

			await session.prompt(`READ_IMAGE:${imgPath}`);
			await new Promise<void>(resolve => {
				const t = setInterval(() => {
					if (!view.working && view.entries.length >= 4) {
						clearInterval(t);
						resolve();
					}
				}, 15);
			});
			await session.whenSynced();

			// Assistant toolCall normalized rawInput.Path + locations[0].path into lowercase args.path.
			const assistant = view.entries.find(e => e.type === "message" && e.message.role === "assistant");
			const readCall =
				assistant?.type === "message" && assistant.message.role === "assistant"
					? assistant.message.content.find(c => c.type === "toolCall" && c.id === "tc-read-img")
					: undefined;
			expect(readCall?.type === "toolCall" ? readCall.arguments.path : undefined).toBe(imgPath);

			// Local read image was sniffed and attached as an image block.
			const readResult = view.entries.find(
				e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "tc-read-img",
			);
			expect(
				readResult?.type === "message" && readResult.message.role === "toolResult"
					? readResult.message.content
					: [],
			).toEqual([{ type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" }]);

			// Inline ACP image content block was preserved alongside text.
			const inlineResult = view.entries.find(
				e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "tc-inline-img",
			);
			expect(
				inlineResult?.type === "message" && inlineResult.message.role === "toolResult"
					? inlineResult.message.content
					: [],
			).toEqual([
				{ type: "text", text: "chart ready" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			]);
			sub.unsubscribe();
		} finally {
			await session.close();
		}
	});

	test("read tool loads local code slices, safe SVG previews + source, unsafe SVG source only, and binary notices when ACP omits content", async () => {
		const dir = tempDir("agy-read-files-");
		const agyBin = writeFakeAgy(dir);
		const codePath = join(dir, "index.html");
		writeFileSync(codePath, "line1\nline2\nline3\nline4\n", "utf8");
		const safeSvgPath = join(dir, "icon.svg");
		const safeSvg =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';
		writeFileSync(safeSvgPath, safeSvg, "utf8");
		const unsafeSvgPath = join(dir, "scripted.svg");
		const unsafeSvg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
		writeFileSync(unsafeSvgPath, unsafeSvg, "utf8");
		const pdfPath = join(dir, "doc.pdf");
		writeFileSync(pdfPath, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0x01]));
		const emptyPath = join(dir, "empty.txt");
		writeFileSync(emptyPath, "", "utf8");

		const source = new AntigravityAcpSource({ binaryPath: agyBin, cwd: dir });
		await source.start();
		const session = await HostedSession.attach({ source, cwd: dir });
		try {
			let view = emptySessionView;
			const sub = session.subscribe(
				batch => {
					for (const item of batch) view = applySessionEvent(view, item.ev, Date.now());
				},
				0,
				undefined,
			);

			const spec = [
				{ id: "tc-code", path: codePath, startLine: 2, endLine: 3 },
				{ id: "tc-svg-safe", path: safeSvgPath },
				{ id: "tc-svg-unsafe", path: unsafeSvgPath },
				{ id: "tc-pdf", path: pdfPath },
				{ id: "tc-empty", path: emptyPath },
			];
			await session.prompt(`READ_FILES:${JSON.stringify(spec)}`);
			await new Promise<void>(resolve => {
				const t = setInterval(() => {
					if (
						!view.working &&
						view.entries.some(
							e =>
								e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "tc-empty",
						)
					) {
						clearInterval(t);
						resolve();
					}
				}, 15);
			});
			await session.whenSynced();

			const resultOf = (id: string) => {
				const entry = view.entries.find(
					e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === id,
				);
				return entry?.type === "message" && entry.message.role === "toolResult" ? entry.message.content : [];
			};
			const callOf = (id: string) => {
				for (const e of view.entries) {
					if (e.type === "message" && e.message.role === "assistant") {
						const found = e.message.content.find(c => c.type === "toolCall" && c.id === id);
						if (found?.type === "toolCall") return found;
					}
				}
				return undefined;
			};

			// Code file honors StartLine/EndLine and normalizes them into offset/limit for readRenderer's summary.
			expect(callOf("tc-code")?.arguments).toMatchObject({ path: codePath, offset: 2, limit: 2 });
			expect(resultOf("tc-code")).toEqual([{ type: "text", text: "line2\nline3" }]);

			// Safe SVG attaches both its XML source and an image/svg+xml thumbnail.
			expect(resultOf("tc-svg-safe")).toEqual([
				{ type: "text", text: safeSvg },
				{ type: "image", data: Buffer.from(safeSvg, "utf8").toString("base64"), mimeType: "image/svg+xml" },
			]);

			// Scripted SVG omits the image preview and still displays its source safely.
			expect(resultOf("tc-svg-unsafe")).toEqual([{ type: "text", text: unsafeSvg }]);

			// Binary non-image files display a concise notice instead of an empty body.
			expect(resultOf("tc-pdf")).toEqual([{ type: "text", text: "[PDF file · 10 B]" }]);
			expect(resultOf("tc-empty")).toEqual([{ type: "text", text: "(empty file)" }]);

			sub.unsubscribe();
		} finally {
			await session.close();
		}
	});

	test("session/load replays ACP chunks and falls back to local transcript when replay is empty", async () => {
		const dir = tempDir("agy-resume-");
		const agyBin = writeFakeAgy(dir);

		// Case A: ACP replays chunks during session/load
		const replayed = new AntigravityAcpSource({
			binaryPath: agyBin,
			cwd: dir,
			resumeSessionId: "agy-replay",
		});
		await replayed.start();
		try {
			const { entries } = await replayed.getEntries();
			expect(entries).toHaveLength(2);
		} finally {
			await replayed.stop();
		}

		// Case B: ACP does not replay chunks -> falls back to local transcript.jsonl
		const transcriptPath = join(dir, "transcript.jsonl");
		writeFileSync(
			transcriptPath,
			[
				JSON.stringify({
					step_index: 1,
					type: "USER_INPUT",
					source: "USER_EXPLICIT",
					created_at: "2026-11-20T10:00:00.000Z",
					content: "Fix the build",
				}),
				JSON.stringify({
					step_index: 2,
					type: "PLANNER_RESPONSE",
					source: "MODEL",
					created_at: "2026-11-20T10:00:05.000Z",
					thinking: "Checking config",
					content: "Build is green now.",
				}),
			].join("\n") + "\n",
			"utf8",
		);
		const seeded = new AntigravityAcpSource({
			binaryPath: agyBin,
			cwd: dir,
			resumeSessionId: "agy-no-replay",
			transcriptPath,
		});
		await seeded.start();
		try {
			const { entries } = await seeded.getEntries();
			expect(entries).toHaveLength(2);
		} finally {
			await seeded.stop();
		}
	});
});

describe("Antigravity transcripts, discovery, StoredSession and SessionManager", () => {
	test("parses Antigravity transcript.jsonl into MessageEntry records with thinking, tools, and results", () => {
		const raw = [
			JSON.stringify({
				step_index: 1,
				type: "USER_INPUT",
				source: "USER_EXPLICIT",
				created_at: "2026-11-20T01:00:00.000Z",
				content: "List workspace files",
			}),
			JSON.stringify({
				step_index: 2,
				type: "PLANNER_RESPONSE",
				source: "MODEL",
				created_at: "2026-11-20T01:00:03.000Z",
				thinking: "Let's inspect the directory",
				content: "Checking files now.",
				tool_calls: [{ id: "c1", name: "run_command", arguments: { CommandLine: "ls" }, result: "README.md" }],
			}),
		].join("\n");

		const parsed = parseAntigravityTranscript(raw);
		expect(parsed.preview).toBe("List workspace files");
		expect(parsed.entries).toHaveLength(3); // user, assistant(thinking+text+toolCall), toolResult
		const second = parsed.entries[1];
		expect(second?.type).toBe("message");
		if (second?.type === "message" && second.message.role === "assistant") {
			expect(second.message.content.map(c => c.type)).toEqual(["thinking", "text", "toolCall"]);
		}
	});

	test("shows what the user typed, not the IDE's request envelope", () => {
		const raw = JSON.stringify({
			step_index: 0,
			type: "USER_INPUT",
			source: "USER_EXPLICIT",
			created_at: "2026-11-21T06:41:13Z",
			content:
				"<USER_REQUEST>\nIs the drop rate right?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-21T15:41:13+09:00.\n</ADDITIONAL_METADATA>",
		});
		const parsed = parseAntigravityTranscript(raw);
		expect(parsed.preview).toBe("Is the drop rate right?");
		const first = parsed.entries[0];
		expect(first?.type === "message" && first.message.role === "user" && first.message.content).toBe(
			"Is the drop rate right?",
		);
	});

	test("parses native Antigravity transcript GENERIC steps, unwraps quoted args, and hydrates read code + images", () => {
		const dir = tempDir("agy-transcript-read-");
		const codePath = join(dir, "app.ts");
		writeFileSync(codePath, "export const answer = 42;\n", "utf8");
		const svgPath = join(dir, "logo.svg");
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>';
		writeFileSync(svgPath, svg, "utf8");
		const pngPath = join(dir, "shot.png");
		const pngBytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		);
		writeFileSync(pngPath, pngBytes);

		const raw = [
			JSON.stringify({ step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "Inspect files" }),
			JSON.stringify({
				step_index: 1,
				type: "PLANNER_RESPONSE",
				source: "MODEL",
				tool_calls: [
					{ name: "read_file", args: { Path: JSON.stringify(codePath) } },
					{ name: "read_file", args: { Path: JSON.stringify(svgPath) } },
					{ name: "read_file", args: { Path: JSON.stringify(pngPath) } },
				],
			}),
			JSON.stringify({
				step_index: 2,
				type: "GENERIC",
				source: "MODEL",
				status: "DONE",
				content:
					"Created At: 2026-11-26T22:00:00+09:00\nCompleted At: 2026-11-26T22:00:01+09:00\nShowing lines 1-1 of 1\n1: export const answer = 42;",
			}),
			JSON.stringify({
				step_index: 3,
				type: "GENERIC",
				source: "MODEL",
				status: "DONE",
				content: `Created At: 2026-11-26T22:00:00+09:00\nCompleted At: 2026-11-26T22:00:01+09:00\nShowing lines 1-1 of 1\n1: ${svg}`,
			}),
			JSON.stringify({
				step_index: 4,
				type: "GENERIC",
				source: "MODEL",
				status: "DONE",
				content: "Created At: 2026-11-26T22:00:00+09:00\nShowing binary file of type image/png",
				media: [{ mime_type: "image/png", uri: `file://${pngPath}` }],
			}),
		].join("\n");

		const parsed = parseAntigravityTranscript(raw, Date.now(), { cwd: dir, hydrateLocalReads: true });
		const assistant = parsed.entries[1];
		expect(assistant?.type === "message" && assistant.message.role === "assistant").toBe(true);
		if (assistant?.type === "message" && assistant.message.role === "assistant") {
			expect(assistant.message.content).toEqual([
				{ type: "toolCall", id: "agy_call_1_1", name: "read", arguments: { Path: codePath, path: codePath } },
				{ type: "toolCall", id: "agy_call_1_2", name: "read", arguments: { Path: svgPath, path: svgPath } },
				{ type: "toolCall", id: "agy_call_1_3", name: "read", arguments: { Path: pngPath, path: pngPath } },
			]);
		}

		const results = parsed.entries.filter(
			(e): e is Extract<(typeof parsed.entries)[number], { type: "message" }> =>
				e.type === "message" && e.message.role === "toolResult",
		);
		expect(results).toHaveLength(3);
		const r0 = results[0]!.message;
		const r1 = results[1]!.message;
		const r2 = results[2]!.message;
		expect(r0.role === "toolResult" ? r0.content : []).toEqual([
			{ type: "text", text: "Showing lines 1-1 of 1\n1: export const answer = 42;" },
		]);
		expect(r1.role === "toolResult" ? r1.content : []).toEqual([
			{ type: "text", text: `Showing lines 1-1 of 1\n1: ${svg}` },
			{ type: "image", data: Buffer.from(svg, "utf8").toString("base64"), mimeType: "image/svg+xml" },
		]);
		expect(r2.role === "toolResult" ? r2.content : []).toEqual([
			{ type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" },
		]);
	});

	test("scans disk brain transcripts + registry, opens read-only StoredSession, and manages mixed sessions", async () => {
		const dir = tempDir("agy-mgr-");
		const repo = join(dir, "repo");
		const brainRoot = join(dir, "brain");
		const sessDir = join(brainRoot, "conv-disk-1", ".system_generated", "logs");
		mkdirSync(repo, { recursive: true });
		mkdirSync(sessDir, { recursive: true });

		writeFileSync(join(brainRoot, "conv-disk-1", "metadata.json"), JSON.stringify({ cwd: repo, title: "Disk Agy" }));
		const transcriptPath = join(sessDir, "transcript.jsonl");
		writeFileSync(
			transcriptPath,
			[
				JSON.stringify({ type: "USER_INPUT", created_at: "2026-11-20T02:00:00.000Z", content: "Hello from disk" }),
				JSON.stringify({ type: "PLANNER_RESPONSE", created_at: "2026-11-20T02:00:02.000Z", content: "Hi back" }),
			].join("\n") + "\n",
		);

		const registry = new AntigravitySessionRegistry(join(dir, "agy-registry.json"));
		const agyBin = writeFakeAgy(dir);
		const scanned = scanAntigravityConversations({ brainDirs: [brainRoot], registry });
		expect(scanned).toHaveLength(1);
		expect(scanned[0]?.backend).toBe("antigravity");
		expect(scanned[0]?.title).toBe("Disk Agy");

		// StoredSession opens Antigravity transcript read-only
		const stored = await StoredSession.open({ conversation: scanned[0]!, access: "free" });
		expect(stored.info.backend).toBe("antigravity");
		const sub = stored.subscribe(() => {}, 0, undefined);
		expect(sub.result.kind).toBe("snapshot");
		if (sub.result.kind === "snapshot") {
			expect(sub.result.snapshot.entries).toHaveLength(2);
			expect(sub.result.snapshot.status?.backend).toBe("antigravity");
			expect(sub.result.snapshot.status?.capabilities?.steer).toBe(true);
		}
		sub.unsubscribe();

		// SessionManager integrates Antigravity alongside omp
		let probedIds: readonly string[] = [];
		const manager = new SessionManager({
			ompPath: "/nonexistent/omp",
			sessionDir: join(dir, "empty-omp-sessions"),
			resolveCwd: async cwd => cwd,
			probeLeases: async ids => {
				probedIds = ids;
				return { held: new Set(), unknown: new Set() };
			},
			antigravity: {
				binary: { path: agyBin, args: ["acp"], version: "1.2.3" },
				sessionDir: brainRoot,
				registry,
			},
		});
		await manager.refresh();
		// omp lease probe must never be called with Antigravity ids
		expect(probedIds).toEqual([]);
		expect(manager.list().map(s => ({ id: s.id, backend: s.backend }))).toEqual([
			{ id: "conv-disk-1", backend: "antigravity" },
		]);
		// Antigravity sessions are excluded from omp replica sync
		expect(manager.conversationFiles()).toEqual([]);

		// Rename stored Antigravity session persists via registry
		await manager.rename("conv-disk-1", "Renamed Agy");
		expect(manager.list().find(s => s.id === "conv-disk-1")?.title).toBe("Renamed Agy");

		// Forking Antigravity is refused cleanly
		await expect(manager.fork("conv-disk-1")).rejects.toThrow(/fork/i);

		// Creating and resuming Antigravity sessions work via ACP
		const created = await manager.create(repo, undefined, "antigravity");
		expect(created.backend).toBe("antigravity");
		expect(await manager.roles(created.id)).toEqual({ roles: [], cycle: [] });
		await expect(manager.setRole(created.id, "default", "x/y")).rejects.toThrow(/roles/i);

		const resumed = await manager.resume("conv-disk-1", false);
		expect(resumed.backend).toBe("antigravity");
		expect(resumed.id).toBe("conv-disk-1");
		await manager.closeAll();
	});

	test("empty Antigravity sessions are never persisted to the registry and at most one empty hosted session is kept", async () => {
		const dir = tempDir("agy-empty-");
		const repoA = join(dir, "repo-a");
		const repoB = join(dir, "repo-b");
		mkdirSync(repoA, { recursive: true });
		mkdirSync(repoB, { recursive: true });
		const agyBin = writeFakeAgy(dir, { uniqueSessionIds: true });
		const registryFile = join(dir, "agy-registry.json");
		const registry = new AntigravitySessionRegistry(registryFile);
		// Pre-existing legacy empty record in the registry (no messages, no preview) should be ignored on scan.
		registry.upsert({ id: "legacy-empty-agy", cwd: repoA });
		expect(scanAntigravityConversations({ brainDirs: [join(dir, "no-brain")], registry })).toEqual([]);

		const manager = new SessionManager({
			ompPath: "/nonexistent/omp",
			sessionDir: join(dir, "empty-omp"),
			resolveCwd: async cwd => cwd,
			probeLeases: async () => ({ held: new Set(), unknown: new Set() }),
			antigravity: {
				binary: { path: agyBin, args: ["acp"], version: "1.2.3" },
				sessionDir: join(dir, "no-brain"),
				registry,
			},
		});
		try {
			await manager.refresh();
			expect(manager.list()).toEqual([]);

			// Creating an empty Antigravity session lists it while hosted, without writing it to the registry.
			const first = await manager.create(repoA, undefined, "antigravity");
			expect(registry.get(first.id)).toBeUndefined();
			expect(manager.list().map(s => s.id)).toEqual([first.id]);

			// Clicking "New session" again in the same cwd & backend reuses the single empty session.
			const reused = await manager.create(repoA, undefined, "antigravity");
			expect(reused).toBe(first);
			expect(manager.list().map(s => s.id)).toEqual([first.id]);

			// Creating an empty session in another cwd replaces the previous untouched empty session.
			const second = await manager.create(repoB, undefined, "antigravity");
			expect(second).not.toBe(first);
			expect(second.info.cwd).toBe(repoB);
			expect(manager.list().map(s => ({ id: s.id, cwd: s.cwd }))).toEqual([{ id: second.id, cwd: repoB }]);

			// Closing an untouched empty Antigravity session removes it completely (nothing left in stored sessions).
			await manager.close(second.id);
			expect(registry.get(second.id)).toBeUndefined();
			expect(manager.list()).toEqual([]);

			// Once a user actually sends a message, the session is persisted and stays listed after closing.
			const spoken = await manager.create(repoA, undefined, "antigravity");
			const done = new Promise<void>(resolve => {
				const sub = spoken.subscribe(
					batch => {
						if (batch.some(item => item.ev.k === "prompt_result")) {
							sub.unsubscribe();
							resolve();
						}
					},
					0,
					undefined,
				);
			});
			await spoken.prompt("Keep this session");
			await done;
			await spoken.whenSynced();
			expect(spoken.isEmpty).toBe(false);
			expect(registry.get(spoken.id)?.preview).toBe("Keep this session");
			expect(registry.get(spoken.id)?.messageCount).toBeGreaterThan(0);

			await manager.close(spoken.id);
			expect(manager.list().map(s => ({ id: s.id, preview: s.preview }))).toEqual([
				{ id: spoken.id, preview: "Keep this session" },
			]);
		} finally {
			await manager.closeAll();
		}
	});
});

describe("Antigravity config, binary locator and GatewayStore persistence", () => {
	test("config parses antigravity section and flags override file config", () => {
		const parsed = parseFileConfig({
			antigravity: {
				enabled: true,
				bin: "/opt/agy",
				args: ["acp", "--verbose"],
				sessionDir: "/data/brain",
				authMethod: "oauth-personal",
				mode: "default",
				permissionMode: "edits",
			},
		});
		const resolved = resolveConfig(
			{
				antigravity: "/usr/local/bin/agy",
				antigravitySessionDir: "/override/brain",
				antigravityAuthMethod: "gemini-api-key",
				antigravityMode: "auto-edit",
				antigravityPermissionMode: "auto",
			},
			parsed,
			{ configDir: "/tmp/c", stateDir: "/tmp/s" },
			{ webDir: "/tmp/w" },
		);
		expect(resolved.antigravity).toEqual({
			enabled: true,
			bin: "/usr/local/bin/agy",
			args: ["acp", "--verbose"],
			sessionDir: "/override/brain",
			authMethod: "gemini-api-key",
			mode: "auto-edit",
			permissionMode: "auto",
		});
		expect(() => parseFileConfig({ antigravity: { permissionMode: "yolo" } })).toThrow(/permissionMode/);
	});

	test("ACP auth probe, authenticate, -32000 auth_required error, and GEMINI_API_KEY auto-auth", async () => {
		const dir = tempDir("agy-auth-");
		const bin = writeFakeAgy(dir);
		const binary = { path: bin, args: ["acp"], version: "1.2.3" };

		const status = await probeAntigravityAuth(binary, { configuredMethod: "oauth-personal", env: {} });
		expect(status.available).toBe(true);
		expect(status.authMethods.map(m => m.id)).toEqual(["oauth-personal", "gemini-api-key"]);
		expect(status.configuredMethod).toBe("oauth-personal");
		expect(status.loginCommand).toContain("--login");

		// Explicit authenticate via oauth-personal succeeds
		expect(await authenticateAntigravity(binary, "oauth-personal", { env: {} })).toEqual({
			methodId: "oauth-personal",
			authenticated: true,
		});

		// Unauthenticated session/new returns -32000 -> AntigravityAuthError (and SessionActionError code="auth_required")
		const unauth = new AntigravityAcpSource({
			binaryPath: bin,
			cwd: dir,
			env: { FAKE_AGY_REQUIRE_AUTH: "1", GEMINI_API_KEY: "" },
		});
		await expect(unauth.start()).rejects.toBeInstanceOf(AntigravityAuthError);

		// With GEMINI_API_KEY in env, -32000 automatically invokes authenticate("gemini-api-key") and retries session/new
		const withKey = new AntigravityAcpSource({
			binaryPath: bin,
			cwd: dir,
			env: { FAKE_AGY_REQUIRE_AUTH: "1", GEMINI_API_KEY: "test-key" },
		});
		await withKey.start();
		await withKey.stop();

		// SessionManager surfaces auth_required as SessionActionError(code="auth_required")
		const mgr = new SessionManager({
			ompPath: "/nonexistent/omp",
			sessionDir: join(dir, "omp"),
			resolveCwd: async cwd => cwd,
			createSource: async () => {
				throw new AntigravityAuthError("Sign in required", status.authMethods, status.loginCommand!);
			},
			antigravity: { binary },
		});
		let caught: unknown;
		try {
			await mgr.create(dir, undefined, "antigravity");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SessionActionError);
		expect((caught as SessionActionError).code).toBe("auth_required");
	});

	test("locateAntigravity returns null when absent/disabled, probes version when found, throws when explicit missing", async () => {
		const dir = tempDir("agy-loc-");
		const bin = writeFakeAgy(dir);

		expect(await locateAntigravity({ enabled: false, bin })).toBeNull();
		await expect(locateAntigravity({ bin: join(dir, "missing-agy") })).rejects.toThrow(/not found/i);

		const found = await locateAntigravity({ bin });
		expect(found).toEqual({ path: bin, args: ["acp"], version: "1.2.3" });
	});

	test("GatewayStore migration 7 persists machine antigravity capability", () => {
		const store = GatewayStore.open(":memory:");
		try {
			store.upsertMachine({
				id: "m1",
				name: "dev",
				platform: "darwin",
				daemonVersion: "0.1.0",
				omp: { version: "19.0.1", expectedVersion: "19.0.1", versionMismatch: false },
				antigravity: { available: true, version: "1.2.3" },
				leaseWarnings: [],
				lastSeen: 1000,
			});
			const machines = store.machines();
			expect(machines[0]?.antigravity).toEqual({ available: true, version: "1.2.3" });
		} finally {
			store.close();
		}
	});
});
