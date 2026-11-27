import type { BrokerStatus, MachineSummary } from "@omp-web/protocol";
import type { ReactNode } from "react";
import { describeBroker, describeMachineBroker } from "../../lib/accounts";
import { displayPath } from "../../lib/environment";
import { Moment } from "../moment";

interface Props {
	broker: BrokerStatus | null;
	machines: readonly MachineSummary[];
	now: number;
}

/** The managed credential broker: whether it runs, where its state lives, and how every machine reaches it. */
export function BrokerCard({ broker, machines, now }: Props): ReactNode {
	if (broker === null) return <section className="acct-card">Waiting for the gateway…</section>;
	const view = describeBroker(broker, now);
	return (
		<section
			className="acct-card"
			data-section="broker"
			data-phase={broker.phase}
			data-healthy={String(broker.healthy)}
		>
			<h3>
				Auth broker <span className={`acct-chip acct-chip--${view.tone}`}>{view.headline}</span>
			</h3>
			{view.detail && <p className="acct-note">{view.detail}</p>}
			{broker.phase === "disabled" ? (
				<details className="acct-how">
					<summary>How this works</summary>
					<p className="acct-note">
						Credentials are not centralised: every machine uses the sign-in omp has on that machine. To sign in
						once for all machines, start the gateway with <code>--broker</code> (or{" "}
						<code>
							"broker": {"{"} "enabled": true {"}"}
						</code>{" "}
						in <code>config.json</code>); see <code>README.md</code>. Enabling it switches every machine to the
						broker's credentials, which start empty: sign in here, or migrate what the gateway machine already
						has.
					</p>
				</details>
			) : (
				<dl className="acct-facts">
					<dt>Address</dt>
					<dd>
						<code>{broker.url}</code>
						{broker.advertisedUrl && broker.advertisedUrl !== broker.url && (
							<>
								{" "}
								(other machines: <code>{broker.advertisedUrl}</code>)
							</>
						)}
					</dd>
					<dt>State</dt>
					<dd>
						<code>
							{broker.home
								? displayPath(
										`${broker.home}/.omp`,
										machines.find(m => m.gateway),
									)
								: ""}
						</code>{" "}
						— credentials in <code>agent.db</code>, bearer token in <code>auth-broker.token</code> (owner-only;
						never shown here)
					</dd>
					{broker.pid !== null && (
						<>
							<dt>Process</dt>
							<dd>
								pid {broker.pid}
								{broker.version ? `, omp ${broker.version}` : ""}
								{broker.startedAt !== null && (
									<>
										, up since <Moment at={broker.startedAt} now={now} />
									</>
								)}
								{broker.restarts > 0 && `, restarted ${broker.restarts}×`}
							</dd>
						</>
					)}
					{broker.lastError && broker.phase !== "restarting" && (
						<>
							<dt>Last failure</dt>
							<dd>
								{broker.lastError.message} (<Moment at={broker.lastError.at} now={now} />)
							</dd>
						</>
					)}
				</dl>
			)}
			{broker.phase !== "disabled" && (
				<ul className="acct-machines" aria-label="Machines and the broker">
					{machines.map(machine => {
						const text = machine.online ? describeMachineBroker(machine.broker, machine.name) : null;
						return (
							<li
								key={machine.id}
								data-machine={machine.id}
								data-broker-state={machine.online ? (machine.broker?.state ?? "unknown") : "offline"}
							>
								<span className={`acct-chip acct-chip--${machine.online ? (text?.tone ?? "off") : "off"}`}>
									{machine.online ? (machine.broker?.state ?? "…") : "offline"}
								</span>{" "}
								<strong>{machine.name}</strong>
								{text && text.tone !== "ok" && <span className="acct-note"> — {text.text}</span>}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
