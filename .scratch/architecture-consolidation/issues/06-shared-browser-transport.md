# 06: 让 Web 与诊断页共用连接生命周期

**Parent:** [Architecture consolidation spec](../spec.md)

**What to build:** Web 前台/后台订阅与 Backend 诊断页使用一份连接生命周期实现，各自认证方式继续可用。

**Blocked by:** None (can start immediately)

**Status:** resolved

## Acceptance criteria

- [x] 现有 Web 多订阅者连接语义迁入 session 浏览器子路径，Web 与诊断页均接入；两处被适配过的旧运行时副本退出，vendor 保留。
- [x] 每会话一条 source，多个读者共享；ready、reconnect、release、最后读者释放与订阅交接行为保持。
- [x] Web 使用同源 cookie BFF source factory，诊断页使用 bearer factory；浏览器 Web props 不包含 Backend/宿主 token。
- [x] session 纯根保持无浏览器依赖，packages 不依赖 apps；诊断页构建与使用不要求 Web 应用源码在场。
- [x] 本票保持现有浏览器载荷可工作；若需要过渡事件适配，其删除明确由 08/09 承接，不能留下第二个连接管理器。

## Verification seam

复用多订阅者连接、后台预算/交接和诊断浏览器 session 检查；验证最后释放会关闭 source，Backend 诊断 bundle 能独立构建。

## Integration notes

这是后续载荷切换的 expand 切片，交付两种真实消费者共享生命周期；不在本票提前切换 Web HTTP/SSE 协议，也不将通用调度器塞入 transport。

## Comments

### Resolution (2026-10-15)

**Status:** resolved. Commit `0307c18` + merge `20f7733`（integration tip `4b9e0c6` 已并入）。

交付：

- `packages/session/src/agent-event-connection.ts` —— Web 的多订阅者连接实现物理迁入（`git mv`，语义不变：每会话一条 source、`ready`/`reconnect`/`release`、最后读者释放）。顶层参数属性与 `private readonly` 构造参数改写为显式字段，因为 `packages/session` 的测试用 Node strip-only TS 直接跑 `src`。
- `packages/session/src/browser.ts` —— `"./browser"` 出口新增 `cookieBffSource(basePath="/api/agent")` 与 `bearerSource(origin, token)` 两个 factory，并 re-export 连接类型；`BrowserDurableSession` 改接同一条连接（`subscribe` + `ready`），旧的 `maintain/ensureConnected` 单连接副本删除。
- 删除两处被适配副本：`packages/session/src/pi-web/agent-event-connection.ts`、`apps/web/lib/agent-event-connection.ts`（及其旧测试）。`apps/web/vendor/pi-web/agent-event-connection.ts` 字节与 LICENSE 未动。
- 消费者改接：`apps/web/components/AppShell.tsx` 用 `cookieBffSource()`；`apps/web/lib/completion-delivery.ts`、`apps/web/hooks/useAgentSession.ts` 改从 `@hepi/session/browser` 导入。`apps/web/package.json` 新增 `@hepi/session: workspace:*`（lockfile 同步）。
- `packages/session` 纯根 `"./"` 未新增任何浏览器依赖；`packages/*` 不依赖 `apps/*`。

验证（命令/退出码/原始日志，均在 `.dev/verify/consolidation-06/`）：

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| `pnpm install --offline --frozen-lockfile` | 0 | `pnpm-install.log` |
| `node scripts/verify.mjs --profile=full --log-dir=.dev/verify/consolidation-06/verify-full-merged` | 0（3/3 PASS：workspace-typecheck、workspace-tests、web-unit） | `verify-full-merged.stdout`、`verify-full-merged.json` |
| `pnpm --filter @hepi/session test` | 0（25 tests，25 pass） | `session-test.log` |
| `pnpm --filter @hepi/server build:ui`（诊断 bundle） | 0（`public/chat.js` 17.5kb，bundle 内引用 `packages/session/src/agent-event-connection.ts`，0 处 `apps/web`） | `build-ui.log` |
| `pnpm --filter @hepi/server test`（含 `browser-session.test.ts` 真实后端字节） | 0（285 pass） | `verify-full-merged/workspace-tests.log` |

Web 单元基线由 64 files/111 tests 变为 63 files/109 tests：连接契约随实现迁走 2 个用例，新增的 5 个用例落在 `packages/session`。

**Ticket 08 需要知道的接口变更**：

- 连接实现与类型现在从 `@hepi/session/browser` 导出（`AgentEventConnection`、`AgentEventSubscription`、`AgentEventSourceLike`、`AgentEventConnectionError`、`AgentEventLike`）；`apps/web/lib/agent-event-connection.ts` 已不存在。
- 装配点有一个显式 seam：`createSource` 现在是 `cookieBffSource()`（Web，同源 URL、无认证头）或 `bearerSource(origin, token)`（诊断页）。08 的字节透传改造只需改 Web 的 BFF 路由与 source URL，不需要碰连接生命周期。
- `AgentEventConnection.subscribe(conversationId, listener)` 的 listener 仍收 `AgentEventLike`（本票不引入 `ConversationStreamEvent`）；`AgentEventLike` 现由 `packages/session` 声明，`apps/web/lib/agent-event-wire.ts` 的同名接口结构相同，两者可互相赋值。
- Web props 未新增任何 token/宿主凭据；`AppShell` 只传同源路径。

### Coordination

- 未编辑 `packages/session/src/index.ts`（ticket 05 独占）。`browser.ts` 只新增对 `"./browser"` 的导出与 factory，未改 `index.ts` 的公开 API。
- 未新增连接管理器、调度器或第二份 source；`CompletionDelivery` 的预算/交接逻辑未改。
