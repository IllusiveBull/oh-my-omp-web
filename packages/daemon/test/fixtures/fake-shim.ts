/**
 * A stand-in for the `omp.exe` launcher on Windows (a Bun global-bin shim): it starts the real process (argv[2...]) as its
 * child and ends when that child ends. Killing the launcher does not kill the child: that is the point of the fixture.
 */
const [command, ...args] = process.argv.slice(2);
const child = Bun.spawn([command!, ...args], {
	stdin: "ignore",
	stdout: "inherit",
	stderr: "inherit",
	env: process.env,
});
process.exit((await child.exited) ?? 0);
