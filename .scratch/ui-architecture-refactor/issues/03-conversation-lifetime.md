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
| reload 只一个 POST、notice 依读取结果 | lifecycle「a reload reports what the read after it established…」(accepted/missing/failure) | pass |
| production shell：reload 只一次 | browser `test:conversation-lifetime-shell` 第 1 段（Settings › General 一次 toggle → 1 POST reload + 1 state read） | pass |
| production shell：同 scope 換 connection 不 remount 且重建 registry | browser `test:conversation-lifetime-shell` 第 2 段（DOM marker 存活、無 reload） | pass |
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
| 4 | `reloadConversation` ignored the read status; success notice after a failed read | The notice is decided by the read's outcome: `null`/`"error"`/`"cancelled"` produce an error notice (missing vs. not re-readable), never the resource counts. Test covers accepted, missing and transport failure. |

### 剩餘限制

- 01 的 `WorkbenchSelection.reloadAttachment` 與其測試仍存在但已無 caller；刪除屬 selection owner。
- AppShell 的 lifetime／presentation sections 由 coordinator 在 worktrees 間合併；本票只改 ChatWindow key 與
  Settings reload 接線。
- 未觀察到的 run 仍不補完成音（ADR 0007 既有契約），本票未改。
