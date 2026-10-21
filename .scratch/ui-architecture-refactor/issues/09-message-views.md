# 訊息 block 呈現模組

Type: implementation
Status: in-progress
Blocked by: none — preserve current MessageView public props; transcript integration verified in ticket 04 and system acceptance
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R7 訊息部分
Acceptance: [行為矩陣](../acceptance.md) — C9、C6 的展開與位置

## 目標與責任路徑

`MessageView.tsx`、MarkdownBody／block/read-resource 既有模組及其直接 consumers/tests。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "MessageView.tsx" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

本票可與 01／03 並行：沿用現有 MessageView props，只改訊息呈現 owner 與直接測試；ChatWindow、useAgentSession、AppShell 由其他票擁有。04 完成時驗證 transcript 接線，12 再驗 streaming／展開／位置的整體行為。本票不提前設計 runtime 介面。

1. 按實際 text/thinking/tool/deferred/diff 呈現責任分內部模組，不更改 wire 或 lifecycle 投影。
2. 保留 entry/message identity、memo、工具展開與資源延遲讀取／失敗的呈現。
3. 遷移既有 import 及 tests，刪只為原單檔內部耦合存在的 helpers；不引入 dynamic registry。
4. 把本票限於有局部變更收益的分支；沒有收益的拆分記具體理由，不為行數切碎。

## 驗收條件

- [ ] 至少主要異質 block 的專屬呈現邏輯可在其擁有者局部修改，不需了解其他格式。
- [ ] 串流更新不 reset 展開狀態／焦點，deferred block 不提前讀全內容。
- [ ] 無新 conversation 訂閱，訊息 view 不取得 runtime setters。
- [ ] 既有測試遷移而非同輸出多測一層；未增加 source shape assertion。

## 驗證與證據

MessageView/Markdown 既有測試，focused browser references、tool/deferred 展開及 streaming 呈現；重用未變 source 的有效結果。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：已移轉的同檔葉節點實作、無語義轉換的分派 wrapper、被替代內部形狀測試。

更新 owning guides：開發指南的訊息呈現定位；若外部行為不變不另寫 capability 承諾。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

待實作填寫：變更修訂、changed paths、scenario evidence、已刪路徑、checks/logs、已解決 material findings 及剩餘限制。完成以上條件後才改 Status 為 resolved。
