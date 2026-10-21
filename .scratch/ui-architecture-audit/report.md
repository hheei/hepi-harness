# UI 功能塊與架構盤點

日期：2026-10-21。基準：`a57100bb4917d408ee51c19beeda30d3efecc857`。

## 判斷

存在局部、可具體定位的架構失衡。最嚴重的是「工作台選擇／切換」和「對話 runtime／呈現」責任交錯；設定面板其次。檔案與終端已有比較清楚的傳輸／平台介面，問題主要是畫面檔案聚集。不能由此判定整個前後端架構失敗。

前一輪目錄重整解決導航，TS 遷移解決可檢查性；都沒有改變狀態擁有者、功能生命週期或跨功能通知，因而不會自然消除目前的維護負擔。

這是靜態分析：原始碼確認、依賴圖導航、三個功能範圍的平行盤點與交叉核實。沒有重跑測試、做效能實驗或修改實作。下列風險表示維護與變更耦合，不等於已重現使用者故障。現有 git 路徑歷史只有初始匯入及本次重整，不能據此追溯是哪次需求或哪位作者造成。

## 規模訊號

[metrics.json](metrics.json) 收錄 227 個 UI 實作 TS/TSX 檔案、65,239 行；排除 `.test.`、`.d.ts`，包括翻譯字典。以下是檔案層級呼叫位置的文字統計，包含同檔內的子元件，並非單一元件同時建立的 hook 數，也不是圈複雜度。

| 檔案 | 行數 | useState | useEffect / useLayoutEffect | useRef |
| --- | ---: | ---: | ---: | ---: |
| AppShell.tsx | 2,942 | 44 | 25 | 28 |
| ChatInput.tsx | 2,855 | 27 | 27 | 21 |
| useAgentSession.ts | 2,466 | 37 | 16 | 44 |
| SessionSidebar.tsx | 2,440 | 37 | 25 | 45 |
| ModelsConfig.tsx | 2,189 | 28 | 9 | 11 |
| MessageView.tsx | 2,178 | 26 | 5 | 6 |
| McpConfig.tsx | 2,149 | 17 | 11 | 19 |
| ChatWindow.tsx | 1,961 | 14 | 28 | 30 |

八檔合計 19,180 行、230 個 state 呼叫位置、146 個 effect 呼叫位置。數字只用來追查熱點；MessageView 的多種 block 呈現，不能和 AppShell 的跨功能協調一視同仁。

## 功能盤點

| 功能塊 | 主要擁有者 | 必要複雜度 | 問題及優先級 |
| --- | --- | --- | --- |
| 連線、登入、Web／App 組裝 | workbench、workbench-scope、client | descriptor、credential、連線替換、dispose | 已有集中介面；draft store 的全域 scope 仍由 render 安裝。中 |
| 選擇、新對話、工作樹、還原 | AppShell、SessionSidebar、NewSessionContextBar | URL、tab memory、workspace memory、草稿 promotion | 多方向回報與 imperative 控制；轉換規則跨視圖。最高 |
| 對話執行、提交、恢復、完成通知 | useAgentSession、lifecycle-projection、CompletionDelivery | 未知提交結果、串流、重連、前背景交接 | runtime、讀取、model、toast、DOM 混在大 hook；Shell 知道初始化細節。最高 |
| 歷史、跳轉、虛擬視窗、捲動 | useHistoryNavigation、history-navigation、ChatWindow、useAgentSession | active window、older prefix、raw history 不同 | prefix 調整與捲動還原跨 hook／畫面協調。高 |
| 輸入、附件、slash、@、queue | ChatInput、useAgentSession | 原生輸入／undo、圖片、命令 | 編輯互動與業務命令選擇共用大介面。高，先縮上游 |
| 訊息、thinking、tool、diff | MessageView、MarkdownBody、resource reader | 多態內容、deferred blocks、memo | 呈現聚集；尚無同級狀態所有權問題證據。中低 |
| 模型、provider、credential | ModelsConfig、OAuthDetail、EnabledModelsSection、models-cache | 表單、認證、catalog、啟用集合 | mutation／cache／可見 readout 的更新契約分散。高 |
| MCP 設定、測試、登入、codemode | McpConfig、helpers、McpSignIn、McpAddServer | 多來源設定、信任、測試、OAuth flow | helpers 拆出了函式，overview／mutation／polling 協調仍留在 UI。中高 |
| Skills、Agents、Extensions | 對應 Config、ExecutionTarget | library、execution target、conversation reload 不同 | target 生命週期已有介面；部分更新仍回到 session 重掛。中 |
| 檔案、預覽、上傳、儲存 | FileSeam、FileViewer、FileExplorer、FileSaveHost | cookie URL／bearer blob、格式、bounded save | FileViewer 呈現聚集；傳輸擁有者合理。中低 |
| 終端 | TerminalPanel、TerminalFanIn、terminal-client | 多 tab 一條輸出串流、獨立輸入、cursor | 內部集中；與檔案共用 panel 的分頁政策還在 Shell。低 |
| 外觀、響應式、快捷鍵、焦點 | AppShell、SettingsUi、layout hooks | accessibility、drawer、resize | layout 與 domain transition 混在 Shell。中，先移業務 |

## F1：選擇／切換沒有單一擁有者

證據：

- [AppShell.tsx](../../packages/ui/src/components/AppShell.tsx)：`handleCwdChange`（約 899 行）不只更新 cwd，也決定 project 身分、搬草稿、退出對話、清資訊、清檔案分頁、還原舊對話及導向 URL。
- 同檔 `handleSelectSession`（981 行）再處理其中多個規則，並設定 `suppressCwdBumpRef`，避免 Sidebar 隨後的 cwd 回報再次觸發切換。
- [SessionSidebar.tsx](../../packages/ui/src/components/SessionSidebar.tsx)：158 行起同時接收 selected cwd 與向上發出 cwd change；408 行另持有 `selectedCwd`；834 行起回報及向下同步各有 effect。
- Sidebar 的 `SessionSidebarControl`（190 行起）由聊天區新對話列呼叫；AppShell 的 `handlePickNewSessionContext`（1438 行起）把動作送進 Sidebar，再轉回 `onNewSession`。

普通變更例：調整「切到同專案另一 worktree 時保留甚麼」。需要理解 Sidebar 的選擇、Shell 的 project 比較、草稿移動、conversation 保留及稍後的還原結果。問題是轉換規則跨視圖，不是存在多個 UI 入口。

建議：工作台選擇模組統一接收 selectConversation、startComposer、selectWorkspace、restore 等意圖，持有明確的選擇值與轉換結果。Sidebar 和新對話列都送同一組意圖。URL、tab memory、workspace memory 各有用途，優先次序由這一個擁有者決定。

應消失：跨視圖的「先通知哪一邊」、重複 reset 清單、Sidebar 控制聊天區選擇的 imperative 中轉。旗標只有在等價行為測試取代後才可刪。

## F2：對話 runtime 的生命週期外露到 Shell

證據：

- [useAgentSession.ts](../../packages/ui/src/hooks/useAgentSession.ts)：2240 行起 mount-only 初始化，effect 最後以 `[]` 結束，並清理串流、計時器等。
- [AppShell.tsx](../../packages/ui/src/components/AppShell.tsx)：873 行起註解明說，還原選擇必須重掛 ChatWindow，否則 mount-only 載入不會執行；2696 行以 `sessionKey` 掛載；2924 行 session reload 也增加同一重掛計數器。
- [ChatWindow.tsx](../../packages/ui/src/components/ChatWindow.tsx)：61 行起 Props、335 行起 hook 解構，含大量 options、回呼及 ref，上層要知道 transport subscription、projection handover、完成通知、system-info loader 等內部概念。

key 重掛本身不是反模式；conversation identity 改變時重置 view 可以合理。問題是跨功能用可變計數器表達 reload、selection、promotion 等不同操作，讓 Shell 承擔 runtime 初始化協定。

建議：一個 conversation／composer runtime 介面，內部處理 stream、read、submit、recover、dispose；identity 決定生命週期。畫面透過 attach/subscription 讀 view；同一對話 reload 是明確操作。可保留 keyed 的內部 runtime 容器，不要求一次把所有 effect 改成隨 id 響應。

應消失：Shell 對 mount-only 實作的了解，以及只為重新初始化 hook 保留的重掛／搬運協定。保留 request-id 恢復、生命週期 fold 及前背景交接語義。

## F3：有分層資料模型，但協調仍困在 React hook

證據：

- useAgentSession 的 401 行同時持有 data、step，稍後另有 older prefix、model／agent-state overrides。
- 729 行 `receive` 已集中 accepted statement 發布，這是好的收斂，並非每個 transport 各自雙寫。
- 815 行組合 prefix + live window；832 行再以 effect 比較上一個 window、更新 prefix。
- 650 行 agent-state 有自己的請求順序與 attachment stamp；858 行 stats 合併 session 檔統計與可見訊息。
- 2343 行 DOM 捲動、2390 行附近 notice 顯示／退出／hover 暫停計時，也在同一 hook。

不能把 data、prefix、stream continuity 一概稱作重複真相而整批刪除。session metadata、older prefix、transport delta base、accepted lifecycle window 各有不同含義。問題是讀者要了解跨 effect 更新順序，hook 同時輸出狀態、setters、操作、DOM refs 和 subscription ref。

建議：accepted conversation readout 集中 window、prefix、metadata 更新與派生。保留完整 session stats、history head 等不可由可見 window 推導的資訊。DOM scroll settlement 留在 transcript 呈現模組，toast 計時留在聊天區本地，不新增全域通知系統。

應消失：同一接受結果的重複 transcript 表示，以及為串接內部步驟公開的 setters／mutable callback refs。不能預先承諾整個 SessionData 可刪。

## F4：資料更新契約被 UI 動作代替

證據：

- AppShell 2920 行關閉任意 Settings 就增加 `modelsRefreshKey`。
- key 穿過 ChatWindow，於 useAgentSession 2358 行起清 model cache。
- [ModelsConfig.tsx](../../packages/ui/src/components/ModelsConfig.tsx)：1767 行 credentialChanged 另直接 invalidateModelCatalog；1926 行 config PUT 後更新本面板與 enabled model resync。
- [models-cache.ts](../../packages/ui/src/lib/models-cache.ts)：50 行起已集中 invalidation，並明確說只影響下一次讀，不主動通知或 reload。

可以確認的是更新語義散落：credential change、config save、modal close 各做一部分。沒有瀏覽器重現，不能宣稱某個可見選單一定 stale。關閉未改設定的面板仍清 cache，是明確耦合訊號。

建議：模型領域的成功寫入決定 scoped readout 是否過期，讀者依明確策略重讀。延伸既有 cache／model 介面，不建立通吃設定的事件總線。保存後是否立即改動正在使用的 picker，先寫清產品行為。

應消失：modelsRefreshKey 的 Shell → ChatWindow → session hook 中轉，及用 modal dismiss 代替資料變更的規則。

## F5：大型設定畫面直接承擔資源工作流

ModelsConfig 的 ProviderDetail（305 行）處理 editable draft、discovery request、capability；外層（1673 行）再處理 providers/config/auth/selection/save。[McpConfig.tsx](../../packages/ui/src/components/McpConfig.tsx) 325 行附近同時持有寫入 controllers、sign-ins、add draft、reload 和 selection；355 行 overview 有自己的 request sequence。

問題不是 REST 和 ExecutionTarget 介面不同，也不是 useApiRequest 與 client.request 寫法不同。它們對應不同資源。provider discovery 的 counter 保護尚未保存的 API key/baseUrl 草稿，不能直接替換成 workspace target fence。

建議：每種領域保持小而明確的工作流介面，例如 provider 設定草稿／保存、MCP overview／操作、OAuth flow。view 保持欄位、焦點與選擇；mutation 與 reload policy 由工作流持有。helpers 只搬出函式、仍要求畫面理解 controller 先後順序，就沒有增加模組深度。

驗收：新增一種 MCP 操作，常規取消、更新 overview、失敗 readback 不必在畫面再抄一遍；「多抽幾個 hooks」不算完成。

## F6：測試揭露缺少行為介面

[AppShell.session-delete.test.ts](../../packages/ui/src/components/AppShell.session-delete.test.ts) 第 10 行起按 source marker 截取 callback，再用 VM、假的 setters、refs 執行。驗證了重要的刪除後切換行為，但重排 callback、改註解就可能令測試失去入口。

這比測試檔案數或 mock 數更能說明問題：重要轉換沒有 React 外可呼叫的介面。選擇模組應承接這些 case，取代 source extraction，不疊另一套測試。

SSE 測試從公開 transport 注入 frames 合理；不能因用了 mock 而刪除。TS 遷移保住案例，不代表 seam 已合理。

## 應保留與排除的誤判

- [workbench-scope.ts](../../packages/ui/src/lib/workbench-scope.ts) 統一組裝 client/files/conversation API；Web cookie、App bearer 是真實不同 adapter。
- [file-seam.ts](../../packages/ui/src/lib/file/file-seam.ts) 已是檔案端點擁有者，不再造 FileResourceReader 包同一組方法。
- [useFileBytes.ts](../../packages/ui/src/hooks/useFileBytes.ts) 45 行起有 abort、lease release 與 connection disposal 配套；未發現裸 fetch 或 blob 未清理的證據。
- [FileViewer.tsx](../../packages/ui/src/components/FileViewer.tsx) 701 行先 metadata 檢查大小；[useDocxPreview.ts](../../packages/ui/src/hooks/useDocxPreview.ts) 讀已解析 URL。bearer 下是本地 blob，不是第二次遠端下載；metadata 預讀有用途。
- [save-host.ts](../../apps/app/src/save-host.ts) 是 Tauri choose/begin/append/finish/abort，與瀏覽器 download 能力不同；保留 FileSaveHost。
- TerminalPanel 291 行，TerminalFanIn 共享串流責任清楚；沒有證據支持 cursor reconnect 故障的說法。
- [SettingsPanel.tsx](../../packages/ui/src/components/SettingsPanel.tsx) hidden 保留已訪問 tab 是保留草稿策略；MCP active flow 背景 poll 不自動等於 leak。
- MessageView、FileViewer 拆檔改善閱讀，不能代替所有權修正。不要為消除大檔新增 plugin registry、generic controller 或全域 store。
- [workbench.tsx](../../packages/ui/src/workbench.tsx) 安裝全域 draft scope（約 190 行）與 [draft-store.ts](../../packages/ui/src/lib/draft-store.ts) 可變 scope（74、100 行）意味草稿隔離依賴目前單 workbench 假設；這是介面限制，沒有證據表明現行單 workbench 流程有資料串用。隨選擇／草稿整理再處理，非先行大改理由。

## 修整順序與完成條件

1. **工作台選擇**：統一 cwd／conversation／fresh composer 轉換。保留同專案 worktree、跨專案、deep link、刪除後離開、reload 還原、草稿 promotion。以行為介面測試取代 source extraction；Sidebar 與新對話列只發意圖。
2. **對話 runtime/readout**：收斂既有 fold、receiver、prefix、metadata，隔離 DOM 與 notice timers。明確 attach、read/reload、submit/recover、dispose。普通 reload 不由 Shell 重掛整棵樹；未知提交只 lookup，不重送。
3. **模型更新契約**：成功 mutation 與現有 scoped cache 決定更新，拿掉 modal-close refreshKey；不要求換查詢框架。
4. **設定工作流**：MCP 或 Models 先一個領域，以新增操作能否局部完成衡量，不同時重寫全部設定。
5. **視圖拆檔**：最後處理 composer interaction、message blocks、viewer leaves、Shell header/layout，保留 FileSeam、平台 adapter、TerminalFanIn。

候選責任方向：host/connection → 選擇與 conversation runtime → 視圖讀取 readout／送意圖。避免 Sidebar ↔ Shell ↔ ChatWindow ↔ hook 用 refs、callbacks、refreshKey 共同協商一次轉換。尚未形成批准的 ADR 或實作規格。

本輪未修改、提交或推送產品程式碼。未估算淨刪行數：替換需保住行為、落實介面，現在報數會把必要狀態與演算法誤算為可刪程式碼。成功指標：協調位置減少、上層不依賴下層初始化順序、測試穿過穩定行為介面。

## 後續規劃記錄

使用者於 2026-10-21 要求先記錄盤點，再建立完整規格與 tickets。後續見 [UI 架構收斂規格](../ui-architecture-refactor/spec.md)、[票單計畫](../ui-architecture-refactor/ticket-plan.md)及[驗收矩陣](../ui-architecture-refactor/acceptance.md)，目前僅完成規劃。本文保留為 `a57100bb` 的靜態證據；已交付架構以[架構指南](../../docs/architecture.md)及[開發指南](../../docs/developer-guide.md)為準。
