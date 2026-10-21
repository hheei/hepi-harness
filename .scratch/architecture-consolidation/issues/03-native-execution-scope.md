# 03: 修正多 exec 身份并使用原生扩展包装

**Parent:** [Architecture consolidation spec](../spec.md)

**What to build:** 一次工具调用可执行多条命令，每条都有独立执行身份；网络重复请求仍受 Gateway ledger 抑制，扩展选择不绕过关联。

**Blocked by:** None (can start immediately)

**Status:** resolved

## Acceptance criteria

- [x] 本仓 ExecutionHostEnv 显式声明 forCall；同一工具作用域内使用隔离词法序号为每次 exec 分配 base#n。
- [x] 不同命令和相同命令的两次 exec 均按两个意图运行；同一执行身份的重复网络请求仍不再次执行，指纹冲突仍拒绝。
- [x] 原工具与 native wraps 同属 coding-tools 选择，保留元数据和既有工作区约束；无独立可关闭的身份包装扩展。
- [x] 普通 ExecutionEnv 和 undefined 经真实方法判断透传；not_supported、env.id、中止与 journal outcome-unknown 行为保持。
- [x] 原手工逐工具 execute 包装退出；执行说明明确默认 unsafe replay、身份记录作用域和 FS 无 journal 的限制。

## Answer

实现于 `work/architecture-consolidation-03`，基线 `b49e44e`（`git merge-base --is-ancestor b49e44e HEAD` 通过）。

- `packages/gateway/src/environment.ts`：`ExecutionHostEnv` 显式声明 `forCall(identity: ExecutionIdentity)`；`gatewayEnvironment(binding, cwd, scope?: { base })` 的第三参数由裸 `durableCallId` 改为作用域；作用域 env 用词法序号 `ordinal` 造 `\`${base}#${++ordinal}\``，无作用域时保持随机 UUID（无去重承诺）。`id`（`withFileMutationQueue` 键）、`cwd`、`Proxy` 的 `not_supported` 兜底、abort 先于 dispatch 的语义均未改动。
- `apps/server/src/harness.ts`：删除逐工具覆盖 `execute` 的安装体（含 `as typeof api.env & { forCall?: ... }` 断言），改为 `{ ...CodingTools, wraps: [...] }`：同名 `coding-tools` 扩展用原生 `wrapTool` 包装自己的工具，选择与身份作用域原子；`withCallScope` 两次运行时判断（env 是否为 undefined、`forCall` 是否函数）后透传。
- 测试：`packages/gateway/test/execution.test.ts` 第三参数改为 `{ base: "env-await-1" }`，新增“一个作用域内每条命令独立身份”（不同命令 ×2 + 相同命令 ×2 全部执行、计数文件为 `onetwosamesame`）；新增 `apps/server/test/execution-scope.test.ts` 在 durable runtime 接缝上断言已安装 `coding-tools` 的调用经 `forCall` 得到 `<conversation>:...:#1` 身份（RecordingLedger 记录 admited callId）、普通 `NodeExecutionEnv` 透传（不触达 gateway）、无 env 时得到 `No execution environment is configured` 工具结果。
- 文档：`docs/architecture.md`（安装形态、身份作用域、账本只记录执行、无 FS journal、默认 unsafe 不重放、非 exactly-once）、`docs/local-integration.md`（身份构成、无作用域时随机 ID、FS 无 journal）。

证据（原始日志 `/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-03/`）：

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| `pnpm --filter @hepi/gateway --filter @hepi/server -r typecheck` | 0 | verify:changed step |
| `pnpm --filter @hepi/gateway test`（185 pass） | 0 | `gateway-suite.log` |
| `pnpm --filter @hepi/server test`（286 pass） | 0 | `server-suite.log` |
| `node --test test/execution-scope.test.ts`（新增，红→绿） | 0 | `red-server.log` / `green-server.log` |
| `pnpm verify:changed --base=b49e44e` | 1（仅 `check-docs`，12 处 pre-existing 断链，与基线 `b49e44e` 完全相同） | `verify-changed.log` |

已合并当前集成 tip `fb46433`（merge `f2e4fbe`），合并后重跑：`pnpm --filter @hepi/gateway --filter @hepi/server -r typecheck` exit=0；`pnpm --filter @hepi/gateway test` 185 pass exit=0（`post-merge-gateway.log`）；`pnpm --filter @hepi/server test` 286 pass exit=0（`post-merge-server.log`）；两条新增用例在合并后仍通过（`one execution scope gives every command its own identity`、`a coding-tools call runs in its own call scope...`）。集成合并 `793eb2d`（ticket 04 + 03）后主工作区复查：`pnpm --filter @hepi/gateway --filter @hepi/server -r typecheck`、`check:docs`、`check:entrypoints` 全部 exit=0，日志 `.dev/verify/consolidation-03/integration/post-merge-primary-checks.log`。

限制（记录，不做）：跨尝试身份稳定性、exec 级 exactly-once、文件写入 journal 均未承诺；`forCall` 依赖上游 `EnvTarget` 缺 taskId/callId 的现状，上游若接受身份字段则该作用域可整体删除。

## Verification seam

复用公共 Gateway HTTP/Execution Environment、扩展选择、执行与 journal 恢复用例；补一组必要的多 exec 回归。

## Integration notes

当前已安装 Bash 单次 exec，缺陷为潜伏。PowerShell 触发还需实际安装与首候选失败；不把此票描述为当前线上崩溃修复，不承诺跨尝试 exactly-once。
