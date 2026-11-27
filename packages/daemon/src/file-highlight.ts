/**
 * Syntax highlighting for the file viewer, with upstream's native highlighter (`@oh-my-pi/pi-natives`, syntect). It
 * returns ANSI-coloured text for a theme given as escape sequences; the "colours" passed here are private markers, so the
 * answer can be turned into plain `[kind, length]` runs the browser renders itself (no HTML, no ANSI crosses the wire).
 * Pages are highlighted independently: the daemon keeps no parser state between requests.
 */
import { highlightCode, supportsLanguage } from "@oh-my-pi/pi-natives";
import { HIGHLIGHT_KINDS } from "@omp-web/protocol";

/** Marker per HIGHLIGHT_KINDS entry, in order: ESC-free, control characters that are rejected in the input beforehand. */
const LETTERS = "CKFVSNTOPID";
const COLORS = {
	comment: "\x01C\x02",
	keyword: "\x01K\x02",
	function: "\x01F\x02",
	variable: "\x01V\x02",
	string: "\x01S\x02",
	number: "\x01N\x02",
	type: "\x01T\x02",
	operator: "\x01O\x02",
	punctuation: "\x01P\x02",
	inserted: "\x01I\x02",
	deleted: "\x01D\x02",
};
if (LETTERS.length !== HIGHLIGHT_KINDS.length) throw new Error("highlight markers out of step with HIGHLIGHT_KINDS");

/** The native highlighter runs on the daemon's event loop (~1.5 ms per KiB of dense code): bigger pages are shown plain. */
export const HIGHLIGHT_MAX_CHARS = 128 * 1024;
const MARK = "\x01";
const RESET = "\x1b[39m";
/** Source containing the markers' characters is not highlighted: it could not be told from the markers. */
const confusable = (text: string): boolean => text.includes(MARK) || text.includes("\x02") || text.includes("\x1b");

/** The highlighter's language for a file name (extension or well-known name), or null. */
export function languageFor(path: string): string | null {
	const base = path.split("/").at(-1) ?? "";
	const dot = base.lastIndexOf(".");
	const candidates = [base, dot > 0 ? base.slice(dot + 1) : dot === 0 ? base.slice(1) : ""];
	for (const candidate of candidates) {
		if (candidate !== "" && supportsLanguage(candidate)) return candidate.toLowerCase();
	}
	return null;
}

/**
 * Flattened `[kind, length, …]` runs over `text` (kind 0 plain, k = HIGHLIGHT_KINDS[k-1]), or null when the language is
 * unknown, the text is not safe to highlight, nothing was coloured, or the answer does not reproduce the text.
 */
export function highlightSpans(text: string, lang: string | null): number[] | null {
	if (lang === null || text === "" || text.length > HIGHLIGHT_MAX_CHARS || confusable(text)) return null;
	let marked: string;
	try {
		marked = highlightCode(text, lang, COLORS);
	} catch {
		return null;
	}
	const runs: number[] = [];
	const plain: string[] = [];
	let kind = 0;
	const add = (piece: string): void => {
		if (piece === "") return;
		plain.push(piece);
		const last = runs.length - 2;
		if (last >= 0 && runs[last] === kind) runs[last + 1]! += piece.length;
		else runs.push(kind, piece.length);
	};
	for (let at = 0; at < marked.length;) {
		const mark = marked.indexOf(MARK, at);
		const reset = marked.indexOf(RESET, at);
		const next = mark < 0 ? reset : reset < 0 ? mark : Math.min(mark, reset);
		if (next < 0) {
			add(marked.slice(at));
			break;
		}
		add(marked.slice(at, next));
		if (next === mark) {
			kind = LETTERS.indexOf(marked[next + 1] ?? "") + 1; // `\x01<letter>\x02`
			at = next + 3;
		} else {
			kind = 0;
			at = next + RESET.length;
		}
	}
	// An answer that is not the input with markers added cannot be trusted to line up with the text.
	if (plain.join("") !== text) return null;
	return runs.length === 2 && runs[0] === 0 ? null : runs;
}
