import {
	type ChoiceField,
	type FormBlock,
	type FormField,
	type FormSpan,
	type HtmlForm,
	parseHtmlForm,
	type TextField,
} from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import type { FormValue, UiResponseBody } from "@omp-web/protocol";
import { type ReactNode, useMemo, useState } from "react";

/** What the human has entered in one field: a choice's checked options and "Other" answer, or a text field's text. */
type FieldState = { checked: ReadonlySet<number>; otherOn: boolean; other: string } | { text: string };

/** Input types rendered as themselves; anything else is a plain text input (`range` has no visible value, so a number). */
const INPUT_TYPES: Record<string, string> = {
	text: "text",
	email: "email",
	url: "url",
	number: "number",
	range: "number",
	tel: "tel",
	password: "password",
	search: "search",
	date: "date",
	time: "time",
	"datetime-local": "datetime-local",
	month: "month",
	week: "week",
};

function initialState(field: FormField): FieldState {
	if (field.kind === "text") return { text: field.value };
	const checked = new Set(field.options.flatMap((option, index) => (option.checked ? [index] : [])));
	return { checked, otherOn: false, other: "" };
}

/**
 * The value a field submits, and why omp would reject it, as `@oh-my-pi/pi-coding-agent/tools/html-form/data`
 * (`choiceValue`, `textValue`, `fieldError`) computes them; that module type-imports `@oh-my-pi/pi-ai`, which the web
 * bundle does not carry. Keep in step with it: omp validates the reply with the same rules and fails the whole `ask`
 * call on a mismatch.
 */
function valueOf(field: FormField, state: FieldState): FormValue | undefined {
	if (field.kind === "text") {
		const text = "text" in state ? state.text : "";
		const number = Number(text);
		return (field.type === "number" || field.type === "range") && text.trim() !== "" && Number.isFinite(number)
			? number
			: text;
	}
	if ("text" in state) return undefined;
	const typed = field.other && state.otherOn ? state.other.trim() : undefined;
	const values = field.options.flatMap((option, index) =>
		state.checked.has(index) && !option.disabled ? [option.value] : [],
	);
	if (field.multi && field.options.length > 1) return typed ? [...values, typed] : values;
	return typed || values[0];
}

function fieldError(field: FormField, value: FormValue | undefined): string | undefined {
	if (field.kind === "choice") {
		const empty = value === undefined || (Array.isArray(value) && value.length === 0);
		if (!field.required || !empty) return undefined;
		return field.multi && field.options.length > 1 ? "Select at least one" : "Required";
	}
	const text = value === undefined ? "" : String(value);
	if (text.trim() === "") return field.required ? "Required" : undefined;
	if (field.type === "number" || field.type === "range") {
		const number = Number(text);
		if (!Number.isFinite(number)) return "Enter a number";
		if (field.min !== undefined && number < field.min) return `Must be at least ${field.min}`;
		if (field.max !== undefined && number > field.max) return `Must be at most ${field.max}`;
	}
	if (field.minLength !== undefined && text.length < field.minLength)
		return `Needs at least ${field.minLength} characters`;
	if (field.maxLength !== undefined && text.length > field.maxLength) return `At most ${field.maxLength} characters`;
	if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "Enter an email address";
	if (field.type === "url" && !URL.canParse(text)) return "Enter a full URL";
	if (field.pattern) {
		let pattern: RegExp | undefined;
		try {
			pattern = new RegExp(`^(?:${field.pattern})$`, "v");
		} catch {
			// omp ignores a pattern the model wrote wrong
		}
		if (pattern?.test(text) === false) return `Must match ${field.pattern}`;
	}
	return undefined;
}

/**
 * omp's `form` dialog (the `ask` tool): the HTML `<form>` parsed with omp's own parser, so the fields, "Other" answers
 * and constraints match what omp validates the reply against. Nothing of the model's markup reaches the DOM as HTML.
 */
export function FormRequest({
	html,
	onRespond,
}: {
	html: string;
	onRespond(response: UiResponseBody): void;
}): ReactNode {
	const parsed = useMemo((): HtmlForm | Error => {
		try {
			return parseHtmlForm(html);
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
	}, [html]);
	if (parsed instanceof Error) return <div className="uireq-body">This form could not be read: {parsed.message}</div>;
	return <ParsedForm form={parsed} onRespond={onRespond} />;
}

function ParsedForm({ form, onRespond }: { form: HtmlForm; onRespond(response: UiResponseBody): void }): ReactNode {
	const [states, setStates] = useState<FieldState[]>(() => form.fields.map(initialState));
	const [tried, setTried] = useState(false);
	const indexOf = useMemo(() => new Map(form.fields.map((field, index) => [field, index])), [form]);

	const errors = form.fields.map((field, index) =>
		field.name ? fieldError(field, valueOf(field, states[index]!)) : undefined,
	);
	const submit = (): void => {
		if (errors.some(error => error !== undefined)) {
			setTried(true);
			return;
		}
		// Hidden inputs first: a named field of the same name takes precedence, as omp resolves it.
		const data: Record<string, FormValue> = Object.create(null);
		for (const [name, value] of form.hidden) data[name] = value;
		form.fields.forEach((field, index) => {
			if (!field.name) return;
			const value = valueOf(field, states[index]!);
			if (value !== undefined) data[field.name] = value;
		});
		onRespond({ data });
	};

	const renderBlock = (block: FormBlock, key: number): ReactNode => {
		if (block.kind !== "field") return <ContextBlock key={key} block={block} />;
		const index = indexOf.get(block.field)!;
		return (
			<FieldView
				key={key}
				field={block.field}
				state={states[index]!}
				error={tried ? errors[index] : undefined}
				onChange={state => setStates(prev => prev.with(index, state))}
			/>
		);
	};

	return (
		<>
			<div className="uireq-form">
				{form.sections.map((section, s) =>
					section.fieldset ? (
						<fieldset key={s} className="uireq-q">
							{section.title.length > 0 && (
								<legend>
									<Spans spans={section.title} />
								</legend>
							)}
							{section.blocks.map(renderBlock)}
						</fieldset>
					) : (
						<div key={s} className="uireq-section">
							{section.blocks.map(renderBlock)}
						</div>
					),
				)}
			</div>
			<div className="uireq-options">
				<button type="button" className="btn btn--primary" onClick={submit}>
					Submit
				</button>
			</div>
		</>
	);
}

function Spans({ spans }: { spans: readonly FormSpan[] }): ReactNode {
	return spans.map((span, i) => {
		if (span.style === "code") return <code key={i}>{span.text}</code>;
		if (span.style === "strong") return <strong key={i}>{span.text}</strong>;
		if (span.style === "em") return <em key={i}>{span.text}</em>;
		return span.text;
	});
}

function ContextBlock({ block }: { block: Exclude<FormBlock, { kind: "field" }> }): ReactNode {
	switch (block.kind) {
		case "text":
			return (
				<div className={block.heading ? "uireq-text uireq-title" : "uireq-text"}>
					<Spans spans={block.spans} />
				</div>
			);
		case "list": {
			const items = block.items.map((item, i) => (
				<li key={i}>
					<Spans spans={item} />
				</li>
			));
			return block.ordered ? <ol className="uireq-text">{items}</ol> : <ul className="uireq-text">{items}</ul>;
		}
		case "pre":
			return <pre className="uireq-pre">{block.text}</pre>;
		case "table":
			return (
				<table className="uireq-table">
					<tbody>
						{block.rows.map((row, r) => (
							<tr key={r}>
								{row.map((cell, c) =>
									r < block.headerRows ? (
										<th key={c}>
											<Spans spans={cell} />
										</th>
									) : (
										<td key={c}>
											<Spans spans={cell} />
										</td>
									),
								)}
							</tr>
						))}
					</tbody>
				</table>
			);
		case "image":
			// Only web and inline sources load in the browser; a local path of the agent's machine shows its alt text.
			return /^(https?:|data:image\/)/i.test(block.src) ? (
				<img className="uireq-img" src={block.src} alt={block.alt} />
			) : (
				<div className="faint">[image{block.alt ? `: ${block.alt}` : ""}]</div>
			);
		case "svg":
			// As an <img>, the markup cannot run scripts or reach the page.
			return (
				<img
					className="uireq-img"
					src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(block.markup)}`}
					alt={block.alt}
				/>
			);
	}
}

function FieldView({
	field,
	state,
	error,
	onChange,
}: {
	field: FormField;
	state: FieldState;
	error: string | undefined;
	onChange(state: FieldState): void;
}): ReactNode {
	return (
		<div className="uireq-field">
			{field.kind === "text" ? (
				<TextFieldView field={field} text={"text" in state ? state.text : ""} onChange={onChange} />
			) : (
				"checked" in state && <ChoiceFieldView field={field} state={state} onChange={onChange} />
			)}
			{error && <div className="uireq-error">{error}</div>}
		</div>
	);
}

function TextFieldView({
	field,
	text,
	onChange,
}: {
	field: TextField;
	text: string;
	onChange(state: FieldState): void;
}): ReactNode {
	const common = {
		className: "uireq-input",
		name: field.name,
		value: text,
		placeholder: field.placeholder || undefined,
		required: field.required,
		minLength: field.minLength,
		maxLength: field.maxLength,
	};
	return (
		<label className="uireq-text-field">
			{field.label.length > 0 && (
				<span className="uireq-text">
					<Spans spans={field.label} />
				</span>
			)}
			{field.multiline ? (
				<textarea {...common} rows={Math.max(field.rows, 2)} onChange={e => onChange({ text: e.target.value })} />
			) : (
				<input
					{...common}
					type={INPUT_TYPES[field.type] ?? "text"}
					min={field.min}
					max={field.max}
					pattern={field.pattern}
					onChange={e => onChange({ text: e.target.value })}
				/>
			)}
		</label>
	);
}

function ChoiceFieldView({
	field,
	state,
	onChange,
}: {
	field: ChoiceField;
	state: { checked: ReadonlySet<number>; otherOn: boolean; other: string };
	onChange(state: FieldState): void;
}): ReactNode {
	const label = field.label.length > 0 && (
		<span className="uireq-text">
			<Spans spans={field.label} />
		</span>
	);
	// A single <select>: one dropdown, with an empty choice when nothing is preselected.
	if (field.select && !field.multi) {
		const current = [...state.checked][0];
		return (
			<label className="uireq-text-field">
				{label}
				<select
					className="uireq-input"
					name={field.name}
					value={current === undefined ? "" : String(current)}
					onChange={e =>
						onChange({ ...state, checked: new Set(e.target.value === "" ? [] : [Number(e.target.value)]) })
					}
				>
					{current === undefined && <option value="">—</option>}
					{field.options.map((option, index) => (
						<option key={index} value={String(index)} disabled={option.disabled}>
							{option.label.map(span => span.text).join("")}
						</option>
					))}
				</select>
			</label>
		);
	}
	// A lone checkbox is a toggle, never an array; radios and checkbox groups get rows.
	const multi = field.multi;
	const toggle = (index: number): void => {
		if (!multi) return onChange({ ...state, checked: new Set([index]), otherOn: false });
		const checked = new Set(state.checked);
		if (checked.has(index)) checked.delete(index);
		else checked.add(index);
		onChange({ ...state, checked });
	};
	const inputType = multi ? "checkbox" : "radio";
	const groupName = `form-${field.name}`;
	return (
		<div className="uireq-choice" role="group">
			{label}
			{field.options.map((option, index) => (
				<label key={index} className="uireq-opt">
					<input
						type={inputType}
						name={groupName}
						checked={state.checked.has(index)}
						disabled={option.disabled}
						onChange={() => toggle(index)}
					/>
					<span>
						<Spans spans={option.label} />
					</span>
				</label>
			))}
			{field.other && (
				<label className="uireq-opt uireq-other">
					<input
						type={inputType}
						name={groupName}
						checked={state.otherOn}
						onChange={() =>
							onChange(
								multi ? { ...state, otherOn: !state.otherOn } : { ...state, checked: new Set(), otherOn: true },
							)
						}
					/>
					<input
						className="uireq-input"
						placeholder="Other…"
						value={state.other}
						onChange={e =>
							onChange({
								...state,
								other: e.target.value,
								otherOn: e.target.value.trim() !== "",
								checked: multi || e.target.value.trim() === "" ? state.checked : new Set(),
							})
						}
					/>
				</label>
			)}
		</div>
	);
}
