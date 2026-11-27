import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ReactNode, useRef } from "react";
import { type ToolLinkContext, useToolPathLinks } from "../src/components/files/tool-links";
import { parseRoute } from "../src/lib/route";

/** The file a tool link opened: the dock's Files tab of the route. */
function opened(hash: string) {
	const dock = parseRoute(hash).dock;
	return dock?.tab === "files" ? dock.ref : null;
}
import { type FakeDom, installFakeDom } from "./fake-dom";

let dom: FakeDom;
const globals = globalThis as unknown as Record<string, unknown>;
let hadLocation = false;
let previousLocation: unknown;
const fakeLocation = { hash: "" };

beforeAll(async () => {
	dom = await installFakeDom();
	hadLocation = "location" in globals;
	previousLocation = globals.location;
	Object.defineProperty(globals, "location", { value: fakeLocation, configurable: true, writable: true });
});
afterAll(() => {
	if (hadLocation)
		Object.defineProperty(globals, "location", { value: previousLocation, configurable: true, writable: true });
	else delete globals.location;
	dom.uninstall();
});

const ctx: ToolLinkContext = {
	machine: "home",
	roots: ["/Users/me/proj"],
	cwd: "/Users/me/proj/packages/web",
	preferredRoot: "/Users/me/proj",
};

/** The transcript container with a collapsed card header (a button) holding a path, as upstream renders it. */
function Host({
	context,
	toggled,
	children,
}: {
	context: ToolLinkContext | null;
	toggled: string[];
	children?: ReactNode;
}): ReactNode {
	const ref = useRef<HTMLDivElement>(null);
	useToolPathLinks(ref, context);
	return (
		<div className="session-transcript" ref={ref}>
			<button type="button" className="tv-head" onClick={() => toggled.push("card")}>
				<span className="tv-path" id="inside">
					~/proj/src/a.ts<span className="tv-lines">:12-20</span>
				</span>
			</button>
			<button type="button" className="tv-head" onClick={() => toggled.push("other")}>
				<span className="tv-path" id="outside">
					/etc/hosts
				</span>
			</button>
			<button type="button" className="tv-head" onClick={() => toggled.push("rel")}>
				<span className="tv-path" id="relative">
					src/b.ts
				</span>
			</button>
			{children}
		</div>
	);
}

describe("tool card path links", () => {
	test("clicking a path inside a registered worktree opens it and does not toggle the card", async () => {
		fakeLocation.hash = "";
		const toggled: string[] = [];
		const view = await dom.mount(<Host context={ctx} toggled={toggled} />);
		await view.click("[id=inside]");
		expect(opened(fakeLocation.hash)).toEqual({
			machine: "home",
			root: "/Users/me/proj",
			path: "src/a.ts",
			line: 12,
		});
		expect(toggled).toEqual([]);
		await view.unmount();
	});

	test("an edit card's header has no line: the click takes the line of the session's newest edit of that file; other cards do not", async () => {
		fakeLocation.hash = "";
		const withEdits: ToolLinkContext = {
			...ctx,
			editedLine: (_root, path) => (path === "src/e.ts" ? 22 : undefined),
		};
		function Cards(): ReactNode {
			const ref = useRef<HTMLDivElement>(null);
			useToolPathLinks(ref, withEdits);
			return (
				<div ref={ref}>
					<div className="tv-card">
						<button type="button" className="tv-head">
							<span className="tv-name">edit</span>
							<span className="tv-path" id="edit-card">
								~/proj/src/e.ts
							</span>
						</button>
					</div>
					<div className="tv-card">
						<button type="button" className="tv-head">
							<span className="tv-name">read</span>
							<span className="tv-path" id="read-card">
								~/proj/src/e.ts
							</span>
						</button>
					</div>
					<div className="tv-card">
						<button type="button" className="tv-head">
							<span className="tv-name">edit</span>
							<span className="tv-path" id="open-card">
								~/proj/src/e.ts
							</span>
						</button>
						<div className="tv-body">
							<span className="tv-path">
								~/proj/src/e.ts<span className="tv-lines">:31</span>
							</span>
						</div>
					</div>
				</div>
			);
		}
		const view = await dom.mount(<Cards />);
		await view.click("[id=edit-card]");
		expect(opened(fakeLocation.hash)?.line).toBe(22);
		fakeLocation.hash = "";
		await view.click("[id=read-card]"); // a read card without a range opens the file at its top
		expect(opened(fakeLocation.hash)).toEqual({ machine: "home", root: "/Users/me/proj", path: "src/e.ts" });
		fakeLocation.hash = "";
		await view.click("[id=open-card]"); // an opened card says better where the edit is
		expect(opened(fakeLocation.hash)?.line).toBe(31);
		await view.unmount();
	});

	test("a click on the nested line-range span counts as a click on the path", async () => {
		fakeLocation.hash = "";
		const toggled: string[] = [];
		const view = await dom.mount(<Host context={ctx} toggled={toggled} />);
		await view.click(".tv-lines");
		expect(opened(fakeLocation.hash)?.line).toBe(12);
		expect(toggled).toEqual([]);
		await view.unmount();
	});

	test("a relative path resolves against the session's cwd", async () => {
		fakeLocation.hash = "";
		const view = await dom.mount(<Host context={ctx} toggled={[]} />);
		await view.click("[id=relative]");
		expect(opened(fakeLocation.hash)).toEqual({
			machine: "home",
			root: "/Users/me/proj",
			path: "packages/web/src/b.ts",
		});
		await view.unmount();
	});

	test("a path outside every root does nothing; the card toggles as usual", async () => {
		fakeLocation.hash = "";
		const toggled: string[] = [];
		const view = await dom.mount(<Host context={ctx} toggled={toggled} />);
		await view.click("[id=outside]");
		expect(fakeLocation.hash).toBe("");
		expect(toggled).toEqual(["other"]);
		await view.unmount();
	});

	test("without a context (worktrees unknown) nothing is intercepted", async () => {
		fakeLocation.hash = "";
		const toggled: string[] = [];
		const view = await dom.mount(<Host context={null} toggled={toggled} />);
		await view.click("[id=inside]");
		expect(fakeLocation.hash).toBe("");
		expect(toggled).toEqual(["card"]);
		await view.unmount();
	});

	test("paths that resolve are marked openable, others are left alone; unmounting removes the marks and the listener", async () => {
		fakeLocation.hash = "";
		const toggled: string[] = [];
		const view = await dom.mount(<Host context={ctx} toggled={toggled} />);
		expect(view.query("[id=inside]")?.getAttribute("data-openable")).toBe("true");
		expect(view.query("[id=inside]")?.getAttribute("title")).toBe("Open in Files");
		expect(view.query("[id=relative]")?.getAttribute("data-openable")).toBe("true");
		expect(view.query("[id=outside]")?.hasAttribute("data-openable")).toBe(false);
		const inside = view.query("[id=inside]")!;
		await view.rerender(<div />);
		expect(inside.hasAttribute("data-openable")).toBe(false);
		expect(inside.hasAttribute("title")).toBe(false);
		await view.unmount();
	});

	test("path-like tokens of text output open on click, through the caret API", async () => {
		fakeLocation.hash = "";
		const toggled: string[] = [];
		const text = "match in src/a.ts:30: const x";
		const view = await dom.mount(
			<Host context={ctx} toggled={toggled}>
				<pre className="tv-pre">{text}</pre>
			</Host>,
		);
		const textNode = view.query("pre")!.childNodes[0]!;
		const document = globals.document as unknown as Record<string, unknown>;
		const caret = (offset: number) => (): { offsetNode: unknown; offset: number } => ({
			offsetNode: textNode,
			offset,
		});
		document.caretPositionFromPoint = caret(text.indexOf("a.ts") + 1);
		await view.click("pre");
		expect(opened(fakeLocation.hash)).toEqual({
			machine: "home",
			root: "/Users/me/proj",
			path: "packages/web/src/a.ts",
			line: 30,
		});

		// A word that is not a path does nothing.
		fakeLocation.hash = "";
		document.caretPositionFromPoint = caret(1);
		await view.click("pre");
		expect(fakeLocation.hash).toBe("");
		// Neither does a position between words.
		document.caretPositionFromPoint = caret(text.indexOf(" in") + 3);
		await view.click("pre");
		expect(fakeLocation.hash).toBe("");

		// A browser that only has the older API still works.
		delete document.caretPositionFromPoint;
		document.caretRangeFromPoint = () => ({ startContainer: textNode, startOffset: text.indexOf("src/") + 2 });
		await view.click("pre");
		expect(opened(fakeLocation.hash)?.line).toBe(30);

		// And a browser with neither does nothing.
		fakeLocation.hash = "";
		delete document.caretRangeFromPoint;
		await view.click("pre");
		expect(fakeLocation.hash).toBe("");
		await view.unmount();
	});

	test("omp URLs open where the machine locates them; a failed one says why; proc:// stays inert", async () => {
		fakeLocation.hash = "";
		const asked: string[] = [];
		const context: ToolLinkContext = {
			...ctx,
			locate: async url => {
				asked.push(url);
				return url === "local://plan.md"
					? { root: "/home/me/.omp/agent/sessions/x/local", path: "plan.md" }
					: { error: `${url} has no file on this machine` };
			},
		};
		const toggled: string[] = [];
		const view = await dom.mount(
			<Host context={context} toggled={toggled}>
				<button type="button" className="tv-head" onClick={() => toggled.push("plan")}>
					<span className="tv-path" id="plan">
						local://plan.md<span className="tv-lines">:40</span>
					</span>
				</button>
				<span className="tv-path" id="gone">
					agent://Gone
				</span>
				<span className="tv-path" id="proc">
					proc://bg_1
				</span>
			</Host>,
		);
		await view.until(() => view.query("[id=plan]")?.getAttribute("data-openable") === "true");
		expect(view.query("[id=proc]")?.hasAttribute("data-openable")).toBe(false);

		await view.click("[id=plan]");
		await view.until(() => opened(fakeLocation.hash) !== null);
		expect(opened(fakeLocation.hash)).toEqual({
			machine: "home",
			root: "/home/me/.omp/agent/sessions/x/local",
			path: "plan.md",
			line: 40,
		});
		expect(toggled).toEqual([]);

		fakeLocation.hash = "";
		await view.click("[id=gone]");
		await view.until(() => view.query("[id=gone]")?.getAttribute("data-open-failed") === "true");
		expect(view.query("[id=gone]")?.getAttribute("title")).toBe(
			"Cannot open agent://Gone: agent://Gone has no file on this machine",
		);
		expect(fakeLocation.hash).toBe("");

		await view.click("[id=proc]");
		expect(asked).toEqual(["local://plan.md", "agent://Gone"]);
		await view.unmount();
	});
});
