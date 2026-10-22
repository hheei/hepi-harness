# 檔案 preview 呈現模組

Type: implementation
Status: resolved
Blocked by: none
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R7 檔案部分
Acceptance: [行為矩陣](../acceptance.md) — R7、R8

## 目標與責任路徑

`FileViewer.tsx`、`useDocxPreview.ts` 與各格式 preview；只在接線必要時改 FileSaveControl/useFileBytes；保持 FileSeam、apps/app save-host adapter。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "FileViewer.tsx" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 將 text/diff、image、audio/video、document 等不同呈現責任分成內部 leaves，FileViewer 只作選擇及共同畫面接線。
2. 重用 FileSeam/useFileBytes，不新增 endpoint owner；保留 abort/lease release、docx metadata 預檢與 bounded text 行為。
3. 保持 browser 與 Tauri save adapter，取消／失敗結果不因葉節點拆分被吞掉。
4. 遷移直接 imports／既有測試與 fixtures；沒有實際格式變化就不建立 plugin registry。

## 驗收條件

- [ ] 各 preview 格式專屬邏輯局部可找；FileViewer 不再混合所有格式的工作流。
- [ ] 快速換路徑／scope 仍清理 lease、取消舊讀，預檢不被移到下載之後。
- [ ] bearer blob 的本地讀取不變成重複遠端下載，URL／save endpoint 只由既有 seam 提供。
- [ ] 原生 save 的實測歸屬明確；本票未測部分須交整合驗收承接並保留狀態。

## 驗證與證據

file surfaces/failures/docx/transfer 既有 drivers、file-save/useFileBytes 案例；實際 native save 依矩陣 R8 在本票或整合票留證據。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：已移轉 preview 實作、只有改名轉傳的本地 wrapper；不刪平台 adapter 或 metadata 預檢。

更新 owning guides：工作台、開發指南；現有平台限制保持。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

獨立 reviewer agent-226 對 `7cc775e4..ba1e9076` 審閱：Standards 與 Spec（R7／R8 reviewed paths）皆無 actionable findings。確認 text state／request fencing、docx metadata 預檢、lease byte reads 及共用 save control 保留。未重跑 suites，依本票既有 checks；實際 Tauri save 仍由票 12 驗證，browser fixtures 不取代 native 證據。

## 交付記錄

變更修訂：commit `0b2c2e28b0e9570502a3d1381979470aaddac2c9`（worktree base `7cc775e4`）。

Changed paths（相對 `packages/ui/src`）：

- `components/FileViewer.tsx`：只作格式選擇（44 行），不再持有任何格式工作流。
- 新葉節點：`components/TextFilePreview.tsx`（bounded chunk + git patch + 三種模式 + scroll/selection/wrap 狀態）、
  `components/SourceFilePreview.tsx`、`components/DiffFilePreview.tsx`、`components/MarkdownFilePreview.tsx`、
  `components/ImageFilePreview.tsx`、`components/MediaFilePreview.tsx`（audio/video 同一職責，以 kind 區分）、
  `components/DocumentFilePreview.tsx`。
- 共用接線：`components/FilePreviewToolbar.tsx`（路徑列、watcher 缺席、FileSaveControl）、
  `components/file-preview-styles.ts`（行號與字串樣式、dark theme）、`components/file-source-selection.ts`（來源行選取）。
- 測試入口遷移：`lib/file/file-save.test.ts`、`lib/file/file-seam.test.ts` 的同一組斷言改指向實際擁有者（新葉節點），
  非鏡像或檔案形狀測試。
- 文件：`docs/workbench.md`（格式葉節點清單、docx 預檢位置）、`docs/developer-guide.md`（components 目錄與 format leaves）。

已刪路徑：`FileViewer.tsx` 內的 `TextFileViewer`、`ImageViewer`、`AudioViewer`、`VideoViewer`、`DocumentViewer`、
`DiffView`、`SourceCodeRenderer`、`MarkdownImage`、`DownloadLink`、`WatchState` 及其本地樣式常數；無 wrapper／shim 保留。

保留契約：`FileSeam` 仍是唯一 endpoint owner；`useFileBytes` 的 abort + lease release 未改；docx metadata 預檢仍在任何
位元組請求之前（先 `?type=meta`，超界不發 read）；browser download 與 Tauri `FileSaveHost` 仍由 `FileSaveControl`／
`useFileSave` 決定，取消不誤報成功。未新增 plugin registry 或 transport facade。

Evidence：

- `pnpm verify:changed --base=7cc775e4` 於 revision `0b2c2e28`（clean tree）exit 0：changed-typecheck、
  changed-test、web-unit、check-docs 全 PASS；log 在 `.dev/verify/2026-10-21T05-44-30-551-verify-changed`。
  （同一 source 在 commit 前以 dirty tree 跑過一次，log `.dev/verify/2026-10-21T05-43-31-953-verify-changed`。）
- 在同一產品 source 的 evidence revision `ba1e9076`（clean tree）重新執行 focused drivers：
  `pnpm --filter @hepi/web test:docx-preview`（15 checks）、`test:file-surfaces`（25）、`test:file-failures`（25）、
  `test:files-transfer`（17）、`test:workbench-scope`（16）、`pnpm -r typecheck`、
  `pnpm --filter @hepi/ui typecheck`、`pnpm --filter @hepi/ui test`（367 pass）皆 exit 0。每項 log 含 command、
  revision、dirty state 與 exit code，收於 `.dev/verify/2026-10-21T13-55-manual-ticket10/`。
- `pnpm --filter @hepi/ui test` 367 pass、exit 0；`pnpm --filter @hepi/ui typecheck` 與 `pnpm -r typecheck` exit 0。
- R7：`pnpm --filter @hepi/web test:docx-preview`（cookie／bearer 各讀一次、超界零讀取、無 frame/script、empty 文案）
  exit 0；`test:file-surfaces`（image 走 connection lease、meta 讀取、native save 缺省文案、App 分片寫入）exit 0；
  `test:file-failures`（failed／gone／truncated，Retry 與 Reload folder 落到 shell 回呼）exit 0；
  `test:files-transfer`（upload、range、download 導覽、watch 501）exit 0；`test:workbench-scope` exit 0。
- R8 部分：browser download 與 fixture `FileSaveHost` 的 save／取消已由上述 driver 覆蓋並通過。

剩餘限制：實際 Tauri 原生儲存（真 shell picker 與 app_save_* IPC 寫盤）本票未執行，須由整合驗收票 12 依矩陣 R8
在 App 環境承接；本票不宣稱該列已驗證。無其他 material findings，無新增 record 級項目。
