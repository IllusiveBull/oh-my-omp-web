import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PUSH_SUBSCRIPTIONS_API } from "@omp-web/protocol";
import { NotificationBell, NotificationSettings } from "../src/components/notification-settings";
import { type FakeDom, installFakeDom, makeEvent, type Mounted } from "./fake-dom";
import { type Rig, rig, sha256 } from "./push-rig";

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

const status = (view: Mounted): string | null => view.query(".notif-status")?.getAttribute("data-state") ?? null;
const toggle = ".notif-push-toggle";
const checked = (view: Mounted): string | null => view.query(toggle)?.getAttribute("aria-checked") ?? null;
const switchable = (view: Mounted): boolean => view.query(toggle)?.hasAttribute("disabled") === false;

async function show(r: Rig): Promise<Mounted> {
	const view = await dom.mount(<NotificationSettings push={r.settings} />);
	await view.until(() => status(view) !== null);
	return view;
}

describe("NotificationSettings", () => {
	test("shows the state it finds and does not prompt or subscribe by itself", async () => {
		const r = rig();
		expect(r.settings.getSnapshot().ready).toBe(false);
		const view = await show(r);
		expect(status(view)).toBe("off");
		expect(r.manager.subscribeCalls).toEqual([]);
		expect(r.permissionRequests).toBe(0);
		await view.unmount();
	});

	test("an unsupported context explains why and cannot be switched on, but still lists devices", async () => {
		const r = rig({ secure: false });
		r.gateway.devices = [{ id: "d1", label: "Phone", endpointHash: "h", createdAt: 1, lastDeliveredAt: null }];
		const view = await show(r);
		expect(status(view)).toBe("unsupported");
		expect(view.query(".notif-status")?.textContent).toContain("secure connection");
		expect(switchable(view)).toBe(false);
		expect(view.query("input[name=device-label]")).toBeNull();
		expect(view.query("li[data-subscription=d1] .notif-label")?.textContent).toBe("Phone");
		await view.unmount();
	});

	test("iPhone and iPad without Web Push are pointed to the Home Screen", async () => {
		const r = rig({ registration: null, ios: true });
		const view = await show(r);
		expect(status(view)).toBe("unsupported");
		expect(view.query(".notif-status")?.textContent).toContain("Home Screen");
		await view.unmount();
	});

	test("blocked notifications are shown as denied", async () => {
		const view = await show(rig({}, "denied"));
		expect(status(view)).toBe("denied");
		expect(switchable(view)).toBe(false);
		await view.unmount();
	});

	test("switching on subscribes with the typed device name, then shows this device marked in the list", async () => {
		const r = rig();
		r.gateway.devices = [
			{ id: "other", label: "Laptop", endpointHash: "zzz", createdAt: 1_000, lastDeliveredAt: 2_000 },
		];
		const view = await show(r);
		expect(view.query("input[name=device-label]")?.getAttribute("placeholder")).toBe("Chrome on macOS");
		expect(view.query("li[data-subscription=other] .notif-meta")?.textContent).toContain("last push");
		await view.type("input[name=device-label]", "My phone");
		await view.click(toggle);
		await view.until(() => status(view) === "on");

		expect(r.gateway.devices.map(d => d.label)).toEqual(["Laptop", "My phone"]);
		const mine = r.gateway.devices.find(d => d.label === "My phone")!;
		expect(view.query(`li[data-subscription=${mine.id}] .notif-this`)).not.toBeNull();
		expect(view.query("li[data-subscription=other] .notif-this")).toBeNull();
		expect(view.queryAll(".notif-this")).toHaveLength(1);
		expect(view.query(`li[data-subscription=${mine.id}] .notif-meta`)?.textContent).toContain("no push yet");
		expect(mine.endpointHash).toBe(sha256("https://push.example/endpoint-1"));
		expect(checked(view)).toBe("true");
		expect(view.query("input[name=device-label]")).toBeNull();
		expect(view.query(`li[data-subscription=${mine.id}] .notif-revoke`)).toBeNull();
		expect(view.query("li[data-subscription=other] .notif-revoke")).not.toBeNull();
		expect(view.query(".notif-error")).toBeNull();
		await view.unmount();
	});

	test("switching off removes this device and returns to the off state", async () => {
		const r = rig();
		const view = await show(r);
		expect(checked(view)).toBe("false");
		await view.click(toggle);
		await view.until(() => status(view) === "on");
		await view.click(toggle);
		await view.until(() => status(view) === "off");
		expect(r.gateway.devices).toEqual([]);
		expect(view.query("ul.notif-devices")).toBeNull();
		expect(checked(view)).toBe("false");
		expect(switchable(view)).toBe(true);
		await view.unmount();
	});

	test("Test notification is offered only while on, and asks the gateway to push to this device", async () => {
		const r = rig();
		const view = await show(r);
		expect(view.query(".notif-push-test")).toBeNull();
		await view.click(toggle);
		await view.until(() => status(view) === "on");
		const mine = r.gateway.devices[0]!;
		await view.click(".notif-push-test");
		await view.until(() => view.query(".notif-notice") !== null);
		expect(r.gateway.called("POST", `${PUSH_SUBSCRIPTIONS_API}/${mine.id}/test`)).toHaveLength(1);
		expect(view.query(".notif-error")).toBeNull();
		await view.unmount();
	});

	test("a test the push service rejects as gone says so and leaves this device off", async () => {
		const r = rig();
		const view = await show(r);
		await view.click(toggle);
		await view.until(() => status(view) === "on");
		// the push service answered 410 and the gateway dropped the device
		r.gateway.fail.set(`POST ${PUSH_SUBSCRIPTIONS_API}/:id`, { status: 410, text: "" });
		r.gateway.devices = [];
		await view.click(".notif-push-test");
		await view.until(() => view.query(".notif-error") !== null);
		expect(view.query(".notif-error")?.textContent).toContain("no longer knows this device");
		expect(status(view)).toBe("off");
		expect(view.query(".notif-notice")).toBeNull();
		await view.unmount();
	});

	test("Revoke removes another device through the gateway", async () => {
		const r = rig();
		r.gateway.devices = [
			{ id: "a", label: "Laptop", endpointHash: "h1", createdAt: 1, lastDeliveredAt: null },
			{ id: "b", label: "Tablet", endpointHash: "h2", createdAt: 2, lastDeliveredAt: null },
		];
		const view = await show(r);
		await view.click("li[data-subscription=a] .notif-revoke");
		await view.until(() => view.query("li[data-subscription=a]") === null);
		expect(r.gateway.called("DELETE", `${PUSH_SUBSCRIPTIONS_API}/a`)).toHaveLength(1);
		expect(view.query("li[data-subscription=b]")).not.toBeNull();
		await view.unmount();
	});

	test("a failure is shown inline and the controls come back", async () => {
		const r = rig();
		r.gateway.fail.set(`POST ${PUSH_SUBSCRIPTIONS_API}`, { status: 500, text: "db locked" });
		const view = await show(r);
		await view.click(toggle);
		await view.until(() => view.query(".notif-error") !== null);
		expect(view.query(".notif-error")?.textContent).toBe("The gateway answered 500: db locked.");
		expect(status(view)).toBe("off");
		expect(switchable(view)).toBe(true);
		await view.unmount();
	});
});

describe("NotificationBell", () => {
	test("starts closed and struck through, opens the settings, lights up once enabled, and closes on Escape", async () => {
		const r = rig();
		const view = await dom.mount(<NotificationBell push={r.settings} />);
		await view.until(() => r.settings.getSnapshot().ready);
		expect(view.query(".notif-pop")).toBeNull();
		expect(view.query(".notif-bell-button")?.getAttribute("aria-label")).toBe("Notifications: off");
		await view.click(".notif-bell-button");
		expect(view.query(".notif-pop")).not.toBeNull();
		await view.click(toggle);
		await view.until(() => status(view) === "on");
		expect(view.query(".notif-bell-button")?.getAttribute("aria-label")).toBe("Notifications: on");
		await view.act(() => {
			dom.document.dispatchEvent(Object.assign(makeEvent("keydown"), { key: "Escape" }));
		});
		expect(view.query(".notif-pop")).toBeNull();
		await view.unmount();
	});
});
