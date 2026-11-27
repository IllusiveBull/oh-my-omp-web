import type { OmpThemeWire } from "@omp-web/protocol";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type { DaemonClient } from "../store/daemon-client";

/**
 * The machine's omp theme colours (`omp.theme`) as `--omp-dark-*` / `--omp-light-*` custom properties for an element's
 * style; app.css picks the palette matching the page. Kept when the machine goes offline; undefined until loaded.
 */
export function useOmpTheme(client: DaemonClient, machine: string, offline: boolean): CSSProperties | undefined {
	const [theme, setTheme] = useState<OmpThemeWire | null>(null);
	useEffect(() => {
		if (offline) return;
		let current = true;
		void client.request(machine, { t: "omp.theme" }).then(ack => {
			if (current && ack.ok) setTheme(ack.data as OmpThemeWire);
		});
		return () => {
			current = false;
		};
	}, [client, machine, offline]);
	return useMemo(() => {
		if (!theme) return undefined;
		const vars: Record<string, string> = {};
		for (const mode of ["dark", "light"] as const)
			for (const [token, value] of Object.entries(theme[mode]))
				if (token !== "name") vars[`--omp-${mode}-${token}`] = value;
		// Custom properties: React passes them through, CSSProperties does not name them.
		return vars as CSSProperties;
	}, [theme]);
}
