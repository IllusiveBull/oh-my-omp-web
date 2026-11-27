/**
 * Model-facing custom messages, made readable for the transcript.
 *
 * omp delivers a finished background job as an `async-result` custom message whose text is written for the model: a
 * `<system-notice>` envelope, "Resume your work…", `<task-result>` / `<output>` / `<preview>` tags, and follow-up hints
 * (`X is now idle — message it via write agent://X`). Upstream's transcript shows that text as Markdown under a chip, so
 * the tags and hints showed up verbatim. Its terminal renders a "Background job completed" row from `details` instead.
 *
 * Here each such entry is replaced, before the transcript sees it. A command job (`bash`) becomes a tool card like the
 * call that started it: a synthetic assistant entry calling `bash` with the job's command, paired with a result entry
 * holding the command's output, its status as the bash card's `async <status>` badge and its duration as wall time.
 * Other jobs (sub-agents, eval) get a custom entry with a job header per job (status, name, kind, duration from
 * `details.jobs`) and the job's own output: the agent's report as Markdown, anything else as a code block. A delivery
 * mixing both keeps its job order, one entry per run of the same kind. Agent-to-agent traffic (`irc:*`) gets the
 * terminal IRC card's title as its chip and the agent's message as its body. Any other displayed custom message only
 * loses a `<system-notice>` envelope. An assistant message's thinking text loses its surrounding blank lines: models end
 * it with "\n\n", which the expanded block (`white-space: pre-wrap`) showed as an empty last line. Results are cached
 * per entry, so an unchanged entry keeps its identity (upstream's rows are memoised on it).
 */
import { formatDuration } from "@oh-my-pi/pi-utils/format";
import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";

type CustomEntry = Extract<SessionEntry, { type: "custom_message" }>;
type MessageEntry = Extract<SessionEntry, { type: "message" }>;

interface JobDetails {
	jobId: string;
	type?: string;
	status?: string;
	label?: string;
	durationMs?: number;
}

const ASYNC_RESULT = "async-result";
/**
 * The delivery's own words at the top of a job's text (one line per sentence now, one line for both in older omp), not
 * the job's.
 */
const DELIVERY_PREFIX =
	/^(Background job .*? has completed\.\s*|\d+ background jobs have completed\.\s*)?(Resume your work using the results? below\.\s*)?/;
/** Hints to the model on how to follow up with the job's agent. */
const HINT_LINE = /^(\S+ is now idle — message it via .*|Agent: (agent|history):\/\/\S+(, history:\/\/\S+)?)$/;
/** A line that is only a harness tag: dropped, its content stays. */
const TAG_LINE =
	/^<\/?(system-notice|task-result|output|response|activity|vibe-turn|preview)\b[^>]*>$|^<meta\b[^>]*\/>$/;
const ERROR_LINE = /^<error>([\s\S]*)<\/error>$/;
const PREVIEW_OPEN = /^<preview\b[^>]*\bfull-output="([^"]*)"[^>]*>$/;

const cache = new WeakMap<SessionEntry, readonly SessionEntry[]>();

/** The entries rewritten for reading (see above); the same array when none needs it. */
export function presentEntries(entries: readonly SessionEntry[]): readonly SessionEntry[] {
	let out: SessionEntry[] | null = null;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const shown = presented(entry);
		if (out === null) {
			if (shown === null || (shown.length === 1 && shown[0] === entry)) continue;
			out = entries.slice(0, i);
		}
		if (shown === null) out.push(entry);
		else out.push(...shown);
	}
	return out ?? entries;
}

/** What `entry` shows as; null for entries never rewritten. */
function presented(entry: SessionEntry): readonly SessionEntry[] | null {
	let shown = cache.get(entry);
	if (shown !== undefined) return shown;
	if (entry.type === "custom_message" && entry.display) shown = present(entry);
	else if (entry.type === "message" && entry.message.role === "assistant") shown = [trimThinking(entry)];
	else return null;
	cache.set(entry, shown);
	return shown;
}

function trimThinking(entry: MessageEntry): MessageEntry {
	const message = entry.message as AssistantMessage;
	if (!message.content.some(block => block.type === "thinking" && block.thinking !== block.thinking.trim()))
		return entry;
	const content = message.content.map(block =>
		block.type === "thinking" ? { ...block, thinking: block.thinking.trim() } : block,
	);
	return { ...entry, message: { ...message, content } };
}

function present(entry: CustomEntry): readonly SessionEntry[] {
	const irc = ircCard(entry);
	if (irc) return [irc];
	const text = textOf(entry.content);
	const images = typeof entry.content === "string" ? [] : entry.content.filter(block => block.type === "image");
	const jobs = entry.customType === ASYNC_RESULT ? jobsOf(entry.details) : [];
	if (jobs.length > 0) return asyncResult(entry, text, jobs, images) ?? [entry];
	const body = unwrapNotice(text);
	if (body === null) return [entry];
	return [{ ...entry, content: images.length > 0 ? [{ type: "text", text: body }, ...images] : body }];
}

/**
 * Agent-to-agent traffic as the terminal's IRC card shows it: a title naming the endpoints and the agent's own message
 * from `details`. `irc:incoming` content is the `<irc>` envelope written for the model (reply instructions included);
 * relay and pool cards prefix the same body with a bracketed header.
 */
function ircCard(entry: CustomEntry): CustomEntry | null {
	const kind = IRC_KINDS[entry.customType];
	if (kind === undefined || typeof entry.details !== "object" || entry.details === null) return null;
	const details = entry.details as Record<string, unknown>;
	const str = (key: string): string | undefined => {
		const value = details[key];
		return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
	};
	const body = kind === "incoming" ? details.message : details.body;
	if (typeof body !== "string") return null;
	const from = str("from") ?? "?";
	const to = str("to") ?? "?";
	const title =
		kind === "incoming"
			? `IRC ← ${from}`
			: kind === "autoreply"
				? `IRC → ${to}`
				: kind === "workpool"
					? `Pool ${str("pool") ?? "?"} → ${to}`
					: `IRC ${from} → ${to}`;
	const meta = [
		kind === "autoreply" ? "auto" : undefined,
		kind === "workpool" ? str("mode") : undefined,
		details.progress === true ? "progress" : undefined,
		str("replyTo") ? "reply" : undefined,
	].filter(Boolean);
	return { ...entry, customType: [title, ...meta].join(" · "), content: body };
}

const IRC_KINDS: Record<string, "incoming" | "autoreply" | "relay" | "workpool"> = {
	"irc:incoming": "incoming",
	"irc:autoreply": "autoreply",
	"irc:relay": "relay",
	"irc:workpool": "workpool",
};

function textOf(content: CustomEntry["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function jobsOf(details: unknown): JobDetails[] {
	if (typeof details !== "object" || details === null || !("jobs" in details) || !Array.isArray(details.jobs))
		return [];
	return details.jobs.filter(
		(job): job is JobDetails => typeof job === "object" && job !== null && typeof job.jobId === "string",
	);
}

/**
 * The delivery as entries: each run of command jobs as tool cards, each run of other jobs as one custom entry. Null
 * when the text is not shaped as expected. Images go with the first entry: the delivery does not say whose they are.
 */
function asyncResult(
	entry: CustomEntry,
	text: string,
	jobs: readonly JobDetails[],
	images: readonly ImageContent[],
): SessionEntry[] | null {
	const bodies = jobSections(text, jobs);
	if (bodies === null) return null;
	const out: SessionEntry[] = [];
	for (let start = 0; start < jobs.length;) {
		const command = jobs[start]!.type === "bash";
		let end = start + 1;
		while (end < jobs.length && (jobs[end]!.type === "bash") === command) end++;
		const run = jobs.slice(start, end);
		const runBodies = bodies.slice(start, end);
		const runImages = start === 0 ? images : [];
		if (command) out.push(...commandCards(entry, start, run, runBodies, runImages));
		else out.push(reportEntry(entry, start, run, runBodies, runImages));
		start = end;
	}
	return out;
}

/** One assistant entry calling `bash` once per job, then one result entry per call, as a live call is recorded. */
function commandCards(
	entry: CustomEntry,
	start: number,
	jobs: readonly JobDetails[],
	bodies: readonly string[][],
	images: readonly ImageContent[],
): SessionEntry[] {
	const timestamp = Date.parse(entry.timestamp) || 0;
	const callId = (job: JobDetails): string => `${entry.id}/${job.jobId}`;
	const call: SessionEntry = {
		type: "message",
		id: `${entry.id}/${start}`,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		message: {
			role: "assistant",
			content: jobs.map(job => ({
				type: "toolCall" as const,
				id: callId(job),
				name: "bash",
				arguments: { command: job.label ?? job.jobId },
			})),
			model: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "stop",
			timestamp,
		},
	};
	const results = jobs.map((job, i): SessionEntry => {
		const output = jobText(bodies[i]!, false);
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: callId(job),
			toolName: "bash",
			content: [...(output === "" ? [] : [{ type: "text" as const, text: output }]), ...(i === 0 ? images : [])],
			details: { async: { state: job.status ?? "completed", jobId: job.jobId }, wallTimeMs: job.durationMs },
			isError: job.status === "failed",
			timestamp,
		};
		return { type: "message", id: callId(job), parentId: entry.parentId, timestamp: entry.timestamp, message };
	});
	return [call, ...results];
}

/** Jobs as Markdown: a header per job, then its output. The first run keeps the delivery's id. */
function reportEntry(
	entry: CustomEntry,
	start: number,
	jobs: readonly JobDetails[],
	bodies: readonly string[][],
	images: readonly ImageContent[],
): CustomEntry {
	const body = jobs.map((job, i) => `${header(job)}\n\n${jobBody(bodies[i]!, job)}`.trimEnd()).join("\n\n---\n\n");
	return {
		...entry,
		id: start === 0 ? entry.id : `${entry.id}/${start}`,
		customType: jobs.length > 1 ? `${jobs.length} background jobs` : "background job",
		content: images.length > 0 ? [{ type: "text", text: body }, ...images] : body,
	};
}

/**
 * Each job's lines. Null when the text is not shaped as expected. Several jobs are separated by
 * `── Job <id> (<label>) ──`, and a label may span lines (a multi-line command), so each separator is found by the next
 * job's id and runs to the line that ends in ` ──`.
 */
function jobSections(text: string, jobs: readonly JobDetails[]): string[][] | null {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const sections: string[][] = [[]];
	let inSeparator = false;
	for (const line of lines) {
		const next = jobs.length > 1 ? jobs[sections.length - 1] : undefined;
		if (next && line.startsWith(`── Job ${next.jobId}`)) {
			sections.push([]);
			inSeparator = !line.endsWith(" ──");
		} else if (inSeparator) inSeparator = !line.endsWith(" ──");
		else sections.at(-1)!.push(line);
	}
	// With several jobs the text before the first separator is the delivery's own line.
	const bodies = jobs.length > 1 ? sections.slice(1) : sections;
	return bodies.length === jobs.length ? bodies : null;
}

function header(job: JobDetails): string {
	const mark = job.status === "failed" ? "✗" : job.status === "cancelled" ? "⊘" : "✓";
	const name = job.type === "task" ? (job.label ?? job.jobId) : job.jobId;
	const facts = [job.type, typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined];
	const head = [`**${mark} ${name.replace(/[\\`*_[\]<>]/g, "\\$&")}**`, ...facts.filter(Boolean)].join(" · ");
	if (job.type === "task" || job.label === undefined || job.label === job.jobId) return head;
	// A command's first line names it; a multi-line one would break the inline code span.
	const [first, ...more] = job.label.split("\n");
	return `${head}\n\n${inlineCode(more.length > 0 ? `${first} …` : first!)}`;
}

function jobBody(lines: readonly string[], job: JobDetails): string {
	const body = jobText(lines, true);
	// Only an agent's report is Markdown.
	return body === "" || job.type === "task" ? body : fence(body);
}

/** A job's own output, without the delivery's words, harness tags and hints; `markdown` styles the notes it adds. */
function jobText(lines: readonly string[], markdown: boolean): string {
	const kept: string[] = [];
	let leading = true;
	for (const raw of lines) {
		const line = raw.trim();
		const preview = PREVIEW_OPEN.exec(line);
		if (preview) {
			const where = markdown ? inlineCode(preview[1]!) : preview[1]!;
			kept.push(markdown ? `_Preview; full output at ${where}_` : `[Preview; full output at ${where}]`, "");
			continue;
		}
		if (TAG_LINE.test(line) || HINT_LINE.test(line)) continue;
		let text = raw;
		if (leading) {
			const rest = line.replace(DELIVERY_PREFIX, "");
			if (rest === "") continue;
			if (rest !== line) text = rest;
			leading = false;
		}
		const error = ERROR_LINE.exec(line);
		kept.push(error ? `${markdown ? "**Error:**" : "Error:"} ${error[1]}` : text);
	}
	return kept.join("\n").trim();
}

function unwrapNotice(text: string): string | null {
	const match = /^\s*<system-notice\b[^>]*>\n?([\s\S]*?)\n?<\/system-notice>\s*$/.exec(text);
	return match ? match[1]!.trim() : null;
}

function fence(text: string): string {
	const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), m => m[0].length));
	const marks = "`".repeat(longest + 1);
	return `${marks}text\n${text}\n${marks}`;
}

function inlineCode(text: string): string {
	const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), m => m[0].length));
	const marks = "`".repeat(longest + 1);
	return `${marks}${longest > 0 ? " " : ""}${text}${longest > 0 ? " " : ""}${marks}`;
}
