# 系統驗收與交付記錄

Type: implementation
Status: planned
Blocked by: [Shell layout 與 panel 接線](11-shell-composition.md)
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — 驗證與交付、完成條件
Acceptance: [行為矩陣](../acceptance.md) — N1–N10、C1–C9、R1–R11 全部核對

## 目標與責任路徑

本 effort 驗收／票狀態及相關 guides；沿既有 apps/web/e2e drivers／apps/app host journey 做整合。產品修改限可重現 material integration 問題的真正擁有者。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "workbench.tsx" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 對照矩陣收集每列的測試／journey／已知限制，檢查真實覆蓋而不是僅列 driver 名稱；補缺失的高風險整合驗證。
2. 在整合 source 跑相關 changed checks、Web/App build 及必要 browser/native journeys；重用同 source 有效結果，不把舊 revision 的證據當新 revision。
3. 專查 API 呼叫者已遷移、obsolete 路徑已刪、純 fold 無 I/O、正常連線預算及 platform seam 保留。這是 source review，不新增源碼形狀測試。
4. material finding 修到擁有者並做必要驗證，其他記 review notes。更新 owning docs、migration-status 的實際限制、票狀態及交付結果。
5. coordinator 在整合 code edits 後依倉庫規則更新 graph；不做部署、重啟或額外發布。

## 驗收條件

- [ ] 每列有 tested revision/dirty state、命令、exit code、raw log 與結果；未測不標 passed。
- [ ] Web 與 App、HTTP/SSE 公開 seam、真實 DOM／原生路徑各自有適當證據，不互相冒充。
- [ ] 未完成高風險 journey 仍列未完成，沒有以 ticks 或票數代替實測。
- [ ] 全部替換清理與現行 guide 更新完成，material findings 已解決；其他限制有 disposition。
- [ ] Spec 與票狀態反映真實完成情況，交付附實作修訂及證據索引。

## 驗證與證據

`pnpm verify:changed`（committed branch 選實際 base）、`pnpm --filter @hepi/web build`、`pnpm --filter @hepi/app build`，再按 acceptance 矩陣跑 focused journeys；先確認 package scripts。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：整合殘留 obsolete imports／未使用接線／臨時測試重複；不為無影響推測新增 guards。

更新 owning guides：開發指南、架構、聊天、工作台、providers/MCP 等 owning guides；verification 的實測記錄、migration-status 實際限制及本 effort 結果。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

待實作填寫：變更修訂、changed paths、scenario evidence、已刪路徑、checks/logs、已解決 material findings 及剩餘限制。完成以上條件後才改 Status 為 resolved。
