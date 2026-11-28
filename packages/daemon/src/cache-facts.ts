import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { SessionEntry as OmpSessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import type { SessionFacts, SessionStatus } from "@omp-web/protocol";
import { localAgentDbPath } from "./migration";

/**
 * Facts for the cache forecast: everything the daemon can know about the prompt a session would send next, without
 * sending anything. This file only collects and hashes; deciding hit or miss is `forecastCache` in the protocol package.
 * Hashes only leave the daemon: no prompt text, tool schema, account identity or token is kept in a fact.
 */

export function sha256Hex(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Session file
// ---------------------------------------------------------------------------

export interface SessionFileFacts {
	history: SessionFacts["history"];
	pins: SessionFacts["pins"];
	lastRequestAt: number | null;
	promptCacheKey: string | null;
}

/** Calls `onLine` for every non-empty line of a file, reading it in chunks: a long session is never held whole in memory. */
async function forEachLine(file: string, onLine: (line: string) => void): Promise<void> {
	const decoder = new TextDecoder();
	let rest = "";
	for await (const chunk of Bun.file(file).stream()) {
		rest += decoder.decode(chunk, { stream: true });
		let newline = rest.indexOf("\n");
		while (newline !== -1) {
			const line = rest.slice(0, newline);
			rest = rest.slice(newline + 1);
			if (line.trim() !== "") onLine(line);
			newline = rest.indexOf("\n");
		}
	}
	rest += decoder.decode();
	if (rest.trim() !== "") onLine(rest);
}

/**
 * Facts of one session jsonl, streamed. Line 1 is omp's fixed-width title slot, then comes the `session` header, then the
 * body entries.
 *
 * - `history.hash` is the SHA-256 over the body lines, each normalized as `JSON.stringify(JSON.parse(line))`, joined by
 *   `\n`: the header and the title slot are excluded, so a rewritten header (cwd, previousSessionFiles) or a renamed
 *   session does not change it. Same definition as the session layer's body fingerprint. A line that is not valid JSON
 *   (omp skips such lines when it loads a file; a live writer may have half-written the last one) is not an entry.
 * - `historyEntries`: hash only the first N entries (and count compactions among them). The daemon passes the source's
 *   entry count when it fingerprints a target, so equal hashes mean "the fork kept the source's history".
 * - `pins`, `lastRequestAt` and `promptCacheKey` always describe the whole file.
 * - `lastRequestAt`: newest assistant `message`; its own `timestamp` (epoch ms), else the entry's ISO timestamp.
 */
export async function readSessionFileFacts(
	file: string,
	options: { historyEntries?: number } = {},
): Promise<SessionFileFacts> {
	const limit = options.historyEntries ?? Number.POSITIVE_INFINITY;
	const hasher = new Bun.CryptoHasher("sha256");
	let entries = 0;
	let compactions = 0;
	let lastCompactionIndex: number | null = null;
	let headerSeen = false;
	let promptCacheKey: string | null = null;
	let lastRequestAt: number | null = null;
	const pins = new Map<string, string>();

	await forEachLine(file, line => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;
		if (!headerSeen) {
			// The title slot (and anything else before the header) is not part of the history.
			if (parsed.type !== "session") return;
			headerSeen = true;
			if (typeof parsed.providerPromptCacheKey === "string" && parsed.providerPromptCacheKey !== "") {
				promptCacheKey = parsed.providerPromptCacheKey;
			}
			return;
		}
		if (entries < limit) {
			if (entries > 0) hasher.update("\n");
			hasher.update(JSON.stringify(parsed));
			if (parsed.type === "compaction") {
				compactions++;
				lastCompactionIndex = entries;
			}
			entries++;
		}
		if (parsed.type === "credential_pin") {
			if (typeof parsed.provider === "string" && typeof parsed.hash === "string")
				pins.set(parsed.provider, parsed.hash);
		} else if (parsed.type === "message" && isRecord(parsed.message) && parsed.message.role === "assistant") {
			const stamp =
				typeof parsed.message.timestamp === "number"
					? parsed.message.timestamp
					: Date.parse(String(parsed.timestamp));
			if (Number.isFinite(stamp) && (lastRequestAt === null || stamp > lastRequestAt)) lastRequestAt = stamp;
		}
	});

	return {
		history: { entries, hash: hasher.digest("hex"), compactions, lastCompactionIndex },
		pins: [...pins]
			.map(([provider, hash]) => ({ provider, hash }))
			.sort((a, b) => a.provider.localeCompare(b.provider)),
		lastRequestAt,
		promptCacheKey,
	};
}

/**
 * The latest `credential_pin` per provider among `entries` (an active branch, root to leaf): which OAuth account served
 * the session last. Undefined when none was recorded (API keys and non-OAuth providers record none).
 */
export function branchPins(entries: Iterable<OmpSessionEntry>): SessionStatus["pins"] {
	const pins = new Map<string, string>();
	for (const entry of entries) if (entry.type === "credential_pin") pins.set(entry.provider, entry.hash);
	return pins.size === 0 ? undefined : [...pins].map(([provider, hash]) => ({ provider, hash }));
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface AccountIdentityRow {
	provider: string;
	accountId?: string | null;
	email?: string | null;
	orgId?: string | null;
	projectId?: string | null;
}

/**
 * Pin hashes (`credentialPinHash`, upstream's own function: the digest is a persisted contract) of account identities.
 * Rows without an account key (no accountId and no email) have no pin and are skipped; duplicates are folded.
 */
export function hashAccountIdentities(rows: AccountIdentityRow[]): { provider: string; hash: string }[] {
	const seen = new Set<string>();
	const out: { provider: string; hash: string }[] = [];
	for (const row of rows) {
		const hash = credentialPinHash(row.provider, {
			accountId: row.accountId ?? undefined,
			email: row.email ?? undefined,
			orgId: row.orgId ?? undefined,
			projectId: row.projectId ?? undefined,
		});
		if (hash === undefined || seen.has(`${row.provider}\0${hash}`)) continue;
		seen.add(`${row.provider}\0${hash}`);
		out.push({ provider: row.provider, hash });
	}
	return out;
}

/**
 * The only query run on omp's credential database. An OAuth credential is stored as `{access, refresh, expires, email?,
 * accountId?, orgId?, projectId?, …}` JSON in `data` (upstream `serializeCredential`), so the four identity fields are
 * read with `json_extract` and the column itself never appears outside of it: the tokens are computed by SQLite and
 * dropped there, they never reach this process. `json_valid` keeps one corrupt row from failing the whole query.
 */
export const ACCOUNT_IDENTITY_QUERY = `SELECT provider,
	CASE WHEN json_valid(data) THEN json_extract(data, '$.accountId') END AS accountId,
	CASE WHEN json_valid(data) THEN json_extract(data, '$.email') END AS email,
	CASE WHEN json_valid(data) THEN json_extract(data, '$.orgId') END AS orgId,
	CASE WHEN json_valid(data) THEN json_extract(data, '$.projectId') END AS projectId
FROM auth_credentials
WHERE credential_type = 'oauth' AND disabled_cause IS NULL
ORDER BY id ASC`;

const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * The OAuth accounts of an omp credential database, as pin hashes. Read-only; a missing file or a database that has no
 * `auth_credentials` table yet (never signed in) has no accounts and is still `local-db`; any other failure is
 * `unavailable` with its message, so the forecast says "unknown" rather than "no match".
 */
export function readAccountHashes(agentDbPath: string): SessionFacts["accounts"] {
	if (!existsSync(agentDbPath)) return { via: "local-db", hashes: [] };
	let db: Database | null = null;
	try {
		db = new Database(agentDbPath, { readonly: true });
		const rows: AccountIdentityRow[] = [];
		for (const row of db.query(ACCOUNT_IDENTITY_QUERY).all()) {
			if (!isRecord(row) || typeof row.provider !== "string") continue;
			rows.push({
				provider: row.provider,
				accountId: stringOrNull(row.accountId),
				email: stringOrNull(row.email),
				orgId: stringOrNull(row.orgId),
				projectId: stringOrNull(row.projectId),
			});
		}
		return { via: "local-db", hashes: hashAccountIdentities(rows) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/no such table/i.test(message)) return { via: "local-db", hashes: [] };
		return { via: "unavailable", hashes: [], reason: message };
	} finally {
		db?.close();
	}
}

/** omp's `agent.db` for an environment (`PI_CODING_AGENT_DIR`, else `<home>/<PI_CONFIG_DIR | .omp>/agent`). */
export function agentDbPathFor(env: Record<string, string | undefined>): string {
	return localAgentDbPath(env);
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every depth: key order (which a JS round trip may change) must not change a hash. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
		return out;
	}
	return value;
}

export interface BuildSessionFactsInput {
	state: RpcSessionState;
	origin: SessionFacts["origin"];
	file: SessionFileFacts;
	accounts: SessionFacts["accounts"];
	omp: string;
	platform: string;
	now: number;
	/** False when the prompt was still changing when `state` was read (see {@link settledState}); omitted when unknown. */
	settled?: boolean;
}

export interface SettledStateOptions {
	/** Pause between two reads. Default 500. */
	intervalMs?: number;
	/** How long the prompt must stay unchanged to count as settled. Default 1500. */
	stableForMs?: number;
	/** Give up after this long in total. Default 20000. */
	maxMs?: number;
	/** Test seams: the clock and the pause. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface SettledState {
	state: RpcSessionState;
	/** False when the prompt was still changing at `maxMs`: `state` is then only the last read. */
	settled: boolean;
	waitedMs: number;
}

/**
 * `get_state` of a process that has just started, once its prompt stops changing. omp rebuilds the system prompt and the
 * tool list after startup (MCP servers connect asynchronously), so a freshly forked process first reports a smaller
 * prompt than the mature session it was forked from, which would look like a real difference between the two ends. The
 * fingerprint is the one `buildSessionFacts` hashes (system prompt blocks, and the tool dump including examples). Reads
 * every `intervalMs`; settled once the fingerprint has been unchanged for `stableForMs`, unsettled at `maxMs` (the last
 * state is returned). A failing `read` propagates.
 */
export async function settledState(
	read: () => Promise<RpcSessionState>,
	options: SettledStateOptions = {},
): Promise<SettledState> {
	const intervalMs = options.intervalMs ?? 500;
	const stableForMs = options.stableForMs ?? 1500;
	const maxMs = options.maxMs ?? 20_000;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	const fingerprint = (s: RpcSessionState): string =>
		sha256Hex(canonicalJson([s.systemPrompt ?? null, s.dumpTools ?? null]));

	const start = now();
	let state = await read();
	let seen = fingerprint(state);
	let changedAt = start;
	for (;;) {
		const t = now();
		if (t - changedAt >= stableForMs) return { state, settled: true, waitedMs: t - start };
		if (t - start >= maxMs) return { state, settled: false, waitedMs: t - start };
		await sleep(Math.min(intervalMs, start + maxMs - t));
		state = await read();
		const next = fingerprint(state);
		if (next !== seen) {
			seen = next;
			changedAt = now();
		}
	}
}

/**
 * The facts of a session from its `get_state` snapshot plus its file and the machine's accounts. Pure. `systemPrompt[0]`
 * is the static head, `systemPrompt[1..]` joined by `\n` the volatile tail; the tools hash covers the whole `dumpTools`
 * array (order kept, it is the order on the wire) including every tool's `examples`.
 */
export function buildSessionFacts(input: BuildSessionFactsInput): SessionFacts {
	const { state, file } = input;
	const prompt = state.systemPrompt;
	const head = prompt && prompt.length > 0 ? prompt[0] : undefined;
	const tail = prompt && prompt.length > 0 ? prompt.slice(1).join("\n") : undefined;
	const model = state.model;
	return {
		sessionId: state.sessionId,
		...(state.sessionFile ? { file: state.sessionFile } : {}),
		origin: input.origin,
		capturedAt: input.now,
		omp: input.omp,
		platform: input.platform,
		model: model ? { provider: model.provider, id: model.id, ...(model.api ? { api: model.api } : {}) } : null,
		thinkingLevel: state.thinkingLevel ?? null,
		fastModeActive: state.fastModeActive,
		slowModeEnabled: state.slowModeEnabled,
		tools: state.dumpTools
			? { hash: sha256Hex(canonicalJson(state.dumpTools)), count: state.dumpTools.length }
			: null,
		systemHead: head === undefined ? null : { hash: sha256Hex(head), chars: head.length },
		systemTail: tail === undefined ? null : { hash: sha256Hex(tail), chars: tail.length },
		context: state.contextUsage
			? { tokens: state.contextUsage.tokens ?? null, window: state.contextUsage.contextWindow ?? null }
			: null,
		lastRequestAt: file.lastRequestAt,
		history: file.history,
		pins: file.pins,
		accounts: input.accounts,
		promptCacheKey: file.promptCacheKey,
		...(input.settled === undefined ? {} : { settled: input.settled }),
	};
}
