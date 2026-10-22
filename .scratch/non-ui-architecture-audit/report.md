# UI 以外的架構複雜度盤點

Baseline: `5ec7ffe62a2aaf172fb294bd68f1976098cfb012`。唯讀 source／graph 盤點；不修改 runtime，不執行產品測試或部署，也不將維護成本推論寫成已重現 bug／效能故障。UI ticket 03 獨立持續進行。

指標見 [metrics.json](metrics.json)。範圍為 Backend、Gateway、Session、Client CLI、操作 scripts、App host；排除 unit tests／declarations。兩位 scouts 分別盤點 Backend／Gateway，coordinator 確認主要 source，排除「持久狀態與 live attachment 天生重複」及「所有 timer 需要新 supervisor」等沒有證據的判斷。

## 優先次序

| 優先度 | 聚集點 | 已確認的維護成本 | 建議的最小切片 |
| --- | --- | --- | --- |
| 高 | Backend 組裝與 HTTP dispatch | 不同 domain routes 共用巨大 closure，初始化、狀態與 endpoint 細節在同一入口相遇 | 按現有 domain 抽直接 handlers，bootstrap 只負責接線；保持既有真實整合測試 |
| 高 | Backend project／workspace binding | binding precedence、retained bindings、live registry 與 revision 在 server closure；持久層、HTTP mutation 與解析規則分散 | 先讓 registry 擁有 resolution／mutation／revision，再遷 route |
| 中高 | Gateway RPC transport | 10 個建構參數，execution／files／terminal／installs／settings 的 HTTP framing 同檔 | 讓現有 capability 擁有具體 HTTP handlers；直接 composition，不加 plugin registry |
| 中高 | 本機／SSH filesystem 語義雙份 | Node 與嵌入 Python 各自實作 resource traversal／path rules，變更需同步理解兩語言 | Python helper 成為可獨立定位的 source；普通允許操作的共同 contract cases，維持兩端驗證 |
| 中 | Client ingress 解析 Backend topology | ingress 從 workspace／host 列表及 profiles 組合判定 MCP locality，依賴 Backend 列表形狀 | Backend 提供自己擁有的 binding／locality 決策；ingress 沿用結果與既有 credential boundary |

## 1. Backend 是最明顯的集中點

[server.ts](../../apps/server/src/server.ts) 共 3,241 行。`createBackendServer` 從第 897 行開始，HTTP `handle` 從第 1885 行開始。組裝函式內同時管理 project／gateway binding、Harness 啟動、subagent composition、MCP 接線、conversation attachment、catalogue 與 HTTP dispatch。入口不只組裝，也持有 domain 規則。

例如 project listing／creation 的 route 在第 2050／2069 行附近；同一函式早在 915 行就建立 configured／gateways maps，983 行附近決定 configured／retained／project folder 的 resolution precedence。增加 project 操作、改 binding 規則或 catalogue revision 時，都回到這個大 closure。

優先抽 registry 是因為它有自己的語言與一致性：resolve workspace、retained binding、新操作可用的 targets、project mutation 與 publication revision。避免把整個 closure 改成一個同樣巨大的 ServerContext 物件傳給每條 route，否則只是搬檔案。

Conversation attachment 在 [server.ts](../../apps/server/src/server.ts) 的 `attachConversation`（687）／attachment call（1580）與 durable operations 的組裝（1135 之後）仍有接線成本；可在上述 owner 穩定後另抽 attachment owner。**不把 `conversations` Map 與 Harness 當作兩份 authoritative state**：前者持有 live runtime，後者是持久事實。沒有重現 desynchronization。

## 2. Gateway index 同時是套件入口與多種 transport 的實作

[index.ts](../../packages/gateway/src/index.ts) 共 1,149 行；`GatewayRpcServer` 第 503 行起，constructor 接 gateway 及 workbench／files／installs／workspaces／worktrees／terminals／MCP／providers／providerLogins。`#handle` 除路由外也決定 validation、JSON answer、request disconnect 與各 capability 的生命週期處理；後續還包含 binary file payload 與 terminal SSE framing。

問題是新增一種 capability 的接線與細節都堆到同檔。可先分 files payload、terminal transport、provider handlers；auth admission 仍在既有共同入口，各 domain 的 lifetime 差異保留。

已確認第 1018 行的 `close()` 會集中關閉 terminal、login、MCP、files、socket 與 gateway；**沒有證據需要新增 lifecycle supervisor**。provider login 與 request-bound MCP 的不同壽命是既有產品語義，不是 bug。

## 3. filesystem 的成本在雙語言語義，不只是行數

[filesystem.ts](../../packages/gateway/src/filesystem.ts) 959 行；[ssh-filesystem.ts](../../packages/gateway/src/ssh-filesystem.ts) 689 行，但第 33 行 `REMOTE_FILESYSTEM_SCRIPT` 字串另含 **1,191 行 Python**，一般 TypeScript LOC 看不到這份實作。

本機 `LocalFilesystem.execute`（312 之後）與遠端 adapter 都派送 FileRequest；Node 的 resource／agent-definition／mutation resolution（794、807、916 附近）對應 Python helper 的 resource roots、read／write confinement 與 snapshot traversal。增加一種 execution-side resource 時，需同步兩端規則。

已有 `FilesystemServer` interface，不能建議再造一個相同 interface。真正可改善的是 helper 的 source 可定位性、規則對照與透過普通允許工作流程驗證兩種 adapter 的相同行為。路徑是否合法仍必須由實際 host 驗證；不將 remote validation 移到 client，也不進行 bypass testing。

## 4. Ingress 知道過多 Backend 內部形狀

[ingress/index.ts](../../packages/gateway/src/ingress/index.ts) 的 `servesFolder`（315）分別讀 `/api/workspaces`、`/api/hosts`，理解 workspace.gatewayId、host.id、host.error，以及 profiles 空陣列代表 local host 的語義。這些都是 Backend topology／binding 規則。

現有 fail-closed 行為與權限判斷有必要；維護成本是 Backend 列表形狀或 host profile 模型改動會牽動 ingress。應由 Backend 回答它擁有的 binding／host locality 決策，減少 ingress 重組原始 metadata 的知識，而非刪除此判斷。

## 5. 次級候選與暫不動的區域

- [verify-artifacts.mjs](../../apps/app/scripts/verify-artifacts.mjs) 657 行：module top-level 啟動 artifact/log 目錄選擇，後續同時協調 X display、credential sandbox、package inspection、fixture ingress、keyboard automation 與報告。這是 platform integration 的必要工作，但環境 fixture 與 assertions 的接線可逐步分開；優先度低於上面四項，不主張新建通用 automation framework，也沒有量測 CI latency。
- [skill-install.ts](../../apps/server/src/skill-install.ts) 704 行、[workspace-resources.ts](../../apps/server/src/workspace-resources.ts) 693 行：跨 host publication 與 conversation adoption 的工作流複雜，但 installer 已明確分開 published／reload outcomes（publish 約 386、adopt 646）；僅憑呼叫 reloadResources 不足以判定錯誤耦合。先保留這個有用的小介面。
- `packages/session/src` 7 個 implementation files 共 2,482 行；`createExecutionResources`（530）已封裝 origin／credentials／decoding／target disposal，`AgentEventConnection`（105）集中 subscriber／retry／release。不因 parser 或協定程式較長就列為優先重構。
- Client CLI 4 檔共 431 行；native Rust 2 檔共 619 行。這次未見與 Backend／Gateway 相同程度的責任集中；不是完整 correctness review。

## 建議執行順序

先完成目前 UI 核心工作，再把 Backend project／workspace registry 當下一個有明確 owner 的切片；隨後抽 Backend domain routes、Gateway transport handlers，再整理 SSH helper 的可維護性。完整產品改造需要自己的行為範圍與驗證計畫，本盤點不直接授權重寫或新增一串 tickets。
