/** In-memory stand-ins for the browser's push APIs and the gateway's push routes, shared by the push tests. */
import {
	PUSH_KEY_API,
	PUSH_SUBSCRIPTIONS_API,
	type PushSubscribeRequest,
	type PushSubscriptionInfo,
} from "@omp-web/protocol";
import {
	type PushBrowser,
	type PushDeps,
	type PushRegistrationLike,
	PushSettings,
	type PushSubscriptionLike,
	sha256Hex,
} from "../src/lib/push";

export const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const repeat = (length: number, value: number): number[] => Array.from({ length }, () => value);

export const P256DH = Buffer.from([4, ...repeat(64, 7)]).toString("base64url");
export const AUTH = Buffer.from(repeat(16, 9)).toString("base64url");
export const SERVER_KEY_BYTES = [4, ...repeat(64, 1)];
export const SERVER_KEY = Buffer.from(SERVER_KEY_BYTES).toString("base64url");

export class FakeSubscription implements PushSubscriptionLike {
	unsubscribed = false;
	constructor(
		readonly endpoint: string,
		private readonly manager: FakePushManager,
	) {}
	toJSON(): { endpoint: string; keys: Record<string, string> } {
		return { endpoint: this.endpoint, keys: { p256dh: P256DH, auth: AUTH } };
	}
	async unsubscribe(): Promise<boolean> {
		this.unsubscribed = true;
		this.manager.current = null;
		return true;
	}
}

export class FakePushManager {
	current: FakeSubscription | null = null;
	subscribeCalls: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }[] = [];
	failure: Error | null = null;
	async getSubscription(): Promise<FakeSubscription | null> {
		return this.current;
	}
	async subscribe(options: {
		userVisibleOnly: boolean;
		applicationServerKey: Uint8Array<ArrayBuffer>;
	}): Promise<FakeSubscription> {
		this.subscribeCalls.push(options);
		if (this.failure) throw this.failure;
		this.current ??= new FakeSubscription("https://push.example/endpoint-1", this);
		return this.current;
	}
}

interface Call {
	method: string;
	path: string;
	body: unknown;
}

/** The gateway's push routes, in memory. `fail` makes a route answer with that status and text. */
export class FakeGateway {
	devices: PushSubscriptionInfo[] = [];
	calls: Call[] = [];
	fail = new Map<string, { status: number; text: string }>();
	#next = 1;

	fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
		const method = init.method ?? "GET";
		const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		this.calls.push({ method, path: input, body });
		const failure = this.fail.get(
			`${method} ${input.startsWith(`${PUSH_SUBSCRIPTIONS_API}/`) ? `${PUSH_SUBSCRIPTIONS_API}/:id` : input}`,
		);
		if (failure) return new Response(failure.text, { status: failure.status });
		if (input === PUSH_KEY_API) return Response.json({ publicKey: SERVER_KEY });
		if (input === PUSH_SUBSCRIPTIONS_API && method === "GET") return Response.json(this.devices);
		if (input === PUSH_SUBSCRIPTIONS_API && method === "POST") {
			const request: PushSubscribeRequest = JSON.parse(String(init.body));
			const created: PushSubscriptionInfo = {
				id: `sub${this.#next++}`,
				label: request.label,
				endpointHash: sha256(request.endpoint),
				createdAt: 1000,
				lastDeliveredAt: null,
			};
			this.devices = [...this.devices.filter(d => d.endpointHash !== created.endpointHash), created];
			return Response.json(created, { status: 201 });
		}
		if (input.startsWith(`${PUSH_SUBSCRIPTIONS_API}/`) && method === "DELETE") {
			const id = decodeURIComponent(input.slice(PUSH_SUBSCRIPTIONS_API.length + 1));
			const known = this.devices.some(d => d.id === id);
			this.devices = this.devices.filter(d => d.id !== id);
			return new Response(null, { status: known ? 204 : 404 });
		}
		if (input.startsWith(`${PUSH_SUBSCRIPTIONS_API}/`) && input.endsWith("/test") && method === "POST") {
			const id = decodeURIComponent(input.slice(PUSH_SUBSCRIPTIONS_API.length + 1, -"/test".length));
			return new Response(null, { status: this.devices.some(d => d.id === id) ? 204 : 404 });
		}
		return new Response("no such route", { status: 404 });
	};

	/** The device list calls made so far, to check what a failing action did and did not do. */
	called(method: string, path: string): Call[] {
		return this.calls.filter(c => c.method === method && c.path === path);
	}
}

export class FakeNotification {
	permissionRequests = 0;
	/** What the next `requestPermission()` answers; it also becomes `permission`. */
	nextPermission: NotificationPermission = "granted";
	constructor(public permission: NotificationPermission) {}
	async requestPermission(): Promise<NotificationPermission> {
		this.permissionRequests++;
		this.permission = this.nextPermission;
		return this.permission;
	}
}

export class Rig {
	readonly gateway = new FakeGateway();
	readonly manager = new FakePushManager();
	readonly notification: FakeNotification;
	readonly browser: PushBrowser;
	readonly settings: PushSettings;

	constructor(overrides: Partial<PushBrowser> = {}, permission: NotificationPermission = "default") {
		this.notification = new FakeNotification(permission);
		this.browser = {
			secure: true,
			ios: false,
			userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
			notification: this.notification,
			registration: async () => ({ pushManager: this.manager }) satisfies PushRegistrationLike,
			...overrides,
		};
		const deps: PushDeps = { browser: this.browser, fetch: this.gateway.fetch, sha256Hex };
		this.settings = new PushSettings(deps);
	}

	get permissionRequests(): number {
		return this.notification.permissionRequests;
	}
}

export const rig = (overrides: Partial<PushBrowser> = {}, permission: NotificationPermission = "default"): Rig =>
	new Rig(overrides, permission);
