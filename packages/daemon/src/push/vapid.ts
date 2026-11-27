import type { webcrypto } from "node:crypto";
import { join } from "node:path";
import { ConfigError, readSecret, writeSecret } from "../secrets";
import { toBase64Url } from "./encrypt";

/** A JWT lives at most 24 h (RFC 8292 §2); stay clear of the limit so clock skew cannot push it over. */
const JWT_LIFETIME_SECONDS = 12 * 60 * 60 - 5 * 60;

const ES256: webcrypto.EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };

/** The gateway's application-server identity: it signs the `Authorization` of every push request. */
export interface VapidKeys {
	privateKey: CryptoKey;
	/** Uncompressed P-256 point, base64url: the browser's `applicationServerKey`. */
	publicKey: string;
}

interface StoredVapid {
	privateJwk: webcrypto.JsonWebKey;
	publicKey: string;
}

function publicPoint(jwk: webcrypto.JsonWebKey): string {
	if (jwk.x === undefined || jwk.y === undefined) throw new Error("not an EC key");
	return toBase64Url(
		Buffer.concat([Uint8Array.of(0x04), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]),
	);
}

const importSigningKey = (jwk: webcrypto.JsonWebKey): Promise<CryptoKey> =>
	crypto.subtle.importKey("jwk", jwk, ES256, false, ["sign"]);

/** The VAPID keys in `<configDir>/vapid.json`; generated (mode 0600) on first use. Refuses a file other users can read. */
export async function loadVapid(configDir: string): Promise<VapidKeys> {
	const file = join(configDir, "vapid.json");
	const text = await readSecret(file);
	if (text === null) {
		const pair = await crypto.subtle.generateKey(ES256, true, ["sign", "verify"]);
		const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
		const publicKey = publicPoint(privateJwk);
		await writeSecret(file, `${JSON.stringify({ privateJwk, publicKey } satisfies StoredVapid, null, "\t")}\n`);
		return { privateKey: await importSigningKey(privateJwk), publicKey };
	}
	try {
		const stored = JSON.parse(text) as Partial<StoredVapid>;
		if (stored.privateJwk === undefined || stored.publicKey !== publicPoint(stored.privateJwk)) {
			throw new Error("the private key and the public key do not match");
		}
		return { privateKey: await importSigningKey(stored.privateJwk), publicKey: stored.publicKey };
	} catch (error) {
		throw new ConfigError(
			`${file} is not a valid VAPID key file: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

const encodeJson = (value: object): string => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * The `Authorization` header for a push request to a push service at `audience` (the endpoint's origin):
 * `vapid t=<JWT>, k=<public key>` (RFC 8292). `now` is in milliseconds.
 */
export async function vapidHeaders(
	keys: VapidKeys,
	audience: string,
	subject: string,
	now = Date.now(),
): Promise<string> {
	const claims = { aud: audience, exp: Math.floor(now / 1000) + JWT_LIFETIME_SECONDS, sub: subject };
	const signingInput = `${encodeJson({ typ: "JWT", alg: "ES256" })}.${encodeJson(claims)}`;
	// WebCrypto's ECDSA signature is already the raw r||s form JWS wants.
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		keys.privateKey,
		new TextEncoder().encode(signingInput),
	);
	return `vapid t=${signingInput}.${toBase64Url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}
