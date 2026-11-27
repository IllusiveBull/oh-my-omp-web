import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

interface Props {
	/** Chip content. */
	label: ReactNode;
	title: string;
	/** Trigger look in place of a chip (e.g. a round icon button). */
	buttonClass?: string;
	/** Accessible name of a trigger whose label is only an icon. */
	ariaLabel?: string;
	ariaBusy?: boolean;
	disabled?: boolean;
	/** `up`: the popover opens above the chip (a chip at the bottom of the page). */
	placement?: "up";
	/** Called each time the menu opens (lazy loading of its options). */
	onOpen?(): void;
	children(close: () => void): ReactNode;
}

/** Gap between the popover and the viewport edges. */
const EDGE = 8;
/** Gap between the chip and the popover. */
const GAP = 4;

/**
 * Pins the popover (`position: fixed`) to the chip in viewport coordinates, so a scrolling ancestor (the sidebar) cannot
 * clip it: below the chip (above it for `up`), shifted left to stay on screen, as tall as the room on that side.
 */
function place(trigger: HTMLElement, pop: HTMLElement, up: boolean): void {
	const rect = trigger.getBoundingClientRect();
	const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - pop.offsetWidth - EDGE));
	pop.style.setProperty("--pop-left", `${left}px`);
	if (up) {
		pop.style.setProperty("--pop-bottom", `${window.innerHeight - rect.top + GAP}px`);
		pop.style.setProperty("--pop-max-h", `${rect.top - GAP - EDGE}px`);
	} else {
		pop.style.setProperty("--pop-top", `${rect.bottom + GAP}px`);
		pop.style.setProperty("--pop-max-h", `${window.innerHeight - rect.bottom - GAP - EDGE}px`);
	}
}

/** A chip that opens a small popover; closes on outside click and Escape. */
export function ChipMenu({
	label,
	title,
	buttonClass,
	ariaLabel,
	ariaBusy,
	disabled,
	placement,
	onOpen,
	children,
}: Props): ReactNode {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLSpanElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const pop = useRef<HTMLDivElement>(null);
	const up = placement === "up";

	useEffect(() => {
		if (!open) return;
		const onPointer = (e: PointerEvent): void => {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	useLayoutEffect(() => {
		if (!open) return;
		const follow = (): void => {
			if (trigger.current && pop.current) place(trigger.current, pop.current, up);
		};
		follow();
		window.addEventListener("resize", follow);
		// Capture: the scrolling element is an ancestor (the sidebar, the transcript), not the window.
		window.addEventListener("scroll", follow, true);
		// The popover's width changes with its content (a list that loads, a form that opens).
		const resized = typeof ResizeObserver === "function" ? new ResizeObserver(follow) : undefined;
		if (pop.current) resized?.observe(pop.current);
		return () => {
			window.removeEventListener("resize", follow);
			window.removeEventListener("scroll", follow, true);
			resized?.disconnect();
		};
	}, [open, up]);

	return (
		<span className="chip-menu" ref={root}>
			<button
				ref={trigger}
				type="button"
				className={buttonClass ?? "chip chip--button"}
				title={title}
				aria-label={ariaLabel}
				aria-busy={ariaBusy || undefined}
				aria-haspopup="listbox"
				aria-expanded={open}
				disabled={disabled}
				onClick={() => {
					if (!open) onOpen?.();
					setOpen(!open);
				}}
			>
				{label}
			</button>
			{open && (
				<>
					{/* Phones only (app.css): dims the page behind the bottom sheet; a tap on it closes the menu without
					 * reaching the control underneath. */}
					<div className="chip-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
					<div ref={pop} className={up ? "chip-pop chip-pop--up" : "chip-pop"}>
						{children(() => setOpen(false))}
					</div>
				</>
			)}
		</span>
	);
}
