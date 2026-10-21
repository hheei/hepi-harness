# MCP 工作流

Type: implementation
Status: resolved
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

獨立 reviewer agent-228 對 `7cc775e4..71f2597e` 審閱：Standards／Spec 均無 material findings。確認 fencing、readback、hidden-tab polling、dispose、獨立 Test 及 undo 行為符合規格；未重跑 suites，複用本票驗證。真實 upstream OAuth 與 native Tauri journey 未驗證。

## 交付記錄

Commit: `4526a4af`（parent `7cc775e4`）。先前 checks 在 `7cc775e4` + 本票 dirty tree 上跑，source 相同；提交後 `pnpm verify:changed --base=7cc775e4` 於 clean `4526a4af` 重跑亦 pass（log `.dev/verify/2026-10-21T05-58-28-923-verify-changed/`）。

### 變更

- 新 `packages/ui/src/components/mcp-workflow.ts`：`McpWorkflow` 領域物件，擁有 overview readout（request fence）、selection 由 listing 推導、每個 mutation 的 pending/answered/failed 與 readback、Test（每 server、可與 mutation 並行）、sign-in polling（自有 timer 至終止或 dispose）與 undo notice 到期。
- 新 `packages/ui/src/components/useMcpWorkflow.ts`：唯一 React 綁定，每 connection+folder 一個 workflow，`useSyncExternalStore` 快照，unmount dispose（effect 建立、state 持有，StrictMode replay 安全）。
- 改 `packages/ui/src/components/McpConfig.tsx`：view 只保留表單欄位（Add draft、Code mode budget row）、選取意圖、focus 回復；刪除 overview/mutation/polling 協調、request counter、controller refs、`applyOverview`/`runAction`/poll round。`McpConfigView` 改收單一 `snapshot`。
- 新測試 `packages/ui/src/components/mcp-workflow.test.ts`（8 案例）。
- 新瀏覽器 journey `apps/web/e2e/mcp-skills/ux-mcp-workflow.{ts,fixture.tsx,fixture.css}`，script `test:mcp-workflow`。
- 文件：`docs/mcp-on-the-web-host.md` 新增「The panel's own workflow (ticket 07)」；`docs/developer-guide.md` 檢查清單加入 `test:mcp-workflow`。

### 已刪路徑

McpConfig 內的 `loadMcpOverview`/`postMcpAction`/`postMcpTest`/sign-in request 接線、`requestRef`/`controllerRef`/`saveControllerRef`/`actionControllerRef`/`testRequestsRef`/`signInsRef`/`pollRound`/`activeFlowsKey`/`mountedRef`、`refresh`/`saveCodemode*`/`runAction`/`applyOverview`/`testServer`/`startSignIn`/`pasteSignIn`/`cancelSignIn`/`signOut`/`undoRemoval`/`switchGroup` 的 view 端版本、view 端的 `onProjectTrustChanged` 呼叫與 selection reconcile。無 shim／alias／雙路徑。

### Scenario evidence（acceptance R4、R5）

| 列 | 承接 | 結果 |
| --- | --- | --- |
| R4 | `mcp-workflow.test.ts`（readout fence、refused change reload、test beside change、Add select+test）＋ `ux-mcp-workflow.ts`（pending change、answer 的 listing、refusal 顯示 host reason 並重讀、Test 結果成 row state）＋ `test:mcp-acceptance`、`test:mcp-tool-states` | pass |
| R5 | `ux-mcp-workflow.ts`：sign-in 在 Settings 切到 General（section hidden）期間持續 polling 並在該處結束；換 connection 後舊 panel 停止 polling、新 connection 重讀。unit：ended flow 停止 polling、gone flow 停止、dispose 後不再請求 | pass |

### Checks（全部在 revision `7cc775e425512087f91365ccc06b9323a9bc11a4`，dirty tree = 本票變更；raw log 於 `.dev/verify/mcp07/`）

| command | exit | log |
| --- | --- | --- |
| `pnpm --filter @hepi/ui typecheck` | 0 | `ui-typecheck.log` |
| `pnpm --filter @hepi/ui test` | 0（375 pass） | `ui-test.log` |
| `pnpm --filter @hepi/web test:mcp-workflow` | 0（16 checks PASS） | `mcp-workflow-browser.log` |
| `pnpm --filter @hepi/web test:mcp-tool-states` | 0（PASS） | `mcp-tool-states.log` |
| `pnpm --filter @hepi/web test:mcp-acceptance` | 0（PASS） | `mcp-acceptance.log` |
| `pnpm verify:changed --base=7cc775e4` | 0（changed-typecheck / changed-test / web-unit / check-docs） | `.dev/verify/2026-10-21T05-56-12-953-verify-changed/` |
| `pnpm --filter @hepi/web build` | 0 | 終端輸出 |
| `pnpm check:docs` | 0（464 files, 0 broken） | 終端輸出 |

### Findings

無 material finding。未測：真實 upstream OAuth provider 的完整授權流程（journey 用 fixture host 的合法 flow 形狀，非真實 upstream）；Tauri packaged App 的 MCP 面板未在原生 host 上驅動。兩者為本票既有能力限制，不宣稱可用。
