import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { stripAnsi } from "./ansi";

/** One category of omp's `/context` report: `  System prompt    [███░░] 12%  4120 tokens`. */
export interface ContextRow {
	label: string;
	percent: number;
	tokens: number;
}

/** omp's `/context` text as its title line, the category rows, and whatever else it printed (snapcompact notes). */
export function parseContextReport(text: string): { title: string; rows: ContextRow[]; notes: string[] } {
	const lines = stripAnsi(text).split("\n");
	const rows: ContextRow[] = [];
	const notes: string[] = [];
	for (const line of lines.slice(1)) {
		const m = /^ {2}(\S.*?)\s+\[[^\]]*\]\s*(\d+(?:\.\d+)?)%\s+(\d+) tokens$/.exec(line);
		if (m) rows.push({ label: m[1]!, percent: Number(m[2]), tokens: Number(m[3]) });
		else if (line.trim()) notes.push(line);
	}
	return { title: lines[0] ?? "", rows, notes };
}

/** A row of the overview, in the terminal's `/context` order; `child` rows are the tools under Tool Output. */
export interface OverviewRow {
	key: string;
	label: string;
	tokens: number;
	child?: true;
}

/** The parts of Messages, as omp's terminal view splits them. */
const MESSAGE_PARTS = [
	["user", "User / Developer Messages"],
	["assistant", "Assistant Messages"],
	["thinking", "Assistant Thinking"],
	["calls", "Tool Calls"],
	["output", "Tool Output"],
] as const;
type MessagePart = (typeof MESSAGE_PARTS)[number][0];

/** Weight of an image in characters (omp counts an image as about 1,200 tokens; text as about 4 characters a token). */
const IMAGE_CHARS = 4800;

type Block = { type: string; text?: string; thinking?: string; data?: string; name?: string; arguments?: unknown };

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return (content as Block[]).reduce(
		(sum, block) => sum + (block.type === "image" ? IMAGE_CHARS : (block.text?.length ?? 0)),
		0,
	);
}

/**
 * Characters per part of Messages in what omp sends the model: the entries after the last compaction (from its first
 * kept entry), with the compaction summary counted as a user message. Tool output is also kept per tool.
 */
export function messageWeights(entries: readonly SessionEntry[]): {
	parts: Record<MessagePart, number>;
	tools: Map<string, number>;
} {
	const parts: Record<MessagePart, number> = { user: 0, assistant: 0, thinking: 0, calls: 0, output: 0 };
	const tools = new Map<string, number>();
	const output = (tool: string, chars: number): void => {
		parts.output += chars;
		tools.set(tool, (tools.get(tool) ?? 0) + chars);
	};
	let start = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "compaction") continue;
		parts.user += entry.summary.length;
		const kept = entries.findIndex(e => e.id === entry.firstKeptEntryId);
		start = kept >= 0 ? kept : i + 1;
		break;
	}
	for (const entry of entries.slice(start)) {
		if (entry.type === "custom_message") parts.user += contentChars(entry.content);
		else if (entry.type === "branch_summary") parts.user += entry.summary.length;
		if (entry.type !== "message") continue;
		// omp's own roles beyond the wire subset (`!command` runs) carry their output as text.
		const message = entry.message as { role: string; content?: unknown; toolName?: string; output?: string };
		switch (message.role) {
			case "user":
			case "developer":
				parts.user += contentChars(message.content);
				break;
			case "assistant":
				for (const block of message.content as Block[]) {
					if (block.type === "text") parts.assistant += block.text?.length ?? 0;
					else if (block.type === "thinking") parts.thinking += block.thinking?.length ?? 0;
					else if (block.type === "redactedThinking") parts.thinking += block.data?.length ?? 0;
					else if (block.type === "toolCall")
						parts.calls += (block.name?.length ?? 0) + (JSON.stringify(block.arguments) ?? "").length;
				}
				break;
			case "toolResult":
				output(message.toolName ?? "tool", contentChars(message.content));
				break;
			case "bashExecution":
				output("bash", message.output?.length ?? 0);
				break;
			case "pythonExecution":
				output("python", message.output?.length ?? 0);
				break;
		}
	}
	return { parts, tools };
}

/** Largest-remainder split of `total` by `weights` (omp's `allocateTokens`); undefined when the weights cannot scale. */
function allocate(weights: readonly number[], total: number): number[] | undefined {
	const sum = weights.reduce((a, b) => a + b, 0);
	if (!(sum > 0)) return undefined;
	const shares = weights.map((weight, index) => {
		const exact = (total * weight) / sum;
		return { index, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
	});
	const remaining = total - shares.reduce((a, s) => a + s.tokens, 0);
	const ranked = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (let i = 0; i < remaining; i++) ranked[i]!.tokens++;
	return shares.map(s => s.tokens);
}

const OMP_ONLY_LABELS = new Set([
	"System prompt",
	"System context",
	"Instruction files",
	"Skills",
	"System tools",
	"Auto-compact buf",
]);

/**
 * The terminal's `/context` rows from omp's report (or Antigravity's synthesized report) and the transcript.
 * For omp reports: System Prompt, Instruction Files, Skills and Tools are omp's totals, Messages is split into the
 * terminal's message categories (and Tool Output per tool), then Auto-Compact Buffer and Free Space.
 * For non-omp reports without those omp-specific rows (e.g. Antigravity): keeps the reported rows (such as
 * `System & tools`), splits `Messages` by transcript share, and appends `Free Space` when present.
 */
export function contextOverview(
	rows: readonly ContextRow[],
	entries: readonly SessionEntry[],
): { rows: OverviewRow[]; split: boolean; omp: boolean } {
	const omp = rows.some(row => OMP_ONLY_LABELS.has(row.label)) || rows.every(row => row.label === "Messages");
	const taken = new Set<string>();
	const total = (...labels: string[]): number =>
		labels.reduce((sum, label) => {
			taken.add(label);
			return sum + (rows.find(row => row.label === label)?.tokens ?? 0);
		}, 0);
	const out: OverviewRow[] = omp
		? [
				{ key: "system-prompt", label: "System Prompt", tokens: total("System prompt", "System context") },
				{ key: "instruction-files", label: "Instruction Files", tokens: total("Instruction files") },
				{ key: "skills", label: "Skills", tokens: total("Skills") },
				{ key: "tools", label: "Tools", tokens: total("System tools") },
			]
		: [];
	const pushMessages = (messages: number): boolean => {
		const { parts, tools } = messageWeights(entries);
		const shares = allocate(
			MESSAGE_PARTS.map(([part]) => parts[part]),
			messages,
		);
		if (shares) {
			MESSAGE_PARTS.forEach(([part, label], i) => {
				out.push({ key: part, label, tokens: shares[i]! });
				if (part !== "output") return;
				const named = [...tools].sort((a, b) => b[1] - a[1]);
				const toolShares = allocate(
					named.map(([, chars]) => chars),
					shares[i]!,
				);
				named.forEach(([tool], j) => {
					out.push({ key: `output/${tool}`, label: tool, tokens: toolShares?.[j] ?? 0, child: true });
				});
			});
			return true;
		}
		out.push({ key: "messages", label: "Messages", tokens: messages });
		return false;
	};
	if (omp) {
		const split = pushMessages(total("Messages"));
		const buffer = total("Auto-compact buf");
		const free = total("Free");
		// Categories a newer omp adds keep their own rows.
		for (const row of rows)
			if (!taken.has(row.label)) out.push({ key: `other/${row.label}`, label: row.label, tokens: row.tokens });
		out.push(
			{ key: "buffer", label: "Auto-Compact Buffer", tokens: buffer },
			{ key: "free", label: "Free Space", tokens: free },
		);
		return { rows: out, split, omp: true };
	}
	let split = false;
	let free: number | undefined;
	for (const row of rows) {
		if (row.label === "Messages") {
			split = pushMessages(row.tokens);
		} else if (row.label === "Free") {
			free = row.tokens;
		} else {
			out.push({ key: `other/${row.label}`, label: row.label, tokens: row.tokens });
		}
	}
	if (free !== undefined) out.push({ key: "free", label: "Free Space", tokens: free });
	return { rows: out, split, omp: false };
}

/** The window size from the report's title (`Context window: 200000 tokens (12% used)`). */
export function contextWindow(title: string): number | null {
	const m = /Context window: (\d+) tokens/.exec(title);
	return m ? Number(m[1]) : null;
}
