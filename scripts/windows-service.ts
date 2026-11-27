import { dlopen } from "bun:ffi";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSecret } from "../packages/daemon/src/secrets";

interface ServiceConfig {
	bun: string;
	omp: string;
	repo: string;
	configDir: string;
	stateDir: string;
	args: string[];
	home?: string;
	environmentFile?: string;
}

if (process.platform !== "win32") throw new Error("Windows service runner requires Windows");
const configFile = process.argv[2];
if (!configFile) throw new Error("service configuration path is required");
const config = JSON.parse((await Bun.file(configFile).text()).replace(/^\uFEFF/, "")) as ServiceConfig;
mkdirSync(config.stateDir, { recursive: true });
const statusFile = join(config.stateDir, "windows-service-status.json");
const runnerStartedAt = Date.now();
const logFile = join(config.stateDir, "windows-service.log");
const maxLogBytes = 5 * 1024 * 1024;
function log(text: string): void {
	if (existsSync(logFile) && statSync(logFile).size >= maxLogBytes) {
		renameSync(logFile, `${logFile}.1`);
	}
	appendFileSync(logFile, text);
}
function status(phase: string, daemonPid: number | null, restarts: number, exitCode: number | null): void {
	writeFileSync(
		`${statusFile}.tmp`,
		JSON.stringify({
			runnerPid: process.pid,
			runnerStartedAt,
			daemonPid,
			phase,
			restarts,
			exitCode,
			updatedAt: new Date().toISOString(),
		}),
	);
	renameSync(`${statusFile}.tmp`, statusFile);
}

// Job handle is non-inheritable (null SECURITY_ATTRIBUTES). Assign the runner before creating any child.
const kernel = dlopen("kernel32.dll", {
	CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
	SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
	AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
	GetCurrentProcess: { args: [], returns: "ptr" },
	GetLastError: { args: [], returns: "u32" },
	OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
	WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
});
const jobName = `Local\\omp-web-${crypto.randomUUID()}`;
const job = kernel.symbols.CreateJobObjectW(null, Buffer.from(`${jobName}\0`, "utf16le"));
if (!job) throw new Error(`CreateJobObjectW failed: ${kernel.symbols.GetLastError()}`);
const limits = new Uint8Array(144);
new DataView(limits.buffer).setUint32(16, 0x2000, true);
if (!kernel.symbols.SetInformationJobObject(job, 9, limits, limits.byteLength)) {
	throw new Error(`SetInformationJobObject failed: ${kernel.symbols.GetLastError()}`);
}
if (!kernel.symbols.AssignProcessToJobObject(job, kernel.symbols.GetCurrentProcess())) {
	throw new Error(`AssignProcessToJobObject failed: ${kernel.symbols.GetLastError()}`);
}
// Headless conhost may die without delivering a console event. Hold its process handle so PID reuse cannot hide a stop.
const parent = kernel.symbols.OpenProcess(0x100000, 0, process.ppid);
if (!parent) throw new Error(`OpenProcess(parent) failed: ${kernel.symbols.GetLastError()}`);
setInterval(() => {
	if (kernel.symbols.WaitForSingleObject(parent, 0) !== 258) process.exit(0);
}, 250);
// Scheduler closes conhost's console. Bun delivers SIGHUP but does not exit the loop by itself.
// Exiting releases our sole job handle and hard-stops every descendant.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
	process.on(signal, () => process.exit(0));
}

const daemon = join(config.repo, "packages", "daemon", "src", "index.ts");
let restarts = 0;
let delay = 1000;
for (;;) {
	status("starting", null, restarts, null);
	const started = Date.now();
	try {
		const env = { ...process.env };
		env.OMP_WEB_SERVICE_JOB = jobName;
		if (config.home) {
			env.HOME = config.home;
			env.USERPROFILE = config.home;
			env.APPDATA = join(config.home, "AppData", "Roaming");
			env.LOCALAPPDATA = join(config.home, "AppData", "Local");
		}
		if (config.environmentFile) {
			const content = await readSecret(config.environmentFile);
			if (content === null) throw new Error("environment file is missing");
			let additions: unknown;
			try {
				additions = JSON.parse(content);
			} catch {
				throw new Error("environment file is not valid JSON");
			}
			if (!additions || typeof additions !== "object" || Array.isArray(additions))
				throw new Error("environment file must be an object");
			for (const [key, value] of Object.entries(additions)) {
				if (typeof value !== "string") throw new Error("environment values must be strings");
				env[key] = value;
			}
		}
		const child = Bun.spawn(
			[
				config.bun,
				daemon,
				"--config-dir",
				config.configDir,
				"--state-dir",
				config.stateDir,
				"--omp",
				config.omp,
				...config.args,
			],
			{
				cwd: config.repo,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		status("running", child.pid, restarts, null);
		log(`${new Date().toISOString()} daemon started pid=${child.pid}\n`);
		const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let pending = "";
			let redactNext = false;
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				pending += decoder.decode(value, { stream: true });
				let newline: number;
				while ((newline = pending.indexOf("\n")) >= 0) {
					const line = pending.slice(0, newline + 1);
					pending = pending.slice(newline + 1);
					if (redactNext) {
						redactNext = false;
						continue;
					}
					if (line.includes("generated the gateway token (shown once")) redactNext = true;
					log(line);
				}
			}
			if (pending && !redactNext) log(pending);
		};
		const drains = Promise.all([drain(child.stdout), drain(child.stderr)]);
		const code = await child.exited;
		await drains;
		status("restarting", null, ++restarts, code);
		log(`${new Date().toISOString()} daemon exited code=${code}; restarting in ${delay}ms\n`);
	} catch (error) {
		status("restarting", null, ++restarts, null);
		log(
			`${new Date().toISOString()} daemon launch failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
	if (Date.now() - started >= 60_000) delay = 1000;
	await Bun.sleep(delay);
	delay = Math.min(delay * 2, 30_000);
}
