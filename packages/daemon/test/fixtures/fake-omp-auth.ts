/**
 * A stand-in for `omp --mode rpc` as the credential process uses it: it answers `get_login_providers`,
 * `get_logout_accounts` and `logout`, and drives scripted `login` flows, emitting the same `extension_ui_request` frames
 * omp's RPC `login` does (`open_url`, `notify`, `input`). The scenario of a provider id is FAKE_SCENARIOS[id] (a JSON object),
 * else the id itself; the scenarios:
 *
 * - `oauth`: open_url (http), progress, an `input` for the authorization code; completes when the answer arrives;
 * - `callback`: open_url, progress, completes by itself after FAKE_LOGIN_DELAY_MS;
 * - `badurl`: open_url with a javascript: URL, then completes;
 * - `secret`: an `input` marked `secret` (which real omp refuses before emitting; here to prove the gateway does too);
 * - `typed`: an `input` that is not marked secret but asks for an API key, after an open_url (what omp 18.19 sends for key providers);
 * - `fail`: the login command fails with an error.
 * The pid and every answer received are appended to FAKE_OMP_LOG.
 */
import { appendFileSync } from "node:fs";

const log = (line: string): void => {
	if (process.env.FAKE_OMP_LOG) appendFileSync(process.env.FAKE_OMP_LOG, `${line}\n`);
};
const emit = (frame: object): void => console.log(JSON.stringify(frame));
log(
	`start pid=${process.pid} url=${process.env.OMP_AUTH_BROKER_URL ?? "-"} token=${process.env.OMP_AUTH_BROKER_TOKEN ? "set" : "-"} agentdir=${process.env.PI_CODING_AGENT_DIR ?? "-"} profile=${process.env.PI_PROFILE ?? "-"} argv=${process.argv.slice(2).join(" ")}`,
);

emit({
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1],
	maxFrameBytes: 1048576,
	maxReassembledFrameBytes: 67108864,
});

const answers = new Map<string, (value: string | undefined) => void>();
let requestSeq = 0;
const ask = (frame: object): Promise<string | undefined> => {
	const id = `ui-${++requestSeq}`;
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	answers.set(id, resolve);
	emit({ type: "extension_ui_request", id, ...frame });
	return promise;
};
const respond = (id: unknown, command: string, data: unknown): void =>
	emit({ type: "response", id, command, success: true, data });
const fail = (id: unknown, command: string, error: string): void =>
	emit({ type: "response", id, command, success: false, error });

const scenarios = JSON.parse(process.env.FAKE_SCENARIOS ?? "{}") as Record<string, string>;
const PROVIDERS = ["anthropic", "stencil", "kimi-code", "deepseek", "a-provider-from-the-future", "fail"];

async function login(id: unknown, providerId: string): Promise<void> {
	switch (scenarios[providerId] ?? providerId) {
		case "oauth": {
			emit({
				type: "extension_ui_request",
				id: "url-1",
				method: "open_url",
				url: "https://claude.ai/oauth/authorize?x=1",
				launchUrl: "http://localhost:54545/launch",
				instructions: "Complete login in your browser.",
			});
			emit({
				type: "extension_ui_request",
				id: "n-1",
				method: "notify",
				message: "Waiting for browser authentication...",
				notifyType: "info",
			});
			const code = await ask({
				method: "input",
				title: "Paste the authorization code (or full redirect URL):",
				timeout: 600000,
			});
			log(`answer ${code ?? "(cancelled)"}`);
			if (code === undefined) return fail(id, "login", "cancelled");
			return respond(id, "login", { providerId });
		}
		case "callback":
			emit({
				type: "extension_ui_request",
				id: "url-1",
				method: "open_url",
				url: "https://example.invalid/authorize",
			});
			await Bun.sleep(Number(process.env.FAKE_LOGIN_DELAY_MS ?? 50));
			return respond(id, "login", { providerId });
		case "badurl":
			emit({
				type: "extension_ui_request",
				id: "url-1",
				method: "open_url",
				url: "javascript:alert(document.cookie)",
			});
			emit({ type: "extension_ui_request", id: "url-2", method: "open_url", url: "https://example.invalid/ok" });
			await Bun.sleep(50);
			return respond(id, "login", { providerId });
		case "secret": {
			emit({
				type: "extension_ui_request",
				id: "url-1",
				method: "open_url",
				url: "https://example.invalid/key-page",
			});
			const value = await ask({ method: "input", title: "Paste your API key", secret: true });
			log(`secret answered: ${value}`);
			return respond(id, "login", { providerId });
		}
		case "typed": {
			emit({
				type: "extension_ui_request",
				id: "url-1",
				method: "open_url",
				url: "https://platform.example.invalid/api_keys",
				instructions: "Create or copy your API key",
			});
			const value = await ask({ method: "input", title: "Paste your API key", placeholder: "sk-..." });
			log(`typed answered: ${value}`);
			return respond(id, "login", { providerId });
		}
		default:
			return fail(id, "login", `Unknown OAuth provider: ${providerId}`);
	}
}

for await (const line of console) {
	if (line.trim() === "") continue;
	const message = JSON.parse(line) as {
		id?: string;
		type?: string;
		providerId?: string;
		credentialId?: number;
		value?: string;
		cancelled?: boolean;
	};
	switch (message.type) {
		case "get_login_providers":
			respond(message.id, "get_login_providers", {
				providers: PROVIDERS.map(id => ({
					id,
					name: `Provider ${id}`,
					available: true,
					authenticated: id === "anthropic",
				})),
			});
			break;
		case "get_logout_accounts":
			respond(message.id, "get_logout_accounts", {
				accounts:
					message.providerId === "anthropic"
						? [
								{
									credentialId: 7,
									provider: "anthropic",
									label: "me@example.invalid",
									detail: "oauth #7",
									type: "oauth",
									active: true,
								},
							]
						: [],
			});
			break;
		case "logout":
			log(`logout ${message.providerId} ${message.credentialId}`);
			respond(message.id, "logout", {});
			break;
		case "login":
			void login(message.id, String(message.providerId));
			break;
		case "extension_ui_response": {
			const resolve = answers.get(String(message.id));
			answers.delete(String(message.id));
			resolve?.(message.cancelled ? undefined : message.value);
			break;
		}
	}
}
