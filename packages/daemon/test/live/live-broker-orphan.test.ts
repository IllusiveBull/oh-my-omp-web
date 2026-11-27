import type { Subprocess } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerSupervisor } from "../../src/broker-supervisor";
import { descendantPids, processAlive } from "../../src/proc-tree";
import { makeSandbox, requireOmp } from "./live-env";

// Live: the real `omp auth-broker serve` (on Windows `omp.exe` is a launcher with the broker as its child) run by a "daemon"
// process that is then killed hard. The next supervisor has to find the orphan, stop it as a tree and take over the port.
// Isolated: HOME and USERPROFILE of the broker are inside the sandbox; no real credentials are involved.

const sandbox = makeSandbox("omp-web-live-orphan-");
const home = join(sandbox.root, "broker-home");
const spawned: Subprocess[] = [];
const supervisors: BrokerSupervisor[] = [];

afterAll(async () => {
	for (const s of supervisors) await s.stop();
	for (const p of spawned) {
		try {
			p.kill();
		} catch {
			// gone
		}
	}
	sandbox.cleanup();
});

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = probe.port!;
	await probe.stop(true);
	return port;
}
const until = async (predicate: () => boolean, ms = 60_000): Promise<void> => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await Bun.sleep(50);
	}
};
const healthy = (port: number): Promise<boolean> =>
	fetch(`http://127.0.0.1:${port}/v1/healthz`, { signal: AbortSignal.timeout(2000) }).then(
		r => r.ok,
		() => false,
	);

describe("a broker left behind by a hard-killed daemon", () => {
	test("is found by its record (pid + creation time + command line), stopped as a tree, and replaced; stop() then leaves nothing", async () => {
		const omp = await requireOmp();
		const port = await freePort();
		const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "..", "fixtures", "run-real-supervisor.ts")], {
			env: { ...Bun.env, ORPHAN_OMP: omp.path, ORPHAN_PORT: String(port), ORPHAN_HOME: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		spawned.push(daemon);
		const reader = daemon.stdout.getReader();
		let seen = "";
		while (!/running (\d+)/.test(seen)) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`the daemon stand-in ended: ${seen}`);
			seen += new TextDecoder().decode(value);
		}
		const launcher = Number(/running (\d+)/.exec(seen)![1]);
		const record = join(home, "omp-web-broker.json");
		if (process.platform === "win32")
			await until(() => existsSync(record) && readFileSync(record, "utf8").includes('"procs"'));
		const tree = [launcher, ...descendantPids(launcher)];
		if (process.platform === "win32") expect(tree.length).toBeGreaterThanOrEqual(2); // omp.exe + the real broker below it

		// the crash: no cleanup of any kind runs in the daemon
		if (process.platform === "win32")
			expect(Bun.spawnSync(["taskkill", "/F", "/PID", String(daemon.pid)]).exitCode).toBe(0);
		else daemon.kill("SIGKILL");
		await daemon.exited;
		await Bun.sleep(1000);
		// the orphan: at least the real broker is alive and still answers on the port
		expect(tree.some(processAlive)).toBe(true);
		expect(await healthy(port)).toBe(true);
		expect(existsSync(record)).toBe(true);

		const next = new BrokerSupervisor({
			ompPath: omp.path,
			bind: { host: "127.0.0.1", port },
			home,
			env: { ...Bun.env },
		});
		supervisors.push(next);
		next.start();
		await until(() => next.status().phase === "running" && next.status().healthy);
		expect(tree.some(processAlive)).toBe(false); // every process of the old tree is gone
		expect(next.status().pid).not.toBe(launcher);
		expect(next.status().restarts).toBe(0); // no failed start on the way (the orphan was dealt with first)

		const mine = [next.status().pid!, ...descendantPids(next.status().pid!)];
		await next.stop();
		expect(mine.some(processAlive)).toBe(false);
		expect(await healthy(port)).toBe(false);
	}, 120_000);
});
