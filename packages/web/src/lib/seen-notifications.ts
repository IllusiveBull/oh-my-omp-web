import { useEffect } from "react";
import { isLooking, onLookingChange } from "./looking";

/** The part of `ServiceWorkerRegistration` used to find this device's notifications. */
export interface NotificationHost {
	getNotifications(filter: { tag: string }): Promise<readonly { close(): void }[]>;
}

/** Resolves the active registration; null when service workers are missing. */
export type NotificationHostSource = () => Promise<NotificationHost> | null;

export const serviceWorkerHost: NotificationHostSource = () =>
	typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker.ready : null;

/** Closes this device's notifications of the thread (they are tagged with the thread id); resolves to how many. */
export async function closeThreadNotifications(host: NotificationHost, threadId: string): Promise<number> {
	const open = await host.getNotifications({ tag: threadId });
	for (const notification of open) notification.close();
	return open.length;
}

/**
 * While a thread is open in a page the user is looking at (visible and focused), its notifications on this device are
 * stale: closes them when the thread opens or changes and whenever the user comes back to the page. Best effort:
 * without a service worker, or when it cannot be reached, there is nothing to close.
 */
export function useCloseSeenNotifications(
	threadId: string | undefined,
	source: NotificationHostSource = serviceWorkerHost,
): void {
	useEffect(() => {
		if (threadId === undefined) return;
		const close = (): void => {
			if (!isLooking()) return;
			source()
				?.then(host => closeThreadNotifications(host, threadId))
				.catch(() => {});
		};
		close();
		return onLookingChange(close);
	}, [threadId, source]);
}
