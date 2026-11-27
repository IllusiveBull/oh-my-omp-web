import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import type { LoginKind } from "@omp-web/protocol";

/**
 * How a provider signs in, from upstream's own provider catalog (the vendored copy this build was typed against). A
 * provider the installed omp knows but this catalog does not is `unknown`; the login flow still refuses anything but the
 * authorization-code prompt at run time, so a stale catalog can only make the UI more cautious, never let a typed secret through.
 */
export function loginKindOf(providerId: string): LoginKind {
	switch (authPolicyFor(providerId)?.login?.kind) {
		case "oauth-code":
			return "oauth";
		case "device-code":
			return "device";
		case "api-key":
			return "api-key";
		case "custom":
			return "custom";
		default:
			return "unknown";
	}
}

/** Whether the web may offer the sign-in (everything but pasted API keys, which are secrets). */
export function webSignInAllowed(kind: LoginKind): boolean {
	return kind !== "api-key";
}

/** `'...'` for a POSIX shell. */
export function posixQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** `'...'` for PowerShell (single quotes double up). */
export function powershellQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/**
 * `set "NAME=value"` for cmd.exe: inside the quotes `& | < > ^` are literal. Not expressible: `"` (cannot occur in a Windows
 * path) and `%` (an interactive cmd expands `%name%` even inside quotes and has no escape for it), which are refused.
 */
export function cmdSetCommand(name: string, value: string): string {
	if (/["%\r\n]/.test(value)) throw new Error(`cmd.exe cannot be given a value containing " or %: ${value}`);
	return `set "${name}=${value}"`;
}

/** Which shell the command is typed into. */
export type CliShell = "posix" | "cmd" | "powershell" | "gitbash";

export interface CliContext {
	platform: NodeJS.Platform;
	/**
	 * The shell the command is for (Windows: cmd, PowerShell or Git Bash; default PowerShell, which is also what a user
	 * copying the command from the Accounts page is assumed to use). Ignored off Windows.
	 */
	shell?: CliShell;
	/** The broker's HOME, or null when it is the user's own home (no environment override needed). */
	brokerHome: string | null;
	/** The broker's URL as the gateway machine reaches it. */
	brokerUrl: string;
	/** The file holding the broker's bearer token. */
	tokenFile: string;
}

/**
 * The exact command to type on the gateway machine for an `omp auth-broker` verb that writes the broker's own database
 * (`login`, `logout`): the broker's HOME in front when its state is not the user's own, so omp opens the broker's
 * `agent.db`. The running broker notices such a write within a moment (it polls its database for outside changes).
 */
export function brokerCliCommand(verb: string, context: CliContext): string {
	if (context.platform === "win32") {
		// omp finds its home through USERPROFILE on Windows and ignores HOME, so that is what is set.
		const home = context.brokerHome;
		switch (context.shell ?? "powershell") {
			case "cmd":
				return `${home === null ? "" : `${cmdSetCommand("USERPROFILE", home)} && `}omp auth-broker ${verb}`;
			case "gitbash":
				return `${home === null ? "" : `USERPROFILE=${posixQuote(home)} `}omp auth-broker ${verb}`;
			default:
				return `${home === null ? "" : `$env:USERPROFILE = ${powershellQuote(home)}; `}omp auth-broker ${verb}`;
		}
	}
	const prefix = context.brokerHome === null ? "" : `HOME=${posixQuote(context.brokerHome)} `;
	return `${prefix}omp auth-broker ${verb}`;
}

/** `omp auth-broker migrate ...` talks to the broker like an environment does, so it needs the broker's URL and token. */
export function brokerMigrateCommand(flags: string, context: CliContext): string {
	if (context.platform === "win32") {
		return (
			`$env:OMP_AUTH_BROKER_URL = ${powershellQuote(context.brokerUrl)}; ` +
			`$env:OMP_AUTH_BROKER_TOKEN = (Get-Content -Raw ${powershellQuote(context.tokenFile)}).Trim(); ` +
			`omp auth-broker migrate --from-local${flags}`
		);
	}
	return (
		`OMP_AUTH_BROKER_URL=${posixQuote(context.brokerUrl)} ` +
		`OMP_AUTH_BROKER_TOKEN="$(cat ${posixQuote(context.tokenFile)})" ` +
		`omp auth-broker migrate --from-local${flags}`
	);
}
