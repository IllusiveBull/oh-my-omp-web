<p align="center">
  <img src="./packages/web/public/icon-192.png" width="80" height="80" alt="oh-my-omp-web logo" />
</p>

<h1 align="center">oh-my-omp-web</h1>

<p align="center">A self-hosted web and mobile UI for <a href="https://github.com/can1357/oh-my-pi">oh-my-pi (<code>omp</code>)</a>, with ACP support for Antigravity (<code>agy</code>).</p>

<p align="center">
  <a href="#deploy-with-an-agent"><strong>Deploy with an Agent</strong></a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#multi-machine-setup">Multi-Machine</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="./README_ZH.md">中文</a>
</p>

`oh-my-omp-web` runs the coding agents you already have installed and puts them behind one web app that works on desktop, tablet, and phone. You can start a session on your workstation, then review diffs or answer approval prompts from your phone. You can open a terminal that stays alive after you close the browser. You can also move a running thread to another machine, uncommitted changes included.

## Features

- **Uses your own agents and subscriptions.** It runs [`omp`](https://github.com/can1357/oh-my-pi) (`rpc-ui`) on your own machines. There is no proxy and no resold tokens. Antigravity CLI (`agy acp`) is also supported. It is there because Antigravity bans accounts that go through `omp`.
- **Many machines, one UI.** One machine runs the `gateway` daemon. Any number of other machines run `env` daemons (macOS, Linux, Windows). The `env` machines connect out to the gateway over Tailscale or LAN and open no ports.
- **Desktop and mobile PWA.** You can install it to your Home Screen. It has Light, Dark, and System themes, Web Push notifications (iOS/iPadOS Home Screen included), and notification sounds.
- **The full `omp` workflow.** Change model and thinking level in the middle of a thread. Switch model roles (`smol` / `default` / `slow`). Attach images, files, and pasted blocks. Run `/goal`, `/loop`, and `/btw`. Look at sub-agents. Search transcripts and prompt history.
- **Move threads between worktrees and machines.** An idle thread can move to another worktree or another machine. Uncommitted changes (staged and unstaged stay separate), missing commits, and session history move with it. You see a prompt-cache forecast first. If you cancel or it fails, everything rolls back.
- **Files, diffs, and terminals.** A read-only file browser with syntax highlighting and Markdown preview. Staged, unstaged, and HEAD diffs. Optional terminals (PTY) that survive browser disconnects and stay in sync across devices.
- **One login, one quota view.** You can host `omp auth-broker` on the gateway and sign in once for all machines. A usage pill and an Accounts page show quotas for `omp` providers and Antigravity.
- **History when a machine is offline.** Remote machines copy recent transcripts to the gateway, so you can still read them when the laptop is off.
- **Open source.** Self-hosted, [MIT licensed](./LICENSE).

---

## Deploy with an Agent

You can let a coding agent (`omp`, Claude Code, Codex, Antigravity, etc.) do the setup. Run it on the machine you want to deploy to and give it one of the prompts below. It reads this README, checks prerequisites, configures the daemon, and checks that it works.

### Prompt to give your agent

**Single machine (local or Tailscale HTTPS):**

```text
Deploy oh-my-omp-web on this machine following the "Agent Deployment Runbook" in README.md.
- Role: gateway
- Expose over: [localhost only | Tailscale HTTPS (`tailscale serve`) | Tailscale IP]
- Optional features: [enable terminals (--terminal)? yes/no] [enable auth broker (--broker)? yes/no]
- Background service: [run in foreground | launchd (macOS) | systemd user service (Linux) | Windows Task Scheduler]
Check prerequisites first, keep all secret files owner-only, never print secrets into logs or git, and verify login + WebSocket health before reporting back with the URL and where to read the gateway token.
```

**Add another machine (`env` role):**

```text
Deploy oh-my-omp-web on this machine as a remote environment (`--role env`) following the "Agent Deployment Runbook" in README.md.
- Gateway URL: wss://<gateway-host>.<tailnet>.ts.net/env
- Optional features: [enable terminals (--terminal)? yes/no]
- Background service: [launchd | systemd user service | Windows Task Scheduler]
Wait for me to paste or place the machine credential from `bun run start machine add <name>` into `<config dir>/credential`, enforce private file permissions, start the daemon, and verify that it connects to the gateway cleanly.
```

### Agent Deployment Runbook

> For the agent doing the deploy. Do the steps in order. Do not change `vendor/oh-my-pi`.

#### 1. Prerequisites

Check these on every machine:

| Dependency | Requirement | Check |
| --- | --- | --- |
| [Bun](https://bun.sh) | `>= 1.4.4` | `bun --version` |
| `git` | `>= 2.31` | `git --version` |
| [`omp`](https://github.com/can1357/oh-my-pi) | On `PATH` (or set `OMP_BIN` / `--omp`), with `rpc-ui` v2 | `omp --version` |
| `agy` *(optional)* | Antigravity CLI on `PATH` (or `AGY_BIN` / `--antigravity`), for ACP sessions | `agy --version` |

#### 2. Clone, install, build

```bash
git clone --recurse-submodules <repo-url> oh-my-omp-web
cd oh-my-omp-web
bun install        # installs deps and links prebuilt omp native addons (scripts/link-natives.ts)
bun run build      # bundles packages/web into packages/web/dist (app, login page, PWA service worker)
```

If you cloned without `--recurse-submodules`, run `git submodule update --init` before `bun install`.

#### 3. Configure the gateway

`<config dir>/config.json` is optional. Every field has a safe default (see [Configuration](#configuration)).

- **POSIX config dir:** `~/.config/omp-web` (state dir: `~/.local/state/omp-web`)
- **Windows config dir:** `%APPDATA%\omp-web` (state dir: `%LOCALAPPDATA%\omp-web`)

Start the gateway once:

```bash
bun run start
```

- On first run it creates a 43-character **gateway token**. It prints the token once and saves it to `<config dir>/token` (mode `600` on POSIX; on Windows, an ACL for owner, SYSTEM, and Administrators only).
- By default it listens on `http://127.0.0.1:7777`.
- Never commit or log the token. Tell the user to read `<config dir>/token` on the machine when they sign in.

#### 4. Expose over Tailscale (for remote and phone access)

**Option A: loopback + `tailscale serve` (recommended; you get HTTPS, which PWA install and Web Push need)**

Keep the gateway on `127.0.0.1:7777` and let Tailscale handle TLS:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7777
```

- Web UI: `https://<machine>.<tailnet>.ts.net/`
- The gateway reads `X-Forwarded-Proto: https` to set `Secure` cookies and check Origin.
- If login or the WebSocket gets `403` behind a reverse proxy, add the public origin to `gateway.allowOrigins` in `config.json` (or pass `--allow-origin https://<machine>.<tailnet>.ts.net`).
- For Web Push, set a real contact in `config.json`. This matters most on iOS/iPadOS 16.4+, where you install the app with **Share → Add to Home Screen**:
  ```json
  { "gateway": { "pushSubject": "mailto:you@example.com" } }
  ```
  The gateway needs outbound HTTPS to the browser push services (FCM / Mozilla / Apple).

**Option B: bind to the Tailscale IP (plain HTTP; no Web Push, no PWA install)**

```bash
bun run start --bind "$(tailscale ip -4)"
```

When you bind outside loopback, the token must be at least 32 characters (the generated one is 43). Don't use `0.0.0.0`.

#### 5. Add more machines (`env` role)

1. On the **gateway**, create a credential for the new machine:
   ```bash
   bun run start machine add <machine-name>
   # or write directly to a mode-600 file:
   bun run start machine add <machine-name> --out /path/to/credential
   ```
   It prints one line: `<machine-id>:<key>`.

2. On the **remote (`env`)** machine:
   - Clone and run `bun install`. You don't need `bun run build` on an env-only machine.
   - Save `<machine-id>:<key>` to `<config dir>/credential` and make it private:
     - POSIX: `chmod 600 ~/.config/omp-web/credential`
     - Windows: only the running user, `SYSTEM`, and `Administrators` may have access. If the ACL is too open, the daemon won't start and prints the `icacls` command that fixes it.
   - Start the env daemon:
     ```bash
     bun run start --role env --gateway-url wss://<gateway>.<tailnet>.ts.net/env
     ```
     Inside a tailnet, `ws://<gateway-tailscale-ip>:7777/env` works too. The key is never sent; both sides prove it with HMAC.

#### 6. Optional features

- **Terminals (off by default on every machine).**
  Turn them on only where browser users should get a full shell as the daemon user:
  `--terminal`, or `"terminal": { "enabled": true }` in `config.json`.
- **Shared login with `omp auth-broker` (off by default).**
  Turn it on at the gateway to sign in once for all machines:
  ```bash
  # single machine:
  bun run start --broker
  # multi-machine over Tailscale:
  bun run start --broker --broker-bind "$(tailscale ip -4):8765"
  ```
  With the broker on, `omp` on every connected machine uses the broker's credential store, which starts empty. Sign in from **Accounts** in the web UI, or copy your existing local credentials on the gateway:
  ```bash
  OMP_AUTH_BROKER_URL='http://127.0.0.1:8765' \
  OMP_AUTH_BROKER_TOKEN="$(cat ~/.local/state/omp-web/auth-broker/.omp/auth-broker.token)" \
  omp auth-broker migrate --from-local --include-oauth --dry-run
  # review output, then re-run without --dry-run
  ```
  Secrets and API keys never go through web forms. For API-key providers the UI shows the CLI command to run (or an **Open in terminal** button on the gateway when `--terminal` is on).

#### 7. Run in the background

- **macOS (`launchd`) / Linux (`systemd --user`):** Run `bun packages/daemon/src/index.ts` from the repo directory. Use the user's normal `HOME` and a `PATH` that has `bun`, `omp`, and `git`. Set `Restart=on-failure`. Use the same `HOME` and `PI_CONFIG_DIR` as your terminal `omp`, or session lease detection won't work.
- **Windows (Task Scheduler sign-in task):**
  Use the PowerShell installer in the repo. It creates a task for the current user that runs while you are signed in and uses a Job Object to clean up child processes:
  ```powershell
  .\scripts\windows-service.ps1 install -OmpPath "$env:USERPROFILE\.bun\bin\omp.exe" -DaemonArgs @('--terminal','--broker')
  .\scripts\windows-service.ps1 start
  .\scripts\windows-service.ps1 status
  ```
  - For an `env` machine on Windows:
    ```powershell
    .\scripts\windows-service.ps1 install -TaskName omp-web-env `
      -DaemonArgs @('--role','env','--gateway-url','wss://<gateway>.<tailnet>.ts.net/env','--terminal')
    ```
  - `stop` and `uninstall` also work. `uninstall` keeps config and state. The log is `<state dir>\windows-service.log`.
  - In service mode, terminals use the built-in Windows PowerShell 5.1. Packaged/AppX `pwsh` is refused, because its child processes can escape Job Object cleanup.

#### 8. Checklist before you finish

1. The daemon stays up and the log has no errors (no missing `omp`, no protocol mismatch).
2. The gateway answers HTTP (`curl -sf http://127.0.0.1:7777/login/ | head -n 5`, or the public HTTPS URL).
3. With `tailscale serve`, `https://<machine>.<tailnet>.ts.net/` loads and the WebSocket connects.
4. For `env` machines, the log shows an authenticated connection and the machine shows as online in the sidebar.
5. All secret files (`token`, `machine-keys.json`, `credential`, `vapid.json`) are owner-only (`600` or a restricted Windows ACL).
6. Tell the user to open the URL, paste the token from `<config dir>/token`, and add at least one Git repository from the project menu in the sidebar. `omp-web` only starts sessions and terminals inside registered project roots and their git worktrees.

---

## Quick Start

On a single machine:

```bash
git clone --recurse-submodules <repo-url> oh-my-omp-web
cd oh-my-omp-web
bun install
bun run build
bun run start
```

1. Copy the **gateway token** printed on first start. It is also saved in `~/.config/omp-web/token` (`%APPDATA%\omp-web\token` on Windows).
2. Open [http://127.0.0.1:7777](http://127.0.0.1:7777) and paste the token.
3. Click the project selector in the sidebar, add a Git repository, then click **New session**.

Sessions you start in the terminal (`omp`) show up here too. While a terminal session holds its lease, it opens read-only. Idle ones you can take over after a confirmation.

---

## Multi-Machine Setup

One machine is the **gateway**. It serves the web UI and is also an environment itself. Every other machine runs with `--role env`. These machines open no ports; they connect out to the gateway with their own key.

```bash
# 1. On the gateway machine
bun run start machine add laptop

# 2. On the laptop: save the printed "<machine-id>:<key>" to ~/.config/omp-web/credential (chmod 600)
bun run start --role env --gateway-url wss://<gateway>.<tailnet>.ts.net/env
```

To list or remove machines, run on the gateway:

```bash
bun run start machine list
bun run start machine remove <machine-id>
```

---

## Configuration

`bun run start --help` lists every CLI flag. Every option except `--config-dir` and `--state-dir` can also go in `<config dir>/config.json`. CLI flags win over the file. Unknown keys are an error.

### Gateway `config.json`

```json
{
  "role": "gateway",
  "name": "workstation",
  "gateway": {
    "bind": "127.0.0.1",
    "port": 7777,
    "webDir": "packages/web/dist",
    "allowOrigins": [],
    "pushSubject": "mailto:you@example.com"
  },
  "broker": {
    "enabled": false,
    "bind": "127.0.0.1:8765"
  },
  "terminal": {
    "enabled": false,
    "max": 16,
    "ringKiB": 1024,
    "scrollbackLines": 2000
  },
  "replica": {
    "retentionDays": 30,
    "maxFileMiB": 128,
    "scanSeconds": 30
  },
  "handoff": {
    "maxFileMiB": 10,
    "maxTotalMiB": 128,
    "maxBundleMiB": 256,
    "maxArchiveMiB": 512,
    "confirmTimeoutMinutes": 30
  }
}
```

### Env-only `config.json`

```json
{
  "role": "env",
  "omp": "/usr/local/bin/omp",
  "env": {
    "gatewayUrl": "wss://gateway.tailnet.ts.net/env",
    "credentialFile": "/home/me/.config/omp-web/credential"
  },
  "terminal": {
    "enabled": true
  },
  "antigravity": {
    "enabled": true,
    "permissionMode": "ask"
  }
}
```

### Where data lives

| Item | Path | Notes |
| --- | --- | --- |
| Config & secrets | `~/.config/omp-web` (`%APPDATA%\omp-web`) | `config.json`, `token`, `machine-keys.json`, `credential`, `vapid.json` (mode `600` / restricted ACL) |
| State & SQLite | `~/.local/state/omp-web` (`%LOCALAPPDATA%\omp-web`) | `gateway.db`, `replicas/<machine-id>/`, `projects.json`, `owned-sessions.json`, `machine-id` |
| Auth broker state | `<state dir>/auth-broker/.omp/` | `agent.db`, `auth-broker.token` (override with `broker.home`) |

**Security defaults:**
- Every HTTP route and WebSocket needs an HttpOnly session cookie, checked against `<config dir>/token`.
- Sessions, file browsing, and terminals only work inside registered Git project roots and their worktrees. `.git`, path traversal, and symlinks that point outside the tree are refused.
- Terminals are **off by default** on every machine, and their use is logged.
- If a secret file has loose POSIX permissions or a loose Windows ACL, the daemon refuses to start.

---

## Development

```bash
bun run --cwd packages/web dev   # rebuild frontend into packages/web/dist on change
bun run check                    # vendor tag guard, oxlint, oxfmt --check, typecheck
bun run test                     # unit & integration tests (protocol, daemon, web)
bun run test:live                # contract tests against installed omp (no real model call)
bun run sync:upstream            # sync catalog versions after updating vendor/oh-my-pi
```

> Don't edit files under `vendor/oh-my-pi`. It is pinned to an upstream `oh-my-pi` release tag. Put your changes in `packages/protocol`, `packages/daemon`, or `packages/web`.

## License

The code in this repository is under the [MIT License](./LICENSE).
