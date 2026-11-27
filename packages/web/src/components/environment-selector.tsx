import { type GatewaySessionInfo, MACHINES_API, MACHINE_NICKNAME_MAX, type MachineSummary } from "@omp-web/protocol";
import { Pencil } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { type Selection, selectMachine } from "../lib/environment";
import type { DaemonClient } from "../store/daemon-client";
import { ProjectPicker } from "./project-picker";
import { IconButton } from "./ui/icon-button";

interface Props {
	client: DaemonClient;
	machines: readonly MachineSummary[];
	selection: Selection;
	/** The focused machine's listed sessions (the project menu offers the directories of those outside every project). */
	sessions: readonly GatewaySessionInfo[];
	/** Per machine id: its listed sessions an omp process of that daemon runs (`hosted`). */
	activeCounts: Readonly<Record<string, number>>;
	onSelection(next: Selection): void;
}

/**
 * The sidebar's focus: the machine, then the project whose sessions the list shows (or all of them), which is also
 * where "New session" starts. The project menu is the status line's: it also adds and removes projects.
 */
export function EnvironmentSelector({
	client,
	machines,
	selection,
	sessions,
	activeCounts,
	onSelection,
}: Props): ReactNode {
	const machine = machines.find(m => m.id === selection.machine);
	const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** Like a session's rename: Enter saves, Escape or leaving the field cancels; empty restores the original name. */
	const save = async (event: FormEvent): Promise<void> => {
		event.preventDefault();
		if (!editing || busy) return;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`${MACHINES_API}/${encodeURIComponent(editing.id)}`, {
				method: "PATCH",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ nickname: editing.draft }),
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `Could not save nickname (${response.status})`);
			}
			setEditing(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="env" aria-label="Environment">
			<ul className="machine-list">
				{machines.map(m => (
					<li key={m.id} className="machine-row">
						{editing?.id === m.id ? (
							<form className="side-rename" onSubmit={event => void save(event)}>
								<input
									autoFocus
									onFocus={event => event.currentTarget.select()}
									aria-label={`Nickname for ${m.originalName ?? m.name}`}
									title="Empty restores the original name"
									maxLength={MACHINE_NICKNAME_MAX}
									placeholder={m.originalName ?? m.name}
									value={editing.draft}
									disabled={busy}
									onChange={event => setEditing({ id: m.id, draft: event.target.value })}
									onKeyDown={event => event.key === "Escape" && !busy && setEditing(null)}
									onBlur={() => !busy && setEditing(null)}
									name="nickname"
								/>
							</form>
						) : (
							<button
								type="button"
								className={`machine-item${m.id === machine?.id ? " machine-item--on" : ""}`}
								data-machine={m.id}
								title={m.originalName ?? m.name}
								data-online={String(m.online)}
								aria-pressed={m.id === machine?.id}
								onClick={() => m.id !== machine?.id && onSelection(selectMachine(m, { machine, selection }))}
							>
								<span className={`mdot mdot--${m.online ? "online" : "offline"}`} aria-hidden />
								<span className="machine-name">{m.name}</span>
								{m.gateway && <span className="machine-tag">gateway</span>}
								<span className="machine-state">
									{m.online ? activeLabel(activeCounts[m.id] ?? 0) : "offline · cached"}
								</span>
							</button>
						)}
						<span className="side-actions icon-row">
							<IconButton
								icon={Pencil}
								label="Rename"
								className="side-x"
								disabled={busy}
								// Keep focus until click so blur cannot cancel and then reopen the editor.
								onMouseDown={event => event.preventDefault()}
								onClick={() => {
									setError(null);
									setEditing(current =>
										current?.id === m.id
											? null
											: { id: m.id, draft: m.originalName === undefined ? "" : m.name },
									);
								}}
							/>
						</span>
					</li>
				))}
				{machines.length === 0 && <li className="side-none">No machines yet</li>}
			</ul>
			{error && (
				<div className="form-error" role="alert">
					{error}
				</div>
			)}
			{machine && (
				<ProjectPicker
					client={client}
					machine={machine}
					target={selection}
					sessions={sessions}
					onSelection={onSelection}
					allProjects
				/>
			)}
		</section>
	);
}

function activeLabel(count: number): string {
	return `${count} active session${count === 1 ? "" : "s"}`;
}
