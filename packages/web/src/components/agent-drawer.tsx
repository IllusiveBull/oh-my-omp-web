import { Transcript, type TranscriptProps } from "@oh-my-pi/collab-web/src/components/transcript/Transcript";
import type { SubagentTranscript, SubagentWire } from "@omp-web/protocol";
import { X } from "lucide-react";
import {
	type ReactNode,
	type UIEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { AgentTranscriptPoller, NO_TRANSCRIPT, type TranscriptState } from "../lib/agent-transcript-poller";
import { presentEntries } from "../lib/custom-messages";
import { agentRunMs } from "../lib/subagents";
import { formatElapsed } from "../lib/time";
import { useNow } from "../lib/use-now";
import type { DaemonClient } from "../store/daemon-client";
import { useTranscriptTail } from "./transcript-follow";
import { useTranscriptTimes } from "./transcript-times";
import { IconButton } from "./ui/icon-button";

const EMPTY_TOOLS: TranscriptProps["activeTools"] = new Map();
/** Within this distance of the top of the transcript, the page before it is read. */
const EARLIER_TRIGGER_PX = 80;

interface Props {
	client: DaemonClient;
	machine: string;
	sessionId: string;
	subagent: SubagentWire;
	onClose(): void;
}

/**
 * Transcript of one sub-agent, read incrementally from the daemon. Upstream's `AgentDrawer` talks to its own guest
 * connection, so only its look (the `ag-*` classes) and `<Transcript>` are reused here.
 */
export function AgentDrawer({ client, machine, sessionId, subagent, onClose }: Props): ReactNode {
	const { agent, progress, lifecycle } = subagent;
	const [state, setState] = useState<TranscriptState>(NO_TRANSCRIPT);
	const poller = useRef<AgentTranscriptPoller | null>(null);
	const running = useRef(false);
	running.current = agent.status === "running";
	const body = useRef<HTMLDivElement>(null);
	useTranscriptTimes(body);
	useTranscriptTail(body);
	const now = useNow(agent.status === "running");

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		setState(NO_TRANSCRIPT);
		if (!agent.hasSessionFile) return;
		const next = new AgentTranscriptPoller(
			async position => {
				const ack = await client.request(machine, {
					t: "session.agent_transcript",
					sessionId,
					agentId: agent.id,
					...position,
				});
				return ack.ok ? { ok: true, data: ack.data as SubagentTranscript } : { ok: false, error: ack.error };
			},
			setState,
			() => running.current,
		);
		poller.current = next;
		next.resume();
		return () => {
			next.dispose();
			poller.current = null;
		};
	}, [client, machine, sessionId, agent.id, agent.hasSessionFile]);

	// A read fails while the browser's socket or the machine's link is down (and a loop of failed reads of an agent that
	// is not running stops): each time both are up again (a new socket, a re-registered link), read at once.
	const link = useSyncExternalStore(client.subscribe, () => {
		const state = client.getSnapshot();
		const info = state.machines.find(m => m.id === machine);
		return state.phase === "open" && info?.online ? info.linkId : null;
	});
	useEffect(() => {
		const current = poller.current;
		if (link === null || !current) return;
		if (current.polling) void current.poll();
		else current.resume();
	}, [link]);

	// Activity of the agent restarts a loop that stopped after a quiet while.
	useEffect(() => {
		poller.current?.resume();
	}, [progress, lifecycle, agent.status, agent.lastActivity]);

	const model = progress?.progress.resolvedModel;
	const shownEntries = useMemo(() => presentEntries(state.entries), [state.entries]);

	// An older page lands above what the reader looks at: keep that in place (its distance from the bottom).
	const anchor = useRef<number | null>(null);
	const loadEarlier = (): void => {
		const current = poller.current;
		if (!current || !state.earlier || state.loadingEarlier) return;
		const scroller = body.current?.querySelector(".tr-root");
		anchor.current = scroller ? scroller.scrollHeight - scroller.scrollTop : null;
		void current.loadEarlier();
	};
	useLayoutEffect(() => {
		const distance = anchor.current;
		const scroller = body.current?.querySelector(".tr-root");
		if (distance === null || state.loadingEarlier) return;
		anchor.current = null;
		if (scroller) scroller.scrollTop = scroller.scrollHeight - distance;
	}, [state]);
	// Reaching the top of everything shown (upstream reveals its own hidden rows first) reads the page before it.
	const onScroll = (event: UIEvent<HTMLDivElement>): void => {
		const target = event.target as Element;
		if (!target.classList.contains("tr-root") || target.scrollTop > EARLIER_TRIGGER_PX) return;
		if (target.querySelector(".tr-earlier") === null) loadEarlier();
	};

	return (
		<>
			<div className="ag-drawer-backdrop" onClick={onClose} />
			<aside className="ag-drawer" role="dialog" aria-label={agent.displayName}>
				<header className="ag-drawer-head">
					<div className="ag-drawer-title">
						<span className="ag-drawer-name">{agent.displayName}</span>
						<span className={`ag-chip ag-chip--${agent.status}`}>{agent.status}</span>
						<span className="ag-chip" title="Time this sub-agent has run">
							{formatElapsed(agentRunMs(subagent, now))}
						</span>
						{model && <span className="ag-chip ag-chip--model">{model}</span>}
					</div>
					<div className="ag-drawer-actions">
						<IconButton icon={X} label="Close" onClick={onClose} />
					</div>
				</header>
				<div className="ag-drawer-body" ref={body} onScrollCapture={onScroll}>
					{!agent.hasSessionFile ? (
						<div className="dock-empty">no transcript available</div>
					) : state.loading ? (
						state.error === null && <div className="dock-empty">loading transcript…</div>
					) : (
						<>
							{state.earlier && (
								<button
									type="button"
									className="tr-earlier ag-load-earlier"
									disabled={state.loadingEarlier}
									onClick={loadEarlier}
								>
									{state.loadingEarlier ? "loading earlier…" : "load earlier"}
								</button>
							)}
							<Transcript
								compact
								entries={shownEntries}
								stream={null}
								streamDone={false}
								activeTools={EMPTY_TOOLS}
								working={agent.status === "running" && state.error === null}
							/>
						</>
					)}
					{agent.hasSessionFile && state.error !== null && (
						<div className="ag-fetch-error" role="alert">
							transcript unavailable: {state.error}
						</div>
					)}
				</div>
			</aside>
		</>
	);
}
