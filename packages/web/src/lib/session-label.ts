import type { SessionInfo } from "@omp-web/protocol";

function cleanName(value: string | undefined): string | undefined {
	const firstLine = value?.split(/\r?\n/, 1)[0];
	return firstLine?.replace(/[\x00-\x1F\x7F]/g, "").trim() || undefined;
}

/** Matches omp's picker: session name, first prompt, then an untitled timestamp; never the project path. */
export function sessionLabel(
	info: Pick<SessionInfo, "title" | "preview" | "createdAt" | "modifiedAt"> | undefined,
	sessionName?: string,
): string {
	const title = cleanName(sessionName) ?? cleanName(info?.title);
	if (title) return title;
	const prompt = info?.preview !== "(no messages)" ? cleanName(info?.preview) : undefined;
	if (prompt) return prompt;
	if (!info) return "Untitled";
	const timestamp = Number.isFinite(info.createdAt) ? info.createdAt : info.modifiedAt;
	const time = new Date(timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	return `Untitled · ${time}`;
}
