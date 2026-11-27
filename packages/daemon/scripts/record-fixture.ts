#!/usr/bin/env bun
/**
 * Records one real omp turn (a tool call plus an answer) through `OmpRpcSource`, i.e. the daemon's own transport, and
 * writes the raw `AgentSessionEvent` stream plus `get_entries` to test/fixtures/turn.json, sanitized of machine paths.
 * Used by test/session.test.ts as the daemon's input fixture.
 *
 *   PROOF_MODEL=anthropic/claude-haiku-4-5 bun packages/daemon/scripts/record-fixture.ts
 *   bun packages/daemon/scripts/record-fixture.ts --scrub   # re-scrub identifiers in the existing fixture, no model call
 *
 * One tiny prompt. Needs an authenticated model; the machine default may not be (pass PROOF_MODEL).
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { locateOmp } from "../src/omp-binary";
import { OmpRpcSource } from "../src/omp-source";

/**
 * Replaces account/credential-derived identifiers omp records in sessions (local credential row id, the credential pin hash,
 * provider response ids) with fixed values, so the fixture can be published.
 */
function scrubIdentifiers(node: unknown): void {
	if (Array.isArray(node)) return node.forEach(scrubIdentifiers);
	if (typeof node !== "object" || node === null) return;
	const record = node as Record<string, unknown>;
	if (record.type === "credential_pin" && typeof record.hash === "string") record.hash = "0".repeat(64);
	for (const key of Object.keys(record)) {
		if (key === "credentialId" && typeof record[key] === "number") record[key] = 1;
		else if (key === "responseId" && typeof record[key] === "string") record[key] = "msg_fixture";
		else scrubIdentifiers(record[key]);
	}
}

const fixturePath = join(import.meta.dir, "../test/fixtures/turn.json");
if (process.argv[2] === "--scrub") {
	// Re-scrub an existing fixture in place without calling a model.
	const existing = JSON.parse(await Bun.file(fixturePath).text());
	scrubIdentifiers(existing);
	writeFileSync(fixturePath, `${JSON.stringify(existing, null, "\t")}\n`);
	console.log(`scrubbed ${fixturePath}`);
	process.exit(0);
}

const out = process.argv[2] ?? fixturePath;
const rawRoot = mkdtempSync(join(tmpdir(), "omp-web-fixture-"));
const root = realpathSync(rawRoot); // macOS: /var/... is a symlink to /private/var/...; omp may report either
const project = join(root, "project");
mkdirSync(project);
writeFileSync(
	join(project, "package.json"),
	`${JSON.stringify({ name: "demo-app", version: "1.0.0", private: true, scripts: { test: "bun test" } }, null, 2)}\n`,
);

const omp = await locateOmp();
const source = new OmpRpcSource({
	ompPath: omp.path,
	cwd: project,
	model: Bun.env.PROOF_MODEL,
	sessionDir: join(root, "sessions"),
});
const events: AgentSessionEvent[] = [];
source.onSessionEvent(event => events.push(event));
const done = Promise.withResolvers<void>();
source.onPromptResult(result =>
	result.status === "error" ? done.reject(new Error(result.error?.message)) : done.resolve(),
);
await source.start();
const state = await source.getState();
await source.prompt("Use the read tool to read package.json, then answer in one short sentence. Nothing else.");
await done.promise;
await source.getState(); // flush: everything printed before this response has been delivered
const entries = await source.getEntries();
await source.stop();

// Thin long streaming runs: keep every 4th update and the last of each run (the fixture only needs to prove streaming).
const thinned: AgentSessionEvent[] = [];
let run = 0;
for (let i = 0; i < events.length; i++) {
	const event = events[i]!;
	if (event.type !== "message_update") {
		run = 0;
		thinned.push(event);
		continue;
	}
	const last = events[i + 1]?.type !== "message_update";
	if (run++ % 4 === 0 || last) thinned.push(event);
}
for (const event of thinned) if (event.type === "notice") event.message = "[trimmed]";

const scrubbed = { omp: omp.version, model: state.model?.id, events: thinned, entries: entries.entries };
scrubIdentifiers(scrubbed);
const sanitize = (text: string): string =>
	text
		.replaceAll(project, "/work/project")
		.replaceAll(join(rawRoot, "project"), "/work/project")
		.replaceAll(root, "/work")
		.replaceAll(rawRoot, "/work")
		.replaceAll(homedir(), "/home/user");
writeFileSync(out, sanitize(`${JSON.stringify(scrubbed, null, "\t")}\n`));
console.log(`recorded ${thinned.length}/${events.length} events, ${entries.entries.length} entries -> ${out}`);
