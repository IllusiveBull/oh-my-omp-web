import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { GoalWire, SessionCapabilities, SlashCommandWire } from "@omp-web/protocol";

/**
 * omp builtins that only run in its terminal UI (RPC mode has no handler for them, and the daemon refuses them), done
 * here with omp-web's own equivalents. Offered in the slash menu beside the session's commands.
 */
export const WEB_COMMANDS = [
	{ name: "new", description: "Start a new session (as the sidebar's New session) and open it", source: "builtin" },
	{ name: "fork", description: "Fork this session into a new one and open it", source: "builtin" },
	{
		name: "btw",
		description: "Ask a side question, or open this session's BTW history",
		input: { hint: "[question]" },
		source: "builtin",
	},
	{
		name: "queue",
		description: "Queue a message for after the agent yields",
		input: { hint: "<message>" },
		source: "builtin",
	},
	{ name: "copy", description: "Copy the last assistant reply to the clipboard", source: "builtin" },
	{
		name: "hub",
		aliases: ["subagents"],
		description: "Open the Agents tab (this session's sub-agents)",
		source: "builtin",
	},
	{
		name: "goal",
		description: "Set a goal the agent keeps working on (omp's goal mode), or pause, resume or drop it",
		input: { hint: "[objective]" },
		subcommands: [
			{ name: "set", description: "Set the goal", usage: "<objective>" },
			{ name: "pause", description: "Pause the current goal" },
			{ name: "resume", description: "Resume a paused goal" },
			{ name: "drop", description: "Drop the current goal" },
		],
		source: "builtin",
	},
	{
		name: "loop",
		description:
			"Toggle loop mode: the next prompt sent repeats after every run; bound it with a count or duration, or gate it with --until/--while '<cmd>'",
		input: { hint: "[count|duration] [--while|--until '<cmd>'] [prompt]" },
		source: "builtin",
	},
	{ name: "exit", aliases: ["quit", "q"], description: "Close this session", source: "builtin" },
] as const satisfies readonly SlashCommandWire[];

export type WebCommandName = (typeof WEB_COMMANDS)[number]["name"];

const named = (command: SlashCommandWire, word: string): boolean =>
	command.name === word || (command.aliases?.includes(word) ?? false);

function allowedWebCommand(name: WebCommandName, capabilities?: SessionCapabilities): boolean {
	if (!capabilities) return true;
	switch (name) {
		case "fork":
			return capabilities.fork;
		case "btw":
			return capabilities.btw;
		case "queue":
			return capabilities.followUp;
		case "hub":
			return capabilities.subagents;
		case "goal":
			return capabilities.goal;
		case "loop":
			return capabilities.loop;
		case "new":
		case "copy":
		case "exit":
			return true;
	}
}

/** The session's commands plus the supported web commands none of them shadows. */
export function withWebCommands(
	commands: readonly SlashCommandWire[],
	capabilities?: SessionCapabilities,
): SlashCommandWire[] {
	const missing = WEB_COMMANDS.filter(
		web => allowedWebCommand(web.name, capabilities) && !commands.some(c => named(c, web.name)),
	);
	return missing.length === 0 ? [...commands] : [...commands, ...missing];
}

/**
 * The web command `message` invokes (with its argument text), or null when it is none — or when a session command of
 * that name or alias (an extension, a file command, …) exists: omp runs that one.
 */
export function parseWebCommand(
	message: string,
	commands: readonly SlashCommandWire[],
	capabilities?: SessionCapabilities,
): { name: WebCommandName; args: string } | null {
	const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(message.trim());
	if (!m) return null;
	const word = m[1]!;
	const web = WEB_COMMANDS.find(c => named(c, word));
	if (!web || !allowedWebCommand(web.name, capabilities) || commands.some(c => named(c, word))) return null;
	return { name: web.name, args: (m[2] ?? "").trim() };
}

/** The text of the newest assistant reply that has any (`/copy`), or null. */
export function lastAssistantText(entries: readonly SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.flatMap(part => (part.type === "text" ? [part.text] : []))
			.join("\n")
			.trim();
		if (text) return text;
	}
	return null;
}

/**
 * What `/goal args` asks for: an op for the daemon, `show` (the status line already shows the goal: nothing to send),
 * or an error for the composer.
 */
export function goalCommand(
	args: string,
	goal: GoalWire | undefined,
): { op: "create"; objective: string } | { op: "pause" | "resume" | "drop" } | { op: "show" } | { error: string } {
	const [word = "", ...rest] = args.split(/\s+/).filter(Boolean);
	const tail = args.trim().slice(word.length).trim();
	switch (word) {
		case "":
		case "show":
			return goal ? { op: "show" } : { error: "No goal yet: /goal <objective> sets one" };
		case "pause":
		case "resume":
		case "drop":
			if (rest.length > 0) return { error: `/goal ${word} takes no argument` };
			return { op: word };
		case "set":
			return tail === "" ? { error: "/goal set needs an objective" } : { op: "create", objective: tail };
		default:
			return { op: "create", objective: args.trim() };
	}
}
