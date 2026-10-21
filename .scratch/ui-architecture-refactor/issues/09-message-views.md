# 訊息 block 呈現模組

Type: implementation
Status: resolved
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

- [x] 至少主要異質 block 的專屬呈現邏輯可在其擁有者局部修改，不需了解其他格式。
- [x] 串流更新不 reset 展開狀態／焦點，deferred block 不提前讀全內容。
- [x] 無新 conversation 訂閱，訊息 view 不取得 runtime setters。
- [x] 既有測試遷移而非同輸出多測一層；未增加 source shape assertion。

## 驗證與證據

MessageView/Markdown 既有測試，focused browser references、tool/deferred 展開及 streaming 呈現；重用未變 source 的有效結果。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：已移轉的同檔葉節點實作、無語義轉換的分派 wrapper、被替代內部形狀測試。

更新 owning guides：開發指南的訊息呈現定位；若外部行為不變不另寫 capability 承諾。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

變更修訂：commit `8919714a7f2d3c923b9d7554c000d01a2cf625b4`（worktree base `8182fafc`）。

Changed paths（相對 `packages/ui/src`）：

- `components/MessageView.tsx`：只剩 role 分派與 memo comparator（105 行，原 2178 行），公開 `Props`、
  `MessageView` 身分、比較器語意（含 `haveSameRelevantToolResults`）不變。
- `components/AssistantMessageView.tsx`：區塊序列、串流 token 估計、tps 視窗、thinking/tool 時長、錯誤與截斷提示、
  寫入檔案列、usage／複製／時間 footer。
- `components/UserMessageView.tsx`：提示泡泡、`/skill:` 收合、附件、整段讀取（複製／編輯）與分叉；`replaceUserMessageText`
  隨其 owner 遷入。
- `components/CustomMessageView.tsx`：`CompactionMessageView`、compaction 檔案清單、一般 extension message（含 details 展開）。
- `components/BashExecutionView.tsx`：使用者指令重用 `ToolCallBlock`。
- 區塊葉節點：`components/MessageTextBlocks.tsx`（`SafeMarkdownBody`、`DeferredText`、`TextBlock`）、
  `components/ThinkingBlockView.tsx`、`components/ToolCallBlockView.tsx`、`components/MessageDiffView.tsx`、
  `components/MessageImages.tsx`、`components/MessageUsage.tsx`。
- 純規則：`lib/token-estimate.ts`（token 估計與 suffix 快取，新增 `lib/token-estimate.test.ts`）、
  `lib/message-display.ts`（新增 `formatMessageTime`、`getModelDisplayName`、`getMessageText`）。
- 測試遷移：`components/MessageView.test.ts` 的 `replaceUserMessageText` 改指向 `UserMessageView.tsx`；
  `lib/resource-read.test.ts` 的 reader／`thinkingUrl` 斷言改指向實際擁有者（`ThinkingBlockView`、`MessageTextBlocks`、
  `MessageImages`、`deferred-text`）；`lib/file/file-seam.test.ts` 的 owned 清單加入新葉節點。斷言數量與語意未變。
- 文件：`docs/developer-guide.md` 訊息呈現定位（哪個 owner 管哪一段）。
- `apps/web/e2e/chat/ux-token-footer.ts`：AppShell 已在 `packages/ui`，driver 讀取路徑改指實際檔案（原路徑自 baseline 起即不存在，
  driver 在該步驟失敗）。

已刪路徑：`MessageView.tsx` 內的 `SafeMarkdownBody`、`DeferredText`、`TextBlock`、`ThinkingBlock`、`ToolCallBlock`、
`SplitPatchView`/`SplitFilesView`/`SplitDiffHeader`/`SplitDiffCellView`/`PatchTextView`、`ResultImages`、`PairedResult`、
`PairedDiffResult`、`CompactionMessageView`/`CompactionFileMetadata`/`CompactionFileList`、`CustomMessageView`、
`ResourceImage`、`MessageImage`、`ResponseUsage`、`BashExecutionView`、`formatTime`、`previewText`、`getToolPreview`、
`getMessageText`、`getMessageImages`、`safeJson`、`inlineImageSource`、`imageReadBlock`、token 估計常數與函式。
`getToolCallInputText`、`getTokenEstimateText` 等只被單一 owner 使用的 helper 不再 export，無 shim／alias／雙路徑。

保留契約：entry/message identity 與 memo；`tool-call-expansion`、`thinking-expansion-preference` 的外部展開狀態；
deferred text/thinking/image 只在明確展開或複製時讀取，且一律經 `WorkbenchClient.resources`；無新 conversation 訂閱、
無 runtime setter、無 dynamic registry。

Evidence：

- `pnpm verify:changed --base=8182fafc` 於 revision `8919714a`（clean tree）exit 0：changed-typecheck、changed-test、
  web-unit、check-docs 全 PASS；log `.dev/verify/2026-10-21T11-19-18-855-verify-changed`。（同一 source 在 commit 前以
  dirty tree 跑過，log `.dev/verify/2026-10-21T11-18-18-796-verify-changed`；更早兩次 `.dev/verify/2026-10-21T11-13-12-133-…`、
  `.dev/verify/2026-10-21T11-17-17-088-…` 對應前一輪修正。）
- `pnpm --filter @hepi/ui typecheck` exit 0；`pnpm --filter @hepi/ui test` 400 pass、exit 0。
- 等價性：臨時 driver 對 25 組訊息情境（user/assistant/thinking/tool/apply_patch/codemode/subagent/mcp/image/usage/
  error/truncated/written files/deferred/custom/compaction/bash/fork，各自 collapsed 與 expanded）以
  `renderToStaticMarkup` 比較 baseline `8182fafc` 與新 `MessageView` 的完整 HTML，全部相等；driver 不留在樹中。
- 瀏覽器：`node apps/web/e2e/chat/ux-token-footer.ts` exit 0（footer 顯示／隱藏、reload 後保留、本地化 accessible name、
  窄版無溢位）；`node apps/web/e2e/history/window-experiment.ts` exit 0（production `MessageView` 在 200/2000 訊息、
  展開／串流下的錨點與 unmount 行為）。
- 圖：本 worktree 無 `graphify-out/graph.json`，依倉庫規則改用 source 確認呼叫端（`ChatWindow` 只匯入 `MessageView`；
  `apps/web/e2e` 兩個 fixture 掛載 production `MessageView`）。

剩餘限制：`ux-history-navigation-acceptance.ts` 需要先建置 `apps/web/dist` 與真實 Backend，本票未執行；它讀取的
`data-entry-id`／`data-message-text`／`.markdown-user-message` 標記在本票保留且已由上述等價性 driver 覆蓋。整合層
串流／展開／位置行為仍由票 12 依 C9 驗收。無 material findings。
