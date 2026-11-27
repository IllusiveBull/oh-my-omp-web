import {
	type CacheForecast,
	type CarriedSummary,
	type ForecastItem,
	type ForecastItemId,
	HANDOFF_STEP_IDS,
	type HandoffPlan,
	type HandoffStep,
	type HandoffStepId,
	type HandoffStepStatus,
	type HandoffWire,
	type ThreadHop,
} from "@omp-web/protocol";

export function carried(overrides: Partial<CarriedSummary> = {}): CarriedSummary {
	return {
		base: { commit: "0123456789abcdef0123456789abcdef01234567", branch: "main", detached: false },
		tracked: { modified: 3, added: 1, deleted: 0, renamed: 0, typeChanged: 0, modeChanged: 0 },
		untracked: { files: 2, bytes: 2048 },
		staged: { preserved: true, paths: 2 },
		skipped: [],
		skippedTruncated: false,
		ignored: { count: 0, sample: [] },
		sample: ["src/a.ts", "src/b.ts"],
		paths: 6,
		...overrides,
	};
}

const STEP_LABELS: Record<HandoffStepId, string> = {
	preflight: "Check both machines",
	commit: "Snapshot the working tree",
	capture: "Capture session facts",
	bundle: "Transfer the repository",
	worktree: "Create the worktree",
	session: "Transfer the session",
	fork: "Fork the session",
	forecast: "Forecast the cache",
};

/** The eight steps with the first `done` ones finished, the next one `running`, the rest `pending`. */
export function steps(
	done: number,
	running = true,
	overrides: Partial<Record<HandoffStepId, Partial<HandoffStep>>> = {},
): HandoffStep[] {
	return HANDOFF_STEP_IDS.map((id, i) => {
		const status: HandoffStepStatus = i < done ? "done" : i === done && running ? "running" : "pending";
		return { id, label: STEP_LABELS[id], status, ...overrides[id] };
	});
}

const ITEMS: [ForecastItemId, string, ForecastItem["status"], boolean][] = [
	["tools", "Tool definitions", "hit", false],
	["systemHead", "System prompt (static head)", "hit", false],
	["systemTail", "System prompt (project context)", "miss", false],
	["history", "Conversation history", "hit", false],
	["model", "Model", "hit", false],
	["thinking", "Thinking level", "hit", false],
	["tier", "Service tier", "na", false],
	["account", "Account", "unknown", true],
	["ttl", "Cache time-to-live", "hit", true],
	["cacheKey", "Prompt cache key", "na", true],
];

export function forecast(overrides: Partial<CacheForecast> = {}): CacheForecast {
	return {
		summary: "partial",
		headline: "Partial hit: tools and system head hit, project context misses (~12,300 tokens rewritten)",
		rewriteTokens: 12_300,
		items: ITEMS.map(([id, label, status, inference]) => ({
			id,
			label,
			status,
			detail: `${label} detail`,
			inference,
		})),
		computedAt: 1_000,
		...overrides,
	};
}

export function wire(overrides: Partial<HandoffWire> = {}): HandoffWire {
	return {
		id: "h-0001-aaaa",
		threadId: "thread-a",
		source: {
			machine: "desk",
			machineName: "Desktop",
			sessionId: "a",
			title: "Fix the build",
			cwd: "/work/app",
			worktree: "/work/app",
			projectId: "p1",
			projectName: "app",
		},
		target: { machine: "lap", machineName: "Laptop", choice: { mode: "new" } },
		phase: "running",
		steps: steps(3),
		createdAt: 1_000,
		updatedAt: 2_000,
		...overrides,
	};
}

export function plan(overrides: Partial<HandoffPlan> = {}): HandoffPlan {
	return {
		source: {
			machine: "desk",
			machineName: "Desktop",
			sessionId: "a",
			threadId: "thread-a",
			title: "Fix the build",
			cwd: "/work/app",
			hosted: true,
		},
		repo: {
			project: { id: "p1", name: "app", root: "/work/app", worktree: "/work/app" },
			head: "0123456789abcdef0123456789abcdef01234567",
			branch: "main",
			detached: false,
			preview: carried(),
		},
		sameMachine: false,
		target: {
			machine: "lap",
			machineName: "Laptop",
			online: true,
			project: { name: "app", root: "/home/me/app" },
			worktrees: [],
			newWorktree: { path: "/home/me/app.omp-worktrees/abc123", branch: "omp-web/abc123" },
		},
		blockers: [],
		...overrides,
	};
}

export function hop(overrides: Partial<ThreadHop> = {}): ThreadHop {
	return {
		id: "hop-1",
		handoffId: "h-0001-aaaa",
		at: Date.now() - 2 * 3_600_000,
		from: { machine: "desk", machineName: "desktop", sessionId: "a", cwd: "/work/app" },
		to: {
			machine: "lap",
			machineName: "laptop",
			sessionId: "b",
			cwd: "/home/me/app.omp-worktrees/abc123",
			branch: "omp-web/abc123",
		},
		forecast: "partial",
		...overrides,
	};
}
