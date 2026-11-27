// Builds the app (Bun HTML bundler), the login page as a separate bundle at dist/login/, copies public/, and emits the
// root-scoped service worker at dist/sw.js. The gateway serves the login page to browsers without a session, so it must
// not share code or the service worker's precache with the app.
// `--watch` (dev): NODE_ENV=development, no minify, rebuild on change of index.html / login.html / src / public.
import { cp, rm } from "node:fs/promises";
import { readdirSync, watch } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const watching = process.argv.includes("--watch");
const minify = !watching;
const define = { "process.env.NODE_ENV": JSON.stringify(watching ? "development" : "production") };

// Root-absolute URLs in the HTML (`/manifest.json`, `/icon-192.png`) point at files of public/, which are copied to dist/
// as they are: they must not be resolved by the bundler. `"/*"` says that on macOS/Linux; Bun 1.4.4 on Windows never
// matches a pattern that starts with "/" (`Could not resolve: "/manifest.json"`, even for the exact name), and a bare
// `"*"` would also leave the JS un-bundled. A suffix pattern per file of public/ does match there.
const external =
	process.platform === "win32"
		? readdirSync(join(root, "public"), { recursive: true, withFileTypes: true })
				.filter(entry => entry.isFile())
				.map(
					entry => `*${relative(join(root, "public"), join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`,
				)
		: ["/*"];

async function build(): Promise<void> {
	await rm(dist, { recursive: true, force: true });
	const app = await Bun.build({
		entrypoints: [join(root, "index.html")],
		outdir: dist,
		minify,
		define,
		external,
	});
	if (!app.success) throw new Error(app.logs.join("\n"));
	const login = await Bun.build({
		entrypoints: [join(root, "login.html")],
		outdir: join(dist, "login"),
		naming: { entry: "index.[ext]" },
		publicPath: "/login/",
		minify,
		define,
		external,
	});
	if (!login.success) throw new Error(login.logs.join("\n"));
	await cp(join(root, "public"), dist, { recursive: true });

	const precache = new Set<string>(["/"]);
	for (const o of app.outputs) precache.add(`/${relative(dist, o.path)}`);
	precache.delete("/index.html"); // served as "/"
	for await (const f of new Bun.Glob("**/*").scan(join(root, "public"))) precache.add(`/${f}`);
	const list = [...precache].sort();

	// Version = hash of every precached file's bytes, so any shell change replaces the old cache.
	const hasher = new Bun.CryptoHasher("sha256");
	for (const p of list) hasher.update(await Bun.file(join(dist, p === "/" ? "index.html" : p)).bytes());
	const version = hasher.digest("hex").slice(0, 12);

	const sw = await Bun.build({
		entrypoints: [join(root, "src/sw.ts")],
		outdir: dist,
		naming: "sw.js",
		minify,
		define: { ...define, __SW_VERSION__: JSON.stringify(version), __SW_PRECACHE__: JSON.stringify(list) },
	});
	if (!sw.success) throw new Error(sw.logs.join("\n"));
	console.log(`built dist (sw version ${version}, ${list.length} precached)`);
}

if (!watching) {
	await build().catch(err => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
} else {
	let running = false;
	let again = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = async (): Promise<void> => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			await build();
		} catch (err) {
			console.error(err instanceof Error ? err.message : err);
		}
		running = false;
		if (again) {
			again = false;
			void run();
		}
	};
	const schedule = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => void run(), 100);
	};
	for (const p of ["index.html", "login.html", "src", "public"]) watch(join(root, p), { recursive: true }, schedule);
	await run();
}
