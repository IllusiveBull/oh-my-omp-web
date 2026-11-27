import { useEffect, useState } from "react";

/**
 * The current time, refreshed while `active` (a countdown only ticks while it is on screen) at each multiple of
 * `intervalMs` of the wall clock, so every clock on the page (status line, sub-agent rows) ticks at the same instant.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		let timer: ReturnType<typeof setTimeout>;
		const tick = (): void => {
			const at = Date.now();
			setNow(at);
			timer = setTimeout(tick, intervalMs - (at % intervalMs));
		};
		tick();
		return () => clearTimeout(timer);
	}, [active, intervalMs]);
	return now;
}
