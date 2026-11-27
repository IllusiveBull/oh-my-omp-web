import "./dom-shim";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { useState } from "react";
import { Composer } from "../src/components/composer";
import { type DraftAttachments, NO_ATTACHMENTS } from "../src/lib/draft-attachments";
import { type FakeDom, installFakeDom, makeEvent } from "./fake-dom";

let dom: FakeDom;
beforeAll(async () => {
	dom = await installFakeDom();
});
afterAll(() => dom.uninstall());
const initialAttachments: DraftAttachments = {
	images: [],
	pastes: [{ n: 1, marker: "[Paste #1]", expansion: "unsent pasted content" }],
};

test("recalls prompts in order, respects multiline editing, and restores the draft with its attachments", async () => {
	let currentAttachments = initialAttachments;
	function Editor() {
		const [draft, setDraft] = useState("unsent [Paste #1]");
		const [attachments, setAttachments] = useState(initialAttachments);
		return (
			<Composer
				working={false}
				disabled={false}
				draft={draft}
				attachments={attachments}
				history={["old prompt", "new prompt\nsecond line"]}
				commands={[]}
				loadModels={async () => []}
				onOpenModels={() => {}}
				onDraftChange={(text, next = NO_ATTACHMENTS) => {
					setDraft(text);
					setAttachments(next);
					currentAttachments = next;
				}}
				onPrompt={async () => ({ ok: true })}
				onSteer={async () => ({ ok: true })}
				onFollowUp={async () => ({ ok: true })}
				onAbort={() => {}}
			/>
		);
	}
	const view = await dom.mount(<Editor />);
	expect(view.query(".composer-input")?.getAttribute("title")).toBeNull();
	const input = Object.assign(view.query(".composer-input")!, {
		selectionStart: 0,
		selectionEnd: 0,
		setSelectionRange(start: number, end: number) {
			this.selectionStart = start;
			this.selectionEnd = end;
		},
	});
	const press = async (key: string, position = input.selectionStart, extra = {}) => {
		input.setSelectionRange(position, position);
		const event = Object.assign(makeEvent("keydown"), { key, keyCode: 0, ...extra });
		await view.act(() => {
			input.dispatchEvent(event);
		});
		return event.defaultPrevented;
	};
	expect(await press("ArrowUp", 0, { isComposing: true })).toBe(false);
	expect(input.value).toBe("unsent [Paste #1]");
	expect(await press("ArrowUp", 0, { ctrlKey: true })).toBe(false);
	await press("ArrowUp");
	expect(input.value).toBe("new prompt\nsecond line");
	expect(currentAttachments).toBe(NO_ATTACHMENTS);
	expect(await press("ArrowUp", input.value.length)).toBe(false);
	await press("ArrowUp", 0);
	expect(input.value).toBe("old prompt");
	await press("ArrowUp", 0);
	expect(input.value).toBe("old prompt");
	await press("ArrowDown");
	expect(input.value).toBe("new prompt\nsecond line");
	await press("ArrowDown", input.value.length);
	expect(input.value).toBe("unsent [Paste #1]");
	expect(currentAttachments).toBe(initialAttachments);
	expect(await press("ArrowDown", input.value.length)).toBe(false);

	await view.type(".composer-input", "edited draft");
	await press("ArrowUp", 0);
	await press("ArrowDown", input.value.length);
	expect(input.value).toBe("edited draft");
	await view.unmount();
});
