import type { GitSummaryWire } from "@omp-web/protocol";
import { parseStatusV2 } from "./git-parse";
import { runGit } from "./git-run";

/**
 * Branch and change counts of the working tree at `cwd`, as omp's status line counts them: staged and unstaged changes
 * per file (a file can be both), untracked entries. Undefined outside a git repository.
 */
export async function gitSummary(cwd: string): Promise<GitSummaryWire | undefined> {
	const result = await runGit(cwd, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal"], {
		timeoutMs: 10_000,
		maxBytes: 8 * 1024 * 1024,
	});
	if (result.timedOut || (result.code !== 0 && !result.truncated)) return undefined;
	const status = parseStatusV2(new TextDecoder().decode(result.stdout));
	const summary: GitSummaryWire = { branch: status.branch.head, staged: 0, unstaged: 0, untracked: 0 };
	for (const entry of status.entries) {
		if (entry.kind === "untracked") summary.untracked++;
		else {
			if (entry.x !== ".") summary.staged++;
			if (entry.y !== ".") summary.unstaged++;
		}
	}
	return summary;
}
