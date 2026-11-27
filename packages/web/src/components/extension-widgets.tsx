import type { WidgetPlacement, WidgetWire } from "@omp-web/protocol";
import type { ReactNode } from "react";
import { stripAnsi } from "../lib/ansi";

interface Props {
	widgets: ReadonlyMap<string, WidgetWire>;
	placement: WidgetPlacement;
}

/** Extension `setWidget` blocks of one placement, one preformatted block per key. Terminal styling (ANSI) is dropped. */
export function ExtensionWidgets({ widgets, placement }: Props): ReactNode {
	const blocks = [...widgets].filter(([, widget]) => widget.placement === placement);
	if (blocks.length === 0) return null;
	return (
		<div className="ext-widgets">
			{blocks.map(([key, widget]) => (
				<pre key={key} className="ext-widget" title={key}>
					{widget.lines.map(stripAnsi).join("\n")}
				</pre>
			))}
		</div>
	);
}
