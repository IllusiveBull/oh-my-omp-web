// Generates public/icon-{192,512}.png, icon-maskable-512.png, apple-touch-icon.png (pure-JS PNG encoder).
// Run: bun packages/web/scripts/gen-icons.ts  (outputs are committed; rerun only when the mark changes)
import { deflateSync } from "node:zlib";
import { join } from "node:path";

const A = [0x5a, 0xd8, 0xe6]; // --accent-a
const B = [0xed, 0x4a, 0xbf]; // --accent-b

function crc32(buf: Uint8Array): number {
	let c = ~0;
	for (const b of buf) {
		c ^= b;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/** Black square with a gradient ring; `scale` is the ring's outer radius as a fraction of half the size. */
function render(size: number, scale: number): Uint8Array {
	const ss = 3; // supersampling per axis
	const raw = new Uint8Array(size * (size * 4 + 1));
	const c = size / 2;
	const outer = c * scale;
	const inner = outer * 0.58;
	for (let y = 0; y < size; y++) {
		raw[y * (size * 4 + 1)] = 0;
		for (let x = 0; x < size; x++) {
			let cover = 0;
			for (let sy = 0; sy < ss; sy++)
				for (let sx = 0; sx < ss; sx++) {
					const d = Math.hypot(x + (sx + 0.5) / ss - c, y + (sy + 0.5) / ss - c);
					if (d <= outer && d >= inner) cover++;
				}
			const a = cover / (ss * ss);
			const t = Math.min(1, Math.max(0, (x + y) / (2 * size)));
			const o = y * (size * 4 + 1) + 1 + x * 4;
			for (let i = 0; i < 3; i++) raw[o + i] = Math.round((A[i]! + (B[i]! - A[i]!) * t) * a);
			raw[o + 3] = 255;
		}
	}
	const ihdr = new Uint8Array(13);
	const dv = new DataView(ihdr.buffer);
	dv.setUint32(0, size);
	dv.setUint32(4, size);
	ihdr.set([8, 6, 0, 0, 0], 8);
	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", new Uint8Array()),
	];
	return Buffer.concat(parts);
}

const dir = join(import.meta.dir, "..", "public");
// Maskable: mark stays inside the 80% safe zone; "any" icons use more of the canvas.
await Bun.write(join(dir, "icon-192.png"), render(192, 0.78));
await Bun.write(join(dir, "icon-512.png"), render(512, 0.78));
await Bun.write(join(dir, "icon-maskable-512.png"), render(512, 0.62));
await Bun.write(join(dir, "apple-touch-icon.png"), render(180, 0.7));
