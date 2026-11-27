/**
 * A just-enough DOM for React's client renderer, so components with state and effects can be driven (click, type,
 * re-render) in `bun test` without a browser or a DOM library. It implements what react-dom touches, element and text
 * nodes, attributes, bubbling events with capture, and a small selector engine for assertions (`tag`, `.class`,
 * `[attr]`, `[attr=value]`, descendant combinator). It is not a conformance DOM.
 */
import type { ReactNode } from "react";

/** Event-loop turns `until` waits for a condition before giving up. */
const UNTIL_TURNS = 200;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;

class FakeEvent {
	target: FakeNode | null = null;
	currentTarget: FakeNode | null = null;
	defaultPrevented = false;
	cancelBubble = false;
	readonly timeStamp = Date.now();
	readonly isTrusted = false;
	eventPhase = 0;
	constructor(
		readonly type: string,
		readonly bubbles: boolean,
	) {}
	preventDefault(): void {
		this.defaultPrevented = true;
	}
	stopPropagation(): void {
		this.cancelBubble = true;
	}
	stopImmediatePropagation(): void {
		this.cancelBubble = true;
	}
}

type Listener = (event: FakeEvent) => void;

interface Registered {
	listener: Listener;
	capture: boolean;
}

abstract class FakeNode {
	parentNode: FakeNode | null = null;
	childNodes: FakeNode[] = [];
	abstract readonly nodeType: number;
	readonly #listeners = new Map<string, Registered[]>();
	constructor(readonly ownerDocument: FakeDocument | null) {}

	get firstChild(): FakeNode | null {
		return this.childNodes[0] ?? null;
	}
	get lastChild(): FakeNode | null {
		return this.childNodes.at(-1) ?? null;
	}
	get nextSibling(): FakeNode | null {
		const siblings = this.parentNode?.childNodes;
		return siblings?.[siblings.indexOf(this) + 1] ?? null;
	}
	get isConnected(): boolean {
		return this.parentNode ? this.parentNode.isConnected : this.nodeType === DOCUMENT_NODE;
	}

	appendChild<T extends FakeNode>(child: T): T {
		return this.insertBefore(child, null);
	}
	insertBefore<T extends FakeNode>(child: T, before: FakeNode | null): T {
		child.parentNode?.removeChild(child);
		const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
		this.childNodes.splice(index, 0, child);
		child.parentNode = this;
		return child;
	}
	removeChild<T extends FakeNode>(child: T): T {
		const index = this.childNodes.indexOf(child);
		if (index >= 0) this.childNodes.splice(index, 1);
		child.parentNode = null;
		return child;
	}
	contains(other: FakeNode | null): boolean {
		for (let node = other; node; node = node.parentNode) if (node === this) return true;
		return false;
	}

	addEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }): void {
		const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
		const list = this.#listeners.get(type) ?? [];
		if (!list.some(l => l.listener === listener && l.capture === capture)) list.push({ listener, capture });
		this.#listeners.set(type, list);
	}
	removeEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }): void {
		const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
		const list = this.#listeners.get(type);
		if (!list) return;
		this.#listeners.set(
			type,
			list.filter(l => !(l.listener === listener && l.capture === capture)),
		);
	}

	/** Capture listeners from the root down, then target and bubble listeners back up (when the event bubbles). */
	dispatchEvent(event: FakeEvent): boolean {
		event.target = this;
		const path: FakeNode[] = [this];
		for (let node = this.parentNode; node; node = node.parentNode) path.push(node);
		const run = (node: FakeNode, capture: boolean): void => {
			if (event.cancelBubble) return;
			event.currentTarget = node;
			for (const registered of (node.#listeners.get(event.type) ?? []).slice()) {
				if (registered.capture === capture || node === this) registered.listener(event);
			}
		};
		for (const node of path.slice(1).reverse()) run(node, true);
		run(this, false);
		if (event.bubbles) for (const node of path.slice(1)) run(node, false);
		return !event.defaultPrevented;
	}

	abstract get textContent(): string;
	abstract set textContent(value: string);
}

export class FakeText extends FakeNode {
	readonly nodeType = TEXT_NODE;
	nodeValue: string;
	constructor(ownerDocument: FakeDocument, text: string) {
		super(ownerDocument);
		this.nodeValue = text;
	}
	get data(): string {
		return this.nodeValue;
	}
	set data(value: string) {
		this.nodeValue = value;
	}
	get textContent(): string {
		return this.nodeValue;
	}
	set textContent(value: string) {
		this.nodeValue = value;
	}
}

interface SimpleSelector {
	tag: string | null;
	classes: string[];
	attributes: { name: string; value: string | null }[];
}

function parseCompound(text: string): SimpleSelector {
	const selector: SimpleSelector = { tag: null, classes: [], attributes: [] };
	const pattern = /^([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/y;
	let at = 0;
	while (at < text.length) {
		pattern.lastIndex = at;
		const match = pattern.exec(text);
		if (!match) throw new Error(`unsupported selector: ${text}`);
		if (match[1]) selector.tag = match[1].toLowerCase();
		else if (match[2]) selector.classes.push(match[2]);
		else if (match[3]) selector.attributes.push({ name: match[3], value: match[4] ?? match[5] ?? match[6] ?? null });
		at = pattern.lastIndex;
	}
	return selector;
}

export class FakeElement extends FakeNode {
	readonly nodeType = ELEMENT_NODE;
	readonly tagName: string;
	readonly nodeName: string;
	readonly attributes = new Map<string, string>();
	readonly dataset: Record<string, string> = {};
	readonly style: Record<string, unknown> & { setProperty(name: string, value: string): void } = {
		setProperty(name: string, value: string) {
			this[name] = value;
		},
	};
	#value = "";
	#defaultValue = "";
	#dirtyValue = false;
	// <option> state React writes when it syncs a controlled <select>.
	selected = false;
	defaultSelected = false;
	constructor(
		ownerDocument: FakeDocument,
		tag: string,
		readonly namespaceURI: string,
	) {
		super(ownerDocument);
		this.tagName = namespaceURI.endsWith("xhtml") ? tag.toUpperCase() : tag;
		this.nodeName = this.tagName;
	}

	// No layout: every box is empty at the origin (chip-menu.tsx positions its popover from these).
	readonly offsetWidth = 0;
	getBoundingClientRect(): {
		left: number;
		top: number;
		right: number;
		bottom: number;
		width: number;
		height: number;
	} {
		return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
	}

	// React assigns these as properties; assertions read them as attributes.
	get name(): string {
		return this.getAttribute("name") ?? "";
	}
	set name(value: string) {
		this.setAttribute("name", value);
	}
	get type(): string {
		return this.getAttribute("type") ?? (this.tagName === "INPUT" ? "text" : "");
	}
	set type(value: string) {
		this.setAttribute("type", value);
	}
	get value(): string {
		return this.tagName === "OPTION" ? (this.getAttribute("value") ?? this.textContent) : this.#value;
	}
	set value(value: string) {
		this.#value = String(value);
		this.#dirtyValue = true;
	}
	get defaultValue(): string {
		return this.#defaultValue;
	}
	set defaultValue(value: string) {
		this.#defaultValue = String(value);
		if (!this.#dirtyValue) this.#value = this.#defaultValue;
	}
	get options(): FakeElement[] {
		return this.querySelectorAll("option");
	}
	get disabled(): boolean {
		return this.hasAttribute("disabled");
	}
	get className(): string {
		return this.getAttribute("class") ?? "";
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, String(value));
	}
	setAttributeNS(_ns: string | null, name: string, value: string): void {
		this.setAttribute(name, value);
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}
	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
	// react-dom's legacy input-change fallback (used when it loaded before any DOM existed) registers with these.
	attachEvent(): void {}
	detachEvent(): void {}
	focus(): void {}
	blur(): void {}
	select(): void {}

	get textContent(): string {
		return this.childNodes.map(c => c.textContent).join("");
	}
	set textContent(value: string) {
		for (const child of this.childNodes) child.parentNode = null;
		this.childNodes = [];
		if (value !== "" && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(value));
	}

	matches(selector: SimpleSelector): boolean {
		if (selector.tag !== null && this.tagName.toLowerCase() !== selector.tag) return false;
		const classes = this.className.split(/\s+/);
		if (!selector.classes.every(c => classes.includes(c))) return false;
		return selector.attributes.every(({ name, value }) => {
			const actual = this.getAttribute(name);
			return value === null ? actual !== null : actual === value;
		});
	}

	querySelectorAll(selector: string): FakeElement[] {
		// Whitespace separates compounds except inside [...].
		const chain = (selector.match(/(?:\[[^\]]*\]|[^\s[])+/g) ?? []).map(parseCompound);
		const found: FakeElement[] = [];
		const visit = (node: FakeNode, ancestors: FakeElement[]): void => {
			for (const child of node.childNodes) {
				if (!(child instanceof FakeElement)) continue;
				if (child.matches(chain.at(-1)!) && matchesAncestry(chain, ancestors)) found.push(child);
				visit(child, [...ancestors, child]);
			}
		};
		visit(this, [this]);
		return found;
	}
	querySelector(selector: string): FakeElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	click(): void {
		this.dispatchEvent(new FakeEvent("click", true));
	}
}

/** Every earlier compound of the chain must match some ancestor, in order (descendant combinator). */
function matchesAncestry(chain: SimpleSelector[], ancestors: FakeElement[]): boolean {
	let index = chain.length - 2;
	for (let i = ancestors.length - 1; i >= 0 && index >= 0; i--) {
		if (ancestors[i]!.matches(chain[index]!)) index--;
	}
	return index < 0;
}

export class FakeDocument extends FakeNode {
	readonly nodeType = DOCUMENT_NODE;
	readonly body: FakeElement;
	readonly documentElement: FakeElement;
	readonly activeElement: FakeElement | null = null;
	defaultView: unknown = null;
	/** React feature-detects the `input` event by this property; without it it falls back to a legacy polyfill. */
	oninput = null;
	visibilityState: DocumentVisibilityState = "visible";
	/** What `hasFocus()` answers: whether the page's window has focus. */
	focused = true;
	constructor() {
		super(null);
		this.documentElement = new FakeElement(this, "html", "http://www.w3.org/1999/xhtml");
		this.body = new FakeElement(this, "body", "http://www.w3.org/1999/xhtml");
		this.appendChild(this.documentElement);
		this.documentElement.appendChild(this.body);
	}
	createElement(tag: string): FakeElement {
		return new FakeElement(this, tag, "http://www.w3.org/1999/xhtml");
	}
	createElementNS(ns: string, tag: string): FakeElement {
		return new FakeElement(this, tag, ns);
	}
	createTextNode(text: string): FakeText {
		return new FakeText(this, text);
	}
	hasFocus(): boolean {
		return this.focused;
	}
	/** React walks up to the root to find the other radios of a group, and queries it. */
	querySelectorAll(selector: string): FakeElement[] {
		return this.documentElement.querySelectorAll(selector);
	}
	get textContent(): string {
		return "";
	}
	set textContent(_value: string) {}
}

export const makeEvent = (type: string, bubbles = true): FakeEvent => new FakeEvent(type, bubbles);

export interface Mounted {
	container: FakeElement;
	/** Runs `action` inside React's `act`, so effects and state updates are flushed before it returns. */
	act(action: () => void | Promise<void>): Promise<void>;
	/** Renders `element` again into the same root. */
	rerender(element: ReactNode): Promise<void>;
	query(selector: string): FakeElement | null;
	queryAll(selector: string): FakeElement[];
	/** Lets pending promises and I/O settle (inside `act`) until `condition` holds; fails after a bounded number of turns. */
	until(condition: () => boolean): Promise<void>;
	/** Clicks the first element matching `selector` (must exist) and lets the resulting updates settle. */
	click(selector: string): Promise<void>;
	/** Sets an input's value as a user typing would (value setter, then an `input` event). */
	type(selector: string, text: string): Promise<void>;
	unmount(): Promise<void>;
}

export interface FakeDom {
	document: FakeDocument;
	/** The global `window` (events dispatched on it reach `window.addEventListener` listeners). */
	window: FakeElement;
	mount(element: ReactNode): Promise<Mounted>;
	/** Removes the globals this harness installed (restoring whatever was there before). */
	uninstall(): void;
}

/**
 * Installs the fake DOM as globals and loads react-dom's client renderer (which decides at load whether a DOM exists,
 * hence the dynamic import). Pair with `uninstall()` in `afterAll`.
 */
export async function installFakeDom(): Promise<FakeDom> {
	const document = new FakeDocument();
	const target = globalThis as unknown as Record<string, unknown>;
	const previous = new Map<string, { had: boolean; value: unknown }>();
	const set = (key: string, value: unknown): void => {
		previous.set(key, { had: key in target, value: target[key] });
		Object.defineProperty(target, key, { value, configurable: true, writable: true });
	};
	const windowStub = Object.assign(new FakeElement(document, "window", "http://www.w3.org/1999/xhtml"), {
		document,
		HTMLIFrameElement: class {},
		event: undefined,
	});
	document.defaultView = windowStub;
	set("window", windowStub);
	set("document", document);
	set("HTMLIFrameElement", class {});
	set("IS_REACT_ACT_ENVIRONMENT", true);
	if (!("navigator" in target)) set("navigator", { userAgent: "fake-dom" });

	// Dynamic on purpose: react-dom/client decides whether a DOM exists when it loads, so it must load after the globals.
	const { createRoot } = await import("react-dom/client");
	const { act } = await import("react");
	const mounted: Mounted[] = [];

	return {
		document,
		window: windowStub,
		async mount(element) {
			const container = document.createElement("div");
			document.body.appendChild(container);
			const root = createRoot(container as unknown as Element);
			const settle = (action: () => void | Promise<void>): Promise<void> =>
				act(async () => {
					await action();
				});
			const handle: Mounted = {
				container,
				act: settle,
				rerender: next => settle(() => root.render(next)),
				query: selector => container.querySelector(selector),
				queryAll: selector => container.querySelectorAll(selector),
				until: condition =>
					settle(async () => {
						for (let turn = 0; !condition(); turn++) {
							if (turn >= UNTIL_TURNS) throw new Error("condition did not become true");
							await new Promise<void>(resolve => setImmediate(resolve));
						}
					}),
				click: selector =>
					settle(() => {
						const el = container.querySelector(selector);
						if (!el) throw new Error(`nothing matches ${selector}`);
						el.click();
					}),
				type: (selector, text) =>
					settle(() => {
						const el = container.querySelector(selector);
						if (!el) throw new Error(`nothing matches ${selector}`);
						// react-dom picks, when it first loads in the process (any test file), between the `input` event and a
						// legacy fallback driven by focus and key events; driving both works whichever it picked.
						el.dispatchEvent(new FakeEvent("focusin", true));
						const setter = Object.getOwnPropertyDescriptor(FakeElement.prototype, "value")?.set;
						setter?.call(el, text);
						el.dispatchEvent(new FakeEvent("input", true));
						el.dispatchEvent(new FakeEvent("keyup", true));
					}),
				unmount: () => settle(() => root.unmount()),
			};
			mounted.push(handle);
			await handle.rerender(element);
			return handle;
		},
		uninstall() {
			for (const [key, { had, value }] of previous) {
				if (had) Object.defineProperty(target, key, { value, configurable: true, writable: true });
				else delete target[key];
			}
		},
	};
}
