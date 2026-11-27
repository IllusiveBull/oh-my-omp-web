/**
 * Windows' equivalent of mode 0600 for the secret files (token, machine-keys.json, credential, vapid.json, gateway.db) and of
 * 0700 for the directories the daemon creates. POSIX modes mean nothing there (`stat().mode` is always 0o666, `chmod` only
 * toggles the read-only attribute); the access control list is what counts.
 *
 * Mechanism, all through `icacls.exe` (no elevation, no FFI):
 * - restrict: `icacls <path> /inheritance:r /grant:r *<own SID>:F *S-1-5-18:F *S-1-5-32-544:F` (directories: `(OI)(CI)F`, so
 *   what is created inside inherits it). SIDs, not account names, so it works in every Windows language.
 * - inspect: `icacls <path> /save <tmp>` writes the DACL as SDDL (UTF-16LE, no BOM): SIDs and rights in a form that can be
 *   parsed without locale-dependent text.
 *
 * "Too permissive" = the DACL has an ALLOW ACE (explicit or inherited) granting any read-capable right to a trustee other
 * than the owner-of-the-process SID, SYSTEM (S-1-5-18) and BUILTIN\Administrators (S-1-5-32-544); a NULL DACL counts too.
 * Not checked: the owner of the object (an owner can rewrite the DACL), deny ACEs (they grant nothing), and ACEs that are
 * inherit-only (they do not apply to the object itself).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SID_SYSTEM = "S-1-5-18";
export const SID_ADMINISTRATORS = "S-1-5-32-544";

/** SDDL trustee aliases that can appear in `icacls /save` output, as SIDs (the rest are printed as full SIDs). */
const ALIASES: Record<string, string> = {
	SY: SID_SYSTEM,
	BA: SID_ADMINISTRATORS,
	WD: "S-1-1-0",
	BU: "S-1-5-32-545",
	BG: "S-1-5-32-546",
	PU: "S-1-5-32-547",
	AU: "S-1-5-11",
	IU: "S-1-5-4",
	NU: "S-1-5-2",
	SU: "S-1-5-6",
	AN: "S-1-5-7",
	LS: "S-1-5-19",
	NS: "S-1-5-20",
	CO: "S-1-3-0",
	OW: "S-1-3-4",
};
const NAMES: Record<string, string> = {
	"S-1-1-0": "Everyone",
	"S-1-5-32-545": "BUILTIN\\Users",
	"S-1-5-11": "Authenticated Users",
	"S-1-5-4": "INTERACTIVE",
	"S-1-5-2": "NETWORK",
	"S-1-5-6": "SERVICE",
	"S-1-5-7": "ANONYMOUS LOGON",
	"S-1-5-32-546": "BUILTIN\\Guests",
	"S-1-5-32-547": "BUILTIN\\Power Users",
	"S-1-3-4": "OWNER RIGHTS",
};
const describeSid = (sid: string): string => (NAMES[sid] ? `${sid} (${NAMES[sid]})` : sid);

/** Rights that let a trustee read the content (file data / directory listing) or everything. */
const READ_MASK =
	0x1 /* FILE_READ_DATA, FILE_LIST_DIRECTORY */ | 0x80000000 /* GENERIC_READ */ | 0x10000000; /* GENERIC_ALL */
const RIGHT_SYMBOLS: Record<string, number> = {
	GA: 0x10000000,
	GR: 0x80000000,
	GW: 0x40000000,
	GX: 0x20000000,
	FA: 0x1f01ff,
	FR: 0x120089,
	FW: 0x120116,
	FX: 0x1200a0,
	RC: 0x20000,
	SD: 0x10000,
	WD: 0x40000,
	WO: 0x80000,
};
const ALL_BITS = 0xffffffff;

/** The access mask of an SDDL rights field: hex, or 2-letter symbols. An unknown symbol counts as "everything" (conservative). */
export function rightsMask(rights: string): number {
	if (/^0x[0-9a-f]+$/i.test(rights)) return Number.parseInt(rights.slice(2), 16) >>> 0;
	if (rights === "") return 0;
	if (rights.length % 2 !== 0) return ALL_BITS;
	let mask = 0;
	for (let i = 0; i < rights.length; i += 2) {
		const bits = RIGHT_SYMBOLS[rights.slice(i, i + 2)];
		if (bits === undefined) return ALL_BITS;
		mask |= bits;
	}
	return mask >>> 0;
}

export interface Ace {
	type: string;
	flags: string;
	mask: number;
	/** A full SID (aliases resolved). */
	sid: string;
}

export interface Dacl {
	/** `D:NO_ACCESS_CONTROL`: everybody may do everything. */
	isNull: boolean;
	aces: Ace[];
}

/** The DACL out of the text `icacls /save` wrote (first line is the object's name, then `D:...`). Throws when there is none. */
export function parseDacl(text: string): Dacl {
	const start = text.search(/(^|\n)D:/);
	if (start < 0) throw new Error("no DACL in the saved security descriptor");
	let body = text.slice(text.indexOf("D:", start) + 2);
	const end = body.search(/\r?\n/);
	if (end >= 0) body = body.slice(0, end);
	body = body.replace(/S:.*$/, ""); // a SACL, if any, is not ours
	const open = body.indexOf("(");
	const flags = open < 0 ? body : body.slice(0, open);
	if (flags.includes("NO_ACCESS_CONTROL")) return { isNull: true, aces: [] };
	const aces: Ace[] = [];
	let depth = 0;
	let from = -1;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === "(") {
			if (depth++ === 0) from = i + 1;
		} else if (c === ")" && --depth === 0) {
			const fields = body.slice(from, i).split(";");
			const trustee = fields[5] ?? "";
			aces.push({
				type: fields[0] ?? "",
				flags: fields[1] ?? "",
				mask: rightsMask(fields[2] ?? ""),
				sid: ALIASES[trustee] ?? trustee,
			});
		}
	}
	return { isNull: false, aces };
}

/** Allow-type ACE kinds: allow, object allow, conditional allow, callback allow. */
const ALLOW = new Set(["A", "OA", "XA", "ZA"]);

/** The SIDs, besides this user, SYSTEM and Administrators, that an ALLOW ACE lets read the object. */
export function readerSids(dacl: Dacl, ownSid: string): string[] {
	const allowed = new Set([ownSid, SID_SYSTEM, SID_ADMINISTRATORS]);
	const seen = new Set<string>();
	for (const ace of dacl.aces) {
		if (!ALLOW.has(ace.type) || ace.flags.includes("IO") || (ace.mask & READ_MASK) === 0) continue;
		if (!allowed.has(ace.sid)) seen.add(ace.sid);
	}
	return [...seen];
}

/** The trustees (as `SID (name)`) that would be able to read the object, or `["NULL DACL (everyone)"]`; empty when it is private. */
export function readersBeyond(dacl: Dacl, ownSid: string): string[] {
	if (dacl.isNull) return ["NULL DACL (everyone)"];
	return readerSids(dacl, ownSid).map(describeSid);
}

// ---------------------------------------------------------------------------
// The process side (icacls.exe). Synchronous on purpose: ~8 ms each (measured), used at startup and on a secret's read.
// ---------------------------------------------------------------------------

export class AclError extends Error {}

function icacls(args: string[]): string {
	const run = (): { code: number | null; text: string; out: string } => {
		const done = Bun.spawnSync(["icacls", ...args], { stdout: "pipe", stderr: "pipe" });
		return {
			code: done.exitCode,
			out: done.stdout.toString(),
			text: `${done.stdout.toString()}${done.stderr.toString()}`,
		};
	};
	let result: { code: number | null; text: string; out: string };
	try {
		result = run();
	} catch (error) {
		throw new AclError(`cannot run icacls: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (result.code !== 0) {
		const output = result.text.trim().split(/\r?\n/).slice(0, 2).join(" ");
		throw new AclError(`icacls ${args[0] ? `"${args[0]}" ` : ""}failed (exit ${result.code}): ${output}`);
	}
	return result.out;
}

let cachedSid: string | undefined;
/** The SID of the user this process runs as (`whoami /user`), once. */
export function ownSid(): string {
	if (cachedSid !== undefined) return cachedSid;
	let out: string;
	try {
		out = Bun.spawnSync(["whoami", "/user", "/fo", "csv", "/nh"], {
			stdout: "pipe",
			stderr: "pipe",
		}).stdout.toString();
	} catch (error) {
		throw new AclError(`cannot run whoami: ${error instanceof Error ? error.message : String(error)}`);
	}
	const sid = /"(S-1-[0-9-]+)"\s*$/.exec(out.trim())?.[1];
	if (sid === undefined)
		throw new AclError(`cannot read this account's SID from whoami (${JSON.stringify(out.trim())})`);
	cachedSid = sid;
	return sid;
}

/** The three-trustee grant list, `suffix` being the inheritance flags for directories. */
const grants = (suffix: string): string[] => [
	`*${ownSid()}:${suffix}F`,
	`*${SID_SYSTEM}:${suffix}F`,
	`*${SID_ADMINISTRATORS}:${suffix}F`,
];

/**
 * The command that makes `path` private, as the user would type it. `/inheritance:r` drops every inherited ACE and `/grant:r`
 * sets the three; an *explicit* ACE for somebody else survives both, so the offenders found are removed by name
 * (`/remove:g`, which takes SIDs).
 */
export function fixCommand(path: string, directory = false, offenders: readonly string[] = []): string {
	const remove = offenders.length > 0 ? ` /remove:g ${offenders.map(sid => `*${sid}`).join(" ")}` : "";
	return `icacls "${path}" /inheritance:r /grant:r ${grants(directory ? "(OI)(CI)" : "").join(" ")}${remove}`;
}

/** Removes inherited ACEs and leaves full control to this user, SYSTEM and Administrators only. */
export function restrictPath(path: string, directory = false): void {
	icacls([path, "/inheritance:r", "/grant:r", ...grants(directory ? "(OI)(CI)" : "")]);
}

/** The DACL of `path` as `icacls /save` reports it. */
export function readDacl(path: string): Dacl {
	const dir = mkdtempSync(join(tmpdir(), "ompweb-acl-"));
	try {
		const out = join(dir, "dacl.txt");
		icacls([path, "/save", out]);
		return parseDacl(
			readFileSync(out)
				.toString("utf16le")
				.replace(/^\uFEFF/, ""),
		);
	} catch (error) {
		if (error instanceof AclError) throw error;
		throw new AclError(
			`cannot read the access list of ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Why `path` may not be used as a secret, or null when only this user (and SYSTEM, Administrators) can read it. */
export function aclProblem(path: string): string | null {
	let readers: string[];
	let sids: string[];
	try {
		const dacl = readDacl(path);
		const own = ownSid();
		readers = readersBeyond(dacl, own);
		sids = readerSids(dacl, own);
	} catch (error) {
		let hint: string;
		try {
			hint = fixCommand(path);
		} catch {
			hint = "identify this account's SID and restrict the file with icacls";
		}
		return `${path}: cannot check who can read it (${error instanceof Error ? error.message : String(error)}); refusing to use it. Make sure icacls.exe works, or fix the file by hand: ${hint}`;
	}
	if (readers.length === 0) return null;
	return `${path} can be read by ${readers.join(", ")}; run: ${fixCommand(path, false, sids)}`;
}

/**
 * Creates `dir` and any missing parent, each with a protected DACL (full control for this user, SYSTEM, Administrators,
 * inherited by everything created inside). A directory that already exists is never touched.
 */
export function ensureSecureDir(dir: string): void {
	const missing: string[] = [];
	let at = resolve(dir);
	while (!existsSync(at)) {
		missing.push(at);
		const up = dirname(at);
		if (up === at) break;
		at = up;
	}
	for (const path of missing.reverse()) {
		try {
			mkdirSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			continue; // someone else made it meanwhile: theirs to protect
		}
		restrictPath(path, true);
	}
}
