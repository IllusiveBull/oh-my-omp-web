#!/usr/bin/env bun
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION, type DaemonHello, type TerminalPurpose } from "@omp-web/protocol";
import pkg from "../package.json";
import { OmpAuthProcess, PLACEHOLDER_MODEL, prepareAgentDir } from "./auth-process";
import { antigravityLoginCommand } from "./antigravity-acp";
import { locateAntigravity } from "./antigravity-binary";
import { AntigravitySessionRegistry } from "./antigravity-sessions";
import { AuthService } from "./auth-service";
import { BrokerSupervisor, parseBrokerBind } from "./broker-supervisor";
import { defaultDirs, loadFileConfig, loadMachineId, resolveConfig, type DaemonConfig, type Dirs } from "./config";
import { GatewayStore } from "./db";
import { HandoffService } from "./handoff-service";
import { readAccountHashes } from "./cache-facts";
import { EnvBroker, linkProtection } from "./env-broker";
import { FileOwnedSessions } from "./owned";
import { removeMachineReplicas } from "./replica-gateway";
import { EnvDialer } from "./env-dialer";
import { EnvHost, type EnvIdentity } from "./env-host";
import { Gateway } from "./gateway";
import { startGatewayServer } from "./gateway-server";
import { checkLeaseEnvironment, collectLeaseFacts } from "./lease";
import { registerLocalEnv } from "./local-env";
import { localAgentDbPath } from "./migration";
import { createPush } from "./push";
import { SessionManager } from "./manager";
import { EXPECTED_OMP_VERSION, OmpStartupError, locateOmp, probeRpcProtocol, versionMismatch } from "./omp-binary";
import { ProjectRegistry } from "./projects";
import { promptHistoryMatcher } from "./session-search";
import { TerminalService, type PurposeLaunch } from "./terminal-service";
import type { CliShell } from "./login-kinds";
import {
	ConfigError,
	MachineKeys,
	assertBindAllowed,
	formatCredential,
	OWNER_ONLY,
	loadToken,
	mkdirPrivate,
	parseCredential,
	readSecret,
	writeSecret,
} from "./secrets";

/** What the terminal service learns from the role after it was built. */
interface TerminalWiring {
	/** The gateway role's broker login launch (null elsewhere: no broker is hosted). */
	launch: ((purpose: TerminalPurpose, shell: CliShell) => PurposeLaunch | null) | null;
	machineId: string;
}

/** How often the session store and lease state are rescanned while a browser is connected. */
const SESSION_SCAN_INTERVAL_MS = 4_000;

/**
 * Timing knobs for the browser smoke only (undocumented outside it): how often an environment probes its broker and how long the
 * gateway waits before restarting a dead one, so a smoke can keep the broker down for longer than one probe period.
 */
function testMs(name: string): number | undefined {
	const value = Number(Bun.env[name]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

const HELP = `omp-webd — hosts omp rpc-ui sessions for the omp-web PWA

  omp-webd [run] [options]        run the daemon
  omp-webd machine add <name> [--out <file>]   register an environment machine (prints its credential once)
  omp-webd machine list
  omp-webd machine remove <id>

Roles (--role, default gateway):
  gateway   this machine serves the web app and is itself an environment. Listens on --bind:--port
            (default 127.0.0.1:7777); every request needs the login cookie (token: <config dir>/token).
  env       environment only: listens on nothing, dials the gateway (--gateway-url) with its machine credential.

Options:
  --config-dir <dir>        config and secrets (default: ~/.config/omp-web; Windows %APPDATA%\\omp-web)
  --state-dir <dir>         database, project registry, machine id (default: ~/.local/state/omp-web; Windows %LOCALAPPDATA%\\omp-web)
  --name <name>             this machine's display name, gateway role (default: hostname); env machines are named by \`machine add\`
  --omp <path>              omp binary (default: $OMP_BIN, then PATH)
  --antigravity <path>      Antigravity CLI binary for ACP mode (default: $AGY_BIN, then \`agy\` on PATH when present)
  --antigravity-session-dir <dir>  custom Antigravity brain directory for historical session discovery
  --antigravity-auth-method <id>   preferred ACP authenticate methodId (e.g. oauth-personal, gemini-api-key)
  --antigravity-mode <id>          default ACP execution mode (e.g. default, accept-edits, auto, plan)
  --antigravity-permission-mode <mode>  tool approval policy: ask, edits, or auto (default)
  --session-dir <dir>       omp's --session-dir: one flat directory used for new sessions and the only one listed
                            (default: omp's per-project directories under its agent dir, all of them listed)
  gateway role:
  --bind <address>          address to listen on (default 127.0.0.1; beyond loopback needs a token of 32+ characters)
  --port <n>                listen port (default 7777)
  --web-dir <dir>           built web assets to serve (default: packages/web/dist)
  --allow-origin <url>      extra browser Origin allowed (repeatable)
  --broker                  host the credential broker (\`omp auth-broker serve\`) as a child; off by default. Turning it on switches
                            every environment's omp to the broker's credentials (log in through the web, or migrate)
  --broker-bind <host:port> where the broker listens (default 127.0.0.1:8765; no wildcard; the tailscale address for other machines)
  --broker-home <dir>       the broker's HOME: its agent.db and bearer token live in <dir>/.omp (default: <state dir>/auth-broker)
  --broker-advertise-url <url>  what other machines are told to use when it differs from --broker-bind
  env role:
  --gateway-url <url>       ws:// or wss:// URL of the gateway's /env endpoint
  --credential-file <file>  "<machine id>:<key>" from \`omp-webd machine add\` (default: <config dir>/credential)
  --terminal                allow persistent shells (the web Terminal) on this machine. OFF by default: a terminal is a full
                            shell as the user running omp-webd, so each machine's operator opts in (config.json: terminal.enabled)
  --broker-url <url>        use this machine's own credential broker instead of the gateway's (with --broker-token-file)
  --broker-token-file <file>  that broker's bearer token (owner-only: mode 600; on Windows an ACL for you, SYSTEM and Administrators)

All options except the directories can also be set in <config dir>/config.json (see README).`;

const COMMON = {
	"config-dir": { type: "string" },
	"state-dir": { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

function dirsFrom(flags: { "config-dir"?: string; "state-dir"?: string }): Dirs {
	const defaults = defaultDirs();
	return {
		configDir: resolve(flags["config-dir"] ?? defaults.configDir),
		stateDir: resolve(flags["state-dir"] ?? defaults.stateDir),
	};
}

async function machineCommand(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { ...COMMON, out: { type: "string" } },
	});
	const dirs = dirsFrom(values);
	const keys = new MachineKeys(join(dirs.configDir, "machine-keys.json"));
	const [action, argument] = positionals;
	if (action === "add" && argument) {
		const { id, key } = await keys.add(argument);
		const credential = formatCredential(id, key);
		console.log(`machine "${argument}" registered: id ${id}`);
		if (values.out) {
			await writeSecret(resolve(values.out), `${credential}\n`);
			console.log(`credential written to ${resolve(values.out)} (${OWNER_ONLY}). Copy it to that machine.`);
		} else {
			console.log(`credential (shown once; it cannot be recovered):\n${credential}`);
		}
		console.log(
			`On that machine: put it in <config dir>/credential (${process.platform === "win32" ? "restrict it with icacls; the daemon prints the command if it is too open" : "chmod 600"}) and run \`omp-webd --role env --gateway-url wss://<gateway>/env\`.`,
		);
	} else if (action === "list") {
		const machines = await keys.list();
		for (const [id, machine] of Object.entries(machines)) console.log(`${id}  ${machine.name}`);
		if (Object.keys(machines).length === 0) console.log("no machines registered");
	} else if (action === "remove" && argument) {
		if (!(await keys.remove(argument))) throw new ConfigError(`no machine with id ${argument}`);
		const db = join(dirs.stateDir, "gateway.db");
		if (await Bun.file(db).exists()) {
			const store = GatewayStore.open(db);
			store.deleteMachine(argument);
			store.close();
		}
		await removeMachineReplicas(join(dirs.stateDir, "replicas"), argument);
		console.log(
			`machine ${argument} removed: its key no longer registers. A running gateway keeps showing it, and keeps an already open link, until restarted.`,
		);
	} else {
		throw new ConfigError("usage: omp-webd machine add <name> [--out <file>] | list | remove <id>");
	}
}

async function run(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			...COMMON,
			role: { type: "string" },
			name: { type: "string" },
			omp: { type: "string" },
			antigravity: { type: "string" },
			"antigravity-session-dir": { type: "string" },
			"antigravity-auth-method": { type: "string" },
			"antigravity-mode": { type: "string" },
			"antigravity-permission-mode": { type: "string" },
			"session-dir": { type: "string" },
			bind: { type: "string" },
			port: { type: "string" },
			"web-dir": { type: "string" },
			"allow-origin": { type: "string", multiple: true },
			"gateway-url": { type: "string" },
			"credential-file": { type: "string" },
			broker: { type: "boolean" },
			terminal: { type: "boolean" },
			"broker-bind": { type: "string" },
			"broker-home": { type: "string" },
			"broker-advertise-url": { type: "string" },
			"broker-url": { type: "string" },
			"broker-token-file": { type: "string" },
		},
	});
	if (values.help) {
		console.log(HELP);
		return;
	}
	const dirs = dirsFrom(values);
	const config = resolveConfig(
		{
			role: values.role,
			name: values.name,
			omp: values.omp,
			antigravity: values.antigravity,
			antigravitySessionDir: values["antigravity-session-dir"],
			antigravityAuthMethod: values["antigravity-auth-method"],
			antigravityMode: values["antigravity-mode"],
			antigravityPermissionMode: values["antigravity-permission-mode"],
			sessionDir: values["session-dir"],
			bind: values.bind,
			port: values.port,
			webDir: values["web-dir"],
			allowOrigin: values["allow-origin"],
			gatewayUrl: values["gateway-url"],
			credentialFile: values["credential-file"],
			broker: values.broker,
			terminal: values.terminal,
			brokerBind: values["broker-bind"],
			brokerHome: values["broker-home"],
			brokerAdvertiseUrl: values["broker-advertise-url"],
			brokerUrl: values["broker-url"],
			brokerTokenFile: values["broker-token-file"],
		},
		await loadFileConfig(dirs.configDir),
		dirs,
		{ webDir: resolve(import.meta.dir, "../../web/dist") },
	);

	const omp = await locateOmp(config.omp);
	const antigravity = await locateAntigravity(config.antigravity);
	if (antigravity) {
		console.log(
			`omp-webd: Antigravity ACP enabled (${antigravity.path}${antigravity.version ? ` ${antigravity.version}` : ""})`,
		);
	}
	const authAgentDir = join(config.stateDir, "auth-agent");
	await prepareAgentDir(authAgentDir);
	await probeRpcProtocol(omp, undefined, { agentDir: authAgentDir, model: PLACEHOLDER_MODEL });
	const mismatch = versionMismatch(omp);
	if (mismatch) console.warn(`omp-webd: warning: ${mismatch}`);
	const leaseWarnings = checkLeaseEnvironment(collectLeaseFacts(config.sessionDir));
	for (const warning of leaseWarnings) console.warn(`omp-webd: warning: ${warning}`);

	const hello: DaemonHello = {
		protocol: PROTOCOL_VERSION,
		daemonVersion: pkg.version,
		home: homedir(),
		omp: { version: omp.version, expectedVersion: EXPECTED_OMP_VERSION, versionMismatch: mismatch !== null },
		antigravity: antigravity
			? { available: true, ...(antigravity.version ? { version: antigravity.version } : {}) }
			: { available: false },
		leaseWarnings,
	};
	const projects = await ProjectRegistry.open(join(config.stateDir, "projects.json"));
	// This machine's view of the credential broker: the gateway's (handed over the link) unless it has one of its own.
	let localBroker: { url: string; token: string } | undefined;
	if (config.localBroker) {
		const token = await readSecret(config.localBroker.tokenFile);
		if (token === null || token === "") {
			throw new ConfigError(`no broker token at ${config.localBroker.tokenFile} (broker.tokenFile)`);
		}
		localBroker = { url: config.localBroker.url.replace(/\/+$/, ""), token };
	}
	const broker = new EnvBroker({ local: localBroker, intervalMs: testMs("OMP_WEB_BROKER_PROBE_MS") });
	const antigravityRegistry = new AntigravitySessionRegistry(join(config.stateDir, "antigravity-sessions.json"));
	const manager = new SessionManager({
		ompPath: omp.path,
		antigravity: {
			binary: antigravity,
			authMethod: config.antigravity.authMethod,
			mode: config.antigravity.mode,
			permissionMode: config.antigravity.permissionMode,
			sessionDir: config.antigravity.sessionDir,
			registry: antigravityRegistry,
		},
		sessionDir: config.sessionDir,
		historyMatcher: promptHistoryMatcher(),
		resolveCwd: cwd => projects.resolveCwd(cwd),
		owned: FileOwnedSessions.open(join(config.stateDir, "owned-sessions.json")),
		childEnv: () => broker.childEnv(),
		explainSpawnError: error => broker.explainSpawnError(error),
	});
	await manager.refresh();
	// Filled in by the role once it knows them: this machine's id (audit log) and, on the gateway, the broker login launch.
	const terminalWiring: TerminalWiring = { launch: null, machineId: "unregistered" };
	const terminals = new TerminalService({
		enabled: config.terminal.enabled,
		machineId: () => terminalWiring.machineId,
		max: config.terminal.max,
		shell: config.terminal.shell,
		ringChars: config.terminal.ringChars,
		scrollbackLines: config.terminal.scrollbackLines,
		resolveCwd: cwd => projects.resolveCwd(cwd),
		purposeLaunch: async (purpose, shell) => {
			if (purpose.kind === "antigravity-login") {
				return antigravity ? { cwd: homedir(), input: antigravityLoginCommand(antigravity) } : null;
			}
			return terminalWiring.launch?.(purpose, shell) ?? null;
		},
	});
	if (terminals.enabled) {
		console.log(
			`omp-webd: terminals are ENABLED on this machine (shell ${terminals.capability().shell}): anyone signed in to the gateway can run commands here as ${userInfo().username}`,
		);
	}
	const handoff = new HandoffService({
		manager,
		projects,
		ompPath: omp.path,
		stateDir: config.stateDir,
		ompVersion: omp.version,
		childEnv: () => broker.childEnv(),
		worktreesDir: config.handoff.worktreesDir,
		usesBroker: () => broker.status().source !== "none",
	});
	handoff.start();
	const host = new EnvHost(manager, projects, { replica: config.replica, broker, terminals, handoff });
	broker.start();
	manager.startPolling(SESSION_SCAN_INTERVAL_MS, () => host.clientCount > 0);
	const base = { platform: process.platform, hello };

	const stop =
		config.role === "gateway"
			? await runGateway(config, host, base, omp.path, terminalWiring)
			: await runEnv(config, host, base, terminalWiring);
	const shutdown = async (): Promise<void> => {
		await stop();
		broker.stop();
		host.close();
		await terminals.close(); // every shell gets SIGHUP/SIGTERM (then SIGKILL) before the daemon exits
		await manager.closeAll();
		process.exit(0);
	};
	let stopping: Promise<void> | null = null;
	const stopOnce = (): void => {
		stopping ??= shutdown();
	};
	process.on("SIGINT", stopOnce);
	process.on("SIGTERM", stopOnce);
	if (process.platform === "win32") {
		// What a Windows console actually delivers (Bun 1.4.4, measured): Ctrl-C is SIGINT, Ctrl-Break is SIGBREAK; closing the
		// console window is CTRL_CLOSE_EVENT, mapped to SIGHUP [INFERENCE: could not be triggered here]. SIGTERM never arrives.
		process.on("SIGBREAK", stopOnce);
		process.on("SIGHUP", stopOnce);
	}
}

/** The gateway role: database, in-process environment, HTTP listener. Returns the function that stops them. */
async function runGateway(
	config: DaemonConfig,
	host: EnvHost,
	base: Omit<EnvIdentity, "machineId">,
	ompPath: string,
	terminalWiring: TerminalWiring,
): Promise<() => Promise<void>> {
	const { token, created } = await loadToken(join(config.configDir, "token"));
	assertBindAllowed(config.gateway.bind, token);
	const store = GatewayStore.open(join(config.stateDir, "gateway.db"));
	const identity: EnvIdentity = { ...base, machineId: await loadMachineId(config.stateDir) };
	terminalWiring.machineId = identity.machineId;
	// The notifier asks the gateway who is looking at what, and the gateway reports to the notifier: one of them is built first.
	const wiring: { gateway?: Gateway } = {};
	const push = await createPush({
		store,
		configDir: config.configDir,
		subject: config.gateway.pushSubject,
		isViewed: (machine, sessionId) => wiring.gateway?.isViewed(machine, sessionId) ?? false,
		machineName: machine => wiring.gateway?.nameOf(machine) ?? machine,
	});
	// Credentials: the managed broker (when enabled) and the service that lists accounts and drives sign-ins.
	const supervisor = config.broker.enabled
		? new BrokerSupervisor({
				ompPath,
				bind: parseBrokerBind(config.broker.bind),
				home: config.broker.home,
				advertiseUrl: config.broker.advertiseUrl,
				...(testMs("OMP_WEB_BROKER_RESTART_MS") === undefined
					? {}
					: {
							backoff: {
								minMs: testMs("OMP_WEB_BROKER_RESTART_MS")!,
								maxMs: testMs("OMP_WEB_BROKER_RESTART_MS")!,
								stableMs: 30_000,
							},
						}),
			})
		: null;
	if (supervisor) await mkdirPrivate(config.broker.home);
	const authCwd = join(config.stateDir, "auth-cwd");
	const auth = new AuthService({
		supervisor,
		selfMachineId: identity.machineId,
		publish: frame => wiring.gateway?.publish(frame),
		brokerConfigChanged: () => wiring.gateway?.brokerConfigChanged(),
		createProcess: async env => {
			await mkdirPrivate(authCwd);
			const process = new OmpAuthProcess({
				ompPath,
				cwd: authCwd,
				env,
				agentDir: join(config.stateDir, "auth-agent"),
			});
			await process.start();
			return process;
		},
		localAgentDb: supervisor ? localAgentDbPath() : null,
		userHome: homedir(),
	});
	const gateway = new Gateway({
		store,
		selfMachineId: identity.machineId,
		gatewayVersion: pkg.version,
		replicaDir: join(config.stateDir, "replicas"),
		attention: push.notifier,
		auth,
		handoff: {
			limits: config.handoff.limits,
			confirmTimeoutMs: config.handoff.confirmTimeoutMs,
			// The broker's accounts, as pin hashes: identity fields are read with json_extract, never the tokens next to them.
			brokerAccounts: supervisor
				? async () => readAccountHashes(join(config.broker.home, ".omp", "agent", "agent.db"))
				: undefined,
		},
	});
	wiring.gateway = gateway;
	terminalWiring.launch = (purpose, shell) =>
		purpose.kind === "broker-login" ? auth.brokerLoginTerminal(purpose.provider, shell) : null;
	const local = registerLocalEnv(gateway, host, identity, config.name);
	auth.start();
	supervisor?.start();
	const server = startGatewayServer({
		gateway,
		store,
		keys: new MachineKeys(join(config.configDir, "machine-keys.json")),
		token,
		bind: config.gateway.bind,
		port: config.gateway.port,
		webDir: config.gateway.webDir,
		allowedOrigins: config.gateway.allowOrigins,
		push: { publicKey: push.publicKey, test: id => push.notifier.test(id) },
	});
	if (created) {
		console.log(
			`omp-webd: generated the gateway token (shown once, stored in ${join(config.configDir, "token")}, ${OWNER_ONLY}):\n${token}`,
		);
	}
	console.log(
		`omp-webd gateway listening on http://${config.gateway.bind}:${server.port} (machine "${config.name}", omp ${base.hello.omp.version}); sign in with the token`,
	);
	if (supervisor) {
		console.log(
			`omp-webd: auth broker (omp auth-broker serve) on ${supervisor.url} for this machine, ${supervisor.advertisedUrl} for the others; state in ${config.broker.home}/.omp`,
		);
	}
	return async () => {
		await server.stop(true);
		await auth.stop(); // SIGINT to the broker child (its graceful path), then the omp process that drove sign-ins
		local.close();
		await new Promise<void>(resolve => setImmediate(resolve)); // the in-process link reports its end asynchronously, to a still-open store
		gateway.close();
		store.close();
	};
}

/** The env role: no listener, one outbound link to the gateway. */
async function runEnv(
	config: DaemonConfig,
	host: EnvHost,
	base: Omit<EnvIdentity, "machineId">,
	terminalWiring: TerminalWiring,
): Promise<() => Promise<void>> {
	const text = await readSecret(config.env.credentialFile);
	if (text === null) {
		throw new ConfigError(
			`no machine credential at ${config.env.credentialFile}; create one on the gateway with \`omp-webd machine add <name>\``,
		);
	}
	const credential = parseCredential(text, config.env.credentialFile);
	const identity: EnvIdentity = { ...base, machineId: credential.id };
	terminalWiring.machineId = credential.id;
	const gatewayUrl = config.env.gatewayUrl!;
	const protection = linkProtection(gatewayUrl);
	const dialer = new EnvDialer({
		url: gatewayUrl,
		identity,
		key: credential.key,
		host,
		acceptsBroker: protection !== null,
	});
	dialer.start();
	console.log(`omp-webd env (machine ${credential.id}) dialing ${config.env.gatewayUrl}; it listens on no port`);
	if (protection === null && !config.localBroker) {
		console.warn(
			"omp-webd: warning: this link is plain ws:// over an address that is neither loopback nor in the tailnet, so the gateway's credential broker token will not be accepted over it; use wss:// or give this machine its own broker (broker.url + broker.tokenFile)",
		);
	}
	return async () => dialer.stop();
}

try {
	const argv = process.argv.slice(2);
	if (argv[0] === "machine") await machineCommand(argv.slice(1));
	else await run(argv[0] === "run" ? argv.slice(1) : argv);
} catch (error) {
	if (error instanceof ConfigError || error instanceof OmpStartupError) {
		console.error(`omp-webd: ${error instanceof OmpStartupError ? "refusing to start: " : ""}${error.message}`);
		process.exit(error instanceof ConfigError ? 2 : 1);
	}
	throw error;
}
