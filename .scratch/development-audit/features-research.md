# 功能缺口研究：provider、session export、Agents、Push、分支导航、远程 workbench

日期：2026-10-14。基准 revision：`1758c1fb4479e9d4637a957857246c5998619d73`（master）。共享工作区 dirty（其他 worker 的改动；
本 worker 只新增未跟踪的 `.scratch/development-audit/` 与 git-ignored 的 `.dev/research-features/`）。

本文是**研究**，不含实现、不含部署、不调用付费 provider、不发通知、不改真实凭证。审计原报告为
[2026-10-14.md](2026-10-14.md)，执行归属见 [follow-up.md](follow-up.md)：审计建议 1（CLI Worktree，agent-7）与
2（Settings/登出，agent-11）由其他 worker 实施，本文只负责建议 3 的六个候选功能；建议 4 的性能验证由独立 worker 记录。并发的 Settings worker 正在改
`apps/web/components/SettingsPanel.tsx`、`apps/web/app/api/[...path]/route.ts`、新增 `apps/web/lib/capability-availability.ts`；
本文不触碰这些文件，并把"能力缺失"与"UI 可见性"分开陈述。

## 0. 方法与证据等级

- **验证（verified）**：对当前源码/上游快照的**公开 seam** 做了可复现探测。主证据是
  `node .dev/research-features/probe-routes.mjs`（revision `1758c1f`，dirty，**exit 0**，完整输出
  `.dev/research-features/probe-routes.log`）。该脚本用 jiti 加载真实的 `apps/web/adapters/durable-api.ts`（Web origin 的会话/后端适配 seam；登录、MCP 与技能市场另有入口），对一个记录型 stand-in backend 发请求，断言"哪些路由被转发、哪些落到 adapter 自己的 501
  `{code:"unsupported"}`"。它不触网、不碰真实凭证。
- **推断（inferred）**：从源码结构读出、但未在运行期断言的结论，均在文中显式标注。
- **未测（unmeasured）**：需要真实 provider / 真机 / 浏览器才能确认的部分，标注为未测。

主源（外部）：pi-web `https://github.com/agegr/pi-web` @ `76bdc57027172eb381a216d647225a6d24f23360`（v0.10.0，
MIT；`apps/web/vendor/pi-web/LICENSE` 记 "Copyright (c) 2026 agegr"）；pi
`https://github.com/earendil-works/pi` @ `6fb2e7815167e6b19006fc526d1a5d0f5f998787`；`models.dev` `https://models.dev/api.json`；
RFC 8030/8291/8292；W3C Push API。以上 URL 与 `https://registry.npmjs.org/web-push/latest` 于 **2026-10-14** 访问，均 HTTP 200。
版本/license 记录见 [docs/upstream-sources.md](../../docs/upstream-sources.md)。

## 1. 现状矩阵（能力 vs UI 可达性）

对六项功能逐条探测（`probe-routes.log`）。"501" 表示 Web origin 的 `durable-api` 落到末尾
`return unsupported("This capability is not connected to the durable server yet")`。

| 功能 | Web 侧路由 | 当前结果 | 能力是否已存在 |
| --- | --- | --- | --- |
| Provider discover | `POST /api/models-config/discover` | **501 unsupported** | 上游 helper 已复制到 `apps/web/lib/`（dormant）；后端无路由 |
| Provider test | `POST /api/models-config/test` | **501 unsupported** | 同上；后端 `ModelRuntime` 有 `completeSimple`/`getAuth` |
| Model catalog | `GET /api/models-config/catalog` | **501 unsupported** | `apps/web/lib/model-catalog.ts`（纯函数）已存在 |
| Provider 凭证/OAuth | `/api/auth/providers`、`/api/auth/login/[p]`、`/api/auth/logout/[p]`、`/api/auth/api-key/[p]` | **全部 501** | 后端 `ModelRuntime` 有 `login/logout/listCredentials/getProviderAuthStatus`；上游路由为快照 |
| Provider 用量 | `POST /api/provider-usage/query` | **501** | `apps/web/lib/provider-usage.ts` 存在但**无任何 importer**（完全 dormant） |
| Session export | `GET /api/sessions/[id]/export` | **501** | 上游依赖 pi session **JSONL 文件** + `dist/core/export-html`；durable 会话不是文件 |
| Agents profiles | `/api/subagents/profiles`（GET/PUT/PATCH/DELETE）、`/api/subagents/settings`（GET/PUT） | **全部 501** | 上游 `subagents.ts` 读写**本机文件**；执行器（`subagent-runtime.ts`/`rpc-manager.ts`）已从 lib 移除 |
| Push | `GET /api/push/config`、`POST /api/push/subscribe` | **501** | `web-push.ts`+`push-client.ts`+`public/sw.js` 已存在；缺路由与**完成触发器** |
| 分支导航（会话内 entry tree） | `GET /api/sessions/[id]?tree=summary`、`POST /api/agent/[id] {type:"navigate_tree"}` | 读 200 但 `tree: []`；命令 **501** | pi-durable **没有**会话内 entry tree 原语（见 §4.E） |
| 分支导航（fork 为新会话） | `POST /api/sessions/[id]/fork {at}` | **200**（已接通） | 后端 `Conversation.fork(at)` |
| 远程 workbench | `/api/workbench` → SSH gateway `/v1/workbench` | 本地 200；SSH gateway **无 workbench surface** | `GatewayWorkbench` 仅本地装配 |

对照的**已接通**路由（同一探测，均 200）：`GET /api/models-config`、`GET /api/models`、
`GET /api/sessions/[id]?deferThinking=1&deferMedia=1&tree=summary`、`GET /api/sessions/[id]/context?leafId=1`、
`POST /api/sessions/[id]/fork {at}`。也就是说：**Settings 的 models.json 手工编辑、会话读、fork 是通的；上表 501 的都是能力本身未接，不是按钮可见性问题。**

并发的 Settings worker 引入 `capability-availability.ts`（探测路由、对 501 `unsupported` 隐藏/标注控件），它**改变的是
可达性呈现，不改变能力可用性**：上表 501 的功能在该改动后仍是"未实现"，只是不再以"点了才报错"的形式暴露。

## 2. 必须先分清的四组边界（本研究的核心）

### 2.1 durable 模型凭证 vs legacy OAuth 运行时

- **durable 路径（当前唯一权威）**：后端 `apps/server/src/model-config.ts` 用
  `ModelRuntime.create({ modelsPath, modelsStore: InMemoryModelsStore, credentials: InMemoryCredentialStore, allowModelNetwork:false })`
  构造；pi 模式（`apps/server/src/pi-config.ts`）额外传 `authPath: <agentDir>/auth.json`。即
  **models.json 与凭证属于后端主机**（环境模式凭证仅在内存，不落盘；`apps/server/src/provider-config.ts` 明确"pi 凭证存储与 pi 配置文件永不被读"）。
- **legacy 路径（dormant，不能直接接线）**：`apps/web/lib/model-runtime.ts` 已被移除（`docs/upstream-sources.md` 记其作为 dormant runtime entry 移入 vendor）；
  `apps/web/lib/provider-listing-runtime.ts`、`provider-credential-store.ts`、`model-discovery-auth.ts`、`provider-usage.ts`
  在当前 import 图中**无任何非测试 importer**（已用 grep 逐一确认）。它们读写的 `getAgentDir()/auth.json` 是 **Web 主机**的
  agent 目录（`provider-credential-store.ts:join(getAgentDir(),"auth.json")`）。
- **结论**：split 部署下把上游 `/api/auth/*`、`/api/models-config/discover|test|catalog` 原样接进 Web origin，会把凭证写到
  **错误的机器**。正确 owning boundary 是**后端**（它已拥有 models.json、`ModelRuntime`、auth.json 与刷新）。Web 侧只应转发。

### 2.2 MCP 管理 vs MCP 工具调用

- **管理面（已接通）**：`apps/web/adapters/mcp-surface.ts` 明确 "no MCP request reaches the durable backend"；
  配置/测试/OAuth 登录由 **Web 主机 gateway** 的 `packages/gateway/src/mcp/host.ts` 承担（`McpHostService`，仅本地 gateway 装配，
  `packages/gateway/src/main.ts` / `packages/client/src/gateway.ts` 中 `profiles ? undefined : new McpHostService(...)`）。
- **调用面（未接通）**：`apps/server/src/` **不导入** `@earendil-works/pi-mcp`，不创建 MCP client，也不把 MCP 工具加入会话工具集；
  `apps/server/src/pi-config.ts:122` 把 `"mcp"` 列在 unsupported。故"后端不是 MCP participant"：会话的模型调用**看不到** MCP 工具。
- **结论**：MCP 面板可管理服务器并测试连通，**不等于**模型能调用 MCP 工具。审计原报告此点成立。

### 2.3 分支导航：fork 新会话 vs 会话内 entry tree

- **fork 为新会话（已接通，durable 原生）**：后端 `Conversation.fork(at)`（`apps/server/src/server.ts:1810`），
  路由 `POST /api/conversations/:id/fork`，Web 侧 `POST /api/sessions/:id/fork` 与 agent 命令 `fork`/`fork_branch`
  都带 `at`（entryId）。`ConversationRecord.parent = { conversationId, at }` 保留血缘。
- **会话内 entry tree（未接通，且无 durable 来源）**：`durable-api.ts:102` 硬编码 `tree: []`，`leafId` 取最后一条 entry；
  后端**不处理** `tree=summary`、**从不返回** `treeFormat`（grep 确认 `apps/server/src/server.ts` 无 `treeFormat`/`tree` 查询参数）；
  `navigate_tree` 落到 adapter 的 default → **501**；`/context?leafId=` 只读 `before/tail`，忽略 `leafId`。
  pi-durable 的 entry 只有 `head`（新上下文的起点标记）与 `reset(handoff)`/`fork(at)`，**没有** pi-web 会话 JSONL 的
  per-entry `parentId`，因此无法在不新增运行期原语的前提下重建会话内树。
- **结论**：durable 的"分支"是**另一个会话**；pi-web 的 `BranchNavigator`（会话内树 + 切 leaf）在当前运行时**没有数据源**。
  这是产品/运行期决策，而不是漏接线。

### 2.4 远程 workbench vs 本地 workbench

- `GatewayWorkbench`（`packages/gateway/src/workbench/index.ts`）直接用本地 `node:fs` 与本地 git（`git-environment.ts`），
  无 `SshRunner` 注入点；`main.ts` 与 `client/src/gateway.ts` 都只在**本地**装配它，SSH 分支传 `undefined`。
- gateway 在缺 workbench 时对 `/v1/workbench` 回 `{ok:false, code:"operation_failed"}`（409），而非具名 `not_supported`
  （`packages/gateway/src/index.ts:598`）——与 `/v1/worktrees` 的具名 `not_supported` 不一致。
- 本地 workbench 内部还有三个明确 501：live watch、DOCX preview、linked-directory approval
  （`apps/web/adapters/workbench.ts:339,341`）。

## 3. 逐功能研究

每项给出：当前事实 / 已验证 vs 推断 / 复用上游（路径、版本、license）/ owning boundary 与 API 契约 / 依赖顺序 /
最小实现方案 / 验收 seam / 未决产品选择。

### 3.A Provider discover / test / catalog（含 provider usage）

**当前事实**：三条 `/api/models-config/*` 子路径与 `/api/provider-usage/query` 全部 501（probe 已验证）。
`GET|PUT /api/models-config` 已接通到后端（probe：GET 200；`apps/web/adapters/durable-api.ts:602` 转发，PUT 时 `invalidateModelsCache()`）。
后端 `apps/server/src/server.ts:1500` 拥有 models.json 的读/校验/原子写/apply。

**已验证**：501 与 200 的分布（probe）；后端 runtime 的构造与凭证边界（源码）；
`ModelRuntime` 1.1.0 具备 `getAuth`、`completeSimple`、`refresh`、`listCredentials`、`getProviderAuthStatus`
（`node_modules/.pnpm/@earendil-works+pi-coding-agent@1.1.0*/dist/core/model-runtime.d.ts`）。
**推断**：把 discover/test 放在后端即可复用同一 `ModelRuntime` 与凭证；未运行验证（需真实 provider，本次不调用）。

**复用上游**：pi-web @ `76bdc57`（MIT）：
`app/api/models-config/discover/route.ts`、`test/route.ts`、`catalog/route.ts`、`lib/model-discovery.ts`、
`lib/model-discovery-auth.ts`、`lib/model-catalog.ts`、`lib/provider-usage.ts`、`lib/provider-usage-ids.ts`。
本地已有这些 lib 的副本（`apps/web/lib/`，dormant）。catalog 的外部源是 `https://models.dev/api.json`（200，2026-10-14）。
provider usage 的查询格式来自 `@narumitw/pi-usage`（MIT），`provider-usage.ts` 注释声明无运行期依赖。

**owning boundary / API 契约**：**后端**新增（或从 Web lib 上移）三个路由，沿用上游契约：
- `POST /api/models-config/discover` → `{models, endpoint}`；失败 `{error, status}`（400/502/504）。
- `POST /api/models-config/test` → `{ok, latencyMs, status, responseText}`；失败 `{ok:false,error,...}`。
- `GET /api/models-config/catalog?q&provider&baseUrl&limit` → `{models, recommendation, source}`。
- `POST /api/provider-usage/query {providerId}` → `{providerId,status:"ready"|"auth-unavailable"|"query-failed",report?,message?}`。
Web adapter 只做 `forward(await backendResponse(...))`，与现有 `models-config` 分支同形。

**依赖/顺序**：需要一次决策：后端 `ModelRuntime` 目前 `allowModelNetwork:false`。discover/test/usage 都要出网，
需要**按请求**启用出网（不是启动时全量 refresh），并保持 `refreshOnCreate:false`。

**最小实现方案**：在后端新增 `model-discovery.ts`（从 Web lib 上移纯函数）与一个薄路由层；
`resolveModelDiscoveryAuth` 改为接收**后端已有的 `ModelConfigTarget.runtime`**，而不是自建临时 runtime；
catalog 保持纯 HTTP + 1h 缓存（上游 `__piModelsDevCatalogCache`）。adapter 增加 4 条 forward。

**验收 seam**：`apps/server` 的 HTTP 层：对 stand-in provider（本地 HTTP fixture，非真实厂商）断言 discover/test 的请求形状与
错误映射；对 `https://models.dev/api.json` 的 catalog 只断言解析与缓存（可用 fixture 响应替代）；adapter 层断言转发而非 501。

**未决产品选择**：① discover/test 是否需要后端出网白名单/开关；② catalog 的 models.dev 依赖是否可接受（离线部署怎么办）；
③ 自定义 provider 的 `apiKey` 出现在请求体时是否回显后端诊断（上游会回显，后端现有 models.json 诊断刻意脱敏）。

### 3.B Session export

**当前事实**：`GET /api/sessions/[id]/export` **501**（probe 已验证）。上游实现依赖
`resolveSessionPath(id)`（读 pi **JSONL 会话文件**）+ `dist/core/export-html` 或 `pi --export` CLI。
durable 会话存于 SQLite，不是文件；adapter 的 `sessionData.filePath` 恒为 `""`。

**已验证**：durable 的完整读能力存在：分页
`GET /api/conversations/:id/entries?before=<id>&tail=N`（`tail` 上限 1000；页被**最新 head 标记**下界，永不返回活动上下文已离开的 entry；
可能回 413 `frame_too_large`）；deferred 读块
`GET /api/conversations/:id/entries/:entryId/thinking?blockIndex=` 与 `.../tool-result-image?blockIndex=`
（`apps/server/src/server.ts:1650-1700`）。deferred 形状由 `projectEntry`→`deferHistoryMessage` 统一施加于**流与分页**
（`apps/server/src/history-window.ts:246`），即分页里的 thinking 是 preview、image 是 URL。
图片策略在 `packages/protocol/src/index.ts:254`：`MAX_TOOL_RESULT_IMAGE_BYTES = 10MiB`、`TOOL_RESULT_IMAGE_MIMES`；
超限/非白名单图片被丢弃并追加 `toolResultImageNotice()` 文本。
**推断**：pi-coding-agent 1.0.0/1.1.0 的 `export-html` 不是 package export 子路径（`exports` 只有 `.`、`./rpc-entry`、`./client`、`./experimental/plugin`），
上游靠 `pathToFileURL(join(packageDir,"dist","core","export-html","index.js"))` 直取 dist 内部；本仓库对 dist 内部有"镜像行为、不直取"的既有取向（见 `apps/server/src/model-config.ts` 的 `stripJsonComments` 注释）。

**复用上游**：pi-web `app/api/sessions/[id]/export/route.ts`（含 `patchExportHtml` 的深树迭代化补丁，针对 5000+ 线性树栈溢出）；
pi-coding-agent 的 `exportFromFile`/`exportSessionToHtml`（**未导出子路径**）。均为 MIT。

**owning boundary / API 契约**：**后端**拥有 transcript、分页、读块与图片策略，因此导出应在后端（或后端提供"完整条目"读，
由 Web 渲染）。契约保持上游：`GET /api/sessions/:id/export?inline=1` → `text/html`，
`Content-Disposition`、`CSP frame-ancestors 'none'`、`X-Frame-Options: DENY`、`nosniff`。

**依赖/顺序**：导出必须先有"完整且去 deferred 的条目"读。当前分页返回的仍是 deferred 投影，所以导出要么
(a) 后端新增一个导出专用读（分页 + 读块内联，遵守图片策略），要么 (b) 复用现有分页并在导出器内逐块回读。
**(b) 会把策略判定散到导出器**，与"策略只有一个 owner"冲突。

**最小实现方案**：后端新增 `exportConversation(conversationId)`：循环
`entries({before, tail})` 直到 `hasMore=false`；对每个 deferred thinking 块回读 `thinking` 块；
对每个 deferred image URL 回读 `tool-result-image`（**保持策略**：不在 `TOOL_RESULT_IMAGE_MIMES` 或 >10MiB 的仍以 notice 文本出现，不内联）；
然后用一个 **durable→pi session JSONL** 适配器或**原生渲染器**产出 HTML。前者可复用 pi 的 `exportFromFile`（需直取 dist 内部，版本钉死并记录）；
后者不依赖 dist 内部但需自写模板。

**验收 seam**：后端 HTTP：对一个含 thinking + 大图 + 超限图 + 多页（>1000 条）的 fixture 会话断言导出 HTML
包含完整 thinking 文本、内联白名单图片、超限图片为 notice 文本，且分页全部走完；以及 413 分页时的降级路径。

**未决产品选择**：① 导出范围：仅活动上下文（现有分页语义）还是含 head 标记之前的原始 entry（**当前无路由可取**，需新原语）；
② 渲染器：直取 pi dist 内部（版本钉死）vs 原生模板；③ 导出是同步请求还是后台任务（大会话耗时）。

### 3.C Agents profiles

**当前事实**：`/api/subagents/profiles`（GET/PUT/PATCH/DELETE）与 `/api/subagents/settings`（GET/PUT）全部 **501**（probe 已验证）。
`apps/web/components/AgentsConfig.tsx` 因此读不到 profiles；并发的 Settings worker 已让它在该 501 时显示具名限制而非空编辑器。

**已验证**：上游 `subagents.ts` 从**本机文件**读/写 profile（`getAgentDir()` 全局、cwd 下项目 scope），
`subagent-settings.ts` 写本机 `builtInEnabled/maxConcurrent`；执行器
`lib/subagent-runtime.ts`、`lib/rpc-manager.ts` 已从可执行 lib 移除（vendor 保留为 provenance）。
后端**已有** subagent 血缘概念：`ConversationRecord.owner` → `subagentParentConversationId`（`apps/server/src/server.ts:79,1082`），
fork 对 subagent 会话回 409 `subagent`。但**没有**按 profile 生成子会话的执行路径。
**推断**：仅接上 profiles 路由只会在**Web 主机**写文件，与"资源属于执行环境"（ADR 0002）冲突。

**复用上游**：pi-web `app/api/subagents/profiles/route.ts`、`settings/route.ts`、`[id]/route.ts`、
`lib/subagents.ts`、`lib/subagent-settings.ts`、`lib/subagent-profile-precedence.ts`（MIT）。
本地 lib 已有 `subagents.ts`/`subagent-settings.ts`/`subagent-profile-precedence.ts` 副本（dormant）。

**owning boundary / API 契约**：profile **文件**属于执行环境（与 skills/prompts 同类）→ 应由 gateway 的
`/v1/files` 或一次资源发现提供；**执行**属于后端（会话/任务编排）。契约沿用上游：
GET `{profiles:[...]}`、PUT `{profile}`、PATCH `{profile}`（开关）、DELETE `{ok:true}`、
settings `{enabled,maxConcurrent}`；refusal 用 400/403/404。

**依赖/顺序**：① 执行环境资源发现需先能列 `agents`（当前 `apps/server/src/workspace-resources.ts` 只发现
skills/prompts/context）；② 编辑器写文件需要执行环境安装/文件写路径；③ **运行** profile 需要新的后端执行能力。

**最小实现方案（分三步，互相独立）**：
1. **只读**：后端/执行环境发现 agent profile 列表，`GET /api/subagents/profiles` 返回真实列表（让页面 truthful）。
2. **可写**：PUT/PATCH/DELETE 落到执行环境的 profile 文件（经既有安装/文件 seam）。
3. **可运行**：后端新增 profile 驱动的子会话（这是大能力，且依赖 subagent 执行器设计）。

**验收 seam**：① 对执行主机上的 fixture `agents/*.md` 断言 GET 返回与文件一致；
② PUT 后断言执行主机文件内容变化（不是 Web 主机）；③ 运行能力另立验收。

**未决产品选择**：① 是否保留 upstream 的 scope 语义（`builtin/global/project`）；
② 子代理执行是复用 pi-durable 的 task/owner 机制，还是引入新执行器；③ 是否需要 `isolation:"worktree"`（与 worktree 能力耦合）。

### 3.D Push

**当前事实**：`GET /api/push/config`、`POST /api/push/subscribe` **501**（probe 已验证）。
浏览器侧几乎齐备：`apps/web/lib/push-client.ts`（`setupPushSubscription`）、`apps/web/lib/web-push.ts`（VAPID、订阅持久化、`notifySessionComplete`）、
`apps/web/public/sw.js`（`push`/`notificationclick`）、`SettingsPanel.tsx` 与 `AppShell.tsx` 调用 `setupPushSubscription`。
`web-push@3.6.7`（**MPL-2.0**，npm registry，2026-10-14）已是依赖，并在 `next.config.ts` 的 `serverExternalPackages` 中。

**已验证**：`notifySessionComplete` 在 `apps/web`（排除 vendor）**没有任何调用点**；上游由 `lib/rpc-manager.ts:2483`
在 run 结束时调用，而该文件已从可执行 lib 移除。即"有推送管道，没有扳机"。
`web-push.ts:stateFilePath()` = `getAgentDir()/web-push.json`（Web 主机），`listSessionNames()` 用
`SessionManager.listAll()`（pi **文件**会话）取名字——对 durable 会话是错的来源。
后端目录已暴露 `lastRunEndedAt`（`apps/server/src/server.ts:94,1066`），可作为完成信号。
**推断**：把 `/api/push/*` 接进 Web host（VAPID 与订阅属于 Web 主机）并在服务端观察完成即可，无需后端改协议。

**复用上游**：pi-web `app/api/push/config/route.ts`、`app/api/push/subscribe/route.ts`、
`lib/web-push.ts`、`lib/push-client.ts`（MIT）。本地 `web-push.ts`/`push-client.ts` 已是其副本（`push-client.ts` 被组件使用）。

**owning boundary / API 契约**：**Web host**（浏览器订阅 + VAPID 私钥属于该 origin）。
`GET /api/push/config → {publicKey}`；`POST /api/push/subscribe {subscription,locale} → {ok:true}`（按 endpoint upsert，非法 400）。

**依赖/顺序**：① 两条路由；② 完成触发器；③ 会话名来源改为后端目录标题（`hepi.title`）。

**最小实现方案**：在 `apps/web/app/api/[...path]/route.ts`（或 adapter）接两条路由到现有 `web-push.ts`；
新增一个服务端观察者：轮询后端 `/api/conversations` 的 `lastRunEndedAt`（与 sidebar 已有的 running 轮询同源），
在推进时对对应会话调用 `notifySessionComplete`；把 `listSessionNames` 换成读后端目录标题。

这只是未验证的候选设计。目录的最近结束时间不等于完整完成事件日志：轮询间多次完成可能被合并，
服务重启与多实例也需要明确初始基线及持久去重。实施前须确定通知按每个 submission 还是每个 run、
失败/取消是否推送、多个设备及页面前后台的策略，再验证触发与交付边界；不能把现有 helper 的存在
当成完成通知已接近交付的测量证据。

**验收 seam**：组件/public seam：对 stand-in backend 断言 `/api/push/config` 返回公钥、`/api/push/subscribe` 落盘且按 endpoint upsert；
触发器用假时钟推进 `lastRunEndedAt` 并断言 `send` 被调用一次（`web-push.ts` 已有 `WebPushEnvironment` 注入点，`lib/web-push.test.mjs` 即此 seam）。
**不发真实通知**。

**未决产品选择**：① 触发器用轮询还是后端新增完成事件（轮询会多一次目录读）；② 订阅状态放 Web 主机文件 vs 后端文档；
③ 是否只在页面不可见时推送（当前 `sw.js` 有意总是显示通知，iOS 语义）。

### 3.E 分支导航

见 §2.3 的边界。补充：

**已验证**：probe 显示 `GET /api/sessions/conv-1?tree=summary` → 200 且 `tree: []`、`leafId` = 末条 entry；
`POST /api/agent/conv-1 {type:"navigate_tree"}` → **501** "Command navigate_tree is not connected to the durable runtime yet"；
`fork` 带 `at` → 200。
`apps/web/components/AppShell.tsx:372-378` 从 `onBranchDataChange` 拿树（`useAgentSession.ts:2738` 传 `data?.tree ?? []`），
`hasSessionBranches([])` 为 false → 按钮恒为暗色、面板为空。
**推断**：pi-durable 无 per-entry parent，故无法在不新增原语下重建 pi-web 的会话内树；此判断基于类型与 API 阅读，非运行断言。

**复用上游**：pi-web `components/BranchNavigator.tsx`、`lib/session-family.ts`、`lib/session-tree.ts`（注意：本地
`apps/web/lib/session-tree.ts` 是 **sidebar 的会话分组树**，与 BranchNavigator 的**消息 entry 树**是不同概念，不要混用）、
`lib/session-reader.ts` 的 `sliceActiveBranch`（MIT）。

**owning boundary / API 契约**：会话内树若要有，属**运行期原语**（pi-durable），不是 adapter 拼装；
fork-as-conversation 已由后端 `Conversation.fork(at)` 拥有。

**依赖/顺序**：需要产品决策后才能谈实现。可选项：
(a) 退役 `BranchNavigator`，用"fork 到新会话 + 会话列表血缘"表达分支（**零运行期改动**，复用已有 `parentConversationId`）；
(b) 后端暴露"会话血缘"列表（fork 树），UI 改为会话级分支视图；
(c) 推动 pi-durable 提供会话内 leaf 导航原语（**最大成本，需上游变更**）。

**最小实现方案**：先做 (a) 的**诚实化**：让 BranchNavigator 不再请求不存在的树（当前是静默空树），
并让 `/context?leafId=` 与 `navigate_tree` 明确回 501/被忽略的原因；若选 (b)，后端新增
`GET /api/conversations/:id/lineage`（读 `ConversationRecord.parent` 链）。

**验收 seam**：(a) 组件 seam：断言空树时无分支控件、fork 菜单仍可用；(b) 后端 HTTP：对已知 fork 链断言血缘顺序。

**未决产品选择**：① 用户要的是"会话内切换分支"还是"从某条消息分叉成新会话"（当前只有后者）；
② 是否接受 (c) 的上游依赖；③ 与 `/clone`、compaction head 标记的语义如何呈现。

### 3.F 远程 workbench

**当前事实**：本地 workbench 可用（list/read/changes/diff）；SSH gateway **不装配** `GatewayWorkbench`，
`/v1/workbench` 回 `{ok:false,code:"operation_failed"}`（409），非具名 `not_supported`。
workbench 内部 live watch / DOCX preview / linked-directory approval 均 501（本地亦然）。

**已验证**：装配点（`main.ts`、`client/src/gateway.ts` 的 `profiles ? undefined : new GatewayWorkbench(...)`）；
gateway 缺 surface 的返回码（`index.ts:598`）；`SshFilesystem` 已用 `SshRunner.open` 持有常驻 Python 会话做 read/write/edit，
说明"远程文件读"能力已存在，只是未接到 workbench 契约上。
**推断**：远程 workbench 可复用 `SshFilesystem` 的读 + 远程 git 命令；未运行验证。

**复用上游**：pi-web `app/api/files/[...path]/route.ts`、`app/api/git/{status,diff}/route.ts`（MIT，vendor 中已存快照）；
pi-gui `packages/gateway/vendor/pi-gui/app-store-files.ts`/`app-store-diff.ts`（本地 `packages/gateway/src/workbench/` 已改编）。

**owning boundary / API 契约**：workbench 是 **host capability**（与 worktree/files 同类），应新增
`SshWorkbenchServer`（`{profiles, runner, workspaces}`）实现同一 `WorkbenchRequest/WorkbenchResult` 契约；
缺 surface 时应像 worktrees 一样回具名 `not_supported`。

**依赖/顺序**：① 先让"缺 surface"具名（小改，与 worktree 一致）；② 再实现 SSH 变体（files/read 复用 SSH filesystem；changes/diff 走远程 git）；
③ live watch / DOCX / linked-directory 是本地也缺的独立项，不应混入。

**最小实现方案**：`packages/gateway/src/workbench/` 抽象出"读文件/列文件/跑 git"的 runner 注入点，
本地实现保持现状，SSH 实现走 `SshRunner`；`main.ts`/`client` 的 SSH 分支装配它。

**验收 seam**：gateway 包测试：对真实 localhost sshd fixture 断言 `/v1/workbench` 的 list/read/changes/diff
（fixture 已在 `packages/gateway/test/fixtures` 用于其他 SSH 测试）。

**未决产品选择**：① 远程 workbench 是否要支持全部四种 operation 还是先只读；
② workbench 与既有 SSH 文件 RPC 的重叠是否应合并（避免两套远程读）；
③ live watch 走 SSH 的可行性（长连接 + 心跳）。

## 4. 功能提案排序与抽取/复用归属

排序依据：用户价值 × 实现确定性 ÷ 成本（含新原语/新边界）。

| 序 | 功能 | 为什么这个次序 | 抽取/复用归属 | 成本与风险 |
| --- | --- | --- | --- | --- |
| 1 | **Provider discover/test/catalog** | 上游 helper 已存在、边界清晰（后端已拥有 runtime/models.json）、无新原语 | 纯函数上移到 `apps/server/src/model-discovery.ts`（从 `apps/web/lib/model-discovery.ts`/`model-catalog.ts` 改编）；`ModelConfigTarget.runtime` 为唯一 runtime 来源；adapter 只 forward | 低-中；唯一新决策是"按请求出网" |
| 2 | **Push** | 订阅/发送 helper 与 Service Worker 已存在；完成触发和交付策略仍需验证 | 复用 `apps/web/lib/web-push.ts`（已有 `WebPushEnvironment` 注入 seam）与 `public/sw.js`；会话名改为读后端目录标题 | 中；完成来源、重启/多实例去重与交付策略尚未验证 |
| 3 | **Session export** | 价值明确、读能力齐备，但需新的"完整条目+去 deferred"读与渲染器 | 后端拥有 `exportConversation`；分页/读块/图片策略复用 `history-window.ts`+`packages/protocol`；渲染器二选一 | 中；深树与超限图片是已记录的坑 |
| 4 | **Provider 凭证/OAuth/API key** | 与 1 同边界但风险高（OAuth 流程、凭证持久化、写 auth.json） | 后端 `ModelRuntime.login/logout`；`provider-credential-store.ts` 的锁语义若复用需**重定向到后端主机**（否则跨机写错） | 中-高；env 模式凭证不落盘是硬约束 |
| 5 | **Agents profiles** | 配置面可小步交付，但"可运行"是全新执行能力 | 文件属执行环境（gateway 文件/安装 seam）；执行属后端（复用 `owner` 血缘） | 高；应拆三步，先只读 |
| 6 | **远程 workbench** | 本地已可用，远程是增量；有重复读能力 | `packages/gateway/src/workbench` 抽 runner 注入；SSH 复用 `SshRunner`+`SshFilesystem` | 中；注意与 SSH 文件 RPC 的重叠 |
| 7 | **分支导航（会话内树）** | 当前**没有 durable 数据源**，需产品或上游原语决策 | 先"诚实化"UI；会话血缘读 `ConversationRecord.parent` | 高/不确定；不建议在决策前实现 |

**跨功能的抽取归属原则**（与 ADR 0002、copy-first 一致）：
- 资源类（agents profiles、skills、prompts）→ **执行环境**（gateway），不是 Web 主机。
- 模型/凭证类（models.json、auth.json、usage）→ **后端**（唯一 `ModelRuntime` owner）。
- 浏览器类（VAPID 订阅、Service Worker、导出下载）→ **Web host**。
- 传输/编排（会话、fork、分页、读块、策略）→ **后端**。
- 上游源码一律"改编 + 记录 revision/license"，不直取 `dist/` 内部除非版本钉死并记录（现例：`node-ignore` 端口、`prompt-templates` 快照）。

## 5. 未决产品选择（显式清单）

1. 后端 `ModelRuntime` 的出网策略：discover/test/usage 是否按请求开网？离线部署如何降级？
2. models.dev catalog 依赖是否可接受？离线/受限网络的替代。
3. Provider 凭证写入：pi 模式（写后端 auth.json）是否唯一支持写凭证的模式？env 模式只读是否可接受？
4. Session export 的范围：仅活动上下文 vs 含 head 标记之前的原始 entry（后者当前无路由）。
5. Session export 的渲染器：直取 pi dist 内部（版本钉死）vs 原生模板。
6. Push 触发器：轮询目录 vs 后端新增完成事件；订阅状态存 Web 主机文件 vs 后端文档。
7. Agents profiles 的 scope 语义与"运行"是否纳入近期范围；子代理执行复用 task/owner 还是新执行器。
8. 分支导航的产品形态：会话内切 leaf（需运行期原语）vs fork 成新会话（已可用）vs 会话血缘视图。
9. 远程 workbench 的 operation 范围与是否与 SSH 文件 RPC 合并。
10. workbench 缺 surface 的返回码是否统一为具名 `not_supported`（与 worktrees 一致）。

## 6. 建议的下一批

按"先补已提供流程的断层，再选独立功能"：

- **第一批（低风险、可独立验收）**：Provider discover/test/catalog（后端）+ Push（Web host，含触发器）。
  Provider 增强边界清晰；Push 的订阅/发送可以复用，但完成触发器需先验证上述交付策略。
  若尚未确定通知语义，可先将 Session export 排在 Push 前交付。
- **第二批**：Session export（后端，含"完整条目+去 deferred"读与图片策略保持）；Provider 凭证/OAuth（在后端，先定凭证持久化模式）。
- **第三批**：Agents profiles 的只读 → 可写；远程 workbench 的具名 limit → SSH 变体。
- **待决策**：分支导航的会话内树（先做 UI 诚实化，等产品/上游决策）。

每批都应在其**公开 seam**（后端 HTTP / adapter / 组件）留下可复现验收，且不与并发的 Settings 可见性改动耦合。

## 7. 本次未做与剩余限制

- 未实现任何功能（新功能实现被 gate 为范围外）；未部署、未推送、未提交、未 stash、未 reset。
- 未调用任何付费 provider、未发送任何通知、未改动任何真实凭证。
- 未在浏览器中验证 UI（只读组件源码 + adapter public seam 探测）。
- 未对 models.dev 之外的外部 API 做真实调用；provider discover/test/usage 的端到端行为为**推断**，需真实 provider 才能确认。
- 未验证 pi-durable 是否存在未公开的会话内分支原语（只读了 `@earendil-works/pi-durable@1.1.0` 的 `dist/*.d.ts` 公开类型）。

## 8. 证据

| 检查 | 命令 | revision / dirty | exit | 日志 |
| --- | --- | --- | --- | --- |
| Web adapter 公开 seam 探测（501 vs 转发、空树、navigate_tree 501） | `node .dev/research-features/probe-routes.mjs` | `1758c1f` / dirty（其他 worker 文件；本 worker 仅新增未跟踪 scratch 与 git-ignored `.dev/research-features/`） | 0 | `.dev/research-features/probe-routes.log` |
| 上游路由/类型事实 | `curl raw.githubusercontent.com/agegr/pi-web@76bdc57…`（`app/api/{models-config,auth,push,provider-usage,subagents,sessions/[id]/export,tools/settings}`） | 同 | 200 | 见本文 §3 引用 |
| `ModelRuntime` 能力 | 读 `node_modules/.pnpm/@earendil-works+pi-coding-agent@1.1.0*/dist/core/model-runtime.d.ts` | 同 | — | — |
| dormant 判定 | `grep -rn "from \"@/lib/<mod>\"" apps/web --include=*.ts --include=*.tsx`（逐模块） | 同 | 0 | 输出见 §2.1/§3.C |
| 外部主源可达性 | `curl -sS -o /dev/null -w '%{http_code}' <url>`（RFC 8030/8291/8292、W3C Push API、models.dev、npm web-push） | 2026-10-14 | 200 | — |

（`.dev/research-features/` 为 git-ignored 的临时证据目录；本文是唯一交付文档。）
