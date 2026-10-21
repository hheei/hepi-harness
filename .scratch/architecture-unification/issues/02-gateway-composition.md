# 02: CLI 与 standalone 使用统一 Gateway 装配

**What to build:** 操作者从任一入口启动 Local 或 SSH Gateway，获得一致能力、配置校验和关闭行为。

**Blocked by:** None (can start immediately)

**Status:** done

**Spec:** [统一设计](../spec.md)

## Acceptance criteria

- [x] 一个 startup Module 拥有 registry、journal、runner、能力、listen 与关闭；两个入口只解析配置及处理入口职责。
- [x] resolved local/SSH 配置互斥；所有能力共享同一 registry，opaque workspace identity 与 runtime registration 保持。
- [x] heartbeat 的 env/config/CLI 支持及优先级一致；非法数值一致拒绝，0 语义保持。
- [x] SSH 自定义 workspace identity 的拒绝行为统一，避免 standalone 静默忽略；合法默认与既有状态目录语义保持。
- [x] plain/shared SSH runner 用途保持，关闭先 surfaces 后 master，重复关闭及启动失败不会遗留本次资源。
- [x] Local/SSH 各走真实 HTTP 能力和已安装 CLI tarball；复制实现删除，公布新共享可导入入口。

## Verification

既有 CLI installed-artifact、Local/localhost SSH worktree/terminal smoke，读取配置后启动公开端口并操作；覆盖 heartbeat 与关闭。 每次结果保存命令、源版本/dirty指纹、实际退出码和原始日志；本 ticket 更新自己的当前指南。

## Context

读取 [已定决策](../decisions.md)、[导航与 owning guides](../navigation.md) 和 [review notes](../review-notes.md)。按 spec 删除被替代知识与路径；可跨 Module 整理，最终 Interface 应统一且可维护。具体源位置在导航表，本 ticket 的行为目标不绑定过时文件布局。

## Delivered

One Gateway composition: `packages/gateway/src/startup.ts`, published as `@hepi/gateway/startup` (`startGateway`,
`RunningGateway`, `GatewayStartupSettings`, `sshProfileOf`, `sshWorkspaceIdProblem`, `remoteWorkspaceId`,
`terminalHeartbeatProblem`, `parseTerminalHeartbeatMs`, `DEFAULT_TERMINAL_HEARTBEAT_MS`). It owns the one
`WorkspaceRegistry`, the call journal, the plain and gateway-managed SSH runners, every surface, the loopback listener
and the close order (surfaces first, then the master this process created), and releases what it created when startup
fails. `packages/gateway/src/main.ts` and `packages/client` (`src/gateway.ts`, `src/config.ts`, `src/cli.ts`) keep
only configuration, defaults, output and signals; the duplicated assembly is deleted. The CLI gained
`--terminal-heartbeat-ms`/`HEPI_TERMINAL_HEARTBEAT_MS` (config-file key included), refused by the same rule the
standalone entry applies, with `0` stating no keepalive. `packages/client/README.md` gained the startup section,
`docs/architecture.md` the composition section, and `docs/deployment.md` its entrypoint pointer. The stale
`packages/client/src/gateway.ts` composition — and the `not_supported` worktree gap the audit recorded against it —
is deleted rather than kept as a shim.

Owning guide: [packages/client/README.md 的启动段](../../../packages/client/README.md).

## Evidence

Source fingerprint: HEAD `1758c1fb4479e9d4637a957857246c5998619d73`, branch `integration/architecture-unification`,
dirty tree (115 entries, prior fixes retained). Blob hashes, per-file sha256 and the slice diff hash are in
`.dev/ticket02/fingerprint.txt`; the owned slice is `packages/gateway/src/startup.ts` (new),
`packages/gateway/src/main.ts`, `packages/gateway/package.json`, `packages/gateway/test/startup.test.ts` (new),
`packages/client/{src,test,README.md,package.json}`, plus the owning guides
`packages/client/README.md`, `docs/architecture.md`, `docs/deployment.md`.

**No additive export is needed from `packages/gateway/src/index.ts`.** That file belongs to the ticket-03 worker and
was not read-modified: `startup.ts` imports the composition parts from their own modules (`execution.ts`,
`filesystem.ts`, `install.ts`, `runner.ts`, `ssh-filesystem.ts`, `ssh-workspaces.ts`, `terminal.ts`,
`workbench/index.ts`, `mcp/*`) and from `./index.ts` only what it already exports (`GatewayRpcServer`,
`LocalGateway`, `SshGateway`, `GatewayWorktrees`, `TerminalSessions`, `localTerminalLauncher`,
`sshTerminalLauncher`, `createSystemSshRunner`, `managedControlMaster`, `WorkspaceRegistry`,
`sshWorkspaceSeed`, `WorkspaceServer`, `localExecutionHostIdentity`, `agentDirOf`, `McpHostService`,
`type SshProfile`). The shared entry is published as the package subpath `@hepi/gateway/startup`.

| Command | Exit | Log |
| --- | --- | --- |
| `pnpm --filter @hepi/client build` | 0 | `.dev/ticket02/build.log` |
| `pnpm --filter @hepi/client smoke:pack` (installed tarball: local + real localhost sshd) | 0 | `.dev/ticket02/smoke-pack.log` |
| `node .dev/ticket02/entry-smoke.mts` (standalone entrypoint, both modes, SIGTERM) | 0 | `.dev/ticket02/entry-smoke.log` |
| `node --test packages/gateway/test/startup.test.ts` | 0 | `.dev/ticket02/startup-test.log` |
| `node --test packages/gateway/test/*.test.ts` | 1 | `.dev/ticket02/gateway-tests.log` |
| `pnpm verify:changed --base=HEAD` | 1 | `.dev/verify/2026-10-14T16-54-57-676-verify-changed/` |
| `pnpm check:docs` | 0 | stdout: 233 files, 0 broken links |

The startup suite covers, over real HTTP: one registry behind execution, files, workspaces, worktrees and MCP; the
listener's own port; close releasing it (twice, nothing closed twice); a bind failure that leaves the first gateway
serving and the failed attempt's journal reusable; the terminal keepalive cadence on both terminal streams and its
absence at `0`; local/SSH settings mutual exclusion; and the SSH composition against a real localhost `sshd` — the
remote host's own account, a read, an execution, `mcp_unavailable`, the `remote-<profile>` refusal, the prepared
control directory and its reaping. `smoke:pack` passes 6/6 on the installed tarball, including the SSH gateway.

The standalone entrypoint smoke (`.dev/ticket02/entry-smoke.mts`, four checks, exit 0) starts
`packages/gateway/src/main.ts` from configuration alone: a local gateway serving a read and MCP on its configured port,
an SSH gateway against a real localhost `sshd` (the remote account's own answer, a read, `mcp_unavailable`), both
stopping at SIGTERM with exit 0; a custom `HEPI_WORKSPACE_ID` refused with the shared wording; and an unusable
`HEPI_TERMINAL_HEARTBEAT_MS` refused by the same rule the CLI applies. It kills every process it spawned.

The remaining non-zero steps name other workers' in-flight paths, never one this ticket owns:
`packages/gateway/test/terminal-stream-budget.test.ts` "a legal aggregate replay of several tabs' control and Unicode
output arrives whole" (1 of 177 gateway tests; ticket 03's `index.ts`/`terminal.ts`), and `web-unit`'s 36 recorded
`not ok` names (MCP/trust/settings and session-hook scenes; tickets 06/07). `workspace-typecheck` passes.
`packages/client` is 10/10 green.
