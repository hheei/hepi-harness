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

## 實作中新發現的記錄格式

僅在有具體 finding 時追加：trigger、source／repro evidence、正常使用可能性、user impact、fix/record/investigate、負責票及重訪條件。`record` 是完整處置，不形成阻擋依賴或自動擴大實作範圍。

## 規劃文件審閱與檢查 — 2026-10-21

獨立 reviewer `agent-220` 讀取本 effort 全部文件、原始盤點及倉庫 review/verification policy，分別檢查 Standards 與 Spec：兩者皆無 material findings。範圍限規劃的一致性、替換切片、依賴及驗收歸屬，不構成產品程式碼審閱或實作驗收。

文件結構核對：12 張票、30 個不重複 scenario IDs、109 個 effort 內文件相對連結皆存在；Blocked by 全部指向較早且存在的票，無依賴循環。結構記錄在 `.dev/verify/ui-architecture-plan/structure.json`。

`pnpm check:docs --json=.dev/verify/ui-architecture-plan/docs.json` 在 `a57100bb4917d408ee51c19beeda30d3efecc857` 加本次未提交規劃文件的工作樹執行，exit 0；raw log：`.dev/verify/ui-architecture-plan/docs.log`，JSON：`.dev/verify/ui-architecture-plan/docs.json`。`git diff --check` 同一工作樹 exit 0，raw log：`.dev/verify/ui-architecture-plan/diff-check.log`。工作樹另有先前的 durable-ledger scratch，未納入本次編寫／審閱範圍。

未執行產品測試、build 或 browser/native journey：本次僅建立規格及 tickets，矩陣仍是未執行需求。以上本地 `.dev` 檔案是當前工作區證據，不保證在新 checkout 中存在。
