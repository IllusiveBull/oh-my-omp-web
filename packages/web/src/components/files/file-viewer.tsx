import { Markdown } from "@oh-my-pi/collab-web/src/components/transcript/Markdown";
import { FILE_DIFF_MODES, type FileContent } from "@omp-web/protocol";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { copyText } from "../../lib/accounts";
import { diffModesFor, entryFor, formatSize, pageInfo } from "../../lib/files";
import type { FilesStore, FilesSnapshot, ViewMode } from "../../lib/files-store";
import { CodeView } from "./code-view";
import { DiffView } from "./diff-view";
import { ImageView } from "./image-view";

type TextContent = Extract<FileContent, { kind: "text" }>;

interface Props {
	store: FilesStore;
	snapshot: FilesSnapshot;
	machineName: string;
	/** Root-relative path of the open file or directory, "" when nothing is open. */
	path: string;
	onMode(mode: ViewMode): void;
	/** Opens an ancestor directory (a breadcrumb). */
	onCrumb(path: string): void;
	/** Narrow screens: back to the tree. */
	onBack(): void;
}

const MODE_LABELS: Record<ViewMode, string> = {
	source: "Source",
	unstaged: "Unstaged",
	staged: "Staged",
	head: "vs HEAD",
	untracked: "Untracked",
};

/** Files shown rendered by default (the Preview tab); Source still shows the text. */
const MARKDOWN = /\.(md|markdown)$/i;

/** The viewer of one file: breadcrumbs, source/diff tabs, badges and banners, then the page, image or diff. */
export function FileViewer({ store, snapshot, machineName, path, onMode, onCrumb, onBack }: Props): ReactNode {
	const { file, status } = snapshot;
	const content = file.content;
	const kind = path === "" ? "none" : (content?.kind ?? "none");
	const markdown = MARKDOWN.test(path) && content?.kind === "text";
	// Preview unless chosen otherwise for this file; a link to a line (`local://plan.md:40`) opens the source there.
	const [choice, setChoice] = useState<{ path: string; rendered: boolean } | null>(null);
	const rendered = choice?.path === path ? choice.rendered : file.target === null;
	const setRendered = (value: boolean): void => setChoice({ path, rendered: value });
	const preview = markdown && rendered && file.mode === "source";

	// Which tabs apply to the file's git state; a mode the route asks for stays offered even when it does not apply.
	const applicable = file.path === null ? [] : diffModesFor(entryFor(status.index, file.path));
	const modes: ViewMode[] = ["source", ...FILE_DIFF_MODES.filter(m => applicable.includes(m) || m === file.mode)];
	const tab = (key: string, label: string, on: boolean, onClick: () => void): ReactNode => (
		<button
			key={key}
			type="button"
			className={`btn btn--small files-mode${on ? " btn--on" : ""}`}
			data-view={key}
			data-on={on ? "true" : "false"}
			aria-pressed={on}
			onClick={onClick}
		>
			{label}
		</button>
	);

	return (
		<div
			className="files-viewer"
			data-path={path}
			data-kind={kind}
			data-mode={file.mode}
			data-loading={file.loading ? "true" : undefined}
		>
			<div className="files-viewer-head">
				<button type="button" className="btn btn--small files-viewer-back" name="viewer-back" onClick={onBack}>
					<ArrowLeft size={14} aria-hidden="true" /> Files
				</button>
				<Breadcrumbs path={path} onCrumb={onCrumb} />
				<CopyPath path={path} />
			</div>
			{path !== "" && (modes.length > 1 || markdown) && (
				<div className="files-modes" role="group" aria-label="View">
					{markdown &&
						tab("preview", "Preview", preview, () => {
							setRendered(true);
							onMode("source");
						})}
					{modes.map(mode =>
						tab(mode, MODE_LABELS[mode], file.mode === mode && !preview, () => {
							if (mode === "source") setRendered(false);
							onMode(mode);
						}),
					)}
				</div>
			)}
			<Body store={store} snapshot={snapshot} machineName={machineName} path={path} preview={preview} />
		</div>
	);
}

function Breadcrumbs({ path, onCrumb }: { path: string; onCrumb(path: string): void }): ReactNode {
	const segments = path === "" ? [] : path.split("/");
	return (
		<nav className="files-crumbs" aria-label="Path">
			{segments.map((segment, i) => {
				const target = segments.slice(0, i + 1).join("/");
				const last = i === segments.length - 1;
				return (
					<span key={target} className="files-crumb-item">
						{i > 0 && <span className="files-crumb-sep">/</span>}
						{last ? (
							<span className="files-crumb files-crumb--last">{segment}</span>
						) : (
							<button type="button" className="files-crumb" onClick={() => onCrumb(target)}>
								{segment}
							</button>
						)}
					</span>
				);
			})}
		</nav>
	);
}

/** Copies the root-relative path of what is open. */
function CopyPath({ path }: { path: string }): ReactNode {
	const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
	return (
		<button
			type="button"
			className="btn btn--small files-copy"
			name="copy-path"
			disabled={path === ""}
			aria-label={copied === "copied" ? "Path copied" : copied === "failed" ? "Copy failed" : "Copy path"}
			title={copied === "failed" ? "Copying needs a secure context (https)" : "Copy path"}
			onClick={() => {
				copyText(path).then(
					() => setCopied("copied"),
					() => setCopied("failed"),
				);
			}}
		>
			{copied === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
		</button>
	);
}

interface BodyProps {
	store: FilesStore;
	snapshot: FilesSnapshot;
	machineName: string;
	path: string;
	/** A Markdown file shown rendered instead of as source. */
	preview: boolean;
}

function Body({ store, snapshot, machineName, path, preview }: BodyProps): ReactNode {
	const { file } = snapshot;
	const { content, error } = file;
	if (path === "" || file.path === null) return <div className="files-empty">Select a file to view it.</div>;
	const banners: ReactNode[] = [];
	if (content && "ignored" in content && content.ignored) {
		banners.push(
			<div key="ignored" className="files-banner" data-kind="ignored">
				ignored by git
			</div>,
		);
	}
	if (snapshot.offline && content) {
		banners.push(
			<div key="stale" className="files-banner" data-kind="stale">
				{machineName} is offline: this is the last copy that was loaded.
			</div>,
		);
	}

	if (file.mode !== "source") {
		return (
			<>
				{banners}
				<DiffView state={file.diff} />
			</>
		);
	}

	if (!content) {
		if (error) {
			return (
				<div className="files-error" role="alert" data-code={error.code}>
					{error.message}
				</div>
			);
		}
		return <div className="files-empty">Loading…</div>;
	}
	const failure =
		error && error.code !== "offline" ? (
			<div className="files-error" role="alert" data-code={error.code}>
				{error.message}
			</div>
		) : null;

	switch (content.kind) {
		case "dir":
			return (
				<>
					{failure}
					<div className="files-empty">This is a directory; its entries are in the tree.</div>
				</>
			);
		case "binary":
			return (
				<>
					{banners}
					{failure}
					<div className="files-empty">
						Binary file ({content.reason}), {formatSize(content.size)}. It is not shown.
					</div>
				</>
			);
		case "too_large":
			return (
				<>
					{banners}
					{failure}
					<div className="files-empty">
						Too large to open: {formatSize(content.size)}, the limit is {formatSize(content.limit)}.
					</div>
				</>
			);
		case "image":
			return (
				<>
					{banners}
					{failure}
					<ImageView
						api={store.api}
						path={content.path}
						size={content.size}
						mtimeMs={content.mtimeMs}
						mime={content.mime}
					/>
				</>
			);
		case "text":
			return (
				<>
					{banners}
					{content.lossy && (
						<div className="files-banner" data-kind="lossy">
							Some bytes are not valid UTF-8 and are shown as �, so this text is not byte-for-byte the file.
						</div>
					)}
					{failure}
					<Badges content={content} />
					{preview ? (
						<div className="files-markdown">
							<Markdown text={content.text} />
						</div>
					) : (
						<CodeView content={content} target={file.target} loading={file.loading} />
					)}
					<Pager store={store} content={content} loading={file.loading} />
				</>
			);
	}
}

function Badges({ content }: { content: TextContent }): ReactNode {
	const badges = [
		content.lang !== null ? content.lang : null,
		content.bom ? "UTF-8 BOM" : null,
		content.crlf ? "CRLF" : null,
		content.lossy ? "not valid UTF-8 (shown as �)" : null,
		content.cut ? "long line cut" : null,
		formatSize(content.size),
	].filter((badge): badge is string => badge !== null);
	return (
		<div className="files-badges">
			{badges.map(badge => (
				<span key={badge} className="files-badge">
					{badge}
				</span>
			))}
		</div>
	);
}

function Pager({ store, content, loading }: { store: FilesStore; content: TextContent; loading: boolean }): ReactNode {
	const [line, setLine] = useState("");
	const go = (): void => {
		const n = Number.parseInt(line, 10);
		if (Number.isInteger(n) && n > 0) store.goToLine(n);
	};
	return (
		<div className="files-pager">
			<button
				type="button"
				className="btn btn--small"
				name="prev-page"
				disabled={loading || content.startLine <= 1}
				onClick={() => store.prevPage()}
			>
				Previous
			</button>
			<button
				type="button"
				className="btn btn--small"
				name="next-page"
				disabled={loading || content.nextLine === null}
				onClick={() => store.nextPage()}
			>
				Next
			</button>
			<span className="files-pageinfo">{pageInfo(content)}</span>
			<span className="files-goto">
				<input
					name="goto-line"
					inputMode="numeric"
					placeholder="Line"
					aria-label="Go to line"
					value={line}
					onChange={e => setLine(e.target.value)}
					onKeyDown={e => e.key === "Enter" && go()}
				/>
				<button type="button" className="btn btn--small" name="goto" onClick={go}>
					Go to line
				</button>
			</span>
		</div>
	);
}
