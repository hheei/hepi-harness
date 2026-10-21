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
| 檔案 preview 呈現模組 | agent-224 | `.dev/worktrees/ui-previews` | in-progress |

agent-225 只讀準備對話 I/O 的接線與 native 驗收前提，不修改依賴尚未完成的票。

## 整合與驗證

目前尚無產品變更整合，亦無本次實作驗收結果。每票回報後在其 ticket 記錄 commands、tested revision/dirty state、exit code、raw logs 及未測 scenarios；整合後以實際 source 再執行相關檢查。原生／上游 OAuth／真實 compaction 證據不得由 browser fixture 代替。
