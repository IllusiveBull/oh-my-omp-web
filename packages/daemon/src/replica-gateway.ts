import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	REPLICA_MAX_CHUNK_BYTES,
	type EnvLinkMessage,
	type GatewayLinkMessage,
	type ReplicaFileMeta,
	type ReplicaHave,
} from "@omp-web/protocol";
import type { GatewayStore, ReplicaRow } from "./db";
import { bodyHashes, safeReplicaName } from "./replica-files";
import { mkdirPrivate } from "./secrets";

type DataMessage = Extract<EnvLinkMessage, { t: "replica.data" }>;

/** `<root>/<machine id>`: where one machine's copies live. */
export function machineReplicaDir(root: string, machineId: string): string {
	if (!/^[\w-]+$/.test(machineId)) throw new Error(`unsafe machine id: ${machineId}`);
	return join(root, machineId);
}

/** Deletes every copy of a machine (when the machine is removed). */
export async function removeMachineReplicas(root: string, machineId: string): Promise<void> {
	await rm(machineReplicaDir(root, machineId), { recursive: true, force: true });
}

/**
 * The gateway's copies of the machines' session files: `<root>/<machine id>/<file name>`, byte for byte what the machine
 * has (title slot first, then the body), plus the SQLite rows that say how much of which version is there.
 */
export class ReplicaFiles {
	constructor(
		private readonly store: GatewayStore,
		readonly root: string,
	) {}

	/** The directory holding one machine's copies, which is also what `scanConversations` reads to rebuild its sessions. */
	dir(machineId: string): string {
		return machineReplicaDir(this.root, machineId);
	}

	path(row: ReplicaRow): string {
		return join(this.dir(row.machineId), row.name);
	}

	/** What is held of the file, or null when nothing usable is (no bytes, or the file does not match its row). */
	async have(row: ReplicaRow): Promise<ReplicaHave | null> {
		if (row.size === 0) return null;
		const info = await stat(this.path(row)).catch(() => null);
		if (info === null || info.size !== row.size) return null;
		const file = await open(this.path(row), "r");
		try {
			return { size: row.size, slotLen: row.slotLen, ...(await bodyHashes(file, row.size, row.slotLen)) };
		} finally {
			await file.close();
		}
	}

	/** Writes one chunk; false when it does not continue the copy (the caller starts the file over). */
	async apply(row: ReplicaRow, msg: DataMessage): Promise<boolean> {
		const slot = Buffer.from(msg.slot, "base64");
		const data = Buffer.from(msg.data, "base64");
		if (data.length > REPLICA_MAX_CHUNK_BYTES) return false;
		const dir = this.dir(row.machineId);
		await mkdirPrivate(dir);
		if (msg.restart ? msg.offset !== slot.length : msg.offset !== row.size || slot.length !== row.slotLen)
			return false;
		const file = await open(this.path(row), msg.restart ? "w" : "r+");
		try {
			if (slot.length > 0) await file.write(slot, 0, slot.length, 0);
			if (data.length > 0) await file.write(data, 0, data.length, msg.offset);
		} finally {
			await file.close();
		}
		this.store.replicaApplied(row.machineId, row.fileId, {
			size: msg.offset + data.length,
			slotLen: slot.length,
			mtimeMs: msg.mtimeMs,
		});
		return true;
	}

	/** Forgets the copy's bytes (it stopped matching its source) but keeps the row, so the file is fetched again. */
	async reset(row: ReplicaRow): Promise<void> {
		await rm(this.path(row), { force: true });
		this.store.replicaApplied(row.machineId, row.fileId, { size: 0, slotLen: 0, mtimeMs: 0 });
	}

	async remove(rows: readonly ReplicaRow[]): Promise<void> {
		for (const row of rows) await rm(this.path(row), { force: true });
	}
}

/** A file is dropped after this many consecutive chunks that did not continue its copy. */
const MAX_DESYNCS = 3;

/**
 * The gateway's half of the replica for one machine's link: takes the manifest, then fetches stale files one at a time
 * and one chunk at a time (`replica.want` → `replica.data` → next `replica.want`). Driving from this side is the flow
 * control: the daemon never sends a chunk nobody asked for, so live frames are never queued behind an upload.
 */
export class ReplicaSync {
	#queue: string[] = [];
	#current: string | null = null;
	#desyncs = 0;
	/** Files that failed in this manifest generation: they wait for the next manifest instead of looping. */
	#failed = new Set<string>();
	#chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly machineId: string,
		private readonly store: GatewayStore,
		private readonly files: ReplicaFiles,
		private readonly send: (message: GatewayLinkMessage) => void,
		/** A file of the copy reached the machine's version (or the set of files changed): session lists may carry new replica info. */
		private readonly onChange: () => void,
	) {}

	/** Everything still in flight settled; for tests and shutdown. */
	idle(): Promise<void> {
		return this.#chain;
	}

	/** The daemon's list of files to copy. Unknown names are ignored; files no longer listed are deleted. */
	manifest(files: ReplicaFileMeta[]): void {
		this.#enqueue(async () => {
			const safe = files.filter(f => safeReplicaName(f.name));
			const { stale, removed } = this.store.replicaReconcile(this.machineId, safe);
			await this.files.remove(removed);
			this.#failed.clear();
			this.#queue = stale;
			if (removed.length > 0) this.onChange();
			if (this.#current !== null && !stale.includes(this.#current)) this.#current = null;
			if (this.#current === null) await this.#next();
		});
	}

	data(msg: DataMessage): void {
		this.#enqueue(async () => {
			if (msg.id !== this.#current) return;
			const row = this.store.replicaRow(this.machineId, msg.id);
			if (!row) return this.#next();
			let applied = false;
			try {
				applied = await this.files.apply(row, msg);
			} catch (error) {
				console.warn(`omp-webd: replica of ${row.name}: ${error instanceof Error ? error.message : String(error)}`);
				this.#failed.add(row.fileId);
				return this.#next();
			}
			if (!applied) {
				// The chunk did not continue our copy (it moved under us): start this file over from nothing.
				await this.files.reset(row);
				if (++this.#desyncs > MAX_DESYNCS) {
					this.#failed.add(row.fileId);
					return this.#next();
				}
				return this.#want(row.fileId);
			}
			this.#desyncs = 0;
			if (msg.more) return this.#want(row.fileId);
			this.onChange();
			return this.#next();
		});
	}

	/** The daemon cannot or will not replicate a file (gone, a line too long): forget it until the next manifest. */
	skip(id: string, reason: string): void {
		this.#enqueue(async () => {
			const row = this.store.replicaRow(this.machineId, id);
			if (row) {
				console.warn(`omp-webd: not replicating ${row.name}: ${reason}`);
				this.#failed.add(id);
			}
			if (id === this.#current) await this.#next();
		});
	}

	#enqueue(task: () => Promise<void>): void {
		this.#chain = this.#chain.then(task).catch(error => {
			console.warn(`omp-webd: replica sync failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	async #next(): Promise<void> {
		this.#current = null;
		this.#desyncs = 0;
		for (let id = this.#queue.shift(); id !== undefined; id = this.#queue.shift()) {
			if (this.#failed.has(id)) continue;
			this.#current = id;
			await this.#want(id);
			return;
		}
	}

	async #want(id: string): Promise<void> {
		const row = this.store.replicaRow(this.machineId, id);
		if (!row) return this.#next();
		this.send({ t: "replica.want", id, have: await this.files.have(row) });
	}
}
