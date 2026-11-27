import type { AttentionEvent } from "@omp-web/protocol";

/**
 * What the gateway tells its notifier (Web Push): which hosted sessions need a human, and which threads somebody has
 * looked at. The notifier decides whom to push; the gateway only reports.
 */
export interface AttentionSink {
	/** A hosted session on `machine` finished a run or waits for an answer. Fire and forget. */
	attention(machine: string, event: AttentionEvent): void;
	/** A client read, or is looking at, the session (any of its ids): devices showing a notification for it must clear it. */
	seen(machine: string, sessionId: string): void;
}
