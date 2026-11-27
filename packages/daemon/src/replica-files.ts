import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { parseTitleSlotLine } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { REPLICA_CHECK_BYTES, type ReplicaHave } from "@omp-web/protocol";

/**
 * Shape of an omp session file, as far as replication cares. omp changes a file in three ways: it appends lines; it
 * rewrites the fixed-width title slot in place (the first 256-byte line, same size, new mtime: a rename); and it
 * sometimes rewrites the whole file (compaction, branch edits, header repoint) through a staged copy. A replica is the
 * title slot plus an append-only body, and tells the last two apart from the first by hashing both ends of the body.
 */

/** Stable id of a source file: a hash of its path on the machine. */
export function replicaFileId(path: string): string {
	return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export async function readRange(file: FileHandle, start: number, length: number): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await file.read(buffer, filled, length - filled, start + filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return buffer.subarray(0, filled);
}

/** Length of the title slot at the start of a file (its first line, newline included); 0 when the file has none. */
export async function slotLength(file: FileHandle, size: number): Promise<number> {
	const head = await readRange(file, 0, Math.min(size, 2048));
	const newline = head.indexOf(0x0a);
	if (newline === -1) return 0;
	return parseTitleSlotLine(head.subarray(0, newline).toString("utf8").trim()) ? newline + 1 : 0;
}

/** Hashes of the first and last {@link REPLICA_CHECK_BYTES} of the body (what follows the slot) of the first `size` bytes. */
export async function bodyHashes(
	file: FileHandle,
	size: number,
	slotLen: number,
): Promise<{ headHash: string; tailHash: string }> {
	const body = Math.max(0, size - slotLen);
	const window = Math.min(REPLICA_CHECK_BYTES, body);
	const head = await readRange(file, slotLen, window);
	const tail = await readRange(file, size - window, window);
	return { headHash: sha256(head), tailHash: sha256(tail) };
}

/** Whether `have` (the gateway's copy) is a prefix of the file the handle reads, so that appending from `have.size` is sound. */
export async function isPrefixOf(
	file: FileHandle,
	fileSize: number,
	fileSlotLen: number,
	have: ReplicaHave,
): Promise<boolean> {
	if (have.slotLen !== fileSlotLen || have.size < fileSlotLen || have.size > fileSize) return false;
	const hashes = await bodyHashes(file, have.size, have.slotLen);
	return hashes.headHash === have.headHash && hashes.tailHash === have.tailHash;
}

/** A copy's file name is the source's base name; anything that could leave the machine's directory is refused. */
export function safeReplicaName(name: string): boolean {
	return /^[\w.@+=-]+\.jsonl$/.test(name) && !name.startsWith(".") && !name.includes("..");
}
