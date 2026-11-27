import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "./ui/icon-button";

/** Tool-result thumbnails (collab-web `ResultImages`) and images attached to messages (`MsgContent`). */
const IMAGE_SELECTOR = ".tv-imgs img.tv-img, img.tr-msg-img";
/** One transcript: the gallery the arrows step through. */
const SCOPE_SELECTOR = ".session-transcript, .ag-drawer-body";

interface Gallery {
	srcs: string[];
	index: number;
}

/** The images of the clicked one's transcript, or null when the click was not on a transcript image. */
export function galleryFor(target: EventTarget | null): Gallery | null {
	if (!(target instanceof Element)) return null;
	const hit = target.closest(".tv-imgs > button, img.tr-msg-img");
	const img = hit instanceof HTMLImageElement ? hit : hit?.querySelector("img.tv-img");
	if (!(img instanceof HTMLImageElement)) return null;
	const scope = img.closest(SCOPE_SELECTOR) ?? document;
	const all = [...scope.querySelectorAll<HTMLImageElement>(IMAGE_SELECTOR)];
	return { srcs: all.map(i => i.src), index: Math.max(0, all.indexOf(img)) };
}

/** A data: URL as a blob: URL, which browsers open in a tab (top-level data: navigation is blocked). */
async function openInTab(src: string): Promise<void> {
	const url = URL.createObjectURL(await (await fetch(src)).blob());
	window.open(url, "_blank", "noopener");
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * In-page viewer for transcript images. Upstream's thumbnails open a new tab on click; a capture listener on the document
 * takes plain clicks first (modifier clicks keep the new tab). Fit to screen; click the image for actual size;
 * arrows / swipe step through the transcript's images; Escape or the backdrop closes.
 */
export function ImageViewer(): ReactNode {
	const [gallery, setGallery] = useState<Gallery | null>(null);
	const [actual, setActual] = useState(false);
	const returnFocus = useRef<HTMLElement | null>(null);
	const dialog = useRef<HTMLDivElement>(null);
	const touchX = useRef<number | null>(null);

	useEffect(() => {
		const onClick = (e: MouseEvent): void => {
			if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			const next = galleryFor(e.target);
			if (!next) return;
			e.preventDefault();
			e.stopPropagation();
			returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			setActual(false);
			setGallery(next);
		};
		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, []);

	const close = useCallback((): void => {
		setGallery(null);
		returnFocus.current?.focus({ preventScroll: true });
	}, []);
	const step = useCallback((by: number): void => {
		setActual(false);
		setGallery(g => (g && g.srcs.length > 1 ? { ...g, index: (g.index + by + g.srcs.length) % g.srcs.length } : g));
	}, []);

	const open = gallery !== null;
	useEffect(() => {
		if (!open) return;
		dialog.current?.querySelector<HTMLButtonElement>(".imgv-close")?.focus({ preventScroll: true });
		// Capture on window: Escape here must not also close a drawer or panel underneath.
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") close();
			else if (e.key === "ArrowLeft") step(-1);
			else if (e.key === "ArrowRight") step(1);
			else return;
			e.preventDefault();
			e.stopPropagation();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, close, step]);

	if (!gallery) return null;
	const src = gallery.srcs[gallery.index]!;
	const many = gallery.srcs.length > 1;
	return (
		<div
			ref={dialog}
			className="imgv"
			role="dialog"
			aria-modal="true"
			aria-label="Image viewer"
			onClick={e => e.target === e.currentTarget && close()}
		>
			<div className="imgv-bar">
				<span className="imgv-count">{many ? `${gallery.index + 1} / ${gallery.srcs.length}` : ""}</span>
				<IconButton icon={ExternalLink} label="Open in new tab" onClick={() => void openInTab(src)} />
				<IconButton icon={X} label="Close" className="imgv-close" onClick={close} />
			</div>
			<div
				className={`imgv-stage${actual ? " imgv-stage--actual" : ""}`}
				onClick={e => e.target === e.currentTarget && close()}
				onTouchStart={e => {
					touchX.current = e.touches.length === 1 ? e.touches[0]!.clientX : null;
				}}
				onTouchEnd={e => {
					const start = touchX.current;
					touchX.current = null;
					if (start === null || actual || !many) return;
					const dx = e.changedTouches[0]!.clientX - start;
					if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
				}}
			>
				<img
					className="imgv-img"
					src={src}
					alt={many ? `Image ${gallery.index + 1} of ${gallery.srcs.length}` : "Image"}
					title={actual ? "Fit to screen" : "Actual size"}
					onClick={() => setActual(a => !a)}
				/>
			</div>
			{many && (
				<>
					<IconButton
						icon={ChevronLeft}
						label="Previous image"
						className="imgv-nav imgv-nav--prev"
						onClick={() => step(-1)}
					/>
					<IconButton
						icon={ChevronRight}
						label="Next image"
						className="imgv-nav imgv-nav--next"
						onClick={() => step(1)}
					/>
				</>
			)}
		</div>
	);
}
