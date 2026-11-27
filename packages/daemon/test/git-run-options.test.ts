/** The `env` and `config` options of `runGit`: applied after the hardening, never able to reopen it by accident. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { FileError } from "../src/file-path";
import { runGit } from "../src/git-run";
import { world, type World } from "./handoff-git-fixtures";

let w: World;
let root: string;
beforeAll(async () => {
	w = world();
	root = await w.repo("opts");
});
afterAll(() => w.dispose());

const out = async (args: string[], options: Parameters<typeof runGit>[2] = {}): Promise<string> => {
	const result = await runGit(root, args, { ...options, env: { ...w.env, ...options.env } });
	expect(result.code).toBe(0);
	return new TextDecoder().decode(result.stdout);
};

test("env variables are applied after the GIT_* scrub", async () => {
	process.env.GIT_AUTHOR_NAME = "inherited and scrubbed";
	try {
		expect(
			await out(["var", "GIT_AUTHOR_IDENT"], {
				env: { GIT_AUTHOR_NAME: "From Caller", GIT_AUTHOR_EMAIL: "c@example.com" },
			}),
		).toStartWith("From Caller <c@example.com>");
		expect(await out(["var", "GIT_AUTHOR_IDENT"], { env: { GIT_AUTHOR_EMAIL: "c@example.com" } })).not.toContain(
			"inherited and scrubbed",
		);
	} finally {
		delete process.env.GIT_AUTHOR_NAME;
	}
});

test("config pairs are appended to the hardening overrides and win over them", async () => {
	expect(await out(["config", "--get", "core.hooksPath"])).toBe(
		process.platform === "win32" ? "NUL\n" : "/dev/null\n",
	);
	expect(await out(["config", "--get", "extra.key"], { config: [["extra.key", "extra value"]] })).toBe(
		"extra value\n",
	);
	expect(await out(["config", "--get", "commit.gpgsign"], { config: [["commit.gpgsign", "false"]] })).toBe("false\n");
	expect(await out(["config", "--get", "core.quotePath"], { config: [["core.quotePath", "true"]] })).toBe("true\n");
	// without the option nothing leaks from a previous call
	expect((await runGit(root, ["config", "--get", "extra.key"], { env: w.env })).code).toBe(1);
});

test("the variables that carry the hardening cannot be set through env", async () => {
	for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS"]) {
		await expect(runGit(root, ["status"], { env: { ...w.env, [key]: "x" } })).rejects.toBeInstanceOf(FileError);
	}
});
