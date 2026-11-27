import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRolesWire } from "@omp-web/protocol";

/**
 * Model role assignments (`modelRoles` in omp's settings: role → `provider/id[:thinking]`), read and written through the
 * omp binary's own `omp config`, so the format and the layering (global `config.yml`, project settings) are those of
 * the omp that runs the sessions. Running omp processes watch their config files and pick a change up by themselves.
 */
export interface ModelRoleStore {
	/** The roles the terminal UI's model hub lists, with what each is set to as seen from `cwd`. */
	read(cwd: string): Promise<ModelRolesWire>;
	/**
	 * Sets (`selector`) or clears (null) a role in the global settings, like the terminal UI's hub does by default.
	 * Returns a warning when another layer still decides the effective value in `cwd`.
	 */
	write(cwd: string, role: string, selector: string | null): Promise<string | undefined>;
}

type RunConfig = (args: string[], cwd: string) => Promise<unknown>;

/** `omp config <args> --json`, parsed. Throws with omp's message when it fails. */
export function ompConfigRunner(ompPath: string, env: () => Record<string, string>): RunConfig {
	return async (args, cwd) => {
		const proc = Bun.spawn([ompPath, "config", ...args, "--json"], {
			cwd,
			env: { ...Bun.env, ...env() },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`omp config ${args[0]} failed: ${(err.trim() || out.trim()).slice(0, 500)}`);
		try {
			return JSON.parse(out);
		} catch {
			throw new Error(`omp config ${args[0]} printed non-JSON output: ${out.slice(0, 200)}`);
		}
	};
}

function stringRecord(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (isRecord(value)) for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
	return out;
}

/** `omp config get <key> --json` → its `value`. */
async function getValue(run: RunConfig, key: string, cwd: string): Promise<unknown> {
	const result = await run(["get", key], cwd);
	return isRecord(result) ? result.value : undefined;
}

export function ompModelRoles(run: RunConfig): ModelRoleStore {
	return {
		async read(cwd) {
			const [assigned, cycle, { MODEL_ROLE_IDS, MODEL_ROLES }] = await Promise.all([
				getValue(run, "modelRoles", cwd).then(stringRecord),
				getValue(run, "cycleOrder", cwd),
				// Names and sections of the built-in roles; loaded on first use only.
				import("@oh-my-pi/pi-coding-agent/config/model-roles"),
			]);
			// As the hub orders them: built-in chat roles, then roles only the cycle order or an assignment names. The
			// non-chat kinds (image, web search, speech, …) take models the session's model list does not carry.
			const ids: string[] = MODEL_ROLE_IDS.filter(
				id => MODEL_ROLES[id].section === "chat" && !MODEL_ROLES[id].hidden,
			);
			const builtIn = new Set<string>(MODEL_ROLE_IDS);
			const extra = [...(Array.isArray(cycle) ? cycle : []), ...Object.keys(assigned)];
			for (const id of extra) if (typeof id === "string" && !builtIn.has(id) && !ids.includes(id)) ids.push(id);
			const names: Record<string, string> = Object.fromEntries(MODEL_ROLE_IDS.map(id => [id, MODEL_ROLES[id].name]));
			const colors: Record<string, string> = Object.fromEntries(
				MODEL_ROLE_IDS.flatMap(id => (MODEL_ROLES[id].color ? [[id, MODEL_ROLES[id].color]] : [])),
			);
			return {
				roles: ids.map(id => ({ id, name: names[id] ?? id, color: colors[id], selector: assigned[id] })),
				cycle: Array.isArray(cycle) ? cycle.filter((id): id is string => typeof id === "string") : [],
			};
		},

		async write(cwd, role, selector) {
			// Read-modify-write of the global layer's own value, so roles set in other layers are not copied into it.
			const layer = await run(["list", "--scope", "global"], cwd);
			const entry = isRecord(layer) ? layer.modelRoles : undefined;
			const roles = stringRecord(isRecord(entry) ? entry.value : undefined);
			if (selector === null) delete roles[role];
			else roles[role] = selector;
			await run(["set", "modelRoles", JSON.stringify(roles)], cwd);
			const effective = stringRecord(await getValue(run, "modelRoles", cwd))[role];
			if (effective === (selector ?? undefined)) return undefined;
			return `Saved to the global settings, but in this project ${role} is ${effective ?? "unset"} (project settings or a --config overlay decide it).`;
		},
	};
}
