import { describe, expect, test } from "bun:test";
import { terminalOnlyCommand } from "../src/terminal-commands";

describe("terminalOnlyCommand", () => {
	test("refuses builtins that only the terminal UI runs, which omp would otherwise send to the model", async () => {
		expect(await terminalOnlyCommand("/new", [])).toContain("/new only works in omp's terminal UI");
		expect(await terminalOnlyCommand("  /tree", [])).toContain("/tree");
		expect(await terminalOnlyCommand("/plan:now", [])).toContain("/plan");
	});

	test("lets through text-mode builtins, prompts, unknown words and same-named session commands", async () => {
		expect(await terminalOnlyCommand("/model anthropic/claude-haiku-4-5", [])).toBeNull();
		expect(await terminalOnlyCommand("/compact", [])).toBeNull();
		expect(await terminalOnlyCommand("explain /new", [])).toBeNull();
		expect(await terminalOnlyCommand("/usr/bin/env is where?", [])).toBeNull();
		expect(await terminalOnlyCommand("/new", [{ name: "new", source: "extension" }])).toBeNull();
		expect(await terminalOnlyCommand("/plan", [{ name: "x", aliases: ["plan"], source: "custom" }])).toBeNull();
	});
});
