import type { SessionEvent } from "@omp-web/protocol";

export type NotificationSound = "completion" | "error" | "ask";

/** Prompt results are final; agent_end can be an async scheduling pause or an intermediate retry. */
export function soundOfEvent(ev: SessionEvent): NotificationSound | null {
	if (ev.k === "ui" && ev.request.method !== "editor") return "ask";
	if (ev.k !== "prompt_result" || ev.status === "aborted") return null;
	return ev.status === "error" ? "error" : "completion";
}

const STORAGE_KEY = "omp-web.notification-sounds";
const NOTES: Record<NotificationSound, readonly number[]> = {
	completion: [660, 880],
	error: [330, 220],
	ask: [880, 660, 880],
};

/** One lazy audio context per page. Never queue a notification behind an autoplay prompt. */
class NotificationSounds {
	#context: AudioContext | null = null;
	#enabled = true;
	#listeners = new Set<() => void>();

	getSnapshot = (): boolean => this.#enabled;
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	initialize(): void {
		try {
			this.#set(localStorage.getItem(STORAGE_KEY) !== "off");
		} catch {
			// Storage may be blocked; the in-memory switch still works.
		}
		window.addEventListener("pointerdown", this.unlock, { passive: true });
		window.addEventListener("keydown", this.unlock);
		window.addEventListener("storage", event => {
			if (event.key === STORAGE_KEY || event.key === null) this.#set(event.newValue !== "off");
		});
	}

	setEnabled(enabled: boolean): void {
		this.#set(enabled);
		try {
			localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
		} catch {
			// Storage may be blocked.
		}
		if (enabled) this.unlock();
	}

	unlock = (): void => {
		if (!this.#enabled || typeof AudioContext === "undefined") return;
		try {
			this.#context ??= new AudioContext();
			if (this.#context.state === "suspended") void this.#context.resume().catch(() => {});
		} catch {
			// Audio availability must not interfere with input or the event stream.
		}
	};

	play = (kind: NotificationSound): void => {
		const context = this.#context;
		if (!this.#enabled || !context || context.state !== "running") return;
		const start = context.currentTime;
		for (const [index, frequency] of NOTES[kind].entries()) {
			const at = start + index * 0.16;
			const oscillator = context.createOscillator();
			const gain = context.createGain();
			oscillator.type = "sine";
			oscillator.frequency.value = frequency;
			gain.gain.setValueAtTime(0, at);
			gain.gain.linearRampToValueAtTime(0.12, at + 0.01);
			gain.gain.exponentialRampToValueAtTime(0.001, at + 0.13);
			oscillator.connect(gain).connect(context.destination);
			oscillator.onended = () => {
				oscillator.disconnect();
				gain.disconnect();
			};
			oscillator.start(at);
			oscillator.stop(at + 0.14);
		}
	};

	async preview(kind: NotificationSound): Promise<void> {
		if (!this.#enabled) return;
		if (typeof AudioContext === "undefined") throw new Error("This browser does not support notification sounds.");
		this.#context ??= new AudioContext();
		await this.#context.resume();
		if (this.#context.state !== "running")
			throw new Error("Sound is blocked. Allow audio for this site and try again.");
		this.play(kind);
	}

	#set(enabled: boolean): void {
		if (enabled === this.#enabled) return;
		this.#enabled = enabled;
		for (const listener of this.#listeners) listener();
	}
}

export const notificationSounds = new NotificationSounds();
