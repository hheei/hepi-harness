# 評估與待觀察記錄

Date: 2026-10-21
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Status: recorded — 靜態盤點結果，不是 bug closeout 或已執行驗證。

[原始盤點](../ui-architecture-audit/report.md)保存證據；[規格](spec.md)定義本次設計；[票單](ticket-plan.md)定義可執行切片。本次重構是使用者明確要求規劃的架構改善，不把 code smell 轉寫為已重現生產故障。

| 項目 | Trigger／證據 | 正常使用可能性及影響 | Disposition／重訪條件 |
| --- | --- | --- | --- |
| 多 workbench 共頁與全域 draft scope | workbench render 安裝 draft scope；draft-store 模組變數 | 目前產品是單 workbench；沒有資料串用重現 | record。工作台選擇票讓目前 scope 顯式；不建立多工作台產品能力。實際新增第二 workbench 再定義支援 |
| 模型選單 stale | modal-close refreshKey，credential invalidation 與 config save 路徑不同 | 設定及模型使用常見，但未做 browser 故障重現 | design scope。模型票實作 spec R5 的明確更新契約；不得宣稱既有 bug 已重現 |
| hidden Settings 的 MCP polling | active OAuth flow 遞迴 polling，已訪問 tab 保持 mounted | 流程切 tab 常見，背景完成是目前合理行為 | record。保留 active-flow 語義；有流量或錯誤實證再研究節流，不直接當 leak |
| SessionData 與 Step | metadata、session stats、history tokens、prefix、stream base 各有不同語義 | 誤刪會丟完整統計／歷史／恢復能力 | design constraint。readout 票只刪相同 accepted transcript 的多餘表示，按矩陣驗證 |
| blob 與 docx 額外下載推測 | FileSeam、useFileBytes 有 abort/release；docx 可讀本地 blob | 未發現租約 leak 或重複遠端下載證據 | record。保留介面；真實網路／heap 證據出現再診斷 |
| Terminal cursor／SSE 故障推測 | TerminalFanIn 已集中傳輸，盤點沒有重現 | 終端常用，但無實際故障證據 | record。Shell 票驗證既有行為，不另改終端協定 |
| 大檔即效能問題 | 八個檔案約 19k 行，文字 hook 計數偏高 | 維護成本有證據，runtime latency/heap 未測 | record。沒有性能承諾；有正常場景量測後另開 focused diagnosis |
| 未觀察 run 不補完成音 | 既有 ADR 0007 的明確限制 | 背景／隱藏頁可能發生，已有產品契約 | preserve。通知覆蓋不是本工作範圍，不加每對話常駐串流 |

## Ticket 01 review corrections

agent-230 reviewed clean `73b94db2`（整合 counterpart `96c2348e`）。Standards 無 material findings；Spec 以下 7 項皆判為 `fix`，由 agent-221 在原 owner 修正。票 01 重開，票 03 尚未啟動。

| Finding | 正常使用 trigger／evidence | User impact／修正 owner |
| --- | --- | --- |
| P1 draft disposal | fresh composer 尚有輸入時更換 connection；Chromium unmount 前 storage 有文字，後為空 | 未送出草稿遺失；移除 useAgentSession lifecycle cleanup 的 draft deletion，selection intent 決定清除 |
| P1 stale promotion | A 提交待 admission 時已選擇並輸入 B；late promotion 仍替換 B | 目前 composer 被錯換且草稿可能隨 unmount 清除；promotion intent 驗證 source composer identity |
| P2 pending open after workspace pick | open B 尚待回覆時明確選擇 A 的 worktree；state repro 顯示 late B 落地 | 使用者的 workspace 選擇被蓋掉；workspace intent retire pending generation，保持 attachment |
| P2 remembered conversation | 明確跨 project 返回已記住 conversation 的 B；state repro 顯示仍落 composer | workspace 恢復功能失效；destination restore 在 selection owner 使用 generation fence；裸路由契約不變 |
| P2 file tabs | Sidebar 直接發跨 project 的 conversation／workspace／New intent，舊 handleSelectWorkspace 已無 caller | 舊 project 檔案頁籤殘留在新 cwd；Shell 依 accepted project transition 清 presentation state，排除 identity hydration |
| P2 same-conversation selection | 重按目前 conversation，state repro attachment 由 1 變 2 | ChatWindow 重掛且閱讀位置／本地 UI 重置；相同 identity 保留 attachment，explicit entry/block targets 仍處理 |
| P2 raw-history activation | reference 發 Open raw history，focus 已設定但 activeTopPanel 非 history | 常用跳轉沒有顯示面板；raw navigation 落地時啟用 history panel |

Reviewer 的 focused state/browser reproductions exit 0；原始 logs 複製至 `.dev/verify/ui-architecture-refactor/ticket01-selection-review.log`、`ticket01-draft-disposal-review.log`。file-tab／raw panel 另有 caller/gate source evidence；修正須補公共 seam／ordinary browser regression checks。不是旁路或安全邊界測試。

## 實作中新發現的記錄格式

Ticket 09 closeout：agent-234 確認唯一 P2 deferred-prompt clipboard finding 已由 `ec128568`（整合 `216d669c`）修正，獨立 Chromium 複審無 material regression。`UserMessageView.test.ts` 使用實際 hook body 與模擬 React state，沒有 snippet extraction／source-shape assertion；其 coverage 與 production browser 大幅重複，user impact negligible，disposition `record`。下次維護這組 tests 時再精簡，不新增 blocking dependency 或另做實作。

Ticket 01 closeout：agent-230 第一次複審確認原 findings 1／2／3／5／6 fixed；最後 correction `20120fdc`（整合 `bdd7c7ac`）修正剩餘 workspace restore／raw panel 及引入的 parked-draft regression。最後窄幅複審確認三項皆 fixed、correction scope 無 material regression。驗證與 tested revisions 見 [execution](execution.md) 及 [ticket 01](issues/01-workbench-selection.md)。所有 material findings 已完成 fix，不再阻擋後續整合。

僅在有具體 finding 時追加：trigger、source／repro evidence、正常使用可能性、user impact、fix/record/investigate、負責票及重訪條件。`record` 是完整處置，不形成阻擋依賴或自動擴大實作範圍。

## Ticket 12 系統驗收審核 — 2026-10-22

Independent reviewer `agent-292` 在 `fa7b37dc` 對本票交付分別執行 Standards 與 Spec 審核，兩者皆無 material findings。審核為行為定義，不以 driver 名稱取代結果：

| 項目 | 審核結論 |
| --- | --- |
| 導航 target memoization（`ce5cb804`） | 修正屬於適當 owner（`AppShell` 以選擇 `navigation` 記錄 memoize），回應 `ChatWindow` 的 identity 去重，非 caller 防護 |
| 引用 prompt journey | 一個 fork、一則訊息，離開→回來不重播 |
| native journey | 真實確認、重開後未設定、本次 run 憑據 store 為空 |
| fixture trust answer | `GET /api/project-trust` 答案屬 driver 補齊，非產品缺口 |
| 統計 | 44 個唯一 driver、49 次執行，與 raw log 索引一致 |

審核範圍為交付的行為與所有權；未執行的能力（真實上游 OAuth、live compaction、release、Android）繼續作為限制記錄，不作為已驗收項目。

## 規劃文件審閱與檢查 — 2026-10-21

獨立 reviewer `agent-220` 讀取本 effort 全部文件、原始盤點及倉庫 review/verification policy，分別檢查 Standards 與 Spec：兩者皆無 material findings。範圍限規劃的一致性、替換切片、依賴及驗收歸屬，不構成產品程式碼審閱或實作驗收。

文件結構核對：12 張票、30 個不重複 scenario IDs、109 個 effort 內文件相對連結皆存在；Blocked by 全部指向較早且存在的票，無依賴循環。結構記錄在 `.dev/verify/ui-architecture-plan/structure.json`。

`pnpm check:docs --json=.dev/verify/ui-architecture-plan/docs.json` 在 `a57100bb4917d408ee51c19beeda30d3efecc857` 加本次未提交規劃文件的工作樹執行，exit 0；raw log：`.dev/verify/ui-architecture-plan/docs.log`，JSON：`.dev/verify/ui-architecture-plan/docs.json`。`git diff --check` 同一工作樹 exit 0，raw log：`.dev/verify/ui-architecture-plan/diff-check.log`。工作樹另有先前的 durable-ledger scratch，未納入本次編寫／審閱範圍。

未執行產品測試、build 或 browser/native journey：本次僅建立規格及 tickets，矩陣仍是未執行需求。以上本地 `.dev` 檔案是當前工作區證據，不保證在新 checkout 中存在。


## Ticket 03 integration review

Agent-248 reviewed integrated Ticket 03 against R3 and acceptance C1/C3-C5/N8/N10 without running tests. Four material findings in ordinary connection/settings workflows; ticket reopened and corrections required at owner boundaries.

| Finding | Trigger and user impact | Required correction |
| --- | --- | --- |
| CompletionDelivery registry remains initialized once in AppShell while WorkbenchConnection can change without remounting AppShell. | Switch connection in the same shell; new ChatWindow joins old-client registry, losing new connection completion/background watches. | Key or recreate registry by connection identity; dispose old registry interest and subscribe through new client. |
| ConversationSession changes with API identity, but mount read effect is empty-dependency and loadSession validates only conversation id on null/error paths. | Same conversation ID across connection switch while old read is in flight; old answer can clear/rewind new transcript or publish old failure. | Add connection-generation/owner fence to all read success, null and error publication, including post-read agent state. |
| Settings General reload calls `api.reload(sessionId)` before registered onSessionReloaded, which calls conversation.reload again. | Ordinary setting mutation reloads resources; duplicate route mutation violates one-operation behavior and may duplicate work. | Put reload ownership in one caller; callback performs follow-up read/report only, or Settings delegates full operation to chat. |
| reloadConversation ignores `loadSession` result then unconditionally emits success. | Backend reload succeeds but follow-up read fails; UI reports success despite unreadable/unknown updated state. | Gate success notice on accepted read; surface read failure without claiming success. |

C3 and N8 pass by source/test review. C1 and C5 fail pending fixes; C4 partial due registry lifetime. N10 has no material regression found but was not independently verified. Browser fixture mounts ChatWindow with custom registry, not production AppShell/SettingsPanel; add ordinary public-shell interaction coverage for connection switch and exactly-once reload if seam permits. No bypass probes or test execution by reviewer.
