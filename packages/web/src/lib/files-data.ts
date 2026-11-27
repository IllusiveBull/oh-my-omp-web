/**
 * The Files view's data layer: `files.*` requests to one worktree of one machine, answers decoded and failures
 * normalised. A browser connection may have at most {@link MAX_IN_FLIGHT} file requests in flight (the daemon answers
 * `busy` beyond that), so every request goes through a small queue shared by all views of the same client; a `busy`
 * answer is retried once.
 */
import type {
	Ack,
	FileBytes,
	FileContent,
	FileDiff,
	FileDiffMode,
	FileListing,
	FileLocation,
	GitStatus,
} from "@omp-web/protocol";
import type { ClientRequest } from "../store/daemon-client";
import {
	decodeBytes,
	decodeContent,
	decodeDiff,
	decodeListing,
	decodeLocation,
	decodeStatus,
	type FilesFailure,
	type FilesFailureCode,
} from "./files";

/** The part of the daemon client the files layer needs (a test supplies its own). */
export interface FilesTransport {
	request(machine: string, request: ClientRequest): Promise<Ack>;
}

export type FilesResult<T> = { ok: true; data: T } | { ok: false; failure: FilesFailure };

export const MAX_IN_FLIGHT = 4;
export const BUSY_RETRY_MS = 300;

const DAEMON_CODES: Record<string, true> = {
	not_registered: true,
	bad_path: true,
	not_found: true,
	outside_root: true,
	forbidden: true,
	too_large: true,
	changed: true,
	busy: true,
	git: true,
};

/** Runs tasks with at most `limit` at a time, in arrival order. */
class Limiter {
	#active = 0;
	readonly #waiting: (() => void)[] = [];
	constructor(readonly limit: number) {}

	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.#active < this.limit) this.#active++;
		else {
			// The releasing task hands its slot over, so a caller arriving meanwhile cannot overtake the queue.
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiting.push(resolve);
			await promise;
		}
		try {
			return await task();
		} finally {
			const next = this.#waiting.shift();
			if (next) next();
			else this.#active--;
		}
	}
}

const limiters = new WeakMap<object, Limiter>();

function limiterOf(transport: object): Limiter {
	let limiter = limiters.get(transport);
	if (!limiter) {
		limiter = new Limiter(MAX_IN_FLIGHT);
		limiters.set(transport, limiter);
	}
	return limiter;
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** A failed ack as the failure the UI shows. */
export function failureOfAck(ack: Extract<Ack, { ok: false }>): FilesFailure {
	const code: FilesFailureCode =
		ack.code !== undefined && Object.hasOwn(DAEMON_CODES, ack.code)
			? (ack.code as FilesFailureCode)
			: /offline/i.test(ack.error)
				? "offline"
				: "failed";
	return { message: ack.error, code };
}

const ABORTED: FilesFailure = { message: "the Files view was closed", code: "aborted" };

export class FilesApi {
	readonly #transport: FilesTransport;
	readonly #limiter: Limiter;
	#closed = false;

	constructor(
		transport: FilesTransport,
		readonly machine: string,
		readonly root: string,
	) {
		this.#transport = transport;
		this.#limiter = limiterOf(transport);
	}

	/** Requests still waiting for a slot are dropped, and nothing more is sent. */
	close(): void {
		this.#closed = true;
	}

	list(path: string, showIgnored: boolean): Promise<FilesResult<FileListing>> {
		return this.#call({ t: "files.list", root: this.root, path, showIgnored }, decodeListing);
	}

	read(path: string, fromLine?: number, maxLines?: number): Promise<FilesResult<FileContent>> {
		return this.#call({ t: "files.read", root: this.root, path, fromLine, maxLines }, decodeContent);
	}

	bytes(path: string, offset: number, length: number): Promise<FilesResult<FileBytes>> {
		return this.#call({ t: "files.bytes", root: this.root, path, offset, length }, decodeBytes);
	}

	status(): Promise<FilesResult<GitStatus>> {
		return this.#call({ t: "files.status", root: this.root }, decodeStatus);
	}

	diff(path: string, mode: FileDiffMode, origPath?: string): Promise<FilesResult<FileDiff>> {
		return this.#call({ t: "files.diff", root: this.root, path, mode, origPath }, decodeDiff);
	}

	/** Where an omp URL's file lives on the machine, as session `sessionId` resolves it (no root needed). */
	locate(sessionId: string, url: string): Promise<FilesResult<FileLocation>> {
		return this.#call({ t: "files.locate", sessionId, url }, decodeLocation);
	}

	async #call<T>(request: ClientRequest, decode: (data: unknown) => T | null): Promise<FilesResult<T>> {
		for (let attempt = 0; ; attempt++) {
			const ack = await this.#send(request);
			if (ack === null) return { ok: false, failure: ABORTED };
			if (ack.ok) {
				const data = decode(ack.data);
				return data === null
					? { ok: false, failure: { message: "the daemon's answer could not be read", code: "protocol" } }
					: { ok: true, data };
			}
			const failure = failureOfAck(ack);
			if (failure.code === "busy" && attempt === 0) {
				await sleep(BUSY_RETRY_MS);
				continue;
			}
			return { ok: false, failure };
		}
	}

	/** One request through the queue; null when the view closed before it could be sent. */
	async #send(request: ClientRequest): Promise<Ack | null> {
		return this.#limiter.run(async () => {
			if (this.#closed) return null;
			try {
				return await this.#transport.request(this.machine, request);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { t: "ack", reqId: "", ok: false, error: message } satisfies Ack;
			}
		});
	}
}
