import type { ReactNode } from "react";
import { formatAbsolute, formatCountdown, formatRelative } from "../lib/time";

interface Props {
	/** Epoch ms. */
	at: number;
	/** What "now" is for the relative form (epoch ms). */
	now: number;
	/** Show the absolute time after the relative one ("5 minutes ago (Nov 12, 2026, 15:04)"); otherwise it is the tooltip. */
	absolute?: boolean;
	/** Relative form to the hour/minute ("in 4d 7h") instead of the coarsest unit ("in 4 days"). */
	precise?: boolean;
}

/** A point in time: relative to now, with the absolute time as well. Both come from `Intl`. */
export function Moment({ at, now, absolute = false, precise = false }: Props): ReactNode {
	const exact = formatAbsolute(at);
	return (
		<time dateTime={new Date(at).toISOString()} title={exact}>
			{precise ? formatCountdown(at, now) : formatRelative(at, now)}
			{absolute ? ` (${exact})` : ""}
		</time>
	);
}
