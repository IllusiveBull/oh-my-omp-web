import {
	MAX_REPLICATED_PAYLOAD_BYTES,
	serializeReplicatedEntry,
	serializeReplicatedEvent,
	type ReplicatedEntry,
	type SerializedReplication,
} from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { MAX_MESSAGE_IMAGE_CHARS } from "@omp-web/protocol";

/** Session-entry types the transcript can render (pi-wire `SessionEntry` union). Others still advance cursors. */
const WIRE_ENTRY_TYPES = new Set<string>([
	"message",
	"custom_message",
	"compaction",
	"branch_summary",
	"model_change",
	"thinking_level_change",
]);

/**
 * Total byte ceiling of one wire entry/event after restoring stashed image payloads: holds up to the prompt image cap
 * ({@link MAX_MESSAGE_IMAGE_CHARS}, 12 MiB) plus 1 MiB of non-image payload while staying safely below the gateway's
 * 16 MiB WebSocket frame limit.
 */
export const MAX_WIRE_PAYLOAD_BYTES = MAX_MESSAGE_IMAGE_CHARS + MAX_REPLICATED_PAYLOAD_BYTES;

/** What an image block becomes when restoring it would exceed {@link MAX_WIRE_PAYLOAD_BYTES} (never truncated base64). */
export const OMITTED_IMAGE_TEXT = "[image omitted: too large to display]";

const IMAGE_TOKEN_PREFIX = "\u0000omp-web-img:";
const IMAGE_TOKEN_SUFFIX = "\u0000";
const MAX_IMAGE_WALK_DEPTH = 64;

export interface EntryLike {
	id: string;
	type: string;
}

function isImageBlock(record: Record<string, unknown>): record is Record<string, unknown> & {
	type: "image";
	data: string;
	mimeType: string;
} {
	return record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string";
}

/**
 * Structural-sharing clone that replaces every non-empty `{ type: "image", data, mimeType }` block's `data` with a tiny
 * token so collab's 1 MiB string shrinker never slices base64 into a corrupted image. Leaves the caller's value untouched.
 */
function stashImages(root: unknown, images: Map<string, string>): unknown {
	const ancestors = new WeakSet<object>();

	const visit = (value: unknown, depth: number): unknown => {
		if (value === null || typeof value !== "object" || depth >= MAX_IMAGE_WALK_DEPTH) return value;
		if (ancestors.has(value)) return value;

		if (Array.isArray(value)) {
			ancestors.add(value);
			let copy: unknown[] | null = null;
			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				const next = visit(item, depth + 1);
				if (next !== item) {
					if (copy === null) copy = value.slice();
					copy[i] = next;
				}
			}
			ancestors.delete(value);
			return copy ?? value;
		}

		const withToJSON = value as { toJSON?: (key?: string) => unknown };
		if (typeof withToJSON.toJSON === "function") return value;

		const record = value as Record<string, unknown>;
		if (isImageBlock(record) && record.data.length > 0) {
			const token = `${IMAGE_TOKEN_PREFIX}${images.size}${IMAGE_TOKEN_SUFFIX}`;
			images.set(token, record.data);
			return { ...record, data: token };
		}

		ancestors.add(value);
		const keys = Object.keys(record);
		let copy: Record<string, unknown> | null = null;
		for (const key of keys) {
			const item = record[key];
			const next = visit(item, depth + 1);
			if (next !== item) {
				if (copy === null) copy = Object.assign(Object.create(null) as Record<string, unknown>, record);
				Object.defineProperty(copy, key, {
					value: next,
					writable: true,
					enumerable: true,
					configurable: true,
				});
			}
		}
		ancestors.delete(value);
		return copy ?? value;
	};

	return visit(root, 0);
}

/** Restores stashed base64 payloads into our private clone within `budget` bytes; any image over budget becomes text. */
function restoreImages(root: unknown, images: Map<string, string>, initialBudget: number): void {
	const ancestors = new WeakSet<object>();
	let budget = initialBudget;

	const replaceWithOmitted = (record: Record<string, unknown>): void => {
		record.type = "text";
		record.text = OMITTED_IMAGE_TEXT;
		delete record.data;
		delete record.mimeType;
	};

	const visit = (value: unknown, depth: number): void => {
		if (value === null || typeof value !== "object" || depth >= MAX_IMAGE_WALK_DEPTH) return;
		if (ancestors.has(value)) return;
		ancestors.add(value);

		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			ancestors.delete(value);
			return;
		}

		const record = value as Record<string, unknown>;
		if (record.type === "image" && typeof record.data === "string") {
			const original = images.get(record.data);
			if (original !== undefined) {
				const delta =
					Buffer.byteLength(JSON.stringify(original), "utf8") -
					Buffer.byteLength(JSON.stringify(record.data), "utf8");
				if (delta <= budget) {
					record.data = original;
					budget -= delta;
				} else {
					replaceWithOmitted(record);
				}
				ancestors.delete(value);
				return;
			}
			if (record.data.startsWith(IMAGE_TOKEN_PREFIX)) {
				replaceWithOmitted(record);
				ancestors.delete(value);
				return;
			}
		}

		for (const key of Object.keys(record)) visit(record[key], depth + 1);
		ancestors.delete(value);
	};

	visit(root, 0);
}

/**
 * Bounds `value` with collab's shrinker while keeping image base64 payloads intact up to {@link MAX_WIRE_PAYLOAD_BYTES}.
 * Collab's 1 MiB string shrinker otherwise slices image `data` at 64 KiB and appends an elision notice, which browsers
 * cannot decode and render as broken images.
 */
function serializePreservingImages<T>(
	value: T,
	shrink: (item: T) => SerializedReplication<T>,
): SerializedReplication<T> {
	let rawJson: string | undefined;
	try {
		rawJson = JSON.stringify(value);
	} catch {
		rawJson = undefined;
	}
	if (rawJson !== undefined) {
		if (
			rawJson.length * 3 <= MAX_REPLICATED_PAYLOAD_BYTES ||
			Buffer.byteLength(rawJson, "utf8") <= MAX_REPLICATED_PAYLOAD_BYTES
		) {
			return { value, json: rawJson };
		}
		if (!rawJson.includes('"image"')) return shrink(value);
	}

	const images = new Map<string, string>();
	const stashed = stashImages(value, images) as T;
	if (images.size === 0) return shrink(value);

	const shrunk = shrink(stashed);
	const baseBytes = Buffer.byteLength(shrunk.json, "utf8");
	restoreImages(shrunk.value, images, Math.max(0, MAX_WIRE_PAYLOAD_BYTES - baseBytes));
	return { value: shrunk.value, json: JSON.stringify(shrunk.value) };
}

/** The renderable entries, bounded for the wire while keeping image attachments decodable. */
export function toWireEntries(entries: readonly EntryLike[]): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (const entry of entries) {
		if (!WIRE_ENTRY_TYPES.has(entry.type)) continue;
		out.push(
			serializePreservingImages(entry as unknown as ReplicatedEntry, serializeReplicatedEntry)
				.value as unknown as SessionEntry,
		);
	}
	return out;
}

/** One agent event, bounded for the wire while keeping image attachments decodable. */
export function serializeWireEvent(event: AgentSessionEvent): SerializedReplication<AgentSessionEvent> {
	return serializePreservingImages(event, serializeReplicatedEvent);
}
