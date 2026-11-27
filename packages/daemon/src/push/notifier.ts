import type { AttentionEvent, PushPayload } from "@omp-web/protocol";
import type { AttentionSink } from "../attention";
import type { GatewayStore } from "../db";
import type { PushDelivery, PushSender } from "./sender";

export interface PushNotifierOptions {
	store: GatewayStore;
	sender: PushSender;
	/** Whether some connected client is looking at the session right now (page visible, session open). */
	isViewed: (machine: string, sessionId: string) => boolean;
	machineName: (machine: string) => string;
}

const FALLBACK_BODY: Record<AttentionEvent["kind"], string> = {
	turn_end: "Finished",
	input_needed: "Waiting for your input",
};

/** An answer is worth waking a device for; a finished run can wait a while and then expires. */
const DELIVERY: Record<AttentionEvent["kind"], Omit<PushDelivery, "topic">> = {
	input_needed: { urgency: "high", ttlSeconds: 86_400 },
	turn_end: { urgency: "normal", ttlSeconds: 3_600 },
};

/**
 * Apple's web push (Safari / the Home Screen PWA) revokes a subscription after a few pushes that show no notification,
 * and a `clear` shows none, so Apple devices are not sent one (they close their own notifications when the thread is
 * opened). [INFERENCE: Apple's documented rule, not observed here]
 */
const isApple = (endpoint: string): boolean => /(^|\.)push\.apple\.com$/.test(new URL(endpoint).hostname);

const CLEAR_DELIVERY: Omit<PushDelivery, "topic"> = { urgency: "low", ttlSeconds: 600 };

/** Someone is waiting for it with the settings open: wake the device now, and drop it if it cannot arrive soon. */
const TEST_DELIVERY: PushDelivery = { urgency: "high", ttlSeconds: 60, topic: "test" };
const TEST_PAYLOAD: PushPayload = {
	type: "test",
	title: "omp-web",
	body: "Test notification: this device gets notified when a session needs you.",
};

/**
 * Turns the gateway's attention reports into Web Push messages for every subscribed device, and remembers which devices
 * show a notification for which thread so that reading the thread clears them. Never throws into the gateway; the
 * returned promises settle when the pushes have been answered (callers need not await them).
 */
export class PushNotifier implements AttentionSink {
	readonly #store: GatewayStore;
	readonly #sender: PushSender;
	readonly #isViewed: PushNotifierOptions["isViewed"];
	readonly #machineName: PushNotifierOptions["machineName"];
	readonly #unknown = new Set<string>();

	constructor(options: PushNotifierOptions) {
		this.#store = options.store;
		this.#sender = options.sender;
		this.#isViewed = options.isViewed;
		this.#machineName = options.machineName;
	}

	async attention(machine: string, event: AttentionEvent): Promise<void> {
		try {
			const thread = this.#thread(machine, event.sessionId);
			if (thread === undefined || this.#isViewed(machine, event.sessionId)) return;
			const payload: PushPayload = {
				type: "notify",
				thread,
				machine,
				sessionId: event.sessionId,
				kind: event.kind,
				title: `${this.#machineName(machine)} · ${event.title}`,
				body: event.detail === "" ? FALLBACK_BODY[event.kind] : event.detail,
				url: `#/m/${encodeURIComponent(machine)}/s/${encodeURIComponent(event.sessionId)}`,
			};
			const delivery: PushDelivery = { ...DELIVERY[event.kind], topic: thread };
			await Promise.all(
				this.#store.pushSubscriptions().map(async sub => {
					if ((await this.#sender.send(sub, payload, delivery)) === "delivered")
						this.#store.markNotified(sub.id, thread);
				}),
			);
		} catch (error) {
			console.warn(`push: could not notify (${error instanceof Error ? error.message : String(error)})`);
		}
	}

	async seen(machine: string, sessionId: string): Promise<void> {
		try {
			const thread = this.#store.threadOf(machine, sessionId);
			if (thread === undefined) return;
			const notified = new Set(this.#store.takeNotified(thread));
			if (notified.size === 0) return;
			const payload: PushPayload = { type: "clear", thread };
			const delivery: PushDelivery = { ...CLEAR_DELIVERY, topic: thread };
			await Promise.all(
				this.#store
					.pushSubscriptions()
					.filter(sub => notified.has(sub.id) && !isApple(sub.endpoint))
					.map(sub => this.#sender.send(sub, payload, delivery)),
			);
		} catch (error) {
			console.warn(`push: could not clear (${error instanceof Error ? error.message : String(error)})`);
		}
	}

	/** Sends one device a test notification; `unknown` when no device has that id. */
	async test(id: string): Promise<"delivered" | "gone" | "failed" | "unknown"> {
		const sub = this.#store.pushSubscriptions().find(s => s.id === id);
		return sub === undefined ? "unknown" : this.#sender.send(sub, TEST_PAYLOAD, TEST_DELIVERY);
	}

	#thread(machine: string, sessionId: string): string | undefined {
		const thread = this.#store.threadOf(machine, sessionId);
		if (thread === undefined && !this.#unknown.has(`${machine}\0${sessionId}`)) {
			this.#unknown.add(`${machine}\0${sessionId}`);
			console.warn(`push: attention for a session the gateway does not know (${machine}); skipped`);
		}
		return thread;
	}
}
