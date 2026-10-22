# 模型與 provider 工作流

Type: implementation
Status: resolved — integrated 07943df4; final evidence e6a0ffd
Blocked by: [對話 I/O 與 view attachment](03-conversation-lifetime.md), [Composer 互動與命令介面](05-composer-interaction.md)
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R5、R6 模型部分
Acceptance: [行為矩陣](../acceptance.md) — R1–R3、C5 的模型更新部分、R11 的模型 scope

## 目標與責任路徑

`ModelsConfig.tsx`、provider helpers、`models-cache.ts`／既有 scoped cache 使用者；對話與 composer 模型讀者；Shell／ChatWindow modelsRefreshKey。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "models-cache.ts" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 收斂 provider draft/save、credentials/auth 及 model catalog 的領域介面，保留各資源差別與 draft request fence。
2. 成功 applied mutation 使受影響 catalog generation 過期；已掛載讀者以既有 bounded read/retry 重讀，不等待 Settings 關閉。未掛載時只 invalidation。
3. 保持 scope／in-flight coalescing／stale result 規則；讀失敗保留選擇並呈現 retry，retry 不重寫設定。
4. 將所有現行成功 credential/config 寫入接入同一更新策略；saved-but-not-applied 如實 readback。
5. 刪 modelsRefreshKey 中轉及 modal dismiss 更新契約，同票遷移 provider/browser 驗證。

## 驗收條件

- [x] Settings 開著也能在成功更新後重讀受影響的 model readout；不默改目前 session model。
- [x] 關閉未修改 Settings 不清 cache、不 fetch；失敗 mutation 不虛報 applied。
- [x] host-wide 變更覆蓋受影響 cwd；其他 connection/account 的讀者不串用。
- [x] 只用模型領域的更新介面，未增加全域 bus 或第二 cache 實作。
- [x] Shell、ChatWindow、對話 hook 不再有 modelsRefreshKey。

## 驗證與證據

models-cache/scoped cache、provider draft 既有案例；provider acceptance journey 加入保持 Settings 開啟、mutation failure/read retry 的實際觀察。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：modelsRefreshKey 整條傳遞、modal-close invalidation effect、重複 mutation/readback 策略；保留草稿 discovery fencing。

更新 owning guides：Providers、pi-config、聊天／開發指南的模型刷新契約。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

Worker revision `a5687489`, clean, base `b3ab7871`; merged into architecture-consolidation. Model cache invalidation now notifies mounted readers, bounded read/retry shared across mount/change/manual Retry. Applied writes invalidate; applied:false reads saved file back without claiming adoption. Removed modelsRefreshKey and Settings-close invalidation.

`pnpm verify:changed --base=b3ab7871` exit0, four steps pass; worker worktree `.dev/verify/2026-10-21T19-06-11-174-verify-changed/`. `pnpm --filter @hepi/web test:panel-ingress` exit0,77 checks; `test:provider-acceptance` exit0,70 checks. Logs `.dev/worktrees/ui-model-workflow/.dev/verify/ticket06/{panel-ingress-committed,provider-acceptance-committed}.log`. Worker mutation checks detect removed reader notification and erroneous unapplied-save invalidation; mutations reverted. Guides updated in same commit.

Parent integration at62c2c588 passed, raw bash-29f2dc-6.log. Reviewer initially used reversed diff and retracted those findings. Sole material P2: old in-flight catalog result could overwrite refreshed state. Fixed8a64b0e2 with sequence fencing for success, error and retry; regression releases old responses last. Correction review: no remaining material issue, lifecycle40/40. Integrated07943df4; pnpm verify:changed --base=62c2c588 exit0, UI465/App29/Web14 and typecheck; report `.dev/worktrees/architecture-consolidation/.dev/verify/2026-10-21T19-21-04-372-verify-changed/verify.json`, raw bash-29f2dc-7.log. Worker clean8a64b0e2 final changed/browser77/provider70 checks all0; raw `.dev/worktrees/ui-model-workflow/.dev/verify/ticket06-final/`. Verification guide updated at e6a0ffd; docs check463 links0. No App-host journey or deployment performed; native acceptance remains separate.
