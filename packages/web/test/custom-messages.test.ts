import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { presentEntries } from "../src/lib/custom-messages";

const custom = (customType: string, content: string, details?: unknown, display = true): SessionEntry => ({
	type: "custom_message",
	id: customType,
	parentId: null,
	timestamp: "2026-11-20T00:00:00Z",
	customType,
	content,
	details,
	display,
});
const job = (jobId: string, type: string, durationMs: number, label = jobId) => ({
	jobId,
	type,
	status: "completed",
	label,
	durationMs,
});
const shown = (entry: SessionEntry): { chip: string; text: string } => {
	const out = presentEntries([entry])[0]!;
	if (out.type !== "custom_message" || typeof out.content !== "string") throw new Error("not a text custom message");
	return { chip: out.customType, text: out.content };
};

describe("presentEntries", () => {
	test("a finished sub-agent: a job header and its report, without the envelope, tags or follow-up hints", () => {
		const text = [
			"<system-notice>",
			"Background job FpvDrone has completed.",
			"Resume your work using the result below.",
			'<task-result id="FpvDrone" agent="task" status="completed" duration="52.1s">',
			"",
			"<output>",
			"未实现，等你定控制和镜头方案。",
			"",
			"## 需要你决定的两件事",
			"</output>",
			"</task-result>",
			"",
			"FpvDrone is now idle — message it via write agent://FpvDrone to follow up; transcript at history://FpvDrone",
			"</system-notice>",
		].join("\n");
		const { chip, text: body } = shown(custom("async-result", text, { jobs: [job("FpvDrone", "task", 52_100)] }));
		expect(chip).toBe("background job");
		expect(body).toBe("**✓ FpvDrone** · task · 52.1s\n\n未实现，等你定控制和镜头方案。\n\n## 需要你决定的两件事");
	});

	test("several jobs: command jobs as bash tool cards, the rest as one report, in job order", () => {
		const text = [
			"<system-notice>",
			"4 background jobs have completed. Resume your work using the results below.",
			"",
			"── Job bg_13 (node a.js evals '",
			"async function wait(ms){…) ──",
			"[Command timed out after 30 seconds]",
			"── Job bg_12 (bun test) ──",
			"<error>exit 1</error>",
			"── Job Scout (Scout) ──",
			"<task-result>",
			"<output>",
			"Found it.",
			"</output>",
			"</task-result>",
			"── Job ev_1 (eval) ──",
			"3 pass ```",
			"</system-notice>",
		].join("\n");
		const command = "node a.js evals '\nasync function wait(ms){…";
		const jobs = [
			job("bg_13", "bash", 30_000, command),
			{ ...job("bg_12", "bash", 2_000, "bun test"), status: "failed" },
			job("Scout", "task", 5_000),
			job("ev_1", "eval", 1_000, "eval"),
		];
		const delivery = custom("async-result", text, { jobs });
		const [call, first, second, report, ...rest] = presentEntries([delivery]);
		expect(rest).toEqual([]);
		if (call?.type !== "message" || call.message.role !== "assistant") throw new Error("not an assistant message");
		expect(call.message.content).toEqual([
			{ type: "toolCall", id: "async-result/bg_13", name: "bash", arguments: { command } },
			{ type: "toolCall", id: "async-result/bg_12", name: "bash", arguments: { command: "bun test" } },
		]);
		const results = [first, second].map(entry => {
			if (entry?.type !== "message" || entry.message.role !== "toolResult") throw new Error("not a tool result");
			return entry.message;
		});
		expect(
			results.map(({ toolCallId, toolName, content, details, isError }) => ({
				toolCallId,
				toolName,
				content,
				details,
				isError,
			})),
		).toEqual([
			{
				toolCallId: "async-result/bg_13",
				toolName: "bash",
				content: [{ type: "text", text: "[Command timed out after 30 seconds]" }],
				details: { async: { state: "completed", jobId: "bg_13" }, wallTimeMs: 30_000 },
				isError: false,
			},
			{
				toolCallId: "async-result/bg_12",
				toolName: "bash",
				content: [{ type: "text", text: "Error: exit 1" }],
				details: { async: { state: "failed", jobId: "bg_12" }, wallTimeMs: 2_000 },
				isError: true,
			},
		]);
		if (report?.type !== "custom_message" || typeof report.content !== "string") throw new Error("not a report");
		expect(report.id).toBe("async-result/2");
		expect(report.customType).toBe("2 background jobs");
		const [agent, other] = report.content.split("\n\n---\n\n");
		expect(agent).toBe("**✓ Scout** · task · 5.0s\n\nFound it.");
		// a fence longer than any backtick run in the output
		expect(other).toBe("**✓ ev\\_1** · eval · 1.0s\n\n`eval`\n\n````text\n3 pass ```\n````");
	});

	test("older omp's one-line delivery header is dropped too", () => {
		const text =
			"<system-notice>\nBackground job Town has completed. Resume your work using the result below.\nAll 13 pass.\n</system-notice>";
		expect(shown(custom("async-result", text, { jobs: [job("Town", "task", 60_000)] })).text).toBe(
			"**✓ Town** · task · 1m\n\nAll 13 pass.",
		);
	});

	test("other notices lose only the envelope; untouched entries keep their identity", () => {
		expect(shown(custom("lsp-late-diagnostic", "<system-notice>\nLate diagnostics\n</system-notice>")).text).toBe(
			"Late diagnostics",
		);
		const plain = [
			custom("launch-completion", "Supervised process done"),
			custom("tool-roster-notice", "<system-notice>x</system-notice>", undefined, false),
		];
		expect(presentEntries(plain)).toBe(plain);
		const notice = [
			custom("async-result", "<system-notice>\nBackground job a has completed.\nok\n</system-notice>", {
				jobs: [job("a", "task", 1)],
			}),
		];
		expect(presentEntries(notice)[0]).toBe(presentEntries([...notice])[0]!);
	});

	test("agent messages: the endpoints as the chip, the agent's own message as the body", () => {
		const envelope = [
			"<irc>",
			"Incoming IRC message from agent `Instances`:",
			"",
			"Proposed API: `new GrassInstances(group, material)`. Confirm?",
			"",
			'If response expected, reply via `write` (`path: "agent://Instances"`, `content: "…"`).',
			"</irc>",
		].join("\n");
		const incoming = shown(
			custom("irc:incoming", envelope, {
				id: "1",
				from: "Instances",
				message: "Proposed API: `new GrassInstances(group, material)`. Confirm?",
				replyTo: "0",
			}),
		);
		expect(incoming).toEqual({
			chip: "IRC ← Instances · reply",
			text: "Proposed API: `new GrassInstances(group, material)`. Confirm?",
		});
		const relay = shown(
			custom("irc:relay", "[IRC `A` → `B`]\n\nhello", { from: "A", to: "B", body: "hello", progress: true }),
		);
		expect(relay).toEqual({ chip: "IRC A → B · progress", text: "hello" });
		const pool = shown(
			custom("irc:workpool", "[pool p → W1]\n\ngo", { pool: "p", to: "W1", body: "go", mode: "dispatched" }),
		);
		expect(pool).toEqual({ chip: "Pool p → W1 · dispatched", text: "go" });
	});

	test("thinking text loses the blank lines models end it with; other blocks stay as they are", () => {
		const message = (content: unknown[]): SessionEntry =>
			({
				type: "message",
				id: "m",
				parentId: null,
				timestamp: "2026-11-20T00:00:00Z",
				message: { role: "assistant", content, model: "m", stopReason: "stop", timestamp: 0 },
			}) as SessionEntry;
		const entry = message([
			{ type: "thinking", thinking: "Checking the tests.\n\n" },
			{ type: "text", text: "Done.\n\n" },
		]);
		const out = presentEntries([entry])[0]!;
		if (out.type !== "message" || out.message.role !== "assistant") throw new Error("not an assistant message");
		expect(out.message.content).toEqual([
			{ type: "thinking", thinking: "Checking the tests." },
			{ type: "text", text: "Done.\n\n" },
		]);
		const trimmed = [message([{ type: "thinking", thinking: "Already tidy." }])];
		expect(presentEntries(trimmed)).toBe(trimmed);
	});
});
