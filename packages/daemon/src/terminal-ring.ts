/**
 * What a terminal's output looks like to the replay machinery: a character stream (UTF-16 code units, `string.length`)
 * with a position that only grows, and a tracker of where in the VT escape grammar the stream currently is.
 *
 * `PtySession` hands out decoded text in chunks of whatever size the pty read produced, so a chunk boundary can fall
 * inside an escape sequence (`ESC [ 3` | `8 ; 5 ; 2 m`). The live stream is unharmed by that, because the consumer's
 * parser is stateful. A replay that *starts* in the middle of a sequence is not: the leftover bytes print as text and the
 * terminal state is wrong from there on. So the ring only ever discards whole chunks, and only up to a chunk that starts
 * outside any escape sequence ("ground" state).
 */

type ScanState = "ground" | "esc" | "esc-intermediate" | "csi" | "string" | "string-esc";

/** The VT control-sequence callback: `params` are the characters between the introducer and the final byte. */
export type CsiHandler = (params: string, final: string) => void;

/**
 * Follows the escape grammar across chunks. It does not interpret anything; it only answers "is the stream between two
 * sequences right now", and optionally reports complete CSI sequences (the screen uses that to track modes that the
 * serializer does not carry).
 */
export class EscapeScanner {
	#state: ScanState = "ground";
	#csi = "";

	constructor(private readonly onCsi?: CsiHandler) {}

	get ground(): boolean {
		return this.#state === "ground";
	}

	reset(): void {
		this.#state = "ground";
		this.#csi = "";
	}

	push(data: string): void {
		let i = 0;
		const n = data.length;
		while (i < n) {
			if (this.#state === "ground") {
				const esc = data.indexOf("\x1b", i);
				if (esc === -1) return;
				this.#state = "esc";
				i = esc + 1;
				continue;
			}
			const code = data.charCodeAt(i);
			i++;
			// CAN and SUB abort any sequence; ESC starts a new one (inside a string it may start the terminator).
			if (code === 0x18 || code === 0x1a) {
				this.#state = "ground";
				continue;
			}
			switch (this.#state) {
				case "esc":
					if (code === 0x5b) {
						this.#state = "csi";
						this.#csi = "";
					} else if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
						this.#state = "string"; // OSC, DCS, SOS, PM, APC
					} else if (code >= 0x20 && code <= 0x2f) {
						this.#state = "esc-intermediate";
					} else if (code === 0x1b) {
						this.#state = "esc";
					} else {
						this.#state = "ground";
					}
					break;
				case "esc-intermediate":
					if (code >= 0x20 && code <= 0x2f) break;
					this.#state = code === 0x1b ? "esc" : "ground";
					break;
				case "csi":
					if (code === 0x1b) {
						this.#state = "esc";
					} else if (code >= 0x40 && code <= 0x7e) {
						this.#state = "ground";
						this.onCsi?.(this.#csi, String.fromCharCode(code));
					} else if (code >= 0x20 && this.#csi.length < 64) {
						this.#csi += String.fromCharCode(code);
					}
					break;
				case "string":
					if (code === 0x07) this.#state = "ground";
					else if (code === 0x1b) this.#state = "string-esc";
					break;
				case "string-esc":
					this.#state = code === 0x5c ? "ground" : code === 0x1b ? "string-esc" : "string";
					break;
			}
		}
	}
}

interface Chunk {
	/** Offset of the chunk's first character. */
	offset: number;
	data: string;
	/** The stream was outside every escape sequence at the start of this chunk. */
	ground: boolean;
}

/** Appended data is merged into the last chunk until it reaches this size (fewer, larger strings), at most a quarter of the capacity. */
const MERGE_UNTIL = 16 * 1024;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * Bounded history of one terminal's output. `start`..`head` is what a client can still be given verbatim; offsets never
 * go backwards or get reused. Memory is about `capacity` characters, plus at most the length of the escape sequence (or
 * `capacity / 2`, whichever comes first) when no chunk boundary is in ground state.
 */
export class OutputRing {
	readonly #chunks: Chunk[] = [];
	readonly #scanner = new EscapeScanner();
	readonly #mergeUntil: number;
	#head = 0;

	constructor(readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1024) throw new Error("ring capacity must be an integer >= 1024");
		this.#mergeUntil = Math.min(MERGE_UNTIL, capacity / 4);
	}

	/** Offset of the oldest retained character. */
	get start(): number {
		return this.#chunks[0]?.offset ?? this.#head;
	}

	/** Total characters ever appended: the offset the next character gets. */
	get head(): number {
		return this.#head;
	}

	/** Characters currently retained. */
	get size(): number {
		return this.#head - this.start;
	}

	append(data: string): void {
		if (data.length === 0) return;
		const last = this.#chunks.at(-1);
		if (last && last.data.length < this.#mergeUntil) {
			last.data += data;
		} else {
			this.#chunks.push({ offset: this.#head, data, ground: this.#scanner.ground });
		}
		this.#scanner.push(data);
		this.#head += data.length;
		this.#evict();
	}

	/**
	 * Up to `max` characters starting at `from` (`start <= from <= head`). Never ends between the halves of a surrogate
	 * pair, so a frame cut here is always valid text; it may end inside an escape sequence, which the receiving terminal
	 * parser carries over to the next frame.
	 */
	slice(from: number, max: number): string {
		if (from < this.start || from > this.#head)
			throw new RangeError(`offset ${from} is outside the ring (${this.start}..${this.#head})`);
		if (from === this.#head || max <= 0) return "";
		let index = this.#chunkAt(from);
		let out = "";
		let position = from;
		while (index < this.#chunks.length && out.length < max) {
			const chunk = this.#chunks[index]!;
			const begin = position - chunk.offset;
			const take = Math.min(chunk.data.length - begin, max - out.length);
			out += chunk.data.slice(begin, begin + take);
			position += take;
			index++;
		}
		if (out.length > 1 && isHighSurrogate(out.charCodeAt(out.length - 1)) && position < this.#head) {
			out = out.slice(0, -1); // the low half is the next frame's first character
		}
		return out;
	}

	/** Whether the stream is between escape sequences at the end of the data appended so far. */
	get ground(): boolean {
		return this.#scanner.ground;
	}

	/** True if `offset` is retained and the stream is outside every escape sequence there (a safe place to start from). */
	startsClean(offset: number): boolean {
		if (offset === this.start) return this.#chunks[0]?.ground ?? true;
		return this.#chunks.some(chunk => chunk.offset === offset && chunk.ground);
	}

	#chunkAt(offset: number): number {
		let lo = 0;
		let hi = this.#chunks.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this.#chunks[mid]!.offset <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	}

	/** Drops whole leading chunks while at least `capacity` characters remain, ending at a ground-state chunk start. */
	#evict(): void {
		if (this.#chunks.length < 2) return;
		let drop = 0;
		for (let k = 1; k < this.#chunks.length; k++) {
			const retained = this.#head - this.#chunks[k]!.offset;
			if (retained < this.capacity) break;
			if (this.#chunks[k]!.ground || retained >= this.capacity + this.capacity / 2) drop = k;
		}
		if (drop > 0) this.#chunks.splice(0, drop);
	}
}
