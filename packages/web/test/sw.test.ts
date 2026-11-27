/**
 * The service worker script itself, run against a fake worker scope: that it wires push and notificationclick to the
 * decisions of lib/push-message.ts, and that the shell caching listeners are still registered next to them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

interface Notification {
	tag: string;
	data: unknown;
	closed: boolean;
	close(): void;
}

const notification = (tag: string, data: unknown = undefined): Notification => ({
	tag,
	data,
	closed: false,
	close() {
		this.closed = true;
	},
});

interface Window {
	url: string;
	focused: boolean;
	visibilityState: string;
	focusCalls: number;
	messages: unknown[];
	focus(): Promise<void>;
	postMessage(message: unknown): void;
}

const windowAt = (url: string, focused = false, visibilityState = "visible"): Window => ({
	url,
	focused,
	visibilityState,
	focusCalls: 0,
	messages: [],
	async focus() {
		this.focusCalls++;
	},
	postMessage(message) {
		this.messages.push(message);
	},
});

type Handler = (event: unknown) => void;

const handlers = new Map<string, Handler>();
const shown: { title: string; options: object }[] = [];
let open: Notification[] = [];
let windows: Window[] = [];
const opened: string[] = [];

const scope = {
	skipWaiting: async () => {},
	clients: {
		claim: async () => {},
		matchAll: async () => windows,
		openWindow: async (url: string) => {
			opened.push(url);
		},
	},
	registration: {
		showNotification: async (title: string, options: object) => {
			shown.push({ title, options });
		},
		getNotifications: async () => open,
	},
	addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
};

const GLOBALS = ["self", "location", "__SW_VERSION__", "__SW_PRECACHE__"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(async () => {
	const target = globalThis as Record<string, unknown>;
	for (const key of GLOBALS) saved.set(key, Object.getOwnPropertyDescriptor(target, key));
	const define = (key: string, value: unknown): void => {
		Object.defineProperty(target, key, { value, configurable: true, writable: true });
	};
	define("self", scope);
	define("location", { origin: "https://gw.example" });
	define("__SW_VERSION__", "test");
	define("__SW_PRECACHE__", []);
	// Dynamic on purpose: the worker script registers its listeners when it loads, so it must load after the fake scope.
	await import("../src/sw");
});

afterAll(() => {
	const target = globalThis as Record<string, unknown>;
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(target, key, descriptor);
		else delete target[key];
	}
});

/** Dispatches an event to the worker's handler and resolves what it handed to `waitUntil`. */
async function dispatch(type: string, event: object): Promise<number> {
	const waits: Promise<unknown>[] = [];
	const handler = handlers.get(type);
	if (!handler) throw new Error(`no ${type} listener`);
	handler({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
	await Promise.all(waits);
	return waits.length;
}

const pushData = (body: unknown): { data: { text: () => string } } => ({
	data: { text: () => (typeof body === "string" ? body : JSON.stringify(body)) },
});

const notify = {
	type: "notify",
	thread: "t1",
	machine: "m1",
	sessionId: "s1",
	kind: "input_needed",
	title: "Deploy?",
	body: "Confirm the deploy",
	url: "#/m/m1/s/s1",
};

describe("service worker", () => {
	test("keeps the shell caching and update listeners and adds push and notificationclick", () => {
		for (const type of ["install", "activate", "fetch", "push", "notificationclick"]) {
			expect(handlers.has(type)).toBe(true);
		}
	});

	test("a notify push shows a notification tagged by thread", async () => {
		shown.length = 0;
		expect(await dispatch("push", pushData(notify))).toBe(1);
		expect(shown).toEqual([
			{
				title: "Deploy?",
				options: { body: "Confirm the deploy", tag: "t1", renotify: true, data: { url: "#/m/m1/s/s1" } },
			},
		]);
	});

	test("a clear push closes the notifications of that thread only and shows nothing", async () => {
		shown.length = 0;
		open = [notification("t1"), notification("t2"), notification("t1")];
		expect(await dispatch("push", pushData({ type: "clear", thread: "t1" }))).toBe(1);
		expect(open.map(n => n.closed)).toEqual([true, false, true]);
		expect(shown).toEqual([]);
	});

	test("malformed pushes, unknown types and pushes without data do nothing", async () => {
		shown.length = 0;
		open = [notification("t1")];
		for (const event of [
			pushData("not json"),
			pushData({ type: "other" }),
			pushData({ ...notify, url: "https://evil" }),
			{ data: null },
		]) {
			expect(await dispatch("push", event)).toBe(0);
		}
		expect(shown).toEqual([]);
		expect(open[0]!.closed).toBe(false);
	});

	test("a click closes the notification, focuses the app window and tells it which session to open", async () => {
		const elsewhere = windowAt("https://other.example/", true);
		const app = windowAt("https://gw.example/#/m/m2/s/other"); // on another route
		windows = [elsewhere, app];
		opened.length = 0;
		const clicked = notification("t1", { url: "#/m/m1/s/s1" });
		expect(await dispatch("notificationclick", { notification: clicked })).toBe(1);
		expect(clicked.closed).toBe(true);
		expect(app.focusCalls).toBe(1);
		expect(app.messages).toEqual([{ type: "omp-open", url: "#/m/m1/s/s1" }]);
		expect(elsewhere.focusCalls).toBe(0);
		expect(elsewhere.messages).toEqual([]);
		expect(opened).toEqual([]);
	});

	test("a click with no app window open starts one at the session's route", async () => {
		windows = [windowAt("https://other.example/")];
		opened.length = 0;
		await dispatch("notificationclick", { notification: notification("t1", { url: "#/m/m1/s/s1" }) });
		expect(opened).toEqual(["/#/m/m1/s/s1"]);
	});

	test("a click on a notification without a valid route only closes it", async () => {
		const app = windowAt("https://gw.example/");
		windows = [app];
		opened.length = 0;
		const clicked = notification("t1", { url: "https://evil.example/" });
		expect(await dispatch("notificationclick", { notification: clicked })).toBe(0);
		expect(clicked.closed).toBe(true);
		expect(app.focusCalls).toBe(0);
		expect(opened).toEqual([]);
	});

	test("a navigation to / stores a copy of the shell taken before the page reads the response body", async () => {
		const target = globalThis as Record<string, unknown>;
		const original = { fetch: target.fetch, caches: target.caches };
		const stored = new Map<string, Response>();
		target.fetch = async () => new Response("<html>shell</html>", { status: 200 });
		// opening the cache takes a moment, as it does in a browser: by then the page has read the body
		target.caches = {
			open: async () => {
				await Bun.sleep(5);
				return { put: async (key: string, res: Response) => void stored.set(key, res) };
			},
		};
		try {
			let answer: Promise<Response> | undefined;
			handlers.get("fetch")!({
				request: { method: "GET", url: "https://gw.example/", mode: "navigate", headers: new Headers() },
				respondWith: (res: Promise<Response>) => (answer = res),
			});
			expect(await (await answer!).text()).toBe("<html>shell</html>"); // the page consumes the body first
			await Bun.sleep(30);
			expect(await stored.get("/")?.text()).toBe("<html>shell</html>");
		} finally {
			target.fetch = original.fetch;
			target.caches = original.caches;
		}
	});
});
