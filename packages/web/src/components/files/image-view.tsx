import { type ReactNode, useEffect, useState } from "react";
import { formatSize } from "../../lib/files";
import type { FilesApi } from "../../lib/files-data";
import { fetchImage } from "../../lib/files-image";

interface Props {
	api: FilesApi;
	path: string;
	size: number;
	mtimeMs: number;
	mime: string;
}

type State =
	| { phase: "loading" }
	| { phase: "ready"; url: string }
	| { phase: "error"; message: string; code?: string };

/**
 * An image of the worktree: fetched in chunks, assembled into a Blob and shown through an object URL, which is revoked
 * when the image changes or the view goes away. A new `size` or `mtimeMs` (the file was re-read after a change) loads it
 * again.
 */
export function ImageView({ api, path, size, mtimeMs, mime }: Props): ReactNode {
	const [state, setState] = useState<State>({ phase: "loading" });
	const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

	useEffect(() => {
		let cancelled = false;
		let url: string | null = null;
		setState({ phase: "loading" });
		setDimensions(null);
		void fetchImage(api, path, size, mime, () => cancelled).then(result => {
			if (cancelled) return;
			if (!result.ok) {
				if (!("cancelled" in result)) setState({ phase: "error", message: result.message, code: result.code });
				return;
			}
			url = URL.createObjectURL(result.blob);
			setState({ phase: "ready", url });
		});
		return () => {
			cancelled = true;
			if (url !== null) URL.revokeObjectURL(url);
		};
	}, [api, path, size, mtimeMs, mime]);

	return (
		<div className="files-image" data-state={state.phase}>
			{state.phase === "loading" && <div className="files-empty">Loading image…</div>}
			{state.phase === "error" && (
				<div className="files-error" role="alert" data-code={state.code}>
					{state.message}
				</div>
			)}
			{state.phase === "ready" && (
				<img
					src={state.url}
					alt={path}
					onLoad={e =>
						setDimensions({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
					}
					onError={() => setState({ phase: "error", message: "the browser could not decode this image" })}
				/>
			)}
			<div className="files-image-meta">
				{dimensions ? `${dimensions.width}×${dimensions.height} · ` : ""}
				{formatSize(size)}
			</div>
		</div>
	);
}
