/** Gateway HTTP surface for authentication; the browser and the gateway must agree on these. */
export const AUTH_COOKIE = "omp_web_session";
/** `POST {token}` (JSON): sets the session cookie. 204 on success, 401 on a wrong token. */
export const LOGIN_API = "/api/login";
/** `POST`: deletes the session and clears the cookie. Always 204. */
export const LOGOUT_API = "/api/logout";
/** `GET`: 204 when the request carries a valid session cookie, 401 otherwise. */
export const SESSION_API = "/api/session";
/** Everything under this prefix, and the login page itself, is served without a session. */
export const LOGIN_PREFIX = "/login";
/** WebSocket path of browsers (cookie required). */
export const BROWSER_WS_PATH = "/ws";
/** WebSocket path of environment daemons registering with their pre-shared key. */
export const ENV_WS_PATH = "/env";
/** `GET`: the VAPID public key (a `PushKeyResponse`). Cookie required, like everything but the login page. */
export const PUSH_KEY_API = "/api/push/key";
/**
 * `GET` lists the devices (`PushSubscriptionInfo[]`), `POST` adds one (`PushSubscribeRequest`), `DELETE <path>/<id>` revokes,
 * `POST <path>/<id>/test` sends that device a test notification: 204 when the push service accepted it, 404 for an unknown
 * device, 410 when the push service no longer knows it (the gateway removed it), 502 for any other failure.
 */
export const PUSH_SUBSCRIPTIONS_API = "/api/push/subscriptions";
/** `PATCH <path>/<machine id> {nickname: string}`: empty/whitespace restores the registered name. */
export const MACHINES_API = "/api/machines";
export const MACHINE_NICKNAME_MAX = 80;
