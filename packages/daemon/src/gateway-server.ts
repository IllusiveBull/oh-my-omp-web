import { join, normalize, sep } from "node:path";
import {
	AUTH_COOKIE,
	BROWSER_WS_PATH,
	ENV_WS_PATH,
	LOGIN_API,
	LOGIN_PREFIX,
	LOGOUT_API,
	MACHINES_API,
	MACHINE_NICKNAME_MAX,
	PUSH_KEY_API,
	PUSH_SUBSCRIPTIONS_API,
	SESSION_API,
} from "@omp-web/protocol";
import type { GatewayStore } from "./db";
import { BrowserConn, type Gateway, type GatewayHeartbeat } from "./gateway";
import { EnvAcceptor } from "./gateway-link";
import type { LinkEnd } from "./link-end";
import { parseSubscribeRequest, subscriptionInfo } from "./push/subscriptions";
import { secretsEqual, type MachineKeys } from "./secrets";

export interface GatewayServerOptions {
	gateway: Gateway;
	store: GatewayStore;
	keys: MachineKeys;
	/** The single-user token a browser exchanges for a session cookie. */
	token: string;
	/** Address to listen on; the caller has already checked it against the token (see `assertBindAllowed`). */
	bind: string;
	port: number;
	/** Built web assets: the app at the root, the login page under `login/`. */
	webDir: string;
	/** Extra browser origins allowed to open the WebSocket and to post (same-origin is always allowed). */
	allowedOrigins?: string[];
	heartbeat?: GatewayHeartbeat;
	handshakeTimeoutMs?: number;
	/** How long a login lasts. Default 30 days. */
	sessionTtlMs?: number;
	/** Pause after a wrong token, to make guessing slow. Default 250 ms. */
	loginFailureDelayMs?: number;
	/**
	 * Web Push: the VAPID public key `GET /api/push/key` serves, and how a test notification is sent to one device.
	 * Without it the push routes answer 404.
	 */
	push?: { publicKey: string; test(id: string): Promise<"delivered" | "gone" | "failed" | "unknown"> };
}

export type GatewaySocketData =
	| { kind: "browser"; conn: BrowserConn | null; cookie: string | undefined }
	| { kind: "env"; acceptor: EnvAcceptor | null };

const MIME: Record<string, string> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	json: "application/json",
	svg: "image/svg+xml",
	png: "image/png",
	ico: "image/x-icon",
	webmanifest: "application/manifest+json",
};

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_BODY = 4096;
const MAX_SUBSCRIBE_BODY = 8 * 1024;
/** Served without a login: they must load before one exists (install prompts fetch them without credentials). */
const PUBLIC_ASSET = /^\/(manifest\.json|apple-touch-icon\.png|icon-[\w-]+\.png)$/;

function readCookie(req: Request, name: string): string | undefined {
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

/** Names a login in logs without revealing it: a prefix of the hash that the database stores instead of the cookie. */
const loginId = (cookie: string): string => new Bun.CryptoHasher("sha256").update(cookie).digest("hex").slice(0, 12);

const isHttps = (req: Request, url: URL): boolean =>
	url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
	return `${AUTH_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** Serves `rel` from `root`; an extensionless path that does not exist is a client-side route and gets `fallback` (a file under `root`). */
async function serveFrom(root: string, rel: string, fallback: string | null): Promise<Response> {
	let relative = normalize(rel).replace(/^[/\\]+/, "");
	if (relative === "") relative = fallback ?? "index.html";
	let file = join(root, relative);
	if (file !== root && !file.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
	let handle = Bun.file(file);
	if (!(await handle.exists())) {
		if (relative.includes(".") || fallback === null) return new Response("not found", { status: 404 });
		file = join(root, fallback);
		handle = Bun.file(file);
		if (!(await handle.exists())) return new Response("not found", { status: 404 });
	}
	const ext = file.split(".").pop() ?? "";
	return new Response(handle, { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
}

/** Adapts a Bun server socket to the gateway's link interface. */
function serverLink(ws: Bun.ServerWebSocket<GatewaySocketData>): LinkEnd {
	return {
		send: text => void ws.send(text),
		bufferedAmount: () => ws.getBufferedAmount(),
		close: (code, reason) => ws.close(code, reason),
		terminate: () => ws.terminate(),
	};
}

/**
 * The gateway's HTTP/WebSocket listener. Every route requires the session cookie except the login endpoint, the login
 * page and its assets, the manifest and the icons; `/env` is the daemons' registration endpoint (pre-shared key, no
 * browsers). Requests without a valid cookie get 401, and for page navigations the body is the login page.
 */
export function startGatewayServer(options: GatewayServerOptions): Bun.Server<GatewaySocketData> {
	const { gateway, store, webDir } = options;
	const loginDir = join(webDir, "login");
	const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
	const failureDelayMs = options.loginFailureDelayMs ?? 250;

	const authed = (req: Request): boolean => {
		const cookie = readCookie(req, AUTH_COOKIE);
		return cookie !== undefined && store.authSessionValid(cookie);
	};

	/** The browser's own origin as the page saw it (behind `tailscale serve` the proxy terminates TLS). */
	const originAllowed = (req: Request, url: URL): boolean => {
		const origin = req.headers.get("origin");
		// Non-browser clients send no Origin. Browsers always do: without this check any web page could drive the
		// gateway through a cross-site WebSocket or form post.
		if (origin === null) return true;
		const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
		const host = req.headers.get("host") ?? url.host;
		return origin === `${proto}://${host}` || (options.allowedOrigins?.includes(origin) ?? false);
	};

	const loginPage = async (status: number): Promise<Response> => {
		const page = Bun.file(join(loginDir, "index.html"));
		if (!(await page.exists())) {
			return new Response("unauthorized (the login page is not built: run `bun run build`)", { status });
		}
		return new Response(page, { status, headers: { "content-type": MIME.html!, "cache-control": "no-store" } });
	};

	const isNavigation = (req: Request, url: URL): boolean =>
		req.method === "GET" &&
		!url.pathname.startsWith("/api/") &&
		url.pathname !== BROWSER_WS_PATH &&
		(req.headers.get("sec-fetch-dest") === "document" ||
			(req.headers.get("accept") ?? "").includes("text/html") ||
			!url.pathname.split("/").at(-1)!.includes("."));

	const unauthorized = (req: Request, url: URL): Promise<Response> | Response =>
		isNavigation(req, url) ? loginPage(401) : Response.json({ error: "unauthorized" }, { status: 401 });

	const login = async (req: Request, url: URL): Promise<Response> => {
		if (!originAllowed(req, url)) return new Response("forbidden origin", { status: 403 });
		const body = await req.text();
		let token: unknown;
		try {
			token = body.length <= MAX_LOGIN_BODY ? (JSON.parse(body) as { token?: unknown }).token : undefined;
		} catch {
			token = undefined;
		}
		if (typeof token !== "string" || !secretsEqual(token, options.token)) {
			await Bun.sleep(failureDelayMs);
			return Response.json({ error: "wrong token" }, { status: 401 });
		}
		const cookie = store.createAuthSession(sessionTtlMs);
		return new Response(null, {
			status: 204,
			headers: { "set-cookie": sessionCookie(cookie, Math.floor(sessionTtlMs / 1000), isHttps(req, url)) },
		});
	};

	const logout = (req: Request, url: URL): Response => {
		if (!originAllowed(req, url)) return new Response("forbidden origin", { status: 403 });
		const cookie = readCookie(req, AUTH_COOKIE);
		if (cookie !== undefined) {
			store.deleteAuthSession(cookie);
			gateway.revokeLogin(loginId(cookie));
		}
		return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie("", 0, isHttps(req, url)) } });
	};

	/** The request body as text; null when it is larger than `limit` bytes (nothing beyond the limit is buffered). */
	const readBounded = async (req: Request, limit: number): Promise<string | null> => {
		if (Number(req.headers.get("content-length") ?? 0) > limit) return null;
		const chunks: Uint8Array[] = [];
		let size = 0;
		if (req.body !== null) {
			for await (const chunk of req.body) {
				size += chunk.byteLength;
				if (size > limit) return null;
				chunks.push(chunk);
			}
		}
		return Buffer.concat(chunks).toString("utf8");
	};

	/** `/api/push/*`: the VAPID key and the device list. Already authenticated; writes also pass the Origin check. */
	const pushRoute = async (req: Request, url: URL): Promise<Response> => {
		const { push } = options;
		const path = url.pathname;
		if (push === undefined) return Response.json({ error: "push is not configured" }, { status: 404 });
		const writes = req.method === "POST" || req.method === "DELETE";
		if (writes && !originAllowed(req, url)) return new Response("forbidden origin", { status: 403 });
		if (path === PUSH_KEY_API && req.method === "GET") return Response.json({ publicKey: push.publicKey });
		if (path === PUSH_SUBSCRIPTIONS_API && req.method === "GET") {
			return Response.json(store.pushSubscriptions().map(subscriptionInfo));
		}
		if (path === PUSH_SUBSCRIPTIONS_API && req.method === "POST") {
			const text = await readBounded(req, MAX_SUBSCRIBE_BODY);
			if (text === null) return Response.json({ error: "body too large" }, { status: 413 });
			const parsed = parseSubscribeRequest(text);
			if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
			const row = store.addPushSubscription({
				endpoint: parsed.endpoint,
				p256dh: parsed.keys.p256dh,
				auth: parsed.keys.auth,
				label: parsed.label,
			});
			return Response.json(subscriptionInfo(row), { status: 201 });
		}
		const prefix = `${PUSH_SUBSCRIPTIONS_API}/`;
		if (path.startsWith(prefix) && path.endsWith("/test") && req.method === "POST") {
			const result = await push.test(path.slice(prefix.length, -"/test".length));
			if (result === "delivered") return new Response(null, { status: 204 });
			if (result === "unknown") return Response.json({ error: "unknown subscription" }, { status: 404 });
			if (result === "gone")
				return Response.json({ error: "the push service no longer knows this device" }, { status: 410 });
			return Response.json({ error: "the push service did not accept the message" }, { status: 502 });
		}
		if (path.startsWith(prefix) && req.method === "DELETE") {
			return store.deletePushSubscription(path.slice(prefix.length))
				? new Response(null, { status: 204 })
				: Response.json({ error: "unknown subscription" }, { status: 404 });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	};

	const serveApp = (path: string): Promise<Response> | Response => {
		try {
			return serveFrom(webDir, decodeURIComponent(path), "index.html");
		} catch {
			return new Response("bad request", { status: 400 });
		}
	};

	return Bun.serve<GatewaySocketData>({
		hostname: options.bind,
		port: options.port,
		async fetch(req, srv) {
			const url = new URL(req.url);
			const path = url.pathname;
			if (path === ENV_WS_PATH) {
				// Daemons are not browsers; a browser page opening this socket is a cross-site attempt.
				if (req.headers.has("origin")) return new Response("forbidden", { status: 403 });
				return srv.upgrade(req, { data: { kind: "env", acceptor: null } satisfies GatewaySocketData })
					? undefined
					: new Response("upgrade failed", { status: 400 });
			}
			if (path === LOGIN_API && req.method === "POST") return login(req, url);
			if (path === LOGOUT_API && req.method === "POST") return logout(req, url);
			if (path === LOGIN_PREFIX || path.startsWith(`${LOGIN_PREFIX}/`)) {
				if (path === LOGIN_PREFIX || path === `${LOGIN_PREFIX}/`) return loginPage(200);
				return serveFrom(loginDir, decodeURIComponent(path.slice(LOGIN_PREFIX.length)), null);
			}
			if (PUBLIC_ASSET.test(path)) return serveApp(path);
			if (!authed(req)) return unauthorized(req, url);
			if (path === SESSION_API) return new Response(null, { status: 204 });
			if (path.startsWith(`${MACHINES_API}/`)) {
				if (!originAllowed(req, url)) return new Response("forbidden origin", { status: 403 });
				if (req.method !== "PATCH") return new Response(null, { status: 405 });
				const text = await readBounded(req, 4096);
				if (text === null) return Response.json({ error: "body too large" }, { status: 413 });
				let body: unknown;
				try {
					body = JSON.parse(text);
				} catch {
					return Response.json({ error: "invalid JSON" }, { status: 400 });
				}
				const nickname = body && typeof body === "object" && "nickname" in body ? body.nickname : undefined;
				if (typeof nickname !== "string" || nickname.trim().length > MACHINE_NICKNAME_MAX) {
					return Response.json(
						{ error: `nickname must be a string of at most ${MACHINE_NICKNAME_MAX} characters` },
						{ status: 400 },
					);
				}
				let id: string;
				try {
					id = decodeURIComponent(path.slice(MACHINES_API.length + 1));
				} catch {
					return Response.json({ error: "invalid machine id" }, { status: 400 });
				}
				return gateway.setMachineNickname(id, nickname.trim() || null)
					? new Response(null, { status: 204 })
					: Response.json({ error: "unknown machine" }, { status: 404 });
			}
			if (
				path === PUSH_KEY_API ||
				path === PUSH_SUBSCRIPTIONS_API ||
				path.startsWith(`${PUSH_SUBSCRIPTIONS_API}/`)
			) {
				return pushRoute(req, url);
			}
			if (path === BROWSER_WS_PATH) {
				if (!originAllowed(req, url)) return new Response("forbidden origin", { status: 403 });
				return srv.upgrade(req, {
					data: { kind: "browser", conn: null, cookie: readCookie(req, AUTH_COOKIE) } satisfies GatewaySocketData,
				})
					? undefined
					: new Response("upgrade failed", { status: 400 });
			}
			return serveApp(path);
		},
		websocket: {
			maxPayloadLength: 16 * 1024 * 1024,
			open(ws) {
				if (ws.data.kind === "browser") {
					const cookie = ws.data.cookie;
					ws.data.conn = gateway.attachBrowser(
						{
							send: text => ws.send(text),
							getBufferedAmount: () => ws.getBufferedAmount(),
							close: (code, reason) => ws.close(code, reason),
							terminate: () => ws.terminate(),
						},
						cookie === undefined
							? undefined
							: { id: loginId(cookie), valid: () => store.authSessionValid(cookie) },
					);
					return;
				}
				ws.data.acceptor = new EnvAcceptor({
					gateway,
					keys: options.keys,
					link: serverLink(ws),
					heartbeat: options.heartbeat,
					handshakeTimeoutMs: options.handshakeTimeoutMs,
				});
				ws.data.acceptor.start();
			},
			drain(ws) {
				if (ws.data.kind === "browser") ws.data.conn?.drain();
			},
			message(ws, data) {
				if (typeof data !== "string") return; // every frame of both protocols is text
				if (ws.data.kind === "browser") void ws.data.conn?.receive(data);
				else void ws.data.acceptor?.receive(data);
			},
			close(ws) {
				if (ws.data.kind === "browser") {
					if (ws.data.conn) gateway.detachBrowser(ws.data.conn);
				} else {
					ws.data.acceptor?.closed();
				}
			},
		},
	});
}
