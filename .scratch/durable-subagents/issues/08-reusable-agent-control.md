# 08: 复用子会话并统一派活与停止工具

**What to build:** 主 agent 或另一已授权会话向正常完成的同一 child 继续派活，结果返回本次发起方；模型可以停止工作，但无法覆盖用户停止。最终模型工具集完整为五个 agent_*。

**Blocked by:** [07 — 可靠自动回传最终结果并唤醒接收者](07-automatic-result-delivery.md)

**Status:** accepted — merged `cbb54aa`. Spec and standards reviews: no material finding. Focused tests 56/56; verify:changed server 415/415 exit 0 (log lacks SHA; parent confirmed clean tip `25f2733` and the caller change).

**Labels:** ready-for-agent

**Spec:** [D02](../spec.md#d02)、[D03](../spec.md#d03)、[D04](../spec.md#d04)、[D05](../spec.md#d05)、[D07](../spec.md#d07)、[D08](../spec.md#d08)；[验收 A02、A03、A05、A06、A09](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] agent_send沿用Conversation ID/历史，正常完成后可直接再次派活；每次显式派活保存独立dispatch/recipient/receipt，不重建child或复活旧terminal anchor。
- [x] 另一已授权会话B可向A的childC派活并接收本次结果；不改C的createdBy、展示parent、nativeowner或ExecutionHost。
- [x] agent_stop委托同一核心原子控制；用户held下agent_send(resume:true)明确user_stopped、无新增dispatch，另一次agent_stop不降级用户来源。
- [x] 仅agent停止且无用户暂停时，模型的明确恢复意图在旧普通取消范围idle后可继续；用户停止必须由用户明确恢复。
- [x] 多steer/合并输入共享answer时，各dispatch保留自己的receipt及同一answer引用；reset/unanswered如实回报，不找临近消息猜答案。
- [x] 工具注册最终集合严格为agent_spawn、agent_send、agent_stop、agent_get、agent_read，不注册conversation_*；核心HTTP/Web仍共用五主入口。
- [x] agent_get分页/状态与agent_read的行/字节预算、member校验及续读复用核心；模型caller伪造、自停和越权策略/source覆盖被拒绝。
- [x] 关闭委派工具仍保留兼容task definitions、已有历史和恢复；真实缺失/版本不兼容明确blocked，不注入假成功任务。

## Verification seam

- 真实工具调用验证完成→再send→再次自动报告，A创建C/B派活C各归其收据；受控模型验证共享answer语义。
- 用户stop→模型resume拒绝→agent_stop不能降级→可信用户continue→send成功；检查全部工具schema与注册集合。

## Scope and handoff

不以增加等待/轮询工具替代自动回报；不扩大conversation_*模型工具范围，不新建代理状态库。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。

07验收后开始本票时，先读[只读准备](../reusable-control-preparation.md)，核对实际dispatch/report注册与admission接缝，再扩展既有控制owner；准备不是执行证据，不解除07阻塞。

## Implementation record (ticket 08, branch `impl/durable-subagents-07`)

Base: merged integration tip `b94e132` (ticket 07 accepted `565c634`; 10/11 merged). Branch tip at delivery:
`8396edd` plus this record. Owned paths only: `apps/server/src/subagents/*`, `apps/server/src/conversation-operations.ts`,
`apps/server/test/subagents*`, `docs/architecture.md`, `docs/chat.md`. `server.ts`, `packages/protocol`, `apps/web` and
`patches/` are untouched — the native `pi-durable@1.3.0` patch is unchanged, so no public anchor signature moved.

### TDD tips

| SHA | Tip |
| --- | --- |
| `d20ff2d` | **red** — `agent_send` reuses the same child and reports to its own sender. Fails on the tool-set assertion: `[agent_get, agent_read, agent_spawn]` vs the required five. |
| `312b143` | **green** — `agent_send`/`agent_stop` implemented over the shared control owner. |
| `4e6cdc4` | coverage: cross-conversation dispatch, trusted control, the send crash window, disabled-tool recovery. |

### What was built

- **`extension.ts`** — the model surface is exactly `agent_spawn`, `agent_send`, `agent_stop`, `agent_get`,
  `agent_read`. `agent_send` creates no conversation: it admits a task into an existing one under the caller's own
  stable request id (`<delegating>:<callId>`), then writes the dispatch record **and** its reporter task in one commit,
  so an admitted dispatch always has something that will report it. A self-dispatch is refused before any read or write.
  `agent_stop` holds through the same atomic control, under the `agent` source; a self-stop is refused.
- **`conversation-operations.ts`** — the one behaviour change: a held dispatch now passes the request's **trusted**
  caller to the native `continue` instead of forcing `user`. The native rule is what decides — a user's send clears a
  user stop, an agent's send is refused `source_locked` and creates nothing, and an agent's send clears a stop an agent
  recorded. No new control state, no second queue.
- **`host.ts` / `composition.ts`** — `send` and `stop` ports mapped to the same operations the HTTP routes use;
  `source_locked` becomes the model-readable `user_stopped`, a removed target becomes `recipient_deleted`, an unknown one
  `not_found`, and every other error propagates.

### Evidence

```
cd apps/server && node --test test/subagents*.test.ts test/conversation-stop-continue.test.ts test/native-input-control*.test.ts
# 56 tests, 56 pass, 0 fail
```

`pnpm verify:changed --base=8657170` → `changed-typecheck` PASS, `changed-test` PASS (**415/415**, exit 0),
`check-docs` FAIL with the same **12 pre-existing** broken links in unrelated `.scratch/` files (unchanged from the 07
delivery). Report: `.dev/verify/2026-10-16T21-48-19-702-verify-changed/verify.json`.

New coverage, all driven through real model tool calls over a real backend, SQLite and controlled model:

- a second explicit send reuses the same child (same id, history, creator, display parent, owner, config) with two
  distinct dispatch receipts, and each reports to its own sender;
- a **different** conversation dispatches the same child and receives that report itself;
- a user stop refuses a model dispatch with nothing created (no submission, no dispatch record), a second agent stop
  does not downgrade the `user` source, and the user's own resume lets the model dispatch again;
- an agent stop holds under the `agent` source and the model explicitly resumes it; self-stop and a caller argument are
  refused;
- **SIGKILL between a second dispatch's admission and its dispatch record** — the reopened store proves the task text is
  admitted once, the replay is answered with the same submission id, and the report is delivered exactly once;
- disabling the delegation tools leaves an admitted child, its history and its automatic report intact.

### Acceptance

| Criterion | Where |
| --- | --- |
| A05 reuse, per-dispatch receipts | `a second explicit send reuses the same child…` |
| A02/A03 cross-conversation, unchanged child | `another conversation can give a child a task…` |
| A09 user stop not overridable | `a user stop refuses a model dispatch…` |
| A03 self-stop / caller spoof refused | `an agent stop holds and is resumable…` |
| A19 send crash window | `a real SIGKILL between a second dispatch's admission and its record…` |
| A01 disabled tools keep work + recovery | `disabling the delegation tools…` |

Remaining in scope for a later ticket: per-item queued-item edit/cancel in the Web surface (ticket 09) and the
`reset`/`unanswered` shared-answer receipts at the model seam; both are covered natively today by the reporter's own
records rather than by a second status store.
