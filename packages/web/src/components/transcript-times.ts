/**
 * Telegram-style message times and per-message copy button for upstream's transcript.
 *
 * collab-web's `Row` puts an entry's raw timestamp (a UTC ISO string) only in the gutter's `title` and offers no prop
 * or render hook for anything else. Forking the transcript would mean carrying it through every upstream update, so a
 * MutationObserver on the container reads that attribute and, in the reader's time zone:
 *
 *  - rewrites the gutter's tooltip to the full local date and time, keeping the raw value in `data-ts`;
 *  - appends a quiet `.tr-meta` footer to each message row's `.tr-body` (user, assistant, custom) holding the local
 *    time ("14:03:27" today, "Nov 19, 14:03:27" earlier) and, when the message has text, a copy button beside it.
 *
 * Copy prefers the raw Markdown text of the matching `SessionEntry` (positionally aligned from the tail of `entries`
 * to handle upstream's windowing and verified against the entry's timestamp), falling back to the rendered `.tr-md`
 * text when `entries` is omitted.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { type RefObject, useEffect, useRef } from "react";
import { copyText } from "../lib/accounts";
import { formatExact, formatMessageTime } from "../lib/time";

const GUTTER = "tr-gutter";
const META = "tr-meta";
const TIME = "tr-time";
const COPY = "tr-copy";
const ELEMENT_NODE = 1;
const SVG_NS = "http://www.w3.org/2000/svg";
const MESSAGE_ROWS = new Set(["tr-row--user", "tr-row--assistant", "tr-row--custom"]);
const COPY_RESET_MS = 1500;
const FAIL_RESET_MS = 2000;

function classesOf(node: Node): string[] {
	if (node.nodeType !== ELEMENT_NODE) return [];
	return ((node as Element).getAttribute("class") ?? "").split(/\s+/);
}

function hasClass(node: Node, className: string): boolean {
	return classesOf(node).includes(className);
}

function isMessageRow(node: Node | null): node is Element {
	if (!node || node.nodeType !== ELEMENT_NODE) return false;
	return classesOf(node).some(c => MESSAGE_ROWS.has(c));
}

function isInsideMeta(node: Node | null, container: Node): boolean {
	for (let at = node; at && at !== container; at = at.parentNode) {
		if (hasClass(at, META)) return true;
	}
	return false;
}

function closestWithClass(node: Node | null, className: string, container: Node): Element | null {
	for (let at = node; at && at !== container; at = at.parentNode) {
		if (hasClass(at, className)) return at as Element;
	}
	return null;
}

/** The `.tr-body` sibling of a `.tr-gutter` (works in both browsers and the fake DOM shim). */
function bodyOf(gutter: Element): Element | null {
	if (gutter.nextElementSibling) return gutter.nextElementSibling;
	for (let node = gutter.nextSibling; node; node = node.nextSibling) {
		if (node.nodeType === ELEMENT_NODE) return node as Element;
	}
	return null;
}

function isMessageRowEntry(entry: SessionEntry): boolean {
	if (entry.type === "message") {
		return entry.message.role === "user" || entry.message.role === "assistant";
	}
	if (entry.type === "custom_message") {
		return entry.customType === "collab-prompt" || entry.display;
	}
	return false;
}

/** The raw message text of a transcript entry for the copy button, or null when it has none. */
export function entryCopyText(entry: SessionEntry): string | null {
	if (entry.type === "message") {
		if (entry.message.role === "user") {
			const { content } = entry.message;
			const text =
				typeof content === "string"
					? content
					: content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n");
			return text.trim() ? text : null;
		}
		if (entry.message.role === "assistant") {
			const text = entry.message.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n\n")
				.trim();
			return text || null;
		}
		return null;
	}
	if (entry.type === "custom_message" && (entry.customType === "collab-prompt" || entry.display)) {
		const { content } = entry;
		const text =
			typeof content === "string"
				? content
				: content
						.filter(part => part.type === "text")
						.map(part => part.text)
						.join("\n");
		return text.trim() ? text : null;
	}
	return null;
}

/** Fallback text read from rendered `.tr-md` blocks when `entries` is unavailable or mismatched. */
function fallbackBodyText(body: Element): string | null {
	const parts: string[] = [];
	for (const md of Array.from(body.querySelectorAll(".tr-md"))) {
		if (closestWithClass(md, "tv-card", body) || closestWithClass(md, "tr-think", body)) continue;
		const text = (md.textContent ?? "").trim();
		if (text) parts.push(text);
	}
	return parts.length > 0 ? parts.join("\n\n") : null;
}

type CopyIconKind = "copy" | "copied" | "failed";

function createIcon(doc: Document, kind: CopyIconKind): Element {
	const svg = doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("width", "12");
	svg.setAttribute("height", "12");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	if (kind === "copy") {
		const rect = doc.createElementNS(SVG_NS, "rect");
		rect.setAttribute("width", "14");
		rect.setAttribute("height", "14");
		rect.setAttribute("x", "8");
		rect.setAttribute("y", "8");
		rect.setAttribute("rx", "2");
		rect.setAttribute("ry", "2");
		const path = doc.createElementNS(SVG_NS, "path");
		path.setAttribute("d", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2");
		svg.appendChild(rect);
		svg.appendChild(path);
	} else if (kind === "copied") {
		const path = doc.createElementNS(SVG_NS, "path");
		path.setAttribute("d", "M20 6 9 17l-5-5");
		svg.appendChild(path);
	} else {
		const p1 = doc.createElementNS(SVG_NS, "path");
		p1.setAttribute("d", "M18 6 6 18");
		const p2 = doc.createElementNS(SVG_NS, "path");
		p2.setAttribute("d", "m6 6 12 12");
		svg.appendChild(p1);
		svg.appendChild(p2);
	}
	return svg;
}

function setButtonState(button: Element, state: CopyIconKind): void {
	const doc = button.ownerDocument;
	if (!doc) return;
	const label = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy message";
	if (state === "copy") button.removeAttribute("data-state");
	else button.setAttribute("data-state", state);
	button.setAttribute("aria-label", label);
	button.setAttribute("title", label);
	while (button.firstChild) button.removeChild(button.firstChild);
	button.appendChild(createIcon(doc, state));
}

function findDirectChild(parent: Element, className: string): Element | null {
	for (const child of Array.from(parent.childNodes)) {
		if (hasClass(child, className)) return child as Element;
	}
	return null;
}

/** Localizes one gutter's timestamp; returns the formatted time and exact local timestamp when valid. */
function localizeGutter(gutter: Element, now: number): { formatted: string; exact: string; raw: string } | null {
	const title = gutter.getAttribute("title");
	const existingRaw = gutter.getAttribute("data-ts");
	const existingLocal = gutter.getAttribute("data-local");
	if (title !== null && title !== existingLocal) {
		const at = Date.parse(title);
		if (Number.isNaN(at)) return null;
		const exact = formatExact(at);
		const formatted = formatMessageTime(at, now);
		gutter.setAttribute("data-ts", title);
		gutter.setAttribute("data-local", exact);
		gutter.setAttribute("title", exact);
		bodyOf(gutter)?.setAttribute("data-time", formatted);
		return { formatted, exact, raw: title };
	}
	if (existingRaw !== null && existingLocal !== null) {
		const at = Date.parse(existingRaw);
		if (Number.isNaN(at)) return null;
		const body = bodyOf(gutter);
		const formatted = body?.getAttribute("data-time") ?? formatMessageTime(at, now);
		body?.setAttribute("data-time", formatted);
		return { formatted, exact: existingLocal, raw: existingRaw };
	}
	return null;
}

function restore(gutter: Element): void {
	const raw = gutter.getAttribute("data-ts");
	if (raw !== null && gutter.getAttribute("title") === gutter.getAttribute("data-local")) {
		gutter.setAttribute("title", raw);
	}
	gutter.removeAttribute("data-ts");
	gutter.removeAttribute("data-local");
	const body = bodyOf(gutter);
	body?.removeAttribute("data-time");
	const meta = body ? findDirectChild(body, META) : null;
	meta?.parentNode?.removeChild(meta);
}

/**
 * Shows each message's time (in the reader's time zone) and a copy button beside it inside the transcript under `ref`.
 */
export function useTranscriptTimes(ref: RefObject<HTMLElement | null>, entries?: readonly SessionEntry[]): void {
	const entriesRef = useRef<readonly SessionEntry[] | undefined>(entries);
	entriesRef.current = entries;
	const syncRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		const container = ref.current;
		if (!container) return;
		const copyTexts = new WeakMap<Element, string>();
		const timers = new Map<Element, ReturnType<typeof setTimeout>>();

		const clearTimer = (button: Element): void => {
			const id = timers.get(button);
			if (id !== undefined) {
				clearTimeout(id);
				timers.delete(button);
			}
		};

		const sync = (): void => {
			const now = Date.now();
			const doc = container.ownerDocument;
			const gutters = Array.from(container.querySelectorAll(`.${GUTTER}`));
			const messageRows: { body: Element; formatted: string; exact: string; raw: string }[] = [];

			for (const gutter of gutters) {
				const localized = localizeGutter(gutter, now);
				if (!localized) continue;
				const row = gutter.parentNode;
				const body = bodyOf(gutter);
				if (body && isMessageRow(row)) {
					messageRows.push({ body, ...localized });
				}
			}

			const currentEntries = entriesRef.current;
			const messageEntries = currentEntries
				? currentEntries.filter(e => isMessageRowEntry(e) && !Number.isNaN(Date.parse(e.timestamp)))
				: null;
			const offset = messageEntries ? messageEntries.length - messageRows.length : -1;

			for (let i = 0; i < messageRows.length; i++) {
				const { body, formatted, exact, raw } = messageRows[i]!;
				const matched =
					messageEntries && offset >= 0 && messageEntries[offset + i]?.timestamp === raw
						? messageEntries[offset + i]!
						: null;
				const text = matched ? entryCopyText(matched) : fallbackBodyText(body);

				let meta = findDirectChild(body, META);
				if (!meta && doc) {
					meta = doc.createElement("div");
					meta.setAttribute("class", META);
					const time = doc.createElement("span");
					time.setAttribute("class", TIME);
					meta.appendChild(time);
					body.appendChild(meta);
				}
				if (!meta || !doc) continue;
				if (body.lastChild !== meta) body.appendChild(meta);

				const time = findDirectChild(meta, TIME);
				if (time) {
					if (time.textContent !== formatted) time.textContent = formatted;
					if (time.getAttribute("title") !== exact) time.setAttribute("title", exact);
				}

				let button = findDirectChild(meta, COPY);
				if (text !== null) {
					if (!button) {
						button = doc.createElement("button");
						button.setAttribute("type", "button");
						button.setAttribute("class", COPY);
						setButtonState(button, "copy");
						meta.appendChild(button);
					}
					copyTexts.set(button, text);
				} else if (button) {
					clearTimer(button);
					copyTexts.delete(button);
					meta.removeChild(button);
				}
			}
		};

		syncRef.current = sync;

		const onClick = (event: Event): void => {
			const button = closestWithClass(event.target as Node | null, COPY, container);
			if (!button) return;
			const text = copyTexts.get(button);
			if (text === undefined) return;
			event.preventDefault();
			event.stopPropagation();
			clearTimer(button);
			copyText(text).then(
				() => {
					if (!container.contains(button)) return;
					setButtonState(button, "copied");
					timers.set(
						button,
						setTimeout(() => {
							timers.delete(button);
							if (container.contains(button)) setButtonState(button, "copy");
						}, COPY_RESET_MS),
					);
				},
				() => {
					if (!container.contains(button)) return;
					setButtonState(button, "failed");
					timers.set(
						button,
						setTimeout(() => {
							timers.delete(button);
							if (container.contains(button)) setButtonState(button, "copy");
						}, FAIL_RESET_MS),
					);
				},
			);
		};

		container.addEventListener("click", onClick);

		const observer =
			typeof MutationObserver === "function"
				? new MutationObserver(records => {
						let relevant = false;
						for (const record of records) {
							if (record.type === "attributes") {
								if (hasClass(record.target, GUTTER)) {
									const el = record.target as Element;
									if (el.getAttribute("title") !== el.getAttribute("data-local")) {
										relevant = true;
										break;
									}
								}
								continue;
							}
							if (isInsideMeta(record.target, container)) continue;
							for (const node of Array.from(record.addedNodes)) {
								if (!hasClass(node, META)) {
									relevant = true;
									break;
								}
							}
							if (relevant) break;
						}
						if (relevant) sync();
					})
				: null;
		observer?.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
		sync();

		return () => {
			syncRef.current = null;
			container.removeEventListener("click", onClick);
			observer?.disconnect();
			for (const id of timers.values()) clearTimeout(id);
			timers.clear();
			for (const gutter of Array.from(container.querySelectorAll(`.${GUTTER}[data-ts]`))) restore(gutter);
		};
	}, [ref]);

	useEffect(() => {
		syncRef.current?.();
	}, [entries]);
}
