import type { OmpThemeWire } from "@omp-web/protocol";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type { DaemonClient } from "../store/daemon-client";

const themeCaches = new WeakMap<DaemonClient, Map<string, OmpThemeWire>>();

function getCachedTheme(client: DaemonClient, machine: string): OmpThemeWire | null {
	return themeCaches.get(client)?.get(machine) ?? null;
}

function setCachedTheme(client: DaemonClient, machine: string, theme: OmpThemeWire): void {
	let byMachine = themeCaches.get(client);
	if (!byMachine) {
		byMachine = new Map();
		themeCaches.set(client, byMachine);
	}
	byMachine.set(machine, theme);
}

/**
 * The machine's omp theme colours (`omp.theme`) as `--omp-dark-*` / `--omp-light-*` custom properties for an element's
 * style; app.css picks the palette matching the page. Kept across session switches and when the machine goes offline.
 */
export function useOmpTheme(client: DaemonClient, machine: string, offline: boolean): CSSProperties | undefined {
	const [fetched, setFetched] = useState<{ machine: string; data: OmpThemeWire } | null>(null);
	const theme = (fetched?.machine === machine ? fetched.data : null) ?? getCachedTheme(client, machine);
	useEffect(() => {
		if (offline) return;
		let current = true;
		void client.request(machine, { t: "omp.theme" }).then(ack => {
			if (!ack.ok) return;
			const data = ack.data as OmpThemeWire;
			setCachedTheme(client, machine, data);
			if (current) setFetched({ machine, data });
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
