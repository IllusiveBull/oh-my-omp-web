import { statSync } from "node:fs";
import { BlobStore, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { resolveSessionLeafId, type SessionEntry as OmpEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile, resolveBlobRefsInEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { migrateToCurrentVersion } from "@oh-my-pi/pi-coding-agent/session/session-migrations";
import { getBlobsDir } from "@oh-my-pi/pi-utils/dirs";
import { contextLevel, formatContextUsage } from "@oh-my-pi/pi-coding-agent/ui/status/format";
import {
	compareBranches,
	defaultCapabilities,
	emptySessionView,
	selectActiveBranch,
	type SessionInfo,
	type SessionStatus,
} from "@omp-web/protocol";
import { findAntigravityConversationDb, readAntigravityConversationUsage } from "./antigravity-db";
import { antigravityCallCostUsd, antigravityModelContextWindow } from "./antigravity-pricing";
import { loadAntigravityTranscript } from "./antigravity-sessions";
import type { EventLogOptions } from "./event-log";
import type { Conversation } from "./session-index";
import { ViewChannel, type SessionHandle, type SessionListener, type SubscribeResult } from "./session-channel";
import { branchPins } from "./cache-facts";
import { toWireEntries } from "./wire-entries";

export interface StoredSessionOptions {
	conversation: Conversation;
	access: "free" | "held";
	log?: EventLogOptions;
	/** The file is a gateway-side copy of another machine's session: blobs are absent, see {@link MISSING_IMAGE_TEXT}. */
	replica?: boolean;
	now?: () => number;
}

interface Loaded {
	/** Active-branch entry ids, root first. */
	branch: string[];
	entries: Map<string, OmpEntry>;
	status: SessionStatus;
	/** `mtime:size` of the file the load saw. */
	signature: string;
}

function fileSignature(path: string): string {
	if (!path) return "";
	const stat = statSync(path);
	return `${stat.mtimeMs}:${stat.size}`;
}

/** The list entry of a conversation that no process of this daemon runs. */
export function conversationInfo(conversation: Conversation, access: "free" | "held"): SessionInfo {
	return {
		id: conversation.id,
		sessionId: conversation.id,
		access,
		cwd: conversation.cwd,
		title: conversation.title,
		preview: conversation.preview,
		phase: "stored",
		createdAt: conversation.createdAt,
		modifiedAt: conversation.modifiedAt,
		file: conversation.path || undefined,
		files: conversation.files,
		aliases: conversation.memberIds.filter(id => id !== conversation.id),
		...(conversation.backend && conversation.backend !== "omp" ? { backend: conversation.backend } : {}),
	};
}

/** What an image whose blob is not on this machine becomes in a replica transcript. */
export const MISSING_IMAGE_TEXT = "[image not replicated to the gateway]";

/**
 * Images are stored outside the session file (content-addressed blobs under omp's agent dir) and are not replicated.
 * After the blob store has had its chance, any image still pointing at a blob becomes a text block saying so, instead of
 * reaching the browser as an invalid base64 string. Walks the entries in place.
 */
function replaceUnresolvedImages(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) replaceUnresolvedImages(item);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, unknown>;
	if (record.type === "image" && typeof record.data === "string" && isBlobRef(record.data)) {
		record.type = "text";
		record.text = MISSING_IMAGE_TEXT;
		delete record.data;
		delete record.mimeType;
		return;
	}
	for (const child of Object.values(record)) replaceUnresolvedImages(child);
}

/**
 * A conversation that is only a file on disk (no omp process of this daemon runs it): the transcript is rendered
 * straight from the file along its active branch. While a client looks at it, {@link refresh} re-reads the file when it
 * changes, so a session another omp process is writing (the `held` case) follows along read-only.
 */
export class StoredSession implements SessionHandle {
	readonly #channel: ViewChannel;
	#conversation: Conversation;
	#access: "free" | "held";
	#loaded: Loaded;
	#info: SessionInfo;

	readonly #replica: boolean;

	private constructor(options: StoredSessionOptions, loaded: Loaded) {
		this.#replica = options.replica === true;
		const now = options.now ?? Date.now;
		this.#channel = new ViewChannel({ log: options.log, now });
		this.#conversation = options.conversation;
		this.#access = options.access;
		this.#loaded = loaded;
		this.#info = conversationInfo(options.conversation, options.access);
		this.#channel.seed({
			...emptySessionView,
			entries: toWireEntries(loaded.branch.map(id => loaded.entries.get(id)!)),
			status: loaded.status,
		});
	}

	static async open(options: StoredSessionOptions): Promise<StoredSession> {
		return new StoredSession(options, await StoredSession.#load(options.conversation, options.replica === true));
	}

	static async #load(conversation: Conversation, replica: boolean): Promise<Loaded> {
		if (conversation.backend === "antigravity") {
			const signature = fileSignature(conversation.path);
			const parsed = loadAntigravityTranscript(conversation.path, {
				cwd: conversation.cwd || undefined,
				hydrateLocalReads: true,
			});
			const entries = parsed.entries as unknown as OmpEntry[];
			const dbPath = findAntigravityConversationDb(conversation.id, { transcriptPath: conversation.path });
			const dbUsage = dbPath ? readAntigravityConversationUsage(dbPath) : null;
			const resolvedModelId = parsed.model ?? dbUsage?.model;
			const contextWindow = resolvedModelId ? antigravityModelContextWindow(resolvedModelId) : undefined;
			const contextTokens = dbUsage?.latest.contextTokens;
			const contextPercent =
				contextTokens !== undefined && contextWindow !== undefined && contextWindow > 0
					? (contextTokens / contextWindow) * 100
					: undefined;
			const cost = dbUsage ? dbUsage.calls.reduce((sum, call) => sum + antigravityCallCostUsd(call), 0) : 0;
			return {
				branch: entries.map(entry => entry.id),
				entries: new Map(entries.map(entry => [entry.id, entry])),
				signature,
				status: {
					sessionId: conversation.id,
					sessionFile: conversation.path || undefined,
					cwd: conversation.cwd,
					model: resolvedModelId
						? resolvedModelId.includes("/")
							? resolvedModelId
							: `antigravity/${resolvedModelId}`
						: undefined,
					sessionName: conversation.title ?? parsed.title,
					isStreaming: false,
					isCompacting: false,
					queue: { steering: [], followUp: [], liveSteered: 0 },
					todos: [],
					...(contextTokens !== undefined && contextWindow !== undefined && contextPercent !== undefined
						? {
								contextUsage: {
									label: formatContextUsage(contextPercent, contextWindow, contextTokens),
									level: contextLevel(contextPercent, contextWindow),
									percent: contextPercent,
								},
							}
						: {}),
					...(cost > 0 ? { cost } : {}),
					backend: "antigravity",
					capabilities: defaultCapabilities("antigravity"),
				},
			};
		}
		const signature = fileSignature(conversation.path);
		const file = await loadEntriesFromFile(conversation.path, undefined, { throwIfMissing: true });
		migrateToCurrentVersion(file);
		await resolveBlobRefsInEntries(file, new BlobStore(getBlobsDir()));
		if (replica) replaceUnresolvedImages(file);
		const header = file.find(entry => entry.type === "session");
		const all = file.filter((entry): entry is OmpEntry => entry.type !== "session");
		const branchEntries = selectActiveBranch(all, resolveSessionLeafId(all));
		const model = branchEntries.findLast(entry => entry.type === "model_change");
		const thinking = branchEntries.findLast(entry => entry.type === "thinking_level_change");
		return {
			branch: branchEntries.map(entry => entry.id),
			entries: new Map(branchEntries.map(entry => [entry.id, entry])),
			signature,
			status: {
				sessionId: conversation.id,
				sessionFile: conversation.path,
				cwd: conversation.cwd,
				model: model?.type === "model_change" ? model.model : undefined,
				pins: branchPins(branchEntries),
				thinkingLevel:
					thinking?.type === "thinking_level_change" ? (thinking.thinkingLevel ?? undefined) : undefined,
				sessionName: header?.type === "session" ? (header.title ?? conversation.title) : conversation.title,
				isStreaming: false,
				isCompacting: false,
				queue: { steering: [], followUp: [], liveSteered: 0 },
				todos: [],
			},
		};
	}

	get id(): string {
		return this.#conversation.id;
	}

	get info(): SessionInfo {
		return this.#info;
	}

	get listenerCount(): number {
		return this.#channel.listenerCount;
	}

	get epoch(): string {
		return this.#channel.epoch;
	}

	subscribe(
		listener: SessionListener,
		lastSeq: number,
		epoch: string | undefined,
	): { result: SubscribeResult; unsubscribe: () => void } {
		return this.#channel.subscribe(listener, lastSeq, epoch);
	}

	/** Index refresh: new lease state, and possibly a newer copy of the conversation (then {@link refresh} reloads from it). */
	update(conversation: Conversation, access: "free" | "held"): void {
		this.#conversation = conversation;
		this.#access = access;
		this.#info = conversationInfo(conversation, access);
	}

	get access(): "free" | "held" {
		return this.#access;
	}

	/** Re-reads the file when it (or the file the conversation now lives in) changed and publishes the difference. */
	async refresh(): Promise<void> {
		const conversation = this.#conversation;
		if (!conversation.path) return;
		if (
			conversation.path === this.#loaded.status.sessionFile &&
			fileSignature(conversation.path) === this.#loaded.signature
		) {
			return;
		}
		const next = await StoredSession.#load(conversation, this.#replica);
		const previous = this.#loaded;
		this.#loaded = next;
		const change = compareBranches(previous.branch, next.branch);
		if (change.kind === "extend") {
			const wire = toWireEntries(change.appended.map(id => next.entries.get(id)!));
			if (wire.length > 0) this.#channel.emit({ k: "entries", entries: wire }, JSON.stringify(wire).length);
		} else if (change.kind === "switch") {
			const wire = toWireEntries(next.branch.map(id => next.entries.get(id)!));
			this.#channel.emit({ k: "entries", entries: wire, reset: true }, JSON.stringify(wire).length);
		}
		if (JSON.stringify(previous.status) !== JSON.stringify(next.status))
			this.#channel.emit({ k: "state", status: next.status });
	}
}
