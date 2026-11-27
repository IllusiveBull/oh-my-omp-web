/**
 * Frame plumbing for the gateway's relay. Daemon frames can be large (snapshot chunks are ~256 KiB), so the gateway
 * must not parse and re-serialize them: it adds the machine id by splicing text and routes by a prefix.
 */

/** Adds `"m": machine` to a serialized JSON object frame without parsing it. */
export function tagFrame(frame: string, machine: string): string {
	if (!frame.startsWith("{") || frame.length < 3) throw new Error("tagFrame: not a JSON object frame");
	return `{"m":${JSON.stringify(machine)},${frame.slice(1)}`;
}

/**
 * A frame for one virtual client on the daemon <-> gateway link: `<cid>\n<frame>`. Link control messages are JSON
 * objects (they start with `{`), a client id never does, so the two cannot be confused.
 */
export function clientFrame(cid: string, frame: string): string {
	return `${cid}\n${frame}`;
}

/** Splits a {@link clientFrame}; null for a link control message (or anything else that is not one). */
export function parseClientFrame(text: string): { cid: string; frame: string } | null {
	if (text.startsWith("{")) return null;
	const split = text.indexOf("\n");
	if (split <= 0) return null;
	return { cid: text.slice(0, split), frame: text.slice(split + 1) };
}
