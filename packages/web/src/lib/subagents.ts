import type { SubagentWire } from "@omp-web/protocol";

/**
 * The Agents list order: running sub-agents first, each group in spawn order. Progress frames move nothing (upstream's
 * panel sorts running agents by last activity, so concurrent ones swap places on every frame); an agent changes place
 * once, when it finishes.
 */
export function orderAgents(subagents: ReadonlyMap<string, SubagentWire>): SubagentWire[] {
	return [...subagents.values()].sort((a, b) => {
		const ar = a.agent.status === "running" ? 0 : 1;
		const br = b.agent.status === "running" ? 0 : 1;
		if (ar !== br) return ar - br;
		if (a.agent.createdAt !== b.agent.createdAt) return a.agent.createdAt - b.agent.createdAt;
		const ai = a.progress?.index ?? 0;
		const bi = b.progress?.index ?? 0;
		if (ai !== bi) return ai - bi;
		return a.agent.id < b.agent.id ? -1 : a.agent.id > b.agent.id ? 1 : 0;
	});
}

/** The Agents button's badge: sub-agents of the session, and how many of them are running. */
export interface AgentCounts {
	total: number;
	running: number;
}

export function countRunningAgents(subagents: ReadonlyMap<string, SubagentWire>): number {
	let running = 0;
	for (const { agent } of subagents.values()) if (agent.status === "running") running++;
	return running;
}

/**
 * How long the sub-agent has run (the daemon dates `createdAt` from omp's own `durationMs`): up to `now` while it runs,
 * omp's final duration once it has stopped.
 */
export function agentRunMs({ agent, progress }: SubagentWire, now: number): number {
	if (agent.status === "running") return Math.max(0, now - agent.createdAt);
	return progress?.progress.durationMs || Math.max(0, agent.lastActivity - agent.createdAt);
}
