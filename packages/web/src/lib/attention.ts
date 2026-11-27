/** `url` as a parsed URL when it is http(s); anything else (`javascript:`, `file:`, garbage) is never made clickable. */
export function parseHttpUrl(url: string): URL | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
	} catch {
		return null;
	}
}

/** One-line excerpt of a suggested composer text. */
export function previewText(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** What `Use` does: put `suggested` into the draft without losing what the user already typed. */
export function appendDraft(draft: string, suggested: string): string {
	return draft === "" ? suggested : `${draft}\n${suggested}`;
}
