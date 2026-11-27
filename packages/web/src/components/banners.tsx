import type { MachineSummary } from "@omp-web/protocol";
import type { ReactNode } from "react";
import { describeMachineBroker } from "../lib/accounts";
import type { ConnectionPhase } from "../store/daemon-client";

interface Props {
	phase: ConnectionPhase;
	/** The machine being looked at (the open session's, else the selected one): its omp warnings are shown. */
	machine: MachineSummary | undefined;
}

export function Banners({ phase, machine }: Props): ReactNode {
	const broker = machine ? describeMachineBroker(machine.broker, machine.name) : null;
	return (
		<>
			{phase !== "open" && (
				<div className="banner banner--warn" role="status">
					{phase === "connecting" ? "Connecting to the gateway…" : "Connection lost — reconnecting…"}
				</div>
			)}
			{machine?.omp.versionMismatch && (
				<div className="banner banner--info" role="status">
					{machine.name}: installed omp {machine.omp.version} differs from the version omp-web was built against (
					{machine.omp.expectedVersion}). Behaviour may drift.
				</div>
			)}
			{machine?.online && broker && broker.tone !== "ok" && (
				<div
					className={`banner banner--${broker.tone === "bad" ? "warn" : "info"}`}
					role="status"
					data-banner="broker"
					data-broker-state={machine.broker?.state}
				>
					{broker.text}
				</div>
			)}
			{machine?.leaseWarnings.map(warning => (
				<div key={warning} className="banner banner--warn" role="status">
					{machine.name}: session ownership checks may be unreliable: {warning}
				</div>
			))}
		</>
	);
}
