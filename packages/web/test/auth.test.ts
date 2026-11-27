import { describe, expect, test } from "bun:test";
import { SESSION_API } from "@omp-web/protocol";
import { probeSession } from "../src/lib/auth";

const respond = (status: number) => async (): Promise<Response> => new Response(null, { status });

describe("probeSession", () => {
	test("only a 401 means the session is gone", async () => {
		expect(await probeSession(respond(401))).toBe("expired");
		expect(await probeSession(respond(204))).toBe("valid");
		expect(await probeSession(respond(502))).toBe("unreachable");
		expect(
			await probeSession(async () => {
				throw new TypeError("network down");
			}),
		).toBe("unreachable");
	});

	test("asks the session endpoint with the cookie and without caches", async () => {
		const calls: [string, RequestInit | undefined][] = [];
		await probeSession(async (input, init) => {
			calls.push([input, init]);
			return new Response(null, { status: 204 });
		});
		expect(calls).toEqual([[SESSION_API, { credentials: "same-origin", cache: "no-store" }]]);
	});
});
