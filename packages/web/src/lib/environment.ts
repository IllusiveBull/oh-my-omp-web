import type { GatewaySessionInfo, MachineSummary, ProjectInfo, WorktreeInfo } from "@omp-web/protocol";

/**
 * What the environment selector points at: a machine, one of its registered projects (project root, "" = all projects)
 * and one of that project's worktrees (worktree path, "" = all worktrees).
 */
export interface Selection {
	machine: string | null;
	project: string;
	worktree: string;
}

export const EMPTY_SELECTION: Selection = { machine: null, project: "", worktree: "" };

export function findProject(machine: MachineSummary | undefined, root: string): ProjectInfo | undefined {
	return machine?.projects.find(p => p.root === root);
}

/** A machine with a single project is that project; otherwise nothing is preselected. */
export function defaultProject(machine: MachineSummary | undefined): string {
	return machine?.projects.length === 1 ? machine.projects[0]!.root : "";
}

/** A project with a single worktree is that worktree; otherwise nothing is preselected. */
export function defaultWorktree(project: ProjectInfo | undefined): string {
	return project?.worktrees.length === 1 ? project.worktrees[0]!.path : "";
}

/** The user picked a project of `machineId` (`null` = all projects): its single worktree, if it has just one, comes along. */
export function selectProject(machineId: string, project: ProjectInfo | null): Selection {
	return { machine: machineId, project: project?.root ?? "", worktree: defaultWorktree(project ?? undefined) };
}

/**
 * The user switched to `machine` from `from` (the selection's machine as known now): "all projects" stays all projects;
 * the same repository (a project's `id` is its root commit, equal across clones) stays selected there, on the worktree
 * of the same branch, else the main one. A project the new machine lacks starts from the machine's defaults.
 */
export function selectMachine(
	machine: MachineSummary,
	from?: { machine: MachineSummary | undefined; selection: Selection },
): Selection {
	if (from?.selection.project === "") return selectProject(machine.id, null);
	const source = from && findProject(from.machine, from.selection.project);
	const same = source && machine.projects.find(p => p.id === source.id);
	if (!from || !source || !same) {
		return selectProject(machine.id, machine.projects.length === 1 ? machine.projects[0]! : null);
	}
	if (from.selection.worktree === "") return selectProject(machine.id, same);
	const branch = source.worktrees.find(w => w.path === from.selection.worktree)?.branch;
	const worktree =
		(branch != null && same.worktrees.find(w => w.branch === branch)) ||
		same.worktrees.find(w => w.main) ||
		same.worktrees[0];
	return { machine: machine.id, project: same.root, worktree: worktree?.path ?? "" };
}

/**
 * The selection to show for what the user chose earlier (`stored`, possibly from another session of the app) against
 * the machines known now. Whatever no longer exists falls back: the machine to the gateway's own, then to the first
 * one; the project and worktree to their defaults. Pure, so a machine list that arrives late repairs it without
 * overwriting what was stored.
 */
export function resolveSelection(
	machines: readonly MachineSummary[],
	stored: Selection | null,
	gatewayMachine: string | null,
): Selection {
	const machine =
		machines.find(m => m.id === stored?.machine) ?? machines.find(m => m.id === gatewayMachine) ?? machines[0];
	if (!machine) return EMPTY_SELECTION;
	const kept = stored?.machine === machine.id ? stored : null;
	const project =
		kept && (kept.project === "" || findProject(machine, kept.project)) ? kept.project : defaultProject(machine);
	const projectInfo = findProject(machine, project);
	const worktree =
		kept &&
		kept.project === project &&
		(kept.worktree === "" || projectInfo?.worktrees.some(w => w.path === kept.worktree))
			? kept.worktree
			: defaultWorktree(projectInfo);
	return { machine: machine.id, project, worktree };
}

/** Sessions inside the selected project (and worktree). "All projects" keeps everything, even sessions outside every project. */
export function scopeSessions(
	sessions: readonly GatewaySessionInfo[],
	project: string,
	worktree: string,
): GatewaySessionInfo[] {
	if (project === "") return [...sessions];
	return sessions.filter(s => s.projectRoot === project && (worktree === "" || s.worktreeRoot === worktree));
}

/** Directories of sessions outside every registered project, once each, in list order: offered as projects to add. */
export function unregisteredDirs(sessions: readonly GatewaySessionInfo[]): string[] {
	return [...new Set(sessions.filter(s => s.projectRoot === undefined).map(s => s.cwd))];
}

/** `target` with a worktree of its project: its own when the project has it, else the repository's main one. */
export function withWorktree(machine: MachineSummary | undefined, target: Selection): Selection {
	const project = findProject(machine, target.project);
	const worktree = project?.worktrees.some(w => w.path === target.worktree)
		? target.worktree
		: (project?.worktrees.find(w => w.main)?.path ?? defaultWorktree(project));
	return { machine: target.machine, project: project ? target.project : "", worktree };
}

/**
 * Where "New session" starts: the focused project, else the project of the most recently active session in a
 * registered project, else the machine's only project; at the selection's worktree when that project has it, else its
 * main one.
 */
export function startSelection(
	machine: MachineSummary | undefined,
	selection: Selection,
	sessions: readonly GatewaySessionInfo[],
): Selection {
	let recent: GatewaySessionInfo | undefined;
	for (const s of sessions)
		if (s.projectRoot && findProject(machine, s.projectRoot) && s.modifiedAt > (recent?.modifiedAt ?? -1)) recent = s;
	return withWorktree(machine, {
		...selection,
		project: selection.project || recent?.projectRoot || defaultProject(machine),
	});
}

export type NewSessionTarget = { ok: true; cwd: string } | { ok: false; reason: string };

/** Where "New session" would create one, or why it cannot. */
export function newSessionTarget(machine: MachineSummary | undefined, selection: Selection): NewSessionTarget {
	if (!machine) return { ok: false, reason: "No machine selected." };
	if (!machine.online) return { ok: false, reason: `${machine.name} is offline.` };
	if (selection.project === "") {
		return { ok: false, reason: machine.projects.length === 0 ? "Add a project first." : "Pick a project." };
	}
	if (selection.worktree === "") return { ok: false, reason: "Pick a worktree." };
	return { ok: true, cwd: selection.worktree };
}

export function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** Display a path relative to its own machine's reported home, without changing the path used by requests. */
export function displayPath(path: string, machine: Pick<MachineSummary, "platform" | "home"> | undefined): string {
	if (!machine?.home) return path;
	const windows = machine.platform === "win32";
	const value = windows ? path.replace(/\\/g, "/") : path;
	const home = (windows ? machine.home.replace(/\\/g, "/") : machine.home).replace(/\/+$/, "") || "/";
	const a = windows ? value.toLowerCase() : value;
	const b = windows ? home.toLowerCase() : home;
	if (a.replace(/\/+$/, "") === b || (b === "/" && a === "/")) return "~";
	const prefix = b === "/" ? "/" : `${b}/`;
	if (!a.startsWith(prefix)) return path;
	return `~/${value.slice(prefix.length)}`;
}

/** The last two path segments: enough to tell worktrees of one project apart. */
function pathHint(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

/** `branch (main) — …/parent/dir`; a detached HEAD shows the directory name instead of a branch. */
export function worktreeLabel(worktree: WorktreeInfo, machine?: Pick<MachineSummary, "platform" | "home">): string {
	const name = worktree.branch ?? `${basename(worktree.path)} (detached)`;
	const path = displayPath(worktree.path, machine);
	return `${name}${worktree.main ? " (main)" : ""} — ${path.startsWith("~") ? path : pathHint(path)}`;
}

const STORAGE_KEY = "omp-web.selection";

export function loadSelection(storage: Pick<Storage, "getItem">): Selection | null {
	try {
		const raw = storage.getItem(STORAGE_KEY);
		if (raw === null) return null;
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null) return null;
		const { machine, project, worktree } = value as Record<string, unknown>;
		if (
			(machine !== null && typeof machine !== "string") ||
			typeof project !== "string" ||
			typeof worktree !== "string"
		) {
			return null;
		}
		return { machine, project, worktree };
	} catch {
		return null; // storage unavailable or the value is not ours
	}
}

export function saveSelection(storage: Pick<Storage, "setItem">, selection: Selection): void {
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify(selection));
	} catch {
		// Private mode / quota: the selection just does not outlive the tab.
	}
}
