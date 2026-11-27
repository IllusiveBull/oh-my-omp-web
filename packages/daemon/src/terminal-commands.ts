import type { SlashCommandWire } from "@omp-web/protocol";

/**
 * Why `message` must not go to omp, or null when it may: omp's RPC mode forwards a builtin it has no text-mode handler
 * for (`/new`, `/tree`, `/plan`, `/settings`, … — they open terminal UI) to the model as an ordinary prompt. A session
 * command of the same name (extension, custom, file, skill: listed in `commands`) still runs and is let through.
 *
 * The registry is loaded on the first slash message only: it pulls in much of omp and the daemon rarely needs it.
 */
export async function terminalOnlyCommand(
	message: string,
	commands: readonly SlashCommandWire[],
): Promise<string | null> {
	const text = message.trimStart();
	if (!text.startsWith("/")) return null;
	const [{ parseSlashCommand }, { lookupBuiltinSlashCommand }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse"),
		import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry"),
	]);
	const parsed = parseSlashCommand(text);
	if (!parsed) return null;
	const builtin = lookupBuiltinSlashCommand(parsed.name);
	if (!builtin || builtin.handle) return null;
	if (commands.some(c => c.name === parsed.name || c.aliases?.includes(parsed.name))) return null;
	return `/${parsed.name} only works in omp's terminal UI; omp-web cannot run it`;
}
