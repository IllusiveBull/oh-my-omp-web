import { useEffect } from "react";
import type { DaemonClient } from "../store/daemon-client";
import { isLooking, onLookingChange } from "./looking";
import type { SessionRef } from "./route";

/**
 * Keeps the gateway told which session this page is showing and whether the user is looking at it (visible and
 * focused; it does not push-notify a thread somebody is reading). Reports when the session opens or closes and whenever
 * that may change; `pagehide` reports not looking, `pageshow` (a page restored from the back-forward cache) the current
 * state again. The client re-sends the last report itself whenever its socket reconnects.
 */
export function usePresence(client: DaemonClient, ref: SessionRef | null): void {
	const machine = ref?.machine ?? "";
	const sessionId = ref?.id ?? null;
	useEffect(() => {
		const report = (visible: boolean): void => void client.reportView(machine, sessionId, visible);
		const reportCurrent = (): void => report(isLooking());
		const reportHidden = (): void => report(false);
		reportCurrent();
		const stop = onLookingChange(reportCurrent);
		window.addEventListener("pageshow", reportCurrent);
		window.addEventListener("pagehide", reportHidden);
		return () => {
			stop();
			window.removeEventListener("pageshow", reportCurrent);
			window.removeEventListener("pagehide", reportHidden);
		};
	}, [client, machine, sessionId]);
}
