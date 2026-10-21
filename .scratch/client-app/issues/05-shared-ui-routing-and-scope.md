# 05 — Web/App 共享会话 UI、路由与连接作用域

Type: implementation
Status: resolved for the shared surface (workbench, both hosts and the native conversation-API cutover integrated at
`b0a9f62`; ticket 16's 2026-10-19 closeout then drove the App's own journey on the packaged shell at `ad225f8`, 27 checks,
and the native journey on the published release, 26 checks). Platform evidence stays 04/15's and cross-host release
acceptance stays 16's, whose named limits are debug-only native numbers and a loopback sshd standing in for a second host.
Blocked by: [04](./04-tauri-platform-spike.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

用户在 Web/App 使用同一 React 工作台，切连接后不会混入旧数据。

## Scope

按已工作的会话切片抽共享组件/hooks/投影，Web 与 Tauri 仅组装宿主能力和连接。Declarative BrowserRouter/HashRouter 共用逻辑 query；按新设计同步调整 session/cwd 调用者，无旧链接兼容要求。按确认的连接身份构造 client/cache/draft owner，维护现有 acquisition generation 与 lifecycle authority；导入别名、CSS/Tailwind、字体和静态资产随共享切片可独立构建。

client 的命名 domain 操作收口认证、URL、取消、资源与幂等 dispose；复用现有会话 hook/纯投影及 AgentEventConnection，各保留单一 owner。原始 transport seam 留在内部；不另造 controller/view/status。设计依据与候选成本见[deep-module 审查](../review-notes.md)。

## Acceptance

- [ ] Web/App 两端打开同一会话并发送，首开/query/返回/刷新或重开正确；HashRouter 参数来自 router location。
  —— Web 成立；App 的会话路径已迁到 Backend 原生 `/api/conversations…`（见下「会话 API 切换」与「Review 233 fixes」）并随本票
  合入集成 tip，但真实 Tauri/WebKitGTK 上的开/发/刷新/重开与跨端同会话幂等仍属票据 04/16 的证据，因此原「两端」结论
  不成立。本票证明的是协议、公开 seam 与 Node 内真实 HTTP/SSE 行为，不是原生壳。
- [x] 不同 profile 使用相同 session id/cwd，延迟旧响应不污染新页面；订阅/请求/blob/通知 interest 随切换清理。
- [x] App bundle 无 Next 服务端、Node builtin、完整 coding-agent runtime 与内部 token；共享入口在 Next 之外可构建。
- [x] 一份 lifecycle/durable projection，复用既有排序与恢复；移动实现时同步更新调用者并删除旧路径，不新建兼容 re-export。
- [x] profile/Backend/身份归属与连接 generation 不混用会话 acquisition 时钟；dispose 不停止 run，释放一个调用者不关闭其他调用者的共享流。
- [x] 会话加载以同一已接纳 snapshot 更新 transcript/composer，去掉 includeState 的重复同类 snapshot 请求；保留迟到拒绝、resync 与必要独立刷新。

## Verification

双入口会话烟测 + profile 切换竞态 + 路由行为；复用现有投影测试并检查 bundle 依赖边界。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Review notes

涉及 G6，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。

## Answer

实现于 `impl/client-app-05`（base `integration/client-app` `19f5a54`，最终 revision 见下表）。行为写在
[Client ingress 的共享工作台一节](../../../docs/client-ingress.md#the-shared-workbench-and-whose-state-a-page-holds)。

### 现在可用的行为

**一份工作台，两个宿主只组装差异。** `apps/web/components`、`hooks`、`lib` 的 React 切片整体迁到 `packages/ui/src`
（`@hepi/ui`），两端口都挂同一个 `Workbench`。宿主只声明四件事，其余全在下面共用：history 模式、入口 origin、
凭证形态、构建产物。Web 是 `BrowserRouter` + 同源 cookie + `apps/web`（Vite 静态）；App 是 `HashRouter` +
配置的 Gateway origin + 设备 bearer + `apps/app`（Vite，装进壳）。

**一份逻辑 query。** `next/navigation` 从共享切片里消失。`lib/navigation.ts` 只声明 `location.search` 与
replace-navigate，`host-router.tsx` 是唯一知道有 router 的地方，把它接到 `useLocation`/`useNavigate`。工作台只写
`?session=`/`?cwd=` 这样的 search 串，从不拼 path 或 `#`，也从不读 `window.location` —— 后者在 App 里指向 bundle
自己的地址。session/cwd 的调用者按新设计同步改完，没有保留旧链接兼容。

**一份连接作用域。** `client.ts` 按连接创建，持有该连接唯一的 `AgentEventConnection` 与一个 resource reader；
`lib/connection-scope.ts` 把 profile + Backend id + account scope 拼成不透明 key。draft、remembered view、staged
turn 三个 store 都以它为前缀：同一 session id 在两条连接上是两个 key，切换连接从空开始，不导入上一作用域的任何值。
`dispose` 幂等，关该连接的流、撤销 blob、拒绝后续请求，但不停止 run，也不关别的调用者的共享流。连接 generation
与 acquisition generation 各守其职，没有合并成一个时钟。

**一份 lifecycle/durable projection。** 迁移只搬位置：`lifecycle-projection`、`durable-projection`、
`completion-delivery` 及其排序/恢复规则原样进共享包，调用者同步改到新路径，没有新 controller/view/status，也没有
兼容 re-export。

**一次加载一份 snapshot。** `loadSession(sid, includeState)` 不再在读会话后再读 `:id/state`：两者回答同一个 native
snapshot，所以 composer 字段从**已接纳**的那份 payload 投影（`applyReadAgentState`，走同一个 writer 和同一道
fence）。被 fold 拒绝的读仍会独立读一次 state —— 被拒的窗口不是会话当前的 composer 事实，这与 resync 取新读同源。

### 受测 seam

| 测试 | 断言 |
| --- | --- |
| `packages/ui/src/lib/navigation.test.mjs`（3） | React Router 自己的 `BrowserHistory` 与 `HashHistory` 在同一份 document 上给出同一个逻辑 query；adapter 只写 search（带 `replace`），从不写 path/`#`；工作台读的是 router location 而不是页面地址 |
| `packages/ui/src/lib/connection-scope.test.mjs`（4） | profile/Backend/account 三者任一变化即不同 scope；含分隔符的 part 不能冒充另一 scope；缺身份的 descriptor 被拒绝而不是塌成一个共享 scope |
| `packages/ui/src/lib/session-view-cache.test.mjs`（3） | 同 session id 在两条连接上是两份视图，删除一份不动另一份；LRU/字节预算仍成立 |
| `packages/ui/src/lib/draft-store.test.mjs`（7） | 切连接后 composer 为空、切回仍是自己那份；storage entry 名带 scope，另一 scope 的 entry 不会被采纳；配额拒绝、逐键写、hydration 语义不变 |
| `packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs`（17） | 一次加载只发一次会话读、0 次 `/state`，transcript 与 composer 同源于那份答案；被拒的读仍取新 state；既有生命周期/恢复/迟到拒绝全部保持 |
| `apps/app/test/bundle-boundary.test.mjs`（2） | App bundle 的真实模块图里没有 Next、没有 Node builtin、没有 coding-agent runtime、没有 `HEPI_AUTH_TOKEN`/`serviceToken`；挂 `HashRouter` 且无 service worker |
| `apps/web/e2e/ux-workbench-scope.mjs`（16 checks，真实 Chromium） | 两条连接共享 session id：draft/view 互不可见、切回各归各；blob lease 在 dispose 后不可解析、被 dispose 的 client 拒绝后续请求、另一条连接与它的 blob 不受影响；`?session=`/`?cwd=` 来自 router location |

### 命令与结果

全部在同一 revision 上跑，log 在 `.dev/verify/t05-final/`：

| 检查 | 命令 | exit | log |
| --- | --- | --- | --- |
| 全 workspace typecheck | `pnpm -r typecheck` | 0 | `typecheck.log` |
| 共享工作台单测（116） | `pnpm --filter @hepi/ui test` | 0 | `ui-test.log` |
| App bundle 边界（2） | `node --test apps/app/test/bundle-boundary.test.mjs` | 0 | `bundle-boundary.log` |
| 浏览器 scope/路由烟测（16 checks） | `node apps/web/e2e/ux-workbench-scope.mjs` | 0 | `workbench-scope.log` |
| App 静态构建 | `pnpm --filter @hepi/app build` | 0 | `app-build.log` |
| Web 静态构建 | `pnpm --filter @hepi/web build` | 0 | `web-build.log` |
| Web 单测（46） | `node scripts/test-web-unit.mjs` | 0 | `web-unit.log` |
| 选定检查 | `pnpm verify:changed --base=integration/client-app` | 见下 | `verify-changed.log` |

`verify:changed`（revision `46bbd1f`，clean tree）里 typecheck / workspace-tests / web-unit / script-tests /
check-entrypoints 全部 0；`check-docs` exit 1，12 条断链**全部**是本工作树缺 git-ignored `.dev`/`.pi` 目录造成的既有
断链，指向本票改动文件的 0 条（`node scripts/check-docs.mjs | grep -v '\.dev/\|\.pi/'` 为空）。
`check-entrypoints` 的 2 个 `KNOWN-MISSING`（`e2e/terminal.mjs`、`e2e/run.mjs`）是本票之前就记录的，本票未触碰。

### 审查修正（2026-10-17）

分支 `fix/client-app-05-host-io`（base `integration/client-app` `47ec8f0`）：代码 `693f525`、测试 `d472f8a`、
文档记录与 lock 整理在其上（本分支 tip，clean tree）。四条审查发现
全部按 [review policy](../../../docs/agents/review-policy.md) 判为 `fix`：触发器都是普通用法（App 打开任意会话、切换
profile），证据都在本票自己的源码里，影响是工作流不可用或跨连接污染。原实现只把组件搬进共享包，仍沿用被替换的 Next
BFF 的到达方式，因此「Web/App 同一会话」只在 Web 页成立。

| 发现 | 触发器与证据 | 影响 | 处置 |
| --- | --- | --- | --- |
| descriptor / 会话目录 / 打开 / 读取 / 提交 / 刷新 / cwd 校验用相对全局 `fetch` | `AppShell`、`useAgentSession`、`SessionSidebar`、`agent-client` 里的相对路径；App 的 document origin 是 bundle | App 打不开会话、读不到目录、提交不到 Gateway，且不带设备 bearer | `fix`：全部改走连接的 client（origin + credential + disposed 拒绝） |
| 流与 completion 用硬编码 `cookieBffSource()`，且 CompletionDelivery 自建第二个 `AgentEventConnection` | `workbench.tsx` 的 `?? cookieBffSource()`、`AppShell` 的 `createSource: cookieBffSource()` | App 的流打到 bundle origin 且无 bearer；同一会话两条 socket，连接预算按一条算 | `fix`：host 声明自己的 source（Web 同源 cookie、App Gateway origin + bearer）；registry 改为读 client 的**同一个** `AgentEventConnection` |
| CompletionDelivery 订阅不随 AppShell 卸载/profile 切换关闭 | `AppShell` 只用 ref 创建 registry，无 cleanup；registry 从不 `close()` | 切换后旧连接的 watch 继续持有流，通知仍来自旧连接 | `fix`：挂载配对 `open()`、卸载 `close()`；`close` 只释放自己的 reader，不关共享 socket |
| ChatInput 在新连接 scope 安装前读草稿 | scope 在 `Workbench` 的 effect 里安装，而 effect 自叶向根执行，composer 的 layout effect 先跑 | 新连接 composer 采纳旧连接的未发送文本，并把它写进新 scope | `fix`：scope 在 composition root 的 render 中安装；composer 只在 store 已安装为自己的连接时读写 |

### 修正后的验证

全部在代码+测试 revision `d472f8a`（并在本分支 tip 上重跑，结果相同）的 clean tree 上跑，log 在
`.dev/verify/t05-host-io/` 与 `.dev/verify/2026-10-17T21-46-55-100-verify-changed/`：

| 检查 | 命令 | exit | log |
| --- | --- | --- | --- |
| 连接 seam（2：origin/bearer/拒绝/dispose + 共享流与 close 语义） | `node --test packages/ui/src/client.test.mjs` | 0 | `client.log` |
| App 宿主配置与 bundle 边界（3） | `node --test apps/app/test/host-config.test.mjs apps/app/test/bundle-boundary.test.mjs` | 0 | `app-tests.log` |
| 共享工作台单测（120） | `pnpm --filter @hepi/ui test` | 0 | `ui-test.log` |
| 浏览器 scope/路由烟测（16 checks） | `node apps/web/e2e/ux-workbench-scope.mjs` | 0 | `workbench-scope.log` |
| App / Web 静态构建 | `pnpm --filter @hepi/app build`、`pnpm --filter @hepi/web build` | 0 | `app-build.log`、`web-build.log` |
| Web 单测（43） | `node scripts/test-web-unit.mjs` | 0 | `web-unit.log` |
| 选定检查 | `pnpm verify:changed --base=integration/client-app` | 见下 | `verify-changed.out` |

`verify:changed` 里 workspace-typecheck / workspace-tests / web-unit / script-tests / check-entrypoints 全部 0；
`check-docs` exit 1，12 条断链仍全部是 git-ignored `.dev`/`.pi` 目标的既有残留（指向本票改动文件的 0 条），与本票原本记录一致。

### 修正的范围边界（未动的直接 `fetch`）

本票只把「同一会话工作流」搬上连接；以下仍用相对 `fetch`，属各自票据，未在本票改动：

| 路由 | 文件 | 归属 |
| --- | --- | --- |
| `/api/files/*`、`/api/file-index`、`/api/git/{status,diff}`、上传 | `FileExplorer`、`FileViewer`、`ChatInput` | 08 |
| 历史文本/图片读块、`/api/sessions/:id/{read,info,entries}` | `lib/deferred-text.ts`、`MessageView`、`RawHistoryPanel` | 07 |
| `/api/sessions`（PATCH/DELETE/fork/search）、`/api/projects`、`/api/worktrees`、`/api/home`、`/api/default-cwd`、`/api/sessions/ui-state` | `SessionSidebar`、`SessionSearch`、`useSessionUiState`、`NewProjectDialog` | 06 |
| `/api/project-trust`、delegate/fork 相关 | `AppShell`、`ProjectTrustDialog`、`lib/delegate-client.ts`、`QuickDelegatePanel` | 10 |
| `/api/models`、`/api/models/default`、`/api/models-config`、`/api/auth/*`、`/api/tools/settings`、`/api/web-auth`、provider-usage | `useAgentSession`、`ModelsConfig`、`EnabledModelsSection`、`SettingsPanel`、`ProviderUsageSummary`、`lib/capability-availability.ts` | 11 |
| `/api/skills`、`/api/skill-market/*`、`/api/agent-definitions` | `SkillsConfig`、`ChatInput`、`AgentsConfig` | 12 |
| `/api/mcp*` | `McpConfig`、`mcp-config-helpers.ts`、`mcp-sign-in-helpers.ts` | 13 |
| `/api/terminal*` | `lib/terminal-client.ts` | 09 |
| `/api/app-update`、push 原型、`/api/durable-login` | `ChatWindow`、`lib/push-client.ts`、`DurableLogin` | 14 / 17 |

一条接口事实（未改，属入口/票据 03/06/16）：Gateway client ingress 只把 `/api/sessions/:id/entries/...` 重写到 Backend
的 `/api/conversations/...`，其余 `/api/*` 原样转发，而 Backend 的原生会话契约是 `/api/conversations/...`；Web 页今天仍由
Next BFF 提供 `/api/sessions/...` 与 `/api/agent/...`。本次修正让两端都经连接的 origin+credential 提出请求（App 不再打到
bundle origin，流带 bearer），但**路径词汇**与响应形状的切换仍属票据 03/06 的切片与票据 16 的入口切换：在 App 上
`GET /api/sessions`、`POST /api/agent/:id` 这些路径会被 ingress 原样转发给 Backend 而 404。本票未改路由表，也未动
ingress；该项作为剩余边界记录，不在本票实现。

### 未做/留给后续

- **不动部署。** Web/App 产物已能构建，但入口切换、静态服务与 `/api` fallback 属票据 15/16；本票没有启动或停止任何服务。
- **不实现票据 11 的 settings cache 与 default-model gating。** 那条分支的 `@hepi/session/settings` 拥有
  `connectionScopeOf` 与 `ScopedCache`；本票的 `connectionIdentityOf` 从同一个 descriptor 的两个同一字段派生
  `backendId`/`accountScope`，两处 scope 因此逐字一致，合入时是一次调用替换而不是迁移。`models-cache` 仍是 Web 本地
  文件，等 11 合入后按它的 seam 接入。
- **P2（流内 JSON 往返）与 P5（渲染成本）仍未测量**，本票没有动 transport 的字符串桥，也没有重写渲染结构。
- **未在真实 Tauri/WebKitGTK 上验证**（票据 04 的 CLI/SDK 证据另记）；本票证明的是协议、公开 seam 与浏览器行为。

### 已知记录项（非阻塞）

- 共享包内所有相对 import 保持仓库原有的无扩展名写法；两个宿主 tsconfig 打开了 `allowImportingTsExtensions`，
  因为 `packages/session`/`packages/protocol` 之间用的是显式 `.ts`（NodeNext）。
- `packages/ui` 只导出两个宿主真正需要的名字（`workbench`、`host-router`、`client`、`styles/*`）；其余是包的内部
  实现，宿主按名导入会被 exports 挡住。

### The conversation API cutover (2026-10-17, scout-223)

**确认的 404 证据。** 共享工作台在两端都向 `/api/sessions…` 与 `/api/agent…` 提问。Gateway client ingress 只把
`/api/sessions/:id/entries/:entryId/{text,thinking,tool-result-image}` 重写到 Backend，其余 `/api/*` 原样转发；Backend 的原生
会话契约是 `/api/conversations…`，所以 App（document origin 是 bundle，请求打到配置的 Gateway origin）在
`GET /api/sessions`、`GET /api/agent/:id/events`、`GET /api/agent/running` 上收到 Backend 的 `404 {code:"not_found"}`。
Web 页此前仍由 Next BFF 提供这些路径，所以缺陷只在 App 上显形。票据 10 已明确把旧 React 消费者划归本票。

**本次改动（实现，不新增 Gateway/Backend 路由）。** 主会话 list/open/read/history、create/send/control、requestId 提交查询/
恢复与会话事件流从 Next BFF 词汇迁到 Backend 原生 `/api/conversations…`，写入侧复用既有 `@hepi/session/control`：

| 关注点 | 现在的位置 | 契约 |
| --- | --- | --- |
| 会话 API 收口 | `packages/ui/src/lib/conversation-api.ts`（`createConversationApi`） | list/running/search/create/read/open/history/submission/settings/commands/reload/rawRead/autoName，全部经连接的 `client`；`control(id)` 返回 `@hepi/session/control` |
| catalogue 投影 | `packages/ui/src/lib/conversation-catalogue.ts` | Backend 的 catalogue row → `SessionInfo`；list version 直接透传，不二次推导 |
| 三态写入 | `@hepi/session/control` + `ConversationRefusal`/`isRefusal`/`operationFailure` | 值 / 4xx 拒绝（Backend 的 status+code）/ unknown（携带 requestId，从不重发） |
| 事件流 | `@hepi/session/browser` 的 `conversationSource()`（原 `cookieBffSource`） | 同源 `/api/conversations/:id/events`，无 header（cookie 自带） |
| 消费者 | `useAgentSession`、`AppShell`、`SessionSidebar`、`SessionSearch`、`RawHistoryPanel`、`SettingsPanel`、`QuickDelegatePanel`/`delegate-client` | 不再拼 `/api/sessions`、`/api/agent`；`lib/agent-client.ts` 已删除 |

幂等与有界语义保持原样：`requestId` 仍是 attempt 身份，`/submissions?requestId=` 仍是唯一恢复路径，history 仍走
`/entries?before|tail` 的 Backend 分页，不新增客户端队列或第二套状态。未动 Gateway 路由表、Backend 路由与票据 06–15 的
API。

**受测 seam。** `packages/ui/src/lib/conversation-api.http.test.mjs`（真实 HTTP → 真实 ingress → 真实 Backend，device bearer）：
(1) 旧词汇 `/api/sessions`、`/api/agent/:id/events`、`/api/agent/running` 在 Backend 上确为 404，而 `/api/conversations` 为 200；
(2) 一个 bearer 客户端经工作台 API 完成 list/create/read/open/send/submission 恢复/history/control/rename，并断言 ingress 只收到
`/api/conversations…`（`/api/sessions`、`/api/agent` 命中数为 0）；(3) 事件流在同一连接上以 device bearer 拿到
`snapshot` 与 `submission` 帧。纯投影 seam 另有 `packages/ui/src/lib/conversation-catalogue.test.mjs`（8）。

**仍未关闭的验收。**

- 本票 Acceptance 第一条只在 Web 上成立；App 的真实 Tauri/WebKitGTK 端到端会话（打开→发送→刷新/重开）仍属票据 04/16，
  本次证据是 Node 内的真实 HTTP/SSE seam，不是原生壳。
- 跨端同一会话（Web 创建 → App 提交 → 丢响应 → 原 requestId 查询只提交一次）的验收属票据 16；本次只证明同一 bearer 客户端的
  幂等/恢复路径，未在同一时刻用两个真实宿主跑同一条链路。
- 下列仍用相对 `fetch`，属各自票据：`/api/files/*`、`/api/file-index`、`/api/git/*`（08）；`/api/sessions/ui-state`
  （`useSessionUiState`，06）；`/api/projects`、`/api/worktrees`、`/api/home`、`/api/default-cwd`、`/api/cwd/*`（06）；
  `/api/models*`、`/api/auth/*`、`/api/tools/settings`、`/api/web-auth`（11）；`/api/skills*`、`/api/agent-definitions`（12）；
  `/api/mcp*`、`/api/project-trust`（13）；`/api/terminal*`（09）；`/api/app-update`、push、`/api/durable-login`（14/17）；
  `MessageView` 的 `/api/agent/:id/bash-output`（08 的 bash 输出路由，Backend 未实现该路由）。
- 旧 Next BFF 的 `/api/sessions…`/`/api/agent…` 路由本身仍在 `apps/web`（票据 17 删除）；本次没有在 Gateway/Backend 增加兼容路由。
- 已合入集成 tip；未部署。

### Review 233 fixes (2026-10-18)

两次复审发现的 material P2，都在本票自己的 seam 上修根因，并按 review policy 只在公开 seam 验证。

**P2-1：busy 期间 steer/follow-up 的附件被静默丢弃。** 触发链：`sendStreamingPrompt` 把附件放进 staged turn（
`useAgentSession.ts`），却只把 `{queueOnly, whenBusy}` 交给 `api.control(sid).send`；`@hepi/session/control` 的 queue-only
分支只序列化 `{requestId, text, mode}`；Backend `POST /:id/busy` 只读 text（`expandInput`）。三处各自"合理"，合起来就是
用户看到的乐观附件在真正提交的 entry 里消失。`/messages` 与 `/continue` 早已接受 images，所以这不是新能力，而是同一 admission
seam 的一个入口少了内容词汇。

- 修法（端到端，不新增路由、不新增层）：`POST /:id/busy` 与普通提交同源——用 `MAX_SUBMISSION_BODY_BYTES` 读体、
  `validateCommand` 校验、`imageRefusal` 判断模型是否可读图、`submissionContent` 生成内容，仍然 `resume: false`（不恢复 hold）；
  模型图像判断抽成 `imageRefusal`，`/messages`、`/continue`、`/busy` 共用一份，删掉两处重复内联。
- `control.ts` 的 queue-only body 带上 `images`；`useAgentSession` 把 `piImages` 交给线上请求，staged 内容与提交内容一致。
- 拒绝先于入队：空 body、协议不接受的附件、模型不可读的图，都在 admission 之前 400，草稿与附件留在 composer。

**P2-2：delegation 回答的 catalogue row 被原样交给 `onOpenChild`。** `delegate-client` 把 Backend 的 `conversation`
以 `as never` 断言成 `SessionInfo`，行上没有 cwd/projectKey，`AppShell` 的 `workspaceKeyOf` 因此判定为"换了目录"→
`setFileTabs([])`。修法：`delegateFrom` 用 `catalogueRow`（与列表同一投影）在返回前投影，child 行带上 folder/Project/relation；
ticket 12 的 `listDelegateDefinitions(ExecutionTarget)` 与 target fence 原样保留，本票只提供原生 delegation 提交。

**受测 seam 与红→绿。** `packages/ui/src/lib/conversation-api.http.test.mjs`（真实 ingress + 真实 Backend + device bearer，
gate 制造真实 busy）：普通发送保留图；busy steer 的图落在提交的 entry 上。红：把 queue-only 序列化的 images 去掉 →
该用例报 `the steered image was dropped between the composer and the conversation`。`packages/ui/src/lib/delegate-client.test.mjs`：
`delegateFrom` 的 row 与 `catalogueRow` 逐字段相等，且 `workspaceKeyOf(row) === workspaceKeyOf(parent)`（file tab 保持的
判据）。红：改回 `as never` → 两条用例全红（actual 是裸 wire row）。Backend 侧 `apps/server/test/submission-images.test.ts`
新增 busy 入队保留图/模型不可读图与空 body、非法附件被拒两条。复审自带的缺陷断言 probe（`/tmp/t05-review-http-probe.mjs`）
在修复后 3 条按"缺陷成立"写的用例转红、其余 5 条通过——即所报缺陷不再成立。

**记录（record，不修）**：`recallQueue()` 只回文本，队列项上的附件不返回（`recall-queue` 用 `contentText`）；这是票据 10
的召回语义，不是本次引入，等真实使用给出证据再处理。`MessageView` 的 `/api/agent/:id/bash-output` 仍无 Backend 路由（08）。
