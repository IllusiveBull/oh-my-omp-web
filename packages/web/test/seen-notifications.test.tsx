import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import {
	closeThreadNotifications,
	type NotificationHost,
	type NotificationHostSource,
	useCloseSeenNotifications,
} from "../src/lib/seen-notifications";
import { type FakeDom, installFakeDom, makeEvent } from "./fake-dom";

class FakeHost implements NotificationHost {
	/** Open notifications by tag; `closed` collects what was closed. */
	open: { tag: string }[] = [];
	closed: string[] = [];
	queries: string[] = [];
	async getNotifications(filter: { tag: string }): Promise<{ close(): void }[]> {
		this.queries.push(filter.tag);
		return this.open.filter(n => n.tag === filter.tag).map(n => ({ close: () => this.closed.push(n.tag) }));
	}
}

describe("closeThreadNotifications", () => {
	test("closes every notification of the thread and counts them", async () => {
		const host = new FakeHost();
		host.open = [{ tag: "t1" }, { tag: "t2" }, { tag: "t1" }];
		expect(await closeThreadNotifications(host, "t1")).toBe(2);
		expect(host.closed).toEqual(["t1", "t1"]);
		expect(await closeThreadNotifications(host, "none")).toBe(0);
	});
});

function Probe({ threadId, source }: { threadId: string | undefined; source: NotificationHostSource }): ReactNode {
	useCloseSeenNotifications(threadId, source);
	return null;
}

describe("useCloseSeenNotifications", () => {
	let dom: FakeDom;
	beforeAll(async () => {
		dom = await installFakeDom();
	});
	afterAll(() => dom.uninstall());

	const rig = () => {
		const host = new FakeHost();
		host.open = [{ tag: "t1" }, { tag: "t2" }];
		const source: NotificationHostSource = () => Promise.resolve(host);
		return { host, source };
	};
	const settled = (view: { until(c: () => boolean): Promise<void> }, host: FakeHost, closed: number): Promise<void> =>
		view.until(() => host.closed.length >= closed);

	test("closes the open thread's notifications when it opens and when the thread changes", async () => {
		dom.document.visibilityState = "visible";
		const { host, source } = rig();
		const view = await dom.mount(<Probe threadId={undefined} source={source} />);
		expect(host.queries).toEqual([]); // no session open
		await view.rerender(<Probe threadId="t1" source={source} />);
		await settled(view, host, 1);
		await view.rerender(<Probe threadId="t2" source={source} />);
		await settled(view, host, 2);
		expect(host.closed).toEqual(["t1", "t2"]);
		await view.unmount();
	});

	test("closes them again when the page becomes visible, and never while it is hidden", async () => {
		dom.document.visibilityState = "hidden";
		const { host, source } = rig();
		const view = await dom.mount(<Probe threadId="t1" source={source} />);
		expect(host.queries).toEqual([]);
		dom.document.visibilityState = "visible";
		await view.act(() => void dom.document.dispatchEvent(makeEvent("visibilitychange", false)));
		await settled(view, host, 1);
		expect(host.queries).toEqual(["t1"]);
		dom.document.visibilityState = "hidden";
		await view.act(() => void dom.document.dispatchEvent(makeEvent("visibilitychange", false)));
		expect(host.queries).toEqual(["t1"]);
		await view.unmount();
		dom.document.visibilityState = "visible";
		dom.document.dispatchEvent(makeEvent("visibilitychange", false));
		expect(host.queries).toEqual(["t1"]); // listener removed
	});

	test("a visible but unfocused window keeps them, and closes them once it gets focus", async () => {
		dom.document.visibilityState = "visible";
		dom.document.focused = false;
		const { host, source } = rig();
		const view = await dom.mount(<Probe threadId="t1" source={source} />);
		expect(host.queries).toEqual([]);
		dom.document.focused = true;
		await view.act(() => void dom.window.dispatchEvent(makeEvent("focus", false)));
		await settled(view, host, 1);
		expect(host.closed).toEqual(["t1"]);
		await view.unmount();
	});

	test("without a service worker, or when it fails, nothing happens and nothing throws", async () => {
		dom.document.visibilityState = "visible";
		const missing = await dom.mount(<Probe threadId="t1" source={() => null} />);
		await missing.unmount();
		const failing = await dom.mount(<Probe threadId="t1" source={() => Promise.reject(new Error("no worker"))} />);
		await failing.act(async () => {
			await new Promise<void>(resolve => setImmediate(resolve));
		});
		await failing.unmount();
	});
});
