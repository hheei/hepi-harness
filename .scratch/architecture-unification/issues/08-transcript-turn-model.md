# 08: 聊天先形成完整 turn 描述再渲染

**What to build:** 用户看到相同 turn、过程和答案分组，渲染先选择描述再创建 JSX，为窗口化提供一个明确 Interface。

**Blocked by:** None (can start immediately)

**Status:** done (2026-10-14, worker chat-window)

**Evidence:** implementation in `apps/web/lib/chat-turn-model.ts` (new) + `apps/web/components/ChatWindow.tsx`, at HEAD
`1758c1fb4479e9d4637a957857246c5998619d73` with a dirty tree (fingerprint: `sha1sum apps/web/lib/chat-turn-model.ts
apps/web/components/ChatWindow.tsx` = `53660e07…` / `5ddade36…`).

| check | command | exit | log |
| --- | --- | --- | --- |
| turn descriptions + renderer seam | `node --test --test-reporter=tap lib/chat-turn-model.test.mjs components/ChatWindow.process-details.test.mjs components/ChatMinimap.test.mjs components/ChatWindow.notices.test.mjs components/ChatWindow.quoted-branch.test.mjs components/ChatWindow.scroll-to-latest.test.mjs components/ChatWindow.extension-request.test.mjs lib/chat-lazy-load.test.mjs lib/message-display.test.mjs` (cwd `apps/web`) | 0 | `.dev/verify/2026-10-14-ticket08/unit.log` (58 pass, 0 fail) |
| typecheck | `npx tsc --noEmit -p tsconfig.json` (cwd `apps/web`) | 0 | `.dev/verify/2026-10-14-ticket08/typecheck.log` |
| production-browser visible-turn/tool/search scene | `node e2e/ux-visible-turns.mjs` (cwd `apps/web`) | 0 | `.dev/verify/2026-10-14-ticket08/ux-visible-turns.log` |
| repository selector | `pnpm verify:changed` | 1 — pre-existing only: `packages/gateway/src/startup.ts`/`src/main.ts` typecheck errors from another ticket's in-flight edits, plus the recorded Web failure baseline and the two `useAgentSession.test.mjs` names another ticket's in-flight `useAgentSession.ts` edits own (`unavailableObservation`); the one name this ticket moved (`useAgentSession.test.mjs`'s pagination assertion) was updated in the same change | `.dev/verify/2026-10-14T16-25-05-060-verify-changed/` |

Owning guide updated: `docs/chat.md` → "The transcript is described before it is drawn".

**Spec:** [统一设计](../spec.md)

## Acceptance criteria

- [ ] 按现有语义生成稳定 key + 消息范围的完整 turn 描述，保留 leading/non-user 与 trailing history。
- [ ] toolCall/toolResult pairing、ProcessDetailsGroup、final answer、written files、timestamp、pending/live surfaces 行为不变。
- [ ] 选择 render descriptions 后才创建 JSX；删除全量 JSX 后 slice 和重复 grouping；此切片尚不宣称 DOM 已有界。
- [ ] 稳定 entry identity 映射用于 search/minimap/refs，渲染不反向承担分页或 lifecycle ordering。
- [ ] 现有真实 browser visible-turn/工具配对/answer/search 场景验证展示与动作一致；描述逻辑可在同一 public render Seam 测。
- [ ] 旧 grouping helper/tests 在新 Seam 覆盖后替换，不长期保留两套 renderer。

## Verification

生产聊天渲染和已有 visible-turn/tool-result/search browser 夹具；独立 demo 可与旧渲染行为对照。 每次结果保存命令、源版本/dirty指纹、实际退出码和原始日志；本 ticket 更新自己的当前指南。

## Context

读取 [已定决策](../decisions.md)、[导航与 owning guides](../navigation.md) 和 [review notes](../review-notes.md)。按 spec 删除被替代知识与路径；可跨 Module 整理，最终 Interface 应统一且可维护。具体源位置在导航表，本 ticket 的行为目标不绑定过时文件布局。
