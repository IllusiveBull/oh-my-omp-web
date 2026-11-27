import { createRoot } from "react-dom/client";
import { App } from "./app";
import { exposeTerminals } from "./components/terminal/debug";
import { initializeTheme } from "./components/theme-toggle";
import { routeOfOpenMessage } from "./lib/push-message";
import { notificationSounds } from "./lib/notification-sound";
import { DaemonClient } from "./store/daemon-client";
import "@oh-my-pi/collab-web/src/styles/tokens.css";
import "@oh-my-pi/collab-web/src/styles/base.css";
import "./styles/theme.css";
import "./styles/ui.css";
import "./styles/app.css";
import "./styles/shell.css";
import "./styles/gateway.css";
import "./styles/accounts.css";
import "./styles/files.css";
import "./styles/handoff.css";
import "./styles/terminal.css";
import "@xterm/xterm/css/xterm.css";

initializeTheme();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
notificationSounds.initialize();
const client = new DaemonClient(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`, {
	onSound: notificationSounds.play,
});
client.connect();
// Debug handle exposing session stores for inspection; only enabled with `?debug`.
if (new URLSearchParams(location.search).has("debug")) {
	Object.assign(window, { __ompClient: client });
	exposeTerminals(client);
}
createRoot(root).render(<App client={client} />);

if ("serviceWorker" in navigator) {
	// A new SW claims clients immediately; reload once so the page never keeps running stale JS.
	let hadController = navigator.serviceWorker.controller !== null;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!hadController) {
			hadController = true; // first install claiming this page: nothing stale to replace
			return;
		}
		location.reload();
	});
	// A clicked push notification asks the page it focused to show its session.
	navigator.serviceWorker.addEventListener("message", event => {
		const route = routeOfOpenMessage(event.data);
		if (route !== null) location.hash = route;
	});
	const registration = navigator.serviceWorker.register("/sw.js", { scope: "/" });
	registration.catch(err => console.warn("service worker registration failed", err));
	// The browser looks for a new sw.js only when a page loads, so a page left open (an installed PWA above all) kept
	// the old build across deploys. A deploy restarts the gateway: every reconnect's new `hello` asks now. A changed
	// sw.js installs, claims this page, and the controllerchange handler above reloads it; an unchanged one costs a fetch.
	let hello = client.getSnapshot().hello;
	client.subscribe(() => {
		const next = client.getSnapshot().hello;
		if (next === hello) return;
		const reconnected = hello !== null;
		hello = next;
		if (reconnected && next !== null) void registration.then(r => r.update()).catch(() => {});
	});
}
