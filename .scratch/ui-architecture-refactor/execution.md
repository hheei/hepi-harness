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
| 工作台選擇與草稿 | agent-221 | `.dev/worktrees/ui-selection` | in-progress |
| Accepted conversation readout | agent-222 | `.dev/worktrees/ui-readout` | in-progress |
| MCP 工作流 | agent-223 | `.dev/worktrees/ui-mcp` | in-progress |
| 檔案 preview 呈現模組 | agent-224 | `.dev/worktrees/ui-previews` | resolved／integrated；獨立 review 無 actionable findings，native save 留票 12 |

agent-225 只讀準備對話 I/O 的接線與 native 驗收前提，不修改依賴尚未完成的票。

## 整合與驗證

每票回報後在其 ticket 記錄 commands、tested revision/dirty state、exit code、raw logs 及未測 scenarios；整合後按實際 source 及交互影響選擇檢查，未改動的 source 複用既有證據。原生／上游 OAuth／真實 compaction 證據不得由 browser fixture 代替。

### Ticket 10 整合

- Worker implementation `0b2c2e28` 與 evidence record `ba1e9076` 已 cherry-pick 為 `22421d7a`、`54a81bf8`。FileViewer 改為格式選擇；格式 leaves 保留既有 FileSeam、lease／abort、docx 預檢及 save adapter。
- `pnpm verify:changed --base=7cc775e4` 在 worker 的 clean `0b2c2e28` exit 0；原始紀錄保留於 worktree，另複製到主工作區 `.dev/verify/2026-10-21T05-44-30-551-verify-changed/`。主工作區 `git diff 0b2c2e28 HEAD -- packages/ui apps/web apps/app packages/session packages/protocol` 為空，故複用相同 source 的驗證，不把它改稱 root 新跑的結果。
- 在 evidence revision `ba1e9076`（clean tree）補跑並保存五項 browser-driver logs（15、25、25、17、16 checks），連同 repo/UI typecheck 與 367 UI tests，位於 `.dev/verify/2026-10-21T13-55-manual-ticket10/`。產品 source 與整合版一致。實際 Tauri save 尚未跑，交票 12。
- agent-226 已在 worker worktree 對 `7cc775e4..ba1e9076` 完成只讀獨立 review：Standards、Spec 皆無 actionable findings。確認 request fencing、docx metadata 預檢、lease byte reads 與共用 save control 保留。Review 未重跑 suites，複用票 10 的既有驗證；不是全系統驗收或原生 save 證據。

### Native 驗收準備

在 `daa355e` 的工作站環境，`command -v cargo rustc Xvfb xdpyinfo xdotool xwd ffmpeg dbus-daemon gnome-keyring-daemon gdbus` 及 `ls -l .dev/cargo-target/debug/hepi-app` 均 exit 0；raw log：`.dev/verify/ui-architecture-refactor/environment.log`。共用 debug binary 存在，但未將它當作本次 source 的建置證據。最終整合後需依既有 artifact build script 重新嵌入 App UI 並標記修訂，再跑普通 native journey。

對話 I/O 接線採安全方向：可保留 identity-keyed 的內部容器隔離跨 conversation state；同 identity reload 改走明確 read/reacquire。只移除 key 並加 effect dependencies，卻不處理數十個 state/ref 的重新初始化，不能算完成。
