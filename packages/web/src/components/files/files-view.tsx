import type { FileDiffMode, GitStatus, MachineSummary } from "@omp-web/protocol";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { displayPath } from "../../lib/environment";
import { type ChangeItem, changeStats, describeBranch, loadShowIgnored, saveShowIgnored } from "../../lib/files";
import { FilesApi, type FilesTransport } from "../../lib/files-data";
import { rootsOfMachine } from "../../lib/files-links";
import { FilesStore, type ViewMode } from "../../lib/files-store";
import type { FilesRef } from "../../lib/route";
import { ChangesList } from "./changes-list";
import { DiffStat } from "./diff-stat";
import { FileTree } from "./file-tree";
import { FileViewer } from "./file-viewer";
import { IconButton } from "../ui/icon-button";

interface Props {
	client: FilesTransport;
	/** The machine's id and its entry in the gateway's list (undefined until the first `machines` frame). */
	machine: string;
	machineInfo: MachineSummary | undefined;
	/** A registered worktree root of that machine. */
	root: string;
	/** What the route selects: a file or directory of the worktree ("" = nothing), the line to show, the diff mode. */
	path: string;
	line?: number;
	diff?: FileDiffMode;
	/** Changes the route; `replace` rewrites the current history entry (tabs) instead of adding one (opening a file). */
	onNavigate(ref: FilesRef, how: "push" | "replace"): void;
	/** Which list is shown beside the viewer: the directory tree or the git changes (the dock's Files/Changes tab). */
	tab: FilesTab;
	onTab(tab: FilesTab): void;
	/** Each git status the view loads (null until the first), for the dock toolbar's Changes button. */
	onStatus?(status: GitStatus | null): void;
}

export type FilesTab = "tree" | "changes";

function browserStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null; // reading the property can throw when storage is disabled
	}
}

/**
 * Read-only browsing of one worktree: the directory tree and the git changes beside a viewer for the selected file
 * (source, images, diffs). Narrow screens show the tree or the viewer, one at a time. Loading, polling and caching are
 * the {@link FilesStore}'s; this component wires it to the route and the layout.
 */
export function FilesView({
	client,
	machine,
	machineInfo,
	root,
	path,
	line,
	diff,
	onNavigate,
	tab,
	onTab,
	onStatus,
}: Props): ReactNode {
	const store = useMemo(
		() => new FilesStore(new FilesApi(client, machine, root), loadShowIgnored(browserStorage())),
		[client, machine, root],
	);
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const online = machineInfo?.online !== false;
	const linkId = machineInfo?.linkId ?? 0;
	const machineName = machineInfo?.name ?? machine;
	const [screen, setScreen] = useState<"list" | "viewer">(path === "" ? "list" : "viewer");

	// Order matters: the machine's state is recorded before loading starts, and the route is applied last.
	useEffect(() => store.setMachine(online, linkId), [store, online, linkId]);
	useEffect(() => {
		store.start();
		return () => store.stop();
	}, [store]);
	useEffect(() => store.select({ path, line: line ?? null, diff: diff ?? null }), [store, path, line, diff]);
	useEffect(() => setScreen(path === "" ? "list" : "viewer"), [path]);
	const openedKind = snapshot.file.content?.kind;
	useEffect(() => {
		// A directory has no viewer: the tree is where its entries are.
		if (openedKind === "dir") setScreen("list");
	}, [openedKind]);

	const navigate = (to: string, how: "push" | "replace", options: { line?: number; diff?: FileDiffMode } = {}): void =>
		onNavigate({ machine, root, path: to, ...options }, how);

	const openFile = (to: string): void => {
		setScreen("viewer");
		navigate(to, "push");
	};
	const openChange = (item: ChangeItem): void => {
		if (item.mode === null) {
			// An untracked directory has no diff: show it in the tree.
			onTab("tree");
			navigate(item.path, "push");
			return;
		}
		setScreen("viewer");
		navigate(item.path, "push", { diff: item.mode });
	};
	const changeMode = (mode: ViewMode): void => navigate(path, "replace", mode === "source" ? {} : { diff: mode });

	const status = snapshot.status;
	const branch = status.data ? describeBranch(status.data.branch) : "";
	const hasData = snapshot.dirs.get("")?.listing != null;
	const changes = changeStats(status.data);
	useEffect(() => onStatus?.(status.data), [onStatus, status.data]);
	// A directory an omp URL led to (`local://`, `agent://`, …) is not a git worktree: no point saying git failed there.
	const worktree = rootsOfMachine(machineInfo).includes(root);

	return (
		<div className="files" data-machine={machine} data-root={root} data-screen={screen} data-tab={tab}>
			<header className="files-head">
				<div className="files-title">
					<span className="files-root" title={displayPath(root, machineInfo)}>
						{displayPath(root, machineInfo)}
					</span>
					{branch && (
						<span className="files-branch" title={`Branch: ${branch}`}>
							{branch}
						</span>
					)}
					<span className="files-machine">{machineName}</span>
				</div>
				<div className="files-head-actions">
					<label className="files-toggle">
						<input
							type="checkbox"
							name="show-ignored"
							checked={snapshot.showIgnored}
							onChange={e => {
								store.setShowIgnored(e.target.checked);
								saveShowIgnored(browserStorage(), e.target.checked);
							}}
						/>{" "}
						Show ignored
					</label>
					<IconButton
						icon={RefreshCw}
						label="Refresh"
						className="files-refresh"
						name="refresh"
						data-busy={status.loading ? "true" : undefined}
						onClick={() => store.refresh()}
					/>
				</div>
			</header>
			{snapshot.offline && (
				<div className="files-offline" role="status">
					{machineName} is offline.
					{hasData ? " What is shown was loaded earlier; it reloads when the machine is back." : ""}
				</div>
			)}
			<div className="files-body">
				<nav className="files-side" aria-label="Worktree">
					<div className="files-tabs" role="tablist">
						<button
							type="button"
							role="tab"
							className={`files-tab${tab === "tree" ? " files-tab--on" : ""}`}
							data-tab="tree"
							aria-selected={tab === "tree"}
							onClick={() => onTab("tree")}
						>
							Files
						</button>
						<button
							type="button"
							role="tab"
							className={`files-tab${tab === "changes" ? " files-tab--on" : ""}`}
							data-tab="changes"
							aria-selected={tab === "changes"}
							onClick={() => onTab("changes")}
						>
							Changes
							{changes.files > 0 && <DiffStat stats={changes} />}
						</button>
					</div>
					{status.error && status.error.code !== "offline" && worktree && (
						<div className="files-note" data-code={status.error.code}>
							git status unavailable: {status.error.message}
						</div>
					)}
					{status.data?.truncated && tab === "tree" && (
						<div className="files-note" data-kind="truncated">
							git status has more entries than are shown
						</div>
					)}
					<div className="files-side-body">
						{tab === "tree" ? (
							<FileTree
								snapshot={snapshot}
								selected={path === "" ? null : path}
								onToggle={p => store.toggleDir(p)}
								onOpen={openFile}
							/>
						) : (
							<ChangesList
								status={status}
								selected={{ path: path === "" ? null : path, mode: diff ?? null }}
								onOpen={openChange}
							/>
						)}
					</div>
				</nav>
				<section className="files-main" aria-label="File">
					<FileViewer
						store={store}
						snapshot={snapshot}
						machineName={machineName}
						path={path}
						onMode={changeMode}
						onCrumb={p => navigate(p, "push")}
						onBack={() => setScreen("list")}
					/>
				</section>
			</div>
		</div>
	);
}
