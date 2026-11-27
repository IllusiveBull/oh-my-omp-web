import type { ModelOption, ModelRolesWire, SessionOptions } from "@omp-web/protocol";
import { X } from "lucide-react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ModelSearch, modelRef } from "../lib/model-search";
import { ompText, thinkingToken } from "./status-line";
import type { DaemonClient } from "../store/daemon-client";
import { IconButton } from "./ui/icon-button";

interface Props {
	client: DaemonClient;
	machine: string;
	sessionId: string;
	/** The session's model and thinking level now. */
	model: string | undefined;
	thinkingLevel: string | undefined;
	/** Sends a slash command to the session (`/switch …`): omp resolves the selector and switches the session. */
	onRun(command: string): Promise<{ ok: boolean; error?: string }>;
	onClose(): void;
}

const INHERIT = "inherit";

/** A thinking chip in omp's colour for its level. */
function thinkingStyle(level: string): CSSProperties | undefined {
	const token = thinkingToken(level);
	return token ? { color: ompText(token) } : undefined;
}
const refOf = modelRef;

/** Selector as omp writes it (`formatModelSelectorValue`): `provider/id`, then `:thinking` unless it is `inherit`. */
const selectorOf = (model: string, thinking: string): string =>
	thinking && thinking !== INHERIT ? `${model}:${thinking}` : model;

/**
 * A role's selector as a model of the list and its thinking setting (`inherit` without a suffix). A model id may hold
 * `:` itself, so a suffix only counts when it is one of that model's thinking settings.
 */
export function parseRoleSelector(
	selector: string,
	models: readonly ModelOption[],
): { model: ModelOption; thinking: string } | null {
	const exact = models.find(m => refOf(m) === selector);
	if (exact) return { model: exact, thinking: INHERIT };
	const colon = selector.lastIndexOf(":");
	if (colon < 0) return null;
	const base = models.find(m => refOf(m) === selector.slice(0, colon));
	const thinking = selector.slice(colon + 1);
	return base?.thinking.some(t => t.value === thinking) ? { model: base, thinking } : null;
}

/**
 * omp's model hub (`/model` in the terminal UI): the model roles (`default`, `smol`, `slow`, `plan`, `commit`, …) with
 * their assignments, which are omp settings shared with every session and the terminal UI. A role is changed by picking
 * a model and then its thinking setting from the strip omp offers for that model (`inherit`, `off`, `auto`, its
 * efforts), or cleared; saved to the global settings. Setting the default role also switches this session, as the
 * terminal UI does. Switching this session to a role is the status line's role menu.
 */
export function ModelHub({ client, machine, sessionId, model, thinkingLevel, onRun, onClose }: Props): ReactNode {
	const [roles, setRoles] = useState<ModelRolesWire | null>(null);
	const [models, setModels] = useState<ModelOption[] | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [picked, setPicked] = useState<ModelOption | null>(null);
	const [thinking, setThinking] = useState(INHERIT);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [warning, setWarning] = useState<string | null>(null);

	const loadRoles = useCallback(async (): Promise<void> => {
		const ack = await client.request(machine, { t: "session.roles", sessionId });
		if (ack.ok) setRoles(ack.data as ModelRolesWire);
		else setError(ack.error);
	}, [client, machine, sessionId]);

	useEffect(() => {
		void loadRoles();
		void client.request(machine, { t: "session.options", sessionId }).then(ack => {
			if (ack.ok) setModels((ack.data as SessionOptions).models);
			else setError(ack.error);
		});
	}, [client, machine, sessionId, loadRoles]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "Escape") return;
			if (editing !== null) setEditing(null);
			else onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [editing, onClose]);

	/** Opens the editor on the role's current model and thinking, so the thinking alone can be changed. */
	const edit = (role: string, selector: string | undefined): void => {
		const current = selector && models ? parseRoleSelector(selector, models) : null;
		setEditing(role);
		setFilter("");
		setPicked(current?.model ?? null);
		setThinking(current?.thinking ?? INHERIT);
		setError(null);
	};

	/** A new model keeps the thinking setting when it offers it too, as the terminal UI's hub does. */
	const pickModel = (model: ModelOption): void => {
		setPicked(model);
		if (!model.thinking.some(t => t.value === thinking)) setThinking(INHERIT);
	};

	const act = async (work: () => Promise<string | null>): Promise<void> => {
		setBusy(true);
		setError(null);
		setWarning(null);
		try {
			setError(await work());
		} finally {
			setBusy(false);
		}
	};

	const save = (role: string, selector: string | null): Promise<void> =>
		act(async () => {
			const ack = await client.request(machine, { t: "session.set_role", sessionId, role, selector });
			if (!ack.ok) return ack.error;
			const data = ack.data as { warning?: string } | undefined;
			if (data?.warning) setWarning(data.warning);
			setEditing(null);
			await loadRoles();
			if (role === "default" && selector !== null) {
				const switched = await onRun(`/switch ${selector}`);
				if (!switched.ok) return switched.error ?? "switch failed";
			}
			return null;
		});

	const search = useMemo(() => {
		const list = models ?? [];
		const roleModels = (roles?.roles ?? []).flatMap(role => {
			const parsed = role.selector ? parseRoleSelector(role.selector, list) : null;
			return parsed ? [refOf(parsed.model)] : [];
		});
		return new ModelSearch(list, { roleModels, currentModel: model });
	}, [models, roles, model]);
	const shown = useMemo(() => search.rank(filter), [search, filter]);
	const pickedRef = picked ? refOf(picked) : null;

	return (
		<div className="handoff-overlay" data-testid="model-hub">
			<div className="handoff-sheet model-hub" role="dialog" aria-modal="true" aria-label="Model roles">
				<div className="handoff-head">
					<h2>Model roles · all sessions</h2>
					<IconButton icon={X} className="handoff-close" label="Close" onClick={onClose} />
				</div>
				<div className="handoff-title">
					<div>
						This session: <span className="mono">{model ?? "no model"}</span>
						{thinkingLevel && <span className="mono"> · think: {thinkingLevel}</span>}
					</div>
					<div className="model-hub-warning">
						Roles are global omp settings, shared with every session and the terminal UI. Saving the default role
						also switches this session.
					</div>
				</div>
				<div className="handoff-body">
					{error && (
						<div className="form-error" role="alert">
							{error}
						</div>
					)}
					{warning && <div className="model-hub-warning">{warning}</div>}
					{!roles && !error && <div className="faint">Loading…</div>}
					<ul className="model-roles" aria-label="Model roles">
						{roles?.roles.map(role => (
							<li key={role.id} className="model-role" data-role={role.id}>
								<div className="model-role-row">
									<span
										className="model-role-name"
										style={role.color ? { color: ompText(role.color) } : undefined}
									>
										{role.name}
										{role.name.toLowerCase() !== role.id && <span className="faint"> {role.id}</span>}
										{roles.cycle.includes(role.id) && (
											<span className="chip model-role-cycle" title="In omp's quick-switch cycle">
												cycle
											</span>
										)}
									</span>
									<span className={`model-role-selector mono${role.selector ? "" : " faint"}`}>
										{role.selector ?? "unset"}
									</span>
									<span className="model-role-actions">
										<button
											type="button"
											className={`btn btn--small${editing === role.id ? " btn--on" : ""}`}
											disabled={busy}
											aria-expanded={editing === role.id}
											onClick={() => (editing === role.id ? setEditing(null) : edit(role.id, role.selector))}
										>
											Change
										</button>
									</span>
								</div>
								{editing === role.id && (
									<div className="model-role-editor">
										<input
											className="chip-filter"
											name="role-model-filter"
											value={filter}
											onChange={e => setFilter(e.target.value)}
											placeholder={models ? `Filter ${models.length} models` : "Loading models…"}
											autoFocus
										/>
										<div className="chip-list model-role-models" role="listbox" aria-label="Models">
											{shown.map(m => (
												<button
													key={refOf(m)}
													type="button"
													role="option"
													aria-selected={refOf(m) === pickedRef}
													className="chip-option"
													onClick={() => pickModel(m)}
												>
													{refOf(m)}
												</button>
											))}
											{models && shown.length === 0 && <div className="faint">No match</div>}
										</div>
										{picked && picked.thinking.length > 0 && (
											<div className="model-role-thinking" role="radiogroup" aria-label="Thinking">
												<span className="faint">Thinking</span>
												{picked.thinking.map(option => (
													<button
														key={option.value}
														type="button"
														role="radio"
														aria-checked={option.value === thinking}
														className={`chip chip--button${option.value === thinking ? " chip--on" : ""}`}
														style={thinkingStyle(option.value)}
														title={option.description}
														onClick={() => setThinking(option.value)}
													>
														{option.label}
													</button>
												))}
											</div>
										)}
										<div className="model-role-save">
											<button
												type="button"
												className="btn btn--primary btn--small"
												disabled={busy || pickedRef === null}
												onClick={() => pickedRef && void save(role.id, selectorOf(pickedRef, thinking))}
											>
												Save{pickedRef ? ` ${selectorOf(pickedRef, thinking)}` : ""}
											</button>
											{role.selector && (
												<button
													type="button"
													className="btn btn--small"
													disabled={busy}
													onClick={() => void save(role.id, null)}
												>
													Clear
												</button>
											)}
										</div>
									</div>
								)}
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	);
}
