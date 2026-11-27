import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { checkLeaseEnvironment, probeLeases, type LeaseFacts } from "../src/lease";
import { writeExecutable } from "./fake-bin";

const healthy: LeaseFacts = {
	platform: "darwin",
	home: "/Users/me",
	accountHome: "/Users/me",
	ownersDir: "/Users/me/.omp/run/session-owners",
	ownersDirExists: true,
	configRoot: "/Users/me/.omp",
	sessionsDir: "/Users/me/.omp/agent/sessions",
	sessionsDirExists: true,
	sessionsDirUid: 501,
	uid: 501,
	env: {},
};

describe("lease environment check", () => {
	test("a normal login environment raises no warning", () => {
		expect(checkLeaseEnvironment(healthy)).toEqual([]);
	});

	test("warns when the daemon's HOME is not the account's home (a TUI from a login shell would use another lease directory)", () => {
		const warnings = checkLeaseEnvironment({ ...healthy, home: "/tmp/sandbox-home" });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("/tmp/sandbox-home");
		expect(warnings[0]).toContain("/Users/me");
	});

	describe("Windows", () => {
		const win: LeaseFacts = {
			...healthy,
			platform: "win32",
			home: "C:\\Users\\Me",
			accountHome: "C:\\Users\\Me",
			ownersDir: "C:\\Users\\Me\\.omp\\run\\session-owners",
			configRoot: "C:\\Users\\Me\\.omp",
			sessionsDir: "C:\\Users\\Me\\.omp\\agent\\sessions",
			sessionsDirUid: undefined,
			uid: undefined,
		};

		test("the same home written another way (case, separators, a trailing slash) is the same home: no warning", () => {
			expect(checkLeaseEnvironment(win)).toEqual([]);
			expect(checkLeaseEnvironment({ ...win, home: "c:/users/me/" })).toEqual([]);
			expect(checkLeaseEnvironment({ ...win, accountHome: "C:\\USERS\\ME" })).toEqual([]);
		});

		test("another home (an isolated USERPROFILE, a different drive) still warns", () => {
			expect(checkLeaseEnvironment({ ...win, home: "C:\\Temp\\sandbox" }).join("\n")).toContain("C:\\Temp\\sandbox");
			expect(checkLeaseEnvironment({ ...win, home: "D:\\Users\\Me" })).toHaveLength(1);
		});

		// What a scheduled task gives the daemon: USERPROFILE, no HOME. omp and os.homedir() follow USERPROFILE on Windows and
		// ignore HOME, so a missing or odd HOME must not warn, and the lease directory must still be the user's own.
		test.skipIf(process.platform !== "win32")(
			"real process with HOME unset (or nonsense) and USERPROFILE set: no home warning",
			() => {
				const probe = (env: Record<string, string | undefined>): string[] => {
					const done = Bun.spawnSync(
						[
							process.execPath,
							"-e",
							'import { collectLeaseFacts, checkLeaseEnvironment } from "' +
								import.meta.dir.replaceAll("\\", "/") +
								'/../src/lease"; const f = collectLeaseFacts(); console.log(JSON.stringify({ w: checkLeaseEnvironment(f).filter(x => x.startsWith("HOME is")), owners: f.ownersDir, home: f.home }));',
						],
						{ env, stdout: "pipe", stderr: "pipe" },
					);
					expect(done.stderr.toString()).toBe("");
					return [done.stdout.toString().trim()];
				};
				const base = { ...Bun.env } as Record<string, string | undefined>;
				const unset = JSON.parse(probe({ ...base, HOME: undefined })[0]!);
				expect(unset.w).toEqual([]);
				expect(win32.normalize(unset.owners).toLowerCase()).toContain(
					win32.normalize(Bun.env.USERPROFILE!).toLowerCase(),
				);
				const odd = JSON.parse(probe({ ...base, HOME: "/c/not/a/home" })[0]!);
				expect(odd.w).toEqual([]);
				expect(odd.owners).toBe(unset.owners);
			},
		);
	});

	test("warns when the sessions belong to another user, and when sessions were moved out of the config root by PI_CODING_AGENT_DIR", () => {
		expect(checkLeaseEnvironment({ ...healthy, sessionsDirUid: 0 }).join("\n")).toContain("another user");
		const configRoot = join(tmpdir(), "omp-config");
		const moved = checkLeaseEnvironment({
			...healthy,
			configRoot,
			env: { piCodingAgentDir: join(tmpdir(), "omp-agent") },
		});
		expect(moved.join("\n")).toContain("PI_CODING_AGENT_DIR");
		// pointing it inside the config root changes nothing about where leases live
		expect(
			checkLeaseEnvironment({ ...healthy, configRoot, env: { piCodingAgentDir: join(configRoot, "agent") } }),
		).toEqual([]);
	});

	test("only warns about a missing lease directory on platforms using flock files", () => {
		expect(checkLeaseEnvironment({ ...healthy, ownersDirExists: false }).join("\n")).toContain("does not");
		expect(checkLeaseEnvironment({ ...healthy, ownersDirExists: false, sessionsDirExists: false })).toEqual([]);
		for (const platform of ["linux", "win32"] as const) {
			expect(checkLeaseEnvironment({ ...healthy, platform, ownersDirExists: false })).toEqual([]);
		}
	});

	test("warns on Linux XDG_STATE_HOME", () => {
		const linux = checkLeaseEnvironment({ ...healthy, platform: "linux", env: { xdgStateHome: "/state" } });
		expect(linux.join("\n")).toContain("XDG_STATE_HOME");
		expect(checkLeaseEnvironment({ ...healthy, env: { xdgStateHome: "/state" } })).toEqual([]); // macOS ignores it
	});
});

describe("omp session lease probe", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompweb-lease-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** A stand-in `omp` that answers `session lease --json -- <ids>`: ids starting with "held-" are held, "odd-" unknown. */
	function fakeOmp(body?: string): string {
		return writeExecutable(
			join(dir, "omp"),
			body ??
				`[ "$1 $2 $3 $4" = "session lease --json --" ] || { echo "bad argv: $*" >&2; exit 2; }
shift 4
held=""; unknown=""
for id in "$@"; do
  case "$id" in
    held-*) held="$held\\"$id\\"," ;;
    odd-*) unknown="$unknown\\"$id\\"," ;;
  esac
done
echo "{\\"held\\":[\${held%,}],\\"unknown\\":[\${unknown%,}]}"
`,
		);
	}

	test("reports held and unknown ids from the CLI's JSON, across more ids than one invocation carries", async () => {
		const ids = Array.from({ length: 450 }, (_, i) =>
			i % 100 === 7 ? `held-${i}` : i % 150 === 3 ? `odd-${i}` : `free-${i}`,
		);
		const report = await probeLeases(fakeOmp(), ids);
		expect([...report.held].toSorted()).toEqual(ids.filter(id => id.startsWith("held-")).toSorted());
		expect([...report.unknown].toSorted()).toEqual(ids.filter(id => id.startsWith("odd-")).toSorted());
	});

	test("a failing or garbled probe throws instead of reporting everything free", async () => {
		await expect(probeLeases(fakeOmp("echo boom >&2\nexit 1\n"), ["a"])).rejects.toThrow(/exited with 1: boom/);
		await expect(probeLeases(fakeOmp("echo not-json\n"), ["a"])).rejects.toThrow(/non-JSON/);
		await expect(probeLeases(fakeOmp('echo \'{"held":"x"}\'\n'), ["a"])).rejects.toThrow(/unexpected shape/);
	});
});
