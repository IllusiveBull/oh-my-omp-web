/**
 * Whether the user is looking at this page: it is visible and its window has focus. Visibility alone is not enough: on
 * macOS a window behind others stays `visible` while any part of it shows, so a session open in a background window
 * would never be notified about, and its notifications would be closed as soon as they appeared.
 */
export const isLooking = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/** Calls `listener` whenever {@link isLooking} may have changed; returns the function that stops it. */
export function onLookingChange(listener: () => void): () => void {
	document.addEventListener("visibilitychange", listener);
	window.addEventListener("focus", listener);
	window.addEventListener("blur", listener);
	return () => {
		document.removeEventListener("visibilitychange", listener);
		window.removeEventListener("focus", listener);
		window.removeEventListener("blur", listener);
	};
}
