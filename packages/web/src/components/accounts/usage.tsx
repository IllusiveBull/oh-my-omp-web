import type { UsageReportWire, UsageWire } from "@omp-web/protocol";
import { Eye, EyeOff, RefreshCw, Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { barWidth, limitText, percent } from "../../lib/accounts";
import { formatCountdown } from "../../lib/time";
import { Moment } from "../moment";

/** "Claude 5 Hour", not "Claude 5 Hour · 5 Hour": the window label only when the label does not already say it. */
export function limitLabel(label: string, windowLabel: string | undefined): string {
	return windowLabel && !label.toLowerCase().includes(windowLabel.toLowerCase()) ? `${label} · ${windowLabel}` : label;
}

/** One report's limits as bars; the rows share columns so labels, bars, percentages and resets line up. */
export function LimitBars({ report, now }: { report: UsageReportWire; now: number }): ReactNode {
	if (report.limits.length === 0) return <p className="acct-note">No limits reported.</p>;
	return (
		<ul className="acct-limits">
			{report.limits.map(limit => (
				<li
					key={limit.id}
					data-limit={limit.id}
					data-status={limit.status ?? "unknown"}
					title={limitText(limit, now, formatCountdown)}
				>
					<span className="acct-limit-label">{limitLabel(limit.label, limit.windowLabel)}</span>
					<span
						className="acct-bar"
						role="img"
						aria-label={
							limit.usedFraction === undefined ? "usage unknown" : `${percent(limit.usedFraction)} used`
						}
					>
						<span
							className={`acct-bar-fill acct-bar-fill--${limit.status ?? "unknown"}`}
							style={{ width: `${barWidth(limit.usedFraction)}%` }}
						/>
					</span>
					<span className={`acct-limit-value acct-limit-value--${limit.status ?? "unknown"}`}>
						{limit.used !== undefined && limit.limit !== undefined && limit.unit !== "percent" && (
							<span className="faint">
								{limit.used.toLocaleString()} / {limit.limit.toLocaleString()} {limit.unit}
								{" · "}
							</span>
						)}
						{limit.usedFraction === undefined ? "?" : percent(limit.usedFraction)}
					</span>
					<span className="acct-limit-reset">
						{limit.resetsAt !== undefined && (
							<>
								resets <Moment at={limit.resetsAt} now={now} precise />
							</>
						)}
					</span>
					{limit.notes && limit.notes.length > 0 && (
						<span className="acct-limit-notes">{limit.notes.join(" · ")}</span>
					)}
				</li>
			))}
		</ul>
	);
}

interface Props {
	/** The broker's usage; null while the broker is not enabled (only machine-local sources, such as Antigravity). */
	usage: UsageWire | null;
	children: ReactNode;
	now: number;
	onRefresh(): Promise<string | null>;
	/** Masks emails, account ids and organizations, e.g. while sharing the screen. */
	hidePrivate: boolean;
	onToggleHidePrivate(): void;
}

/** Shared account/usage card; refresh failures leave the last reported limits visible. */
export function UsageSection({ usage, children, now, onRefresh, hidePrivate, onToggleHidePrivate }: Props): ReactNode {
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	return (
		<section className="acct-card" data-section="accounts">
			<h3>
				Accounts &amp; usage
				<button
					type="button"
					className="btn btn--small btn--ghost"
					title="Ask the broker and each machine for fresh usage"
					disabled={busy}
					onClick={() => {
						setBusy(true);
						void onRefresh().then(m => {
							setMessage(m);
							setBusy(false);
						});
					}}
				>
					<RefreshCw size={14} aria-hidden="true" />
					{busy ? "Refreshing…" : "Refresh"}
				</button>
				<button
					type="button"
					className="btn btn--small btn--ghost"
					data-action="hide-private"
					aria-pressed={hidePrivate}
					title={
						hidePrivate
							? "Show emails, account ids and organizations"
							: "Hide emails, account ids and organizations"
					}
					onClick={onToggleHidePrivate}
				>
					{hidePrivate ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
					{hidePrivate ? "Show" : "Hide"}
				</button>
				{usage && usage.fetchedAt !== null && (
					<span className="acct-head-note" title="The broker caches provider queries for about five minutes.">
						updated <Moment at={usage.fetchedAt} now={now} />
						{usage.generatedAt !== null && usage.generatedAt !== usage.fetchedAt && (
							<>
								{" "}
								· broker data from <Moment at={usage.generatedAt} now={now} />
							</>
						)}
					</span>
				)}
			</h3>
			{usage?.error && (
				<div className="form-error" role="alert">
					Could not refresh usage: {usage.error}
				</div>
			)}
			{message && <p className="acct-note">{message}</p>}
			{usage && usage.fetchedAt === null && !usage.error && <p className="acct-note">Not asked yet.</p>}
			{usage && usage.fetchedAt !== null && usage.reports.length === 0 && !usage.error && (
				<p className="acct-note" data-role="no-usage">
					The broker reported no usage. Only some providers publish usage, and a credential the provider rejects
					reports nothing.
				</p>
			)}
			{children}
		</section>
	);
}

/** A report's saved resets, led by a sparkle icon: "2 saved resets · 1 usable now · soonest expires in 3d 4h"; nothing when it has none. */
export function SavedResets({
	report,
	now,
	className = "acct-meta",
}: {
	report: UsageReportWire | null;
	now: number;
	className?: string;
}): ReactNode {
	const reset = report?.resetCredits;
	if (!reset || reset.availableCount <= 0) return null;
	const expiries = reset.credits?.map(c => Date.parse(c.expiresAt)) ?? [];
	const future = expiries.filter(at => at > now);
	const expiry = future.length > 0 ? Math.min(...future) : expiries.length > 0 ? Math.max(...expiries) : undefined;
	return (
		<p className={className} data-role="saved-resets">
			<Sparkles size={12} className="acct-inline-icon" aria-hidden="true" /> {reset.availableCount} saved reset
			{reset.availableCount === 1 ? "" : "s"}
			{reset.redeemableCount !== undefined && reset.redeemableCount !== reset.availableCount
				? ` · ${reset.redeemableCount} usable now`
				: ""}
			{expiry !== undefined && (
				<>
					{" "}
					· {expiry > now ? "soonest expires " : "expired "}
					<Moment at={expiry} now={now} precise /> ({new Date(expiry).toISOString().slice(0, 10)})
				</>
			)}
		</p>
	);
}

/**
 * The account's secondary lines: provider-reported, non-secret metadata (organization, plan, saved resets).
 * `hidePrivate` leaves out the organization.
 */
export function AccountMeta({
	report,
	now,
	hidePrivate,
}: {
	report: UsageReportWire | null;
	now: number;
	hidePrivate: boolean;
}): ReactNode {
	const facts = [!hidePrivate && report?.orgName, report?.planType && `plan: ${report.planType}`].filter(Boolean);
	return (
		<>
			{facts.length > 0 && <p className="acct-meta">{facts.join(" · ")}</p>}
			<SavedResets report={report} now={now} />
		</>
	);
}

/**
 * Same binding-per-account window aggregation as omp usage; independent Claude/Codex meters stay separate.
 * Shown only when some window pools more than one account: for a single account it repeats its bars.
 */
export function ProviderCapacity({ reports }: { reports: readonly UsageReportWire[] }): ReactNode {
	const buckets = new Map<string, { label: string; duration: number; used: number; accounts: number }>();
	for (const report of reports) {
		const maxima = new Map<string, number>();
		for (const limit of report.limits) {
			if (limit.usedFraction === undefined) continue;
			const duration = limit.durationMs;
			const window = duration !== undefined ? `d:${duration}` : (limit.windowId ?? limit.windowLabel ?? limit.label);
			const slug = limit.id.toLowerCase().split(":")[1];
			const meter =
				report.provider === "anthropic" || report.provider === "openai-codex"
					? limit.tier?.trim().toLowerCase() ||
						(report.provider === "openai-codex"
							? slug && slug !== "primary" && slug !== "secondary"
								? slug
								: "chat"
							: "")
					: "";
			const key = `${window}\0${meter}`;
			maxima.set(key, Math.max(maxima.get(key) ?? -Infinity, limit.usedFraction));
			if (!buckets.has(key)) {
				const label =
					duration !== undefined
						? duration >= 86_400_000
							? `${duration / 86_400_000}d`
							: `${duration / 3_600_000}h`
						: (limit.windowLabel ?? limit.windowId ?? limit.label);
				buckets.set(key, {
					label: label + (meter ? ` (${meter.charAt(0).toUpperCase()}${meter.slice(1)})` : ""),
					duration: duration ?? Infinity,
					used: 0,
					accounts: 0,
				});
			}
		}
		for (const [key, used] of maxima) {
			const bucket = buckets.get(key)!;
			bucket.used += used;
			bucket.accounts++;
		}
	}
	if (![...buckets.values()].some(b => b.accounts > 1)) return null;
	return (
		<p className="acct-capacity" data-role="capacity">
			<span className="acct-capacity-title">Pooled</span>
			{[...buckets.values()]
				.sort((a, b) => a.duration - b.duration || a.label.localeCompare(b.label))
				.map(b => (
					<span key={b.label} className="acct-capacity-item">
						<strong>{b.label}</strong> {Math.max(0, b.accounts - b.used).toFixed(2)}× left{" "}
						<span className="faint">
							({b.used.toFixed(2)}/{b.accounts} used)
						</span>
					</span>
				))}
		</p>
	);
}
