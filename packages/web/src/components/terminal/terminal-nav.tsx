import type { MachineSummary } from "@omp-web/protocol";
import { Plus } from "lucide-react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { basename, displayPath, type Selection } from "../../lib/environment";
import type { TerminalRef } from "../../lib/route";
import { disabledMessage, tabsOf, terminalTarget } from "../../lib/terminal";
import type { TerminalClient } from "../../store/terminal-client";

interface NavProps {
	terminals: TerminalClient;
	/** The machine in context: the open session's, else the one the environment selector points at. */
	machine: MachineSummary | undefined;
	selection: Selection;
	/** The terminal on screen, if any. */
	selected: TerminalRef | null;
	onOpen(ref: TerminalRef): void;
}

const STATE_LABEL = { running: "running", exited: "exited", lost: "ended", offline: "offline", disabled: "disabled" };

/** Things that happened to terminals the user is not looking at (dismissed from another browser), each dismissable. */
export function TerminalNotices({ terminals, machine }: { terminals: TerminalClient; machine: string }): ReactNode {
	const { notices } = useSyncExternalStore(terminals.subscribe, terminals.getSnapshot);
	return notices
		.filter(n => n.machine === machine)
		.map(n => (
			<div key={n.id} className="side-note term-note" role="status" data-role="term-notice" data-notice="gone">
				{n.message}{" "}
				<button
					type="button"
					className="btn btn--ghost btn--small term-note-x"
					onClick={() => terminals.dismissNotice(n.id)}
				>
					Dismiss
				</button>
			</div>
		));
}

/**
 * The dock's terminal list: start a shell in the worktree in context and list the machine's terminals with their
 * state. Says plainly when the machine has terminals disabled.
 */
export function TerminalNav({ terminals, machine, selection, selected, onOpen }: NavProps): ReactNode {
	const state = useSyncExternalStore(terminals.subscribe, terminals.getSnapshot);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const machineId = machine?.id ?? null;
	useEffect(() => {
		if (machineId === null) return;
		return terminals.watch(machineId);
	}, [terminals, machineId]);
	useEffect(() => setError(null), [machineId]);

	if (!machine) return null;
	const view = state.machines[machine.id];
	const disabled = view?.capability?.enabled === false;
	const online = view?.online ?? false;
	const target = terminalTarget(machine, selection);
	const tabs = tabsOf(view?.terminals ?? [], [], { disabled, online });
	const blocked = disabled ? "Terminals are disabled on this machine." : target.ok ? null : target.reason;

	const create = async (): Promise<void> => {
		if (!target.ok) return;
		setBusy(true);
		setError(null);
		const result = await terminals.open(machine.id, { cwd: target.cwd });
		setBusy(false);
		if (!result.ok) setError(result.code === "terminal_disabled" ? disabledMessage(machine.name) : result.error);
		else onOpen({ machine: machine.id, id: result.terminal.id });
	};

	return (
		<section className="term-nav" data-section="terminals" aria-label="Terminals">
			<div className="section-head term-nav-head">
				<span className="section-head-title">Terminals</span>
				<button
					type="button"
					className="btn btn--small section-head-actions"
					data-role="term-new"
					data-place="nav"
					disabled={busy || blocked !== null || !online}
					title={blocked ?? (target.ok ? `New terminal in ${displayPath(target.cwd, machine)}` : undefined)}
					onClick={() => void create()}
				>
					<Plus size={14} aria-hidden="true" /> {busy ? "Starting…" : "New terminal"}
				</button>
			</div>
			{disabled && (
				<div className="side-note" role="status" data-role="term-notice" data-notice="disabled">
					{disabledMessage(machine.name)}
				</div>
			)}
			{!disabled && view?.error && (
				<div className="side-note" role="status" data-role="term-notice" data-notice="error">
					Terminals are not available on {machine.name}: {view.error}
				</div>
			)}
			{!disabled && blocked !== null && tabs.length === 0 && <div className="term-nav-hint">{blocked}</div>}
			{error && (
				<div className="form-error" role="alert" data-role="term-error">
					{error}
				</div>
			)}
			{tabs.length > 0 && (
				<ul className="term-nav-list">
					{tabs.map(tab => {
						const info = view?.terminals.find(t => t.id === tab.id);
						const on = selected?.machine === machine.id && selected.id === tab.id;
						return (
							<li
								key={tab.id}
								className={`side-item${on ? " side-item--on" : ""}`}
								data-terminal={tab.id}
								data-machine={machine.id}
								data-state={tab.state}
							>
								<button
									type="button"
									className="side-pick term-nav-pick"
									title={info ? displayPath(info.cwd, machine) : undefined}
									onClick={() => onOpen({ machine: machine.id, id: tab.id })}
								>
									<span className={`term-dot term-dot--${tab.state}`} aria-label={tab.state} />
									<span className="side-name">
										{tab.title}
										{tab.purpose === "broker-login" && <span className="term-badge">broker login</span>}
									</span>
									<span className="side-sub">
										{info ? `${displayPath(info.cwd, machine) === "~" ? "~" : basename(info.cwd)} · ` : ""}
										{STATE_LABEL[tab.state]}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
			{selected === null && <TerminalNotices terminals={terminals} machine={machine.id} />}
		</section>
	);
}
