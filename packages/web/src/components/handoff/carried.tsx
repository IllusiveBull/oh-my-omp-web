import type { CarriedSummary } from "@omp-web/protocol";
import type { ReactNode } from "react";
import { limitList, moreText, shortHead, skippedText, stagedText, trackedText, untrackedText } from "../../lib/handoff";

/** Rows shown before "and N more". */
export const SKIPPED_LIMIT = 8;
export const IGNORED_LIMIT = 5;
export const SAMPLE_LIMIT = 8;

/** What the handoff commit carries: base commit, counts, the staged split, a sample of the paths. */
export function CarriedView({ carried }: { carried: CarriedSummary }): ReactNode {
	const sample = limitList(carried.sample, SAMPLE_LIMIT);
	const base = carried.base;
	return (
		<div className="handoff-carried" data-testid="handoff-carried">
			<div>
				{base.branch ? `Branch ${base.branch}` : "Detached HEAD"} at <code>{shortHead(base.commit)}</code>
				{base.detached && base.branch ? " (detached)" : ""}
			</div>
			<div data-testid="handoff-counts">
				{carried.paths} path{carried.paths === 1 ? "" : "s"} carried: {trackedText(carried.tracked)};{" "}
				{untrackedText(carried.untracked)}
			</div>
			<div data-testid="handoff-staged">{stagedText(carried.staged)}</div>
			{sample.shown.length > 0 && (
				<ul className="handoff-paths" data-testid="handoff-sample">
					{sample.shown.map(path => (
						<li key={path}>{path}</li>
					))}
					{carried.paths > sample.shown.length && (
						<li className="handoff-more">{moreText(carried.paths - sample.shown.length)}</li>
					)}
				</ul>
			)}
		</div>
	);
}

/** Everything left behind, with the reason: skipped paths and the ignored files. Nothing is dropped silently. */
export function NotCarried({ carried }: { carried: CarriedSummary }): ReactNode {
	const skipped = limitList(carried.skipped, SKIPPED_LIMIT);
	const ignored = limitList(carried.ignored.sample, IGNORED_LIMIT);
	const ignoredMore = Math.max(0, carried.ignored.count - ignored.shown.length);
	const nothing = carried.skipped.length === 0 && carried.ignored.count === 0;
	return (
		<div className="handoff-notcarried" data-testid="handoff-not-carried">
			<h4>Not carried</h4>
			{nothing && <p className="handoff-note">Nothing is left behind.</p>}
			{skipped.shown.length > 0 && (
				<ul className="handoff-paths" data-testid="handoff-skipped">
					{skipped.shown.map(path => (
						<li key={path.path}>{skippedText(path)}</li>
					))}
					{skipped.more > 0 && <li className="handoff-more">{moreText(skipped.more)}</li>}
					{carried.skippedTruncated && (
						<li className="handoff-more">the list is capped: more paths were skipped than shown</li>
					)}
				</ul>
			)}
			{carried.ignored.count > 0 && (
				<div data-testid="handoff-ignored">
					<p className="handoff-note">
						{carried.ignored.count} ignored file{carried.ignored.count === 1 ? "" : "s"} stay behind (not
						carried):
					</p>
					<ul className="handoff-paths">
						{ignored.shown.map(path => (
							<li key={path}>{path}</li>
						))}
						{ignoredMore > 0 && <li className="handoff-more">{moreText(ignoredMore)}</li>}
					</ul>
				</div>
			)}
		</div>
	);
}
