import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../src/git-run";
import { processAlive } from "../src/proc-tree";
import { world, type World } from "./handoff-git-fixtures";

let w: World;
let root: string;
beforeAll(async () => {
	w = world();
	root = await w.repo("tree");
});
afterAll(() => w.dispose());

test.skipIf(process.platform !== "win32")(
	"timeout, output cap and root exit kill git descendants and release slots",
	async () => {
		const script = join(w.dir, "child.js");
		writeFileSync(
			script,
			`const fs = require('node:fs');
if (process.argv[2] === 'grandchild') { fs.writeFileSync(process.argv[3], String(process.pid)); process.send('ready'); setInterval(() => {}, 1000); }
else { Bun.spawn([process.execPath, __filename, 'grandchild', process.argv[2]], { stdout: 'inherit', stderr: 'inherit', ipc(message) { if (message === 'ready' && process.argv[3] === 'orphan') process.exit(0); } });
fs.writeFileSync(process.argv[2] + '.child', String(process.pid));
if (process.argv[3] === 'cap') setTimeout(() => process.stdout.write('x'.repeat(10000)), 1000);
setInterval(() => {}, 1000); }
`,
		);
		for (const mode of ["timeout", "cap", "orphan"]) {
			const marker = join(w.dir, mode);
			const quote = (s: string) => `'${s.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
			const result = await runGit(
				root,
				["-c", `alias.treetest=!${quote(process.execPath)} ${quote(script)} ${quote(marker)} ${mode}`, "treetest"],
				{
					env: w.env,
					timeoutMs: 6000,
					maxBytes: mode === "cap" ? 32 : 1024,
				},
			);
			expect(result.timedOut).toBe(mode === "timeout");
			expect(result.truncated).toBe(mode === "cap");
			expect(existsSync(marker)).toBe(true);
			for (const file of [marker, `${marker}.child`]) {
				const pid = Number(readFileSync(file, "utf8"));
				// Real process termination cannot be driven by fake timers.
				for (let i = 0; i < 50 && processAlive(pid); i++) await Bun.sleep(100);
				expect(processAlive(pid)).toBe(false);
			}
		}
		expect((await runGit(root, ["status", "--porcelain"], { env: w.env })).code).toBe(0);
	},
	30000,
);
