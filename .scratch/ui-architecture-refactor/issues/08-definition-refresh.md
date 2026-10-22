# Definitions target 與刷新接線

Type: implementation
Status: resolved
Blocked by: [對話 I/O 與 view attachment](03-conversation-lifetime.md)
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R6 Skills/Agents/Extensions、R3 reload
Acceptance: [行為矩陣](../acceptance.md) — R6、C5

## 目標與責任路徑

`SkillsConfig.tsx`、`AgentsConfig.tsx`、`ExtensionsConfig.tsx`、`SettingsPanel.tsx` 的 onSessionReload；ExecutionTarget／target-fence 的現有使用者與 Shell callback。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "ExecutionTarget" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 保留 library 與 conversation target 的語義，把設定成功後 refresh 接到明確 definitions／conversation read 操作。
2. target 捕獲、取消與適用性仍由既有 target fence 保護；切對話後舊操作不能 reload 新對話。
3. 把 Settings → Shell sessionKey 回呼替換為 typed 的操作結果接線；只更新需要的資源，不重建整個工作台。
4. 清理重複 refresh counters 及已失去用途的 callback，遷移 target/extension 現有案例。

## 驗收條件

- [x] 更新成功影響正確 target；失敗不虛報 reload，切換後不污染新的 conversation。
- [x] Skills/Agents/Extensions 與 SettingsPanel 不知道 sessionKey 或對話初始化細節。
- [x] 既有 installed/enabled、reload/error 狀態與 focus 保留。
- [x] ExecutionTarget 沒被模型／MCP 通用 CRUD 化。

## 驗證與證據

target-fence 現有案例、skills-project-target、skills-inventory-race、extensions-panel journeys；必要 agent definitions case 沿既有 execution seam。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：設定資料更新的 sessionKey callback、已由明確 reload 承接的 refresh counters／重複 fencing。

更新 owning guides：Execution-side resources、installation、開發指南。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

UI08 branch `impl/ui-definitions`, worker tested `02b95822`: connection-scoped `conversation-refreshes` replaces Shell reload ref; panels name their own conversation. Removed `onSessionReloaded`, session-keyed Extensions remount, Skills reloadKey. Five registry cases and 15 production-panel browser assertions cover failed, superseded, not-open and switched targets. Worker journey logs `.dev/worktrees/ui-definitions/.dev/verify/ticket08/`.

Integrated at `b3ab7871` in `.dev/worktrees/architecture-consolidation`. Combined `pnpm verify:changed --base=ddc82d03` exit 0 (typecheck, tests, web-unit, docs); raw report `.dev/verify/2026-10-21T17-08-21-052-verify-changed/`.

On unchanged integrated revision `b3ab7871`, `pnpm --filter @hepi/web test:transcript-presentation && pnpm --filter @hepi/web test:composer-interaction && pnpm --filter @hepi/web test:definition-refresh` exit 0. Full raw log `/home/chlo/.pi/agent/sessions/--home-chlo-Documents-dev-hepi-harness--/tasks/01a15c17-51ee-75d2-80b8-9ae57d3c15af/bash-f4a6b0-15.log`. Cross-ticket ReloadOutcome registration variance resolved by integrating UI04 and UI08 together. Real Backend long-history/native acceptance remains ticket12.
