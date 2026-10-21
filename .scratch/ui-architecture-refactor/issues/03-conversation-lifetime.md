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

- [ ] 同 conversation reload 不重建整棵 ChatWindow；Shell 不知道 mount-only 初始化規則。
- [ ] 離開前景仍可完成背景興趣追蹤；每 answer group 至多一次通知，失敗／abort 不誤作成功。
- [ ] 新 connection 不接收舊 read，dispose／React setup-cleanup 正確釋放 owned resources。
- [ ] 未知提交只 lookup；promotion、queue、steer、follow-up 及失敗狀態保持。
- [ ] view 對外介面不含可變 transport callback ref；不是全域 scheduler 或第二執行器。

## 驗證與證據

沿用 useAgentSession.lifecycle、completion-delivery、handover continuity 的行為案例；公開 transport／ConversationApi fake 配合法事件；browser 前背景切換與提交恢復。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：sessionKey 的 domain reload／初始化計數器、mount-only 所需上層協定、公開 mutable transport callback refs、已取代 subscription／read 協調路徑。

更新 owning guides：架構、聊天、開發指南；保留 ADR 0007 原有執行／通知語義。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

待實作填寫：變更修訂、changed paths、scenario evidence、已刪路徑、checks/logs、已解決 material findings 及剩餘限制。完成以上條件後才改 Status 為 resolved。
