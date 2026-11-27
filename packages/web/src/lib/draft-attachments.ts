import type { ImageWire } from "@omp-web/protocol";

/**
 * What the composer's text points at through markers, as omp's editor does: `[Image #N, WxH]` for an attached image,
 * `[Paste #N, +L lines]` / `[Paste #N, C chars]` for a collapsed paste, `[File #N, name]` for an added text file. The
 * draft holds the markers; {@link compose} turns them into the message that goes out.
 */

/** An attached image; `n` is the number in its marker, fixed while drafting. */
export interface DraftImage {
	n: number;
	image: ImageWire;
	width?: number;
	height?: number;
}

/** Text the draft shows as `marker` and sends as `expansion`. */
export interface DraftPaste {
	n: number;
	marker: string;
	expansion: string;
}

export interface DraftAttachments {
	images: readonly DraftImage[];
	pastes: readonly DraftPaste[];
}

export const NO_ATTACHMENTS: DraftAttachments = { images: [], pastes: [] };

/** omp collapses a paste into a marker past 10 lines or 1000 characters. */
export function isMarkerSized(text: string): boolean {
	return text.split("\n").length > 10 || text.length > 1000;
}

/** omp's "wrapped block": the text in `<attachment>` tags, so the model reads it as one quoted block. */
export function wrapAttachment(content: string, name?: string): string {
	const open = name === undefined ? "<attachment>" : `<attachment name="${name.replaceAll('"', "&quot;")}">`;
	return `${open}\n${content}\n</attachment>`;
}

export function imageMarker(n: number, width?: number, height?: number): string {
	return width !== undefined && height !== undefined ? `[Image #${n}, ${width}x${height}]` : `[Image #${n}]`;
}

export function pasteMarker(n: number, content: string): string {
	const lines = content.split("\n").length;
	return lines > 10 ? `[Paste #${n}, +${lines} lines]` : `[Paste #${n}, ${content.length} chars]`;
}

export function fileMarker(n: number, name: string): string {
	return `[File #${n}, ${name.replaceAll("]", ")")}]`;
}

/** The marker of a draft image. */
export const markerOf = (image: DraftImage): string => imageMarker(image.n, image.width, image.height);

/** The number for the next image or paste: one past the highest still attached. */
export function nextNumber(items: readonly { n: number }[]): number {
	return items.reduce((max, item) => Math.max(max, item.n), 0) + 1;
}

/** Drops what the text no longer has a marker for (the same object when nothing went). */
export function prune(text: string, attachments: DraftAttachments): DraftAttachments {
	const images = attachments.images.filter(image => text.includes(markerOf(image)));
	const pastes = attachments.pastes.filter(paste => text.includes(paste.marker));
	return images.length === attachments.images.length && pastes.length === attachments.pastes.length
		? attachments
		: { images, pastes };
}

/**
 * The message that goes out: pastes and files expanded, and the images whose markers the text holds renumbered
 * 1..K in marker order (omp maps `[Image #N]` to the message's N-th image).
 */
export function compose(text: string, attachments: DraftAttachments): { message: string; images: ImageWire[] } {
	const live = prune(text, attachments);
	const images = [...live.images].sort((a, b) => a.n - b.n);
	const table = new Map<string, string>();
	images.forEach((image, i) => table.set(markerOf(image), imageMarker(i + 1, image.width, image.height)));
	for (const paste of live.pastes) table.set(paste.marker, paste.expansion);
	if (table.size === 0) return { message: text, images: [] };
	// Longest first so `#1` never shadows `#10`; one pass, so an expanded paste that happens to contain another marker
	// stays verbatim.
	const pattern = [...table.keys()]
		.sort((a, b) => b.length - a.length)
		.map(marker => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	return {
		message: text.replace(new RegExp(pattern, "g"), marker => table.get(marker) ?? marker),
		images: images.map(image => image.image),
	};
}

/**
 * The marker a Backspace (`back`) or Delete (`forward`) at `caret` removes as a whole, as omp's editor does, so no
 * half-deleted marker is left as stray text: Backspace right after or inside one, Delete right before or inside one.
 */
export function markerRange(
	text: string,
	attachments: DraftAttachments,
	caret: number,
	direction: "back" | "forward",
): { start: number; end: number } | null {
	for (const marker of [...attachments.images.map(markerOf), ...attachments.pastes.map(paste => paste.marker)]) {
		for (let start = text.indexOf(marker); start !== -1; start = text.indexOf(marker, start + 1)) {
			const end = start + marker.length;
			const hit = direction === "back" ? caret > start && caret <= end : caret >= start && caret < end;
			if (hit) return { start, end };
		}
	}
	return null;
}

/** The text without `marker` (and the space inserted after it). */
export function removeMarker(text: string, marker: string): string {
	return text.replaceAll(`${marker} `, "").replaceAll(marker, "");
}
