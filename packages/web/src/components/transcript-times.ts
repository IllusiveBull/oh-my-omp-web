/**
 * Telegram-style message times for upstream's transcript.
 *
 * collab-web's `Row` puts an entry's raw timestamp (a UTC ISO string) only in the gutter's `title` and offers no prop
 * or render hook for anything else. Forking the transcript would mean carrying it through every upstream update, so a
 * MutationObserver on the container reads that attribute and, in the reader's time zone:
 *
 *  - sets `data-time` on the row's body, the gutter's sibling ("14:03:27" today, "Nov 19, 14:03:27" earlier), which CSS
 *    shows at the bottom right of the message (`attr()` reads only the pseudo-element's own element);
 *  - rewrites the gutter's tooltip to the full local date and time, keeping the raw value in `data-ts`.
 *
 * React writes `title` only when the timestamp prop changes; that write is observed and converted again. No node React
 * owns is added, moved or re-texted.
 */
import { type RefObject, useEffect } from "react";
import { formatExact, formatMessageTime } from "../lib/time";

const GUTTER = "tr-gutter";
const ELEMENT_NODE = 1;

function isGutter(node: Node): node is Element {
	return (
		node.nodeType === ELEMENT_NODE && ((node as Element).getAttribute("class") ?? "").split(/\s+/).includes(GUTTER)
	);
}

/** Localizes one gutter's timestamp; titles that are not timestamps, or already ours, are left alone. */
function localize(gutter: Element, now: number): void {
	const title = gutter.getAttribute("title");
	if (title === null || title === gutter.getAttribute("data-local")) return;
	const at = Date.parse(title);
	if (Number.isNaN(at)) return;
	const exact = formatExact(at);
	gutter.setAttribute("data-ts", title);
	gutter.setAttribute("data-local", exact);
	gutter.setAttribute("title", exact);
	gutter.nextElementSibling?.setAttribute("data-time", formatMessageTime(at, now));
}

function restore(gutter: Element): void {
	const raw = gutter.getAttribute("data-ts");
	if (raw !== null && gutter.getAttribute("title") === gutter.getAttribute("data-local"))
		gutter.setAttribute("title", raw);
	gutter.removeAttribute("data-ts");
	gutter.removeAttribute("data-local");
	gutter.nextElementSibling?.removeAttribute("data-time");
}

function scan(root: Element, now: number): void {
	if (isGutter(root)) localize(root, now);
	for (const gutter of Array.from(root.querySelectorAll(`.${GUTTER}[title]`))) localize(gutter, now);
}

/** Shows each message's time, in the reader's time zone, inside the transcript under `ref`. */
export function useTranscriptTimes(ref: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const container = ref.current;
		if (!container) return;
		const observer =
			typeof MutationObserver === "function"
				? new MutationObserver(records => {
						const now = Date.now();
						for (const record of records) {
							if (record.type === "attributes") {
								if (isGutter(record.target)) localize(record.target, now);
								continue;
							}
							for (const added of Array.from(record.addedNodes)) {
								if (added.nodeType === ELEMENT_NODE) scan(added as Element, now);
							}
						}
					})
				: null;
		observer?.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
		scan(container, Date.now());
		return () => {
			observer?.disconnect();
			for (const gutter of Array.from(container.querySelectorAll(`.${GUTTER}[data-ts]`))) restore(gutter);
		};
	}, [ref]);
}
