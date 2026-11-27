/** A scripted `files.*` daemon for the Files view's tests: an in-memory worktree answering the requests. */
import type { Ack, AckErrorCode, FileEntry, GitStatus } from "@omp-web/protocol";
import type { FilesTransport } from "../src/lib/files-data";
import type { ClientRequest } from "../src/store/daemon-client";

export const ok = (data: unknown): Ack => ({ t: "ack", reqId: "", ok: true, data });
export const refuse = (error: string, code?: AckErrorCode): Ack => ({ t: "ack", reqId: "", ok: false, error, code });

export const CLEAN: GitStatus = {
	branch: { head: "main", oid: "0123456789abcdef", upstream: "origin/main", ahead: 1, behind: 0 },
	entries: [],
	truncated: false,
};

export const file = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
	name,
	kind: "file",
	size: 10,
	...extra,
});
export const dir = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({ name, kind: "dir", ...extra });

type Hold = { match(request: ClientRequest): boolean; promise: Promise<void> };

export class FakeFiles implements FilesTransport {
	calls: { machine: string; request: ClientRequest }[] = [];
	inFlight = 0;
	maxInFlight = 0;
	/** Directory path → entries. */
	dirs = new Map<string, FileEntry[]>();
	/** File path → lines. */
	texts = new Map<string, string[]>();
	/** File path → raster bytes. */
	images = new Map<string, { mime: string; bytes: Uint8Array }>();
	status: GitStatus = CLEAN;
	/** `${mode}:${path}` → unified diff text. */
	diffs = new Map<string, string>();
	mtimeMs = 1000;
	offline = false;
	#holds: Hold[] = [];

	/** Holds the answer of every matching request until the returned function is called. */
	hold(match: (request: ClientRequest) => boolean): () => void {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#holds.push({ match, promise });
		return resolve;
	}

	of(t: string): ClientRequest[] {
		return this.calls.filter(c => c.request.t === t).map(c => c.request);
	}

	async request(machine: string, request: ClientRequest): Promise<Ack> {
		this.calls.push({ machine, request });
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			for (const hold of this.#holds) if (hold.match(request)) await hold.promise;
			await new Promise<void>(resolve => setImmediate(resolve));
			if (this.offline) return refuse("machine Home is offline");
			return this.#answer(request);
		} finally {
			this.inFlight--;
		}
	}

	#answer(request: ClientRequest): Ack {
		switch (request.t) {
			case "files.list": {
				const entries = this.dirs.get(request.path);
				if (!entries) return refuse(`${request.path}: no such directory`, "not_found");
				const shown = entries.filter(e => !e.ignored || request.showIgnored === true);
				return ok({
					path: request.path,
					entries: shown,
					truncated: false,
					scanned: entries.length,
					ignoredHidden: entries.length - shown.length,
					ignoreChecked: true,
				});
			}
			case "files.read": {
				if (this.dirs.has(request.path)) return ok({ kind: "dir", path: request.path });
				const meta = { path: request.path, mtimeMs: this.mtimeMs, ignored: false };
				const image = this.images.get(request.path);
				if (image) return ok({ ...meta, kind: "image", size: image.bytes.length, mime: image.mime });
				const lines = this.texts.get(request.path);
				if (!lines) return refuse(`${request.path}: not found`, "not_found");
				const start = request.fromLine ?? 1;
				const end = Math.min(lines.length, start + (request.maxLines ?? 1000) - 1);
				const page = lines.slice(start - 1, end);
				return ok({
					...meta,
					kind: "text",
					size: lines.join("\n").length,
					text: page.map(l => `${l}\n`).join(""),
					startLine: start,
					endLine: start + page.length - 1,
					nextLine: end < lines.length ? end + 1 : null,
					totalLines: lines.length,
					lossy: false,
					crlf: false,
					bom: false,
					cut: false,
					lang: request.path.endsWith(".ts") ? "typescript" : null,
					spans: null,
				});
			}
			case "files.bytes": {
				const image = this.images.get(request.path);
				if (!image) return refuse(`${request.path}: not found`, "not_found");
				const slice = image.bytes.slice(request.offset, request.offset + request.length);
				return ok({
					offset: request.offset,
					length: slice.length,
					size: image.bytes.length,
					mtimeMs: this.mtimeMs,
					eof: request.offset + slice.length >= image.bytes.length,
					data: Buffer.from(slice).toString("base64"),
				});
			}
			case "files.status":
				return ok(this.status);
			case "files.diff":
				return ok({
					mode: request.mode,
					path: request.path,
					origPath: request.origPath,
					diff: this.diffs.get(`${request.mode}:${request.path}`) ?? "",
					truncated: false,
					binary: false,
					added: 1,
					removed: 1,
				});
			default:
				return refuse(`unexpected request ${request.t}`);
		}
	}
}

/** A small worktree: src/{a.ts, deep/x.ts}, README.md, an ignored dist/. */
export function sampleTree(): FakeFiles {
	const fake = new FakeFiles();
	fake.dirs.set("", [dir("dist", { ignored: true }), dir("src"), file("README.md")]);
	fake.dirs.set("dist", [file("out.js")]);
	fake.dirs.set("src", [dir("deep"), file("a.ts")]);
	fake.dirs.set("src/deep", [file("x.ts")]);
	fake.texts.set("README.md", ["# hello", "", "world"]);
	fake.texts.set("src/a.ts", ["export const a = 1;", "export const b = 2;"]);
	fake.texts.set(
		"src/deep/x.ts",
		Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`),
	);
	return fake;
}

/** Lets promises and `setImmediate` work settle. */
export async function settle(turns = 5): Promise<void> {
	for (let i = 0; i < turns; i++) await new Promise<void>(resolve => setImmediate(resolve));
}
