# MCP 工作流

Type: implementation
Status: planned
Blocked by: none
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R6 MCP 部分
Acceptance: [行為矩陣](../acceptance.md) — R4、R5

## 目標與責任路徑

`McpConfig.tsx`、`mcp-config-helpers.ts`、McpSignIn/McpAddServer 與目前 MCP client／工作流 helpers；不改 Gateway protocol。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "McpConfig.tsx" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 以既有 MCP 動作建立領域 readout／操作介面，封裝 overview、mutation controllers、操作 pending/result/error 與 readback。
2. 收斂 add/import/test/trust/codemode/sign-in 的取消和更新策略；view 保留表單欄位與選擇。不可把不同操作硬套成樂觀 CRUD。
3. active OAuth 在 hidden tab 按既有流程繼續，完成／逾時更新結果；connection dispose 清理。保留 credential/trust／脫敏擁有者。
4. 切換所有 McpConfig 使用者與 tests，移除 view 端知道 controller 次序／retry 的接線。

## 驗收條件

- [ ] 畫面呼叫 domain 操作，不手動串 mutation → reload → reconcile selection。
- [ ] 各操作都有可見 pending/success/failure，失敗 readback 不被誤當保存成功。
- [ ] hidden tab、active flow、scope change／dispose 的矩陣有證據。
- [ ] 正常 trust/sign-in 流程保持；無通用工作流 framework 或新 transport wrapper。

## 驗證與證據

MCP helpers/interface 行為測試、既有 test:mcp-acceptance／test:mcp-tool-states；合法 sign-in fixture。真實 upstream OAuth 未測要明列。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：McpConfig view 中被承接的 overview/mutation/polling 協調、重複取消／更新片段及內部形狀測試。

更新 owning guides：MCP on the Web host、開發指南；能力限制如有變更記 migration-status。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

待實作填寫：變更修訂、changed paths、scenario evidence、已刪路徑、checks/logs、已解決 material findings 及剩餘限制。完成以上條件後才改 Status 為 resolved。
