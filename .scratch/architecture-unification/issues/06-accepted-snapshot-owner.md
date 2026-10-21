# 06: HTTP 与 SSE 使用同一个已接受事实拥有者

**What to build:** 消息和失败、模型、队列、leaf、history head 在乱序输入下作为同一已接受 statement 发布，重挂载和来源特有行为仍正确。

**Blocked by:** 01

**Status:** done — claimed and implemented by agent-34 on 2026-10-14; result and verification below

**Spec:** [统一设计](../spec.md)

## Acceptance criteria

- [x] 共同 normalized statement 从共享 raw frame 合同进入一个 acceptance-owning receiver，先 pure fold 后发布共同事实。
- [x] 拒绝 statement 不能改变任一共同旁证、cache/checkpoint 或来源相关发布；不新增 clock、第二 reducer 或 branded-token 守门拼补。
- [x] 共同 data 与 view 表示在合适 owner 收敛，能派生的 React state/refs 和双份 setter 删除。
- [x] HTTP prefix migration/cache/tool-loadout/override 与 SSE liveTools/liveMessage/phase 的真实区别保留；不用万能 origin dispatch 混淆 independent agent-state read。
- [x] equal revision remount、跨 acquisition、跨 projection identity 和 HTTP/SSE 乱序按现有合同处理。
- [x] prefix 保留、compaction rebaseline、thinking/model override、oversize refusal recovery 均通过公开行为回归。
- [x] hook 对 UI 暴露稳定的已接受历史事实，供后续渲染窗口消费；pure projection 不获得 I/O。

## Verification

pure fold 反例加 hook acquisition 的 HTTP/SSE 公共行为；browser reconnect/prefix 是整合回归，不叠加内部 setter 镜像测试。 每次结果保存命令、源版本/dirty指纹、实际退出码和原始日志；本 ticket 更新自己的当前指南。

## Context

读取 [已定决策](../decisions.md)、[导航与 owning guides](../navigation.md) 和 [review notes](../review-notes.md)。按 spec 删除被替代知识与路径；可跨 Module 整理，最终 Interface 应统一且可维护。具体源位置在导航表，本 ticket 的行为目标不绑定过时文件布局。
## Result

一个 acceptance-owning receiver：`apps/web/lib/lifecycle-acquisition.ts`。

- `AcceptedStatement<TSession> = { source: "http" | "sse"; acquisition; input; facts: AcceptedFacts<TSession> | null }`，其中 `AcceptedFacts = { session（该 transport 发布的整份 payload）; historyHead; leafId; queuedMessages? }`。
- `httpStatement(read, acquisition)` / `sseStatement(read, acquisition)` 从 transport 自己的 read 对象同时构造 fold input 与 facts，任一 transport 都不会在入口丢掉共同旁证。
- `receiveAccepted(step, statement) -> { step, view, accepted }`：只调 `advance()` 一次，`accepted` 就是 `Step.snapshotAccepted`。没有第二个 clock、没有 revision 比较、没有 branded token、没有 origin dispatch。
- `submissionStatement` / `unavailableStatement` 的 `facts` 为 null（不是 window，故无旁证可发布）。
- 旧 observation 导出（`snapshotObservation`/`lifecycleObservation`/`unavailableObservation`）保留，供 `completion-delivery.ts` 与 `durable-lifecycle.test.mjs` 继续使用。

hook（`apps/web/hooks/useAgentSession.ts`）：

- `receive(statement)` 是唯一共同发布者：`historyHeadRef`、`setData(facts.session)`、`setActiveLeafId`、`setRunFailure`、`setQueuedMessages`（仅当该 transport 声明 queue），全部在 `receipt.accepted` 下。
- HTTP 分支只保留自身路径：prefix migration、session-view cache checkpoint、hasEarlierMessages、tool loadout/preset、model+thinking override 结算、wrapperRebuilt reconnect。SSE 分支只保留实时渲染：liveTools、liveMessage、phase、isCompacting、oversize refusal 清理。两份重复的 `setData`/`setActiveLeafId`/`setRunFailure`/`historyHeadRef`/`setQueuedMessages` 已删除。
- 派生镜像删除：`liveModel`、`liveThinkingLevel` React state 与 `syncLiveModel`；`currentModel`/`currentThinkingLevel` 读已接受 transcript（`data.context.model`/`data.context.thinkingLevel`）。
- `applyAgentState(state, sid, requestId, acceptedRevision)` 是 agent-state answer 的唯一 writer：model、thinkingLevel、contextUsage 同源写入，`applyContextUsage` 合并入它。它不受 snapshot acceptance 门控（独立读），但受两把既有 owner 值 fencing：read 开始时取的 request id（同一类 read 之间的序）与当时已接受 lifecycle revision（描述已被更新 window 取代的 answer 不再 refine）。已接受 window 仍是会话所选 model/level 的 owner，stale answer 不能把旧 model 推回屏幕。

### Verification

Source: HEAD `1758c1fb4479e9d4637a957857246c5998619d73` + dirty tree（无 commit、无 reset、无 deploy）。

| command | exit | log |
| --- | --- | --- |
| `cd apps/web && npx tsc --noEmit` | 0 | `.dev/ticket01/ticket06-web-typecheck.log` |
| `pnpm --filter @hepi/protocol test` / `--filter @hepi/session test` / `--filter @hepi/server test` | 0 / 0 / 0 | `.dev/ticket06/package-suites.log` |
| focused `node --test`（context-usage、useAgentSession.lifecycle、useAgentSession、model-switching、model-scope-startup、ChatInput.streaming-thinking、lifecycle-acquisition、lifecycle-projection、durable-lifecycle、durable-api、text-read-block、session-view-cache） | 0 (184 pass) | `.dev/ticket06/focused-web-2.log` |
| 全 Web unit（两处 mirror 断言修复前） | 1 (2357 tests, 2339 pass, 18 fail) | `.dev/ticket06/web-unit/web-unit.json` |
| 全 Web unit（修复后） | 1 (2363 tests, 2345 pass, 18 fail) | `.dev/ticket06/web-unit-2/web-unit.json` |

18 个失败是**在该源码状态观察到的**，不是 baseline 集合声明，也不做等量比较；精确名称比较由 coordinator 的整合运行负责。其中三处属本 ticket 并已修复：`ChatInput.streaming-thinking` 与 `model-scope-startup` 断言的 `setLiveThinkingLevel` 镜像、`useAgentSession.test.mjs` 的 `hasMoreItems` 分页断言（ticket 10 窗口化把 `visibleStartIndex` 移出该判断）。其余名称属当时在飞的 sibling 改动（08/09/10 的 ChatWindow/transcript-window、lib/mcp-* 等）。`context-usage.test.mjs` 更新到合并后的 `applyAgentState` seam，并新增 stale-answer 反例。

报告与原始日志：`.dev/ticket01/RESULTS-06.md`。`git diff --check` exit 0。
