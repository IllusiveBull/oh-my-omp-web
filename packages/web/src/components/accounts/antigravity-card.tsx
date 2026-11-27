import type { AntigravityAuthStatusAck, MachineSummary } from "@omp-web/protocol";
import { RefreshCw, SquareTerminal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { TerminalRef } from "../../lib/route";
import { disabledMessage } from "../../lib/terminal";
import { antigravitySignIn, type SignIn, type UsageEntry, usageOf } from "../../lib/usage";
import type { DaemonClient } from "../../store/daemon-client";
import { terminalsOf } from "../../store/terminal-client";
import { Moment } from "../moment";
import { LimitBars, SavedResets } from "./usage";

interface Props {
	client: DaemonClient;
	machines: readonly MachineSummary[];
	hidePrivate?: boolean;
	onOpenTerminal(ref: TerminalRef): void;
}

interface MachineAuthState {
	loading: boolean;
	status: AntigravityAuthStatusAck | null;
	error: string | null;
	runningMethod: string | null;
	notice: { ok: boolean; text: string } | null;
}

/** "Signed in · me@example.com", "Not signed in": a sign-in state as a chip. */
export function SignInChip({ signIn, identity }: { signIn: SignIn; identity?: string | null }): ReactNode {
	return (
		<span className={`acct-chip acct-chip--${signIn.tone}`} data-role="agy-sign-in" data-tone={signIn.tone}>
			{signIn.label}
			{identity ? ` · ${identity}` : ""}
		</span>
	);
}

function MachineAntigravityRow({
	client,
	machine,
	hidePrivate,
	onOpenTerminal,
}: {
	client: DaemonClient;
	machine: MachineSummary;
	hidePrivate: boolean;
	onOpenTerminal(ref: TerminalRef): void;
}): ReactNode {
	const store = usageOf(client);
	const usage = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const [state, setState] = useState<MachineAuthState>({
		loading: machine.online,
		status: null,
		error: null,
		runningMethod: null,
		notice: null,
	});

	const refresh = useCallback(
		async (probe: boolean): Promise<void> => {
			if (!machine.online) return;
			setState(prev => ({ ...prev, loading: true, error: null }));
			if (probe) void store.probe(machine.id);
			const ack = await client.request(machine.id, { t: "antigravity.auth.status" });
			if (ack.ok) {
				setState(prev => ({ ...prev, loading: false, status: ack.data as AntigravityAuthStatusAck, error: null }));
			} else {
				setState(prev => ({ ...prev, loading: false, error: ack.error }));
			}
		},
		[client, store, machine.id, machine.online],
	);

	// The sign-in state comes from the shared quota probe, which the page keeps fresh; only the methods are asked here.
	useEffect(() => {
		if (machine.online) void refresh(false);
	}, [machine.online, refresh]);

	const runAuth = async (methodId: string): Promise<void> => {
		setState(prev => ({ ...prev, runningMethod: methodId, notice: null }));
		const ack = await client.request(machine.id, { t: "antigravity.auth.login", methodId });
		if (ack.ok) {
			setState(prev => ({
				...prev,
				runningMethod: null,
				notice: { ok: true, text: `Authenticated via ${methodId}.` },
			}));
			void refresh(true);
		} else {
			setState(prev => ({ ...prev, runningMethod: null, notice: { ok: false, text: ack.error } }));
		}
	};

	const openTerminal = async (): Promise<void> => {
		setState(prev => ({ ...prev, notice: null }));
		const terminals = terminalsOf(client);
		const result = await terminals.open(machine.id, { purpose: { kind: "antigravity-login" } });
		if (!result.ok) {
			const text = result.code === "terminal_disabled" ? disabledMessage(machine.name) : result.error;
			setState(prev => ({ ...prev, notice: { ok: false, text } }));
			return;
		}
		onOpenTerminal({ machine: machine.id, id: result.terminal.id });
	};

	const methods = state.status?.authMethods ?? [];
	const loginCommand = state.status?.loginCommand ?? "agy acp --login";
	const probed = usage.antigravity[machine.id];
	const signIn = antigravitySignIn(probed);
	const identity = !hidePrivate ? probed?.report?.identity : undefined;
	const busy = state.loading || usage.probing.has(machine.id);

	return (
		<div className="acct-agy-machine" data-testid={`antigravity-machine-${machine.id}`}>
			<div className="acct-agy-head">
				<h4>
					<span>{machine.name}</span>
					{machine.antigravity?.version && <span className="chip">{machine.antigravity.version}</span>}
					{!machine.online && <span className="chip">offline</span>}
					{machine.online && (
						<span data-testid={`antigravity-identity-${machine.id}`}>
							<SignInChip signIn={signIn} identity={identity} />
						</span>
					)}
					{state.status?.hasGeminiApiKey && <span className="chip">GEMINI_API_KEY</span>}
					{state.status?.configuredMethod && <span className="chip">method: {state.status.configuredMethod}</span>}
				</h4>
				{machine.online && (
					<button
						type="button"
						className="btn btn--small btn--ghost"
						title={`Check ${machine.name}'s sign-in and quota again`}
						disabled={busy}
						onClick={() => void refresh(true)}
					>
						<RefreshCw size={14} aria-hidden="true" />
						{busy ? "Checking…" : "Refresh"}
					</button>
				)}
			</div>
			{machine.online && signIn.detail && (
				<p className="acct-note" data-usage-reason={probed?.unavailable?.reason}>
					{signIn.detail}
				</p>
			)}
			{state.error && (
				<div className="form-error" role="alert">
					{state.error}
				</div>
			)}
			{machine.online && (
				<div className="acct-agy-actions">
					{methods.map(method => (
						<button
							key={method.id}
							type="button"
							className="btn"
							data-testid={`antigravity-auth-${method.id}`}
							disabled={state.runningMethod !== null}
							title={method.description ?? `Authenticate Antigravity ACP with ${method.id}`}
							onClick={() => void runAuth(method.id)}
						>
							{state.runningMethod === method.id ? `Signing in (${method.name})…` : `Sign in: ${method.name}`}
						</button>
					))}
					<button
						type="button"
						className="btn"
						data-testid="antigravity-open-terminal"
						disabled={state.runningMethod !== null}
						title={`Open a terminal on ${machine.name} with \`${loginCommand}\` typed (not run)`}
						onClick={() => void openTerminal()}
					>
						<SquareTerminal size={14} aria-hidden="true" />
						Open in terminal
					</button>
				</div>
			)}
			<p className="acct-note">
				CLI login command: <code className="acct-agy-cmd">{loginCommand}</code>
			</p>
			{state.notice && (
				<div className={state.notice.ok ? "acct-note acct-ok" : "form-error"} role="status">
					{state.notice.text}
				</div>
			)}
		</div>
	);
}

/**
 * Antigravity CLI (`agy acp`) sign-in per machine. Independent of omp's credential broker so machines can sign in
 * even when `--broker` is off; their quota is listed with the other accounts under Accounts & usage.
 */
export function AntigravityCard({ client, machines, hidePrivate = false, onOpenTerminal }: Props): ReactNode {
	const supported = machines.filter(m => m.antigravity?.available === true);
	if (supported.length === 0) return null;
	return (
		<section className="acct-card" data-testid="antigravity-auth-card">
			<h3>
				<span>Antigravity (ACP)</span>
				<span className="acct-count">{supported.length}</span>
			</h3>
			<div className="acct-agy-list">
				{supported.map(machine => (
					<MachineAntigravityRow
						key={machine.id}
						client={client}
						machine={machine}
						hidePrivate={hidePrivate}
						onOpenTerminal={onOpenTerminal}
					/>
				))}
			</div>
			<details className="acct-how">
				<summary>How this works</summary>
				<p className="acct-note">
					Antigravity uses each machine&apos;s own CLI credentials rather than omp&apos;s auth broker. Sign in via
					ACP authentication or run <code>agy acp --login</code> in a terminal on that machine.
				</p>
			</details>
		</section>
	);
}

/** Antigravity quotas as accounts under Accounts & usage: one per Google account, with the machines that use it. */
export function AntigravityUsageList({
	entries,
	now,
	hidePrivate,
}: {
	entries: readonly UsageEntry[];
	now: number;
	hidePrivate: boolean;
}): ReactNode {
	if (entries.length === 0) return null;
	return (
		<div className="acct-group" data-provider="antigravity">
			<h4>
				Antigravity
				<span className="acct-count">
					{entries.length} {entries.length === 1 ? "account" : "accounts"}
				</span>
			</h4>
			<ul className="acct-accounts">
				{entries.map(entry => {
					const report = entry.report;
					const identity = report?.identity;
					return (
						<li key={entry.key} className="acct-account" data-testid={`antigravity-usage-${entry.key}`}>
							<div className="acct-account-row">
								<span className="acct-account-label">
									<span className="acct-account-name">
										{identity ? (hidePrivate ? "Hidden account" : identity) : entry.machines.join(", ")}
									</span>
									{entry.signIn && entry.signIn.tone !== "ok" && <SignInChip signIn={entry.signIn} />}
								</span>
							</div>
							{identity && <p className="acct-meta">on {entry.machines.join(", ")}</p>}
							<SavedResets report={report} now={now} />
							{report && <LimitBars report={report} now={now} />}
							{report && (
								<p className="acct-meta">
									Quota updated <Moment at={report.fetchedAt} now={now} />
								</p>
							)}
							{entry.note && <p className="acct-meta">{entry.note}</p>}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
