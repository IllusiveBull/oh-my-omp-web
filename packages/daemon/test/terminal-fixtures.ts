import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import type { TerminalEnvFrame } from "@omp-web/protocol";
import type { PtyFactory, PtyLaunch, PtyOutcome, PtyProcess } from "../src/pty-host";
import type { TerminalSocket } from "../src/terminal-service";

/** A pty that does nothing but what the test tells it to: output on demand, exit on demand. */
export class FakePty implements PtyProcess {
	readonly written: string[] = [];
	readonly resizes: { cols: number; rows: number }[] = [];
	killed = 0;
	#onData: (chunk: string) => void;
	readonly #finish: (outcome: PtyOutcome) => void;
	readonly exited: Promise<PtyOutcome>;

	constructor(
		readonly launch: PtyLaunch,
		onData: (chunk: string) => void,
		readonly pid: number,
	) {
		this.#onData = onData;
		const { promise, resolve } = Promise.withResolvers<PtyOutcome>();
		this.exited = promise;
		this.#finish = resolve;
	}

	emit(chunk: string): void {
		this.#onData(chunk);
	}

	exit(code: number | null, cancelled = false): void {
		this.#finish({ exitCode: code, cancelled });
	}

	write(data: string): void {
		this.written.push(data);
	}

	resize(cols: number, rows: number): void {
		this.resizes.push({ cols, rows });
	}

	kill(): void {
		this.killed++;
		this.exit(null, true);
	}
}

export function fakePtyFactory(): { factory: PtyFactory; ptys: FakePty[] } {
	const ptys: FakePty[] = [];
	return {
		ptys,
		factory: async (launch, onData) => {
			const pty = new FakePty(launch, onData, 4000 + ptys.length);
			ptys.push(pty);
			return pty;
		},
	};
}

/** A client's connection: frames it was sent, parsed, and whether the gateway holds it back. */
export class TestSocket implements TerminalSocket {
	readonly frames: TerminalEnvFrame[] = [];
	readonly raw: string[] = [];
	paused = false;

	sendPriority(frame: string): void {
		this.raw.push(frame);
		this.frames.push(JSON.parse(frame) as TerminalEnvFrame);
	}

	isPaused(): boolean {
		return this.paused;
	}

	/** Frames of one kind (and terminal) since the start. */
	of<T extends TerminalEnvFrame["t"]>(t: T, id?: string): Extract<TerminalEnvFrame, { t: T }>[] {
		return this.frames.filter(f => f.t === t && (id === undefined || ("id" in f && f.id === id))) as Extract<
			TerminalEnvFrame,
			{ t: T }
		>[];
	}
}

/** What the browser does with the frames of one terminal: an xterm of its own (same engine, same widths) and the offset bookkeeping. */
export class TestBrowser {
	readonly term: Terminal;
	readonly serialize = new SerializeAddon();
	expected: number | null = null;
	consumed = 0;
	gaps = 0;
	resets = 0;
	/** Characters written, per frame kind. */
	text = "";
	#pending = Promise.resolve();

	constructor(
		cols = 80,
		rows = 24,
		readonly scrollback = 2000,
	) {
		this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
		this.term.loadAddon(new Unicode11Addon());
		this.term.unicode.activeVersion = "11";
		this.term.loadAddon(this.serialize);
	}

	/** Applies the frames of terminal `id` the socket received since `from`; returns the next index. */
	apply(socket: Pick<TestSocket, "frames">, id: string, from = 0): number {
		let index = from;
		for (; index < socket.frames.length; index++) {
			const frame = socket.frames[index]!;
			if (!("id" in frame) || frame.id !== id) continue;
			if (frame.t === "term.size") {
				this.#pending = this.#pending.then(() => void this.term.resize(frame.cols, frame.rows));
			} else if (frame.t === "term.out") {
				if (frame.snapshot === "start") {
					this.resets++;
					this.expected = frame.offset;
					this.#write(frame.data, true);
				} else if (frame.snapshot === "part") {
					this.#write(frame.data, false);
				} else if (this.expected === null || frame.offset > this.expected) {
					this.gaps++;
				} else if (frame.offset === this.expected) {
					this.expected += frame.data.length;
					this.#write(frame.data, false);
				}
			}
		}
		return index;
	}

	#write(data: string, reset: boolean): void {
		this.#pending = this.#pending.then(() => {
			const { promise, resolve } = Promise.withResolvers<void>();
			if (reset) {
				this.term.reset();
				this.text = "";
			}
			this.text += data;
			this.term.write(data, () => {
				this.consumed += data.length;
				resolve();
			});
			return promise;
		});
	}

	/** Resolves once everything applied so far was parsed. */
	async settled(): Promise<void> {
		await this.#pending;
	}

	lines(): string[] {
		const buffer = this.term.buffer.active;
		const out: string[] = [];
		for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? "");
		return out;
	}

	dispose(): void {
		this.term.dispose();
	}
}

export async function until(
	predicate: () => boolean | Promise<boolean>,
	ms = 4000,
	label = "condition",
): Promise<void> {
	const start = Date.now();
	while (!(await predicate())) {
		if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(5);
	}
}
