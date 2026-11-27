import { open } from "node:fs/promises";
import {
	REPLICA_CHUNK_BYTES,
	REPLICA_MAX_CHUNK_BYTES,
	type EnvLinkMessage,
	type ReplicaFileMeta,
	type ReplicaHave,
} from "@omp-web/protocol";
import { isPrefixOf, readRange, slotLength } from "./replica-files";

export interface ReplicaSource {
	meta: ReplicaFileMeta;
	/** Where the file is on this machine. */
	path: string;
}

/** Link bytes the socket may hold unsent before an upload chunk waits: live session traffic goes first. */
const LINK_BACKLOG_LIMIT = 256 * 1024;
const BACKLOG_POLL_MS = 50;

/**
 * The daemon's half of the transcript replica, per link: it announces which files it wants copied
 * (`replica.manifest`) and answers each `replica.want` with one chunk. The gateway drives (one want in flight, the next
 * only after it processed the previous chunk), so uploads interleave with live frames instead of queueing ahead of them,
 * and a chunk waits while the socket still holds a backlog.
 *
 * Every chunk is cut at a line end: the copy only ever contains whole lines, so a link that drops mid-upload leaves a
 * copy that parses.
 */
export class ReplicaUploader {
	#files = new Map<string, ReplicaSource>();
	#closed = false;

	constructor(
		private readonly send: (message: EnvLinkMessage) => void,
		private readonly bufferedAmount: () => number,
	) {}

	/** Announces the files to replicate, replacing the previous list. */
	announce(sources: ReplicaSource[]): void {
		this.#files = new Map(sources.map(s => [s.meta.id, s]));
		this.send({ t: "replica.manifest", files: sources.map(s => s.meta) });
	}

	close(): void {
		this.#closed = true;
	}

	/** Answers a `replica.want`: validates what the gateway holds against the file and sends the next piece. */
	async want(id: string, have: ReplicaHave | null): Promise<void> {
		const source = this.#files.get(id);
		if (!source) {
			this.send({ t: "replica.skip", id, reason: "not in the manifest" });
			return;
		}
		while (this.bufferedAmount() > LINK_BACKLOG_LIMIT) {
			if (this.#closed) return;
			await Bun.sleep(BACKLOG_POLL_MS);
		}
		if (this.#closed) return;
		try {
			this.send(await this.#chunk(id, source.path, have));
		} catch (error) {
			const gone = error instanceof Error && "code" in error && error.code === "ENOENT";
			this.send({
				t: "replica.skip",
				id,
				reason: gone
					? "the file is gone"
					: `cannot read it: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	async #chunk(id: string, path: string, have: ReplicaHave | null): Promise<EnvLinkMessage> {
		const file = await open(path, "r");
		try {
			const stat = await file.stat();
			const { size, mtimeMs } = stat;
			const slotLen = await slotLength(file, size);
			const restart = have === null || !(await isPrefixOf(file, size, slotLen, have));
			const start = restart ? slotLen : have.size;
			const slot = slotLen > 0 ? (await readRange(file, 0, slotLen)).toString("base64") : "";
			let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
			if (start < size) {
				let window = await readRange(file, start, Math.min(REPLICA_CHUNK_BYTES, size - start));
				let end = window.lastIndexOf(0x0a);
				// A line longer than the chunk: read on to its end, up to the cap.
				while (end === -1 && start + window.length < size && window.length < REPLICA_MAX_CHUNK_BYTES) {
					const more = await readRange(
						file,
						start + window.length,
						Math.min(REPLICA_CHUNK_BYTES, size - start - window.length),
					);
					window = Buffer.concat([window, more]);
					end = window.lastIndexOf(0x0a);
				}
				if (end === -1 && start + window.length < size) {
					return { t: "replica.skip", id, reason: `a line is longer than ${REPLICA_MAX_CHUNK_BYTES} bytes` };
				}
				// No newline at all and the file ends here: only an unfinished line remains, which waits.
				data = end === -1 ? Buffer.alloc(0) : window.subarray(0, end + 1);
			}
			return {
				t: "replica.data",
				id,
				restart,
				slot,
				offset: start,
				data: data.toString("base64"),
				size,
				mtimeMs,
				more: data.length > 0 && start + data.length < size,
			};
		} finally {
			await file.close();
		}
	}
}
