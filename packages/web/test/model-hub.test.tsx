import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Ack, ModelRolesWire, SessionOptions } from "@omp-web/protocol";
import { ModelHub, parseRoleSelector } from "../src/components/model-hub";
import { type ClientRequest, DaemonClient } from "../src/store/daemon-client";
import { type FakeDom, installFakeDom } from "./fake-dom";

const ROLES: ModelRolesWire = {
	roles: [
		{ id: "default", name: "Default", selector: "a/big:medium" },
		{ id: "smol", name: "Fast", selector: "a/small" },
		{ id: "slow", name: "Thinking" },
	],
	cycle: ["smol", "default"],
};
const LADDER = (...values: string[]) => values.map(value => ({ value, label: value, description: `${value}…` }));
const OPTIONS: SessionOptions = {
	models: [
		{ provider: "a", id: "big", thinking: LADDER("inherit", "off", "auto", "low", "medium", "high") },
		{ provider: "a", id: "small", thinking: [] }, // does not reason
		{ provider: "b", id: "other", thinking: LADDER("inherit", "off", "low", "high") },
	],
	thinkingLevels: ["off", "low", "high"],
};

class RolesClient extends DaemonClient {
	requests: ClientRequest[] = [];
	override request(_machine: string, request: ClientRequest): Promise<Ack> {
		this.requests.push(request);
		const data = request.t === "session.roles" ? ROLES : request.t === "session.options" ? OPTIONS : undefined;
		return Promise.resolve({ t: "ack", reqId: "", ok: true, data });
	}
}

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());

function hub(client: DaemonClient, ran: string[], closed: { n: number }) {
	return (
		<ModelHub
			client={client}
			machine="m"
			sessionId="s"
			model="a/big"
			thinkingLevel="medium"
			onRun={command => {
				ran.push(command);
				return Promise.resolve({ ok: true });
			}}
			onClose={() => closed.n++}
		/>
	);
}

describe("parseRoleSelector", () => {
	test("splits a thinking suffix only when the model offers it", () => {
		const [big, small] = OPTIONS.models;
		expect(parseRoleSelector("a/big:medium", OPTIONS.models)).toEqual({ model: big, thinking: "medium" });
		expect(parseRoleSelector("a/big", OPTIONS.models)).toEqual({ model: big, thinking: "inherit" });
		expect(parseRoleSelector("a/small", OPTIONS.models)).toEqual({ model: small, thinking: "inherit" });
		expect(parseRoleSelector("a/small:high", OPTIONS.models)).toBeNull();
		expect(parseRoleSelector("z/unknown", OPTIONS.models)).toBeNull();
	});
});

describe("ModelHub", () => {
	test("lists the roles with what they are set to; no per-role switch", async () => {
		const client = new RolesClient("ws://x/ws");
		const view = await dom.mount(hub(client, [], { n: 0 }));
		await view.until(() => view.queryAll(".model-role").length === 3);
		expect(view.queryAll(".model-role-selector").map(e => e.textContent)).toEqual([
			"a/big:medium",
			"a/small",
			"unset",
		]);
		expect(view.queryAll("[data-role=smol] .model-role-actions button").map(b => b.textContent)).toEqual(["Change"]);
		await view.unmount();
	});

	test("Change starts on the role's model and thinking; the strip is the model's own, inherit saves no suffix", async () => {
		const client = new RolesClient("ws://x/ws");
		const ran: string[] = [];
		const view = await dom.mount(hub(client, ran, { n: 0 }));
		await view.until(() => view.queryAll(".model-role").length === 3);

		await view.click("[data-role=default] button[aria-expanded]");
		const strip = () => view.queryAll("[data-role=default] [role=radio]").map(b => b.textContent);
		const on = () => view.query("[data-role=default] [role=radio][aria-checked=true]")?.textContent;
		expect(strip()).toEqual(["inherit", "off", "auto", "low", "medium", "high"]);
		expect(on()).toBe("medium");
		// Another model: its own ladder (no auto); medium is not on it, so back to inherit.
		await view.type("input[name=role-model-filter]", "oth");
		await view.click("[data-role=default] .chip-option");
		expect(strip()).toEqual(["inherit", "off", "low", "high"]);
		expect(on()).toBe("inherit");
		await view.click("[data-role=default] .btn--primary");
		await view.until(() => ran.length > 0);
		expect(client.requests.filter(r => r.t === "session.set_role")).toEqual([
			{ t: "session.set_role", sessionId: "s", role: "default", selector: "b/other" },
		]);
		expect(ran).toEqual(["/switch b/other"]); // the default role also switches the session

		// A model that does not reason has no strip.
		await view.click("[data-role=slow] button[aria-expanded]");
		await view.type("input[name=role-model-filter]", "small");
		await view.click("[data-role=slow] .chip-option");
		expect(view.queryAll("[data-role=slow] [role=radio]")).toEqual([]);
		await view.click("[data-role=slow] .btn--primary");
		await view.until(() => client.requests.filter(r => r.t === "session.set_role").length === 2);
		expect(client.requests.filter(r => r.t === "session.set_role").at(-1)).toEqual({
			t: "session.set_role",
			sessionId: "s",
			role: "slow",
			selector: "a/small",
		});
		expect(ran).toEqual(["/switch b/other"]); // not the session's role
		await view.unmount();
	});

	test("a filter matching hundreds of models still lists, and can pick, the last of them", async () => {
		const many: SessionOptions = {
			thinkingLevels: [],
			models: Array.from({ length: 300 }, (_, i) => ({ provider: "z", id: `m${i}`, thinking: [] })),
		};
		class ManyClient extends RolesClient {
			override request(machine: string, request: ClientRequest): Promise<Ack> {
				if (request.t === "session.options") {
					return Promise.resolve({ t: "ack", reqId: "", ok: true, data: many });
				}
				return super.request(machine, request);
			}
		}
		const client = new ManyClient("ws://x/ws");
		const view = await dom.mount(hub(client, [], { n: 0 }));
		await view.until(() => view.queryAll(".model-role").length === 3);
		await view.click("[data-role=slow] button[aria-expanded]");
		await view.type("input[name=role-model-filter]", "z/m");
		expect(view.queryAll("[data-role=slow] .chip-option")).toHaveLength(300);
		await view.type("input[name=role-model-filter]", "z/m299");
		expect(view.query("[data-role=slow] .chip-option")?.textContent).toBe("z/m299");
		await view.unmount();
	});
});
