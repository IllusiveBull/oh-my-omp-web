import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { usePresence } from "../src/lib/use-presence";
import type { SessionRef } from "../src/lib/route";
import { DaemonClient } from "../src/store/daemon-client";
import { type FakeDom, installFakeDom, makeEvent } from "./fake-dom";

class RecordingClient extends DaemonClient {
	reports: [string, string | null, boolean][] = [];
	override reportView(machine: string, sessionId: string | null, visible: boolean): Promise<boolean> {
		this.reports.push([machine, sessionId, visible]);
		return Promise.resolve(true);
	}
}

function Probe({ client, session }: { client: DaemonClient; session: SessionRef | null }): ReactNode {
	usePresence(client, session);
	return null;
}

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

describe("usePresence", () => {
	test("reports when a session opens and closes, with the page's visibility", async () => {
		dom.document.visibilityState = "visible";
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(<Probe client={client} session={null} />);
		expect(client.reports).toEqual([["", null, true]]);
		await view.rerender(<Probe client={client} session={{ machine: "m1", id: "a" }} />);
		await view.rerender(<Probe client={client} session={{ machine: "m1", id: "a" }} />); // same session: nothing new
		await view.rerender(<Probe client={client} session={{ machine: "m2", id: "a" }} />);
		await view.rerender(<Probe client={client} session={null} />);
		expect(client.reports).toEqual([
			["", null, true],
			["m1", "a", true],
			["m2", "a", true],
			["", null, true],
		]);
		await view.unmount();
	});

	test("reports every visibility change, and hidden on pagehide", async () => {
		dom.document.visibilityState = "visible";
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(<Probe client={client} session={{ machine: "m1", id: "a" }} />);
		client.reports.length = 0;

		dom.document.visibilityState = "hidden";
		await view.act(() => void dom.document.dispatchEvent(makeEvent("visibilitychange", false)));
		dom.document.visibilityState = "visible";
		await view.act(() => void dom.document.dispatchEvent(makeEvent("visibilitychange", false)));
		await view.act(() => void dom.window.dispatchEvent(makeEvent("pagehide", false)));
		await view.act(() => void dom.window.dispatchEvent(makeEvent("pageshow", false)));
		expect(client.reports).toEqual([
			["m1", "a", false],
			["m1", "a", true],
			["m1", "a", false],
			["m1", "a", true],
		]);
		await view.unmount();
	});

	test("a visible page whose window lost focus is not being looked at; regaining focus is", async () => {
		// macOS keeps a window behind others `visible`: without the focus rule its session would never be notified about
		dom.document.visibilityState = "visible";
		dom.document.focused = true;
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(<Probe client={client} session={{ machine: "m1", id: "a" }} />);
		client.reports.length = 0;

		dom.document.focused = false;
		await view.act(() => void dom.window.dispatchEvent(makeEvent("blur", false)));
		dom.document.focused = true;
		await view.act(() => void dom.window.dispatchEvent(makeEvent("focus", false)));
		expect(client.reports).toEqual([
			["m1", "a", false],
			["m1", "a", true],
		]);
		await view.unmount();
	});

	test("opening a session in an unfocused window reports it as not looked at", async () => {
		dom.document.visibilityState = "visible";
		dom.document.focused = false;
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(<Probe client={client} session={{ machine: "m1", id: "a" }} />);
		expect(client.reports).toEqual([["m1", "a", false]]);
		await view.unmount();
		dom.document.focused = true;
	});

	test("stops listening when unmounted", async () => {
		dom.document.visibilityState = "visible";
		const client = new RecordingClient("ws://x/ws");
		const view = await dom.mount(<Probe client={client} session={{ machine: "m1", id: "a" }} />);
		await view.unmount();
		client.reports.length = 0;
		dom.document.dispatchEvent(makeEvent("visibilitychange", false));
		dom.window.dispatchEvent(makeEvent("focus", false));
		dom.window.dispatchEvent(makeEvent("blur", false));
		dom.window.dispatchEvent(makeEvent("pagehide", false));
		expect(client.reports).toEqual([]);
	});
});
