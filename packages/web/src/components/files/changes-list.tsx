import type { FileDiffMode } from "@omp-web/protocol";
import type { ReactNode } from "react";
import {
	baseName,
	CHANGE_GROUPS,
	type ChangeGroup,
	type ChangeItem,
	changeLetter,
	groupChanges,
	parentOf,
} from "../../lib/files";
import type { StatusState } from "../../lib/files-store";
import { DiffLines } from "./diff-stat";

interface Props {
	status: StatusState;
	/** The path and diff mode the route selects (null mode: the source). */
	selected: { path: string | null; mode: FileDiffMode | null };
	onOpen(item: ChangeItem): void;
}

const TITLES: Record<ChangeGroup, string> = {
	conflicted: "Conflicted",
	staged: "Staged",
	unstaged: "Unstaged",
	untracked: "Untracked",
};

/** `git status` as a list: conflicted, staged, unstaged and untracked files, each opening the matching diff. */
export function ChangesList({ status, selected, onOpen }: Props): ReactNode {
	const groups = groupChanges(status.data);
	if (status.data === null) {
		return status.error && status.error.code !== "offline" ? (
			<div className="files-tree-error" role="alert" data-code={status.error.code}>
				{status.error.message}
			</div>
		) : (
			<div className="files-empty">{status.error ? "Not loaded (offline)" : "Loading changes…"}</div>
		);
	}
	if (status.data.entries.length === 0) return <div className="files-empty">No changes</div>;
	return (
		<>
			<ul className="files-changes">
				{CHANGE_GROUPS.filter(group => groups[group].length > 0).flatMap(group => [
					<li key={`h:${group}`} className="files-changes-heading" data-group={group}>
						{TITLES[group]} <span className="files-count">{groups[group].length}</span>
					</li>,
					...groups[group].map(item => (
						<li
							key={`${group}:${item.path}`}
							className={`files-change${selected.path === item.path && selected.mode === item.mode ? " files-change--on" : ""}`}
							data-path={item.path}
							data-xy={item.xy}
							data-kind={item.kind}
							data-group={group}
						>
							<button type="button" className="files-change-main" title={item.path} onClick={() => onOpen(item)}>
								<span className="files-mark" data-status={item.label}>
									{changeLetter(item.label)}
								</span>
								<span className="files-change-name">{baseName(item.path)}</span>
								<span className="files-change-dir">
									{parentOf(item.path)}
									{item.origPath !== undefined ? ` ← ${item.origPath}` : ""}
								</span>
								{item.lines && (
									<span className="diffstat files-change-lines">
										<DiffLines {...item.lines} />
									</span>
								)}
							</button>
						</li>
					)),
				])}
			</ul>
			{status.data.truncated && (
				<div className="files-note" data-kind="truncated">
					git status has more entries than are shown
				</div>
			)}
		</>
	);
}
