import { Terminal } from "lucide-react";
import { type ReactNode, useState } from "react";

interface Props {
	provider: string;
	/** Opens the sign-in shell on the gateway machine and shows it. Resolves to an error message, or null on success. */
	onOpen(provider: string): Promise<string | null>;
}

/**
 * Credentials that omp-web does not take through the browser are entered in a terminal on the gateway machine: this
 * opens one in the broker's home with the login command typed but not run.
 */
export function OpenInTerminal({ provider, onOpen }: Props): ReactNode {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<div className="acct-open-terminal">
			<button
				type="button"
				className="btn btn--small"
				data-action="open-terminal"
				data-provider={provider}
				disabled={busy}
				onClick={() => {
					setBusy(true);
					setError(null);
					void onOpen(provider).then(message => {
						setError(message);
						setBusy(false);
					});
				}}
			>
				<Terminal size={14} aria-hidden="true" />
				{busy ? "Opening…" : "Open in terminal"}
			</button>
			<span className="acct-note">The command is typed but not run. Review it and press Enter.</span>
			{error && (
				<div className="form-error" role="alert" data-role="open-terminal-error">
					{error}
				</div>
			)}
		</div>
	);
}
