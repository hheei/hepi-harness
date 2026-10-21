# Shell layout 與 panel 接線

Type: implementation
Status: planned
Blocked by: [工作台選擇與草稿](01-workbench-selection.md), [Accepted conversation readout](02-conversation-readout.md), [對話 I/O 與 view attachment](03-conversation-lifetime.md), [Transcript 與 notice 呈現](04-transcript-presentation.md), [Composer 互動與命令介面](05-composer-interaction.md), [模型與 provider 工作流](06-model-workflow.md), [MCP 工作流](07-mcp-workflow.md), [Definitions target 與刷新接線](08-definition-refresh.md), [訊息 block 呈現模組](09-message-views.md), [檔案 preview 呈現模組](10-file-previews.md)
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R7 Shell、全部責任整合
Acceptance: [行為矩陣](../acceptance.md) — N4、N5、R9、R10、R11，核對前票消費介面

## 目標與責任路徑

`AppShell.tsx` 最終組裝、header/layout/focus、file/terminal panel/tab presentation，SettingsPanel 及新 domain/readout 使用者。TerminalFanIn 僅檢查接線。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "AppShell.tsx" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 以上游票單已落實的 selection、conversation、設定及呈現介面組裝 Shell，移出殘餘 domain handlers。
2. 將 panel/tab 呈現政策集中於實際 UI 擁有者，消費 selection transition；保留 project 切換與 terminal 自有 cwd 規則。
3. 按責任分 header/layout/shortcut/focus 接線，使 shell 不需維護 runtime 初始化、資料接受或設定刷新規則。
4. 做所有當前 callers 的最後清理，刪失效 props/refs/counters；不把完整 Shell 原封不動移到另一巨型 hook。

## 驗收條件

- [ ] Shell 只需知道領域意圖與 readout，無 sessionKey/domain refreshKey 協定。
- [ ] file/terminal tabs、close/restart、active tab、跨 project 清理有單一可追查政策。
- [ ] terminal shared stream／budget 不變，UI panel 不新增 transport 層。
- [ ] keyboard、focus、responsive drawer/panel 行為符合矩陣。
- [ ] App/Web 都能消費新組裝；所有本次 obsolete 路徑及 imports 已刪。

## 驗證與證據

panel ingress、terminal close/session/fan-in、history keyboard/focus、workbench scope 的 focused drivers；App/Web build；變更範圍一般 checks。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：Shell 殘餘 domain setters／同步 flags、已無用途 refresh counters、只作大介面搬運的 hooks／wrappers。

更新 owning guides：開發指南的最終模組地圖、工作台、架構；capability limits 保持真實。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

待實作填寫：變更修訂、changed paths、scenario evidence、已刪路徑、checks/logs、已解決 material findings 及剩餘限制。完成以上條件後才改 Status 為 resolved。
