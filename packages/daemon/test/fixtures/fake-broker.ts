/**
 * A stand-in for `omp auth-broker serve` for the supervisor tests: it listens on the port in argv[2], answers
 * `/v1/healthz` and the authenticated `/v1/credentials/disabled`, and records what happened in the file named by
 * FAKE_BROKER_LOG (one line per event) so a test can see how it was started and stopped.
 *
 * FAKE_BROKER_MODE: `serve` (default) | `crash` (exit 3 after 150 ms) | `silent` (never listens) | `ignore-sigint`
 * (keeps running when asked to stop). FAKE_BROKER_TOKEN is the bearer token it accepts.
 */
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2]);
const mode = process.env.FAKE_BROKER_MODE ?? "serve";
const log = (line: string): void => {
	if (process.env.FAKE_BROKER_LOG) appendFileSync(process.env.FAKE_BROKER_LOG, `${line}\n`);
};
log(
	`start pid=${process.pid} home=${process.env.HOME} agentdir=${process.env.PI_CODING_AGENT_DIR ?? "-"} ` +
		`brokerurl=${process.env.OMP_AUTH_BROKER_URL ?? "-"} brokertoken=${process.env.OMP_AUTH_BROKER_TOKEN ? "set" : "-"}`,
);

if (mode === "silent") {
	setInterval(() => {}, 1000);
} else {
	Bun.serve({
		port,
		hostname: "127.0.0.1",
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/v1/healthz") return Response.json({ ok: true, version: "fake-1" });
			if (req.headers.get("authorization") !== `Bearer ${process.env.FAKE_BROKER_TOKEN}`) {
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			if (url.pathname === "/v1/credentials/disabled")
				return Response.json({ generatedAt: Date.now(), disabled: [] });
			return Response.json({ error: "no route" }, { status: 404 });
		},
	});
	if (mode === "crash") setTimeout(() => process.exit(3), 150);
}

process.on("SIGINT", () => {
	log("sigint");
	if (mode === "ignore-sigint") return;
	process.exit(0);
});
process.on("SIGTERM", () => {
	log("sigterm");
	process.exit(0);
});
