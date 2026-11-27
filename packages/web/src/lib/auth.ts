import { SESSION_API } from "@omp-web/protocol";

/** What `GET /api/session` says about the cookie: usable, rejected by the gateway, or no answer (network, 5xx). */
export type SessionCheck = "valid" | "expired" | "unreachable";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A 401 is the only proof that the session is gone; anything else means "try again later". */
export async function probeSession(doFetch: Fetch = fetch): Promise<SessionCheck> {
	try {
		const res = await doFetch(SESSION_API, { credentials: "same-origin", cache: "no-store" });
		if (res.status === 401) return "expired";
		return res.ok ? "valid" : "unreachable";
	} catch {
		return "unreachable";
	}
}
