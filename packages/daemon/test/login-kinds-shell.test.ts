import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyTerminal, nativePty } from "../src/pty-host";
import { until } from "./terminal-fixtures";
import { brokerCliCommand, cmdSetCommand, type CliContext, type CliShell } from "../src/login-kinds";

const ctx = (shell: CliShell, brokerHome: string | null): CliContext => ({
	platform: "win32",
	shell,
	brokerHome,
	brokerUrl: "http://127.0.0.1:8765",
	tokenFile: "C:\\t",
});

// A path with a space, a quote, an ampersand, a caret, non-ASCII and CJK (all legal in a Windows file name).
const AWKWARD = "C:\\Users\\Zoë O'Neil & Co ^ 日本語\\omp web\\auth-broker";

describe("the broker login command typed into a Windows shell (typed, never run)", () => {
	test("PowerShell (default): $env:USERPROFILE, single quotes doubled", () => {
		expect(brokerCliCommand("login anthropic", ctx("powershell", AWKWARD))).toBe(
			"$env:USERPROFILE = 'C:\\Users\\Zoë O''Neil & Co ^ 日本語\\omp web\\auth-broker'; omp auth-broker login anthropic",
		);
		expect(brokerCliCommand("login anthropic", { ...ctx("powershell", AWKWARD), shell: undefined })).toBe(
			brokerCliCommand("login anthropic", ctx("powershell", AWKWARD)),
		);
	});

	test("cmd.exe: set \"USERPROFILE=...\" && ...; the broker's HOME is only in front when it is not the user's own", () => {
		expect(brokerCliCommand("login anthropic", ctx("cmd", "C:\\Users\\u\\b b"))).toBe(
			'set "USERPROFILE=C:\\Users\\u\\b b" && omp auth-broker login anthropic',
		);
		expect(brokerCliCommand("login anthropic", ctx("cmd", null))).toBe("omp auth-broker login anthropic");
		// & ^ ' are literal inside the quotes of `set "..."`
		expect(brokerCliCommand("login x", ctx("cmd", AWKWARD))).toBe(
			`set "USERPROFILE=${AWKWARD}" && omp auth-broker login x`,
		);
		// what cmd cannot express is refused rather than typed wrong
		expect(() => cmdSetCommand("USERPROFILE", "C:\\100%\\x")).toThrow(/cannot be given/);
		expect(() => cmdSetCommand("USERPROFILE", 'C:\\a"b')).toThrow(/cannot be given/);
	});

	test("Git Bash: NAME='value' in front, single quotes escaped the POSIX way, backslashes verbatim", () => {
		expect(brokerCliCommand("login anthropic", ctx("gitbash", AWKWARD))).toBe(
			"USERPROFILE='C:\\Users\\Zoë O'\\''Neil & Co ^ 日本語\\omp web\\auth-broker' omp auth-broker login anthropic",
		);
		expect(brokerCliCommand("login x", ctx("gitbash", null))).toBe("omp auth-broker login x");
	});

	test("macOS/Linux: unchanged (HOME=...)", () => {
		expect(brokerCliCommand("login x", { ...ctx("posix", "/srv/b b"), platform: "darwin" })).toBe(
			"HOME='/srv/b b' omp auth-broker login x",
		);
	});
});

// The strings above are only worth something if the real shells read them back as the same path. Replace the omp part of
// the typed command by a program that writes the USERPROFILE it was started with, and run each form in the real shell.
describe.skipIf(process.platform !== "win32")(
	"the typed prefix, run in the real shells, hands the program exactly the path",
	() => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "ompweb-typed-")));
		afterAll(() => rmSync(dir, { recursive: true, force: true }));
		const printer = join(dir, "print.ts");
		const out = join(dir, "seen.txt");
		writeFileSync(
			printer,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, process.env.USERPROFILE ?? "(unset)");\n`,
		);
		// "%" cannot be put into cmd, and `"` cannot be in a Windows file name: everything else of AWKWARD is real.
		const home = AWKWARD;
		const bun = process.execPath;
		const CMD = Bun.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";

		// The way a user does it: the line is typed into a real ConPTY shell and Enter is pressed.
		const run = async (shell: string, typedLine: string): Promise<string> => {
			rmSync(out, { force: true });
			const terminal = await PtyTerminal.spawn({
				id: "t_typed",
				factory: nativePty,
				shell,
				cwd: dir,
				cols: 200,
				rows: 30,
				ringChars: 1 << 20,
				scrollbackLines: 10,
				name: "typed",
				env: { ...Bun.env, USERPROFILE: "C:\\not-it" },
				now: Date.now,
			});
			try {
				await Bun.sleep(1500);
				terminal.write(`${typedLine}\r`);
				await until(() => existsSync(out), 15_000, `the program ran for: ${typedLine}`);
				await Bun.sleep(100);
				return readFileSync(out, "utf8");
			} finally {
				await terminal.kill();
				terminal.dispose();
			}
		};
		const typed = (shell: CliShell): string =>
			brokerCliCommand("login x", ctx(shell, home)).replace("omp auth-broker login x", `"${bun}" "${printer}"`);

		test("cmd.exe", async () => {
			const line = typed("cmd");
			expect(await run(CMD, line)).toBe(home);
		});

		test("Windows PowerShell", async () => {
			const line = typed("powershell").replace(`"${bun}" "${printer}"`, `& "${bun}" "${printer}"`);
			const ps = `${Bun.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
			expect(await run(ps, line)).toBe(home);
		});

		const gitbash = ["C:\\Program Files\\Git\\bin\\bash.exe"].find(p => existsSync(p));
		test.skipIf(gitbash === undefined)("Git Bash", async () => {
			const line = brokerCliCommand("login x", ctx("gitbash", home)).replace(
				"omp auth-broker login x",
				`'${bun.replaceAll("\\", "/")}' '${printer.replaceAll("\\", "/")}'`,
			);
			expect(await run(gitbash!, line)).toBe(home);
		});
	},
);
