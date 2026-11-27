import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { MigrationWire } from "@omp-web/protocol";
import { brokerMigrateCommand, type CliContext } from "./login-kinds";

/** One stored credential as far as migration planning needs it: no secret material. */
export interface CredentialRow {
	provider: string;
	type: "oauth" | "api_key";
	/** Upstream's `identity_key` (e.g. `email:me@example.com`); null when the credential carries no identity. */
	identity: string | null;
}

/**
 * Where omp keeps its credential database for an environment: `<agent dir>/agent.db`, the agent dir being
 * `PI_CODING_AGENT_DIR` or `<home>/<PI_CONFIG_DIR | .omp>/agent`. (omp profiles move it further; not followed here.)
 */
export function localAgentDbPath(env: Record<string, string | undefined> = Bun.env, home: string = homedir()): string {
	const agentDir = env.PI_CODING_AGENT_DIR || join(home, env.PI_CONFIG_DIR || ".omp", "agent");
	return join(agentDir, "agent.db");
}

/**
 * The stored credentials of an omp credential database, read through three non-secret columns (`provider`,
 * `credential_type`, `identity_key`): the `data` column that holds tokens and keys is never selected. Rows that were
 * disabled (logged out) are left out. A missing file or a database without the table (never signed in) has none.
 */
export function readCredentialRows(dbPath: string): CredentialRow[] {
	if (!existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.query("SELECT provider, credential_type, identity_key FROM auth_credentials WHERE disabled_cause IS NULL")
			.all();
		const out: CredentialRow[] = [];
		for (const row of rows) {
			if (typeof row !== "object" || row === null) continue;
			const provider = "provider" in row ? row.provider : undefined;
			const type = "credential_type" in row ? row.credential_type : undefined;
			const identity = "identity_key" in row ? row.identity_key : null;
			if (typeof provider !== "string" || (type !== "oauth" && type !== "api_key")) continue;
			out.push({ provider, type, identity: typeof identity === "string" && identity !== "" ? identity : null });
		}
		return out;
	} catch {
		return []; // no auth_credentials table yet
	} finally {
		db.close();
	}
}

const NOTE =
	"OAuth accounts are skipped unless --include-oauth is given. That copies the refresh token, so afterwards two places hold the same grant; " +
	"providers that rotate refresh tokens (Anthropic does) invalidate the other copy as soon as either one refreshes. After migrating OAuth accounts, " +
	"stop using the local copy (or sign in through this page instead, which creates a fresh grant held only by the broker).";

const identityLabel = (row: CredentialRow): string =>
	row.type === "api_key" ? "(api key)" : (row.identity?.replace(/^[a-z]+:/, "") ?? "(no identity)");

/**
 * Whether the gateway machine has credentials of its own that the broker lacks, for the `migrate --from-local` guide. This
 * only looks at which accounts exist (provider, type, identity key); it never reads or moves a secret and never runs the
 * migration. A local OAuth row counts as already on the broker when the broker has an OAuth row for the same provider and
 * identity key; an api-key row when the broker has any api-key row for the provider (the rule `migrate` itself applies).
 */
export function detectMigration(options: {
	localDb: string;
	brokerDb: string;
	cli: CliContext;
	/** Test seam: rows of the two databases. */
	rows?: { local: CredentialRow[]; broker: CredentialRow[] };
}): MigrationWire {
	const { localDb, brokerDb, cli } = options;
	const same = resolve(localDb) === resolve(brokerDb);
	const local = options.rows?.local ?? (same ? [] : readCredentialRows(localDb));
	const broker = options.rows?.broker ?? (same ? [] : readCredentialRows(brokerDb));
	const missing = local.filter(row => {
		if (row.type === "api_key") return !broker.some(b => b.provider === row.provider && b.type === "api_key");
		return !broker.some(
			b => b.provider === row.provider && b.type === "oauth" && b.identity !== null && b.identity === row.identity,
		);
	});
	const includeOauth = missing.some(row => row.type === "oauth");
	const flags = includeOauth ? " --include-oauth" : "";
	return {
		state: same ? "same" : missing.length > 0 ? "available" : "none",
		localDb,
		entries: missing.map(row => ({ provider: row.provider, type: row.type, identity: identityLabel(row) })),
		dryRunCommand: brokerMigrateCommand(`${flags} --dry-run`, cli),
		command: brokerMigrateCommand(flags, cli),
		note: NOTE,
	};
}
