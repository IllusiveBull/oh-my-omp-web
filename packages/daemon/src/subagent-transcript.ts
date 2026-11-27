import { stat } from "node:fs/promises";
import type { SessionEntry as OmpSessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { toWireEntries } from "./wire-entries";

/** Bytes of transcript a page starts from; one is doubled until it holds {@link PAGE_MIN_ENTRIES} entries (or the file's start). */
export const TRANSCRIPT_PAGE_BYTES = 256 * 1024;
const PAGE_MIN_ENTRIES = 20;
const NEWLINE = 0x0a;
const decoder = new TextDecoder();

/** A run of whole renderable entries of a transcript and the byte range `[startByte, nextByte)` it was read from. */
export interface TranscriptWindow {
	entries: SessionEntry[];
	startByte: number;
	nextByte: number;
	/** The file is shorter than the cursor asked about (rewritten): `entries` replace everything read before. */
	reset: boolean;
}

function parse(bytes: Uint8Array): SessionEntry[] {
	const entries: OmpSessionEntry[] = [];
	for (const line of decoder.decode(bytes).split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as OmpSessionEntry);
		} catch {
			// A torn or malformed record renders nothing; its neighbours still do.
		}
	}
	return toWireEntries(entries);
}

async function sizeOf(file: string): Promise<number> {
	try {
		return (await stat(file)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

/** Whole lines from `fromByte` to the end of the file (a line still being written waits for the next read). */
export async function readTranscriptForward(file: string, fromByte: number): Promise<TranscriptWindow> {
	const size = await sizeOf(file);
	if (fromByte > size) return readTranscriptPage(file, undefined, true);
	const bytes = fromByte === size ? new Uint8Array() : await Bun.file(file).slice(fromByte, size).bytes();
	const end = bytes.lastIndexOf(NEWLINE) + 1;
	return { entries: parse(bytes.subarray(0, end)), startByte: fromByte, nextByte: fromByte + end, reset: false };
}

/**
 * The page of whole lines that ends at `beforeByte` (a line boundary a previous read returned), or at the last whole
 * line of the file when it is absent: the latest part of the transcript, which a reader wants first. Older pages are read
 * by passing the returned `startByte` back as `beforeByte`.
 */
export async function readTranscriptPage(
	file: string,
	beforeByte: number | undefined,
	reset = false,
): Promise<TranscriptWindow> {
	const size = await sizeOf(file);
	if (beforeByte !== undefined && beforeByte > size) return readTranscriptPage(file, undefined, true);
	let end = beforeByte;
	for (let window = TRANSCRIPT_PAGE_BYTES; ; window *= 2) {
		const limit = end ?? size;
		const start = Math.max(0, limit - window);
		const bytes = start === limit ? new Uint8Array() : await Bun.file(file).slice(start, limit).bytes();
		// The file's last line may still be being written: the page ends at the last whole one.
		const tail = end === undefined ? bytes.lastIndexOf(NEWLINE) + 1 : bytes.length;
		if (tail === 0 && start > 0) continue;
		end = start + tail;
		// The window may start inside a line: the page starts after it.
		const head = start === 0 ? 0 : bytes.indexOf(NEWLINE) + 1;
		if (head === 0 && start > 0) continue;
		const entries = parse(bytes.subarray(head, tail));
		if (entries.length >= PAGE_MIN_ENTRIES || start === 0) {
			return { entries, startByte: start + head, nextByte: end, reset };
		}
	}
}
