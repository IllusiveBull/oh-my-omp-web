import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultDirs, loadFileConfig, loadMachineId, parseFileConfig, resolveConfig } from "../src/config";
import {
	ConfigError,
	MIN_TOKEN_LENGTH,
	MachineKeys,
	assertBindAllowed,
	formatCredential,
	isLoopback,
	linkProof,
	loadToken,
	parseCredential,
	readSecret,
	writeSecret,
} from "../src/secrets";

const made: string[] = [];
const dir = (): string => {
	const d = mkdtempSync(join(tmpdir(), "ompweb-config-"));
	made.push(d);
	return d;
};
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});
const dirs = { configDir: "/cfg", stateDir: "/state" };
const defaults = { webDir: "/web" };
const mode = (file: string): number => statSync(file).mode & 0o777;
/** `resolveConfig` makes configured paths absolute for the host: "/state" is "C:\state" on Windows. */
const abs = (path: string): string => resolve(path);
const posix = process.platform !== "win32";

describe("broker configuration", () => {
	test("the broker is off unless asked for: no hosting, loopback default address, state under the daemon's own state dir (not the user's omp directory)", () => {
		const config = resolveConfig({}, {}, dirs, defaults);
		expect(config.broker).toEqual({
			enabled: false,
			bind: "127.0.0.1:8765",
			home: abs("/state/auth-broker"),
			advertiseUrl: undefined,
		});
		expect(config.localBroker).toBeUndefined();
	});

	test("flags and the config file set the broker; flags win", () => {
		const file = parseFileConfig({
			broker: {
				enabled: true,
				bind: "100.64.0.2:8765",
				home: "/srv/broker",
				advertiseUrl: "http://gw.tail1.ts.net:8765",
			},
		});
		expect(resolveConfig({}, file, dirs, defaults).broker).toEqual({
			enabled: true,
			bind: "100.64.0.2:8765",
			home: abs("/srv/broker"),
			advertiseUrl: "http://gw.tail1.ts.net:8765",
		});
		const flagged = resolveConfig(
			{ broker: true, brokerBind: "127.0.0.1:9000", brokerHome: "/tmp/b" },
			{},
			dirs,
			defaults,
		);
		expect(flagged.broker).toMatchObject({ enabled: true, bind: "127.0.0.1:9000", home: abs("/tmp/b") });
	});

	test("a wildcard or malformed bind is an error even while the broker is disabled; the vault is never on every interface", () => {
		expect(() => resolveConfig({ brokerBind: "0.0.0.0:8765" }, {}, dirs, defaults)).toThrow("every interface");
		expect(() => resolveConfig({ brokerBind: "8765" }, {}, dirs, defaults)).toThrow("host:port");
	});

	test("advertiseUrl needs the broker to be enabled", () => {
		expect(() => resolveConfig({ brokerAdvertiseUrl: "http://x:1" }, {}, dirs, defaults)).toThrow("not enabled");
	});

	test("an env-only daemon can have a broker of its own (url + token file together) but not host one", () => {
		const own = resolveConfig(
			{ role: "env", gatewayUrl: "wss://gw/env", brokerUrl: "http://100.64.0.2:8765", brokerTokenFile: "/tok" },
			{},
			dirs,
			defaults,
		);
		expect(own.localBroker).toEqual({ url: "http://100.64.0.2:8765", tokenFile: abs("/tok") });
		expect(() =>
			resolveConfig({ role: "env", gatewayUrl: "wss://gw/env", brokerUrl: "http://x:1" }, {}, dirs, defaults),
		).toThrow("both a URL and a token file");
		expect(() =>
			resolveConfig({ role: "env", gatewayUrl: "wss://gw/env", broker: true }, {}, dirs, defaults),
		).toThrow("does not host a broker");
		expect(() =>
			resolveConfig({ role: "env", gatewayUrl: "wss://gw/env", brokerBind: "127.0.0.1:1" }, {}, dirs, defaults),
		).toThrow("does not host a broker");
		expect(() => resolveConfig({ brokerUrl: "http://x:1", brokerTokenFile: "/tok" }, {}, dirs, defaults)).toThrow(
			"--role env only",
		);
	});

	test("config.json: unknown broker keys and wrong types are errors", () => {
		expect(() => parseFileConfig({ broker: { enable: true } })).toThrow('unknown key "enable"');
		expect(() => parseFileConfig({ broker: { enabled: "yes" } })).toThrow("broker.enabled");
		expect(() => parseFileConfig({ broker: { advertiseUrl: "ftp://x" } })).toThrow("broker.advertiseUrl");
		expect(() => parseFileConfig({ broker: { url: "gateway:8765" } })).toThrow("broker.url");
		expect(parseFileConfig({ broker: { url: "http://gw:8765", tokenFile: "/t" } }).broker).toMatchObject({
			url: "http://gw:8765",
			tokenFile: "/t",
		});
	});
});

describe("config surface", () => {
	test("defaults: a gateway on loopback:7777 serving the built web app", () => {
		const config = resolveConfig({}, {}, dirs, defaults);
		expect(config).toMatchObject({
			role: "gateway",
			gateway: { bind: "127.0.0.1", port: 7777, webDir: abs("/web"), allowOrigins: [] },
			env: { credentialFile: abs("/cfg/credential") },
		});
	});

	test("flags beat the config file, which beats the defaults", () => {
		const file = parseFileConfig({
			name: "from-file",
			omp: "/file/omp",
			gateway: { bind: "10.0.0.1", port: 9000, allowOrigins: ["https://a"] },
		});
		const config = resolveConfig(
			{ port: "9100", name: "from-flag", allowOrigin: ["https://b"] },
			file,
			dirs,
			defaults,
		);
		expect(config).toMatchObject({
			name: "from-flag",
			omp: "/file/omp",
			gateway: { bind: "10.0.0.1", port: 9100, allowOrigins: ["https://b"] },
		});
	});

	test("an env-only daemon needs a ws(s) gateway URL and accepts no listener settings; a gateway does not register elsewhere", () => {
		expect(() => resolveConfig({ role: "env" }, {}, dirs, defaults)).toThrow("needs a gateway");
		expect(() => resolveConfig({ role: "env", gatewayUrl: "http://gw/env" }, {}, dirs, defaults)).toThrow(
			"ws:// or wss://",
		);
		expect(() => resolveConfig({ role: "env", gatewayUrl: "ws://gw/env", port: "1" }, {}, dirs, defaults)).toThrow(
			"listens on no port",
		);
		expect(() =>
			resolveConfig({ role: "env", gatewayUrl: "ws://gw/env", bind: "0.0.0.0" }, {}, dirs, defaults),
		).toThrow("listens on no port");
		const env = resolveConfig({ role: "env", gatewayUrl: "wss://gw/env" }, {}, dirs, defaults);
		expect(env).toMatchObject({ role: "env", env: { gatewayUrl: "wss://gw/env" } });
		expect(() => resolveConfig({ gatewayUrl: "ws://gw/env" }, {}, dirs, defaults)).toThrow("its own environment");
		expect(() => resolveConfig({ role: "both" }, {}, dirs, defaults)).toThrow("--role");
		expect(() => resolveConfig({ port: "70000" }, {}, dirs, defaults)).toThrow("--port");
	});

	test("config.json is validated: wrong types and unknown keys (typos) are errors, not silent defaults", () => {
		expect(parseFileConfig({ role: "env", env: { gatewayUrl: "ws://x/env" } })).toMatchObject({ role: "env" });
		expect(() => parseFileConfig({ rol: "env" })).toThrow('unknown key "rol"');
		expect(() => parseFileConfig({ gateway: { prot: 1 } })).toThrow('unknown key "prot"');
		expect(() => parseFileConfig({ gateway: { port: "7777" } })).toThrow("port number");
		expect(() => parseFileConfig({ role: "relay" })).toThrow("gateway");
		expect(() => parseFileConfig([])).toThrow("must be an object");
	});

	test("config.json is read from the config dir; a missing file is an empty config and broken JSON is an error", async () => {
		const d = dir();
		expect(await loadFileConfig(d)).toEqual({});
		await Bun.write(join(d, "config.json"), '{"name":"box"}');
		expect(await loadFileConfig(d)).toMatchObject({ name: "box" });
		await Bun.write(join(d, "config.json"), "{");
		await expect(loadFileConfig(d)).rejects.toThrow("not valid JSON");
	});

	test("default directories follow XDG on unix and AppData on Windows", () => {
		expect(defaultDirs({ XDG_CONFIG_HOME: "/x/c", XDG_STATE_HOME: "/x/s" }, "linux")).toEqual({
			configDir: join("/x/c", "omp-web"),
			stateDir: join("/x/s", "omp-web"),
		});
		expect(defaultDirs({ APPDATA: "C:\\R", LOCALAPPDATA: "C:\\L" }, "win32")).toEqual({
			configDir: join("C:\\R", "omp-web"),
			stateDir: join("C:\\L", "omp-web"),
		});
	});

	test("the machine id is generated once and kept", async () => {
		const d = dir();
		const id = await loadMachineId(d);
		expect(id).toMatch(/^m_[0-9a-f]{12}$/);
		expect(await loadMachineId(d)).toBe(id);
	});
});

describe("bind address", () => {
	test("loopback is always allowed; anything else needs a long token", () => {
		for (const host of ["127.0.0.1", "127.9.9.9", "localhost", "::1", "[::1]"]) expect(isLoopback(host)).toBe(true);
		for (const host of ["0.0.0.0", "100.64.1.2", "::", "example.com", "127.0.0.1.evil.com"])
			expect(isLoopback(host)).toBe(false);
		assertBindAllowed("127.0.0.1", "short");
		assertBindAllowed("100.64.1.2", "x".repeat(MIN_TOKEN_LENGTH));
		expect(() => assertBindAllowed("100.64.1.2", "short")).toThrow("refusing to bind 100.64.1.2");
		expect(() => assertBindAllowed("0.0.0.0", "x".repeat(MIN_TOKEN_LENGTH - 1))).toThrow(ConfigError);
	});
});

describe.skipIf(!posix)("secret files", () => {
	test("the token is generated on first run with mode 600 and reused afterwards", async () => {
		const d = dir();
		const file = join(d, "cfg", "token");
		const first = await loadToken(file);
		expect(first.created).toBe(true);
		expect(first.token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
		expect(mode(file)).toBe(0o600);
		expect(mode(join(d, "cfg"))).toBe(0o700);
		const second = await loadToken(file);
		expect(second).toEqual({ token: first.token, created: false });
	});

	test("a secret other users can read is refused, with the fix in the message; an empty token file is refused", async () => {
		const d = dir();
		const file = join(d, "token");
		await writeSecret(file, "x".repeat(40));
		chmodSync(file, 0o644);
		await expect(loadToken(file)).rejects.toThrow("chmod 600");
		await expect(readSecret(file)).rejects.toBeInstanceOf(ConfigError);
		chmodSync(file, 0o600);
		expect((await loadToken(file)).token).toBe("x".repeat(40));
		await writeSecret(file, "\n");
		await expect(loadToken(file)).rejects.toThrow("empty");
	});

	test("machine keys: added with a fresh id and key, stored 600, listed, removed; names are unique", async () => {
		const d = dir();
		const keys = new MachineKeys(join(d, "machine-keys.json"));
		expect(await keys.list()).toEqual({});
		const a = await keys.add("laptop");
		const b = await keys.add("desktop");
		expect(a.id).not.toBe(b.id);
		expect(a.key).not.toBe(b.key);
		expect(mode(join(d, "machine-keys.json"))).toBe(0o600);
		expect(await keys.get(a.id)).toEqual({ name: "laptop", key: a.key });
		await expect(keys.add("laptop")).rejects.toThrow("already exists");
		expect(await keys.get("__proto__")).toBeUndefined();
		expect(await keys.get("nope")).toBeUndefined();
		expect(await keys.remove(a.id)).toBe(true);
		expect(await keys.remove(a.id)).toBe(false);
		expect(Object.keys(await keys.list())).toEqual([b.id]);
		chmodSync(join(d, "machine-keys.json"), 0o666);
		await expect(keys.list()).rejects.toThrow("chmod 600");
	});
});

describe("machine credential and registration proof", () => {
	test("a credential is `<id>:<key>`; malformed ones are refused", () => {
		const text = formatCredential("m_abc", "k:ey");
		expect(parseCredential(text, "f")).toEqual({ id: "m_abc", key: "k:ey" });
		for (const bad of ["", "nocolon", ":key", "id:"]) expect(() => parseCredential(bad, "f")).toThrow("machine id");
	});

	test("the proof binds role, both nonces, the machine id and the broker flag; a proof for one role is useless as the other", () => {
		const base = linkProof("key", "env", "n", "c", "m", true);
		expect(linkProof("key", "env", "n", "c", "m", true)).toBe(base);
		for (const other of [
			linkProof("other", "env", "n", "c", "m", true),
			linkProof("key", "gateway", "n", "c", "m", true),
			linkProof("key", "env", "n2", "c", "m", true),
			linkProof("key", "env", "n", "c2", "m", true),
			linkProof("key", "env", "n", "c", "m2", true),
			linkProof("key", "env", "n", "c", "m", false), // whether the daemon takes the broker token is signed too
		]) {
			expect(other).not.toBe(base);
		}
	});
});

describe("terminal configuration", () => {
	test("terminals are off unless the operator turns them on, on every role", () => {
		expect(resolveConfig({}, {}, dirs, defaults).terminal).toEqual({
			enabled: false,
			max: 16,
			shell: undefined,
			ringChars: 1024 * 1024,
			scrollbackLines: 2000,
		});
		const env = resolveConfig({}, { role: "env", env: { gatewayUrl: "ws://127.0.0.1:1/env" } }, dirs, defaults);
		expect(env.terminal.enabled).toBe(false);
	});

	test("the flag or the file enable them (the flag wins), with limits and a shell", () => {
		const file = parseFileConfig({
			terminal: { enabled: false, max: 4, shell: "/bin/zsh", ringKiB: 512, scrollbackLines: 100 },
		});
		expect(resolveConfig({}, file, dirs, defaults).terminal).toEqual({
			enabled: false,
			max: 4,
			shell: "/bin/zsh",
			ringChars: 512 * 1024,
			scrollbackLines: 100,
		});
		expect(resolveConfig({ terminal: true }, file, dirs, defaults).terminal.enabled).toBe(true);
		expect(
			resolveConfig({ terminal: false }, parseFileConfig({ terminal: { enabled: true } }), dirs, defaults).terminal
				.enabled,
		).toBe(false);
	});

	test("typos and nonsense are errors, not silent defaults", () => {
		for (const [terminal, pattern] of [
			[{ enable: true }, /unknown key "enable"/],
			[{ enabled: "yes" }, /terminal\.enabled/],
			[{ max: 0 }, /terminal\.max/],
			[{ max: 1000 }, /terminal\.max/],
			[{ shell: "zsh" }, /terminal\.shell/],
			[{ ringKiB: 1 }, /terminal\.ringKiB/],
			[{ scrollbackLines: -1 }, /terminal\.scrollbackLines/],
		] as [Record<string, unknown>, RegExp][]) {
			expect(() => parseFileConfig({ terminal })).toThrow(pattern);
		}
	});
});

describe("environment switch configuration", () => {
	test("defaults: limits from the documented table, worktrees next to the project, a 30 minute confirmation window", () => {
		const config = resolveConfig({}, {}, dirs, defaults);
		expect(config.handoff).toEqual({
			worktreesDir: undefined,
			limits: {
				maxFileBytes: 10 * 1048576,
				maxTotalBytes: 128 * 1048576,
				maxBundleBytes: 256 * 1048576,
				maxArchiveBytes: 512 * 1048576,
			},
			confirmTimeoutMs: 30 * 60_000,
		});
	});

	test("config.json sets them; unknown keys, non-numbers and relative worktree directories are errors", () => {
		const file = parseFileConfig({
			handoff: {
				worktreesDir: "/wt",
				maxFileMiB: 1,
				maxTotalMiB: 2,
				maxBundleMiB: 3,
				maxArchiveMiB: 4,
				confirmTimeoutMinutes: 5,
			},
		});
		expect(resolveConfig({}, file, dirs, defaults).handoff).toEqual({
			worktreesDir: resolve("/wt"),
			limits: { maxFileBytes: 1048576, maxTotalBytes: 2097152, maxBundleBytes: 3145728, maxArchiveBytes: 4194304 },
			confirmTimeoutMs: 300_000,
		});
		expect(() => parseFileConfig({ handoff: { maxFile: 1 } })).toThrow(/unknown key "maxFile"/);
		expect(() => parseFileConfig({ handoff: { maxFileMiB: "big" } })).toThrow(/positive number/);
		expect(() => parseFileConfig({ handoff: { worktreesDir: "relative/dir" } })).toThrow(/absolute path/);
	});
});
