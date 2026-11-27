import { dlopen, FFIType, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AntigravityUsageAck, UsageLimitWire } from "@omp-web/protocol";

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";

const SUMMARY_WINDOW_MS = new Map<string, number>([
	["5h", 5 * 60 * 60_000],
	["weekly", 7 * 24 * 60 * 60_000],
]);

const REQUEST_TIMEOUT_MS = 10_000;
const KEYRING_TIMEOUT_MS = 5_000;
const EXPIRY_MARGIN_MS = 60_000;

export function antigravityUserAgent(
	platform: NodeJS.Platform = process.platform,
	arch: NodeJS.Architecture = process.arch,
): string {
	return `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${arch}; cl=963137146)`;
}

/**
 * Decodes a secret stored by Go's `go-keyring` library (used by `agy` CLI 1.5+).
 * On macOS/Linux `go-keyring` prefixes encoded values with `go-keyring-base64:` or `go-keyring-encoded:` (hex).
 * Also handles hex-encoded blobs returned by macOS `security find-generic-password -w` when raw bytes are non-ASCII.
 */
export function decodeGoKeyringSecret(secret: string | Uint8Array): string {
	const raw = typeof secret === "string" ? secret.trim() : new TextDecoder().decode(secret).trim();
	const text =
		/^[0-9a-fA-F]+$/.test(raw) && raw.length >= 16 && raw.length % 2 === 0
			? Buffer.from(raw, "hex").toString("utf8").trim()
			: raw;
	if (text.startsWith("go-keyring-base64:")) {
		return Buffer.from(text.slice("go-keyring-base64:".length), "base64").toString("utf8");
	}
	if (text.startsWith("go-keyring-encoded:")) {
		return Buffer.from(text.slice("go-keyring-encoded:".length), "hex").toString("utf8");
	}
	return text;
}

/**
 * Reads a generic credential from the Windows Credential Manager, where `go-keyring` stores `service:username`
 * with the secret as the raw credential blob.
 */
function readWindowsCredential(target: string): string | undefined {
	const advapi = dlopen("advapi32.dll", {
		CredReadW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		CredFree: { args: [FFIType.ptr], returns: FFIType.void },
	});
	try {
		const name = Buffer.from(`${target}\0`, "utf16le");
		const out = new BigUint64Array(1);
		// CRED_TYPE_GENERIC = 1.
		if (!advapi.symbols.CredReadW(ptr(name), 1, 0, ptr(out))) return undefined;
		const credential = read.ptr(ptr(out), 0) as Pointer;
		try {
			// x64 CREDENTIALW: CredentialBlobSize at 32, CredentialBlob at 40.
			const size = read.u32(credential, 32);
			const blob = read.ptr(credential, 40) as Pointer;
			if (!size || !blob) return undefined;
			return new TextDecoder().decode(new Uint8Array(toArrayBuffer(blob, 0, size)));
		} finally {
			advapi.symbols.CredFree(credential);
		}
	} finally {
		advapi.close();
	}
}

/** Reads `agy` CLI 1.5+'s stored OAuth credential from the OS keyring (`service: "gemini"`, `account: "antigravity"`). */
export async function readSystemKeyringSecret(
	platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
	if (platform === "win32") {
		try {
			const secret = readWindowsCredential("gemini:antigravity")?.trim();
			return secret ? decodeGoKeyringSecret(secret) : undefined;
		} catch {
			return undefined;
		}
	}
	let cmd: string[] | null = null;
	if (platform === "darwin") {
		cmd = ["security", "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"];
	} else if (platform === "linux") {
		cmd = ["secret-tool", "lookup", "service", "gemini", "username", "antigravity"];
	}
	if (!cmd) return undefined;

	let proc: ReturnType<typeof Bun.spawn> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		const timedOut = new Promise<null>(resolve => {
			timer = setTimeout(() => {
				try {
					proc?.kill();
				} catch {
					// Already exited.
				}
				resolve(null);
			}, KEYRING_TIMEOUT_MS);
		});
		const result = await Promise.race([
			(async () => {
				const [exitCode, stdout] = await Promise.all([
					proc!.exited,
					new Response(proc!.stdout as ReadableStream).text(),
				]);
				return { exitCode, stdout };
			})(),
			timedOut,
		]);
		if (!result || result.exitCode !== 0) return undefined;
		const trimmed = result.stdout.trim();
		return trimmed ? decodeGoKeyringSecret(trimmed) : undefined;
	} catch {
		return undefined;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

interface LegacyTokenFile {
	client_id: string;
	client_secret: string;
	refresh_token: string;
	project_id?: string;
}

interface CliTokenFile {
	access_token: string;
	refresh_token?: string;
	expiry?: string;
}

function parseLegacyToken(raw: string): LegacyTokenFile | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return undefined;
		if (
			typeof parsed.client_id !== "string" ||
			!parsed.client_id ||
			typeof parsed.client_secret !== "string" ||
			!parsed.client_secret ||
			typeof parsed.refresh_token !== "string" ||
			!parsed.refresh_token
		) {
			return undefined;
		}
		return {
			client_id: parsed.client_id,
			client_secret: parsed.client_secret,
			refresh_token: parsed.refresh_token,
			...(typeof parsed.project_id === "string" && parsed.project_id ? { project_id: parsed.project_id } : {}),
		};
	} catch {
		return undefined;
	}
}

function parseCliToken(raw: string): CliTokenFile | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return undefined;
		const inner = isRecord(parsed.token) ? parsed.token : parsed;
		if (typeof inner.access_token !== "string" || !inner.access_token) return undefined;
		return {
			access_token: inner.access_token,
			...(typeof inner.refresh_token === "string" && inner.refresh_token
				? { refresh_token: inner.refresh_token }
				: {}),
			...(typeof inner.expiry === "string" && inner.expiry ? { expiry: inner.expiry } : {}),
		};
	} catch {
		return undefined;
	}
}

const finite = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;
const nonEmpty = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

function statusOf(usedFraction: number): UsageLimitWire["status"] {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.8) return "warning";
	return "ok";
}

function makeQuotaLimit(
	id: string,
	label: string,
	remainingFraction: number | undefined,
	resetTime: string | undefined,
	options: { windowId?: string; windowLabel?: string; durationMs?: number; description?: string } = {},
): UsageLimitWire | undefined {
	if (remainingFraction === undefined || !Number.isFinite(remainingFraction)) return undefined;
	const usedFraction = 1 - Math.max(0, Math.min(1, remainingFraction));
	const parsedReset = resetTime ? Date.parse(resetTime) : Number.NaN;
	const resetsAt = Number.isFinite(parsedReset) ? parsedReset : undefined;
	return {
		id,
		label,
		...(options.windowLabel ? { windowLabel: options.windowLabel } : {}),
		...(options.windowId ? { windowId: options.windowId } : {}),
		...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
		usedFraction,
		status: statusOf(usedFraction),
		unit: "percent",
		...(options.description ? { notes: [options.description] } : {}),
	};
}

/**
 * Untouched summary buckets report a rolling full-window reset (`now + windowDuration ± 60s`).
 * Omit those synthetic reset timestamps so unused quotas don't show a moving countdown.
 */
function summaryResetTime(
	remainingFraction: number | undefined,
	description: string | undefined,
	resetTime: string | undefined,
	durationMs: number | undefined,
	requestedAt: number,
): string | undefined {
	if (resetTime === undefined) return undefined;
	const resetMs = Date.parse(resetTime);
	const untouched =
		remainingFraction === 1 &&
		description === undefined &&
		durationMs !== undefined &&
		Number.isFinite(resetMs) &&
		Math.abs(resetMs - requestedAt - durationMs) <= 60_000;
	return untouched ? undefined : resetTime;
}

/** Parses `v1internal:retrieveUserQuotaSummary` JSON into `omp-web` `UsageLimitWire[]`. */
export function parseAntigravityQuotaSummary(response: unknown, requestedAt: number): UsageLimitWire[] {
	if (!isRecord(response)) return [];
	const rawGroups = Array.isArray(response.groups) ? response.groups : [];
	const hasGroupedBuckets = rawGroups.some(g => isRecord(g) && Array.isArray(g.buckets) && g.buckets.length > 0);
	const groups: { displayName?: string; buckets: unknown[] }[] = hasGroupedBuckets
		? rawGroups.filter(isRecord).map(g => ({
				displayName: nonEmpty(g.displayName),
				buckets: Array.isArray(g.buckets) ? g.buckets : [],
			}))
		: [{ buckets: Array.isArray(response.buckets) ? response.buckets : [] }];

	const limits = new Map<string, UsageLimitWire>();
	for (const group of groups) {
		for (const rawBucket of group.buckets) {
			if (!isRecord(rawBucket) || rawBucket.disabled === true) continue;
			const bucketId = nonEmpty(rawBucket.bucketId);
			if (!bucketId) continue;
			const remainingFraction = finite(rawBucket.remainingFraction);
			const windowId = nonEmpty(rawBucket.window);
			const description = nonEmpty(rawBucket.description);
			const bucketDisplayName = nonEmpty(rawBucket.displayName);
			const durationMs = windowId ? SUMMARY_WINDOW_MS.get(windowId) : undefined;
			const resetTime = summaryResetTime(
				remainingFraction,
				description,
				nonEmpty(rawBucket.resetTime),
				durationMs,
				requestedAt,
			);
			// Argon and Carbon are metered separately from the default Gemini buckets.
			const family = bucketId.startsWith("gemini-argon-")
				? (group.displayName ?? "Gemini Argon")
				: bucketId.startsWith("gemini-carbon-")
					? (group.displayName ?? "Gemini Carbon")
					: bucketId.startsWith("gemini-")
						? "Gemini"
						: bucketId.startsWith("3p-")
							? "Claude & GPT (shared)"
							: (group.displayName ?? bucketId);
			const windowLabel =
				windowId === "weekly" ? "Weekly" : windowId === "5h" ? "5-hour" : (bucketDisplayName ?? "Quota");
			const limit = makeQuotaLimit(bucketId, `${family} · ${windowLabel}`, remainingFraction, resetTime, {
				windowId,
				windowLabel,
				durationMs,
				description,
			});
			if (limit) limits.set(limit.id, limit);
		}
	}
	return [...limits.values()];
}

/** Fallback parser for `v1internal:fetchAvailableModels` on older accounts without quota summary buckets. */
export function parseAntigravityAvailableModelsQuota(response: unknown): UsageLimitWire[] {
	if (!isRecord(response) || !isRecord(response.models)) return [];
	const limits = new Map<string, UsageLimitWire>();
	for (const [modelId, rawModel] of Object.entries(response.models)) {
		if (!isRecord(rawModel)) continue;
		const provider = nonEmpty(rawModel.modelProvider);
		const family =
			provider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")
				? "Gemini"
				: provider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")
					? "Claude"
					: provider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")
						? "GPT"
						: undefined;
		if (!family) continue;

		const pairs: [string, unknown][] = [
			["quota", rawModel.quotaInfo],
			["weekly", rawModel.weeklyQuotaInfo],
		];
		for (const [suffix, rawQuota] of pairs) {
			if (!isRecord(rawQuota)) continue;
			const windowLabel = suffix === "weekly" ? "Weekly" : "Reported quota";
			const limit = makeQuotaLimit(
				`${family.toLowerCase()}-${suffix}`,
				`${family} · ${windowLabel}`,
				finite(rawQuota.remainingFraction),
				nonEmpty(rawQuota.resetTime),
				{
					windowId: suffix === "weekly" ? "weekly" : "other",
					windowLabel,
					durationMs: suffix === "weekly" ? 7 * 24 * 60 * 60_000 : undefined,
				},
			);
			if (!limit) continue;
			const prev = limits.get(limit.id);
			if (!prev || (limit.usedFraction ?? 0) > (prev.usedFraction ?? 0)) {
				limits.set(limit.id, limit);
			}
		}
	}
	return [...limits.values()];
}

export interface AntigravityUsageOptions {
	/** Preferred ACP auth method (`oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`). */
	authMethod?: string;
	/** Directories to search for `acp_token.json` and `antigravity-oauth-token`. Defaults to standard `~/.gemini/*` dirs. */
	tokenDirs?: string[];
	/** Environment variables (for `HOME` / `USERPROFILE` / `GEMINI_HOME`). */
	env?: Record<string, string | undefined>;
	/** Override OS keyring reader (for tests). */
	readKeyring?: () => Promise<string | undefined>;
	/** Override `fetch` (for tests). */
	fetch?: typeof globalThis.fetch;
	/** Override clock (for tests). */
	now?: () => number;
	platform?: NodeJS.Platform;
	arch?: NodeJS.Architecture;
}

function defaultTokenDirs(env: Record<string, string | undefined>): string[] {
	const home = env.HOME ?? env.USERPROFILE ?? homedir();
	const dirs: string[] = [];
	if (env.GEMINI_HOME) {
		dirs.push(join(env.GEMINI_HOME, "antigravity-acp"), join(env.GEMINI_HOME, "antigravity-cli"), env.GEMINI_HOME);
	}
	dirs.push(
		join(home, ".gemini", "antigravity-acp"),
		join(home, ".gemini", "antigravity-cli"),
		join(home, ".gemini", "antigravity"),
	);
	return [...new Set(dirs)];
}

function readAllExistingFiles(dirs: readonly string[], filenames: readonly string[]): string[] {
	const found: string[] = [];
	for (const dir of dirs) {
		for (const name of filenames) {
			const file = join(dir, name);
			if (!existsSync(file)) continue;
			try {
				const text = readFileSync(file, "utf8");
				if (text.trim()) found.push(text);
			} catch {
				// Unreadable file; keep searching fallbacks.
			}
		}
	}
	return found;
}

function readFirstExistingFile(dirs: readonly string[], filenames: readonly string[]): string | undefined {
	return readAllExistingFiles(dirs, filenames)[0];
}

async function fetchJson(fetchFn: typeof globalThis.fetch, url: string, init: RequestInit): Promise<unknown> {
	const response = await fetchFn(url, {
		...init,
		redirect: "manual",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
	}
	return response.json();
}

/**
 * Probes Google Cloud Code internal quota endpoints (`v1internal:retrieveUserQuotaSummary`, falling back to
 * `v1internal:fetchAvailableModels`) using the machine's Antigravity OAuth sign-in.
 */
export class AntigravityUsageProbe {
	#cachedToken: { key: string; accessToken: string; identity?: string; expiresAt: number } | undefined;
	#inFlight: Promise<AntigravityUsageAck> | null = null;

	constructor(private readonly options: AntigravityUsageOptions = {}) {}

	clear(): void {
		this.#cachedToken = undefined;
	}

	probe(): Promise<AntigravityUsageAck> {
		this.#inFlight ??= this.#run().finally(() => {
			this.#inFlight = null;
		});
		return this.#inFlight;
	}

	async #run(): Promise<AntigravityUsageAck> {
		const nowFn = this.options.now ?? Date.now;
		const fetchedAt = nowFn();
		const authMethod = this.options.authMethod;
		if (authMethod === "gemini-api-key" || authMethod === "agent-platform") {
			return {
				fetchedAt,
				report: null,
				unavailable: {
					reason: "unsupported",
					message: "Subscription quota limits are only available for Google account sign-ins.",
				},
			};
		}

		const env = this.options.env ?? Bun.env;
		const dirs = this.options.tokenDirs ?? defaultTokenDirs(env);
		const fetchFn = this.options.fetch ?? globalThis.fetch;
		const platform = this.options.platform ?? process.platform;
		const arch = this.options.arch ?? process.arch;
		const userAgent = antigravityUserAgent(platform, arch);

		let accessToken: string;
		let identity: string | undefined;
		let projectId: string | undefined;

		try {
			const legacyRaw = readFirstExistingFile(dirs, ["acp_token.json"]);
			const legacy = legacyRaw ? parseLegacyToken(legacyRaw) : undefined;

			if (legacy) {
				projectId = legacy.project_id;
				const cacheKey = `${legacy.client_id}\0${legacy.refresh_token}\0${legacy.project_id ?? ""}`;
				if (this.#cachedToken?.key === cacheKey && this.#cachedToken.expiresAt > nowFn() + EXPIRY_MARGIN_MS) {
					accessToken = this.#cachedToken.accessToken;
					identity = this.#cachedToken.identity;
				} else {
					this.#cachedToken = undefined;
					const tokenBody = new URLSearchParams({
						client_id: legacy.client_id,
						client_secret: legacy.client_secret,
						refresh_token: legacy.refresh_token,
						grant_type: "refresh_token",
					});
					const refreshed = await fetchJson(fetchFn, "https://oauth2.googleapis.com/token", {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: tokenBody,
					});
					if (
						!isRecord(refreshed) ||
						typeof refreshed.access_token !== "string" ||
						!refreshed.access_token ||
						typeof refreshed.expires_in !== "number" ||
						!(refreshed.expires_in > 0)
					) {
						throw new Error("Invalid OAuth token refresh response");
					}
					accessToken = refreshed.access_token;
					identity = await this.#fetchIdentity(fetchFn, accessToken);
					this.#cachedToken = {
						key: cacheKey,
						accessToken,
						identity,
						expiresAt: nowFn() + refreshed.expires_in * 1000,
					};
				}
			} else {
				this.#cachedToken = undefined;
				// Check both `antigravity-oauth-token` files and the OS keyring; prefer the freshest non-expired token
				// so a stale leftover token file never shadows an active OS keyring sign-in.
				const rawCandidates = readAllExistingFiles(dirs, ["antigravity-oauth-token"]);
				const keyringRaw = await (this.options.readKeyring
					? this.options.readKeyring()
					: readSystemKeyringSecret(platform));
				if (keyringRaw) rawCandidates.push(keyringRaw);

				if (rawCandidates.length === 0) {
					return {
						fetchedAt,
						report: null,
						unavailable: {
							reason: "unauthenticated",
							message: "Sign in with Google to see Antigravity quota limits.",
						},
					};
				}

				const parsedTokens = rawCandidates
					.map(raw => parseCliToken(raw))
					.filter((token): token is CliTokenFile => token !== undefined);
				if (parsedTokens.length === 0) {
					return {
						fetchedAt,
						report: null,
						unavailable: {
							reason: "probe_failed",
							message: "Saved Antigravity sign-in could not be parsed.",
						},
					};
				}

				const now = nowFn();
				const fresh = parsedTokens
					.map(token => ({
						token,
						expiryMs: token.expiry === undefined ? Number.POSITIVE_INFINITY : Date.parse(token.expiry),
					}))
					.filter(entry =>
						Number.isFinite(entry.expiryMs)
							? entry.expiryMs > now + EXPIRY_MARGIN_MS
							: entry.token.expiry === undefined,
					)
					.sort((a, b) => b.expiryMs - a.expiryMs);
				const chosen = fresh[0]?.token;
				if (!chosen) {
					return {
						fetchedAt,
						report: null,
						unavailable: {
							reason: "expired",
							message:
								"Antigravity's saved sign-in has expired. Send a turn in Antigravity to renew it, then refresh.",
						},
					};
				}
				accessToken = chosen.access_token;
				identity = await this.#fetchIdentity(fetchFn, accessToken);
			}

			const endpoints =
				authMethod === "oauth-business" ? [PROD_ENDPOINT, DAILY_ENDPOINT] : [DAILY_ENDPOINT, PROD_ENDPOINT];
			const fetchOperation = async (
				operation: string,
				parse: (body: unknown, requestedAt: number) => UsageLimitWire[],
			): Promise<UsageLimitWire[]> => {
				const batches = await Promise.all(
					endpoints.map(async endpoint => {
						const requestedAt = nowFn();
						try {
							const body = await fetchJson(fetchFn, `${endpoint}/v1internal:${operation}`, {
								method: "POST",
								headers: {
									Authorization: `Bearer ${accessToken}`,
									"Content-Type": "application/json",
									"User-Agent": userAgent,
								},
								body: JSON.stringify(projectId ? { project: projectId } : {}),
							});
							return parse(body, requestedAt);
						} catch {
							return [];
						}
					}),
				);
				const merged = new Map<string, UsageLimitWire>();
				for (const limit of batches.flat()) {
					if (!merged.has(limit.id)) merged.set(limit.id, limit);
				}
				return [...merged.values()];
			};

			const summaryLimits = await fetchOperation("retrieveUserQuotaSummary", parseAntigravityQuotaSummary);
			const limits =
				summaryLimits.length > 0
					? summaryLimits
					: await fetchOperation("fetchAvailableModels", body => parseAntigravityAvailableModelsQuota(body));

			if (limits.length === 0) {
				return {
					fetchedAt,
					report: null,
					unavailable: {
						reason: "probe_failed",
						message: "Antigravity did not return usable quota information.",
					},
				};
			}

			return {
				fetchedAt,
				report: {
					provider: "antigravity",
					fetchedAt,
					...(identity ? { identity } : {}),
					limits,
				},
			};
		} catch {
			return {
				fetchedAt,
				report: null,
				unavailable: {
					reason: "probe_failed",
					message: "Could not read Antigravity limits. Refresh to retry.",
				},
			};
		}
	}

	async #fetchIdentity(fetchFn: typeof globalThis.fetch, accessToken: string): Promise<string | undefined> {
		try {
			const info = await fetchJson(fetchFn, "https://www.googleapis.com/oauth2/v2/userinfo", {
				method: "GET",
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			if (!isRecord(info)) return undefined;
			return nonEmpty(info.email) ?? nonEmpty(info.id);
		} catch {
			return undefined;
		}
	}
}
