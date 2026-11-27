import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvBroker } from "../src/env-broker";
import { SessionManager } from "../src/manager";
import { ompChildEnv, OmpRpcSource } from "../src/omp-source";
import { posixPath, writeExecutable } from "./fake-bin";

const dir = mkdtempSync(join(tmpdir(), "ompweb-ompenv-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FIXTURE = join(import.meta.dir, "fixtures", "fake-omp.ts");

/** An executable that runs the fake omp, recording its environment in `out`; extra variables are set by the caller's env. */
function fakeOmp(name: string): { path: string; out: string } {
	const out = join(dir, `${name}.env.json`);
	const path = writeExecutable(join(dir, name), `exec "${posixPath(process.execPath)}" "${posixPath(FIXTURE)}" "$@"`);
	return { path, out };
}

const recorded = (out: string): { url: string | null; token: string | null; title: string | null; argv: string[] } =>
	JSON.parse(readFileSync(out, "utf8"));

describe("ompChildEnv", () => {
	test("adds the broker variables on top of the daemon's environment and always asks for titles", () => {
		const env = ompChildEnv(
			{ HOME: "/h", OMP_AUTH_BROKER_URL: "http://old", PI_RPC_EMIT_TITLE: "0" },
			{ OMP_AUTH_BROKER_URL: "http://new:8765", OMP_AUTH_BROKER_TOKEN: "t" },
		);
		expect(env).toEqual({
			HOME: "/h",
			OMP_AUTH_BROKER_URL: "http://new:8765",
			OMP_AUTH_BROKER_TOKEN: "t",
			PI_RPC_EMIT_TITLE: "1",
		});
		expect(ompChildEnv({ HOME: "/h" })).toEqual({ HOME: "/h", PI_RPC_EMIT_TITLE: "1" });
	});
});

describe("the omp child gets the credential broker", () => {
	test("a real child process is started with OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN from the machine's broker", async () => {
		const omp = fakeOmp("omp-env");
		process.env.FAKE_OMP_ENV_OUT = omp.out;
		const broker = new EnvBroker();
		broker.setGateway({ url: "http://100.64.0.7:8765", token: "tok-from-gateway" });
		const source = new OmpRpcSource({ ompPath: omp.path, cwd: dir, env: broker.childEnv() });
		try {
			await source.start();
			expect(recorded(omp.out)).toMatchObject({
				url: "http://100.64.0.7:8765",
				token: "tok-from-gateway",
				title: "1",
			});
			// the token travels in the environment, never on the command line (where `ps` would show it)
			expect(JSON.stringify(recorded(omp.out).argv)).not.toContain("tok-from-gateway");
		} finally {
			await source.stop();
			delete process.env.FAKE_OMP_ENV_OUT;
		}
	});

	test("the manager reads the machine's broker at every spawn: a later config reaches later sessions", async () => {
		const omp = fakeOmp("omp-env-manager");
		process.env.FAKE_OMP_ENV_OUT = omp.out;
		process.env.FAKE_OMP_MODE = "die";
		const broker = new EnvBroker();
		const manager = new SessionManager({
			ompPath: omp.path,
			resolveCwd: async cwd => cwd,
			childEnv: () => broker.childEnv(),
			explainSpawnError: error => broker.explainSpawnError(error),
		});
		try {
			await expect(manager.create(dir)).rejects.toThrow(); // the fake dies at startup
			expect(recorded(omp.out)).toMatchObject({ url: null, token: null }); // no broker yet: omp is left to its own credentials
			broker.setGateway({ url: "http://127.0.0.1:1", token: "tok-2" });
			await expect(manager.create(dir)).rejects.toThrow();
			expect(recorded(omp.out)).toMatchObject({ url: "http://127.0.0.1:1", token: "tok-2" });
		} finally {
			delete process.env.FAKE_OMP_ENV_OUT;
			delete process.env.FAKE_OMP_MODE;
		}
	});

	test("when omp cannot start and the machine's broker is unreachable, the error names the broker instead of omp's opaque failure", async () => {
		const omp = fakeOmp("omp-env-explain");
		process.env.FAKE_OMP_ENV_OUT = omp.out;
		process.env.FAKE_OMP_MODE = "die";
		const broker = new EnvBroker({ timeoutMs: 500 });
		broker.setGateway({ url: "http://127.0.0.1:1", token: "tok-3" }); // nothing listens on port 1
		await broker.probe();
		expect(broker.status().state).toBe("unreachable");
		const manager = new SessionManager({
			ompPath: omp.path,
			resolveCwd: async cwd => cwd,
			childEnv: () => broker.childEnv(),
			explainSpawnError: error => broker.explainSpawnError(error),
		});
		try {
			const error = await manager.create(dir).then(
				() => null,
				(e: unknown) => (e instanceof Error ? e : new Error(String(e))),
			);
			expect(error?.message).toContain("Agent process exited with code 1"); // omp's own failure is kept
			expect(error?.message).toContain("cannot use the auth broker at http://127.0.0.1:1");
			expect(error?.message).not.toContain("tok-3");
		} finally {
			delete process.env.FAKE_OMP_ENV_OUT;
			delete process.env.FAKE_OMP_MODE;
		}
	});

	test("an omp that fails for another reason keeps its own error when the broker is healthy", async () => {
		const omp = fakeOmp("omp-env-plain");
		process.env.FAKE_OMP_ENV_OUT = omp.out;
		process.env.FAKE_OMP_MODE = "die";
		const manager = new SessionManager({
			ompPath: omp.path,
			resolveCwd: async cwd => cwd,
			explainSpawnError: error => new EnvBroker().explainSpawnError(error),
		});
		try {
			const error = await manager.create(dir).then(
				() => null,
				(e: unknown) => (e instanceof Error ? e : new Error(String(e))),
			);
			expect(error?.message).toContain("Agent process exited with code 1");
			expect(error?.message).not.toContain("cannot use the auth broker");
		} finally {
			delete process.env.FAKE_OMP_ENV_OUT;
			delete process.env.FAKE_OMP_MODE;
		}
	});
});

describe("an omp that dies mid-session", () => {
	test("the exit reason carries why the daemon stopped reading and the tail of omp's stderr, not just the code", async () => {
		const omp = fakeOmp("omp-env-crash");
		process.env.FAKE_OMP_ENV_OUT = omp.out;
		const source = new OmpRpcSource({ ompPath: omp.path, cwd: dir });
		const exited = Promise.withResolvers<string>();
		source.onExit(exited.resolve);
		try {
			await source.start();
			// (not `expect(...).rejects`: under it Bun stops reading the child's stdout, so omp never sees EPIPE)
			const failed = await source.setSessionName("boom").then(
				() => null,
				(e: unknown) => (e instanceof Error ? e.message : String(e)),
			);
			const reason = await exited.promise;
			expect(failed).toBe(reason); // the pending command fails with the same reason
			expect(reason).toStartWith("omp exited with code 1");
			expect(reason).toContain("reading omp's output failed: rpc frame must be an object");
			expect(reason).toContain("stderr:\nfatal: something broke mid-session");
		} finally {
			await source.stop();
			delete process.env.FAKE_OMP_ENV_OUT;
		}
	});
});
