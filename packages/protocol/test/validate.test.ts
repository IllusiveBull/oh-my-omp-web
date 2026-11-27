import { describe, expect, test } from "bun:test";
import { MAX_LOGIN_INPUT_CHARS, parseBrowserMessage, parseClientMessage } from "../src";

describe("parseClientMessage", () => {
	test("accepts every client message shape", () => {
		const ok: unknown[] = [
			{ t: "sessions.list", reqId: "1" },
			{ t: "sessions.search", reqId: "1", query: "parser bug" },
			{ t: "session.create", reqId: "1", cwd: "/x", model: "a/b" },
			{ t: "session.create", reqId: "1", cwd: "/x", backend: "antigravity" },
			{ t: "session.create", reqId: "1", cwd: "/x", backend: "antigravity", permissionMode: "auto" },
			{ t: "session.create", reqId: "1", cwd: "/x", model: "antigravity/gemini-2.5-pro", backend: "antigravity" },
			{ t: "session.set_mode", reqId: "1", sessionId: "s", mode: "auto" },
			{ t: "session.set_permission_mode", reqId: "1", sessionId: "s", mode: "edits" },
			{ t: "session.close", reqId: "1", sessionId: "s" },
			{ t: "subscribe", reqId: "1", sessionId: "s", lastSeq: 0 },
			{ t: "subscribe", reqId: "1", sessionId: "s", lastSeq: 3, epoch: "e" },
			{ t: "session.resume", reqId: "1", sessionId: "s" },
			{ t: "session.resume", reqId: "1", sessionId: "s", confirm: true },
			{ t: "session.fork", reqId: "1", sessionId: "s" },
			{ t: "session.rename", reqId: "1", sessionId: "s", title: "New name" },
			{ t: "follow_up", reqId: "1", sessionId: "s", message: "later" },
			{ t: "queue.remove", reqId: "1", sessionId: "s", message: "m", queue: "followUp" },
			{ t: "session.options", reqId: "1", sessionId: "s" },
			{ t: "session.set_model", reqId: "1", sessionId: "s", provider: "anthropic", modelId: "claude" },
			{ t: "session.set_thinking", reqId: "1", sessionId: "s", level: "high" },
			{ t: "session.roles", reqId: "1", sessionId: "s" },
			{ t: "session.context", reqId: "1", sessionId: "s" },
			{ t: "omp.theme", reqId: "1" },
			{ t: "session.set_role", reqId: "1", sessionId: "s", role: "smol", selector: "anthropic/claude:low" },
			{ t: "session.set_role", reqId: "1", sessionId: "s", role: "my-role", selector: null },
			{ t: "session.compact", reqId: "1", sessionId: "s" },
			{ t: "session.compact", reqId: "1", sessionId: "s", instructions: "keep the API notes" },
			{ t: "session.agents", reqId: "1", sessionId: "s", open: true },
			{ t: "session.agent_transcript", reqId: "1", sessionId: "s", agentId: "A" },
			{ t: "session.agent_transcript", reqId: "1", sessionId: "s", agentId: "A", fromByte: 120 },
			{ t: "project.add", reqId: "1", path: "/work/repo" },
			{ t: "project.remove", reqId: "1", root: "/work/repo" },
			{ t: "project.list", reqId: "1" },
			{ t: "antigravity.auth.status", reqId: "1" },
			{ t: "antigravity.auth.login", reqId: "1", methodId: "oauth-personal" },
			{ t: "antigravity.usage", reqId: "1" },
			{ t: "unsubscribe", reqId: "1", sessionId: "s" },
			{ t: "prompt", reqId: "1", sessionId: "s", message: "hi" },
			{ t: "steer", reqId: "1", sessionId: "s", message: "hi" },
			{
				t: "prompt",
				reqId: "1",
				sessionId: "s",
				message: "",
				images: [{ data: "iVBORw0K", mimeType: "image/png" }],
			},
			{
				t: "follow_up",
				reqId: "1",
				sessionId: "s",
				message: "x",
				images: [{ data: "/9j/", mimeType: "image/jpeg" }],
			},
			{ t: "abort", reqId: "1", sessionId: "s" },
			{ t: "ui.response", reqId: "1", sessionId: "s", requestId: "u", response: { value: "x" } },
			{ t: "ui.response", reqId: "1", sessionId: "s", requestId: "u", response: { confirmed: false } },
			{ t: "ui.response", reqId: "1", sessionId: "s", requestId: "u", response: { cancelled: true } },
			{
				t: "ui.response",
				reqId: "1",
				sessionId: "s",
				requestId: "u",
				response: { answers: [{ id: "q", selectedOptions: ["a"], customInput: "c" }] },
			},
		];
		for (const msg of ok)
			expect(parseClientMessage(JSON.stringify(msg))).toMatchObject({ t: (msg as { t: string }).t });
	});

	test("rejects malformed frames with a readable error", () => {
		const bad: [unknown, RegExp][] = [
			["{", /JSON/],
			[{ reqId: "1" }, /"t"/],
			[{ t: "prompt", reqId: "1", sessionId: "s" }, /message/],
			[{ t: "prompt", sessionId: "s", message: "x" }, /reqId/],
			[{ t: "subscribe", reqId: "1", sessionId: "s", lastSeq: 1.5 }, /lastSeq/],
			[{ t: "subscribe", reqId: "1", sessionId: "s", lastSeq: -1 }, /lastSeq/],
			[{ t: "ui.response", reqId: "1", sessionId: "s", requestId: "u", response: { nope: 1 } }, /unrecognised/],
			[
				{ t: "ui.response", reqId: "1", sessionId: "s", requestId: "u", response: { answers: [{ id: 1 }] } },
				/malformed/,
			],
			[{ t: "subscribe", reqId: "1", sessionId: "s", lastSeq: 1, epoch: 5 }, /epoch/],
			[{ t: "session.resume", reqId: "1", sessionId: "s", confirm: "yes" }, /confirm/],
			[{ t: "session.create", reqId: "1", cwd: "/x", backend: "other" }, /backend/],
			[
				{ t: "session.create", reqId: "1", cwd: "/x", backend: "antigravity", permissionMode: "yolo" },
				/permissionMode/,
			],
			[{ t: "session.set_mode", reqId: "1", sessionId: "s", mode: "  " }, /mode/],
			[{ t: "session.set_permission_mode", reqId: "1", sessionId: "s", mode: "nope" }, /mode/],
			[{ t: "antigravity.auth.login", reqId: "1", methodId: "   " }, /methodId/],
			[{ t: "session.rename", reqId: "1", sessionId: "s", title: "   " }, /title/],
			[{ t: "session.fork", reqId: "1" }, /sessionId/],
			[{ t: "sessions.search", reqId: "1" }, /query/],
			[{ t: "queue.remove", reqId: "1", sessionId: "s", message: "m", queue: "other" }, /queue/],
			[{ t: "session.set_model", reqId: "1", sessionId: "s", provider: "p" }, /modelId/],
			[{ t: "session.agents", reqId: "1", sessionId: "s", open: "yes" }, /open/],
			[{ t: "session.set_role", reqId: "1", sessionId: "s", role: "smol" }, /selector/],
			[{ t: "prompt", reqId: "1", sessionId: "s", message: "x", images: [] }, /images/],
			[
				{
					t: "prompt",
					reqId: "1",
					sessionId: "s",
					message: "x",
					images: [{ data: "AAAA", mimeType: "image/svg+xml" }],
				},
				/type/,
			],
			[
				{
					t: "steer",
					reqId: "1",
					sessionId: "s",
					message: "x",
					images: [{ data: "not base64!", mimeType: "image/png" }],
				},
				/base64/,
			],
			[
				{
					t: "prompt",
					reqId: "1",
					sessionId: "s",
					message: "x",
					images: [{ data: "A".repeat(12 * 1024 * 1024 + 4), mimeType: "image/png" }],
				},
				/exceed/,
			],
			[{ t: "session.set_role", reqId: "1", sessionId: "s", role: "smol", selector: " " }, /selector/],
			[{ t: "session.set_role", reqId: "1", sessionId: "s", role: "a.b", selector: null }, /role/],
			[{ t: "session.agent_transcript", reqId: "1", sessionId: "s", agentId: "A", fromByte: -3 }, /fromByte/],
			[{ t: "project.add", reqId: "1" }, /path/],
			[{ t: "project.remove", reqId: "1", root: 5 }, /root/],
			[{ t: "teleport", reqId: "1" }, /unknown message type/],
		];
		for (const [msg, pattern] of bad) {
			expect(() => parseClientMessage(typeof msg === "string" ? msg : JSON.stringify(msg))).toThrow(pattern);
		}
	});
});

describe("parseBrowserMessage: auth.*", () => {
	const parse = (m: unknown): unknown => parseBrowserMessage(JSON.stringify(m));

	test("every auth request parses to an auth message without a machine id", () => {
		const ok: Record<string, unknown>[] = [
			{ t: "auth.watch", reqId: "1", open: true },
			{ t: "auth.watch", reqId: "1", open: false },
			{ t: "auth.refresh", reqId: "1" },
			{ t: "auth.usage.refresh", reqId: "1" },
			{ t: "auth.login.start", reqId: "1", providerId: "anthropic" },
			{
				t: "auth.login.input",
				reqId: "1",
				flowId: "f",
				promptId: "p",
				value: "https://localhost/callback?code=x&state=y",
			},
			{ t: "auth.login.cancel", reqId: "1", flowId: "f" },
			{ t: "auth.login.dismiss", reqId: "1", flowId: "f" },
			{ t: "auth.logout", reqId: "1", providerId: "anthropic", credentialId: 3 },
		];
		for (const message of ok) expect(parse(message)).toEqual({ kind: "auth", message } as never);
	});

	test("malformed auth requests are errors the gateway can ack", () => {
		for (const bad of [
			{ t: "auth.watch", reqId: "1" },
			{ t: "auth.watch", open: true },
			{ t: "auth.login.start", reqId: "1", providerId: "" },
			{ t: "auth.login.start", reqId: "1", providerId: "x".repeat(200) },
			{ t: "auth.login.input", reqId: "1", flowId: "f", promptId: "p" },
			{
				t: "auth.login.input",
				reqId: "1",
				flowId: "f",
				promptId: "p",
				value: "x".repeat(MAX_LOGIN_INPUT_CHARS + 1),
			},
			{ t: "auth.logout", reqId: "1", providerId: "a", credentialId: -1 },
			{ t: "auth.logout", reqId: "1", providerId: "a", credentialId: 1.5 },
			{ t: "auth.logout", reqId: "1", providerId: "a", credentialId: "1" },
			{ t: "auth.teleport", reqId: "1" },
		]) {
			expect(() => parse(bad)).toThrow();
		}
	});
});

describe("environment switch requests", () => {
	const parse = (m: unknown): unknown => parseBrowserMessage(JSON.stringify(m));
	test("every handoff request parses to a gateway-handled message", () => {
		const ok = [
			{ t: "handoff.plan", reqId: "1", m: "m_a", sessionId: "s", targetMachine: "m_b" },
			{ t: "handoff.start", reqId: "1", m: "m_a", sessionId: "s", targetMachine: "m_b", target: { mode: "new" } },
			{
				t: "handoff.start",
				reqId: "1",
				m: "m_a",
				sessionId: "s",
				targetMachine: "m_b",
				target: { mode: "existing", worktree: "/work/tree" },
			},
			{ t: "handoff.confirm", reqId: "1", id: "abcdefgh12" },
			{ t: "handoff.cancel", reqId: "1", id: "abcdefgh12" },
			{ t: "handoff.dismiss", reqId: "1", id: "abcdefgh12" },
		];
		for (const message of ok) expect(parse(message)).toEqual({ kind: "handoff", message } as never);
	});

	test("malformed handoff requests are errors the gateway can ack", () => {
		for (const bad of [
			{ t: "handoff.plan", reqId: "1", m: "m_a", sessionId: "s" },
			{ t: "handoff.start", reqId: "1", m: "m_a", sessionId: "s", targetMachine: "m_b" },
			{ t: "handoff.start", reqId: "1", m: "m_a", sessionId: "s", targetMachine: "m_b", target: { mode: "clone" } },
			{
				t: "handoff.start",
				reqId: "1",
				m: "m_a",
				sessionId: "s",
				targetMachine: "m_b",
				target: { mode: "existing", worktree: "" },
			},
			{ t: "handoff.confirm", reqId: "1" },
			{ t: "handoff.confirm", reqId: "1", id: "../../etc" },
			{ t: "handoff.cancel", reqId: "1", id: "x" },
		]) {
			expect(() => parse(bad)).toThrow();
		}
	});
});
