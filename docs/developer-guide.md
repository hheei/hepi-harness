# Developer guide: architecture and implementation

沿一次请求找实现所有者、契约与验证接缝。启动步骤见 [Onboarding](development/onboarding.md),
开发入口见 [Developer handbook](developer-handbook.md),完整语义以 [Architecture](architecture.md) 为准。

## System shape

```text
Web (cookie) / Tauri App (device bearer)
        │ packages/ui shared workbench · HTTP + SSE
        ▼
client ingress ──service credential──► Backend · pi-durable + SQLite
        │                                   │ GatewayHostClient
        └────────host service call──────────▼
                      execution gateway · local or SSH
```

客户端只到 ingress;ingress 检查身份并用自己的 service credential 访问 Backend,不外传客户端凭据或回传
Backend 的 `Set-Cookie`。文件、MCP、provider auth 可由 ingress 的主机 surface 回答。Backend 是唯一 durable
运行时与 SQLite writer;访问执行主机只走 `GatewayHostClient`,不自行拼 `/v1/*` 或 bearer 头。
没有多租户或 shell 沙箱:授予 bash 等于允许以 gateway 用户身份运行任意脚本。
见 [ADR 0001](adr/0001-single-authoritative-durable-runtime.md)。

Gateway file transports depend on `FilesystemServer` in `packages/gateway/src/filesystem.ts`. Construct
`LocalFilesystem` for this machine and `SshFilesystem` for SSH profiles. The shared positive contract tests use both
adapters, including a real loopback SSH helper session; adapter-specific resource and transport tests remain separate.

## Directory map

| 位置 | 职责 | 入口 |
| --- | --- | --- |
| `apps/web` | Vite Web 宿主、路由、Service Worker、安装清单 | `src/main.tsx`、`vite.config.ts`、`public/sw.js` |
| `apps/app` | Tauri 壳、OS 凭据库、窗口策略、原生保存与打包 | `src/main.tsx`、`src/connection.ts`、`src/save-host.ts`、`src-tauri/src/` |
| `packages/ui` | 两宿主共享工作台、投影、面板与纯规则 | `src/workbench.tsx`、`src/client.ts`、`src/lib/workbench-scope.ts`、`src/lib/workbench-selection.ts`、`src/components/AppShell.tsx` |
| `packages/session` | 快照、SSE、重连、控制与资源读取 | `src/browser.ts`、`src/agent-event-connection.ts`、`src/control.ts`、`src/resources.ts` |
| `packages/protocol` | 版本化帧、路径与类型 | `src/index.ts`、`src/navigation.ts`、`src/files.ts`、`src/gateway.ts` |
| `packages/gateway` | ingress、执行、文件、终端、SSH、MCP、provider 凭据 | `src/ingress/index.ts`、`src/client.ts`、`src/startup.ts`、`src/index.ts` |
| `apps/server` | 会话、任务、模型注册与 durable 执行语义 | `src/main.ts`、`src/server.ts`、`src/harness.ts` |
| `scripts` | dev、验证、文档/入口检查、只读部署检查 | `dev.mjs`、`verify.mjs`、`check-docs.mjs`、`check-entrypoints.mjs` |
| `deploy` | 服务端镜像与 Compose | [Container deployment](container-deployment.md) |
| `docs` | 当前指南、限定 revision/日期的证据、ADR | [索引](README.md) |

### `packages/ui/src`:宿主入口、面板与特性模块

纯规则、投影与客户端 API 放 `lib`,文件、聊天与 provider 模块各自成簇。测试与被测文件同目录,由包脚本递归枚举;单文件也可直接用 `node --test` 运行。

| 位置 | 放什么 |
| --- | --- |
| `src/workbench.tsx`、`src/client.ts`、`src/index.ts`、`src/host-router.tsx` | 挂载、连接与包入口,不进子目录 |
| `src/components` | React 面板;新面板放这里。格式专属的预览叶节点与面板同目录,文件名即格式(`FileViewer` 只选叶节点) |
| `src/hooks` | 需要 React 生命周期的采集与面板状态 |
| `src/lib` | 纯规则、投影、客户端 API、面板契约;无 React 的放这里,子目录只有 `lib/file`(文件面)、`lib/chat`(轮次模型与滚动)、`lib/provider`(凭据与登录面板契约)与 `lib/i18n` |
| `src/styles` | 全局样式 |

消息呈现同样按责任分叶:`components/MessageView.tsx` 只按 role 分派并持有 memo comparator,`AssistantMessageView` 管区块序列、流式 token 估计／tps 与 footer,`UserMessageView` 管提示泡泡与整段复制／分叉,`CustomMessageView`(含 compaction)管扩展消息,`BashExecutionView` 把用户指令复用成 tool call 呈现;区块本身归 `MessageTextBlocks`(含 deferred 全文)、`ThinkingBlockView`、`ToolCallBlockView`、`MessageDiffView`、`MessageImages`,token 估计与时间／模型名等纯规则在 `lib/token-estimate.ts`、`lib/message-display.ts`。`file-`、`chat-`、`provider-` 文件保留名字,收進對應特性目錄;文件預覽按格式分葉:`components/FileViewer.tsx` 只按协议判定格式并交给 `ImageFilePreview`、`MediaFilePreview`、`DocumentFilePreview` 或 `TextFilePreview`,后者再交给 `SourceFilePreview`、`DiffFilePreview`、`MarkdownFilePreview`;字串/换行/行号样式在 `file-preview-styles.ts`,来源行选取在 `file-source-selection.ts`。全部仍只经 `lib/file/file-seam.ts` 读字节;`lib/*` 通配 `exports` 与 `@hepi/ui/*` 路径映射继续解析嵌套路径。共享 MCP DTO 与纯导入解析器由 `@hepi/protocol` 导出,面板聚合行为归 Gateway ingress;调用端直接导入所有者,Gateway 不依赖 UI。其余小簇保留现有位置,下一批迁移依据见 [目录导航评审记录](../.scratch/repo-navigation-map/notes.md)。

### `apps/web/e2e`:共享工作台的验收,不是 Web 包的私有测试

`apps/web/src` 是挂载、路由适配与 PWA 的薄宿主;`apps/web/e2e` 的场景多数属于共享 `packages/ui`。`ux-` 前缀是历史标签,今天不区分"ux 与否"。

目录按主题分组,driver 与它独占的 `.fixture.tsx`/`.fixture.css` 放同一目录:

| 目录 | 覆盖 |
| --- | --- |
| `acceptance/` | `acceptance-stack.ts` 共享栈、`acceptance-release.test.ts`、Web+App 客户端验收、provider 连接验收、原生 App 验收 |
| `chat/` | 转写滚动、子对话恢复、跨会话引用、subtree 控制、token footer、提示整段复制 |
| `history/` | 历史 rail、键盘、scope、导航重试、可见 turn、`window-experiment` |
| `mcp-skills/` | MCP 验收与面板状态、扩展面板、skills 目标与 inventory race、delegate 定义 |
| `workbench-files/` | 文件面、文件失败、transfer、docx 预览、SSH Project、workbench scope |
| `terminal/` | terminal 关闭、fan-in、session |
| `auth-shell/` | capability/trust、可访问性收尾、panel/sidebar ingress、PWA offline、Web logout |

`apps/web/package.json` 的 `test:*` 脚本分别运行命名场景,但**没有** `test` 脚本,所以 `pnpm -r test` 到不了这里;Web `*.test.ts` 由 `pnpm test:web:unit` 覆盖。上一版的 33 个 Next driver 及死脚本已删除,覆盖缺口见 [migration status](migration-status.md#retired-next-browser-drivers-2026-10-21)。

## Test layout and TypeScript

测试统一使用 TypeScript:`*.test.ts` 由 Node test runner 执行,浏览器 driver、测试专用 helper 与进程 fixture 也使用 `.ts`。测试文件纳入 strict 类型检查;`pnpm typecheck` 检查全部 workspace 与根目录工具测试,`pnpm typecheck:scripts` 单独检查后者。

| 范围 | 位置 |
| --- | --- |
| 单模块的规则、投影、状态转换 | 与实现同目录,例如 `lib/file/file-save.test.ts` |
| package 公开契约、跨模块与真实进程集成 | 所属 package 的 `test/` |
| 浏览器用户旅程 | `apps/web/e2e/<主题>/`,driver 与独占 fixture 同目录 |
| 工具脚本 | `scripts/*.test.ts`,共享测试 helper 在 `scripts/testing/` |

位置依据验证边界,不依据是否有 I/O。公开契约测试保留在 `test/`;单模块测试随实现一起移动或删除。UI、App、Web、工具测试与完整验收递归枚举 `.test.ts`。Gateway/Backend 的日常脚本保留明确的确定性文件清单,新增或移动测试时同步更新清单;`test:acceptance` 递归覆盖 `src/` 与 `test/`。

## Client hosts and the shared workbench

`apps/web/src/main.tsx` 声明 Web 的同源 ingress、cookie、`conversationSource()` 与以 origin 命名的 profile。
App 壳从 OS 凭据库提供 `{profile, origin, token}` 到 `globalThis.__HEPI_CONNECTION__`,使用 bearer;凭据不进 URL
或构建产物。两者挂载同一 `packages/ui` 树。

`workbench.tsx` 并列读取 `/api/descriptor` 与 `/api/web-auth`,由 `admissionOf` 决定 admitted / sign-in / refused。
读不到 descriptor 不猜身份。`connectionIdentityOf`(`lib/connection-scope.ts`)按固定顺序百分号编码
`profile`、`backendId`、`accountScope` 并以 `|` 连接;generation 只做读栅栏,不属于身份。

每条连接创建一个 client,树以 scope 为 key;换连接重挂载,旧草稿、缓存、图片 lease 随旧 client 销毁。
`workbenchConnection`(`lib/workbench-scope.ts`)装配 `client/scope/files/api/drafts`;`drafts` 是该连接的草稿实例
(`lib/draft-store.ts` 的 `createDraftStore(scope)`),不存在渲染期安装的全局 scope;未挂载时调用
`useWorkbenchConnection()` 抛错。工作台读哪一条会话/草稿 composer 由 `lib/workbench-selection.ts` 的选择 store 唯一持有
(shell 与 sidebar 读同一 readout、发同一 intent),规则见 [Chat](chat.md#the-workbenchs-one-selection)。新面板放 `components`,纯规则放 `lib`,宿主事实才进 `WorkbenchHostConfig`。

**检查:** `pnpm --filter @hepi/ui test`、`pnpm test:web:unit`、`pnpm --filter @hepi/web typecheck`;
浏览器场景见 `apps/web/e2e/workbench-files/ux-workbench-scope.ts`。

## The connection client

`packages/ui/src/client.ts` 的 `createClient` 拥有一条连接的全部 I/O:SSE、read-block、执行侧资源 scope 与终止生命周期。
`request()` 统一 origin、bearer 与调用方/连接 abort;监听器直到 body 读完才释放。
`readJson()` 把非 2xx 转成带 status、Backend code、body 的 `WorkbenchRequestError`。
`dispose()` 中止请求、关闭 stream、释放资源与图片 lease;后续请求和晚到响应都按 connection closed 处理。

命名请求加在 `lib/conversation-api.ts` 或对应 `lib/*-api.ts`;组件不自行 `fetch`,共享层不拼相对 URL。
SSE reader 归 `packages/session`。**检查:** `src/client.test.ts`、`lib/conversation-api.http.test.ts`、
`lib/workspace-api.http.test.ts`。

## Client ingress: identity and routing

`packages/gateway/src/ingress/index.ts:createClientIngress` 是客户端监听器,与 Backend、执行监听器分开。

| 凭据 | 用途 |
| --- | --- |
| `HEPI_WEB_LOGIN_TOKEN` | 换取本入口的 `hepi-web-session` HttpOnly、SameSite=Strict cookie |
| 设备 bearer | 每请求经 Backend `POST /internal/credentials/verify` 验证;authority 不可达即拒绝 |
| `HEPI_INGRESS_SERVICE_TOKEN` | ingress 出站访问 Backend,不下发客户端 |
| 执行 token | 本入口不接受;`/v1` 与 `/v1/*` 直接 404 |

Web 身份命名为 `web:<sha256 前 32 位>`。路由由一个入口分派:

- `/api/file-index`、`/api/git/{status,diff}`、`/api/files/*` 由 `createFileSurface` 翻译。
- MCP/project-trust 交给 `ingress/mcp.ts`;provider auth 交给 `ingress/providers.ts`,调用本机 host service。
- `SETTINGS_ROUTES_NOT_SERVED` 的 5 条模型设置路由答 `501 {code:"unsupported"}`。
- 其余 `/api/*` 代理到 Backend:只转发 `accept/content-type/last-event-id/range`,另加 service bearer、
  已确认身份的 `x-hepi-client` 与配置的 `DEFAULT_HOST_HEADER`;客户端不选择 host。
- `backendRoute()` 只把 `sessions/:id/entries/:entryId/{text,thinking,tool-result-image}` 改写为 `conversations/...`。
- SSE/终端流每 1000 ms(`DEFAULT_REVOCATION_CHECK_INTERVAL_MS`)重查设备凭据;撤销断开响应,不停止 run。
  `close()` 中止所有附着响应。
- 仅配置 `HEPI_INGRESS_STATIC_DIR` 时服务静态页;非 `/api` 路径不代理。

Backend 资源路由加在 `apps/server/src/server.ts`;主机资源加在 ingress surface。
**检查:** `pnpm --filter @hepi/gateway test`、`pnpm --filter @hepi/web test:web-logout`、
`test:panel-ingress`、`test:client-acceptance`。配置见 [Client ingress](client-ingress.md)。

## The Backend: durable runtime and HTTP surface

`src/main.ts` 读环境后由 `openServerHarness()` 打开 store/registry,再由 `createBackendServer()` 起 HTTP。
配置包括 `HEPI_DB`、`HEPI_BIND_HOST`、`HEPI_AUTH_TOKEN`、`PORT`、`HEPI_GATEWAYS` 或
`HEPI_GATEWAY_URL/TOKEN/ID`、`HEPI_WORKSPACE_ID`、`HEPI_PROVIDER*`、`HEPI_CONFIG_SOURCE`、`HEPI_PROJECTS`、
`HEPI_SKILL_REPOSITORY`、`HEPI_DEVICE_CREDENTIALS`、`HEPI_HEARTBEAT_MS`、`HEPI_MCP_TOOLS`。
非 loopback 必须显式配置 auth token。一个部署一个 writer;未配置模型时不造默认,运行以 `no_model` 收束。

| 路由 | 所有者 / 用途 |
| --- | --- |
| `GET /api/descriptor` | `server.ts`:协议、身份、Backend/account scope、build、capabilities |
| `GET/POST /api/device-credentials`, `DELETE …/:id` | `device-credentials.ts`:只允许 Web 身份签发/列举/撤销 |
| `POST /internal/credentials/verify` | `server.ts`:ingress 身份核验 |
| `GET/POST /api/conversations`, `GET …/:id` | `conversation-operations.ts`、`catalogue-binding.ts`:目录、创建、relations/references/配置 |
| `GET …/:id/state`, `GET …/:id/events` | `history-window.ts`:快照与 SSE |
| `GET …/:id/submissions?requestId=` | `server.ts`:只读 durable 记录或 null |
| `POST …/:id/{messages,fork,abort,delegate,recovery,references}` | `conversation-input.ts`、`subtree-control.ts`、`subagents/`:输入、控制与关系 |
| `GET …/:id/{read,navigation,navigation/around}`, `…/entries/:entryId/{text,thinking,tool-result-image}` | `conversation-read.ts`、`conversation-navigation.ts`、`read-block.ts`:历史、窗口、延迟块 |
| `/api/terminal*`, `/api/files/{upload,upload-check,bytes}` | `terminal-relay.ts`、`file-relay.ts`:主机中继 |
| `/api/{workspaces,hosts,host/directories,projects,worktrees,workbench}` | `project-store.ts`、`server.ts`:执行目标与只读操作 |
| `/api/{models,models-config,extensions,agent-definitions,sidebar-state,search,skill-market/*}` | `model-config.ts`、`extension-selection.ts`、`skill-install.ts` 等 |

`ConversationOperations.spawn` 在一次 commit 中写 `pi.agent`、`hepi.workspace`、relations、references 与会话作用域
request 索引;稳定 `requestId` 重放返回原会话。调用方解析 Agent Definition/context strategy。
创建者、显示父、原生 fork 源、任务所有者是四条独立关系,见 [ADR 0007](adr/0007-lifecycle-facts-one-projection.md)。

## Submission, stream, read and recovery

提交带稳定 `requestId`,会话内只准入一次。`whenBusy` 选 steer/followUp;`queueOnly` 入队不唤醒;图片是同一次
准入的原生 content block。SSE baseline 为 `snapshot`;后续 `state` 带 `baseRevision/appended`,标量全量。
`submission` 只通知迁移、不保留或重放;`resync_required` 表示漏帧;`state_oversize` 是具名拒绝。
`HEARTBEAT_FRAME = ":\n\n"`,默认 30 s,`HEPI_HEARTBEAT_MS=0` 关闭;ingress 逐字节透传。

快照 `submissions` 只含等待项。客户端对等待项读取 `GET …/submissions?requestId=`,查 durable 结果而不重发,
见 [ADR 0006](adr/0006-durable-submission-lifecycle.md)。UI 的唯一折叠在 `lib/lifecycle-projection.ts`;
采集在 `lifecycle-acquisition.ts`,存储在 `lifecycle-store.ts`。对话的 UI I/O 集中在
`lib/conversation-session.ts`:surface 持有的 stream reader(经 shell 每对话一个 source join)、single-flight 读取
(forced 读不共用)、唯一准入路径(立即 send、steer、follow-up)、by-id lookup、Backend 自身 reload 与释放。它不做
排序、不持 timer/retry queue/socket;折叠决定答案含义,`hooks/useAgentSession.ts` 呈现并执行 fold 请求。同对话 reload
是读取与重新取得资源,不是新 attachment:聊天保留其树、其 stream 与读者位置,Shell 不再为此提供 mount key。
该操作只有一个 owner(`reloadResources`):Settings › General 只声明配置已变、await 该注册的 reload,不自行发请求;
`/reload` 命令调用同一函数。通知只声称**读取**已确立的事实,而读取结果是带类型的 `ConversationReadOutcome`
(`accepted` / `refused` / `missing` / `failed`+`ReadFailure` / `cancelled` / `superseded`),不是可空值。`refused` 即读取
到此结束:不会为一个 fold 已拒绝的 window 再发 agent-state 读取,否则调用方会据其答案恢复 run 或声称 reload。路由本身
被拒绝时由该操作报为 `failed`,既不会向 await 的调用方抛出未处理 rejection,也不会为一个没发生的变更再发读取;但仅在
发起它的 connection 仍是当前 connection 时——切换后到达的拒绝为 `superseded`,不发声。一次 reload 只发一条通知:
`/reload` 只是同一操作的调用方,不重复陈述其结果。读取另按**发起它的 connection** 设栅栏(不只 conversation id,两个 connection
可有同一 id):切换后到达的 window、`not_found` 或 failure 一律拒绝,不写到新 connection 的 surface。
已被接受的 readout(accepted window、其前方的 older prefix、该 window 的 pagination claim)由
`lib/conversation-readout.ts` 在同一个接受步骤发布:prefix 依共享 `decidePrefix` 与 readout 已持有的上一个 window
同步决定,不再由 React effect 追赶。metadata(stats、history token/head、leaf、display model)留在被接受的 payload 上,
stream-local `SessionState` 仍是独立的传输连续性状态。

当前安装工具未声明安全重放;崩溃后的 `write/edit/bash` 意图为 interrupted。MCP 注册 `replay:"unsafe"`。
Gateway ledger 对同一 `(gateway, workspace, callId)` 不二次执行;丢答案报 `outcome_unknown` 并保留已花掉的 ID,
timeout/aborted/明确拒绝保留各自名字。文件写无 call ID/journal,结果丢失无法判定;读可幂等重试。
这不承诺 exactly-once 分布式执行,见 [Execution](architecture.md#execution)。

新帧按 protocol → Backend 投影 → session 折叠 → UI 改;恢复语义归 durable seam。
**检查:** server 的 `durable-submissions/delta-frames/frame-size/conversation-heartbeat`、`acceptance-recovery`;Web 的
`useAgentSession.lifecycle`、`conversation-session`、`completion-delivery` 与 `lifecycle-projection`;浏览器
`test:conversation-lifetime`(reload 不重建、未知提交只 lookup、背景 answer 只通知一次)。曾覆盖同一路径的 `test:submission-recovery` 浏览器驱动依赖已退役的 Next 构建,已删除。

## History: bounded window, outline, fork, compaction

| 常量 | 值 / 所有者 |
| --- | --- |
| `VISIBLE_WINDOW` | 50 条 user/assistant/compaction 消息;`apps/server/src/history-window.ts` |
| `FRAME_TARGET_BYTES` | 512 KiB 目标;同上 |
| `FRAME_LIMIT_BYTES` | 1 MiB − 64 KiB 硬界,超出具名拒绝;同上 |
| `NAVIGATION_TARGET_MAX_RAW_ENTRIES` | 300 条目标扫描上限;`packages/protocol/src/navigation.ts` |

`WindowProjector.advance` 只增量接受连续增长端追加(`p`、`path.length===1`、`op[3]===0`);head、截断、替换、
重排都重算。数量/raw cap 从最旧端整条裁到最短后缀;字节目标也裁旧条目,但保留最后一条可投影消息。
单条仍超目标则交硬界拒绝;若只剩记账条目,`#widenToProjectable` 回退最近可见边界,范围内无可见条目则整体
返回且 `hasMore=false`。规则只在 `history-window.ts`,下游不再投影。

`navigation` 从 fork-aware 已提交历史分页列用户锚点,覆盖 compaction 前缀与 fork 继承前缀;坐标包含 conversation、
history scope、entry。`navigation/around` 共用窗口投影并由 snapshot 固定,最多读 300 原始条目。成员性归 runtime:
继承条目可读,兄弟分支是 missing。路由/查询归 `conversation-navigation.ts` 与 `conversation-read.ts`。

`useHistoryNavigation.ts` 持大纲与目标状态;`lib/history-navigation.ts` 协调一次请求、最多一次读、恰好一次落地。
`landWindow` 经 `lib/conversation-readout.ts` 的 `landHistory` 合入 readout 的前缀并按 Backend id 去重;结果为 held / missing / stale-snapshot / wrong-scope /
malformed / cancelled / deferred-busy / error。Fork 走同一 spawn 接缝,继承历史、asOf 配置与文档,同时写自己的
身份关系。Compaction/reset 移动 head 时,客户端按 `historyHead` 结束旧窗口。

**检查:** server 的 `history-window/conversation-navigation/conversation-read/conversation-fork-source.test.ts`;
Web 的 `test:history-rail`、`test:navigation-retry`、`test:visible-turns`、`test:history-scope`（`test:windowed-transcript` 已随 Next 驱动删除）。

## Files: streaming, limits, save

`packages/gateway/src/files-surface.ts:createFileSurface` 在 ingress 翻译文件操作,用 service credential 调 Backend
路由;字节归执行主机。

| 界限 | 值 / 所有者 |
| --- | --- |
| 上传批次 | 100 MiB 合计;`multipart.ts:MAX_UPLOAD_BATCH_BYTES`,ingress `uploadBatchBytes` 可覆盖 |
| 文本预览 | 本地/SSH 均 200 KiB;`workbench/app-store-files.ts`、`workbench/ssh-files.ts` |
| 图片 / DOCX 预览 | 各 10 MiB;`packages/protocol/src/files.ts` |
| App 保存 IPC slice | 1 MiB;`packages/ui/src/lib/file/file-save.ts:SAVE_CHUNK_BYTES` |

协议的 `TEXT_PREVIEW_MAX_BYTES=256 KiB` 仅格式常量,不参与执行。`readUploadParts` 用 busboy 流式转发,
`totalBytes` 同样限制 chunked body;冲突策略 error/overwrite/skip 在写前检查。超界先拒绝再 `drainRequest`,
排空再超界就断开。`?type=download` 流式转发完整字节与 length/range 头,不受预览上限限制。
watch/preview/allow-link 请求类型具名不支持。

Web 下载由浏览器写盘;App 依次 `app_save_choose/begin/append/finish/abort`,按 1 MiB await 每片。取消或失败
删除本次部分文件,源文件不动,不重试。原生保存整块几十 MiB 曾测得约 3 GB RSS,分片约 224–225 MB;
测量与壳契约见 [App README](../apps/app/README.md#saving-a-file)。新操作归 file surface 与 Backend relay。

**检查:** gateway 的 `files-surface/multipart.test.ts`;server 的 `file-relay/files-transfer.test.ts`;
Web 的 `test:files-transfer`、`test:file-surfaces`、`test:file-failures`、`test:docx-preview`。

## Terminal: one stream for the page

`lib/terminal-fan-in.ts` 用一条 fetch 流服务所有标签,避免占满浏览器约 6 条 HTTP/1.1 连接。Web 带 cookie,
App 带 bearer,均不放 URL;cursor 按标签保存,重连续读不重放。
Backend `terminal-relay.ts` 每请求按 cwd 解析 workspace,把 `/api/terminal/events?tabs=<id>|<cwd>|<after>,...`
按 host 分组 fanIn 再合并;不可解析的标签返回可行动状态。卸载标签释放附着。

Gateway `terminal.ts` 持 PTY 生命周期:尾部保留 128 KiB(`TERMINAL_REPLAY_CHARS`),无人附着保留 120 s
(`TERMINAL_RECONNECT_MS`),单连接待写预算 4 MiB(`TERMINAL_STREAM_BUDGET_BYTES`),超界结束并按 cursor 重连。
心跳默认 30 s(`TERMINAL_HEARTBEAT_MS`,0 关闭),注释帧不写 `id:`。

**检查:** gateway 的 `terminal-launcher/terminal-stream-budget.test.ts`;server 的
`terminal-relay/terminal-browser.test.ts`;Web 的 `test:terminal-fan-in`、`test:terminal-session`、`test:terminal-close`。

## MCP: host-owned, backend-invoked

MCP 的配置、凭据、OAuth 与子进程归 Web origin 主机账号,不归 Backend。

1. Gateway `mcp/config.ts` 管 `mcp.json`(1 MiB)与项目信任;`listing.ts` 启动、列工具、关闭。
   `McpHostService` 的测试期限 30 s,登录 TTL 5 min;登录使用粘贴回调。
2. `ingress/mcp.ts` 回答 `/api/mcp*` 与 `/api/project-trust`,核对 workspace 的 gateway id;
   无本机服务答 `mcp_unavailable`。
3. Backend `mcp-grants.ts` durable 记录会话授予的身份与当时 descriptor。`HEPI_MCP_TOOLS` 只是声明,不授予;
   含 command/args/env/url/headers/auth 等主机键的声明在启动时拒绝。
4. `McpToolBridge` 注册 deferred、`replay:"unsafe"` 工具,由 `pi.agent.modelTools` 选择。Gateway 每调用重新
   核对信任/开启/暴露/工具存在,并发上限 8。Backend 不保平行信任表、不读配置或凭据、不起 MCP 进程。

主机关闭测试进程、限制调用并发、回收过期登录;撤销由 ingress `revokeLoginFlows` 取消流程。SSH gateway 不提供
MCP。主机能力改 `mcp/`,路由改 `ingress/mcp.ts`,授予改 `mcp-grants.ts/mcp-conversation-tools.ts`,面板改 UI。

**检查:** gateway 的 `mcp.test.ts`、`mcp-{invocation,list-tools,import-resolution}.test.ts`;server 的
`mcp-{declarations,grants,conversation-tools}.test.ts`;Web 的 `test:mcp-tool-states`、`test:mcp-workflow`、`test:mcp-acceptance`。
操作与限制见 [MCP on the Web host](mcp-on-the-web-host.md)。

## Providers: catalog versus credentials

Backend 拥有模型目录、选择与请求语义;host Gateway 执行 provider 认证并读写本机凭据。

| Backend 模式 | 来源 |
| --- | --- |
| 默认环境模式 | `HEPI_PROVIDER/HEPI_MODEL/HEPI_PROVIDER_BASE_URL/HEPI_PROVIDER_API_KEY`,凭据只在内存,不读 auth.json |
| `HEPI_CONFIG_SOURCE=pi` | Backend 主机的 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`,含 auth.json/models.json;见 [Pi config](pi-config.md) |

Provider 目录与认证语义用 `@earendil-works/pi-ai:builtinProviders()`,不维护第二份列表或认证协议。
Gateway `provider-auth.ts/provider-login.ts/provider-credential-store.ts` 写主机账号的 `auth.json`:与 Pi CLI
`FileAuthStorageBackend` 共用 proper-lockfile,同目录 rename,每次设目录 0700/文件 0600。缺文件在锁内独占
创建且容忍已存在,不截断其他写者。ingress 暴露 `/api/auth/providers`、`api-key/:id`、`login/:id`
(start/poll/answer/cancel)、`logout/:id`。列举区分 provider 解析的 configured 与本机 storedType,只显示
maskedHint;写操作不回明文。

**ADR 0008 分歧仍存在:**接受的决策把 provider auth 放在 Backend,交付树由 host Gateway 执行;Backend 只读
自己配置的账号。Web 主机登录不自动配置另一台 Backend。正文是目标,同文件 2026-10-20 实现注记是现状,
见 [ADR 0008](adr/0008-gateway-as-capability-broker.md)。模型改 Backend,凭据改 gateway,面板改
`lib/provider/provider-auth.ts/components/EnabledModelsSection.tsx`。

**检查:** server 的 `provider-{config,availability}.test.ts`、`models-config.test.ts`;gateway 的
`provider-credential-store.test.ts`;UI 的 `provider-auth.test.ts`;Web 的 `test:provider-acceptance`、
`test:models-config`。配置见 [Providers](providers.md),付费 smoke 见 [Verification](verification.md)。

## Gateway host client and execution

Backend 每次主机调用由已解析 binding 构造 `GatewayHostClient`(`packages/gateway/src/client.ts`):
`process`(execute/abort)、`control`(workspaces/worktrees/workbench/MCP/installs)、`files`、`terminal`。
`host-client.ts:GatewayHostTransport` 统一 origin、bearer、路由上界、abort、响应校验与错误:
gateway_offline / timeout / aborted / unauthorized / protocol_error / operation_failed(status/code) / outcome_unknown。
不重试可能已执行的 mutation。

`ExecutionHostEnv.forCall` 把 conversation/task/call 变成 `<conversation>:<task>:<call>#n`。同身份重复调用由
ledger 作答;同 ID 不同请求拒绝;重启时 admitted/dispatched 调用报 outcome-unknown。无 call scope 用随机 ID,
不宣称去重。一个 gateway 进程一个 call journal。

`startup.ts` 唯一装配 registry、journal、SSH runner/master、surface、loopback 监听与关闭顺序。local/SSH
互斥;SSH 从 profile 播种 `remote-<profile>` registry,不提供 MCP。环境 `main.ts` 与打包 CLI 只读各自配置并处理
信号。新主机能力加 capability、`/v1` 路由与 Backend relay;Backend 生产代码不拼执行 HTTP。

**检查:** `pnpm --filter @hepi/gateway test`(host-client/host-files/host-terminal/process/control)、
`pnpm --filter @hepi/gateway test:acceptance`(execution/ingress);server 的
`gateway-client-boundary/terminal-relay/file-relay.test.ts`。

## Where a change belongs

| 改动 | 落点 | 验证 |
| --- | --- | --- |
| 客户端 API | Backend `server.ts` + UI `lib/*-api.ts` | `*.http.test.ts` |
| 本机能力 | gateway capability + ingress surface 或 Backend relay | `host-*.test.ts`、boundary test |
| gateway 传输族 framing(文件 payload、终端流) | `packages/gateway/src/transport/{file-payload,terminal}.ts`;入口只保留路由识别、凭证校验与未知路由 | `file-transfer`、`terminal`、`terminal-stream-budget` 套件,以及同目录的纯解析测试 |
| 帧/字段 | protocol → Backend → session → UI | delta-frames、frame-size |
| durable 事实/恢复 | `conversation-operations.ts` | `conversation-*.test.ts` |
| 面板/交互 | UI `components` + `lib` | `pnpm test:web:unit`、对应 e2e |
| composer 編輯行為(草稿、補全、鍵盤、附件) | `packages/ui/src/components/composer/`;畫面本身留在 `ChatInput.tsx` | `pnpm --filter @hepi/ui test`、`pnpm --filter @hepi/web test:composer-interaction` |
| 开发脚本 | `scripts/` | `pnpm test:scripts` |

## Verification record

原手册在 `docs/developer-handbook`、base `2b1cdf2` 的文档检查记录为:439 Markdown、0 broken links/漏索引;
157 entry files、0 known/new missing,两命令退出码均 0。这是该次文档交付的记录,不证明产品测试或线上健康。
当前命令与基线见 [Verification](verification.md);检查结果须绑定实际 revision、退出码与 raw log。
线上状态按 [Runbook](deployment-runbook.md) 第 1 阶段检查,主机说明见
[Workstation](local-tailscale-deployment.md#current-local-backend) 与 [Oracle](oracle-tailscale-deployment.md)。
