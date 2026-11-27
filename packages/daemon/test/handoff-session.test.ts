import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { aclProblem } from "../src/file-acl";
import {
	markSessionMoved,
	normalizeHeader,
	type OmpRun,
	packSessionFile,
	readSessionHeader,
	removeSessionCopy,
	SessionTransferError,
	sessionBodyFingerprint,
	sessionCopyFiles,
	unpackSessionArchive,
} from "../src/handoff-session";
import { writeExecutable } from "./fake-bin";
import { titleSlot } from "./session-files";

const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-web-handoff-session-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
const freshDir = (name: string): string => {
	const dir = join(root, `${name}-${++counter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const sha = (bytes: Uint8Array | string): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

interface JournalSpec {
	/** Line 1 including its terminator; default: omp's 256-byte title slot. */
	slot?: string;
	header: Record<string, unknown>;
	body?: string[];
	eol?: "\n" | "\r\n";
}

/** The three regions of a session file as bytes, so a test can prove which ones an edit touched. */
function journal(spec: JournalSpec): { bytes: Buffer; slot: Buffer; header: Buffer; body: Buffer } {
	const eol = spec.eol ?? "\n";
	const slot = Buffer.from(spec.slot ?? titleSlot("title"));
	const header = Buffer.from(JSON.stringify(spec.header) + eol);
	const body = Buffer.from((spec.body ?? []).map(line => line + eol).join(""));
	return { bytes: Buffer.concat([slot, header, body]), slot, header, body };
}

const baseHeader = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	type: "session",
	version: 3,
	id: "sess-1",
	timestamp: "2026-11-01T10:00:00.000Z",
	cwd: "/work/project",
	...extra,
});

const entry = (n: number): string =>
	JSON.stringify({
		type: "message",
		id: `e${n}`,
		parentId: n ? `e${n - 1}` : null,
		message: { role: "user", text: `t${n}` },
	});

function writeJournal(dir: string, spec: JournalSpec, name = "2026-11-01T10-00-00-000Z_sess-1.jsonl") {
	const parts = journal(spec);
	const file = join(dir, name);
	writeFileSync(file, parts.bytes);
	return { file, ...parts };
}

const split = (bytes: Buffer, slotLength: number, headerLength: number) => ({
	slot: bytes.subarray(0, slotLength),
	header: bytes.subarray(slotLength, slotLength + headerLength),
	body: bytes.subarray(slotLength + headerLength),
});

describe("readSessionHeader", () => {
	test("reads the title slot and the header, with the directory lists as arrays", async () => {
		const { file, slot } = writeJournal(freshDir("read"), {
			header: baseHeader({ additionalDirectories: ["/a", "/b"], previousSessionFiles: ["/tmp/x.jsonl"] }),
			body: [entry(0)],
		});
		const info = await readSessionHeader(file);
		expect(info.slot).toBe(slot.toString().replace(/\n$/, ""));
		expect(info.header.id).toBe("sess-1");
		expect(info.additionalDirectories).toEqual(["/a", "/b"]);
		expect(info.previousSessionFiles).toEqual(["/tmp/x.jsonl"]);
	});

	test("a file without a title slot has its header on line 1", async () => {
		const dir = freshDir("noslot");
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${JSON.stringify(baseHeader())}\n${entry(0)}\n`);
		const info = await readSessionHeader(file);
		expect(info.slot).toBe("");
		expect(info.header.cwd).toBe("/work/project");
		expect(info.additionalDirectories).toEqual([]);
	});

	test("anything that is not a session journal is a failed SessionTransferError", async () => {
		const dir = freshDir("notsession");
		const cases: Record<string, string> = {
			"empty.jsonl": "",
			"text.jsonl": "hello\nworld\n",
			"slotonly.jsonl": titleSlot("t"),
			"otherjson.jsonl": `${JSON.stringify({ type: "title" })}\n${JSON.stringify({ type: "message" })}\n`,
			"noid.jsonl": `${JSON.stringify({ type: "session" })}\n`,
		};
		for (const [name, content] of Object.entries(cases)) {
			writeFileSync(join(dir, name), content);
			const error = await readSessionHeader(join(dir, name)).catch(e => e);
			expect(error, name).toBeInstanceOf(SessionTransferError);
			expect(error.kind, name).toBe("failed");
		}
		const missing = await readSessionHeader(join(dir, "gone.jsonl")).catch(e => e);
		expect(missing).toBeInstanceOf(SessionTransferError);
	});
});

describe("normalizeHeader", () => {
	test.skipIf(process.platform !== "win32")(
		"restricts the rewritten journal even in a broadly readable directory",
		async () => {
			const dir = freshDir("broad-acl");
			const grant = Bun.spawnSync(["icacls", dir, "/grant", "*S-1-1-0:(OI)(CI)R"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(grant.exitCode).toBe(0);
			const original = writeJournal(dir, {
				header: baseHeader({ previousSessionFiles: ["/tmp/old"] }),
				body: [entry(0), entry(1)],
				eol: "\r\n",
			});
			expect(aclProblem(original.file)).not.toBeNull();
			await normalizeHeader(original.file, { clearAdditionalDirectories: false });
			expect(aclProblem(original.file)).toBeNull();
			const after = readFileSync(original.file);
			expect(after.subarray(0, original.slot.length).equals(original.slot)).toBe(true);
			expect(after.subarray(-original.body.length).equals(original.body)).toBe(true);
			expect(readdirSync(dir)).toEqual([original.file.slice(dir.length + 1)]);
		},
	);

	test("drops previousSessionFiles from line 2 and leaves every other byte alone", async () => {
		const dir = freshDir("norm");
		const original = writeJournal(dir, {
			header: baseHeader({ additionalDirectories: ["/keep"], previousSessionFiles: ["/tmp/stage.jsonl"], zed: 1 }),
			body: Array.from({ length: 50 }, (_, i) => entry(i)),
		});
		chmodSync(original.file, 0o640);
		const result = await normalizeHeader(original.file, { clearAdditionalDirectories: false });
		expect(result).toEqual({ dropped: [], removedPreviousSessionFiles: true });

		const after = readFileSync(original.file);
		const parts = split(after, original.slot.length, after.length - original.slot.length - original.body.length);
		expect(sha(parts.slot)).toBe(sha(original.slot));
		expect(sha(parts.body)).toBe(sha(original.body));
		expect(parts.header.toString()).toBe(
			`${JSON.stringify(baseHeader({ additionalDirectories: ["/keep"], zed: 1 }))}\n`,
		);
		if (process.platform !== "win32") expect(statSync(original.file).mode & 0o777).toBe(0o640);
		// The temp file of the atomic rewrite is gone.
		expect(readdirSync(dir)).toEqual([original.file.slice(dir.length + 1)]);
	});

	test("clearAdditionalDirectories reports what it dropped", async () => {
		const original = writeJournal(freshDir("dirs"), {
			header: baseHeader({ additionalDirectories: ["/src/a", "/src/b"], previousSessionFiles: [] }),
			body: [entry(0)],
		});
		const result = await normalizeHeader(original.file, { clearAdditionalDirectories: true });
		expect(result).toEqual({ dropped: ["/src/a", "/src/b"], removedPreviousSessionFiles: true });
		const info = await readSessionHeader(original.file);
		expect(info.header).toEqual(baseHeader());
		expect(sha(readFileSync(original.file).subarray(-original.body.length))).toBe(sha(original.body));
	});

	test("only previousSessionFiles when additionalDirectories are kept, only additionalDirectories when it is absent", async () => {
		const keep = writeJournal(freshDir("keep"), { header: baseHeader({ additionalDirectories: ["/x"] }) });
		expect(await normalizeHeader(keep.file, { clearAdditionalDirectories: false })).toEqual({
			dropped: [],
			removedPreviousSessionFiles: false,
		});
		const drop = writeJournal(freshDir("drop"), { header: baseHeader({ previousSessionFiles: ["/p"] }) });
		expect(await normalizeHeader(drop.file, { clearAdditionalDirectories: true })).toEqual({
			dropped: [],
			removedPreviousSessionFiles: true,
		});
	});

	test("nothing to change is a no-op: the file is not rewritten", async () => {
		const original = writeJournal(freshDir("noop"), { header: baseHeader(), body: [entry(0), entry(1)] });
		const before = statSync(original.file);
		const result = await normalizeHeader(original.file, { clearAdditionalDirectories: true });
		expect(result).toEqual({ dropped: [], removedPreviousSessionFiles: false });
		const after = statSync(original.file);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(sha(readFileSync(original.file))).toBe(sha(original.bytes));
	});

	test("keeps CRLF terminators on the header line and on the lines around it", async () => {
		const original = writeJournal(freshDir("crlf"), {
			slot: `${JSON.stringify({ type: "title", title: "t", pad: "p" })}\r\n`,
			header: baseHeader({ previousSessionFiles: ["/p"], additionalDirectories: ["/d"] }),
			body: [entry(0), entry(1)],
			eol: "\r\n",
		});
		await normalizeHeader(original.file, { clearAdditionalDirectories: true });
		const text = readFileSync(original.file).toString();
		const lines = text.split("\r\n");
		expect(lines[1]).toBe(JSON.stringify(baseHeader()));
		expect(text).toBe(`${original.slot.toString()}${JSON.stringify(baseHeader())}\r\n${entry(0)}\r\n${entry(1)}\r\n`);
	});

	test("a header without a trailing line end (a session with no entries yet) is rewritten too", async () => {
		const dir = freshDir("noeol");
		const file = join(dir, "s.jsonl");
		const slot = titleSlot("t");
		writeFileSync(file, slot + JSON.stringify(baseHeader({ previousSessionFiles: ["/p"] })));
		await normalizeHeader(file, { clearAdditionalDirectories: false });
		expect(readFileSync(file).toString()).toBe(slot + JSON.stringify(baseHeader()));
	});

	test("works on a file with no title slot (header on line 1)", async () => {
		const dir = freshDir("slotless");
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${JSON.stringify(baseHeader({ previousSessionFiles: ["/p"] }))}\n${entry(0)}\n`);
		await normalizeHeader(file, { clearAdditionalDirectories: false });
		expect(readFileSync(file).toString()).toBe(`${JSON.stringify(baseHeader())}\n${entry(0)}\n`);
	});

	test("multi-megabyte bodies are copied byte for byte and never parsed", async () => {
		const dir = freshDir("big");
		// A body that is not JSON at all, with multibyte text and lone carriage returns: a whole-file parse (or a text
		// round trip) would choke on it or alter it.
		const line = `{"unfinished": "ünïcödé 日本語 \r still the same line ${"x".repeat(900)}`;
		const body = Array.from({ length: 6000 }, () => line);
		const original = writeJournal(dir, {
			header: baseHeader({ previousSessionFiles: ["/p"] }),
			body,
		});
		expect(original.body.length).toBeGreaterThan(5 * 1024 * 1024);
		await normalizeHeader(original.file, { clearAdditionalDirectories: false });
		const after = readFileSync(original.file);
		expect(after.length).toBe(
			original.slot.length + `${JSON.stringify(baseHeader())}\n`.length + original.body.length,
		);
		expect(sha(after.subarray(after.length - original.body.length))).toBe(sha(original.body));
		expect(sha(after.subarray(0, original.slot.length))).toBe(sha(original.slot));
	});

	test("a file that is not a session is left untouched and reported", async () => {
		const dir = freshDir("garbage");
		const file = join(dir, "x.jsonl");
		writeFileSync(file, "not json\nmore\n");
		const error = await normalizeHeader(file, { clearAdditionalDirectories: true }).catch(e => e);
		expect(error).toBeInstanceOf(SessionTransferError);
		expect(readFileSync(file).toString()).toBe("not json\nmore\n");
		expect(readdirSync(dir)).toEqual(["x.jsonl"]);
	});
});

describe("removeSessionCopy / sessionCopyFiles", () => {
	/** A bucket holding session A (journal, artifacts, omp's lock files, an unpack backup) and an unrelated session B. */
	function bucket(): { dir: string; a: string; b: string } {
		const dir = freshDir("bucket");
		const a = writeJournal(dir, { header: baseHeader({ id: "aaa" }), body: [entry(0)] }, "t_aaa.jsonl").file;
		const b = writeJournal(dir, { header: baseHeader({ id: "bbb" }), body: [entry(0)] }, "t_bbb.jsonl").file;
		mkdirSync(join(dir, "t_aaa", "nested"), { recursive: true });
		writeFileSync(join(dir, "t_aaa", "nested", "0.txt"), "artifact");
		mkdirSync(join(dir, "t_bbb"));
		writeFileSync(join(dir, "t_bbb", "1.txt"), "keep");
		writeFileSync(join(dir, ".t_aaa.jsonl.lock.os"), "");
		writeFileSync(join(dir, ".t_bbb.jsonl.lock.os"), "");
		writeFileSync(join(dir, "t_aaa.jsonl.unpack-123.bak"), "old");
		writeFileSync(join(dir, "t_aaa.jsonl.456.bak"), "old");
		writeFileSync(join(dir, "t_bbb.jsonl.789.bak"), "other");
		return { dir, a, b };
	}

	test("removes the journal, artifacts directory, lock file and backups, and nothing else", async () => {
		const { dir, a } = bucket();
		const planned = await sessionCopyFiles(a);
		expect(planned.at(-1)).toBe(a);
		expect(planned).toContain(join(dir, "t_aaa"));
		expect(planned).toContain(join(dir, ".t_aaa.jsonl.lock.os"));
		expect(planned).toContain(join(dir, "t_aaa.jsonl.unpack-123.bak"));
		expect(planned).toContain(join(dir, "t_aaa.jsonl.456.bak"));
		expect(planned).toHaveLength(5);
		expect(existsSync(a)).toBe(true); // planning deletes nothing

		const removed = await removeSessionCopy(a);
		expect([...removed].sort()).toEqual([...planned].sort());
		expect(readdirSync(dir).sort()).toEqual(
			[".t_bbb.jsonl.lock.os", "t_bbb", "t_bbb.jsonl", "t_bbb.jsonl.789.bak"].sort(),
		);
		expect(readFileSync(join(dir, "t_bbb", "1.txt")).toString()).toBe("keep");
	});

	test("is idempotent", async () => {
		const { a } = bucket();
		await removeSessionCopy(a);
		expect(await removeSessionCopy(a)).toEqual([]);
		expect(await sessionCopyFiles(a)).toEqual([]);
	});

	test("removes the bucket only when asked and when it is empty afterwards", async () => {
		const { dir, a, b } = bucket();
		const kept = await removeSessionCopy(a, { removeEmptyBucket: true });
		expect(kept).not.toContain(dir);
		expect(existsSync(dir)).toBe(true);

		await removeSessionCopy(b);
		const lone = freshDir("lone");
		const only = writeJournal(lone, { header: baseHeader() }, "t_only.jsonl").file;
		const removed = await removeSessionCopy(only, { removeEmptyBucket: true });
		expect(removed).toEqual([only, lone]);
		expect(existsSync(lone)).toBe(false);

		const stays = freshDir("stays");
		const first = writeJournal(stays, { header: baseHeader() }, "t_first.jsonl").file;
		await removeSessionCopy(first);
		expect(existsSync(stays)).toBe(true);
	});

	test("refuses a path that is not an absolute .jsonl file with a session header", async () => {
		const dir = freshDir("refuse");
		const notSession = join(dir, "notes.jsonl");
		writeFileSync(notSession, "just text\n");
		mkdirSync(join(dir, "notes"));
		const txt = join(dir, "readme.txt");
		writeFileSync(txt, "x");
		const folder = join(dir, "folder.jsonl");
		mkdirSync(folder);

		for (const path of [notSession, txt, folder, "relative/s.jsonl", join(dir, ".jsonl")]) {
			const error = await removeSessionCopy(path, { removeEmptyBucket: true }).catch(e => e);
			expect(error, path).toBeInstanceOf(SessionTransferError);
			const planError = await sessionCopyFiles(path).catch(e => e);
			expect(planError, path).toBeInstanceOf(SessionTransferError);
		}
		expect(readdirSync(dir).sort()).toEqual(["folder.jsonl", "notes", "notes.jsonl", "readme.txt"]);
		expect(readFileSync(notSession).toString()).toBe("just text\n");
	});
});

describe("sessionBodyFingerprint", () => {
	const entries = Array.from({ length: 10 }, (_, i) => entry(i));

	test("is stable and counts the entries after the header", async () => {
		const { file } = writeJournal(freshDir("fp"), { header: baseHeader(), body: entries });
		const a = await sessionBodyFingerprint(file);
		expect(a.entries).toBe(10);
		expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await sessionBodyFingerprint(file)).toEqual(a);
	});

	test("ignores the header, the title slot, whitespace and line endings", async () => {
		const plain = writeJournal(freshDir("fp1"), { header: baseHeader(), body: entries });
		const other = writeJournal(freshDir("fp2"), {
			slot: titleSlot("another title"),
			header: baseHeader({ id: "different", cwd: "/elsewhere", parentSession: "/p" }),
			body: entries.map(line => JSON.stringify(JSON.parse(line), null, 1).replace(/\n\s*/g, " ")),
			eol: "\r\n",
		});
		expect(await sessionBodyFingerprint(other.file)).toEqual(await sessionBodyFingerprint(plain.file));
	});

	test("maxEntries covers a prefix: a longer copy matches over the shorter's length and differs overall", async () => {
		const short = writeJournal(freshDir("fp3"), { header: baseHeader(), body: entries.slice(0, 6) });
		const long = writeJournal(freshDir("fp4"), {
			header: baseHeader({ id: "fork" }),
			body: [...entries.slice(0, 6), entry(99)],
		});
		const shortPrint = await sessionBodyFingerprint(short.file);
		expect(await sessionBodyFingerprint(long.file, shortPrint.entries)).toEqual(shortPrint);
		expect((await sessionBodyFingerprint(long.file)).hash).not.toBe(shortPrint.hash);
		expect(await sessionBodyFingerprint(long.file, 1000)).toEqual({
			entries: 7,
			hash: (await sessionBodyFingerprint(long.file)).hash,
		});
		expect((await sessionBodyFingerprint(long.file, 0)).entries).toBe(0);
	});

	test("is sensitive to a changed, reordered or missing entry", async () => {
		const base = await sessionBodyFingerprint(
			writeJournal(freshDir("fp5"), { header: baseHeader(), body: entries }).file,
		);
		const edited = [...entries];
		edited[3] = entry(33);
		const swapped = [...entries];
		[swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
		for (const body of [edited, swapped, entries.slice(1)]) {
			const print = await sessionBodyFingerprint(writeJournal(freshDir("fp6"), { header: baseHeader(), body }).file);
			expect(print.hash).not.toBe(base.hash);
		}
	});

	test("skips lines that are not JSON, as omp does, and reads a last line without a line end", async () => {
		const dir = freshDir("fp7");
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${titleSlot("t")}${JSON.stringify(baseHeader())}\n${entry(0)}\ngarbage {\n\n${entry(1)}`);
		const clean = writeJournal(freshDir("fp8"), { header: baseHeader(), body: [entry(0), entry(1)] });
		expect(await sessionBodyFingerprint(file)).toEqual(await sessionBodyFingerprint(clean.file));
	});

	test("streams a multi-megabyte body split across read chunks", async () => {
		const body = Array.from({ length: 4000 }, (_, i) => JSON.stringify({ i, text: `ünï ${"y".repeat(1500)}` }));
		const { file } = writeJournal(freshDir("fp9"), { header: baseHeader(), body });
		const print = await sessionBodyFingerprint(file);
		expect(print.entries).toBe(4000);
		const hasher = new Bun.CryptoHasher("sha256");
		for (const line of body) hasher.update(`${line}\n`);
		expect(print.hash).toBe(hasher.digest("hex"));
	});

	test("a file that is not a session is an error", async () => {
		const dir = freshDir("fp10");
		writeFileSync(join(dir, "x.jsonl"), "nope\n");
		expect(await sessionBodyFingerprint(join(dir, "x.jsonl")).catch(e => e)).toBeInstanceOf(SessionTransferError);
	});
});

// ---------------------------------------------------------------------------
// The omp wrappers, against a fake `omp` that prints the documented outputs
// ---------------------------------------------------------------------------

describe("omp session wrappers (fake omp)", () => {
	const REFUSAL =
		"Cannot pack /s/file.jsonl: another live omp process writes this session. Exit it first. Nothing was changed.";
	let fakeDir: string;
	let fakeOmp: string;

	beforeAll(() => {
		fakeDir = freshDir("fake-omp");
		// Behaviour comes from FAKE_OMP_* variables; it records its argv and what it saw of the environment.
		fakeOmp = writeExecutable(
			join(fakeDir, "omp"),
			`
printf '%s\\n' "$@" > "$FAKE_OMP_RECORD"
printf '%s' "\${FAKE_OMP_PROBE-<unset>}" > "$FAKE_OMP_RECORD.probe"
if [ -n "$FAKE_OMP_PIDFILE" ]; then echo $$ > "$FAKE_OMP_PIDFILE"; fi
if [ -n "$FAKE_OMP_SLEEP" ]; then exec sleep "$FAKE_OMP_SLEEP"; fi
if [ -n "$FAKE_OMP_TOUCH" ]; then : > "$FAKE_OMP_TOUCH"; fi
if [ -n "$FAKE_OMP_FLOOD" ]; then head -c 3000000 /dev/zero | tr '\\0' x >&2; echo >&2; fi
if [ -n "$FAKE_OMP_STDOUT" ]; then printf '%s\\n' "$FAKE_OMP_STDOUT"; fi
if [ -n "$FAKE_OMP_STDERR" ]; then printf '%s\\n' "$FAKE_OMP_STDERR" >&2; fi
exit "\${FAKE_OMP_EXIT:-0}"
`,
		);
	});

	/** An OmpRun whose fake records into a fresh file; `argv()` reads what omp was called with. */
	function fake(env: Record<string, string | undefined> = {}, extra: Partial<OmpRun> = {}) {
		const record = join(freshDir("record"), "argv");
		const run: OmpRun = { ompPath: fakeOmp, env: { FAKE_OMP_RECORD: record, ...env }, ...extra };
		return {
			run,
			argv: (): string[] | null => (existsSync(record) ? readFileSync(record, "utf8").trimEnd().split("\n") : null),
			probe: (): string => readFileSync(`${record}.probe`, "utf8"),
		};
	}

	const ESC = "\u001b";
	const red = (text: string): string => `${ESC}[31m${text}${ESC}[39m`;
	const dim = (text: string): string => `${ESC}[2m${text}${ESC}[22m`;

	describe("packSessionFile", () => {
		test("runs `omp session pack <file> <tar>` with an argv array and reports no missing blobs", async () => {
			const dir = freshDir("pack");
			const tar = join(dir, "out.tar");
			const f = fake({ FAKE_OMP_TOUCH: tar, FAKE_OMP_STDOUT: tar });
			// Paths with spaces and shell metacharacters reach omp as single arguments.
			const file = join(dir, "a b; $(touch pwned).jsonl");
			expect(await packSessionFile(f.run, file, tar)).toEqual({ missingBlobs: 0 });
			expect(f.argv()).toEqual(["session", "pack", file, tar]);
			expect(existsSync(join(dir, "pwned"))).toBe(false);
		});

		test("parses the missing-blob warning (colored or not)", async () => {
			const tar = join(freshDir("pack-blobs"), "out.tar");
			const warning =
				"warning: 3 referenced blob(s) are missing from the local blob store and were not packed; those images will not load after unpacking.";
			for (const stderr of [warning, `${ESC}[33m${warning}${ESC}[39m`]) {
				const f = fake({ FAKE_OMP_TOUCH: tar, FAKE_OMP_STDERR: stderr });
				expect(await packSessionFile(f.run, "/s/file.jsonl", tar)).toEqual({ missingBlobs: 3 });
			}
		});

		test("a live owner is a refusal carrying omp's sentence, without color codes", async () => {
			const f = fake({ FAKE_OMP_EXIT: "1", FAKE_OMP_STDERR: red(`error: ${REFUSAL}`) });
			const error = await packSessionFile(f.run, "/s/file.jsonl", join(freshDir("pack-refused"), "out.tar")).catch(
				e => e,
			);
			expect(error).toBeInstanceOf(SessionTransferError);
			expect(error.kind).toBe("refused");
			expect(error.message).toBe(REFUSAL);
		});

		test("a lease message without omp's error: prefix is still a refusal", async () => {
			const f = fake({ FAKE_OMP_EXIT: "1", FAKE_OMP_STDERR: REFUSAL });
			const error = await packSessionFile(f.run, "/s/file.jsonl", "/tmp/never.tar").catch(e => e);
			expect(error.kind).toBe("refused");
			expect(error.message).toBe(REFUSAL);
		});

		test("a crash (no error: line) is a failure with the last stderr line", async () => {
			const f = fake({ FAKE_OMP_EXIT: "3", FAKE_OMP_STDERR: "TypeError: boom\n    at run (cli.ts:1:1)" });
			const error = await packSessionFile(f.run, "/s/file.jsonl", "/tmp/never.tar").catch(e => e);
			expect(error).toBeInstanceOf(SessionTransferError);
			expect(error.kind).toBe("failed");
			expect(error.message).toBe("at run (cli.ts:1:1)");
		});

		test("a silent non-zero exit names the exit code", async () => {
			const f = fake({ FAKE_OMP_EXIT: "9" });
			const error = await packSessionFile(f.run, "/s/file.jsonl", "/tmp/never.tar").catch(e => e);
			expect(error.kind).toBe("failed");
			expect(error.message).toContain("exited with code 9");
		});

		test("success without an archive on disk is a failure", async () => {
			const f = fake();
			const error = await packSessionFile(f.run, "/s/file.jsonl", join(freshDir("pack-none"), "out.tar")).catch(
				e => e,
			);
			expect(error.kind).toBe("failed");
			expect(error.message).toContain("no archive");
		});

		test("a chatty stderr beyond the output cap neither blocks nor breaks the result", async () => {
			const tar = join(freshDir("pack-flood"), "out.tar");
			const f = fake({ FAKE_OMP_TOUCH: tar, FAKE_OMP_FLOOD: "1" });
			expect(await packSessionFile(f.run, "/s/file.jsonl", tar)).toEqual({ missingBlobs: 0 });
		});
	});

	describe("unpackSessionArchive", () => {
		function landed(name = "2026-11-01T10-00-00-000Z_sess-1.jsonl"): string {
			return writeJournal(freshDir("landed"), { header: baseHeader(), body: [entry(0)] }, name).file;
		}

		test("runs `omp session unpack <tar> --cwd=<cwd>` and returns the file, its id and the mode", async () => {
			const file = landed();
			const f = fake({ FAKE_OMP_STDOUT: file, FAKE_OMP_STDERR: dim("Unpacked session (sess-1).") });
			const result = await unpackSessionArchive(f.run, "/x/in.tar", "/work/target");
			expect(result).toEqual({ file, id: "sess-1", mode: "created" });
			expect(f.argv()).toEqual(["session", "unpack", resolve("/x/in.tar"), `--cwd=${resolve("/work/target")}`]);
		});

		test("maps each of omp's three sentences to its mode", async () => {
			const file = landed();
			const notes: Record<string, string> = {
				created: "Unpacked session (sess-1).",
				replaced: "Replaced the local copy of this session (sess-1).",
				forked: "The local copy of this session diverged; unpacked as a fork (sess-1).",
			};
			for (const [mode, note] of Object.entries(notes)) {
				const f = fake({ FAKE_OMP_STDOUT: file, FAKE_OMP_STDERR: dim(note) });
				expect((await unpackSessionArchive(f.run, "/x/in.tar", "/work/t")).mode).toBe(mode as "created");
			}
		});

		test("an unrecognized outcome sentence is a failure that names the file", async () => {
			const file = landed();
			const f = fake({ FAKE_OMP_STDOUT: file, FAKE_OMP_STDERR: "something new (sess-1)." });
			const error = await unpackSessionArchive(f.run, "/x/in.tar", "/work/t").catch(e => e);
			expect(error.kind).toBe("failed");
			expect(error.message).toContain(file);
		});

		test("stdout that is not exactly one existing absolute .jsonl path is a failure", async () => {
			const file = landed();
			const cases = [
				"",
				"relative/session.jsonl",
				join(freshDir("x"), "gone.jsonl"),
				join(freshDir("x"), "notes.txt"),
				`${file}\n${file}`,
			];
			writeFileSync(cases[3]!, "x");
			for (const stdout of cases) {
				const f = fake({ FAKE_OMP_STDOUT: stdout, FAKE_OMP_STDERR: "Unpacked session (sess-1)." });
				const error = await unpackSessionArchive(f.run, "/x/in.tar", "/work/t").catch(e => e);
				expect(error, JSON.stringify(stdout)).toBeInstanceOf(SessionTransferError);
				expect(error.kind).toBe("failed");
			}
		});

		test("a stdout path that is not a session journal is a failure", async () => {
			const dir = freshDir("landed-bad");
			const file = join(dir, "x_y.jsonl");
			writeFileSync(file, "not a session\n");
			const f = fake({ FAKE_OMP_STDOUT: file, FAKE_OMP_STDERR: "Unpacked session (y)." });
			expect(await unpackSessionArchive(f.run, "/x/in.tar", "/work/t").catch(e => e)).toBeInstanceOf(
				SessionTransferError,
			);
		});

		test("a bad archive version is a refusal", async () => {
			const message =
				"Unsupported session archive version 9 in /x/in.tar: omp 18.19.0 reads version 1. Update omp on this machine.";
			const f = fake({ FAKE_OMP_EXIT: "1", FAKE_OMP_STDERR: red(`error: ${message}`) });
			const error = await unpackSessionArchive(f.run, "/x/in.tar", "/work/t").catch(e => e);
			expect(error.kind).toBe("refused");
			expect(error.message).toBe(message);
		});
	});

	describe("markSessionMoved", () => {
		test("runs `omp session moved <file> --to=<label>`", async () => {
			const f = fake();
			await markSessionMoved(f.run, "/s/file.jsonl", "cloud-box");
			expect(f.argv()).toEqual(["session", "moved", resolve("/s/file.jsonl"), "--to=cloud-box"]);
		});

		test("the label is one line, at most 120 characters, and cannot be read as an option", async () => {
			const f = fake();
			await markSessionMoved(f.run, "/s/file.jsonl", "  my\nlaptop\t\r\n (home)  ");
			expect(f.argv()).toEqual(["session", "moved", resolve("/s/file.jsonl"), "--to=my laptop (home)"]);

			await markSessionMoved(f.run, "/s/file.jsonl", "--evil");
			expect(f.argv()).toEqual(["session", "moved", resolve("/s/file.jsonl"), "--to=--evil"]);

			await markSessionMoved(f.run, "/s/file.jsonl", "é".repeat(500));
			const label = f.argv()![3]!.slice("--to=".length);
			expect(Array.from(label)).toHaveLength(120);
			expect(label).toBe("é".repeat(120));

			// A surrogate pair is not cut in half.
			await markSessionMoved(f.run, "/s/file.jsonl", "😀".repeat(200));
			expect(Array.from(f.argv()![3]!.slice("--to=".length))).toHaveLength(120);
		});

		test("an empty label never reaches omp", async () => {
			const f = fake();
			for (const label of ["", "   ", "\n\t"]) {
				const error = await markSessionMoved(f.run, "/s/file.jsonl", label).catch(e => e);
				expect(error).toBeInstanceOf(SessionTransferError);
				expect(error.kind).toBe("failed");
			}
			expect(f.argv()).toBeNull();
		});

		test("a live owner is a refusal", async () => {
			const message =
				"Cannot mark moved /s/file.jsonl: another live omp process writes this session. Exit it first. Nothing was changed.";
			const f = fake({ FAKE_OMP_EXIT: "1", FAKE_OMP_STDERR: red(`error: ${message}`) });
			const error = await markSessionMoved(f.run, "/s/file.jsonl", "x").catch(e => e);
			expect(error.kind).toBe("refused");
			expect(error.message).toBe(message);
		});
	});

	describe("running omp", () => {
		test("a process that outlives the timeout is killed", async () => {
			const pidFile = join(freshDir("pid"), "pid");
			const f = fake({ FAKE_OMP_PIDFILE: pidFile, FAKE_OMP_SLEEP: "30" }, { timeoutMs: 400 });
			const started = performance.now();
			const error = await markSessionMoved(f.run, "/s/file.jsonl", "x").catch(e => e);
			expect(performance.now() - started).toBeLessThan(10_000);
			expect(error).toBeInstanceOf(SessionTransferError);
			expect(error.kind).toBe("failed");
			expect(error.message).toContain("did not finish");
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			expect(pid).toBeGreaterThan(1);
			expect(() => process.kill(pid, 0)).toThrow();
		});

		test("a binary that cannot be started is a failure", async () => {
			const error = await markSessionMoved({ ompPath: join(fakeDir, "does-not-exist") }, "/s/file.jsonl", "x").catch(
				e => e,
			);
			expect(error).toBeInstanceOf(SessionTransferError);
			expect(error.kind).toBe("failed");
			expect(error.message).toContain("cannot run omp");
		});

		test("the environment is the daemon's plus the overrides; undefined removes a variable", async () => {
			Bun.env.FAKE_OMP_PROBE = "from-daemon";
			try {
				const inherited = fake();
				await markSessionMoved(inherited.run, "/s/file.jsonl", "x");
				expect(inherited.probe()).toBe("from-daemon");

				const overridden = fake({ FAKE_OMP_PROBE: "override" });
				await markSessionMoved(overridden.run, "/s/file.jsonl", "x");
				expect(overridden.probe()).toBe("override");

				const removed = fake({ FAKE_OMP_PROBE: undefined });
				await markSessionMoved(removed.run, "/s/file.jsonl", "x");
				expect(removed.probe()).toBe("<unset>");
			} finally {
				delete Bun.env.FAKE_OMP_PROBE;
			}
		});
	});
});
