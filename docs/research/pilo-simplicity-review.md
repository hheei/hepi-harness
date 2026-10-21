# Pilo 對照：Hepi 如何更小而精

日期：2026-10-19。只讀研究；未修改產品程式、刪除功能、執行測試或部署。

來源基線：Pilo 17837f8a9cc22ec61ba1eb6d17a275752e96015c，已核對 GitHub HEAD，研究副本 /tmp/hepi-pilo-simplicity-current。Hepi integration/client-app 3e69c62a4a6c7989999fba57ac29345c9cff02cb，位於 .dev/worktrees/client-app-integration。下列 Hepi 行號相對該 worktree。Pilo 無本地 graph；Hepi graph 未收錄新共享 UI 符號，以聚焦來源及呼叫方搜尋補證。兩名 scout 分別調查 API/平台與狀態，主代理逐項核對；未直接採用其刪行估算。

## 結論

最值得借鑑：一份事實來源、平台差異集中、刪除沒有產品消費者的抽象。Hepi 已共用 React Workbench；應完成舊入口退役、移除遷移殘留，不再建立第二套 client、registry 或會話狀態系統。Pilo 的權威是 Pi JSONL，Hepi 的權威是 durable transcript 與原子文件；兩者不應混為同一種 runtime。

## 已確認的精簡機會

1. **刪除未使用的 SettingsReader。** packages/session/src/settings.ts:123 的 ModelCatalog、SettingsReader、createSettingsReader 只是 createScopedCache 的包裝。全庫 createSettingsReader 搜尋只有定義、文件與 packages/ui/src/lib/models-cache.test.mjs:91 專屬測試；實際 models-cache.ts 和 useAgentSession.loadModels 直接用 createScopedCache。刪尾段26行、專屬測試12行，共38行；調整 import 和 docs/client-ingress.md:527，同時保留真實快取作用域、失效、in-flight 與容量測試。

2. **刪過期的全域 fetch fallback。** packages/ui/src/lib/api-request.ts:19、capability-availability.ts:91、workspace-api.ts:264、hooks/useSessionUiState.ts:86 允許缺少 connection 時使用 pageOriginRequest。註解稱供獨立 fixture，但 apps/web/e2e/ux-capability-trust.fixture.tsx:169-179 已建立 client 並提供 WorkbenchConnectionProvider。產品元件要求 connection，剩餘 fixture 也注入 provider。useCapabilityServed 六個現行呼叫只傳 path，亦可收掉無呼叫方的 request 參數。保留獨立 Markdown 的 optional context；不能盲刪整個 optional hook。實施時把 capability-availability.test.mjs:69-72 的 fallback 原始碼斷言改為實際 provider 請求驗證。尚未製作 patch，不計刪行收益。

3. **ConversationApi 隨 connection 建立一次。** AppShell、SessionSidebar、SessionSearch、RawHistoryPanel、SettingsPanel、useAgentSession 六處各自 useMemo 建立 createConversationApi(client)。在既有 WorkbenchConnection 放一個 API，與 client 同壽命建立，消費者直接取用。保留 conversation-api.ts:132 的目錄投影、控制與路由責任。這是減少重複組裝；約112行 API 實作仍存在，不能宣稱可刪60–80行。共享檔案仍在開發，宜隨現有整合批次處理。

## 最大刪減由既有票17擁有

追蹤檔案目錄盤點：

| 舊目錄 | 文字行數 |
| --- | ---: |
| apps/web/app | 145 |
| apps/web/adapters | 3,467 |
| apps/web/vendor | 77,520 |
| 合計，445個檔案 | 81,132 |

命令：在上述 Hepi worktree 執行 git ls-files 各目錄，再以 wc -l 計數，退出0。這是庫存，不是淨刪除承諾，包含第三方副本、測試及需搬遷契約。票16完成產物驗收後，票17核對消費者、搬保留契約、刪舊入口/adapter/vendor/依賴及 launcher。沿用既有票，不另開框架替換。

## Pilo 原始碼依據與借鑑界線

- [README](https://github.com/hsingjui/pilo/blob/17837f8a9cc22ec61ba1eb6d17a275752e96015c/README.md#architecture)：Pi JSONL 為真相，SQLite 作索引。借鑑單一權威，保留 Hepi durable 語義。
- [PiloClient](https://github.com/hsingjui/pilo/blob/17837f8a9cc22ec61ba1eb6d17a275752e96015c/src/lib/api/pilo-client.ts#L60)：元件直接向 client 要操作。Hepi 可收斂 API 組裝，不必把所有領域方法塞進巨大傳輸介面。
- [歷史 window store](https://github.com/hsingjui/pilo/blob/17837f8a9cc22ec61ba1eb6d17a275752e96015c/src/components/chat/chat-history-window-store.ts#L4)：目錄與 hydrated 訊息分離、預設200則及 LRU。Hepi 已批准的 history-navigation spec 涵蓋此方向，另需分頁索引、穩定 entry ID、fork/revision 合同；不另造平行實作。
- [Tauri client](https://github.com/hsingjui/pilo/blob/17837f8a9cc22ec61ba1eb6d17a275752e96015c/src/lib/api/tauri-pilo-client.ts) 與 [Web client](https://github.com/hsingjui/pilo/blob/17837f8a9cc22ec61ba1eb6d17a275752e96015c/src/remote/web-pilo-client.ts)：仍有兩份傳輸與不同應用流程。Hepi 已共用 HTTP/SSE 與單一 Workbench，這部分保持現狀。

## 未採納的裁剪建議

保留 FileSeam：它集中 cookie 直接 URL、bearer 有界 blob lease、下載能力及 workspace 路由；把方法散回元件只是搬走複雜度。局部原樣 readJson wrapper 可順手收掉，不構成重寫理由。

保留 live projection、lifecycle acquisition、view cache、歷史 hydration 各自責任；Pilo 自己也分 conversation store 與 window store。

Workbench descriptor probe 後重建 client 是後續候選，但需保留拒絕登入、重試、切換連線、StrictMode cleanup；無 patch/驗證，不承諾能刪30–40行。

不改成一個 string/unknown 通吃的 sendCommand；型別、未知 mutation 結果、取消與不重播語義仍須有明確擁有者。

## 順序與驗證

先完成票16/17，再處理死 SettingsReader 與 fixture fallback，最後隨會話整合收斂 API 組裝。此輪只有研究，未改產品行為，故未跑產品測試；實施時跑各自快取、connection/provider 與 Web/App journey 檢查。

net: -38 lines possible（已量到的死封裝與專屬測試）；其他候選及舊目錄退役另計，尚未執行刪除。
