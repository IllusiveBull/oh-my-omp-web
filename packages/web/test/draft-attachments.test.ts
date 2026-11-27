import { expect, test } from "bun:test";
import type { ImageWire } from "@omp-web/protocol";
import { compose, type DraftAttachments, markerRange, pasteMarker, prune } from "../src/lib/draft-attachments";

const png = (data: string): ImageWire => ({ data, mimeType: "image/png" });

test("sends only images whose markers remain, renumbered 1..K in marker order, and expands pastes once", () => {
	const attachments: DraftAttachments = {
		images: [
			{ n: 1, image: png("one"), width: 4, height: 3 },
			{ n: 2, image: png("two") },
			{ n: 10, image: png("ten") },
		],
		// The pasted text itself mentions a marker: it must stay verbatim.
		pastes: [{ n: 1, marker: "[Paste #1, 12 chars]", expansion: "see [Image #2]" }],
	};
	const { message, images } = compose("[Image #10] vs [Image #1, 4x3] [Paste #1, 12 chars]", attachments);
	expect(message).toBe("[Image #2] vs [Image #1, 4x3] see [Image #2]");
	expect(images).toEqual([png("one"), png("ten")]);
});

test("a deleted marker drops its attachment; a marker deletes as a unit from inside or either edge", () => {
	const attachments: DraftAttachments = {
		images: [{ n: 1, image: png("one") }],
		pastes: [{ n: 2, marker: pasteMarker(2, "x\n".repeat(11)), expansion: "x" }],
	};
	expect(prune("text [Image #1]", attachments)).toEqual({ images: attachments.images, pastes: [] });
	const text = "ab [Image #1] cd";
	expect(markerRange(text, attachments, 13, "back")).toEqual({ start: 3, end: 13 });
	expect(markerRange(text, attachments, 3, "back")).toBeNull();
	expect(markerRange(text, attachments, 3, "forward")).toEqual({ start: 3, end: 13 });
	expect(markerRange(text, attachments, 8, "forward")).toEqual({ start: 3, end: 13 });
	expect(markerRange(text, attachments, 13, "forward")).toBeNull();
});
