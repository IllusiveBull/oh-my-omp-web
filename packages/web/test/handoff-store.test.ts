import { describe, expect, test } from "bun:test";
import type { MachineSummary, ServerMessage } from "@omp-web/protocol";
import { DaemonClient } from "../src/store/daemon-client";
import { plan, wire } from "./handoff-fixtures";
import { machineSummary } from "./fixtures";

class FakeSocket {
	static instances: FakeSocket[] = [];
	readyState = 0;
	sent: Record<string, unknown>[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
	}
	send(text: string): void {
		this.sent.push(JSON.parse(text));
	}
	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}
	deliver(message: ServerMessage): void {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
	requests(type: string): Record<string, unknown>[] {
		return this.sent.filter(m => m.t === type);
	}
}

const HELLO = { t: "hello", protocol: 6, gatewayVersion: "0", machine: "desk" } as const;

function connect(machines: MachineSummary[] = [machineSummary({ id: "desk" })]): {
	client: DaemonClient;
	socket: FakeSocket;
} {
	FakeSocket.instances = [];
	const client = new DaemonClient("ws://x/ws", {
		socketFactory: url => new FakeSocket(url) as unknown as WebSocket,
		reconnect: { minMs: 5, maxMs: 10 },
		authProbe: async () => "valid",
	});
	client.connect();
	const socket = FakeSocket.instances[0]!;
	socket.open();
	socket.deliver(HELLO);
	socket.deliver({ t: "machines", machines });
	return { client, socket };
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition was not met in time");
		await Bun.sleep(1);
	}
}

describe("DaemonClient handoffs", () => {
	test("empty before the gateway says anything; each handoff.state frame replaces the list wholesale", () => {
		const { client, socket } = connect();
		expect(client.getSnapshot().handoffs).toEqual([]);
		const a = wire({ id: "h-aaaa-0001" });
		const b = wire({ id: "h-bbbb-0002", phase: "awaiting_confirm" });
		socket.deliver({ t: "handoff.state", handoffs: [a, b] });
		expect(client.getSnapshot().handoffs).toEqual([a, b]);
		socket.deliver({ t: "handoff.state", handoffs: [b] });
		expect(client.getSnapshot().handoffs).toEqual([b]);
		socket.deliver({ t: "handoff.state", handoffs: [] });
		expect(client.getSnapshot().handoffs).toEqual([]);
		client.close();
	});

	test("a frame notifies subscribers", () => {
		const { client, socket } = connect();
		let calls = 0;
		client.subscribe(() => calls++);
		socket.deliver({ t: "handoff.state", handoffs: [wire()] });
		expect(calls).toBe(1);
		client.close();
	});

	test("the list survives the loss of the socket (shown while reconnecting) but a new connection starts empty until its own frame", async () => {
		const { client, socket: first } = connect();
		first.deliver({ t: "handoff.state", handoffs: [wire()] });
		first.close();
		expect(client.getSnapshot().phase).toBe("reconnecting");
		expect(client.getSnapshot().handoffs).toHaveLength(1);
		await until(() => FakeSocket.instances.length === 2);
		const second = FakeSocket.instances[1]!;
		second.open();
		second.deliver(HELLO);
		expect(client.getSnapshot().handoffs).toEqual([]);
		second.deliver({ t: "handoff.state", handoffs: [wire({ phase: "awaiting_confirm" })] });
		expect(client.getSnapshot().handoffs[0]?.phase).toBe("awaiting_confirm");
		client.close();
	});

	test("a request has no machine of its own, gets a reqId, and resolves with the ack (plan carries the plan in data)", async () => {
		const { client, socket } = connect();
		const pending = client.handoffRequest({ t: "handoff.plan", m: "desk", sessionId: "a", targetMachine: "lap" });
		const sent = socket.requests("handoff.plan")[0]!;
		expect(sent).toMatchObject({ t: "handoff.plan", m: "desk", sessionId: "a", targetMachine: "lap" });
		expect(typeof sent.reqId).toBe("string");
		socket.deliver({ t: "ack", reqId: sent.reqId as string, ok: true, data: plan() });
		const ack = await pending;
		expect(ack).toMatchObject({ ok: true, data: { blockers: [] } });
		client.close();
	});

	test("start, confirm, cancel and dismiss go out as typed; start acks its id and a refusal is an ack with the error", async () => {
		const { client, socket } = connect();
		const start = client.handoffRequest({
			t: "handoff.start",
			m: "desk",
			sessionId: "a",
			targetMachine: "lap",
			target: { mode: "existing", worktree: "/wt" },
		});
		const sent = socket.requests("handoff.start")[0]!;
		expect(sent.target).toEqual({ mode: "existing", worktree: "/wt" });
		socket.deliver({ t: "ack", reqId: sent.reqId as string, ok: true, data: { id: "h-new-0001" } });
		expect(await start).toMatchObject({ ok: true, data: { id: "h-new-0001" } });

		for (const t of ["handoff.confirm", "handoff.cancel", "handoff.dismiss"] as const) {
			const pending = client.handoffRequest({ t, id: "h-new-0001" });
			const request = socket.requests(t)[0]!;
			expect(request).toMatchObject({ t, id: "h-new-0001" });
			socket.deliver({
				t: "ack",
				reqId: request.reqId as string,
				ok: false,
				error: "not awaiting confirm",
				code: "handoff",
			});
			expect(await pending).toMatchObject({ ok: false, error: "not awaiting confirm", code: "handoff" });
		}
		client.close();
	});

	test("without a connection a request fails at once; a lost connection fails the pending ones", async () => {
		const offline = new DaemonClient("ws://x/ws", {
			socketFactory: url => new FakeSocket(url) as unknown as WebSocket,
		});
		expect(await offline.handoffRequest({ t: "handoff.cancel", id: "h-x-000001" })).toMatchObject({
			ok: false,
			error: "not connected",
		});
		const { client, socket } = connect();
		const pending = client.handoffRequest({ t: "handoff.cancel", id: "h-x-000001" });
		socket.close();
		expect(await pending).toMatchObject({ ok: false, error: "connection lost" });
		client.close();
	});

	test("a request that is never answered times out", async () => {
		const { client } = connect();
		const ack = await client.handoffRequest({ t: "handoff.cancel", id: "h-x-000001" }, 10);
		expect(ack).toMatchObject({ ok: false, error: "request timed out" });
		client.close();
	});
});
