import { Moon, Sun } from "lucide-react";
import { type ReactNode, useState } from "react";

const STORAGE_KEY = "omp-web.theme";
type Theme = "system" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

function applyTheme(theme: Theme): void {
	if (theme === "system") document.documentElement.removeAttribute("data-theme");
	else document.documentElement.dataset.theme = theme;
}

/** Restore before React renders; no attribute lets the CSS follow the system live. */
export function initializeTheme(): void {
	let theme: Theme = "system";
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "light" || stored === "dark") theme = stored;
	} catch {
		// Storage can be unavailable; the system preference still works.
	}
	applyTheme(theme);
}

export function ThemeToggle(): ReactNode {
	const [theme, setTheme] = useState<Theme>(() => {
		const current = document.documentElement.dataset.theme;
		return current === "light" || current === "dark" ? current : "system";
	});
	const next = NEXT[theme];
	const label = `Theme: ${LABEL[theme]}. Switch to ${LABEL[next].toLowerCase()}`;
	return (
		<button
			type="button"
			className="icon-btn"
			aria-label={label}
			title={label}
			onClick={() => {
				applyTheme(next);
				setTheme(next);
				try {
					if (next === "system") localStorage.removeItem(STORAGE_KEY);
					else localStorage.setItem(STORAGE_KEY, next);
				} catch {
					// Keep the selection for this page when storage is unavailable.
				}
			}}
		>
			{theme === "system" ? (
				<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
					<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
					<path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" />
				</svg>
			) : theme === "light" ? (
				<Sun size={16} aria-hidden="true" />
			) : (
				<Moon size={16} aria-hidden="true" />
			)}
		</button>
	);
}
