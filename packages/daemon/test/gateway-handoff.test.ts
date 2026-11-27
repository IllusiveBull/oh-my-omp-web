import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { Harness, makeRepo } from "./gateway-harness";

let repo: string;
let h: Harness | undefined;

beforeAll(async () => {
	repo = await makeRepo();
});
afterAll(() => {
	rmSync(dirname(repo), { recursive: true, force: true });
});
afterEach(async () => {
	await h?.stop();
	h = undefined;
});

describe("environment switch requests through the browser socket", () => {
	test("every client starts with the (empty) switch list; a plan for an unknown session answers with a blocker; start, confirm and cancel of things that do not exist are errors", async () => {
		h = await Harness.start({ repo });
		const c = await h.connect();
		await c.until(() => c.frames.some(f => f.t === "handoff.state"));
		expect(c.frames.findLast(f => f.t === "handoff.state")).toEqual({ t: "handoff.state", handoffs: [] });
		const ask = (message: Record<string, unknown>) => c.call(message as never);
		const plan = await ask({ t: "handoff.plan", sessionId: "nope", targetMachine: c.machine });
		expect(plan.ok).toBe(true);
		expect((plan.data as { blockers: string[] }).blockers).toEqual(["Unknown session."]);
		const start = await ask({
			t: "handoff.start",
			sessionId: "nope",
			targetMachine: c.machine,
			target: { mode: "new" },
		});
		expect(start).toMatchObject({ ok: false });
		expect(start.error).toContain("Unknown session.");
		expect(await ask({ t: "handoff.confirm", id: "abcdefgh12" })).toMatchObject({
			ok: false,
			error: "Unknown switch.",
		});
		expect(await ask({ t: "handoff.cancel", id: "abcdefgh12" })).toMatchObject({
			ok: false,
			error: "Unknown switch.",
		});
		expect(await ask({ t: "handoff.dismiss", id: "abcdefgh12" })).toMatchObject({
			ok: false,
			error: "Unknown switch.",
		});
		expect(await ask({ t: "handoff.confirm", id: "../x" })).toMatchObject({ ok: false });
		expect(h.gateway.handoffs()).toEqual([]);
	});

	test("a daemon without the handoff service refuses the daemon-side operations with a message, not silence", async () => {
		h = await Harness.start({ repo });
		const id = await h.createSession(await h.connect());
		const c = await h.connect();
		await c.until(() => c.frames.some(f => f.t === "sessions"));
		const plan = await c.call({ t: "handoff.plan", sessionId: id, targetMachine: c.machine } as never);
		expect(plan.ok).toBe(true);
		const blockers = (plan.data as { blockers: string[] }).blockers;
		expect(blockers.join(" ")).toContain("cannot switch environments");
	});
});
