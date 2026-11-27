import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { sniff } from "./file-text";

/** Largest local raster image attached to a `read` tool card (8 MiB raw ≈ 10.7 MiB base64, within the 13 MiB wire cap). */
export const MAX_READ_IMAGE_BYTES = 8 * 1024 * 1024;
/** Largest local SVG attached as an image preview on a `read` tool card. */
const MAX_READ_SVG_BYTES = 2 * 1024 * 1024;
/** Maximum text bytes attached to a `read` tool card when ACP/transcript omitted file content. */
const MAX_READ_TEXT_BYTES = 128 * 1024;
/** Maximum text lines attached to a `read` tool card fallback (matches `read_file`'s 800-line window). */
const MAX_READ_TEXT_LINES = 800;
/** Maximum bytes scanned from byte 0 when seeking to a high `StartLine` offset. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const SNIFF_HEAD_BYTES = 8192;
const CHUNK_BYTES = 64 * 1024;

const LOSSY_UTF8 = new TextDecoder("utf-8", { fatal: false });

export function pathFromInput(raw: Record<string, unknown>): string | undefined {
	for (const key of ["path", "Path", "file_path", "AbsolutePath", "TargetFile"]) {
		const value = raw[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

export function parsePositiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		const parsed = Number(value.trim());
		if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
	}
	return undefined;
}

export function parseNonNegativeInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		const parsed = Number(value.trim());
		if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
	}
	return undefined;
}

export function extractReadLineRange(args: Record<string, unknown>): {
	startLine?: number;
	endLine?: number;
	byteOffset?: number;
} {
	const startLine =
		parsePositiveInt(args.StartLine) ?? parsePositiveInt(args.start_line) ?? parsePositiveInt(args.offset);
	let endLine = parsePositiveInt(args.EndLine) ?? parsePositiveInt(args.end_line);
	if (endLine === undefined) {
		const limit = parsePositiveInt(args.limit);
		if (limit !== undefined) {
			endLine = (startLine ?? 1) + limit - 1;
		}
	}
	const byteOffset = parseNonNegativeInt(args.ByteOffset) ?? parseNonNegativeInt(args.byte_offset);
	return {
		...(startLine !== undefined ? { startLine } : {}),
		...(endLine !== undefined ? { endLine } : {}),
		...(byteOffset !== undefined && byteOffset > 0 ? { byteOffset } : {}),
	};
}

export function resolveLocalPath(rawPath: string, cwd: string): string {
	let target = rawPath.trim();
	if (target.startsWith("file://")) {
		try {
			target = fileURLToPath(target);
		} catch {
			// Fall through with original string.
		}
	}
	if (target === "~") return homedir();
	if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
	return isAbsolute(target) ? target : resolve(cwd, target);
}

/**
 * Returns true when an SVG document contains only static vector markup (no scripts, event handlers, embedded active
 * content, or external links), making it safe both inside `<img>` and if opened in a separate tab.
 */
export function isSafeSvgPreview(svgText: string): boolean {
	if (!/<svg\b/i.test(svgText)) return false;
	if (/<\s*(?:script|foreignobject|iframe|object|embed|applet|meta)\b/i.test(svgText)) return false;
	if (/\bon[a-z]+\s*=/i.test(svgText)) return false;
	if (/(?:javascript|vbscript)\s*:/i.test(svgText)) return false;
	if (/data\s*:\s*text\/html/i.test(svgText)) return false;
	// Disallow href / xlink:href pointing outside internal `#fragment` references.
	if (/(?:xlink:)?href\s*=\s*(?:"\s*(?!#)|'\s*(?!#))/i.test(svgText)) return false;
	return true;
}

function formatByteSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function binaryDescription(filePath: string, head: Uint8Array, reason: string): string {
	if (
		head.length >= 5 &&
		head[0] === 0x25 &&
		head[1] === 0x50 &&
		head[2] === 0x44 &&
		head[3] === 0x46 &&
		head[4] === 0x2d
	) {
		return "PDF file";
	}
	if (/\.pdf$/i.test(filePath)) return "PDF file";
	return reason;
}

/** Trim an incomplete trailing UTF-8 sequence when a read hit a fixed byte ceiling mid-character. */
function trimIncompleteUtf8(buf: Buffer): Buffer {
	for (let i = buf.length - 1; i >= Math.max(0, buf.length - 4); i--) {
		const byte = buf[i]!;
		if (byte < 0x80) return buf;
		if (byte >= 0xc0) {
			const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
			return buf.length - i < need ? buf.subarray(0, i) : buf;
		}
	}
	return buf;
}

/** Finds the byte offset of 1-based `startLine` by scanning newline bytes up to `MAX_SCAN_BYTES`. */
function findLineOffset(fd: number, size: number, startLine: number): number | null {
	if (startLine <= 1) return 0;
	const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
	let remaining = startLine - 1;
	let pos = 0;
	const limit = Math.min(size, MAX_SCAN_BYTES);
	while (pos < limit) {
		const toRead = Math.min(CHUNK_BYTES, limit - pos);
		const n = readSync(fd, chunk, 0, toRead, pos);
		if (n <= 0) break;
		const view = chunk.subarray(0, n);
		for (let at = view.indexOf(0x0a); at >= 0; at = view.indexOf(0x0a, at + 1)) {
			if (--remaining === 0) return pos + at + 1;
		}
		pos += n;
	}
	return null;
}

function readLocalTextSlice(
	fd: number,
	size: number,
	args: Record<string, unknown>,
): { text: string; truncated: boolean } {
	const { startLine = 1, endLine, byteOffset = 0 } = extractReadLineRange(args);
	const lineOffset = findLineOffset(fd, size, startLine);
	if (lineOffset === null || lineOffset >= size) {
		return { text: "", truncated: false };
	}
	const startByte = lineOffset + byteOffset;
	if (startByte >= size) {
		return { text: "", truncated: false };
	}

	const maxBytes = Math.min(MAX_READ_TEXT_BYTES, size - startByte);
	const buf = Buffer.allocUnsafe(maxBytes);
	let total = 0;
	while (total < maxBytes) {
		const n = readSync(fd, buf, total, maxBytes - total, startByte + total);
		if (n <= 0) break;
		total += n;
	}
	const raw = buf.subarray(0, total);
	const reachedEof = startByte + total >= size;
	const cleanBuf = reachedEof ? raw : trimIncompleteUtf8(raw);
	const hasBom =
		startByte === 0 && cleanBuf.length >= 3 && cleanBuf[0] === 0xef && cleanBuf[1] === 0xbb && cleanBuf[2] === 0xbf;
	let text = LOSSY_UTF8.decode(hasBom ? cleanBuf.subarray(3) : cleanBuf);
	let truncated = !reachedEof;

	// Cap to the requested line window (or MAX_READ_TEXT_LINES when unbounded).
	const requestedLines = endLine !== undefined && endLine >= startLine ? endLine - startLine + 1 : undefined;
	const maxLines = requestedLines !== undefined ? Math.min(requestedLines, MAX_READ_TEXT_LINES) : MAX_READ_TEXT_LINES;
	const lines = text.split("\n");
	// A trailing newline produces a trailing empty element that is not an extra line.
	const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
	const lineCount = hasTrailingNewline ? lines.length - 1 : lines.length;
	if (lineCount > maxLines) {
		text = lines.slice(0, maxLines).join("\n");
		truncated = requestedLines === undefined || requestedLines > MAX_READ_TEXT_LINES;
	} else if (lineCount === maxLines && requestedLines !== undefined) {
		truncated = requestedLines > MAX_READ_TEXT_LINES;
	} else if (!reachedEof && !hasTrailingNewline && lines.length > 1) {
		// Drop a potentially half-read final line when we stopped at the byte ceiling.
		text = lines.slice(0, -1).join("\n");
		truncated = true;
	}

	return { text, truncated };
}

/**
 * Loads a local raster or safe SVG image for a `read` tool card or transcript `media` entry.
 */
export function readLocalImageAttachment(rawPath: string, cwd: string): ImageContent | null {
	const filePath = resolveLocalPath(rawPath, cwd);
	let fd: number | undefined;
	try {
		const stat = statSync(filePath);
		if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_READ_IMAGE_BYTES) return null;
		fd = openSync(filePath, "r");
		const head = Buffer.allocUnsafe(Math.min(stat.size, SNIFF_HEAD_BYTES));
		const bytesRead = readSync(fd, head, 0, head.length, 0);
		const sniffed = sniff(head.subarray(0, bytesRead));
		closeSync(fd);
		fd = undefined;
		if (sniffed.kind === "image") {
			return { type: "image", data: readFileSync(filePath).toString("base64"), mimeType: sniffed.mime };
		}
		if (sniffed.kind === "text" && /\.svg$/i.test(filePath) && stat.size <= MAX_READ_SVG_BYTES) {
			const bytes = readFileSync(filePath);
			if (isSafeSvgPreview(LOSSY_UTF8.decode(bytes))) {
				return { type: "image", data: bytes.toString("base64"), mimeType: "image/svg+xml" };
			}
		}
		return null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Ignore close failure.
			}
		}
	}
}

export interface LocalReadFallback {
	text: string;
	images: ImageContent[];
	truncated?: boolean;
}

/**
 * `agy acp`'s `read_file` tool updates omit `content`/`rawOutput` for both text/code and image files; read the local
 * file (raster images, safe SVG previews + source, bounded text/code slices, or a concise binary notice) so the `read`
 * tool card renders its contents.
 */
export function readLocalFileFallback(
	rawPath: string,
	cwd: string,
	args: Record<string, unknown>,
	need: { needText: boolean; needImages: boolean },
): LocalReadFallback {
	if (!need.needText && !need.needImages) return { text: "", images: [] };
	const filePath = resolveLocalPath(rawPath, cwd);
	let fd: number | undefined;
	try {
		const stat = statSync(filePath);
		if (!stat.isFile()) return { text: "", images: [] };
		if (stat.size === 0) {
			return { text: need.needText ? "(empty file)" : "", images: [] };
		}
		fd = openSync(filePath, "r");
		const head = Buffer.allocUnsafe(Math.min(stat.size, SNIFF_HEAD_BYTES));
		const bytesRead = readSync(fd, head, 0, head.length, 0);
		const headView = head.subarray(0, bytesRead);
		const sniffed = sniff(headView);

		if (sniffed.kind === "image") {
			closeSync(fd);
			fd = undefined;
			if (!need.needImages) return { text: "", images: [] };
			if (stat.size > MAX_READ_IMAGE_BYTES) {
				return {
					text: need.needText ? `[image too large to display · ${formatByteSize(stat.size)}]` : "",
					images: [],
				};
			}
			return {
				text: "",
				images: [{ type: "image", data: readFileSync(filePath).toString("base64"), mimeType: sniffed.mime }],
			};
		}

		if (sniffed.kind === "binary") {
			return {
				text: need.needText
					? `[${binaryDescription(filePath, headView, sniffed.reason)} · ${formatByteSize(stat.size)}]`
					: "",
				images: [],
			};
		}

		const images: ImageContent[] = [];
		let text = "";
		let truncated = false;

		if (need.needText) {
			const slice = readLocalTextSlice(fd, stat.size, args);
			text = slice.text;
			truncated = slice.truncated;
		}

		closeSync(fd);
		fd = undefined;

		if (need.needImages && /\.svg$/i.test(filePath) && stat.size <= MAX_READ_SVG_BYTES) {
			const svgBytes = readFileSync(filePath);
			if (isSafeSvgPreview(LOSSY_UTF8.decode(svgBytes))) {
				images.push({ type: "image", data: svgBytes.toString("base64"), mimeType: "image/svg+xml" });
			}
		}

		return { text, images, ...(truncated ? { truncated: true } : {}) };
	} catch {
		return { text: "", images: [] };
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Ignore close failure.
			}
		}
	}
}
