import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttentionEvent } from "@omp-web/protocol";
import type { GatewayStore } from "../src/db";
import { PushNotifier } from "../src/push/notifier";
import { PushSender } from "../src/push/sender";
import { loadVapid, type VapidKeys } from "../src/push/vapid";
import {
	fakePushService,
	makeDevice,
	type FakePushService,
	openRequest,
	storeWithSessions,
	type TestDevice,
} from "./push-helpers";

const dirs: string[] = [];
let vapid: VapidKeys;
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let store: GatewayStore;
let threads: Record<string, string>;
let viewed: Set<string>;
let warn: Mock<typeof console.warn>;
/** Endpoint -> status the fake push service answers. */
let statuses: Map<string, number>;
let service: FakePushService;
let notifier: PushNotifier;

beforeEach(async () => {
	if (vapid === undefined) {
		const dir = mkdtempSync(join(tmpdir(), "ompweb-notifier-"));
		dirs.push(dir);
		vapid = await loadVapid(dir);
	}
	({ store, threads } = storeWithSessions(["s1", "s2"]));
	viewed = new Set();
	statuses = new Map();
	service = fakePushService(url => statuses.get(url) ?? 201);
	warn = spyOn(console, "warn").mockImplementation(() => {});
	notifier = new PushNotifier({
		store,
		sender: new PushSender({ vapid, subject: "mailto:ops@example.com", store, fetch: service.fetch }),
		isViewed: (machine, sessionId) => viewed.has(`${machine}/${sessionId}`),
		machineName: machine => (machine === "m1" ? "box" : machine),
	});
});
afterEach(() => {
	warn.mockRestore();
	store.close();
});

async function addDevice(name: string): Promise<TestDevice> {
	const device = await makeDevice(`https://push.example.net/${name}`);
	store.addPushSubscription({
		endpoint: device.endpoint,
		p256dh: device.keys.p256dh,
		auth: device.keys.auth,
		label: name,
	});
	return device;
}

const event = (overrides: Partial<AttentionEvent> = {}): AttentionEvent => ({
	sessionId: "s1",
	kind: "turn_end",
	title: "Fix the bug",
	detail: "All tests pass now.",
	...overrides,
});

const sentTo = (device: TestDevice) => service.requests.filter(r => r.url === device.endpoint);

describe("attention", () => {
	test("pushes a notification to every subscribed device, encrypted for each, and remembers who got it", async () => {
		const phone = await addDevice("phone");
		const laptop = await addDevice("laptop");
		await notifier.attention("m1", event());
		const expected = {
			type: "notify",
			thread: threads.s1,
			machine: "m1",
			sessionId: "s1",
			kind: "turn_end",
			title: "box · Fix the bug",
			body: "All tests pass now.",
			url: "#/m/m1/s/s1",
		};
		expect(sentTo(phone)).toHaveLength(1);
		expect(sentTo(laptop)).toHaveLength(1);
		expect(await openRequest(sentTo(phone)[0]!, phone)).toEqual(expected);
		expect(await openRequest(sentTo(laptop)[0]!, laptop)).toEqual(expected);
		const request = sentTo(phone)[0]!;
		expect(request.headers.get("topic")).toBe(threads.s1!);
		expect(request.headers.get("urgency")).toBe("normal");
		expect(request.headers.get("ttl")).toBe("3600");
		expect(store.takeNotified(threads.s1!).sort()).toEqual(
			store
				.pushSubscriptions()
				.map(s => s.id)
				.sort(),
		);
	});

	test("a question is urgent and lives a day; ids in the url are escaped; an empty detail gets a fixed text", async () => {
		const phone = await addDevice("phone");
		store.upsertMachine({ ...store.machines()[0]!, id: "m 2/x", name: "odd" });
		const [odd] = store.syncSessions("m 2/x", [
			{
				id: "a b",
				sessionId: "a b",
				access: "free",
				cwd: "/p",
				phase: "stored",
				createdAt: 1,
				modifiedAt: 1,
				files: 1,
				aliases: [],
			},
		]);
		await notifier.attention("m 2/x", event({ sessionId: "a b", kind: "input_needed", detail: "" }));
		const request = sentTo(phone)[0]!;
		expect(request.headers.get("urgency")).toBe("high");
		expect(request.headers.get("ttl")).toBe("86400");
		expect(await openRequest(request, phone)).toEqual({
			type: "notify",
			thread: odd!.threadId,
			machine: "m 2/x",
			sessionId: "a b",
			kind: "input_needed",
			title: "m 2/x · Fix the bug",
			body: "Waiting for your input",
			url: "#/m/m%202%2Fx/s/a%20b",
		});
		await notifier.attention("m1", event({ detail: "" }));
		expect(await openRequest(sentTo(phone)[1]!, phone)).toMatchObject({ body: "Finished" });
	});

	test("a session somebody is looking at is not notified; the same session elsewhere still is", async () => {
		const phone = await addDevice("phone");
		viewed.add("m1/s1");
		await notifier.attention("m1", event());
		expect(service.requests).toEqual([]);
		expect(store.takeNotified(threads.s1!)).toEqual([]);
		await notifier.attention("m1", event({ sessionId: "s2" }));
		expect(sentTo(phone)).toHaveLength(1);
	});

	test("an unknown session is skipped with one warning, never thrown", async () => {
		await addDevice("phone");
		await notifier.attention("m1", event({ sessionId: "ghost" }));
		await notifier.attention("m1", event({ sessionId: "ghost" }));
		expect(service.requests).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	test("a dead subscription is pruned and not remembered; a failing one is kept but not remembered; the others still get it", async () => {
		const dead = await addDevice("dead");
		const flaky = await addDevice("flaky");
		await addDevice("ok");
		statuses.set(dead.endpoint, 410);
		statuses.set(flaky.endpoint, 500);
		await notifier.attention("m1", event());
		expect(service.requests).toHaveLength(3);
		expect(store.pushSubscriptions().map(s => s.label)).toEqual(["flaky", "ok"]);
		const okId = store.pushSubscriptions().find(s => s.label === "ok")!.id;
		expect(store.takeNotified(threads.s1!)).toEqual([okId]);
	});

	test("nothing happens without subscriptions, and storage failures do not escape", async () => {
		await notifier.attention("m1", event());
		expect(service.requests).toEqual([]);
		store.close();
		await expect(notifier.attention("m1", event())).resolves.toBeUndefined();
		await expect(notifier.seen("m1", "s1")).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
	});
});

describe("seen", () => {
	test("tells the devices that were notified to close the notification, then forgets them", async () => {
		const phone = await addDevice("phone");
		const laptop = await addDevice("laptop");
		statuses.set(laptop.endpoint, 500);
		await notifier.attention("m1", event());
		service.requests.length = 0;
		await notifier.seen("m1", "s1");
		// only the device that accepted the notification has something to clear
		expect(service.requests).toHaveLength(1);
		const request = sentTo(phone)[0]!;
		expect(await openRequest(request, phone)).toEqual({ type: "clear", thread: threads.s1 });
		expect(request.headers.get("urgency")).toBe("low");
		expect(request.headers.get("ttl")).toBe("600");
		expect(request.headers.get("topic")).toBe(threads.s1!);
		await notifier.seen("m1", "s1");
		expect(service.requests).toHaveLength(1);
	});

	test("an Apple device is notified but never sent a clear (a push that shows nothing gets its subscription revoked)", async () => {
		const apple = await makeDevice("https://web.push.apple.com/abc");
		store.addPushSubscription({
			endpoint: apple.endpoint,
			p256dh: apple.keys.p256dh,
			auth: apple.keys.auth,
			label: "iphone",
		});
		const other = await addDevice("laptop");
		await notifier.attention("m1", event());
		expect(sentTo(apple)).toHaveLength(1);
		await notifier.seen("m1", "s1");
		expect(sentTo(apple)).toHaveLength(1); // no clear
		expect(sentTo(other)).toHaveLength(2); // notify + clear
	});

	test("only the thread that was read is cleared, and a thread nobody was notified of costs nothing", async () => {
		const phone = await addDevice("phone");
		await notifier.attention("m1", event());
		await notifier.attention("m1", event({ sessionId: "s2" }));
		service.requests.length = 0;
		await notifier.seen("m1", "s2");
		expect(await openRequest(service.requests[0]!, phone)).toEqual({ type: "clear", thread: threads.s2 });
		service.requests.length = 0;
		await notifier.seen("m1", "s2");
		await notifier.seen("m1", "ghost");
		expect(service.requests).toEqual([]);
		await notifier.seen("m1", "s1");
		expect(service.requests).toHaveLength(1);
	});

	test("a device that unsubscribed in the meantime is not contacted", async () => {
		const phone = await addDevice("phone");
		await notifier.attention("m1", event());
		store.deletePushSubscription(store.pushSubscriptions()[0]!.id);
		service.requests.length = 0;
		await notifier.seen("m1", "s1");
		expect(sentTo(phone)).toEqual([]);
	});
});

describe("test", () => {
	test("sends only the chosen device a test notification that is urgent and short-lived, and reports the outcome", async () => {
		const phone = await addDevice("phone");
		const laptop = await addDevice("laptop");
		const [phoneId, laptopId] = store.pushSubscriptions().map(s => s.id);
		expect(await notifier.test(phoneId!)).toBe("delivered");
		expect(sentTo(laptop)).toEqual([]);
		const request = sentTo(phone)[0]!;
		expect(await openRequest(request, phone)).toEqual({ type: "test", title: "omp-web", body: expect.any(String) });
		expect(request.headers.get("urgency")).toBe("high");
		expect(request.headers.get("ttl")).toBe("60");
		// a test is not a thread: nothing to clear later
		expect(store.takeNotified(threads.s1!)).toEqual([]);
		statuses.set(laptop.endpoint, 410);
		expect(await notifier.test(laptopId!)).toBe("gone");
		expect(await notifier.test("ghost")).toBe("unknown");
	});
});
