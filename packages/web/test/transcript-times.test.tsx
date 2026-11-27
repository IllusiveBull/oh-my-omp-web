import "./dom-shim";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Transcript } from "@oh-my-pi/collab-web/src/components/transcript/Transcript";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { useRef } from "react";
import { entryCopyText, useTranscriptTimes } from "../src/components/transcript-times";
import { type FakeDom, installFakeDom } from "./fake-dom";
import { userEntry } from "./fixtures";

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

const assistantEntry = (
	id: string,
	content: Extract<SessionEntry, { type: "message" }>["message"] extends infer M
		? M extends { role: "assistant"; content: infer C }
			? C
			: never
		: never,
	timestamp = "2026-01-01T00:01:00.000Z",
): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp,
	message: {
		role: "assistant",
		content,
		model: "test/model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 2,
	},
});

const customEntry = (id: string, content: string, display = true): SessionEntry => ({
	type: "custom_message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:02:00.000Z",
	customType: "notice",
	content,
	display,
});

const modelChangeEntry = (id: string): SessionEntry => ({
	type: "model_change",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:03:00.000Z",
	model: "test/model",
});

function Harness({ entries }: { entries: readonly SessionEntry[] }) {
	const ref = useRef<HTMLDivElement>(null);
	useTranscriptTimes(ref, entries);
	return (
		<div ref={ref}>
			<Transcript entries={entries} stream={null} streamDone={false} activeTools={new Map()} working={false} />
		</div>
	);
}

describe("entryCopyText", () => {
	test("extracts raw text from user, assistant, and displayed custom entries, ignoring thinking and tool calls", () => {
		expect(entryCopyText(userEntry("u1", "hello **world**"))).toBe("hello **world**");
		expect(
			entryCopyText(
				assistantEntry("a1", [
					{ type: "thinking", thinking: "secret thought" },
					{ type: "text", text: "First `code` block" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
					{ type: "text", text: "Second line" },
				]),
			),
		).toBe("First `code` block\n\nSecond line");
		expect(
			entryCopyText(
				assistantEntry("a2", [
					{ type: "thinking", thinking: "only thinking" },
					{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "ls" } },
				]),
			),
		).toBeNull();
		expect(entryCopyText(customEntry("c1", "background report", true))).toBe("background report");
		expect(entryCopyText(customEntry("c2", "hidden", false))).toBeNull();
		expect(entryCopyText(modelChangeEntry("m1"))).toBeNull();
	});
});

describe("useTranscriptTimes copy button", () => {
	test("renders timestamp and copy button beside it on text messages, copies raw markdown, and omits button on tool-only rows", async () => {
		const copied: string[] = [];
		const originalClipboard = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					copied.push(text);
				},
			},
		});
		const entries: SessionEntry[] = [
			userEntry("u1", "check **this** out"),
			assistantEntry("a-tool", [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "pwd" } }]),
			assistantEntry(
				"a-text",
				[
					{ type: "thinking", thinking: "hidden thought" },
					{ type: "text", text: "Done:\n```ts\nconst x = 1;\n```" },
				],
				"2026-01-01T00:01:30.000Z",
			),
			customEntry("c1", "custom note"),
			modelChangeEntry("m1"),
		];
		const view = await dom.mount(<Harness entries={entries} />);
		try {
			const metas = view.queryAll(".tr-meta");
			// 4 message rows (user, tool-only assistant, text assistant, custom); marker row gets no .tr-meta
			expect(metas).toHaveLength(4);
			for (const meta of metas) {
				expect(meta.querySelector(".tr-time")?.textContent.length).toBeGreaterThan(0);
			}
			// Tool-only assistant row has time but no copy button
			expect(metas[0]!.querySelector(".tr-copy")).not.toBeNull();
			expect(metas[1]!.querySelector(".tr-copy")).toBeNull();
			expect(metas[2]!.querySelector(".tr-copy")).not.toBeNull();
			expect(metas[3]!.querySelector(".tr-copy")).not.toBeNull();

			// Clicking user copy button copies raw markdown
			await view.act(() => {
				metas[0]!.querySelector(".tr-copy")!.click();
			});
			await view.until(() => copied.length === 1);
			expect(copied[0]).toBe("check **this** out");
			expect(metas[0]!.querySelector(".tr-copy")?.getAttribute("data-state")).toBe("copied");
			expect(metas[0]!.querySelector(".tr-copy")?.getAttribute("aria-label")).toBe("Copied");

			// Clicking assistant copy button copies raw markdown without thinking text
			await view.act(() => {
				metas[2]!.querySelector(".tr-copy")!.click();
			});
			await view.until(() => copied.length === 2);
			expect(copied[1]).toBe("Done:\n```ts\nconst x = 1;\n```");
			expect(metas[2]!.querySelector(".tr-copy")?.getAttribute("data-state")).toBe("copied");

			// Clipboard error marks failed state
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async () => {
						throw new Error("denied");
					},
				},
			});
			await view.act(() => {
				metas[3]!.querySelector(".tr-copy")!.click();
			});
			await view.until(() => metas[3]!.querySelector(".tr-copy")?.getAttribute("data-state") === "failed");
			expect(metas[3]!.querySelector(".tr-copy")?.getAttribute("aria-label")).toBe("Copy failed");
		} finally {
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
			await view.unmount();
		}
	});
});
