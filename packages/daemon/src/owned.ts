import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Which sessions this daemon created, forked or took over, so taking one over again needs no confirmation. */
export interface OwnedSessions {
	has(id: string): boolean;
	add(id: string): void;
}

/** In memory only: forgotten with the process. */
export class MemoryOwnedSessions implements OwnedSessions {
	readonly #ids = new Set<string>();

	has(id: string): boolean {
		return this.#ids.has(id);
	}

	add(id: string): void {
		this.#ids.add(id);
	}
}

/**
 * The same set kept in a file (`owned-sessions.json` in the state dir), so a restart does not make the daemon ask about
 * conversations it started itself. Only ids this daemon itself acted on are ever added, so the file never marks a
 * session another process (a terminal UI) created. A missing file is an empty set; a file that is not ours is an error
 * rather than silently emptied, since an empty set only makes the daemon ask more.
 */
export class FileOwnedSessions implements OwnedSessions {
	readonly #ids: Set<string>;

	private constructor(
		private readonly file: string,
		ids: Set<string>,
	) {
		this.#ids = ids;
	}

	static open(file: string): FileOwnedSessions {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return new FileOwnedSessions(file, new Set());
			throw error;
		}
		const parsed: unknown = JSON.parse(text);
		const ids = typeof parsed === "object" && parsed !== null && "ids" in parsed ? parsed.ids : undefined;
		if (!Array.isArray(ids) || !ids.every(id => typeof id === "string")) {
			throw new Error(`${file} is not a list of owned session ids; fix or delete it`);
		}
		return new FileOwnedSessions(file, new Set(ids));
	}

	has(id: string): boolean {
		return this.#ids.has(id);
	}

	add(id: string): void {
		if (this.#ids.has(id)) return;
		this.#ids.add(id);
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ ids: [...this.#ids] })}\n`);
		renameSync(tmp, this.file);
	}
}
