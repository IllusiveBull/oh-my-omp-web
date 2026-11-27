import type { AskQuestion, UiRequest, UiResponseBody } from "@omp-web/protocol";
import { type ReactNode, useState } from "react";

interface Props {
	request: UiRequest;
	onRespond(response: UiResponseBody): void;
}

/** Answers one omp `extension_ui_request` (select, confirm, input, editor, ask). */
export function UiRequestDialog({ request, onRespond }: Props): ReactNode {
	const cancel = (): void => onRespond({ cancelled: true });
	return (
		<div className="uireq" role="dialog" aria-label="omp is asking">
			{request.method === "select" && <SelectRequest request={request} onRespond={onRespond} />}
			{request.method === "confirm" && (
				<>
					<div className="uireq-title">{request.title}</div>
					<div className="uireq-body">{request.message}</div>
					<div className="uireq-options">
						<button type="button" className="btn btn--primary" onClick={() => onRespond({ confirmed: true })}>
							Yes
						</button>
						<button type="button" className="btn" onClick={() => onRespond({ confirmed: false })}>
							No
						</button>
					</div>
				</>
			)}
			{(request.method === "input" || request.method === "editor") && (
				<TextRequest request={request} onRespond={onRespond} />
			)}
			{request.method === "ask" && <AskRequest questions={request.questions} onRespond={onRespond} />}
			<div className="uireq-foot">
				<button type="button" className="btn btn--ghost" onClick={cancel}>
					Cancel
				</button>
			</div>
		</div>
	);
}

/**
 * A select. Without a marker every option is a button that answers at once. The ask tool's radio prompt gets radio
 * rows and a Submit; its checkbox prompt is a loop (each toggle is one answer, omp re-asks with the new
 * `checkedIndices`), so a toggle shows at once and locks the rows until the next prompt replaces this one.
 */
function SelectRequest({
	request,
	onRespond,
}: {
	request: Extract<UiRequest, { method: "select" }>;
	onRespond(response: UiResponseBody): void;
}): ReactNode {
	const { options, selectionMarker: marker } = request;
	const markable = marker ? Math.min(request.markableCount ?? options.length, options.length) : 0;
	const checked = new Set(request.checkedIndices);
	const initial = request.initialIndex;
	const [picked, setPicked] = useState(
		marker === "radio" && initial !== undefined && initial >= 0 && initial < markable ? initial : undefined,
	);
	const [toggled, setToggled] = useState<number>();
	const descriptions = options.map((_, i) => request.optionDetails?.[i]?.description);
	return (
		<>
			<div className="uireq-title">{request.title}</div>
			{markable > 0 && (
				<div className="uireq-q" role={marker === "radio" ? "radiogroup" : "group"} aria-label={request.title}>
					{options.slice(0, markable).map((option, i) => (
						<label key={option} className="uireq-opt">
							<input
								type={marker}
								name={request.id}
								checked={marker === "radio" ? picked === i : checked.has(i) !== (toggled === i)}
								disabled={toggled !== undefined}
								onChange={() => {
									if (marker === "radio") return setPicked(i);
									setToggled(i);
									onRespond({ value: option });
								}}
							/>
							{option}
							{descriptions[i] && <span className="faint"> — {descriptions[i]}</span>}
						</label>
					))}
				</div>
			)}
			<div className="uireq-options">
				{marker === "radio" && (
					<button
						type="button"
						className="btn btn--primary"
						disabled={picked === undefined}
						onClick={() => picked !== undefined && onRespond({ value: options[picked]! })}
					>
						Submit
					</button>
				)}
				{options.slice(markable).map((option, j) => (
					<button
						key={option}
						type="button"
						className={marker === "checkbox" ? "btn btn--primary" : "btn"}
						disabled={toggled !== undefined}
						onClick={() => onRespond({ value: option })}
					>
						{option}
						{descriptions[markable + j] && <span className="faint"> — {descriptions[markable + j]}</span>}
					</button>
				))}
			</div>
		</>
	);
}

function TextRequest({
	request,
	onRespond,
}: {
	request: Extract<UiRequest, { method: "input" | "editor" }>;
	onRespond(response: UiResponseBody): void;
}): ReactNode {
	const [text, setText] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
	return (
		<>
			<div className="uireq-title">{request.title}</div>
			{request.method === "editor" ? (
				<textarea
					className="composer-input"
					rows={6}
					value={text}
					onChange={e => setText(e.target.value)}
					name="editor"
				/>
			) : (
				<input
					className="uireq-input"
					type={request.secret ? "password" : "text"}
					value={text}
					placeholder={request.placeholder}
					onChange={e => setText(e.target.value)}
					name="input"
				/>
			)}
			<div className="uireq-options">
				<button type="button" className="btn btn--primary" onClick={() => onRespond({ value: text })}>
					Submit
				</button>
			</div>
		</>
	);
}

interface Answer {
	selected: string[];
	custom: string;
}

function AskRequest({
	questions,
	onRespond,
}: {
	questions: AskQuestion[];
	onRespond(response: UiResponseBody): void;
}): ReactNode {
	const [answers, setAnswers] = useState<Record<string, Answer>>({});
	const get = (id: string): Answer => answers[id] ?? { selected: [], custom: "" };
	const toggle = (q: AskQuestion, label: string): void => {
		const cur = get(q.id);
		const selected = q.multi
			? cur.selected.includes(label)
				? cur.selected.filter(l => l !== label)
				: [...cur.selected, label]
			: [label];
		setAnswers({ ...answers, [q.id]: { ...cur, selected } });
	};
	const complete = questions.every(q => get(q.id).selected.length > 0 || get(q.id).custom.trim() !== "");
	return (
		<>
			{questions.map(q => (
				<fieldset key={q.id} className="uireq-q">
					<legend>{q.header ? `${q.header}: ${q.question}` : q.question}</legend>
					{q.options.map((o, i) => (
						<label key={o.label} className="uireq-opt">
							<input
								type={q.multi ? "checkbox" : "radio"}
								name={q.id}
								checked={get(q.id).selected.includes(o.label)}
								onChange={() => toggle(q, o.label)}
							/>
							{o.label}
							{q.recommended === i && <span className="chip">recommended</span>}
							{o.description && <span className="faint"> — {o.description}</span>}
						</label>
					))}
					<input
						className="uireq-input"
						placeholder="Other…"
						value={get(q.id).custom}
						onChange={e => setAnswers({ ...answers, [q.id]: { ...get(q.id), custom: e.target.value } })}
						name={`${q.id}-other`}
					/>
				</fieldset>
			))}
			<div className="uireq-options">
				<button
					type="button"
					className="btn btn--primary"
					disabled={!complete}
					onClick={() =>
						onRespond({
							answers: questions.map(q => {
								const a = get(q.id);
								return {
									id: q.id,
									selectedOptions: a.selected,
									...(a.custom.trim() ? { customInput: a.custom.trim() } : {}),
								};
							}),
						})
					}
				>
					Submit
				</button>
			</div>
		</>
	);
}
