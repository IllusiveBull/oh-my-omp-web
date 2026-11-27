import "./dom-shim";
import { afterAll, beforeAll, test } from "bun:test";
import type { Ack, SubagentTranscript, SubagentWire } from "@omp-web/protocol";
import { AgentDrawer } from "../src/components/agent-drawer";
import type { DaemonClient, DaemonState } from "../src/store/daemon-client";
import { type FakeDom, installFakeDom } from "./fake-dom";
import { machineSummary, userEntry } from "./fixtures";

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

const SUBAGENT: SubagentWire = {
	agent: {
		id: "Worker",
		displayName: "Worker",
		kind: "sub",
		status: "idle",
		hasSessionFile: true,
		createdAt: 0,
		lastActivity: 0,
	},
};

/** The parts of the client the drawer uses: its connection state, and requests answered as the socket allows. */
function fakeClient(transcript: SubagentTranscript) {
	let state = { phase: "reconnecting", machines: [machineSummary({ id: "m1" })] } as unknown as DaemonState;
	const listeners = new Set<() => void>();
	const client = {
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot: () => state,
		request: async (): Promise<Ack> =>
			state.phase === "open"
				? { t: "ack", reqId: "r", ok: true, data: transcript }
				: { t: "ack", reqId: "", ok: false, error: "not connected" },
	};
	return {
		client: client as unknown as DaemonClient,
		reconnect() {
			state = { ...state, phase: "open" };
			for (const listener of listeners) listener();
		},
	};
}

test("a transcript that could not be read while the socket was down is read again once it is back", async () => {
	const { client, reconnect } = fakeClient({ entries: [userEntry("u1", "look here")], nextByte: 10, reset: false });
	const view = await dom.mount(
		<AgentDrawer client={client} machine="m1" sessionId="s1" subagent={SUBAGENT} onClose={() => {}} />,
	);
	await view.until(() => view.container.textContent.includes("transcript unavailable: not connected"));
	// Well before the next poll would have come round (if the loop still ran at all).
	await view.act(reconnect);
	await view.until(() => !view.container.textContent.includes("transcript unavailable"));
	await view.unmount();
});
