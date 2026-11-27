/**
 * The file behind one of omp's own URLs (`local://x.md`, `agent://Id`, `skill://name`, …), located by omp's own URL
 * router with the context of one session, so omp-web resolves them exactly as the session's tools do. `artifact://N`
 * (omp before 19, which replaced it with `local://N.log`) is located here: old transcripts still link to it.
 * Only {@link LOCATABLE_URL_SCHEMES}: in-process state (`proc://`), remote resources and secrets (`vault://`) are refused.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { LOCATABLE_URL_SCHEMES, type SessionInfo } from "@omp-web/protocol";
import { FileError } from "./file-path";

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]+):\/\//;
const JSONL = ".jsonl";

/** The scheme of `url` when omp-web may locate it, else null. */
export function locatableScheme(url: string): string | null {
	const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();
	return scheme !== undefined && LOCATABLE_URL_SCHEMES.includes(scheme) ? scheme : null;
}

/** omp < 19's `artifact://N`: the file `N.<anything>` in the session's own artifacts directory. */
async function locateArtifact(url: string, artifactsDir: string | null): Promise<string> {
	const id = /^artifact:\/\/(\d+)\/?$/i.exec(url)?.[1];
	if (id === undefined) throw new FileError("not_found", `${url}: artifact:// needs a numeric id`);
	if (artifactsDir === null) throw new FileError("not_found", `${url}: the session has no artifacts directory`);
	let names: string[];
	try {
		names = await readdir(artifactsDir);
	} catch {
		throw new FileError("not_found", `${url} has no file on this machine`);
	}
	const name = names.find(n => n.startsWith(`${id}.`));
	if (name === undefined) throw new FileError("not_found", `${url} has no file on this machine`);
	return join(artifactsDir, name);
}

/** Absolute path of the file or directory `url` names for `session`. Throws {@link FileError} when there is none. */
export async function locateOmpUrl(
	url: string,
	session: Pick<SessionInfo, "cwd" | "file" | "sessionId">,
): Promise<string> {
	const scheme = locatableScheme(url);
	if (scheme === null) throw new FileError("forbidden", `${url} is not a file omp-web can show`);
	const file = session.file;
	// omp's SessionManager.getArtifactsDir(): the session file without `.jsonl`.
	const artifactsDir = file?.endsWith(JSONL) ? file.slice(0, -JSONL.length) : null;
	if (scheme === "artifact") return locateArtifact(url, artifactsDir);
	let located: string | null;
	try {
		// The omp process knows its loaded skills; out of process they are discovered for the session's directory, with
		// omp's default sources (the session's own skill settings are not read).
		const skills = scheme === "skill" ? (await loadSkills({ cwd: session.cwd })).skills : undefined;
		located = await InternalUrlRouter.instance().locate(url, {
			cwd: session.cwd,
			...(file === undefined ? {} : { sessionFile: file }),
			sessionId: session.sessionId,
			...(skills === undefined ? {} : { skills }),
			localProtocolOptions: { getArtifactsDir: () => artifactsDir, getSessionId: () => session.sessionId },
		});
	} catch (error) {
		throw new FileError("not_found", error instanceof Error ? error.message : String(error));
	}
	if (located === null) throw new FileError("not_found", `${url} has no file on this machine`);
	return located;
}
