# 25 — 每个 connection 只组装一次 ConversationApi

Type: implementation
Status: **complete 2026-10-20** — the API is a field of the connection, built with it in one place, and the seven surfaces
that read it take the connection's.
Blocked by: [17](./17-retire-next-and-transition-paths.md) (complete 2026-10-19)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

六个会话UI消费者直接取得connection拥有的ConversationApi，无需各自useMemo组装同一对象。

## Scope

依据 [Pilo 研究](../../../docs/research/pilo-simplicity-review.md)，在现有WorkbenchConnection建立时组装一次createConversationApi(client)。AppShell、SessionSidebar、SessionSearch、RawHistoryPanel、SettingsPanel、useAgentSession改为取用该对象；更新所有构造connection的fixture。保留conversation-api.ts的typed目录投影、路由、control及requestId/outcome_unknown合同，底层WorkbenchClient继续负责传输。

## Acceptance

- [x] 每个有效connection有一个与client绑定的ConversationApi；六个现行消费者及并行新增消费者不再重复实例化。
      `WorkbenchConnection.api` is stated by `workbenchConnection(client, identity)` in
      `packages/ui/src/lib/workbench-scope.ts`, which is also the one place the scope key, the identity and the file seam
      are derived. Consumers now holding `connection.api`: `AppShell`, `SessionSidebar`, `SessionSearch`,
      `RawHistoryPanel`, `SettingsPanel`, `useAgentSession`, and `ReferencePanel` + `ChatWindow` which assembled their
      own (`ReferenceApi` is now `Pick<ConversationApi, …>`). `createConversationApi` has one caller left: the
      assembly. `conversation-api.http.test.mjs` still constructs one directly, which is that module's own seam.
- [x] effect创建/清理维持StrictMode语义；connection替换取得新API，旧client disposal继续隔离旧请求和迟到回答。
      The client is still created and disposed by the effect pair in `workbench.tsx`; only the assembly call moved inside
      it, so a StrictMode replay gets a live client with a live API and the cleanup still owns disposal. Disposal reaches
      the API because every method is a request on the disposed client (`workbench-connection.test.mjs` asserts
      `api.settings()` rejects `/closed/` after `client.dispose()`; `client.test.mjs` and
      `ux-workbench-scope.mjs` keep the existing disposal/stream cases).
- [x] 现有会话list/search/read、控制、目录投影、fork/委派及附件合同保持，通过相关既有seam证据；不把未知mutation自动重发。
      `conversation-api.ts` itself is unchanged: no line of the catalogue projection, routes, `createConversationControl`
      wiring, request-id or `outcome_unknown` rule moved. `conversation-api.http.test.mjs` (20.5K, against a real
      ingress) passes unchanged, as do `useAgentSession.lifecycle`, `ux-references`, `ux-navigation-retry`,
      `ux-subtree-control`, `ux-deferred-text`'s unit seam and `ux-sidebar-ingress`.
- [x] fixture与provider使用同一连接组装方式；实现不增加全局singleton、registry或第二状态层。
      Every fixture that mounts a connection now calls `workbenchConnection(client, identity)` instead of hand-building
      the object: `ux-{capability-trust,deferred-text,delegate-definition-race,docx-preview,file-failures,file-surfaces,
      navigation-retry,panel-ingress,references,sidebar-ingress,skills-inventory-race,skills-project-target,
      subtree-control}`. `ux-extensions-panel` and `ux-mcp-tool-states` gained the provider they were missing. No
      singleton, registry or second state layer was added; the API is a value on the connection the provider already
      held.
- [x] FileSeam、lifecycle acquisition、历史hydration/cache的职责保留；probe-client bootstrap优化留作后续研究，不捆绑实现。
      `FileSeam` is still `createFileSeam(client)` and still part of the connection (the function was inlined into the
      assembly rather than kept as a second export no fixture used twice). The acquisition generation, the history
      hydration and `session-view-cache`/`models-cache` are untouched. The probe client in `workbench.tsx` is unchanged.
- [x] 更新当前connection组装指南，记录实际净diff；API主体仍然存在，不把搬迁行数冒称删除。
      `docs/client-ingress.md` documents the one assembly and lists the surfaces that read it; `docs/migration-status.md`
      records that the API is built with the connection. Net diff for this ticket: 8 consumer files 26+/34-, `workbench-scope.ts`
      25+/3-, `workbench.tsx` 4+/2-, 15 fixtures 72+/68-, and the new `workbench-connection.test.mjs`. The ~112-line API
      implementation is unchanged — this removes repeated assembly, not the API.

## Verification

相关connection/workbench与conversation-api现有测试、正常会话Web/App seam、StrictMode与disposal现有生命周期检查、相关typecheck及 pnpm verify:changed。复用未变协议证据，记录command、revision、exit与log。

Tested source `0a3d065eb259f9ec19f9af4c6e8f631b34f90cbb`, dirty tree carrying tickets 23/24/25 (one commit block).

| Command | Exit | Result / log |
| --- | --- | --- |
| `rg -n 'createConversationApi' -g '!node_modules' -g '!graphify-out' .` | 0 | one product caller (`workbench-scope.ts`), plus `createConversationApi`'s own http test |
| `node --test packages/ui/src/lib/conversation-api.http.test.mjs` | 0 | passes unchanged against a real ingress |
| `node --test packages/ui/src/lib/workbench-connection.test.mjs` | 0 | 2 pass — one API bound to its client (its own route, then nothing after disposal), and a hook outside a connection refusing instead of asking the page's origin, asking the connection's once inside one. A third case that grepped eight component sources for `createConversationApi`/`useWorkbenchConnection` was dropped in review: it mirrored the implementation instead of a behaviour. |
| `pnpm --filter @hepi/ui typecheck` / `@hepi/web typecheck` | 0 | both `tsc --noEmit` programs |
| `node --test` over `packages/ui/src/**/*.test.mjs` | 0 | 355 pass |
| `node apps/web/e2e/ux-workbench-scope.mjs` | 0 | PASS — two connections, real storage/blob leases, disposal refusing later requests |
| `node apps/web/e2e/ux-references.mjs`, `ux-navigation-retry.mjs`, `ux-subtree-control.mjs`, `ux-file-surfaces.mjs`, `ux-file-failures.mjs`, `ux-docx-preview.mjs`, `ux-skills-project-target.mjs`, `ux-skills-inventory-race.mjs`, `ux-delegate-definition-race.mjs` | 0 | PASS each |
| `pnpm verify:changed --base=0a3d065` | 0 | `.dev/verify/2026-10-20T10-36-30-742-verify-changed/`, `ok: true` |

Committed revision `7345384` (clean tree): `pnpm verify:changed --base=0a3d065` exit 0,
`.dev/verify/2026-10-20T10-40-08-666-verify-changed/verify.json` — sha `7345384f`, `dirty: false`, `ok: true`,
`changed-typecheck`/`changed-test`/`web-unit`/`check-docs` all 0.

## Coordination

17后随现有会话整合批次实施；同24及history、MCP、references owner协调workbench-scope、AppShell、useAgentSession和fixture写入。可与23/24按路径并行，不反向阻塞16/17或18–22，不新建状态机。
Landed with 24 (shared files: `workbench-scope.ts`, `workbench.tsx`, fixtures). `AppShell`'s connection assembly was not
restructured, and the subagent-recovery components and the `ux-references` acceptance fixture were left to their owners.
