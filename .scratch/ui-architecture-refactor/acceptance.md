# 行為與驗收矩陣

Status: verified — 需求表；本次實作結果與證據見文末「本次實作驗收結果」。
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Contract: [架構收斂規格](spec.md)；票號及執行狀態見[票單計畫](ticket-plan.md)。

## 使用方式

責任票須把每列指向其遷移後測試或具體人工 journey，填入驗證證據。以既有測試承接為優先；只有未覆蓋的 material 行為才新增案例。這是需求矩陣，既有 driver 名稱僅是起點，不表示它目前覆蓋整列。最終整合驗收追蹤每列，不重新複製所有單測。

所有測試經產品普通登入、admission、資源介面；禁止 bypass probe。一般競態測試可控制合法讀取結果到達順序，但不繞過 auth／trust／大小預檢等限制。

## 選擇、草稿、工作台

| ID | 正常使用情境 | 必須觀察的結果 | 責任票／驗證 seam |
| --- | --- | --- | --- |
| N1 | URL 指定 cwd、session、或兩者，再 reload | 明確 URL 優先於 tab memory；兩者都有時 cwd 優先；成功開啟後 URL／選擇一致 | 工作台選擇；initial-navigation 既有單測 + browser |
| N2 | 無明確 URL，還原前一 conversation 或未送出 composer | tab 的 conversation／composer identity 與草稿承接；workspace 記憶只在既有還原條件介入 | 工作台選擇；選擇介面 + browser |
| N3 | 還原／open 尚未結束，使用者選了其他目標 | 舊結果不改新選擇、URL、draft 或錯誤面板；明確 retry 只重讀當前未解決意圖 | 工作台選擇；延遲的合法 open/read |
| N4 | 對話已開，切同 project worktree；之後補齊 projectKey | 已開對話保留；身分 hydration 不造成回首頁／重掛；同 project file tabs 保留 | 工作台選擇、Shell 呈現；選擇介面 + browser |
| N5 | 跨 project 切換或從另一 project 的「+」開始 | 舊 file tabs 清除；終端保留自己 cwd，依既有 tab 規則關閉／保留；目的地還原與選擇一致 | 工作台選擇、Shell 呈現 |
| N6 | 新 composer 輸入文字、圖片及 model/thinking，移到另一 cwd | carry 操作帶走目前 live 草稿與選擇；目標停放草稿不與 carry 草稿合併；提交到新 cwd | 工作台選擇、composer；真實 DOM + submit fixture |
| N7 | 離開 composer 再回該 cwd；同 cwd 明確按 New | parked draft 依現有政策取回；New 有獨立 identity，不把目前 composer 的 live 文字誤作新輸入；不刪使用者未送出資料 | 工作台選擇；draft store 既有案例 + browser |
| N8 | 新 composer 首次提交並 promotion；提交結果未知 | promotion 在既有確認點承接草稿／identity；未知結果可查詢且不重送、不提前清草稿 | 工作台選擇、對話 I/O；提交公開 seam |
| N9 | 刪除當前／其他對話，或開啟目標已不存在／暫時讀不到 | 僅必要時離開；fallback 到已知 cwd 的 composer；其他對話與草稿不受影響；區分 gone 與可 retry | 工作台選擇；取代 VM source extraction |
| N10 | 重點同一 conversation；或選擇帶 entry/block 的搜尋／引用結果 | 普通重點不 reset 閱讀；顯式 target 仍能定位；raw-history focus 按既有選項顯示 | 工作台選擇、transcript；navigation/reference drivers |

## 對話、歷史與呈現

| ID | 情境 | 必須觀察的結果 | 責任票／驗證 seam |
| --- | --- | --- | --- |
| C1 | HTTP/SSE 並行、重連、較舊 revision／不同 attachment 的合法結果晚到 | 延用既有 fold 的接受／拒絕規則；view、prefix、metadata、cache 不被 stale read 回退 | readout、對話 I/O；既有 lifecycle/transport tests |
| C2 | 翻舊頁、live window 向前、jump window、head 變更／compaction | transcript 無重複／缺漏／錯序；prefix 依現有規則保留或失效；完整 stats 與 history token 不丟失 | readout、transcript；prefix/history seam + browser |
| C3 | submit／steer／follow-up／queue／abort，收件後網路中斷 | pending、entry commit、answer interest 與 activity 不混淆；未知結果只 lookup；retry 不重做寫入 | 對話 I/O；ConversationApi + lifecycle tests |
| C4 | 前景離開仍有工作，再選回；多個 answer groups 結束 | 共用既有串流與 projection handover；觀察到的每答案最多一次成功通知，失敗／abort／子代理不誤響 | 對話 I/O；handover/completion 既有案例 + browser |
| C5 | 同 conversation 設定 reload、connection 替換／dispose、React setup/cleanup | reload 不重建整棵聊天樹；舊請求不寫新 connection；資源釋放，背景興趣依既有契約保留 | 對話 I/O、definitions；公開訂閱/讀介面 |
| C6 | 正在閱讀舊訊息時到新資料；回底部；history jump／還原 | 不強拉讀者到底；follow-tail／user anchor／entry 位置與既有動作一致；移動間不套用舊對話 scroll | transcript；chat-scroll/history drivers |
| C7 | notice 顯示、hover／focus 暫停、離開 view | 依現有剩餘時間暫停／恢復；清理本地 timer；不產生第二種 lifecycle 成功判定 | transcript；本地顯示行為測試 |
| C8 | IME 組字、Enter、undo/redo、@／slash 選取、圖片貼上及重開草稿 | 不在組字中誤送；完成插入與 undo 語義保留；字串、selection、附件與保存值一致 | composer；ChatInput 案例 + 真實瀏覽器 |
| C9 | 展開 tool/thinking、串流增量、deferred block、diff／引用連結 | 已有 block identity、展開狀態、資源延遲讀與錯誤顯示保留；呈現不新開 conversation stream | 訊息呈現；MessageView 案例 + references driver |

## 設定、檔案、平台

| ID | 情境 | 必須觀察的結果 | 責任票／驗證 seam |
| --- | --- | --- | --- |
| R1 | model config applied 保存／credential 成功更新；Settings 持續開啟 | 受影響 scope catalog invalidated；已掛載讀者重讀，未掛載讀者下次讀更新；不默改目前模型／草稿 | 模型工作流；cache seam + provider browser driver |
| R2 | 無修改關閉 Settings；保存失敗／saved-but-not-applied；catalog read 失敗 | 無修改不刷新；不虛報 applied；必要 readback 與錯誤可見，retry 只讀，不重做 mutation | 模型工作流；工作流 + browser |
| R3 | provider 草稿快速改 key/baseUrl、切 scope，舊 discovery 才返回 | 舊結果不蓋新草稿；目前 request fencing 與 cache scope 保留，不把不同讀取混為一種 | 模型工作流；工作流 controlled results |
| R4 | MCP add/import、修改／刪除、test、trust、codemode，以及失敗回讀 | pending/result/error 可見；mutation 及 overview 同一擁有者；既有信任流程與脫敏語義不變 | MCP 工作流；現有 MCP acceptance + interface tests |
| R5 | MCP OAuth 進行中切 Settings tab，再完成／逾時／斷線 | 草稿保留；active flow 依既有規則繼續／終止；connection dispose 清資源，不把 hidden 當取消 | MCP 工作流；合法 sign-in fixture + browser |
| R6 | Skills/Agents/Extensions 選 library／conversation target；reload 時切 conversation | scope 不串用；刷新只作用適用的 target／conversation；無 Shell sessionKey 協定、無提交重播 | definitions；既有 target/extension journeys |
| R7 | FileViewer 切格式／路徑、docx 超出預檢、bearer blob 與 cookie URL | metadata／lease／abort/release 語義保留；大檔顯示既有限制；不加裸 fetch 或重複遠端下載 | 檔案呈現；files/docx/failures drivers |
| R8 | Browser download 及實際 Tauri 儲存、取消或失敗 | FileSaveHost 既有選檔與 bounded write/finish/abort；取消不誤報成功；平台差異留 adapter | 檔案呈現、整合驗收；原生測試不能用 browser 替代 |
| R9 | 多 terminal tabs、resize/input、close/restart，與檔案分頁共存 | 延用 TerminalFanIn，共用輸出串流與既有連線預算；tab cwd 不隨 workspace 重寫 | Shell 呈現；terminal-session/close/fan-in drivers |
| R10 | desktop／narrow layout、Sidebar drawer、快捷鍵、panel close 的 focus | 現有鍵盤／焦點／mobile drawer 行為保留；資料轉換不依 UI callback 先後順序 | Shell 呈現；panel/history keyboard drivers |
| R11 | Web 與 App 掛同一 UI，切 connection/account 或 logout | adapter 正確；舊 connection 不再發布；catalog／draft／session readout 不被當新 scope 的資料 | 整合驗收；Web admission + App host journeys |

## 既有驗證起點

按各票改動選取，不將全部命令綁到每票。實作若搬動測試，在同票更新 owning script 與本表的證據指標。

- `pnpm --filter @hepi/ui test`、`pnpm --filter @hepi/ui typecheck`：純規則、hooks 及互動的既有案例；對應檔案在 UI `src` 中 colocated。
- `pnpm --filter @hepi/web test:chat-scroll`、`test:navigation-retry`、`test:history-rail`、`test:history-scope`、`test:raw-history-sidebar-focus`、`test:rail-keyboard`、`test:references`。
- `pnpm --filter @hepi/web test:provider-acceptance`、`test:mcp-acceptance`、`test:skills-project-target`、`test:skills-inventory-race`、`test:extensions-panel`。
- `pnpm --filter @hepi/web test:file-surfaces`、`test:file-failures`、`test:docx-preview`、`test:files-transfer`、`test:workbench-scope`、`test:terminal-close`、`test:terminal-session`、`test:terminal-fan-in`。
- `pnpm --filter @hepi/web test:client-acceptance`、`test:provider-acceptance`、`test:native-acceptance` 是整體起點；先讀 driver 確認真實覆蓋，特別區分 mock host 與實際 Tauri。
- `pnpm verify:changed` 執行相關一般檢查；Web／App build 及實際 browser/native journeys 另依改動補充。

## 證據格式與最終核對

每列記錄：scenario ID、承接測試／journey、tested revision 與 dirty state、command、exit code、raw log、通過／失敗／未測及原因。可集中在票的驗證節引用既有 runner 報告，不複製整份輸出。沒有執行即保持未測。

純 UI fixture 可證明畫面接線；request ordering 由公開 transport 測；真實上游 OAuth、live compaction、packaged native 只能用對應環境結果聲稱。能力本來未測的部分保留其限制；本工作改到的高風險平台流程若仍無證據，不宣稱整體驗收完成，記錄未完成項。

## 本次實作驗收結果（ticket 12）

Status: verified — 每一列都指向本次實際執行的 driver／suite，並綁定下列 revision。未測能力另列限制，不以 driver 名稱代替結果。

Tested revision: `8526bfca`（clean tree；`git status --porcelain` 為空）。所有 browser／native／build 指令都跑在該 revision。
統一報告與 raw logs：`.dev/verify/ui12/`（`verify-changed-final/verify.json`、`browser/*.log`、`native/native-acceptance.log`、`web-build.log`、`app-build.log`、`cargo-build.log`）。

| 檢查 | 指令 | Exit | 結果 |
| --- | --- | --- | --- |
| changed 選擇器（typecheck／UI+App 測試／web-unit） | `node scripts/verify.mjs --profile=changed --base=8f19a31b` | 0 | UI 474／474、App 29／29、web-unit 14／14，全部 PASS；`verify-changed-final/verify.json` |
| 文件與入口 | `pnpm check:docs`、`node scripts/check-entrypoints.mjs` | 0 | 466 Markdown、0 broken link、0 guide 漏索引；155 entry files、0 newly missing |
| Web build | `pnpm --filter @hepi/web build` | 0 | `web-build.log` |
| App build | `pnpm --filter @hepi/app build` | 0 | `app-build.log` |
| App 原生 binary（debug profile，共用 cargo target） | `cd apps/app/src-tauri && CARGO_TARGET_DIR=<repo>/.dev/cargo-target CARGO_BUILD_JOBS=6 CARGO_INCREMENTAL=1 cargo build` | 0 | `cargo-build.log`；產物 `.dev/cargo-target/debug/hepi-app` |
| 49 個 browser driver | 見下表各自的 script | 全部 0 | 每個 driver 一份 raw log 在 `browser/`；索引 `browser/index-final.log`、`index-final2.log`、`index-final3.log` |
| 真實 Tauri native journey | `node apps/web/e2e/acceptance/ux-native-acceptance.ts --keep` | 0 | 42 個檢查全過；`native/native-acceptance.log` |

### 選擇、草稿、工作台

| ID | 承接驗證 | 觀察到的結果 |
| --- | --- | --- |
| N1 | `ux-workbench-selection`（36 checks）、`ux-navigation-retry`（8）、`workbench-selection.test.ts` | 明確 `?session=`／`?cwd=` 優先於 tab memory；兩者並存時 cwd 勝；真 reload 後 URL、tab memory 與選擇一致 |
| N2 | `ux-workbench-selection`、`workbench-selection.test.ts` | 無 URL 時回到 tab 記住的 conversation 或 composer，草稿在真 reload 後回到輸入框，且 identity 不變 |
| N3 | `workbench-selection.test.ts`（延遲 open／read 的 generation fence）、`ux-navigation-retry` | 晚到的 open／read 不改新選擇、URL 或錯誤面板；Retry 只重讀當前未解決意圖 |
| N4 | `workbench-selection.test.ts`（projectKey hydration）、`ux-conversation-lifetime-shell`（同 scope 不重掛） | 身分補齊合併 row 而不替換 conversation；已開對話保留 |
| N5 | `panel-state.test.ts`、`ux-workbench-selection`（跨 project 的 reference）、`ux-terminal-close`／`ux-terminal-session` | 跨 project 只清 file tabs；terminal 保留自身 cwd 與 tab 規則 |
| N6 | `ux-composer-interaction`（24）、draft store 測試 | carry 帶走 live 草稿與 model／thinking；目標停放草稿不合併 |
| N7 | `ux-workbench-selection`、`useComposerDraft` 案例 | parked draft 取回；New 是獨立 identity，不吞目前文字，也不刪未送出資料 |
| N8 | `ux-conversation-lifetime`（14）、`useAgentSession.lifecycle.test.ts` | 未知提交只 lookup（1 POST、1 lookup、0 重送）；promotion 在確認點承接草稿／identity |
| N9 | `ux-workbench-selection`（刪除段）、`ux-navigation-retry` | 刪除當前對話落到同 cwd 的 composer，其他對話與草稿不受影響；gone 與可 retry 分開 |
| N10 | `ux-references`（43）、`ux-references-acceptance`（45）、`ux-raw-history-sidebar-focus`（32）、`ux-rail-keyboard`（18）、`ux-subtree-control`（78） | 同一 conversation 重點不 reset 閱讀；顯式 target 仍定位；raw-history focus 依既有選項顯示 |

### 對話、歷史與呈現

| ID | 承接驗證 | 觀察到的結果 |
| --- | --- | --- |
| C1 | `useAgentSession.lifecycle.test.ts`（在 474 UI 套件內）、`ux-conversation-lifetime` | 較舊 revision／換 connection 的合法結果晚到時不發布；view、prefix、metadata 不回退 |
| C2 | `ux-visible-turns`（29）、`ux-history-rail`（23）、`ux-history-scope`（11）、`ux-history-navigation-acceptance`（82） | 翻舊頁、live window、jump window 與 head 變更下 transcript 無重複／缺漏／錯序；完整 stats 與 history token 保留。**live compaction 本身未測** |
| C3 | `useAgentSession.lifecycle.test.ts`、`ux-conversation-lifetime`、`ux-child-recovery`（24） | submit／steer／follow-up／queue／abort 語義保持；收件後網路中斷只 lookup，不重做寫入 |
| C4 | `completion-delivery.test.ts`、`handover-continuity.test.ts`、`ux-conversation-lifetime` | 前景離開仍追蹤背景工作；每答案至多一次通知；失敗／abort 不誤響 |
| C5 | `ux-conversation-lifetime-shell`（12）、`conversation-session.test.ts`、lifecycle | 同對話 reload 不重建整棵聊天樹；換 connection 時 registry 重建、舊 source closed、舊讀不寫新 connection |
| C6 | `ux-chat-scroll`（15）、`ux-transcript-presentation`（15） | 讀歷史時新資料不強拉到底；follow-tail／anchor／jump 依既有動作；移動間不套用舊 conversation scroll |
| C7 | `ux-transcript-presentation` | notice 依剩餘時間暫停／恢復，離開 view 清理本地 timer，未新增第二種完成判定 |
| C8 | `ux-composer-interaction`（24）、`ChatInput.test.ts` | IME 組字不誤送；插入與 undo 語義保留；字串、selection、附件與保存值一致 |
| C9 | `ux-message-copy`（12）、`ux-token-footer`（36）、`ux-subtree-control`（78）、`ux-references` | block identity、展開狀態、延遲資源讀與錯誤顯示保留；呈現不新開 conversation stream |

### 設定、檔案、平台

| ID | 承接驗證 | 觀察到的結果 |
| --- | --- | --- |
| R1 | `ux-provider-connection-acceptance`（70） | applied 保存／成功 credential 更新使受影響 catalog 失效，已掛載讀者立即重讀（1→2 次 `/api/models`）；不改目前 model、不清草稿 |
| R2 | `ux-provider-connection-acceptance` | 未修改關閉 Settings 不刷新、不 fetch；saved-but-not-applied 如實顯示並 readback；catalog 讀失敗可重試且只重讀 |
| R3 | `ux-provider-connection-acceptance`、models-cache／workflow 測試 | 舊 discovery 結果不蓋新草稿；request fencing 與 cache scope 保留 |
| R4 | `ux-mcp-workflow`（16）、`ux-mcp-acceptance`（58）、`ux-mcp-tool-states`（62）、`ux-capability-trust`（17） | add／import／修改／刪除／test／trust／codemode 的 pending／result／error 可見；信任流程與脫敏語義不變 |
| R5 | `ux-mcp-acceptance`（合法 sign-in fixture） | 切 Settings tab 後 active flow 依既有規則繼續／終止；connection dispose 才釋放。**真實上游 OAuth 未執行** |
| R6 | `ux-skills-project-target`（14）、`ux-skills-inventory-race`（9）、`ux-extensions-panel`（29）、`ux-definition-refresh`（15）、`ux-delegate-definition-race`（6） | scope 不串用；刷新只作用適用 target；無 sessionKey 協定、無提交重播 |
| R7 | `ux-file-surfaces`（25）、`ux-file-failures`（25）、`ux-docx-preview`（15）、`files-transfer`（17） | metadata／lease／abort／release 保留；docx 超出預檢在讀 bytes 前拒絕；無裸 fetch 或重複遠端下載 |
| R8 | 真實 Tauri journey（42 checks） | GTK 儲存對話框由 xdotool 回答，落地 bytes 與 workspace 檔案 sha256 相同（1048 bytes）；取消不留檔、控制回到 idle；第二次開啟 picker 後 Escape 收檔 |
| R9 | `ux-terminal-close`（9）、`ux-terminal-session`（38）、`ux-terminal-fan-in`（26）、`panel-state.test.ts` | 多 tab 共用一個 fan-in 串流與連線預算；close／restart 只一次；tab cwd 不隨 workspace 重寫；與 file tabs 共存 |
| R10 | `ux-panel-ingress`（77）、`ux-raw-history-sidebar-focus`（32）、`ux-rail-keyboard`（18）、`ux-closeout-accessibility`（28） | desktop／narrow layout、Sidebar drawer、快捷鍵、panel close 的焦點行為保留；資料轉換不依 UI callback 順序 |
| R11 | `ux-client-acceptance`（58，Web 真實瀏覽器 + App browser-emulated）、`ux-web-logout`（17）、`ux-conversation-lifetime-shell`、真實 Tauri journey | Web 與 App 掛同一 UI：Web 登入／logout 走 ingress 路由；App 同 scope 換 connection 不重掛並重建 registry；真實 shell 以已撤銷憑證啟動時報 refused、再經其自身 Disconnect 刪除憑證並重開為未設定 |

### 剩餘限制（未宣稱）

- **真實上游 OAuth**：R5 只以合法 sign-in fixture 覆蓋，未對真實 provider 授權伺服器執行。
- **live compaction**：C2 覆蓋 head 變更與 jump window，但未對真實長對話執行一次壓縮。
- **packaged release artifact**：native journey 使用 debug profile binary，屬功能證據，不是 release 效能或打包產物驗證；未建置 release 或 `.deb`。
- **Android**：本機無 SDK／adb／裝置，未對行動 App 做任何聲稱。
- **remote-host**：未在 remote-host 建置或執行；全部 build 在 workstation。
- **未觀察 run 不補完成音**：ADR 0007 既有契約，本次未改。
