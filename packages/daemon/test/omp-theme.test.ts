import { describe, expect, test } from "bun:test";
import { ompTheme } from "../src/omp-theme";

describe("ompTheme", () => {
	test("resolves the configured themes' status line colours to CSS hex, 256-colour indices included", async () => {
		const asked: string[] = [];
		const theme = await ompTheme(async key => {
			asked.push(key);
			return key === "theme.dark" ? "dark" : undefined; // light unset: omp's default light theme
		});
		expect(asked.sort()).toEqual(["theme.dark", "theme.light"]);
		expect(theme.dark.name).toBe("dark");
		expect(theme.light.name).toBe("light");
		expect(theme.dark.statusLineModel).toBe("#d787af"); // a hex in dark.json
		expect(theme.dark.accent).toBe("#febc38"); // through a var
		expect(theme.dark.statusLineStaged).toMatch(/^#[0-9a-f]{6}$/i); // 256-colour index 70
		expect(theme.light.statusLineModel).toBe("#875f87");
	});

	test("an unknown theme name fails instead of guessing colours", async () => {
		await expect(ompTheme(async () => "no-such-theme-xyz")).rejects.toThrow(/no-such-theme-xyz/);
	});
});
