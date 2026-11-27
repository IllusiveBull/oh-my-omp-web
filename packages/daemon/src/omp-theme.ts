import { colorHex } from "@oh-my-pi/pi-tui/theme/color";
import { loadThemeJson } from "@oh-my-pi/pi-tui/theme/loader";
import { resolveColorValue } from "@oh-my-pi/pi-tui/theme/theme";
import type { OmpPaletteWire, OmpThemeWire } from "@omp-web/protocol";

/** The theme tokens omp's status line and model hub paint with. */
const TOKENS = [
	"accent",
	"success",
	"warning",
	"error",
	"muted",
	"dim",
	"statusLineSep",
	"statusLineModel",
	"statusLinePath",
	"statusLineGitClean",
	"statusLineGitDirty",
	"statusLineDirty",
	"statusLineStaged",
	"statusLineUntracked",
	"statusLineContext",
	"statusLineCost",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
] as const;

async function palette(name: string, light: boolean): Promise<OmpPaletteWire> {
	const json = await loadThemeJson(name);
	const out: OmpPaletteWire = { name };
	for (const token of TOKENS) {
		const value = json.colors[token];
		if (value !== undefined) out[token] = colorHex(resolveColorValue(value, json.vars ?? {}), light);
	}
	return out;
}

/**
 * The colours of the terminal UI's themes as the user configured them (`theme.dark` / `theme.light`, read through the
 * omp binary's `omp config`), resolved to CSS hex by omp's own theme loader (built-in themes and the custom themes
 * directory).
 */
export async function ompTheme(readSetting: (key: string) => Promise<unknown>): Promise<OmpThemeWire> {
	const [dark, light] = await Promise.all([readSetting("theme.dark"), readSetting("theme.light")]);
	return {
		dark: await palette(typeof dark === "string" && dark ? dark : "dark", false),
		light: await palette(typeof light === "string" && light ? light : "light", true),
	};
}
