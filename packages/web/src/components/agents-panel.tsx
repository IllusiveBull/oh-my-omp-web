import "@oh-my-pi/collab-web/src/components/agents/agents.css";
import { fmtCost, fmtTokens, relTime } from "@oh-my-pi/collab-web/src/lib/format";
import type { SubagentWire } from "@omp-web/protocol";
import { memo, type ReactNode, useMemo } from "react";
import { agentRunMs, orderAgents } from "../lib/subagents";
import { formatElapsed } from "../lib/time";
import { useNow } from "../lib/use-now";

/** What the agent is doing: its current tool, else its last stated intent, else its state ("started" reads as running). */
function activityLine({ agent, progress, lifecycle }: SubagentWire): string {
	const p = progress?.progress;
	if (p?.currentTool) return p.currentTool;
	if (p?.lastIntent) return p.lastIntent;
	return lifecycle && lifecycle.status !== "started" ? lifecycle.status : agent.status;
}

/**
 * The session's sub-agents in a stable order ({@link orderAgents}), drawn with upstream's `ag-*` look. Upstream's
 * `AgentsPanel` reorders running agents on every progress frame, so only its styles are reused.
 */
export const AgentsPanel = memo(function AgentsPanel(props: {
	subagents: ReadonlyMap<string, SubagentWire>;
	selectedId: string | null;
	onSelect(id: string | null): void;
}): ReactNode {
	const { subagents, selectedId, onSelect } = props;
	const now = useNow(true);
	const ordered = useMemo(() => orderAgents(subagents), [subagents]);
	// The same centred empty state as the BTW panel's.
	if (ordered.length === 0) return <div className="dock-empty">No subagents yet</div>;

	return (
		<div className="ag-panel">
			<div className="ag-heading">
				Subagents
				<span className="ag-heading-count">{ordered.length}</span>
			</div>
			{ordered.map(wire => {
				const { agent } = wire;
				const p = wire.progress?.progress;
				const selected = selectedId === agent.id;
				return (
					<button
						key={agent.id}
						type="button"
						className={selected ? "ag-row ag-row--selected" : "ag-row"}
						onClick={() => onSelect(selected ? null : agent.id)}
					>
						<span className="ag-row-head">
							<span className={`ag-dot ag-dot--${agent.status}`} />
							<span className="ag-row-name">{agent.displayName}</span>
							<span className="ag-chip">{agent.kind}</span>
						</span>
						<span className="ag-row-activity">{activityLine(wire)}</span>
						<span className="ag-row-meta">
							<span title="Time this sub-agent has run">{formatElapsed(agentRunMs(wire, now))}</span>
							{p && <span>{fmtTokens(p.tokens)} tok</span>}
							{p && <span>{fmtCost(p.cost)}</span>}
							<span className="ag-row-meta-when">{relTime(agent.lastActivity)}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
});
