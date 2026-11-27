import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	brokerCliCommand,
	brokerMigrateCommand,
	loginKindOf,
	posixQuote,
	powershellQuote,
	webSignInAllowed,
} from "../src/login-kinds";
import { detectMigration, localAgentDbPath, readCredentialRows } from "../src/migration";

const dir = mkdtempSync(join(tmpdir(), "ompweb-migration-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SECRET_ACCESS = "sk-ant-oat-SECRET-ACCESS-TOKEN";
const SECRET_REFRESH = "SECRET-REFRESH-TOKEN";
const SECRET_KEY = "sk-SECRET-API-KEY";
const CLI = {
	platform: "linux" as const,
	brokerHome: "/srv/omp-web/auth-broker",
	brokerUrl: "http://127.0.0.1:8765",
	tokenFile: "/srv/omp-web/auth-broker/.omp/auth-broker.token",
};

let counter = 0;
/** A real omp credential database (upstream's own store) holding fake credentials. */
async function makeDb(
	rows: { provider: string; kind: "oauth" | "api_key"; email?: string; accountId?: string }[],
	options: { logout?: string[] } = {},
): Promise<string> {
	const path = join(dir, `agent-${++counter}.db`);
	const store = await SqliteAuthCredentialStore.open(path);
	try {
		for (const row of rows) {
			await store.upsertAuthCredential(
				row.provider,
				row.kind === "oauth"
					? {
							type: "oauth",
							access: SECRET_ACCESS,
							refresh: SECRET_REFRESH,
							expires: Date.now() + 86_400_000,
							email: row.email,
							accountId: row.accountId,
						}
					: { type: "api_key", key: SECRET_KEY },
			);
		}
		for (const provider of options.logout ?? []) await store.deleteAuthCredentials(provider, "logged out by user");
	} finally {
		store.close();
	}
	return path;
}

describe("readCredentialRows", () => {
	test("reads provider, type and identity from upstream's real schema, never the secrets, and skips logged-out rows", async () => {
		const db = await makeDb(
			[
				{ provider: "anthropic", kind: "oauth", email: "me@example.invalid", accountId: "a1" },
				{ provider: "deepseek", kind: "api_key" },
				{ provider: "openai-codex", kind: "oauth", email: "gone@example.invalid" },
			],
			{ logout: ["openai-codex"] },
		);
		const rows = readCredentialRows(db);
		expect(rows).toEqual([
			{ provider: "anthropic", type: "oauth", identity: "email:me@example.invalid" },
			{ provider: "deepseek", type: "api_key", identity: null },
		]);
		const serialized = JSON.stringify(rows);
		for (const secret of [SECRET_ACCESS, SECRET_REFRESH, SECRET_KEY]) expect(serialized).not.toContain(secret);
	});

	test("a missing file, an empty file and a database without the table all have no credentials", () => {
		expect(readCredentialRows(join(dir, "does-not-exist.db"))).toEqual([]);
		const empty = join(dir, "empty.db");
		writeFileSync(empty, "");
		expect(readCredentialRows(empty)).toEqual([]);
	});

	test("it opens the database read-only: it cannot change what it inspects", async () => {
		const db = await makeDb([{ provider: "anthropic", kind: "oauth", email: "me@example.invalid" }]);
		const before = Bun.file(db).size;
		readCredentialRows(db);
		expect(Bun.file(db).size).toBe(before);
	});
});

describe("detectMigration", () => {
	test("local credentials the broker lacks are listed by provider, type and identity: OAuth needs --include-oauth, and nothing secret is in the answer", async () => {
		const local = await makeDb([
			{ provider: "anthropic", kind: "oauth", email: "me@example.invalid" },
			{ provider: "deepseek", kind: "api_key" },
		]);
		const broker = await makeDb([]);
		const result = detectMigration({ localDb: local, brokerDb: broker, cli: CLI });
		expect(result.state).toBe("available");
		expect(result.entries).toEqual([
			{ provider: "anthropic", type: "oauth", identity: "me@example.invalid" },
			{ provider: "deepseek", type: "api_key", identity: "(api key)" },
		]);
		expect(result.dryRunCommand).toBe(
			`OMP_AUTH_BROKER_URL='http://127.0.0.1:8765' OMP_AUTH_BROKER_TOKEN="$(cat '/srv/omp-web/auth-broker/.omp/auth-broker.token')" omp auth-broker migrate --from-local --include-oauth --dry-run`,
		);
		expect(result.command).not.toContain("--dry-run");
		expect(result.command).toContain("--include-oauth");
		expect(result.note).toContain("rotate refresh tokens");
		const serialized = JSON.stringify(result);
		for (const secret of [SECRET_ACCESS, SECRET_REFRESH, SECRET_KEY]) expect(serialized).not.toContain(secret);
	});

	test("what the broker already holds is not listed: same OAuth identity, any API key of the provider", async () => {
		const local = await makeDb([
			{ provider: "anthropic", kind: "oauth", email: "me@example.invalid" },
			{ provider: "anthropic", kind: "oauth", email: "other@example.invalid" },
			{ provider: "deepseek", kind: "api_key" },
		]);
		const broker = await makeDb([
			{ provider: "anthropic", kind: "oauth", email: "me@example.invalid" },
			{ provider: "deepseek", kind: "api_key" },
		]);
		const result = detectMigration({ localDb: local, brokerDb: broker, cli: CLI });
		expect(result.entries).toEqual([{ provider: "anthropic", type: "oauth", identity: "other@example.invalid" }]);
	});

	test("nothing to migrate: `none`, and the flags only mention --include-oauth when OAuth rows are involved", async () => {
		const empty = await makeDb([]);
		expect(detectMigration({ localDb: empty, brokerDb: empty + ".other", cli: CLI })).toMatchObject({
			state: "none",
			entries: [],
		});
		const keyOnly = await makeDb([{ provider: "deepseek", kind: "api_key" }]);
		const result = detectMigration({ localDb: keyOnly, brokerDb: empty, cli: CLI });
		expect(result.state).toBe("available");
		expect(result.command).not.toContain("--include-oauth");
	});

	test("when the broker serves the very database the local omp uses there is nothing to migrate", async () => {
		const db = await makeDb([{ provider: "anthropic", kind: "oauth", email: "me@example.invalid" }]);
		expect(detectMigration({ localDb: db, brokerDb: db, cli: CLI })).toMatchObject({ state: "same", entries: [] });
	});

	test("a missing local database (never signed in on this machine) is `none`", async () => {
		const broker = await makeDb([]);
		expect(detectMigration({ localDb: join(dir, "nope.db"), brokerDb: broker, cli: CLI }).state).toBe("none");
	});
});

describe("localAgentDbPath", () => {
	test("follows omp's own rule: PI_CODING_AGENT_DIR, else <home>/<PI_CONFIG_DIR or .omp>/agent", () => {
		expect(localAgentDbPath({}, "/home/u")).toBe(join("/home/u", ".omp", "agent", "agent.db"));
		expect(localAgentDbPath({ PI_CONFIG_DIR: ".omp-work" }, "/home/u")).toBe(
			join("/home/u", ".omp-work", "agent", "agent.db"),
		);
		expect(localAgentDbPath({ PI_CODING_AGENT_DIR: "/data/agent" }, "/home/u")).toBe(join("/data/agent", "agent.db"));
	});
});

describe("commands printed for the gateway machine", () => {
	test("login/logout verbs get the broker's HOME in front unless it is the user's own home", () => {
		expect(brokerCliCommand("login anthropic", CLI)).toBe(
			"HOME='/srv/omp-web/auth-broker' omp auth-broker login anthropic",
		);
		expect(brokerCliCommand("login anthropic", { ...CLI, brokerHome: null })).toBe("omp auth-broker login anthropic");
		expect(
			brokerCliCommand("login anthropic", { ...CLI, platform: "win32", brokerHome: "C:\\omp web\\broker" }),
		).toBe("$env:USERPROFILE = 'C:\\omp web\\broker'; omp auth-broker login anthropic");
	});

	test("quoting survives spaces and quotes", () => {
		expect(posixQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
		expect(powershellQuote("C:\\it's")).toBe("'C:\\it''s'");
		expect(brokerCliCommand("login x", { ...CLI, brokerHome: "/a b/it's" })).toBe(
			`HOME='/a b/it'\\''s' omp auth-broker login x`,
		);
	});

	test("the migrate command reads the token from its file at run time instead of printing it", () => {
		const posix = brokerMigrateCommand(" --dry-run", CLI);
		expect(posix).toContain("$(cat ");
		expect(posix).toContain("migrate --from-local --dry-run");
		const win = brokerMigrateCommand("", { ...CLI, platform: "win32", tokenFile: "C:\\b\\.omp\\auth-broker.token" });
		expect(win).toContain("Get-Content -Raw 'C:\\b\\.omp\\auth-broker.token'");
	});
});

describe("how a provider signs in (from upstream's catalog)", () => {
	test("anthropic is OAuth, kimi-code a device code, deepseek a pasted API key; an id the catalog does not know is unknown", () => {
		expect(loginKindOf("anthropic")).toBe("oauth");
		expect(loginKindOf("stencil")).toBe("oauth");
		expect(loginKindOf("kimi-code")).toBe("device");
		expect(loginKindOf("deepseek")).toBe("api-key");
		expect(loginKindOf("github-copilot")).toBe("custom");
		expect(loginKindOf("a-provider-from-the-future")).toBe("unknown");
		expect(webSignInAllowed("api-key")).toBe(false);
		for (const kind of ["oauth", "device", "custom", "unknown"] as const) expect(webSignInAllowed(kind)).toBe(true);
	});
});
