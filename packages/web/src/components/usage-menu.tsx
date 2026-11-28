import type { MachineSummary, UsageLimitWire } from "@omp-web/protocol";
import { ArrowRight, Gauge, RefreshCw, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { barWidth, loadHidePrivate, percent, usageForAccount } from "../lib/accounts";
import { formatResetAt } from "../lib/time";
import { peakLimit, providerName, type UsageEntry, usageEntries, usageOf, usageTone } from "../lib/usage";
import { useNow } from "../lib/use-now";
import type { AuthViewState, DaemonClient } from "../store/daemon-client";
import { SignInChip } from "./accounts/antigravity-card";
import { limitLabel, SavedResets } from "./accounts/usage";
import { ChipMenu } from "./chip-menu";

interface Props {
	client: DaemonClient;
	auth: AuthViewState;
	machines: readonly MachineSummary[];
	/** Provider of the open session's model (`anthropic`), null without a session. */
	provider: string | null;
	/** The session's `credential_pin` for that provider: the OAuth account that served it last. */
	pin: string | null;
	/** Opens the Accounts page. */
	onSeeAll(): void;
}

/** How stale the toolbar's rings may get. */
const BACKGROUND_MAX_AGE_MS = 5 * 60_000;
/** How stale the open menu may be. */
const OPEN_MAX_AGE_MS = 60_000;

/** An account's ring: its 0..1 fill and colour. */
interface Dial {
	key: string;
	fraction: number | undefined;
	tone: string;
}

function dialOf(entry: UsageEntry): Dial {
	if (entry.report === null) return { key: entry.key, fraction: 0, tone: "signed-out" };
	const peak = peakLimit(entry.report);
	return { key: entry.key, fraction: peak?.usedFraction, tone: usageTone(peak) };
}

/** A progress ring, filled clockwise from 12 o'clock: `size` px square, the ring `r` from the centre, `width` thick. */
function Ring({ dial, size, r, width }: { dial: Dial; size: number; r: number; width: number }): ReactNode {
	const c = size / 2;
	const circumference = 2 * Math.PI * r;
	return (
		<svg
			className={`usage-ring usage-ring--${dial.tone}`}
			viewBox={`0 0 ${size} ${size}`}
			width={size}
			height={size}
			strokeWidth={width}
			aria-hidden="true"
		>
			<circle className="usage-ring-track" cx={c} cy={c} r={r} />
			<circle
				className="usage-ring-fill"
				cx={c}
				cy={c}
				r={r}
				strokeDasharray={`${(circumference * barWidth(dial.fraction)) / 100} ${circumference}`}
				transform={`rotate(-90 ${c} ${c})`}
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

/** How close an account is to running out; a signed-out account counts as out. */
function pressure(entry: UsageEntry): number {
	return entry.report === null ? 1 : (peakLimit(entry.report)?.usedFraction ?? 0);
}

/**
 * The account the open session draws on, among its model provider's: the one the session's `credential_pin` names
 * (the account that served it last), else the account omp serves that provider from now, else the provider's first.
 * Without a session, or when its provider reports no usage, the account closest to its limit.
 */
function mainEntry(
	shown: readonly UsageEntry[],
	provider: string | null,
	pin: string | null,
	auth: AuthViewState,
): UsageEntry {
	if (provider !== null) {
		const name = providerName(provider);
		const same = shown.filter(e => providerName(e.provider) === name);
		const pinned = pin === null ? undefined : same.find(e => e.report?.pinHashes?.includes(pin));
		if (pinned) return pinned;
		const accounts = auth.accounts.accounts;
		const active = accounts.find(a => a.active && a.provider === provider);
		const report = active ? usageForAccount(active, auth.usage.reports, accounts) : null;
		const hit = (report && same.find(e => e.report === report)) ?? same[0];
		if (hit) return hit;
	}
	return shown.reduce((worst, e) => (pressure(e) > pressure(worst) ? e : worst));
}

/**
 * The toolbar's usage pill: the open session's account as a ring with its name and percentage, every other account
 * (omp's broker providers and each machine's Antigravity quota alike) as a small ring in a row beneath. Opens a menu
 * with every limit. Hidden when no source exists.
 */
export function UsageMenu({ client, auth, machines, provider, pin, onSeeAll }: Props): ReactNode {
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
	let label: ReactNode;
	if (shown.length === 0) {
		label = (
			<span className="usage-item">
				<Gauge size={15} aria-hidden="true" />
				<span className="usage-name">Usage</span>
			</span>
		);
	} else {
		const main = mainEntry(shown, provider, pin, auth);
		const dial = dialOf(main);
		const others = shown.filter(e => e !== main);
		label = (
			<span className="usage-item" data-status={dial.tone}>
				<Ring dial={dial} size={22} r={8.5} width={3} />
				<span className="usage-stack">
					<span className="usage-main">
						<span className="usage-name">{main.name}</span>
						{main.report === null ? (
							<span className="usage-pct usage-pct--signed-out">signed out</span>
						) : (
							dial.fraction !== undefined && (
								<span className={`usage-pct usage-pct--${dial.tone}`}>{percent(dial.fraction)}</span>
							)
						)}
					</span>
					{others.length > 0 && (
						<span className="usage-minis">
							{others.map(e => (
								<Ring key={e.key} dial={dialOf(e)} size={8} r={3} width={1.6} />
							))}
						</span>
					)}
				</span>
			</span>
		);
	}
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
