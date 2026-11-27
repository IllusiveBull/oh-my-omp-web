import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { EnvFrame, SessionSnapshot, SnapshotHead } from "./messages";

type Begin = Extract<EnvFrame, { t: "snapshot.begin" }>;

/**
 * Serialized `snapshot.begin`, `snapshot.chunk`* and `snapshot.end` frames of one snapshot, produced lazily so a sender
 * that has to wait for a slow client holds the snapshot, not its serialization. Entries go into chunks of at most
 * about `maxChunkBytes`; one entry larger than that travels alone (entries are already bounded by the collab shrinker).
 */
export function* snapshotFrames(
	sessionId: string,
	snapshotId: string,
	seq: number,
	epoch: string,
	snapshot: SessionSnapshot,
	maxChunkBytes: number,
): Generator<string> {
	const { entries, ...head } = snapshot;
	yield JSON.stringify({
		t: "snapshot.begin",
		sessionId,
		snapshotId,
		seq,
		epoch,
		head,
		entryCount: entries.length,
	} satisfies Begin);
	const prefix = `{"t":"snapshot.chunk","sessionId":${JSON.stringify(sessionId)},"snapshotId":${JSON.stringify(snapshotId)},"entries":[`;
	let parts: string[] = [];
	let bytes = 0;
	for (const entry of entries) {
		const json = JSON.stringify(entry);
		if (parts.length > 0 && bytes + json.length > maxChunkBytes) {
			yield `${prefix}${parts.join(",")}]}`;
			parts = [];
			bytes = 0;
		}
		parts.push(json);
		bytes += json.length;
	}
	if (parts.length > 0) yield `${prefix}${parts.join(",")}]}`;
	yield JSON.stringify({ t: "snapshot.end", sessionId, snapshotId } satisfies EnvFrame);
}

export interface AssembledSnapshot {
	sessionId: string;
	seq: number;
	epoch: string;
	snapshot: SessionSnapshot;
}

/**
 * Client side of {@link snapshotFrames}: collects the frames of one snapshot and releases it only when complete, so
 * the store applies it atomically. A `begin` discards anything half-assembled; frames of an unknown or superseded
 * snapshot are ignored; an `end` whose entry count does not match yields `null` (the caller resubscribes).
 */
export class SnapshotAssembler {
	#pending: { begin: Begin; entries: SessionEntry[] } | null = null;

	/** Feeds one frame; returns the finished snapshot at `snapshot.end`, `"incomplete"` for a broken one, else null. */
	push(frame: EnvFrame): AssembledSnapshot | "incomplete" | null {
		switch (frame.t) {
			case "snapshot.begin":
				this.#pending = { begin: frame, entries: [] };
				return null;
			case "snapshot.chunk":
				if (this.#pending?.begin.snapshotId === frame.snapshotId) this.#pending.entries.push(...frame.entries);
				return null;
			case "snapshot.end": {
				const pending = this.#pending;
				if (pending?.begin.snapshotId !== frame.snapshotId) return null;
				this.#pending = null;
				if (pending.entries.length !== pending.begin.entryCount) return "incomplete";
				const head: SnapshotHead = pending.begin.head;
				return {
					sessionId: pending.begin.sessionId,
					seq: pending.begin.seq,
					epoch: pending.begin.epoch,
					snapshot: { ...head, entries: pending.entries },
				};
			}
			default:
				return null;
		}
	}
}
