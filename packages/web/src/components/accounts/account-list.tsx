import type { AccountWire, DisabledAccountWire, UsageReportWire } from "@omp-web/protocol";
import { TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { unmatchedReports, usageForAccount } from "../../lib/accounts";
import { Moment } from "../moment";
import { AccountMeta, LimitBars, ProviderCapacity } from "./usage";

interface Props {
	accounts: readonly AccountWire[];
	disabled: readonly DisabledAccountWire[];
	reports: readonly UsageReportWire[];
	now: number;
	/** Removing is refused while a sign-in runs. */
	flowRunning: boolean;
	/** Masks labels and reported identities (emails, account ids, organizations). */
	hidePrivate: boolean;
	onLogout(account: AccountWire): Promise<string | null>;
}

/** The accounts the broker holds, grouped by provider, each with its usage when the broker reported one and a two-step log out. */
export function AccountList({
	accounts,
	disabled,
	reports,
	now,
	flowRunning,
	hidePrivate,
	onLogout,
}: Props): ReactNode {
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const keyOf = (a: AccountWire): string => `${a.provider}#${a.credentialId}`;
	// Masked, the credential number still tells rows apart.
	const labelOf = (a: AccountWire): string =>
		hidePrivate ? `${a.type === "oauth" ? "OAuth" : "API key"} #${a.credentialId}` : a.label;
	const unassigned = unmatchedReports(accounts, reports);
	const providers = [...new Set([...accounts.map(a => a.provider), ...reports.map(r => r.provider)])];
	return (
		<>
			{error && (
				<div className="form-error" role="alert">
					{error}
				</div>
			)}
			{accounts.length === 0 && <p className="acct-note">No stored accounts yet. Sign in below.</p>}
			{providers.map(provider => {
				const rows = accounts.filter(a => a.provider === provider);
				const additional = unassigned.filter(r => r.provider === provider);
				const providerReports = reports.filter(r => r.provider === provider);
				const count = rows.length + additional.length;
				return (
					<div key={provider} className="acct-group" data-provider={provider}>
						<h4>
							{rows[0]?.providerName ?? provider}
							<span className="acct-count">
								{count} {count === 1 ? "account" : "accounts"}
							</span>
						</h4>
						{[...new Set(providerReports.flatMap(r => r.notes ?? []))].map(note => (
							<p key={note} className="acct-note">
								{note}
							</p>
						))}
						<ul className="acct-accounts">
							{rows.map(account => {
								const report = usageForAccount(account, reports, accounts);
								return (
									<li key={keyOf(account)} className="acct-account" data-account={keyOf(account)}>
										<div className="acct-account-row">
											<span className="acct-account-label">
												<span className="acct-account-name">{labelOf(account)}</span>
												{account.active && <span className="acct-chip acct-chip--ok">in use</span>}
												<span className="acct-chip acct-chip--off">
													{account.type === "oauth" ? "OAuth" : "API key"}
												</span>
											</span>
											{confirming === keyOf(account) ? (
												<span className="env-confirm">
													<span className="env-confirm-label">Log out {labelOf(account)}?</span>
													<button
														type="button"
														className="btn btn--small btn--danger env-confirm-yes"
														disabled={busy}
														onClick={() => {
															setBusy(true);
															setError(null);
															void onLogout(account).then(message => {
																setError(message);
																setBusy(false);
																setConfirming(null);
															});
														}}
													>
														Log out
													</button>
													<button
														type="button"
														className="btn btn--small btn--ghost env-confirm-no"
														disabled={busy}
														onClick={() => setConfirming(null)}
													>
														Keep
													</button>
												</span>
											) : (
												<button
													type="button"
													className="btn btn--small btn--danger"
													data-action="logout"
													disabled={flowRunning}
													onClick={() => setConfirming(keyOf(account))}
												>
													Log out
												</button>
											)}
										</div>
										<AccountMeta report={report} now={now} hidePrivate={hidePrivate} />
										{!hidePrivate && report?.identity && report.identity !== account.label && (
											<p className="acct-meta">Usage reported for {report.identity}</p>
										)}
										{report ? (
											<LimitBars report={report} now={now} />
										) : (
											<p className="acct-meta">No usage data reported.</p>
										)}
										{account.provider === "anthropic" &&
											account.type === "oauth" &&
											account.authorizedAt !== undefined &&
											account.authorizedAt + 30 * 86_400_000 - now <= 7 * 86_400_000 && (
												<p className="acct-meta acct-warn">
													<TriangleAlert size={12} className="acct-inline-icon" aria-hidden="true" />{" "}
													{account.authorizedAt + 30 * 86_400_000 <= now ? (
														"Re-login now — grant is past Anthropic’s ~30d lifetime."
													) : (
														<>
															Re-login{" "}
															<Moment at={account.authorizedAt + 30 * 86_400_000} now={now} precise />{" "}
															(Anthropic expires OAuth grants ~30d after login)
														</>
													)}
												</p>
											)}
									</li>
								);
							})}
							{additional.map((report, index) => (
								<li
									key={`${report.identity ?? ""}/${index}`}
									className="acct-account"
									data-usage-provider={provider}
								>
									<div className="acct-account-row">
										<span className="acct-account-label">
											<span className="acct-account-name">
												{hidePrivate ? "Hidden account" : (report.identity ?? "Unknown account")}
											</span>
											<span className="acct-chip">not assigned to a stored account</span>
										</span>
									</div>
									<AccountMeta report={report} now={now} hidePrivate={hidePrivate} />
									<LimitBars report={report} now={now} />
								</li>
							))}
						</ul>
						<ProviderCapacity reports={providerReports} />
					</div>
				);
			})}
			{disabled.length > 0 && (
				<div className="acct-group" data-section="disabled">
					<h4>Needs signing in again</h4>
					<ul className="acct-accounts">
						{disabled.map(d => (
							<li key={`${d.provider}/${d.label}/${d.disabledAt}`} className="acct-disabled">
								<span className="acct-chip acct-chip--bad">disabled</span> {d.provider}:{" "}
								{hidePrivate ? "hidden account" : d.label} — {d.cause}
								{d.disabledAt !== null && (
									<>
										{" "}
										(<Moment at={d.disabledAt} now={now} />)
									</>
								)}
							</li>
						))}
					</ul>
				</div>
			)}
		</>
	);
}
