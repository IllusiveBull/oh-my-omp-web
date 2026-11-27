import type { PushPayload } from "@omp-web/protocol";
import { field } from "./json";
import { parseSessionHash } from "./route";

/** What the service worker posts to an open page when a notification is clicked; `main.tsx` turns it into a route. */
export const OPEN_MESSAGE_TYPE = "omp-open";

/** Tag of the test notification: a second test replaces the first. */
export const TEST_TAG = "omp-web-test";

/** What a push event asks the service worker to do. A shown notification without a `url` opens nothing when clicked. */
export type PushPlan =
	| { action: "show"; title: string; options: { body: string; tag: string; renotify: true; data: { url?: string } } }
	| { action: "clear"; thread: string }
	| { action: "ignore" };

/** Narrows a decoded push body to {@link PushPayload}; anything else (wrong shape, unknown `type`, a url that is not a session route) is null. */
export function parsePushPayload(value: unknown): PushPayload | null {
	if (typeof value !== "object" || value === null) return null;
	const type = field(value, "type");
	const thread = field(value, "thread");
	if (type === "clear") return typeof thread === "string" && thread ? { type: "clear", thread } : null;
	if (type === "test") {
		const title = field(value, "title");
		const body = field(value, "body");
		return typeof title === "string" && typeof body === "string" ? { type: "test", title, body } : null;
	}
	if (type !== "notify") return null;
	const machine = field(value, "machine");
	const sessionId = field(value, "sessionId");
	const kind = field(value, "kind");
	const title = field(value, "title");
	const body = field(value, "body");
	const url = field(value, "url");
	if (typeof thread !== "string" || !thread) return null;
	if (typeof machine !== "string" || typeof sessionId !== "string") return null;
	if (kind !== "turn_end" && kind !== "input_needed") return null;
	if (typeof title !== "string" || typeof body !== "string") return null;
	// The click opens this route; a payload carrying anything else is not something this gateway sent.
	if (typeof url !== "string" || parseSessionHash(url) === null) return null;
	return { type: "notify", thread, machine, sessionId, kind, title, body, url };
}

/** The decision for one push message body (the raw text of the event's data, or null when it had none). Never throws. */
export function planPush(text: string | null): PushPlan {
	if (text === null) return { action: "ignore" };
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch {
		return { action: "ignore" };
	}
	const payload = parsePushPayload(decoded);
	if (!payload) return { action: "ignore" };
	if (payload.type === "clear") return { action: "clear", thread: payload.thread };
	if (payload.type === "test") {
		return {
			action: "show",
			title: payload.title,
			options: { body: payload.body, tag: TEST_TAG, renotify: true, data: {} },
		};
	}
	return {
		action: "show",
		title: payload.title,
		options: { body: payload.body, tag: payload.thread, renotify: true, data: { url: payload.url } },
	};
}

/** The notifications of `thread` among the open ones: a `clear` closes exactly those. */
export function notificationsOfThread<T extends { tag: string }>(thread: string, open: readonly T[]): T[] {
	return open.filter(notification => notification.tag === thread);
}

/** The route a clicked notification carries in its `data`, or null when it has none that is valid. */
export function notificationRoute(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const url = field(data, "url");
	return typeof url === "string" && parseSessionHash(url) !== null ? url : null;
}

/** The part of a service-worker `WindowClient` the click decision looks at. */
export interface WindowCandidate {
	url: string;
	focused: boolean;
	visibilityState: string;
}

/**
 * The window a click should reuse: among the app's own (same origin) windows the focused one, else a visible one, else
 * the first. Null when there is none, in which case the caller opens a new window.
 */
export function pickAppWindow<T extends WindowCandidate>(windows: readonly T[], origin: string): T | null {
	const own = windows.filter(candidate => {
		try {
			return new URL(candidate.url).origin === origin;
		} catch {
			return false;
		}
	});
	return own.find(c => c.focused) ?? own.find(c => c.visibilityState === "visible") ?? own[0] ?? null;
}

/** The message an open page receives for a click on `route`. */
export const openMessage = (route: string): { type: typeof OPEN_MESSAGE_TYPE; url: string } => ({
	type: OPEN_MESSAGE_TYPE,
	url: route,
});

/** The route a page should show for a service-worker message, or null for any other message. */
export function routeOfOpenMessage(data: unknown): string | null {
	if (typeof data !== "object" || data === null || field(data, "type") !== OPEN_MESSAGE_TYPE) return null;
	return notificationRoute(data);
}
