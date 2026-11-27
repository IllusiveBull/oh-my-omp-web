import { afterEach, describe, expect, test, vi } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PtyTerminal,
	nativePty,
	resolveShell,
	scrubbedNames,
	shellEnvAdditions,
	shellKindOf,
	shellLaunch,
	shellName,
	type ShellSources,
} from "../src/pty-host";
import { Process } from "@oh-my-pi/pi-natives";
import { killProcessTree } from "../src/proc-tree";
import { fakePtyFactory, until } from "./terminal-fixtures";

const win = process.platform === "win32";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});

const tmp = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ompweb-pty-")));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

async function shell(cwd = tmp(), cols = 100, rows = 30): Promise<PtyTerminal> {
	const terminal = await PtyTerminal.spawn({
		id: "t_test",
		factory: nativePty,
		shell: "/bin/sh",
		cwd,
		cols,
		rows,
		ringChars: 1 << 20,
		scrollbackLines: 200,
		name: "sh",
		env: { ...Bun.env, HOME: cwd, ENV: "" },
		now: Date.now,
	});
	cleanups.push(() => terminal.kill().then(() => terminal.dispose()));
	return terminal;
}

const text = (t: PtyTerminal): string => t.ring.slice(t.ring.start, Number.MAX_SAFE_INTEGER);
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("initial input waits past ConPTY control-only startup for visible prompt output", async () => {
	vi.useFakeTimers();
	try {
		const { factory, ptys } = fakePtyFactory();
		const t = await PtyTerminal.spawn({
			id: "t_startup",
			factory,
			shell: "pwsh.exe",
			cwd: tmp(),
			cols: 100,
			rows: 30,
			ringChars: 4096,
			scrollbackLines: 10,
			name: "pwsh",
			env: {},
			now: Date.now,
			initialInput: "$env:USERPROFILE = 'C:\\隔离 home'; omp auth-broker login zai",
		});
		cleanups.push(() => t.kill().then(() => t.dispose()));
		ptys[0]!.emit("\x1b[6n\x1b]0;PowerShell\x07\x1b[?9001h\x1b[8;30;100t\x1b[K\r\n\x1b[H");
		vi.advanceTimersByTime(250);
		expect(ptys[0]!.written).toEqual([]);
		ptys[0]!.emit("PS C:\\隔离 home> ");
		vi.advanceTimersByTime(150);
		expect(ptys[0]!.written).toEqual(["$env:USERPROFILE = 'C:\\隔离 home'; omp auth-broker login zai"]);
	} finally {
		vi.useRealTimers();
	}
});

describe("what the shell's environment is", () => {
	// POSIX: `env -u` + /bin/sh; real Windows shell coverage is in the ConPTY suite below.
	test.skipIf(win)(
		"the daemon's own credentials and its host terminal's identity are not inherited by a real shell",
		async () => {
			const secrets = {
				OMP_AUTH_BROKER_TOKEN: "broker-token-SENTINEL",
				OMP_AUTH_BROKER_URL: "http://broker-SENTINEL",
				OMP_WEB_BROKER_PROBE_MS: "7",
				OMP_WEB_FUTURE_SETTING: "x-SENTINEL",
				TERM_PROGRAM: "ghostty-SENTINEL",
				TERMINFO: "/nowhere-SENTINEL",
				TMUX: "/tmp/tmux-SENTINEL,1,0",
				GHOSTTY_RESOURCES_DIR: "/ghostty-SENTINEL",
				ITERM_SESSION_ID: "iterm-SENTINEL",
				// ordinary user variables must survive
				MY_OWN_SETTING: "kept",
			};
			const home = tmp();
			const probe = Bun.spawn(["bun", join(import.meta.dir, "fixtures/pty-probe.ts"), "/bin/sh", home], {
				env: { ...Bun.env, HOME: home, ENV: "", ...secrets },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text()]);
			await probe.exited;
			expect(err).toBe("");
			const { env } = JSON.parse(out.trim().split("\n").at(-1)!) as { env: Record<string, string> };
			const all = JSON.stringify(env);
			expect(all).not.toContain("SENTINEL");
			for (const name of Object.keys(secrets).filter(n => n !== "MY_OWN_SETTING")) expect(env[name]).toBeUndefined();
			expect(env.MY_OWN_SETTING).toBe("kept");
			expect(env.TERM).toBe("xterm-256color");
			expect(env.COLORTERM).toBe("truecolor");
			expect(env.HOME).toBe(home);
			expect(env.PATH).toBeTruthy();
			expect(env.LANG ?? env.LC_ALL ?? env.LC_CTYPE).toMatch(/UTF-?8/i);
		},
	);

	test("the removal is by name: no value of the environment appears in the command line the shell was started with", () => {
		const env = { OMP_AUTH_BROKER_TOKEN: "very-secret", PATH: "/usr/bin", TERM_PROGRAM: "x" };
		const launch = shellLaunch("/bin/zsh", env, "darwin");
		expect(launch.application).toBe("/usr/bin/env");
		expect(launch.args).toEqual(["-u", "OMP_AUTH_BROKER_TOKEN", "-u", "TERM_PROGRAM", "/bin/zsh", "-l"]);
		expect(launch.args.join(" ")).not.toContain("very-secret");
		expect(scrubbedNames(env)).toEqual(["OMP_AUTH_BROKER_TOKEN", "TERM_PROGRAM"]);
	});

	test('Windows: no `env`; the arguments follow the kind of shell, and the scrubbed names are overridden with "" (never a value)', () => {
		const env = {
			OMP_AUTH_BROKER_TOKEN: "very-secret",
			omp_web_probe_ms: "7",
			Path: "C:\\x",
			TERM_PROGRAM: "x",
			WT_SESSION: "y",
		};
		expect(shellLaunch("C:\\Windows\\System32\\cmd.exe", env, "win32")).toEqual({
			application: "C:\\Windows\\System32\\cmd.exe",
			args: [],
		});
		expect(shellLaunch("C:\\Program Files\\PowerShell\\7\\pwsh.exe", env, "win32").args).toEqual(["-NoLogo"]);
		expect(shellLaunch("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", env, "win32").args).toEqual([
			"-NoLogo",
		]);
		expect(shellLaunch("C:\\Program Files\\Git\\bin\\bash.exe", env, "win32").args).toEqual(["-l", "-i"]);
		expect(shellLaunch("C:\\Program Files\\Git\\usr\\bin\\SH.EXE", env, "win32").args).toEqual(["-l", "-i"]);
		const additions = shellEnvAdditions(env, "win32");
		expect(additions).toEqual({
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			OMP_AUTH_BROKER_TOKEN: "",
			omp_web_probe_ms: "", // environment names are case-insensitive on Windows: this is OMP_WEB_*
			TERM_PROGRAM: "",
			WT_SESSION: "",
		});
		expect(JSON.stringify(additions)).not.toContain("very-secret");
		expect(additions.LANG).toBeUndefined(); // ConPTY shells are UTF-8 (code page 65001) without a locale
		expect(additions.Path).toBeUndefined(); // ordinary variables are inherited, not touched
	});

	test("shellKindOf", () => {
		expect(shellKindOf("C:\\Windows\\System32\\cmd.exe", "win32")).toBe("cmd");
		expect(shellKindOf("C:/Program Files/PowerShell/7/pwsh.exe", "win32")).toBe("powershell");
		expect(shellKindOf("powershell.exe", "win32")).toBe("powershell");
		expect(shellKindOf("C:\\Program Files\\Git\\bin\\bash.exe", "win32")).toBe("gitbash");
		expect(shellKindOf("C:\\tools\\nu.exe", "win32")).toBe("cmd"); // unknown: no arguments, cmd quoting
		expect(shellKindOf("/bin/zsh", "darwin")).toBe("posix");
	});

	test("a UTF-8 locale is added only when the daemon has none", () => {
		expect(shellEnvAdditions({ LANG: "de_DE.UTF-8" }, "linux").LANG).toBeUndefined();
		expect(shellEnvAdditions({}, "darwin").LANG).toBe("en_US.UTF-8");
		expect(shellEnvAdditions({ LANG: "C" }, "linux").LANG).toBe("C.UTF-8");
		expect(shellEnvAdditions({}, "linux")).toMatchObject({ TERM: "xterm-256color", COLORTERM: "truecolor" });
	});
});

describe("which shell", () => {
	const sources = (over: Partial<ShellSources> = {}): ShellSources => ({
		account: () => "/bin/account-shell",
		env: { SHELL: "/bin/env-shell" },
		platform: "linux",
		executable: path =>
			["/bin/account-shell", "/bin/env-shell", "/bin/sh", "/bin/zsh", "/bin/configured"].includes(path),
		...over,
	});

	test("configured, else the account database's login shell, else $SHELL, else a platform default", () => {
		expect(resolveShell("/bin/configured", sources())).toBe("/bin/configured");
		expect(resolveShell(undefined, sources())).toBe("/bin/account-shell");
		expect(resolveShell(undefined, sources({ account: () => null }))).toBe("/bin/env-shell");
		expect(resolveShell(undefined, sources({ account: () => null, env: {} }))).toBe("/bin/sh");
		expect(resolveShell(undefined, sources({ account: () => null, env: {}, platform: "darwin" }))).toBe("/bin/zsh");
	});

	test("a candidate that cannot be run (or is relative) is skipped, and no shell at all is an error naming the setting", () => {
		expect(resolveShell("/bin/missing", sources())).toBe("/bin/account-shell");
		expect(resolveShell("zsh", sources())).toBe("/bin/account-shell");
		expect(() => resolveShell(undefined, sources({ executable: () => false }))).toThrow(/terminal\.shell/);
	});

	test.skipIf(win)("the real account database yields a runnable shell on this machine", () => {
		expect(resolveShell(undefined).startsWith("/")).toBe(true);
	});

	describe("Windows (pure rules; the sources are faked, so these run on every platform)", () => {
		const env = { SystemRoot: "C:\\WINDOWS", COMSPEC: "C:\\WINDOWS\\system32\\cmd.exe" };
		const PWSH = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe";
		const PS5 = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
		const present = (files: string[], onPath: Record<string, string> = {}): ShellSources => ({
			account: () => {
				throw new Error("the account database is a POSIX thing");
			},
			env,
			platform: "win32",
			executable: path => files.includes(path),
			which: name => onPath[name.toLowerCase()] ?? null,
		});

		test("default: pwsh if it is on PATH, else Windows PowerShell, else COMSPEC, else cmd.exe under SystemRoot", () => {
			expect(resolveShell(undefined, present([PS5, env.COMSPEC], { "pwsh.exe": PWSH }))).toBe(PWSH);
			expect(resolveShell(undefined, present([PS5, env.COMSPEC]))).toBe(PS5);
			expect(resolveShell(undefined, present([env.COMSPEC]))).toBe(env.COMSPEC);
			expect(resolveShell(undefined, present(["C:\\WINDOWS\\System32\\cmd.exe"]))).toBe(
				"C:\\WINDOWS\\System32\\cmd.exe",
			);
			expect(() => resolveShell(undefined, present([]))).toThrow(/no usable shell.*terminal\.shell/);
		});

		test("service default is system PowerShell; packaged pwsh is refused without overriding explicit settings", () => {
			const service = {
				...present([PWSH, PS5, env.COMSPEC], { "pwsh.exe": PWSH }),
				env: { ...env, OMP_WEB_SERVICE_JOB: "service-job" },
			};
			expect(resolveShell(undefined, service)).toBe(PS5);
			expect(resolveShell(env.COMSPEC, service)).toBe(env.COMSPEC);
			expect(() => resolveShell(PWSH, service)).toThrow(/Packaged\/AppX pwsh.*children escape/);
			expect(() => resolveShell("pwsh.exe", service)).toThrow(/Packaged\/AppX pwsh/);
			const installed = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
			expect(resolveShell(installed, { ...service, executable: path => path === installed })).toBe(installed);
		});

		test("a configured shell wins, by absolute path or by name on PATH; Git Bash only when configured", () => {
			const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
			expect(resolveShell(bash, present([bash, PS5]))).toBe(bash);
			expect(resolveShell("bash", present([PS5], { bash }))).toBe(bash);
			expect(resolveShell(undefined, present([bash, PS5]))).toBe(PS5); // installed is not enough
		});

		test("a configured shell that cannot be resolved is an error naming it and the setting, never a fallback", () => {
			expect(() => resolveShell("C:\\nope\\sh.exe", present([PS5, env.COMSPEC]))).toThrow(
				/terminal\.shell "C:\\nope\\sh\.exe" cannot be run/,
			);
			expect(() => resolveShell("nu", present([PS5]))).toThrow(/neither an existing file nor a program on PATH/);
			expect(() => resolveShell("/bin/sh", present([PS5]))).toThrow(/cannot be run/); // not a Windows path
		});
	});

	test.skipIf(!win)("Windows, this machine: the default resolves to an existing absolute path", () => {
		const shell = resolveShell(undefined);
		expect(/^[A-Za-z]:\\/.test(shell)).toBe(true);
		expect(lstatSync(shell).isFile() || lstatSync(shell).isSymbolicLink()).toBe(true);
		expect(() => resolveShell("C:\\definitely\\not\\a\\shell.exe")).toThrow(/cannot be run/);
	});

	test("labels", () => {
		expect(shellName("/bin/zsh")).toBe("zsh");
		expect(shellName("C:\\x\\pwsh.exe".replaceAll("\\", "/"))).toBe("pwsh");
	});
});

describe.skipIf(win)("a real shell on a pty", () => {
	test("runs in the cwd it was given, echoes input, round-trips CJK and emoji", async () => {
		const cwd = tmp();
		const t = await shell(cwd);
		t.write("pwd; printf '%s\\n' '你好 😀 é'\r");
		await until(() => text(t).includes("你好 😀 é\r\n"), 5000, "unicode output");
		expect(text(t)).toContain(`${cwd}\r\n`);
		expect(t.info.state).toBe("running");
		expect(t.info.pid).toBeGreaterThan(0);
	});

	test("resize reaches the pty (stty), is clamped to 20–400 x 5–200, and is recorded in the size timeline", async () => {
		const t = await shell(tmp(), 100, 30);
		await until(() => t.ring.head > 0, 5000, "the first prompt"); // sizes are recorded at the output offset they take effect
		expect(t.resize(120, 40)).toBe(true);
		t.write("stty size\r");
		await until(() => text(t).includes("40 120\r\n"), 5000, "stty 40 120");
		expect(t.resize(5, 1)).toBe(true);
		expect([t.info.cols, t.info.rows]).toEqual([20, 5]);
		expect(t.resize(20, 5)).toBe(false); // unchanged
		expect(t.resize(9999, 9999)).toBe(true);
		expect([t.info.cols, t.info.rows]).toEqual([400, 200]);
		expect(t.sizes.map(s => [s.cols, s.rows])).toEqual([
			[100, 30],
			[120, 40],
			[20, 5],
			[400, 200],
		]);
	});

	test("exit: the code is reported, the state flips, and the output and screen stay readable", async () => {
		const t = await shell();
		t.write("echo before-exit; exit 7\r");
		await until(() => t.info.state === "exited", 5000, "exit");
		expect(t.info.exit).toMatchObject({ code: 7, killed: false });
		expect(text(t)).toContain("before-exit");
		const snapshot = t.screen.snapshot();
		expect(snapshot.data).toContain("before-exit");
		t.write("ignored\r"); // no throw
		expect(t.resize(50, 10)).toBe(false);
	});

	test("kill ends the shell and the program it runs (the whole process group), and says it was killed", async () => {
		const t = await shell();
		t.write("sleep 600 & echo CHILD=$(jobs -p); sleep 601\r");
		await until(() => /CHILD=\d+/.test(text(t)), 5000, "child pid");
		const child = Number(/CHILD=(\d+)/.exec(text(t))![1]);
		const shellPid = t.info.pid!;
		expect(alive(child) && alive(shellPid)).toBe(true);
		await t.kill();
		expect(t.info.state).toBe("exited");
		expect(t.info.exit?.killed).toBe(true);
		await until(() => !alive(child) && !alive(shellPid), 4000, "processes gone");
	});

	test("a shell that ignores the hangup is killed by the daemon after the grace period", async () => {
		const t = await shell();
		t.write("trap '' HUP TERM; echo ready; while true; do sleep 1; done\r");
		await until(() => text(t).includes("ready\r\n"), 5000, "ready");
		const pid = t.info.pid!;
		await t.kill();
		await until(() => !alive(pid), 6000, "stubborn shell gone");
		expect(t.info.state).toBe("exited");
	}, 12_000);

	test("a shell that cannot be executed leaves a terminal that says why and exited 127, not a hung or half-made one", async () => {
		const t = await PtyTerminal.spawn({
			id: "t_bad",
			factory: nativePty,
			shell: "/definitely/not/a/shell",
			cwd: tmp(),
			cols: 80,
			rows: 24,
			ringChars: 4096,
			scrollbackLines: 10,
			name: "x",
			env: Bun.env,
			now: Date.now,
		});
		cleanups.push(() => t.dispose());
		await until(() => t.info.state === "exited", 5000, "exit");
		expect(t.info.exit?.code).toBe(127);
		expect(text(t)).toContain("/definitely/not/a/shell");
	});

	test("text typed before the shell is ready is kept and shown, not run (initialInput)", async () => {
		const cwd = tmp();
		const t = await PtyTerminal.spawn({
			id: "t_pre",
			factory: nativePty,
			shell: "/bin/sh",
			cwd,
			cols: 100,
			rows: 30,
			ringChars: 1 << 20,
			scrollbackLines: 50,
			name: "sh",
			env: { ...Bun.env, HOME: cwd, ENV: "" },
			now: Date.now,
			initialInput: "echo PRETYPED-MARKER-$((40+2))",
		});
		cleanups.push(() => t.kill().then(() => t.dispose()));
		await Bun.sleep(600);
		// the tty echoed the typed text (it is on the line), but nothing ran: the arithmetic was not evaluated
		expect(text(t)).toContain("echo PRETYPED-MARKER-$((40+2))");
		expect(text(t)).not.toContain("PRETYPED-MARKER-42");
		t.write("\r");
		await until(() => text(t).includes("PRETYPED-MARKER-42"), 5000, "executed after Enter");
	});
});

// ConPTY (Windows): the same PtyTerminal over cmd.exe (explicitly: the default is pwsh / PowerShell now).
const CMD = Bun.env.ComSpec ?? Bun.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe";
const POWERSHELL = `${Bun.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const GITBASH = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find(p =>
	existsSync(p),
);
/** Every descendant of `pid` (children, grandchildren …) as the native process handle sees them now. */
function descendants(pid: number): number[] {
	const out: number[] = [];
	const walk = (p: Process): void => {
		for (const child of p.children()) {
			out.push(child.pid);
			walk(child);
		}
	};
	const root = Process.fromPid(pid);
	if (root) walk(root);
	return out;
}

describe.skipIf(!win)("a real shell on ConPTY", () => {
	const cmdShell = async (cwd = tmp(), cols = 100, rows = 30): Promise<PtyTerminal> => {
		const terminal = await PtyTerminal.spawn({
			id: "t_conpty",
			factory: nativePty,
			shell: CMD,
			cwd,
			cols,
			rows,
			ringChars: 1 << 20,
			scrollbackLines: 200,
			name: "cmd",
			env: { ...Bun.env },
			now: Date.now,
		});
		cleanups.push(() => terminal.kill().then(() => terminal.dispose()));
		return terminal;
	};

	test("a missing service job refuses startup with a clear error", async () => {
		const before = Bun.env.OMP_WEB_SERVICE_JOB;
		Bun.env.OMP_WEB_SERVICE_JOB = `Local\\omp-web-missing-${crypto.randomUUID()}`;
		try {
			const error = await cmdShell().then(
				() => null,
				(error: unknown) => error,
			);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toContain("cannot open the Windows service job");
		} finally {
			if (before === undefined) delete Bun.env.OMP_WEB_SERVICE_JOB;
			else Bun.env.OMP_WEB_SERVICE_JOB = before;
		}
	});

	test("runs in the cwd it was given, echoes input, round-trips CJK and emoji", async () => {
		const cwd = tmp();
		const t = await cmdShell(cwd);
		t.write("echo 你好 😀 é\r");
		await until(() => text(t).includes("你好 😀 é\r\n"), 8000, "unicode output");
		t.write("cd\r");
		await until(() => text(t).toLowerCase().includes(cwd.toLowerCase()), 5000, "cwd"); // ConPTY draws with cursor moves, no \r\n
		expect(t.info.state).toBe("running");
		expect(t.info.pid).toBeGreaterThan(0);
	});

	test("resize reaches the console (PowerShell-free: `mode con`), is clamped, and is recorded in the size timeline", async () => {
		const t = await cmdShell(tmp(), 100, 30);
		await until(() => t.ring.head > 0, 8000, "the first prompt");
		expect(t.resize(120, 40)).toBe(true);
		t.write("mode con\r");
		await until(() => /Columns:\s+120/.test(text(t)) && /Lines:\s+40/.test(text(t)), 8000, "mode con 120x40");
		expect(t.resize(5, 1)).toBe(true);
		expect([t.info.cols, t.info.rows]).toEqual([20, 5]);
		expect(t.resize(9999, 9999)).toBe(true);
		expect([t.info.cols, t.info.rows]).toEqual([400, 200]);
	});

	test("exit: the code is reported, the state flips, and the output stays readable", async () => {
		const t = await cmdShell();
		t.write("echo before-exit & exit 7\r");
		await until(() => t.info.state === "exited", 8000, "exit");
		expect(t.info.exit).toMatchObject({ code: 7, killed: false });
		expect(text(t)).toContain("before-exit");
	});

	test("Ctrl-C (a ^C byte) stops the program in the foreground, not the shell", async () => {
		const t = await cmdShell();
		t.write("ping -n 60 127.0.0.1 > nul\r");
		await Bun.sleep(1500);
		t.write("\x03");
		t.write("echo AFTER-CTRL-C\r");
		await until(() => text(t).includes("AFTER-CTRL-C\r\n"), 8000, "the shell is back");
		expect(t.info.state).toBe("running");
	});

	test("kill ends the shell and the program it runs, and says it was killed", async () => {
		const t = await cmdShell();
		t.write("ping -n 600 127.0.0.1 > nul\r");
		await Bun.sleep(1500);
		const shellPid = t.info.pid!;
		expect(alive(shellPid)).toBe(true);
		await t.kill();
		expect(t.info.state).toBe("exited");
		expect(t.info.exit?.killed).toBe(true);
		await until(() => !alive(shellPid), 4000, "shell gone");
	});

	// Real shells, started the way the daemon starts them (PtyTerminal.spawn -> shellLaunch + shellEnvAdditions), in a child
	// process whose environment holds the daemon's secrets (fixtures/pty-probe.ts prints what the shell sees).
	const shells: [string, string | undefined][] = [
		["cmd.exe", CMD],
		["powershell.exe", POWERSHELL],
		["bash.exe (Git for Windows)", GITBASH],
	];
	for (const [name, shell] of shells) {
		test.skipIf(shell === undefined)(
			`${name}: the daemon's credentials and wiring are not readable with a value; ordinary variables and TERM are`,
			async () => {
				const probe = Bun.spawn(["bun", join(import.meta.dir, "fixtures/pty-probe.ts"), shell!, tmp()], {
					env: {
						...Bun.env,
						OMP_AUTH_BROKER_TOKEN: "broker-token-SENTINEL",
						OMP_AUTH_BROKER_URL: "http://broker-SENTINEL",
						OMP_WEB_FUTURE_SETTING: "x-SENTINEL",
						omp_web_lower_case: "lower-SENTINEL",
						TERM_PROGRAM: "ghostty-SENTINEL",
						MY_OWN_SETTING: "kept",
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const out = await new Response(probe.stdout).text();
				await probe.exited;
				expect(out.trim()).not.toBe("");
				const { env } = JSON.parse(out.trim().split("\n").at(-1)!) as { env: Record<string, string> };
				expect(JSON.stringify(env)).not.toContain("SENTINEL"); // nothing carries a value (unset, or set-but-empty in Git Bash)
				for (const secret of [
					"OMP_AUTH_BROKER_TOKEN",
					"OMP_AUTH_BROKER_URL",
					"OMP_WEB_FUTURE_SETTING",
					"omp_web_lower_case",
					"TERM_PROGRAM",
				]) {
					const seen = Object.entries(env).find(([k]) => k.toUpperCase() === secret.toUpperCase());
					expect([secret, seen?.[1] ?? ""]).toEqual([secret, ""]);
				}
				expect(env.MY_OWN_SETTING).toBe("kept");
				expect(env.TERM).toBe("xterm-256color");
			},
			20_000,
		);
	}

	test("kill ends a grandchild too (shell -> cmd /c -> ping -t): nothing survives, checked by pid", async () => {
		const t = await cmdShell();
		t.write("cmd /c ping -t 127.0.0.1 > nul\r");
		const shellPid = t.info.pid!;
		let tree: number[] = [];
		await until(
			() => {
				tree = descendants(shellPid);
				return tree.length >= 2; // cmd /c and ping (conhost is not a descendant of the shell)
			},
			8000,
			"grandchild running",
		);
		await t.kill();
		await until(() => ![shellPid, ...tree].some(alive), 5000, `all of ${[shellPid, ...tree]} gone`);
	});

	test("killProcessTree (the escalation after the grace period) ends a root and all its descendants", async () => {
		const root = Bun.spawn(["cmd", "/c", "cmd /c ping -t 127.0.0.1 > nul"], { stdout: "ignore", stderr: "ignore" });
		let tree: number[] = [];
		await until(
			() => {
				tree = descendants(root.pid);
				return tree.length >= 2;
			},
			8000,
			"tree running",
		);
		killProcessTree(root.pid);
		await root.exited;
		await until(() => !tree.some(alive), 5000, `descendants ${tree} gone`);
	});

	test("a shell that cannot be started: PtyTerminal.spawn rejects (TerminalService turns that into a clear error)", async () => {
		const rejected = await PtyTerminal.spawn({
			id: "t_missing",
			factory: nativePty,
			shell: "C:\\definitely\\not\\a\\shell.exe",
			cwd: tmp(),
			cols: 80,
			rows: 24,
			ringChars: 4096,
			scrollbackLines: 10,
			name: "x",
			env: Bun.env,
			now: Date.now,
		}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(rejected).toBeInstanceOf(Error);
		expect(String((rejected as Error).message)).toContain("shell.exe");
	});
});
