import { describe, expect, test } from "bun:test";
import {
	decryptPayload,
	encryptPayload,
	type Bytes,
	fromBase64Url,
	generateSubscriptionKeys,
	toBase64Url,
} from "../src/push/encrypt";

const bytes = (text: string): Bytes => {
	const decoded = fromBase64Url(text);
	if (decoded === null) throw new Error(`bad base64url: ${text}`);
	return decoded;
};

// RFC 8291 §5 and Appendix A: the example message, with its keys, salt and the resulting body.
const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
	receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
	receiverPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	senderPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	body:
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
		"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/** The key pair of an uncompressed public point and its private scalar. */
async function importPair(publicPoint: string, privateScalar: string): Promise<CryptoKeyPair> {
	const point = bytes(publicPoint);
	const jwk = {
		kty: "EC",
		crv: "P-256",
		x: toBase64Url(point.subarray(1, 33)),
		y: toBase64Url(point.subarray(33, 65)),
	};
	return {
		publicKey: await crypto.subtle.importKey("jwk", jwk, ECDH, true, []),
		privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d: privateScalar }, ECDH, false, ["deriveBits"]),
	};
}

describe("RFC 8291 example", () => {
	test("encrypting the example message with the example keys and salt yields exactly the example body", async () => {
		const sender = await importPair(RFC.senderPublic, RFC.senderPrivate);
		const body = await encryptPayload(
			{ p256dh: RFC.receiverPublic, auth: RFC.authSecret },
			new TextEncoder().encode(RFC.plaintext),
			{ serverKeys: sender, salt: bytes(RFC.salt) },
		);
		expect(toBase64Url(body)).toBe(RFC.body);
	});

	test("the receiver of the example decrypts the example body to the example message", async () => {
		const receiver = await importPair(RFC.receiverPublic, RFC.receiverPrivate);
		const plain = await decryptPayload(bytes(RFC.body), {
			privateKey: receiver.privateKey,
			publicKey: bytes(RFC.receiverPublic),
			auth: bytes(RFC.authSecret),
		});
		expect(new TextDecoder().decode(plain)).toBe(RFC.plaintext);
	});
});

describe("encryptPayload", () => {
	test("a fresh message round-trips, uses a new salt and sender key each time, and announces the 4096-byte record size", async () => {
		const device = await generateSubscriptionKeys();
		const plaintext = new TextEncoder().encode(JSON.stringify({ type: "clear", thread: "t1", note: "héllo ✓" }));
		const a = await encryptPayload(device, plaintext);
		const b = await encryptPayload(device, plaintext);
		expect(a).not.toEqual(b);
		expect(a.subarray(0, 16)).not.toEqual(b.subarray(0, 16));
		expect(new DataView(a.buffer, a.byteOffset).getUint32(16)).toBe(4096);
		expect(a[20]).toBe(65);
		expect(a.length).toBe(86 + plaintext.length + 1 + 16);
		const receiver = { privateKey: device.privateKey, publicKey: device.publicKey, auth: device.authSecret };
		expect(await decryptPayload(a, receiver)).toEqual(plaintext);
		expect(await decryptPayload(b, receiver)).toEqual(plaintext);
	});

	test("an empty payload and one filling the record exactly both work; one byte more is refused", async () => {
		const device = await generateSubscriptionKeys();
		const receiver = { privateKey: device.privateKey, publicKey: device.publicKey, auth: device.authSecret };
		expect(await decryptPayload(await encryptPayload(device, new Uint8Array()), receiver)).toEqual(new Uint8Array());
		const fits = new Uint8Array(4096 - 17).fill(0x61);
		// the record fits, but with the 86-byte header the body exceeds what push services accept
		await expect(encryptPayload(device, fits)).rejects.toThrow("too large");
		const small = new Uint8Array(100 - 17).fill(0x61);
		const body = await encryptPayload(device, small, { recordSize: 100 });
		expect(body.length).toBe(86 + 100);
		expect(await decryptPayload(body, receiver)).toEqual(small);
		await expect(encryptPayload(device, new Uint8Array(100 - 16), { recordSize: 100 })).rejects.toThrow("one record");
	});

	test("a payload ending in zero bytes survives the padding delimiter", async () => {
		const device = await generateSubscriptionKeys();
		const receiver = { privateKey: device.privateKey, publicKey: device.publicKey, auth: device.authSecret };
		const plaintext = Uint8Array.of(1, 0, 0, 0);
		expect(await decryptPayload(await encryptPayload(device, plaintext), receiver)).toEqual(plaintext);
	});

	test("a tampered body, a wrong auth secret and another device's key all fail to decrypt", async () => {
		const device = await generateSubscriptionKeys();
		const other = await generateSubscriptionKeys();
		const receiver = { privateKey: device.privateKey, publicKey: device.publicKey, auth: device.authSecret };
		const body = await encryptPayload(device, new TextEncoder().encode("secret"));
		for (const index of [0, 21, 86, body.length - 1]) {
			const tampered = body.slice();
			tampered[index] = tampered[index]! ^ 0x01;
			await expect(decryptPayload(tampered, receiver)).rejects.toThrow();
		}
		await expect(decryptPayload(body, { ...receiver, auth: other.authSecret })).rejects.toThrow();
		await expect(
			decryptPayload(body, { privateKey: other.privateKey, publicKey: other.publicKey, auth: device.authSecret }),
		).rejects.toThrow();
		await expect(decryptPayload(body.subarray(0, 40), receiver)).rejects.toThrow("malformed");
		// a record size smaller than the record means the body holds several records, which this receiver does not read
		const split = body.slice();
		new DataView(split.buffer).setUint32(16, 20);
		await expect(decryptPayload(split, receiver)).rejects.toThrow("more than one record");
	});

	test("subscription keys that are not a P-256 point or a 16-byte secret are refused", async () => {
		const device = await generateSubscriptionKeys();
		const plain = new Uint8Array(1);
		await expect(encryptPayload({ p256dh: "AAAA", auth: device.auth }, plain)).rejects.toThrow("uncompressed");
		await expect(encryptPayload({ p256dh: device.p256dh, auth: "AAAA" }, plain)).rejects.toThrow("16 bytes");
		await expect(encryptPayload({ p256dh: "not base64!", auth: device.auth }, plain)).rejects.toThrow("uncompressed");
		await expect(encryptPayload(device, plain, { salt: new Uint8Array(8) })).rejects.toThrow("salt");
		await expect(encryptPayload(device, plain, { recordSize: 10 })).rejects.toThrow("record size");
	});
});

describe("generateSubscriptionKeys", () => {
	test("returns an uncompressed point and a 16-byte auth secret in both raw and base64url form", async () => {
		const keys = await generateSubscriptionKeys();
		expect(keys.publicKey.length).toBe(65);
		expect(keys.publicKey[0]).toBe(0x04);
		expect(keys.authSecret.length).toBe(16);
		expect(bytes(keys.p256dh)).toEqual(keys.publicKey);
		expect(bytes(keys.auth)).toEqual(keys.authSecret);
	});
});
