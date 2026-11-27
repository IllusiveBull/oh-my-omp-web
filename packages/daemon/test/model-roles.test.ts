import { describe, expect, test } from "bun:test";
import { ompModelRoles } from "../src/model-roles";

/** Fakes `omp config … --json`: an effective view (global layer plus `project`) and a writable global layer. */
function fakeConfig(global: Record<string, string>, project: Record<string, string> = {}) {
	const calls: string[][] = [];
	const run = async (args: string[]): Promise<unknown> => {
		calls.push(args);
		if (args[0] === "get" && args[1] === "modelRoles") return { key: "modelRoles", value: { ...global, ...project } };
		if (args[0] === "get" && args[1] === "cycleOrder")
			return { key: "cycleOrder", value: ["smol", "default", "fav"] };
		if (args[0] === "list") return { modelRoles: { value: { ...global } }, theme: { value: "x" } };
		if (args[0] === "set") {
			for (const key of Object.keys(global)) delete global[key];
			Object.assign(global, JSON.parse(args[2]!));
			return { key: "modelRoles", value: global };
		}
		throw new Error(`unexpected ${args.join(" ")}`);
	};
	return { calls, store: ompModelRoles(run) };
}

describe("ompModelRoles", () => {
	test("lists the hub's chat roles with omp's names, then custom roles from the cycle order and assignments", async () => {
		const { store } = fakeConfig({ default: "a/big:high", smol: "a/small", mine: "b/x" });
		const { roles, cycle } = await store.read("/w");
		expect(roles.slice(0, 3)).toEqual([
			{ id: "default", name: "Default", color: "success", selector: "a/big:high" },
			{ id: "smol", name: "Fast", color: "warning", selector: "a/small" },
			{ id: "slow", name: "Thinking", color: "accent", selector: undefined },
		]);
		const ids = roles.map(r => r.id);
		expect(ids).not.toContain("image"); // a non-chat kind
		expect(ids.slice(-2)).toEqual(["fav", "mine"]);
		expect(cycle).toEqual(["smol", "default", "fav"]);
	});

	test("writes the global layer's own roles back with one role changed or removed", async () => {
		const global: Record<string, string> = { default: "a/big", smol: "a/small" };
		const { store, calls } = fakeConfig(global, { plan: "p/only-here" });
		expect(await store.write("/w", "smol", "a/tiny:low")).toBeUndefined();
		expect(global).toEqual({ default: "a/big", smol: "a/tiny:low" }); // project's `plan` not copied in
		expect(await store.write("/w", "default", null)).toBeUndefined();
		expect(global).toEqual({ smol: "a/tiny:low" });
		expect(calls.filter(c => c[0] === "set")).toHaveLength(2);
	});

	test("warns when the session's project still decides the role", async () => {
		const { store } = fakeConfig({}, { plan: "p/only-here" });
		expect(await store.write("/w", "plan", "a/big")).toContain("in this project plan is p/only-here");
	});
});
