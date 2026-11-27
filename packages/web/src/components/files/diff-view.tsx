import { DiffBlock } from "@oh-my-pi/collab-web/src/tool-render/parts";
import type { ReactNode } from "react";
import { diffBody } from "../../lib/files";
import type { DiffState } from "../../lib/files-store";
import "@oh-my-pi/collab-web/src/tool-render/tool-render.css";

/** Rows of the diff shown before upstream's own "N more lines" expander takes over. */
const DIFF_ROWS = 400;

/**
 * One git diff of the open file: a condensed header (path, rename origin, counts) from git's own header lines, then
 * the hunks drawn by the transcript's diff renderer.
 */
export function DiffView({ state }: { state: DiffState | null }): ReactNode {
	if (state === null || (state.data === null && state.error === null)) {
		return <div className="files-empty">Loading diff…</div>;
	}
	const { data, error } = state;
	if (data === null) {
		return (
			<div className="files-error" role="alert" data-code={error?.code}>
				{error?.message}
			</div>
		);
	}
	const body = diffBody(data.diff);
	return (
		<div className="files-diff-wrap" data-mode={data.mode} data-loading={state.loading ? "true" : undefined}>
			{error && (
				<div className="files-error" role="alert" data-code={error.code}>
					{error.message}
				</div>
			)}
			<div className="files-diff-head">
				<span className="files-diff-path">{data.path}</span>
				{data.renamedFrom !== undefined && (
					<span className="files-diff-rename">renamed from {data.renamedFrom}</span>
				)}
				<span className="files-diff-counts">
					<span className="files-diff-added">+{data.added}</span>{" "}
					<span className="files-diff-removed">−{data.removed}</span>
				</span>
			</div>
			{data.binary && (
				<div className="files-banner" data-kind="binary">
					Binary file changed
				</div>
			)}
			{data.truncated && (
				<div className="files-banner" data-kind="truncated">
					The diff is too long and was cut off here.
				</div>
			)}
			{!data.binary &&
				(body === "" ? (
					<div className="files-empty">no changes in this view</div>
				) : (
					<div className="files-diff">
						<DiffBlock diff={body} maxLines={DIFF_ROWS} />
					</div>
				))}
		</div>
	);
}
