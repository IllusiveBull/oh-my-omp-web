import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { SubagentTranscript } from "@omp-web/protocol";

export type TranscriptRead = { ok: true; data: SubagentTranscript } | { ok: false; error: string };

/** What one read asks for: everything after `fromByte`, the page before `beforeByte`, or (neither) the latest page. */
export interface TranscriptPosition {
	fromByte?: number;
	beforeByte?: number;
}

export interface TranscriptState {
	entries: readonly SessionEntry[];
	/** Message of the last failed read; cleared by the next successful one. */
	error: string | null;
	/** No read has succeeded yet. */
	loading: boolean;
	/** Older entries exist before the first one read ({@link AgentTranscriptPoller.loadEarlier}). */
	earlier: boolean;
	/** An older page is being read. */
	loadingEarlier: boolean;
}

export const NO_TRANSCRIPT: TranscriptState = {
	entries: [],
	error: null,
	loading: true,
	earlier: false,
	loadingEarlier: false,
};

/** Consecutive unchanged polls of a non-running agent before the loop stops. */
const IDLE_POLLS_BEFORE_STOP = 4;

/**
 * Follows one sub-agent's transcript through `session.agent_transcript`. The first read takes the latest page only, so
 * a long transcript opens at its end at once; later reads continue from the cursor the previous one returned (`reset`
 * replaces everything read so far), every `pollMs` while the agent runs, and {@link loadEarlier} prepends the page before
 * the first entry. Once the agent is not running and a few polls in a row bring nothing, the loop stops until
 * {@link resume} (the agent showed activity again).
 */
export class AgentTranscriptPoller {
	#entries: readonly SessionEntry[] = [];
	#reported: TranscriptState = NO_TRANSCRIPT;
	#error: string | null = null;
	#loaded = false;
	/** Where the entries read start (0: at the file's start) and end (the next forward read's cursor). */
	#start = 0;
	#cursor = 0;
	/** Bumped when the entries are replaced, so an older page asked for before that is dropped. */
	#generation = 0;
	#idlePolls = 0;
	#inFlight = false;
	#loadingEarlier = false;
	#disposed = false;
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly read: (position: TranscriptPosition) => Promise<TranscriptRead>,
		private readonly onUpdate: (state: TranscriptState) => void,
		private readonly isRunning: () => boolean,
		private readonly pollMs = 1200,
	) {}

	get polling(): boolean {
		return this.#timer !== null;
	}

	/** Polls now and then every `pollMs`. No-op while already polling. */
	resume(): void {
		if (this.#disposed || this.#timer !== null) return;
		this.#idlePolls = 0;
		void this.poll();
		this.#timer = setInterval(() => void this.poll(), this.pollMs);
	}

	dispose(): void {
		this.#disposed = true;
		this.#stop();
	}

	/** One read. Overlapping calls are dropped. */
	async poll(): Promise<void> {
		if (this.#disposed || this.#inFlight) return;
		this.#inFlight = true;
		try {
			const result = await this.read(this.#loaded ? { fromByte: this.#cursor } : {});
			if (this.#disposed) return;
			if (!result.ok) {
				this.#error = result.error;
				this.#emit();
				this.#countIdle();
				return;
			}
			const { entries, nextByte, reset } = result.data;
			const changed = !this.#loaded || reset || nextByte !== this.#cursor;
			if (!this.#loaded || reset) {
				this.#entries = entries;
				// A daemon that predates paging sends everything, from the start.
				this.#start = result.data.startByte ?? 0;
				this.#generation++;
			} else if (entries.length > 0) this.#entries = [...this.#entries, ...entries];
			this.#cursor = nextByte;
			this.#loaded = true;
			this.#error = null;
			this.#emit();
			if (changed) this.#idlePolls = 0;
			else this.#countIdle();
		} finally {
			this.#inFlight = false;
		}
	}

	/** Reads the page before the first entry and prepends it. No-op while one is being read or none is left. */
	async loadEarlier(): Promise<void> {
		if (this.#disposed || this.#loadingEarlier || !this.#loaded || this.#start === 0) return;
		this.#loadingEarlier = true;
		this.#emit();
		const generation = this.#generation;
		try {
			const result = await this.read({ beforeByte: this.#start });
			if (this.#disposed || generation !== this.#generation) return;
			if (!result.ok) {
				this.#error = result.error;
				return;
			}
			if (result.data.reset) {
				// The file was rewritten: what the page holds is the new latest page.
				this.#entries = result.data.entries;
				this.#cursor = result.data.nextByte;
				this.#generation++;
			} else this.#entries = [...result.data.entries, ...this.#entries];
			this.#start = result.data.startByte ?? 0;
			this.#error = null;
		} finally {
			this.#loadingEarlier = false;
			if (!this.#disposed) this.#emit();
		}
	}

	/** Reports a state only when it differs from the last one, so an unchanged poll does not re-render the drawer. */
	#emit(): void {
		const previous = this.#reported;
		const next: TranscriptState = {
			entries: this.#entries,
			error: this.#error,
			loading: !this.#loaded,
			earlier: this.#start > 0,
			loadingEarlier: this.#loadingEarlier,
		};
		if (
			next.entries === previous.entries &&
			next.error === previous.error &&
			next.loading === previous.loading &&
			next.earlier === previous.earlier &&
			next.loadingEarlier === previous.loadingEarlier
		) {
			return;
		}
		this.#reported = next;
		this.onUpdate(next);
	}

	#countIdle(): void {
		if (this.isRunning()) {
			this.#idlePolls = 0;
			return;
		}
		if (++this.#idlePolls >= IDLE_POLLS_BEFORE_STOP) this.#stop();
	}

	#stop(): void {
		if (this.#timer === null) return;
		clearInterval(this.#timer);
		this.#timer = null;
	}
}
