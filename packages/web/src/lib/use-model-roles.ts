import type { ModelRolesWire } from "@omp-web/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../store/daemon-client";

interface RolesCache {
	byCwd: Map<string, ModelRolesWire>;
	byMachine: Map<string, ModelRolesWire>;
}

const caches = new WeakMap<DaemonClient, RolesCache>();

function cacheOf(client: DaemonClient): RolesCache {
	let cache = caches.get(client);
	if (!cache) {
		cache = { byCwd: new Map(), byMachine: new Map() };
		caches.set(client, cache);
	}
	return cache;
}

/** Last-known model roles for `(machine, cwd)`, falling back to the machine's global roles while a new cwd loads. */
export function getCachedModelRoles(client: DaemonClient, machine: string, cwd?: string): ModelRolesWire | null {
	const cache = caches.get(client);
	if (!cache) return null;
	if (cwd) {
		const exact = cache.byCwd.get(`${machine}\0${cwd}`);
		if (exact) return exact;
	}
	return cache.byMachine.get(machine) ?? null;
}

export function cacheModelRoles(
	client: DaemonClient,
	machine: string,
	cwd: string | undefined,
	roles: ModelRolesWire,
): void {
	const cache = cacheOf(client);
	cache.byMachine.set(machine, roles);
	if (cwd) cache.byCwd.set(`${machine}\0${cwd}`, roles);
}

/** Drops per-cwd entries for `machine` after a global role edit so other projects do not briefly show pre-edit values. */
export function invalidateCachedModelRoles(client: DaemonClient, machine: string): void {
	const cache = caches.get(client);
	if (!cache) return;
	const prefix = `${machine}\0`;
	for (const key of cache.byCwd.keys()) {
		if (key.startsWith(prefix)) cache.byCwd.delete(key);
	}
}

/**
 * omp's model roles (`session.roles`) for the status line's role menu. Seeds immediately from the last-known roles on
 * this machine/cwd so switching sessions never hides the role chip, while refreshing in the background.
 */
export function useModelRoles(
	client: DaemonClient,
	machine: string,
	sessionId: string,
	cwd: string | undefined,
	enabled: boolean,
): { roles: ModelRolesWire | null; reload(): void } {
	const key = `${machine}\0${sessionId}`;
	const [fetched, setFetched] = useState<{ key: string; data: ModelRolesWire } | null>(null);
	const requestSeq = useRef(0);
	const cwdRef = useRef(cwd);
	cwdRef.current = cwd;

	const reload = useCallback((): void => {
		const seq = ++requestSeq.current;
		void client.request(machine, { t: "session.roles", sessionId }).then(ack => {
			if (!ack.ok) return;
			const data = ack.data as ModelRolesWire;
			cacheModelRoles(client, machine, cwdRef.current, data);
			if (requestSeq.current === seq) setFetched({ key, data });
		});
	}, [client, machine, sessionId, key]);

	useEffect(() => {
		if (!enabled) {
			requestSeq.current++;
			setFetched(null);
			return;
		}
		reload();
		return () => {
			requestSeq.current++;
		};
	}, [enabled, reload]);

	const roles = enabled ? ((fetched?.key === key ? fetched.data : null) ?? getCachedModelRoles(client, machine, cwd)) : null;
	return { roles, reload };
}
