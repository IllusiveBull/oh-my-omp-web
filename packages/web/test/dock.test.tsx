import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DockToolbar } from "../src/components/dock";
import { type FakeDom, installFakeDom } from "./fake-dom";

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

describe("DockToolbar", () => {
	test("the Agents badge counts running sub-agents only; the tooltip still names all of them", async () => {
		const view = await dom.mount(<DockToolbar open={null} onToggle={() => {}} agents={{ total: 16, running: 2 }} />);
		expect(view.query("[data-tab=agents] .icon-btn-badge")?.textContent).toBe("2");
		expect(view.query("[data-tab=agents]")?.getAttribute("aria-label")).toBe("Agents: 16 sub-agents, 2 running");
		await view.unmount();

		const idle = await dom.mount(<DockToolbar open={null} onToggle={() => {}} agents={{ total: 16, running: 0 }} />);
		expect(idle.query("[data-tab=agents] .icon-btn-badge")).toBeNull();
		await idle.unmount();
	});

	test("Changes is the last tab and spells out the worktree's changes only while there are some", async () => {
		const changed = await dom.mount(
			<DockToolbar open={null} onToggle={() => {}} changes={{ files: 12, added: 985, removed: 296 }} />,
		);
		expect(changed.queryAll(".dock-tab").at(-1)?.getAttribute("data-tab")).toBe("changes");
		expect(changed.query("[data-tab=changes] .diffstat")?.textContent).toBe("+985−296");
		expect(changed.query("[data-tab=changes] .diffstat-blocks")).toBeNull(); // numbers only, no squares
		expect(changed.query("[data-tab=changes]")?.getAttribute("aria-label")).toBe(
			"Changes: 12 files changed, 985 additions, 296 deletions",
		);
		await changed.unmount();

		const clean = await dom.mount(
			<DockToolbar open={null} onToggle={() => {}} changes={{ files: 0, added: 0, removed: 0 }} />,
		);
		expect(clean.query("[data-tab=changes] .diffstat")).toBeNull();
		await clean.unmount();
	});
});
