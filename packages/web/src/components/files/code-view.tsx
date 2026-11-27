import type { FileContent } from "@omp-web/protocol";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { highlightLines } from "../../lib/files";

type TextContent = Extract<FileContent, { kind: "text" }>;

interface Props {
	content: TextContent;
	/** The line to mark and scroll to. */
	target: number | null;
	loading: boolean;
}

/**
 * One page of a text file with its syntax highlighting. File content only ever becomes React text nodes and `hl-*`
 * spans; the line numbers are drawn by CSS from `data-line`, so copying the code does not copy them.
 */
export function CodeView({ content, target, loading }: Props): ReactNode {
	const lines = useMemo(
		() => highlightLines(content.text, content.spans, content.crlf),
		[content.text, content.spans, content.crlf],
	);
	const ref = useRef<HTMLDivElement>(null);

	// A new page starts at the top, or at the line asked for; a reload of the same page keeps the scroll position
	// (a page is identified by its first line and the target).
	useEffect(() => {
		const root = ref.current;
		if (!root) return;
		const line = target === null ? null : root.querySelector(`[data-line="${target}"]`);
		if (line && typeof line.scrollIntoView === "function") line.scrollIntoView({ block: "center" });
		else root.scrollTop = 0;
	}, [content.path, content.startLine, target]);

	return (
		<div className="files-code" ref={ref} tabIndex={0} data-loading={loading ? "true" : undefined}>
			{lines.map((segments, i) => {
				const number = content.startLine + i;
				return (
					<div
						key={number}
						className={`files-line${number === target ? " files-line--target" : ""}`}
						data-line={number}
					>
						{segments.map((segment, j) =>
							segment.kind === null ? (
								segment.text
							) : (
								<span key={j} className={`hl-${segment.kind}`}>
									{segment.text}
								</span>
							),
						)}
					</div>
				);
			})}
		</div>
	);
}
