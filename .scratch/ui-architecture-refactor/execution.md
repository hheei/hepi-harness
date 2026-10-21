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
| 工作台選擇與草稿 | agent-221 | `.dev/worktrees/ui-selection` | in-progress；agent-230 發現 7 項 material regressions，worker 修正中 |
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

### Native 驗收準備


在 `daa355e` 的工作站環境，`command -v cargo rustc Xvfb xdpyinfo xdotool xwd ffmpeg dbus-daemon gnome-keyring-daemon gdbus` 及 `ls -l .dev/cargo-target/debug/hepi-app` 均 exit 0；raw log：`.dev/verify/ui-architecture-refactor/environment.log`。共用 debug binary 存在，但未將它當作本次 source 的建置證據。最終整合後需依既有 artifact build script 重新嵌入 App UI 並標記修訂，再跑普通 native journey。

對話 I/O 接線採安全方向：可保留 identity-keyed 的內部容器隔離跨 conversation state；同 identity reload 改走明確 read/reacquire。只移除 key 並加 effect dependencies，卻不處理數十個 state/ref 的重新初始化，不能算完成。
