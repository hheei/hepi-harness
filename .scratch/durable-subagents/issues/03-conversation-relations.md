# 03: 持久化会话来源、展示关系与引用

**What to build:** 用户或宿主创建独立主会话和显式 child，并通过统一查询区分谁创建、展示在哪、从哪里 fork；另一已授权会话可引用目标而不改变其归属。

**Blocked by:** None (can start immediately)

**Status:** resolved

**Labels:** ready-for-agent

**Spec:** [D01](../spec.md#d01)、[D03](../spec.md#d03)、[D14](../spec.md#d14)；[验收 A02、A22](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] 核心 spawn/get 接受已解析完整配置、明确 creator、可选展示 parent、显式 ownership/执行绑定和稳定请求身份；不解释代理定义。
- [x] 创建/provenance/关系初始化与请求去重在同一创建接缝成立；同 request 不重复会话。创建独立 B 时 createdBy=A 但无展示 parent。
- [x] 关系文档仅保存 hepi 所有的 createdBy/hierarchy/provenance；native fork source 与 owner 直接投影，不复制可变权威记录。
- [x] 同事务校验自引用/成环；跨会话引用保存 conversation/可选 entry 身份，不自动复制全文、改 parent、取得控制权限或迁移主机。
- [x] get 按 ID 返回关系/有效配置或按过滤分页列举，复用 catalogue/watch 投影，不另建图服务；不泄露 provider 凭据。
- [x] 父 tombstone 后保留 child 关系与可读身份，显示父不可用事实而不提升为独立主会话；原引用仍可解释。
- [x] 真实 SQLite 重开后 creator、parent、fork/owner 读投影、引用和 provenance 一致；已授权非自己 child 的目标不被展示关系误拒绝。

## Verification seam

- 公开创建/get/catalogue/引用 HTTP 接缝，验证 A→独立B、A→childC、B引用C 的可观测字段。
- 使用注册的受控原生 task 提供显式 ownership；实际 subagent anchor 创建由06负责，不用 ownerless 默认替代。

## Scope and handoff

不放开 child fork 的现有拒绝；实际子分支及导航由11交付。不做展示树拖拽重组。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。

## Evidence

Branch `impl/durable-subagents-03`, base 3e719d8, integration tip 27a1d68 merged before completion. Code:

- `apps/server/src/conversation-operations.ts` — the one creation/relation seam. `spawn` writes the parsed agent configuration, the native ownership, the explicit `createdBy`/`displayParentId`/`workspaceId` binding, the relations and a session-scoped request index in one commit; a replay of the same `requestId` answers the same conversation. `get` returns the relations, the native fork/owner edges projected from the record, the references and a credential-free effective config. `RelationsDoc`/`ReferencesDoc` hold only hepi-owned facts; `WorkspaceDoc` moved here from `server.ts`.
- `apps/server/src/server.ts` — `POST /api/conversations` uses the seam (creator/displayParent/requestId/provenance); `GET /api/conversations/:id` answers the catalogue row plus relations/native edges/references/config; `POST /api/conversations/:id/references` saves a structured reference; `GET /api/conversations` filters and pages by `createdBy`/`displayParentId`/`forkSource`/`ownerConversationId`/`workspaceId`. Catalogue rows carry `createdBy`, `displayParentId` and `displayParentDeleted` separately from `parentConversationId` (fork source) and `subagentParentConversationId` (native owner).
- `packages/protocol/src/index.ts` — `ConversationRelations`, `ConversationProvenance`, `ConversationReference`, `ConversationConfig`, `ConversationInfo`.
- `docs/architecture.md` — new “Conversation relations and references” section.
- `apps/server/test/conversation-relations.test.ts` — six tests through the core seam and the HTTP routes.

Commands and raw logs (all exit 0; node v26.5.1, pnpm 12.4.1, logs under the git-ignored `.dev/verify/durable-subagents-03/`):

| Command | Result | Log |
| --- | --- | --- |
| `pnpm --filter @hepi/protocol typecheck` | exit 0 | `typecheck-protocol.log` |
| `pnpm --filter @hepi/server typecheck` | exit 0 | `typecheck-server.log` |
| `cd apps/server && node --test test/conversation-relations.test.ts` | exit 0, 6/6 | `test-conversation-relations.log` |
| `cd apps/server && node --test test/*.test.ts` | exit 0, 295/295 | `test-server.log` |
| `pnpm --filter @hepi/protocol test` | exit 0, 47/47 | `test-protocol.log` |

Repository selector: `pnpm verify:changed --base=integration/durable-subagents` at f8483d4 (clean tree) — `changed-typecheck` exit 0, `changed-test` exit 0 (server 295, protocol 47, gateway, session), `web-unit` 118/118 exit 0; the only failing step is `check-docs` exit 1, with the same 12 pre-existing broken `.scratch/**` links present at the base revision 2197a18 (reproduced in a detached baseline worktree). Report: `.dev/verify/2026-10-16T07-33-14-567-verify-changed/verify.json`.

Observable acceptance covered: A creates independent B (`createdBy=A`, no display parent, no task owner) and child C (`displayParentId=A`); B references C without changing C's relations; catalogue filters and paging; a tombstoned display parent keeps the child edge with `displayParentDeleted` and the child is not promoted; relations/references survive a real SQLite reopen; a task-owned child projects its native owner edge separately from its hepi creator; the by-id config is credential-free.

Limits: the hierarchy self/cycle guard lives in the one relations writer, but on the create path a cycle is structurally impossible — a new conversation has no descendants — so the reachable refusals here are an unknown creator/parent and an unknown reference target. Model `agent_*` tools, real subagent anchor execution and child forks remain tickets 06/08/11; `ConversationOperations.read`/`send`/`stop` are reserved for tickets 04/02/08.
