// Mirrors upstream's resolution context into our root package.json.
//
// Vendored packages declare `"dep": "catalog:"`, and bun resolves `catalog:` against the
// *root* workspace of the install, i.e. this repo. So we copy upstream's `workspaces.catalog`.
//
// We do not share upstream's bun.lock, so semver ranges would float to newer versions than
// upstream typechecks against (observed: @types/bun 1.4.4 and @opentelemetry/api 1.10.0
// produce TS errors in upstream sources that upstream's locked 1.4.2 / 1.9.1 do not).
// To stay on upstream's tested versions, pin every non-workspace catalog entry to the
// version recorded in upstream's bun.lock via `overrides`.
//
// Run after every submodule bump (bump-omp will call it), then `bun install`.
const ours = new URL("../package.json", import.meta.url);
const upstreamDir = new URL("../vendor/oh-my-pi/", import.meta.url);

const up = await Bun.file(new URL("package.json", upstreamDir)).json();
const lock = Bun.JSONC.parse(await Bun.file(new URL("bun.lock", upstreamDir)).text()) as {
	packages: Record<string, [string, ...unknown[]]>;
};
const pkg = await Bun.file(ours).json();

const catalog: Record<string, string> = up.workspaces.catalog;
const overrides: Record<string, string> = { ...up.overrides };
for (const name of Object.keys(catalog)) {
	const entry = lock.packages[name]?.[0]; // "name@version"; workspace packages are "name@workspace:..."
	if (!entry) continue;
	const version = entry.slice(name.length + 1);
	if (version.startsWith("workspace:")) continue;
	overrides[name] = version;
}

// Prebuilt native addons (see link-natives.ts): leaf packages are versioned in lockstep with pi-natives.
const natives = await Bun.file(new URL("packages/natives/package.json", upstreamDir)).json();
pkg.optionalDependencies = Object.fromEntries(
	["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"].map(tag => [
		`@oh-my-pi/pi-natives-${tag}`,
		natives.version,
	]),
);

pkg.workspaces.catalog = catalog;
pkg.overrides = overrides;
// Root devDependencies must not contradict the overrides.
for (const key of Object.keys(pkg.devDependencies ?? {})) {
	if (overrides[key]) pkg.devDependencies[key] = overrides[key];
}
await Bun.write(ours, `${JSON.stringify(pkg, null, "\t")}\n`);
console.log(`catalog: ${Object.keys(catalog).length} entries, overrides: ${Object.keys(overrides).length}`);
