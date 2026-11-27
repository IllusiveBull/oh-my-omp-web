import type { BtwRecordWire, BtwTurnWire } from "@omp-web/protocol";
import type { RpcBtwHistoryRecord } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

type OmpTurn = Omit<RpcBtwHistoryRecord, "id" | "leafId" | "followUps">;

function toTurn({ question, answer, status, createdAt, updatedAt, error }: OmpTurn): BtwTurnWire {
	return { question, answer, status, createdAt, updatedAt, ...(error === undefined ? {} : { error }) };
}

/** omp's side-question topic as the browser gets it: pasted images stay in omp's sidecar, they are not relayed. */
export function toBtwWire(record: RpcBtwHistoryRecord): BtwRecordWire {
	return {
		...toTurn(record),
		id: record.id,
		leafId: record.leafId,
		...(record.followUps?.length ? { followUps: record.followUps.map(toTurn) } : {}),
	};
}

/** How often a streaming answer is published at most. */
const FLUSH_MS = 100;

/**
 * Turns omp's `/btw` frames into `btw` session events: a topic's full record on every lifecycle change, and while an
 * answer streams, the record with the deltas so far, at most every {@link FLUSH_MS} (each event carries the whole
 * topic, so the event log keeps only the newest per topic).
 */
export class BtwRelay {
	/** Topics with an answer streaming, as last published plus the deltas since. */
	#live = new Map<string, BtwRecordWire>();
	#dirty = new Set<string>();
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly publish: (record: BtwRecordWire) => void) {}

	record(raw: RpcBtwHistoryRecord): void {
		const record = toBtwWire(raw);
		this.#dirty.delete(record.id);
		if (record.status === "running" || record.followUps?.at(-1)?.status === "running")
			this.#live.set(record.id, record);
		else this.#live.delete(record.id);
		this.publish(record);
	}

	delta(recordId: string, delta: string): void {
		const record = this.#live.get(recordId);
		if (!record) return; // its `btw_record` (running) always comes first; a stray delta has nothing to extend
		const followUps = record.followUps;
		const last = followUps?.at(-1);
		this.#live.set(
			recordId,
			last && followUps
				? { ...record, followUps: [...followUps.slice(0, -1), { ...last, answer: last.answer + delta }] }
				: { ...record, answer: record.answer + delta },
		);
		this.#dirty.add(recordId);
		this.#timer ??= setTimeout(() => this.#flush(), FLUSH_MS);
	}

	/** Publishes pending deltas now and stops the timer (the session ends). */
	close(): void {
		clearTimeout(this.#timer);
		this.#flush();
	}

	#flush(): void {
		this.#timer = undefined;
		for (const id of this.#dirty) {
			const record = this.#live.get(id);
			if (record) this.publish(record);
		}
		this.#dirty.clear();
	}
}
