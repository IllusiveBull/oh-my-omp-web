import type { PushSubscriptionInfo } from "@omp-web/protocol";
import { Bell, BellOff } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { browserPushDeps, LABEL_MAX, PushSettings } from "../lib/push";
import { notificationSounds, type NotificationSound } from "../lib/notification-sound";
import { Moment } from "./moment";

interface Props {
	/** Defaults to one wired to this browser; tests pass their own. */
	push?: PushSettings;
}

/** An on/off switch: a button with `role="switch"`, labelled by the `<label>` around it. */
function Switch({
	checked,
	disabled,
	className,
	onChange,
}: {
	checked: boolean;
	disabled?: boolean;
	className?: string;
	onChange(next: boolean): void;
}): ReactNode {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			className={className ? `switch ${className}` : "switch"}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		>
			<span className="switch-thumb" />
		</button>
	);
}

/** A device the gateway notifies. This device has no Revoke: its push switch does the same. */
function Device({
	device,
	self,
	now,
	disabled,
	onRevoke,
}: {
	device: PushSubscriptionInfo;
	self: boolean;
	now: number;
	disabled: boolean;
	onRevoke(): void;
}): ReactNode {
	return (
		<li className="notif-device" data-subscription={device.id}>
			<span className="notif-label">{device.label}</span>
			{self && <span className="notif-this">this device</span>}
			<span className="notif-meta">
				added <Moment at={device.createdAt} now={now} /> ·{" "}
				{device.lastDeliveredAt === null ? (
					"no push yet"
				) : (
					<>
						last push <Moment at={device.lastDeliveredAt} now={now} />
					</>
				)}
			</span>
			{!self && (
				<button
					type="button"
					className="btn btn--small notif-revoke"
					aria-label={`Revoke ${device.label}`}
					disabled={disabled}
					onClick={onRevoke}
				>
					Revoke
				</button>
			)}
		</li>
	);
}

function SoundSettings(): ReactNode {
	const enabled = useSyncExternalStore(
		notificationSounds.subscribe,
		notificationSounds.getSnapshot,
		notificationSounds.getSnapshot,
	);
	const [error, setError] = useState<string | null>(null);
	const preview = async (kind: NotificationSound): Promise<void> => {
		setError(null);
		try {
			await notificationSounds.preview(kind);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	return (
		<div className="notif-option notif-sounds">
			<label className="notif-row">
				<span className="notif-row-label">Sounds</span>
				<Switch
					className="notif-sound-toggle"
					checked={enabled}
					onChange={next => notificationSounds.setEnabled(next)}
				/>
			</label>
			<p className="notif-hint">
				Completion, errors and waiting for input in open sessions. Independent of push; interact with the page once
				to allow audio.
			</p>
			{enabled && (
				<div className="notif-tests" role="group" aria-label="Test sounds">
					<span className="notif-tests-label" aria-hidden="true">
						Test
					</span>
					<button
						type="button"
						className="btn btn--small btn--ghost"
						aria-label="Test completion"
						onClick={() => void preview("completion")}
					>
						Completion
					</button>
					<button
						type="button"
						className="btn btn--small btn--ghost"
						aria-label="Test error"
						onClick={() => void preview("error")}
					>
						Error
					</button>
					<button
						type="button"
						className="btn btn--small btn--ghost"
						aria-label="Test input"
						onClick={() => void preview("ask")}
					>
						Input
					</button>
				</div>
			)}
			{error && (
				<p className="notif-error form-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * Web Push settings of this device, notification sounds, and the list of the devices the gateway notifies. Permission
 * is only asked for by turning push on; nothing happens on load but looking at the current state.
 */
export function NotificationSettings({ push }: Props): ReactNode {
	const [settings] = useState(() => push ?? new PushSettings(browserPushDeps()));
	const snapshot = useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
	const [label, setLabel] = useState("");
	useEffect(() => {
		void settings.refresh();
	}, [settings]);
	const now = Date.now();
	const on = snapshot.state === "on";
	const switchable = snapshot.ready && (on || snapshot.state === "off");

	return (
		<section className="notif" aria-label="Notifications">
			<h2 className="notif-title">Notifications</h2>
			<div className="notif-options">
				<div className="notif-option">
					<label className="notif-row">
						<span className="notif-row-label">Push on this device</span>
						<Switch
							className="notif-push-toggle"
							checked={on}
							disabled={!switchable || snapshot.busy}
							// Turning on asks for permission first thing, so it has to run in this click handler.
							onChange={next => void (next ? settings.enable(label) : settings.disable())}
						/>
					</label>
					{snapshot.ready && (
						<p className="notif-hint notif-status" data-state={snapshot.state} role="status">
							{on || snapshot.state === "off"
								? "A notification when a session finishes a turn or needs an answer, unless you are looking at it."
								: snapshot.reason}
						</p>
					)}
					{snapshot.state === "off" && snapshot.ready && (
						<label className="notif-device-field">
							Device name
							<input
								className="notif-device-name"
								name="device-label"
								value={label}
								onChange={e => setLabel(e.target.value)}
								onKeyDown={e => e.key === "Enter" && !snapshot.busy && void settings.enable(label)}
								placeholder={snapshot.defaultLabel}
								maxLength={LABEL_MAX}
								autoComplete="off"
							/>
						</label>
					)}
					{on && (
						<div className="notif-tests">
							<button
								type="button"
								className="btn btn--small btn--ghost notif-push-test"
								disabled={snapshot.busy}
								onClick={() => void settings.sendTest()}
							>
								Test notification
							</button>
						</div>
					)}
					{snapshot.notice && (
						<p className="notif-hint notif-notice" role="status">
							{snapshot.notice}
						</p>
					)}
					{snapshot.error && (
						<div className="notif-error form-error" role="alert">
							{snapshot.error}
						</div>
					)}
				</div>
				<SoundSettings />
			</div>
			{snapshot.devices.length > 0 && (
				<>
					<h3 className="notif-subtitle">Devices</h3>
					<ul className="notif-devices">
						{snapshot.devices.map(device => (
							<Device
								key={device.id}
								device={device}
								self={device.endpointHash === snapshot.self}
								now={now}
								disabled={snapshot.busy}
								onRevoke={() => void settings.revoke(device.id)}
							/>
						))}
					</ul>
				</>
			)}
		</section>
	);
}

/**
 * A bell in a corner of the sidebar: lit when this device gets notifications, struck through otherwise. Clicking it
 * opens the notification settings in a popover that closes on an outside click and Escape.
 */
export function NotificationBell({ push }: Props): ReactNode {
	const [settings] = useState(() => push ?? new PushSettings(browserPushDeps()));
	const snapshot = useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
	const [pop, setPop] = useState<CSSProperties | null>(null);
	const root = useRef<HTMLSpanElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		void settings.refresh();
	}, [settings]);

	useEffect(() => {
		if (!pop) return;
		const onPointer = (e: PointerEvent): void => {
			if (!root.current?.contains(e.target as Node)) setPop(null);
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setPop(null);
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [pop]);

	const toggle = (): void => {
		const rect = button.current?.getBoundingClientRect();
		if (pop || !rect) {
			setPop(null);
			return;
		}
		// The CSS width shrinks on narrow screens; clamp's minimum wins if 300px cannot fit.
		const top = rect.bottom + 4;
		setPop({
			top,
			left: `clamp(calc(8px + env(safe-area-inset-left)), ${rect.left}px, calc(100vw - env(safe-area-inset-right) - 308px))`,
			maxHeight: `min(480px, 70dvh, calc(100dvh - ${top}px - env(safe-area-inset-bottom) - 8px))`,
		});
	};

	const on = snapshot.ready && snapshot.state === "on";
	const label = on ? "Notifications: on" : "Notifications: off";
	return (
		<span className="notif-bell" ref={root}>
			<button
				ref={button}
				type="button"
				className={`icon-btn notif-bell-button${on ? " notif-bell-button--on" : ""}`}
				title={label}
				aria-label={label}
				aria-haspopup="dialog"
				aria-expanded={pop !== null}
				onClick={toggle}
			>
				{on ? <Bell size={16} aria-hidden="true" /> : <BellOff size={16} aria-hidden="true" />}
			</button>
			{pop && (
				<div className="notif-pop" role="dialog" aria-label="Notifications" style={pop}>
					<NotificationSettings push={settings} />
				</div>
			)}
		</span>
	);
}
