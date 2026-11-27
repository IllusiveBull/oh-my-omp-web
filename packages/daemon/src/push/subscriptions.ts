import { createHash } from "node:crypto";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { PushSubscribeRequest, PushSubscriptionInfo } from "@omp-web/protocol";
import type { PushSubscriptionRow } from "../db";
import { fromBase64Url } from "./encrypt";

export const MAX_LABEL_LENGTH = 80;
export const DEFAULT_LABEL = "device";

/** A push service is reached over https; plain http only on loopback, so tests and local smokes can use a fake one. */
function endpointError(endpoint: string): string | null {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return "endpoint is not a URL";
	}
	if (url.username !== "" || url.password !== "") return "endpoint must not carry credentials";
	const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
	return url.protocol === "https:" || loopback ? null : "endpoint must be an https URL";
}

/** Validates a `POST /api/push/subscriptions` body; the error message when it is not acceptable. */
export function parseSubscribeRequest(text: string): PushSubscribeRequest | string {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return "body is not JSON";
	}
	if (!isRecord(body)) return "body must be an object";
	const { endpoint } = body;
	if (typeof endpoint !== "string") return "endpoint must be a string";
	const problem = endpointError(endpoint);
	if (problem !== null) return problem;
	if (!isRecord(body.keys)) return "keys must be an object";
	const { p256dh, auth } = body.keys;
	const point = typeof p256dh === "string" ? fromBase64Url(p256dh) : null;
	if (typeof p256dh !== "string" || point?.length !== 65 || point[0] !== 0x04) {
		return "keys.p256dh must be an uncompressed P-256 point (base64url)";
	}
	if (typeof auth !== "string" || fromBase64Url(auth)?.length !== 16) return "keys.auth must be 16 bytes (base64url)";
	if (typeof body.label !== "string") return "label must be a string";
	const label = body.label.trim();
	if (label.length > MAX_LABEL_LENGTH) return `label is longer than ${MAX_LABEL_LENGTH} characters`;
	return {
		endpoint,
		keys: { p256dh, auth },
		label: label === "" ? DEFAULT_LABEL : label,
	};
}

/** What a device may see of its subscription: never the endpoint (a capability URL) or the keys. */
export function subscriptionInfo(row: PushSubscriptionRow): PushSubscriptionInfo {
	return {
		id: row.id,
		label: row.label,
		endpointHash: createHash("sha256").update(row.endpoint).digest("hex"),
		createdAt: row.createdAt,
		lastDeliveredAt: row.lastDeliveredAt,
	};
}
