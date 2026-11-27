import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Ack, type GatewaySessionInfo, HISTORY_MERGE_DEBOUNCE_MS } from "@omp-web/protocol";
import { SessionList } from "../src/components/session-list";
import { searchSessions } from "../src/lib/session-search";
import { type ClientRequest, DaemonClient } from "../src/store/daemon-client";
import { type FakeDom, installFakeDom, type Mounted } from "./fake-dom";
import { gatewaySession, machineSummary } from "./fixtures";

const ids = (sessions: readonly GatewaySessionInfo[]): string[] => sessions.map(s => s.id);

describe("searchSessions (the browser's own ranking of the list)", () => {
	const sessions = [
		gatewaySession({ id: "old", title: "Parser rewrite plan", modifiedAt: 1 }),
		gatewaySession({ id: "mid", title: "Notes", preview: "rewrite the parser tests", modifiedAt: 2 }),
		gatewaySession({ id: "exact", title: "parser rewrite", modifiedAt: 0 }),
		gatewaySession({ id: "new", title: "Other", cwd: "/src/parser-rewrite", modifiedAt: 3 }),
		gatewaySession({ id: "none", title: "Unrelated", modifiedAt: 4 }),
	];

	test("every token must match; exact titles lead partial titles, then other literal matches, newest first", () => {
		expect(ids(searchSessions(sessions, "parser rewrite"))).toEqual(["exact", "old", "new", "mid"]);
		expect(ids(searchSessions(sessions, "  PARSER   rewrite "))).toEqual(["exact", "old", "new", "mid"]);
		expect(ids(searchSessions(sessions, "parser unrelated"))).toEqual([]);
		expect(ids(searchSessions(sessions, "  "))).toEqual(ids(sessions));
	});

	test("matches the model, directory and file too", () => {
		const listed = [
			gatewaySession({ id: "a", model: "anthropic/claude-opus" }),
			gatewaySession({ id: "b", file: "/store/2026-11-01_b.jsonl" }),
		];
		expect(ids(searchSessions(listed, "opus"))).toEqual(["a"]);
		expect(ids(searchSessions(listed, "2026-11-01"))).toEqual(["b"]);
		expect(ids(searchSessions(listed, "/work/app"))).toEqual(["a", "b"]);
	});

	test("the daemon's matches lead in its order (any id of a session names it), then the browser's own, without duplicates", () => {
		const listed = [
			gatewaySession({ id: "a", title: "alpha-note", modifiedAt: 3 }),
			gatewaySession({ id: "b", title: "other", modifiedAt: 2, aliases: ["b-old"] }),
			gatewaySession({ id: "c", title: "other too", modifiedAt: 1 }),
		];
		// "b" matched the transcript; "gone" names no listed session; "a" also matches by title.
		expect(ids(searchSessions(listed, "alpha", ["gone", "b-old", "a"]))).toEqual(["b", "a"]);
		expect(ids(searchSessions(listed, "alpha", []))).toEqual(["a"]);
		expect(ids(searchSessions(listed, "alpha"))).toEqual(["a"]);
	});
});

describe("SessionList search", () => {
	class SearchClient extends DaemonClient {
		requests: { machine: string; request: ClientRequest }[] = [];
		replies = new Map<string, (ack: Ack) => void>();
		override request(machine: string, request: ClientRequest): Promise<Ack> {
			this.requests.push({ machine, request });
			if (request.t !== "sessions.search") return Promise.resolve({ t: "ack", reqId: "", ok: true });
			const { promise, resolve } = Promise.withResolvers<Ack>();
			this.replies.set(request.query, resolve);
			return promise;
		}
		searches(): string[] {
			return this.requests.flatMap(r => (r.request.t === "sessions.search" ? [r.request.query] : []));
		}
	}
	const found = (matches: string[]): Ack => ({ t: "ack", reqId: "", ok: true, data: { matches } });

	let dom: FakeDom;
	beforeAll(async () => {
		dom = await installFakeDom();
		Object.assign(dom.document.documentElement, { dataset: {} });
	});
	afterAll(() => dom.uninstall());

	const mount = async (client: SearchClient, online = true): Promise<Mounted> => {
		const view = await dom.mount(
			<SessionList
				client={client}
				machines={[machineSummary({ id: "home", name: "Home", online })]}
				sessions={{
					home: [
						gatewaySession({ id: "s1", title: "One" }),
						gatewaySession({ id: "s2", title: "Two" }),
						gatewaySession({ id: "s3", title: "Zebra crossing", modifiedAt: 5 }),
					],
				}}
				selection={{ machine: "home", project: "", worktree: "" }}
				selected={null}
				onSelection={() => {}}
				onSelect={() => {}}
				accounts={{ open: false, attention: "off", onToggle: () => {} }}
				onOpenHandoff={() => {}}
			/>,
		);
		// The filter field opens from the Sessions header.
		await view.click(".side-search-toggle");
		return view;
	};
	const shown = (view: Mounted): string[] => view.queryAll(".side-item").map(el => el.getAttribute("data-session")!);
	const typeAndWait = async (view: Mounted, text: string): Promise<void> => {
		await view.type("input[name=filter]", text);
		await view.act(() => Bun.sleep(HISTORY_MERGE_DEBOUNCE_MS + 60));
	};

	test("lists what the daemon found in transcripts and prompt history once typing pauses", async () => {
		const client = new SearchClient("ws://x/ws");
		const view = await mount(client);
		await view.type("input[name=filter]", "qzv");
		expect(shown(view)).toEqual([]); // nothing in the list matches, and no request is sent per keystroke
		expect(client.searches()).toEqual([]);
		await view.act(() => Bun.sleep(HISTORY_MERGE_DEBOUNCE_MS + 60));
		expect(client.searches()).toEqual(["qzv"]);
		await view.act(() => client.replies.get("qzv")!(found(["s2"])));
		await view.until(() => shown(view).length === 1);
		expect(shown(view)).toEqual(["s2"]);
		await view.unmount();
	});

	test("a reply to an older query is dropped", async () => {
		const client = new SearchClient("ws://x/ws");
		const view = await mount(client);
		await typeAndWait(view, "qz");
		await typeAndWait(view, "qzv");
		expect(client.searches()).toEqual(["qz", "qzv"]);
		await view.act(() => client.replies.get("qzv")!(found(["s1"])));
		await view.until(() => shown(view).length === 1);
		await view.act(() => client.replies.get("qz")!(found(["s2"])));
		expect(shown(view)).toEqual(["s1"]);
		// the answer to "qzv" is not shown for the next query either
		await view.type("input[name=filter]", "qzvq");
		expect(shown(view)).toEqual([]);
		await view.unmount();
	});

	test("says so, instead of silently narrowing the search, when the daemon predates session search", async () => {
		const client = new SearchClient("ws://x/ws");
		const view = await mount(client);
		await typeAndWait(view, "zebra");
		await view.act(() =>
			client.replies.get("zebra")!({
				t: "ack",
				reqId: "",
				ok: false,
				error: "unknown message type: sessions.search",
			}),
		);
		await view.until(() => view.query("[data-testid=search-note]") !== null);
		expect(view.query("[data-testid=search-note]")!.textContent).toContain("does not support history search");
		expect(shown(view)).toEqual(["s3"]); // the list's own fields still match
		await view.unmount();
	});

	test("an offline machine is searched in the cached list only, without asking the daemon", async () => {
		const client = new SearchClient("ws://x/ws");
		const view = await mount(client, false);
		await typeAndWait(view, "zebra");
		expect(client.searches()).toEqual([]);
		expect(shown(view)).toEqual(["s3"]);
		await view.unmount();
	});
});
