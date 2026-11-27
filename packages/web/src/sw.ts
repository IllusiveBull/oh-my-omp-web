// App-shell service worker and Web Push receiver. __SW_VERSION__ / __SW_PRECACHE__ are injected by scripts/build.ts.
// What a push or a click means is decided in lib/push-message.ts (unit-tested); this file only wires it to the browser.
import {
	notificationRoute,
	notificationsOfThread,
	openMessage,
	pickAppWindow,
	planPush,
	type WindowCandidate,
} from "./lib/push-message";

declare const __SW_VERSION__: string;
declare const __SW_PRECACHE__: string[];

interface SwWindowClient extends WindowCandidate {
	focus(): Promise<unknown>;
	postMessage(message: unknown): void;
}
interface SwNotification {
	tag: string;
	data: unknown;
	close(): void;
}
interface SwScope {
	skipWaiting(): Promise<void>;
	clients: {
		claim(): Promise<void>;
		matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<SwWindowClient[]>;
		openWindow(url: string): Promise<unknown>;
	};
	registration: {
		showNotification(title: string, options: object): Promise<void>;
		getNotifications(): Promise<SwNotification[]>;
	};
	addEventListener(type: "install" | "activate", cb: (e: SwExtendable) => void): void;
	addEventListener(type: "fetch", cb: (e: SwFetchEvent) => void): void;
	addEventListener(type: "push", cb: (e: SwPushEvent) => void): void;
	addEventListener(type: "notificationclick", cb: (e: SwNotificationClickEvent) => void): void;
}
interface SwExtendable extends Event {
	waitUntil(p: Promise<unknown>): void;
}
interface SwFetchEvent extends SwExtendable {
	request: Request;
	respondWith(r: Promise<Response> | Response): void;
}
interface SwPushEvent extends SwExtendable {
	data: { text(): string } | null;
}
interface SwNotificationClickEvent extends SwExtendable {
	notification: SwNotification;
}

const sw = self as unknown as SwScope;
const CACHE = `omp-web-shell-${__SW_VERSION__}`;
// Gateway routes that must never be intercepted: the WebSocket upgrade, the HTTP API, and the login page (served
// without a session and never part of the shell).
const BYPASS = ["/ws", "/api/", "/login/"];

// skipWaiting + clients.claim: a new build takes over immediately; main.tsx reloads the page on controllerchange.
sw.addEventListener("install", e => {
	e.waitUntil(
		caches
			.open(CACHE)
			.then(c => c.addAll(__SW_PRECACHE__))
			.then(() => sw.skipWaiting()),
	);
});

sw.addEventListener("activate", e => {
	e.waitUntil(
		caches
			.keys()
			.then(keys =>
				Promise.all(keys.filter(k => k.startsWith("omp-web-shell-") && k !== CACHE).map(k => caches.delete(k))),
			)
			.then(() => sw.clients.claim()),
	);
});

sw.addEventListener("fetch", e => {
	const { request } = e;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== location.origin) return;
	if (BYPASS.some(p => url.pathname === p.replace(/\/$/, "") || url.pathname.startsWith(p))) return;
	if (request.headers.get("upgrade")) return;

	if (request.mode === "navigate") {
		// Network-first; offline falls back to the cached shell.
		e.respondWith(
			fetch(request)
				.then(res => {
					if (res.ok && url.pathname === "/") {
						const copy = res.clone(); // before the page consumes the body
						void caches.open(CACHE).then(c => c.put("/", copy));
					}
					return res;
				})
				.catch(async () => (await caches.match("/")) ?? Response.error()),
		);
		return;
	}
	// Hashed assets and icons are precached and immutable per build: cache-first, network for the rest.
	e.respondWith(caches.match(request).then(hit => hit ?? fetch(request)));
});

// A `notify` shows (or replaces, by thread tag) a notification; a `clear` closes the thread's notifications and shows
// nothing. Malformed or unknown messages are dropped.
sw.addEventListener("push", e => {
	const plan = planPush(e.data?.text() ?? null);
	if (plan.action === "show") e.waitUntil(sw.registration.showNotification(plan.title, plan.options));
	else if (plan.action === "clear") {
		e.waitUntil(
			sw.registration.getNotifications().then(open => {
				for (const notification of notificationsOfThread(plan.thread, open)) notification.close();
			}),
		);
	}
});

// Focus an existing app window and have it route to the session (it may be on another route), else open one.
sw.addEventListener("notificationclick", e => {
	e.notification.close();
	const route = notificationRoute(e.notification.data);
	if (route === null) return;
	e.waitUntil(
		sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async windows => {
			const app = pickAppWindow(windows, location.origin);
			if (!app) {
				await sw.clients.openWindow(`/${route}`);
				return;
			}
			await app.focus();
			app.postMessage(openMessage(route));
		}),
	);
});
