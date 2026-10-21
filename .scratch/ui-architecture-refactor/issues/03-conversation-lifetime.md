# 對話 I/O 與 view attachment

Type: implementation
Status: in-progress
Blocked by: [Accepted conversation readout](02-conversation-readout.md)
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R3、R1 的 promotion、R2
Acceptance: [行為矩陣](../acceptance.md) — C1、C3–C5、N8、N10

## 目標與責任路徑

`useAgentSession.ts`、`ChatWindow.tsx`、`AppShell.tsx` 的 sessionKey/reload；`conversation-api.ts` 使用者、`completion-delivery.ts` 與共享 agent connection 接線。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "completion-delivery.ts" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

01 的 lifecycle draft retention、source-identity promotion 與 attachment 契約已經獨立複審確認，可從整合 revision `6d4a0342` 開始本票。01 尚餘 workspace restore／park 與 cross-project raw panel 修正；本票保留 selection API，不改 selection owner 或 project cleanup/raw-panel effects。最終整合／驗收仍等待 01 完成；AppShell 的 lifetime 與 presentation sections 由 coordinator 在 worktrees 間合併。

1. 將對話 acquisition、read/reload、submit/recover、訂閱及 dispose 集中到 UI 對話工作階段介面，注入既有 ConversationApi／connection。純 fold 繼續只決策。
2. 定義 connection+conversation 與 fresh composer 的 identity／promotion；前景 view attach/detach 不決定 durable 執行生死。
3. 遷移 Shell／ChatWindow／設定 reload 的現有呼叫者至明確操作，刪除以 sessionKey 初始化／reload 的協定。
4. 接回既有 CompletionDelivery、interest map、shared source 與 projection handover；維持 selected stream/headroom/terminal 的預算。
5. 保留 submit unknown 的 lookup-only 恢復。測試轉至公開命令／訂閱，不讓 view 或測試抓 mutable transport callback ref。

## 驗收條件

- [x] 同 conversation reload 不重建整棵 ChatWindow；Shell 不知道 mount-only 初始化規則。
- [x] 離開前景仍可完成背景興趣追蹤；每 answer group 至多一次通知，失敗／abort 不誤作成功。
- [x] 新 connection 不接收舊 read，dispose／React setup-cleanup 正確釋放 owned resources。
- [x] 未知提交只 lookup；promotion、queue、steer、follow-up 及失敗狀態保持。
- [x] view 對外介面不含可變 transport callback ref；不是全域 scheduler 或第二執行器。

## 驗證與證據

沿用 useAgentSession.lifecycle、completion-delivery、handover continuity 的行為案例；公開 transport／ConversationApi fake 配合法事件；browser 前背景切換與提交恢復。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：sessionKey 的 domain reload／初始化計數器、mount-only 所需上層協定、公開 mutable transport callback refs、已取代 subscription／read 協調路徑。

更新 owning guides：架構、聊天、開發指南；保留 ADR 0007 原有執行／通知語義。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

agent-248 對整合版 03 提出四項 material findings（connection 更換後 registry 存活、stale read 未按 connection 設柵欄、
Settings 重複 reload、reload 失敗仍報成功）；已在本票 owner 邊界內全部修正，見交付記錄的 Review disposition。
新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

Revision：本票程式改動 rebase 到整合 tip `e3c278c0`（`impl/architecture-consolidation`，含三筆已複審的
non-UI Wave 1 merge）。Status 維持 in-progress：最終整合／驗收仍由 coordinator 進行。

### 介面

`packages/ui/src/lib/conversation-session.ts` — `ConversationSession`，一 connection＋一 conversation identity 的
UI 對話 I/O：

| 操作 | 責任 |
| --- | --- |
| `join(conversationId, listener)` | 經 shell 每對話一個 source join；同對話 idempotent，換對話釋放前一個；回傳 `{ continuity, ready }` |
| `release()` / `reconnect(id)` / `isJoined(id)` | 交還 reader；只重連自己所在對話 |
| `read(id, {force})` | single-flight；forced 讀不共用失敗中的 flight |
| `send(id, attempt)` | 唯一准入路徑：立即 send／queueOnly steer／followUp 同一操作；refusal 拋出，未知結果不重送 |
| `lookup(id, requestId)` | 只查 durable record |
| `reload(id)` | Backend 自身 reload |
| `dispose()` | 釋放 reader、忘記共用 flight（setup/cleanup replay 重新 join） |

`useAgentSession` 以 `useMemo` 依 `api`＋`subscribeAgentEvents` 組裝一次；fold 仍是唯一決策者，hook 只呈現並執行
fold 請求。

### Changed paths

- `packages/ui/src/lib/conversation-session.ts`（新）、`conversation-session.test.ts`（新）
- `packages/ui/src/hooks/useAgentSession.ts`：join/read/send/lookup/reload 遷入 session；移除 `loadFlightsRef`、
  `eventSubscriptionRef`；return 不再含 `handleAgentEventRef`、`dispatch`、`setForkingEntryId`；新增
  `onConversationReloadChange`；移除未使用 `sessionRunning`。
- `packages/ui/src/hooks/useAgentSession.lifecycle.test.ts`：resync 改走公開 stream source；新增 explicit reload 案例。
- `packages/ui/src/components/ChatWindow.tsx`：移除 `sessionRunning`、`handleAgentEventRef` 相關註解；接
  `onConversationReloadChange`。
- `packages/ui/src/components/AppShell.tsx`：`key={chatIdentity}`（conversation id 或 composer draft key）取代
  `selectionState.attachment`；Settings reload 改呼叫 chat 註冊的 `reloadConversation`，不再 `reloadAttachment()`。
- `apps/web/e2e/chat/ux-conversation-lifetime.{ts,fixture.tsx}`（新，ChatWindow 層）、
  `ux-conversation-lifetime-shell.{ts,fixture.tsx}`（新，production AppShell 層）、`apps/web/package.json`
  （`test:conversation-lifetime`、`test:conversation-lifetime-shell`）。
- `packages/ui/src/components/SettingsPanel.tsx`：General 不再自行 `api.reload`，只宣告變更並呼叫註冊的 reload。
- 文件：`docs/architecture.md`、`docs/chat.md`、`docs/developer-guide.md`。

### 已刪路徑

`sessionKey`／`selectionState.attachment` 的 mount 協定（`reloadAttachment` 已無呼叫者）、hook 的私有
`eventSubscriptionRef` 與 `loadFlightsRef`、view-facing 可變 transport callback ref `handleAgentEventRef`、
未使用 `sessionRunning` prop。`WorkbenchSelection.reloadAttachment` 仍在 selection owner 中（本票不擁有該檔），
已無 caller；由 coordinator 在 01/11 收斂時刪除。

### Evidence

| Scenario | Seam | Result |
| --- | --- | --- |
| C5 reload 不重建 | `useAgentSession.lifecycle.test.ts`「an explicit reload is one operation…」；browser `test:conversation-lifetime` 第 1 段（DOM marker 存活） | pass |
| C3/N8 未知提交只 lookup | lifecycle「real send dispatch recovers by request identity…」；browser 第 2 段（1 POST、1 lookup、0 tone） | pass |
| C4 背景興趣與單次通知 | `completion-delivery.test.ts`、`handover-continuity.test.ts`；browser 第 3–5 段（離屏 answer 一次、abort 不響、返回不重播） | pass |
| dispose／setup-cleanup | `conversation-session.test.ts`「disposing releases the reader…」 | pass |
| connection 切换重建 registry | browser `test:conversation-lifetime` 第 6 段（`first:conv-a` → `switched:conv-a`，tree 存活，旧 answer 不重播） | pass |
| 切换后旧读成功／`null`／失败皆不发布 | lifecycle「a read that answers after a connection switch…」(三 outcome) | pass |
| reload 只一个 POST、notice 依读取结果 | lifecycle「a reload reports what the read after it established…」(accepted/missing/refused/failure) | pass |
| reload 路由自身被拒绝 | lifecycle「a reload route that rejects is reported, and no read is asked for what it never changed」（503 → `failed`、0 次 state read、不抛出） | pass |
| reload 期间換 connection | lifecycle「a reload whose read answers after a connection switch states nothing」（`superseded`、无 notice、新 connection window 留存） | pass |
| production shell：reload 只一次 | browser `test:conversation-lifetime-shell` 第 1 段（Settings › General 一次 toggle → 1 POST reload + 1 state read） | pass |
| production shell：同 scope 換 connection 不 remount | browser `test:conversation-lifetime-shell` 第 2 段（DOM marker 存活、無 reload） | pass |
| production shell：registry 真的被替换 | browser 第 2 段：`openStreams` 由 `["first:shell-conv"]` 變為 `["replaced:shell-conv"]`，`first` source 為 `closed`，且經 `emitOn("replaced", …)` 送出的 window 出現在 transcript | pass |
| production shell：換 scope 才是 remount | browser `test:conversation-lifetime-shell` 第 3 段（marker 消失、shell 重建） | pass |
| admission 單一路徑 | `conversation-session.test.ts`「one admission path…」 | pass |
| 舊 read 不跨 connection | lifecycle「disposing the connection retires its shared model read…」、`conversation-session.test.ts` 讀共用案例 | pass |

指令與 exit code 見下方 Checks。raw log 位置以 `pnpm verify:changed` 的 run directory 為準。

### Review disposition (agent-248, 4 material findings)

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | `completionDeliveryRef` initialized once; AppShell survives connection switch → old registry keeps old client watches | Registry now lives in state, keyed by the `connection` object; a switch closes the outgoing registry (releases its watches) and builds the next over the new client. Suppression ref still read at call time. **Scope note:** the workbench keys the tree by `connection.scope`, so a scope change already remounts — a remount is what made the ref look correct. The finding's real window is a connection replaced **without** a scope change, which the production-shell scene 2 drives; scene 6 of the ChatWindow fixture drives the same rule below the shell. |
| 2 | `useAgentSession` read paths lacked a connection fence; same conversation id let a replaced API's success/`null`/error publish | `fromCurrentConnection(readThrough)` compares the identity of the connection-owned object (conversation session **or** connection API). Applied after **every** awaited read — snapshot, `null`, failure — in `loadSession`, the agent-state read, `loadContext` and `loadTools`. The mount/load effect now keys on `conversation`, so a switch re-reads the conversation it is now showing. Test covers all three outcomes after a switch. |
| 3 | SettingsPanel awaited `api.reload` and then the registered callback reloaded again → two POSTs | SettingsPanel only calls `onSessionReloaded()`; `reloadConversation` owns the route, the read and the notice. The slash-command `/reload` path also moved to `conversation.reload` so there is one owner of that route. Test asserts exactly one reload POST. |
| 4 | `reloadConversation` ignored the read status; success notice after a failed read | The notice is decided by the read's outcome, never the resource counts. Superseded by finding 6 below, which replaced the nullable outcome this row described. |

### Review disposition (agent-263, 3 material findings)

| # | Finding | Resolution |
| --- | --- | --- |
| 5 (P1) | `/reload` ignored `loadSession`'s outcome → success notice after a 404 or a read failure | Both reload surfaces are one function now (`reloadResources`), so the command cannot report an outcome Settings would not. The command returns `{ error }` for a `failed` outcome and stays silent for `superseded`, and it only adds the command line's catalogue after a reload that was actually accepted. |
| 6 (P2) | `null` conflated a stale answer with a missing conversation, and the closure's `reloadFailureKind` mislabelled `missing` | `loadSession` returns `ConversationReadOutcome` — `accepted` / `refused` / `missing` / `failed`+`ReadFailure` / `cancelled` / `superseded` — so the caller reads the fact instead of guessing from an absence. The closure over `readFailure` is gone; the notice names the read's own `ReadFailure.kind`, which is why a 422 now says "could not be re-read" and a transport failure "could not be reached". |
| 7 (P1) | `SettingsPanel`'s `onSessionReloaded` was fire-and-forget, so a rejected reload POST was unhandled and unnotified | The prop is `() => Promise<void>` and General `await`s it inside its own `try`, so a rejection is a stated failure rather than an unhandled one. The operation itself answers the route's rejection as a `failed` outcome, so no caller has to catch it and no read follows a change that never happened. |

### Review disposition (agent-264, validation gap)

| # | Finding | Resolution |
| --- | --- | --- |
| 8 | `ux-conversation-lifetime-shell.ts` claimed production registry replacement but asserted only DOM, read and reload counts; disabling the guard in `AppShell` still passed | The scene now asserts the registry itself: the first connection holds the conversation's stream, after the switch only the replacement's source is open, the outgoing source is recorded `closed`, and a frame delivered through **only** the replacement's source (`emitOn`) reaches the transcript. The guard was disabled to confirm the scene fails on the mutant (it times out at the `openStreams` assertion). |

### Review disposition (agent-265, spec probe on 3f0d1632)

| # | Finding | Resolution |
| --- | --- | --- |
| 9 (P2) | A reload whose transcript window the fold refused still read agent state afterwards, and `loadSession` returned `accepted` from that auxiliary answer — revision 9 on screen, reload read revision 1 twice, success notice. The existing 422 "refused" case did not cover it: it answered with an HTTP refusal, not a window the fold rejected. | `loadSession` now ends a refused window before the agent-state query (`if (!accepted) return { status: "refused" }`), so the auxiliary read is neither made nor able to promote a rejected window. Regression: `a reload whose window the fold refused claims nothing, and asks for no state of it` — asserts no notice, exactly one read, and the newer window still on screen. The probe's `reads:3` plus success notice reproduces before the fix and fails after removing the guard. |
| 10 (P2) | A reload POST still pending across a connection switch, rejecting 503 afterwards, put the old host's failure notice on the replacement surface. | The route's rejection is fenced like a read: `!fromCurrentConnection(conversation) \|\| sessionIdRef.current !== sid` → `superseded`, no notice and no read. Regression: `a reload route that rejects after a connection switch states nothing on the surface that replaced it`. |
| 11 (P2) | `/reload` emitted the outcome notice twice — once in `reloadResources`, once through `complete` — for both success and failure. | The command returns its result without `complete`'s notice; the operation is the only reporter. `error` stays on the result because it is the composer's "do not clear the text" signal, not a second report. Regression: `a /reload command states its outcome once, for a success and for a failure` (asserts exactly one notice per outcome). |

All three regressions fail when their fix is reverted (6 lifecycle tests fail on the reverted tree), so they are not
probes that pass on both sides.

### 修正狀態

Clean revision `f7886fe8`, base `e3c278c0`: changed verification passed; report `.dev/verify/2026-10-21T13-49-44-265-verify-changed/verify.json`. Browser reruns passed: `pnpm --dir apps/web test:conversation-lifetime` (14 assertions), `pnpm --dir apps/web test:conversation-lifetime-shell` (8 assertions), both exit 0. Raw browser logs: `.dev/verify/ui-conversation-lifetime-03/`.

agent-263 的三项 reload findings 与 agent-264 的 validation gap 已在本轮修正：`loadSession` 返回带类型的
`ConversationReadOutcome`（`accepted`／`refused`／`missing`／`failed`+`ReadFailure`／`cancelled`／`superseded`），
`reloadResources` 是 `/reload` 与 Settings › General 共用的唯一 owner，Settings 的 `onSessionReloaded` 改为
`() => Promise<void>` 并在自身 `try` 内 `await`，路由拒绝由 owner 报为 `failed`（不发后续读取、不向调用方抛出）。
新增 public-seam 失败回归：路由 503、读取 missing／refused／failure、reload 期间换 connection。production shell
scene 现断言 registry 本身（`openStreams` 从 `first:shell-conv` 变为 `replaced:shell-conv`、旧 source `closed`、
经 `emitOn("replaced", …)` 的 frame 进入 transcript）；关闭 AppShell 的替换 guard 后该 scene 失败，确认断言有效。
agent-265 的两项 spec probe 与 standards 的重复通知发现同样已修正，三者的 public-seam 回归都写在
`useAgentSession.lifecycle.test.ts` 里（拒绝 window 不得声称成功、切换后旧 POST 拒绝不得发声、一次 `/reload` 只一条通知），
并在 revert 对应修复后确认失败。Ticket 保持 in-progress，等待 coordinator 集成与验收。未观察到的 run 仍不补完成音
（ADR 0007 既有契约），本票未改。
