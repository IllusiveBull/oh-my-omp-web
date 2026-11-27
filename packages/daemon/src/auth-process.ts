import { mkdirPrivate } from "./secrets";
import { RpcClient, type RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcFrameDecoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { RpcExtensionUIRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { join } from "node:path";
import { ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { UiResponseBody } from "@omp-web/protocol";
import { isUiRequest } from "./omp-source";
import { mapUiRequest, toRpcUiResponse } from "./ui-request";

/** One entry of `get_login_providers`. */
export interface LoginProviderInfo {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
}

/** One entry of `get_logout_accounts` (upstream's `LogoutAccount`, which carries no secret material). */
export interface LogoutAccountInfo {
	credentialId: number;
	provider: string;
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
}

/** What omp's `login` command emits while it runs, reduced to what the flow needs. */
export type LoginEvent =
	/** `open_url`: the sign-in link (already restricted to http(s)). */
	| { kind: "link"; url: string; launchUrl?: string; instructions?: string }
	/** An `input` request: the authorization-code prompt, or something the flow must refuse (`secret`). */
	| { kind: "prompt"; id: string; title: string; placeholder?: string; secret: boolean }
	/** Any other interactive request (select, confirm, editor, ask): RPC login cannot be driven through it. */
	| { kind: "unsupported"; method: string }
	| { kind: "progress"; level: "info" | "warning" | "error"; message: string }
	/** omp withdrew a pending prompt (timeout). */
	| { kind: "prompt_cancelled"; id: string };

export interface LoginRun {
	/** Resolves when omp's `login` response arrives; rejects with omp's own error message. */
	done: Promise<void>;
	/** Answers a prompt the run emitted. Throws when the process is gone. */
	answer(promptId: string, response: UiResponseBody): void;
}

/**
 * The long-lived omp RPC process on the gateway machine that does the credential work: listing providers and
 * accounts, signing in, signing out. All of its credential traffic goes to the broker when `OMP_AUTH_BROKER_URL` is in
 * its environment, which is how one sign-in here reaches every machine.
 */
export interface AuthProcess {
	providers(): Promise<LoginProviderInfo[]>;
	accounts(providerId: string): Promise<LogoutAccountInfo[]>;
	logout(providerId: string, credentialId: number): Promise<{ remainingSource?: string }>;
	/** Starts omp's `login` for the provider; `onEvent` receives the link, the prompts and the progress. */
	login(providerId: string, onEvent: (event: LoginEvent) => void): LoginRun;
	/** Fires once when the process ends without `kill` / `stop` having been asked for. */
	onExit(listener: (reason: string) => void): void;
	/** Ends the process now: omp's `login` has no cancel, and killing it frees its callback port and drops the flow. */
	kill(): Promise<void>;
	stop(): Promise<void>;
}

export interface OmpAuthProcessOptions {
	/** Absolute path of the omp binary. */
	ompPath: string;
	/** An empty directory to run in, so omp finds no project settings. */
	cwd: string;
	/** Environment of the child: the daemon's own plus the broker's URL and token. */
	env: Record<string, string | undefined>;
	/**
	 * The child's own agent directory (`PI_CODING_AGENT_DIR`): it holds the placeholder model below and keeps the user's
	 * settings out of this process. Credentials do not live here (they are the broker's).
	 */
	agentDir: string;
}

/**
 * omp refuses to start a non-interactive process without a usable model ("No default model selected", exit 1), and a broker
 * that nobody has signed in to yet offers none, which is exactly when this process is needed to sign in. So it is started
 * with a placeholder model of its own: a local provider whose key is a literal that is not a credential, on a port nothing
 * listens on. No request is ever made to it. (Using a real provider's API key would make omp report that provider as signed in.)
 */
export const PLACEHOLDER_MODEL = "omp-web/placeholder";
export const PLACEHOLDER_MODELS_YML = `providers:
  omp-web:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    apiKey: omp-web-placeholder-not-a-credential
    models:
      - id: placeholder
        name: omp-web placeholder (never called)
`;

/** Creates `agentDir` with the placeholder `models.yml` (idempotent). */
export async function prepareAgentDir(agentDir: string): Promise<void> {
	await mkdirPrivate(agentDir);
	const file = join(agentDir, "models.yml");
	if (
		(await Bun.file(file)
			.text()
			.catch(() => null)) !== PLACEHOLDER_MODELS_YML
	)
		await Bun.write(file, PLACEHOLDER_MODELS_YML);
}

/** Variables that would move the child's agent directory away from `agentDir` (profiles) or point it at another broker. */
const STRIPPED_ENV = ["PI_PROFILE", "OMP_PROFILE"];

/** Flags that keep the RPC process to what it is for: no session file, no extensions, no tools, no model call. */
const QUIET_FLAGS = [
	"--model",
	PLACEHOLDER_MODEL,
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-lsp",
	"--no-context-files",
	"--no-title",
	"--no-tools",
];

/**
 * `AuthProcess` over upstream `RpcClient` driving `omp --mode rpc`. The client's own `login()` is used for the command
 * (it owns the 10 minute response timeout), but not for the prompts: its callbacks skip `secret: true` inputs silently,
 * and the gateway has to see every interactive request to refuse the ones it must not forward. So the child's stdout is
 * tee'd to a tap, as in `OmpRpcSource`, and answers go straight to the child's stdin.
 */
export class OmpAuthProcess implements AuthProcess {
	readonly #client: RpcClient;
	#stdin: { write(data: string): unknown } | null = null;
	#child: RpcAgentProcess | null = null;
	#listeners = new Set<(request: RpcExtensionUIRequest) => void>();
	#exitListeners = new Set<(reason: string) => void>();
	#ending = false;
	#exited = false;

	constructor(private readonly options: OmpAuthProcessOptions) {
		this.#client = new RpcClient({ cwd: options.cwd, spawn: agentArgs => this.#spawn(agentArgs) });
	}

	/** Writes the placeholder model, spawns omp and waits for its ready frame. */
	async start(): Promise<void> {
		await mkdirPrivate(this.options.agentDir);
		const file = join(this.options.agentDir, "models.yml");
		if (
			(await Bun.file(file)
				.text()
				.catch(() => null)) !== PLACEHOLDER_MODELS_YML
		) {
			await Bun.write(file, PLACEHOLDER_MODELS_YML);
		}
		await this.#client.start();
	}

	#spawn(agentArgs: string[]): RpcAgentProcess {
		const env: Record<string, string | undefined> = {
			...this.options.env,
			PI_CODING_AGENT_DIR: this.options.agentDir,
		};
		for (const name of STRIPPED_ENV) delete env[name];
		const child = ptree.spawn([this.options.ompPath, ...agentArgs, ...QUIET_FLAGS], {
			cwd: this.options.cwd,
			env,
			stdin: "pipe",
		});
		this.#stdin = child.stdin;
		const [forClient, forTap] = child.stdout.tee();
		void this.#tap(forTap);
		void child.exited.then(
			code => this.#handleExit(`omp exited with code ${code}`),
			error => this.#handleExit(`omp exited: ${error instanceof Error ? error.message : String(error)}`),
		);
		this.#child = {
			stdin: child.stdin,
			stdout: forClient,
			peekStderr: () => child.peekStderr(),
			kill: (signal, graceMs) => child.kill(signal, graceMs),
			exited: child.exited,
		};
		return this.#child;
	}

	async #tap(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new RpcFrameDecoder();
		try {
			for await (const line of readJsonl(stream)) {
				const frame = decoder.push(line);
				if (isUiRequest(frame)) for (const listener of this.#listeners) listener(frame);
			}
		} catch {
			// a broken stream surfaces through the child's exit
		}
	}

	#handleExit(reason: string): void {
		if (this.#exited) return;
		this.#exited = true;
		if (this.#ending) return;
		for (const listener of this.#exitListeners) listener(reason);
	}

	providers(): Promise<LoginProviderInfo[]> {
		return this.#client.getLoginProviders();
	}

	async accounts(providerId: string): Promise<LogoutAccountInfo[]> {
		const accounts = await this.#client.getLogoutAccounts(providerId);
		return accounts.map(a => ({
			credentialId: a.credentialId,
			provider: a.provider,
			label: a.label,
			detail: a.detail,
			type: a.type,
			active: a.active,
		}));
	}

	logout(providerId: string, credentialId: number): Promise<{ remainingSource?: string }> {
		return this.#client.logout(providerId, credentialId);
	}

	login(providerId: string, onEvent: (event: LoginEvent) => void): LoginRun {
		const listener = (request: RpcExtensionUIRequest): void => {
			const mapped = mapUiRequest(request);
			switch (mapped.kind) {
				case "open_url":
					onEvent({
						kind: "link",
						url: mapped.url,
						launchUrl: mapped.launchUrl,
						instructions: mapped.instructions,
					});
					break;
				case "notify":
					onEvent({ kind: "progress", level: mapped.level, message: mapped.message });
					break;
				case "cancel":
					onEvent({ kind: "prompt_cancelled", id: mapped.targetId });
					break;
				case "request":
					if (mapped.request.method === "input") {
						onEvent({
							kind: "prompt",
							id: mapped.request.id,
							title: mapped.request.title,
							placeholder: mapped.request.placeholder,
							secret: mapped.request.secret === true,
						});
					} else {
						onEvent({ kind: "unsupported", method: mapped.request.method });
					}
					break;
				default:
					break;
			}
		};
		this.#listeners.add(listener);
		const done = this.#client.login(providerId).then(
			() => {},
			(error: unknown) => {
				throw error instanceof Error ? error : new Error(String(error));
			},
		);
		void done.then(
			() => this.#listeners.delete(listener),
			() => this.#listeners.delete(listener),
		);
		return {
			done,
			answer: (promptId, response) => {
				if (!this.#stdin || this.#exited) throw new Error("the omp process is not running");
				this.#stdin.write(`${JSON.stringify(toRpcUiResponse(promptId, response))}\n`);
			},
		};
	}

	onExit(listener: (reason: string) => void): void {
		this.#exitListeners.add(listener);
	}

	async kill(): Promise<void> {
		this.#ending = true;
		this.#listeners.clear();
		await this.#client.stop();
	}

	stop(): Promise<void> {
		return this.kill();
	}
}
