import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chmod, mkdir, open, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { aclProblem, ensureSecureDir, fixCommand, restrictPath } from "./file-acl";

/** A configuration problem the operator has to fix; the CLI prints the message and exits. */
export class ConfigError extends Error {}

/** Shortest gateway token accepted on a non-loopback bind (a generated one is 43 characters). */
export const MIN_TOKEN_LENGTH = 32;

const POSIX = process.platform !== "win32";

/** What "private" means on this platform, for messages: mode 600 on POSIX, an ACL on Windows. */
export const OWNER_ONLY: string = POSIX ? "mode 600" : "access restricted to you, SYSTEM and Administrators";

/** How to make `file` private by hand, for messages. */
export const makePrivateHint = (file: string): string => (POSIX ? `chmod 600 ${file}` : fixCommand(file));

/** Creates `dir` (and missing parents) for this user only: mode 700, or on Windows a protected ACL that children inherit. An existing directory is left as it is. */
export async function mkdirPrivate(dir: string): Promise<void> {
	if (POSIX) await mkdir(dir, { recursive: true, mode: 0o700 });
	else ensureSecureDir(dir);
}

/** {@link mkdirPrivate} for the synchronous opener of the database. */
export function mkdirPrivateSync(dir: string): void {
	if (POSIX) mkdirSync(dir, { recursive: true, mode: 0o700 });
	else ensureSecureDir(dir);
}

/**
 * Creates `file` (and its directory) readable by this user only; replaces it atomically. The temporary file is created
 * empty and restricted *before* the content is written, and the rename keeps its descriptor (measured), so the content is
 * never visible under a broader ACL. POSIX: mode 600. Windows: see `file-acl.ts`.
 */
export async function writeSecret(file: string, content: string): Promise<void> {
	await mkdirPrivate(dirname(file));
	const tmp = `${file}.${process.pid}.tmp`;
	if (POSIX) {
		await Bun.write(tmp, content);
		await chmod(tmp, 0o600); // the file mode of Bun.write follows the umask
	} else {
		await (await open(tmp, "w")).close();
		restrictPath(tmp);
		await Bun.write(tmp, content); // writing into the existing file keeps its descriptor
	}
	await rename(tmp, file);
}

/**
 * Reads a secret file; null when it does not exist. Refuses a file other users can read: POSIX by mode, Windows by the
 * ACL (any ALLOW ACE with a read-capable right for a trustee besides this user, SYSTEM and Administrators, inherited or
 * not; a NULL DACL; or an ACL that cannot be inspected).
 */
export async function readSecret(file: string): Promise<string | null> {
	const info = await stat(file).catch(() => null);
	if (info === null) return null;
	if (POSIX) {
		if ((info.mode & 0o077) !== 0) {
			throw new ConfigError(
				`${file} is readable by other users (mode ${(info.mode & 0o777).toString(8)}); run: ${makePrivateHint(file)}`,
			);
		}
	} else {
		const problem = aclProblem(file);
		if (problem !== null) throw new ConfigError(problem);
	}
	return (await Bun.file(file).text()).trim();
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** Constant-time comparison: both sides are hashed first so the length of the secret does not leak either. */
export function secretsEqual(a: string, b: string): boolean {
	const ha = createHash("sha256").update(a).digest();
	const hb = createHash("sha256").update(b).digest();
	return timingSafeEqual(ha, hb);
}

/** The gateway's single-user token (`file`); generated on first run. */
export async function loadToken(file: string): Promise<{ token: string; created: boolean }> {
	const existing = await readSecret(file);
	if (existing !== null) {
		if (existing === "") throw new ConfigError(`${file} is empty; delete it to generate a new token`);
		return { token: existing, created: false };
	}
	const token = randomToken();
	await writeSecret(file, `${token}\n`);
	return { token, created: true };
}

const LOOPBACK = /^(localhost|\[?::1\]?|127(\.\d{1,3}){3})$/i;
export const isLoopback = (host: string): boolean => LOOPBACK.test(host);

/** Binding beyond loopback exposes the login page to the network: only with a token that cannot be guessed. */
export function assertBindAllowed(bind: string, token: string): void {
	if (isLoopback(bind) || token.length >= MIN_TOKEN_LENGTH) return;
	throw new ConfigError(
		`refusing to bind ${bind}: the gateway token is shorter than ${MIN_TOKEN_LENGTH} characters. Delete the token file to generate a strong one, or bind 127.0.0.1.`,
	);
}

// ---------------------------------------------------------------------------
// Per-machine pre-shared keys (gateway <-> env registration)
// ---------------------------------------------------------------------------

export interface MachineKey {
	name: string;
	key: string;
}

/** `machine-keys.json` on the gateway: machine id -> display name + pre-shared key. Read fresh on every use. */
export class MachineKeys {
	constructor(private readonly file: string) {}

	async list(): Promise<Record<string, MachineKey>> {
		const text = await readSecret(this.file);
		if (text === null || text === "") return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new ConfigError(`${this.file} is not valid JSON`);
		}
		const machines = (parsed as { machines?: Record<string, MachineKey> }).machines;
		if (typeof machines !== "object" || machines === null)
			throw new ConfigError(`${this.file} has no "machines" object`);
		return machines;
	}

	async get(id: string): Promise<MachineKey | undefined> {
		const machines = await this.list();
		return Object.hasOwn(machines, id) ? machines[id] : undefined;
	}

	async add(name: string): Promise<{ id: string; key: string }> {
		const machines = await this.list();
		if (Object.values(machines).some(m => m.name === name))
			throw new ConfigError(`a machine named "${name}" already exists`);
		const id = `m_${randomBytes(6).toString("hex")}`;
		const key = randomToken();
		machines[id] = { name, key };
		await this.#save(machines);
		return { id, key };
	}

	async remove(id: string): Promise<boolean> {
		const machines = await this.list();
		if (!Object.hasOwn(machines, id)) return false;
		delete machines[id];
		await this.#save(machines);
		return true;
	}

	async #save(machines: Record<string, MachineKey>): Promise<void> {
		await writeSecret(this.file, `${JSON.stringify({ machines }, null, "\t")}\n`);
	}
}

/** What an env daemon needs to register: `<machine id>:<key>` in one line (the id has no colon). */
export const formatCredential = (id: string, key: string): string => `${id}:${key}`;

export function parseCredential(text: string, file: string): { id: string; key: string } {
	const split = text.indexOf(":");
	if (split <= 0 || split === text.length - 1) {
		throw new ConfigError(`${file} must contain "<machine id>:<key>" (from \`omp-webd machine add\`)`);
	}
	return { id: text.slice(0, split), key: text.slice(split + 1) };
}

// ---------------------------------------------------------------------------
// Registration proof
// ---------------------------------------------------------------------------

/**
 * HMAC proving knowledge of the pre-shared key without sending it (the link may run over plain `ws://` inside the
 * tailnet). Both directions are proved, with a different `role`, so a captured env proof cannot be replayed as the gateway's.
 * `acceptsBroker` (whether the daemon takes the credential broker's token over this link) is covered by both: a party on
 * the path that flips it makes the gateway's check of the daemon's proof fail, before any token is sent.
 */
export function linkProof(
	key: string,
	role: "env" | "gateway",
	nonce: string,
	cnonce: string,
	machineId: string,
	acceptsBroker: boolean,
): string {
	return createHmac("sha256", key)
		.update([role, nonce, cnonce, machineId, acceptsBroker ? "broker" : "no-broker"].join("\0"))
		.digest("hex");
}
