import type { MachineSummary, UsageLimitWire } from "@omp-web/protocol";
import { ArrowRight, Gauge, RefreshCw, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { barWidth, loadHidePrivate, percent } from "../lib/accounts";
import { formatResetAt } from "../lib/time";
import { peakLimit, type UsageEntry, usageEntries, usageOf, usageTone } from "../lib/usage";
import { useNow } from "../lib/use-now";
import type { AuthViewState, DaemonClient } from "../store/daemon-client";
import { SignInChip } from "./accounts/antigravity-card";
import { limitLabel, SavedResets } from "./accounts/usage";
import { ChipMenu } from "./chip-menu";

interface Props {
	client: DaemonClient;
	auth: AuthViewState;
	machines: readonly MachineSummary[];
	/** Opens the Accounts page. */
	onSeeAll(): void;
}

/** How stale the toolbar's rings may get. */
const BACKGROUND_MAX_AGE_MS = 5 * 60_000;
/** How stale the open menu may be. */
const OPEN_MAX_AGE_MS = 60_000;

/** A progress ring for a 0..1 fraction. */
function Ring({ fraction, tone }: { fraction: number | undefined; tone: string }): ReactNode {
	const r = 6;
	const c = 2 * Math.PI * r;
	return (
		<svg className={`usage-ring usage-ring--${tone}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<circle className="usage-ring-track" cx="8" cy="8" r={r} />
			<circle
				className="usage-ring-fill"
				cx="8"
				cy="8"
				r={r}
				strokeDasharray={`${(c * barWidth(fraction)) / 100} ${c}`}
				transform="rotate(-90 8 8)"
			/>
		</svg>
	);
}

function LimitRow({ limit, now }: { limit: UsageLimitWire; now: number }): ReactNode {
	const tone = usageTone(limit);
	return (
		<li className="usage-limit" data-status={tone}>
			<span className="usage-limit-label">{limitLabel(limit.label, limit.windowLabel)}</span>
			<span className="usage-limit-reset">
				{limit.resetsAt !== undefined && (
					<>
						<RotateCcw size={11} role="img" aria-label="Resets" />
						{formatResetAt(limit.resetsAt, now)}
					</>
				)}
			</span>
			<span className="usage-limit-pct">{limit.usedFraction === undefined ? "?" : percent(limit.usedFraction)}</span>
			<span className="acct-bar usage-limit-bar">
				<span
					className={`acct-bar-fill acct-bar-fill--${tone}`}
					style={{ width: `${barWidth(limit.usedFraction)}%` }}
				/>
			</span>
		</li>
	);
}

function EntrySection({
	entry,
	now,
	hidePrivate,
}: {
	entry: UsageEntry;
	now: number;
	hidePrivate: boolean;
}): ReactNode {
	const report = entry.report;
	const identity = !hidePrivate && report?.identity;
	return (
		<section className="usage-acct" data-usage={entry.key}>
			<h4>
				<span>
					{entry.name}
					{report?.planType && <span className="faint"> · {report.planType}</span>}
					{entry.origin && <span className="faint"> · {entry.origin}</span>}
				</span>
				{entry.signIn && <SignInChip signIn={entry.signIn} />}
				{identity && <span className="usage-identity faint">{identity}</span>}
			</h4>
			<SavedResets report={report} now={now} className="usage-note" />
			{report && report.limits.length > 0 && (
				<ul className="usage-limits">
					{report.limits.map(limit => (
						<LimitRow key={limit.id} limit={limit} now={now} />
					))}
				</ul>
			)}
			{report && report.limits.length === 0 && <p className="usage-note">No limits reported.</p>}
			{entry.note && <p className="usage-note">{entry.note}</p>}
		</section>
	);
}

function UsagePanel({
	entries,
	auth,
	pending,
	onRefresh,
	onSeeAll,
}: {
	entries: readonly UsageEntry[];
	auth: AuthViewState;
	pending: boolean;
	onRefresh(): void;
	onSeeAll(): void;
}): ReactNode {
	const now = useNow(true, 30_000);
	const hidePrivate = useMemo(loadHidePrivate, []);
	const broker = auth.broker;
	const brokerNote =
		broker && broker.phase !== "disabled" && broker.phase !== "running"
			? `The auth broker is ${broker.phase}; provider usage is unavailable.`
			: auth.usage.error
				? `Could not refresh provider usage: ${auth.usage.error}`
				: null;
	return (
		<div className="usage-panel" data-testid="usage-panel">
			<div className="usage-panel-head">
				<span>Usage limits</span>
				<button
					type="button"
					className="btn btn--small btn--ghost"
					disabled={pending}
					title="Ask every provider again"
					onClick={onRefresh}
				>
					<RefreshCw size={13} aria-hidden="true" />
					{pending ? "Refreshing…" : "Refresh"}
				</button>
				<button type="button" className="btn btn--small btn--ghost" onClick={onSeeAll}>
					See all <ArrowRight size={13} aria-hidden="true" />
				</button>
			</div>
			{brokerNote && <p className="usage-note">{brokerNote}</p>}
			{entries.map(entry => (
				<EntrySection key={entry.key} entry={entry} now={now} hidePrivate={hidePrivate} />
			))}
			{entries.length === 0 && (
				<p className="usage-note">{pending ? "Loading…" : "No provider reported usage yet."}</p>
			)}
		</div>
	);
}

/**
 * The toolbar's usage pill: one ring per account (omp's broker providers and each machine's Antigravity quota alike,
 * whatever backend the open session uses), opening a menu with every limit. Hidden when no source exists.
 */
export function UsageMenu({ client, auth, machines, onSeeAll }: Props): ReactNode {
	const store = usageOf(client);
	const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const brokerOn = auth.broker !== null && auth.broker.phase !== "disabled";
	const agyOn = machines.some(m => m.online && m.antigravity?.available === true);
	const brokerRunning = auth.broker?.phase === "running";
	const agyMachines = machines
		.filter(m => m.online && m.antigravity?.available === true)
		.map(m => m.id)
		.join("\0");

	// Ask on mount, when a source appears, and then at most every few minutes (with the sources as they are by then).
	const latest = useRef({ auth, machines });
	latest.current = { auth, machines };
	useEffect(() => {
		const ensure = (): void => store.ensure(latest.current.auth, latest.current.machines, BACKGROUND_MAX_AGE_MS);
		ensure();
		const timer = setInterval(ensure, 60_000);
		return () => clearInterval(timer);
	}, [store, brokerRunning, agyMachines]);

	const entries = useMemo(
		() => usageEntries(auth.usage, state.antigravity, machines),
		[auth.usage, state.antigravity, machines],
	);
	if (!brokerOn && !agyOn) return null;

	// Accounts with usage, and Antigravity sign-ins that are gone (those would otherwise vanish from the pill silently).
	const shown = entries.filter(e => e.report !== null || e.signIn?.tone === "bad");
	const label =
		shown.length === 0 ? (
			<span className="usage-item">
				<Gauge size={15} aria-hidden="true" />
				<span className="usage-name">Usage</span>
			</span>
		) : (
			shown.map(entry => {
				if (entry.report === null) {
					return (
						<span key={entry.key} className="usage-item" data-status="signed-out">
							<Ring fraction={0} tone="signed-out" />
							<span className="usage-name">{entry.name}</span>
							<span className="usage-pct usage-pct--signed-out">signed out</span>
						</span>
					);
				}
				const peak = peakLimit(entry.report);
				const tone = usageTone(peak);
				return (
					<span key={entry.key} className="usage-item" data-status={tone}>
						<Ring fraction={peak?.usedFraction} tone={tone} />
						<span className="usage-name">{entry.name}</span>
						{peak?.usedFraction !== undefined && (
							<span className={`usage-pct usage-pct--${tone}`}>{percent(peak.usedFraction)}</span>
						)}
					</span>
				);
			})
		);
	const summary = shown
		.map(e => {
			const peak = peakLimit(e.report);
			if (e.report === null) return `${e.name} ${e.signIn?.label.toLowerCase() ?? "?"}`;
			return `${e.name} ${peak?.usedFraction === undefined ? "?" : percent(peak.usedFraction)}`;
		})
		.join(", ");

	return (
		<ChipMenu
			label={label}
			title={summary ? `Usage: ${summary}` : "Usage limits"}
			ariaLabel={summary ? `Usage limits: ${summary}` : "Usage limits"}
			buttonClass="usage-pill"
			onOpen={() => store.ensure(auth, machines, OPEN_MAX_AGE_MS)}
		>
			{close => (
				<UsagePanel
					entries={entries}
					auth={auth}
					pending={state.pending > 0}
					onRefresh={() => store.ensure(auth, machines, 0)}
					onSeeAll={() => {
						close();
						onSeeAll();
					}}
				/>
			)}
		</ChipMenu>
	);
}
