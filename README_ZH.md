<p align="center">
  <img src="./packages/web/public/icon-192.png" width="80" height="80" alt="oh-my-omp-web logo" />
</p>

<h1 align="center">oh-my-omp-web</h1>

<p align="center">自托管的 <a href="https://github.com/can1357/oh-my-pi">oh-my-pi (<code>omp</code>)</a> 网页和手机端界面，也通过 ACP 支持 Antigravity (<code>agy</code>)。</p>

<p align="center">
  <a href="#让-agent-帮你部署"><strong>让 Agent 部署</strong></a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#多机协同">多机协同</a> ·
  <a href="#配置说明">配置说明</a> ·
  <a href="./README.md">English</a>
</p>

`oh-my-omp-web` 用的是你机器上已经装好的编程 Agent，给它们套一个网页界面，电脑、平板、手机都能用。你可以在电脑上开一个会话，然后在手机上看 diff、点审批。可以开终端，关掉浏览器也不会断。还可以把正在跑的会话搬到另一台机器上，没提交的改动也一起带过去。

## 功能

- **用你自己的 Agent 和订阅。** 在你自己的机器上运行 [`omp`](https://github.com/can1357/oh-my-pi)（`rpc-ui`）。没有中间代理，也不转卖 token。另外因为 Antigravity 会封通过 `omp` 使用的账号，支持 Antigravity CLI（`agy acp`）。
- **多台机器，一个界面。** 一台机器跑 `gateway`，其他机器（macOS / Linux / Windows）跑 `--role env`。`env` 机器通过 Tailscale 或局域网主动连到网关，自己不开端口。
- **电脑和手机都能用的 PWA。** 可以装到手机主屏幕。有浅色、深色、跟随系统三种主题，支持 Web Push 通知（包括 iOS/iPadOS 主屏幕应用）和提示音。
- **`omp` 的功能都有。** 对话中途换模型、换思考强度。切换模型角色（`smol` / `default` / `slow`）。附加图片、文件和大段粘贴。用 `/goal`、`/loop`、`/btw`。查看子 Agent。搜索会话记录和历史提示词。
- **会话可以换 worktree、换机器。** 空闲的会话可以搬到另一个 worktree 或另一台机器。没提交的改动（staged 和 unstaged 分开保留）、缺的 commit、会话历史会一起搬过去。搬之前会先告诉你 prompt cache 大概还能命中多少。取消或失败会自动回滚。
- **文件、diff 和终端。** 只读的文件浏览器，带语法高亮和 Markdown 预览。可以看 staged、unstaged、HEAD 三种 diff。终端（PTY）需要手动开启，关掉浏览器不会断，多个设备看到的输出一样。
- **登录一次，额度一起看。** 可以让网关托管 `omp auth-broker`，登录一次所有机器都能用。顶部的用量标签和 Accounts 页面会显示 `omp` 各服务商和 Antigravity 的额度。
- **机器离线也能看历史。** 远程机器会把最近的会话记录同步到网关。笔记本关机了，也能在网页上看之前的对话。
- **开源。** 自托管，[MIT 协议](./LICENSE)。

---

## 让 Agent 帮你部署

配置可以交给编程 Agent（`omp`、Claude Code、Codex、Antigravity 等）来做。在要部署的机器上打开 Agent，把下面的提示词发给它。它会读这份文档，检查依赖，配置守护进程，最后确认能用。

### 发给 Agent 的提示词

**部署主网关机器（单机或 Tailscale HTTPS）：**

```text
请严格按照 README_ZH.md 中的「Agent 部署手册」在这台机器上部署 oh-my-omp-web。
- 角色：gateway
- 访问方式：[仅本机 localhost | Tailscale HTTPS (`tailscale serve`) | Tailscale IP]
- 可选功能：[是否开启持久终端 --terminal：是/否] [是否开启集中鉴权 --broker：是/否]
- 后台运行方式：[前台运行 | macOS launchd | Linux systemd 用户服务 | Windows 计划任务]
请先检查依赖环境，确保所有密钥文件权限仅当前用户可读，不要把任何 token/密钥输出到日志或提交到 git；部署完成后验证登录页与 WebSocket 可用，并告诉我访问地址和查看 gateway token 的文件路径。
```

**接入另一台远程机器（`env` 节点）：**

```text
请严格按照 README_ZH.md 中的「Agent 部署手册」在这台机器上以远程环境节点（--role env）方式部署 oh-my-omp-web。
- 网关地址：wss://<gateway-host>.<tailnet>.ts.net/env
- 可选功能：[是否开启持久终端 --terminal：是/否]
- 后台运行方式：[macOS launchd | Linux systemd 用户服务 | Windows 计划任务]
安装好依赖后，等我提供网关通过 `bun run start machine add <name>` 生成的机器凭证，将其写入 `<config dir>/credential` 并设置私有权限，启动守护进程后确认节点已成功连上网关。
```

### Agent 部署手册

> 给执行部署的 Agent 看的。按顺序做。不要改 `vendor/oh-my-pi` 里的文件。

#### 1. 检查依赖环境

每台机器都要确认：

| 依赖 | 要求 | 检查命令 |
| --- | --- | --- |
| [Bun](https://bun.sh) | `>= 1.4.4` | `bun --version` |
| `git` | `>= 2.31` | `git --version` |
| [`omp`](https://github.com/can1357/oh-my-pi) | 在 `PATH` 里（或用 `OMP_BIN` / `--omp` 指定），支持 `rpc-ui` v2 | `omp --version` |
| `agy` *（可选）* | Antigravity CLI 在 `PATH` 里（或用 `AGY_BIN` / `--antigravity` 指定），用于 ACP 会话 | `agy --version` |

#### 2. 克隆、安装、构建

```bash
git clone --recurse-submodules <repo-url> oh-my-omp-web
cd oh-my-omp-web
bun install        # 安装依赖并自动链接预编译的 omp native addon（scripts/link-natives.ts）
bun run build      # 构建前端到 packages/web/dist（包含应用、登录页、PWA Service Worker）
```

如果克隆时没加 `--recurse-submodules`，先运行 `git submodule update --init`，再 `bun install`。

#### 3. 配置网关

`<config dir>/config.json` 可以不写，每个字段都有安全的默认值（见[配置说明](#配置说明)）。

- **POSIX：** 配置目录 `~/.config/omp-web`，状态目录 `~/.local/state/omp-web`
- **Windows：** 配置目录 `%APPDATA%\omp-web`，状态目录 `%LOCALAPPDATA%\omp-web`

先启动一次网关：

```bash
bun run start
```

- 第一次启动会生成一个 43 位的 **gateway token**。它只打印一次，同时保存到 `<config dir>/token`（POSIX 权限 `600`；Windows 上只有当前用户、SYSTEM、Administrators 能访问）。
- 默认监听 `http://127.0.0.1:7777`。
- 不要提交或记录这个 token。让用户登录时自己去机器上读 `<config dir>/token`。

#### 4. 通过 Tailscale 访问（远程和手机访问用这个）

**方案 A：只监听本机 + `tailscale serve`（推荐；有 HTTPS，PWA 安装和 Web Push 都需要它）**

网关保持监听 `127.0.0.1:7777`，HTTPS 交给 Tailscale：

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7777
```

- 访问地址：`https://<machine>.<tailnet>.ts.net/`
- 网关会读 `X-Forwarded-Proto: https`，用来设置 `Secure` Cookie 和检查 Origin。
- 如果在反向代理后面登录或 WebSocket 返回 `403`，把公网地址加到 `config.json` 的 `gateway.allowOrigins` 里（或者传 `--allow-origin https://<machine>.<tailnet>.ts.net`）。
- 要用 Web Push，在 `config.json` 里填一个真实的联系地址。iOS/iPadOS 16.4+ 要先用「分享 → 添加到主屏幕」安装，再从主屏幕打开：
  ```json
  { "gateway": { "pushSubject": "mailto:you@example.com" } }
  ```
  网关机器要能访问外部的推送服务（FCM / Mozilla / Apple），走 HTTPS。

**方案 B：直接监听 Tailscale IP（只有 HTTP；不能用 Web Push，不能装 PWA）**

```bash
bun run start --bind "$(tailscale ip -4)"
```

监听本机以外的地址时，token 至少要 32 位（自动生成的是 43 位）。不要用 `0.0.0.0`。

#### 5. 加入更多机器（`env` 角色）

1. 在**网关**上给新机器生成凭证：
   ```bash
   bun run start machine add <machine-name>
   # 或直接写入权限为 600 的文件：
   bun run start machine add <machine-name> --out /path/to/credential
   ```
   会输出一行：`<machine-id>:<key>`。

2. 在**远程（`env`）机器**上：
   - 克隆代码，运行 `bun install`。只做 `env` 的机器不用 `bun run build`。
   - 把 `<machine-id>:<key>` 写进 `<config dir>/credential`，并设成私有：
     - POSIX：`chmod 600 ~/.config/omp-web/credential`
     - Windows：只允许当前用户、`SYSTEM`、`Administrators` 访问。权限太宽的话守护进程不会启动，并会打印修复用的 `icacls` 命令。
   - 启动 `env` 守护进程：
     ```bash
     bun run start --role env --gateway-url wss://<gateway>.<tailnet>.ts.net/env
     ```
     在 tailnet 里用 `ws://<gateway-tailscale-ip>:7777/env` 也可以。密钥本身不会发出去，双方用 HMAC 互相验证。

#### 6. 可选功能

- **终端（每台机器默认关闭）：**
  终端会给浏览器用户一个完整的 Shell（以守护进程的用户身份运行），所以只在需要的机器上打开：`--terminal`，或在 `config.json` 里写 `"terminal": { "enabled": true }`。
- **共享登录 `omp auth-broker`（默认关闭）：**
  在网关上打开后，登录一次所有机器都能用：
  ```bash
  # 单机模式：
  bun run start --broker
  # 多机模式（通过 Tailscale 内网供其他节点访问）：
  bun run start --broker --broker-bind "$(tailscale ip -4):8765"
  ```
  打开后，所有已连接机器上的 `omp` 都会改用 broker 的凭证库，这个库一开始是空的。可以在网页的 **Accounts** 页面登录，也可以在网关机器上把本地已有的凭证迁过去：
  ```bash
  OMP_AUTH_BROKER_URL='http://127.0.0.1:8765' \
  OMP_AUTH_BROKER_TOKEN="$(cat ~/.local/state/omp-web/auth-broker/.omp/auth-broker.token)" \
  omp auth-broker migrate --from-local --include-oauth --dry-run
  # 确认迁移计划无误后，去掉 --dry-run 再次执行
  ```
  API Key 之类的密钥不会通过网页表单提交。需要 API Key 的服务商，页面会显示要运行的 CLI 命令（网关开了 `--terminal` 时，可以直接点 **Open in terminal**）。

#### 7. 后台运行

- **macOS（`launchd`）/ Linux（`systemd --user`）：** 在仓库目录运行 `bun packages/daemon/src/index.ts`。用用户平时的 `HOME`，`PATH` 里要有 `bun`、`omp`、`git`，失败时自动重启。`HOME` 和 `PI_CONFIG_DIR` 要跟终端里的 `omp` 一样，否则检测不到终端会话的租约（lease）。
- **Windows（登录后自动运行的计划任务）：**
  用仓库里的 PowerShell 脚本安装。它会为当前用户创建一个计划任务，只在用户登录时运行，用 Job Object 保证停止时清理所有子进程：
  ```powershell
  .\scripts\windows-service.ps1 install -OmpPath "$env:USERPROFILE\.bun\bin\omp.exe" -DaemonArgs @('--terminal','--broker')
  .\scripts\windows-service.ps1 start
  .\scripts\windows-service.ps1 status
  ```
  - 在 Windows 上装 `env` 节点：
    ```powershell
    .\scripts\windows-service.ps1 install -TaskName omp-web-env `
      -DaemonArgs @('--role','env','--gateway-url','wss://<gateway>.<tailnet>.ts.net/env','--terminal')
    ```
  - 还有 `stop` 和 `uninstall`。卸载不会删配置和数据。日志在 `<state dir>\windows-service.log`。
  - 服务模式下，终端用系统自带的 Windows PowerShell 5.1。商店版/AppX 的 `pwsh` 不能用，因为它的子进程可能逃过 Job Object 的清理。

#### 8. 完成前的检查清单

汇报完成之前，逐项确认：
1. 守护进程一直在运行，日志里没有错误（没有找不到 `omp`，没有协议版本不匹配）。
2. 网关能正常响应 HTTP（访问 `http://127.0.0.1:7777/login/` 或公网 HTTPS 地址）。
3. 用了 `tailscale serve` 的话，`https://<machine>.<tailnet>.ts.net/` 能打开，WebSocket 能连上。
4. `env` 节点的日志显示已通过认证连上网关，侧边栏里这台机器显示在线。
5. 所有密钥文件（`token`、`machine-keys.json`、`credential`、`vapid.json`）只有属主能读（`600` 或受限的 Windows ACL）。
6. 告诉用户：打开网页，粘贴 `<config dir>/token` 里的 token 登录，然后在侧边栏的项目菜单里添加至少一个 Git 仓库。`omp-web` 只在已添加的项目目录和它们的 git worktree 里启动会话和终端。

---

## 快速开始

在一台机器上运行：

```bash
git clone --recurse-submodules <repo-url> oh-my-omp-web
cd oh-my-omp-web
bun install
bun run build
bun run start
```

1. 复制第一次启动时打印的 **gateway token**。它也保存在 `~/.config/omp-web/token`（Windows 是 `%APPDATA%\omp-web\token`）。
2. 浏览器打开 [http://127.0.0.1:7777](http://127.0.0.1:7777)，粘贴 token 登录。
3. 在侧边栏的项目菜单里添加一个 Git 仓库，点 **New session**。

在终端里用 `omp` 开的会话也会显示在这里。终端还占着的会话只能只读查看，空闲的会话确认后可以接管。

---

## 多机协同

一台机器做 **gateway**，它提供网页，自己也算一个环境。其他机器都用 `--role env` 运行。这些机器不开端口，用各自的密钥主动连到网关。

```bash
# 1. 在网关机器上添加节点
bun run start machine add laptop

# 2. 在目标机器上将输出的 "<machine-id>:<key>" 保存到 ~/.config/omp-web/credential（chmod 600）
bun run start --role env --gateway-url wss://<gateway>.<tailnet>.ts.net/env
```

在网关上查看或删除机器：

```bash
bun run start machine list
bun run start machine remove <machine-id>
```

---

## 配置说明

`bun run start --help` 会列出所有命令行参数。除了 `--config-dir` 和 `--state-dir`，其他选项都可以写进 `<config dir>/config.json`。命令行参数优先于配置文件。写了不认识的字段会直接报错。

### 网关 `config.json`

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

### `env` 节点 `config.json`

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

### 数据存放位置

| 内容 | 路径 | 说明 |
| --- | --- | --- |
| 配置和密钥 | `~/.config/omp-web`（Windows：`%APPDATA%\omp-web`） | `config.json`、`token`、`machine-keys.json`、`credential`、`vapid.json`（权限 `600` / 受限 ACL） |
| 运行状态和数据库 | `~/.local/state/omp-web`（Windows：`%LOCALAPPDATA%\omp-web`） | `gateway.db`、`replicas/<machine-id>/`、`projects.json`、`owned-sessions.json`、`machine-id` |
| Auth Broker 状态 | `<state dir>/auth-broker/.omp/` | `agent.db`、`auth-broker.token`（可以用 `broker.home` 改位置） |

**默认的安全设置：**
- 每个 HTTP 路由和 WebSocket 都要求 HttpOnly 会话 Cookie，Cookie 根据 `<config dir>/token` 校验。
- 会话、文件浏览和终端只能在已添加的 Git 项目目录和它们的 worktree 里使用。`.git`、路径穿越、指向项目外的符号链接都会被拒绝。
- 终端在每台机器上都**默认关闭**。打开后，创建、连接、结束终端都会记日志。
- 密钥文件的权限太宽（POSIX 权限或 Windows ACL）时，守护进程不会启动。

---

## 本地开发

```bash
bun run --cwd packages/web dev   # 监听前端变更并自动重新构建到 packages/web/dist
bun run check                    # vendor tag 检查、oxlint、oxfmt --check、类型检查
bun run test                     # 单元测试与集成测试（protocol、daemon、web）
bun run test:live                # 针对本机 omp 的契约测试（不触发真实模型调用）
bun run sync:upstream            # 更新 vendor/oh-my-pi submodule 后同步 catalog 依赖版本
```

> 不要直接改 `vendor/oh-my-pi` 里的文件。它是 submodule，固定在上游 `oh-my-pi` 的某个 release tag 上。自己的改动放在 `packages/protocol`、`packages/daemon` 或 `packages/web` 里。

## 开源协议

本仓库代码使用 [MIT 协议](./LICENSE)。
