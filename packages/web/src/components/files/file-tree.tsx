import type { FileEntry } from "@omp-web/protocol";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Link2 } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { decorationOf, inertReason, joinPath, openKind } from "../../lib/files";
import type { FilesSnapshot } from "../../lib/files-store";
import { treeKey, visibleItems } from "../../lib/tree-keys";

interface Props {
	snapshot: FilesSnapshot;
	/** The one row that is in the tab order (roving tabindex); the others are reached with the arrow keys. */
	tabbable?: string;
	/** The path the route selects. */
	selected: string | null;
	onToggle(path: string): void;
	onOpen(path: string): void;
}

/** Indent of a row: 14px a level. */
const indent = (depth: number): number => 8 + depth * 14;

const STATUS_TITLE: Record<string, string> = {
	modified: "modified",
	"staged-modified": "modified (staged)",
	added: "added",
	deleted: "deleted",
	renamed: "renamed",
	untracked: "untracked",
	conflicted: "conflicted (merge conflict)",
};

/** The worktree's directory tree: directories expand in place and list on demand; a file opens in the viewer. */
export function FileTree({ snapshot, selected, onToggle, onOpen }: Props): ReactNode {
	const root = useRef<HTMLUListElement>(null);
	const [focused, setFocused] = useState<string | null>(null);
	const items = visibleItems(snapshot);
	// The row in the tab order: the one with focus, else the selected one, else the first (if it still exists).
	const tabbable = [focused, selected].find(p => p !== null && items.some(i => i.path === p)) ?? items[0]?.path;

	const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
		const current = (event.target as HTMLElement).closest("[data-path]")?.getAttribute("data-path");
		if (current === null || current === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
		const action = treeKey(event.key, items, current);
		if (action === null) return;
		event.preventDefault();
		if (action.kind === "toggle") {
			onToggle(action.path);
			return;
		}
		setFocused(action.path);
		for (const row of root.current?.querySelectorAll<HTMLElement>("[data-path]") ?? []) {
			if (row.getAttribute("data-path") === action.path) {
				row.querySelector<HTMLElement>(":scope > .files-node-main")?.focus();
				break;
			}
		}
	};

	return (
		// Keys are handled on the tree; the rows are real buttons, so Enter and Space activate them natively.
		<ul className="files-tree" role="tree" aria-label="Files" ref={root} onKeyDown={onKeyDown}>
			<DirRows
				dir=""
				depth={0}
				snapshot={snapshot}
				selected={selected}
				tabbable={tabbable}
				onFocusRow={setFocused}
				onToggle={onToggle}
				onOpen={onOpen}
			/>
		</ul>
	);
}

interface RowsProps extends Props {
	onFocusRow(path: string): void;
	dir: string;
	depth: number;
}

function DirRows({ dir, depth, snapshot, selected, tabbable, onFocusRow, onToggle, onOpen }: RowsProps): ReactNode {
	const state = snapshot.dirs.get(dir);
	const pad = { paddingLeft: indent(depth) };
	if (!state?.listing) {
		if (state?.error && state.error.code !== "offline") {
			return (
				<li className="files-tree-error" role="alert" data-code={state.error.code} style={pad}>
					{state.error.message}
				</li>
			);
		}
		return (
			<li className="files-node-loading" style={pad}>
				{state?.error ? "Not loaded (offline)" : "Loading…"}
			</li>
		);
	}
	const { listing } = state;
	return (
		<>
			{listing.entries.map(entry => (
				<Node
					key={entry.name}
					entry={entry}
					path={joinPath(dir, entry.name)}
					depth={depth}
					snapshot={snapshot}
					selected={selected}
					tabbable={tabbable}
					onFocusRow={onFocusRow}
					onToggle={onToggle}
					onOpen={onOpen}
				/>
			))}
			{listing.entries.length === 0 && (
				<li className="files-note" style={pad}>
					{dir === "" ? "This directory is empty" : "empty"}
				</li>
			)}
			{listing.truncated && (
				<li className="files-note" data-kind="truncated" style={pad}>
					showing first {listing.entries.length} of at least{" "}
					{Math.max(listing.scanned, listing.entries.length + 1)} entries
				</li>
			)}
			{!listing.ignoreChecked && (
				<li className="files-note" data-kind="ignore-unavailable" style={pad}>
					ignore rules unavailable
				</li>
			)}
		</>
	);
}

interface NodeProps extends Props {
	onFocusRow(path: string): void;
	entry: FileEntry;
	path: string;
	depth: number;
}

function Node({
	entry,
	path,
	depth,
	snapshot,
	selected,
	tabbable,
	onFocusRow,
	onToggle,
	onOpen,
}: NodeProps): ReactNode {
	const open = openKind(entry);
	const isDir = open === "dir";
	const expanded = isDir && snapshot.expanded.has(path);
	const deco = decorationOf(snapshot.status.index, path, entry.kind === "dir" || isDir);
	const ignored = entry.ignored === true;
	const classes = [
		"files-node",
		selected === path ? "files-node--on" : "",
		ignored ? "files-node--ignored" : "",
		open === null ? "files-node--inert" : "",
	];
	const Chevron = expanded ? ChevronDown : ChevronRight;
	const Icon = open === null ? Link2 : isDir ? (expanded ? FolderOpen : Folder) : File;
	return (
		<li
			className={classes.filter(Boolean).join(" ")}
			role="treeitem"
			aria-expanded={isDir ? expanded : undefined}
			aria-level={depth + 1}
			aria-selected={selected === path}
			data-path={path}
			data-kind={entry.kind}
			data-ignored={ignored ? "true" : "false"}
			data-status={deco?.status}
			data-xy={deco?.xy}
			data-changes={deco?.count}
			data-expanded={isDir ? String(expanded) : undefined}
		>
			<button
				type="button"
				className="files-node-main"
				style={{ paddingLeft: indent(depth) }}
				tabIndex={tabbable === path ? 0 : -1}
				onFocus={() => onFocusRow(path)}
				aria-disabled={open === null ? true : undefined}
				title={open === null ? inertReason(entry) : path}
				onClick={() => {
					if (open === "dir") onToggle(path);
					else if (open === "file") onOpen(path);
				}}
			>
				<span className="files-node-icons" aria-hidden="true">
					{isDir ? <Chevron size={12} /> : null}
					<Icon size={14} />
				</span>
				<span className="files-node-name">{entry.name}</span>
				{entry.kind === "symlink" && entry.link && <span className="files-node-link">→ {entry.link.target}</span>}
				{ignored && <span className="files-node-flag">ignored</span>}
				{deco?.letter !== undefined && (
					<span className="files-mark" data-status={deco.status} title={STATUS_TITLE[deco.status]}>
						{deco.letter}
					</span>
				)}
				{deco?.count !== undefined && (
					<span className="files-dot" title={`${deco.count} changed below`}>
						{deco.count}
					</span>
				)}
			</button>
			{expanded && (
				<ul className="files-children" role="group">
					<DirRows
						dir={path}
						depth={depth + 1}
						snapshot={snapshot}
						selected={selected}
						tabbable={tabbable}
						onFocusRow={onFocusRow}
						onToggle={onToggle}
						onOpen={onOpen}
					/>
				</ul>
			)}
		</li>
	);
}
