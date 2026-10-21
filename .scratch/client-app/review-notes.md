# Architecture gaps and design patterns

Date: 2026-10-17. Source baseline: 848f391b4245070b6677704d6a64e2a0d7356996 + worktree. Read-only source review, not runtime verification. Findings concern the migration design; no claim that current deployment is broken.

Private-project scope: no valuable historical data. Direct replacement from fresh state; no old-user/PWA/draft upgrades, historical-data migration, version compatibility or rollback rehearsals. Current-runtime recovery and target capability validation remain required.

## Findings

| ID | Trigger / source evidence | Normal-use impact | Disposition / closure |
| --- | --- | --- | --- |
| G1 | User confirms private project with no old-client support requirement | Version combinations need no migration treatment | removed from scope: version negotiation, compatibility matrix and old-client refusal tests. Connection description only identifies current Backend/capabilities/build |
| G2 | Existing Web login (`../../apps/web/app/api/%5B...path%5D/route.ts`) and [Backend auth](../../apps/server/src/server.ts) validate static service tokens; device issuance, persistence and active-stream revocation do not exist yet | New App otherwise needs master token or cannot revoke one device | fix-spec: Backend credential authority, authenticated enrollment, secure store, bounded revocation, fail closed when authorization cannot be verified. Tickets 02/04. Revoking access does not abort durable work |
| G3 | Durable adapter (`../../apps/web/adapters/durable-api.ts`), agent definitions (`../../apps/web/adapters/agent-definitions.ts`) and MCP host adapter (`../../apps/web/adapters/mcp-host.ts`) resolve different origin/workspace/host scopes | Removing Next can lose correct SSH routing or operate MCP on wrong host | fix-spec: capability/caller matrix names each identity; Backend decides workspace binding, MCP client API names its configuration host. Tickets 01/06/12/13 |
| G4 | Push caller (retired in ticket 14; was `packages/ui/src/lib/push-client.ts`) requests /api/push/config and /subscribe; catch-all/Backend have no owning push handler; [Settings](../../packages/ui/src/components/SettingsPanel.tsx) probes capability | Treating latent Push prototype as delivered feature expands scope; blanket deletion could remove working page notices | fix-spec: retire orphan Push feature, retain page completion notifications and PWA install/offline behavior. Tickets 01/14/17. Unsupported capability is not a new implementation mandate |
| G5 | [Worker](../../apps/web/public/sw.js) targets Next static assets | New Vite Web needs its own worker/manifest, independent of the old implementation | fix-spec: fresh-install PWA and API-not-cached checks only. No old-worker/cache upgrade tests. Tickets 14/16/17 |
| G6 | Current UI uses [Next routing](../../packages/ui/src/components/AppShell.tsx), [draft storage](../../packages/ui/src/lib/draft-store.ts), origin-relative resources and singleton caches | Hash query loss, reused IDs/cwd across Backend profiles, stale responses or blob leakage | fix-spec: scoped client owner + React Router hooks; preserve acquisition fencing; fresh scoped draft/preference keys; no legacy import/export. Tickets 05/07/14. Baseline already identified these; now acceptance is explicit |
| G7 | The bounded multipart parser imported `next/dist/compiled/busboy`; media/link elements cannot add a bearer header | Next deletion breaks streaming uploads; naive bearer adaptation buffers large downloads | fix-spec: independent parser, resource client, bounded large-file save, cancel/backpressure evidence. Tickets 07/08. **Closed by 08**: the reader is `packages/gateway/src/multipart.ts` over the public `busboy`, and the file surface is `packages/gateway/src/files-surface.ts` |
| G8 | [Deployment runbook](../../docs/deployment-runbook.md) describes old services; new Web/App require different artifacts | Missing build/run instructions could leave new entry dependent on retired services | fix-spec: reproducible current artifacts, fresh-state integration and one direct switch. No old-release manifests or rollback rehearsals. Tickets 01/15/16/17 |
| G9 | Web login (`../../apps/web/app/api/[...path]/route.ts`) and Backend fetch (`../../apps/web/adapters/durable-api.ts`) both use HEPI_AUTH_TOKEN; [execution startup](../../packages/gateway/src/startup.ts) binds loopback | Reusing current configuration would conflate login/service identities and leave a mobile client without a reachable entry | fix-spec: independent entry/service/execution credentials, explicitly reachable client listener or TLS reverse proxy, App preflight and cookie CSRF as distinct branches. Tickets 02/04 |
| G10 | [Pinned plugin-http implementation](https://github.com/tauri-apps/plugins-workspace/blob/f36ba7ba48695776bc11cce0bfdc45678ec24f72/plugins/http/guest-js/index.ts#L179) calls req.arrayBuffer then converts body to number array; response uses fetch_read_body | Choosing this fetch as a universal fallback would buffer large uploads across JS/IPC | **closed by ticket 04 measurement**: native `fetch` covers read/SSE, and WebKitGTK refuses streamed request bodies itself, so the plugin is not adopted and its buffering is moot. The measured cost that replaces this concern is IPC chunk size: whole WebView chunks peaked at 3.06 GB RSS against 225 MB for 1 MiB slices. Read/upload/save stay separate paths. Ticket 08 owns the file-path consequence; Android remains unmeasured |

fix-spec means specification/acceptance correction for an expected migration path. No row authorizes unrelated production changes. Workspace routing, auth separation, media adaptation and scoping were already in blueprint; this review tightens ownership and closure, rather than treating them as newly discovered production bugs.

## Apply patterns only at existing seams

| Pattern | Concrete use | Keep interface small |
| --- | --- | --- |
| Facade + composition root | Gateway hides client mapping; Web/App roots choose history, credentials and platform functions | One scoped client boundary; keep domain decisions in Backend and pure projections |
| Ports and adapters | Cookie/bearer request auth; BrowserRouter/HashRouter; browser/native save or notification when both exist | Functions at real runtime differences; reuse protocol/session; no extra package or DI container |
| Functional core, imperative shell | Existing lifecycle/durable projections fold facts; transport performs I/O and cancellation | Reuse current reducer/ordering contracts; do not wrap them in another state machine |
| Observer / shared subscription | Existing conversation subscribers and terminal fan-in share streams | One owner per connection; unsubscribe/cancel on scope change; no global event bus |
| Command + idempotency key | Existing requestId/lookup semantics handle unknown submission outcome | Reuse commands/receipts; no general retry queue or new command registry |

Read/write separation already exists between durable commands and projections. That does not justify a CQRS library, event bus, service locator, generic repository layer, or another persistent scheduler. Host routing uses existing Backend binding lookup, not client-side discovery of internal service tokens.

## Deep-module review: interface alternatives and costs

2026-10-17，按 codebase-design 的 Depth、Locality、seam 与 deletion test 比较三份独立接口草案。以下是设计建议和源码成本分析，尚无 App benchmark；方法数量或隐藏代码行数不作为深度证明。

| 方案 | 调用者获得的 leverage | Locality / seam 代价 | 结论 |
| --- | --- | --- | --- |
| A：createClient → session.watch/send | 会话订阅与命令入口很短 | 资源、终端、目录和 dispose 缺位；把投影与 requestId 隐藏进去会争夺现有 hook 的职责 | 保留按会话共享订阅的思路；不采用自动生成且调用者不可见的提交身份 |
| B：request/stream 原始 transport + domain functions | 认证、地址、取消只实现一次 | 原始 path、generation、解析和错误判断容易重新散落到调用者；自造 RawHttpResponse 重复 Fetch 标准接口 | transport 仅作内部 seam；优先注入 fetch-compatible 函数，保留 Response/ReadableStream |
| C：ConversationController + view/多种动作 | 聊天调用者能直接表达意图 | 新 controller/view/status 若与现有 lifecycle projection 并存会产生第二套状态；承担模型、fork、导航后职责膨胀 | 复用现有会话 hook 作为调用者 interface，不先重写为新 controller |

推荐组合：`packages/ui/src/client` 按连接创建，内部拥有认证请求、资源与 disposal；对 UI 暴露命名 domain 操作。既有会话 hook 保持唯一 lifecycle/projection owner，既有 AgentEventConnection 保持会话流的 I/O owner。transport 本身不决定完成、busy、队列或 requestId 的结算。`packages/client` 继续仅为 gateway/doctor CLI。

示意 interface，仅约束职责，不要求增加对应类或重命名全部函数：

```ts
const client = createClient({ profile, identity, fetch: platformFetch });
const snapshot = await client.conversations.read(id, { signal });
const release = client.conversations.subscribe(id, onEvent);
await client.conversations.command(id, { type: "prompt", requestId, text });
const image = await client.resources.image(resource); // 有界资源 lease：url + release()
release();
image.release();
client.dispose();
```

`requestId` 在发送前由现有提交 owner 创建并登记；响应未知时继续按它查询。`dispose` 幂等，终止该连接 HTTP/流/计时器并释放临时资源；不会停止 Backend run。普通会话切换只解除该调用者 interest，其他订阅者仍使用同一流。profile/Backend/身份决定缓存归属；连接 generation 拦截旧连接返回，既有 acquisition generation 继续裁决同一会话内读取/流的先后，两者不能合并成一个时钟。原始平台 fetch、流解析和鉴权材料留在 implementation，React 调用者不拼 origin/header。

依赖按现有 seam 处理：纯投影是 in-process，直接复用；Gateway 是 remote-owned，生产 fetch 与内存/真实 HTTP fixture 在同一 interface 验证；凭证存储和保存文件由宿主提供实际不同的 adapter，组件不用知道 OS。标准 fetch 能满足两端时共用同一 implementation；plugin-http 不作为必装抽象。原生 EventSource 无法加 Bearer；插件响应流也不能证明上传流式。没有两个真实用途的 adapter 不增加独立 port/包。

Deletion test：删掉 scoped client，认证、取消、资源释放会重新散落到多个调用者，说明它有 leverage；删掉另造的 transport wrapper 若只少一次转发，说明它不值得存在。保留纯投影与流恢复的独立合同测试；替代新 seam 后删除只验证旧 helper/Next implementation 的测试，避免叠加三套同义验证。

### 有证据的成本与实施落点

| 项目 | 当前源码证据 / 普通触发 | 建议 / 验收 | 落点 |
| --- | --- | --- | --- |
| P1：一次加载重复 snapshot | [loadSession](../../packages/ui/src/hooks/useAgentSession.ts) 的 includeState 分支先读 sessions/:id，再读 :id/state；adapter (`../../apps/web/adapters/durable-api.ts`) 两路都调用同一 Backend state | 同一已接纳 snapshot 派生 transcript 与 composer/settings；不共享过期 acquisition，不抑制 resync 后确需的新读。记录一次加载请求数与 ordering 回归 | 05/07 |
| P2：流内部 JSON 往返 | [StreamSource](../../packages/session/src/browser.ts) parse wire → emit stringify → [AgentEventConnection](../../packages/session/src/agent-event-connection.ts) parse；每个 frame 均发生 | 先记录代表性帧大小/频率与处理耗时；若值得，沿现有 source seam 交付 typed event，更新全部实际消费者、去掉字符串桥，不增加另一套 parser。入口继续透传原始 SSE bytes | 03/05；收益待测 |
| P3：目录 metadata 串行与重复请求 | sessions 列表 (`../../apps/web/adapters/durable-api.ts`) 顺序读 catalog、projects、workspaceRoots；workspaceRoots 内又读 workspaces 与 projects | 一次请求内各读一次 catalog/projects/workspaces，可并行；映射复用这份 metadata。仍保持 revisions 和宿主身份，不以全局缓存代替权限判断，不逐会话读 history | 06 |
| P4：有界资源与流 owner | [file relay](../../apps/server/src/file-relay.ts) 已逐 chunk 转发并等待 drain；新 App 会增加认证媒体加载 | 保留背压/取消；blob 仅用于限额展示资源，cache/retained history 有明确上限与释放条件，大文件边读边保存；避免为 bearer 统一 arrayBuffer/base64 | 07/08/09 |
| P5：构建及渲染成本分开 | AppShell 切会话有 sessionKey 重挂载；hook 在实时帧更新多个字段；现有 source 并不能证明可见卡顿或 React 实际 commit 数 | production 测首屏与会话切换、streaming commits；依据结果再分离高频 transcript 与稳定面板、按需加载重面板。保留正确 remount 语义，不能仅凭 setter 数量断定多次 render | 15/16；record，测量触发实现 |

P1/P3 是迁移时可直接减少的明确冗余工作；收益大小仍无测量。P2/P5 属于有证据的成本候选，不是已确认性能故障，也不增加阻塞票据。P4 是既定内存合同，不能以“底层 fetch 支持 stream”替代端到端验证。

测量使用生产构建、同设备、固定会话窗口/帧负载和文件大小，记录冷/暖状态、重复次数、请求/连接数、首个可见内容、帧处理/React commit、峰值 JS 与 native 内存。已有旧实现可作一次对照，不建立旧版长期回归或兼容矩阵；有代表样本才报告分位数。UDS/in-process、文件/终端直路仍由 hop/CPU/内存证据触发，不进入必做任务。

## Remaining limits and investigations

| Topic | Evidence / trigger | Disposition / revisit |
| --- | --- | --- |
| UDS, embedding, file/terminal bypass | Existing file relay already streams; no measurement shows local HTTP dominates | record: retain HTTP+SSE/Backend relay; revisit with latency, CPU or allocation trace |
| Native fetch vs plugin-http | Measured on Linux x86_64 / WebKitGTK 4.1 in a real Tauri v2 shell (ticket 04): native `fetch` streams downloads incrementally and needs no plugin. WebKitGTK rejects a `ReadableStream` request body outright (`NotSupportedError`), so uploads are bounded bodies regardless of plugin choice, and `plugin-http` was not adopted | resolved: no plugin; the remaining rule is measured — bound what crosses IPC (whole WebView chunks peaked at 3.06 GB RSS, 1 MiB slices at 225 MB). Android is still unmeasured |
| Universal native background push | No complete current Push backend; native target permission/background constraints vary | record: outside this scope; revisit on explicit product request and platform support |
| File watch | Workbench explicitly returns not-connected/501 | record: preserve honest capability limit; no watcher ticket |
| Additional native OS/signing | [Ticket 01](issues/01-contracts-and-release-envelope.md) fixed the pair: Linux x86_64 (workstation, WebKitGTK 4.1, Tauri v2) and Android as candidate. The desktop half is evidenced — the Tauri v2 shell builds and packages with the project's own `@tauri-apps/cli` 2.12.3 (ticket 15, 33 artifact assertions) — while Android stays unevidenced because the SDK is absent. Decision and commands: [spec release envelope](spec.md#release-envelope) | record: 04 records actual target evidence and signs nothing beyond those two; Windows, macOS and iOS are not selected; additional OS follow later without blocking the agreed targets |

## Navigation and review provenance

Parent used narrow graph queries for ingress, adapters and browser connection seams during architecture research, then confirmed owning source. Read-only scouts reviewed ingress/auth/host routing and shared UI/PWA retirement using parent-supplied paths. Findings above were checked against source. Cancellation owns client access; Backend owns durable run state. Native behavior remains bounded by the platform spike, independently of source-level contract evidence.

[Specification](spec.md) owns requirements; [ticket breakdown](ticket-breakdown.md) owns ordering. These notes explain evidence and tradeoffs and do not create another implementation loop for record dispositions.
