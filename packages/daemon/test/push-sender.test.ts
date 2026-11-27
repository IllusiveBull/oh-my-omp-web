import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushPayload } from "@omp-web/protocol";
import { GatewayStore } from "../src/db";
import { fromBase64Url } from "../src/push/encrypt";
import { PushSender } from "../src/push/sender";
import { loadVapid, type VapidKeys } from "../src/push/vapid";
import { fakePushService, makeDevice, openRequest, type TestDevice } from "./push-helpers";

const dirs: string[] = [];
let vapid: VapidKeys;
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const ENDPOINT = "https://push.example.net/send/secret-capability-token";

const payload: PushPayload = {
	type: "notify",
	thread: "t1",
	machine: "m1",
	sessionId: "s1",
	kind: "turn_end",
	title: "box · fix the bug",
	body: "Done",
	url: "#/m/m1/s/s1",
};

let store: GatewayStore;
let device: TestDevice;
let warn: Mock<typeof console.warn>;

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	if (vapid === undefined) {
		const dir = mkdtempSync(join(tmpdir(), "ompweb-sender-"));
		dirs.push(dir);
		vapid = await loadVapid(dir);
	}
	store = GatewayStore.open(":memory:", { now: () => 5_000 });
	device = await makeDevice(ENDPOINT);
	warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	warn.mockRestore();
	store.close();
});

const subscribe = () =>
	store.addPushSubscription({
		endpoint: ENDPOINT,
		p256dh: device.keys.p256dh,
		auth: device.keys.auth,
		label: "phone",
	});

const sender = (fetchFake: typeof fetch, extra: { timeoutMs?: number } = {}) =>
	new PushSender({ vapid, subject: "mailto:ops@example.com", store, fetch: fetchFake, now: () => NOW, ...extra });

describe("PushSender", () => {
	test("posts the encrypted payload with the push headers and a VAPID authorization, and records the delivery", async () => {
		const sub = subscribe();
		const service = fakePushService(() => 201);
		const result = await sender(service.fetch).send(sub, payload, {
			ttlSeconds: 3600,
			urgency: "normal",
			topic: "t1",
		});
		expect(result).toBe("delivered");
		expect(service.requests).toHaveLength(1);
		const request = service.requests[0]!;
		expect(request.url).toBe(ENDPOINT);
		expect(request.redirect).toBe("manual");
		expect(request.headers.get("content-encoding")).toBe("aes128gcm");
		expect(request.headers.get("content-type")).toBe("application/octet-stream");
		expect(request.headers.get("ttl")).toBe("3600");
		expect(request.headers.get("urgency")).toBe("normal");
		expect(request.headers.get("topic")).toBe("t1");
		const authorization = request.headers.get("authorization")!;
		expect(authorization).toStartWith("vapid t=");
		expect(authorization).toEndWith(`, k=${vapid.publicKey}`);
		const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(authorization.split(".")[1]!)!)) as Record<
			string,
			unknown
		>;
		expect(claims).toEqual({
			aud: "https://push.example.net",
			exp: NOW / 1000 + 12 * 3600 - 300,
			sub: "mailto:ops@example.com",
		});
		expect(await openRequest(request, device)).toEqual(payload);
		expect(store.pushSubscriptions()[0]!.lastDeliveredAt).toBe(5_000);
	});

	test("the topic header is omitted when there is no topic, and 200 and 202 count as delivered", async () => {
		const sub = subscribe();
		for (const status of [200, 202]) {
			const service = fakePushService(() => status);
			expect(await sender(service.fetch).send(sub, payload, { ttlSeconds: 60, urgency: "high" })).toBe("delivered");
			expect(service.requests[0]!.headers.has("topic")).toBe(false);
			expect(service.requests[0]!.headers.get("urgency")).toBe("high");
		}
	});

	test("404 and 410 mean the subscription is dead: it is deleted", async () => {
		for (const status of [404, 410]) {
			const sub = subscribe();
			const service = fakePushService(() => status);
			expect(await sender(service.fetch).send(sub, payload, { ttlSeconds: 60, urgency: "low" })).toBe("gone");
			expect(store.pushSubscriptions()).toEqual([]);
		}
	});

	test("other statuses (including redirects) fail without touching the subscription", async () => {
		const sub = subscribe();
		for (const status of [301, 400, 401, 413, 429, 500, 503]) {
			const service = fakePushService(() => status);
			expect(await sender(service.fetch).send(sub, payload, { ttlSeconds: 60, urgency: "low" })).toBe("failed");
		}
		expect(store.pushSubscriptions()).toHaveLength(1);
		expect(store.pushSubscriptions()[0]!.lastDeliveredAt).toBeNull();
	});

	test("a network error and a timeout are failures; nothing logged names the endpoint or the keys", async () => {
		const sub = subscribe();
		const refused = (async () => {
			throw new TypeError(`connect ECONNREFUSED ${ENDPOINT}`);
		}) as unknown as typeof fetch;
		expect(await sender(refused).send(sub, payload, { ttlSeconds: 60, urgency: "low" })).toBe("failed");
		const hangs = ((_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as unknown as typeof fetch;
		expect(await sender(hangs, { timeoutMs: 20 }).send(sub, payload, { ttlSeconds: 60, urgency: "low" })).toBe(
			"failed",
		);
		await sender(fakePushService(() => 500).fetch).send(sub, payload, { ttlSeconds: 60, urgency: "low" });
		await sender(fakePushService(() => 410).fetch).send(sub, payload, { ttlSeconds: 60, urgency: "low" });
		expect(warn).toHaveBeenCalledTimes(4);
		const logged = warn.mock.calls.flat().join("\n");
		for (const secret of [
			ENDPOINT,
			"secret-capability-token",
			device.keys.p256dh,
			device.keys.auth,
			vapid.publicKey,
		]) {
			expect(logged).not.toContain(secret);
		}
	});

	test("a subscription whose keys are unusable fails instead of throwing", async () => {
		store.close();
		store = GatewayStore.open(":memory:");
		const sub = store.addPushSubscription({ endpoint: ENDPOINT, p256dh: "AAAA", auth: "AAAA", label: "broken" });
		const service = fakePushService();
		expect(await sender(service.fetch).send(sub, payload, { ttlSeconds: 60, urgency: "low" })).toBe("failed");
		expect(service.requests).toEqual([]);
	});
});
