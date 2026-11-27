import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	isLoopDurationExpired,
	isLoopLimitExhausted,
	parseLoopArgs,
} from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import type { LoopConditionOptions, LoopConditionVerdict } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import type { LoopConditionConfig, LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";
import type { LoopWire } from "@omp-web/protocol";

/** What a loop needs from its session. */
export interface LoopHost {
	cwd: string;
	sessionId(): string;
	/** A run, compaction or queued message would collide with the next iteration. */
	isBusy(): Promise<boolean>;
	submit(prompt: string): Promise<void>;
	notify(level: "info" | "warning" | "error", message: string): void;
	/** The loop's state changed (undefined: loop mode is off). */
	changed(loop: LoopWire | undefined): void;
}

export interface LoopOptions {
	/** Pause between a settled run and the next iteration, as omp's terminal UI waits (ms). */
	delayMs?: number;
	/** omp's `loop.conditionTimeoutMs` default; 0 waits indefinitely. */
	conditionTimeoutMs?: number;
	/** Runs a `--while`/`--until` command; omp's own by default (loaded on first use: it pulls in omp's shell). */
	evaluate?: (condition: LoopConditionConfig, options: LoopConditionOptions) => Promise<LoopConditionVerdict>;
}

interface Active {
	paused: boolean;
	prompt: string | undefined;
	limit: LoopLimitRuntime | undefined;
	condition: LoopConditionConfig | undefined;
}

// Lazy on purpose: omp's condition runner pulls in its whole bash executor, which most daemons never need.
const defaultEvaluate: NonNullable<LoopOptions["evaluate"]> = async (condition, options) =>
	(await import("@oh-my-pi/pi-coding-agent/modes/loop-condition")).evaluateLoopCondition(condition, options);

/**
 * omp's `/loop` for a session hosted over RPC, which has no loop mode of its own: the prompt sent after `/loop` (or
 * given inline) is sent again each time the session settles (omp's `session_settled`: the run ended, background
 * subagents included, and nothing is queued), until its limit runs out or its condition says stop. A stop or a failed
 * run pauses it; the next prompt sent resumes it with that prompt; `/loop` again turns it off. Mirrors
 * `InteractiveMode`'s loop with omp's default `loop.mode` (`prompt`).
 */
export class LoopMode {
	readonly #host: LoopHost;
	readonly #delayMs: number;
	readonly #conditionTimeoutMs: number;
	readonly #evaluate: NonNullable<LoopOptions["evaluate"]>;
	#active: Active | undefined;
	/** Bumped by every change of prompt or state: an iteration started under an older one gives up. */
	#generation = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** Settles the promise {@link settled} returned when its timer is cancelled before firing. */
	#timerDone: (() => void) | undefined;
	#conditionAbort: AbortController | undefined;

	constructor(host: LoopHost, options: LoopOptions = {}) {
		this.#host = host;
		this.#delayMs = options.delayMs ?? 800;
		this.#conditionTimeoutMs = options.conditionTimeoutMs ?? 30_000;
		this.#evaluate = options.evaluate ?? defaultEvaluate;
	}

	get enabled(): boolean {
		return this.#active !== undefined;
	}

	get wire(): LoopWire | undefined {
		const active = this.#active;
		if (!active) return undefined;
		const limit = active.limit;
		return {
			state: active.paused ? "paused" : active.prompt !== undefined ? "running" : "waiting",
			...(active.prompt !== undefined ? { prompt: active.prompt } : {}),
			...(limit?.kind === "iterations"
				? { limit: { kind: "iterations", remaining: limit.remaining, initial: limit.initial } }
				: limit?.kind === "duration"
					? { limit: { kind: "duration", deadlineMs: limit.deadlineMs } }
					: {}),
			...(active.condition
				? { condition: { command: active.condition.command, until: active.condition.until } }
				: {}),
		};
	}

	/**
	 * `/loop args`: turns loop mode off when it is on; otherwise on, returning the inline prompt (if any) for the caller
	 * to send as the first run. Throws omp's usage message for arguments it cannot parse.
	 */
	toggle(args: string): string | undefined {
		if (this.#active) {
			this.disable("Loop mode disabled.");
			return undefined;
		}
		const parsed = parseLoopArgs(args);
		if (typeof parsed === "string") throw new Error(parsed);
		this.#active = {
			paused: false,
			prompt: undefined,
			limit: createLoopLimitRuntime(parsed.limit),
			condition: parsed.condition,
		};
		this.#bump();
		const limit = parsed.limit ? ` Limited to ${describeLoopLimit(parsed.limit)}.` : "";
		const condition = parsed.condition
			? ` Continuing ${parsed.condition.until ? "until" : "while"} \`${parsed.condition.command}\` ${parsed.condition.until ? "succeeds" : "fails"}.`
			: "";
		const tail = parsed.prompt ? "Repeating it after each run." : "The next prompt you send repeats after each run.";
		this.#host.notify(
			"info",
			`Loop mode enabled.${limit}${condition} ${tail} Stop pauses the loop; /loop again turns it off.`,
		);
		return parsed.prompt;
	}

	/** A prompt the user sent while loop mode is on: it becomes the prompt to repeat (and resumes a paused loop). */
	recordPrompt(prompt: string): void {
		const active = this.#active;
		if (!active) return;
		active.prompt = prompt;
		active.paused = false;
		this.#bump();
	}

	/** Stops repeating until the next prompt is sent (the user stopped the run, or it failed). */
	pause(): void {
		const active = this.#active;
		if (!active || active.paused) return;
		active.paused = true;
		active.prompt = undefined;
		this.#bump();
	}

	disable(message: string): void {
		if (!this.#active) return;
		this.#active = undefined;
		this.#bump();
		this.#host.notify("info", message);
	}

	/** Releases the timer and a running condition without reporting anything (the session is going away). */
	close(): void {
		this.#active = undefined;
		this.#cancel();
	}

	/**
	 * omp's `session_settled`: schedules the next iteration. Resolves when that iteration has run (or was dropped by a
	 * stop, a new prompt or the loop turning off).
	 */
	settled(): Promise<void> {
		const active = this.#active;
		if (!active || active.paused || active.prompt === undefined) return Promise.resolve();
		this.#cancelTimer();
		const generation = this.#generation;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#timerDone = resolve;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#timerDone = undefined;
			this.#iterate(generation)
				.catch(error => {
					if (generation !== this.#generation) return;
					this.#host.notify("error", `Loop paused: ${error instanceof Error ? error.message : String(error)}`);
					this.pause();
				})
				.finally(resolve);
		}, this.#delayMs);
		return promise;
	}

	async #iterate(generation: number): Promise<void> {
		const current = (): Active | undefined => (generation === this.#generation ? this.#active : undefined);
		let active = current();
		if (!active?.prompt) return;
		if (isLoopDurationExpired(active.limit)) return this.disable("Loop time limit reached. Loop mode disabled.");
		// Something started meanwhile (a prompt from another client): its own settle schedules the next iteration.
		if (await this.#host.isBusy()) return;
		active = current();
		if (!active?.prompt) return;
		// An exhausted budget ends the loop before the condition runs one last time for nothing.
		if (isLoopLimitExhausted(active.limit)) return this.disable("Loop limit reached. Loop mode disabled.");
		if (active.condition) {
			const controller = new AbortController();
			this.#conditionAbort = controller;
			const sessionId = this.#host.sessionId();
			let verdict: LoopConditionVerdict;
			try {
				verdict = await this.#evaluate(active.condition, {
					cwd: this.#host.cwd,
					timeoutMs: this.#conditionTimeoutMs,
					signal: controller.signal,
					sessionId,
					isSessionCurrent: () => this.#host.sessionId() === sessionId,
				});
			} finally {
				if (this.#conditionAbort === controller) this.#conditionAbort = undefined;
			}
			if (!current()) return;
			if (verdict.kind === "aborted") return;
			if (verdict.kind !== "continue") return this.disable(verdict.message);
			// The command took a while: a run may have started meanwhile.
			if (await this.#host.isBusy()) return;
			active = current();
			if (!active?.prompt) return;
		}
		if (!consumeLoopLimitIteration(active.limit)) return this.disable("Loop limit reached. Loop mode disabled.");
		this.#host.changed(this.wire);
		await this.#host.submit(active.prompt);
	}

	#bump(): void {
		this.#generation++;
		this.#cancel();
		this.#host.changed(this.wire);
	}

	#cancel(): void {
		this.#cancelTimer();
		this.#conditionAbort?.abort();
		this.#conditionAbort = undefined;
	}

	#cancelTimer(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#timerDone?.();
		this.#timerDone = undefined;
	}
}
