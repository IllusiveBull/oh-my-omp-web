import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthFrame, AuthMessage, BrokerLinkConfig, BrokerStatus } from "@omp-web/protocol";
import type { AuthPort } from "../src/gateway";
import { Harness, makeRepo } from "./gateway-harness";

const DISABLED: BrokerStatus = {
	phase: "disabled",
	healthy: false,
	url: null,
	advertisedUrl: null,
	bind: null,
	home: null,
	agentDb: null,
	tokenFile: null,
	pid: null,
	version: null,
	startedAt: null,
	checkedAt: null,
	restarts: 0,
	nextRetryAt: null,
	lastError: null,
};

class RecordingAuth implements AuthPort {
	handled: { connection: object; message: AuthMessage }[] = [];
	released_: object[] = [];
	frames(): AuthFrame[] {
		return [
			{ t: "auth.broker", broker: DISABLED },
			{
				t: "auth.accounts",
				providers: null,
				accounts: [],
				disabled: [],
				error: null,
				loadedAt: null,
				migration: null,
			},
			{ t: "auth.flow", flow: null },
			{ t: "auth.usage", fetchedAt: null, generatedAt: null, reports: [], error: null },
		];
	}
	async handle(connection: object, message: AuthMessage): Promise<unknown> {
		this.handled.push({ connection, message });
		if (message.t === "auth.refresh") throw new Error("the auth broker is not running (restarting)");
		return { echoed: message.t };
	}
	released(connection: object): void {
		this.released_.push(connection);
	}
	brokerConfigFor(): BrokerLinkConfig | null {
		return null;
	}
}

let repo: string;
beforeAll(async () => {
	repo = await makeRepo();
});
afterAll(() => rmSync(dirname(repo), { recursive: true, force: true }));
let h: Harness | null = null;
afterEach(async () => {
	await h?.stop();
	h = null;
});

const until = async (predicate: () => boolean, ms = 3000): Promise<void> => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
};

describe("the gateway and the credential service", () => {
	test("a connecting browser starts with the current auth frames, right after the machine list", async () => {
		const auth = new RecordingAuth();
		h = await Harness.start({ repo, auth });
		const c = await h.connect();
		await c.waitFor(m => m.t === "auth.usage");
		const types = c.frames.map(f => f.t);
		expect(types.indexOf("machines")).toBeLessThan(types.indexOf("auth.broker"));
		expect(types.filter(t => t.startsWith("auth."))).toEqual([
			"auth.broker",
			"auth.accounts",
			"auth.flow",
			"auth.usage",
		]);
	});

	test("auth requests carry no machine id, go to the service with this connection, and their answers (or errors) are acked", async () => {
		const auth = new RecordingAuth();
		h = await Harness.start({ repo, auth });
		const a = await h.connect();
		const b = await h.connect();
		const ok = await a.callAuth({ t: "auth.login.start", providerId: "anthropic" });
		expect(ok).toMatchObject({ ok: true, data: { echoed: "auth.login.start" } });
		const failed = await b.callAuth({ t: "auth.refresh" });
		expect(failed).toMatchObject({ ok: false, error: "the auth broker is not running (restarting)" });
		expect(auth.handled.map(x => x.message.t)).toEqual(["auth.login.start", "auth.refresh"]);
		expect(auth.handled[0]!.connection).not.toBe(auth.handled[1]!.connection); // one connection object per browser
	});

	test("a malformed auth request is acked as an error without reaching the service", async () => {
		const auth = new RecordingAuth();
		h = await Harness.start({ repo, auth });
		const c = await h.connect();
		c.raw(JSON.stringify({ t: "auth.login.input", reqId: "bad", flowId: "f", promptId: "p" }));
		const ack = await c.waitFor(m => m.t === "ack" && m.reqId === "bad");
		expect(ack).toMatchObject({ ok: false });
		expect(auth.handled).toEqual([]);
	});

	test("closing a browser tells the service (its Accounts page is gone), once", async () => {
		const auth = new RecordingAuth();
		h = await Harness.start({ repo, auth });
		const c = await h.connect();
		await c.callAuth({ t: "auth.watch", open: true });
		c.close();
		await until(() => auth.released_.length === 1);
		expect(auth.released_[0]).toBe(auth.handled[0]!.connection);
	});

	test("what the service publishes reaches every connected browser", async () => {
		const auth = new RecordingAuth();
		h = await Harness.start({ repo, auth });
		const a = await h.connect();
		const b = await h.connect();
		h.gateway.publish({ t: "auth.flow", flow: null });
		for (const c of [a, b]) await until(() => c.frames.filter(f => f.t === "auth.flow").length === 2); // the initial one and this
	});

	test("a gateway without a credential service refuses auth requests plainly", async () => {
		h = await Harness.start({ repo });
		const c = await h.connect();
		const ack = await c.callAuth({ t: "auth.watch", open: true });
		expect(ack).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
		expect(c.frames.some(f => f.t.startsWith("auth."))).toBe(false);
	});
});
