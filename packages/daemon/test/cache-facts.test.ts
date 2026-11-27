import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import {
	ACCOUNT_IDENTITY_QUERY,
	agentDbPathFor,
	buildSessionFacts,
	hashAccountIdentities,
	readAccountHashes,
	readSessionFileFacts,
	settledState,
	sha256Hex,
} from "../src/cache-facts";
import { assistant, titleSlot, user, writeSessionFile } from "./session-files";

const dir = mkdtempSync(join(tmpdir(), "ompweb-cachefacts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const sub = (): string => join(dir, `s${++counter}`);

const T0 = "2026-11-01T10:00:00.000Z";
const T1 = "2026-11-01T10:01:00.000Z";
const T2 = "2026-11-01T10:02:00.000Z";

const body = () => [user("e1", null, "hello", T0), assistant("e2", "e1", "hi", T1), user("e3", "e2", "more", T2)];

/** The same body lines, normalized the way the fingerprint is defined. */
const fingerprint = (entries: object[]): string =>
	sha256Hex(entries.map(entry => JSON.stringify(JSON.parse(JSON.stringify(entry)))).join("\n"));

describe("sha256Hex", () => {
	test("hashes strings and bytes alike", () => {
		expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
	});
});

describe("readSessionFileFacts", () => {
	test("history is the hash of the normalized body lines; header and title slot are not in it", async () => {
		const entries = body();
		const plain = writeSessionFile(sub(), { id: "a", created: T0, entries });
		const slotted = writeSessionFile(sub(), { id: "a", created: T0, entries, slotTitle: "A title" });
		const moved = writeSessionFile(sub(), { id: "other", created: T0, cwd: "/elsewhere", title: "renamed", entries });
		const facts = await readSessionFileFacts(plain);
		expect(facts.history).toEqual({
			entries: 3,
			hash: fingerprint(entries),
			compactions: 0,
			lastCompactionIndex: null,
		});
		expect((await readSessionFileFacts(slotted)).history).toEqual(facts.history);
		expect((await readSessionFileFacts(moved)).history).toEqual(facts.history);
	});

	test("normalization: whitespace in a line does not change the hash, content does", async () => {
		const entries = body();
		const compact = writeSessionFile(sub(), { id: "a", created: T0, entries });
		const spacedDir = sub();
		const spaced = writeSessionFile(spacedDir, { id: "a", created: T0, entries });
		const lines = (await Bun.file(spaced).text()).split("\n");
		writeFileSync(
			spaced,
			lines
				.map(line =>
					line.startsWith('{"type":"message"')
						? JSON.stringify(JSON.parse(line), null, 1).replace(/\n\s*/g, "  ")
						: line,
				)
				.join("\n"),
		);
		expect((await readSessionFileFacts(spaced)).history.hash).toBe(
			(await readSessionFileFacts(compact)).history.hash,
		);
		const changed = writeSessionFile(sub(), {
			id: "a",
			created: T0,
			entries: [...entries.slice(0, 2), user("e3", "e2", "more!", T2)],
		});
		expect((await readSessionFileFacts(changed)).history.hash).not.toBe(
			(await readSessionFileFacts(compact)).history.hash,
		);
	});

	test("historyEntries hashes only that prefix, however much the file grew after it", async () => {
		const entries = body();
		const short = writeSessionFile(sub(), { id: "a", created: T0, entries: entries.slice(0, 2) });
		const full = writeSessionFile(sub(), { id: "b", created: T0, entries });
		const prefix = await readSessionFileFacts(full, { historyEntries: 2 });
		expect(prefix.history).toEqual((await readSessionFileFacts(short)).history);
		expect(prefix.history.entries).toBe(2);
		expect((await readSessionFileFacts(full, { historyEntries: 99 })).history.entries).toBe(3);
		expect((await readSessionFileFacts(full, { historyEntries: 0 })).history).toMatchObject({
			entries: 0,
			hash: sha256Hex(""),
		});
	});

	test("compactions are counted with the index of the newest, within the hashed prefix", async () => {
		const compaction = (id: string, parentId: string) => ({
			type: "compaction",
			id,
			parentId,
			timestamp: T1,
			summary: "s",
			firstKeptEntryId: "e1",
			tokensBefore: 10,
		});
		const file = writeSessionFile(sub(), {
			id: "a",
			created: T0,
			entries: [
				user("e1", null, "x", T0),
				compaction("c1", "e1"),
				assistant("e2", "c1", "y", T1),
				compaction("c2", "e2"),
				user("e3", "c2", "z", T2),
			],
		});
		expect((await readSessionFileFacts(file)).history).toMatchObject({
			entries: 5,
			compactions: 2,
			lastCompactionIndex: 3,
		});
		expect((await readSessionFileFacts(file, { historyEntries: 3 })).history).toMatchObject({
			entries: 3,
			compactions: 1,
			lastCompactionIndex: 1,
		});
		expect((await readSessionFileFacts(file, { historyEntries: 1 })).history).toMatchObject({
			compactions: 0,
			lastCompactionIndex: null,
		});
	});

	test("pins: the latest per provider in file order, sorted by provider", async () => {
		const pin = (id: string, provider: string, hash: string) => ({
			type: "credential_pin",
			id,
			parentId: null,
			timestamp: T0,
			provider,
			hash,
		});
		const file = writeSessionFile(sub(), {
			id: "a",
			created: T0,
			entries: [
				pin("p1", "openai-codex", "h1"),
				pin("p2", "anthropic", "h2"),
				user("e1", "p2", "x", T0),
				pin("p3", "anthropic", "h3"),
			],
		});
		expect((await readSessionFileFacts(file)).pins).toEqual([
			{ provider: "anthropic", hash: "h3" },
			{ provider: "openai-codex", hash: "h1" },
		]);
		expect(
			(await readSessionFileFacts(writeSessionFile(sub(), { id: "n", created: T0, entries: body() }))).pins,
		).toEqual([]);
	});

	test("lastRequestAt: newest assistant message by its own timestamp, else the entry's; none when nobody answered", async () => {
		const file = writeSessionFile(sub(), { id: "a", created: T0, entries: body() });
		expect((await readSessionFileFacts(file)).lastRequestAt).toBe(Date.parse(T1));
		const noStamp = {
			type: "message",
			id: "e9",
			parentId: "e3",
			timestamp: "2026-11-01T10:05:00.000Z",
			message: { role: "assistant", content: [] },
		};
		const withFallback = writeSessionFile(sub(), { id: "b", created: T0, entries: [...body(), noStamp] });
		expect((await readSessionFileFacts(withFallback)).lastRequestAt).toBe(Date.parse("2026-11-01T10:05:00.000Z"));
		const none = writeSessionFile(sub(), { id: "c", created: T0, entries: [user("e1", null, "x", T0)] });
		expect((await readSessionFileFacts(none)).lastRequestAt).toBeNull();
	});

	test("the prompt cache key comes from the header, when there is one", async () => {
		const plain = writeSessionFile(sub(), { id: "a", created: T0, entries: body() });
		expect((await readSessionFileFacts(plain)).promptCacheKey).toBeNull();
		const keyed = join(sub(), "keyed.jsonl");
		await Bun.write(
			keyed,
			`${titleSlot("t")}${JSON.stringify({ type: "session", id: "a", timestamp: T0, cwd: "/w", providerPromptCacheKey: "key-1" })}\n${JSON.stringify(body()[0])}\n`,
		);
		const facts = await readSessionFileFacts(keyed);
		expect(facts.promptCacheKey).toBe("key-1");
		expect(facts.history.entries).toBe(1);
	});

	test("a half-written last line (live writer) and blank lines are not entries", async () => {
		const file = writeSessionFile(sub(), { id: "a", created: T0, entries: body() });
		const text = await Bun.file(file).text();
		writeFileSync(file, `${text}\n{"type":"message","id":"e4","par`);
		const facts = await readSessionFileFacts(file);
		expect(facts.history.entries).toBe(3);
	});

	test("a file without a trailing newline keeps its last entry", async () => {
		const file = writeSessionFile(sub(), { id: "a", created: T0, entries: body() });
		writeFileSync(file, (await Bun.file(file).text()).trimEnd());
		expect((await readSessionFileFacts(file)).history.hash).toBe(fingerprint(body()));
	});

	test("a megabyte of session streams to the right hash", async () => {
		const entries: object[] = [];
		const filler = "x".repeat(400) + "é漢字🙂";
		for (let i = 0; i < 2200; i++) {
			entries.push(
				i % 2 === 0
					? user(`u${i}`, i === 0 ? null : `a${i - 1}`, `${i} ${filler}`, T0)
					: assistant(`a${i}`, `u${i - 1}`, `${i} ${filler}`, T1),
			);
		}
		const file = writeSessionFile(sub(), { id: "big", created: T0, entries });
		expect(Bun.file(file).size).toBeGreaterThan(1_000_000);
		const facts = await readSessionFileFacts(file);
		expect(facts.history.entries).toBe(2200);
		expect(facts.history.hash).toBe(fingerprint(entries));
		expect(facts.lastRequestAt).toBe(Date.parse(T1));
	});
});

describe("hashAccountIdentities", () => {
	test("equals upstream's credentialPinHash for the same identity, and differs per org and project", () => {
		const identity = { accountId: "acc-1", email: "me@example.invalid", orgId: "org-1", projectId: "proj-1" };
		const [hash] = hashAccountIdentities([{ provider: "anthropic", ...identity }]);
		expect(hash).toEqual({ provider: "anthropic", hash: credentialPinHash("anthropic", identity) as string });
		const variants = [
			{ provider: "anthropic", ...identity },
			{ provider: "anthropic", ...identity, orgId: "org-2" },
			{ provider: "anthropic", ...identity, projectId: "proj-2" },
			{ provider: "openai-codex", ...identity },
		];
		expect(new Set(hashAccountIdentities(variants).map(h => h.hash)).size).toBe(4);
	});

	test("null fields count as absent; rows with no accountId and no email are skipped; duplicates are folded", () => {
		const out = hashAccountIdentities([
			{ provider: "anthropic", email: "a@example.invalid", accountId: null, orgId: null, projectId: null },
			{ provider: "anthropic", email: "a@example.invalid" },
			{ provider: "anthropic", orgId: "org-only" },
			{ provider: "google", projectId: "p" },
		]);
		expect(out).toEqual([
			{ provider: "anthropic", hash: credentialPinHash("anthropic", { email: "a@example.invalid" }) as string },
		]);
	});
});

const SECRET_ACCESS = "sk-ant-oat-SECRET-ACCESS-TOKEN";
const SECRET_REFRESH = "SECRET-REFRESH-TOKEN";
const SECRET_KEY = "sk-SECRET-API-KEY";

async function makeAgentDb(): Promise<string> {
	const path = join(sub(), "agent.db");
	await Bun.$`mkdir -p ${join(path, "..")}`.quiet();
	const store = await SqliteAuthCredentialStore.open(path);
	const oauth = (extra: { email?: string; accountId?: string; orgId?: string }) => ({
		type: "oauth" as const,
		access: SECRET_ACCESS,
		refresh: SECRET_REFRESH,
		expires: Date.now() + 86_400_000,
		...extra,
	});
	try {
		await store.upsertAuthCredential(
			"anthropic",
			oauth({ email: "one@example.invalid", accountId: "acc-1", orgId: "org-1" }),
		);
		await store.upsertAuthCredential(
			"anthropic",
			oauth({ email: "two@example.invalid", accountId: "acc-2", orgId: "org-2" }),
		);
		await store.upsertAuthCredential("deepseek", { type: "api_key", key: SECRET_KEY });
		await store.upsertAuthCredential("openai-codex", oauth({ email: "gone@example.invalid", accountId: "acc-3" }));
		await store.deleteAuthCredentials("openai-codex", "logged out by user");
	} finally {
		store.close();
	}
	return path;
}

describe("readAccountHashes", () => {
	test("returns exactly the pin hashes of the active OAuth accounts of a real upstream database", async () => {
		const db = await makeAgentDb();
		const result = readAccountHashes(db);
		expect(result.via).toBe("local-db");
		expect(result.reason).toBeUndefined();
		expect(result.hashes).toEqual([
			{
				provider: "anthropic",
				hash: credentialPinHash("anthropic", {
					email: "one@example.invalid",
					accountId: "acc-1",
					orgId: "org-1",
				}) as string,
			},
			{
				provider: "anthropic",
				hash: credentialPinHash("anthropic", {
					email: "two@example.invalid",
					accountId: "acc-2",
					orgId: "org-2",
				}) as string,
			},
		]);
		const serialized = JSON.stringify(result);
		for (const secret of [SECRET_ACCESS, SECRET_REFRESH, SECRET_KEY, "example.invalid"])
			expect(serialized).not.toContain(secret);
	});

	test("the query returns identity columns only: `data` is read solely inside json_extract / json_valid", async () => {
		const db = new Database(await makeAgentDb(), { readonly: true });
		try {
			expect(db.query(ACCOUNT_IDENTITY_QUERY).columnNames).toEqual([
				"provider",
				"accountId",
				"email",
				"orgId",
				"projectId",
			]);
			const bare = ACCOUNT_IDENTITY_QUERY.replace(/json_valid\(data\)/g, "").replace(/json_extract\(data,/g, "");
			expect(bare).not.toMatch(/\bdata\b/);
			for (const row of db.query(ACCOUNT_IDENTITY_QUERY).all()) {
				expect(JSON.stringify(row)).not.toContain("SECRET");
			}
		} finally {
			db.close();
		}
	});

	test("one corrupt `data` row does not take the others down", async () => {
		const path = await makeAgentDb();
		const rw = new Database(path);
		rw.run(
			"INSERT INTO auth_credentials (provider, credential_type, data, created_at, updated_at) VALUES ('anthropic', 'oauth', 'not json{', 0, 0)",
		);
		rw.close();
		expect(readAccountHashes(path).hashes).toHaveLength(2);
	});

	test("it opens read-only: the database is unchanged", async () => {
		const path = await makeAgentDb();
		const before = await Bun.file(path).bytes();
		readAccountHashes(path);
		expect(Buffer.from(await Bun.file(path).bytes()).equals(Buffer.from(before))).toBe(true);
	});

	test("a missing file, an empty file and a database without the table have no accounts but are not unavailable", () => {
		expect(readAccountHashes(join(dir, "nope.db"))).toEqual({ via: "local-db", hashes: [] });
		const empty = join(dir, "empty.db");
		writeFileSync(empty, "");
		expect(readAccountHashes(empty)).toEqual({ via: "local-db", hashes: [] });
		const other = join(dir, "other.db");
		const db = new Database(other);
		db.run("CREATE TABLE unrelated (x TEXT)");
		db.close();
		expect(readAccountHashes(other)).toEqual({ via: "local-db", hashes: [] });
	});

	test("any other failure is unavailable with its reason", () => {
		const notADatabase = join(dir, "garbage.db");
		writeFileSync(notADatabase, "this is not a sqlite database, not even close".repeat(50));
		const result = readAccountHashes(notADatabase);
		expect(result.via).toBe("unavailable");
		expect(result.hashes).toEqual([]);
		expect(result.reason).toBeTruthy();
	});
});

describe("agentDbPathFor", () => {
	test("follows omp's rule for the environment", () => {
		expect(agentDbPathFor({ PI_CODING_AGENT_DIR: "/data/agent" })).toBe(join("/data/agent", "agent.db"));
	});
});

const STATE = {
	sessionId: "sess-1",
	sessionFile: "/w/sessions/s.jsonl",
	model: { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" },
	thinkingLevel: "high",
	fastModeActive: false,
	slowModeEnabled: true,
	systemPrompt: ["HEAD block", "tail one", "tail two"],
	dumpTools: [
		{
			name: "read",
			description: "Reads",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			examples: [{ caption: "ex", call: { path: "a" } }],
		},
		{ name: "write", description: "Writes", parameters: { type: "object" } },
	],
	contextUsage: { tokens: 12_345, contextWindow: 200_000, percent: 6 },
} as unknown as RpcSessionState;

const FILE = {
	history: { entries: 3, hash: "h", compactions: 1, lastCompactionIndex: 2 },
	pins: [{ provider: "anthropic", hash: "pin" }],
	lastRequestAt: 1234,
	promptCacheKey: "key",
};

const build = (state: RpcSessionState = STATE) =>
	buildSessionFacts({
		state,
		origin: "live",
		file: FILE,
		accounts: { via: "local-db", hashes: [] },
		omp: "18.19.0",
		platform: "darwin-arm64",
		now: 99,
	});

describe("buildSessionFacts", () => {
	test("maps the state: head, tail joined by newline, canonical tools hash, model, context", () => {
		const facts = build();
		expect(facts).toMatchObject({
			sessionId: "sess-1",
			file: "/w/sessions/s.jsonl",
			origin: "live",
			capturedAt: 99,
			omp: "18.19.0",
			platform: "darwin-arm64",
			model: { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" },
			thinkingLevel: "high",
			fastModeActive: false,
			slowModeEnabled: true,
			systemHead: { hash: sha256Hex("HEAD block"), chars: 10 },
			systemTail: { hash: sha256Hex("tail one\ntail two"), chars: 17 },
			context: { tokens: 12_345, window: 200_000 },
			lastRequestAt: 1234,
			history: FILE.history,
			pins: FILE.pins,
			promptCacheKey: "key",
			accounts: { via: "local-db", hashes: [] },
		});
		expect(facts.tools).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{64}$/), count: 2 });
	});

	test("deterministic; key order inside tool schemas does not matter, array order does", () => {
		expect(build()).toEqual(build());
		const reordered = {
			...STATE,
			dumpTools: [
				{
					examples: [{ call: { path: "a" }, caption: "ex" }],
					parameters: { required: ["path"], properties: { path: { type: "string" } }, type: "object" },
					description: "Reads",
					name: "read",
				},
				{ parameters: { type: "object" }, description: "Writes", name: "write" },
			],
		} as unknown as RpcSessionState;
		expect(build(reordered).tools).toEqual(build().tools);
		const swapped = { ...STATE, dumpTools: [...(STATE.dumpTools ?? [])].reverse() } as RpcSessionState;
		expect(build(swapped).tools?.hash).not.toBe(build().tools?.hash);
	});

	test("one character in a tool example, description or schema changes the tools hash, and nothing else", () => {
		const tools = STATE.dumpTools ?? [];
		const mutate = (change: (tool: (typeof tools)[number]) => (typeof tools)[number]): string | undefined =>
			build({ ...STATE, dumpTools: [change(tools[0]!), tools[1]!] } as RpcSessionState).tools?.hash;
		const base = build().tools?.hash;
		const example = mutate(t => ({ ...t, examples: [{ caption: "ex", call: { path: "b" } }] }) as typeof t);
		const description = mutate(t => ({ ...t, description: "Reads!" }));
		const noExamples = mutate(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
		expect(new Set([base, example, description, noExamples]).size).toBe(4);
		const changed = build({
			...STATE,
			dumpTools: [{ ...tools[0]!, description: "Reads!" }, tools[1]!],
		} as RpcSessionState);
		expect(changed.systemHead).toEqual(build().systemHead);
		expect(changed.systemTail).toEqual(build().systemTail);
	});

	test("one character in a system block changes only that block's hash", () => {
		const head = build({ ...STATE, systemPrompt: ["HEAD blocK", "tail one", "tail two"] });
		expect(head.systemHead?.hash).not.toBe(build().systemHead?.hash);
		expect(head.systemTail).toEqual(build().systemTail);
		const tail = build({ ...STATE, systemPrompt: ["HEAD block", "tail one", "tail twO"] });
		expect(tail.systemTail?.hash).not.toBe(build().systemTail?.hash);
		expect(tail.systemHead).toEqual(build().systemHead);
	});

	test("what omp did not report becomes null", () => {
		const bare = {
			sessionId: "s",
			fastModeActive: false,
			slowModeEnabled: false,
			thinkingLevel: undefined,
		} as unknown as RpcSessionState;
		const facts = build(bare);
		expect(facts).toMatchObject({
			model: null,
			thinkingLevel: null,
			tools: null,
			systemHead: null,
			systemTail: null,
			context: null,
		});
		expect("file" in facts).toBe(false);
		expect(build({ ...bare, systemPrompt: ["only head"] }).systemTail).toEqual({ hash: sha256Hex(""), chars: 0 });
	});
});

describe("buildSessionFacts settled", () => {
	test("copies `settled` when given, leaves the field out otherwise", () => {
		const base = {
			state: STATE,
			origin: "live" as const,
			file: FILE,
			accounts: { via: "local-db" as const, hashes: [] },
			omp: "1",
			platform: "p",
			now: 1,
		};
		expect(buildSessionFacts({ ...base, settled: false }).settled).toBe(false);
		expect(buildSessionFacts({ ...base, settled: true }).settled).toBe(true);
		expect("settled" in buildSessionFacts(base)).toBe(false);
	});
});

describe("settledState", () => {
	/** A virtual clock: `sleep` advances it, nothing really waits. */
	function clock() {
		let t = 1_000_000;
		return { now: () => t, sleep: async (ms: number) => void (t += ms) };
	}
	const stateWith = (prompt: string, tool = "read"): RpcSessionState =>
		({
			sessionId: "s",
			systemPrompt: [prompt],
			dumpTools: [{ name: tool, description: "d", parameters: {} }],
		}) as unknown as RpcSessionState;
	/** Replays the script, then repeats its last element. */
	const scripted = (script: RpcSessionState[]) => {
		let reads = 0;
		return { read: async () => script[Math.min(reads++, script.length - 1)]!, reads: () => reads };
	};

	test("an immediately stable prompt settles after stableForMs, not before", async () => {
		const c = clock();
		const r = scripted([stateWith("a")]);
		const out = await settledState(r.read, { ...c });
		expect(out).toMatchObject({ settled: true, waitedMs: 1500 });
		expect(out.state.systemPrompt).toEqual(["a"]);
		expect(r.reads()).toBe(4); // t = 0, 500, 1000, 1500
	});

	test("a prompt that changes twice settles stableForMs after the last change, on the last state", async () => {
		const c = clock();
		// reads at t=0:a 500:b 1000:c(change) then stable
		const r = scripted([stateWith("a"), stateWith("b"), stateWith("c")]);
		const out = await settledState(r.read, { ...c });
		expect(out.settled).toBe(true);
		expect(out.state.systemPrompt).toEqual(["c"]);
		expect(out.waitedMs).toBe(1000 + 1500);
	});

	test("a change in the tool dump alone also restarts the wait", async () => {
		const c = clock();
		const r = scripted([stateWith("a", "t1"), stateWith("a", "t1"), stateWith("a", "t2")]);
		const out = await settledState(r.read, { ...c });
		expect(out.settled).toBe(true);
		expect(out.state.dumpTools?.[0]?.name).toBe("t2");
		expect(out.waitedMs).toBe(1000 + 1500);
	});

	test("a change in an irrelevant field does not", async () => {
		const c = clock();
		const a = { ...stateWith("a"), messageCount: 1 };
		const b = { ...stateWith("a"), messageCount: 2 };
		const out = await settledState(scripted([a, b]).read, { ...c });
		expect(out).toMatchObject({ settled: true, waitedMs: 1500 });
	});

	test("key order inside a tool schema is not a change", async () => {
		const c = clock();
		const tool = (parameters: unknown) =>
			({
				sessionId: "s",
				systemPrompt: ["a"],
				dumpTools: [{ name: "x", description: "d", parameters }],
			}) as unknown as RpcSessionState;
		const r = scripted([tool({ a: 1, b: 2 }), tool({ b: 2, a: 1 })]);
		expect(await settledState(r.read, { ...c })).toMatchObject({ settled: true, waitedMs: 1500 });
	});

	test("never stabilizing gives up at maxMs with the last state and settled=false", async () => {
		const c = clock();
		let n = 0;
		const out = await settledState(async () => stateWith(`p${n++}`), { ...c, maxMs: 5000 });
		expect(out.settled).toBe(false);
		expect(out.waitedMs).toBe(5000);
		expect(out.state.systemPrompt).toEqual([`p${n - 1}`]);
	});

	test("stable exactly when time runs out counts as settled; the pause never overshoots maxMs", async () => {
		const c = clock();
		const out = await settledState(scripted([stateWith("a")]).read, { ...c, stableForMs: 1500, maxMs: 1500 });
		expect(out).toMatchObject({ settled: true, waitedMs: 1500 });
		const pauses: number[] = [];
		const c2 = clock();
		await settledState(async () => stateWith(String(c2.now())), {
			now: c2.now,
			sleep: async ms => {
				pauses.push(ms);
				await c2.sleep(ms);
			},
			intervalMs: 400,
			maxMs: 1000,
		});
		expect(pauses).toEqual([400, 400, 200]);
	});

	test("options are honoured: interval and stableForMs", async () => {
		const c = clock();
		const out = await settledState(scripted([stateWith("a")]).read, { ...c, intervalMs: 100, stableForMs: 250 });
		expect(out).toMatchObject({ settled: true, waitedMs: 300 });
	});

	test("an error from read propagates, on the first and on a later read", async () => {
		const c = clock();
		await expect(
			settledState(
				async () => {
					throw new Error("get_state failed");
				},
				{ ...c },
			),
		).rejects.toThrow("get_state failed");
		let n = 0;
		await expect(
			settledState(
				async () => {
					if (n++ === 2) throw new Error("later");
					return stateWith("a");
				},
				{ ...c },
			),
		).rejects.toThrow("later");
	});
});
