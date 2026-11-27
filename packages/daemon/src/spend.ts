import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

/** Spend summed over a session file, split the way omp's status line shows it. */
export interface Spend {
	/** Every model call's cost, `task` results' sub-agent spend included. */
	cost: number;
	/** The part of `cost` that `task` results carry (finished blocking sub-agents; background ones carry none). */
	taskCost: number;
	/** GitHub Copilot premium requests (omp's `★`). */
	premiumRequests: number;
}

interface UsageLike {
	cost?: { total?: number };
	premiumRequests?: number;
}

export const emptySpend = (): Spend => ({ cost: 0, taskCost: 0, premiumRequests: 0 });

/**
 * Usage one entry records, counted like omp's own status line (`SessionEntryIndex` usage rollup): model calls,
 * `model_usage` records (compaction summaries, side calls) and the sub-agent usage a `task` result carries. Summed over
 * every entry of the file, so a compaction that drops messages from the context does not drop their spend.
 * (`get_session_stats` sums only the messages still in context.)
 */
export function addSpend(spend: Spend, entries: readonly FileEntry[]): void {
	for (const entry of entries) {
		let usage: UsageLike | undefined;
		let task = false;
		if (entry.type === "model_usage") usage = entry.usage;
		else if (entry.type === "message" && entry.message.role === "assistant") usage = entry.message.usage;
		else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "task") {
			const details: unknown = entry.message.details;
			if (
				details &&
				typeof details === "object" &&
				"usage" in details &&
				details.usage &&
				typeof details.usage === "object"
			) {
				usage = details.usage;
				task = true;
			}
		}
		if (!usage) continue;
		const cost = usage.cost?.total ?? 0;
		spend.cost += cost;
		if (task) spend.taskCost += cost;
		spend.premiumRequests += usage.premiumRequests ?? 0;
	}
}

/** A sub-agent as its transcript on disk records it: what the Agents list shows once omp's registry forgets it. */
export interface TranscriptAgent {
	/** The transcript's name: omp writes `<id>.jsonl` (a nested agent's id carries its parent's, `Parent.Child`). */
	id: string;
	file: string;
	startedAt: number;
	lastActivity: number;
	/**
	 * Its last assistant message was cut off (`stopReason: "aborted"`) or asked for tools other than `yield` and nothing
	 * followed: the run was stopped, by a kill or the process ending. Only meaningful for an agent omp no longer runs.
	 */
	aborted: boolean;
}

interface Transcript {
	size: number;
	mtimeMs: number;
	/** Bytes read so far: up to the last complete line. */
	offset: number;
	spend: Spend;
	/** The `session` header's time; absent from files that are not transcripts (`changes.jsonl`). */
	startedAt?: number;
	/** The latest entry's time. */
	lastAt?: number;
	aborted: boolean;
}

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

function entryTime(entry: FileEntry): number | undefined {
	const time = "timestamp" in entry && typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isNaN(time) ? undefined : time;
}

/**
 * A session's sub-agent tree on disk: every transcript in the session's artifacts directory (`<session>.jsonl` →
 * `<session>/<agent>.jsonl`, nested agents under `<session>/<agent>/`).
 *
 * - Spend: each transcript counted by its own model calls only (its `task` results are its children's transcripts,
 *   counted where they are). The main session's own advisors (`__advisor*.jsonl` at the top) are left out, as omp's
 *   status line bills them apart (`sumSubagentTreeCost`). Background `task` results carry no usage, so without this a
 *   restart forgets everything background sub-agents spent.
 * - Agents: every sub-agent that ever ran, finished, failed or killed ones included, which omp's `get_subagents` drops.
 *
 * Transcripts are append-only JSONL: a rescan reads only what was appended since (a shrunk file is read again).
 */
export class SubagentTree {
	#files = new Map<string, Transcript>();
	#agents: TranscriptAgent[] = [];

	/** The sub-agents found by the last {@link scan}. */
	get agents(): readonly TranscriptAgent[] {
		return this.#agents;
	}

	/** Rescans the tree of `sessionFile` (none: an unsaved session, no tree); returns what its sub-agents spent. */
	async scan(sessionFile: string | undefined): Promise<number> {
		const seen = new Map<string, Transcript>();
		const agents: TranscriptAgent[] = [];
		const total = sessionFile?.endsWith(".jsonl")
			? await this.#scan(sessionFile.slice(0, -".jsonl".length), true, seen, agents)
			: 0;
		this.#files = seen;
		this.#agents = agents;
		return total;
	}

	async #scan(dir: string, top: boolean, seen: Map<string, Transcript>, agents: TranscriptAgent[]): Promise<number> {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return 0;
			throw error;
		}
		const directories = new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name));
		let total = 0;
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak")) continue;
			if (top && entry.name.startsWith("__advisor")) continue;
			const file = join(dir, entry.name);
			const stem = entry.name.slice(0, -".jsonl".length);
			const transcript = await this.#read(file);
			if (transcript) {
				seen.set(file, transcript);
				total += Math.max(0, transcript.spend.cost - transcript.spend.taskCost);
				if (transcript.startedAt !== undefined && !stem.startsWith("__")) {
					agents.push({
						id: stem,
						file,
						startedAt: transcript.startedAt,
						lastActivity: transcript.lastAt ?? transcript.startedAt,
						aborted: transcript.aborted,
					});
				}
			}
			if (directories.has(stem)) total += await this.#scan(join(dir, stem), false, seen, agents);
		}
		return total;
	}

	async #read(file: string): Promise<Transcript | undefined> {
		let info: Stats;
		try {
			info = await stat(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const cached = this.#files.get(file);
		if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached;
		const grown = cached !== undefined && info.size >= cached.offset;
		const next: Transcript = grown
			? { ...cached, spend: { ...cached.spend } }
			: { size: 0, mtimeMs: 0, offset: 0, spend: emptySpend(), aborted: false };
		const bytes = await Bun.file(file).slice(next.offset, info.size).bytes();
		const end = bytes.lastIndexOf(NEWLINE) + 1;
		const entries: FileEntry[] = [];
		for (const line of decoder.decode(bytes.subarray(0, end)).split("\n")) {
			if (!line) continue;
			try {
				entries.push(JSON.parse(line) as FileEntry);
			} catch {
				// A malformed record carries no usage worth guessing at.
			}
		}
		addSpend(next.spend, entries);
		for (const entry of entries) {
			const time = entryTime(entry);
			if (entry.type === "session") next.startedAt ??= time;
			if (time !== undefined) next.lastAt = time;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const { stopReason, content } = entry.message;
				next.aborted =
					stopReason === "aborted" ||
					(stopReason === "toolUse" && !content.some(part => part.type === "toolCall" && part.name === "yield"));
			}
		}
		next.size = info.size;
		next.mtimeMs = info.mtimeMs;
		next.offset += end;
		return next;
	}
}
