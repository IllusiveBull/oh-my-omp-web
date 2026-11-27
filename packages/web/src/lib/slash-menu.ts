import type { SlashCommandWire } from "@omp-web/protocol";

const MAX_ITEMS = 100;

/**
 * Commands whose argument is a model (`/model`, alias `/models`; `/switch`): typed with a space, the menu offers the
 * session's models (omp's RPC mode only prints the current model for the bare word).
 */
const MODEL_COMMANDS: Record<string, true> = { model: true, switch: true };

/** One row of the menu: a command, or an argument of the command being typed. */
export interface SlashItem {
	key: string;
	label: string;
	hint?: string;
	description?: string;
	/** The draft after picking it. */
	fill: string;
	/** Picking runs it at once: a model is a complete choice, nothing is left to type. */
	submit: boolean;
	/** Picking opens the model hub instead (`/model`, as in the terminal UI: roles and their models). */
	hub?: true;
}

export interface SlashMenu {
	stage: "command" | "argument";
	items: SlashItem[];
	/** The argument stage of a model command while the models are not loaded yet. */
	loading: boolean;
}

const closed: SlashMenu = { stage: "command", items: [], loading: false };

/** The text after a leading `/` while the draft is still a bare command word (no whitespace yet), else null. */
export function slashQuery(draft: string): string | null {
	return draft.startsWith("/") && !/\s/.test(draft) ? draft.slice(1).toLowerCase() : null;
}

/** `/word arg` with a single-line, still unspaced argument (possibly empty), else null. */
function argumentQuery(draft: string): { word: string; arg: string } | null {
	const m = /^\/(\S+)[ \t]+(\S*)$/.exec(draft);
	return m ? { word: m[1]!, arg: m[2]! } : null;
}

function findCommand(commands: readonly SlashCommandWire[], word: string): SlashCommandWire | undefined {
	const w = word.toLowerCase();
	return commands.find(c => c.name.toLowerCase() === w || (c.aliases ?? []).some(a => a.toLowerCase() === w));
}

const isModelCommand = (command: SlashCommandWire): boolean => MODEL_COMMANDS[command.name] === true;

/** Whether the draft is at the argument of a model command: the menu then needs the session's models. */
export function wantsModels(commands: readonly SlashCommandWire[], draft: string): boolean {
	const q = argumentQuery(draft);
	const command = q && findCommand(commands, q.word);
	return !!command && isModelCommand(command);
}

/** 0: prefix, 1: substring; null: no match. */
function rankText(text: string, query: string): number | null {
	const t = text.toLowerCase();
	if (t.startsWith(query)) return 0;
	return t.includes(query) ? 1 : null;
}

/** 0: name prefix, 1: alias prefix, 2: name substring, 3: alias substring; null: no match. */
function rank(command: SlashCommandWire, query: string): number | null {
	const name = rankText(command.name, query);
	const alias = Math.min(...(command.aliases ?? []).map(a => rankText(a, query) ?? Infinity));
	if (name === 0) return 0;
	if (alias === 0) return 1;
	if (name === 1) return 2;
	return alias === 1 ? 3 : null;
}

function ranked<T>(values: readonly T[], score: (value: T) => number | null): T[] {
	const kept: { value: T; rank: number; index: number }[] = [];
	values.forEach((value, index) => {
		const r = score(value);
		if (r !== null) kept.push({ value, rank: r, index });
	});
	kept.sort((a, b) => a.rank - b.rank || a.index - b.index);
	return kept.slice(0, MAX_ITEMS).map(entry => entry.value);
}

/** Commands matching the command word the draft starts with, best matches first; empty unless the draft is `/word`. */
export function filterSlashCommands(commands: readonly SlashCommandWire[], draft: string): SlashCommandWire[] {
	const query = slashQuery(draft);
	return query === null ? [] : ranked(commands, command => rank(command, query));
}

/** The draft after picking `command`: the user continues with its arguments. */
export function applySlashCommand(command: SlashCommandWire): string {
	return `/${command.name} `;
}

/**
 * What the menu offers for `draft`: matching commands while the command word is typed, then that command's arguments —
 * the session's models (`models`, null while unknown) for a model command, else its declared subcommands.
 */
export function slashMenu(
	commands: readonly SlashCommandWire[],
	draft: string,
	models: readonly string[] | null,
): SlashMenu {
	if (slashQuery(draft) !== null) {
		const items = filterSlashCommands(commands, draft).map((command): SlashItem => ({
			key: command.name,
			label: `/${command.name}`,
			hint: command.input?.hint,
			description: command.description,
			fill: applySlashCommand(command),
			submit: false,
			...(command.name === "model" ? { hub: true as const } : {}),
		}));
		return { stage: "command", items, loading: false };
	}
	const q = argumentQuery(draft);
	const command = q && findCommand(commands, q.word);
	if (!q || !command) return closed;
	const arg = q.arg.toLowerCase();
	if (isModelCommand(command)) {
		const items = ranked(models ?? [], model => rankText(model, arg)).map((model): SlashItem => ({
			key: model,
			label: model,
			fill: `/${q.word} ${model}`,
			submit: true,
		}));
		return { stage: "argument", items, loading: models === null };
	}
	const items = ranked(command.subcommands ?? [], sub => rankText(sub.name, arg)).map((sub): SlashItem => ({
		key: sub.name,
		label: sub.name,
		hint: sub.usage,
		description: sub.description,
		// More to type after it: leave the cursor past a space (which also closes the menu).
		fill: `/${q.word} ${sub.name}${sub.usage ? " " : ""}`,
		submit: false,
	}));
	return { stage: "argument", items, loading: false };
}

/**
 * What Enter does while the menu shows `item`:
 * - a command typed out in full runs, except a model command, which opens the model hub (`/model`) or its model list
 *   (`/switch`): the bare word only prints the current model;
 * - a model is picked (and runs);
 * - a subcommand is completed once the user typed part of it or moved through the list; with nothing typed after the
 *   command (`/compact `) Enter runs the bare command, and once the draft already is the subcommand, Enter runs it.
 */
export function enterAction(
	commands: readonly SlashCommandWire[],
	draft: string,
	item: SlashItem,
	navigated: boolean,
): "pick" | "send" {
	const typed = draft.trim();
	if (slashQuery(draft) !== null) {
		if (typed !== `/${item.key}`) return "pick";
		const command = findCommand(commands, item.key);
		return command && isModelCommand(command) ? "pick" : "send";
	}
	if (item.submit) return "pick";
	if (typed === item.fill.trim()) return "send";
	return argumentQuery(draft)?.arg || navigated ? "pick" : "send";
}
