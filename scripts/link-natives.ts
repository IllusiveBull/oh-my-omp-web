// Upstream's native-addon loader deliberately ignores the prebuilt `@oh-my-pi/pi-natives-<platform>`
// leaf package when pi-natives is loaded from a workspace checkout (its `isWorkspaceLoad` branch in
// packages/natives/native/loader-state.js) and expects a locally built `native/pi_natives.<tag>*.node`.
// We do not build Rust, so link the prebuilt addon(s) (installed via root optionalDependencies) into
// that directory. `*.node` is gitignored upstream, so the submodule worktree stays clean.
//
// The leaf package ships every file the loader may ask for on that platform: arm64 and darwin have one
// `pi_natives.<tag>.node`, x64 has `pi_natives.<tag>-baseline.node` and/or `-modern.node` (the loader
// picks by AVX2 and falls back modern -> baseline -> default), so link all `pi_natives.<tag>*.node`.
//
// Link strategy, first that works: symlink (macOS/Linux, Windows with Developer Mode or elevation) ->
// hardlink (Windows without symlink privilege, same volume; the file is gitignored and read-only to us)
// -> copy (cross-volume). An up-to-date target is left alone, which also keeps a re-run from failing
// on Windows while a daemon or omp holds the loaded `.node` open.
import {
	copyFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type LinkKind = "symlink" | "hardlink" | "copy";

function sameFile(a: string, b: string): boolean {
	try {
		const x = statSync(a, { bigint: true });
		const y = statSync(b, { bigint: true });
		return x.dev === y.dev && x.ino !== 0n && x.ino === y.ino;
	} catch {
		return false;
	}
}

function sameContent(a: string, b: string): boolean {
	try {
		if (statSync(a).size !== statSync(b).size) return false;
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

function isCurrent(source: string, target: string): LinkKind | null {
	let st;
	try {
		st = lstatSync(target);
	} catch {
		return null;
	}
	if (st.isSymbolicLink()) {
		try {
			return resolve(dirname(target), readlinkSync(target)) === resolve(source) ? "symlink" : null;
		} catch {
			return null;
		}
	}
	if (sameFile(source, target)) return "hardlink";
	if (sameContent(source, target)) return "copy";
	return null;
}

/** Make `target` expose `source`; returns how, or the existing kind when already up to date. */
export function linkAddon(source: string, target: string): LinkKind {
	const current = isCurrent(source, target);
	if (current) return current;
	mkdirSync(dirname(target), { recursive: true });
	rmSync(target, { force: true });
	try {
		symlinkSync(relative(dirname(target), source), target);
		return "symlink";
	} catch (err) {
		// EPERM/EACCES: no symlink privilege (Windows without Developer Mode / elevation).
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EPERM" && code !== "EACCES" && code !== "UNKNOWN") throw err;
	}
	try {
		linkSync(source, target);
		return "hardlink";
	} catch (err) {
		// EXDEV: node_modules and the checkout are on different volumes.
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES" && code !== "UNKNOWN") throw err;
	}
	copyFileSync(source, target);
	return "copy";
}

if (import.meta.main) {
	const root = join(import.meta.dir, "..");
	const tag = `${process.platform}-${process.arch}`;
	const leaf = join(root, "node_modules/@oh-my-pi", `pi-natives-${tag}`);
	const addons = existsSync(leaf)
		? readdirSync(leaf).filter(name => name.startsWith(`pi_natives.${tag}`) && name.endsWith(".node"))
		: [];
	if (addons.length === 0) {
		console.error(
			`link-natives: no pi_natives.${tag}*.node in ${leaf} (no prebuilt addon for ${tag}); run bun install`,
		);
		process.exit(1);
	}
	for (const file of addons) {
		const source = join(leaf, file);
		const target = join(root, "vendor/oh-my-pi/packages/natives/native", file);
		const kind = linkAddon(source, target);
		console.log(`link-natives: ${relative(root, target)} -> ${relative(root, source)} (${kind})`);
	}
}
