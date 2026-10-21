# 工作台選擇與草稿

Type: implementation
Status: in-progress — correcting material review findings
Blocked by: none
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R1、替換策略
Acceptance: [行為矩陣](../acceptance.md) — N1–N10、R11 的選擇／draft 部分

## 目標與責任路徑

`AppShell.tsx` 選擇／restore／open／delete handlers；`SessionSidebar.tsx`、`NewSessionContextBar.tsx`；`initial-navigation.ts`、`tab-session.ts`、`workspace-memory.ts`、`draft-store.ts` 及直接呼叫者。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "initial-navigation.ts" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 以現有操作建立工作台選擇 readout 與意圖介面，集中 restore/open 的有效性判定及已接受選擇的持久化。先把 N1–N10 對應現有案例，缺少的高風險行為才補測。
2. 讓 Sidebar、Shell、新對話列、快捷鍵及 deep link 都走這個擁有者；Sidebar 保留搜尋／展開等 local state。
3. 把 parked/carry/New/promotion 的草稿規則及顯式 connection scope 接入；保留現有儲存內容與 key 格式，render 不再改可變全域 scope。
4. 同票遷移選擇相關 source-extraction 測試至新介面；刪掉已替代的 handlers／通知抑制協定。後續仍需用到的 sessionKey 只作生命週期接線，留明確承接到對話 I/O 票。

## 驗收條件

- [x] Sidebar 與 Shell 讀同一 canonical selection，選擇不靠 props → local cwd → effect 回報的循環。
- [x] 資料型 composer move 不經 Sidebar controlRef 中轉；focus/picker imperative 使用者仍有正確焦點。
- [x] identity hydration、同 project worktree、跨 project、stale restore/open、draft carry/park/promotion 具矩陣證據。
- [x] VM 截取 callback 的選擇／刪除測試已替換；scope 的改動不清除既有使用者草稿。

## 驗證與證據

選擇模組 colocated tests、initial navigation／draft 既有案例；focused browser 走 New、worktree、reload、刪除與導航重試。接線改到 App 時檢查其 Configure/host tests。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：重複 canonical selectedCwd 與 domain selection handlers、只為抑制回報而設的 flags、資料選擇的 Sidebar imperative 中轉、source extraction 測試入口。

更新 owning guides：開發指南、工作台、聊天的草稿／restore 說明。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

Status: resolved（2026-10-21，revision `7cc775e4` + 本票工作樹變更）

### 變更

- `lib/workbench-selection.ts`（新）：`createWorkbenchSelection` 為唯一選擇擁有者——conversation／composer／workspace identity、first-frame 優先序（URL > tab 記憶）、tab 與 workspace 記憶寫回、open 的 generation fence 與失敗分類、draft carry／park／promotion／delete 規則，以及 React 綁定（`WorkbenchSelectionProvider`、`useSelectionState`、`useSelectionStateOf`、`useWorkbenchSelection`、`useWorkbenchSelectionStore`）。
- `lib/draft-store.ts`：改為 `createDraftStore(scope, storage)` 實例，每個連線一個（`workbenchConnection.drafts`），刪除模組全域可變 scope 與 `setDraftScope`／`composerScopeInstalled`；key 格式與儲存 entry 前綴不變。
- `lib/workbench-scope.ts`：`WorkbenchConnection` 持有 `drafts`。
- `components/AppShell.tsx`：刪除本機 selection／restore／tab-session／workspace-context 狀態與 effects、`effectiveNewSessionCwd`、`parkedNewSessionDraftKey` 等重複計算；改由 store 讀寫。已刪 `onCwdChange`／`selectedSessionId`／`onSelectSession` 等 prop。
- `components/SessionSidebar.tsx`：刪除 local `selectedCwd`、prop 同步 effect、`onCwdChange` 回報 loop、`createTempSessionId` 與 `startNewSessionIn` 資料中轉；改讀 selection、發 intent，`SessionSidebarControl` 只留 UI imperative。
- `components/ChatInput.tsx`：改讀 `useComposerDrafts()`。
- `hooks/useAgentSession.ts`：draft 三個呼叫改走 `connection.drafts`（readout 不動）。
- `lib/conversation-catalogue.ts`：接收 `mergeCatalogueRow`（原 `components/session-catalog-helpers.ts`，已刪）。
- `workbench.tsx`：刪 render-time `setDraftScope`。
- 文件：`docs/chat.md`「The workbench's one selection」與 draft store 實例化；`docs/developer-guide.md` 責任路徑。

### 證據

- `packages/ui/src/lib/workbench-selection.test.ts`（新，12 案）：N1 URL 優先序與 `?cwd=`、N2 reload 回到同一 composer 且不取資料夾 park、N3 stale open 不落地、N4 identity hydration 不重掛、N5 同 project worktree 保留對話、N6 跨 project 換 workspace、N7 New／carry／park 與跨資料夾 park 不誤取、N8 promotion 不動草稿、N9 刪除僅在開啟者時離開且不清草稿、N10 失敗分類與 retry。
- `apps/web/e2e/history/ux-workbench-selection.ts`（新，Chromium + 真 `createClient`）：`?session=` 深連結、真 reload 取回草稿、新分頁不 invent restore、`?cwd=` 不讀對話、New 自成一 identity、刪除後落在 composer 且被刪對話草稿仍在 scope entry。
- `draft-store.test.ts`、`ChatInput.test.ts` 遷移至實例 API。
- 已刪：`components/AppShell.session-delete.test.ts`（VM source extraction）、`components/session-catalog-helpers.ts`。

### Checks

- `pnpm verify:changed`：changed-typecheck / changed-test / web-unit / check-docs 全 pass，exit 0；log `.dev/verify/2026-10-21T09-51-19-122-verify-changed`（dirty `7cc775e4`）。
- Focused browser（`7d6bd29c`，exit 0，log `.dev/verify/2026-10-21T17-58-48-browser-selection`）：`ux-workbench-selection.ts`、`ux-workbench-scope.ts`、`ux-sidebar-ingress.ts`、`ux-raw-history-sidebar-focus.ts` 全 PASS。
- 負向驗證：移除 `WorkbenchSelectionProvider` 時 `ux-raw-history-sidebar-focus.ts` 逾時失敗，證明 browser scene 真的守住 context 接線。

### 已解 findings

- AppShell 建 store 但未包 provider → mount 時 `useSelectionState` 拋錯（已包 `WorkbenchSelectionProvider`，AppShell 自身改用 `useSelectionStateOf`）。
- `useWorkbenchSelectionStore` 的 deps 捕獲第一輪 closure（navigate/onLanded/query 失效）→ 改 read-through Proxy。
- 同 project 的 workspace identity hydration 誤判為換 workspace → `adoptWorkspaceIdentity` 同步更新對話 `projectKey`。
- 同資料夾 New 誤把 park 併回新 composer → 僅在真的換資料夾時 rekey park。
- browser driver 曾假設 request 帶 method 前綴，兩個 no-read 斷言因此恆真 → 已修正並由實際輸出驗證。
- `ux-workbench-selection.ts` 印出 PASS 卻不結束（fixture server 未關）→ 每次跑都被 timeout 殺掉、exit code 是 timeout 的 → 收在 `finally` 關 server 並 `process.exit`，現 exit 0 / 5.4s。

### 審查回歸修正（reopen，`73b94db2` 之上）

七項 material regression 全在擁有者邊界修正，未加 caller guard：

| 發現 | 擁有者 | 修正 |
| --- | --- | --- |
| P1 換 connection／unmount 清掉 fresh composer 草稿 | `useAgentSession` 生命週期 cleanup | 移除 abandoned-key `clearDraft` microtask；處置屬 selection intent（park／promotion／delete），不刪文字 |
| P1 遲到的 promotion 覆蓋 B | `acceptPromotion` 契約 | 傳入 source composer identity（hook 本來就發 `sourceDraftKey`），只接受與當前 composer 相符者 |
| P2 same-project worktree 選擇不撤 pending open | `selectWorkspace` | 每次明確選擇都 retire in-flight reads（generation），不動 attachment；identity hydration 不 retire |
| P2 跨 project 一律 composer、`rememberedConversation` 無 caller | `selectWorkspace` | 先放 composer（與 HEAD 同序），再由 workspace memory／catalogue 還原對話，同一 generation fence；裸路由不變 |
| P2 file tabs 只在死掉的 `handleSelectWorkspace` 清 | 已接受的 project transition | 新增 `projectTransition`（僅 `adoptConversation`／`adoptComposer` 換 project 時 +1），AppShell 由它清 file tabs；identity hydration 排除；刪除無 caller 的 handler |
| P2 重選同一對話 attachment +1 重掛 | `adoptConversation` | 同 id 保留 attachment、cwd、URL，仍套用 entry／block／raw target |
| P2 raw reference 只設焦點不開面板 | shell presentation | `rawHistoryFocus` 變為非 null 時開 `history` 面板（同 HEAD） |

新增證據：`workbench-selection.test.ts` 5 案（遲到 promotion、明確選擇撤 pending open、返回 workspace 還原記憶對話、project transition 判定、重選保留 attachment）；`useAgentSession.lifecycle.test.ts` 1 案（unmount 不刪 fresh composer 草稿，已用移除修正反向確認會失敗）；browser scene 兩步（換 connection 後前一個 connection 的未送文字仍在；search hit 失敗 → 「Open the raw history instead」→ 面板開啟且定位到該 entry，已用移除面板修正反向確認會失敗）。

Checks（修正後 revision `28ade187`，工作樹乾淨）：`pnpm verify:changed --base=HEAD~1` exit 0（`.dev/verify/2026-10-21T10-31-24-502-verify-changed`）；browser `ux-workbench-selection`、`ux-workbench-scope`、`ux-sidebar-ingress`、`ux-raw-history-sidebar-focus`、`ux-navigation-retry` 全 exit 0（`.dev/verify/2026-10-21T18-31-36-browser-regressions-final`）。

### 追查修正（follow-up，`1179fdcb` 之上 → `20120fdc`）

三項，皆在擁有者邊界修正，前五項已確認的修正未動：

| 發現 | 擁有者 | 修正 |
| --- | --- | --- |
| P1 composer → 記著 B 的 workspace：先 `adoptComposer` 把 B 的 park 搬進 transient key，隨後 `adoptConversation` 丟棄它，New@B 拿不到文字 | `selectWorkspace` | 目的地先決定、之後才採用：有記著且 catalogue 仍列出的對話就用它，否則該資料夾 composer（帶其 park）。兩條 outgoing 分支（對話／composer）共用此決定 |
| P2 對話 → 另一 project 的 workspace 提前 return，跳過已交付 catalogue 的還原 | `selectWorkspace` | 移除該提前 return；`parkComposerDraft()` 只把離開中的 composer 文字 park 在它自己的資料夾 |
| P2 跨 project reference 開 raw：project-transition effect 把同一個選擇剛要求的面板關掉 | AppShell presentation | 兩個決定讀同一 committed selection，合併為一個 effect：清理前一個 project 的 file tabs 同時呈現該次選擇要求的 position；standing position 仍不會重開已被關閉的面板 |
| （紮根）尚未交付的 catalogue 被當成「對話已消失」 | `rememberedRow` | `catalogueDelivered` 區分「列出但沒有這列」與「尚未列出」；後者保留記憶，不無限重試也不誤刪 |
| （紮根）`conversation.list` 讓 store 自行再列一次，與 sidebar 竞赛 | `WorkbenchSelectionDeps` | 移除該 dep，restore 只讀 `setCatalogue` 交付的列 |

新增證據：`workbench-selection.test.ts` +3 案（目的地保留自身 park 且 New@B 取回文字與圖片、跨 project 自對話回來仍還原記憶對話、choice 撤銷進行中的 first-frame validation）；`ux-workbench-selection.ts` scene 10（跨 project reference → `data-raw-history="two"` 保持可見並定位到 entry，URL 為 `?session=two`）。反向確認：把 panel 決定拆回獨立 effect（`setActiveTopPanel(null)`）時該 scene 以 `[data-raw-history]` 逾時失敗；把 selection 改回舊順序時兩條 unit 案失敗。

Checks（revision `20120fdc`，工作樹乾淨）：`pnpm verify:changed --base=HEAD~1` exit 0（`.dev/verify/2026-10-21T11-03-52-404-verify-changed`；@hepi/ui 387 單測 pass）；browser `ux-workbench-selection`、`ux-workbench-scope`、`ux-sidebar-ingress`、`ux-raw-history-sidebar-focus`、`ux-navigation-retry` 全 exit 0（`.dev/verify/2026-10-21T19-03-01-browser-followup`）。

### 剩餘限制

- 只換 readout 的 owner；`useAgentSession` 的 conversation I/O 生命週期仍屬票 03。
- workspace-wide 記憶（`pi-web:last-open-by-workspace`）在明確工作區切換時還原對話（含跨 project），裸路由不 invent restore（與 HEAD 一致）。
- `docs/migration-status` 未新增能力限制：本票沒有移除任何能力。
