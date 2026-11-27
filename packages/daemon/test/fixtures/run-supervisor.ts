/**
 * Runs a BrokerSupervisor around the fake broker in its own process, so a test can SIGKILL the "daemon" and look at the
 * broker child it leaves behind. Prints `running <child pid>` once the child answers, then waits.
 * Env: ORPHAN_PORT, ORPHAN_HOME, ORPHAN_LOG, ORPHAN_TOKEN.
 */
import { join } from "node:path";
import { BrokerSupervisor, spawnBrokerChild } from "../../src/broker-supervisor";

const port = Number(process.env.ORPHAN_PORT);
const home = process.env.ORPHAN_HOME!;
const supervisor = new BrokerSupervisor({
	ompPath: "omp-not-used",
	bind: { host: "127.0.0.1", port },
	home,
	env: { PATH: Bun.env.PATH },
	spawn: (_argv, env) =>
		spawnBrokerChild([process.execPath, join(import.meta.dir, "fake-broker.ts"), String(port)], {
			...env,
			FAKE_BROKER_LOG: process.env.ORPHAN_LOG,
			FAKE_BROKER_TOKEN: process.env.ORPHAN_TOKEN,
		}),
	getToken: async () => ({ token: process.env.ORPHAN_TOKEN!, path: join(home, ".omp", "auth-broker.token") }),
});
supervisor.onChange(() => {
	const status = supervisor.status();
	if (status.phase === "running" && status.healthy) console.log(`running ${status.pid}`);
});
supervisor.start();
setInterval(() => {}, 1000);
