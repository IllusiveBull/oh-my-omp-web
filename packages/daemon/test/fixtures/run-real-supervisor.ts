/**
 * A "daemon" for the live orphan test: a BrokerSupervisor around the real `omp auth-broker serve` in its own process, so the
 * test can hard-kill it and look at what it leaves behind. Prints `running <launcher pid>` once the broker answers.
 * Env: ORPHAN_OMP, ORPHAN_PORT, ORPHAN_HOME (the broker's HOME / USERPROFILE).
 */
import { BrokerSupervisor } from "../../src/broker-supervisor";

const supervisor = new BrokerSupervisor({
	ompPath: process.env.ORPHAN_OMP!,
	bind: { host: "127.0.0.1", port: Number(process.env.ORPHAN_PORT) },
	home: process.env.ORPHAN_HOME!,
	env: { ...Bun.env, ORPHAN_OMP: undefined },
});
supervisor.onChange(() => {
	const status = supervisor.status();
	if (status.phase === "running" && status.healthy) console.log(`running ${status.pid}`);
});
supervisor.start();
setInterval(() => {}, 1000);
