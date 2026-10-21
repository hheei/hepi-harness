# 21 — 会话与入口读取失败恢复

Type: implementation
Status: complete (2026-10-19, `fix/client-app-21-recovery` from `main` `d356152`)
Blocked by: [17](./17-retire-next-and-transition-paths.md) — closed by 17's 2026-10-19 closeout
Parent spec: [全栈重构后续 UX](../spec.md)

## Outcome

普通会话打开、入口读取或跨会话导航失败时，有可见结果与可操作恢复，不只 console.error 或整页红字。

## Scope

在现有 AppShell/session hook/admission owner 收口 loading、unavailable、temporary read error、cancelled 的 UI 结果。提供重试读取／返回有效会话；维持草稿与已确认内容，不创建第二 lifecycle store。历史目标状态由 [history 03](../../history-navigation-research/issues/03-navigation-jump-coordinator.md) 拥有，引用创建由 [references spec](../../cross-session-references/spec.md) 拥有，本票只提供共享读失败承载面。

## Acceptance

- [x] 会话读失败、失效会话与临时不可达有可见状态；Retry 重新读取，Back 回到有效上下文；不存在目标不伪装成功。
- [x] 快速切换会话、迟到响应或已取消 locate 不能覆盖新选择；用户草稿和已有有效内容不因临时错误丢失。
- [x] error/status 用可访问语义，重试可键盘操作；失败状态带适当文本，不把敏感诊断原样显示。
- [x] 恢复只重试读取；submission/control/上传等未知 mutation 走原 requestId 或既有 outcome_unknown，不通过 Retry 重发。
- [x] 与后续 history/reference 整合使用同一状态owner，不重做其 bounded target读取；更新 chat/连接错误指南。

## Evidence and verification

[研究 N2–N4](../../ux-closeout-research/01-navigation-and-conversations.md)、[A5](../../ux-closeout-research/04-web-app-and-operational-feedback.md)。聚焦公开读取失败与共享 UI 恢复旅程；记录 command、SHA、exit、log。网络断开只作为普通故障，遵守既有禁止 bypass testing 规则。

## Delivered (2026-10-19)

Source: `fix/client-app-21-recovery`, branched from `main` `d356152` in `.dev/worktrees/client-app-21-recovery`.

### Owning seams

| Concern | Owner | Change |
| --- | --- | --- |
| Failure classification | `packages/ui/src/lib/read-recovery.ts` (new) | `classifyReadFailure` → `unreachable` / `missing` / `refused` / `cancelled`; `readFailureKey`, `readFailureRetryable` |
| Recovery UI | `packages/ui/src/components/ReadFailurePanel.tsx` (new) | `surface` placement takes the transcript's place; `inline` placement is a dismissible banner |
| Conversation read state | `useAgentSession.loadSession` | classifies into `readFailure`; cleared by the accepted read and by an accepted stream window |
| Read-only retry | `useAgentSession.retryRead` / `dismissReadFailure` | forced re-read under a fresh acquisition; no mutation is resent |
| Page read | `useAgentSession.loadContext` | `onReadFailure` distinguishes "no page established yet" from "the context re-baselined" |
| Entry open | `AppShell.handleOpenSession` | classified `openFailure` + `retryOpenSession` instead of a console line |
| Leaving a broken conversation | `AppShell.leaveUnreadableSession` | the same composer fallback the sidebar delete uses; no draft is cleared |
| Navigation locate | `ChatWindow` locate effect | a failed page is a retryable `locateFailure`, never "the entry is not in this branch" |

### Acceptance mapping

- **Visible state, Retry, Back.** Four classified outcomes, each with a sentence this build owns; Retry appears only for
  `unreachable` (a read that never answered) because a `missing` or `refused` read answers the same way again. Back
  opens the composer of the conversation's folder. A target the Backend says is gone is stated as gone, not as success.
- **Late answers and cancellation.** The retry begins under a fresh acquisition, so an answer that lands after the
  reader moved on is fenced by the fold exactly like any other older one; an aborted read classifies as `cancelled` and
  is neither folded nor shown, so a superseded locate cannot paint a failure over the conversation the reader chose.
- **Accessibility and diagnostics.** The panel is `role="status"` with `data-read-failure`; Retry is a real
  `<button>` (focusable, Enter activates) that states `aria-busy` and is disabled while in flight. The raw reason is
  kept in `ReadFailure.detail` for the log and never rendered — a test asserts the sentence is a fixed key per kind.
- **Reads only.** `retryRead` issues exactly one `GET /api/conversations/:id/state` and nothing else; the lifecycle test
  asserts the request list and that the non-GET count is unchanged across the recovery. Unknown mutations keep their
  request id and the existing `outcome_unknown` lookup.
- **One owner, no second target read.** The history/reference target read stays with its own owner: this ticket adds a
  failure channel to the page read it already calls (`onReadFailure`) instead of a second reader, and the locate
  coordinator keeps its single bounded paging loop. `docs/chat.md` gained "Read failures and their recovery".

### Verification

Run from `.dev/worktrees/client-app-21-recovery`; logs under `.dev/verify/2026-10-19T17-36-53-378-verify-changed/`.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm --filter @hepi/ui typecheck` | 0 | `tsc --noEmit` clean |
| `pnpm --filter @hepi/ui test` | 0 | 285 tests / 285 pass / 0 fail (includes 4 new `read-recovery`, 5 new `ReadFailurePanel`, 3 new hook cases) |
| `node scripts/verify.mjs --profile=changed` | 0 (steps below) | `changed-typecheck` PASS, `changed-test` PASS, `web-unit` PASS, `check-docs` FAIL |
| ↳ `changed-test` | 0 | ui 285/285, gateway 44/44, server 21/21, app 18/18 |
| ↳ `web-unit` | 0 | 14 tests / 14 pass |
| ↳ `check-docs` | 1 | 12 broken relative links, all pre-existing: the identical 12 are reported by the same command on the unmodified `d356152` tree (verified by stashing this change and re-running). 0 new; 0 guides missing from the index. Run twice (before and after the docs edits) with the same 12. |

New tests:

- `packages/ui/src/lib/read-recovery.test.mjs` — the four kinds, abort precedence, the diagnostic staying beside the kind,
  a failure with no message.
- `packages/ui/src/components/ReadFailurePanel.test.mjs` — Retry offered only where it can work, real button +
  `aria-busy`, the way back, the inline banner not taking the transcript's place, an authored refusal message.
- `packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs` — a failed read is classified and keeps the accepted
  window while Retry issues one read and no mutation; a `not_found` is `missing`; a failed page reports its failure
  instead of exhausting a navigation.
- `packages/ui/src/components/AppShell.session-delete.test.mjs` — extended, not replaced: the delete's fallback and the
  unreadable conversation's "back" are now one `fallBackToComposer`, and the existing matrix drives that callback so both
  callers keep the ref-synchronisation and navigation guards the case already asserted.

Not run, and why: no authenticated browser journey. The panel is asserted at its render and hook seams (the same
approach `OAuthPastePanel.test.mjs` and `MessageView.test.mjs` use), and a live failure journey needs a Backend that
can be made to fail a specific conversation read on demand — a probe this repository's no-bypass-testing rule puts out of
scope. The classified state, the read-only retry and the locate distinction are the seams that would be exercised, and
each is covered above.
