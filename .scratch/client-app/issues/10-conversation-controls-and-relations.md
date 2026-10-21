# 10 — 迁移会话控制、队列及关系操作

Type: implementation
Status: resolved
Blocked by: [05](./05-shared-ui-routing-and-scope.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

用户在 Web/App 使用现有 stop/continue、队列、fork 和子任务关系而不重复执行写入。

## Scope

将既有会话命令、排队/steer/follow-up、pending-item 操作和适用的控制/lease、fork、委派/子会话入口接入新 client。具体支持集合以 01 完整矩阵为准，业务继续调用 Backend 现有 seam。

## Acceptance

- [x] stop/continue、队列控制与其他已有有副作用命令保留 requestId/receipt/unknown-outcome 语义。
- [x] fork/关系/委派正确保留 provenance 和目标绑定，创建失败不靠整段盲重试制造副本。
- [x] 多客户端同时操作，UI 依 authoritative facts 更新；无新 busy 推断、客户端调度器或第二套状态层。
- [x] 正常、拒绝、响应丢失及恢复的 UI 结果可区分（client seam 三态：值 / 拒绝 / unknown，且 unknown 按 requestId 收敛）。
- [ ] 旧控制路径的消费者全部迁移 —— **未由本票交付**：旧 adapter（`/api/agent/:id`、`/api/sessions/:id`）的 React 消费者
  属票据 05，删除属票据 17。本票交付它们要调用的 seam，未改动旧路径。

## Verification

复用 durable submission/control、fork/delegation 和 pending-item 公开行为场景；在新入口验证丢失响应。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Review notes

涉及 G3/G6，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。

## Answer

### 现在可用的行为

客户端经 client ingress 可调用会话控制的全部命名操作，实现在 `packages/session/src/control.ts` 的
`createConversationControl`：`stop`、`continueRun`、`control`、`send`（含 queue-only 的 steer/follow-up）、
`recallQueue`、`items`/`editItem`/`cancelItem`、`fork`、`delegate`、`addReference`、`info`/`rename`/`remove`。
每个操作都是对 Backend 自身路由的一次请求；control revision、requestId receipt、queued item、branch、reference、
tombstone 全部仍由 Backend 拥有，客户端不持有第二份状态、不推断 busy、不做调度或重试。

一次操作只有三种结果：值、拒绝（4xx，带 Backend 自己的 status/code/reason/message）、unknown outcome（响应未到达，
携带发起该次尝试的 requestId）。unknown 从不重发，只按该 requestId 查询收敛：stop/continue 用 `control(id)`，
消息用 submissions 查询，fork/delegation 用同一 attempt identity 重试（Backend 以既有副本作答）。这正是
[ADR 0006](../../../docs/adr/0006-durable-submission-lifecycle.md) 对 pending submission 已定的规则，本票把它扩展到
控制面其余部分，因此一个会话对丢失的写入只有一套词汇。

provenance 与目标绑定保持不变：fork 保留 native branch point 与 catalogue parent；delegation 的子会话保留
`provenance.definition`（host/scope/name）、createdBy、displayParentId 与 native owner；失败的创建是带 code 的拒绝且不产生
任何副本；重试的 attempt 得到它已创建的那个会话。删除后的会话离开 catalogue、记录仍可按 id 读回，并拒绝全部控制写入
（`session_deleted`）。

### 被测的 seam

`packages/gateway/test/ingress-control.test.ts`：真实 HTTP/SSE 经 client ingress 打到真实 Backend（真实 SQLite、真实
faux model、真实 device credential authority、真实 local execution host 与真实 Agent Definition 文档），一个 Web
cookie 会话与一个 device bearer 同时操作同一会话。没有 mock 内部协作者：丢失响应由一个真实的前置 hop 制造——它把请求
转发到 ingress、等操作真正完成后销毁调用方连接，因此“操作已提交、答案丢失”是真实状态而非构造的异常。断言只读
Backend 的公开答案（status/code/receipt/control/queue/transcript/catalogue/by-id 关系）。

### 证据

本票已合并当前 `integration/client-app` tip；下列命令在**合并后**的工作区重跑，全部 exit 0，日志在
`.dev/verify/ticket-10/`：

| 命令 | exit | 日志 |
| --- | --- | --- |
| `node --test packages/gateway/test/ingress-control.test.ts`（16 tests, 16 pass） | 0 | `.dev/verify/ticket-10/ingress-control.log` |
| `node --test packages/gateway/test/ingress.test.ts`（回归，12 tests, 12 pass） | 0 | `.dev/verify/ticket-10/ingress-regression.log` |
| `node --test packages/gateway/test/ingress-conversation.test.ts`（票据 03 回归，8 tests, 8 pass） | 0 | `.dev/verify/ticket-10/ingress-conversation.log` |
| `pnpm --filter @hepi/gateway --filter @hepi/session --filter @hepi/server -r typecheck` | 0 | `.dev/verify/ticket-10/typecheck.log` |
| `pnpm --filter @hepi/gateway test`（313 tests, 313 pass） | 0 | `.dev/verify/ticket-10/gateway-suite.log` |
| `pnpm --filter @hepi/session test`（34 tests, 34 pass） | 0 | `.dev/verify/ticket-10/session-suite.log` |

行为与路由记录在 [client ingress](../../../docs/client-ingress.md#conversation-control-queue-fork-and-relations)，
面向使用者的控制/关系段落在 [chat](../../../docs/chat.md#control-queue-fork-and-relations-through-the-shared-client)，
能力状态记录在 [migration status](../../../docs/migration-status.md#conversation-control-queue-fork-and-relations-ticket-10)，
命令/revision/exit/log 记录在
[verification](../../../docs/verification.md#conversation-control-queue-fork-and-relations-ticket-10)。

### 合并 integration/client-app 后的复跑（`f1f7608`）

`impl/client-app-10` 在报告前合并了 `integration/client-app` 的 `0e8c34a`（ticket 03 的会话切片与文档）。
合并冲突只在三份文档的相邻小节（`docs/client-ingress.md`、`docs/migration-status.md`、`docs/verification.md`），
按「两边都保留、03 在前 10 在后」合并（`ce6412c`）；代码与测试无冲突，`packages/session/src/control.ts` 与
`packages/gateway/test/ingress-control.test.ts` 未被 integration 侧改动。合并后补上 seam 自身的判定测试（`f1f7608`），
全部命令都在该 HEAD 上复跑，日志在
`.dev/verify/ticket-10-merge/`：

| 命令 | exit | 日志 |
| --- | --- | --- |
| `node --test packages/gateway/test/ingress-control.test.ts`（16 tests, 16 pass） | 0 | `.dev/verify/ticket-10-merge/ingress-control.log` |
| `node --test packages/gateway/test/ingress.test.ts`（12 tests, 12 pass） | 0 | `.dev/verify/ticket-10-merge/ingress-regression.log` |
| `node --test packages/session/test/control.test.ts`（5 tests, 5 pass） | 0 | `.dev/verify/ticket-10-merge/session-control.log` |
| `node --test apps/server/test/{conversation-stop-continue,durable-submissions,pending-item-routes,session-fork,web-delegate,conversation-fork-source}.test.ts`（57 tests, 57 pass） | 0 | `.dev/verify/ticket-10-merge/server-regressions.log` |
| `pnpm --filter @hepi/gateway --filter @hepi/session --filter @hepi/server -r typecheck` | 0 | `.dev/verify/ticket-10-merge/typecheck.log` |
| `pnpm --filter @hepi/gateway test`（313 tests, 313 pass） | 0 | `.dev/verify/ticket-10-merge/gateway-suite.log` |
| `pnpm --filter @hepi/session test`（39 tests, 39 pass，含新增的 `test/control.test.ts`） | 0 | `.dev/verify/ticket-10-merge/session-suite.log` |
| `pnpm check:docs` | 1 | `.dev/verify/ticket-10-merge/check-docs.log`（339 文件中 12 个既有断链，全在 `.scratch/`，指向被 git 忽略的 `.dev/verify/` 与 `.pi/`；本票未新增） |
| `pnpm verify:changed --base=0e8c34a` | 1 | `.dev/verify/ticket-10-merge/verify-changed.log`（`changed-typecheck`、`changed-test`、`web-unit` 均 exit 0；唯一失败项是同一个 `check-docs` 的 12 个既有断链） |

### 合并 integration 的 ticket 07 后（`8973500`，integration tip `b66c46d`）

integration 侧并入 ticket 07（历史/context/媒体 read block）后本票再次合并。冲突仍是同一形态：
`docs/migration-status.md` 与 `docs/verification.md` 两边在同一锚点各自追加能力小节；按票号顺序保留两者——07 在前、
10 在后——无 marker 残留、无内容丢失。`docs/client-ingress.md` 与 `docs/chat.md` 自动合并成功（各自新增独立小节）。
源码与测试无冲突：ticket 07 增加 `apps/server/src/read-block.ts`、`packages/session/src/resources.ts` 与 ingress 的
read-block 路由，本票增加 `packages/session/src/control.ts`，两者无共享文件。日志在 `.dev/verify/ticket-10-integration/`：

| 命令 | exit | 日志 |
| --- | --- | --- |
| `node --test packages/gateway/test/ingress-control.test.ts`（16 tests, 16 pass） | 0 | `.dev/verify/ticket-10-integration/ingress-control.log` |
| `node --test packages/session/test/control.test.ts`（5 tests, 5 pass） | 0 | `.dev/verify/ticket-10-integration/session-control.log` |
| `node --test packages/gateway/test/{ingress,ingress-conversation,ingress-resources}.test.ts`（30 tests, 30 pass；02/03/07 回归） | 0 | `.dev/verify/ticket-10-integration/ingress-regressions.log` |
| `node --test apps/server/test/{conversation-stop-continue,durable-submissions,pending-item-routes,session-fork,web-delegate,conversation-fork-source}.test.ts`（57 tests, 57 pass） | 0 | `.dev/verify/ticket-10-integration/server-regressions.log` |
| `pnpm --filter @hepi/gateway --filter @hepi/session --filter @hepi/server -r typecheck` | 0 | `.dev/verify/ticket-10-integration/typecheck.log` |
| `pnpm --filter @hepi/gateway test`（323 tests, 323 pass） | 0 | `.dev/verify/ticket-10-integration/gateway-suite.log` |
| `pnpm --filter @hepi/session test`（39 tests, 39 pass） | 0 | `.dev/verify/ticket-10-integration/session-suite.log` |
| `pnpm check:docs` | 1 | `.dev/verify/ticket-10-integration/check-docs.log`（339 文件中仍是同样 12 个既有断链，本票未新增） |

### 报告前与最新 integration tip 对齐（`60428f1`，integration tip `2a41b2e`）

integration 随后并入 ticket 06（catalogue binding），本票在报告前再次合并；这次没有冲突（06 的文档追加落在不同锚点，
源码只动 catalogue/绑定路径，与本票的 control seam 无交集）。全部检查在合并后的 HEAD 上重跑，日志在
`.dev/verify/ticket-10-final/`：

| 命令 | exit | 日志 |
| --- | --- | --- |
| `node --test packages/gateway/test/ingress-control.test.ts`（16 tests, 16 pass） | 0 | `.dev/verify/ticket-10-final/ingress-control.log` |
| `node --test packages/session/test/control.test.ts`（5 tests, 5 pass） | 0 | `.dev/verify/ticket-10-final/session-control.log` |
| `node --test packages/gateway/test/{ingress,ingress-conversation,ingress-resources,ingress-catalogue}.test.ts`（32 tests, 32 pass；02/03/06/07 回归） | 0 | `.dev/verify/ticket-10-final/ingress-regressions.log` |
| `node --test apps/server/test/{conversation-stop-continue,durable-submissions,pending-item-routes,session-fork,web-delegate,conversation-fork-source}.test.ts`（57 tests, 57 pass） | 0 | `.dev/verify/ticket-10-final/server-regressions.log` |
| `pnpm --filter @hepi/gateway --filter @hepi/session --filter @hepi/server -r typecheck` | 0 | `.dev/verify/ticket-10-final/typecheck.log` |
| `pnpm --filter @hepi/gateway test`（325 tests, 325 pass） | 0 | `.dev/verify/ticket-10-final/gateway-suite.log` |
| `pnpm --filter @hepi/session test`（39 tests, 39 pass） | 0 | `.dev/verify/ticket-10-final/session-suite.log` |
| `pnpm check:docs` | 1 | `.dev/verify/ticket-10-final/check-docs.log`（339 文件中仍是同样 12 个既有断链，本票未新增） |

### 合并 integration 的 ticket 04 桌面证据后（`ebb6257`，integration tip `90274e1`）

integration 侧并入 ticket 04 的桌面证据（spike 与文档，无共享源码）后本票再次合并。冲突只有两处追加小节：
`docs/migration-status.md` 与 `docs/verification.md`；按「两边都保留、10 在前、04 在后」合并，无 marker 残留、
无内容丢失，无其他冲突、无本票范围外改动。ticket 04 仍为 partial（desktop evidenced; Android blocked）。
全部检查在合并后的 HEAD 上重跑，日志在 `.dev/verify/ticket-10-integration-04/`：

| 命令 | exit | 日志 |
| --- | --- | --- |
| `node --test packages/gateway/test/ingress-control.test.ts`（16 tests, 16 pass） | 0 | `.dev/verify/ticket-10-integration-04/ingress-control.log` |
| `node --test packages/session/test/control.test.ts`（5 tests, 5 pass） | 0 | `.dev/verify/ticket-10-integration-04/session-control.log` |
| `node --test packages/gateway/test/{ingress,ingress-conversation,ingress-resources,ingress-catalogue}.test.ts`（32 tests, 32 pass；02/03/06/07 回归） | 0 | `.dev/verify/ticket-10-integration-04/ingress-regressions.log` |
| `node --test apps/server/test/{conversation-stop-continue,durable-submissions,pending-item-routes,session-fork,web-delegate,conversation-fork-source}.test.ts`（57 tests, 57 pass） | 0 | `.dev/verify/ticket-10-integration-04/server-regressions.log` |
| `pnpm --filter @hepi/gateway --filter @hepi/session --filter @hepi/server -r typecheck` | 0 | `.dev/verify/ticket-10-integration-04/typecheck.log` |
| `pnpm --filter @hepi/gateway test`（325 tests, 325 pass） | 0 | `.dev/verify/ticket-10-integration-04/gateway-suite.log` |
| `pnpm --filter @hepi/session test`（39 tests, 39 pass） | 0 | `.dev/verify/ticket-10-integration-04/session-suite.log` |
| `pnpm check:docs` | 1 | `.dev/verify/ticket-10-integration-04/check-docs.log`（342 文件中仍是同样 12 个既有断链，本票未新增） |

### 交给协调者的记录项（不在本票范围内处理）

- **同一文档锚点反复冲突**：`docs/migration-status.md` 与 `docs/verification.md` 让每个能力票据在同一位置追加小节，
  因此多数合并都会在这两处冲突。本次按票号顺序手工合并；后续票据按票号插入而非追加在末尾可减少同一冲突。
- **`packages/session` 的导出不齐**：本票为 `control.ts` 增加了 `"./control"` 导出，ticket 07 的 `resources.ts` 仍只能按相对路径
  引用（`packages/gateway/test/ingress-resources.test.ts` 即如此）。该导出属 07 的 owner，本票不改；若 05 需要以包名引用，
  `packages/session/package.json` 应补 `"./resources"`。

### 改动范围

- `packages/session/src/control.ts`（新增）：命名 domain 操作的 client seam；`packages/session/package.json` 增加
  `"./control"` 导出，使共享 UI 以包名而非相对路径引用它。
- `packages/session/test/control.test.ts`（新增）：seam 自己的判定——4xx 为拒绝（`code` 或 receipt 的 `reason`）、
  无答案（抛错/5xx/不可读 body）为携带 requestId 的 unknown 且不重发、queue-only 走 `/busy` 而即时发送走 `/messages`、
  delegation 的两种答案身份、control 的按 requestId 读与 fork 的 attempt 身份。
- `packages/gateway/test/ingress-control.test.ts`（新增）：上述公开 seam 测试。
- `apps/server/test/faux-fixture.ts`：新增 `createAnswerGate`/`gatedEchoModels` 测试夹具，使“run 在飞行中”成为测试
  制造的状态而不是竞态；生产代码未改。
- `packages/session/src/index.ts` 的 `DurableSession.submit` 在开发过程中曾加上 `SubmissionOutcomeUnknown`/`whenBusy`，
  最终**回退**：它是浏览器 adapter 路径而不是本票的 client seam，本票的 unknown-outcome 语义已在 `control.ts` 内完整交付，
  且票据 03 的 ingress 切片已独立覆盖提交丢失响应的查询收敛。保留会与 05/17 的 owner 冲突并形成第二套词汇。
- Backend、ingress 与 protocol 未改动：本票所需的路由与 durable 语义已存在，重复实现会构成第二套状态源。

### 未由本票交付

React 消费者（工作台按钮/队列面板/委派面板）属票据 05；把旧 `/api/agent/:id`、`/api/sessions/:id` 的消费者全部迁移并
删除属票据 17。本票交付的是它们要调用的 client seam，未修改旧 adapter 路径。

### Recorded findings

- **fork 的 requestId 在 Backend 是 session 级 family，不是 source 级**：两个不同 source 用同一 requestId 时，第二个 fork
  返回第一个的副本（实测 fork B 返回 parent=8 而 B 的历史未被复制）。触发条件是同一账号内两次 fork 复用同一 attempt
  identity，正常使用（每次 attempt 各生成一次 id，见 `forkRequestId`）不会发生；客户端以 `conversationId:entryId` 为
  attempt key 生成 id，因此不受影响。处置：record，不改 Backend。
- **dispatch 的答案字段名与 create 不同**（`conversationId` vs `childConversationId`）。这是 Backend 既有合同的真实差异，
  本票在 client seam 一次读平（`readDelegateAnswer`），未改 Backend 字段。
