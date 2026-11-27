import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { PushSubscriptionInfo } from "@omp-web/protocol";
import { Harness, makeRepo } from "./gateway-harness";
import { makeDevice, subscribeBody, type TestDevice } from "./push-helpers";

const KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";

let repo: string;
let h: Harness;
let cookie: string;
let device: TestDevice;
/** What the fake notifier answers for a test push, per subscription id; unlisted ids are unknown. */
let testResults: Map<string, "delivered" | "gone" | "failed">;
let tested: string[];

beforeAll(async () => {
	repo = await makeRepo();
});
afterAll(() => rmSync(dirname(repo), { recursive: true, force: true }));
beforeEach(async () => {
	testResults = new Map();
	tested = [];
	h = await Harness.start({
		repo,
		push: {
			publicKey: KEY,
			test: async id => {
				tested.push(id);
				return testResults.get(id) ?? "unknown";
			},
		},
	});
	cookie = await h.login();
	device = await makeDevice("https://push.example.net/send/capability-token-1");
});
afterEach(async () => {
	await h.stop();
});

/** The body of a response whose shape the test knows. */
const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const api = (path: string, init: RequestInit & { cookie?: string | null } = {}): Promise<Response> => {
	const { cookie: override, headers, ...rest } = init;
	const auth = override === undefined ? cookie : override;
	return fetch(`${h.http}${path}`, { ...rest, headers: { ...(auth === null ? {} : { cookie: auth }), ...headers } });
};

const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
	api("/api/push/subscriptions", {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
		headers,
	});

describe("GET /api/push/key", () => {
	test("returns the VAPID public key", async () => {
		const res = await api("/api/push/key");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ publicKey: KEY });
	});
});

describe("authentication and origin", () => {
	test("without a valid session every push route is 401", async () => {
		const id = h.store.addPushSubscription({
			endpoint: device.endpoint,
			p256dh: device.keys.p256dh,
			auth: device.keys.auth,
			label: "x",
		}).id;
		for (const [method, path] of [
			["GET", "/api/push/key"],
			["GET", "/api/push/subscriptions"],
			["POST", "/api/push/subscriptions"],
			["DELETE", `/api/push/subscriptions/${id}`],
			["POST", `/api/push/subscriptions/${id}/test`],
		] as const) {
			for (const credential of [null, "omp_web_session=garbage"]) {
				const res = await api(path, {
					method,
					cookie: credential,
					body: method === "POST" ? JSON.stringify(subscribeBody(device)) : undefined,
				});
				expect(res.status).toBe(401);
				expect(await res.json()).toEqual({ error: "unauthorized" });
			}
		}
		expect(h.store.pushSubscriptions()).toHaveLength(1);
		expect(tested).toEqual([]);
	});

	test("POST and DELETE from another origin are refused; the same origin and non-browser clients are fine", async () => {
		const evil = { origin: "https://evil.example" };
		expect((await post(subscribeBody(device), evil)).status).toBe(403);
		expect(h.store.pushSubscriptions()).toEqual([]);
		expect((await post(subscribeBody(device), { origin: h.http })).status).toBe(201);
		const id = h.store.pushSubscriptions()[0]!.id;
		expect((await api(`/api/push/subscriptions/${id}`, { method: "DELETE", headers: evil })).status).toBe(403);
		expect(h.store.pushSubscriptions()).toHaveLength(1);
		expect(
			(await api(`/api/push/subscriptions/${id}`, { method: "DELETE", headers: { origin: h.http } })).status,
		).toBe(204);
	});

	test("a test push from another origin is refused before anything is sent", async () => {
		testResults.set("a", "delivered");
		const res = await api("/api/push/subscriptions/a/test", {
			method: "POST",
			headers: { origin: "https://evil.example" },
		});
		expect(res.status).toBe(403);
		expect(tested).toEqual([]);
	});
});

describe("subscriptions", () => {
	test("POST stores the device and answers 201 with its info, which holds neither the endpoint nor the keys", async () => {
		const res = await post(subscribeBody(device, "  Pixel  "));
		expect(res.status).toBe(201);
		const text = await res.text();
		for (const secret of [device.endpoint, "capability-token-1", device.keys.p256dh, device.keys.auth]) {
			expect(text).not.toContain(secret);
		}
		const info = JSON.parse(text) as PushSubscriptionInfo;
		expect(info).toEqual({
			id: expect.any(String),
			label: "Pixel",
			endpointHash: createHash("sha256").update(device.endpoint).digest("hex"),
			createdAt: expect.any(Number),
			lastDeliveredAt: null,
		});
		expect(h.store.pushSubscriptions()).toMatchObject([
			{ id: info.id, endpoint: device.endpoint, p256dh: device.keys.p256dh, auth: device.keys.auth, label: "Pixel" },
		]);
	});

	test("POST is idempotent per endpoint: the same device keeps its id and gets its keys and label updated", async () => {
		const first = await bodyOf<PushSubscriptionInfo>(await post(subscribeBody(device, "old")));
		const renewed = await makeDevice(device.endpoint);
		const again = await post(subscribeBody(renewed, "new"));
		expect(again.status).toBe(201);
		expect((await bodyOf<PushSubscriptionInfo>(again)).id).toBe(first.id);
		expect(h.store.pushSubscriptions()).toMatchObject([
			{ id: first.id, p256dh: renewed.keys.p256dh, auth: renewed.keys.auth, label: "new" },
		]);
	});

	test('an empty label becomes "device"', async () => {
		const info = await bodyOf<PushSubscriptionInfo>(await post(subscribeBody(device, "   ")));
		expect(info.label).toBe("device");
	});

	test("GET lists every device without secrets; DELETE removes one; deleting an unknown id is 404", async () => {
		const other = await makeDevice("http://127.0.0.1:9/push/abc");
		const a = await bodyOf<PushSubscriptionInfo>(await post(subscribeBody(device, "phone")));
		const b = await bodyOf<PushSubscriptionInfo>(await post(subscribeBody(other, "laptop")));
		h.store.recordPushDelivered(a.id);
		const listed = await api("/api/push/subscriptions");
		expect(listed.status).toBe(200);
		const text = await listed.text();
		expect(text).not.toContain("capability-token-1");
		expect(text).not.toContain(other.keys.auth);
		const infos = JSON.parse(text) as PushSubscriptionInfo[];
		expect(infos.map(i => [i.id, i.label])).toEqual([
			[a.id, "phone"],
			[b.id, "laptop"],
		]);
		expect(infos[0]!.lastDeliveredAt).not.toBeNull();
		expect((await api(`/api/push/subscriptions/${a.id}`, { method: "DELETE" })).status).toBe(204);
		const remaining = await bodyOf<PushSubscriptionInfo[]>(await api("/api/push/subscriptions"));
		expect(remaining.map(i => i.id)).toEqual([b.id]);
		expect((await api(`/api/push/subscriptions/${a.id}`, { method: "DELETE" })).status).toBe(404);
		expect((await api("/api/push/subscriptions/nope", { method: "DELETE" })).status).toBe(404);
	});

	test("other methods and sub-paths are 404", async () => {
		expect((await api("/api/push/subscriptions", { method: "DELETE" })).status).toBe(404);
		expect((await api("/api/push/subscriptions/abc")).status).toBe(404);
		expect((await api("/api/push/key", { method: "POST", body: "{}" })).status).toBe(404);
	});
});

describe("test notification", () => {
	test("POST <id>/test sends to that device and maps the outcome to a status", async () => {
		testResults.set("ok", "delivered").set("dead", "gone").set("flaky", "failed");
		const status = async (id: string): Promise<number> =>
			(await api(`/api/push/subscriptions/${id}/test`, { method: "POST" })).status;
		expect(await status("ok")).toBe(204);
		expect(await status("dead")).toBe(410);
		expect(await status("flaky")).toBe(502);
		expect(await status("nope")).toBe(404);
		expect(tested).toEqual(["ok", "dead", "flaky", "nope"]);
	});

	test("only POST sends a test", async () => {
		testResults.set("ok", "delivered");
		expect((await api("/api/push/subscriptions/ok/test")).status).toBe(404);
		expect(tested).toEqual([]);
	});
});

describe("validation", () => {
	const reject = async (body: unknown, message: string): Promise<void> => {
		const res = await post(body);
		expect(res.status).toBe(400);
		const { error } = await bodyOf<{ error: string }>(res);
		expect(error).toContain(message);
		expect(h.store.pushSubscriptions()).toEqual([]);
	};

	test("malformed bodies", async () => {
		await reject("not json", "not JSON");
		await reject("[]", "object");
		await reject("null", "object");
		await reject({ keys: subscribeBody(device).keys, label: "x" }, "endpoint");
		await reject({ ...subscribeBody(device), keys: "nope" }, "keys");
		await reject({ ...subscribeBody(device), label: 5 }, "label");
		const { label: _label, ...noLabel } = subscribeBody(device);
		await reject(noLabel, "label");
	});

	test("endpoints must be https URLs without credentials; plain http only on loopback", async () => {
		for (const endpoint of [
			"push.example.net/x",
			"ftp://push.example.net/x",
			"http://push.example.net/x",
			"http://127.0.0.1.evil.example/x",
			"https://user:pw@push.example.net/x",
			"javascript:alert(1)",
			42,
		]) {
			await reject({ ...subscribeBody(device), endpoint }, "endpoint");
		}
		for (const endpoint of ["https://push.example.net/x", "http://127.0.0.1:8080/x", "http://localhost:8080/x"]) {
			expect((await post({ ...subscribeBody(device), endpoint })).status).toBe(201);
		}
	});

	test("keys must be a base64url uncompressed P-256 point and a 16-byte auth secret", async () => {
		const good = subscribeBody(device).keys;
		const compressed = Buffer.from(new Uint8Array(33).fill(2)).toString("base64url");
		const notPoint = Buffer.from(new Uint8Array(65).fill(5)).toString("base64url");
		for (const p256dh of [compressed, notPoint, "", "AAAA", "not base64!", 7, good.p256dh + "="]) {
			await reject({ ...subscribeBody(device), keys: { ...good, p256dh } }, "p256dh");
		}
		const short = Buffer.from(new Uint8Array(15)).toString("base64url");
		const long = Buffer.from(new Uint8Array(17)).toString("base64url");
		for (const auth of [short, long, "", "***", 3]) {
			await reject({ ...subscribeBody(device), keys: { ...good, auth } }, "auth");
		}
	});

	test("labels longer than 80 characters are refused, 80 are fine", async () => {
		await reject(subscribeBody(device, "x".repeat(81)), "label");
		expect((await post(subscribeBody(device, "y".repeat(80)))).status).toBe(201);
	});

	test("bodies over 8 KiB are refused with 413, by declared and by streamed size", async () => {
		const big = JSON.stringify({ ...subscribeBody(device), padding: "z".repeat(9000) });
		expect((await post(big)).status).toBe(413);
		const streamed = new ReadableStream<Uint8Array>({
			start(controller) {
				const chunk = new TextEncoder().encode("x".repeat(4096));
				for (let i = 0; i < 3; i++) controller.enqueue(chunk);
				controller.close();
			},
		});
		const res = await api("/api/push/subscriptions", {
			method: "POST",
			body: streamed,
			duplex: "half",
		} as RequestInit);
		expect(res.status).toBe(413);
		expect(h.store.pushSubscriptions()).toEqual([]);
	});
});

describe("push not configured", () => {
	test("every push route is 404 (after authentication)", async () => {
		const bare = await Harness.start({ repo });
		try {
			const own = await bare.login();
			for (const [method, path] of [
				["GET", "/api/push/key"],
				["GET", "/api/push/subscriptions"],
				["POST", "/api/push/subscriptions"],
				["DELETE", "/api/push/subscriptions/x"],
				["POST", "/api/push/subscriptions/x/test"],
			] as const) {
				expect((await fetch(`${bare.http}${path}`, { method, headers: { cookie: own } })).status).toBe(404);
				expect((await fetch(`${bare.http}${path}`, { method })).status).toBe(401);
			}
		} finally {
			await bare.stop();
		}
	});
});
