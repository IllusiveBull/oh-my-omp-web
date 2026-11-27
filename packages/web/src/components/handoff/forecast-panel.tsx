import type { HandoffWire } from "@omp-web/protocol";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import type { ReactNode } from "react";
import {
	canCancel,
	canConfirm,
	countdown,
	forecastView,
	INFERENCE_MARKER,
	ITEM_STATUS_TEXT,
	rewriteText,
} from "../../lib/handoff";
import { CarriedView, NotCarried } from "./carried";

/** The summary is also an icon, so the word is not the only carrier besides colour. */
const FORECAST_ICON = {
	hit: <CircleCheck size={14} aria-hidden="true" />,
	partial: <CircleAlert size={14} aria-hidden="true" />,
	miss: <CircleX size={14} aria-hidden="true" />,
} satisfies Record<"hit" | "partial" | "miss", ReactNode>;

interface Props {
	wire: HandoffWire;
	/** Epoch ms for the expiry countdown. */
	now: number;
	/** A confirm or cancel request is in flight. */
	busy: boolean;
	onConfirm(): void;
	onCancel(): void;
}

/**
 * The `awaiting_confirm` screen: what the cache will do after the move (every item, inferred ones flagged in words), what
 * was carried, how long the operation waits, and the two buttons.
 */
export function ForecastPanel({ wire, now, busy, onConfirm, onCancel }: Props): ReactNode {
	const forecast = wire.forecast;
	const left = wire.expiresAt === undefined ? null : countdown(wire.expiresAt, now);
	const view = forecast ? forecastView(forecast.summary) : null;
	return (
		<section
			className={`handoff-forecast ${view?.className ?? ""}`}
			data-testid="handoff-forecast"
			data-summary={forecast?.summary}
		>
			{forecast && view ? (
				<>
					<div className="handoff-forecast-word" data-testid="handoff-forecast-word">
						{FORECAST_ICON[forecast.summary]}
						{view.word}
					</div>
					<h3 className="handoff-forecast-head" data-testid="handoff-forecast-headline">
						{forecast.headline}
					</h3>
					<p className="handoff-note" data-testid="handoff-forecast-rewrite">
						{rewriteText(forecast)}
					</p>
					<ul className="handoff-items" data-testid="handoff-forecast-items">
						{forecast.items.map(item => (
							<li
								key={item.id}
								className={`handoff-item handoff-item--${item.status}`}
								data-testid={`handoff-forecast-item-${item.id}`}
								data-status={item.status}
								data-inference={item.inference}
							>
								<span className="handoff-item-label">{item.label}</span>
								<span className="handoff-item-status">{ITEM_STATUS_TEXT[item.status]}</span>
								<span className="handoff-item-detail">
									{item.detail}
									{item.inference && (
										<>
											{" "}
											<span className="handoff-inference">{INFERENCE_MARKER}</span>
										</>
									)}
								</span>
							</li>
						))}
					</ul>
				</>
			) : (
				<p className="handoff-note">
					{wire.freshSession
						? `The session has no conversation yet: a new session starts on ${wire.target.machineName}, so there is no cache to forecast.`
						: "The cache forecast is not available."}
				</p>
			)}
			{wire.carried && (
				<div className="handoff-section" data-testid="handoff-forecast-carried">
					<h4>Carried</h4>
					<CarriedView carried={wire.carried} />
					<NotCarried carried={wire.carried} />
				</div>
			)}
			{wire.droppedDirectories && wire.droppedDirectories.length > 0 && (
				<div className="handoff-section" data-testid="handoff-dropped-dirs">
					<h4>Additional directories dropped on {wire.target.machineName}</h4>
					<ul className="handoff-paths">
						{wire.droppedDirectories.map(dir => (
							<li key={dir}>{dir}</li>
						))}
					</ul>
				</div>
			)}
			{left && (
				<p className="handoff-expiry" data-testid="handoff-expiry" data-expired={left.expired}>
					{left.expired
						? "Expired: the gateway is rolling the switch back."
						: `Rolls back by itself in ${left.text} unless you confirm.`}
				</p>
			)}
			<div className="handoff-actions">
				<button
					type="button"
					className="btn btn--primary"
					data-testid="handoff-confirm"
					disabled={busy || !canConfirm(wire, now)}
					onClick={onConfirm}
				>
					Confirm switch
				</button>
				<button
					type="button"
					className="btn btn--danger"
					data-testid="handoff-cancel"
					disabled={busy || !canCancel(wire)}
					onClick={onCancel}
				>
					Cancel switch
				</button>
			</div>
		</section>
	);
}
