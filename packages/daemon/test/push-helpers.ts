import type { SessionInfo } from "@omp-web/protocol";
import { GatewayStore } from "../src/db";
import {
	decryptPayload,
	fromBase64Url,
	generateSubscriptionKeys,
	type Bytes,
	type SubscriptionKeys,
} from "../src/push/encrypt";

/** A device: the keys the browser would hold plus the subscription the gateway stores for it. */
export interface TestDevice {
	keys: SubscriptionKeys;
	endpoint: string;
}

export async function makeDevice(endpoint: string): Promise<TestDevice> {
	return { keys: await generateSubscriptionKeys(), endpoint };
}

export const subscribeBody = (device: TestDevice, label = "phone") => ({
	endpoint: device.endpoint,
	keys: { p256dh: device.keys.p256dh, auth: device.keys.auth },
	label,
});

export interface PushRequest {
	url: string;
	headers: Headers;
	body: Bytes;
	redirect: RequestInit["redirect"];
}

export interface FakePushService {
	requests: PushRequest[];
	fetch: typeof fetch;
}

/** A fake push service: records what it was sent and answers with the status `respond(url)` returns. */
export function fakePushService(respond: (url: string) => number = () => 201): FakePushService {
	const requests: PushRequest[] = [];
	// the fake is a plain function; `typeof fetch` also has Bun's `preconnect`, which nothing here calls
	const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		requests.push({
			url,
			headers: new Headers(init?.headers),
			body: init?.body instanceof Uint8Array ? new Uint8Array(init.body) : new Uint8Array(),
			redirect: init?.redirect,
		});
		return new Response(null, { status: respond(url) });
	}) as typeof fetch;
	return { requests, fetch: fetchFake };
}

/** The JSON a device decrypts out of a request it received. */
export async function openRequest(request: PushRequest, device: TestDevice): Promise<unknown> {
	const plain = await decryptPayload(request.body, {
		privateKey: device.keys.privateKey,
		publicKey: device.keys.publicKey,
		auth: fromBase64Url(device.keys.auth)!,
	});
	return JSON.parse(new TextDecoder().decode(plain));
}

/** An in-memory store holding machine `m1` with the sessions `ids`; returns each session's thread id. */
export function storeWithSessions(
	ids: string[],
	now?: () => number,
): { store: GatewayStore; threads: Record<string, string> } {
	const store = GatewayStore.open(":memory:", { now });
	store.upsertMachine({
		id: "m1",
		name: "box",
		platform: "linux",
		daemonVersion: "1",
		omp: { version: "1.0.0", expectedVersion: "1.0.0", versionMismatch: false },
		leaseWarnings: [],
		lastSeen: 100,
	});
	const infos = ids.map((id): SessionInfo => ({
		id,
		sessionId: id,
		access: "free",
		cwd: "/p",
		phase: "stored",
		createdAt: 1,
		modifiedAt: 10,
		files: 1,
		aliases: [],
	}));
	const threads: Record<string, string> = {};
	for (const s of store.syncSessions("m1", infos)) threads[s.id] = s.threadId;
	return { store, threads };
}
