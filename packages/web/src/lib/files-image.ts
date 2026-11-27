/**
 * Image preview: the file's bytes arrive in chunks (`files.bytes`), a few requests at a time, and are assembled into
 * one Blob. All chunks must describe the same file state, otherwise the preview is abandoned.
 */
import { decodeBase64, type FilesFailureCode, planChunks, PREVIEW_MIMES } from "./files";
import type { FilesApi } from "./files-data";

/** Requests of one image in flight at once (the daemon allows four per connection, leaving room for the tree). */
export const IMAGE_CONCURRENCY = 3;

export type ImageLoad =
	| { ok: true; blob: Blob }
	| { ok: false; message: string; code?: FilesFailureCode }
	| { ok: false; cancelled: true };

const CHANGED = "file changed while loading";

/**
 * Fetches `size` bytes of `path` and returns them as a Blob of type `mime`. Fails when the type is not a previewable
 * raster type, a chunk is refused, or the file's size or mtime differs between chunks (it changed while loading).
 */
export async function fetchImage(
	api: Pick<FilesApi, "bytes">,
	path: string,
	size: number,
	mime: string,
	cancelled: () => boolean,
): Promise<ImageLoad> {
	if (!Object.hasOwn(PREVIEW_MIMES, mime)) return { ok: false, message: `${mime} cannot be previewed` };
	const chunks = planChunks(size);
	const parts: Uint8Array<ArrayBuffer>[] = [];
	const shared: { failure: ImageLoad | null; mtimeMs: number | null; next: number } = {
		failure: null,
		mtimeMs: null,
		next: 0,
	};

	const worker = async (): Promise<void> => {
		while (shared.failure === null && !cancelled()) {
			const index = shared.next++;
			const chunk = chunks[index];
			if (!chunk) return;
			const result = await api.bytes(path, chunk.offset, chunk.length);
			if (shared.failure !== null || cancelled()) return;
			if (!result.ok) {
				shared.failure =
					result.failure.code === "aborted"
						? { ok: false, cancelled: true }
						: { ok: false, message: result.failure.message, code: result.failure.code };
				return;
			}
			const { data } = result;
			if (data.size !== size || (shared.mtimeMs !== null && data.mtimeMs !== shared.mtimeMs)) {
				shared.failure = { ok: false, message: CHANGED, code: "changed" };
				return;
			}
			shared.mtimeMs ??= data.mtimeMs;
			let bytes: Uint8Array<ArrayBuffer>;
			try {
				bytes = decodeBase64(data.data);
			} catch {
				shared.failure = { ok: false, message: "the daemon sent unreadable image data", code: "protocol" };
				return;
			}
			if (data.offset !== chunk.offset || bytes.length !== chunk.length) {
				shared.failure = { ok: false, message: CHANGED, code: "changed" };
				return;
			}
			parts[index] = bytes;
		}
	};

	await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, chunks.length) }, worker));
	if (shared.failure !== null) return shared.failure;
	if (cancelled()) return { ok: false, cancelled: true };
	return { ok: true, blob: new Blob(parts, { type: mime }) };
}
