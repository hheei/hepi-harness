# Accepted conversation readout

Type: implementation
Status: resolved
Blocked by: none
Baseline: a57100bb4917d408ee51c19beeda30d3efecc857
Spec: [架構收斂規格](../spec.md) — R2、R3 的既有 lifecycle 約束
Acceptance: [行為矩陣](../acceptance.md) — C1、C2，N8 的 accepted identity 部分

## 目標與責任路徑

`useAgentSession.ts` 的 receive/data/step/history 更新；`lifecycle-projection.ts`、既有 history-prefix 規則、`session-view-cache.ts` 與直接消費者。純共享規則僅在必要時改 `packages/session` 現有擁有者。

路徑均相對 `packages/ui/src`，除非明列其他位置。新模組命名按最小實際責任決定，票列的是責任範圍，不要求建立所有候選檔案。

導航：先在工作區以 `~/.local/bin/graphify query "lifecycle-projection.ts" --budget 1000` 定位並確認 source。圖位於主工作區 `graphify-out/graph.json`；其他 worktree 依倉庫規則指向主圖。新發現問題另作窄查詢，子工作不並發 rebuild graph。

## 工作

1. 盤點現有 snapshot/state/page/stream writers，區分 metadata、older prefix、accepted window 與 stream-local delta base；沿用 accepted receiver／fold。
2. 建立同一接受更新所發布的 readout；prefix 隨 accepted window/head 轉換同步決定，不靠 React effect 比對上一個 view。
3. 讓目前 hook／畫面消費同一 readout，保留 metadata 及 stats 合併語義。舊讀取不得回填過期 cache。
4. 遷移／合併既有純規則和 hook 測試至接受入口，刪被取代的重複 transcript 更新；保持目前 I/O 直到生命週期票接手。

## 驗收條件

- [x] 同一 accepted fact 不再先發布 window、下一輪 effect 才修 prefix。
- [x] 完整 session stats、snapshot/history token、分頁 cursor 與 stream continuity 各保有明確位置。
- [x] 合法 HTTP/SSE 先後、stale acquisition、window 滾動／jump、head 變更的可見輸出符合矩陣。
- [x] 新介面有實際生產讀者；未另建 second lifecycle reducer 或 id→payload 副本。

## 驗證與證據

既有 lifecycle-projection、handover continuity、history prefix／navigation、session-view-cache 案例；以公開 transport 驗證 accepted readout。選 focused history browser journey。

執行相關 `pnpm verify:changed`，依改動加 focused integration/browser checks。結果記錄 command、tested revision/dirty state、exit code、raw log；相同 source 的有效結果可複用。遵守 [verification practice](../../../docs/agents/verification.md)，所有測試走普通 admitted workflow。

## 替換與文件

本票需刪除：重複 accepted transcript representation、只為追趕 accepted window 而存在的 prefix effect／previous-window 同步、被替代的測試鏡像。

更新 owning guides：架構、聊天、開發指南的 readout／history 擁有者說明。 僅記已交付內容，不將未測能力寫成可用。呼叫端／tests 同票遷移，不留 shim、alias、fallback reader 或雙路徑；不刪使用者資料。

## Review notes

目前無實作 findings。新項目依 [review policy](../../../docs/agents/review-policy.md) 分類，跨票記錄見[評估記錄](../review-notes.md)；record 不形成 blocking edge。

## 交付記錄

變更修訂：`b20ae3d8`（base `7cc775e4`，branch `impl/ui-readout`）。

### Seam

新增 `packages/ui/src/lib/conversation-readout.ts`：accepted readout = accepted window payload + older prefix +
該 window 的 pagination claim。

- `acceptSession(previous, session)` — 由 `receive`（`receiveAccepted` 之後）在**同一次接受更新**呼叫；
  prefix 依共享 `decidePrefix` 對 readout 已持有的上一個 window 決定，evicted entries 由該 payload 自身取 message。
  無 second reducer、無 revision 比較、無 id→message 副本。
- `prependOlderPage` / `landHistory` / `claimEarlierHistory` / `clearPrefix` — page read、jump landing、
  pagination claim 都經同一 readout 發布。
- `transcriptOf(prefix, window)` — 唯一可見 transcript 派生；prefix 只在仍先於 window 時繪出。
- metadata（stats、`snapshotRevision`/`historyHead`、leaf、display model、run failure、queue/control）留在被接受的
  `SessionData` payload（`readout.session`）；stream-local `SessionState`（`streamHeldRef`）仍為獨立的傳輸連續性狀態。

### Changed paths

- `packages/ui/src/lib/conversation-readout.ts`（新）、`conversation-readout.test.ts`（新）
- `packages/ui/src/hooks/useAgentSession.ts`：`data`/`history`/`hasEarlierMessages` 三個 state 合成一個 readout；
  `receive` 同步發布；移除追趕 prefix 的 `useEffect` 與 `lastWindowRef`/`windowSessionRef`/`historyRef`/
  `dataRef`/`hasEarlierMessagesRef`；unmount cache 寫入改讀 readout。
- `packages/ui/src/hooks/useAgentSession.lifecycle.test.ts`：新增「同一 update 發布 prefix」案例。
- `docs/architecture.md`、`docs/chat.md`、`docs/developer-guide.md`：readout 擁有者說明。

### 已刪路徑

- prefix 追趕 `useEffect`（比對上一輪 window）與其 refs：`lastWindowRef`、`windowSessionRef`、`historyRef`。
- `history` state 與 `setHistory`／`setHasEarlierMessages`／`setData` 的重複 transcript 寫入路徑
  （`loadSession`、`loadContext`、`landWindow`、missing-read、`applyAgentState` 各一處）。
- 對外不再回傳 `setData`（無生產讀者）。

### Checks / evidence

Tested revision：`7cc775e425512087f91365ccc06b9323a9bc11a4` + 本票未提交變更（dirty tree），2026-10-21。

- `node scripts/verify.mjs --profile=changed --base=7cc775e4 --log-dir=.dev/verify/ui-readout` → exit 0；
  changed-typecheck / changed-test / web-unit / check-docs 全 PASS；raw logs `.dev/verify/ui-readout/*.log`，
  report `verify.json`。
- `pnpm --filter @hepi/ui test` → 375 tests, 0 fail（含新 `conversation-readout.test.ts` 7 案與 hook lifecycle 27 案）。
- `pnpm --filter @hepi/ui typecheck` → exit 0。
- Browser journeys（皆 PASS，raw 輸出見 ticket 附件路徑說明）：
  `pnpm --filter @hepi/web test:history-scope`、`test:navigation-retry`、`test:history-rail`、
  `test:chat-scroll`（需先 `pnpm --filter @hepi/web build`）。
- 未執行：真實 backend compaction 下的 live browser journey（僅以合法 head 變更 frame 覆蓋，見 hook lifecycle 案例）。

### Scenario evidence

- C1：`useAgentSession.lifecycle`「stale HTTP reads cannot rewind transcript, history, failure or selected model」、
  「old independent state answers cannot overwrite a newer window or replacement attachment」、
  「a page loaded under an older head states nothing once the accepted context re-baselines」。
- C2：新 hook 案例「a window that moves publishes its prefix in the same update…」（單一 render 即含 evicted entry）、
  「loaded history survives stream head advances and remount」、「a landed target window joins the loaded prefix…」、
  `conversation-readout.test.ts` 的 head-move／whole-range／landing 案例；browser `test:history-rail`、
  `test:navigation-retry`、`test:history-scope`。
- N8 accepted identity：accepted statement identity 仍由 fold 決定，readout 不另存；`dataOf(m).projectionId` 案例不變。

### Remaining limits

- 未在真實 backend compaction 上跑 browser journey；head 變更以合法 frame 覆蓋。
- `packages/session` 的 `decidePrefix` 未改動（本票只遷移其消費者）。
