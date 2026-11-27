import type { GatewayStore } from "../db";
import { PushNotifier, type PushNotifierOptions } from "./notifier";
import { PushSender } from "./sender";
import { loadVapid } from "./vapid";

export interface PushOptions {
	store: GatewayStore;
	/** Where `vapid.json` lives. */
	configDir: string;
	/** `mailto:` or `https:` contact for the push services. */
	subject: string;
	isViewed: PushNotifierOptions["isViewed"];
	machineName: PushNotifierOptions["machineName"];
	fetch?: typeof fetch;
}

/** Loads (or creates) the VAPID identity and builds the notifier; `publicKey` is what `GET /api/push/key` serves. */
export async function createPush(options: PushOptions): Promise<{ notifier: PushNotifier; publicKey: string }> {
	const vapid = await loadVapid(options.configDir);
	const sender = new PushSender({ vapid, subject: options.subject, store: options.store, fetch: options.fetch });
	const notifier = new PushNotifier({
		store: options.store,
		sender,
		isViewed: options.isViewed,
		machineName: options.machineName,
	});
	return { notifier, publicKey: vapid.publicKey };
}

export { PushNotifier } from "./notifier";
export { PushSender } from "./sender";
