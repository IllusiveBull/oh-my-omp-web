/**
 * Keeps upstream's transcript at its tail when its viewport shrinks or its rows grow, and tells when the reader, away
 * from the tail, has unread activity below.
 *
 * collab-web's `Transcript` follows the tail only when entries, the stream or tools change. Two things move the bottom
 * without any of those changing:
 *
 *  - the panels below it (todos, notices, queue, attention, a growing composer) take height from it; most visibly after
 *    a reload, where the todos arrive with the status after the transcript has already scrolled to the bottom, and so
 *    covered its last lines;
 *  - rows grow after that scroll: the message times (`transcript-times.ts`) are set by a MutationObserver once the rows
 *    have mounted, adding a line under each message, so a session opened at its tail ended a little above it.
 *
 * A ResizeObserver on the container and on each row of `.tr-root` scrolls it back to the bottom while the reader follows
 * the tail. Rows are picked up as they mount by MutationObservers on the container (`.tr-root` itself is replaced while
 * the session loads) and on `.tr-root`'s own child list.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

const SCROLLER = "tr-root";
/** Upstream's tail lock: within this distance of the bottom counts as at the bottom. */
const TAIL_PX = 40;

export interface TranscriptTail {
	/** The reader left the tail and `activity` grew since. */
	unread: boolean;
	/** Scrolls to the bottom; following resumes on arrival. */
	jump(): void;
}

/**
 * Re-pins the transcript under `ref` to its tail across viewport and row resizes while the reader is at the tail.
 * `activity` is any count that grows with new content (entries, a stream): growth while the reader is away is unread.
 */
export function useTranscriptTail(ref: RefObject<HTMLElement | null>, activity = 0): TranscriptTail {
	// The activity when the reader left the tail; null while following.
	const [leftAt, setLeftAt] = useState<number | null>(null);
	const latest = useRef(activity);
	latest.current = activity;

	useEffect(() => {
		const container = ref.current;
		if (!container || typeof ResizeObserver !== "function") return;
		let following = true;
		let lastTop = 0;
		const follow = (next: boolean): void => {
			if (next === following) return;
			following = next;
			setLeftAt(next ? null : latest.current);
		};
		// Scroll does not bubble: capture it from the scroller inside. A scroll event is dispatched a frame after the
		// scroll, so the geometry it reads may already include rows that grew since: the tail scroll that preceded a
		// growth then reads as "away from the tail". Only scrolling up leaves the tail; reaching it rejoins.
		const onScroll = (event: Event): void => {
			const target = event.target as Element;
			if (!target.classList?.contains(SCROLLER)) return;
			if (target.scrollHeight - target.scrollTop - target.clientHeight <= TAIL_PX) follow(true);
			else if (target.scrollTop < lastTop) follow(false);
			lastTop = target.scrollTop;
		};
		const resizes = new ResizeObserver(() => {
			const scroller = container.querySelector(`.${SCROLLER}`);
			if (scroller && following) scroller.scrollTop = scroller.scrollHeight;
		});
		resizes.observe(container);
		const rows =
			typeof MutationObserver === "function"
				? new MutationObserver(records => {
						for (const record of records) {
							for (const removed of Array.from(record.removedNodes)) {
								if (removed instanceof Element) resizes.unobserve(removed);
							}
							for (const added of Array.from(record.addedNodes)) {
								if (added instanceof Element) resizes.observe(added);
							}
						}
					})
				: null;
		let scroller: Element | null = null;
		const watchScroller = (): void => {
			const next = container.querySelector(`.${SCROLLER}`);
			if (next === scroller) return;
			rows?.disconnect();
			for (const row of Array.from(scroller?.children ?? [])) resizes.unobserve(row);
			scroller = next;
			lastTop = 0;
			if (!scroller) return;
			rows?.observe(scroller, { childList: true });
			for (const row of Array.from(scroller.children)) resizes.observe(row);
		};
		const scrollers = typeof MutationObserver === "function" ? new MutationObserver(watchScroller) : null;
		scrollers?.observe(container, { childList: true });
		watchScroller();
		container.addEventListener("scroll", onScroll, true);
		return () => {
			container.removeEventListener("scroll", onScroll, true);
			scrollers?.disconnect();
			rows?.disconnect();
			resizes.disconnect();
		};
	}, [ref]);

	const jump = useCallback((): void => {
		const scroller = ref.current?.querySelector(`.${SCROLLER}`);
		const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
	}, [ref]);

	return { unread: leftAt !== null && activity > leftAt, jump };
}
