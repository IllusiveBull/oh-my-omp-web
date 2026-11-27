import type { Ack, AccountWire, LoginFlowWire, LoginProviderWire, MachineSummary } from "@omp-web/protocol";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { HIDE_PRIVATE_KEY, loadHidePrivate } from "../lib/accounts";
import { disabledMessage } from "../lib/terminal";
import { parseRoute, routeHash, type TerminalRef } from "../lib/route";
import { antigravityEntries, usageOf } from "../lib/usage";
import type { AuthViewState, DaemonClient } from "../store/daemon-client";
import { terminalsOf } from "../store/terminal-client";
import { AccountList } from "./accounts/account-list";
import { AntigravityCard, AntigravityUsageList } from "./accounts/antigravity-card";
import { BrokerCard } from "./accounts/broker-card";
import { LoginFlowCard } from "./accounts/login-flow";
import { ProviderList } from "./accounts/providers";
import { UsageSection } from "./accounts/usage";

interface Props {
	client: DaemonClient;
	auth: AuthViewState;
	machines: readonly MachineSummary[];
	onClose(): void;
	/** Shows the terminal that "Open in terminal" started. Defaults to opening it in the dock beside this page. */
	onOpenTerminal?(ref: TerminalRef): void;
}

function showTerminal(ref: TerminalRef): void {
	location.hash = routeHash({ main: parseRoute(location.hash).main, dock: { tab: "terminal", ref } });
}

/** A request's failure as the message to show, or null when it succeeded. */
async function failure(request: Promise<Ack>): Promise<string | null> {
	const ack = await request;
	return ack.ok ? null : ack.error;
}

/** `auth.usage.refresh` answers `{ refreshed: false, retryInMs }` when it was asked too soon. */
function tooSoon(data: unknown): number | null {
	if (typeof data !== "object" || data === null || !("refreshed" in data) || data.refreshed !== false) return null;
	return "retryInMs" in data && typeof data.retryInMs === "number" ? data.retryInMs : 0;
}

/**
 * Credentials: the managed broker and how each machine reaches it, signing in (the flow is shared by every window),
 * accounts with log out and usage. While this page is open the gateway keeps its data fresh; closing it stops that.
 */
export function AccountsPanel({ client, auth, machines, onClose, onOpenTerminal = showTerminal }: Props): ReactNode {
	const [now, setNow] = useState(() => Date.now());
	const [hidePrivate, setHidePrivate] = useState(loadHidePrivate);
	const toggleHidePrivate = (): void => {
		const next = !hidePrivate;
		setHidePrivate(next);
		try {
			if (next) localStorage.setItem(HIDE_PRIVATE_KEY, "1");
			else localStorage.removeItem(HIDE_PRIVATE_KEY);
		} catch {
			// Keep the choice for this page when storage is unavailable.
		}
	};
	const store = usageOf(client);
	const machineUsage = useSyncExternalStore(store.subscribe, store.getSnapshot).antigravity;
	const latestMachines = useRef(machines);
	latestMachines.current = machines;
	useEffect(() => {
		client.setAccountsOpen(true);
		const timer = setInterval(() => {
			setNow(Date.now());
			store.refreshAntigravity(latestMachines.current, 300_000);
		}, 15_000);
		return () => {
			clearInterval(timer);
			client.setAccountsOpen(false);
		};
	}, [client, store]);
	// Antigravity sign-ins and quotas: fresh on opening, and when a machine comes online.
	useEffect(() => store.refreshAntigravity(machines, 60_000), [store, machines]);

	const { broker, accounts, flow, usage } = auth;
	const disabled = broker?.phase === "disabled";
	const flowRunning = flow?.status === "running";
	const agyEntries = useMemo(() => antigravityEntries(machineUsage, machines), [machineUsage, machines]);
	const agyAvailable = machines.some(m => m.antigravity?.available === true);

	const startSignIn = (provider: LoginProviderWire): Promise<string | null> =>
		failure(client.authRequest({ t: "auth.login.start", providerId: provider.id }));
	const sendCode = (f: LoginFlowWire, value: string): Promise<string | null> =>
		f.prompt
			? failure(client.authRequest({ t: "auth.login.input", flowId: f.id, promptId: f.prompt.id, value }))
			: Promise.resolve("this sign-in is not asking for a code");
	const cancel = (f: LoginFlowWire): Promise<string | null> =>
		failure(client.authRequest({ t: "auth.login.cancel", flowId: f.id }));
	const dismiss = (f: LoginFlowWire): Promise<string | null> =>
		failure(client.authRequest({ t: "auth.login.dismiss", flowId: f.id }));
	const logout = (a: AccountWire): Promise<string | null> =>
		failure(client.authRequest({ t: "auth.logout", providerId: a.provider, credentialId: a.credentialId }));
	const refreshUsage = async (): Promise<string | null> => {
		store.refreshAntigravity(machines, 0);
		if (disabled) return null;
		const ack = await client.authRequest({ t: "auth.usage.refresh" });
		if (!ack.ok) return ack.error;
		const wait = tooSoon(ack.data);
		return wait === null ? null : `Refreshed a moment ago; try again in ${Math.ceil(wait / 1000)} s.`;
	};

	/** Opens a shell on the gateway machine in the broker's home with `omp auth-broker login <provider>` typed (not run). */
	const openTerminal = async (provider: string): Promise<string | null> => {
		const gateway = machines.find(m => m.gateway);
		const machine = gateway?.id ?? client.getSnapshot().hello?.machine;
		if (!machine) return "The gateway machine is not known yet.";
		const terminals = terminalsOf(client);
		const result = await terminals.open(machine, { purpose: { kind: "broker-login", provider } });
		if (!result.ok)
			return result.code === "terminal_disabled" ? disabledMessage(gateway?.name ?? machine) : result.error;
		onOpenTerminal({ machine, id: result.terminal.id });
		return null;
	};

	return (
		<div className="accounts" data-view="accounts">
			<div className="accounts-head">
				<h2>Accounts &amp; login</h2>
				{!disabled && (
					<button
						type="button"
						className="btn btn--small btn--ghost"
						title="Load the accounts and providers from the broker again"
						onClick={() => void client.authRequest({ t: "auth.refresh" })}
					>
						<RefreshCw size={14} aria-hidden="true" />
						Reload accounts
					</button>
				)}
				<button type="button" className="btn btn--small btn--ghost accounts-close" onClick={onClose}>
					<ArrowLeft size={14} aria-hidden="true" />
					Back to sessions
				</button>
			</div>
			<BrokerCard broker={broker} machines={machines} now={now} />
			<AntigravityCard
				client={client}
				machines={machines}
				hidePrivate={hidePrivate}
				onOpenTerminal={onOpenTerminal}
			/>
			{accounts.error && !disabled && (
				<div className="form-error" role="alert" data-role="accounts-error">
					{accounts.error}
				</div>
			)}
			{flow && (
				<LoginFlowCard
					key={flow.id}
					flow={flow}
					onInput={sendCode}
					onCancel={cancel}
					onDismiss={dismiss}
					onOpenTerminal={openTerminal}
				/>
			)}
			{(!disabled || agyAvailable) && (
				<UsageSection
					usage={disabled ? null : usage}
					now={now}
					onRefresh={refreshUsage}
					hidePrivate={hidePrivate}
					onToggleHidePrivate={toggleHidePrivate}
				>
					{!disabled && (
						<AccountList
							accounts={accounts.accounts}
							disabled={accounts.disabled}
							reports={usage.reports}
							now={now}
							flowRunning={flowRunning}
							hidePrivate={hidePrivate}
							onLogout={logout}
						/>
					)}
					<AntigravityUsageList entries={agyEntries} now={now} hidePrivate={hidePrivate} />
				</UsageSection>
			)}
			{!disabled && (
				<ProviderList
					providers={accounts.providers}
					flowRunning={flowRunning}
					onStart={startSignIn}
					onOpenTerminal={openTerminal}
				/>
			)}
		</div>
	);
}
