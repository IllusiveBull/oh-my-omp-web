import {
	PUSH_KEY_API,
	PUSH_SUBSCRIPTIONS_API,
	type PushSubscribeRequest,
	type PushSubscriptionInfo,
} from "@omp-web/protocol";
import { field } from "./json";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The parts of `PushSubscription` this module uses. */
export interface PushSubscriptionLike {
	endpoint: string;
	toJSON(): { endpoint?: string; keys?: Record<string, string> };
	unsubscribe(): Promise<boolean>;
}

/** The parts of `ServiceWorkerRegistration` this module uses. */
export interface PushRegistrationLike {
	pushManager: {
		getSubscription(): Promise<PushSubscriptionLike | null>;
		subscribe(options: {
			userVisibleOnly: boolean;
			applicationServerKey: Uint8Array<ArrayBuffer>;
		}): Promise<PushSubscriptionLike>;
	};
}

/** What the browser provides, as a seam: the real one is {@link detectBrowser}. */
export interface PushBrowser {
	/** `isSecureContext`: push needs https (or localhost). */
	secure: boolean;
	/** iPhone / iPad, where Web Push exists only for a PWA added to the Home Screen. */
	ios: boolean;
	userAgent: string;
	/** `Notification`; null when missing. */
	notification: {
		readonly permission: NotificationPermission;
		requestPermission(): Promise<NotificationPermission>;
	} | null;
	/** Resolves the active service worker registration; null when service workers or `PushManager` are missing. */
	registration: (() => Promise<PushRegistrationLike>) | null;
}

export interface PushDeps {
	browser: PushBrowser;
	fetch: Fetch;
	/** Lower-case hex SHA-256 of the text's UTF-8 bytes. */
	sha256Hex: (text: string) => Promise<string>;
}

/** `unsupported`: this context cannot receive pushes; `denied`: the user blocked notifications; `on`: this device is subscribed. */
export type PushState = "unsupported" | "denied" | "off" | "on";

export interface PushSnapshot {
	/** False until the first inspection finished (nothing is known about the state before). */
	ready: boolean;
	state: PushState;
	/** Why the state is `unsupported` or `denied`. */
	reason: string | null;
	/** A request is in flight: the controls are inert. */
	busy: boolean;
	error: string | null;
	/** The outcome of the last action when it is worth saying (a test that was sent); cleared by the next action. */
	notice: string | null;
	devices: readonly PushSubscriptionInfo[];
	/** `endpointHash` of this browser's own subscription; null when it has none. */
	self: string | null;
	/** What a device is called when the user types nothing. */
	defaultLabel: string;
}

/** An error whose message is meant for the user as it is. */
export class PushError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "PushError";
	}
}

/** The gateway rejects longer labels. */
export const LABEL_MAX = 80;
const READY_TIMEOUT_MS = 10_000;
const DENIED_REASON =
	"Notifications are blocked for this site. Allow them in the browser's site settings, then reload the page.";

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Decodes base64url (what `applicationServerKey` is published as) into bytes. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
	const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** A short "Chrome on macOS" style description of this browser, used when the user does not name the device. */
export function defaultDeviceLabel(userAgent: string): string {
	const browser = /Edg(?:e|A|iOS)?\//.test(userAgent)
		? "Edge"
		: /OPR\/|Opera/.test(userAgent)
			? "Opera"
			: /Firefox\/|FxiOS\//.test(userAgent)
				? "Firefox"
				: /Chrome\/|CriOS\//.test(userAgent)
					? "Chrome"
					: /Safari\//.test(userAgent)
						? "Safari"
						: null;
	const platform = /iPhone/.test(userAgent)
		? "iPhone"
		: /iPad/.test(userAgent)
			? "iPad"
			: /Android/.test(userAgent)
				? "Android"
				: /Windows/.test(userAgent)
					? "Windows"
					: /Mac OS X|Macintosh/.test(userAgent)
						? "macOS"
						: /CrOS/.test(userAgent)
							? "ChromeOS"
							: /Linux|X11/.test(userAgent)
								? "Linux"
								: null;
	if (browser && platform) return `${browser} on ${platform}`;
	return browser ?? platform ?? "device";
}

/** Why this browser/context cannot receive pushes; null when it can. */
export function unsupportedReason(browser: PushBrowser): string | null {
	const missing = browser.notification === null || browser.registration === null;
	if (browser.secure && !missing) return null;
	const reasons: string[] = [];
	if (!browser.secure) {
		reasons.push(
			"Push notifications need a secure connection (https, or localhost), and this page is served over plain http.",
		);
	}
	if (missing && browser.secure) reasons.push("This browser does not support Web Push.");
	if (browser.ios) {
		reasons.push(
			"On iPhone and iPad, Web Push only works for the app added to the Home Screen: in Safari tap Share, then Add to Home Screen, and open omp-web from there.",
		);
	}
	return reasons.join(" ");
}

/** The user-facing message for anything the controller can fail with. */
export function describePushError(error: unknown): string {
	if (error instanceof PushError) return error.message;
	if (error instanceof Error) {
		switch (error.name) {
			case "NotAllowedError":
				return "The browser refused: notifications are blocked for this site.";
			case "AbortError":
				return "The browser's push service could not be reached. Check the connection (Chrome also needs Google services) and try again.";
			case "InvalidStateError":
				return "The browser already holds a push subscription made with a different key. Turn notifications off for this site in the browser settings and try again.";
			case "NotSupportedError":
				return "This browser does not support Web Push.";
			case "SecurityError":
				return "The browser refused push on this connection (it needs https, or localhost).";
			case "TypeError":
				return "Could not reach the gateway.";
			default:
				return error.message || error.name;
		}
	}
	return "Unexpected error.";
}

async function httpError(res: Response): Promise<PushError> {
	if (res.status === 401) return new PushError("Your session expired. Reload the page to sign in again.", 401);
	const text = (await res.text().catch(() => "")).trim().slice(0, 200);
	return new PushError(`The gateway answered ${res.status}${text ? `: ${text}` : ""}.`, res.status);
}

function parseInfo(value: unknown): PushSubscriptionInfo {
	if (typeof value === "object" && value !== null) {
		const id = field(value, "id");
		const label = field(value, "label");
		const endpointHash = field(value, "endpointHash");
		const createdAt = field(value, "createdAt");
		const lastDeliveredAt = field(value, "lastDeliveredAt");
		if (
			typeof id === "string" &&
			typeof label === "string" &&
			typeof endpointHash === "string" &&
			typeof createdAt === "number" &&
			(typeof lastDeliveredAt === "number" || lastDeliveredAt === null)
		) {
			return { id, label, endpointHash, createdAt, lastDeliveredAt };
		}
	}
	throw new PushError("The gateway sent a device list this page does not understand.");
}

/** The `POST /api/push/subscriptions` body for a browser subscription. */
export function subscribeRequest(subscription: PushSubscriptionLike, label: string): PushSubscribeRequest {
	const json = subscription.toJSON();
	const endpoint = json.endpoint ?? subscription.endpoint;
	const p256dh = json.keys?.p256dh;
	const auth = json.keys?.auth;
	if (!endpoint || !p256dh || !auth) throw new PushError("The browser returned an incomplete push subscription.");
	return { endpoint, keys: { p256dh, auth }, label };
}

/**
 * State and actions of the notification settings: whether this device can and does receive pushes, the gateway's
 * device list, and enable / disable / revoke. Every action is an explicit user request; nothing here subscribes or
 * prompts on its own. Exposes a `useSyncExternalStore` pair; all browser and network access goes through `deps`.
 */
export class PushSettings {
	#snapshot: PushSnapshot;
	#listeners = new Set<() => void>();
	/** The gateway's VAPID key and this page's registration, as of the last `#load()`; see `#enable()` for why. */
	#key: string | null = null;
	#registrationCache: PushRegistrationLike | null = null;

	constructor(private readonly deps: PushDeps) {
		this.#snapshot = {
			ready: false,
			state: "off",
			reason: null,
			busy: false,
			error: null,
			notice: null,
			devices: [],
			self: null,
			defaultLabel: defaultDeviceLabel(deps.browser.userAgent),
		};
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): PushSnapshot => this.#snapshot;

	/** Inspects this browser and loads the device list. */
	refresh(): Promise<void> {
		return this.#run(() => this.#load());
	}

	/**
	 * Asks for permission, subscribes this browser and registers it with the gateway. Must run in a click handler: the
	 * permission prompt is the first thing it does, before anything is awaited.
	 */
	enable(label: string): Promise<void> {
		return this.#run(() => this.#enable(label));
	}

	/** Removes this device from the gateway, then unsubscribes the browser. */
	disable(): Promise<void> {
		return this.#run(async () => {
			const registration = await this.#registration();
			const subscription = await registration.pushManager.getSubscription();
			if (subscription) {
				const hash = await this.deps.sha256Hex(subscription.endpoint);
				const own = (await this.#listDevices()).find(device => device.endpointHash === hash);
				if (own) await this.#delete(own.id);
				await subscription.unsubscribe();
			}
			await this.#load();
		});
	}

	/** Revokes a device of the list; when it is this browser, also unsubscribes it. */
	revoke(id: string): Promise<void> {
		return this.#run(async () => {
			const device = this.#snapshot.devices.find(d => d.id === id);
			await this.#delete(id);
			if (device !== undefined && device.endpointHash === this.#snapshot.self) {
				const subscription = await (await this.#registration()).pushManager.getSubscription();
				await subscription?.unsubscribe();
			}
			await this.#load();
		});
	}

	/** Asks the gateway to push a test notification to this device, through the same path a real one takes. */
	sendTest(): Promise<void> {
		return this.#run(async () => {
			const own = this.#snapshot.devices.find(device => device.endpointHash === this.#snapshot.self);
			if (own === undefined) throw new PushError("This device is not registered; switch push on first.");
			const path = `${PUSH_SUBSCRIPTIONS_API}/${encodeURIComponent(own.id)}/test`;
			const res = await this.#call(path, { method: "POST" }, [404, 410, 502]);
			if (res.ok) {
				this.#set({
					notice: "Sent. If nothing shows up, check that the system allows notifications from this browser.",
				});
				return;
			}
			if (res.status === 502)
				throw new PushError("The push service did not accept the test. Try again in a moment.");
			// 404 / 410: the gateway no longer has this device, so it is off now.
			await this.#load();
			throw new PushError("The push service no longer knows this device. Switch push on again.");
		});
	}

	async #run(task: () => Promise<void>): Promise<void> {
		this.#set({ busy: true, error: null, notice: null });
		try {
			await task();
		} catch (error) {
			this.#set({ error: describePushError(error) });
		} finally {
			this.#set({ busy: false });
		}
	}

	async #enable(label: string): Promise<void> {
		const { browser } = this.deps;
		if (this.#snapshot.state === "unsupported" || browser.notification === null || browser.registration === null) {
			throw new PushError(this.#snapshot.reason ?? "This browser does not support Web Push.");
		}
		// Safari only lets `subscribe()` run inside the click's user gesture, which an awaited network request ends. With
		// permission already granted (turning push back on) nothing may be awaited before it, so the key and the
		// registration come from the last `#load()`; the first time, the permission prompt is what is awaited.
		const permission =
			browser.notification.permission === "granted" ? "granted" : await browser.notification.requestPermission();
		if (permission === "denied") {
			this.#set({ state: "denied", reason: DENIED_REASON });
			throw new PushError(DENIED_REASON);
		}
		if (permission !== "granted") throw new PushError("Notification permission was not granted.");
		const key = this.#key ?? (await this.#publicKey());
		const registration = this.#registrationCache ?? (await browser.registration());
		const subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: base64UrlToBytes(key),
		});
		const name = label.trim().slice(0, LABEL_MAX) || this.#snapshot.defaultLabel;
		await this.#call(PUSH_SUBSCRIPTIONS_API, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(subscribeRequest(subscription, name)),
		});
		await this.#load();
	}

	async #load(): Promise<void> {
		const { browser } = this.deps;
		const unsupported = unsupportedReason(browser);
		let subscription: PushSubscriptionLike | null = null;
		if (unsupported === null && browser.registration !== null) {
			this.#registrationCache = await browser.registration();
			subscription = await this.#registrationCache.pushManager.getSubscription();
			// Fetched ahead for `#enable()`, which must not wait on the network; a failure is reported when enabling.
			this.#key ??= await this.#publicKey().catch(() => null);
		}
		const self = subscription ? await this.deps.sha256Hex(subscription.endpoint) : null;
		let devices = this.#snapshot.devices;
		let listFailure: unknown = null;
		try {
			devices = await this.#listDevices();
		} catch (error) {
			listFailure = error;
		}
		// A local subscription the gateway no longer lists (revoked elsewhere) delivers nothing: it counts as off, and
		// enabling again re-registers the same subscription.
		const registered = listFailure !== null || devices.some(device => device.endpointHash === self);
		const permission = browser.notification?.permission;
		const state: PushState =
			unsupported !== null
				? "unsupported"
				: permission === "denied"
					? "denied"
					: self !== null && registered
						? "on"
						: "off";
		this.#set({
			ready: true,
			state,
			reason: state === "unsupported" ? unsupported : state === "denied" ? DENIED_REASON : null,
			devices,
			self,
		});
		if (listFailure !== null) throw listFailure;
	}

	async #registration(): Promise<PushRegistrationLike> {
		const { registration } = this.deps.browser;
		if (registration === null)
			throw new PushError(this.#snapshot.reason ?? "This browser does not support Web Push.");
		return registration();
	}

	async #publicKey(): Promise<string> {
		const res = await this.#call(PUSH_KEY_API);
		const body: unknown = await res.json().catch(() => null);
		const key = typeof body === "object" && body !== null ? field(body, "publicKey") : null;
		if (typeof key === "string" && key) return key;
		throw new PushError("The gateway did not send its push key.");
	}

	async #listDevices(): Promise<PushSubscriptionInfo[]> {
		const body: unknown = await (await this.#call(PUSH_SUBSCRIPTIONS_API)).json().catch(() => null);
		if (!Array.isArray(body)) throw new PushError("The gateway sent a device list this page does not understand.");
		return body.map(parseInfo);
	}

	/** Revokes on the gateway; a device it no longer knows is as good as revoked. */
	async #delete(id: string): Promise<void> {
		await this.#call(`${PUSH_SUBSCRIPTIONS_API}/${encodeURIComponent(id)}`, { method: "DELETE" }, [404]);
	}

	async #call(path: string, init: RequestInit = {}, tolerate: readonly number[] = []): Promise<Response> {
		const res = await this.deps.fetch(path, { credentials: "same-origin", ...init });
		if (!res.ok && !tolerate.includes(res.status)) throw await httpError(res);
		return res;
	}

	#set(patch: Partial<PushSnapshot>): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
		for (const listener of this.#listeners) listener();
	}
}

/** The real browser, as far as it goes: every missing API is reported as missing rather than assumed. */
export function detectBrowser(): PushBrowser {
	const nav = typeof navigator === "undefined" ? undefined : navigator;
	const userAgent = nav?.userAgent ?? "";
	const hasPush = typeof window !== "undefined" && "PushManager" in window;
	const container = nav !== undefined && "serviceWorker" in nav ? nav.serviceWorker : undefined;
	return {
		secure: typeof window !== "undefined" && window.isSecureContext,
		ios: /iPad|iPhone|iPod/.test(userAgent) || (nav?.platform === "MacIntel" && nav.maxTouchPoints > 1),
		userAgent,
		notification: typeof Notification === "undefined" ? null : Notification,
		registration: hasPush && container ? () => activeRegistration(container) : null,
	};
}

/** `serviceWorker.ready` never settles when the worker failed to register: give up after a while. */
function activeRegistration(container: ServiceWorkerContainer): Promise<ServiceWorkerRegistration> {
	const { promise, resolve, reject } = Promise.withResolvers<ServiceWorkerRegistration>();
	const timer = setTimeout(
		() => reject(new PushError("The service worker is not active. Reload the page and try again.")),
		READY_TIMEOUT_MS,
	);
	container.ready.then(resolve, reject).finally(() => clearTimeout(timer));
	return promise;
}

export function browserPushDeps(): PushDeps {
	return { browser: detectBrowser(), fetch: (input, init) => fetch(input, init), sha256Hex };
}
