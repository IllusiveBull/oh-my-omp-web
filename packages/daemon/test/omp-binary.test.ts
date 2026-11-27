import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompChildEnv } from "../src/omp-source";
import { writeExecutable } from "./fake-bin";
import {
	EXPECTED_OMP_VERSION,
	MIN_OMP_VERSION,
	OmpStartupError,
	compareVersions,
	locateOmp,
	probeRpcProtocol,
	versionMismatch,
} from "../src/omp-binary";

const dir = mkdtempSync(join(tmpdir(), "ompweb-bin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fakeOmp = (name: string, script: string): string => writeExecutable(join(dir, name), script);

const ready = (versions: string) =>
	`{"type":"ready","protocolVersion":1,"supportedProtocolVersions":${versions},"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}`;

describe("omp discovery and startup gating", () => {
	test("reads the version from `omp --version`", async () => {
		const path = fakeOmp("omp-ok", `[ "$1" = "--version" ] && echo "omp/18.20.7"`);
		expect(await locateOmp(path)).toEqual({ path, version: "18.20.7" });
	});

	test("refuses an omp older than the minimum (session leases need >= 18.14.1) and accepts the boundary and newer", async () => {
		expect(MIN_OMP_VERSION).toBe("18.14.1");
		for (const old of ["18.14.0", "18.10.4", "17.99.9", "9.8.7"]) {
			const path = fakeOmp(`omp-old-${old}`, `echo "omp/${old}"`);
			await expect(locateOmp(path)).rejects.toThrow(/too old.*>= 18\.14\.1/);
		}
		for (const fine of ["18.14.1", "18.14.2", "18.19.0", "19.0.0"]) {
			const path = fakeOmp(`omp-new-${fine}`, `echo "omp/${fine}"`);
			expect((await locateOmp(path)).version).toBe(fine);
		}
	});

	test("version comparison is numeric, not lexicographic", () => {
		expect(compareVersions("18.9.0", "18.14.1")).toBeLessThan(0);
		expect(compareVersions("18.14.1", "18.14.1")).toBe(0);
		expect(compareVersions("18.14.10", "18.14.9")).toBeGreaterThan(0);
		expect(compareVersions("18.14.1-beta.1", "18.14.1")).toBe(0);
	});

	test("refuses a missing binary, a failing one, and unparsable version output", async () => {
		await expect(locateOmp(join(dir, "nope"))).rejects.toBeInstanceOf(OmpStartupError);
		await expect(locateOmp(fakeOmp("omp-fail", "exit 3"))).rejects.toThrow(/cannot run/);
		await expect(locateOmp(fakeOmp("omp-junk", "echo hello"))).rejects.toThrow(/cannot parse omp version/);
	});

	test("accepts an omp whose ready frame offers protocol v2", async () => {
		const path = fakeOmp("omp-v2", `echo '${ready("[1,2]")}'; sleep 30`);
		await probeRpcProtocol({ path, version: "9.9.9" });
	});

	test("refuses an omp whose ready frame offers no usable protocol version", async () => {
		const v1 = fakeOmp("omp-v1", `echo '${ready("[1]")}'; sleep 30`);
		await expect(probeRpcProtocol({ path: v1, version: "1.0.0" })).rejects.toThrow(/no usable protocol version/);
		const missing = fakeOmp("omp-noversions", `echo '{"type":"ready","protocolVersion":1}'; sleep 30`);
		await expect(probeRpcProtocol({ path: missing, version: "1.0.0" })).rejects.toThrow(/no usable protocol version/);
	});

	test("refuses an omp that exits before sending ready", async () => {
		const path = fakeOmp("omp-dies", "exit 1");
		await expect(probeRpcProtocol({ path, version: "1.0.0" })).rejects.toThrow(/before sending a ready frame/);
	});

	test("version difference is a warning, equality is silent", () => {
		expect(versionMismatch({ path: "omp", version: EXPECTED_OMP_VERSION })).toBeNull();
		expect(versionMismatch({ path: "omp", version: "0.0.1" })).toContain("differs");
	});
});

describe("omp child environment", () => {
	test("always asks omp to forward an extension's setTitle over RPC, and keeps the rest of the environment", () => {
		const env = ompChildEnv({ HOME: "/h", PI_RPC_EMIT_TITLE: "0", OTHER: undefined });
		expect(env.PI_RPC_EMIT_TITLE).toBe("1");
		expect(env.HOME).toBe("/h");
	});
});
