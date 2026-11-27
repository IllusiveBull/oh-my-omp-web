import type {
	GatewaySessionInfo,
	MachineSummary,
	SessionAttention,
	SessionBackend,
	SessionPhase,
} from "@omp-web/protocol";
import { KeyRound, Lock, Pencil, Search, SquarePen, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { loadPermissionModePreference, startSession } from "../lib/new-session";
import type { Tone } from "../lib/accounts";
import {
	basename,
	displayPath,
	newSessionTarget,
	type Selection,
	scopeSessions,
	startSelection,
} from "../lib/environment";
import type { SessionRef } from "../lib/route";
import { environmentLabel, listedSessions } from "../lib/handoff";
import { sessionLabel } from "../lib/session-label";
import { searchSessions } from "../lib/session-search";
import { formatAbsolute, formatStamp } from "../lib/time";
import { useDaemonSessionSearch } from "../lib/use-session-search";
import type { DaemonClient } from "../store/daemon-client";
import { EnvironmentSelector } from "./environment-selector";
import { HopHistory } from "./handoff/hop-history";
import { NotificationBell } from "./notification-settings";
import { ThemeToggle } from "./theme-toggle";
import { IconButton } from "./ui/icon-button";

interface Props {
	client: DaemonClient;
	machines: readonly MachineSummary[];
	sessions: Readonly<Record<string, readonly GatewaySessionInfo[]>>;
	/** The effective environment selection (already repaired against `machines`). */
	selection: Selection;
	selected: SessionRef | null;
	onSelection(next: Selection): void;
	onSelect(ref: SessionRef | null): void;
	/** The Accounts entry: whether its page is open, how worried its dot looks, and how to open or close it. */
	accounts: { open: boolean; attention: Tone; onToggle(): void };
	/** Reopens the dialog of an environment switch (the "switching…" badge). */
	onOpenHandoff(id: string): void;
	/** Preferred backend for New session (only active when the selected machine supports Antigravity). */
	backend?: SessionBackend;
}

const NO_SESSIONS: readonly GatewaySessionInfo[] = [];

/** The session's dot: what it waits on a human for, else its phase (herdr's blocked / working / idle). */
const DOT_LABEL: Record<SessionAttention | SessionPhase, string> = {
	input: "waiting for your answer",
	error: "stopped with an error",
	starting: "starting",
	working: "working",
	idle: "idle",
	closed: "closed",
	stored: "not running",
};

/** A row's second line: where it ran, with what, and when it was created. Parts a session lacks leave no dangling separator. */
function SessionSub({
	session: s,
	machine,
	now,
}: {
	session: GatewaySessionInfo;
	machine: MachineSummary;
	now: number;
}): ReactNode {
	const detail = [
		displayPath(s.cwd, machine) === "~" ? "~" : basename(s.cwd),
		s.model && s.access !== "hosted" ? s.model : "",
		s.files > 1 ? `${s.files} files` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<span className="side-sub">
			{detail}
			{s.createdAt > 0 && (
				<>
					{detail && " · "}
					<time
						className="side-created"
						dateTime={new Date(s.createdAt).toISOString()}
						title={`Created ${formatAbsolute(s.createdAt)}`}
					>
						{formatStamp(s.createdAt, now)}
					</time>
				</>
			)}
		</span>
	);
}

export function SessionList({
	client,
	machines,
	sessions,
	selection,
	selected,
	onSelection,
	onSelect,
	accounts,
	onOpenHandoff,
	backend: preferredBackend = "omp",
}: Props): ReactNode {
	const [query, setQuery] = useState("");
	// The filter field opens from the Sessions header; closing it clears the filter so no hidden query narrows the list.
	const [searching, setSearching] = useState(false);
	const closeSearch = (): void => {
		setSearching(false);
		setQuery("");
	};
	const [notice, setNotice] = useState<{ text: string; needsAuth?: boolean } | null>(null);
	const [busy, setBusy] = useState(false);
	const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
	// On a phone the open session replaces the list; its row keeps the touch row actions (Rename, Close) on return.
	const [lastOpened, setLastOpened] = useState<string | null>(null);
	useEffect(() => {
		if (selected) setLastOpened(selected.id);
	}, [selected]);

	const machine = machines.find(m => m.id === selection.machine);
	const offline = machine?.online === false;
	const agyAvailable = machine?.antigravity?.available === true;
	const activeBackend: SessionBackend = agyAvailable ? preferredBackend : "omp";
	const known = machine ? listedSessions(sessions[machine.id] ?? NO_SESSIONS) : NO_SESSIONS;
	// The list follows the focused project; every worktree of it.
	const scoped = scopeSessions(known, selection.project, "");
	// "New session" starts at once, as omp does; the session's status line moves it to another project or worktree
	// until its first message.
	const start = startSelection(machine, selection, known);
	const target = newSessionTarget(machine, start);

	const create = async (): Promise<void> => {
		if (!machine || !target.ok) return;
		setBusy(true);
		setNotice(null);
		const permMode =
			activeBackend === "antigravity"
				? loadPermissionModePreference(typeof localStorage === "undefined" ? undefined : localStorage)
				: undefined;
		const started = await startSession(client, machine.id, target.cwd, activeBackend, permMode);
		setBusy(false);
		if (started.ok) onSelect({ machine: machine.id, id: started.id });
		else setNotice({ text: started.error, needsAuth: started.code === "auth_required" });
	};
	const revision = `${known.length}:${known.reduce((newest, s) => Math.max(newest, s.modifiedAt), 0)}`;
	const daemonSearch = useDaemonSessionSearch(client, machine?.id, !offline, query, revision);
	const matched = searchSessions(scoped, query, daemonSearch.state === "ready" ? daemonSearch.matches : undefined);
	// Without a filter, sessions running in an omp process here (hosted) lead; a filter keeps its relevance order.
	const shown = query.trim()
		? matched
		: [...matched.filter(s => s.access === "hosted"), ...matched.filter(s => s.access !== "hosted")];
	const now = Date.now();

	const close = async (machineId: string, id: string): Promise<void> => {
		const ack = await client.request(machineId, { t: "session.close", sessionId: id });
		if (!ack.ok) setNotice({ text: ack.error });
		else if (selected?.machine === machineId && selected.id === id) onSelect(null);
	};

	const rename = async (e: FormEvent, machineId: string): Promise<void> => {
		e.preventDefault();
		if (!renaming || !renaming.draft.trim()) return;
		setNotice(null);
		const ack = await client.request(machineId, {
			t: "session.rename",
			sessionId: renaming.id,
			title: renaming.draft.trim(),
		});
		if (!ack.ok) setNotice({ text: ack.error });
		else setRenaming(null);
	};

	return (
		<aside className="side">
			<div className="side-title">
				<span className="side-brand">omp-web</span>
				<span className="icon-row side-title-actions">
					<ThemeToggle />
					<NotificationBell />
					<IconButton
						icon={KeyRound}
						label="Accounts"
						className={`accounts-entry${accounts.open ? " icon-btn--on" : ""}`}
						data-attention={accounts.attention}
						aria-current={accounts.open ? "page" : undefined}
						onClick={accounts.onToggle}
					>
						{accounts.attention !== "ok" && accounts.attention !== "off" && (
							<span className={`icon-btn-dot acct-dot--${accounts.attention}`} aria-hidden="true" />
						)}
					</IconButton>
				</span>
			</div>
			<EnvironmentSelector
				client={client}
				machines={machines}
				selection={selection}
				sessions={known}
				activeCounts={Object.fromEntries(
					machines.map(m => [
						m.id,
						listedSessions(sessions[m.id] ?? NO_SESSIONS).filter(s => s.access === "hosted").length,
					]),
				)}
				onSelection={onSelection}
			/>
			{machine && offline && (
				<div className="side-note" role="status">
					{machine.name} is offline. The sessions below are the gateway's cached list.
				</div>
			)}
			<div className="section-head side-section">
				<span className="section-head-title">Sessions</span>
				<span className="section-head-count">{scoped.length}</span>
				<span className="section-head-actions">
					<IconButton
						icon={Search}
						label="Search sessions"
						className={`side-search-toggle${searching ? " icon-btn--on" : ""}`}
						aria-expanded={searching}
						onClick={() => (searching ? closeSearch() : setSearching(true))}
					/>
					<IconButton
						icon={SquarePen}
						label="New session"
						className="side-new-button"
						disabled={busy || !target.ok}
						aria-busy={busy || undefined}
						title={
							busy
								? activeBackend === "antigravity"
									? "Starting Antigravity…"
									: "Starting omp…"
								: target.ok
									? `New ${activeBackend === "antigravity" ? "Antigravity " : ""}session in ${displayPath(target.cwd, machine)}`
									: target.reason
						}
						onClick={() => void create()}
					/>
				</span>
			</div>
			{!target.ok && machine?.online && <div className="side-new-hint">{target.reason}</div>}
			{searching && (
				<label className="side-search">
					<Search size={14} aria-hidden="true" />
					<input
						autoFocus
						className="side-filter"
						value={query}
						onChange={e => setQuery(e.target.value)}
						onKeyDown={e => e.key === "Escape" && closeSearch()}
						placeholder={`Filter ${scoped.length} sessions`}
						name="filter"
					/>
				</label>
			)}
			{daemonSearch.state === "unsupported" && (
				<div className="side-note" role="status" data-testid="search-note">
					This daemon does not support history search; restart it to update. Matching session names and folders
					only.
				</div>
			)}
			{daemonSearch.state === "failed" && (
				<div className="side-note" role="status" data-testid="search-note">
					History search failed: {daemonSearch.error}. Matching session names and folders only.
				</div>
			)}
			<ul className="side-list">
				{machine &&
					shown.map(s => (
						<li
							key={s.id}
							className={`side-item${selected?.machine === machine.id && s.id === selected.id ? " side-item--on" : ""}${s.id === (selected?.id ?? lastOpened) ? " side-item--recent" : ""}${offline ? (s.replica ? " side-item--cached side-item--replica" : " side-item--cached") : ""}`}
							data-session={s.id}
							data-machine={machine.id}
							data-replica={offline ? s.replica?.state : undefined}
						>
							{renaming?.id === s.id ? (
								<form className="side-rename" onSubmit={e => void rename(e, machine.id)}>
									<input
										autoFocus
										onFocus={e => e.currentTarget.select()}
										value={renaming.draft}
										onChange={e => setRenaming({ id: s.id, draft: e.target.value })}
										onKeyDown={e => e.key === "Escape" && setRenaming(null)}
										onBlur={() => setRenaming(null)}
										name="title"
									/>
								</form>
							) : (
								<button
									type="button"
									className="side-pick"
									onClick={() => onSelect({ machine: machine.id, id: s.id })}
									title={displayPath(s.cwd, machine)}
								>
									<span
										className={`dot dot--${s.attention ?? s.phase}`}
										aria-label={DOT_LABEL[s.attention ?? s.phase]}
										title={DOT_LABEL[s.attention ?? s.phase]}
									/>
									<span className="side-name">
										{s.access === "held" && <Lock size={12} aria-label="open in another omp process" />}{" "}
										{sessionLabel(s)}
										{offline && s.replica && (
											<span
												className="side-replica"
												title={`Copy held by the gateway, as of ${formatAbsolute(s.replica.asOf)}${s.replica.state === "partial" ? " (incomplete: newer data was not copied)" : ""}. Opens read-only.`}
											>
												copy
											</span>
										)}
									</span>
									{s.unread && <span className="side-unread" role="img" aria-label="unread" />}
									<SessionSub session={s} machine={machine} now={now} />
									<span
										className={`side-backend side-backend--${s.backend === "antigravity" ? "agy" : "omp"}`}
										title={s.backend === "antigravity" ? "Antigravity ACP session" : "omp session"}
									>
										{s.backend === "antigravity" ? "agy" : "omp"}
									</span>
									{s.hops && s.hops.length > 0 && (
										<>
											<span className="side-env" data-testid="side-env">
												{environmentLabel(s, machine)}
											</span>
											<HopHistory hops={s.hops} now={now} limit={2} />
										</>
									)}
								</button>
							)}
							{s.handoff?.role === "source" && (
								<button
									type="button"
									className="side-switching"
									data-testid="session-switching"
									title="An environment switch is in progress: show it"
									onClick={() => onOpenHandoff(s.handoff!.id)}
								>
									switching…
								</button>
							)}
							<span className="side-actions icon-row">
								<IconButton
									icon={Pencil}
									label="Rename"
									className="side-x"
									disabled={offline}
									// Keep focus until click so blur cannot cancel and then reopen the editor.
									onMouseDown={e => e.preventDefault()}
									onClick={() =>
										setRenaming(current => (current?.id === s.id ? null : { id: s.id, draft: s.title ?? "" }))
									}
								/>
								{s.access === "hosted" && (
									<IconButton
										icon={X}
										label="Close session"
										danger
										className="side-x"
										disabled={offline}
										onClick={() => void close(machine.id, s.id)}
									/>
								)}
							</span>
						</li>
					))}
				{shown.length === 0 && <li className="side-none">{scoped.length === 0 ? "No sessions" : "No match"}</li>}
			</ul>
			{notice && (
				<div className="form-error" role="alert">
					<span>{notice.text}</span>
					{notice.needsAuth && !accounts.open && (
						<>
							{" "}
							<button type="button" className="btn btn--small" onClick={accounts.onToggle}>
								Open Accounts
							</button>
						</>
					)}
				</div>
			)}
		</aside>
	);
}
