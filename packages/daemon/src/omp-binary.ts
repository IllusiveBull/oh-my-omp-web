import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";
import expectedPackage from "../../../vendor/oh-my-pi/packages/coding-agent/package.json";
import { killProcessTree } from "./proc-tree";

export interface OmpBinary {
	path: string;
	/** Parsed from `omp --version` ("omp/18.19.0"). */
	version: string;
}

/** Version of the vendored upstream tag this daemon was built and typed against. */
export const EXPECTED_OMP_VERSION: string = expectedPackage.version;

/** First omp with session ownership leases (`omp session lease`, RPC `get_session_lease`). */
export const MIN_OMP_VERSION = "18.14.1";

export class OmpStartupError extends Error {}

/** Compares dotted numeric versions ("18.14.1"); pre-release/build suffixes are ignored. Negative, 0, positive like `a - b`. */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string): number[] =>
		v
			.split(/[-+]/)[0]!
			.split(".")
			.map(n => Number.parseInt(n, 10) || 0);
	const [pa, pb] = [parts(a), parts(b)];
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** Resolves the `omp` executable (explicit path, `OMP_BIN`, or `PATH`) and reads its version. */
export async function locateOmp(explicit?: string): Promise<OmpBinary> {
	const candidate = explicit ?? Bun.env.OMP_BIN ?? Bun.which("omp");
	if (!candidate) {
		throw new OmpStartupError("`omp` not found on PATH (set OMP_BIN or --omp). omp-web does not embed the agent.");
	}
	const path = Bun.which(candidate) ?? candidate;
	let output: string;
	try {
		const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
		const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) throw new Error(`exit code ${code}`);
		output = text.trim();
	} catch (error) {
		throw new OmpStartupError(`cannot run \`${path} --version\`: ${error instanceof Error ? error.message : error}`);
	}
	const version = /(\d+\.\d+\.\d+[^\s]*)/.exec(output)?.[1];
	if (!version) throw new OmpStartupError(`cannot parse omp version from ${JSON.stringify(output)}`);
	if (compareVersions(version, MIN_OMP_VERSION) < 0) {
		throw new OmpStartupError(
			`omp ${version} is too old: omp-web needs >= ${MIN_OMP_VERSION} (session ownership leases, \`omp session lease\` / get_session_lease). Run \`omp update\`.`,
		);
	}
	return { path, version };
}

/**
 * Starts a throwaway `omp --mode rpc-ui` and checks its `ready` frame offers protocol v2 (the only one the daemon
 * speaks). Throws `OmpStartupError` otherwise. No session file is written (`--no-session`).
 */
export async function probeRpcProtocol(
	omp: OmpBinary,
	timeoutMs = 30_000,
	/**
	 * Run the probe in this agent directory with the placeholder model (`prepareAgentDir`): omp exits before its ready frame
	 * when no model has credentials, which is the state of a machine that relies on the credential broker and has not got
	 * its credentials yet.
	 */
	placeholder?: { agentDir: string; model: string },
): Promise<void> {
	const proc = Bun.spawn(
		[omp.path, "--mode", "rpc-ui", "--no-session", ...(placeholder ? ["--model", placeholder.model] : [])],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			...(placeholder ? { env: { ...Bun.env, PI_CODING_AGENT_DIR: placeholder.agentDir } } : {}),
		},
	);
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), timeoutMs);
	try {
		for await (const frame of readJsonl(proc.stdout, abort.signal)) {
			if (!isRecord(frame) || frame.type !== "ready") continue;
			const versions = frame.supportedProtocolVersions;
			if (!Array.isArray(versions) || !versions.includes(2)) {
				throw new OmpStartupError(
					`omp ${omp.version} ready frame offers no usable protocol version (supported: ${JSON.stringify(versions)}; need 2)`,
				);
			}
			return;
		}
		throw new OmpStartupError(`omp ${omp.version} exited or timed out before sending a ready frame`);
	} finally {
		clearTimeout(timer);
		if (process.platform === "win32") killProcessTree(proc.pid);
		else proc.kill();
	}
}

/** Human-readable startup warning when the installed omp differs from the vendored tag; null when equal. */
export function versionMismatch(omp: OmpBinary): string | null {
	return omp.version === EXPECTED_OMP_VERSION
		? null
		: `installed omp ${omp.version} differs from the vendored upstream ${EXPECTED_OMP_VERSION}; the rpc-ui contract may have drifted`;
}
