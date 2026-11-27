import { describe, expect, test } from "bun:test";
import { PUSH_KEY_API, PUSH_SUBSCRIPTIONS_API } from "@omp-web/protocol";
import {
	base64UrlToBytes,
	defaultDeviceLabel,
	describePushError,
	LABEL_MAX,
	PushError,
	type PushSubscriptionLike,
	sha256Hex,
	subscribeRequest,
	unsupportedReason,
} from "../src/lib/push";
import {
	AUTH,
	FakePushManager,
	FakeSubscription,
	P256DH,
	type Rig,
	rig,
	SERVER_KEY,
	SERVER_KEY_BYTES,
	sha256,
} from "./push-rig";

describe("PushSettings detection", () => {
	test("a capable browser with no subscription is off, with the device list loaded", async () => {
		const r = rig();
		r.gateway.devices = [{ id: "d1", label: "Phone", endpointHash: "x", createdAt: 5, lastDeliveredAt: 9 }];
		expect(r.settings.getSnapshot().ready).toBe(false);
		await r.settings.refresh();
		const snapshot = r.settings.getSnapshot();
		expect(snapshot).toMatchObject({ ready: true, state: "off", reason: null, error: null, self: null, busy: false });
		expect(snapshot.devices.map(d => d.id)).toEqual(["d1"]);
		expect(snapshot.defaultLabel).toBe("Chrome on macOS");
		expect(r.permissionRequests).toBe(0); // looking never prompts
		expect(r.manager.subscribeCalls).toEqual([]);
	});

	test("an existing subscription the gateway lists is on, and recognised by the hash of its endpoint", async () => {
		const r = rig({}, "granted");
		const subscription = new FakeSubscription("https://push.example/endpoint-1", r.manager);
		r.manager.current = subscription;
		r.gateway.devices = [
			{ id: "other", label: "Other", endpointHash: "zzz", createdAt: 1, lastDeliveredAt: null },
			{ id: "mine", label: "This", endpointHash: sha256(subscription.endpoint), createdAt: 2, lastDeliveredAt: 3 },
		];
		await r.settings.refresh();
		expect(r.settings.getSnapshot()).toMatchObject({ state: "on", self: sha256(subscription.endpoint) });
	});

	test("a local subscription the gateway no longer lists counts as off", async () => {
		const r = rig({}, "granted");
		r.manager.current = new FakeSubscription("https://push.example/endpoint-1", r.manager);
		await r.settings.refresh();
		expect(r.settings.getSnapshot().state).toBe("off");
	});

	test("blocked notifications are denied, with how to undo it", async () => {
		const r = rig({}, "denied");
		await r.settings.refresh();
		const snapshot = r.settings.getSnapshot();
		expect(snapshot.state).toBe("denied");
		expect(snapshot.reason).toContain("blocked");
	});

	test("a plain-http page is unsupported and says why, but still lists devices and never touches the browser APIs", async () => {
		let registrationCalls = 0;
		const r = rig({
			secure: false,
			registration: async () => {
				registrationCalls++;
				return { pushManager: new FakePushManager() };
			},
		});
		r.gateway.devices = [{ id: "d1", label: "Phone", endpointHash: "x", createdAt: 5, lastDeliveredAt: null }];
		await r.settings.refresh();
		const snapshot = r.settings.getSnapshot();
		expect(snapshot.state).toBe("unsupported");
		expect(snapshot.reason).toContain("secure");
		expect(snapshot.devices).toHaveLength(1);
		expect(registrationCalls).toBe(0);
		await r.settings.enable("x");
		expect(r.permissionRequests).toBe(0);
		expect(r.settings.getSnapshot().error).toContain("secure");
	});

	test("missing APIs are unsupported; on iPhone/iPad the reason is the Home Screen requirement", async () => {
		const missing = rig({ registration: null });
		await missing.settings.refresh();
		expect(missing.settings.getSnapshot()).toMatchObject({
			state: "unsupported",
			reason: "This browser does not support Web Push.",
		});

		const noNotification = rig({ notification: null });
		await noNotification.settings.refresh();
		expect(noNotification.settings.getSnapshot().state).toBe("unsupported");

		const ios = rig({
			registration: null,
			ios: true,
			userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari/604.1",
		});
		await ios.settings.refresh();
		expect(ios.settings.getSnapshot().reason).toContain("Home Screen");
		expect(ios.settings.getSnapshot().reason).toContain("iPhone and iPad");
	});

	test("a failing device list is reported but the local state is still shown", async () => {
		const r = rig({}, "granted");
		r.manager.current = new FakeSubscription("https://push.example/endpoint-1", r.manager);
		r.gateway.fail.set(`GET ${PUSH_SUBSCRIPTIONS_API}`, { status: 401, text: "" });
		await r.settings.refresh();
		const snapshot = r.settings.getSnapshot();
		expect(snapshot.error).toContain("session expired");
		expect(snapshot.state).toBe("on");
		expect(snapshot.ready).toBe(true);
	});
});

describe("PushSettings.enable", () => {
	test("asks for permission first, in the click handler, then subscribes with the gateway's key and registers it", async () => {
		const r = rig();
		await r.settings.refresh();
		const done = r.settings.enable("  My phone  ");
		expect(r.permissionRequests).toBe(1); // before anything was awaited
		await done;

		expect(r.manager.subscribeCalls).toHaveLength(1);
		expect(r.manager.subscribeCalls[0]!.userVisibleOnly).toBe(true);
		expect([...r.manager.subscribeCalls[0]!.applicationServerKey]).toEqual(SERVER_KEY_BYTES);
		expect(r.gateway.called("POST", PUSH_SUBSCRIPTIONS_API)[0]!.body).toEqual({
			endpoint: "https://push.example/endpoint-1",
			keys: { p256dh: P256DH, auth: AUTH },
			label: "My phone",
		});
		const snapshot = r.settings.getSnapshot();
		expect(snapshot).toMatchObject({
			state: "on",
			error: null,
			busy: false,
			self: sha256("https://push.example/endpoint-1"),
		});
		expect(snapshot.devices.map(d => d.label)).toEqual(["My phone"]);
	});

	test("with permission already granted (switching back on), subscribe runs before anything is awaited", async () => {
		// Safari rejects a subscribe() that comes after a network wait: it is no longer in the click's gesture.
		const r = rig({}, "granted");
		await r.settings.refresh();
		const keyFetches = r.gateway.called("GET", PUSH_KEY_API).length;
		const done = r.settings.enable("");
		expect(r.manager.subscribeCalls).toHaveLength(1);
		expect(r.permissionRequests).toBe(0);
		await done;
		expect(r.gateway.called("GET", PUSH_KEY_API)).toHaveLength(keyFetches);
		expect(r.settings.getSnapshot().state).toBe("on");
	});

	test("an empty name becomes the platform/browser description; a long one is cut to what the gateway accepts", async () => {
		const blank = rig();
		await blank.settings.refresh();
		await blank.settings.enable("   ");
		expect(blank.gateway.devices[0]!.label).toBe("Chrome on macOS");

		const long = rig();
		await long.settings.refresh();
		await long.settings.enable("x".repeat(200));
		expect(long.gateway.devices[0]!.label).toBe("x".repeat(LABEL_MAX));
	});

	test("refused permission ends in denied without subscribing", async () => {
		const r = rig();
		r.notification.nextPermission = "denied";
		await r.settings.refresh();
		await r.settings.enable("");
		expect(r.settings.getSnapshot()).toMatchObject({ state: "denied", error: expect.stringContaining("blocked") });
		expect(r.manager.subscribeCalls).toEqual([]);
	});

	test("a dismissed prompt leaves it off, with an error", async () => {
		const r = rig();
		r.notification.nextPermission = "default";
		await r.settings.refresh();
		await r.settings.enable("");
		expect(r.settings.getSnapshot()).toMatchObject({
			state: "off",
			error: "Notification permission was not granted.",
		});
		expect(r.manager.subscribeCalls).toEqual([]);
	});

	test("a gateway that rejects the registration leaves it off and says what the gateway answered", async () => {
		const r = rig();
		r.gateway.fail.set(`POST ${PUSH_SUBSCRIPTIONS_API}`, { status: 400, text: "endpoint must be https" });
		await r.settings.refresh();
		await r.settings.enable("");
		const snapshot = r.settings.getSnapshot();
		expect(snapshot.error).toBe("The gateway answered 400: endpoint must be https.");
		expect(snapshot.state).toBe("off");
		expect(snapshot.busy).toBe(false);
	});

	test("browser errors are mapped to something a person can act on", async () => {
		const r = rig();
		r.manager.failure = Object.assign(new Error("boom"), { name: "AbortError" });
		await r.settings.refresh();
		await r.settings.enable("");
		expect(r.settings.getSnapshot().error).toContain("push service could not be reached");
		expect(r.gateway.called("POST", PUSH_SUBSCRIPTIONS_API)).toEqual([]);
	});

	test("a gateway without a key is reported before anything is subscribed", async () => {
		const r = rig();
		r.gateway.fail.set(`GET ${PUSH_KEY_API}`, { status: 503, text: "push is not configured" });
		await r.settings.refresh();
		await r.settings.enable("");
		expect(r.settings.getSnapshot().error).toBe("The gateway answered 503: push is not configured.");
		expect(r.manager.subscribeCalls).toEqual([]);
	});

	test("is busy while it runs, and the controls know", async () => {
		const r = rig();
		await r.settings.refresh();
		const busy: boolean[] = [];
		r.settings.subscribe(() => busy.push(r.settings.getSnapshot().busy));
		await r.settings.enable("");
		expect(busy[0]).toBe(true);
		expect(busy.at(-1)).toBe(false);
	});
});

describe("PushSettings.disable and revoke", () => {
	async function enabled(): Promise<Rig> {
		const r = rig();
		await r.settings.refresh();
		await r.settings.enable("This one");
		r.gateway.devices.push({ id: "other", label: "Other", endpointHash: "zzz", createdAt: 1, lastDeliveredAt: null });
		await r.settings.refresh();
		return r;
	}

	test("disable removes this device from the gateway and unsubscribes the browser", async () => {
		const r = await enabled();
		const subscription = r.manager.current!;
		const mine = r.gateway.devices.find(d => d.label === "This one")!;
		await r.settings.disable();
		expect(r.gateway.called("DELETE", `${PUSH_SUBSCRIPTIONS_API}/${mine.id}`)).toHaveLength(1);
		expect(subscription.unsubscribed).toBe(true);
		expect(r.settings.getSnapshot()).toMatchObject({ state: "off", error: null, self: null });
		expect(r.settings.getSnapshot().devices.map(d => d.id)).toEqual(["other"]);
	});

	test("when the gateway refuses, the browser stays subscribed and the state stays on", async () => {
		const r = await enabled();
		r.gateway.fail.set(`DELETE ${PUSH_SUBSCRIPTIONS_API}/:id`, { status: 500, text: "db locked" });
		await r.settings.disable();
		expect(r.manager.current?.unsubscribed).toBe(false);
		expect(r.settings.getSnapshot()).toMatchObject({ state: "on", error: "The gateway answered 500: db locked." });
	});

	test("revoking another device leaves this one subscribed", async () => {
		const r = await enabled();
		await r.settings.revoke("other");
		expect(r.gateway.called("DELETE", `${PUSH_SUBSCRIPTIONS_API}/other`)).toHaveLength(1);
		expect(r.manager.current?.unsubscribed).toBe(false);
		expect(r.settings.getSnapshot().state).toBe("on");
		expect(r.settings.getSnapshot().devices.map(d => d.label)).toEqual(["This one"]);
	});

	test("revoking this device from the list also unsubscribes the browser", async () => {
		const r = await enabled();
		const subscription = r.manager.current!;
		const mine = r.gateway.devices.find(d => d.label === "This one")!;
		await r.settings.revoke(mine.id);
		expect(subscription.unsubscribed).toBe(true);
		expect(r.settings.getSnapshot().state).toBe("off");
	});

	test("a device the gateway no longer knows counts as revoked", async () => {
		const r = await enabled();
		await r.settings.revoke("ghost"); // the fake answers 404
		expect(r.settings.getSnapshot().error).toBeNull();
	});
});

describe("push helpers", () => {
	test("sha256Hex is the lower-case hex digest of the UTF-8 bytes", async () => {
		expect(await sha256Hex("https://push.example/é")).toBe(sha256("https://push.example/é"));
	});

	test("base64UrlToBytes decodes unpadded base64url", () => {
		expect([...base64UrlToBytes(SERVER_KEY)]).toEqual(SERVER_KEY_BYTES);
		expect([...base64UrlToBytes("-_8")]).toEqual([251, 255]);
	});

	test("defaultDeviceLabel names browser and platform", () => {
		const label = defaultDeviceLabel;
		expect(
			label(
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1",
			),
		).toBe("Safari on iPhone");
		expect(
			label("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"),
		).toBe("Chrome on Android");
		expect(
			label("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0"),
		).toBe("Edge on Windows");
		expect(label("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")).toBe("Firefox on Linux");
		expect(label("")).toBe("device");
	});

	test("unsupportedReason is null for a capable browser", () => {
		const capable = rig().browser;
		expect(unsupportedReason(capable)).toBeNull();
		expect(unsupportedReason({ ...capable, secure: false, ios: true })).toContain("Home Screen");
	});

	test("subscribeRequest refuses an incomplete browser subscription", () => {
		const incomplete: PushSubscriptionLike = {
			endpoint: "https://push.example/e",
			toJSON: () => ({ endpoint: "https://push.example/e" }),
			unsubscribe: async () => true,
		};
		expect(() => subscribeRequest(incomplete, "x")).toThrow(PushError);
	});

	test("describePushError maps the browser's DOMException names and passes plain messages through", () => {
		const named = (name: string): Error => Object.assign(new Error("x"), { name });
		expect(describePushError(named("NotAllowedError"))).toContain("blocked");
		expect(describePushError(named("InvalidStateError"))).toContain("different key");
		expect(describePushError(new TypeError("Failed to fetch"))).toBe("Could not reach the gateway.");
		expect(describePushError(new Error("plain"))).toBe("plain");
		expect(describePushError("odd")).toBe("Unexpected error.");
	});
});
