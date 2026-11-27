import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
	AttentionEvent,
	BrokerLinkConfig,
	DaemonHello,
	ProjectInfo,
	SessionInfo,
	UiRequest,
} from "@omp-web/protocol";
import type { EnvBroker } from "./env-broker";
import type { ClientHost, EnvClientOptions } from "./env-client";
import { EnvEndpoint } from "./env-endpoint";
import type { LinkEnd } from "./link-end";
import type { SessionManager } from "./manager";
import { FileError } from "./file-path";
import { FileService } from "./file-service";
import { locateOmpUrl } from "./omp-urls";
import { ProjectError, type Attribution, type ProjectRegistry } from "./projects";
import { replicaFileId } from "./replica-files";
import type { ReplicaSource } from "./replica-env";
import type { HostedSession } from "./session";
import type { HandoffPort } from "./handoff-service";
import { TerminalService } from "./terminal-service";

/** What this daemon tells the gateway about itself when it registers. */
export interface EnvIdentity {
	machineId: string;
	platform: string;
	hello: DaemonHello;
}

export interface ReplicaPolicy {
	/** Only conversations active within this many days are replicated (their older files with them). */
	retentionDays: number;
	/** Files larger than this are not replicated. */
	maxFileBytes: number;
	/** How often the session store is rescanned for changes while a gateway is linked, viewers or not. */
	scanIntervalMs: number;
}

export const DEFAULT_REPLICA_POLICY: ReplicaPolicy = {
	retentionDays: 30,
	maxFileBytes: 128 * 1024 * 1024,
	scanIntervalMs: 30_000,
};

export interface EnvHostOptions extends EnvClientOptions {
	replica?: ReplicaPolicy;
	/** This machine's view of the credential broker; its status goes to every link, the gateway's `broker.config` goes into it. */
	broker?: EnvBroker;
	/** The machine's persistent shells; without one terminals are disabled (the default). */
	terminals?: TerminalService;
	/** Executes the gateway's environment-switch operations; without one the daemon refuses them. */
	handoff?: HandoffPort;
	now?: () => number;
}

/** After a change the manifest is rebuilt this long later, so a burst (a turn's phase flips) costs one scan. */
const MANIFEST_DEBOUNCE_MS = 1500;
const DETAIL_CHARS = 160;

const clip = (text: string): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 1)}…` : flat;
};

/** The first text of an assistant message (`message_end`), for the push notification's body. */
function assistantText(message: unknown): string {
	if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant")
		return "";
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			return block.text;
		}
	}
	return "";
}

/** What an interactive extension-UI request asks, in a line. */
function askedText(request: UiRequest): string {
	switch (request.method) {
		case "ask":
			return request.questions[0]?.question ?? "";
		case "confirm":
			return [request.title, request.message].filter(Boolean).join(": ");
		case "select":
		case "input":
		case "editor":
			return request.title;
	}
}

/**
 * The environment role of the daemon: its session manager and project registry, and every link it currently has to a
 * gateway (normally one; the gateway's own machine has one in-process link). Keeps each link's copy of the session list
 * and project list current by pushing, offers the session files to the gateway's transcript replica, reports hosted
 * sessions that need a human, and re-targets virtual clients when a session id changes meaning.
 *
 * Nothing here depends on a browser being connected: the slow scan (`replica.scanIntervalMs`) and the hosted sessions'
 * own events drive the replica and the notifications. The scan's cost is one directory scan (stat-cached by omp's
 * listing code) plus one `omp session lease` probe per interval, and it only runs while a gateway is linked.
 */
export class EnvHost implements ClientHost {
	readonly #endpoints = new Set<EnvEndpoint>();
	readonly #attributions = new Map<string, Attribution | null>();
	readonly #policy: ReplicaPolicy;
	readonly #now: () => number;
	readonly #unsubscribe: (() => void)[];
	#pushing = false;
	#dirty = false;
	#manifestTimer: ReturnType<typeof setTimeout> | null = null;
	#scanTimer: ReturnType<typeof setInterval> | null = null;
	#manifesting = false;

	/**
	 * The read-only file browser: scoped to this machine's registered worktrees, shared by every link's clients, plus the
	 * directories of the omp URLs (`local://`, `agent://`, …) a session's transcript links to.
	 */
	readonly files = new FileService({
		resolveRoot: async root => {
			try {
				return await this.projects.resolveWorktreeRoot(root);
			} catch (error) {
				if (error instanceof ProjectError) throw new FileError("not_registered", error.message);
				throw error;
			}
		},
		locateUrl: async (sessionId, url) => {
			const session = this.manager.list().find(s => s.id === sessionId || s.aliases.includes(sessionId));
			if (!session) throw new FileError("not_found", `no session ${sessionId} on this machine`);
			return locateOmpUrl(url, session);
		},
	});

	/** Persistent shells (`term.*`); disabled unless the operator turned them on for this machine. */
	readonly terminals: TerminalService;

	/** Environment-switch operations, when this daemon was wired with the service. */
	readonly handoff: HandoffPort | undefined;

	constructor(
		readonly manager: SessionManager,
		readonly projects: ProjectRegistry,
		private readonly options: EnvHostOptions = {},
	) {
		this.#policy = options.replica ?? DEFAULT_REPLICA_POLICY;
		this.#now = options.now ?? Date.now;
		this.handoff = options.handoff;
		this.terminals =
			options.terminals ??
			new TerminalService({ enabled: false, machineId: () => "-", resolveCwd: cwd => projects.resolveCwd(cwd) });
		this.#unsubscribe = [
			manager.onChange(() => {
				void this.#pushSessions();
				this.#scheduleManifest();
			}),
			// A session id now names a different object (stored <-> hosted): whoever looks at it gets a fresh snapshot of the new one.
			manager.onReplaced(ids => {
				for (const endpoint of this.#endpoints) endpoint.resubscribe(ids);
			}),
			manager.onHosted(session => this.#watch(session)),
			projects.onChange(() => {
				this.#attributions.clear();
				void this.#pushProjects();
				void this.#pushSessions();
			}),
			...(options.broker ? [options.broker.onChange(() => this.#pushBroker())] : []),
		];
	}

	/** Virtual clients across all links: somebody is looking, so the session store is worth rescanning often. */
	get clientCount(): number {
		let count = 0;
		for (const endpoint of this.#endpoints) count += endpoint.clientCount;
		return count;
	}

	/** Starts serving a link: pushes the current session list, projects and replica manifest, then answers its clients. */
	attach(link: LinkEnd): EnvEndpoint {
		const endpoint = new EnvEndpoint(this, link, this.options);
		this.#endpoints.add(endpoint);
		this.#scanTimer ??= setInterval(() => void this.#scan(), this.#policy.scanIntervalMs);
		void (async () => {
			await this.manager.refresh().catch(() => {});
			endpoint.send(await this.#sessionsFrame());
			endpoint.send(await this.#projectsFrame());
			if (this.options.broker) endpoint.send(this.#brokerFrame());
			await this.#announce();
		})();
		return endpoint;
	}

	detach(endpoint: EnvEndpoint): void {
		this.#endpoints.delete(endpoint);
		endpoint.dispose();
		if (this.#endpoints.size === 0) {
			clearInterval(this.#scanTimer ?? undefined);
			this.#scanTimer = null;
			clearTimeout(this.#manifestTimer ?? undefined);
			this.#manifestTimer = null;
		}
	}

	projectsRefreshed(projects: ProjectInfo[]): void {
		this.#attributions.clear();
		const frame = JSON.stringify({ t: "projects", projects });
		for (const endpoint of this.#endpoints) endpoint.send(frame);
		void this.#pushSessions();
	}

	brokerConfig(config: BrokerLinkConfig | null): void {
		this.options.broker?.setGateway(config);
	}

	close(): void {
		this.handoff?.close();
		for (const off of this.#unsubscribe) off();
		for (const endpoint of Array.from(this.#endpoints)) this.detach(endpoint);
	}

	/** One slow-scan tick: index what changed on disk (TUI sessions included), then offer it. Public for tests. */
	async scanNow(): Promise<void> {
		await this.#scan();
	}

	async #scan(): Promise<void> {
		await this.manager.refresh().catch(() => {});
		await this.#announce();
	}

	#scheduleManifest(): void {
		if (this.#endpoints.size === 0 || this.#manifestTimer !== null) return;
		this.#manifestTimer = setTimeout(() => {
			this.#manifestTimer = null;
			void this.#scan();
		}, MANIFEST_DEBOUNCE_MS);
	}

	/** The session files to replicate: indexed conversations active within the retention window, each file within the size cap. */
	async #replicaSources(): Promise<ReplicaSource[]> {
		const horizon = this.#now() - this.#policy.retentionDays * 24 * 60 * 60 * 1000;
		const sources: ReplicaSource[] = [];
		for (const file of this.manager.conversationFiles()) {
			if (file.modifiedAt < horizon) continue;
			const info = await stat(file.path).catch(() => null);
			if (info === null || info.size === 0 || info.size > this.#policy.maxFileBytes) continue;
			sources.push({
				path: file.path,
				meta: {
					id: replicaFileId(file.path),
					name: basename(file.path),
					sessionId: file.sessionId,
					size: info.size,
					mtimeMs: info.mtimeMs,
				},
			});
		}
		return sources;
	}

	/** Offers the current file list to every link whose copy of it is out of date. */
	async #announce(): Promise<void> {
		if (this.#manifesting || this.#endpoints.size === 0) return;
		this.#manifesting = true;
		try {
			const sources = await this.#replicaSources();
			const signature = JSON.stringify(sources.map(s => s.meta));
			for (const endpoint of this.#endpoints) endpoint.announce(sources, signature);
		} finally {
			this.#manifesting = false;
		}
	}

	/** Follows a hosted session's events for the ones that need a human. Ends with the session. */
	#watch(session: HostedSession): void {
		let running = false;
		let lastText = "";
		const { unsubscribe } = session.subscribe(
			events => {
				for (const { ev } of events) {
					if (ev.k === "closed") {
						unsubscribe();
						return;
					}
					if (ev.k === "agent") {
						const event = ev.event;
						if (event.type === "agent_start") {
							running = true;
							lastText = "";
						} else if (event.type === "message_end") {
							lastText = assistantText(event.message) || lastText;
						} else if (event.type === "agent_end" && running) {
							running = false;
							this.#attention(session, "turn_end", lastText);
						}
					} else if (ev.k === "ui" && ev.request.method !== "editor") {
						this.#attention(session, "input_needed", askedText(ev.request));
					}
				}
			},
			0,
			undefined,
		);
	}

	#attention(session: HostedSession, kind: AttentionEvent["kind"], detail: string): void {
		const { info } = session;
		const event: AttentionEvent = {
			sessionId: session.id,
			kind,
			title: info.title ?? basename(info.cwd),
			detail: clip(detail),
		};
		const frame = JSON.stringify({ t: "attention", event });
		for (const endpoint of this.#endpoints) endpoint.send(frame);
	}

	async #attribute(cwd: string): Promise<Attribution | null> {
		if (this.#attributions.has(cwd)) return this.#attributions.get(cwd) ?? null;
		const found = await this.projects.attribute(cwd);
		this.#attributions.set(cwd, found);
		return found;
	}

	async #sessionsFrame(): Promise<string> {
		const sessions: SessionInfo[] = [];
		for (const info of this.manager.list()) {
			const where = await this.#attribute(info.cwd);
			sessions.push(where ? { ...info, ...where } : info);
		}
		return JSON.stringify({ t: "sessions", sessions });
	}

	async #projectsFrame(): Promise<string> {
		return JSON.stringify({ t: "projects", projects: await this.projects.list() });
	}

	/** One push at a time; a change that arrives meanwhile triggers another build after it. */
	async #pushSessions(): Promise<void> {
		if (this.#pushing) {
			this.#dirty = true;
			return;
		}
		this.#pushing = true;
		try {
			do {
				this.#dirty = false;
				if (this.#endpoints.size === 0) return;
				const frame = await this.#sessionsFrame();
				for (const endpoint of this.#endpoints) endpoint.send(frame);
			} while (this.#dirty);
		} finally {
			this.#pushing = false;
		}
	}

	#brokerFrame(): string {
		return JSON.stringify({ t: "broker.status", status: this.options.broker?.status() });
	}

	#pushBroker(): void {
		const frame = this.#brokerFrame();
		for (const endpoint of this.#endpoints) endpoint.send(frame);
	}

	async #pushProjects(): Promise<void> {
		if (this.#endpoints.size === 0) return;
		const frame = await this.#projectsFrame();
		for (const endpoint of this.#endpoints) endpoint.send(frame);
	}
}
