import type { Subprocess } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { descendantPids, inspectWindowsProcesses, processAlive } from "../src/proc-tree";
import {
	BrokerSupervisor,
	sameCommand,
	brokerUrlOf,
	parseBrokerBind,
	spawnBrokerChild,
	type BrokerBind,
	type SpawnBroker,
	type SupervisorOptions,
} from "../src/broker-supervisor";

// Windows has no POSIX signals: Bun maps `child.kill("SIGINT")` to TerminateProcess (exit code 130, nothing runs in the child),
// an outside `process.kill(pid, "SIGKILL")` ends with exit code 1, and there is no `ps`. Tests of the signal sequence, of
// SIGKILL being reported by name, and of recognising an orphan through `ps` are POSIX-only; the rest runs everywhere.
const win = process.platform === "win32";

const FAKE = join(import.meta.dir, "fixtures", "fake-broker.ts");
const SHIM = join(import.meta.dir, "fixtures", "fake-shim.ts");
const TOKEN = "fake-broker-token-for-tests";

const scratch: string[] = [];
const running: BrokerSupervisor[] = [];

afterEach(async () => {
	for (const supervisor of running.splice(0)) await supervisor.stop();
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = probe.port!;
	await probe.stop(true);
	return port;
}

const until = async (predicate: () => boolean, ms = 8000): Promise<void> => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
};

interface Rig {
	supervisor: BrokerSupervisor;
	bind: BrokerBind;
	home: string;
	logFile: string;
	spawns: { at: number; mode: string }[];
	log(): string[];
}

/** A supervisor around the fake broker script; `modes` says how each successive start behaves (the last one repeats). */
async function rig(
	modes: string[] = ["serve"],
	options: Partial<SupervisorOptions> = {},
	/** The broker is started behind a launcher process, as `omp.exe` is on Windows (fixtures/fake-shim.ts). */
	shim = false,
): Promise<Rig> {
	const dir = mkdtempSync(join(tmpdir(), "ompweb-broker-"));
	scratch.push(dir);
	const home = join(dir, "home");
	const logFile = join(dir, "events.log");
	const bind: BrokerBind = { host: "127.0.0.1", port: await freePort() };
	const spawns: { at: number; mode: string }[] = [];
	const spawn: SpawnBroker = (_argv, env) => {
		const mode = modes[Math.min(spawns.length, modes.length - 1)]!;
		spawns.push({ at: Date.now(), mode });
		const argv = shim
			? [process.execPath, SHIM, process.execPath, FAKE, String(bind.port)]
			: [process.execPath, FAKE, String(bind.port)];
		return spawnBrokerChild(argv, {
			...env,
			FAKE_BROKER_MODE: mode,
			FAKE_BROKER_LOG: logFile,
			FAKE_BROKER_TOKEN: TOKEN,
		});
	};
	const supervisor = new BrokerSupervisor({
		ompPath: "omp-not-used",
		bind,
		home,
		env: { PATH: Bun.env.PATH, PI_CODING_AGENT_DIR: "/must/not/leak", OMP_AUTH_BROKER_TOKEN: "must-not-leak" },
		spawn,
		getToken: async () => ({ token: TOKEN, path: join(home, ".omp", "auth-broker.token") }),
		backoff: { minMs: 40, maxMs: 160, stableMs: 60_000 },
		healthIntervalMs: 50,
		startTimeoutMs: 3000,
		stopGraceMs: 400,
		...options,
	});
	running.push(supervisor);
	return {
		supervisor,
		bind,
		home,
		logFile,
		spawns,
		log: () => {
			try {
				return readFileSync(logFile, "utf8").trim().split("\n");
			} catch {
				return [];
			}
		},
	};
}

describe("parseBrokerBind / brokerUrlOf", () => {
	test("host:port, with brackets for IPv6", () => {
		expect(parseBrokerBind("127.0.0.1:8765")).toEqual({ host: "127.0.0.1", port: 8765 });
		expect(parseBrokerBind("100.101.102.103:9000")).toEqual({ host: "100.101.102.103", port: 9000 });
		expect(parseBrokerBind("[::1]:8765")).toEqual({ host: "[::1]", port: 8765 });
		expect(brokerUrlOf({ host: "[::1]", port: 8765 })).toBe("http://[::1]:8765");
		expect(brokerUrlOf({ host: "::1", port: 8765 })).toBe("http://[::1]:8765");
		expect(brokerUrlOf({ host: "100.64.0.1", port: 1 })).toBe("http://100.64.0.1:1");
	});

	test("a wildcard address is refused (the vault would be on every interface), and so are malformed ones", () => {
		for (const wildcard of ["0.0.0.0:8765", "[::]:8765", "*:8765", ":8765"]) {
			expect(() => parseBrokerBind(wildcard)).toThrow();
		}
		expect(() => parseBrokerBind("0.0.0.0:8765")).toThrow("every interface");
		for (const bad of ["8765", "localhost", "127.0.0.1:0", "127.0.0.1:70000", "127.0.0.1:port", ""]) {
			expect(() => parseBrokerBind(bad)).toThrow();
		}
	});
});

describe("BrokerSupervisor", () => {
	test("starts the child, waits until it answers, reports url, pid, token file and version; the token is held, not exposed in status", async () => {
		const r = await rig();
		const changes: string[] = [];
		r.supervisor.onChange(() => changes.push(r.supervisor.status().phase));
		expect(r.supervisor.token).toBeNull();
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "running" && r.supervisor.status().healthy);
		const status = r.supervisor.status();
		expect(status).toMatchObject({
			phase: "running",
			healthy: true,
			url: `http://127.0.0.1:${r.bind.port}`,
			advertisedUrl: `http://127.0.0.1:${r.bind.port}`,
			bind: `127.0.0.1:${r.bind.port}`,
			home: r.home,
			tokenFile: join(r.home, ".omp", "auth-broker.token"),
			agentDb: join(r.home, ".omp", "agent", "agent.db"),
			version: "fake-1",
			restarts: 0,
			lastError: null,
		});
		expect(typeof status.pid).toBe("number");
		expect(r.supervisor.token).toBe(TOKEN);
		expect(JSON.stringify(status)).not.toContain(TOKEN);
		expect(changes).toContain("starting");
		expect(changes).toContain("running");
	});

	test("the child gets the broker's own HOME and none of the variables that would move its state or point it at another broker", async () => {
		const r = await rig();
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "running");
		const start = r.log().find(line => line.startsWith("start"))!;
		expect(start).toContain(`home=${r.home}`);
		expect(start).toContain("agentdir=-");
		expect(start).toContain("brokertoken=-");
	});

	test("advertiseUrl is what other machines are told, while the gateway machine keeps the local url", async () => {
		const r = await rig(["serve"], { advertiseUrl: "http://100.64.0.9:8765" });
		expect(r.supervisor.url).toBe(`http://127.0.0.1:${r.bind.port}`);
		expect(r.supervisor.advertisedUrl).toBe("http://100.64.0.9:8765");
		expect(r.supervisor.status().advertisedUrl).toBe("http://100.64.0.9:8765");
	});

	test("a broker that crashes is restarted with growing backoff and the reason is kept", async () => {
		const r = await rig(["crash", "crash", "serve"]);
		const delays: number[] = [];
		r.supervisor.onChange(() => {
			const status = r.supervisor.status();
			if (status.phase === "restarting" && status.lastError && status.nextRetryAt !== null) {
				delays.push(status.nextRetryAt - status.lastError.at);
			}
		});
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "running" && r.spawns.length === 3);
		const status = r.supervisor.status();
		expect(status.restarts).toBe(2);
		expect(status.lastError?.message).toContain("exited with code 3");
		// Assert the scheduled backoff, not wall-clock spawn gaps (process startup and CIM latency vary independently).
		expect(delays).toEqual([40, 80]);
	});

	test("while it waits to restart the status says so, with when the next attempt is", async () => {
		const r = await rig(["crash", "serve"], { backoff: { minMs: 400, maxMs: 400, stableMs: 60_000 } });
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "restarting");
		const status = r.supervisor.status();
		expect(status.healthy).toBe(false);
		expect(status.pid).toBeNull();
		expect(status.nextRetryAt).toBeGreaterThan(Date.now());
		expect(status.lastError?.message).toContain("exited with code 3");
		await until(() => r.supervisor.status().phase === "running");
		expect(r.supervisor.status().nextRetryAt).toBeNull();
	});

	test("kill -9 of the running broker is noticed and it comes back with a new pid", async () => {
		const r = await rig();
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "running");
		const first = r.supervisor.status().pid!;
		process.kill(first, "SIGKILL");
		await until(() => r.supervisor.status().phase === "restarting");
		expect(r.supervisor.status().lastError?.message).toContain(win ? "exited with code 1" : "killed by SIGKILL");
		await until(() => r.supervisor.status().phase === "running" && r.supervisor.status().healthy);
		expect(r.supervisor.status().pid).not.toBe(first);
		expect(r.supervisor.status().restarts).toBe(1);
	});

	test("a child that never answers is killed after the start timeout and tried again", async () => {
		const r = await rig(["silent", "serve"], { startTimeoutMs: 300 });
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "restarting");
		expect(r.supervisor.status().lastError?.message).toContain("did not answer");
		await until(() => r.supervisor.status().phase === "running");
		expect(r.spawns.map(s => s.mode)).toEqual(["silent", "serve"]);
	});

	test("a token that cannot be read is a failed start, retried", async () => {
		let attempts = 0;
		const r = await rig(["serve"], {
			getToken: async () => {
				if (++attempts === 1) throw new Error("omp auth-broker token failed (exit 1)");
				return { token: TOKEN, path: "/x/.omp/auth-broker.token" };
			},
		});
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "restarting");
		expect(r.supervisor.status().lastError?.message).toContain("cannot read the broker token");
		expect(r.spawns).toHaveLength(0);
		await until(() => r.supervisor.status().phase === "running");
	});

	test("a health probe that starts failing flips `healthy` while the child keeps running, and back when it answers again", async () => {
		let down = false;
		const r = await rig(["serve"], {
			fetch: (url, init) => (down ? Promise.reject(new Error("connect ECONNREFUSED")) : fetch(url, init)),
		});
		r.supervisor.start();
		await until(() => r.supervisor.status().healthy);
		const pid = r.supervisor.status().pid;
		down = true;
		await until(() => !r.supervisor.status().healthy);
		expect(r.supervisor.status()).toMatchObject({ phase: "running", pid });
		down = false;
		await until(() => r.supervisor.status().healthy);
		expect(r.supervisor.status().pid).toBe(pid);
	});

	test("stop() sends SIGINT (the broker's graceful path) and the child is gone afterwards", async () => {
		const r = await rig();
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "running");
		const pid = r.supervisor.status().pid!;
		await r.supervisor.stop();
		expect(r.supervisor.status()).toMatchObject({ phase: "stopped", healthy: false, pid: null });
		if (!win) expect(r.log()).toContain("sigint"); // Windows: the child is terminated without running any handler
		expect(() => process.kill(pid, 0)).toThrow(); // no such process
		// and it stays stopped: no restart after a deliberate stop
		const spawned = r.spawns.length;
		await Bun.sleep(300);
		expect(r.spawns).toHaveLength(spawned);
	});

	test.skipIf(win)("a broker that ignores SIGINT is killed after the grace period", async () => {
		const r = await rig(["ignore-sigint"], { stopGraceMs: 200 });
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "running");
		const pid = r.supervisor.status().pid!;
		const started = Date.now();
		await r.supervisor.stop();
		expect(Date.now() - started).toBeGreaterThanOrEqual(190);
		expect(r.log()).toContain("sigint");
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("stopping while it waits to restart ends the wait instead of starting another child", async () => {
		const r = await rig(["crash", "serve"], { backoff: { minMs: 5000, maxMs: 5000, stableMs: 60_000 } });
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "restarting");
		const started = Date.now();
		await r.supervisor.stop();
		expect(Date.now() - started).toBeLessThan(1500);
		expect(r.spawns).toHaveLength(1);
		expect(r.supervisor.status().phase).toBe("stopped");
	});
});

describe("a broker orphaned by a SIGKILLed daemon", () => {
	const isAlive = (pid: number): boolean => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	test.skipIf(win)(
		"is stopped by the next daemon (SIGINT, as for its own), which then runs its own broker on the same port",
		async () => {
			const r = await rig();
			const port = r.bind.port;
			// a real "daemon" process around the fake broker; kill -9 it, as a crash or `kill -9` would
			const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "run-supervisor.ts")], {
				env: {
					...Bun.env,
					ORPHAN_PORT: String(port),
					ORPHAN_HOME: r.home,
					ORPHAN_LOG: r.logFile,
					ORPHAN_TOKEN: TOKEN,
				},
				stdout: "pipe",
				stderr: "ignore",
			});
			const reader = daemon.stdout.getReader();
			let seen = "";
			while (!/running (\d+)/.test(seen)) {
				const { value, done } = await reader.read();
				if (done) throw new Error(`the daemon stand-in ended: ${seen}`);
				seen += new TextDecoder().decode(value);
			}
			const orphan = Number(/running (\d+)/.exec(seen)![1]);
			expect(existsSync(join(r.home, "omp-web-broker.json"))).toBe(true);
			daemon.kill("SIGKILL");
			await daemon.exited;
			expect(isAlive(orphan)).toBe(true); // the broker outlived its daemon...
			expect((await fetch(`http://127.0.0.1:${port}/v1/healthz`)).status).toBe(200); // ...and still holds the port

			r.supervisor.start();
			await until(() => r.supervisor.status().phase === "running" && r.supervisor.status().healthy);
			await until(() => !isAlive(orphan));
			expect(r.supervisor.status().pid).not.toBe(orphan);
			expect(r.supervisor.status().restarts).toBe(0); // no failed start on the way: the orphan was dealt with first
			expect(r.log().filter(l => l === "sigint")).toHaveLength(1); // stopped the graceful way
		},
		30_000,
	);

	test("reapStale: a pid file naming a dead process is just removed", async () => {
		const r = await rig();
		const file = join(r.home, "omp-web-broker.json");
		await Bun.write(file, JSON.stringify({ pid: 2_147_000_000, startedAt: Date.now(), argv: ["x"] }));
		expect(await r.supervisor.reapStale()).toBe("none");
		expect(existsSync(file)).toBe(false);
	});

	test("reapStale never touches a live process that is not provably the recorded broker (other command, other start time, no ps)", async () => {
		const other = Bun.spawn(["sleep", "60"]);
		try {
			const argv = ["sleep", "60"];
			const startedAt = Date.now();
			const own = { command: "sleep 60", startedAt };
			const cases: [string, { pid: number; startedAt: number; argv: string[] }, ProcessInfoStub][] = [
				[
					"same command line but another start time",
					{ pid: other.pid, startedAt, argv },
					{ ...own, startedAt: startedAt - 3_600_000 },
				],
				["another command line", { pid: other.pid, startedAt, argv: ["omp", "auth-broker", "serve"] }, own],
				["a process that cannot be inspected", { pid: other.pid, startedAt, argv }, null],
			];
			for (const [label, record, info] of cases) {
				const r = await rig(["serve"], { inspect: async () => info });
				const file = join(r.home, "omp-web-broker.json");
				await Bun.write(file, JSON.stringify(record));
				expect([label, await r.supervisor.reapStale()]).toEqual([label, "foreign"]);
				expect(isAlive(other.pid)).toBe(true);
				expect(existsSync(file)).toBe(false);
			}
			// and with the real `ps`: the same pid, a record made up for it, an honest command line: it IS recognised
			if (!win) {
				const real = await rig();
				await Bun.write(
					join(real.home, "omp-web-broker.json"),
					JSON.stringify({ pid: other.pid, startedAt: Date.now(), argv }),
				);
				expect(await real.supervisor.reapStale()).toBe("reaped");
				await until(() => !isAlive(other.pid));
			}
		} finally {
			other.kill("SIGKILL");
		}
	});

	test("a clean stop removes the pid file", async () => {
		const r = await rig();
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "running");
		const file = join(r.home, "omp-web-broker.json");
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: r.supervisor.status().pid });
		await r.supervisor.stop();
		expect(existsSync(file)).toBe(false);
	});
});

type ProcessInfoStub = { startedAt: number; command: string } | null;

describe("sameCommand", () => {
	test("the program by file name, the arguments exactly", () => {
		const argv = ["/Users/me/.local/bin/omp", "auth-broker", "serve", "--bind", "127.0.0.1:8765"];
		expect(sameCommand("omp auth-broker serve --bind 127.0.0.1:8765", argv)).toBe(true);
		expect(sameCommand(argv.join(" "), argv)).toBe(true);
		expect(sameCommand("bun /x/node_modules/.bin/omp auth-broker serve --bind 127.0.0.1:8765", argv)).toBe(true); // a shebang script
		expect(sameCommand("a b /x/omp auth-broker serve --bind 127.0.0.1:8765", argv)).toBe(false);
		expect(sameCommand("omp auth-broker serve --bind 127.0.0.1:9999", argv)).toBe(false);
		expect(sameCommand("vim auth-broker serve --bind 127.0.0.1:8765", argv)).toBe(false);
		expect(sameCommand("omp", argv)).toBe(false);
		expect(sameCommand("omp auth-broker serve --bind 127.0.0.1:8765 --extra", argv)).toBe(false);
		expect(sameCommand("anything", [])).toBe(false);
	});
});

// Windows: no signals, no graceful stop, and `omp.exe` is a launcher in front of the real broker. The orphan of a hard-killed
// daemon is tested against the real omp in test/live/live-broker-orphan.test.ts (a Bun-made launcher's child dies with its
// parent, so a fixture cannot reproduce it).
describe.skipIf(!win)("Windows: the broker is stopped as a tree", () => {
	test("stop() kills the launcher and its child, and resolves only once nothing is left listening", async () => {
		const r = await rig(["serve"], {}, true);
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "running" && r.supervisor.status().healthy);
		const shim = r.supervisor.status().pid!;
		await until(() => descendantPids(shim).length > 0);
		const tree = [shim, ...descendantPids(shim)];
		expect(tree.length).toBeGreaterThanOrEqual(2);
		await r.supervisor.stop();
		expect(tree.map(pid => [pid, processAlive(pid)])).toEqual(tree.map(pid => [pid, false]));
		await expect(fetch(`http://127.0.0.1:${r.bind.port}/v1/healthz`)).rejects.toThrow(); // the port is closed *now*
		expect(r.supervisor.status()).toMatchObject({ phase: "stopped", healthy: false, pid: null });
		expect(existsSync(join(r.home, "omp-web-broker.json"))).toBe(false);
	});

	test("stop rejects instead of claiming success if the listener remains reachable", async () => {
		let stuck = false;
		let ticks = 0;
		const r = await rig(
			["serve"],
			{
				now: () => Date.now() + (stuck ? ticks++ * 100_000 : 0),
				fetch: (url, init) => (stuck ? Promise.resolve(Response.json({ version: "fake" })) : fetch(url, init)),
			},
			true,
		);
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "running");
		stuck = true;
		await expect(r.supervisor.stop()).rejects.toThrow(/still listening/);
	});

	test("when the launcher dies but its child keeps listening, the supervisor reaps that child (recorded tree) and restarts cleanly", async () => {
		const r = await rig(["serve"], {}, true);
		r.supervisor.start();
		await until(() => r.supervisor.status().phase === "running" && r.supervisor.status().healthy);
		const shim = r.supervisor.status().pid!;
		await until(
			() =>
				existsSync(join(r.home, "omp-web-broker.json")) &&
				readFileSync(join(r.home, "omp-web-broker.json"), "utf8").includes('"procs"'),
		);
		const record = JSON.parse(readFileSync(join(r.home, "omp-web-broker.json"), "utf8")) as {
			procs: { pid: number }[];
		};
		expect(record.procs.map(p => p.pid)).toContain(shim);
		expect(record.procs.length).toBeGreaterThanOrEqual(2);
		const child = record.procs.find(p => p.pid !== shim)!.pid;
		// kill only the launcher (what a TerminateProcess of omp.exe does): children first is NOT done here, on purpose
		process.kill(shim, "SIGKILL");
		await until(
			() =>
				r.supervisor.status().phase === "restarting" ||
				(r.supervisor.status().phase === "running" && r.supervisor.status().pid !== shim),
		);
		await until(
			() =>
				r.supervisor.status().phase === "running" &&
				r.supervisor.status().healthy &&
				r.supervisor.status().pid !== shim,
		);
		expect(processAlive(child)).toBe(false); // the old child did not stay behind holding the port
	});

	test("reapStale identifies a process by pid + creation time + command line: only the exact recorded one is killed", async () => {
		const victims: Subprocess[] = [];
		const live = (): Subprocess => {
			const p = Bun.spawn(["ping", "-n", "300", "127.0.0.1"], { stdout: "ignore", stderr: "ignore" });
			victims.push(p);
			return p;
		};
		try {
			const same = live();
			await Bun.sleep(300);
			const info = (await inspectWindowsProcesses([same.pid])).get(same.pid)!;
			expect(info.command).toContain("ping");
			const cases: [string, { pid: number; startedAt: number; command: string }, "foreign" | "reaped"][] = [
				[
					"another creation time (pid reuse)",
					{ pid: same.pid, startedAt: info.startedAt - 60_000, command: info.command },
					"foreign",
				],
				[
					"another command line",
					{ pid: same.pid, startedAt: info.startedAt, command: "C:\\other.exe serve" },
					"foreign",
				],
			];
			for (const [label, proc, expected] of cases) {
				const r = await rig();
				await Bun.write(
					join(r.home, "omp-web-broker.json"),
					JSON.stringify({ pid: proc.pid, startedAt: proc.startedAt, argv: ["x"], procs: [proc] }),
				);
				expect([label, await r.supervisor.reapStale()]).toEqual([label, expected]);
				expect([label, processAlive(same.pid)]).toEqual([label, true]); // never touched
			}
			const r = await rig();
			await Bun.write(
				join(r.home, "omp-web-broker.json"),
				JSON.stringify({
					pid: same.pid,
					startedAt: info.startedAt,
					argv: ["x"],
					procs: [{ pid: same.pid, startedAt: info.startedAt, command: info.command }],
				}),
			);
			expect(await r.supervisor.reapStale()).toBe("reaped");
			expect(processAlive(same.pid)).toBe(false);
			// the tree of a recorded launcher goes with it
			const launcher = Bun.spawn(["cmd", "/c", "ping -n 300 127.0.0.1 > nul"], {
				stdout: "ignore",
				stderr: "ignore",
			});
			victims.push(launcher);
			await until(() => descendantPids(launcher.pid).length > 0);
			const kids = descendantPids(launcher.pid);
			const seen = await inspectWindowsProcesses([launcher.pid]);
			const rr = await rig();
			await Bun.write(
				join(rr.home, "omp-web-broker.json"),
				JSON.stringify({
					pid: launcher.pid,
					startedAt: seen.get(launcher.pid)!.startedAt,
					argv: ["x"],
					procs: [{ pid: launcher.pid, ...seen.get(launcher.pid)! }],
				}),
			);
			expect(await rr.supervisor.reapStale()).toBe("reaped");
			expect([launcher.pid, ...kids].some(processAlive)).toBe(false);
		} finally {
			for (const v of victims) {
				try {
					v.kill();
				} catch {
					// gone
				}
			}
		}
	}, 20_000);

	test("a descendant handle from the native layer reports the launcher's child (what the supervisor records)", async () => {
		const launcher = Bun.spawn(["cmd", "/c", "ping -n 30 127.0.0.1 > nul"], { stdout: "ignore", stderr: "ignore" });
		try {
			await until(() => descendantPids(launcher.pid).length > 0);
			const handle = Process.fromPid(launcher.pid);
			expect(handle?.children().length).toBeGreaterThan(0);
		} finally {
			launcher.kill();
		}
	});
});
