import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useState } from "react";
import { FilesView, type FilesTab } from "../src/components/files/files-view";
import type { FilesRef } from "../src/lib/route";
import { type FakeDom, installFakeDom } from "./fake-dom";
import { dir, type FakeFiles, file, sampleTree, settle } from "./files-fake";
import { machineSummary } from "./fixtures";

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

const home = machineSummary({ id: "home", name: "Home" });
const away = machineSummary({ id: "home", name: "Home", online: false });

interface Opts {
	path?: string;
	line?: number;
	diff?: FilesRef["diff"];
	machine?: typeof home;
	navigations?: { ref: FilesRef; how: string }[];
}

/** The dock owns the tab; here a state stands in for it. */
function Harness({ fake, opts }: { fake: FakeFiles; opts: Opts }) {
	const [tab, setTab] = useState<FilesTab>("tree");
	return (
		<FilesView
			client={fake}
			machine="home"
			machineInfo={opts.machine ?? home}
			root="/r"
			path={opts.path ?? ""}
			line={opts.line}
			diff={opts.diff}
			onNavigate={(ref, how) => opts.navigations?.push({ ref, how })}
			tab={tab}
			onTab={setTab}
		/>
	);
}

const view = (fake: FakeFiles, opts: Opts = {}) => <Harness fake={fake} opts={opts} />;

const node = (path: string) => `[data-path="${path}"]`;

describe("FilesView", () => {
	test("shows the worktree root, the branch and the tree", async () => {
		const fake = sampleTree();
		const mounted = await dom.mount(view(fake));
		await mounted.until(() => mounted.query("li.files-node") !== null);
		expect(mounted.query(".files")?.getAttribute("data-root")).toBe("/r");
		expect(mounted.query(".files")?.getAttribute("data-machine")).toBe("home");
		await mounted.until(() => mounted.query(".files-branch") !== null);
		expect(mounted.query(".files-branch")?.textContent).toBe("main ↑1");
		const rows = mounted.queryAll("ul.files-tree li.files-node");
		// the ignored directory is hidden until asked for
		expect(rows.map(r => r.getAttribute("data-path"))).toEqual(["src", "README.md"]);
		expect(rows[0]?.getAttribute("data-kind")).toBe("dir");
		expect(rows[0]?.getAttribute("data-expanded")).toBe("false");
		await mounted.unmount();
	});

	test("clicking a directory expands it in place; clicking a file navigates to it", async () => {
		const fake = sampleTree();
		const navigations: { ref: FilesRef; how: string }[] = [];
		const mounted = await dom.mount(view(fake, { navigations }));
		await mounted.until(() => mounted.query("li.files-node") !== null);
		await mounted.click(`${node("src")} .files-node-main`);
		await mounted.until(() => mounted.query(node("src/a.ts")) !== null);
		expect(mounted.query(node("src"))?.getAttribute("data-expanded")).toBe("true");
		expect(mounted.queryAll(`${node("src")} ul li.files-node`).length).toBeGreaterThan(0);
		await mounted.click(`${node("src/a.ts")} .files-node-main`);
		expect(navigations).toEqual([{ ref: { machine: "home", root: "/r", path: "src/a.ts" }, how: "push" }]);
		await mounted.click(`${node("src")} .files-node-main`); // collapse again
		expect(mounted.query(node("src"))?.getAttribute("data-expanded")).toBe("false");
		await mounted.unmount();
	});

	test("the route's file opens in the viewer, ancestors expanded, with line rows and the pager", async () => {
		const fake = sampleTree();
		const mounted = await dom.mount(view(fake, { path: "src/deep/x.ts", line: 1500 }));
		await mounted.until(() => mounted.query(".files-line") !== null);
		expect(mounted.query(".files-viewer")?.getAttribute("data-kind")).toBe("text");
		expect(mounted.query(".files-viewer")?.getAttribute("data-path")).toBe("src/deep/x.ts");
		expect(mounted.query(node("src"))?.getAttribute("data-expanded")).toBe("true");
		expect(mounted.query(node("src/deep"))?.getAttribute("data-expanded")).toBe("true");
		expect(mounted.query(node("src/deep/x.ts"))?.className).toContain("files-node--on");
		expect(mounted.query(".files-line--target")?.getAttribute("data-line")).toBe("1500");
		expect(mounted.query(".files-line--target")?.textContent).toBe("line 1500");
		expect(mounted.query(".files-pageinfo")?.textContent).toBe("lines 1460–2459 of 2500");
		expect(mounted.queryAll(".files-line")).toHaveLength(1000);
		expect(mounted.queryAll(".files-crumb-item").map(c => c.textContent)).toEqual(["src", "/deep", "/x.ts"]);
		expect(mounted.query("button[name=next-page]")?.disabled).toBe(false);
		await mounted.click("button[name=next-page]");
		await mounted.until(() => mounted.query(".files-pageinfo")?.textContent === "lines 2460–2500 of 2500");
		expect(mounted.query("button[name=next-page]")?.disabled).toBe(true);
		await mounted.unmount();
	});

	test("file content is shown as text, never as markup; Markdown opens in Preview, Source shows its text", async () => {
		const fake = sampleTree();
		fake.texts.set("README.md", ["<img src=x onerror=alert(1)>", "<b>bold</b>"]);
		const mounted = await dom.mount(view(fake, { path: "README.md" }));
		// The fake DOM does not parse `innerHTML`; the preview is upstream's transcript renderer, whose `html()` escapes raw HTML.
		await mounted.until(() => mounted.query(".files-markdown") !== null);
		expect(mounted.query("button[data-view=preview]")?.getAttribute("aria-pressed")).toBe("true");

		await mounted.click("button[data-view=source]");
		await mounted.until(() => mounted.query(".files-line") !== null);
		expect(mounted.query(".files-line")?.textContent).toBe("<img src=x onerror=alert(1)>");
		expect(mounted.query(".files-code img")).toBeNull();
		expect(mounted.query(".files-code b")).toBeNull();
		await mounted.unmount();
	});

	test("a refused deep link shows the daemon's message and its code in the viewer", async () => {
		const fake = sampleTree();
		const mounted = await dom.mount(view(fake, { path: "nope.txt" }));
		await mounted.until(() => mounted.query(".files-viewer .files-error") !== null);
		const error = mounted.query(".files-viewer .files-error")!;
		expect(error.getAttribute("data-code")).toBe("not_found");
		expect(error.textContent).toContain("nope.txt");
		expect(mounted.query(".files-viewer")?.getAttribute("data-kind")).toBe("none");
		await settle(4);
		expect(fake.of("files.read")).toHaveLength(1);
		await mounted.unmount();
	});

	test("git status decorates files and aggregates onto directories; the Changes tab groups them", async () => {
		const fake = sampleTree();
		fake.status = {
			...fake.status,
			entries: [
				{ path: "src/a.ts", kind: "changed", x: "M", y: "M" },
				{ path: "README.md", kind: "untracked", x: "?", y: "?" },
			],
		};
		const mounted = await dom.mount(view(fake, { path: "src/a.ts" }));
		await mounted.until(() => mounted.query(`${node("src/a.ts")}[data-xy=MM]`) !== null);
		expect(mounted.query(node("src/a.ts"))?.getAttribute("data-status")).toBe("modified");
		expect(mounted.query(node("src"))?.getAttribute("data-status")).toBe("changed");
		expect(mounted.query(node("README.md"))?.getAttribute("data-xy")).toBe("??");
		expect(mounted.query(node("README.md"))?.getAttribute("data-status")).toBe("untracked");
		expect(mounted.query("button.files-tab[data-tab=changes]")?.textContent).toContain("2");

		await mounted.click("button.files-tab[data-tab=changes]");
		const items = mounted.queryAll("ul.files-changes li.files-change");
		expect(items.map(i => `${i.getAttribute("data-group")}:${i.getAttribute("data-path")}`)).toEqual([
			"staged:src/a.ts",
			"unstaged:src/a.ts",
			"untracked:README.md",
		]);
		expect(mounted.queryAll(".files-changes-heading").map(h => h.getAttribute("data-group"))).toEqual([
			"staged",
			"unstaged",
			"untracked",
		]);
		await mounted.unmount();
	});

	test("a change opens its diff mode; the viewer offers only the modes that apply, and a clean file only Source", async () => {
		const fake = sampleTree();
		fake.status = { ...fake.status, entries: [{ path: "src/a.ts", kind: "changed", x: "M", y: "." }] };
		fake.diffs.set(
			"staged:src/a.ts",
			"diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
		);
		const navigations: { ref: FilesRef; how: string }[] = [];
		const mounted = await dom.mount(view(fake, { navigations }));
		await mounted.until(
			() => mounted.query("button.files-tab[data-tab=changes]")?.textContent?.includes("1") === true,
		);
		await mounted.click("button.files-tab[data-tab=changes]");
		await mounted.click(".files-change-main");
		expect(navigations.at(-1)).toEqual({
			ref: { machine: "home", root: "/r", path: "src/a.ts", diff: "staged" },
			how: "push",
		});

		await mounted.rerender(view(fake, { path: "src/a.ts", diff: "staged", navigations }));
		await mounted.until(() => mounted.query(".files-diff .tv-diff-row") !== null);
		expect(mounted.queryAll(".files-viewer button[data-view]").map(b => b.getAttribute("data-view"))).toEqual([
			"source",
			"staged",
			"head",
		]);
		expect(mounted.query("button[data-view=staged]")?.getAttribute("aria-pressed")).toBe("true");
		expect(mounted.queryAll(".files-diff .tv-diff-row").map(r => r.textContent)).toEqual([
			"@@ -1 +1 @@",
			"-old",
			"+new",
		]);
		expect(mounted.query(".files-diff-head")?.textContent).toContain("src/a.ts");

		await mounted.click("button[data-view=source]");
		expect(navigations.at(-1)).toEqual({ ref: { machine: "home", root: "/r", path: "src/a.ts" }, how: "replace" });

		await mounted.rerender(view(fake, { path: "src/deep/x.ts", navigations }));
		await mounted.until(() => mounted.query(".files-viewer")?.getAttribute("data-path") === "src/deep/x.ts");
		await mounted.until(() => mounted.query(".files-line") !== null);
		expect(mounted.query(".files-viewer button[data-view]")).toBeNull(); // a clean file: source only
		await mounted.unmount();
	});

	test("an ignored entry is dimmed and marked, shown only with Show ignored (kept in storage)", async () => {
		const fake = sampleTree();
		const mounted = await dom.mount(view(fake));
		await mounted.until(() => mounted.query("li.files-node") !== null);
		expect(mounted.query(node("dist"))).toBeNull();
		const checkbox = mounted.query("input[name=show-ignored]")!;
		expect("checked" in checkbox && checkbox.checked).toBe(false);
		await mounted.act(() => {
			Object.assign(checkbox, { checked: true }); // as the browser does before it fires the click's change
			checkbox.click();
		});
		await mounted.until(() => mounted.query(node("dist")) !== null);
		expect(mounted.query(node("dist"))?.getAttribute("data-ignored")).toBe("true");
		expect(mounted.query(node("dist"))?.className).toContain("files-node--ignored");
		expect(mounted.query(`${node("dist")} .files-node-flag`)?.textContent).toBe("ignored");
		expect(fake.of("files.list").at(-1)).toMatchObject({ showIgnored: true });
		await mounted.unmount();
	});

	test("symlinks that leave the worktree are inert and never requested", async () => {
		const fake = sampleTree();
		fake.dirs.set("", [
			file("ok.txt"),
			{ name: "out", kind: "symlink", link: { target: "/etc", resolves: "outside" } },
			{ name: "in", kind: "symlink", link: { target: "src", resolves: "dir" } },
			{ name: "pipe", kind: "other" },
			dir("src"),
		]);
		fake.dirs.set("in", [file("a.ts")]);
		const navigations: { ref: FilesRef; how: string }[] = [];
		const mounted = await dom.mount(view(fake, { navigations }));
		await mounted.until(() => mounted.query(node("out")) !== null);
		const out = mounted.query(`${node("out")} .files-node-main`)!;
		expect(out.getAttribute("title")).toContain("outside the worktree");
		expect(mounted.query(`${node("out")} .files-node-link`)?.textContent).toBe("→ /etc");
		await mounted.click(`${node("out")} .files-node-main`);
		await mounted.click(`${node("pipe")} .files-node-main`);
		expect(navigations).toEqual([]);
		expect(fake.of("files.list").some(r => r.t === "files.list" && r.path === "out")).toBe(false);
		await mounted.click(`${node("in")} .files-node-main`); // a link to a directory inside expands like one
		await mounted.until(() => mounted.query(node("in/a.ts")) !== null);
		await mounted.unmount();
	});

	test("an offline machine shows the offline state, keeps what was loaded, and reloads when it is back", async () => {
		const fake = sampleTree();
		const mounted = await dom.mount(view(fake, { path: "src/a.ts" }));
		await mounted.until(() => mounted.query(".files-line") !== null);
		expect(mounted.query(".files-offline")).toBeNull();
		const before = fake.calls.length;

		fake.offline = true;
		await mounted.rerender(view(fake, { path: "src/a.ts", machine: away }));
		await mounted.until(() => mounted.query(".files-offline") !== null);
		expect(mounted.query(".files-offline")?.textContent).toContain("Home is offline");
		expect(mounted.queryAll(".files-line").length).toBeGreaterThan(0); // stale content stays
		expect(mounted.query(".files-banner[data-kind=stale]")).not.toBeNull();
		expect(fake.calls).toHaveLength(before);

		fake.offline = false;
		await mounted.rerender(view(fake, { path: "src/a.ts", machine: { ...home, linkId: 5 } }));
		await mounted.until(() => mounted.query(".files-offline") === null);
		expect(fake.of("files.status").length).toBeGreaterThan(1);
		expect(mounted.query(".files-banner[data-kind=stale]")).toBeNull();
		await mounted.unmount();
	});

	test("the refresh button reloads status, listings and the open file", async () => {
		const fake = sampleTree();
		const mounted = await dom.mount(view(fake, { path: "src/a.ts" }));
		await mounted.until(() => mounted.query(".files-line") !== null);
		await settle(4);
		const before = {
			status: fake.of("files.status").length,
			list: fake.of("files.list").length,
			read: fake.of("files.read").length,
		};
		expect(mounted.query("button[name=refresh]")?.getAttribute("aria-label")).toBe("Refresh");
		await mounted.click("button[name=refresh]");
		await settle(8);
		expect(fake.of("files.status")).toHaveLength(before.status + 1);
		expect(fake.of("files.list").length).toBeGreaterThanOrEqual(before.list + 2); // root and src
		expect(fake.of("files.read")).toHaveLength(before.read + 1);
		await mounted.unmount();
	});

	test("viewer-back returns to the tree", async () => {
		const fake = sampleTree();
		const mounted = await dom.mount(view(fake, { path: "src/a.ts" }));
		await mounted.until(() => mounted.query(".files-line") !== null);
		expect(mounted.query(".files")?.getAttribute("data-screen")).toBe("viewer");
		await mounted.click("button[name=viewer-back]");
		expect(mounted.query(".files")?.getAttribute("data-screen")).toBe("list");
		await mounted.unmount();
	});

	test("unmounting stops polling and drops queued requests", async () => {
		const fake = sampleTree();
		const mounted = await dom.mount(view(fake, { path: "src/a.ts" }));
		await mounted.until(() => mounted.query(".files-line") !== null);
		await mounted.unmount();
		const after = fake.calls.length;
		await settle(10);
		expect(fake.calls).toHaveLength(after);
	});
});
