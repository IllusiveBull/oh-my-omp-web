import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { MACHINES_API, MACHINE_NICKNAME_MAX } from "@omp-web/protocol";
import { Harness, SELF, makeRepo } from "./gateway-harness";

let repo: string;
let h: Harness;
let cookie: string;
beforeAll(async () => {
	repo = await makeRepo();
});
afterAll(() => rmSync(dirname(repo), { recursive: true, force: true }));
beforeEach(async () => {
	h = await Harness.start({ repo });
	cookie = await h.login();
});
afterEach(async () => {
	await h.stop();
});

const patch = (body: unknown, headers: Record<string, string> = {}, id = SELF): Promise<Response> =>
	fetch(`${h.http}${MACHINES_API}/${id}`, {
		method: "PATCH",
		headers: { cookie, "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

test("requires login and same origin without changing the name on rejection", async () => {
	expect((await patch({ nickname: "Desk" }, { cookie: "" })).status).toBe(401);
	expect((await patch({ nickname: "Desk" }, { origin: "https://evil.example" })).status).toBe(403);
	expect(h.gateway.nameOf(SELF)).toBe("gateway-box");
	expect((await patch({ nickname: "Desk" }, { origin: h.http })).status).toBe(204);
	expect(h.gateway.nameOf(SELF)).toBe("Desk");
});

test("trims unicode nicknames, preserves identity, and clears to the registered name", async () => {
	expect((await patch({ nickname: "  工作电脑  " })).status).toBe(204);
	expect(h.gateway.machines()[0]).toMatchObject({ id: SELF, name: "工作电脑", originalName: "gateway-box" });
	expect((await patch({ nickname: "   " })).status).toBe(204);
	expect(h.gateway.machines()[0]!.name).toBe("gateway-box");
	expect(h.gateway.machines()[0]!.originalName).toBeUndefined();
});

test("rejects invalid values and unknown machines without overwriting the saved nickname", async () => {
	await patch({ nickname: "Desk" });
	for (const body of [null, {}, { nickname: 7 }, { nickname: "x".repeat(MACHINE_NICKNAME_MAX + 1) }]) {
		expect((await patch(body)).status).toBe(400);
	}
	expect((await patch({ nickname: "New" }, {}, "missing")).status).toBe(404);
	expect((await patch({ nickname: "x".repeat(5000) })).status).toBe(413);
	expect(h.gateway.nameOf(SELF)).toBe("Desk");
});
