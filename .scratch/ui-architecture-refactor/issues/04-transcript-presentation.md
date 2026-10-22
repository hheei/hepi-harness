# Transcript 與 notice 呈現

Type: implementation
Status: resolved
Blocked by: [對話 I/O 與 view attachment](03-conversation-lifetime.md)
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R4 transcript、R3 顯示責任
Acceptance: [行為矩陣](../acceptance.md) — C2、C6、C7、N10

## 目標與責任路徑

`ChatWindow.tsx`、`useHistoryNavigation.ts`、`useAgentSession.ts` 殘餘 DOM/notice 計時、history/scroll 相關 local hooks。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "useHistoryNavigation" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. transcript presentation 集中 scroll intent、follow-tail、entry anchor、virtualizer 和還原；history 資料操作透過 readout／對話介面。
2. 將 notice 排程、hover/focus 暫停及退出動畫移到本地呈現擁有者，沿用 fold 產生的 notice facts。
3. 拆清 ChatWindow 的組裝與呈現互動，移除 runtime 對 DOM refs／layout effects 的需要。
4. 遷移現有 scrolling/history/notice 案例，保留 browser driver 的真實 DOM 驗證。

## 驗收條件

- [x] useAgentSession／對話工作階段不持有 DOM scroll refs 或 toast 顯示 timer。
- [x] 新訊息不強拉正在閱讀歷史的使用者；follow-tail、jump 與 return-to-bottom 合矩陣。
- [x] 切 conversation 不套用舊 anchor／scroll；notice pause/resume 使用剩餘時間。
- [x] raw history、jump window 與 prefix 沒有因拆分多出另一個資料擁有者。

## 驗證與證據

chat-scroll、history rail/scope、raw-history sidebar focus、rail keyboard、navigation retry journeys；既有 notice 行為案例。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：runtime DOM/layout effects、重複 scroll intent bookkeeping、只用來橋接 scroll 或 notice 的 runtime props／setters。

更新 owning guides：聊天、工作台、開發指南。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

UI04 commits `5ca5731e`, `aed06dec`, `b80ddec7`: `useTranscriptPresentation`, `NoticeShelf`, `notice-shelf` own scrolling and notice clocks. Removed runtime DOM refs/layout effects/timers and scroll returns. Worker ran 13 browser drivers, 312 assertions, exit 0 at `b80ddec7`; raw logs `.dev/worktrees/ui-transcript/.dev/verify/ui-transcript-04-final/`.

Integrated at `b3ab7871` in `.dev/worktrees/architecture-consolidation`. Combined `pnpm verify:changed --base=ddc82d03` exit 0 (typecheck, tests, web-unit, docs); raw report `.dev/verify/2026-10-21T17-08-21-052-verify-changed/`.

On unchanged integrated revision `b3ab7871`, `pnpm --filter @hepi/web test:transcript-presentation && pnpm --filter @hepi/web test:composer-interaction && pnpm --filter @hepi/web test:definition-refresh` exit 0. Full raw log `/home/chlo/.pi/agent/sessions/--home-chlo-Documents-dev-hepi-harness--/tasks/01a15c17-51ee-75d2-80b8-9ae57d3c15af/bash-f4a6b0-15.log`. Cross-ticket ReloadOutcome registration variance resolved by integrating UI04 and UI08 together. Real Backend long-history/native acceptance remains ticket12.
