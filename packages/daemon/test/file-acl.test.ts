import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayStore } from "../src/db";
import {
	SID_ADMINISTRATORS,
	SID_SYSTEM,
	aclProblem,
	fixCommand,
	ownSid,
	parseDacl,
	readDacl,
	readersBeyond,
	rightsMask,
} from "../src/file-acl";
import { ConfigError, mkdirPrivate, readSecret, writeSecret } from "../src/secrets";

const ME = "S-1-5-21-111-222-333-1001";
const OTHER = "S-1-5-21-111-222-333-1004";
// what `icacls /save` printed for a file in %TEMP% (measured on the development machine, SIDs changed)
const DEFAULT = `tok\r\nD:AI(A;ID;0x1301bf;;;${OTHER})(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${ME})\r\n`;
const PRIVATE = `tok\r\nD:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${ME})\r\n`;

describe("the DACL parser and the verdict (pure: runs on every platform)", () => {
	test("rights are read from hex and from SDDL symbols; an unknown symbol is taken as everything", () => {
		expect(rightsMask("0x1301bf")).toBe(0x1301bf);
		expect(rightsMask("FA")).toBe(0x1f01ff);
		expect(rightsMask("FRFX")).toBe(0x120089 | 0x1200a0);
		expect(rightsMask("")).toBe(0);
		expect(rightsMask("ZZ")).toBe(0xffffffff);
	});

	test("trustee aliases are resolved, the flags and the rights are kept", () => {
		const dacl = parseDacl(DEFAULT);
		expect(dacl.isNull).toBe(false);
		expect(dacl.aces).toEqual([
			{ type: "A", flags: "ID", mask: 0x1301bf, sid: OTHER },
			{ type: "A", flags: "ID", mask: 0x1f01ff, sid: SID_SYSTEM },
			{ type: "A", flags: "ID", mask: 0x1f01ff, sid: SID_ADMINISTRATORS },
			{ type: "A", flags: "ID", mask: 0x1f01ff, sid: ME },
		]);
	});

	test("only this user, SYSTEM and Administrators: private; anybody else who can read: named; a NULL DACL: refused", () => {
		expect(readersBeyond(parseDacl(PRIVATE), ME)).toEqual([]);
		expect(readersBeyond(parseDacl(DEFAULT), ME)).toEqual([OTHER]); // inherited, but not an allowed trustee
		const withEveryone = parseDacl(`x\r\nD:PAI(A;;FR;;;WD)(A;;FA;;;SY)(A;;FA;;;${ME})\r\n`);
		expect(readersBeyond(withEveryone, ME)).toEqual(["S-1-1-0 (Everyone)"]);
		const users = parseDacl(`x\r\nD:PAI(A;;0x120089;;;BU)(A;;FA;;;${ME})\r\n`);
		expect(readersBeyond(users, ME)).toEqual(["S-1-5-32-545 (BUILTIN\\Users)"]);
		expect(readersBeyond(parseDacl("x\r\nD:NO_ACCESS_CONTROL\r\n"), ME)).toEqual(["NULL DACL (everyone)"]);
		expect(readersBeyond(parseDacl(`x\r\nD:PAI(A;;GR;;;AU)`), ME)).toEqual(["S-1-5-11 (Authenticated Users)"]);
	});

	test("what does not let anybody read does not count: deny ACEs, inherit-only ACEs, attribute/ACL-only rights, an empty DACL", () => {
		expect(readersBeyond(parseDacl(`x\r\nD:PAI(D;;FA;;;WD)(A;;FA;;;${ME})`), ME)).toEqual([]);
		expect(readersBeyond(parseDacl(`x\r\nD:PAI(A;OICIIOID;FA;;;WD)(A;;FA;;;${ME})`), ME)).toEqual([]);
		expect(readersBeyond(parseDacl(`x\r\nD:PAI(A;;0x80;;;WD)(A;;RC;;;BU)(A;;FA;;;${ME})`), ME)).toEqual([]);
		expect(readersBeyond(parseDacl(`x\r\nD:P`), ME)).toEqual([]);
	});

	test("a descriptor without a DACL cannot be judged", () => {
		expect(() => parseDacl("x\r\n")).toThrow(/no DACL/);
	});

	test.skipIf(process.platform !== "win32")(
		"the fix command is printed with SIDs (no account name), for files and for directories",
		() => {
			expect(fixCommand("C:\\a b\\token")).toMatch(
				/^icacls "C:\\a b\\token" \/inheritance:r \/grant:r \*S-1-5-21-[0-9-]+:F \*S-1-5-18:F \*S-1-5-32-544:F$/,
			);
			expect(fixCommand("C:\\a", true)).toContain("*S-1-5-18:(OI)(CI)F");
			expect(fixCommand("C:\\a", false, ["S-1-1-0", "S-1-5-32-545"])).toMatch(
				/ \/remove:g \*S-1-1-0 \*S-1-5-32-545$/,
			);
		},
	);
});

describe.skipIf(process.platform !== "win32")("secret files and directories with real icacls", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompweb-acl-")));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	let n = 0;
	const fresh = (name = "secret"): string => join(root, `d${++n}`, name);
	const icacls = (...args: string[]): void => {
		const done = Bun.spawnSync(["icacls", ...args], { stdout: "pipe", stderr: "pipe" });
		expect([args, done.exitCode]).toEqual([args, 0]);
	};
	/** Every trustee in the DACL, as SIDs. */
	const trustees = (path: string): string[] =>
		readDacl(path)
			.aces.map(a => a.sid)
			.toSorted();
	const allowed = (): string[] => [ownSid(), SID_SYSTEM, SID_ADMINISTRATORS].toSorted();

	test("a fresh secret is accepted, readable, and its DACL holds only this user, SYSTEM and Administrators (protected)", async () => {
		const file = fresh();
		await writeSecret(file, "s3cret\n");
		expect(await readSecret(file)).toBe("s3cret");
		expect(trustees(file)).toEqual(allowed());
		expect(readDacl(file).aces.every(a => !a.flags.includes("ID"))).toBe(true); // nothing inherited
		expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
	});

	test("rewriting keeps it restricted (the rename brings the temporary file's descriptor along)", async () => {
		const file = fresh();
		await writeSecret(file, "one\n");
		await writeSecret(file, "two\n");
		expect(await readSecret(file)).toBe("two");
		expect(trustees(file)).toEqual(allowed());
	});

	test("granting Everyone read access makes readSecret refuse, naming the trustee and the fix", async () => {
		const file = fresh();
		await writeSecret(file, "x\n");
		icacls(file, "/grant", "*S-1-1-0:R");
		const error = await readSecret(file).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as Error).message).toContain(file);
		expect((error as Error).message).toContain("S-1-1-0 (Everyone)");
		expect((error as Error).message).toContain(`icacls "${file}" /inheritance:r /grant:r *${ownSid()}:F`);
		// and the printed command, run as printed, really fixes it (an explicit Everyone ACE needs the /remove:g part)
		const printed = /run: (icacls .*)$/.exec((error as Error).message)![1]!;
		expect(printed).toContain("/remove:g *S-1-1-0");
		const argv = [...printed.matchAll(/"([^"]*)"|\S+/g)].map(m => m[1] ?? m[0]);
		expect(argv[0]).toBe("icacls");
		icacls(...argv.slice(1));
		expect(await readSecret(file)).toBe("x");
	});

	test("a changed ACL is detected on the next read, and a fixed ACL is accepted", async () => {
		const file = fresh();
		await writeSecret(file, "x\n");
		await readSecret(file);
		icacls(file, "/grant", "*S-1-1-0:R");
		await expect(readSecret(file)).rejects.toThrow(/Everyone/);
		icacls(file, "/remove:g", "*S-1-1-0");
		expect(await readSecret(file)).toBe("x");
	});

	test("the Users group is refused too", async () => {
		const file = fresh();
		await writeSecret(file, "x\n");
		icacls(file, "/grant", "*S-1-5-32-545:R");
		await expect(readSecret(file)).rejects.toThrow(/S-1-5-32-545 \(BUILTIN\\Users\)/);
	});

	test("a file that only inherits allowed ACEs passes: one created in a directory the daemon made", async () => {
		const dir = join(root, `d${++n}`, "nested", "state");
		await mkdirPrivate(dir); // creates d.., nested and state, each protected
		for (const level of [join(dir, ".."), dir]) {
			expect(trustees(level)).toEqual(allowed());
			expect(readDacl(level).aces.every(a => a.flags.includes("OI") && a.flags.includes("CI"))).toBe(true);
		}
		const child = join(dir, "token");
		writeFileSync(child, "plain write, no explicit ACL\n");
		expect(readDacl(child).aces.every(a => a.flags.includes("ID"))).toBe(true); // all inherited
		expect(trustees(child)).toEqual(allowed());
		expect(await readSecret(child)).toBe("plain write, no explicit ACL");
	});

	test("an existing directory is never touched, only the missing levels below it are created protected", async () => {
		const existing = join(root, `d${++n}`);
		mkdirSync(existing);
		const before = JSON.stringify(readDacl(existing));
		await mkdirPrivate(join(existing, "a", "b"));
		expect(JSON.stringify(readDacl(existing))).toBe(before);
		expect(trustees(join(existing, "a"))).toEqual(allowed());
		expect(trustees(join(existing, "a", "b"))).toEqual(allowed());
	});

	test("a file that cannot be inspected is refused, not accepted", () => {
		const problem = aclProblem(join(root, "does-not-exist"));
		expect(problem).toContain("cannot check who can read it");
		expect(problem).toContain("refusing to use it");
	});

	test("gateway.db: refused when others can read it; a new one is restricted, and so are its -wal and -shm", async () => {
		const dir = join(root, `d${++n}`, "state");
		const file = join(dir, "gateway.db");
		const store = GatewayStore.open(file); // creates the directory (protected) and the database
		store.close();
		const again = GatewayStore.open(file);
		for (const part of ["", "-wal", "-shm"]) {
			if (part === "" || existsSync(file + part)) expect([part, trustees(file + part)]).toEqual([part, allowed()]);
		}
		again.close();
		icacls(file, "/grant", "*S-1-5-32-545:R");
		expect(() => GatewayStore.open(file)).toThrow(/S-1-5-32-545/);
	});

	test("a database created in a directory that already existed gets its own restricted ACL", () => {
		const dir = join(root, `d${++n}`);
		mkdirSync(dir);
		const file = join(dir, "gateway.db");
		const store = GatewayStore.open(file);
		store.close();
		expect(trustees(file)).toEqual(allowed());
	});

	test("the check is cheap: no verdict cache is needed (milliseconds per file)", async () => {
		const file = fresh();
		await writeSecret(file, "x\n");
		const t0 = performance.now();
		for (let i = 0; i < 10; i++) expect(aclProblem(file)).toBeNull();
		const each = (performance.now() - t0) / 10;
		console.log(`aclProblem: ${each.toFixed(1)} ms per check`);
		expect(each).toBeLessThan(50);
	});
});
