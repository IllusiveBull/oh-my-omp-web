import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { EscapeScanner, type OutputRing } from "./terminal-ring";

/** Characters handed to the emulator at once. */
const FEED_CHARS = 64 * 1024;

/**
 * The state the serializer does not carry: cursor visibility, the mouse
 * report encodings (SGR/UTF-8/urxvt/pixel: tracking is serialized, the encoding it is reported in is not) and the cursor
 * style. They are tracked from the same stream and appended to a snapshot as the sequences that set them.
 */
class ModeTracker {
	cursorHidden = false;
	readonly encodings = new Set<number>();
	cursorStyle: number | null = null;

	readonly scanner = new EscapeScanner((params, final) => {
		if ((final === "h" || final === "l") && params.startsWith("?")) {
			for (const part of params.slice(1).split(";")) {
				const mode = Number.parseInt(part, 10);
				if (mode === 25) this.cursorHidden = final === "l";
				else if (mode === 1005 || mode === 1006 || mode === 1015 || mode === 1016) {
					if (final === "h") this.encodings.add(mode);
					else this.encodings.delete(mode);
				}
			}
		} else if (final === "q" && params.endsWith(" ")) {
			this.cursorStyle = Number.parseInt(params, 10) || 0;
		} else if (final === "p" && params === "!") {
			this.#soft();
		}
	});

	reset(): void {
		this.#soft();
		this.scanner.reset();
	}

	#soft(): void {
		this.cursorHidden = false;
		this.encodings.clear();
		this.cursorStyle = null;
	}

	sequences(): string {
		let out = "";
		for (const mode of this.encodings) out += `\x1b[?${mode}h`;
		if (this.cursorStyle !== null) out += `\x1b[${this.cursorStyle} q`;
		if (this.cursorHidden) out += "\x1b[?25l";
		return out;
	}
}

export interface ScreenOptions {
	cols: number;
	rows: number;
	scrollback: number;
	/** The program set the window title (OSC 0/2). */
	onTitle?(title: string): void;
}

export interface ScreenSnapshot {
	/** Writing this into an empty terminal of `cols` x `rows` reproduces the screen, its history and its modes. */
	data: string;
	/** The snapshot is the state after exactly this many characters of output; continue the stream from here. */
	offset: number;
	cols: number;
	rows: number;
}

interface SizeEvent {
	offset: number;
	cols: number;
	rows: number;
}

/**
 * A headless xterm.js (the engine the browser runs) following one terminal's output, for reattaching clients: the
 * snapshot restores the normal and alternate screens, history, colours, cursor and the modes of whatever full-screen
 * program is running, which a replay of a ring that no longer holds the program's start cannot.
 *
 * It is fed *from the ring*, at its own pace, never from the pty callback directly. That bounds its memory (it cannot
 * queue unparsed output) and means a flood the emulator cannot keep up with only costs fidelity of the state: when the
 * ring discards output the emulator has not read yet it starts over from the ring's start (a clean boundary) instead of
 * pretending to have seen it.
 */
export class TerminalScreen {
	#term: Terminal;
	#serialize: SerializeAddon;
	#modes = new ModeTracker();
	#fed: number;
	#parsed: number;
	#busy = false;
	/** Bumped when the emulator is replaced: a write callback of the old one must not touch the new state. */
	#generation = 0;
	#disposed = false;
	readonly #sizes: SizeEvent[];
	#restarts = 0;

	constructor(
		private readonly ring: OutputRing,
		private readonly options: ScreenOptions,
	) {
		this.#fed = this.#parsed = ring.head;
		this.#sizes = [{ offset: ring.head, cols: options.cols, rows: options.rows }];
		({ term: this.#term, serialize: this.#serialize } = this.#create(options.cols, options.rows));
	}

	/** How many times the emulator had to skip ahead because the ring discarded output it had not read yet. */
	get restarts(): number {
		return this.#restarts;
	}

	/** The state corresponds to this offset (what the emulator has finished parsing). */
	get parsed(): number {
		return this.#parsed;
	}

	/** The pty was resized; applies to output from `offset` on (the ring's head at that moment). */
	noteResize(offset: number, cols: number, rows: number): void {
		this.#sizes.push({ offset, cols, rows });
		this.pump();
	}

	/** The ring grew (or the emulator has to catch up): feed what it has not read yet. */
	pump(): void {
		if (this.#disposed || this.#busy) return;
		if (this.#fed < this.ring.start) this.#restart(this.ring.start);
		this.#applySizes();
		if (this.#fed >= this.ring.head) return;
		const upcoming = this.#sizes.find(s => s.offset > this.#fed);
		const data = this.ring.slice(
			this.#fed,
			Math.min(FEED_CHARS, upcoming ? upcoming.offset - this.#fed : FEED_CHARS),
		);
		if (data === "") return;
		const generation = this.#generation;
		const end = this.#fed + data.length;
		this.#fed = end;
		this.#busy = true;
		this.#term.write(data, () => {
			if (generation !== this.#generation || this.#disposed) return;
			this.#parsed = end;
			this.#modes.scanner.push(data);
			this.#busy = false;
			this.pump();
		});
	}

	/**
	 * The screen as of `parsed`. Safe at any time: a write the emulator has not started is not part of the state, and one
	 * it has started finishes before JavaScript runs again. If the ring no longer holds `parsed` the emulator is replaced
	 * by a fresh one that starts at the ring's start, and the snapshot is of that (empty, mid-stream) state.
	 */
	snapshot(): ScreenSnapshot {
		if (this.#parsed < this.ring.start) this.#restart(this.ring.start);
		return {
			data: this.#serialize.serialize() + this.#modes.sequences(),
			offset: this.#parsed,
			cols: this.#term.cols,
			rows: this.#term.rows,
		};
	}

	/** Lines of the active buffer as text, for tests and diagnostics. */
	text(): string[] {
		const buffer = this.#term.buffer.active;
		const lines: string[] = [];
		for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
		return lines;
	}

	dispose(): void {
		this.#disposed = true;
		this.#term.dispose();
	}

	#create(cols: number, rows: number): { term: Terminal; serialize: SerializeAddon } {
		const term = new Terminal({ cols, rows, scrollback: this.options.scrollback, allowProposedApi: true });
		const serialize = new SerializeAddon();
		// The browser's xterm uses Unicode 11 widths (emoji, CJK); a snapshot only lines up when both sides agree.
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = "11";
		term.loadAddon(serialize);
		term.onTitleChange(title => this.options.onTitle?.(title));
		return { term, serialize };
	}

	/** The size in force at `offset`: the last event at or before it. */
	#sizeAt(offset: number): SizeEvent {
		let found = this.#sizes[0]!;
		for (const event of this.#sizes) if (event.offset <= offset) found = event;
		return found;
	}

	#applySizes(): void {
		const current = this.#sizeAt(this.#fed);
		if (current.cols !== this.#term.cols || current.rows !== this.#term.rows)
			this.#term.resize(current.cols, current.rows);
		// Events before the emulator's position are history; keep the one in force.
		const keep = this.#sizes.findLastIndex(s => s.offset <= this.#fed);
		if (keep > 0) this.#sizes.splice(0, keep);
	}

	#restart(offset: number): void {
		this.#restarts++;
		this.#generation++;
		this.#term.dispose();
		const size = this.#sizeAt(offset);
		({ term: this.#term, serialize: this.#serialize } = this.#create(size.cols, size.rows));
		this.#fed = this.#parsed = offset;
		this.#busy = false;
		this.#modes.reset();
	}
}
