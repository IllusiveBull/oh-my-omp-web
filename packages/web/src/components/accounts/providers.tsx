import type { LoginProviderWire } from "@omp-web/protocol";
import { Search } from "lucide-react";
import { type ReactNode, useState } from "react";
import { canSignInOnWeb, kindLabel } from "../../lib/accounts";
import { CommandLine } from "./copy-button";
import { OpenInTerminal } from "./open-terminal";

interface Props {
	providers: readonly LoginProviderWire[] | null;
	/** A sign-in is running (here or in another window): starting another is refused, so the buttons wait. */
	flowRunning: boolean;
	onStart(provider: LoginProviderWire): Promise<string | null>;
	/** Opens a terminal on the gateway machine with the provider's login command typed. Absent: only the command is shown. */
	onOpenTerminal?(provider: string): Promise<string | null>;
}

/** Every provider omp can sign in to, with how it signs in; pasted-API-key providers get the terminal command instead of a button. */
export function ProviderList({ providers, flowRunning, onStart, onOpenTerminal }: Props): ReactNode {
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	if (providers === null) return <section className="acct-card">Loading providers…</section>;
	const needle = query.trim().toLowerCase();
	const shown = providers.filter(p => needle === "" || p.id.includes(needle) || p.name.toLowerCase().includes(needle));
	return (
		<section className="acct-card" data-section="providers">
			<h3>Sign in</h3>
			<label className="side-search">
				<Search size={14} aria-hidden="true" />
				<input
					className="side-filter"
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder={`Filter ${providers.length} providers`}
					aria-label="Filter providers"
					name="provider-filter"
				/>
			</label>
			{error && (
				<div className="form-error" role="alert">
					{error}
				</div>
			)}
			<ul className="acct-providers">
				{shown.map(provider => (
					<li key={provider.id} data-provider={provider.id} data-kind={provider.kind}>
						<div className="acct-provider-row">
							<span className="acct-provider-name">
								{provider.name} <span className="faint">{provider.id}</span>
							</span>
							<span className="acct-chip acct-chip--off">{kindLabel(provider.kind)}</span>
							{provider.authenticated && <span className="acct-chip acct-chip--ok">signed in</span>}
							{canSignInOnWeb(provider) && (
								<button
									type="button"
									className="btn btn--small"
									data-action="signin"
									disabled={flowRunning || busy !== null}
									onClick={() => {
										setBusy(provider.id);
										setError(null);
										void onStart(provider).then(message => {
											setError(message);
											setBusy(null);
										});
									}}
								>
									{busy === provider.id ? "Starting…" : provider.authenticated ? "Add another" : "Sign in"}
								</button>
							)}
						</div>
						{provider.kind === "api-key" && (
							<details className="acct-terminal">
								<summary>Why no button?</summary>
								<p className="acct-note">
									{provider.name} signs in with an API key you paste. omp-web does not accept secrets through
									the browser: enter it in a terminal on the gateway machine, then reload this list.
								</p>
								{onOpenTerminal && <OpenInTerminal provider={provider.id} onOpen={onOpenTerminal} />}
								<p className="acct-note">Or run this on the gateway machine yourself:</p>
								{provider.terminalCommand ? (
									<CommandLine command={provider.terminalCommand} />
								) : (
									<CommandLine command={`omp auth-broker login ${provider.id}`} />
								)}
							</details>
						)}
					</li>
				))}
				{shown.length === 0 && <li className="side-none">No match</li>}
			</ul>
		</section>
	);
}
