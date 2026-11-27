/**
 * Web Push: what the gateway asks the env daemons to report (`AttentionEvent`), what it sends to devices
 * (`PushPayload`, encrypted per RFC 8291; the service worker decodes it) and the HTTP API devices subscribe with.
 */

/** A hosted session needs a human: its run ended, or it is waiting for an answer (ask / confirm / select / input). */
export type PushKind = "turn_end" | "input_needed";

/** What an env daemon reports about one hosted session (link message `attention`). */
export interface AttentionEvent {
	/** The session's stable id on that machine (what the web client subscribes with). */
	sessionId: string;
	kind: PushKind;
	/** Session title (or first prompt, or project directory name). */
	title: string;
	/** `turn_end`: the start of the assistant's last text; `input_needed`: what is being asked. At most 160 characters. */
	detail: string;
}

/** The push message body, JSON. Notifications of one thread share the tag `thread`, so a newer one replaces an older. */
export type PushPayload =
	| {
			type: "notify";
			/** Thread id (`GatewaySessionInfo.threadId`); the notification tag. */
			thread: string;
			machine: string;
			sessionId: string;
			kind: PushKind;
			title: string;
			body: string;
			/** Hash route of the session (`#/m/<machine>/s/<id>`); the click focuses or opens it. */
			url: string;
	  }
	/** Somebody read the thread: close its notification(s). */
	| { type: "clear"; thread: string }
	/** A test the user asked for from the settings: shown, opens nothing. */
	| { type: "test"; title: string; body: string };

/** `POST /api/push/subscriptions`: the browser's `PushSubscription.toJSON()` plus a label for the device list. */
export interface PushSubscribeRequest {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	label: string;
}

/** An entry of `GET /api/push/subscriptions`. The endpoint itself (a capability URL) is not returned, only its hash. */
export interface PushSubscriptionInfo {
	id: string;
	label: string;
	/** Hex SHA-256 of the endpoint URL: a device recognises itself by hashing its own endpoint. */
	endpointHash: string;
	createdAt: number;
	/** When the push service last accepted a message for it; null when none was sent yet. */
	lastDeliveredAt: number | null;
}

/** `GET /api/push/key`: the gateway's VAPID public key (uncompressed P-256 point, base64url), for `applicationServerKey`. */
export interface PushKeyResponse {
	publicKey: string;
}
