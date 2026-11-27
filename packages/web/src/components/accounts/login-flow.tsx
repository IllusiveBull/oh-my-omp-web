import type { LoginFlowWire } from "@omp-web/protocol";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { flowStatusLabel } from "../../lib/accounts";
import { parseHttpUrl } from "../../lib/attention";
import { CommandLine, CopyButton } from "./copy-button";
import { OpenInTerminal } from "./open-terminal";

interface Props {
	flow: LoginFlowWire;
	/** Each returns an error message, or null on success. */
	onInput(flow: LoginFlowWire, value: string): Promise<string | null>;
	onCancel(flow: LoginFlowWire): Promise<string | null>;
	onDismiss(flow: LoginFlowWire): Promise<string | null>;
	/** Opens a terminal on the gateway machine with the provider's login command typed. Absent: only the command is shown. */
	onOpenTerminal?(provider: string): Promise<string | null>;
}

/**
 * The sign-in in progress (or just finished), identical on every client: the link omp asked the user to open (a link
 * the user clicks, never an automatic navigation), the authorization-code field, progress, the outcome, cancel. The only
 * thing typed here is the OAuth code or redirect URL; a provider that wants a typed credential ends the flow with the
 * command to run on the gateway instead.
 */
export function LoginFlowCard({ flow, onInput, onCancel, onDismiss, onOpenTerminal }: Props): ReactNode {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const panel = useRef<HTMLElement>(null);
	const titleId = useId();
	useEffect(() => {
		const previous = document.activeElement;
		const node = panel.current;
		node?.focus();
		return () => {
			// Give focus back only if it was still in this dialog (now removed): a terminal opened from here keeps it.
			const active = document.activeElement;
			if (active && active !== document.body && !node?.contains(active)) return;
			if (previous?.isConnected && "focus" in previous) (previous as HTMLElement).focus();
		};
	}, []);
	/** The sign-in has ended and the user moves to the terminal: close this dialog so it does not cover it. */
	const openTerminal =
		onOpenTerminal &&
		(async (provider: string): Promise<string | null> => {
			const failed = await onOpenTerminal(provider);
			return failed ?? (await onDismiss(flow));
		});
	const link = flow.link ? parseHttpUrl(flow.link.url) : null;
	const running = flow.status === "running";

	const act = async (task: () => Promise<string | null>): Promise<void> => {
		setBusy(true);
		setError(await task());
		setBusy(false);
	};
	const submit = (e: FormEvent): void => {
		e.preventDefault();
		if (value.trim() === "") return;
		void act(async () => {
			const result = await onInput(flow, value);
			if (result === null) setValue("");
			return result;
		});
	};

	return (
		<div className="handoff-overlay acct-flow-overlay">
			<section
				className="acct-card acct-flow"
				data-section="flow"
				data-status={flow.status}
				data-provider={flow.providerId}
				ref={panel}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				onKeyDown={e => {
					if (e.key !== "Tab") return;
					const controls = Array.from(
						e.currentTarget.querySelectorAll<HTMLElement>(
							'a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]',
						),
					);
					const first = controls[0];
					const last = controls.at(-1);
					if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
						e.preventDefault();
						last?.focus();
					} else if (!e.shiftKey && document.activeElement === last) {
						e.preventDefault();
						first?.focus();
					}
				}}
			>
				<h3 id={titleId}>
					Sign in to {flow.providerName}{" "}
					<span
						className={`acct-chip acct-chip--${flow.status === "succeeded" ? "ok" : flow.status === "running" ? "warn" : "bad"}`}
					>
						{flowStatusLabel(flow.status)}
					</span>
				</h3>
				{running && flow.link === null && <p className="acct-note">Waiting for omp to produce the sign-in link…</p>}
				{running && link && (
					<div className="acct-link">
						<a
							className="btn btn--primary"
							href={link.href}
							target="_blank"
							rel="noopener noreferrer"
							data-role="signin-link"
						>
							Open the sign-in page
						</a>
						<span className="acct-note">on {link.host}</span>
						<CopyButton text={link.href} label="Copy link" />
					</div>
				)}
				{running && flow.link?.instructions && <p className="acct-note">{flow.link.instructions}</p>}
				{running && flow.prompt && (
					<form
						className="acct-code"
						onSubmit={submit}
						data-role="code-form"
						data-submitted={String(flow.prompt.submitted)}
					>
						<p className="acct-note">
							When you finish, the provider sends the browser to a <code>localhost</code> address. If this device
							is not the gateway machine that page will not load: copy the full address from the address bar (or
							the code shown) and paste it here.
						</p>
						{flow.prompt.submitted ? (
							<p role="status">Code submitted (from any open window); waiting for the provider…</p>
						) : (
							<div className="acct-code-row">
								<input
									name="code"
									value={value}
									onChange={e => setValue(e.target.value)}
									placeholder={flow.prompt.placeholder ?? "Redirect URL or authorization code"}
									aria-label={flow.prompt.title}
									autoComplete="off"
									spellCheck={false}
									disabled={busy}
								/>
								<button type="submit" className="btn btn--primary" disabled={busy || value.trim() === ""}>
									Submit
								</button>
							</div>
						)}
					</form>
				)}
				{flow.progress.length > 0 && (
					<ul className="acct-progress" aria-label="Progress">
						{flow.progress.map((line, i) => (
							<li key={`${i}:${line}`}>{line}</li>
						))}
					</ul>
				)}
				{flow.status === "succeeded" && (
					<p role="status" className="acct-ok">
						Signed in{flow.identity ? ` as ${flow.identity}` : ""}. The broker holds the credential; every machine
						can use it.
					</p>
				)}
				{flow.failure && (
					<div className="acct-failure" role="alert" data-failure={flow.failure.kind}>
						<p>{flow.failure.message}</p>
						{(flow.failure.kind === "secret_input" || flow.failure.kind === "unsupported") &&
							flow.failure.terminalCommand && (
								<>
									<p className="acct-note">
										omp-web does not take API keys, passwords or other secrets through the browser. Enter them
										in a terminal on the gateway machine:
									</p>
									<CommandLine command={flow.failure.terminalCommand} />
									{openTerminal && <OpenInTerminal provider={flow.providerId} onOpen={openTerminal} />}
								</>
							)}
					</div>
				)}
				{error && (
					<div className="form-error" role="alert">
						{error}
					</div>
				)}
				<div className="acct-actions">
					{running ? (
						<button
							type="button"
							className="btn btn--danger"
							disabled={busy}
							onClick={() => void act(() => onCancel(flow))}
						>
							Cancel sign-in
						</button>
					) : (
						<button type="button" className="btn" disabled={busy} onClick={() => void act(() => onDismiss(flow))}>
							Dismiss
						</button>
					)}
				</div>
			</section>
		</div>
	);
}
