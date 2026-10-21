# Accepted conversation readout

Type: implementation
Status: planned
Blocked by: none
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R2、R3 的既有 lifecycle 約束
Acceptance: [行為矩陣](../acceptance.md) — C1、C2，N8 的 accepted identity 部分

## 目標與責任路徑

`useAgentSession.ts` 的 receive/data/step/history 更新；`lifecycle-projection.ts`、既有 history-prefix 規則、`session-view-cache.ts` 與直接消費者。純共享規則僅在必要時改 `packages/session` 現有擁有者。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "lifecycle-projection.ts" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 盤點現有 snapshot/state/page/stream writers，區分 metadata、older prefix、accepted window 與 stream-local delta base；沿用 accepted receiver／fold。
2. 建立同一接受更新所發布的 readout；prefix 隨 accepted window/head 轉換同步決定，不靠 React effect 比對上一個 view。
3. 讓目前 hook／畫面消費同一 readout，保留 metadata 及 stats 合併語義。舊讀取不得回填過期 cache。
4. 遷移／合併既有純規則和 hook 測試至接受入口，刪被取代的重複 transcript 更新；保持目前 I/O 直到生命週期票接手。

## 驗收條件

- [ ] 同一 accepted fact 不再先發布 window、下一輪 effect 才修 prefix。
- [ ] 完整 session stats、snapshot/history token、分頁 cursor 與 stream continuity 各保有明確位置。
- [ ] 合法 HTTP/SSE 先後、stale acquisition、window 滾動／jump、head 變更的可見輸出符合矩陣。
- [ ] 新介面有實際生產讀者；未另建 second lifecycle reducer 或 id→payload 副本。

## 驗證與證據

既有 lifecycle-projection、handover continuity、history prefix／navigation、session-view-cache 案例；以公開 transport 驗證 accepted readout。選 focused history browser journey。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：重複 accepted transcript representation、只為追趕 accepted window 而存在的 prefix effect／previous-window 同步、被替代的測試鏡像。

更新 owning guides：架構、聊天、開發指南的 readout／history 擁有者說明。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

待實作填寫：變更修訂、changed paths、scenario evidence、已刪路徑、checks/logs、已解決 material findings 及剩餘限制。完成以上條件後才改 Status 為 resolved。
