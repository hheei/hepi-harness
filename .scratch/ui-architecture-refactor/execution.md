# UI 架構收斂執行記錄

Status: in-progress
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Integration branch: impl/ui-architecture-refactor
Authorization: 使用者已同意規格，要求使用 workers 實作。部署、重啟不屬範圍。

[規格](spec.md)、[票單計畫](ticket-plan.md)、[驗收要求](acceptance.md)定義目標。本文記錄真實派工與整合；規劃檢查不當作產品驗收。

## Checkpoints

- `7cc775e`：保存盤點、批准規格與 12 張票，將 spec 標記 in-progress。只提交本 effort 與索引；既有 durable-ledger scratch 保留。
- 第一波 workers 從同一 checkpoint 使用各自 worktree；只提交自己範圍，由 coordinator 整合。

## 第一波

| 工作 | Worker | Worktree（主工作區下） | 狀態 |
| --- | --- | --- | --- |
| 工作台選擇與草稿 | agent-221 | `.dev/worktrees/ui-selection` | resolved／integrated；全部 material findings 已修正並複審 |
| 對話 I/O 與 view attachment | agent-233 | `.dev/worktrees/ui-lifetime` | in-progress；基於已確認核心契約，最終整合仍待 01 |
| 訊息 block 呈現 | agent-232 | `.dev/worktrees/ui-message-views` | in-progress；agent-234 發現 clipboard 回歸，worker 修正中 |
| Accepted conversation readout | agent-222 | `.dev/worktrees/ui-readout` | resolved／integrated；review finding 已修正 |
| MCP 工作流 | agent-223 | `.dev/worktrees/ui-mcp` | resolved／integrated；agent-228 無 material findings |
| 檔案 preview 呈現模組 | agent-224 | `.dev/worktrees/ui-previews` | resolved／integrated；獨立 review 無 actionable findings，native save 留票 12 |

agent-225 只讀準備對話 I/O 的接線與 native 驗收前提，不修改依賴尚未完成的票。

## 整合與驗證

每票回報後在其 ticket 記錄 commands、tested revision/dirty state、exit code、raw logs 及未測 scenarios；整合後按實際 source 及交互影響選擇檢查，未改動的 source 複用既有證據。原生／上游 OAuth／真實 compaction 證據不得由 browser fixture 代替。

### Ticket 10 整合

- Worker implementation `0b2c2e28` 與 evidence record `ba1e9076` 已 cherry-pick 為 `22421d7a`、`54a81bf8`。FileViewer 改為格式選擇；格式 leaves 保留既有 FileSeam、lease／abort、docx 預檢及 save adapter。
- `pnpm verify:changed --base=7cc775e4` 在 worker 的 clean `0b2c2e28` exit 0；原始紀錄保留於 worktree，另複製到主工作區 `.dev/verify/2026-10-21T05-44-30-551-verify-changed/`。主工作區 `git diff 0b2c2e28 HEAD -- packages/ui apps/web apps/app packages/session packages/protocol` 為空，故複用相同 source 的驗證，不把它改稱 root 新跑的結果。
- 在 evidence revision `ba1e9076`（clean tree）補跑並保存五項 browser-driver logs（15、25、25、17、16 checks），連同 repo/UI typecheck 與 367 UI tests，位於 `.dev/verify/2026-10-21T13-55-manual-ticket10/`。產品 source 與整合版一致。實際 Tauri save 尚未跑，交票 12。
- agent-226 已在 worker worktree 對 `7cc775e4..ba1e9076` 完成只讀獨立 review：Standards、Spec 皆無 actionable findings。確認 request fencing、docx metadata 預檢、lease byte reads 與共用 save control 保留。Review 未重跑 suites，複用票 10 的既有驗證；不是全系統驗收或原生 save 證據。

### Tickets 02、07 整合

- 02：`b20ae3d8`、`cd09f3a8` 與 evidence-only `97ba0f92` 已整合為 `5d4bc355`、`9cee62b0`、`1eb7145d`。worker clean `b20ae3d8` 的 changed checks exit 0，log `.dev/verify/ui-readout-final/`；browser evidence revision `cd09f3a8`（clean），log `.dev/verify/ui-readout-browser/`。原始 worker 證據已複製至主工作區，不改其 revision。
- agent-227 review：Standards 無 material findings；Spec 發現同 head 的 live frame 會以 window.hasMore 覆蓋已耗盡的 page claim，讓 oldest-history sentinel 再次請求。正常 scroll-back 同時 streaming 可觸發，判為 fix；交 agent-222 在 readout owner 修正並補案例。ticket 02 暫不關閉，ticket 03 仍等待 01、02。
- agent-229 follow-up review 確認 `acceptSession` 修正位於正確 owner，沒有平行 pagination state；readout 與 hook regression cases 覆蓋 exhausted page → live advances → head reset。新 conversation／whole-range reset 只以 source inspection 確認，列為低風險測試缺口，無 material finding。ticket 02 resolved；ticket 03 仍等待 01。
- 07：`4526a4af`、`71f2597e` 已整合為 `31a363d4`、`e8c9f2b8`。worker clean `4526a4af` 的 changed checks exit 0，log `.dev/verify/2026-10-21T05-58-28-923-verify-changed/`；focused workflow evidence `.dev/verify/mcp07/`。agent-228 review 的 Standards／Spec 均無 material findings，未重跑 suites。真實 upstream OAuth 與 native MCP journey 未執行。
- 整合 02、07、10 後執行 `node scripts/verify.mjs --profile=changed --base=7cc775e4 --log-dir=.dev/verify/ui-wave1-partial`：revision `e8c9f2b8`，dirty 僅既有 `.scratch/durable-ledger-simplification/`；exit 0，changed-typecheck／changed-test（UI 383、App 26）／web-unit（14）／check-docs 全 pass。此為該 revision 結果，不取代上述 pagination finding 的修正驗證。

### Ticket 01 與首波整合

- 01 implementation `7d6bd29c`、driver cleanup `73b94db2` 已整合為 `f1f6b02b`、`96c2348e`。hook import conflict 僅合併已移除的全域 draft operations 與已移除的 decidePrefix import；保留 readout owner 及 connection.drafts 三個呼叫。agent-230 正作獨立 review。
- Worker clean `73b94db2` 的 changed checks exit 0，原始 report 複製至主工作區 `.dev/verify/2026-10-21T09-59-18-076-verify-changed/`；browser logs `.dev/verify/2026-10-21T17-58-48-browser-selection/`。
- 首波 01／02（含 pagination fix）／07／10 的整合 revision `96c2348e`，dirty 僅既有 durable-ledger scratch：`node scripts/verify.mjs --profile=changed --base=7cc775e4 --log-dir=.dev/verify/ui-wave1-integrated` exit 0；changed-typecheck、changed-test（UI 395／App 26）、web-unit（14）、check-docs 全 pass。
- 同 revision 補跑 `node apps/web/e2e/history/ux-workbench-selection.ts`、`pnpm --filter @hepi/web test:mcp-workflow`、`pnpm --filter @hepi/web test:navigation-retry` 皆 exit 0。commands／revision／dirty state／raw logs 對照：`.dev/verify/ui-wave1-integrated/browser-metadata.json`。
- Coordinator 執行 `graphify update .` exit 0；15,434 nodes／31,097 edges／679 communities，raw log `.dev/verify/ui-architecture-refactor/wave1-graph.log`。只更新 code graph，不將 docs semantic graph 當作已刷新。
- 票 03 worktree `.dev/worktrees/ui-lifetime` 已從 `96c2348e` 準備，分支 `impl/ui-conversation-lifetime`，offline frozen install exit 0；待 01 review 完成再啟動實作。
- agent-230 review：Standards 無 material findings；Spec 7 項 material regressions。完整 disposition 見 [review notes](review-notes.md#ticket-01-review-corrections)。01 已重新開啟並交回 agent-221；03 暫緩。以上 checks 通過不表示已涵蓋這些行為，仍綁定原 tested revision。review reproductions 原始 logs 已保存至 `.dev/verify/ui-architecture-refactor/ticket01-selection-review.log`、`ticket01-draft-disposal-review.log`。
- 修正鏈 `28ade187`／`229bb29c`／`1179fdcb` 已整合為 `23bb765e`／`16dbd4f4`／`6d4a0342`。包含 lifecycle 不刪草稿、source-identity promotion、workspace choice retirement、catalogue-only remembered restore、accepted-project presentation cleanup、same-conversation attachment 保持與 raw-panel dismissal 保持；agent-230 正針對原 7 findings 複審，不擴大理論範圍。
- 整合 revision `6d4a0342`，dirty 僅既有 durable-ledger scratch：changed checks 全 pass（UI 403／App 26／web-unit 14），report `.dev/verify/ui-selection-corrected-integrated/verify.json`；selection 與 navigation-retry browser commands exit 0，raw logs `.dev/verify/ui-architecture-refactor/corrected-selection.log`、`corrected-navigation.log`。Worker 原始 logs 已複製 `.dev/verify/2026-10-21T10-39-48-555-verify-changed/`、`.dev/verify/2026-10-21T18-39-16-browser-regressions/`。
- Coordinator graph update exit 0，log `.dev/verify/ui-architecture-refactor/selection-corrected-graph.log`；03 worktree 已 fast-forward 至 `6d4a0342`，複審關閉 findings 後可啟動，不等待 01 文件收尾。

### Native 驗收準備

### 並行調整

09 review agent-234：Standards 無 material findings；Spec 一項 P2 fix：UserMessageView.useWholePrompt 的 no-unread fast path 忽略 resolvedTexts，展開 deferred prompt 後複製或第二次複製得到 preview。Chromium clean `f180f716` 重現 firstCopy full／secondCopy preview／expandedCopy preview，正常複製操作會靜默截斷輸出，判為 material。worker 在 owner 修正，補兩個精確操作 regression。Evidence `.dev/verify/ui-architecture-refactor/ticket09-copy-review.json`。Reviewer 另確認 streaming thinking/tool identity、展開與焦點保持，mount zero reads，無 runtime cycles；不新增理論 findings。01 保持 resolved，03 繼續實作。

09 source `8919714a`／evidence `f180f716` 已整合為 `6abeac0a`／`b06e3d8f`，保留 MessageView public props 與 memo，內部異質角色／blocks 分配至實際 owners。agent-234 正審查 Standards／Spec，重點為 dynamic streaming identity、展開／focus 與 lazy resource reads。worker clean `8919714a` 的原始 report 已複製 `.dev/verify/2026-10-21T11-19-18-855-verify-changed/`；25 scenario static HTML 等價性為 worker 臨時 driver 結果，driver 未保留，不當作持久 regression suite。

整合 revision `b06e3d8f`（dirty 僅既有 durable-ledger scratch）changed checks exit 0：UI 410／App 26／web-unit 14，typecheck/docs 全 pass，report `.dev/verify/ui-message-integrated/verify.json`。token-footer／history-window browser commands exit 0，raw logs `.dev/verify/ui-architecture-refactor/message-token-footer.log`、`message-history-window.log`。Coordinator graph update exit 0，log `.dev/verify/ui-architecture-refactor/message-graph.log`。完整 Backend history navigation 與系統 streaming acceptance 仍屬 04／12，未宣稱已執行。

agent-230 最終窄幅複審確認剩餘 A／B／C 全部 fixed，correction scope 無 material regression。parked text/images 由 selection test、conversation → remembered workspace 由 public selection test、cross-project raw panel 與 dismissal 由 browser scene 10 覆蓋；file-tab clearing 經 owner effect inspection。複用 clean `20120fdc` 的 verify report 與 browser logs，不重跑無變更 source。ticket 01 resolved；03 的完整整合依賴解除，03／09 持續實作。

01 最後 3 項 correction 的 code `20120fdc`／docs `684906cb` 已整合為 `bdd7c7ac`／`0bd46ac2`。selection 先決定已交付 catalogue 中的目的地，再 adopt conversation/composer；park 僅處理 departing composer，目的地 parked text/images 不經 transient composer 消耗。Shell 將 project cleanup 與新 raw request presentation 合併在相同 accepted transition，保持 dismissal。worker 原始 checks/browser logs 已複製 `.dev/verify/2026-10-21T11-03-52-404-verify-changed/`、`.dev/verify/2026-10-21T19-03-01-browser-followup/`；agent-230 僅複查原剩餘 3 項。

整合 revision `0bd46ac2`（dirty 僅既有 durable-ledger scratch）changed checks 與 selection browser 皆 exit 0；report `.dev/verify/ui-selection-final-integrated/verify.json`，browser raw log `.dev/verify/ui-architecture-refactor/selection-final-selection.log`。Coordinator graph update exit 0，log `.dev/verify/ui-architecture-refactor/selection-final-graph.log`。03 worker 已知新的 Shell project presentation section，繼續獨立實作；未宣稱 03／09 已完成。

agent-230 對 clean `1179fdcb` 的複審確認原 findings 1／2／3／5／6 fixed；4（conversation → workspace 跳過 remembered row）、7（cross-project raw panel 被 project cleanup 清除）尚未完整修正，另新增 P1：先 adopt transient composer 消耗 destination parked draft，再 restore remembered conversation，造成草稿 key 無法到達。三項皆為正常選擇／跳轉流程，判定 fix，交 agent-221 在 selection／presentation owner 修正並補精確 regression。Repro logs `.dev/verify/ui-architecture-refactor/ticket01-followup-state.log`、`ticket01-followup-raw.log`。

03 的啟動依賴改為已完成的 02 及已確認的 01 核心契約：draft retention／source-identity promotion／attachment；由 agent-233 在 base `3d3d1206` 實作。01 保有 selection owner 與 Shell project cleanup／raw-panel sections，03 保有 hook／ChatWindow／Shell attachment+reload sections；09 保有 MessageView，最終整合仍等待 01，沒有宣稱整體行為已通過驗收。

使用者提出串行等待問題後，確認 09 的現有 MessageView props 可保持不變，無需先完成 03／04。09 的啟動依賴已移除；04 與 12 仍驗證 transcript／streaming／展開位置整合。worker agent-232 在 `.dev/worktrees/ui-message-views`（`impl/ui-message-views`，base `8182fafc`）獨立實作，僅擁有 MessageView／message leaves／直接 tests／09 ticket／developer guide；不修改 01、03 的 Shell、selection、draft、runtime。06／08 的 scout 建議仍須確認 target／cache 接線邊界，尚未派工或宣稱完成。


在 `daa355e` 的工作站環境，`command -v cargo rustc Xvfb xdpyinfo xdotool xwd ffmpeg dbus-daemon gnome-keyring-daemon gdbus` 及 `ls -l .dev/cargo-target/debug/hepi-app` 均 exit 0；raw log：`.dev/verify/ui-architecture-refactor/environment.log`。共用 debug binary 存在，但未將它當作本次 source 的建置證據。最終整合後需依既有 artifact build script 重新嵌入 App UI 並標記修訂，再跑普通 native journey。

對話 I/O 接線採安全方向：可保留 identity-keyed 的內部容器隔離跨 conversation state；同 identity reload 改走明確 read/reacquire。只移除 key 並加 effect dependencies，卻不處理數十個 state/ref 的重新初始化，不能算完成。
