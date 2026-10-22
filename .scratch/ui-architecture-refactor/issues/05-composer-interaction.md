# Composer 互動與命令介面

Type: implementation
Status: resolved
Blocked by: [對話 I/O 與 view attachment](03-conversation-lifetime.md)
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R4 composer、R1 草稿契約
Acceptance: [行為矩陣](../acceptance.md) — C8、N6–N8、C3 的 composer 入口

## 目標與責任路徑

`ChatInput.tsx`、`ChatWindow.tsx` 的 composer 接線、chat/draft helpers 與對應 tests；保持主選擇模組的 draft 所有權。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "ChatInput.tsx" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 明確區分 editor interaction／草稿值、補全與附件 UI、model/queue readout 及業務命令，依實際責任分出內部模組。
2. 保留原生 selection、undo/redo、IME 與 imperative textarea 操作的必要語義；各輸入來源使用同一 live value／草稿承接。
3. 讓 submit/steer/follow-up/queue 操作透過窄介面，不原樣轉傳整個對話工作階段狀態。
4. 遷移附件、@、slash、keyboard、draft/rekey 案例；需要原生編輯行為的 case 用真實瀏覽器。

## 驗收條件

- [x] IME 不誤送，補全插入／undo 正確，圖片與文字在 move/reload/promotion 保留。
- [x] ChatWindow 不必知道 editor 內部 selection／補全計時與 queue 命令實作。
- [x] 不以巨型 context/any 打包原本 props；edit interaction 不是未使用的 pass-through。
- [x] models/queue 真相仍由其領域提供，未在 composer 複製另一份可寫權威。

## 驗證與證據

ChatInput 及 chat helpers 現有案例；focused browser IME/undo、completion/attachment、草稿移動與提交。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：ChatInput 大 props 的 runtime internals 中轉、同一 live text／draft 的多路寫入、只搬參數的 wrapper。

更新 owning guides：聊天、開發指南。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

UI05 commits `346d2b7b`, `fa6b9c5b`: composer commands/editor/popup/notice/queue modules replace monolithic ChatInput internals; ChatInput shrank from 3175 to about 800 lines. One live draft and command seam preserve native undo, IME, attachments, promotion and parking. Worker reports 451 UI tests plus composer browser journey passing.

Integrated at `b3ab7871` in `.dev/worktrees/architecture-consolidation`. Combined `pnpm verify:changed --base=ddc82d03` exit 0 (typecheck, tests, web-unit, docs); raw report `.dev/verify/2026-10-21T17-08-21-052-verify-changed/`.

On unchanged integrated revision `b3ab7871`, `pnpm --filter @hepi/web test:transcript-presentation && pnpm --filter @hepi/web test:composer-interaction && pnpm --filter @hepi/web test:definition-refresh` exit 0. Full raw log `/home/chlo/.pi/agent/sessions/--home-chlo-Documents-dev-hepi-harness--/tasks/01a15c17-51ee-75d2-80b8-9ae57d3c15af/bash-f4a6b0-15.log`. Cross-ticket ReloadOutcome registration variance resolved by integrating UI04 and UI08 together. Real Backend long-history/native acceptance remains ticket12.
