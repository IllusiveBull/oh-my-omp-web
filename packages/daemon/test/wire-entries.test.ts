import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { MAX_REPLICATED_PAYLOAD_BYTES } from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import { MAX_WIRE_PAYLOAD_BYTES, OMITTED_IMAGE_TEXT, serializeWireEvent, toWireEntries } from "../src/wire-entries";

function userImageEntry(id: string, text: string, images: { data: string; mimeType: string }[]) {
	return {
		type: "message" as const,
		id,
		parentId: null,
		timestamp: "2026-11-24T01:37:20.000Z",
		message: {
			role: "user" as const,
			content: [
				{ type: "text" as const, text },
				...images.map(img => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
			],
			timestamp: Date.parse("2026-11-24T01:37:20.000Z"),
		},
	};
}

describe("wire-entries image preservation", () => {
	test("keeps user images larger than collab's 1 MiB payload ceiling intact without mutating the source entry", () => {
		const bigImage = "A".repeat(2 * 1024 * 1024);
		const source = userImageEntry("e1", "[Image #1, 1488x2266] overlay了", [
			{ data: bigImage, mimeType: "image/png" },
		]);

		const [wire] = toWireEntries([source]);
		expect(wire?.type).toBe("message");
		if (
			!wire ||
			wire.type !== "message" ||
			wire.message.role !== "user" ||
			typeof wire.message.content === "string"
		) {
			throw new Error("expected structured user message");
		}
		expect(wire.message.content[0]).toEqual({ type: "text", text: "[Image #1, 1488x2266] overlay了" });
		expect(wire.message.content[1]).toEqual({ type: "image", data: bigImage, mimeType: "image/png" });
		// Caller's object was not mutated.
		expect(source.message.content[1]).toEqual({ type: "image", data: bigImage, mimeType: "image/png" });
	});

	test("still shrinks oversized text while preserving large image attachments in the same entry", () => {
		const bigText = "x".repeat(MAX_REPLICATED_PAYLOAD_BYTES + 200_000);
		const bigImage = "B".repeat(2 * 1024 * 1024);
		const source = userImageEntry("e2", bigText, [{ data: bigImage, mimeType: "image/jpeg" }]);

		const [wire] = toWireEntries([source]);
		if (
			!wire ||
			wire.type !== "message" ||
			wire.message.role !== "user" ||
			typeof wire.message.content === "string"
		) {
			throw new Error("expected structured user message");
		}
		const textBlock = wire.message.content[0];
		expect(textBlock?.type).toBe("text");
		if (textBlock?.type === "text") {
			expect(textBlock.text.length).toBeLessThan(100_000);
			expect(textBlock.text).toContain("elided for collab session");
		}
		expect(wire.message.content[1]).toEqual({ type: "image", data: bigImage, mimeType: "image/jpeg" });
	});

	test("replaces an image over MAX_WIRE_PAYLOAD_BYTES with a text notice instead of corrupting base64", () => {
		const hugeImage = "C".repeat(MAX_WIRE_PAYLOAD_BYTES + 1024);
		const source = userImageEntry("e3", "huge", [{ data: hugeImage, mimeType: "image/png" }]);

		const [wire] = toWireEntries([source]);
		if (
			!wire ||
			wire.type !== "message" ||
			wire.message.role !== "user" ||
			typeof wire.message.content === "string"
		) {
			throw new Error("expected structured user message");
		}
		expect(wire.message.content[1]).toEqual({ type: "text", text: OMITTED_IMAGE_TEXT });
		expect(Buffer.byteLength(JSON.stringify(wire), "utf8")).toBeLessThanOrEqual(MAX_WIRE_PAYLOAD_BYTES);
	});

	test("serializeWireEvent preserves > 1 MiB images in agent events and reports full serialized length", () => {
		const bigImage = "D".repeat(2 * 1024 * 1024);
		const event = {
			type: "message_end",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "see screenshot" },
					{ type: "image", data: bigImage, mimeType: "image/png" },
				],
				timestamp: 1,
			},
		} as unknown as AgentSessionEvent;

		const serialized = serializeWireEvent(event);
		expect(serialized.json.length).toBeGreaterThan(2 * 1024 * 1024);
		const msg = (serialized.value as Extract<AgentSessionEvent, { type: "message_end" }>).message;
		expect(msg.role).toBe("user");
		if (msg.role === "user" && Array.isArray(msg.content)) {
			expect(msg.content[1]).toEqual({ type: "image", data: bigImage, mimeType: "image/png" });
		} else {
			throw new Error("expected structured user message");
		}
	});

	test("non-image oversized entries still shrink under 1 MiB", () => {
		const source = {
			type: "message" as const,
			id: "e4",
			parentId: null,
			timestamp: "2026-11-24T01:37:20.000Z",
			message: {
				role: "user" as const,
				content: "z".repeat(MAX_REPLICATED_PAYLOAD_BYTES + 500_000),
				timestamp: 1,
			},
		};
		const [wire] = toWireEntries([source]);
		expect(Buffer.byteLength(JSON.stringify(wire), "utf8")).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
	});
});
