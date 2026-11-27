import { RpcClient, type RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcFrameDecoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type {
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcPromptResultFrame,
	RpcSubagentSubscriptionLevel,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { RpcSource, SideChannelFrame } from "./rpc-source";

export interface OmpSourceOptions {
	/** Absolute path of the `omp` binary. */
	ompPath: string;
	cwd: string;
	/** `provider/modelId`, passed through `--model`. */
	model?: string;
	/** Overrides omp's session directory (default: omp's own, so TUI sees the sessions too). */
	sessionDir?: string;
	/** Session file to open with `--resume` (omp opens the newest copy if the conversation moved on). */
	resume?: string;
	/** Session file to copy into a new session with `--fork`. */
	fork?: string;
	/** Extra environment for the child on top of the daemon's own (the credential broker's URL and token). */
	env?: Record<string, string>;
}

export function isUiRequest(value: unknown): value is RpcExtensionUIRequest {
	return isRecord(value) && value.type === "extension_ui_request" && typeof value.id === "string";
}

/**
 * Environment of the omp child. `PI_RPC_EMIT_TITLE`: omp only forwards an extension's `setTitle` over RPC when asked to
 * (rpc-mode `shouldEmitRpcTitles`); the web shows it, so the daemon always asks. `extra` is what this daemon adds on top of
 * its own environment, i.e. `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` when the machine uses the gateway's broker.
 */
export function ompChildEnv(
	base: Record<string, string | undefined>,
	extra: Record<string, string> = {},
): Record<string, string | undefined> {
	return { ...base, ...extra, PI_RPC_EMIT_TITLE: "1" };
}

/** How many trailing stderr lines an unexpected exit reports. */
const EXIT_STDERR_LINES = 8;
const EXIT_STDERR_MAX_CHARS = 1500;
/** How long an exit waits for the stdout tap to finish reading what omp wrote before it died. */
const TAP_SETTLE_MS = 250;

/** `base`, plus why the daemon stopped reading (if it did) and the tail of omp's stderr: the exit code alone says nothing. */
export function exitReason(base: string, readError: string | null, stderr: string): string {
	const parts = [base];
	if (readError) parts.push(`reading omp's output failed: ${readError}`);
	const tail = stderr
		.split(/\r?\n/)
		.map(line => line.trimEnd())
		.filter(Boolean)
		.slice(-EXIT_STDERR_LINES)
		.join("\n");
	if (tail)
		parts.push(`stderr:\n${tail.length > EXIT_STDERR_MAX_CHARS ? `…${tail.slice(-EXIT_STDERR_MAX_CHARS)}` : tail}`);
	return parts.join("\n");
}

function isSideChannelFrame(value: unknown): value is SideChannelFrame {
	if (!isRecord(value)) return false;
	if (value.type === "command_output") return typeof value.text === "string";
	return value.type === "session_info_update" || value.type === "config_update";
}

/**
 * Hands a tapped frame to each listener. A listener that throws must not end the tap: the tap also carries the responses
 * of raw commands (`get_entries`, `compact`), which would then all time out while omp keeps running.
 */
function deliver<T>(listeners: Iterable<(value: T) => void>, value: T): void {
	for (const listener of listeners) {
		try {
			listener(value);
		} catch (error) {
			console.error("omp-webd: omp frame listener failed:", error);
		}
	}
}

/** `compact` summarizes with the model and can run far longer than a normal command. */
const COMPACT_TIMEOUT_MS = 300_000;

/**
 * omp answers `get_entries` on its serial command queue, so it waits behind whatever runs there (`compact`, `abort`
 * while a turn winds down, `get_available_models` refreshing catalogs). `RpcClient`'s fixed 30 s would fail the entry
 * sync while omp is merely busy; wait as long as the longest command the daemon queues.
 */
const ENTRIES_TIMEOUT_MS = COMPACT_TIMEOUT_MS;

/**
 * `RpcSource` over upstream `RpcClient` driving `omp --mode rpc-ui`.
 *
 * `RpcClient` hard-codes `--mode rpc` and keeps its extension-UI listener set private (only `login()` uses it), but rpc-ui
 * needs a general `extension_ui_request` feed and a way to answer. So the child is launched through `RpcClient`'s
 * `spawn` transport hook: stdout is tee'd, one branch to the client, the other to a tap that surfaces `ready` and
 * `extension_ui_request` frames and answers to the few raw commands `RpcClient` has no method for. Responses are
 * written straight to the child's stdin (one whole line per write).
 */
export class OmpRpcSource implements RpcSource {
	readonly #client: RpcClient;
	#stdin: { write(data: string): unknown } | null = null;
	#uiListeners = new Set<(r: RpcExtensionUIRequest) => void>();
	#sideListeners = new Set<(frame: SideChannelFrame) => void>();
	#exitListeners = new Set<(reason: string) => void>();
	#rawWaiters = new Map<string, (response: Record<string, unknown>) => void>();
	#rawSeq = 0;
	#ready: { supportedProtocolVersions: unknown } | null = null;
	#exited = false;
	#stopping = false;
	/** Why the daemon stopped reading omp's stdout early (a frame it could not decode); omp then dies on EPIPE. */
	#readError: string | null = null;

	constructor(private readonly options: OmpSourceOptions) {
		this.#client = new RpcClient({
			cwd: options.cwd,
			sessionDir: options.sessionDir,
			spawn: agentArgs => this.#spawn(agentArgs),
		});
	}

	/** Spawns the child and starts the protocol handshake. Rejects if omp does not offer protocol v2. */
	async start(): Promise<void> {
		await this.#client.start();
		const versions = this.#ready?.supportedProtocolVersions;
		if (!Array.isArray(versions) || !versions.includes(2)) {
			await this.stop();
			throw new Error(`omp ready frame offers no usable protocol version (supported: ${JSON.stringify(versions)})`);
		}
	}

	#spawn(agentArgs: string[]): RpcAgentProcess {
		// RpcClient builds ["--mode","rpc", ...]; we own the argv and swap the mode. Fail loudly if upstream changes that.
		if (agentArgs[0] !== "--mode" || agentArgs[1] !== "rpc") {
			throw new Error(`unexpected RpcClient argv, cannot switch to rpc-ui: ${JSON.stringify(agentArgs)}`);
		}
		const argv = [this.options.ompPath, "--mode", "rpc-ui", ...agentArgs.slice(2)];
		if (this.options.model) argv.push("--model", this.options.model);
		if (this.options.resume) argv.push("--resume", this.options.resume);
		if (this.options.fork) argv.push("--fork", this.options.fork);
		const child = ptree.spawn(argv, {
			cwd: this.options.cwd,
			env: ompChildEnv(Bun.env, this.options.env),
			stdin: "pipe",
		});
		this.#stdin = child.stdin;
		const [forClient, forTap] = child.stdout.tee();
		const tapped = this.#tap(forTap);
		void child.exited
			.then(
				code => `omp exited with code ${code}`,
				(err: unknown) => `omp exited: ${err instanceof Error ? err.message : String(err)}`,
			)
			.then(async base => {
				// The tap drains what omp wrote before it died: wait for it (bounded) so a decode failure makes it into the reason.
				await Promise.race([tapped, Bun.sleep(TAP_SETTLE_MS)]);
				this.#handleExit(exitReason(base, this.#readError, child.peekStderr()));
			});
		return {
			stdin: child.stdin,
			stdout: forClient,
			peekStderr: () => child.peekStderr(),
			kill: (signal, graceMs) => child.kill(signal, graceMs),
			exited: child.exited,
		};
	}

	async #tap(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new RpcFrameDecoder();
		try {
			for await (const line of readJsonl(stream)) {
				const frame = decoder.push(line);
				if (!frame) continue;
				if (isRecord(frame) && frame.type === "ready")
					this.#ready = { supportedProtocolVersions: frame.supportedProtocolVersions };
				else if (isUiRequest(frame)) deliver(this.#uiListeners, frame);
				else if (isSideChannelFrame(frame)) deliver(this.#sideListeners, frame);
				else if (isRecord(frame) && frame.type === "response" && typeof frame.id === "string") {
					const waiter = this.#rawWaiters.get(frame.id);
					if (waiter) {
						this.#rawWaiters.delete(frame.id);
						waiter(frame);
					}
				}
			}
		} catch (error) {
			// The child's exit reports it (omp exits once nobody reads its stdout); keep the cause for that reason.
			this.#readError = error instanceof Error ? error.message : String(error);
		}
	}

	#handleExit(reason: string): void {
		if (this.#exited) return;
		this.#exited = true;
		for (const waiter of this.#rawWaiters.values()) waiter({ success: false, error: reason });
		this.#rawWaiters.clear();
		if (this.#stopping) return;
		console.warn(`omp-webd: ${reason}`);
		for (const l of this.#exitListeners) l(reason);
	}

	/** Sends a command `RpcClient` has no method for and awaits its response frame. */
	async #raw(command: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
		if (!this.#stdin || this.#exited) throw new Error("omp process is not running");
		const id = `web_${++this.#rawSeq}`;
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		this.#rawWaiters.set(id, resolve);
		this.#stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		const timer = setTimeout(() => {
			if (this.#rawWaiters.delete(id))
				resolve({ success: false, error: `timeout waiting for ${String(command.type)}` });
		}, timeoutMs);
		try {
			return await promise;
		} finally {
			clearTimeout(timer);
		}
	}

	onSessionEvent: RpcSource["onSessionEvent"] = listener => {
		this.#client.onSessionEvent(listener);
	};
	onExtensionUi: RpcSource["onExtensionUi"] = listener => {
		this.#uiListeners.add(listener);
	};
	onPromptResult: RpcSource["onPromptResult"] = (listener: (r: RpcPromptResultFrame) => void) => {
		this.#client.onPromptResult(listener);
	};
	onSessionSettled: RpcSource["onSessionSettled"] = listener => {
		this.#client.onSessionSettled(listener);
	};
	onAvailableCommands: RpcSource["onAvailableCommands"] = listener => {
		this.#client.onAvailableCommandsUpdate(listener);
	};
	onSideChannel: RpcSource["onSideChannel"] = listener => {
		this.#sideListeners.add(listener);
	};
	onSubagentLifecycle: RpcSource["onSubagentLifecycle"] = listener => {
		this.#client.onSubagentLifecycle(listener);
	};
	onSubagentProgress: RpcSource["onSubagentProgress"] = listener => {
		this.#client.onSubagentProgress(listener);
	};
	onBtwRecord: RpcSource["onBtwRecord"] = listener => {
		this.#client.onBtwRecord(listener);
	};
	onBtwDelta: RpcSource["onBtwDelta"] = listener => {
		this.#client.onBtwDelta(listener);
	};
	btw: RpcSource["btw"] = (question, recordId) => this.#client.btw(question, recordId);
	cancelBtw: RpcSource["cancelBtw"] = recordId => this.#client.cancelBtw(recordId);
	getBtwHistory: RpcSource["getBtwHistory"] = () => this.#client.getBtwHistory();
	goal: RpcSource["goal"] = (op, options) => this.#client.goal(op, options);
	onExit: RpcSource["onExit"] = listener => {
		this.#exitListeners.add(listener);
	};
	getState: RpcSource["getState"] = () => this.#client.getState();
	getEntries: RpcSource["getEntries"] = async since => {
		const response = await this.#raw({ type: "get_entries", since }, ENTRIES_TIMEOUT_MS);
		if (response.success !== true) throw new Error(String(response.error ?? "get_entries failed"));
		return response.data as { entries: SessionEntry[]; leafId: string | null };
	};
	getAvailableCommands: RpcSource["getAvailableCommands"] = () => this.#client.getAvailableCommands();
	getAvailableModels: RpcSource["getAvailableModels"] = () => this.#client.getAvailableModels();
	getAvailableThinkingLevels: RpcSource["getAvailableThinkingLevels"] = () =>
		this.#client.getAvailableThinkingLevels();
	async setModel(provider: string, modelId: string): Promise<void> {
		await this.#client.setModel(provider, modelId);
	}
	async setThinkingLevel(level: string): Promise<void> {
		// HostedSession only passes levels `get_available_thinking_levels` listed.
		await this.#client.setThinkingLevel(level as Parameters<RpcClient["setThinkingLevel"]>[0]);
	}
	async compact(instructions?: string): Promise<void> {
		const response = await this.#raw({ type: "compact", customInstructions: instructions }, COMPACT_TIMEOUT_MS);
		if (response.success !== true) throw new Error(String(response.error ?? "compact failed"));
	}
	followUp: RpcSource["followUp"] = (message, images) => this.#client.followUp(message, images);
	removeQueuedMessage: RpcSource["removeQueuedMessage"] = (message, queue) =>
		this.#client.removeQueuedMessage(message, queue);
	async setSubagentSubscription(level: RpcSubagentSubscriptionLevel): Promise<void> {
		await this.#client.setSubagentSubscription(level);
	}
	getSubagents: RpcSource["getSubagents"] = () => this.#client.getSubagents();
	getSubagentMessages: RpcSource["getSubagentMessages"] = (subagentId, fromByte) =>
		this.#client.getSubagentMessages({ subagentId, fromByte });
	// A prompt that loses the race against a run starting (loop, background job, another client) queues as a
	// follow-up instead of failing with "Agent is already processing" (same as the antigravity source).
	prompt: RpcSource["prompt"] = async (message, images) => {
		await this.#client.prompt(message, images, "followUp");
	};
	steer: RpcSource["steer"] = (message, images) => this.#client.steer(message, images);
	abort(): Promise<void> {
		return this.#client.abort();
	}
	respondUi(response: RpcExtensionUIResponse): void {
		if (!this.#stdin || this.#exited) throw new Error("omp process is not running");
		this.#stdin.write(`${JSON.stringify(response)}\n`);
	}
	async enableAskDialog(): Promise<void> {
		const response = await this.#raw({ type: "set_ask_dialog", enabled: true });
		if (response.success !== true) throw new Error(`set_ask_dialog failed: ${String(response.error)}`);
	}
	async setSessionName(name: string): Promise<void> {
		const response = await this.#raw({ type: "set_session_name", name });
		if (response.success !== true) throw new Error(String(response.error ?? "set_session_name failed"));
	}
	async stop(): Promise<void> {
		this.#stopping = true;
		await this.#client.stop();
	}
}
