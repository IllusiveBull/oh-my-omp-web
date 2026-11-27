import { Plus, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { TerminalTab } from "../../lib/terminal";
import { IconButton } from "../ui/icon-button";

interface Props {
	tabs: readonly TerminalTab[];
	/** The terminal on screen. */
	active: string | null;
	/** Why "New terminal" cannot be used (shown as its tooltip), or null. */
	newBlocked: string | null;
	onSelect(id: string): void;
	/** Each returns an error message, or null on success. */
	onCreate(): Promise<string | null>;
	onKill(id: string): Promise<string | null>;
	onDismiss(id: string): Promise<string | null>;
}

/**
 * The machine's terminals as tabs. The close button never ends a shell silently: on a running one it asks first
 * (then `term.kill`), on an exited or lost one it removes it from the list (`term.dismiss`). Leaving the view without
 * ending anything is the Detach button of the view, or picking another tab.
 */
export function TerminalTabs({ tabs, active, newBlocked, onSelect, onCreate, onKill, onDismiss }: Props): ReactNode {
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const act = async (task: () => Promise<string | null>): Promise<void> => {
		setBusy(true);
		setError(null);
		setError(await task());
		setBusy(false);
	};

	return (
		<div className="term-tabs-wrap">
			<div className="term-tabs" role="tablist" aria-label="Terminals">
				{tabs.map(tab => (
					<div
						key={tab.id}
						className={`term-tab${tab.id === active ? " term-tab--on" : ""}`}
						data-terminal={tab.id}
						data-state={tab.state}
					>
						<button
							type="button"
							role="tab"
							aria-selected={tab.id === active}
							className="term-tab-pick"
							title={tab.title}
							onClick={() => onSelect(tab.id)}
						>
							<span className={`term-dot term-dot--${tab.state}`} aria-label={tab.state} />
							<span className="term-tab-title">{tab.title}</span>
							{tab.purpose === "broker-login" && <span className="term-badge">broker login</span>}
						</button>
						<IconButton
							small
							danger
							icon={X}
							className="term-tab-x"
							data-role={tab.state === "running" ? "term-kill" : "term-dismiss"}
							disabled={busy || tab.state === "offline" || tab.state === "disabled"}
							label={tab.state === "running" ? "End this shell" : "Remove this terminal"}
							onClick={() => {
								if (tab.state === "running") setConfirming(tab.id);
								else void act(() => onDismiss(tab.id));
							}}
						/>
					</div>
				))}
				<IconButton
					icon={Plus}
					className="term-tab-new"
					data-role="term-new"
					data-place="tabs"
					disabled={busy || newBlocked !== null}
					label="New terminal"
					title={newBlocked ?? "New terminal in the selected worktree"}
					onClick={() => void act(onCreate)}
				/>
			</div>
			{confirming !== null && (
				<div className="term-confirm" role="alertdialog" data-role="term-confirm">
					<span>Kill this shell? Programs running in it are terminated.</span>
					<button
						type="button"
						className="btn btn--small btn--danger"
						data-role="term-confirm-yes"
						disabled={busy}
						onClick={() => {
							const id = confirming;
							setConfirming(null);
							void act(() => onKill(id));
						}}
					>
						Kill
					</button>
					<button
						type="button"
						className="btn btn--small"
						data-role="term-confirm-no"
						onClick={() => setConfirming(null)}
					>
						Cancel
					</button>
				</div>
			)}
			{error && (
				<div className="form-error" role="alert" data-role="term-error">
					{error}
				</div>
			)}
		</div>
	);
}
