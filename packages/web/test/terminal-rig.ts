import type { Ack, ServerMessage, TerminalCapability, TerminalInfo } from "@omp-web/protocol";
import type { ClientRequest } from "../src/store/daemon-client";
import type { Sink, TerminalTransport } from "../src/store/terminal-client";

export const CAPABILITY: TerminalCapability = {
	enabled: true,
	max: 8,
	shell: "/bin/zsh",
	ringChars: 1_000_000,
	scrollbackLines: 5000,
};

export function terminalInfo(id: string, overrides: Partial<TerminalInfo> = {}): TerminalInfo {
	return {
		id,
		name: "zsh",
		title: null,
		cwd: "/work/app",
		shell: "/bin/zsh",
		pid: 100,
		createdAt: 1,
		cols: 80,
		rows: 24,
		state: "running",
		exit: null,
		...overrides,
	};
}

export interface Sent {
	machine: string;
	request: ClientRequest;
}

/** A gateway connection to one or more machines that records what was sent and lets the test play the daemon. */
export class FakeTransport implements TerminalTransport {
	requests: Sent[] = [];
	posts: Sent[] = [];
	capability: TerminalCapability = CAPABILITY;
	/** What the daemon lists (`term.watch` acks it). */
	list: TerminalInfo[] = [];
	/** How `term.attach` is answered. */
	attach: "replay" | "snapshot" = "snapshot";
	attachOffset = 0;
	/** Overrides the answer to a request (return undefined for the default). */
	answer: (sent: Sent) => Ack | undefined = () => undefined;
	#links = new Map<string, string | null>();
	#frames = new Set<(frame: ServerMessage) => void>();
	#states = new Set<() => void>();

	request(machine: string, request: ClientRequest): Promise<Ack> {
		const sent = { machine, request };
		this.requests.push(sent);
		return Promise.resolve(this.answer(sent) ?? this.#default(sent));
	}

	post(machine: string, request: ClientRequest): boolean {
		if (this.linkKey(machine) === null) return false;
		this.posts.push({ machine, request });
		return true;
	}

	onFrame(listener: (frame: ServerMessage) => void): () => void {
		this.#frames.add(listener);
		return () => this.#frames.delete(listener);
	}

	linkKey(machine: string): string | null {
		return this.#links.get(machine) ?? null;
	}

	subscribe(listener: () => void): () => void {
		this.#states.add(listener);
		return () => this.#states.delete(listener);
	}

	/** The link to `machine` changed (null: it went away). */
	setLink(machine: string, key: string | null): void {
		this.#links.set(machine, key);
		for (const listener of Array.from(this.#states)) listener();
	}

	/** A `term.*` frame of `machine`. */
	frame(machine: string, frame: Record<string, unknown>): void {
		for (const listener of Array.from(this.#frames)) listener({ ...frame, m: machine } as unknown as ServerMessage);
	}

	sent(t: string): Sent[] {
		return this.requests.filter(r => r.request.t === t);
	}

	posted(t: string): Sent[] {
		return this.posts.filter(r => r.request.t === t);
	}

	/** `bytes` of every `term.ack` posted, in order. */
	ackedBytes(): number[] {
		return this.posts.flatMap(p => (p.request.t === "term.ack" ? [p.request.bytes] : []));
	}

	/** Length of the `data` of every `term.input` posted, in order. */
	inputSizes(): number[] {
		return this.posts.flatMap(p => (p.request.t === "term.input" ? [p.request.data.length] : []));
	}

	#default({ request }: Sent): Ack {
		switch (request.t) {
			case "term.watch":
				return { t: "ack", reqId: "", ok: true, data: { capability: this.capability, terminals: this.list } };
			case "term.attach": {
				const terminal = this.list.find(t => t.id === request.id);
				if (!terminal) return { t: "ack", reqId: "", ok: false, error: `no terminal ${request.id}` };
				return {
					t: "ack",
					reqId: "",
					ok: true,
					data: { mode: this.attach, offset: this.attachOffset, head: this.attachOffset, terminal },
				};
			}
			default:
				return { t: "ack", reqId: "", ok: true, data: {} };
		}
	}
}

/** A screen that records what it was told and completes its writes when the test says so. */
export class FakeSink implements Sink {
	ops: string[] = [];
	#done: (() => void)[] = [];

	reset(): void {
		this.ops.push("reset");
	}

	write(data: string, done: () => void): void {
		this.ops.push(`write:${data.length > 20 ? `${data.length} chars` : data}`);
		this.#done.push(done);
	}

	resize(cols: number, rows: number): void {
		this.ops.push(`resize:${cols}x${rows}`);
	}

	/** The screen processed everything written so far. */
	flush(): void {
		const done = this.#done;
		this.#done = [];
		for (const fn of done) fn();
	}
}

export function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Lets promises and zero-delay timers settle. */
export const tick = (): Promise<void> => sleep(0);
