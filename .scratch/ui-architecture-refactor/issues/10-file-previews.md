# 檔案 preview 呈現模組

Type: implementation
Status: planned
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

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

待實作填寫：變更修訂、changed paths、scenario evidence、已刪路徑、checks/logs、已解決 material findings 及剩餘限制。完成以上條件後才改 Status 為 resolved。
