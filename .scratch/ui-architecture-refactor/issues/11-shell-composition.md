# Shell layout 與 panel 接線

Type: implementation
Status: resolved
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

- [x] Shell 只需知道領域意圖與 readout，無 sessionKey/domain refreshKey 協定。
- [x] file/terminal tabs、close/restart、active tab、跨 project 清理有單一可追查政策。
- [x] terminal shared stream／budget 不變，UI panel 不新增 transport 層。
- [x] keyboard、focus、responsive drawer/panel 行為符合矩陣。
- [x] App/Web 都能消費新組裝；所有本次 obsolete 路徑及 imports 已刪。

## 驗證與證據

panel ingress、terminal close/session/fan-in、history keyboard/focus、workbench scope 的 focused drivers；App/Web build；變更範圍一般 checks。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：Shell 殘餘 domain setters／同步 flags、已無用途 refresh counters、只作大介面搬運的 hooks／wrappers。

更新 owning guides：開發指南的最終模組地圖、工作台、架構；capability limits 保持真實。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

變更修訂：commit `f58ed307`（worktree base `e6a0ffd2`，clean tree）。

Changed paths（相對 `packages/ui/src`，另有列明者）：

- 呈現拆檔：新增 `components/ShellTopBar.tsx`（bar 本體、sidebar toggle、響應式 toolbar、session stats 按鈕、file toggle、
  trust banner、dropdown 錨點與 narrow More overlay）、`components/ShellTopPanel.tsx`（一次一個 dropdown：child tree +
  subtree control、delegate、raw history、system prompt、tool list、session 事實）、`components/ChatArea.tsx`（
  ReadFailurePanel／ChatWindow／placeholder／未選取）、`components/WorkspacePanel.tsx`（TabBar、展開/隱藏、viewer、
  terminal tabs）、`components/SessionStatsPopover.tsx`（stats／context 讀出與複製回饋）。
- 政策與接線：`components/panel-state.ts`（`PanelState` 與全部 tab 轉移）、`hooks/useWorkspacePanel.ts`（tabs、active
  tab、開啟狀態、`sessionStorage` 還原與「空 panel 自動關閉」）、`hooks/useShellPanels.ts`（兩個 resizer 與互相上限）、
  `hooks/useSurfaceFocus.ts`（`useFocusReturn`、`useDismissOnOutsidePointer`）。
- 變更訊號：`lib/workbench-changes.ts`（`WorkbenchChanges`：`catalogue`／`files`），掛在
  `lib/workbench-scope.ts` 的 `WorkbenchConnection`；`components/SessionSidebar.tsx`、`components/FileExplorer.tsx`、
  `components/TextFilePreview.tsx`、`components/ChatWindow.tsx` 訂閱／發布，`components/AppShell.tsx` 只發布。
- 測試入口遷移：`components/subtree-surface.test.ts` 改指向實際擁有者 `ShellTopPanel.tsx`；
  `apps/web/e2e/chat/ux-token-footer.ts` 的 toolbar glyph 斷言改指向 `ShellTopBar.tsx`；
  `apps/web/e2e/workbench-files/ux-file-failures.fixture.tsx`／`.ts` 的 Reload folder 斷言改為「到達 connection 的
  files 訊號」而非 shell 回呼。
- 新測試：`components/panel-state.test.ts`（6：path 為 key、單一 terminal tab、close 的 fallback 與清空、terminal close
  由自身 surface 完成、restart 保留 tab、跨 project 只清 file tabs）、`lib/workbench-changes.test.ts`（3：訂閱/退訂、
  自我退訂不吞下一個、無 replay）。
- 文件：`docs/workbench.md` 新增「The panel beside the chat」一節（模組責任表、tab 政策、變更訊號）。

已刪路徑：`AppShell.tsx` 內的 `refreshKey`／`explorerRefreshKey`／`gitRefreshKey` 計數與其 setter、
`onSessionsChange`／`onRunningSessionIdsChange` 之外的 explorer 回呼、`onExplorerRefresh`／`onFilesUploaded`／
`onReloadFolder` 三條 shell→surface 回呼、`sidebarHoldsFocusRef` 與 `systemInfoLoading`／`systemInfoLoadIdRef` 的重複
pending 狀態、`FileExplorer` 的 `refreshKey` prop、`openSessionStatsPanel`／`systemBtnRef` 等死符號。無 shim／alias／
雙路徑保留；`FileSeam`、`TerminalFanIn`、selection owner、project/terminal cwd 規則未改。

Evidence（revision `f58ed307`，clean tree，base `e6a0ffd2`）：

- `pnpm verify:changed --base=e6a0ffd2` exit 0：changed-typecheck、changed-test（`@hepi/app`／`@hepi/ui`）、web-unit、
  check-docs 全 PASS；log `.dev/verify/2026-10-22T01-55-31-743-verify-changed`。
- `pnpm --filter @hepi/ui test`：474 pass / 0 fail（`.dev/verify/2026-10-22T01-55-f58ed30-ticket11/ui-tests.log`）。
- `pnpm --filter @hepi/web build`、`pnpm --filter @hepi/app build` exit 0。
- focused browser drivers 全部 exit 0，每個 driver 一份 raw log 在
  `.dev/verify/2026-10-22T01-55-f58ed30-ticket11/`：`terminal-close`（9 checks，含 pending creation／cleanup 與
  restart）、`terminal-fan-in`（26）、`terminal-session`（UX-13 PASSED）、`chat-scroll`（host bounded 800/800）、
  `history-rail`、`history-scope`、`visible-turns`、`composer-interaction`、`file-failures`、`file-surfaces`、
  `workbench-scope`、`token-footer`、`panel-ingress`、`raw-history-sidebar-focus`、`rail-keyboard`、
  `subtree-control`。
- 拆檔期間發現並修正的 material finding：`WorkspacePanel` 一度被放在 shell 的 flex row 之外，`#root` 因此長到 854px
  （viewport 800）。`test:chat-scroll` 的「host is bounded by the viewport」抓住它；panel 已回到 row 內，該 driver 現
  800/800 通過。

剩餘限制：R11 的 App host 切 connection／logout 驗收屬整合票 12；本票只證明 Web ingress 與 App build 消費同一組裝。
未執行真 Tauri 原生儲存（票 10 已記錄）。
