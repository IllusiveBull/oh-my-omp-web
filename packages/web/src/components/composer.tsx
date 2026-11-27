import { shouldSubmitOnEnter } from "@oh-my-pi/collab-web/src/components/shell/Composer";
import { type ImageWire, MAX_MESSAGE_IMAGE_CHARS, type SlashCommandWire } from "@omp-web/protocol";
import { ChevronsUpDown, FileUp, ImageIcon, ListPlus, Plus, SendHorizontal, Square, X } from "lucide-react";
import {
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	compose,
	type DraftAttachments,
	type DraftImage,
	fileMarker,
	isMarkerSized,
	markerOf,
	markerRange,
	NO_ATTACHMENTS,
	nextNumber,
	pasteMarker,
	prune,
	removeMarker,
	wrapAttachment,
} from "../lib/draft-attachments";
import { enterAction, type SlashItem, slashMenu, wantsModels } from "../lib/slash-menu";
import { ChipMenu } from "./chip-menu";
import { IconButton } from "./ui/icon-button";

type Ack = { ok: boolean; error?: string };

const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Largest text file "Add files" takes: it goes into the message itself. */
const MAX_FILE_BYTES = 1024 * 1024;

/** A pasted, dropped or picked image file as base64, with its size for the `[Image #N, WxH]` marker when known. */
async function readImage(file: File): Promise<Omit<DraftImage, "n">> {
	const read = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => read.resolve(String(reader.result));
	reader.onerror = () => read.reject(reader.error ?? new Error(`could not read ${file.name}`));
	reader.readAsDataURL(file);
	const url = await read.promise;
	const image: ImageWire = { data: url.slice(url.indexOf(",") + 1), mimeType: file.type as ImageWire["mimeType"] };
	if (typeof Image === "undefined") return { image };
	const sized = Promise.withResolvers<Omit<DraftImage, "n">>();
	const probe = new Image();
	probe.onload = () => sized.resolve({ image, width: probe.naturalWidth, height: probe.naturalHeight });
	probe.onerror = () => sized.resolve({ image });
	probe.src = url;
	return sized.promise;
}

/** A text file's content; binary files are refused, since the content goes into the message. */
async function readTextFile(file: File): Promise<string> {
	if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 1 MB`);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
	} catch {
		throw new Error(`${file.name} is not a text file`);
	}
	if (text.includes("\0")) throw new Error(`${file.name} is not a text file`);
	return text;
}

interface Props {
	working: boolean;
	disabled: boolean;
	/** The draft lives in the parent so it survives while another panel replaces the composer and can be filled from outside. */
	draft: string;
	/** What the draft's markers stand for, kept with it. */
	attachments: DraftAttachments;
	/** Submitted user text from the current session, oldest first. */
	history: readonly string[];
	onDraftChange(draft: string, attachments?: DraftAttachments): void;
	commands: readonly SlashCommandWire[];
	/** The session's models as `provider/id`, for the argument of `/model` and `/switch`. */
	loadModels(): Promise<string[]>;
	/** `/model` picked from the menu: opens the model hub (roles), as the terminal UI does. */
	onOpenModels(): void;
	onPrompt(message: string, images?: ImageWire[]): Promise<Ack>;
	onSteer(message: string, images?: ImageWire[]): Promise<Ack>;
	onFollowUp(message: string, images?: ImageWire[]): Promise<Ack>;
	onAbort(): void;
	/** Whether the session backend supports mid-turn steering (false defaults running-turn sends to Queue). */
	canSteer?: boolean;
	/** Whether `/model` opens omp's model-roles hub. */
	canOpenModels?: boolean;
	/** Label of the active agent for the composer placeholder (default `"omp"`). */
	agentLabel?: string;
}

/**
 * Prompt when idle; while a turn runs, Send either steers (interrupts with the new message) or queues it for after the
 * turn — the arrows beside it switch which — and Stop aborts. A draft starting with `/` is a slash command and always
 * goes out as a plain prompt: omp runs it itself. The slash menu completes the command word, then its argument: a model
 * for `/switch` and `/model …` (picked and run, as the terminal UI's model picker does), else the command's
 * subcommands. Picking `/model` itself opens the model hub.
 *
 * Attachments work as in omp's editor: an image (pasted, dropped, or from "+") becomes an `[Image #N, WxH]` marker in the
 * text, a large paste offers omp's choice of a wrapped block, a `[Paste #N]` marker or the plain text, and a text file
 * becomes a `[File #N, name]` marker. A marker deletes as a unit; deleting it drops what it stands for.
 */
export function Composer({
	working,
	disabled,
	draft,
	attachments,
	history,
	onDraftChange,
	commands,
	loadModels,
	onOpenModels,
	onPrompt,
	onSteer,
	onFollowUp,
	onAbort,
	canSteer = true,
	canOpenModels = true,
	agentLabel = "omp",
}: Props): ReactNode {
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState(0);
	/** Moved through the menu with the arrows since the draft last changed. */
	const [navigated, setNavigated] = useState(false);
	const [models, setModels] = useState<string[] | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);
	/** The draft the user pressed Escape on: the menu stays closed until the draft changes. */
	const [closedFor, setClosedFor] = useState<string | null>(null);
	/** What Send does while a turn runs. */
	const [mode, setMode] = useState<"steer" | "queue">("steer");
	/** A marker-sized paste waiting for the user's choice of how it goes in. */
	const [pendingPaste, setPendingPaste] = useState<string | null>(null);
	const composing = useRef(false);
	const input = useRef<HTMLTextAreaElement>(null);
	const photoInput = useRef<HTMLInputElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	/** Where the caret goes after the next render (an insertion or a marker deleted as a unit). */
	const caret = useRef<number | null>(null);
	/** The draft as last changed here: attachments arrive asynchronously, and several can land before a render. */
	const latest = useRef({ draft, attachments });
	latest.current = { draft, attachments };
	const recall = useRef<{
		items: readonly string[];
		index: number;
		saved: { draft: string; attachments: DraftAttachments };
		expected: string;
	} | null>(null);

	const message = draft.trim();
	const isSlash = message.startsWith("/");
	const needModels = wantsModels(commands, draft);
	const menu = slashMenu(commands, draft, models);
	const matches = menu.items;
	const menuOpen = (matches.length > 0 || menu.loading || (needModels && modelsError !== null)) && closedFor !== draft;
	const active = Math.min(selected, matches.length - 1);
	const steering = working && !isSlash;
	const effectiveMode: "steer" | "queue" = canSteer ? mode : "queue";
	const sendLabel = !steering ? "Send" : effectiveMode === "steer" ? "Steer" : "Queue";

	// Fetched afresh each time the model argument is reached: the list changes with logins and provider setup.
	useEffect(() => {
		if (!needModels) return;
		let current = true;
		setModels(null);
		setModelsError(null);
		loadModels().then(
			list => current && setModels(list),
			(e: unknown) => current && setModelsError(e instanceof Error ? e.message : String(e)),
		);
		return () => {
			current = false;
		};
	}, [needModels, loadModels]);

	// One row, as tall as the buttons beside it, growing with the text up to the CSS max-height.
	useLayoutEffect(() => {
		const el = input.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
	}, [draft]);

	useLayoutEffect(() => {
		if (caret.current === null) return;
		input.current?.setSelectionRange(caret.current, caret.current);
		caret.current = null;
	});

	const change = (text: string, next: DraftAttachments): void => {
		recall.current = null;
		latest.current = { draft: text, attachments: next };
		onDraftChange(text, next);
		setSelected(0);
		setNavigated(false);
	};

	/** A typed edit: whatever lost its marker goes too. */
	const edit = (text: string): void => change(text, prune(text, latest.current.attachments));

	/** Puts `text` at the caret (over the selection). */
	const insert = (text: string, next: DraftAttachments): void => {
		const current = latest.current.draft;
		const start = input.current?.selectionStart ?? current.length;
		const end = input.current?.selectionEnd ?? current.length;
		caret.current = start + text.length;
		change(current.slice(0, start) + text + current.slice(end), next);
	};

	/** Text that goes in as a marker standing for `expansion`. */
	const insertMarker = (marker: (n: number) => string, expansion: string): void => {
		const current = latest.current.attachments;
		const n = nextNumber(current.pastes);
		const label = marker(n);
		insert(`${label} `, { ...current, pastes: [...current.pastes, { n, marker: label, expansion }] });
	};

	/** Images become `[Image #N]` markers, other files `[File #N, name]` markers of their text. */
	const addFiles = async (files: readonly File[]): Promise<void> => {
		setError(null);
		try {
			const read = await Promise.all(files.filter(f => IMAGE_TYPES.includes(f.type)).map(readImage));
			if (read.length > 0) {
				const current = latest.current.attachments;
				const chars = [...current.images, ...read].reduce((sum, i) => sum + i.image.data.length, 0);
				if (chars > MAX_MESSAGE_IMAGE_CHARS)
					throw new Error("Too many or too large images for one message (about 9 MB in total)");
				const first = nextNumber(current.images);
				const added = read.map((image, i) => ({ ...image, n: first + i }));
				insert(added.map(image => `${markerOf(image)} `).join(""), {
					...current,
					images: [...current.images, ...added],
				});
			}
			for (const file of files.filter(f => !IMAGE_TYPES.includes(f.type))) {
				if (file.type.startsWith("image/"))
					throw new Error(`${file.name}: only PNG, JPEG, GIF and WebP images can be sent`);
				const text = await readTextFile(file);
				insertMarker(n => fileMarker(n, file.name), wrapAttachment(text, file.name));
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	/** The user's answer to the large-paste choice (Escape: a marker, as omp does, so nothing pasted is lost). */
	const placePaste = (how: "wrap" | "marker" | "plain"): void => {
		const text = pendingPaste;
		setPendingPaste(null);
		input.current?.focus();
		if (text === null) return;
		if (how === "plain") insert(text, latest.current.attachments);
		else insertMarker(n => pasteMarker(n, text), how === "wrap" ? wrapAttachment(text) : text);
	};

	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
		const files = [...e.clipboardData.items].flatMap(item => {
			const file = item.kind === "file" ? item.getAsFile() : null;
			return file && IMAGE_TYPES.includes(file.type) ? [file] : [];
		});
		// A copied image often comes with a text flavour (its name or URL): the image is what was meant.
		if (files.length > 0) {
			e.preventDefault();
			void addFiles(files);
			return;
		}
		const text = e.clipboardData.getData("text/plain");
		if (isMarkerSized(text)) {
			e.preventDefault();
			setPendingPaste(text);
		}
	};

	const onDrop = (e: DragEvent<HTMLTextAreaElement>): void => {
		const files = [...e.dataTransfer.files];
		if (files.length === 0) return;
		e.preventDefault();
		void addFiles(files);
	};

	/** A slash command goes without the images. */
	const send = async (
		deliver: (message: string, images?: ImageWire[]) => Promise<Ack>,
		text = draft,
	): Promise<void> => {
		const composed = compose(text, attachments);
		const body = composed.message.trim();
		const images = body.startsWith("/") ? [] : composed.images;
		if ((!body && images.length === 0) || disabled) return;
		setError(null);
		const ack = await deliver(body, images.length > 0 ? images : undefined);
		if (!ack.ok) return setError(ack.error ?? "send failed");
		change("", NO_ATTACHMENTS);
	};
	const sendDefault = (): Promise<void> =>
		send(!steering ? onPrompt : effectiveMode === "steer" ? onSteer : onFollowUp);

	const pick = (item: SlashItem): void => {
		if (item.hub && canOpenModels) {
			edit("");
			onOpenModels();
			return;
		}
		edit(item.fill);
		if (item.submit) void send(onPrompt, item.fill);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
		if (pendingPaste !== null && e.key === "Escape") {
			e.preventDefault();
			placePaste("marker");
			return;
		}
		const el = e.currentTarget;
		if (
			(e.key === "Backspace" || e.key === "Delete") &&
			!e.altKey &&
			!e.ctrlKey &&
			!e.metaKey &&
			el.selectionStart === el.selectionEnd
		) {
			const range = markerRange(draft, attachments, el.selectionStart, e.key === "Backspace" ? "back" : "forward");
			if (range) {
				e.preventDefault();
				caret.current = range.start;
				edit(draft.slice(0, range.start) + draft.slice(range.end));
				return;
			}
		}
		if (menuOpen) {
			if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length > 0) {
				e.preventDefault();
				setNavigated(true);
				setSelected((active + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setClosedFor(draft);
				return;
			}
			const enter = shouldSubmitOnEnter(e, composing.current);
			// The models are on their way: the bare model command would only print the current model.
			if (enter && menu.loading) {
				e.preventDefault();
				return;
			}
			const item = matches[active];
			if (item && (e.key === "Tab" || (enter && enterAction(commands, draft, item, navigated) === "pick"))) {
				e.preventDefault();
				pick(item);
				return;
			}
		}
		if (
			!menuOpen &&
			!disabled &&
			!pendingPaste &&
			(e.key === "ArrowUp" || e.key === "ArrowDown") &&
			!e.altKey &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.shiftKey &&
			el.selectionStart === el.selectionEnd
		) {
			// Leave arrows inside a multiline draft to the editor.
			const up = e.key === "ArrowUp";
			const atEdge = up
				? !draft.slice(0, el.selectionStart).includes("\n")
				: !draft.slice(el.selectionEnd).includes("\n");
			if (recall.current?.expected !== draft) recall.current = null;
			const current = recall.current;
			const items = current?.items ?? history;
			if (atEdge && items.length > 0 && (up || current)) {
				e.preventDefault();
				const saved = current?.saved ?? { draft, attachments };
				const index = Math.max(0, Math.min(items.length, (current?.index ?? items.length) + (up ? -1 : 1)));
				const text = index === items.length ? saved.draft : items[index]!;
				caret.current = up ? 0 : text.length;
				change(text, index === items.length ? saved.attachments : NO_ATTACHMENTS);
				recall.current = index === items.length ? null : { items, index, saved, expected: text };
				setClosedFor(text); // A recalled slash prompt must not turn arrows into menu navigation.
				return;
			}
		}
		if (shouldSubmitOnEnter(e, composing.current)) {
			e.preventDefault();
			void sendDefault();
		}
	};

	const pastedLines = pendingPaste?.split("\n").length ?? 0;

	return (
		<div className="composer">
			{error && <div className="form-error">{error}</div>}
			{menuOpen && (
				<ul
					className="slash-menu"
					role="listbox"
					aria-label={menu.stage === "command" ? "Slash commands" : "Arguments"}
				>
					{menu.loading && !modelsError && <li className="slash-item faint">Loading models…</li>}
					{needModels && modelsError && <li className="slash-item form-error">{modelsError}</li>}
					{matches.map((item, i) => (
						<li
							key={item.key}
							role="option"
							aria-selected={i === active}
							className={`slash-item${i === active ? " slash-item--on" : ""}`}
							// Keep focus in the textarea: a click must not blur it before the pick lands.
							onMouseDown={e => e.preventDefault()}
							onClick={() => pick(item)}
						>
							<span className="slash-name">
								{item.label}
								{item.hint && <span className="faint"> {item.hint}</span>}
							</span>
							{item.description && <span className="slash-desc">{item.description}</span>}
						</li>
					))}
				</ul>
			)}
			{pendingPaste !== null && (
				<div className="paste-menu" role="group" aria-label="Large paste">
					<span className="paste-menu-title">
						Pasted {pastedLines} {pastedLines === 1 ? "line" : "lines"}
					</span>
					<button
						type="button"
						className="btn btn--small btn--primary"
						title="Wrap the text in <attachment> tags, collapsed to a [Paste #N] marker"
						onClick={() => placePaste("wrap")}
					>
						Wrapped block
					</button>
					<button
						type="button"
						className="btn btn--small"
						title="Collapse the text to a [Paste #N] marker (Esc)"
						onClick={() => placePaste("marker")}
					>
						Marker
					</button>
					<button
						type="button"
						className="btn btn--small"
						title="Insert the text as it is"
						onClick={() => placePaste("plain")}
					>
						Plain text
					</button>
				</div>
			)}
			{attachments.images.length > 0 && (
				<ul className="composer-images" aria-label="Attached images">
					{attachments.images.map(image => (
						<li key={image.n} className="composer-image" title={markerOf(image)}>
							<img src={`data:${image.image.mimeType};base64,${image.image.data}`} alt={`Image #${image.n}`} />
							<span className="composer-image-n">#{image.n}</span>
							<IconButton
								icon={X}
								small
								danger
								className="composer-image-remove"
								label={`Remove image #${image.n}`}
								onClick={() => edit(removeMarker(draft, markerOf(image)))}
							/>
						</li>
					))}
				</ul>
			)}
			<div className="composer-row">
				<ChipMenu
					label={<Plus size={18} aria-hidden="true" />}
					title="Add photos or files"
					ariaLabel="Add photos or files"
					buttonClass="composer-add"
					placement="up"
					disabled={disabled}
				>
					{close => (
						<div className="chip-list" role="listbox" aria-label="Add">
							<button
								type="button"
								role="option"
								aria-selected={false}
								className="chip-option composer-add-option"
								onClick={() => {
									close();
									photoInput.current?.click();
								}}
							>
								<ImageIcon size={16} aria-hidden="true" /> Photos
							</button>
							<button
								type="button"
								role="option"
								aria-selected={false}
								className="chip-option composer-add-option"
								onClick={() => {
									close();
									fileInput.current?.click();
								}}
							>
								<FileUp size={16} aria-hidden="true" /> Add files
							</button>
						</div>
					)}
				</ChipMenu>
				<input
					ref={photoInput}
					type="file"
					accept={IMAGE_TYPES.join(",")}
					multiple
					hidden
					name="photos"
					onChange={e => {
						void addFiles([...(e.currentTarget.files ?? [])]);
						e.currentTarget.value = "";
					}}
				/>
				<input
					ref={fileInput}
					type="file"
					multiple
					hidden
					name="files"
					onChange={e => {
						void addFiles([...(e.currentTarget.files ?? [])]);
						e.currentTarget.value = "";
					}}
				/>
				<textarea
					ref={input}
					className="composer-input"
					value={draft}
					title="↑ / ↓: prompt history at the first / last line"
					onChange={e => edit(e.target.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					onDrop={onDrop}
					onCompositionStart={() => {
						composing.current = true;
					}}
					onCompositionEnd={() => {
						setTimeout(() => {
							composing.current = false;
						}, 0);
					}}
					placeholder={
						working
							? effectiveMode === "steer"
								? "Steer the running turn…"
								: "Queue a message for after the turn…"
							: `Message ${agentLabel}… (/ for commands)`
					}
					rows={1}
					disabled={disabled}
					name="message"
				/>
				<div className="composer-actions">
					<div className="send-split">
						<button
							type="button"
							className="btn btn--primary"
							onClick={() => void sendDefault()}
							disabled={disabled || message === ""}
							aria-label={sendLabel}
							title={
								!steering
									? undefined
									: effectiveMode === "steer"
										? "Interrupt the running turn with this message"
										: "Send after the running turn finishes"
							}
						>
							{sendLabel === "Queue" ? (
								<ListPlus size={16} aria-hidden="true" />
							) : (
								<SendHorizontal size={16} aria-hidden="true" />
							)}
							<span className="btn-label">{sendLabel}</span>
						</button>
						{canSteer && (
							<button
								type="button"
								className="btn btn--primary send-mode"
								aria-label={mode === "steer" ? "Switch to Queue" : "Switch to Steer"}
								title={
									steering
										? mode === "steer"
											? "Switch to Queue"
											: "Switch to Steer"
										: "Steer or Queue while a turn runs"
								}
								disabled={!steering}
								onClick={() => setMode(mode === "steer" ? "queue" : "steer")}
							>
								<ChevronsUpDown size={14} aria-hidden="true" />
							</button>
						)}
					</div>
					<button
						type="button"
						className="btn btn--danger"
						onClick={onAbort}
						disabled={!working}
						aria-label="Stop"
						title="Abort the running turn"
					>
						<Square size={16} aria-hidden="true" />
						<span className="btn-label">Stop</span>
					</button>
				</div>
			</div>
		</div>
	);
}
