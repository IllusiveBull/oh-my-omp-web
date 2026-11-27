/**
 * Contract between the daemon's protocol stream and upstream collab-web's <Transcript>.
 *
 * `turn-frames.json` is what the daemon produces for a real recorded omp turn (daemon/test/session.test.ts regenerates and
 * compares it). Here it is replayed through the browser-side store and rendered with upstream's own components, so an
 * upstream rename of Transcript props / tool-render behaviour, or a protocol change that breaks the fold, fails this test.
 */
import "./dom-shim";
import { describe, expect, test } from "bun:test";
import { Transcript } from "@oh-my-pi/collab-web/src/components/transcript/Transcript";
import { ToolView } from "@oh-my-pi/collab-web/src/tool-render/ToolView";
import type { SequencedEvent, SessionSnapshot } from "@omp-web/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionStore, type SessionState } from "../src/store/session-store";

interface Golden {
	headSeq: number;
	events: SequencedEvent[];
	snapshot: SessionSnapshot;
}
const golden: Golden = await Bun.file(new URL("../../protocol/test/fixtures/turn-frames.json", import.meta.url)).json();

const render = (state: SessionState): string =>
	renderToStaticMarkup(
		<Transcript
			entries={state.view.entries}
			stream={state.view.stream}
			streamDone={state.view.streamDone}
			activeTools={state.view.activeTools}
			working={state.view.working}
			phase="live"
		/>,
	);
const count = (html: string, needle: string): number => html.split(needle).length - 1;
const instant = (cb: () => void): (() => void) => {
	cb();
	return () => {};
};

describe("recorded turn -> store -> upstream <Transcript>", () => {
	test("replaying the protocol stream renders the turn: user, tool card, answer", () => {
		const store = new SessionStore("s", instant, () => 0);
		let midTool = "";
		let midStream = "";
		for (const e of golden.events) {
			store.applyEvents([e]);
			const ev = e.ev;
			if (ev.k === "agent" && ev.event.type === "tool_execution_start") midTool = render(store.getSnapshot());
			if (ev.k === "agent" && ev.event.type === "message_update" && midStream === "")
				midStream = render(store.getSnapshot());
		}
		const html = render(store.getSnapshot());

		expect(midStream).toContain("tr-row--assistant"); // streaming ghost visible before message_end
		expect(count(midTool, 'aria-label="running"')).toBe(1); // running tool shows a spinner exactly once
		expect(midTool).toContain('class="tv-name">read<');
		expect(count(html, 'class="tv-card')).toBe(1); // one card: the call is not duplicated by ghost + entry
		expect(html).not.toContain('aria-label="running"');
		expect(html).toContain("tv-status--ok");
		expect(html).toContain("tr-row--user");
		expect(count(html, "tr-row--assistant")).toBe(2);
		expect(html).not.toContain("thinking…");
		expect(html).toContain("tr-row--marker"); // model_change / thinking_level_change entries from get_entries
	});

	test("a client that joins late via snapshot renders exactly what a live one rendered", () => {
		const live = new SessionStore("s", instant, () => 0);
		live.applyEvents(golden.events);
		const late = new SessionStore("s", instant, () => 0);
		late.applySnapshot(golden.headSeq, "epoch-1", golden.snapshot);
		expect(render(late.getSnapshot())).toBe(render(live.getSnapshot()));
		expect(late.lastSeq).toBe(live.lastSeq);
	});

	test("expanded tool card renders the file body from the committed toolResult entry", () => {
		const entries = golden.snapshot.entries;
		const call = entries
			.flatMap(e => (e.type === "message" && e.message.role === "assistant" ? e.message.content : []))
			.find(b => b.type === "toolCall");
		const result = entries.flatMap(e =>
			e.type === "message" && e.message.role === "toolResult" ? [e.message] : [],
		)[0];
		if (call?.type !== "toolCall" || !result) throw new Error("fixture has no tool call");
		const html = renderToStaticMarkup(
			<ToolView name={call.name} args={call.arguments} result={result} defaultOpen />,
		);
		expect(html).toContain("tv-body");
		expect(html).toContain("demo-app"); // contents of the project's package.json
	});
});
