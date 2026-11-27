import { Transcript } from "@oh-my-pi/collab-web/src/components/transcript/Transcript";
import { ArrowDown, LoaderCircle } from "lucide-react";
import {
	defaultCapabilities,
	type Ack,
	type GatewaySessionInfo,
	type HandoffWire,
	type ImageWire,
	type MachineSummary,
	type ModelRolesWire,
	type PermissionMode,
	type SessionBackend,
	type SessionOptions,
} from "@omp-web/protocol";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useEffectEvent,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { ackedSessionId } from "../lib/ack";
import { stripAnsi } from "../lib/ansi";
import { type Selection, withWorktree } from "../lib/environment";
import { appendDraft } from "../lib/attention";
import { presentEntries } from "../lib/custom-messages";
import type { DraftAttachments } from "../lib/draft-attachments";
import { FilesApi } from "../lib/files-data";
import { editKey, editedLines, rootsOfMachine } from "../lib/files-links";
import { type AgentCounts, countRunningAgents } from "../lib/subagents";
import { switchAvailability, visibleHandoff } from "../lib/handoff";
import { loadPermissionModePreference, savePermissionModePreference } from "../lib/new-session";
import { useOmpTheme } from "../lib/use-omp-theme";
import { useReadReport } from "../lib/use-read-report";
import { goalCommand, lastAssistantText, parseWebCommand, withWebCommands } from "../lib/web-commands";
import type { ClientRequest, DaemonClient } from "../store/daemon-client";
import { AgentDrawer } from "./agent-drawer";
import { AgentsPanel } from "./agents-panel";
import { AttentionBar } from "./attention-bar";
import { ProjectPicker, WorktreePicker } from "./project-picker";
import { BtwPanel } from "./btw-panel";
import { Composer } from "./composer";
import { ExtensionWidgets } from "./extension-widgets";
import { useToolPathLinks } from "./files/tool-links";
import { QueueList } from "./queue-list";
import { ReplicaBanner } from "./replica-banner";
import { SessionHeader } from "./session-header";
import { Takeover } from "./takeover";
import { HandoffChip } from "./handoff/handoff-chip";
import { ContextPanel } from "./context-panel";
import { ModelHub } from "./model-hub";
import { StatusLine } from "./status-line";
import { HopHistory } from "./handoff/hop-history";
import { MovedBanner } from "./handoff/moved-banner";
import { TodoPanel } from "./todo-panel";
import { useTranscriptTail } from "./transcript-follow";
import { useTranscriptTimes } from "./transcript-times";
import { UiRequestDialog } from "./ui-request";
import { IconButton } from "./ui/icon-button";

interface Props {
	client: DaemonClient;
	/** Id of the machine the session lives on. */
	machine: string;
	/** That machine as the gateway lists it; undefined until the first `machines` frame. */
	machineInfo: MachineSummary | undefined;
	sessionId: string;
	info: GatewaySessionInfo | undefined;
	/** Navigate to another session of the machine (after a takeover that resolved to a different id). */
	onOpen(sessionId: string): void;
	/** Narrow viewports show the list instead of the session; this leaves the session. */
	onShowList(): void;
	/** Every environment switch the gateway lists. */
	handoffs: readonly HandoffWire[];
	/** Open the "Switch environment" dialog for this session. */
	onSwitch(): void;
	/** Open the dialog of an existing operation (the banner's button). */
	onOpenHandoff(id: string): void;
	/** Start a session as the sidebar's "New session" does and open it (`/new [omp|agy]`); why it did not start, else null. */
	onNewSession(backend?: SessionBackend): Promise<string | null>;
	/** Open the dock at this session's Agents or BTW tab. */
	onShowDock(tab: "agents" | "btw"): void;
	/** The dock's Agents or BTW tab while it is open: the element this view draws that tab into. */
	dockSlot: { tab: "agents" | "btw"; element: HTMLElement } | null;
	/** The dock's toolbar for the header, given the session's sub-agents: how many, how many still running. */
	toolbar(agents: AgentCounts): ReactNode;
	/** The machine's listed sessions (the project menu offers the directories of those outside every project). */
	machineSessions: readonly GatewaySessionInfo[];
	/** An explicit sidebar choice for this session; only a fresh, writable session follows it. */
	relocationTarget: Selection | null;
	/**
	 * This session, still without a message, was replaced by one started in another environment (`id`, with the same
	 * model and thinking level); `draft` and `attachments` are the composer's to carry over.
	 */
	onRelocate(next: {
		id: string;
		target: Selection;
		draft: string;
		attachments: DraftAttachments;
		backend: SessionBackend;
	}): void;
}

/** Slash command output arrives as notices and can be long and multi-line. */
const NOTICE_MAX_CHARS = 2000;
/** How long a sidebar choice must stand before a fresh session moves to it (one move per settled choice, not per click). */
const SIDEBAR_SETTLE_MS = 300;

export function SessionView({
	client,
	machine,
	machineInfo,
	sessionId,
	info,
	handoffs,
	onOpen,
	onShowList,
	onSwitch,
	onOpenHandoff,
	dockSlot,
	toolbar,
	onNewSession,
	onShowDock,
	machineSessions,
	onRelocate,
	relocationTarget,
}: Props): ReactNode {
	const store = client.store(machine, sessionId);
	useEffect(() => {
		client.open(machine, sessionId);
		return () => client.release(machine, sessionId);
	}, [client, machine, sessionId]);
	const { view, draft, attachments, loading, lost, attention, replica } = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
	);
	const status = view.status;
	const promptHistory = useMemo(
		() =>
			view.entries.flatMap(entry => {
				if (entry.type !== "message" || entry.message.role !== "user") return [];
				const content = entry.message.content;
				const text =
					typeof content === "string"
						? content
						: content
								.filter(part => part.type === "text")
								.map(part => part.text)
								.join("\n");
				return text.trim() ? [text] : [];
			}),
		[view.entries],
	);
	const request = view.uiRequests[0];
	const offline = machineInfo?.online === false;
	// Served from the gateway's copy: the machine is offline, so it is read-only and nothing is sent to it.
	const fromReplica = offline && replica !== null;
	// Nothing of the session is loaded, the list says there is a copy, and it has not arrived yet.
	const copyPending = offline && loading && replica === null && info?.replica !== undefined && lost === null;
	useReadReport(client, machine, info, !loading && lost === null && (!offline || fromReplica));
	// Only a session this machine's daemon hosts can be written to (and only while it is reachable); the list tells
	// which one this is (unknown until it arrives). A moved session is history, and one being switched is locked by the
	// operation (the daemon refuses commands).
	const readOnly = offline || info?.access !== "hosted" || info.movedTo !== undefined || info.handoff !== undefined;
	const backend: SessionBackend = status?.backend ?? info?.backend ?? "omp";
	const caps = useMemo(() => status?.capabilities ?? defaultCapabilities(backend), [status?.capabilities, backend]);
	const handoff = visibleHandoff(handoffs, info?.threadId);
	const switchAction = switchAvailability(info, handoffs, machineInfo);
	// omp reports sub-agents to the daemon only while a client watches them: a hosted session on screen does, so the
	// Agents badge counts them with the list closed.
	const agentsWatched = !readOnly && caps.subagents;
	const [modelsOpen, setModelsOpen] = useState(false);
	const [contextAnchor, setContextAnchor] = useState<HTMLButtonElement | null>(null);
	const [roles, setRoles] = useState<ModelRolesWire | null>(null);
	// The machine's omp theme colours, for the status line and the hub (kept when the machine goes offline).
	const themeVars = useOmpTheme(client, machine, offline);
	const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
	const subagent = selectedAgent === null ? undefined : view.subagents.get(selectedAgent);
	// Paths printed by tool cards open in the Files view when they lie inside a registered worktree of this machine.
	const transcriptRef = useRef<HTMLDivElement>(null);
	const rootsKey = rootsOfMachine(machineInfo).join("\n");
	const toolPaths = useMemo(
		() => ({
			roots: rootsKey === "" ? [] : rootsKey.split("\n"),
			cwd: info?.cwd ?? "",
			preferredRoot: info?.worktreeRoot,
		}),
		[rootsKey, info?.cwd, info?.worktreeRoot],
	);
	// Where the session's edits landed; read at click time through a ref so that a new entry does not rebuild the listeners.
	const edited = useRef(new Map<string, number>());
	edited.current = useMemo(() => editedLines(view.entries, toolPaths), [view.entries, toolPaths]);
	const toolLinks = useMemo(
		() => ({
			machine,
			...toolPaths,
			editedLine: (root: string, path: string) => edited.current.get(editKey(root, path)),
			// omp's own URLs (`local://`, `agent://`, …): the session's machine finds the file as the session would.
			locate: async (url: string) => {
				const result = await new FilesApi(client, machine, "").locate(sessionId, url);
				return result.ok ? result.data : { error: result.failure.message };
			},
		}),
		[machine, toolPaths, client, sessionId],
	);
	useToolPathLinks(transcriptRef, toolLinks);
	useTranscriptTimes(transcriptRef);
	const tail = useTranscriptTail(transcriptRef, view.entries.length + (view.stream ? 1 : 0));

	// An extension's title replaces the tab title while this session is shown.
	useEffect(() => {
		if (!view.title) return;
		const previous = document.title;
		document.title = stripAnsi(view.title);
		return () => {
			document.title = previous;
		};
	}, [view.title]);

	// The client re-announces the watch after reconnects.
	useEffect(() => {
		if (!agentsWatched) return;
		client.setAgentsWatched(machine, sessionId, true);
		return () => client.setAgentsWatched(machine, sessionId, false);
	}, [client, machine, sessionId, agentsWatched]);

	// The selected agent can vanish (daemon restart, panel list rebuilt): drop the stale selection.
	useEffect(() => {
		if (selectedAgent !== null && !view.subagents.has(selectedAgent)) setSelectedAgent(null);
	}, [selectedAgent, view.subagents]);

	const closeDrawer = useCallback((): void => setSelectedAgent(null), []);
	const loadModels = useCallback(async (): Promise<string[]> => {
		const ack = await client.request(machine, { t: "session.options", sessionId });
		if (!ack.ok) throw new Error(ack.error);
		return (ack.data as SessionOptions).models.map(m => `${m.provider}/${m.id}`);
	}, [client, machine, sessionId]);
	const openModels = useCallback((): void => setModelsOpen(true), []);
	const openContext = useCallback((anchor: HTMLButtonElement): void => {
		setContextAnchor(current => (current === anchor ? null : anchor));
	}, []);
	const closeContext = useCallback((): void => setContextAnchor(null), []);
	const runCommand = useCallback(
		(message: string) => client.request(machine, { t: "prompt", sessionId, message }),
		[client, machine, sessionId],
	);
	// omp builtins that need its terminal UI (RPC mode refuses them) run here instead: `/new` and `/fork` open another
	// session, as the terminal does; a session command of the same name (an extension's) still goes to omp.
	const commands = useMemo(() => withWebCommands(view.commands, caps), [view.commands, caps]);
	const shownEntries = useMemo(() => presentEntries(view.entries), [view.entries]);
	const local = useCallback(
		(deliver: (message: string, images?: ImageWire[]) => Promise<Ack>) =>
			async (message: string, images?: ImageWire[]): Promise<Ack> => {
				const command = parseWebCommand(message, view.commands, caps);
				if (!command) return deliver(message, images);
				const done: Ack = { t: "ack", reqId: "", ok: true };
				const failed = (error: string): Ack => ({ t: "ack", reqId: "", ok: false, error });
				switch (command.name) {
					case "new": {
						const arg = command.args.trim().toLowerCase();
						const requested: SessionBackend | undefined =
							arg === "agy" || arg === "antigravity" ? "antigravity" : arg === "omp" ? "omp" : undefined;
						if (arg !== "" && requested === undefined) {
							return failed("usage: /new [omp|agy]");
						}
						const error = await onNewSession(requested);
						return error === null ? done : failed(error);
					}
					case "fork": {
						const ack = await client.request(machine, { t: "session.fork", sessionId });
						if (!ack.ok) return ack;
						const forked = ackedSessionId(ack.data);
						if (forked === null) return failed("the daemon did not report the forked session");
						onOpen(forked);
						return ack;
					}
					case "btw": {
						onShowDock("btw");
						if (command.args === "") return done;
						return client.request(machine, { t: "session.btw", sessionId, question: command.args });
					}
					case "queue":
						if (command.args === "") return failed("/queue needs a message");
						return client.request(machine, { t: "follow_up", sessionId, message: command.args });
					case "copy": {
						const reply = lastAssistantText(view.entries);
						if (reply === null) return failed("no assistant reply to copy");
						// `navigator.clipboard` does not exist outside secure contexts (the daemon may be served over plain http).
						if (!navigator.clipboard) return failed("the clipboard is unavailable (not a secure context)");
						try {
							await navigator.clipboard.writeText(reply);
							return done;
						} catch (error) {
							return failed(`could not copy: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					case "hub":
						onShowDock("agents");
						return done;
					case "goal": {
						const goal = goalCommand(command.args, status?.goal);
						if ("error" in goal) return failed(goal.error);
						if (goal.op === "show") return done;
						return client.request(machine, { t: "session.goal", sessionId, ...goal });
					}
					case "loop":
						return client.request(machine, { t: "session.loop", sessionId, args: command.args });
					case "exit": {
						const ack = await client.request(machine, { t: "session.close", sessionId });
						if (ack.ok) onShowList();
						return ack;
					}
				}
			},
		[
			client,
			machine,
			sessionId,
			view.commands,
			view.entries,
			caps,
			status?.goal,
			onNewSession,
			onOpen,
			onShowDock,
			onShowList,
		],
	);
	// The roles behind the status line's toggles; read again when the hub (which can change them) closes.
	const loadRoles = useCallback((): void => {
		void client.request(machine, { t: "session.roles", sessionId }).then(ack => {
			if (ack.ok) setRoles(ack.data as ModelRolesWire);
		});
	}, [client, machine, sessionId]);
	const hosted = !readOnly && !loading;
	// Until its first message a session can still move to another project or worktree (as a new session there: omp's
	// directory is fixed for a process). The status line offers it in place of the directory.
	const fresh = hosted && !view.working && !view.entries.some(e => e.type === "message");
	const here: Selection = { machine, project: info?.projectRoot ?? "", worktree: info?.worktreeRoot ?? "" };
	const [moveError, setMoveError] = useState<string | null>(null);
	// The omp ⇄ agy toggle's pending move (starting the other agent takes seconds), by the move generation that started it.
	const [switching, setSwitching] = useState<{ generation: number; to: SessionBackend } | null>(null);
	// Failures of the status line's goal and loop actions (the composer shows those of `/goal` and `/loop`).
	const [modeError, setModeError] = useState<string | null>(null);
	const modeAction = (message: ClientRequest): void => {
		setModeError(null);
		void client.request(machine, message).then(ack => {
			if (!ack.ok) setModeError(ack.error);
		});
	};
	// Only the latest move counts: each call (and each sidebar change, and unmounting) starts a new generation, and a
	// create that finishes under an older one closes what it made instead of moving there.
	const moveGeneration = useRef(0);
	const relocate = async (target: Selection, nextBackend: SessionBackend = backend): Promise<void> => {
		const generation = ++moveGeneration.current;
		const samePlace = target.machine === machine && target.worktree === here.worktree;
		const sameBackend = nextBackend === backend;
		if (!fresh || !target.machine || target.worktree === "" || (samePlace && sameBackend)) return;
		setMoveError(null);
		if (!sameBackend) setSwitching({ generation, to: nextBackend });
		const model =
			sameBackend && status?.model
				? status.thinkingLevel
					? `${status.model}:${status.thinkingLevel}`
					: status.model
				: undefined;
		const permMode =
			nextBackend === "antigravity"
				? (status?.permissionMode ??
					loadPermissionModePreference(typeof localStorage === "undefined" ? undefined : localStorage))
				: undefined;
		const created = await client
			.request(target.machine, {
				t: "session.create",
				cwd: target.worktree,
				...(model ? { model } : {}),
				...(nextBackend !== "omp" ? { backend: nextBackend } : {}),
				...(permMode ? { permissionMode: permMode } : {}),
			})
			.finally(() => setSwitching(s => (s?.generation === generation ? null : s)));
		const id = created.ok ? ackedSessionId(created.data) : null;
		if (generation !== moveGeneration.current) {
			if (id !== null) void client.request(target.machine, { t: "session.close", sessionId: id });
			return;
		}
		if (id === null) {
			setMoveError(created.ok ? "the daemon did not report the new session" : created.error);
			return;
		}
		// The empty session here is not needed any more.
		void client.request(machine, { t: "session.close", sessionId });
		onRelocate({ id, target, draft, attachments, backend: nextBackend });
	};
	const followSidebar = useEffectEvent((target: Selection): void => {
		void relocate(target);
	});
	// Sidebar switches settle first, so flipping through machines starts no session per click; a change (even to a
	// selection with nowhere to move) drops any move still running.
	useEffect(() => {
		moveGeneration.current++;
		if (!relocationTarget) return;
		const timer = setTimeout(() => followSidebar(relocationTarget), SIDEBAR_SETTLE_MS);
		return () => clearTimeout(timer);
	}, [relocationTarget]);
	useEffect(
		() => () => {
			moveGeneration.current++;
		},
		[],
	);
	useEffect(() => {
		if (hosted && caps.roles) loadRoles();
		else setRoles(null);
	}, [hosted, caps.roles, loadRoles]);
	const closeModels = useCallback((): void => {
		setModelsOpen(false);
		loadRoles();
	}, [loadRoles]);
	const switchRole = useCallback((role: string): void => void runCommand(`/switch @${role}`), [runCommand]);
	const withImages = (images: ImageWire[] | undefined) => (images ? { images } : {});
	// omp's effort levels, as its `/effort` command lists them: what a model role's `:thinking` suffix may be.
	const effortLevels = useMemo(
		() => view.commands.find(c => c.name === "effort")?.subcommands?.map(s => s.name) ?? [],
		[view.commands],
	);

	return (
		<div className="session" style={themeVars}>
			<SessionHeader
				client={client}
				machine={machine}
				machineInfo={machineInfo}
				sessionId={sessionId}
				info={info}
				view={view}
				readOnly={readOnly}
				toolbar={toolbar({ total: view.subagents.size, running: countRunningAgents(view.subagents) })}
				onShowList={onShowList}
				switchAction={switchAction}
				onSwitch={onSwitch}
				onOpenModels={openModels}
				capabilities={caps}
			/>
			{fromReplica && <ReplicaBanner machine={machineInfo.name} replica={replica} now={Date.now()} />}
			{info?.movedTo && <MovedBanner movedTo={info.movedTo} now={Date.now()} />}
			{handoff && <HandoffChip wire={handoff} onOpen={onOpenHandoff} />}
			{info?.hops && info.hops.length > 0 && (
				<div className="hop-strip">
					<HopHistory hops={info.hops} now={Date.now()} limit={10} />
				</div>
			)}
			{offline && !fromReplica && !copyPending && (
				<div className="banner banner--offline" role="status">
					Machine {machineInfo.name} is offline.{" "}
					{loading
						? "This session's transcript is not available until it reconnects."
						: "Showing the last transcript received; it updates when the machine reconnects."}
				</div>
			)}
			{lost && <div className="banner banner--err">Session unavailable: {lost}</div>}
			{info?.access === "held" && (
				<div className="banner banner--warn" role="status">
					Open in another omp process (for example the terminal UI), so omp-web shows it read-only. The transcript
					follows the file as that process writes; take it over once that process has exited.
				</div>
			)}
			{info?.access === "free" && !offline && !info.movedTo && !info.handoff && (
				<Takeover client={client} machine={machine} sessionId={sessionId} backend={backend} onOpen={onOpen} />
			)}
			{view.closed !== null && <div className="banner banner--err banner--pre">Session ended: {view.closed}</div>}
			{view.closed !== null && !readOnly && (
				<Takeover
					client={client}
					machine={machine}
					sessionId={sessionId}
					backend={backend}
					prompt="The agent process is gone; the conversation is saved. Resume it in a new process to continue."
					action="Resume"
					onOpen={onOpen}
				/>
			)}
			<div className="session-body">
				<div className="session-main">
					<div className="session-transcript" ref={transcriptRef}>
						{offline && loading ? (
							<div className="session-offline-empty">
								{copyPending
									? `Loading the gateway's copy of the transcript of ${machineInfo.name}…`
									: `Transcript unavailable while ${machineInfo.name} is offline.`}
							</div>
						) : (
							<>
								<Transcript
									entries={shownEntries}
									stream={view.stream}
									streamDone={view.streamDone}
									activeTools={view.activeTools}
									working={view.working}
									phase={loading ? "connecting" : "live"}
								/>
								{tail.unread && (
									<IconButton
										icon={ArrowDown}
										label="Jump to latest"
										className="transcript-jump"
										onClick={tail.jump}
									/>
								)}
							</>
						)}
					</div>
					{view.notices.length > 0 && (
						<ul className="notices">
							{view.notices.slice(-3).map(n => (
								<li key={`${n.at}:${n.message}`} className={`notice notice--${n.level}`}>
									{n.message.length > NOTICE_MAX_CHARS
										? `${n.message.slice(0, NOTICE_MAX_CHARS)}…`
										: n.message}
								</li>
							))}
						</ul>
					)}
					{status && <TodoPanel todos={status.todos} />}
					<ExtensionWidgets widgets={view.widgets} placement="aboveEditor" />
					{!readOnly && (
						<AttentionBar
							items={attention}
							onUseText={text => store.setDraft(appendDraft(store.getSnapshot().draft, text))}
							onDismiss={id => store.dismissAttention(id)}
						/>
					)}
					{status && (
						<QueueList
							queue={status.queue}
							onRemove={
								readOnly
									? undefined
									: (message, queue) =>
											client.request(machine, { t: "queue.remove", sessionId, message, queue })
							}
						/>
					)}
					{readOnly ? null : request ? (
						<div className="ui-request-wrap">
							<UiRequestDialog
								key={request.id}
								request={request}
								onRespond={response =>
									void client.request(machine, {
										t: "ui.response",
										sessionId,
										requestId: request.id,
										response,
									})
								}
							/>
							{backend === "antigravity" && status?.permissionMode !== "auto" && (
								<div className="ui-perm-bar" data-testid="ui-perm-quick-actions">
									<span className="faint">Tired of confirming?</span>
									{status?.permissionMode !== "edits" && (
										<button
											type="button"
											className="btn btn--small btn--ghost"
											data-testid="ui-perm-edits"
											onClick={() => {
												const next: PermissionMode = "edits";
												savePermissionModePreference(
													typeof localStorage === "undefined" ? undefined : localStorage,
													next,
												);
												void client.request(machine, {
													t: "session.set_permission_mode",
													sessionId,
													mode: next,
												});
											}}
										>
											Auto-approve edits
										</button>
									)}
									<button
										type="button"
										className="btn btn--small"
										data-testid="ui-perm-auto"
										onClick={() => {
											const next: PermissionMode = "auto";
											savePermissionModePreference(
												typeof localStorage === "undefined" ? undefined : localStorage,
												next,
											);
											void client.request(machine, {
												t: "session.set_permission_mode",
												sessionId,
												mode: next,
											});
										}}
									>
										Auto-approve all in session
									</button>
								</div>
							)}
						</div>
					) : (
						<Composer
							key={`${machine}:${sessionId}`}
							history={promptHistory}
							working={view.working}
							disabled={loading || lost !== null || view.closed !== null}
							draft={draft}
							attachments={attachments}
							onDraftChange={store.setDraft}
							commands={commands}
							loadModels={loadModels}
							onOpenModels={openModels}
							onPrompt={local((message, images) =>
								client.request(machine, { t: "prompt", sessionId, message, ...withImages(images) }),
							)}
							onSteer={local((message, images) =>
								client.request(machine, { t: "steer", sessionId, message, ...withImages(images) }),
							)}
							onFollowUp={local((message, images) =>
								client.request(machine, { t: "follow_up", sessionId, message, ...withImages(images) }),
							)}
							onAbort={() => void client.request(machine, { t: "abort", sessionId })}
							canSteer={caps.steer}
							canOpenModels={caps.roles}
							agentLabel={backend === "antigravity" ? "Antigravity" : "omp"}
						/>
					)}
					{status && (
						<StatusLine
							machineInfo={machineInfo}
							location={
								fresh && machineInfo ? (
									<>
										{machineInfo.antigravity?.available && (
											<button
												type="button"
												className={`chip chip--button status-backend-btn${backend === "antigravity" ? " status-backend-btn--agy" : ""}${switching ? " status-backend-btn--switching" : ""}`}
												data-testid="fresh-backend-switch"
												disabled={switching !== null}
												aria-busy={switching !== null || undefined}
												title={
													switching
														? `Starting a ${switching.to === "antigravity" ? "Antigravity" : "omp"} session…`
														: backend === "antigravity"
															? "Switch this empty session to omp (keeps your draft)"
															: "Switch this empty session to Antigravity (keeps your draft)"
												}
												onClick={() =>
													void relocate(here, backend === "antigravity" ? "omp" : "antigravity")
												}
											>
												{switching ? (
													<>
														<LoaderCircle aria-hidden="true" />
														switching to {switching.to === "antigravity" ? "agy" : "omp"}…
													</>
												) : backend === "antigravity" ? (
													"agy"
												) : (
													"omp"
												)}
											</button>
										)}
										<ProjectPicker
											client={client}
											machine={machineInfo}
											target={here}
											sessions={machineSessions}
											onSelection={next => void relocate(withWorktree(machineInfo, next))}
											placement="up"
										/>
										<WorktreePicker
											machine={machineInfo}
											target={here}
											onSelection={next => void relocate(next)}
											placement="up"
										/>
									</>
								) : undefined
							}
							status={status}
							roles={caps.roles ? roles : null}
							thinkingLevels={effortLevels}
							onUseRole={readOnly || !caps.roles ? undefined : switchRole}
							onOpenModels={readOnly || !caps.roles ? undefined : openModels}
							onOpenContext={readOnly || !caps.context ? undefined : openContext}
							onGoal={
								readOnly || !caps.goal ? undefined : op => modeAction({ t: "session.goal", sessionId, op })
							}
							onLoopOff={
								readOnly || !caps.loop
									? undefined
									: () => modeAction({ t: "session.loop", sessionId, args: "" })
							}
						/>
					)}
					{moveError && (
						<div className="form-error session-move-error" role="alert">
							{moveError}
						</div>
					)}
					{modeError && (
						<div className="form-error session-move-error" role="alert">
							{modeError}
						</div>
					)}
					<ExtensionWidgets widgets={view.widgets} placement="belowEditor" />
				</div>
				{dockSlot?.tab === "btw" &&
					createPortal(
						<BtwPanel
							client={client}
							machine={machine}
							sessionId={sessionId}
							topics={view.btw}
							readOnly={readOnly}
						/>,
						dockSlot.element,
					)}
				{dockSlot?.tab === "agents" &&
					createPortal(
						readOnly ? (
							<div className="dock-empty">Sub-agents are listed for sessions omp-web hosts.</div>
						) : (
							<AgentsPanel subagents={view.subagents} selectedId={selectedAgent} onSelect={setSelectedAgent} />
						),
						dockSlot.element,
					)}
			</div>
			{subagent && (
				<AgentDrawer
					client={client}
					machine={machine}
					sessionId={sessionId}
					subagent={subagent}
					onClose={closeDrawer}
				/>
			)}
			{contextAnchor && !readOnly && caps.context && (
				<ContextPanel
					client={client}
					machine={machine}
					sessionId={sessionId}
					entries={view.entries}
					anchor={contextAnchor}
					onClose={closeContext}
				/>
			)}
			{modelsOpen && !readOnly && caps.roles && (
				<ModelHub
					client={client}
					machine={machine}
					sessionId={sessionId}
					model={status?.model}
					thinkingLevel={status?.thinkingLevel}
					onRun={runCommand}
					onClose={closeModels}
				/>
			)}
		</div>
	);
}
