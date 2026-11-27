import { Check, Copy, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { copyText } from "../../lib/accounts";
import { IconButton } from "../ui/icon-button";

/** Copies `text` to the clipboard; says so (or that it could not, e.g. outside a secure context). */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }): ReactNode {
	const [state, setState] = useState<"copied" | "failed" | null>(null);
	return (
		<IconButton
			icon={state === "copied" ? Check : state === "failed" ? X : Copy}
			label={state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
			onClick={() => {
				copyText(text).then(
					() => setState("copied"),
					() => setState("failed"),
				);
			}}
		/>
	);
}

/** A command to run on the gateway machine: selectable, one line, with a copy button. */
export function CommandLine({ command }: { command: string }): ReactNode {
	return (
		<div className="acct-command">
			<code>{command}</code>
			<CopyButton text={command} />
		</div>
	);
}
