/**
 * "Open in Files" for the paths of tool cards.
 *
 * Upstream's tool renderers (`PathText`, `Output`, `ResultText`) print paths as plain `<span class="tv-path">` and
 * `<pre class="tv-pre">` text and expose no link or click hook: `ToolRenderHost` only knows about agents and the
 * registry is a constant. Forking those components would mean carrying the fork through every upstream update, so this
 * attaches to the one thing that is stable, their markup, by event delegation on the transcript container:
 *
 *  - a capture-phase click listener resolves the path under the pointer against the machine's registered worktrees
 *    and, when it is inside one, opens it in the Files view (and keeps the card header button from toggling);
 *  - a MutationObserver only adds `data-openable` / `title` attributes, which React does not manage, to the
 *    `.tv-path` spans that resolve, so CSS can show them as links. No node React owns is added, moved or re-texted.
 *
 * There is no upstream seam for this; delegation is the least invasive option.
 */
import type { FileLocation } from "@omp-web/protocol";
import { type RefObject, useEffect } from "react";
import {
	ompUrlCandidate,
	pathCandidate,
	type ResolvedToolPath,
	resolveToolPath,
	type ToolPathContext,
	tokenAt,
} from "../../lib/files-links";
import { type FilesRef, parseRoute, routeHash } from "../../lib/route";

export interface ToolLinkContext extends ToolPathContext {
	/** The machine the session (and so the files) lives on. */
	machine: string;
	/** The line of the newest edit of a file (see `editedLines`): what an edit card's header lacks. */
	editedLine?(root: string, path: string): number | undefined;
	/** Opens a file; the default shows it in the dock's Files tab beside the current main view. */
	open?(ref: FilesRef): void;
	/**
	 * Where one of omp's own URLs (`local://`, `agent://`, …) lives on the machine, or why it cannot be shown. Absent:
	 * those URLs stay inert.
	 */
	locate?(url: string): Promise<FileLocation | { error: string }>;
}

/** What a click landed on: a path already resolved against the worktrees, or an omp URL the daemon has to locate. */
type ClickTarget =
	| { kind: "path"; hit: ResolvedToolPath }
	| { kind: "url"; url: string; line?: number; element: Element | null };

const HINT = "Open in Files";
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function hasClass(node: Node, className: string): boolean {
	return (
		node.nodeType === ELEMENT_NODE && ((node as Element).getAttribute("class") ?? "").split(/\s+/).includes(className)
	);
}

/** The nearest ancestor-or-self of `node` carrying `className`, looking no further out than `container`. */
function closestWithClass(node: Node | null, className: string, container: Node): Element | null {
	for (let at = node; at && at !== container; at = at.parentNode) if (hasClass(at, className)) return at as Element;
	return null;
}

/** Cards of the tools that change files: only their header paths take the line of the edit. */
const EDIT_TOOLS = new Set(["edit", "apply_patch", "ast_edit"]);

/** A path an opened card prints with its line (`:22`) next to a header that does not: the card's own, better, answer. */
function lineInOpenCard(span: Element, text: string, container: Node): number | undefined {
	const card = closestWithClass(span, "tv-card", container);
	if (!card) return undefined;
	for (const other of Array.from(card.querySelectorAll(".tv-path"))) {
		if (other === span) continue;
		const read = readPathElement(other);
		if (read.line !== undefined && read.text === text) return read.line;
	}
	return undefined;
}

function toolNameOf(span: Element, container: Node): string | null {
	const card = closestWithClass(span, "tv-card", container);
	return card?.querySelector(".tv-name")?.textContent?.trim() ?? null;
}

/** A `.tv-path` span's own text (its `.tv-lines` children excluded) and the first line its `:12` / `:12-20` names. */
export function readPathElement(element: Element): { text: string; line?: number } {
	let text = "";
	let line: number | undefined;
	for (const child of Array.from(element.childNodes)) {
		if (child.nodeType === TEXT_NODE) text += child.nodeValue ?? "";
		else if (hasClass(child, "tv-lines")) {
			const digits = /^:(\d+)/.exec(child.textContent ?? "");
			if (digits && line === undefined) line = Number(digits[1]);
		} else text += child.textContent ?? "";
	}
	return line === undefined ? { text } : { text, line };
}

interface CaretDocument {
	caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
	caretRangeFromPoint?(x: number, y: number): Range | null;
}

/** The text node and offset under a point, through whichever caret API the browser has. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
	const doc: CaretDocument = document;
	if (typeof doc.caretPositionFromPoint === "function") {
		const position = doc.caretPositionFromPoint(x, y);
		if (position) return { node: position.offsetNode, offset: position.offset };
	}
	if (typeof doc.caretRangeFromPoint === "function") {
		const range = doc.caretRangeFromPoint(x, y);
		if (range) return { node: range.startContainer, offset: range.startOffset };
	}
	return null;
}

function selectionIsActive(): boolean {
	if (typeof getSelection !== "function") return false;
	const selection = getSelection();
	return selection !== null && !selection.isCollapsed;
}

function openByHash(ref: FilesRef): void {
	location.hash = routeHash({ main: parseRoute(location.hash).main, dock: { tab: "files", ref } });
}

/**
 * Makes the paths printed in `container` (a transcript) open in the Files view. `ctx` is null while the machine's
 * worktrees are unknown; pass a memoized object, the listeners are rebuilt when it changes.
 */
export function useToolPathLinks(ref: RefObject<HTMLElement | null>, ctx: ToolLinkContext | null): void {
	useEffect(() => {
		const container = ref.current;
		if (!container || !ctx) return;
		const open = ctx.open ?? openByHash;
		const locate = ctx.locate;

		const resolve = (text: string, line?: number): ResolvedToolPath | null =>
			resolveToolPath(line === undefined ? text : `${text}:${line}`, ctx);
		const ompUrl = (text: string, line?: number): { url: string; line?: number } | null =>
			locate ? ompUrlCandidate(line === undefined ? text : `${text}:${line}`) : null;

		const resolveClick = (event: MouseEvent): ClickTarget | null => {
			const target = event.target as Node | null;
			const span = closestWithClass(target, "tv-path", container);
			if (span) {
				const { text, line } = readPathElement(span);
				const url = ompUrl(text, line);
				if (url) return { kind: "url", ...url, element: span };
				const hit = resolve(text, line ?? lineInOpenCard(span, text, container));
				if (hit && hit.line === undefined && EDIT_TOOLS.has(toolNameOf(span, container) ?? "")) {
					const edited = ctx.editedLine?.(hit.root, hit.path);
					if (edited !== undefined) hit.line = edited;
				}
				return hit && { kind: "path", hit };
			}
			if (!closestWithClass(target, "tv-pre", container) || selectionIsActive()) return null;
			const caret = caretAt(event.clientX, event.clientY);
			if (!caret || caret.node.nodeType !== TEXT_NODE || !container.contains(caret.node)) return null;
			const token = tokenAt(caret.node.nodeValue ?? "", caret.offset);
			if (token === null) return null;
			const url = ompUrl(token);
			if (url) return { kind: "url", ...url, element: null };
			const candidate = pathCandidate(token);
			const hit = candidate && resolve(candidate.text, candidate.line);
			return hit && { kind: "path", hit };
		};

		const openAt = (root: string, path: string, line: number | undefined): void =>
			open({ machine: ctx.machine, root, path, ...(line === undefined ? {} : { line }) });

		// Capture phase: the path sits inside the card header's <button>, whose own handler would toggle the card.
		const onClick = (event: Event): void => {
			const target = resolveClick(event as MouseEvent);
			if (!target) return;
			event.preventDefault();
			event.stopPropagation();
			if (target.kind === "path") return openAt(target.hit.root, target.hit.path, target.hit.line);
			void locate!(target.url).then(found => {
				if ("error" in found) {
					// Shown where the click was: the link greys out and its tooltip says why.
					target.element?.setAttribute("data-open-failed", "true");
					target.element?.setAttribute("title", `Cannot open ${target.url}: ${found.error}`);
					return;
				}
				target.element?.removeAttribute("data-open-failed");
				openAt(found.root, found.path, target.line);
			});
		};
		container.addEventListener("click", onClick, true);

		// Affordance: mark the spans that resolve. Observed nodes are batched into one pass per animation frame.
		const mark = (span: Element): void => {
			const { text, line } = readPathElement(span);
			if (ompUrl(text, line) || resolve(text, line)) {
				span.setAttribute("data-openable", "true");
				if (!span.hasAttribute("title")) span.setAttribute("title", HINT);
			} else unmark(span);
		};
		const unmark = (span: Element): void => {
			span.removeAttribute("data-openable");
			if (span.getAttribute("title") === HINT) span.removeAttribute("title");
		};
		const scan = (root: Element): void => {
			if (hasClass(root, "tv-path")) mark(root);
			for (const span of Array.from(root.querySelectorAll(".tv-path"))) mark(span);
		};

		const pending = new Set<Node>();
		let cancelFrame: (() => void) | null = null;
		const flush = (): void => {
			cancelFrame = null;
			const nodes = [...pending];
			pending.clear();
			for (const node of nodes) {
				if (!container.contains(node)) continue;
				const span = closestWithClass(node, "tv-path", container);
				if (span) mark(span);
				if (node.nodeType === ELEMENT_NODE) scan(node as Element);
			}
		};
		const schedule = (): void => {
			if (cancelFrame) return;
			if (typeof requestAnimationFrame === "function") {
				const id = requestAnimationFrame(flush);
				cancelFrame = () => cancelAnimationFrame(id);
			} else {
				const id = setTimeout(flush, 16);
				cancelFrame = () => clearTimeout(id);
			}
		};
		const observer =
			typeof MutationObserver === "function"
				? new MutationObserver(records => {
						for (const record of records) {
							if (record.type === "characterData") pending.add(record.target);
							else for (const added of Array.from(record.addedNodes)) pending.add(added);
						}
						schedule();
					})
				: null;
		observer?.observe(container, { childList: true, subtree: true, characterData: true });
		scan(container);

		return () => {
			container.removeEventListener("click", onClick, true);
			observer?.disconnect();
			cancelFrame?.();
			for (const span of Array.from(container.querySelectorAll("[data-openable]"))) unmark(span);
		};
	}, [ref, ctx]);
}
