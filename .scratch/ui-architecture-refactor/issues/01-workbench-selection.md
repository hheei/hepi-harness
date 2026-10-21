# 工作台選擇與草稿

Type: implementation
Status: planned
Blocked by: none
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R1、替換策略
Acceptance: [行為矩陣](../acceptance.md) — N1–N10、R11 的選擇／draft 部分

## 目標與責任路徑

`AppShell.tsx` 選擇／restore／open／delete handlers；`SessionSidebar.tsx`、`NewSessionContextBar.tsx`；`initial-navigation.ts`、`tab-session.ts`、`workspace-memory.ts`、`draft-store.ts` 及直接呼叫者。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "initial-navigation.ts" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 以現有操作建立工作台選擇 readout 與意圖介面，集中 restore/open 的有效性判定及已接受選擇的持久化。先把 N1–N10 對應現有案例，缺少的高風險行為才補測。
2. 讓 Sidebar、Shell、新對話列、快捷鍵及 deep link 都走這個擁有者；Sidebar 保留搜尋／展開等 local state。
3. 把 parked/carry/New/promotion 的草稿規則及顯式 connection scope 接入；保留現有儲存內容與 key 格式，render 不再改可變全域 scope。
4. 同票遷移選擇相關 source-extraction 測試至新介面；刪掉已替代的 handlers／通知抑制協定。後續仍需用到的 sessionKey 只作生命週期接線，留明確承接到對話 I/O 票。

## 驗收條件

- [ ] Sidebar 與 Shell 讀同一 canonical selection，選擇不靠 props → local cwd → effect 回報的循環。
- [ ] 資料型 composer move 不經 Sidebar controlRef 中轉；focus/picker imperative 使用者仍有正確焦點。
- [ ] identity hydration、同 project worktree、跨 project、stale restore/open、draft carry/park/promotion 具矩陣證據。
- [ ] VM 截取 callback 的選擇／刪除測試已替換；scope 的改動不清除既有使用者草稿。

## 驗證與證據

選擇模組 colocated tests、initial navigation／draft 既有案例；focused browser 走 New、worktree、reload、刪除與導航重試。接線改到 App 時檢查其 Configure/host tests。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：重複 canonical selectedCwd 與 domain selection handlers、只為抑制回報而設的 flags、資料選擇的 Sidebar imperative 中轉、source extraction 測試入口。

更新 owning guides：開發指南、工作台、聊天的草稿／restore 說明。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

待實作填寫：變更修訂、changed paths、scenario evidence、已刪路徑、checks/logs、已解決 material findings 及剩餘限制。完成以上條件後才改 Status 為 resolved。
