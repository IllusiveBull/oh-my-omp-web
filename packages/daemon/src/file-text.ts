/**
 * Reading text files for the viewer: classification (image / binary / text), and pages of lines addressed by 1-based
 * line number. A page is at most `FILE_CHUNK_BYTES` and `maxLines` lines; the file is read in blocks, never whole.
 *
 * Reaching line N means scanning for newlines from the start of the file (the daemon keeps no per-viewer state). To keep
 * paging cheap, the first request for a file of up to 32 MiB also builds a coarse line index (every 1000th line start)
 * and the total line count; both are cached per file version (path, size, mtime) in a small LRU.
 */
import type { FileHandle } from "node:fs/promises";
import { FILE_CHUNK_BYTES } from "@omp-web/protocol";

const BLOCK = 1024 * 1024;
const STRIDE = 1000;
/** Files up to this size get a line index and a total line count. */
export const INDEX_MAX_BYTES = 32 * 1024 * 1024;
const SNIFF_BYTES = 8192;

export type Sniffed = { kind: "image"; mime: string } | { kind: "binary"; reason: string } | { kind: "text" };

const startsWith = (buf: Uint8Array, bytes: number[], at = 0): boolean => bytes.every((b, i) => buf[at + i] === b);

/** Raster image types recognized by their first bytes (SVG is text and is shown as such). */
function imageMime(buf: Uint8Array): string | null {
	if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(buf, [0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61)
		return "image/gif";
	if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
	if (startsWith(buf, [0x42, 0x4d]) && buf.length > 14) return "image/bmp";
	if (startsWith(buf, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
	if (
		startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4) &&
		(startsWith(buf, [0x61, 0x76, 0x69, 0x66], 8) || startsWith(buf, [0x61, 0x76, 0x69, 0x73], 8))
	) {
		return "image/avif";
	}
	return null;
}

/** Classifies a file by its first bytes: the way git decides (a NUL byte), plus UTF-16 BOMs and mostly-control content. */
export function sniff(head: Uint8Array): Sniffed {
	const mime = imageMime(head);
	if (mime !== null) return { kind: "image", mime };
	if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) {
		return { kind: "binary", reason: "UTF-16 text (only UTF-8 is displayed)" };
	}
	let control = 0;
	for (const byte of head) {
		if (byte === 0) return { kind: "binary", reason: "binary data" };
		if (
			byte < 0x20 &&
			byte !== 0x09 &&
			byte !== 0x0a &&
			byte !== 0x0d &&
			byte !== 0x0c &&
			byte !== 0x08 &&
			byte !== 0x1b
		)
			control++;
	}
	if (head.length > 0 && control / head.length > 0.3) return { kind: "binary", reason: "binary data" };
	return { kind: "text" };
}

/** The first bytes of the file, for {@link sniff}. */
export async function readHead(handle: FileHandle, size: number): Promise<Buffer> {
	const buf = Buffer.alloc(Math.min(size, SNIFF_BYTES));
	const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
	return buf.subarray(0, bytesRead);
}

interface LineIndex {
	totalLines: number;
	/** `starts[i]` = byte offset of line `i * STRIDE + 1`. */
	starts: number[];
}

const INDEXES = new Map<string, LineIndex>();
const INDEX_LIMIT = 16;

function remember(key: string, index: LineIndex): void {
	INDEXES.delete(key);
	INDEXES.set(key, index);
	if (INDEXES.size > INDEX_LIMIT) INDEXES.delete(INDEXES.keys().next().value!);
}

async function readAt(handle: FileHandle, buf: Buffer, position: number, length: number): Promise<number> {
	const { bytesRead } = await handle.read(buf, 0, length, position);
	return bytesRead;
}

async function buildIndex(handle: FileHandle, size: number): Promise<LineIndex> {
	const buf = Buffer.allocUnsafe(BLOCK);
	const starts = [0];
	let newlines = 0;
	let last = 0x0a;
	for (let pos = 0; pos < size;) {
		const n = await readAt(handle, buf, pos, BLOCK);
		if (n === 0) break;
		const view = buf.subarray(0, n);
		for (let at = view.indexOf(0x0a); at >= 0; at = view.indexOf(0x0a, at + 1)) {
			newlines++;
			if (newlines % STRIDE === 0) starts.push(pos + at + 1);
		}
		last = view[n - 1]!;
		pos += n;
	}
	return { totalLines: newlines + (size > 0 && last !== 0x0a ? 1 : 0), starts };
}

/** Offset of the line that follows `need` newlines counted from `from`; null when the file has fewer. */
async function skipLines(handle: FileHandle, size: number, from: number, need: number): Promise<number | null> {
	if (need === 0) return from;
	const buf = Buffer.allocUnsafe(BLOCK);
	let left = need;
	for (let pos = from; pos < size;) {
		const n = await readAt(handle, buf, pos, BLOCK);
		if (n === 0) break;
		const view = buf.subarray(0, n);
		for (let at = view.indexOf(0x0a); at >= 0; at = view.indexOf(0x0a, at + 1)) {
			if (--left === 0) return pos + at + 1;
		}
		pos += n;
	}
	return null;
}

/** Index in `window` just past the `lines`-th newline, or -1 when the window holds fewer. */
function endOfLines(window: Buffer, lines: number): number {
	let at = -1;
	for (let seen = 0; seen < lines; seen++) {
		at = window.indexOf(0x0a, at + 1);
		if (at < 0) return -1;
	}
	return at + 1;
}

function countNewlines(buf: Buffer): number {
	let count = 0;
	for (let at = buf.indexOf(0x0a); at >= 0; at = buf.indexOf(0x0a, at + 1)) count++;
	return count;
}

export interface TextPage {
	text: string;
	startLine: number;
	endLine: number;
	nextLine: number | null;
	totalLines: number | null;
	lossy: boolean;
	crlf: boolean;
	bom: boolean;
	cut: boolean;
}

const STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const LOSSY = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** Length of the largest prefix of `buf` that does not end inside a UTF-8 sequence. */
function whole(buf: Buffer): number {
	for (let i = buf.length - 1; i >= Math.max(0, buf.length - 4); i--) {
		const byte = buf[i]!;
		if (byte < 0x80) return buf.length;
		if (byte >= 0xc0) {
			const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
			return buf.length - i < need ? i : buf.length;
		}
	}
	return buf.length;
}

/**
 * The page of `maxLines` lines (at most {@link FILE_CHUNK_BYTES} bytes) starting at line `fromLine`. `key` identifies the
 * file version for the index cache.
 */
export async function readTextPage(
	handle: FileHandle,
	size: number,
	key: string,
	fromLine: number,
	maxLines: number,
): Promise<TextPage> {
	let index = INDEXES.get(key) ?? null;
	if (index === null && size <= INDEX_MAX_BYTES) {
		index = await buildIndex(handle, size);
		remember(key, index);
	}
	const totalLines = index?.totalLines ?? null;
	const empty = (startLine: number): TextPage => ({
		text: "",
		startLine,
		endLine: startLine - 1,
		nextLine: null,
		totalLines,
		lossy: false,
		crlf: false,
		bom: false,
		cut: false,
	});
	if (index !== null && fromLine > index.totalLines) return empty(fromLine);

	// Where line `fromLine` starts: from the nearest checkpoint when there is an index, else from the top.
	const base = index === null ? 0 : Math.min(Math.floor((fromLine - 1) / STRIDE), index.starts.length - 1);
	const baseLine = base * STRIDE + 1;
	const from = await skipLines(handle, size, index === null ? 0 : index.starts[base]!, fromLine - baseLine);
	if (from === null) return empty(fromLine);

	const window = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, size - from));
	const got = window.length === 0 ? 0 : await readAt(handle, window, from, window.length);
	const data = window.subarray(0, got);
	const atEof = from + got >= size;

	let end = endOfLines(data, maxLines);
	let cut = false;
	if (end < 0) {
		if (atEof) end = data.length;
		else {
			const lastNewline = data.lastIndexOf(0x0a);
			if (lastNewline >= 0) end = lastNewline + 1;
			else {
				// One line longer than a page: show its beginning and go on after its end.
				end = whole(data);
				cut = true;
			}
		}
	}
	const pageBytes = data.subarray(0, end);
	const pageEndsAtEof = from + end >= size;
	let lines = countNewlines(pageBytes) + (pageBytes.length > 0 && pageBytes[pageBytes.length - 1] !== 0x0a ? 1 : 0);
	let nextLine: number | null = pageEndsAtEof ? null : fromLine + lines;
	if (cut) {
		// The rest of the cut line is skipped; whether anything follows it decides `nextLine`.
		const after = await skipLines(handle, size, from, 1);
		nextLine = after === null || after >= size ? null : fromLine + 1;
		lines = 1;
	}

	const bom =
		from === 0 && pageBytes.length >= 3 && pageBytes[0] === 0xef && pageBytes[1] === 0xbb && pageBytes[2] === 0xbf;
	const body = bom ? pageBytes.subarray(3) : pageBytes;
	let text: string;
	let lossy = false;
	try {
		text = STRICT.decode(body);
	} catch {
		text = LOSSY.decode(body);
		lossy = true;
	}
	return {
		text,
		startLine: fromLine,
		endLine: fromLine + lines - 1,
		nextLine,
		totalLines,
		lossy,
		crlf: text.includes("\r\n"),
		bom,
		cut,
	};
}
