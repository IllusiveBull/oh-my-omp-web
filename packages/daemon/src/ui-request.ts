import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { UiRequest, UiResponseBody, WidgetPlacement } from "@omp-web/protocol";

export type MappedUiRequest =
	| { kind: "request"; request: UiRequest }
	| { kind: "cancel"; targetId: string }
	| { kind: "notify"; level: "info" | "warning" | "error"; message: string }
	| { kind: "status"; key: string; text: string | null }
	| { kind: "widget"; key: string; lines: string[] | null; placement: WidgetPlacement }
	| { kind: "title"; title: string }
	| { kind: "editor_text"; text: string }
	| { kind: "open_url"; url: string; launchUrl?: string; instructions?: string };

/** Bounds on what an extension can make every connected client hold in its session state. */
const MAX_WIDGET_LINES = 100;
const MAX_LINE_CHARS = 2_000;
const MAX_STATUS_CHARS = 500;

function webUrl(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	try {
		const { protocol } = new URL(value);
		return protocol === "https:" || protocol === "http:" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Select markers omp sends from 18.20.0 on; the pinned submodule's `RpcExtensionUIRequest` predates them. */
type RpcSelectRequest = Extract<RpcExtensionUIRequest, { method: "select" }> & {
	initialIndex?: number;
	selectionMarker?: "radio" | "checkbox";
	checkedIndices?: number[];
	markableCount?: number;
};

/**
 * omp `extension_ui_request` -> protocol. The `UiRequest` arms are structurally copied from `RpcExtensionUIRequest`
 * (the web package cannot import coding-agent types); every arm is built field-by-field from the upstream type
 * here, so a renamed or retyped upstream field fails this file's typecheck.
 */
export function mapUiRequest(req: RpcExtensionUIRequest): MappedUiRequest {
	switch (req.method) {
		case "select": {
			const select: RpcSelectRequest = req;
			return {
				kind: "request",
				request: {
					id: select.id,
					method: "select",
					title: select.title,
					options: select.options,
					optionDetails: select.optionDetails,
					initialIndex: select.initialIndex,
					selectionMarker: select.selectionMarker,
					checkedIndices: select.checkedIndices,
					markableCount: select.markableCount,
					timeout: select.timeout,
				},
			};
		}
		case "confirm":
			return {
				kind: "request",
				request: { id: req.id, method: "confirm", title: req.title, message: req.message, timeout: req.timeout },
			};
		case "input":
			return {
				kind: "request",
				request: {
					id: req.id,
					method: "input",
					title: req.title,
					placeholder: req.placeholder,
					secret: req.secret,
					timeout: req.timeout,
				},
			};
		case "editor":
			return {
				kind: "request",
				request: {
					id: req.id,
					method: "editor",
					title: req.title,
					prefill: req.prefill,
					promptStyle: req.promptStyle,
				},
			};
		case "ask":
			return {
				kind: "request",
				request: { id: req.id, method: "ask", questions: req.questions, timeout: req.timeout },
			};
		case "cancel":
			return { kind: "cancel", targetId: req.targetId };
		case "notify":
			return { kind: "notify", level: req.notifyType ?? "info", message: req.message };
		case "setStatus":
			return {
				kind: "status",
				key: req.statusKey,
				text: req.statusText === undefined ? null : req.statusText.slice(0, MAX_STATUS_CHARS),
			};
		case "setWidget":
			return {
				kind: "widget",
				key: req.widgetKey,
				lines:
					req.widgetLines === undefined
						? null
						: req.widgetLines.slice(0, MAX_WIDGET_LINES).map(line => line.slice(0, MAX_LINE_CHARS)),
				placement: req.widgetPlacement ?? "aboveEditor",
			};
		case "setTitle":
			return { kind: "title", title: req.title.slice(0, MAX_STATUS_CHARS) };
		case "set_editor_text":
			return { kind: "editor_text", text: req.text };
		case "open_url": {
			// Only web URLs may ever become a link in a browser: `javascript:`, `file:` and friends are refused here, once.
			const url = webUrl(req.url);
			if (url === undefined) {
				return {
					kind: "notify",
					level: "warning",
					message: `omp asked to open a URL that is not http(s) and was not offered: ${req.url.slice(0, 200)}`,
				};
			}
			return { kind: "open_url", url, launchUrl: webUrl(req.launchUrl), instructions: req.instructions };
		}
	}
}

export function toRpcUiResponse(id: string, body: UiResponseBody): RpcExtensionUIResponse {
	if ("value" in body) return { type: "extension_ui_response", id, value: body.value };
	if ("confirmed" in body) return { type: "extension_ui_response", id, confirmed: body.confirmed };
	if ("answers" in body) return { type: "extension_ui_response", id, answers: body.answers };
	return { type: "extension_ui_response", id, cancelled: true };
}
