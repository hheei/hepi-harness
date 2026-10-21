# 审计建议 1：hepi-client gateway 装配 Worktree（agent-7）

基准 revision：`1758c1fb4479e9d4637a957857246c5998619d73`（master，共享工作区 dirty：其他 worker 的 12 个改动）。
本 worker 独占 `packages/client/**` 与本文档；未触碰 `packages/gateway`、`docs/`、其他 worker 路径。未部署、未推送、未提交、未 stash、未 reset。

## 缺口与触发

经分发 CLI（`hepi-client gateway`）启动的 gateway 不装配 worktree surface：`packages/client/src/gateway.ts` 把
`GatewayRpcServer` 的 `worktrees` 参数固定传 `undefined`，`POST /v1/worktrees` 因此固定返回
`{ok:false, code:"not_supported", message:"this host cannot serve worktree operations"}`，而独立入口
`packages/gateway/src/main.ts` 已有该能力。触发路径是正常的用户流程：Web 侧 worktree 选择/创建/删除经由分发 CLI
的 gateway 时全部失败。disposition：`fix`。

## 修复（最小连贯改动，owner seam）

`packages/client/src/gateway.ts` —— 复用 `main.ts` 已有的组合方式与共享 registry，不新增抽象：

- `const worktrees = profile === undefined ? new GatewayWorktrees(workspaces) : new SshWorktreeServer(sshRegistry, { profiles: [profile], runner: runner! });`
- `new GatewayRpcServer(gateway, …, admin, worktrees, terminals, mcp)`（原为 `undefined`）
- 删除“本 CLI 不装配 worktree”的旧注释；SSH 侧沿用 files/workspace surface 的 plain transport（与 `main.ts` 一致，不用 shared master）。

本地与 SSH 现在走同一份 `worktreeRequest` 实现（`packages/gateway/src/worktrees.ts`），两者都从共享
`WorkspaceRegistry` 解析 workspace id，因此运行时注册的 Project 目录同样被服务。disposal 未改：`rpc.close()`
仍由 `close()` 拥有并先于 `master?.close()` 结算。

## 验证证据

| 检查 | 命令 | revision / dirty | exit | 日志 |
| --- | --- | --- | --- | --- |
| 类型检查 | `pnpm --filter @hepi/client typecheck` | 1758c1f / dirty（本 worker 4 文件） | 0 | `.dev/verify/agent7/client-checks.log` |
| 包测试（含新 HTTP worktree 测试） | `pnpm --filter @hepi/client test` | 同上 | 0（10/10 pass） | 同上 |
| 修复前复现 | 临时把 `worktrees` 参数改回 `undefined` 后跑 `node --test test/gateway.test.ts` | 同上 | 1（`listed.ok` false !== true；`/v1/worktrees` 答 not_supported） | `.dev/verify/agent7/prefix-reproduction.log` |
| 构建（workstation） | `pnpm --filter @hepi/client build` | 同上 | 0 | `.dev/verify/agent7/client-build.log` |
| 打包端到端（本地 + 真实 sshd） | `pnpm --filter @hepi/client smoke:pack` | 同上 | 0（6 checks） | `.dev/verify/agent7/client-smoke.log` |

新增测试 `packages/client/test/gateway.test.ts`：用 `run(["gateway", …])` 启动真实 CLI，经公开
`POST /v1/worktrees` 完成 list → create → remove，用 `git` 自身读取结果作证据（checkout 存在、`symbolic-ref`
等于所请求分支、`git worktree list` 不再包含该路径），并断言未注册 workspace 答 `unknown_workspace`（证明路由真装配而
非桩）。断言不镜像实现内部结构。

`smoke:pack` 现在在**打包安装后的** CLI 上验证同一条公开 HTTP 路径：本地 gateway（真实 git fixture）与 SSH
gateway（真实 localhost sshd + `remote-loopback`）各做一次 create/remove，并检查 checkout 的真实存在与消失。输出：
`local gateway — read, command, MCP listing, worktree list/create/remove and refusal of a bad token and a traversal path`、
`ssh gateway — real localhost sshd on port 23888: account, read, command and worktree create/remove through remote-loopback`。

## 行为变化

- 分发 CLI 的本地与 SSH 模式现在都服务 `/v1/worktrees`（list/create/remove），语义、错误码与 `main.ts` 入口一致
  （非 git root 空列表、dirty remove 需 force、未注册 workspace 答 `unknown_workspace`）。
- 未改变：本地专属 `/v1/workbench`、`/v1/mcp` 的装配边界，SSH 的 plain transport 选择，日志与端口绑定。

## 文档

`packages/client/README.md`（本包 owning guide）：surface 列表加入 `/v1/worktrees`；新增一段说明两模式均服务该能力、
路径约定 `<repo>-worktrees/<branch>`、非 checkout 空列表、dirty remove 需显式 force、运行时注册目录同样被服务；
Development 段落说明测试覆盖该 HTTP surface。共享文档未改（`docs/architecture.md:78`、`docs/migration-status.md:293`
已描述该能力由本地与 SSH gateway 提供，与本修复一致，无漂移需要上报）。

## 剩余限制（record）

1. `packages/client/test/` 只覆盖本地 HTTP worktree 路径；SSH 平价由 `smoke:pack`（真实 sshd，需 `HEPI_REQUIRE_SSH_SMOKE=1`
   的发布机）与 `packages/gateway/test/worktrees.test.ts` 覆盖。客户端包内没有 sshd fixture，未为此新建。
2. 线上（remote-host）仍在运行旧 bundle；本次未部署，故线上 `/v1/worktrees` 仍是旧行为，直到按 runbook 重新部署新 tarball。
3. `main.ts` 的 `HEPI_TERMINAL_HEARTBEAT_MS` 仍未由 CLI 暴露——本次范围外，未改。
4. 未做 SSH worktree 的失败/中断矩阵（unreachable/outcome_unknown 分类）；实现复用 gateway 已有分类，未新增行为。
