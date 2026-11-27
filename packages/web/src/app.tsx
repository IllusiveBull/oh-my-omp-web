import { defaultCapabilities, type GitStatus, type SessionBackend } from "@omp-web/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AccountsPanel } from "./components/accounts-panel";
import { Banners } from "./components/banners";
import { Dock, DockToolbar } from "./components/dock";
import { FilesView } from "./components/files/files-view";
import { SwitchEnvironment, type SwitchTarget } from "./components/handoff/switch-environment";
import { useHandoffNavigation } from "./components/handoff/use-handoff-navigation";
import { ImageViewer } from "./components/image-viewer";
import { SessionList } from "./components/session-list";
import { SessionView } from "./components/session-view";
import { TerminalNav } from "./components/terminal/terminal-nav";
import { TerminalView } from "./components/terminal/terminal-view";
import { UsageMenu } from "./components/usage-menu";
import { accountsAttention } from "./lib/accounts";
import { listedSessions } from "./lib/handoff";
import {
	loadSelection,
	newSessionTarget,
	resolveSelection,
	type Selection,
	saveSelection,
	startSelection,
} from "./lib/environment";
import {
	type AppRoute,
	type DockRoute,
	type DockTab,
	type FilesRef,
	type MainRoute,
	parseRoute,
	routeHash,
	type SessionRef,
	type TerminalRef,
} from "./lib/route";
import { changeStats, describeBranch } from "./lib/files";
import { useCloseSeenNotifications } from "./lib/seen-notifications";
import {
	loadBackendPreference,
	loadPermissionModePreference,
	saveBackendPreference,
	startSession,
} from "./lib/new-session";
import { usePresence } from "./lib/use-presence";
import type { AgentCounts } from "./lib/subagents";
import { useWorktreeStatus } from "./lib/use-worktree-status";
import type { DaemonClient } from "./store/daemon-client";
import { terminalsOf } from "./store/terminal-client";

/**
 * Shows `next`. `replace` rewrites the current history entry (switching a tab inside a view) instead of adding one;
 * rewriting does not fire `hashchange`, so the app is told directly.
 */
function go(next: AppRoute, how: "push" | "replace" = "push"): void {
	const hash = routeHash(next);
	if (how === "push") {
		location.hash = hash;
		return;
	}
	history.replaceState(history.state, "", hash === "" ? location.pathname + location.search : hash);
	window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** The dock with its target dropped, so it follows the new context (another session's worktree and machine). */
function unpinned(dock: DockRoute | null): DockRoute | null {
	return dock === null || dock.tab === "agents" || dock.tab === "btw" ? dock : { tab: dock.tab, ref: null };
}

export function App({ client }: { client: DaemonClient }): ReactNode {
	const daemon = useSyncExternalStore(client.subscribe, client.getSnapshot);
	const [route, setRoute] = useState<AppRoute>(() => parseRoute(location.hash));
	// What the user chose; the effective selection is repaired against the machines known now, so a machine list that
	// arrives late (or a project that vanished) never overwrites the stored choice.
	const [stored, setStored] = useState<Selection | null>(() => loadSelection(localStorage));
	const [backend, setBackendState] = useState<SessionBackend>(() => loadBackendPreference(localStorage));
	const setBackend = useCallback((next: SessionBackend): void => {
		setBackendState(next);
		saveBackendPreference(localStorage, next);
	}, []);
	const selection = useMemo(
		() => resolveSelection(daemon.machines, stored, daemon.hello?.machine ?? null),
		[daemon.machines, daemon.hello, stored],
	);
	const selected = route.main?.kind === "session" ? route.main.ref : null;
	const [relocation, setRelocation] = useState<{ source: SessionRef; target: Selection } | null>(null);
	const { dock } = route;

	usePresence(client, selected);
	const [dialog, setDialog] = useState<SwitchTarget | null>(null);
	const confirmedHere = useRef(new Set<string>());
	const closeDialog = useCallback((): void => setDialog(null), []);
	const openHandoff = useCallback((id: string): void => setDialog({ kind: "handoff", id }), []);
	useHandoffNavigation(
		daemon.handoffs,
		confirmedHere.current,
		useCallback((to: SessionRef): void => {
			setDialog(null);
			go({ main: { kind: "session", ref: to }, dock: unpinned(parseRoute(location.hash).dock) });
		}, []),
	);

	useEffect(() => {
		const onHash = (): void => setRoute(parseRoute(location.hash));
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	// Navigation reads the location rather than `route`: two steps in one event (a tab switch, then a file) must see
	// each other.
	const showMain = useCallback((main: MainRoute): void => {
		const current = parseRoute(location.hash);
		const switching = main?.kind === "session" && current.main?.kind === "session";
		go({ main, dock: switching ? unpinned(current.dock) : current.dock });
	}, []);
	const select = useCallback(
		(ref: SessionRef | null): void => showMain(ref ? { kind: "session", ref } : null),
		[showMain],
	);
	// Closing the Accounts page (its button, or the sidebar key again) returns to the view it was opened from.
	const beforeAccounts = useRef<MainRoute>(null);
	const toggleAccounts = useCallback((): void => {
		const current = parseRoute(location.hash).main;
		if (current?.kind === "accounts") {
			showMain(beforeAccounts.current);
			return;
		}
		beforeAccounts.current = current;
		showMain({ kind: "accounts" });
	}, [showMain]);
	const showDock = useCallback((next: DockRoute | null, how: "push" | "replace" = "push"): void => {
		go({ main: parseRoute(location.hash).main, dock: next }, how);
	}, []);
	const toggleDock = useCallback(
		(tab: DockTab): void => {
			const current = parseRoute(location.hash).dock;
			if (current?.tab === tab) showDock(null);
			else if (tab === "agents" || tab === "btw") showDock({ tab });
			else if (tab === "terminal") showDock({ tab, ref: null });
			else {
				// Files and Changes are two lists of one worktree: switching keeps the file that is open.
				const keep = current?.tab === "files" || current?.tab === "changes" ? current.ref : null;
				showDock({ tab, ref: keep });
			}
		},
		[showDock],
	);

	const focus = useCallback((next: Selection): void => {
		setStored(next);
		saveSelection(localStorage, next);
		// Without a session the dock follows the selector: another worktree (or machine) opens at its own root.
		const current = parseRoute(location.hash);
		if (current.main?.kind !== "session" && current.dock && "ref" in current.dock) {
			go({ main: current.main, dock: unpinned(current.dock) }, "replace");
		}
	}, []);
	const choose = useCallback(
		(next: Selection): void => {
			focus(next);
			const source = parseRoute(location.hash).main;
			const machine = daemon.machines.find(m => m.id === next.machine);
			const target = startSelection(machine, next, listedSessions(daemon.sessions[next.machine ?? ""] ?? []));
			setRelocation(
				source?.kind === "session" && newSessionTarget(machine, target).ok ? { source: source.ref, target } : null,
			);
		},
		[daemon.machines, daemon.sessions, focus],
	);
	// `/new [omp|agy]` in a session: what the sidebar's "New session" does, at the same place.
	const newSession = async (overrideBackend?: SessionBackend): Promise<string | null> => {
		const machine = daemon.machines.find(m => m.id === selection.machine);
		const start = startSelection(machine, selection, listedSessions(daemon.sessions[selection.machine ?? ""] ?? []));
		const target = newSessionTarget(machine, start);
		if (!machine || !target.ok) return target.ok ? "No machine selected." : target.reason;
		const effective: SessionBackend = overrideBackend ?? (machine.antigravity?.available ? backend : "omp");
		if (effective === "antigravity" && !machine.antigravity?.available) {
			return `Antigravity (agy) is not available on ${machine.name}.`;
		}
		const permMode = effective === "antigravity" ? loadPermissionModePreference(localStorage) : undefined;
		const started = await startSession(client, machine.id, target.cwd, effective, permMode);
		if (!started.ok) return started.error;
		select({ machine: machine.id, id: started.id });
		return null;
	};

	const info = selected ? daemon.sessions[selected.machine]?.find(s => s.id === selected.id) : undefined;
	useCloseSeenNotifications(info?.threadId);

	// What the dock works on: the open session's machine and worktree (when the session is in a registered one), else
	// the environment selector's.
	const context: Selection =
		selected && info?.projectRoot && info.worktreeRoot
			? { machine: selected.machine, project: info.projectRoot, worktree: info.worktreeRoot }
			: selected
				? { ...selection, machine: selected.machine }
				: selection;
	const contextMachine = daemon.machines.find(m => m.id === context.machine);
	const filesRef: FilesRef | null =
		dock && (dock.tab === "files" || dock.tab === "changes")
			? (dock.ref ??
				(context.machine && context.worktree
					? { machine: context.machine, root: context.worktree, path: "" }
					: null))
			: null;
	const filesBlocked = "Pick a project and worktree in the sidebar.";
	const blocked: Partial<Record<DockTab, string>> = {};
	const sessionCaps = defaultCapabilities(info?.backend ?? "omp");
	if (!selected) {
		blocked.agents = "Open a session to see its sub-agents.";
		blocked.btw = "Open a session to ask it a side question.";
	} else {
		if (!sessionCaps.subagents) blocked.agents = "Sub-agents are not available for Antigravity sessions.";
		if (!sessionCaps.btw) blocked.btw = "BTW side questions are not available for Antigravity sessions.";
	}
	if (!(context.machine && context.worktree)) {
		blocked.files = filesBlocked;
		blocked.changes = filesBlocked;
	}

	// The session's own tabs are drawn by its view (which holds their state), through a portal into this element.
	const [sessionSlot, setSessionSlot] = useState<HTMLElement | null>(null);
	// The Changes button's worktree: the Files view's while it is open (it reports each status it loads), else the
	// context's, polled here.
	const [reported, setReported] = useState<{ machine: string; root: string; status: GitStatus | null } | null>(null);
	const changesTarget = filesRef
		? { machine: filesRef.machine, root: filesRef.root }
		: context.machine && context.worktree
			? { machine: context.machine, root: context.worktree }
			: null;
	const polled = useWorktreeStatus(client, changesTarget, !filesRef && contextMachine?.online !== false);
	const worktreeStatus = filesRef
		? reported?.machine === filesRef.machine && reported.root === filesRef.root
			? reported.status
			: null
		: polled;
	const changes = changesTarget ? changeStats(worktreeStatus) : undefined;
	const filesMachine = filesRef?.machine;
	const filesRoot = filesRef?.root;
	const reportStatus = useCallback(
		(status: GitStatus | null): void => {
			if (filesMachine !== undefined && filesRoot !== undefined) {
				setReported({ machine: filesMachine, root: filesRoot, status });
			}
		},
		[filesMachine, filesRoot],
	);
	// The Terminal badge counts the running shells of the machine in context (the machine the Terminal tab opens on).
	const terminals = terminalsOf(client);
	const terminalsState = useSyncExternalStore(terminals.subscribe, terminals.getSnapshot);
	const terminalMachine = contextMachine?.id ?? null;
	useEffect(
		() => (terminalMachine === null ? undefined : terminals.watch(terminalMachine)),
		[terminals, terminalMachine],
	);
	const runningTerminals =
		terminalMachine === null
			? 0
			: (terminalsState.machines[terminalMachine]?.terminals.filter(t => t.state === "running").length ?? 0);
	const toolbar = (agents: AgentCounts = { total: 0, running: 0 }): ReactNode => (
		<>
			<UsageMenu
				client={client}
				auth={daemon.auth}
				machines={daemon.machines}
				onSeeAll={() => {
					if (parseRoute(location.hash).main?.kind !== "accounts") toggleAccounts();
				}}
			/>
			<DockToolbar
				open={dock?.tab ?? null}
				onToggle={toggleDock}
				blocked={blocked}
				agents={agents}
				terminals={runningTerminals}
				changes={changes}
				branch={worktreeStatus ? describeBranch(worktreeStatus.branch) : undefined}
			/>
		</>
	);

	const machine = daemon.machines.find(m => m.id === (selected?.machine ?? context.machine));
	const terminalRef: TerminalRef | null = dock?.tab === "terminal" ? dock.ref : null;

	const dockBody = (): ReactNode => {
		if (!dock) return null;
		if (dock.tab === "agents" || dock.tab === "btw") {
			return selected ? (
				<div key={dock.tab} className={`dock-${dock.tab}`} ref={setSessionSlot} />
			) : (
				<div className="dock-empty">{blocked[dock.tab]}</div>
			);
		}
		if (dock.tab === "terminal") {
			return terminalRef ? (
				<TerminalView
					key={`${terminalRef.machine}/${terminalRef.id}`}
					terminals={terminals}
					machine={terminalRef.machine}
					machineInfo={daemon.machines.find(m => m.id === terminalRef.machine)}
					terminalId={terminalRef.id}
					selection={context}
					onSelect={id =>
						showDock({ tab: "terminal", ref: id === null ? null : { machine: terminalRef.machine, id } })
					}
				/>
			) : contextMachine ? (
				<TerminalNav
					terminals={terminals}
					machine={contextMachine}
					selection={context}
					selected={null}
					onOpen={ref => showDock({ tab: "terminal", ref })}
				/>
			) : (
				<div className="dock-empty">Pick a machine in the sidebar.</div>
			);
		}
		if (!filesRef) return <div className="dock-empty">{filesBlocked}</div>;
		return (
			<FilesView
				key={`${filesRef.machine}\0${filesRef.root}`}
				client={client}
				machine={filesRef.machine}
				machineInfo={daemon.machines.find(m => m.id === filesRef.machine)}
				root={filesRef.root}
				path={filesRef.path}
				line={filesRef.line}
				diff={filesRef.diff}
				tab={dock.tab === "changes" ? "changes" : "tree"}
				onTab={tab => showDock({ tab: tab === "changes" ? "changes" : "files", ref: filesRef }, "replace")}
				onStatus={reportStatus}
				onNavigate={(ref, how) => {
					const tab = parseRoute(location.hash).dock?.tab === "changes" ? "changes" : "files";
					showDock({ tab, ref }, how);
				}}
			/>
		);
	};

	const appClass = ["app", (route.main || dock) && "app--session", dock && "app--dock"].filter(Boolean).join(" ");

	return (
		<div className={appClass}>
			<SessionList
				client={client}
				machines={daemon.machines}
				sessions={daemon.sessions}
				selection={selection}
				selected={selected}
				onSelection={choose}
				onSelect={select}
				accounts={{
					open: route.main?.kind === "accounts",
					attention: accountsAttention(daemon.auth.broker, daemon.machines),
					onToggle: toggleAccounts,
				}}
				onOpenHandoff={openHandoff}
				backend={backend}
			/>
			<div className="app-main">
				<Banners phase={daemon.phase} machine={machine} />
				{selected ? (
					<SessionView
						key={`${selected.machine}/${selected.id}`}
						client={client}
						machine={selected.machine}
						machineInfo={daemon.machines.find(m => m.id === selected.machine)}
						sessionId={selected.id}
						info={info}
						onOpen={id => select({ machine: selected.machine, id })}
						onShowList={() => go({ main: null, dock: null })}
						handoffs={daemon.handoffs}
						onSwitch={() =>
							setDialog({
								kind: "plan",
								machine: selected.machine,
								sessionId: selected.id,
								title: info?.title ?? info?.preview,
							})
						}
						onOpenHandoff={openHandoff}
						onNewSession={newSession}
						onShowDock={tab => showDock({ tab })}
						machineSessions={listedSessions(daemon.sessions[selected.machine] ?? [])}
						relocationTarget={
							relocation?.source.machine === selected.machine && relocation.source.id === selected.id
								? relocation.target
								: null
						}
						onRelocate={next => {
							const targetMachine = next.target.machine!;
							client.store(targetMachine, next.id).setDraft(next.draft, next.attachments);
							// The sidebar follows a focused project there so the list shows the new session; "All projects"
							// already lists it and stays as it is.
							if (selection.project !== "") focus(next.target);
							setBackend(next.backend);
							setRelocation(null);
							select({ machine: targetMachine, id: next.id });
						}}
						dockSlot={
							sessionSlot && (dock?.tab === "agents" || dock?.tab === "btw")
								? { tab: dock.tab, element: sessionSlot }
								: null
						}
						toolbar={toolbar}
					/>
				) : (
					<>
						<header className="app-bar">{toolbar()}</header>
						{route.main?.kind === "accounts" ? (
							<AccountsPanel
								client={client}
								auth={daemon.auth}
								machines={daemon.machines}
								onClose={toggleAccounts}
							/>
						) : (
							<div className="app-empty">Create or pick a session from the list.</div>
						)}
					</>
				)}
			</div>
			{dock && (
				<Dock tab={dock.tab} onClose={() => showDock(null)}>
					{dockBody()}
				</Dock>
			)}
			{dialog && (
				<SwitchEnvironment
					client={client}
					machines={daemon.machines}
					handoffs={daemon.handoffs}
					target={dialog}
					onClose={closeDialog}
					confirmedHere={confirmedHere.current}
				/>
			)}
			<ImageViewer />
		</div>
	);
}
