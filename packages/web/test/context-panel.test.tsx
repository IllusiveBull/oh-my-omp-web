import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Ack } from "@omp-web/protocol";
import { ContextPanel } from "../src/components/context-panel";
import { type ClientRequest, DaemonClient } from "../src/store/daemon-client";
import { type FakeDom, installFakeDom, makeEvent } from "./fake-dom";

class ContextClient extends DaemonClient {
	override request(_machine: string, _request: ClientRequest): Promise<Ack> {
		return Promise.resolve({ t: "ack", reqId: "", ok: true, data: { text: "Context Usage · 1M" } });
	}
}

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

describe("ContextPanel", () => {
	test("stays open while the transcript scrolls under it (the agent streaming), closes on a click outside", async () => {
		const transcript = dom.document.createElement("div");
		const anchor = dom.document.createElement("button");
		dom.document.body.appendChild(transcript);
		dom.document.body.appendChild(anchor);
		let closed = 0;
		const view = await dom.mount(
			<ContextPanel
				client={new ContextClient("ws://x/ws")}
				machine="m"
				sessionId="s"
				entries={[]}
				anchor={anchor as unknown as HTMLButtonElement}
				onClose={() => closed++}
			/>,
		);
		await view.act(() => void transcript.dispatchEvent(makeEvent("scroll", false)));
		expect(closed).toBe(0);
		await view.act(() => void transcript.dispatchEvent(makeEvent("pointerdown")));
		expect(closed).toBe(1);
		await view.unmount();
	});
});
