import type { GatewaySessionInfo, MachineSummary } from "@omp-web/protocol";
import { FolderGit2, GitBranch, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ackedProject } from "../lib/ack";
import {
	basename,
	displayPath,
	findProject,
	type Selection,
	selectProject,
	unregisteredDirs,
	worktreeLabel,
} from "../lib/environment";
import type { ClientRequest, DaemonClient } from "../store/daemon-client";
import { ChipMenu } from "./chip-menu";
import { IconButton } from "./ui/icon-button";

interface PanelProps {
	client: DaemonClient;
	machine: MachineSummary;
	/** The project and worktree chosen now; the panel changes the project. */
	target: Selection;
	/** The machine's sessions: the directories of those outside every project are offered as projects to add. */
	sessions: readonly GatewaySessionInfo[];
	onSelection(next: Selection): void;
	/** Offers "All projects" first (the sidebar's focus, where no project means every one). */
	allProjects?: boolean;
	/** Closes the menu (after a project was picked). */
	close(): void;
}

/**
 * The project menu (the sidebar's focus, and a new session's status line): pick a registered project, register a
 * repository (by path, or the directory of a session outside every project), refresh the worktree lists, or forget the
 * chosen project.
 */
export function ProjectPanel({
	client,
	machine,
	target,
	sessions,
	onSelection,
	allProjects,
	close,
}: PanelProps): ReactNode {
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The project whose removal is waiting for its confirmation click.
	const [armed, setArmed] = useState<string | null>(null);
	const project = findProject(machine, target.project);
	const canEdit = machine.online;
	// A session without a working directory has nothing to register: it would be an empty row.
	const dirs = canEdit ? unregisteredDirs(sessions).filter(dir => dir.trim() !== "") : [];
	// Choosing another project cancels a pending removal for good (coming back must not find it armed).
	useEffect(() => setArmed(null), [target.machine, target.project]);

	/** Sends a project request to the machine; the ack's data when it succeeded, else the error is shown. */
	const act = async (request: ClientRequest): Promise<{ data: unknown } | null> => {
		setError(null);
		const ack = await client.request(machine.id, request);
		if (!ack.ok) {
			setError(ack.error);
			return null;
		}
		return { data: ack.data };
	};

	/** Registers the repository containing `dir` and picks it; true when it did. */
	const add = async (dir: string): Promise<boolean> => {
		setBusy(true);
		const ack = await act({ t: "project.add", path: dir });
		setBusy(false);
		if (!ack) return false;
		const added = ackedProject(ack.data);
		if (added === null) {
			setError("the daemon did not report the added project");
			return false;
		}
		onSelection(selectProject(machine.id, added));
		close();
		return true;
	};

	const submit = async (e: FormEvent): Promise<void> => {
		e.preventDefault();
		if (path.trim() && (await add(path.trim()))) setPath("");
	};

	return (
		<div className="project-panel">
			<div className="chip-list" role="listbox" aria-label="Projects">
				{allProjects && (
					<button
						type="button"
						role="option"
						aria-selected={!target.project}
						className="chip-option project-option"
						data-project=""
						onClick={() => {
							onSelection(selectProject(machine.id, null));
							close();
						}}
					>
						All projects
					</button>
				)}
				{machine.projects.map(p => (
					<button
						key={p.root}
						type="button"
						role="option"
						aria-selected={p.root === target.project}
						className="chip-option project-option"
						data-project={p.root}
						title={displayPath(p.root, machine)}
						onClick={() => {
							onSelection(selectProject(machine.id, p));
							close();
						}}
					>
						{p.name}
					</button>
				))}
				{machine.projects.length === 0 && <div className="faint">No projects on {machine.name} yet</div>}
				{dirs.length > 0 && <div className="chip-group">Add a session's directory</div>}
				{dirs.map(dir => (
					<button
						key={dir}
						type="button"
						className="chip-option project-dir"
						data-dir={dir}
						title={displayPath(dir, machine)}
						disabled={busy}
						onClick={() => void add(dir)}
					>
						<Plus size={14} aria-hidden="true" />
						<span>{displayPath(dir, machine)}</span>
					</button>
				))}
			</div>
			<form className="project-add" onSubmit={e => void submit(e)}>
				<input
					name="project-path"
					value={path}
					onChange={e => setPath(e.target.value)}
					placeholder="Add project: ~/path/to/repo"
					aria-label="Project path"
					autoComplete="off"
					disabled={!canEdit}
				/>
				<button type="submit" className="btn btn--small" disabled={!canEdit || busy || !path.trim()}>
					Add
				</button>
			</form>
			{project && armed === project.root ? (
				<span className="env-confirm" role="group" aria-label={`Confirm removing ${project.name}`}>
					<span className="env-confirm-label">Remove {project.name}?</span>
					<button
						type="button"
						className="btn btn--small btn--danger env-confirm-yes"
						disabled={!canEdit}
						onClick={() => {
							setArmed(null);
							void act({ t: "project.remove", root: project.root });
						}}
					>
						Remove
					</button>
					<button
						type="button"
						className="btn btn--small btn--ghost env-confirm-no"
						onClick={() => setArmed(null)}
					>
						Cancel
					</button>
				</span>
			) : (
				<div className="project-tools">
					<IconButton
						icon={RefreshCw}
						label="Refresh projects"
						disabled={!canEdit}
						onClick={() => void act({ t: "project.list" })}
					/>
					<IconButton
						icon={Trash2}
						label="Remove project"
						danger
						disabled={!canEdit || !project}
						onClick={() => project && setArmed(project.root)}
					/>
				</div>
			)}
			{error && (
				<div className="form-error" role="alert">
					{error}
				</div>
			)}
		</div>
	);
}

interface PickerProps {
	client: DaemonClient;
	machine: MachineSummary | undefined;
	target: Selection;
	sessions: readonly GatewaySessionInfo[];
	onSelection(next: Selection): void;
	/** `up` in the status line, under the composer at the bottom of the page. */
	placement?: "up";
	/** See {@link PanelProps.allProjects}; the chip then reads "All projects" while none is chosen. */
	allProjects?: boolean;
	/** Target name while a session relocation is in flight (shows a spinner and `switching to <name>…`). */
	switching?: string | null;
	/** Disables opening the menu (e.g. while another relocation is in flight). */
	disabled?: boolean;
}

/** The project chip and its menu. */
export function ProjectPicker({
	client,
	machine,
	target,
	sessions,
	onSelection,
	placement,
	allProjects,
	switching,
	disabled,
}: PickerProps): ReactNode {
	const project = findProject(machine, target.project);
	const isSwitching = switching !== undefined && switching !== null;
	return (
		<ChipMenu
			title={isSwitching ? (switching ? `Switching to ${switching}…` : "Switching…") : "Project"}
			buttonClass={isSwitching ? "chip chip--button status-chip--switching" : undefined}
			ariaBusy={isSwitching}
			disabled={disabled || isSwitching || !machine}
			placement={placement}
			label={
				isSwitching ? (
					<>
						<LoaderCircle aria-hidden="true" />
						{switching ? `switching to ${switching}…` : "switching…"}
					</>
				) : (
					<>
						<FolderGit2 size={14} aria-hidden="true" />{" "}
						{project?.name ?? (allProjects ? "All projects" : "Pick a project")}
					</>
				)
			}
		>
			{close =>
				machine && (
					<ProjectPanel
						client={client}
						machine={machine}
						target={target}
						sessions={sessions}
						onSelection={onSelection}
						allProjects={allProjects}
						close={close}
					/>
				)
			}
		</ChipMenu>
	);
}

/** The worktree chip: the project's worktrees, named by their branch. */
export function WorktreePicker({
	machine,
	target,
	onSelection,
	placement,
	switching,
	disabled,
}: Pick<PickerProps, "machine" | "target" | "onSelection" | "placement" | "switching" | "disabled">): ReactNode {
	const project = findProject(machine, target.project);
	const worktree = project?.worktrees.find(w => w.path === target.worktree);
	const isSwitching = switching !== undefined && switching !== null;
	return (
		<ChipMenu
			title={isSwitching ? (switching ? `Switching to ${switching}…` : "Switching…") : "Worktree and branch"}
			buttonClass={isSwitching ? "chip chip--button status-chip--switching" : undefined}
			ariaBusy={isSwitching}
			disabled={disabled || isSwitching || !project}
			placement={placement}
			label={
				isSwitching ? (
					<>
						<LoaderCircle aria-hidden="true" />
						{switching ? `switching to ${switching}…` : "switching…"}
					</>
				) : (
					<>
						<GitBranch size={14} aria-hidden="true" />{" "}
						{worktree ? (worktree.branch ?? `${basename(worktree.path)} (detached)`) : "Pick a worktree"}
					</>
				)
			}
		>
			{close => (
				<div className="chip-list" role="listbox" aria-label="Worktrees">
					{project?.worktrees.map(w => (
						<button
							key={w.path}
							type="button"
							role="option"
							aria-selected={w.path === target.worktree}
							className="chip-option"
							data-worktree={w.path}
							title={displayPath(w.path, machine)}
							onClick={() => {
								onSelection({ ...target, worktree: w.path });
								close();
							}}
						>
							{worktreeLabel(w, machine)}
						</button>
					))}
				</div>
			)}
		</ChipMenu>
	);
}
