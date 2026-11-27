import type { ReactNode } from "react";
import { type ChangeStats, diffBlocks } from "../../lib/files";

const number = new Intl.NumberFormat("en");
const BLOCK = 7;
const BLOCK_GAP = 1;

/** `+added −removed`, green and red. */
export function DiffLines({ added, removed }: { added: number; removed: number }): ReactNode {
	return (
		<>
			<span className="diffstat-added">+{number.format(added)}</span>
			<span className="diffstat-removed">−{number.format(removed)}</span>
		</>
	);
}

/**
 * GitHub's five colored squares. They are one SVG: as separate boxes each snapped to the device pixel grid on its own,
 * so at a fractional offset (text widths, page zoom) their gaps came out uneven.
 */
function DiffSquares({ added, removed }: { added: number; removed: number }): ReactNode {
	const blocks = diffBlocks(added, removed);
	const width = blocks.length * BLOCK + (blocks.length - 1) * BLOCK_GAP;
	if (blocks.length === 0) return null;
	return (
		<svg
			className="diffstat-blocks"
			width={width}
			height={BLOCK}
			viewBox={`0 0 ${width} ${BLOCK}`}
			aria-hidden="true"
		>
			{blocks.map((kind, i) => (
				<rect
					key={i}
					className="diffstat-block"
					data-kind={kind}
					x={i * (BLOCK + BLOCK_GAP)}
					width={BLOCK}
					height={BLOCK}
					rx={1}
				/>
			))}
		</svg>
	);
}

/** The worktree's changes as GitHub sums up a diff: files changed, `+added −removed` and five colored squares. */
export function DiffStat({ stats }: { stats: ChangeStats }): ReactNode {
	const { files, added, removed } = stats;
	const lines = added === null || removed === null ? null : { added, removed };
	return (
		<span className="diffstat" title={changeSummary(stats)}>
			<span className="count-badge files-count">{number.format(files)}</span>
			{lines && (
				<>
					<DiffLines {...lines} />
					<DiffSquares {...lines} />
				</>
			)}
		</span>
	);
}

/** "3 files changed, 985 additions, 296 deletions" (no line counts when the daemon did not count them). */
export function changeSummary({ files, added, removed }: ChangeStats): string {
	return [
		`${files} ${files === 1 ? "file" : "files"} changed`,
		...(added === null || removed === null
			? []
			: [
					`${number.format(added)} ${added === 1 ? "addition" : "additions"}`,
					`${number.format(removed)} ${removed === 1 ? "deletion" : "deletions"}`,
				]),
	].join(", ");
}
