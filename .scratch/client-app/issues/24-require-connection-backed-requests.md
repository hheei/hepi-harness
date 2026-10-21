# 24 — 共享产品请求统一由 connection 发出

Type: implementation
Status: **complete 2026-10-20** — the page-origin fallback is gone from every shared request seam, and the fixtures that
were relying on it now inject a connection.
Blocked by: [17](./17-retire-next-and-transition-paths.md) (complete 2026-10-19)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

共享产品组件只有一个请求来源：当前 WorkbenchConnection。独立fixture提供相同provider，减少缺省page-origin传输分支。

## Scope

依据 [Pilo 研究](../../../docs/research/pilo-simplicity-review.md)，核对 packages/ui/src/lib/api-request.ts、capability-availability.ts、workspace-api.ts、hooks/useSessionUiState.ts 与所有调用方，移除仅为旧fixture存在的 pageOriginRequest fallback。useCapabilityServed 当前只使用path，收掉无消费者的自选request参数；fixture在真正产品入口的connection/provider下运行。保留独立Markdown/资源渲染需要的optional context，以及明确属于Web宿主的登入/公共探测请求。

## Acceptance

- [x] 列出每个fallback消费者与处理结果：产品要求既有connection，独立fixture注入provider；无静默退回全局fetch的共享产品请求。

| Consumer | Before | After |
| --- | --- | --- |
| `useApiRequest` (`lib/api-request.ts`) | `connection?.client.request ?? pageOriginRequest` | `useWorkbenchConnection().client.request`; six call sites (ModelsConfig ×4, SettingsPanel, ExtensionsConfig, EnabledModelsSection ×2, McpConversationTools, OAuthDetail) unchanged |
| `useWorkspaceApi` + `useConfiguredHome` (`lib/workspace-api.ts`) | same fallback, and `scope ?? ""` | `useWorkbenchConnection().client.request` / `.scope` (DirectoryPicker, NewProjectDialog, SessionSidebar, NewSessionContextBar) |
| `useSessionUiState` (`hooks/useSessionUiState.ts`) | same fallback | `useWorkbenchConnection().client.request` (SessionSidebar, sidebar fixture) |
| `useCapabilityServed` (`lib/capability-availability.ts`) | `request ?? connection?.client.request ?? pageOriginRequest` | `useWorkbenchConnection().client.request`; the unused `request` parameter and the `pageOriginRequest` export are removed |
| `pageOriginRequest` | exported fallback helper | deleted — no consumer remained |

`useOptionalWorkbenchConnection` stays for the two seams that are genuinely optional (a message body's standalone Markdown rendering, and file-bytes/preview hooks), and the Web host's own `fetch("/api/web-auth")`, `/api/web-login`, `/api/durable-login` and the App's update check keep the page's transport because those routes are the page host's, not the Backend's.

- [x] 六个现行useCapabilityServed调用与并行新增调用全部迁移，失效request参数和fallback helper在无消费者后移除。
      The six calls (`OAuthDetail` once, `EnabledModelsSection` once, `ModelsConfig` four times) now pass a path only, and
      no call site passes a transport.
- [x] capability-availability.test.mjs 中检查fallback源码字符串的断言替换成实际provider请求行为证据，复用现有fixture/driver。
      The source-string assertions are gone. The replacement builds a real `createClient` over a synthetic transport and
      asserts the three answers at the seam — `true` for 200, `false` for `501 {code:"unsupported"}`, `null` for a lost
      request and for a disposed connection — plus the exact URL and the `accept` header the rule sends, with the page's
      `fetch` replaced by a thrower so a fallback would fail the test instead of passing it.
- [x] 真实cookie/bearer场景均向当前ingress发请求；connection disposal后停止请求，现有能力不可用提示与重试行为保留。
      `ux-capability-trust.mjs` (cookie connection, real Chromium) PASS: served/unsupported/unknown still read as the three
      answers and no control is offered on a guess. `ux-panel-ingress.mjs` (device bearer) records 0 page-origin requests
      and every panel request on the configured ingress origin with the connection's bearer. `capabilityServed` on a
      disposed client reads `null` and reaches no transport.
- [x] 独立Markdown与Web宿主登入/公共探测保持实际用途，不新建全局client或另一provider层；当前client-ingress指南更新。
      `MarkdownBody`/`useFileBytes`/`ChatInput`'s optional connection is unchanged; `workbench.tsx`'s descriptor probe,
      `/api/web-auth`, `/api/web-login` and the App update check still use the page's `fetch`. No new client layer:
      `docs/client-ingress.md` records one transport rule and the one connection assembly.

## Verification

定向搜索调用方；运行受影响的capability/workspace/sidebar检查及现有ux-capability-trust browser fixture。按变更追加connection切换/清理的现有公开seam验证，再跑相关typecheck与 pnpm verify:changed。只验证正常产品流程及普通生命周期，不设计绕过认证/授权或系统边界的探测。记录command、revision、exit与log。

Tested source `0a3d065eb259f9ec19f9af4c6e8f631b34f90cbb`, dirty tree carrying tickets 23/24/25 (one commit block).

| Command | Exit | Result / log |
| --- | --- | --- |
| `rg -n 'pageOriginRequest|useOptionalWorkbenchConnection' -g '!node_modules' .` | 0 | no `pageOriginRequest`; the optional hook remains only in `MarkdownBody`, `ChatInput`, `useFileBytes` and its own definition |
| `node --test packages/ui/src/lib/capability-availability.test.mjs` | 0 | 3 pass (notice key, refusal shape, provider request behaviour) |
| `node --test` over every `packages/ui/src/**/*.test.mjs` (the enumeration `scripts/test-web-unit.mjs` does not cover) | 0 | 355 pass, 0 fail (includes `workspace-api.http`, `workbench-scope`, `workbench-connection`, `useAgentSession.lifecycle`) |
| `pnpm --filter @hepi/ui typecheck` | 0 | `tsc --noEmit` |
| `pnpm --filter @hepi/web typecheck` | 0 | `tsc --noEmit` and the Vite program |
| `node apps/web/e2e/ux-capability-trust.mjs` | 0 | PASS, 20 checks (cookie connection) |
| `node apps/web/e2e/ux-sidebar-ingress.mjs` | 0 | PASS — every request on the connection's origin with its bearer, no page-origin request |
| `node apps/web/e2e/ux-extensions-panel.mjs` / `ux-mcp-tool-states.mjs` | 0 | PASS each, after the fixture supplies the connection the panel reads (previously mounted with none) |
| `pnpm verify:changed --base=0a3d065` | 0 | `.dev/verify/2026-10-20T10-36-30-742-verify-changed/`, `ok: true` |

Recorded pre-existing failure, not introduced here: `node apps/web/e2e/ux-panel-ingress.mjs` times out at its
`/api/sessions/session-1/state` wait (`ux-panel-ingress.mjs:317`) at this tip **and at the pinned `0a3d065` baseline
worktree**, because the production `ExtensionsConfig` already asks `/api/conversations/:id/state` while the fixture still
answers only the retired path. Unchanged by this ticket, so it is left as found.

Committed revision `7345384` (clean tree): `pnpm verify:changed --base=0a3d065` exit 0,
`.dev/verify/2026-10-20T10-40-08-666-verify-changed/verify.json` — sha `7345384f`, `dirty: false`, `ok: true`,
`changed-typecheck`/`changed-test`/`web-unit`/`check-docs` all 0.

## Coordination

17后可与23/25并行；与25、18–21及历史导航的owner协调WorkBench/provider fixture、AppShell和共享hook的同文件改动。既有UX票不增加对本票的依赖。
Landed with 25 because both edit `workbench-scope.ts` and the same fixtures; `AppShell` was not restructured beyond
reading the connection's API.
