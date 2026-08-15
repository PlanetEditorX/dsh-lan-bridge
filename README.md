# dsh-lan-bridge

让局域网（手机/平板）完整使用 DeepSeek Harness Web GUI 的本地反向代理。

## 问题背景

Harness Web GUI 有一个 `/api` 信任栅栏（`dsh-client-connection`）：

- 普通 API（会话、模型目录、工作区等）通过 `trustedHosts` 自动信任本机 LAN IP —— 手机本来就能用；
- **特权方法**（`settings.*` 设置、`credentials.*` 凭据、`agentPreset.*`、`host.pickDirectory` / `host.openPath` 原生对话框、`llm.discoverModels`）被**钉死在 loopback**（官方设计：在真正的鉴权层出现之前，配置面只对 loopback 同源开放）。所以从局域网打开页面没问题，但设置等全部返回 403。

栅栏只检查请求头（`Host` / `Origin`），不检查 socket 来源。因此本机上一个把 `Host`/`Origin` 改写成 `127.0.0.1:2881` 的反向代理，就能让局域网设备通过它使用**全部** API。

## 原理

```
手机 ── http://192.168.1.x:2882 ──▶ dsh-lan-bridge（随 profile 启动/停止）
                                        │  改写 Host: 127.0.0.1:2881, Origin: http://127.0.0.1:2881
                                        ▼
                                harness Web server (127.0.0.1:2881)
                                /api（含特权方法）+ 静态页面 + WebSocket
```

- HTTP 与 WebSocket 升级（`/api/events.mux`、`/api/events.host`）都转发；
- 生命周期绑定 profile：Harness 启动即启动，退出即关闭，无需额外服务/计划任务；
- 默认监听 `0.0.0.0:2882`，目标端口自动跟随 `webServer` 服务端口（当前 2881）。

## 安全警告（重要）

1. 该桥**不是鉴权**：能连到 `2882` 端口的任何设备 = 完整 agent + 配置面（含凭据/密钥状态）控制，与「loopback 完整权限」等价；
2. 只放在可信局域网，防火墙规则限定 private/domain 配置文件；
3. **切勿**对公网做端口转发；
4. 直接访问 `http://<LAN-IP>:2881` 仍保持官方限制（仅非特权 API）——这层保持原样作为纵深防御。

## 安装（web profile）

```bat
install.cmd
```

该脚本会：把本包同步到 `%USERPROFILE%\.dsh\lan-bridge`、把 `dsh-lan-bridge` 以
`file:../../lan-bridge` 依赖写入 web profile 的 `package.json` 并执行 pnpm install
（如 pnpm 可用）、向 `cordis.patch.yml` 追加 `lan-bridge` 行（幂等），并打印防火墙命令。

然后**重启 DeepSeek Harness**（或等待 profile patch 热重载）：
手机访问 `http://<电脑LAN-IP>:2882`。

防火墙（管理员 PowerShell，端口 2882，若 2881 规则已存在可只加 2882）：

```powershell
netsh advfirewall firewall add rule name="DeepSeek Harness Web LAN Bridge" dir=in action=allow protocol=TCP localport=2882 profile=private,domain
```

## 配置（cordis.patch.yml 中的 lan-bridge 行）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 关闭桥（行保留但不起作用） |
| `listenHost` | `'0.0.0.0'` | 监听地址；可收窄为具体 LAN IP |
| `listenPort` | `2882` | 局域网访问端口 |
| `targetHost` | `'127.0.0.1'` | 上游 harness 地址 |
| `targetPort` | `2881` | 上游端口；存在 `webServer` 服务时自动跟随其端口 |

## 独立运行（不依赖 profile，用于测试）

```bat
node bin\lan-proxy.mjs --port 2882
```

## 非安全上下文修复：`crypto.randomUUID is not a function`

局域网 IP 的 http 页面属于**非安全上下文**，`crypto.randomUUID`（安全上下文专属 API）不存在。
而前端 `dsh-client-connection` 的浏览器端**每次 RPC 都用它生成 rpcId**（`lib/client.js`），
所以手机端即使通了桥，所有服务也会因该报错挂掉（同剪贴板问题一类）。

修复（**纯插件方案，软件本体零改动**）：本代理对所有 `text/html` 响应在 `</head>` 前注入
基于 `crypto.getRandomValues`（非安全上下文也可用）的 UUID v4 polyfill —— `htmlInject` 选项，
默认开启，`false` 关闭，自定义字符串可替换。随 profile 启动即生效，前端更新后依然有效。

早期曾直接在 `resources\host\...\dsh-web-frontend\dist\index.html` 注入补丁（立即生效但会被
官方更新覆盖），已按用户要求**撤销并还原原文件**。手机端如仍报错，硬刷新（无 Service Worker，
普通刷新即可）一次。

## 注意

- 本包安装在 profile 的 `node_modules`（由 pnpm 管理，`file:` 依赖指向 `~/.dsh/lan-bridge`）。
  升级 Harness 或执行 `dsh plugin` 增删后如失效，重跑 `install.cmd` 即可。
- 手机为非安全上下文：剪贴板复制等能力受浏览器限制（与官方 2881 行为一致）。
