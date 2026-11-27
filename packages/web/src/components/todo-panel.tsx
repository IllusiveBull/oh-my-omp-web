import type { TodoPhaseWire, TodoStatus } from "@omp-web/protocol";
import { ArrowRight, Check, ChevronRight, Circle, type LucideIcon, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { textKeys } from "../lib/keys";

const ICONS: Record<TodoStatus, LucideIcon> = {
	completed: Check,
	in_progress: ArrowRight,
	abandoned: X,
	pending: Circle,
};

/** The agent's phased task list (omp's `todo` tool state). Hidden while there is none. */
export function TodoPanel({ todos }: { todos: readonly TodoPhaseWire[] }): ReactNode {
	const [open, setOpen] = useState(true);
	const tasks = todos.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return null;
	const done = tasks.filter(task => task.status === "completed").length;
	const phaseKeys = textKeys(todos.map(phase => phase.name));
	return (
		<section className="todos" aria-label="Todos">
			<button
				type="button"
				className="btn btn--ghost btn--small todos-head"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<ChevronRight size={14} aria-hidden="true" className={`todos-chev${open ? " todos-chev--open" : ""}`} />
				Todos
				<span className="chip">
					{done}/{tasks.length}
				</span>
			</button>
			{open &&
				todos.map((phase, i) => {
					const taskKeys = textKeys(phase.tasks.map(task => task.content));
					return (
						<div key={phaseKeys[i]} className="todos-phase">
							<div className="todos-phase-name">{phase.name}</div>
							<ul>
								{phase.tasks.map((task, j) => {
									const Icon = ICONS[task.status];
									return (
										<li key={taskKeys[j]} className={`todo todo--${task.status}`}>
											<span className="todo-icon" role="img" aria-label={task.status}>
												<Icon size={12} aria-hidden="true" />
											</span>
											<span className="todo-text">{task.content}</span>
										</li>
									);
								})}
							</ul>
						</div>
					);
				})}
		</section>
	);
}
