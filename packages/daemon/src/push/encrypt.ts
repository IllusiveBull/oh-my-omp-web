/**
 * Web Push message encryption: RFC 8291 key agreement on top of the RFC 8188 `aes128gcm` content coding, with
 * WebCrypto only. Every message is one record: `salt(16) | rs(4, BE) | idlen(1) | keyid(=sender public key) | record`.
 */

import type { webcrypto } from "node:crypto";

/** The byte arrays WebCrypto accepts: backed by a plain `ArrayBuffer`, not a shared one. */
export type Bytes = Uint8Array<ArrayBuffer>;

const SALT_LENGTH = 16;
const TAG_LENGTH = 16;
const POINT_LENGTH = 65;
const AUTH_LENGTH = 16;
/** Smallest record the coding allows: the delimiter byte plus the AES-GCM tag. */
const MIN_RECORD = 1 + TAG_LENGTH;
/** What every push service must accept as a body (RFC 8030 §7.2); also the default and largest record size. */
export const MAX_PUSH_BODY = 4096;
const DELIMITER = 0x02;
const KEY_INFO_PREFIX = new TextEncoder().encode("WebPush: info\0");
const CEK_INFO = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
const NONCE_INFO = new TextEncoder().encode("Content-Encoding: nonce\0");

const ECDH: webcrypto.EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };

export const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** Decodes unpadded base64url; null for anything else (the `Buffer` decoder would silently skip bad characters). */
export function fromBase64Url(text: string): Bytes | null {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
	return new Uint8Array(Buffer.from(text, "base64url"));
}

function concat(...parts: Uint8Array[]): Bytes {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const importPoint = (point: Bytes): Promise<CryptoKey> => crypto.subtle.importKey("raw", point, ECDH, false, []);

async function hkdf(secret: Bytes, salt: Bytes, info: Bytes, bits: number): Promise<Bytes> {
	const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}

/** The content encryption key and nonce both sides derive from the ECDH secret, the auth secret and the header's salt. */
async function deriveKeys(
	privateKey: CryptoKey,
	peerPublic: Bytes,
	uaPublic: Bytes,
	asPublic: Bytes,
	auth: Bytes,
	salt: Bytes,
): Promise<{ cek: CryptoKey; nonce: Bytes }> {
	const ecdh = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "ECDH", public: await importPoint(peerPublic) }, privateKey, 256),
	);
	const ikm = await hkdf(ecdh, auth, concat(KEY_INFO_PREFIX, uaPublic, asPublic), 256);
	const cek = await crypto.subtle.importKey("raw", await hkdf(ikm, salt, CEK_INFO, 128), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
	return { cek, nonce: await hkdf(ikm, salt, NONCE_INFO, 96) };
}

export interface EncryptOptions {
	/** The sender's ECDH key pair; fresh per message by default (tests pin it). */
	serverKeys?: CryptoKeyPair;
	/** 16 random bytes by default (tests pin it). */
	salt?: Bytes;
	/** The record size announced in the header; 4096 by default. */
	recordSize?: number;
}

/** Encrypts `plaintext` for the push subscription `{p256dh, auth}` (both base64url, as `PushSubscription.toJSON()` has them) into a request body. */
export async function encryptPayload(
	subscription: { p256dh: string; auth: string },
	plaintext: Uint8Array,
	options: EncryptOptions = {},
): Promise<Bytes> {
	const uaPublic = fromBase64Url(subscription.p256dh);
	const auth = fromBase64Url(subscription.auth);
	if (uaPublic?.length !== POINT_LENGTH || uaPublic[0] !== 0x04)
		throw new Error("subscription key is not an uncompressed P-256 point");
	if (auth?.length !== AUTH_LENGTH) throw new Error("subscription auth secret must be 16 bytes");
	const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
	if (salt.length !== SALT_LENGTH) throw new Error("salt must be 16 bytes");
	const recordSize = options.recordSize ?? MAX_PUSH_BODY;
	if (!Number.isInteger(recordSize) || recordSize < MIN_RECORD || recordSize > MAX_PUSH_BODY) {
		throw new Error(`record size must be an integer from ${MIN_RECORD} to ${MAX_PUSH_BODY}`);
	}
	if (plaintext.length + MIN_RECORD > recordSize) throw new Error("payload does not fit in one record");

	const serverKeys = options.serverKeys ?? (await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]));
	const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
	const { cek, nonce } = await deriveKeys(serverKeys.privateKey, uaPublic, uaPublic, asPublic, auth, salt);

	const record = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cek, concat(plaintext, Uint8Array.of(DELIMITER))),
	);
	const header = new Uint8Array(SALT_LENGTH + 4 + 1 + asPublic.length);
	header.set(salt);
	new DataView(header.buffer).setUint32(SALT_LENGTH, recordSize);
	header[SALT_LENGTH + 4] = asPublic.length;
	header.set(asPublic, SALT_LENGTH + 5);
	const body = concat(header, record);
	if (body.length > MAX_PUSH_BODY) throw new Error("payload too large for a push message");
	return body;
}

export interface Receiver {
	privateKey: CryptoKey;
	/** The uncompressed public point the subscription advertised. */
	publicKey: Bytes;
	auth: Bytes;
}

/** Reverses `encryptPayload` (a single-record body): for tests and smoke checks; browsers do this themselves. */
export async function decryptPayload(body: Bytes, receiver: Receiver): Promise<Bytes> {
	if (body.length < SALT_LENGTH + 5) throw new Error("truncated header");
	const salt = body.subarray(0, SALT_LENGTH);
	const recordSize = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(SALT_LENGTH);
	const idLength = body[SALT_LENGTH + 4]!;
	const start = SALT_LENGTH + 5 + idLength;
	if (idLength !== POINT_LENGTH || body.length < start + MIN_RECORD) throw new Error("malformed header");
	const record = body.subarray(start);
	if (recordSize < MIN_RECORD || record.length > recordSize) throw new Error("more than one record");
	const asPublic = body.subarray(SALT_LENGTH + 5, start);
	const { cek, nonce } = await deriveKeys(
		receiver.privateKey,
		asPublic,
		receiver.publicKey,
		asPublic,
		receiver.auth,
		salt,
	);
	const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cek, record));
	let end = padded.length;
	while (end > 0 && padded[end - 1] === 0) end--;
	if (end === 0 || padded[end - 1] !== DELIMITER) throw new Error("missing padding delimiter");
	return padded.slice(0, end - 1);
}

export interface SubscriptionKeys {
	/** The subscription's public key, base64url (what `PushSubscription.toJSON().keys.p256dh` holds). */
	p256dh: string;
	/** The subscription's auth secret, base64url. */
	auth: string;
	privateKey: CryptoKey;
	publicKey: Bytes;
	authSecret: Bytes;
}

/** A receiver's subscription key pair and auth secret, as a browser would make them. */
export async function generateSubscriptionKeys(): Promise<SubscriptionKeys> {
	const pair = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
	const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	const authSecret = crypto.getRandomValues(new Uint8Array(AUTH_LENGTH));
	return {
		p256dh: toBase64Url(publicKey),
		auth: toBase64Url(authSecret),
		privateKey: pair.privateKey,
		publicKey,
		authSecret,
	};
}
