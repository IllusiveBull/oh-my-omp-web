import type { ModelInfo } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type {
	RpcAvailableSlashCommand,
	RpcSessionState,
	RpcSubagentLifecycleFrame,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSnapshot, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import type {
	ModelOption,
	QueueWire,
	SlashCommandWire,
	SubagentWire,
	ThinkingOptionWire,
	TodoPhaseWire,
} from "@omp-web/protocol";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { AUTO_THINKING, getConfiguredThinkingLevelMetadata } from "@oh-my-pi/pi-coding-agent/thinking/levels";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/utils/render-utils";
import type { TranscriptAgent } from "./spend";

/*
 * Upstream -> protocol mappings. The protocol mirrors some upstream shapes structurally (the web package cannot import
 * coding-agent types); each mapping below assigns the upstream value to the mirror, so a renamed or widened upstream
 * field fails this file's typecheck.
 */

/** Drops the per-task `details` / `notes` the panel does not show. */
export function toTodos(phases: RpcSessionState["todoPhases"]): TodoPhaseWire[] {
	return phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
	}));
}

export function toQueue(queue: RpcSessionState["queuedMessages"]): QueueWire {
	return { steering: [...queue.steering], followUp: [...queue.followUp], liveSteered: queue.liveSteered };
}

export function toSlashCommands(commands: readonly RpcAvailableSlashCommand[]): SlashCommandWire[] {
	return commands.map(command => ({ ...command }));
}

/** The thinking settings omp's model hub offers for a role on `model` (its `#thinkingOptionsFor`). */
function thinkingOptions(model: ModelInfo): ThinkingOptionWire[] {
	if (!model.reasoning) return [];
	const levels: ConfiguredThinkingLevel[] = [ThinkingLevel.Inherit, ThinkingLevel.Off];
	if (!model.thinking?.unverified) levels.push(AUTO_THINKING);
	levels.push(...getSupportedEfforts(model as Parameters<typeof getSupportedEfforts>[0]));
	return levels.map(level => {
		const { label, description } = getConfiguredThinkingLevelMetadata(level);
		return { value: level, label, description };
	});
}

export function toModelOptions(models: readonly ModelInfo[]): ModelOption[] {
	return models.map(model => ({
		provider: model.provider,
		id: model.id,
		contextWindow: model.contextWindow ?? undefined,
		reasoning: model.reasoning,
		thinking: thinkingOptions(model),
	}));
}

type ProgressPayload = RpcSubagentProgressFrame["payload"];
type LifecyclePayload = RpcSubagentLifecycleFrame["payload"];

function agentStatus(
	status: "pending" | "running" | "completed" | "failed" | "aborted" | "started",
): AgentSnapshot["status"] {
	if (status === "pending" || status === "running" || status === "started") return "running";
	return status === "aborted" ? "aborted" : "idle";
}

/**
 * Merges what omp reports about sub-agents (registry snapshots, progress and lifecycle frames) into the records the
 * panel shows. Holds no timers; the caller decides when to publish.
 */
export class SubagentTracker {
	#agents = new Map<string, SubagentWire>();

	get all(): SubagentWire[] {
		return [...this.#agents.values()].toSorted((a, b) => (a.progress?.index ?? 0) - (b.progress?.index ?? 0));
	}

	get(id: string): SubagentWire | undefined {
		return this.#agents.get(id);
	}

	/** What the tracked sub-agents spent so far (each one's own model calls, as its progress reports them). */
	get cost(): number {
		let cost = 0;
		for (const { progress } of this.#agents.values()) cost += progress?.progress.cost ?? 0;
		return cost;
	}

	clear(): void {
		this.#agents.clear();
	}

	/**
	 * Replaces everything with a `get_subagents` registry snapshot, which lists only the agents omp still runs, and the
	 * transcripts on disk for every other one (finished, failed or killed) so the list keeps them.
	 */
	replace(snapshots: readonly RpcSubagentSnapshot[], onDisk: readonly TranscriptAgent[], now: number): SubagentWire[] {
		this.#agents = new Map();
		for (const snapshot of snapshots) {
			const progress: SubagentProgressPayload | undefined = snapshot.progress && {
				index: snapshot.index,
				agent: snapshot.agent,
				task: snapshot.task ?? snapshot.progress.task,
				parentToolCallId: snapshot.parentToolCallId,
				assignment: snapshot.assignment,
				progress: snapshot.progress,
				sessionFile: snapshot.sessionFile,
			};
			this.#agents.set(snapshot.id, {
				agent: {
					id: snapshot.id,
					displayName: snapshot.id,
					kind: "sub",
					status: agentStatus(snapshot.status),
					hasSessionFile: snapshot.sessionFile !== undefined,
					createdAt: snapshot.lastUpdate - (snapshot.progress?.durationMs ?? 0),
					lastActivity: snapshot.lastUpdate || now,
				},
				progress,
			});
		}
		for (const { id, startedAt, lastActivity, aborted } of onDisk) {
			if (this.#agents.has(id)) continue;
			this.#agents.set(id, {
				agent: {
					id,
					displayName: id,
					kind: "sub",
					status: aborted ? "aborted" : "idle",
					hasSessionFile: true,
					createdAt: startedAt,
					lastActivity,
				},
			});
		}
		return this.all;
	}

	applyProgress(payload: ProgressPayload, now: number): SubagentWire {
		const id = payload.progress.id;
		const previous = this.#agents.get(id);
		// omp's progress says how long the agent has run: its start, whenever the panel began to watch it.
		const ranMs = payload.progress.durationMs;
		const next: SubagentWire = {
			...previous,
			agent: {
				id,
				displayName: id,
				kind: "sub",
				status: agentStatus(payload.progress.status),
				hasSessionFile: payload.sessionFile !== undefined || previous?.agent.hasSessionFile === true,
				createdAt: ranMs > 0 ? now - ranMs : (previous?.agent.createdAt ?? now),
				lastActivity: now,
			},
			progress: payload,
		};
		this.#agents.set(id, next);
		return next;
	}

	applyLifecycle(payload: LifecyclePayload, now: number): SubagentWire {
		const lifecycle: SubagentLifecyclePayload = payload;
		const previous = this.#agents.get(payload.id);
		const next: SubagentWire = {
			...previous,
			agent: {
				id: payload.id,
				displayName: payload.id,
				kind: "sub",
				status: agentStatus(payload.status),
				hasSessionFile: payload.sessionFile !== undefined || previous?.agent.hasSessionFile === true,
				createdAt: previous?.agent.createdAt ?? now,
				lastActivity: now,
			},
			lifecycle,
		};
		this.#agents.set(payload.id, next);
		return next;
	}
}
