import { describe, expect, test } from "bun:test";
import {
	notificationRoute,
	notificationsOfThread,
	openMessage,
	pickAppWindow,
	planPush,
	TEST_TAG,
	routeOfOpenMessage,
} from "../src/lib/push-message";

const notify = {
	type: "notify",
	thread: "t1",
	machine: "m1",
	sessionId: "s1",
	kind: "turn_end",
	title: "Fix the build",
	body: "All tests pass now",
	url: "#/m/m1/s/s1",
};

describe("planPush", () => {
	test("a notify shows the title with the body, tagged by thread so a newer one replaces it, carrying the route", () => {
		expect(planPush(JSON.stringify(notify))).toEqual({
			action: "show",
			title: "Fix the build",
			options: { body: "All tests pass now", tag: "t1", renotify: true, data: { url: "#/m/m1/s/s1" } },
		});
		expect(planPush(JSON.stringify({ ...notify, kind: "input_needed" })).action).toBe("show");
	});

	test("a clear names the thread and shows nothing", () => {
		expect(planPush(JSON.stringify({ type: "clear", thread: "t1" }))).toEqual({ action: "clear", thread: "t1" });
	});

	test("a test shows under its own tag, so it never replaces a session's notification, and opens nothing", () => {
		const plan = planPush(JSON.stringify({ type: "test", title: "omp-web", body: "hi" }));
		expect(plan).toEqual({
			action: "show",
			title: "omp-web",
			options: { body: "hi", tag: TEST_TAG, renotify: true, data: {} },
		});
		expect(notificationRoute(plan.action === "show" ? plan.options.data : null)).toBeNull();
	});

	test("anything malformed, unknown or without data is ignored and never throws", () => {
		const ignored = [
			null,
			"",
			"not json",
			"null",
			"[]",
			"42",
			JSON.stringify({ type: "weird", thread: "t1" }),
			JSON.stringify({ thread: "t1" }),
			JSON.stringify({ type: "clear" }),
			JSON.stringify({ type: "clear", thread: "" }),
			JSON.stringify({ type: "clear", thread: 5 }),
			JSON.stringify({ type: "test", title: "omp-web" }),
			JSON.stringify({ type: "test", body: "hi", title: 1 }),
			JSON.stringify({ ...notify, thread: undefined }),
			JSON.stringify({ ...notify, kind: "boom" }),
			JSON.stringify({ ...notify, title: 5 }),
			JSON.stringify({ ...notify, body: null }),
			JSON.stringify({ ...notify, machine: 1 }),
			JSON.stringify({ ...notify, url: undefined }),
			JSON.stringify({ ...notify, url: "https://evil.example/" }),
			JSON.stringify({ ...notify, url: "#/settings" }),
			JSON.stringify({ ...notify, url: "javascript:alert(1)" }),
		];
		for (const text of ignored) expect(planPush(text)).toEqual({ action: "ignore" });
	});
});

describe("notificationsOfThread", () => {
	test("selects exactly the notifications tagged with the thread", () => {
		const open = [
			{ tag: "t1", id: 1 },
			{ tag: "t2", id: 2 },
			{ tag: "t1", id: 3 },
			{ tag: "", id: 4 },
		];
		expect(notificationsOfThread("t1", open).map(n => n.id)).toEqual([1, 3]);
		expect(notificationsOfThread("none", open)).toEqual([]);
	});
});

describe("notification clicks", () => {
	test("the route comes from the notification data and must be a session route", () => {
		expect(notificationRoute({ url: "#/m/m1/s/s1" })).toBe("#/m/m1/s/s1");
		for (const data of [null, undefined, "x", {}, { url: 3 }, { url: "#/other" }, { url: "/m/m1/s/s1" }]) {
			expect(notificationRoute(data)).toBeNull();
		}
	});

	test("an own window is reused: focused first, then visible, then any; other origins and bad urls never", () => {
		const origin = "https://gw.example";
		const window = (url: string, focused: boolean, visibilityState: string) => ({ url, focused, visibilityState });
		const hidden = window(`${origin}/`, false, "hidden");
		const visible = window(`${origin}/#/m/a/s/b`, false, "visible");
		const focused = window(`${origin}/#/m/c/s/d`, true, "visible");
		const foreign = window("https://other.example/", true, "visible");
		const broken = window("not a url", true, "visible");

		expect(pickAppWindow([hidden, visible, focused], origin)).toBe(focused);
		expect(pickAppWindow([hidden, visible], origin)).toBe(visible);
		expect(pickAppWindow([hidden], origin)).toBe(hidden);
		expect(pickAppWindow([foreign, broken], origin)).toBeNull();
		expect(pickAppWindow([], origin)).toBeNull();
	});

	test("the page-side route of an open message is validated like the notification's", () => {
		expect(openMessage("#/m/m1/s/s1")).toEqual({ type: "omp-open", url: "#/m/m1/s/s1" });
		expect(routeOfOpenMessage(openMessage("#/m/m1/s/s1"))).toBe("#/m/m1/s/s1");
		for (const data of [
			null,
			"omp-open",
			{},
			{ type: "other", url: "#/m/m1/s/s1" },
			{ type: "omp-open" },
			{ type: "omp-open", url: "#/x" },
		]) {
			expect(routeOfOpenMessage(data)).toBeNull();
		}
	});
});
