/**
 * A stand-in for `omp --mode rpc-ui` for the spawn tests: it records the environment it was started with in the file
 * named by FAKE_OMP_ENV_OUT, then either dies (FAKE_OMP_MODE=die, like omp does when it cannot reach its credential broker
 * and has no cached snapshot) or announces protocol v2 and answers the negotiation, which is all `OmpRpcSource.start()` needs.
 * Once started, a `set_session_name` command makes it write a line the reader rejects (a non-object frame) and die with
 * a stderr message, like an omp crashing mid-session.
 */
import { writeFileSync } from "node:fs";

writeFileSync(
	process.env.FAKE_OMP_ENV_OUT ?? "/dev/null",
	JSON.stringify({
		url: process.env.OMP_AUTH_BROKER_URL ?? null,
		token: process.env.OMP_AUTH_BROKER_TOKEN ?? null,
		title: process.env.PI_RPC_EMIT_TITLE ?? null,
		argv: process.argv.slice(2),
	}),
);

if (process.env.FAKE_OMP_MODE === "die") {
	console.error("Error: auth broker snapshot request failed: fetch failed");
	process.exit(1);
}

console.log(
	JSON.stringify({
		type: "ready",
		protocolVersion: 1,
		supportedProtocolVersions: [1, 2],
		maxFrameBytes: 1048576,
		maxReassembledFrameBytes: 67108864,
	}),
);
for await (const line of console) {
	const message = JSON.parse(line) as { id?: string; type?: string };
	if (message.type === "negotiate_protocol") {
		console.log(
			JSON.stringify({
				type: "response",
				id: message.id,
				command: "negotiate_protocol",
				success: true,
				data: { protocolVersion: 2 },
			}),
		);
	}
	if (message.type === "set_session_name") {
		console.error("fatal: something broke mid-session");
		// A line the reader rejects (not an object), then output until the write fails: omp exits on EPIPE once the
		// daemon stops reading its stdout.
		process.stdout.write("42\n");
		setInterval(() => {
			process.stdout.write(`${JSON.stringify({ type: "notice", message: "still here" })}\n`, error => {
				if (error) process.exit(1);
			});
		}, 20);
	}
}
