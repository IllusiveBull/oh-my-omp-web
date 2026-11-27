import { ConfigError } from "./secrets";

export interface AntigravityBinary {
	path: string;
	/** Arguments passed to launch the ACP JSON-RPC 2.0 server (default: `["acp"]`). */
	args: string[];
	/** Parsed from `<bin> --version` when available. */
	version?: string;
}

export interface LocateAntigravityOptions {
	/** Explicit binary path or command name from `--antigravity` or `config.antigravity.bin`. */
	bin?: string;
	/** Custom ACP launch arguments (default: `["acp"]`). */
	args?: string[];
	/** Explicit enable/disable switch (`false` skips auto-detection). */
	enabled?: boolean;
	env?: Record<string, string | undefined>;
}

/**
 * Locates the Antigravity CLI (`agy`) for ACP mode (`agy acp`).
 *
 * Unlike `omp`, Antigravity is optional: when neither `--antigravity` nor `config.antigravity.bin` nor `AGY_BIN` is
 * set and `agy` is absent from `PATH`, returns `null` so the daemon starts with `omp` only. When explicitly configured
 * (or `enabled: true`) and missing or unexecutable, throws {@link ConfigError}.
 */
export async function locateAntigravity(options: LocateAntigravityOptions = {}): Promise<AntigravityBinary | null> {
	if (options.enabled === false) return null;
	const env = options.env ?? Bun.env;
	const explicit = options.bin ?? env.AGY_BIN;
	const candidate = explicit ?? Bun.which("agy");
	if (!candidate) {
		if (options.enabled === true) {
			throw new ConfigError(
				"Antigravity is enabled but `agy` was not found on PATH (set AGY_BIN or --antigravity).",
			);
		}
		return null;
	}
	const path = Bun.which(candidate) ?? candidate;
	const exists = await Bun.file(path).exists();
	if (!exists) {
		if (explicit !== undefined || options.enabled === true) {
			throw new ConfigError(`Antigravity binary not found: ${candidate}`);
		}
		return null;
	}
	const args = options.args && options.args.length > 0 ? [...options.args] : ["acp"];
	const version = await probeAntigravityVersion(path);
	return { path, args, ...(version ? { version } : {}) };
}

async function probeAntigravityVersion(path: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) return undefined;
		const text = (stdout || stderr).trim();
		const semver = /(\d+\.\d+\.\d+[^\s]*)/.exec(text)?.[1];
		return semver ?? (text.split(/\r?\n/)[0]?.slice(0, 80) || undefined);
	} catch {
		return undefined;
	}
}
