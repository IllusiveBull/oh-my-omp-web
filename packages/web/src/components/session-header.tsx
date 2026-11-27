import type {
	MachineSummary,
	PermissionMode,
	SessionCapabilities,
	SessionInfo,
	SessionOptions,
	SessionView,
} from "@omp-web/protocol";
import { ArrowRightLeft, ChevronLeft, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { stripAnsi } from "../lib/ansi";
import { displayPath } from "../lib/environment";
import type { SwitchAvailability } from "../lib/handoff";
import { ModelSearch, modelRef } from "../lib/model-search";
import { savePermissionModePreference } from "../lib/new-session";
import { sessionLabel } from "../lib/session-label";
import type { ClientRequest, DaemonClient } from "../store/daemon-client";
import { ChipMenu } from "./chip-menu";
import { ompColor, ThinkingSector, thinkingToken } from "./status-line";
import { IconButton } from "./ui/icon-button";

interface Props {
	client: DaemonClient;
	machine: string;
	machineInfo?: MachineSummary;
	sessionId: string;
	info: SessionInfo | undefined;
	view: SessionView;
	/** Not hosted by this daemon: nothing can be changed. */
	readOnly: boolean;
	/** The dock's toolbar, shown at the right end of the headline. */
	toolbar: ReactNode;
	onShowList(): void;
	/** Whether "Switch environment" can be offered, and why not when it cannot. */
	switchAction: SwitchAvailability;
	onSwitch(): void;
	/** Opens the model hub (roles). */
	onOpenModels(): void;
	capabilities?: SessionCapabilities;
}

const PERMISSION_MODES: readonly { mode: PermissionMode; label: string; description: string }[] = [
	{ mode: "ask", label: "ask", description: "Ask before running tools" },
	{ mode: "edits", label: "edits", description: "Auto-approve reads & edits; ask for commands/deletes" },
	{ mode: "auto", label: "auto", description: "Auto-approve all tool permission requests" },
];

export function SessionHeader({
	client,
	machine,
	machineInfo,
	sessionId,
	info,
	view,
	readOnly,
	toolbar,
	onShowList,
	switchAction,
	onSwitch,
	onOpenModels,
	capabilities,
}: Props): ReactNode {
	const status = view.status;
	const [options, setOptions] = useState<SessionOptions | null>(null);
	const [optionsError, setOptionsError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [switchAlert, setSwitchAlert] = useState<string | null>(null);
	const queued = status ? status.queue.steering.length + status.queue.followUp.length : 0;

	// Clear any switch-environment alert when switching sessions or when switching becomes available / reason changes.
	useEffect(() => {
		setSwitchAlert(null);
	}, [machine, sessionId, switchAction.ok, switchAction.reason]);

	useEffect(() => {
		if (!switchAlert) return;
		const timer = setTimeout(() => setSwitchAlert(null), 6000);
		return () => clearTimeout(timer);
	}, [switchAlert]);

	const loadOptions = (): void => {
		setFilter("");
		setOptionsError(null);
		void client.request(machine, { t: "session.options", sessionId }).then(ack => {
			if (ack.ok) setOptions(ack.data as SessionOptions);
			else setOptionsError(ack.error);
		});
	};

	const run = async (request: ClientRequest): Promise<void> => {
		setError(null);
		const ack = await client.request(machine, request);
		if (!ack.ok) setError(ack.error);
	};

	const search = useMemo(
		() => new ModelSearch(options?.models ?? [], { currentModel: status?.model }),
		[options, status?.model],
	);
	const models = useMemo(() => search.rank(filter), [search, filter]);

	return (
		<header className="session-head">
			<div className="session-headline">
				<IconButton icon={ChevronLeft} label="Sessions" className="session-back" onClick={onShowList} />
				<div className="session-title">{sessionLabel(info, status?.sessionName)}</div>
				{view.title && <div className="session-ext-title">{stripAnsi(view.title)}</div>}
				<div className="session-tools">{toolbar}</div>
			</div>
			<div className="session-meta">
				<span className="session-cwd" title={displayPath(status?.cwd ?? info?.cwd ?? "", machineInfo)}>
					{displayPath(status?.cwd ?? info?.cwd ?? "", machineInfo)}
				</span>
				{status?.model &&
					(readOnly ? (
						<span className="chip">session: {status.model}</span>
					) : (
						<ChipMenu
							label={`session: ${status.model}`}
							title="Change this session's model (not saved to settings)"
							onOpen={loadOptions}
						>
							{close => (
								<>
									{optionsError && <div className="form-error">{optionsError}</div>}
									{!options && !optionsError && <div className="faint">Loading…</div>}
									{options && (
										<input
											className="chip-filter"
											value={filter}
											onChange={e => setFilter(e.target.value)}
											placeholder={`Filter ${options.models.length} models`}
											name="model-filter"
											autoFocus
										/>
									)}
									<div className="chip-list" role="listbox" aria-label="Models">
										{models.map(m => (
											<button
												key={modelRef(m)}
												type="button"
												role="option"
												aria-selected={modelRef(m) === status.model}
												className="chip-option"
												onClick={() => {
													close();
													void run({
														t: "session.set_model",
														sessionId,
														provider: m.provider,
														modelId: m.id,
													});
												}}
											>
												{modelRef(m)}
											</button>
										))}
										{options && models.length === 0 && <div className="faint">No match</div>}
									</div>
									{capabilities?.roles !== false && (
										<button
											type="button"
											className="chip-option chip-option--action"
											onClick={() => {
												close();
												onOpenModels();
											}}
										>
											Model roles (all sessions)…
										</button>
									)}
								</>
							)}
						</ChipMenu>
					))}
				{status?.thinkingLevel &&
					(readOnly ? (
						<span className="chip">think: {status.thinkingLevel}</span>
					) : (
						<ChipMenu label={`think: ${status.thinkingLevel}`} title="Change thinking level" onOpen={loadOptions}>
							{close => (
								<div className="chip-list" role="listbox" aria-label="Thinking levels">
									{optionsError && <div className="form-error">{optionsError}</div>}
									{!options && !optionsError && <div className="faint">Loading…</div>}
									{options?.thinkingLevels.map(level => {
										const token = thinkingToken(level);
										return (
											<button
												key={level}
												type="button"
												role="option"
												aria-selected={level === status.thinkingLevel}
												className="chip-option"
												onClick={() => {
													close();
													void run({ t: "session.set_thinking", sessionId, level });
												}}
											>
												<ThinkingSector
													level={level}
													style={token ? { color: ompColor(token) } : undefined}
												/>{" "}
												{level}
											</button>
										);
									})}
								</div>
							)}
						</ChipMenu>
					))}
				{status?.agentMode &&
					(readOnly ? (
						<span className="chip">mode: {status.agentModeName ?? status.agentMode}</span>
					) : (
						<ChipMenu
							label={`mode: ${status.agentModeName ?? status.agentMode}`}
							title="Change Antigravity execution mode"
							onOpen={loadOptions}
						>
							{close => (
								<div className="chip-list" role="listbox" aria-label="Execution modes">
									{optionsError && <div className="form-error">{optionsError}</div>}
									{!options && !optionsError && <div className="faint">Loading…</div>}
									{options?.modes?.map(m => (
										<button
											key={m.id}
											type="button"
											role="option"
											aria-selected={m.id === status.agentMode}
											className="chip-option"
											title={m.description}
											onClick={() => {
												close();
												void run({ t: "session.set_mode", sessionId, mode: m.id });
											}}
										>
											{m.name}
											{m.description && <span className="faint"> — {m.description}</span>}
										</button>
									))}
									{options && (!options.modes || options.modes.length === 0) && (
										<div className="faint">No switchable modes reported</div>
									)}
								</div>
							)}
						</ChipMenu>
					))}
				{status?.permissionMode &&
					(readOnly ? (
						<span className="chip" data-testid="permission-mode-chip">
							perm: {status.permissionMode}
						</span>
					) : (
						<ChipMenu
							label={`perm: ${status.permissionMode}`}
							title="Change tool permission approval policy (saved for new Antigravity sessions)"
							buttonClass={status.permissionMode === "auto" ? "chip chip--button chip--backend" : undefined}
						>
							{close => (
								<div className="chip-list" role="listbox" aria-label="Permission modes">
									{PERMISSION_MODES.map(item => (
										<button
											key={item.mode}
											type="button"
											role="option"
											aria-selected={item.mode === status.permissionMode}
											data-testid={`permission-mode-${item.mode}`}
											className="chip-option"
											onClick={() => {
												close();
												savePermissionModePreference(
													typeof localStorage === "undefined" ? undefined : localStorage,
													item.mode,
												);
												void run({ t: "session.set_permission_mode", sessionId, mode: item.mode });
											}}
										>
											{item.label} <span className="faint">— {item.description}</span>
										</button>
									))}
								</div>
							)}
						</ChipMenu>
					))}
				{status?.isCompacting && <span className="chip chip--live">compacting…</span>}
				{view.working && <span className="chip chip--live">working</span>}
				{queued > 0 && <span className="chip">{queued} queued</span>}
				{[...view.statuses].map(([key, text]) => (
					<span key={key} className="chip" title={key}>
						{stripAnsi(text)}
					</span>
				))}
				<button
					type="button"
					className={`btn btn--small btn--ghost handoff-switch${switchAction.ok ? "" : " handoff-switch--disabled"}`}
					data-testid="switch-environment"
					data-reason={switchAction.reason}
					aria-disabled={!switchAction.ok || undefined}
					title={
						switchAction.ok
							? "Continue this thread on another machine or in another worktree"
							: switchAction.reason
					}
					onClick={() => {
						if (switchAction.ok) {
							setSwitchAlert(null);
							onSwitch();
						} else {
							setSwitchAlert(switchAction.reason);
						}
					}}
				>
					<ArrowRightLeft size={14} aria-hidden="true" /> Switch environment
				</button>
			</div>
			{switchAlert && !switchAction.ok && (
				<div className="handoff-switch-alert" role="alert" data-testid="switch-reason">
					<span>{switchAlert}</span>
					<IconButton icon={X} label="Dismiss" onClick={() => setSwitchAlert(null)} />
				</div>
			)}
			{error && (
				<div className="form-error" role="alert">
					{error}
				</div>
			)}
		</header>
	);
}
