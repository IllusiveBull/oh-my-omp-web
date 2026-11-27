import { stat } from "node:fs/promises";
import { SessionManager as OmpSessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type {
	AckErrorCode,
	AntigravityAuthLoginAck,
	AntigravityAuthStatusAck,
	AntigravityUsageAck,
	ModelRolesWire,
	OmpThemeWire,
	PermissionMode,
	SessionBackend,
	SessionInfo,
} from "@omp-web/protocol";
import {
	AntigravityAcpSource,
	AntigravityAuthError,
	authenticateAntigravity,
	probeAntigravityAuth,
} from "./antigravity-acp";
import type { AntigravityBinary } from "./antigravity-binary";
import { type AntigravitySessionRegistry, scanAntigravityConversations } from "./antigravity-sessions";
import { AntigravityUsageProbe } from "./antigravity-usage";
import { settledState, type SettledState, type SettledStateOptions } from "./cache-facts";
import { probeLeases, type LeaseReport } from "./lease";
import { ompConfigRunner, ompModelRoles, type ModelRoleStore } from "./model-roles";
import { ompTheme } from "./omp-theme";
import { MemoryOwnedSessions, type OwnedSessions } from "./owned";
import { OmpRpcSource } from "./omp-source";
import type { RpcSource } from "./rpc-source";
import { HostedSession } from "./session";
import type { SessionHandle } from "./session-channel";
import { scanConversations, type Conversation } from "./session-index";
import { type HistoryMatcher, searchConversations } from "./session-search";
import { conversationInfo, StoredSession } from "./stored-session";

/** A failure the UI reacts to specially (see `AckErrorCode`). */
export class SessionActionError extends Error {
	constructor(
		message: string,
		readonly code?: AckErrorCode,
	) {
		super(message);
	}
}

export interface SessionSpec {
	cwd: string;
	/** Agent backend (`omp` by default, or `antigravity` via `agy acp`). */
	backend?: SessionBackend;
	/** `provider/modelId`; new sessions only (a resumed or forked session keeps its own). */
	model?: string;
	/** Session file to open with `omp --resume`, or Antigravity session ID for ACP `session/load`. */
	resume?: string;
	/** Session file to copy into a new session with `omp --fork`. */
	fork?: string;
	/** Optional local transcript path for Antigravity history seeding on resume. */
	transcriptPath?: string;
	/** Optional persisted title override for Antigravity sessions. */
	initialTitle?: string;
	/** Optional initial permission approval mode for Antigravity sessions (`ask`, `edits`, `auto`). */
	permissionMode?: PermissionMode;
}

/** Ids other than `info.id` that name a hosted session's conversation. */
function aliasesOf(info: SessionInfo, conversation: Conversation | undefined): string[] {
	const ids = new Set([info.sessionId, ...(conversation?.memberIds ?? [])]);
	ids.delete(info.id);
	return [...ids];
}

export interface AntigravityManagerOptions {
	/** Resolved `agy` binary (null/undefined when unavailable on this machine). */
	binary?: AntigravityBinary | null;
	/** Preferred ACP `authenticate` methodId. */
	authMethod?: string;
	/** Default ACP execution mode id (`default`, `accept-edits`, `auto`, `plan`, …). */
	mode?: string;
	/** Default client-side permission approval policy (`ask`, `edits`, `auto`). */
	permissionMode?: PermissionMode;
	/** Optional custom Antigravity brain directory (`--antigravity-session-dir`). */
	sessionDir?: string;
	/** Daemon-side metadata registry for Antigravity sessions. */
	registry?: AntigravitySessionRegistry;
	/** Test seam: replaces scanning local Antigravity brain directories. */
	scan?: () => Conversation[];
	/** Test seam: replaces probing ACP auth methods. */
	probeAuth?: () => Promise<AntigravityAuthStatusAck>;
	/** Test seam: replaces invoking ACP `authenticate`. */
	authenticate?: (methodId: string) => Promise<AntigravityAuthLoginAck>;
	/** Test seam: replaces probing Antigravity subscription quota limits. */
	probeUsage?: () => Promise<AntigravityUsageAck>;
}

export interface ManagerOptions {
	ompPath: string;
	/** Optional Antigravity ACP backend configuration. */
	antigravity?: AntigravityManagerOptions;
	/** omp's `--session-dir`: one flat directory for all sessions. Default: omp's per-project buckets under its agent dir. */
	sessionDir?: string;
	/**
	 * Decides where an omp process may be started: resolves a requested cwd to the canonical directory the child runs in,
	 * or throws when it is not allowed (see `ProjectRegistry.resolveCwd`). Applies to create, resume and fork.
	 */
	resolveCwd: (cwd: string) => Promise<string>;
	/** The set of sessions this daemon owns (default: in memory; the daemon passes one that survives restarts). */
	owned?: OwnedSessions;
	/** Environment added to every omp child (read at spawn time): the credential broker's URL and token. */
	childEnv?: () => Record<string, string>;
	/**
	 * Called with the error of a failed omp start; may return a clearer one (e.g. naming an unreachable credential
	 * broker, which makes omp fail at startup when it has no cached snapshot). Return null to keep the original.
	 */
	explainSpawnError?: (error: Error) => Error | null;
	/** Test seam: replaces spawning `omp`. The returned source must already be started. */
	createSource?: (spec: SessionSpec) => Promise<RpcSource>;
	/** Test seam: replaces `omp session lease --json`. */
	probeLeases?: (ids: readonly string[]) => Promise<LeaseReport>;
	/** Test seam: replaces `omp config` for the model roles. */
	modelRoles?: ModelRoleStore;
	/** Test seam: replaces `omp config get <key>` (theme names; goal continuation modes, as seen from a session's `cwd`). */
	readSetting?: (key: string, cwd?: string) => Promise<unknown>;
	/** Test seam: replaces omp's rename of a session file nobody has loaded. Returns the stored title, or null when refused. */
	renameStored?: (path: string, title: string, cwd: string) => Promise<string | null>;
	/** Ids of the sessions whose recorded prompts match a query, best first (omp's prompt history). Default: none. */
	historyMatcher?: HistoryMatcher;
}

/**
 * Owns the sessions this daemon hosts and the index of every conversation on disk, and resolves what a client asks
 * for: a session id may name a hosted session or any file of a stored conversation.
 */
export class SessionManager {
	readonly #hosted = new Map<string, HostedSession>();
	readonly #stored = new Map<string, StoredSession>();
	readonly #opening = new Map<string, Promise<StoredSession>>();
	/** Ids of sessions this daemon created, forked or took over with confirmation: no further takeover confirmation. */
	readonly #owned: OwnedSessions;
	/** Session ids an environment switch is working on, by operation id: clients may not drive them meanwhile. */
	readonly #reserved = new Map<string, Set<string>>();
	readonly #hostedListeners = new Set<(session: HostedSession) => void>();
	readonly #changeListeners = new Set<() => void>();
	readonly #replacedListeners = new Set<(ids: string[]) => void>();
	#conversations: Conversation[] = [];
	#held = new Set<string>();
	#refreshing: Promise<void> | null = null;
	#poll: ReturnType<typeof setInterval> | null = null;
	#probeFailure = "";

	readonly #roles: ModelRoleStore;
	readonly #readSetting: (key: string, cwd?: string) => Promise<unknown>;
	readonly #antigravityUsage: AntigravityUsageProbe;
	#themeCache: { value: OmpThemeWire; expiresAt: number } | null = null;
	#themeInflight: Promise<OmpThemeWire> | null = null;

	constructor(private readonly options: ManagerOptions) {
		this.#owned = options.owned ?? new MemoryOwnedSessions();
		const config = ompConfigRunner(options.ompPath, () => options.childEnv?.() ?? {});
		this.#roles = options.modelRoles ?? ompModelRoles(config);
		this.#readSetting =
			options.readSetting ??
			(async (key, cwd = process.cwd()) => {
				const result = await config(["get", key], cwd);
				return typeof result === "object" && result !== null && "value" in result ? result.value : undefined;
			});
		this.#antigravityUsage = new AntigravityUsageProbe({ authMethod: options.antigravity?.authMethod });
	}

	/** Queries ACP authentication methods advertised by this machine's Antigravity CLI. */
	antigravityAuthStatus(): Promise<AntigravityAuthStatusAck> {
		const agy = this.options.antigravity;
		if (agy?.probeAuth) return agy.probeAuth();
		return probeAntigravityAuth(agy?.binary, { configuredMethod: agy?.authMethod });
	}

	/** Invokes ACP `authenticate` with `methodId` on this machine's Antigravity CLI. */
	async antigravityAuthLogin(methodId: string): Promise<AntigravityAuthLoginAck> {
		const agy = this.options.antigravity;
		this.#antigravityUsage.clear();
		if (agy?.authenticate) return agy.authenticate(methodId);
		if (!agy?.binary) {
			throw new Error("Antigravity (`agy`) is not available on this machine (install `agy` or pass --antigravity).");
		}
		return authenticateAntigravity(agy.binary, methodId);
	}

	/** Probes Antigravity subscription quota limits using this machine's stored Antigravity sign-in. */
	antigravityUsage(): Promise<AntigravityUsageAck> {
		const agy = this.options.antigravity;
		if (agy?.probeUsage) return agy.probeUsage();
		return this.#antigravityUsage.probe();
	}

	/** The colours of omp's configured dark and light themes (cached briefly to avoid spawning `omp config` on every switch). */
	theme(): Promise<OmpThemeWire> {
		if (this.#themeCache && Date.now() < this.#themeCache.expiresAt) return Promise.resolve(this.#themeCache.value);
		if (this.#themeInflight) return this.#themeInflight;
		const pending = ompTheme(this.#readSetting)
			.then(value => {
				this.#themeCache = { value, expiresAt: Date.now() + 30_000 };
				return value;
			})
			.finally(() => {
				if (this.#themeInflight === pending) this.#themeInflight = null;
			});
		this.#themeInflight = pending;
		return pending;
	}

	/** omp's model roles as seen from the hosted session's directory (project settings apply there). */
	roles(id: string): Promise<ModelRolesWire> {
		const session = this.get(id);
		if (!session.capabilities.roles) return Promise.resolve({ roles: [], cycle: [] });
		return this.#roles.read(session.info.cwd);
	}

	/** Sets or clears a model role in omp's global settings; a warning when the session's project overrides it. */
	setRole(id: string, role: string, selector: string | null): Promise<string | undefined> {
		const session = this.get(id);
		if (!session.capabilities.roles) {
			return Promise.reject(new Error("This session backend does not use omp model roles."));
		}
		return this.#roles.write(session.info.cwd, role, selector);
	}

	/** Fires when this daemon starts hosting a session (created, resumed or forked). Returns the unsubscribe. */
	onHosted(listener: (session: HostedSession) => void): () => void {
		this.#hostedListeners.add(listener);
		return () => this.#hostedListeners.delete(listener);
	}

	/** Every omp session file of every indexed conversation (older copies included) with the conversation's last activity. */
	conversationFiles(): { sessionId: string; path: string; modifiedAt: number }[] {
		return this.#conversations
			.filter(c => c.backend !== "antigravity")
			.flatMap(c =>
				c.memberIds.map((sessionId, i) => ({ sessionId, path: c.memberPaths[i]!, modifiedAt: c.modifiedAt })),
			);
	}

	/** Fires when the session list or any session's info (phase, model, title, access) changes. Returns the unsubscribe. */
	onChange(listener: () => void): () => void {
		this.#changeListeners.add(listener);
		return () => this.#changeListeners.delete(listener);
	}

	/** Fires with the ids whose session object changed identity (stored <-> hosted): subscribers must resubscribe. */
	onReplaced(listener: (ids: string[]) => void): () => void {
		this.#replacedListeners.add(listener);
		return () => this.#replacedListeners.delete(listener);
	}

	#changed(): void {
		for (const l of this.#changeListeners) l();
	}

	#replaced(ids: string[]): void {
		for (const l of this.#replacedListeners) l(ids);
	}

	#accessOf(conversation: Conversation): "free" | "held" {
		return conversation.memberIds.some(id => this.#held.has(id)) ? "held" : "free";
	}

	#conversationOf(id: string): Conversation | undefined {
		return this.#conversations.find(c => c.memberIds.includes(id));
	}

	#hostedFor(id: string, conversation: Conversation | undefined): HostedSession | undefined {
		const direct = this.#hosted.get(id);
		if (direct) return direct;
		if (!conversation) return undefined;
		for (const session of this.#hosted.values()) {
			if (
				conversation.memberIds.includes(session.info.id) ||
				conversation.memberIds.includes(session.info.sessionId)
			) {
				return session;
			}
		}
		return undefined;
	}

	/** Hosted sessions plus the stored conversations they do not cover, newest activity first. */
	list(): SessionInfo[] {
		const infos: SessionInfo[] = [];
		const covered = new Set<string>();
		for (const session of this.#hosted.values()) {
			const conversation = this.#conversationOf(session.info.id) ?? this.#conversationOf(session.info.sessionId);
			infos.push(
				conversation
					? {
							...session.info,
							title: session.info.title ?? conversation.title,
							preview: conversation.preview,
							createdAt: conversation.createdAt,
							files: conversation.files,
							aliases: aliasesOf(session.info, conversation),
						}
					: { ...session.info, aliases: aliasesOf(session.info, undefined) },
			);
			if (conversation) covered.add(conversation.id);
		}
		for (const conversation of this.#conversations) {
			if (!covered.has(conversation.id)) infos.push(conversationInfo(conversation, this.#accessOf(conversation)));
		}
		return infos.toSorted((a, b) => b.modifiedAt - a.modifiedAt);
	}

	/**
	 * Ids of the indexed conversations matching `query`, best first: omp's resume-picker ranking over each
	 * conversation's text, with the ones whose recorded prompts match leading (see `searchConversations`).
	 */
	searchSessions(query: string): Promise<string[]> {
		return searchConversations(this.#conversations, query, this.options.historyMatcher);
	}

	/** Rescans the session store and the lease state; broadcasts when the list changed. Concurrent calls share one scan. */
	refresh(): Promise<void> {
		this.#refreshing ??= this.#refresh().finally(() => {
			this.#refreshing = null;
		});
		return this.#refreshing;
	}

	async #refresh(): Promise<void> {
		const before = JSON.stringify(this.list());
		const ompConversations = await scanConversations(this.options.sessionDir);
		try {
			this.#held = (await this.#probe(ompConversations.flatMap(c => c.memberIds))).held;
			this.#probeFailure = "";
		} catch (error) {
			// Keep the previous answer; a failed probe is never read as "free" by resume (it probes again and refuses).
			const message = error instanceof Error ? error.message : String(error);
			if (message !== this.#probeFailure) console.warn(`omp-webd: lease probe failed: ${message}`);
			this.#probeFailure = message;
		}
		const agyOpts = this.options.antigravity;
		const agyConversations = agyOpts
			? agyOpts.scan
				? agyOpts.scan()
				: scanAntigravityConversations({
						sessionDir: agyOpts.sessionDir,
						registry: agyOpts.registry,
					})
			: [];
		const conversations = [...ompConversations, ...agyConversations].toSorted((a, b) => b.modifiedAt - a.modifiedAt);
		this.#conversations = conversations;
		await this.#refreshStored();
		if (JSON.stringify(this.list()) !== before) this.#changed();
	}

	async #refreshStored(): Promise<void> {
		for (const [key, stored] of Array.from(this.#stored)) {
			const conversation = this.#conversationOf(key);
			if (!conversation || stored.listenerCount === 0) {
				this.#stored.delete(key);
				continue;
			}
			stored.update(conversation, this.#accessOf(conversation));
			if (conversation.id !== key) {
				this.#stored.delete(key);
				this.#stored.set(conversation.id, stored);
			}
			await stored.refresh().catch(error => {
				console.warn(
					`omp-webd: reading ${conversation.path} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		}
	}

	/** Rescans every `intervalMs` while `demand()` is true (somebody is looking), so TUI activity and lease changes show up. */
	startPolling(intervalMs: number, demand: () => boolean): void {
		this.#poll ??= setInterval(() => {
			if (demand()) void this.refresh().catch(error => console.warn(`omp-webd: session scan failed: ${error}`));
		}, intervalMs);
	}

	#probe(ids: readonly string[]): Promise<LeaseReport> {
		return this.options.probeLeases ? this.options.probeLeases(ids) : probeLeases(this.options.ompPath, ids);
	}

	/** The hosted session `id` names (commands need one; stored sessions are read-only until resumed). */
	get(id: string): HostedSession {
		const hosted = this.#hostedFor(id, this.#conversationOf(id));
		if (hosted) return hosted;
		if (this.#conversationOf(id)) throw new Error("session is not running in omp-web: take it over (resume) first");
		throw new Error(`unknown session: ${id}`);
	}

	/** What a client can subscribe to under `id`: the hosted session, else the stored conversation read from disk. */
	async view(id: string): Promise<SessionHandle> {
		let conversation = this.#conversationOf(id);
		const hosted = this.#hostedFor(id, conversation);
		if (hosted) return hosted;
		if (!conversation) {
			await this.refresh();
			conversation = this.#conversationOf(id);
			const late = this.#hostedFor(id, conversation);
			if (late) return late;
		}
		if (!conversation) throw new Error(`unknown session: ${id}`);
		const cached = this.#stored.get(conversation.id);
		if (cached) return cached;
		const key = conversation.id;
		let opening = this.#opening.get(key);
		if (!opening) {
			const target = conversation;
			opening = StoredSession.open({ conversation: target, access: this.#accessOf(target) })
				.then(stored => {
					this.#stored.set(key, stored);
					return stored;
				})
				.finally(() => this.#opening.delete(key));
			this.#opening.set(key, opening);
		}
		return opening;
	}

	/**
	 * Starts a fresh session in `cwd`, keeping at most one empty hosted session at a time:
	 * an existing empty session in the same directory and backend (when no explicit model override is requested)
	 * is reused directly; otherwise a new one is spawned first and any other untouched empty sessions are closed.
	 */
	async create(
		cwd: string,
		model?: string,
		backend?: SessionBackend,
		permissionMode?: PermissionMode,
	): Promise<HostedSession> {
		const resolvedCwd = await this.options.resolveCwd(cwd);
		const requestedBackend: SessionBackend = backend ?? "omp";
		if (!model) {
			const empty = [...this.#hosted.values()].filter(s => s.isEmpty && !this.isReserved(s.id));
			const reusable = empty.find(s => s.info.cwd === resolvedCwd && s.backend === requestedBackend);
			if (reusable) {
				if (requestedBackend === "antigravity" && permissionMode) {
					await reusable.setPermissionMode(permissionMode).catch(() => {});
				}
				await this.#closeOtherEmpty(reusable.id);
				return reusable;
			}
		}
		const session = await this.#spawn({ cwd: resolvedCwd, model, backend, permissionMode }, [], true);
		await this.#closeOtherEmpty(session.id);
		return session;
	}

	async #closeOtherEmpty(keepId: string): Promise<void> {
		const staleIds: string[] = [];
		for (const other of this.#hosted.values()) {
			if (other.id !== keepId && other.isEmpty && !this.isReserved(other.id)) staleIds.push(other.id);
		}
		for (const id of staleIds) {
			await this.close(id).catch(() => {});
		}
	}

	/**
	 * Takes over a stored conversation with `omp --resume`. Order of the gates: a held lease refuses (read-only, nothing to
	 * confirm); a failed probe refuses (fail closed); a conversation this daemon never owned needs `confirm` because an
	 * idle TUI that resumed it holds no lease yet and would fork the conversation on its next write.
	 * A hosted session whose process died is dropped and its file resumed in a new process.
	 */
	async resume(id: string, confirm: boolean): Promise<HostedSession> {
		let conversation = this.#conversationOf(id);
		if (!conversation) {
			await this.refresh();
			conversation = this.#conversationOf(id);
		}
		const existing = this.#hostedFor(id, conversation);
		if (existing && existing.info.phase !== "closed") return existing;
		if (existing) {
			// #spawn returns the hosted session with the resumed id, so the dead one must be gone first.
			this.#hosted.delete(existing.id);
			await existing.close().catch(() => {});
			this.#changed();
			if (!conversation) {
				const file = existing.info.file;
				if (!file) throw new Error("this session ended before omp wrote it to disk; there is nothing to resume");
				return this.#spawn({ cwd: existing.info.cwd, resume: file }, [existing.id]);
			}
		}
		if (!conversation) throw new Error(`unknown session: ${id}`);
		if (conversation.backend === "antigravity") {
			if (!conversation.cwd) {
				throw new Error(
					"This Antigravity session has no recorded project directory, so it can only be viewed read-only.",
				);
			}
			return this.#spawn(
				{
					cwd: conversation.cwd,
					backend: "antigravity",
					resume: conversation.id,
					transcriptPath: conversation.path || undefined,
					initialTitle: conversation.title,
				},
				conversation.memberIds,
			);
		}
		let report: LeaseReport;
		try {
			report = await this.#probe(conversation.memberIds);
		} catch (error) {
			throw new Error(
				`cannot tell whether another omp process owns this session: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (conversation.memberIds.some(memberId => report.held.has(memberId))) {
			throw new SessionActionError(
				"This session is open in another omp process (its ownership lease is held), so it stays read-only here until that process exits.",
				"held",
			);
		}
		if (!confirm && !conversation.memberIds.some(memberId => this.#owned.has(memberId))) {
			throw new SessionActionError(
				"This session was not created by omp-web. If it is open and idle in a terminal, that terminal and omp-web would each continue it on their next message, splitting the conversation into two files. Confirm to take it over.",
				"confirm_takeover",
			);
		}
		return this.#spawn({ cwd: conversation.cwd, resume: conversation.path }, conversation.memberIds);
	}

	/** Copies a session into a new hosted session (`omp --fork`). The source is only read, so a held one can be forked. */
	async fork(id: string): Promise<HostedSession> {
		let conversation = this.#conversationOf(id);
		if (!conversation && !this.#hosted.has(id)) {
			await this.refresh();
			conversation = this.#conversationOf(id);
		}
		const hosted = this.#hostedFor(id, conversation);
		let source: { cwd: string; file: string | undefined };
		if (hosted) {
			if (!hosted.capabilities.fork) throw new Error("Antigravity sessions cannot be forked.");
			if (hosted.info.phase !== "idle") throw new Error("a session can only be forked while it is idle");
			source = { cwd: hosted.info.cwd, file: hosted.info.file };
		} else if (conversation) {
			if (conversation.backend === "antigravity") throw new Error("Antigravity sessions cannot be forked.");
			source = { cwd: conversation.cwd, file: conversation.path };
		} else {
			throw new Error(`unknown session: ${id}`);
		}
		if (!source.file) throw new Error("this session has not been written to disk yet; there is nothing to fork");
		return this.#spawn({ cwd: source.cwd, fork: source.file });
	}

	/** Renames a hosted session through its omp process, a stored one by rewriting its title slot (refused while another process holds it). */
	async rename(id: string, title: string): Promise<void> {
		const conversation = this.#conversationOf(id);
		const hosted = this.#hostedFor(id, conversation);
		if (hosted) {
			await hosted.rename(title);
			return;
		}
		if (!conversation) throw new Error(`unknown session: ${id}`);
		if (conversation.backend === "antigravity") {
			const registry = this.options.antigravity?.registry;
			if (!registry) throw new Error("Antigravity session renaming is not configured on this daemon.");
			registry.rename(conversation.id, title, {
				cwd: conversation.cwd,
				transcriptPath: conversation.path || undefined,
			});
			await this.refresh();
			return;
		}
		const rename =
			this.options.renameStored ?? ((path, name, cwd) => OmpSessionManager.renameSessionTitle(path, name, { cwd }));
		if ((await rename(conversation.path, title, conversation.cwd)) === null) {
			throw new SessionActionError(
				"The session is in use by another omp process or no longer available, so it cannot be renamed.",
				"held",
			);
		}
		await this.refresh();
	}

	async #spawn(requested: SessionSpec, replaces: string[] = [], cwdAlreadyResolved = false): Promise<HostedSession> {
		const spec = cwdAlreadyResolved ? requested : { ...requested, cwd: await this.options.resolveCwd(requested.cwd) };
		const info = await stat(spec.cwd).catch(() => null);
		if (!info?.isDirectory()) throw new Error(`cwd is not a directory: ${spec.cwd}`);
		const source = await this.#createSource(spec).catch((error: unknown) => {
			if (error instanceof AntigravityAuthError) throw new SessionActionError(error.message, "auth_required");
			const original = error instanceof Error ? error : new Error(String(error));
			throw this.options.explainSpawnError?.(original) ?? original;
		});
		let session: HostedSession;
		try {
			session = await HostedSession.attach({
				source,
				cwd: spec.cwd,
				onInfoChange: () => this.#changed(),
				goalContinuesOverRpc: async () => {
					const modes = await this.#readSetting("goal.continuationModes", spec.cwd);
					return Array.isArray(modes) && modes.includes("rpc");
				},
			});
		} catch (error) {
			await source.stop();
			throw error;
		}
		const existing = this.#hosted.get(session.id);
		if (existing) {
			// omp opened a session this daemon already hosts (e.g. a resume that resolved to the same newest copy).
			await session.close();
			return existing;
		}
		this.#hosted.set(session.id, session);
		this.#owned.add(session.id);
		for (const id of replaces) this.#stored.delete(id);
		for (const listener of this.#hostedListeners) listener(session);
		this.#changed();
		this.#replaced([session.id, ...replaces]);
		return session;
	}

	async #createSource(spec: SessionSpec): Promise<RpcSource> {
		if (this.options.createSource) return this.options.createSource(spec);
		if (spec.backend === "antigravity") {
			const binary = this.options.antigravity?.binary;
			if (!binary) {
				throw new Error(
					"Antigravity (`agy`) is not available on this machine (install `agy` or pass --antigravity).",
				);
			}
			const registry = this.options.antigravity?.registry;
			const source = new AntigravityAcpSource({
				binaryPath: binary.path,
				args: binary.args,
				authMethod: this.options.antigravity?.authMethod,
				mode: this.options.antigravity?.mode,
				permissionMode: spec.permissionMode ?? this.options.antigravity?.permissionMode,
				cwd: spec.cwd,
				model: spec.model,
				resumeSessionId: spec.resume,
				transcriptPath: spec.transcriptPath,
				initialTitle: spec.initialTitle,
				onMetadata: patch => {
					registry?.upsert({
						...patch,
						transcriptPath: spec.transcriptPath,
					});
				},
			});
			await source.start();
			return source;
		}
		const source = new OmpRpcSource({
			ompPath: this.options.ompPath,
			cwd: spec.cwd,
			model: spec.model,
			resume: spec.resume,
			fork: spec.fork,
			sessionDir: this.options.sessionDir,
			env: this.options.childEnv?.(),
		});
		await source.start();
		return source;
	}

	/**
	 * Marks sessions as taken by an environment switch (`opId`): `isReserved` tells the client layer to refuse commands to
	 * them until `release`. Names any id of the conversation: its other ids and the hosted id are covered too.
	 */
	reserve(opId: string, ids: readonly string[]): void {
		const held = this.#reserved.get(opId) ?? new Set<string>();
		for (const id of ids) held.add(id);
		this.#reserved.set(opId, held);
		this.#changed();
	}

	release(opId: string): void {
		if (this.#reserved.delete(opId)) this.#changed();
	}

	/** The operation that reserved the session `id` names (directly or through its conversation), if any. */
	isReserved(id: string): string | undefined {
		if (this.#reserved.size === 0) return undefined;
		const conversation = this.#conversationOf(id);
		const hosted = this.#hostedFor(id, conversation);
		const names = new Set([id, ...(conversation?.memberIds ?? [])]);
		if (hosted) {
			names.add(hosted.info.id);
			names.add(hosted.info.sessionId);
		}
		for (const [opId, held] of this.#reserved) for (const name of names) if (held.has(name)) return opId;
		return undefined;
	}

	/** The hosted session `id` names, without the "must be hosted" error `get` throws. */
	hosted(id: string): HostedSession | undefined {
		return this.#hostedFor(id, this.#conversationOf(id));
	}

	/** The indexed conversation containing the session file `path`, if any (for the environment switch's own bookkeeping). */
	conversationOfFile(path: string): Conversation | undefined {
		return this.#conversations.find(c => c.memberPaths.includes(path));
	}

	/** Starts a hosted copy of the session file `file` in `cwd` (`omp --fork`); the source is only read. */
	async forkFile(file: string, cwd: string): Promise<HostedSession> {
		return this.#spawn({ cwd, fork: file });
	}

	/**
	 * Starts a new hosted session in `cwd` for an environment switch whose source had no conversation yet. Unlike
	 * {@link create} it neither reuses nor closes other empty sessions: the switch reserves exactly the one it started.
	 */
	async startFresh(cwd: string): Promise<HostedSession> {
		return this.#spawn({ cwd });
	}

	/**
	 * Hosts the stored session file `file` again after an environment switch stopped it and was rolled back. No takeover
	 * confirmation: this daemon owned it before; a held lease (somebody else took it meanwhile) refuses.
	 */
	async restoreHosted(file: string, cwd: string): Promise<HostedSession> {
		await this.refresh();
		const conversation = this.conversationOfFile(file);
		if (conversation && (await this.#probe(conversation.memberIds)).held.size > 0) {
			throw new SessionActionError(
				"Another omp process holds this session now, so it was not hosted again.",
				"held",
			);
		}
		return this.#spawn({ cwd, resume: file }, conversation?.memberIds ?? []);
	}

	/** Whether another omp process holds the lease of any of `ids`. Throws when the probe fails (never read as free). */
	async leaseHeld(ids: readonly string[]): Promise<boolean> {
		return (await this.#probe(ids)).held.size > 0;
	}

	/**
	 * A short-lived fork of `file` in `cwd`, only to read the `get_state` a fresh omp would report there (system prompt,
	 * tools): it is not hosted and not listed. It does write a session file (`state.sessionFile`): the caller deletes it.
	 */
	async probeFork(file: string, cwd: string, settle?: SettledStateOptions): Promise<SettledState> {
		const spec: SessionSpec = { cwd: await this.options.resolveCwd(cwd), fork: file };
		const source = await this.#createSource(spec).catch((error: unknown) => {
			if (error instanceof AntigravityAuthError) throw new SessionActionError(error.message, "auth_required");
			const original = error instanceof Error ? error : new Error(String(error));
			throw this.options.explainSpawnError?.(original) ?? original;
		});
		try {
			// omp rebuilds its prompt when MCP servers connect after startup: read it once it stopped changing.
			return await settledState(() => source.getState(), settle);
		} finally {
			await source.stop();
		}
	}

	async close(id: string): Promise<void> {
		const session = this.#hosted.get(id);
		if (!session) throw new Error(`unknown session: ${id}`);
		await session.close();
		this.#hosted.delete(id);
		this.#changed();
		await this.refresh().catch(() => {});
		this.#replaced([id, session.info.sessionId]);
	}

	async closeAll(): Promise<void> {
		if (this.#poll) clearInterval(this.#poll);
		this.#poll = null;
		await Promise.all([...this.#hosted.values()].map(s => s.close().catch(() => {})));
		this.#hosted.clear();
	}
}
