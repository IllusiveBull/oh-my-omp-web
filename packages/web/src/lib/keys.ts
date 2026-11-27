/** React keys for a list of texts that may repeat: the text plus how many identical ones precede it. */
export function textKeys(texts: readonly string[]): string[] {
	const seen = new Map<string, number>();
	return texts.map(text => {
		const n = seen.get(text) ?? 0;
		seen.set(text, n + 1);
		return `${n}:${text}`;
	});
}
