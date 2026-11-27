import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { join } from "node:path";

/** Builds on-disk omp session files in omp's own layout, for the index / stored-session tests. */

export interface SessionFileSpec {
	id: string;
	/** ISO timestamp of the header; also names the file the way omp does (`<time with : and . as ->_<id>.jsonl`). */
	created: string;
	cwd?: string;
	title?: string;
	continuationOf?: string;
	parentSession?: string;
	entries: object[];
	/** Overrides the file's mtime (a process that wrote late, e.g. its exit record). */
	mtime?: Date;
	/** Writes omp's fixed-width title slot (the 256-byte first line) with this title, like a renamed session has. */
	slotTitle?: string;
}

/** The title slot line omp writes first in a session file (exactly 256 bytes). */
export const titleSlot = (title: string, updatedAt = "2026-11-01T10:00:00.000Z"): string =>
	serializeTitleSlot({ title, source: "user", updatedAt });

export function writeSessionFile(dir: string, spec: SessionFileSpec): string {
	mkdirSync(dir, { recursive: true });
	const header = {
		type: "session",
		version: 3,
		id: spec.id,
		timestamp: spec.created,
		cwd: spec.cwd ?? "/work/project",
		...(spec.title ? { title: spec.title } : {}),
		...(spec.parentSession ? { parentSession: spec.parentSession } : {}),
		...(spec.continuationOf ? { continuationOf: spec.continuationOf } : {}),
	};
	const path = join(dir, `${spec.created.replace(/[:.]/g, "-")}_${spec.id}.jsonl`);
	const body = `${[header, ...spec.entries].map(entry => JSON.stringify(entry)).join("\n")}\n`;
	writeFileSync(path, spec.slotTitle === undefined ? body : titleSlot(spec.slotTitle) + body);
	if (spec.mtime) utimesSync(path, spec.mtime, spec.mtime);
	return path;
}

export const user = (id: string, parentId: string | null, text: string, timestamp: string) => ({
	type: "message",
	id,
	parentId,
	timestamp,
	message: { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: Date.parse(timestamp) },
});

export const assistant = (id: string, parentId: string | null, text: string, timestamp: string) => ({
	type: "message",
	id,
	parentId,
	timestamp,
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "m",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: Date.parse(timestamp),
	},
});

/** A conversation `u1 -> a1 [-> u2 -> a2]` with ids prefixed by `prefix`. */
export function turns(prefix: string, texts: string[], startMs: number): object[] {
	const out: object[] = [];
	let parent: string | null = null;
	texts.forEach((text, i) => {
		const at = new Date(startMs + i * 1000).toISOString();
		const entry =
			i % 2 === 0 ? user(`${prefix}${i}`, parent, text, at) : assistant(`${prefix}${i}`, parent, text, at);
		out.push(entry);
		parent = `${prefix}${i}`;
	});
	return out;
}
