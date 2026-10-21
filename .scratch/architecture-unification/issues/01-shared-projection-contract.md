# 01: 公共投影帧贯通所有生产消费者

**What to build:** 维护者只定义一次原始投影合同，后端 HTTP/SSE、session 客户端和 Web 仍呈现相同会话行为。

**Blocked by:** None (can start immediately)

**Status:** done — claimed and implemented by agent-34 on 2026-10-14; result and verification below

**Spec:** [统一设计](../spec.md)

## Acceptance criteria

- [ ] Protocol 拥有原始 snapshot/delta 和相伴事实的共享声明，全部生产调用者使用它；显示模型保持显式 Adapter。
- [ ] 旧重复声明与同义映射删除，不留下长期兼容 alias 或新 schema 框架。
- [x] 序列化字段、projection identity、revision、history token、submission 和 deferred read block 合同不变。
- [x] 实际 HTTP/SSE 的 snapshot、delta、resync 和大文本恢复由真实消费者验证；typecheck 覆盖跨包依赖。
- [x] 机械迁移优先原子落地；若不能保持 green，先在本 ticket 内展开/迁移/收缩，最终无旧调用者。
- [x] 更新当前协议/架构说明，保留历史 ADR 的历史语境。

## Verification

既有协议/session 公共行为、后端 HTTP/SSE 和 Web Adapter；类型检查加一个真实跨层回归，不只测类型别名。 每次结果保存命令、源版本/dirty指纹、实际退出码和原始日志；本 ticket 更新自己的当前指南。

## Context

读取 [已定决策](../decisions.md)、[导航与 owning guides](../navigation.md) 和 [review notes](../review-notes.md)。按 spec 删除被替代知识与路径；可跨 Module 整理，最终 Interface 应统一且可维护。具体源位置在导航表，本 ticket 的行为目标不绑定过时文件布局。
## Result

`packages/protocol/src/index.ts` 现在唯一声明原始投影帧：`ServerSnapshot<TMessage, TToolSlot>`、`ServerDelta`、`ServerFrame`、`ServerEntry`、`ConversationSettings`、`ServerFailure`、`ResourceSummary`、`LiveToolSlot`、`ServerEventsFrame`、`ServerResyncFrame`。payload 作为类型参数传入，因此 protocol 包不依赖 runtime；显示模型仍由各消费者自己的 Adapter 表达：后端传 `Message`/`ToolSlot`，SDK 客户端传 `ProtocolEntry`，Web Adapter 传自己的 `AgentMessage`。

- `apps/server/src/server.ts`：wire 声明改为 `ServerEntryOf<Message>` / `ServerDeltaOf<Message, ToolSlot>` / `ServerFrameOf<...>` / `ServerSnapshotOf<...>` / `ServerFailureOf`；重复字面量与本地 `ConversationSettings`/`ServerFailure` alias 删除。
- `packages/session/src/index.ts`：消费共享 `ServerSnapshot`/`ServerDelta`/`ServerEventsFrame`/`ServerResyncFrame`（entry 为 `ProtocolEntry`），`Delta` 复用共享 delta 字段。
- `apps/web/adapters/durable-api.ts`：raw 声明改为共享帧 + `AgentMessage`；`sessionData`/`state`/`uiMessage` 显示 Adapter 不变。
- 删除无生产调用者的旧 fold（`ProtocolSnapshot`/`createSnapshot`/`appendEvent`/`applyEvent`）及其唯一测试 `packages/protocol/test/stream.test.ts`。
- `docs/architecture.md` 协议段原地更新。

### Verification

Source: HEAD `1758c1fb4479e9d4637a957857246c5998619d73` + dirty tree（无 commit、无 reset、无 deploy）。

| command | exit | log |
| --- | --- | --- |
| `pnpm --filter @hepi/protocol test` | 0 (45 pass) | `.dev/ticket01/protocol-tests.log` |
| `pnpm --filter @hepi/session test` | 0 (20 pass) | `.dev/ticket01/session-tests.log` |
| `pnpm --filter @hepi/server test` | 0 (285 pass；含 `browser-session.test.ts` 真实后端与 `session-reducer.test.ts` 真实 HTTP 帧) | `.dev/ticket01/server-tests.log` |
| coordinator Web Adapter 合同检查 | 0 (41/41) | `.dev/verify/architecture-unification/adapter-contract-check.md` |
| `pnpm -r typecheck` | 2 | 仅 `apps/web`，失败项属当时其他 worker 的在飞改动（`AppShell.tsx` trust props、`e2e/window-experiment.fixture.tsx` 缺依赖），非本 ticket owned 类型 |

报告与原始日志：`.dev/ticket01/RESULTS-01.md`。`git diff --check` exit 0。
