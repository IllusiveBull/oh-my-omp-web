import type { PushPayload } from "@omp-web/protocol";
import type { GatewayStore, PushSubscriptionRow } from "../db";
import { encryptPayload } from "./encrypt";
import { vapidHeaders, type VapidKeys } from "./vapid";

export interface PushDelivery {
	/** How long the push service may hold the message for an offline device. */
	ttlSeconds: number;
	urgency: "very-low" | "low" | "normal" | "high";
	/** A newer message with the same topic replaces an undelivered older one at the push service. */
	topic?: string;
}

export interface PushSenderOptions {
	vapid: VapidKeys;
	/** `mailto:` or `https:` contact the push service may reach (RFC 8292 `sub`). */
	subject: string;
	store: GatewayStore;
	fetch?: typeof fetch;
	/** Milliseconds since the epoch. */
	now?: () => number;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Posts encrypted messages to the push services of subscribed devices and prunes the subscriptions they report dead. */
export class PushSender {
	readonly #vapid: VapidKeys;
	readonly #subject: string;
	readonly #store: GatewayStore;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #timeoutMs: number;

	constructor(options: PushSenderOptions) {
		this.#vapid = options.vapid;
		this.#subject = options.subject;
		this.#store = options.store;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/**
	 * One attempt, no retry. `delivered`: the push service accepted it; `gone`: it said the subscription no longer
	 * exists (now deleted); `failed`: anything else. The endpoint is a capability URL, so no log line contains it.
	 */
	async send(
		sub: PushSubscriptionRow,
		payload: PushPayload,
		delivery: PushDelivery,
	): Promise<"delivered" | "gone" | "failed"> {
		try {
			const body = await encryptPayload(sub, new TextEncoder().encode(JSON.stringify(payload)));
			const headers: Record<string, string> = {
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				TTL: String(delivery.ttlSeconds),
				Urgency: delivery.urgency,
				Authorization: await vapidHeaders(this.#vapid, new URL(sub.endpoint).origin, this.#subject, this.#now()),
			};
			if (delivery.topic !== undefined) headers.Topic = delivery.topic;
			const res = await this.#fetch(sub.endpoint, {
				method: "POST",
				headers,
				body,
				redirect: "manual",
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
			if (res.status === 200 || res.status === 201 || res.status === 202) {
				this.#store.recordPushDelivered(sub.id);
				return "delivered";
			}
			if (res.status === 404 || res.status === 410) {
				this.#store.deletePushSubscription(sub.id);
				console.warn(`push: subscription ${sub.id} is gone (${res.status}); removed`);
				return "gone";
			}
			console.warn(`push: subscription ${sub.id} rejected the message (${res.status})`);
		} catch (error) {
			console.warn(
				`push: sending to subscription ${sub.id} failed (${error instanceof Error ? error.name : "error"})`,
			);
		}
		return "failed";
	}
}
