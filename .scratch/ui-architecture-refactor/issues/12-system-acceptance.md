# 系統驗收與交付記錄

Type: implementation
Status: resolved — source `255a61ac`, final check run `fa7b37dc`; every N/C/R row has an executed result or a named limit
Blocked by: [Shell layout 與 panel 接線](11-shell-composition.md)
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — 驗證與交付、完成條件
Acceptance: [行為矩陣](../acceptance.md) — N1–N10、C1–C9、R1–R11 全部核對

## 目標與責任路徑

本 effort 驗收／票狀態及相關 guides；沿既有 apps/web/e2e drivers／apps/app host journey 做整合。產品修改限可重現 material integration 問題的真正擁有者。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "workbench.tsx" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 對照矩陣收集每列的測試／journey／已知限制，檢查真實覆蓋而不是僅列 driver 名稱；補缺失的高風險整合驗證。
2. 在整合 source 跑相關 changed checks、Web/App build 及必要 browser/native journeys；重用同 source 有效結果，不把舊 revision 的證據當新 revision。
3. 專查 API 呼叫者已遷移、obsolete 路徑已刪、純 fold 無 I/O、正常連線預算及 platform seam 保留。這是 source review，不新增源碼形狀測試。
4. material finding 修到擁有者並做必要驗證，其他記 review notes。更新 owning docs、migration-status 的實際限制、票狀態及交付結果。
5. coordinator 在整合 code edits 後依倉庫規則更新 graph；不做部署、重啟或額外發布。

## 驗收條件

- [x] 每列有 tested revision/dirty state、命令、exit code、raw log 與結果；未測不標 passed。
- [x] Web 與 App、HTTP/SSE 公開 seam、真實 DOM／原生路徑各自有適當證據，不互相冒充。
- [x] 未完成高風險 journey 仍列未完成，沒有以 ticks 或票數代替實測。
- [x] 全部替換清理與現行 guide 更新完成，material findings 已解決；其他限制有 disposition。
- [x] Spec 與票狀態反映真實完成情況，交付附實作修訂及證據索引。

## 驗證與證據

`pnpm verify:changed`（committed branch 選實際 base）、`pnpm --filter @hepi/web build`、`pnpm --filter @hepi/app build`，再按 acceptance 矩陣跑 focused journeys；先確認 package scripts。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：整合殘留 obsolete imports／未使用接線／臨時測試重複；不為無影響推測新增 guards。

更新 owning guides：開發指南、架構、聊天、工作台、providers/MCP 等 owning guides；verification 的實測記錄、migration-status 實際限制及本 effort 結果。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

### 狀態：已審核（`fa7b37dc`）

Independent reviewer `agent-292` 在 `fa7b37dc` 關於本票交付分別做了 Standards 與 Spec 審核：兩者皆無 material findings。審核會定義到行為，不以 driver 名稱取代結果：

| 項目 | 審核結論 |
| --- | --- |
| 導航 target memoization（`ce5cb804`） | 確認修正屬於適當 owner：`AppShell` 以選擇的 `navigation` 記錄 memoize target，回應 `ChatWindow` 的 identity 去重，而非在 caller 加防護 |
| 引用 prompt journey | 一個 fork、一則訊息，跨離開→回來不重播；這就是 `cad0d86b` 修正的行為 |
| native journey | 真實確認、重開後為未設定、本次 run 的憑據 store 為空，皆為實測結果 |
| fixture trust answer | 確認 `GET /api/project-trust` 答案屬 driver 补齊（UI11 將該讀取改到 connection client 後的潛在缺口），不是產品缺口 |
| 統計字數 | 44 個唯一 browser driver、49 次執行（5 個跨 ingress 的重跑），與 raw log 索引一致 |

## 交付記錄

Status: resolved — 全部 N1–N10／C1–C9／R1–R11 已有本次執行的證據或明確限制；實作修訂與證據索引如下。

### 實作修訂

| 修訂 | 內容 |
| --- | --- |
| `6e16e77a` | UI11 Shell 組裝整合（worker `f58ed307`、evidence `c9c2895d`） |
| `cad0d86b` | UI11 review P1：`ChatArea` 的 `onInitialPromptConsumed` 曾回傳 callback 而非呼叫它，pending quoted prompt 會在重掛時重播；改為直接傳遞。agent-292 窄幅複審確認修正，無其他 material finding |
| `ce5cb804` | 本票發現：`AppShell` 每次 render 重建 `searchTarget` 物件，而 `ChatWindow` 以 identity 去重（`searchedRef`）。跟隨 reference／深層搜尋命中進入長對話時，同一個 bounded target window 被讀兩次。改為以 selection 的 `navigation` 記錄 memoize |
| `9ede6815` | 原生 journey 補上 App 自身 logout：refused 介面的 Disconnect → 確認 → shell 重開為未設定，並讀回本次 run 的憑證 store 已空；inspector 連線改為「能回答一次 evaluate 才算可用」（重啟後舊 socket 不會回答） |
| `8526bfca` | 整合 `8f19a31b`（Backend03）後的 merge revision；44 個讀共享 UI 樹的 browser driver 跑在此 |
| `255a61ac` | 整合 `17fe24d4`（Ingress02）後的 revision；Web／App build、cargo debug binary、以及 5 個跨真實 ingress 的 driver 跑在此 |
| `8f22ed70` | 僅文件的提交；五個 ingress driver 與真實 Tauri journey 在此重跑 |
| `fa7b37dc` | 最後一次僅文件的提交；changed 選擇器與文件／入口檢查在此跑一次（`255a61ac..HEAD` 的 `packages`／`apps` diff 為空） |

`ce5cb804` 的判準依 [review policy](../../../docs/agents/review-policy.md)：跟隨 citation／reference 是普通操作，
每個目標視窗都是真實 Backend 的一次 bounded read，重複讀同一窗口是可觀察的多餘工作，屬 fix 而非 record。
修正後 `ux-references-acceptance` 由 2 次降為 1 次 target read，該 driver 即為公開 seam 回歸。

### Changed paths

- `packages/ui/src/components/AppShell.tsx`：`searchTarget` memoize（以 `selectionState.navigation` 為 key）。
- `apps/web/e2e/history/ux-workbench-selection.fixture.tsx`：補 `GET /api/project-trust` 答案。UI11 把該讀取由相對
  `fetch` 改為 `connection.client.request`（App bundle 需要），scene 未答該路由因此以 unanswered 失敗；屬 driver 缺口，
  不是產品缺陷。
- `apps/web/e2e/chat/ux-quote-initial-prompt.ts`、`.fixture.tsx`（新）：`test:quote-initial-prompt`，11 checks。
- `apps/web/e2e/acceptance/ux-native-acceptance.ts`：App logout 段與 inspector 可用性檢查。
- `apps/web/package.json`：新增 `test:quote-initial-prompt`。
- 文件：`docs/verification.md`（本次驗收記錄）、`docs/migration-status.md`（實際限制）、
  `docs/developer-guide.md`（新 driver 的檢查入口）。

### Scenario evidence

逐列結果、指令、exit code 與 raw log 見 [行為矩陣](../acceptance.md#ticket-12)（30 列全部填寫，
未測能力在「剩餘限制」明列）。

### Checks

| 檢查 | 指令 | Revision（dirty） | Exit | Log |
| --- | --- | --- | --- | --- |
| changed 選擇器 | `node scripts/verify.mjs --profile=changed --base=17fe24d4` | `fa7b37dc`（clean；`255a61ac` source） | 0 | `.dev/verify/ui12/verify-final6/verify.json`（UI 474、App 29、web-unit 14、check-docs 全 pass） |
| 文件／入口 | `node scripts/check-docs.mjs`、`node scripts/check-entrypoints.mjs` | `fa7b37dc`（clean） | 0 | 466 Markdown／0 broken link；157 entry files／0 newly missing |
| Web build | `pnpm --filter @hepi/web build` | `255a61ac`（clean） | 0 | `.dev/verify/ui12/web-build.log` |
| App build | `pnpm --filter @hepi/app build` | `255a61ac`（clean） | 0 | `.dev/verify/ui12/app-build.log` |
| App debug binary | `cargo build`（`CARGO_TARGET_DIR=<repo>/.dev/cargo-target`，jobs 6，incremental） | `255a61ac`（clean） | 0 | `.dev/verify/ui12/cargo-build.log` |
| 44 個 browser driver（共 49 次執行） | 各 driver 的 `node apps/web/e2e/...`（或 package script） | 44 個跑在 `8526bfca`，5 個跨 ingress 的在 `8f22ed70` 重跑（clean） | 全 0 | `.dev/verify/ui12/browser/*.log`；索引 `index-final.log`、`index-final2.log`、`index-final3.log` |
| 真實 Tauri journey | `node apps/web/e2e/acceptance/ux-native-acceptance.ts` | `8f22ed70`（clean） | 0 | `.dev/verify/ui12/native/native-acceptance.log`（42 checks） |

browser driver 與 check 數（`grep -c '  ok  '` 或 driver 自己的 PASS 行）：
`workbench-selection` 36、`navigation-retry` 8、`chat-scroll` 15、`transcript-presentation` 15、
`composer-interaction` 24、`conversation-lifetime` 14、`conversation-lifetime-shell` 12、`message-copy` 12、
`quote-initial-prompt` 11、`references` 43、`references-acceptance` 45、`history-navigation-acceptance` 82、
`visible-turns` 29、`history-rail` 23、`history-scope` 11、`raw-history-sidebar-focus` 32、`rail-keyboard` 18、
`subtree-control` 78、`token-footer` 36、`panel-ingress` 77、`provider-acceptance` 70、`mcp-workflow` 16、
`mcp-acceptance` 58、`mcp-tool-states` 62、`capability-trust` 17、`skills-project-target` 14、
`skills-inventory-race` 9、`extensions-panel` 29、`definition-refresh` 15、`delegate-definition-race` 6、
`file-surfaces` 25、`file-failures` 25、`docx-preview` 15、`files-transfer` 17、`workbench-scope` 16、
`terminal-close` 9（driver 的 PASS 行）、`terminal-session` 38、`terminal-fan-in` 26、`web-logout` 17、
`sidebar-ingress` 15、`pwa-offline` 24、`closeout-accessibility` 28、`child-recovery` 24、
`client-acceptance` 58。

### 替換清理與 source review

- `AppShell` 不再持有 `sessionKey`／domain `refreshKey`；UI11 的 `WorkbenchChanges` 承接 catalogue／files 變更訊號。
- `WorkbenchSelection.reloadAttachment` 已無 caller 且已刪除（`f1f6b02b` 起就沒有呼叫端，本次複查確認）。
- 純 fold 無 I/O：`lifecycle-projection`／`history-navigation` 只做決策；socket／timer 在 client 與呈現 owner。
- `TerminalFanIn` 與 `FileSeam` 未被加第二層 facade。
- 本次未新增源碼形狀測試；新 driver 皆走產品普通登入／admission。

### 剩餘限制

真實上游 OAuth、live compaction、release／packaged 產物、Android、remote-host 建置均未執行，見
[矩陣的限制段](../acceptance.md) 與 [migration-status](../../../docs/migration-status.md)。

### Review notes

- `ce5cb804` 的 finding 由本票在整合 source 上以 `ux-references-acceptance` 重現（2 次 target read）並修正後複跑為 1 次。
- `ux-workbench-selection` 的 fixture 缺口屬驗證基礎設施，記錄於上，不列為產品 finding。
- 未觀察 run 不補完成音（ADR 0007）為既有契約，本次未改。
