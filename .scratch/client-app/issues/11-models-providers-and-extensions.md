# 11 — 迁移模型、provider、扩展和共享设置

Type: implementation
Status: resolved (settings routing, the scoped model-loading cache and the panels merged at `fbcac7d`/`7f41151` with the
connection-lifetime fix at `a0f2c01`; provider login and model refresh arrived with that effort's tickets 03–05, and 16's
2026-10-19 closeout re-ran `ux-panel-ingress` 65 and `ux-capability-trust` 17 on the integrated tip). The provider effort's
own limits remain its own: interactive OAuth is not exercised against real upstream endpoints, and no deployed-mode
change was made here.
Blocked by: [05](./05-shared-ui-routing-and-scope.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

用户在两端继续配置 Backend 模型/认证及扩展，连接切换不会显示其他 Backend 的设置。

## Scope

迁移模型列表/配置、provider 授权流程、thinking 等会话设置和 extension inventory/selection。保留现有验证、错误脱敏、选择来源和全局/会话级区别；区分客户端显示偏好与 Backend 账号凭据。

## Acceptance

- [ ] 矩阵中已工作的模型/provider 登录保存/退出与扩展配置均走新入口。（设置面板的读/写已经**经
  `WorkbenchClient`** 发出，见下方第二轮适配；但 Web 上连接 origin 仍是页面自身 origin，ingress 尚非已部署入口，
  因此这条不勾。）
- [x] 模型缓存条目和 in-flight 包含服务端身份作用域。当前 `useAgentSession.loadModels` 经 `modelsCache().load(modelsScopeOf(identity), modelCwd, () => client.readJson(modelsUrl))` 读取；原语已接上实际 composer 路径。下方早期“尚未接入”的记录是历史，后续整合记录取代其当前状态。
- [x] 服务端机密不进入构建/env 前缀、错误正文或日志；未知模型和鉴权失败可恢复。
- [ ] Web/App 设置页面可用，无 UI 仍请求旧 Next 专属 endpoint。

## Verification

复用 models config、missing-model recovery、extensions 与脱敏场景；增加作用域缓存竞态。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Review notes

涉及 G2/G6，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。

## Answer (adapted onto `integration/client-app` 47ec8f0)

本票在 `fix/client-app-11-adapt`（base `47ec8f086ef85f1acf9e2fb722753fac0e969b66`）上重新适配，**不是**把历史分支
`impl/client-app-11` 整体并入。历史分支把设置 UI 放在 `apps/web/`；当前 integration 已把 React 移到
`packages/ui`，因此可移植的是**契约与规则**，不是当时的文件位置。

### 已移植

**1. 后端设置路由的 limit / pass-through 契约**（`packages/gateway/src/ingress/index.ts`，来自 `6722786`）。
Backend 拥有的设置原样转发：`GET /api/models`、`GET`/`PUT /api/models-config`、`GET`/`POST /api/extensions`、
`GET`/`PATCH /api/conversations/:id/settings`、`PATCH …/extensions`。没有 owner 的设置路由在转发前回答 `501` +
`code: "unsupported"` 与原因：`auth/providers`、`auth/login|logout/:id`、`auth/api-key/:id`、`models/enabled`、
`models/default`、`models/refresh`、`models-config/discover|test|catalog`。检查位于身份检查之后，因此未认证调用者
无法枚举本部署缺哪些能力。

**2. 按连接作用域的设置缓存**（`packages/session/src/settings.ts`，来自 `6722786`）。
`connectionScopeOf` 从 descriptor 读 backend id + account scope，缺失即抛错而不默认；`createScopedCache` 的条目键
= 作用域 + 调用者 key，**in-flight 同样按该键**，`invalidate` 用 generation 让已运行中的读不能回填。
`packages/ui/src/lib/connection-scope.ts` 的 `connectionIdentityOf` 现在**调用** `connectionScopeOf`（该文件此前的
注释已写明票据 11 会做这次替换），所以 drafts、remembered views 与设置缓存读到的是同一个作用域；
`packages/ui/src/lib/models-cache.ts` 是该规则的客户端实例（`modelsScopeOf` 复用同一 `ConnectionIdentity`），不是第二份实现。

**3. composer 能力门控移植到 `packages/ui`**（来自 `f9c665a`，落到当前 shared-client 位置）。
`packages/ui/src/lib/capability-availability.ts` 的 `useCapabilityServed` 改为**经 `WorkbenchClient` 提问**
（`connection.client.request`），而不是相对全局 `fetch`：App 的页面来自 bundle，没有可解析 `/api` 的 origin。
新增 `composerDefaultStars(served, hasConversation)` 一处判定两个 star，`ChatWindow` 据此传
`onSetDefaultModel` / `onSetDefaultThinkingLevel`；`ModelsConfig`、`SettingsPanel` 的四处探测改为该 hook。
Web 页面自身托管的 `/api/push/config` 显式传入自己的 transport。

### 未移植 / 需后续

- **`apps/web/lib/models-cache.ts` 未改为 scoped cache。** 当前树里它只有 `apps/web/adapters/durable-api.ts` 一个
  调用者（`PUT models-config` 后 `invalidateModelsCache()`），而 `loadModelsWithCache` 已无调用者；`apps/web/vendor/pi-web`
  下是上游快照，`apps/web/lib` 与它现在 byte-identical。这条路径属于票 17 的退役范围，把 dormant Web-only 代码改成
  新规则不构成本票验收，因此不做。
- **`packages/ui` 的 composer 尚未真正读缓存。** `useAgentSession.loadModels` 仍直接 `fetch("/api/models")`（并同样
  是相对路径）。`models-cache.ts` 目前只由测试驱动。把 composer 的模型读取接到该缓存需要在
  `packages/ui/src/hooks/useAgentSession.ts` 内改动，而该文件属当前活动的 ticket-05 host-I/O worker，本票不触碰。
  这是**同一批文件的后续**，不是已完成项。
- 其余相对 `fetch("/api/…")` 在**第二轮适配**（`fix/client-app-11-ui`）中已改走连接，见下方。
- 未做 provider 登录流程（它就是明确的 limit）。`ModelsConfig` 的 OAuth 登录仍用 `new EventSource("/api/auth/login/<id>")`：
  `WorkbenchClient` 没有任意 URL 的流 seam，而该路由在 App 里本就是 `501` 限制，因此不改。
- `apps/web/e2e/ux-capability-trust.fixture.css` 的样式导入原本指向 `apps/web/app/settings.css`，该文件在票据 05 把
  样式移入 `packages/ui/styles` 后已不存在，因此这条已交付的浏览器检查在 base `47ec8f0` 上**本来就构建失败**。本票把它
  改成 `@hepi/ui/styles/settings.css`（一行），检查恢复运行并通过；这是让本票的 host-aware 能力探测可被真实浏览器验证
  的必要修复，不改变该检查的断言。
- 未改 `docs/verification.md` / `docs/migration-status.md`：这两处与 ticket-05 worker 共用，本票只新增
  `docs/client-ingress.md` 的 [settings 段](../../../docs/client-ingress.md#settings-over-the-client-api-ticket-11)，
  命令/exit code/日志记录在本文件下方。

### 验证（提交后于 `fix/client-app-11-adapt` 的 revision `c78923a` 上重跑，clean tree，base `47ec8f0`）

| 检查 | 命令 | exit | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| 设置路由 seam（真实 HTTP + 真实 Backend） | `node --test packages/gateway/test/settings.test.ts` | 0 | 4/4 | `.dev/verify/ticket11-adapt/gateway-settings.log` |
| 作用域缓存 + 能力门控 | `node --test packages/ui/src/lib/models-cache.test.mjs packages/ui/src/lib/capability-availability.test.mjs` | 0 | 13/13 | `.dev/verify/ticket11-adapt/ui-settings.log` |
| ingress 回归（凭证 / 会话 / 目录） | `node --test packages/gateway/test/ingress.test.ts packages/gateway/test/ingress-conversation.test.ts packages/gateway/test/ingress-catalogue.test.ts` | 0 | 22/22 | `.dev/verify/ticket11-adapt/ingress-regression.log` |
| typecheck（gateway + session + ui） | `pnpm --filter @hepi/gateway --filter @hepi/session --filter @hepi/ui -r typecheck` | 0 | 三包 clean | `.dev/verify/ticket11-adapt/typecheck.log` |
| UI 套件 | `pnpm --filter @hepi/ui test` | 0 | 129/129 | `.dev/verify/ticket11-adapt/ui-suite.log` |
| session 套件 | `pnpm --filter @hepi/session test` | 0 | 39/39 | `.dev/verify/ticket11-adapt/session-suite.log` |
| 能力门控浏览器检查（真实 Chromium + 生产 SettingsPanel） | `pnpm --filter @hepi/web test:capability-trust` | 0 | 全项 ok；三次挂载各问一次 `/api/push/config`，无静默重试 | `.dev/verify/ticket11-adapt/capability-trust-browser.log` |
| 文档链接 | `node scripts/check-docs.mjs` | 1 | 12 条既有断链，与 base `47ec8f0` 完全相同的集合（对照 `/tmp/t11-base-docs.log`，同一命令 `--root` 指向该 revision 的 detach worktree） | `.dev/verify/ticket11-adapt/check-docs.log` |
| `verify:changed --base=47ec8f0` | `pnpm verify:changed --base=47ec8f0` | 1 | 4 步通过（changed-typecheck、changed-test、web-unit；changed-test 内 session 39/39、ui 129/129、app 2/2、gateway 329/329、server 453/453），唯一失败为 `check-docs` 的既有 12 条断链 | `.dev/verify/ticket11-adapt/verify-changed.log`，报告 `.dev/verify/2026-10-17T21-31-39-347-verify-changed/verify.json`（`sha c78923a`, `dirty: false`） |

`.dev/verify/` 是 git-ignored，日志不入提交。红-绿证据：去掉 ingress 的 `settingsLimit` 调用后，`GET /api/auth/providers` 得到
`404` 而不是 `501`，`packages/gateway/test/settings.test.ts` 3 例失败（`.dev/verify/ticket11-adapt/red-settings-limit.log`），
恢复后 4/4 通过。

## 第二轮适配（`fix/client-app-11-ui`，base `ad81b12` = `fix/client-app-11-adapt` 的 tip）

第一轮适配把**能力探测**改成经 `WorkbenchClient`，但四个设置面板的数据读/写仍是相对 `fetch("/api/…")`：App 的
页面来自 bundle，没有可解析 `/api` 的 origin，这些请求会打到 bundle 自己的地址上。本轮把面板的读/写也接到连接上。

### 已改

- 新增 `packages/ui/src/lib/api-request.ts` 的 `useApiRequest()`：返回 `connection.client.request`；没有连接时
  （浏览器 fixture 单挂一个面板）回退到页面自身 origin 的 `pageOriginRequest`。该常量原先是
  `capability-availability.ts` 里私有的，现在导出复用，没有第二份实现。
- `SettingsPanel`（General 的 `web-auth` 读/删除、`tools/settings` 读/写）、`ModelsConfig`（`models-config` 读/写、
  `auth/providers`、`models-config/discover|test|catalog`、`auth/login|logout/:id`、`auth/api-key/:id`）、
  `EnabledModelsSection`（`models/enabled` 读/写、`models/refresh`）、`ExtensionsConfig`（`extensions` 读/写、
  `sessions/:id/state`）全部改走 `useApiRequest()`，对应 effect/callback 的依赖里加上该 request。
- 例外只有两处，且是有意的：`SettingsPanel` 的 `/api/push/config` 仍是页面宿主自己的路由（显式传
  `pageOriginRequest`）；`ModelsConfig` 的 OAuth 登录仍是 `EventSource`（`WorkbenchClient` 没有任意 URL 的流 seam，
  且该路由在 App 里本就是 `501` 限制）。
- Web 上连接 origin 为空（同源），因此这些请求与改动前等价；App 上则带上配置的 ingress origin 与该连接自己的
  bearer/cookie。

### 未改（仍属后续）

- `packages/ui/src/hooks/useAgentSession.ts` 的 `loadModels` 仍是相对 `fetch("/api/models")`，也仍未使用
  `models-cache.ts`；该文件属 ticket-05 host-I/O worker，本票不触碰。**这正是验收第 2 条保持未勾的原因。**
- `apps/web/lib/models-cache.ts`（dormant Web-only 路径）未改，属票 17 退役范围。

### 验证（提交后于 `fix/client-app-11-ui` 的 revision `39f4089` 上重跑，clean tree，base `ad81b12`）

| 检查 | 命令 | exit | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| 面板 origin/凭证浏览器 seam（真实 Chromium + 生产面板 + 真实 `createClient`） | `pnpm --filter @hepi/web test:panel-ingress` | 0 | 18 项全 ok：12 个请求全部落在配置的 ingress origin、全部带 `Bearer …`、`credentials: same-origin`，路径集合恰为部署路由；push 是唯一页面 origin 请求 | `.dev/verify/ticket11-ui/panel-ingress.log` |
| UI 套件 | `pnpm --filter @hepi/ui test` | 0 | 129/129 | `.dev/verify/ticket11-ui/ui-suite.log` |
| 能力三态浏览器检查（既有 seam） | `pnpm --filter @hepi/web test:capability-trust` | 0 | PASS | `.dev/verify/ticket11-ui/capability-trust.log` |
| 扩展面板浏览器检查（既有 seam） | `pnpm --filter @hepi/web test:extensions-panel` | 0 | PASS | `.dev/verify/ticket11-ui/extensions-panel.log` |
| 连接作用域浏览器检查（既有 seam） | `pnpm --filter @hepi/web test:workbench-scope` | 0 | PASS | `.dev/verify/ticket11-ui/workbench-scope.log` |
| typecheck（ui + web） | `pnpm --filter @hepi/ui --filter @hepi/web -r typecheck` | 0 | 两包 clean | `.dev/verify/ticket11-ui/typecheck.log` |
| `verify:changed --base=fix/client-app-11-adapt` | `pnpm verify:changed --base=fix/client-app-11-adapt` | 0 | 3 步通过（changed-typecheck、changed-test、web-unit；changed-test 内 ui 129/129、app 2/2） | `.dev/verify/ticket11-ui/verify-changed.log`，报告 `.dev/verify/2026-10-17T22-01-13-712-verify-changed/verify.json`（`sha 39f4089`, `dirty: false`） |

既有但**在 base 上就已失败**、本轮记录而不修的检查：`pnpm --filter @hepi/web test:models-config`、
`test:missing-model`、`test:extensions-selection` 三者在 `ad81b12` 与本轮 revision 上都在脚本第 35/40/46 行断言
`apps/web/.next/BUILD_ID` 存在——那是 Next 构建产物，而票据 05 已把 `apps/web` 的构建改成 vite（产物在 `dist/`），
所以这三条检查在任何 revision 上都无法启动。已在 base `ad81b12`（clean）上以同一命令复现同一断言失败
（`.dev/verify/ticket11-ui/base-models-config.log`），属既有缺陷，与本轮改动无关；本轮新增的 `ux-panel-ingress`
用组件级真实 seam 覆盖了同一批面板。

## 第三轮：模型目录接入作用域缓存并修正共享请求生命周期（`fix/client-app-11-cache-fresh`，base `integration/client-app` `e257e3d`）

第二轮把设置面板的读/写接到连接，但 composer 自己的模型读取（`useAgentSession.loadModels`）仍是相对
`fetch("/api/models")`，也仍未使用作用域缓存——这正是验收第 2 条未勾的原因。本轮把这条**实际加载路径**接上，并修正
此前在 `fix/client-app-11-cache` 上遗留的共享请求生命周期问题。该旧分支的树基于 `7d910e0`（其后的集成 tip 已并入
MCP 等改动），无法快进，因此本轮**从 `e257e3d` 新建 worktree 重建**同一改动；旧分支保持原样、不再合并。

### 已改

- `loadModels` 经 `client.readJson` 读 `/api/models?cwd=…`（本连接的 Gateway origin + 本连接的凭证），结果交给
  `lib/models-cache.ts` 的 `createModelsCache`。键 = `modelsScopeOf(identity)`（描述符里的 Backend id + account scope）
  + cwd；条目与 in-flight 同键。页面只持有一个该缓存实例（`useAgentSession.ts` 的模块级 `modelsCache()`），与
  `session-view-cache.ts` 同一形态。
- 关闭 Settings 触发的 `modelsRefreshKey` 变化、以及 `saveDefaultPreferences` 成功后都会 `invalidate()`；后者也从相对
  `fetch` 改为 `client.readJson`（该路由在本部署由 ingress 回 `501`，面板入口已由 `composerDefaultStars` 关闭，所以
  这条写入在 Web/App 上都不会真正发出）。
- **共享请求生命周期**（本轮修正，`packages/ui/src/client.ts` + `useAgentSession.ts`）：
  - 共享的目录读属于连接，不再挂 composer 自己的 `signal`：StrictMode 的 cleanup、另一个 composer 卸载都不会中止
    别人仍在等待的那次请求。composer 自己的 `signal` 只用来围住**自己的 state**（`signal?.throwIfAborted()` 在任何
    写入之前）。
  - 重试循环只在**本 composer 自己的 abort** 或**连接已 dispose**（`client.disposed`）时结束，不再把任意
    `AbortError` 当作自己的失败：共享读被别的消费者或连接退休后，下一次询问仍可能被回答。
  - `client.ts` 新增连接级 `lifetime`：`dispose()` 中止在途请求；`request()` 在 transport 迟到答复之后、`readJson()`
    在 body 迟到之后都再检查 `disposed`，以 `closed` 拒绝；caller 的 `init.signal` 手工合并转发（不用
    `AbortSignal.any()`——本应用浏览器下限 Safari 16.2 没有它，`mcp-config-helpers.ts` 已有同一约定），请求结束即解绑
    监听。

### 红→绿（真实 hook bundle + 真实 `createClient`）

- 绿：`packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs` 新增 4 例——“a shared model read survives StrictMode
  replay”、“a shared model read survives another consumer leaving”、“disposing the connection retires its shared model
  read and no late answer lands”、“the model catalogue is read through the connection, and cached per connection rather
  than per folder”；`packages/ui/src/client.test.mjs` 新增 1 例——“connection disposal aborts pending requests and fences
  a transport that answers late”（同时覆盖 body 迟到与 caller 自己 abort 不牵连连接两条）。
- 红：把 composer 的 `signal` 重新挂回共享读、并去掉 `dispose()` 里的 `lifetime.abort()`，5 个新用例全部失败
  （lifecycle 3 fail、client 1 fail），日志 `red-lifecycle.log`、`red-client.log`；恢复后全绿。恢复后的两个源文件与
  `7f41151` 逐字节相同（md5 比对）。

### 验证（`7f41151`，clean tree，base `e257e3d`）

| 检查 | 命令 | exit | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| 连接 seam | `node --test packages/ui/src/client.test.mjs` | 0 | 4/4（含新增 1 例） | `.dev/verify/ticket11-cache-fresh/client.log` |
| hook 生命周期（真实 hook bundle + 真实 `createClient`） | `node --test packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs` | 0 | 22/22（含新增 4 例） | `.dev/verify/ticket11-cache-fresh/lifecycle.log` |
| 作用域缓存规则（未改） | `node --test packages/ui/src/lib/models-cache.test.mjs` | 0 | 7/7 | `.dev/verify/ticket11-cache-fresh/models-cache.log` |
| UI 套件 | `pnpm --filter @hepi/ui test` | 0 | 166/166 | `.dev/verify/ticket11-cache-fresh/ui-suite.log` |
| UI typecheck | `pnpm --filter @hepi/ui typecheck` | 0 | clean | `.dev/verify/ticket11-cache-fresh/typecheck.log` |
| 空白/冲突标记 | `git diff --check` | 0 | clean | 无（内联输出） |
| `verify:changed --base=e257e3d` | `pnpm verify:changed --base=e257e3d` | 0 | 3 步全通过（changed-typecheck、changed-test、web-unit 49/49） | `.dev/verify/ticket11-cache-fresh/verify-changed.log`，报告 `.dev/verify/2026-10-18T04-53-24-907-verify-changed/verify.json`（`sha 7f41151`, `dirty: false`） |

| `verify:changed --base=e257e3d`（文档提交 `80c5bca`，含 `check-docs`） | `pnpm verify:changed --base=e257e3d` | 1 | changed-typecheck、changed-test、web-unit 三步通过；唯一失败是 `check-docs` 的既有 12 条断链 | `.dev/verify/ticket11-cache-fresh/verify-changed-docs.log`，报告 `.dev/verify/2026-10-18T04-56-29-561-verify-changed/verify.json`（`sha 80c5bca`） |
| `check-docs` 基线对照（`e257e3d` 导出到 `/tmp`） | `node scripts/check-docs.mjs --root=<e257e3d 的导出>` | 1 | 12 条断链，`file/line/target` 集合与本轮 tip **逐条相同**（全部在 `.scratch/**`，与本轮改动文件无关；两侧差异只是 `resolved` 的根路径） | `.dev/verify/ticket11-cache-fresh/check-docs-base.log` / `check-docs-tip.log` |

该 worktree 初始无 `node_modules`，先在其中 `pnpm install --frozen-lockfile`（exit 0，
`.dev/verify/ticket11-cache-fresh/install.log`），因此 `@hepi/*` 链接指向本 worktree 而不是集成 worktree。

`check-docs` 的 12 条断链是既有缺陷：在 base `e257e3d` 上以同一命令复现，`file/line/target` 逐条相同，本轮三个文档
改动没有新增断链。

### 未勾 / 剩余

- 验收第 1、4 条仍依赖 Web/App 的入口切换（票据 16）：本票证明的是协议、公开 seam 与 Node 内的真实 HTTP 行为。
- provider 登录流程未做（`WorkbenchClient` 无任意 URL 的流 seam；该路由在 App 里本就是 `501` 限制）。
- `apps/web/lib/models-cache.ts`（dormant Web-only 路径）未改，属票 17 退役范围。
- 本轮只跑 Node 侧 seam，未重跑真实 Chromium 的面板检查：本轮改动都在 `packages/ui` 的连接层与 composer，面板
  origin/凭证已由第二轮的真实 Chromium 检查覆盖。


### 集成落点（`integration/client-app`，`fbcac7d` 起，seam 修正 `a0f2c01`）

本票的 `fix/client-app-11-cache-fresh`（`7f41151`、`80c5bca`、`9625896`）已并入 `integration/client-app`，与
`fix/client-app-06-fresh`（`efdd9ae`）、`fix/client-app-08-fresh`（`be2712f`、`8edf8d3`）和
`impl/client-app-15`（`758dcf0`）同树。合并后未发现本票语义冲突：`packages/ui/src/client.ts` 的自动合并保留了 08 的
`limits` 透传与本轮的 `credential`、`lifetime`、迟到答复栅栏。合并树上的检查（`a0f2c01`，clean，base `e257e3d`）：

| 检查 | 命令 | exit | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| 连接 seam | `node --test packages/ui/src/client.test.mjs` | 0 | 5/5 | `.dev/verify/merge-client-app-3/client.log` |
| hook 生命周期 | `node --test packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs` | 0 | 22/22 | `.dev/verify/merge-client-app-3/lifecycle.log` |
| 作用域缓存规则 | `node --test packages/ui/src/lib/models-cache.test.mjs` | 0 | 7/7 | `.dev/verify/merge-client-app-3/models-cache.log` |
| UI 套件 | `pnpm --filter @hepi/ui test` | 0 | 184/184 | `.dev/verify/merge-client-app-3/ui-suite.log` |
| UI typecheck | `pnpm --filter @hepi/ui typecheck` | 0 | clean | `.dev/verify/merge-client-app-3/ui-typecheck.log` |
| 所选检查 | `pnpm verify:changed --base=e257e3d` | 1 | workspace-typecheck、workspace-tests、web-unit、script-tests、check-entrypoints 全 0；仅 `check-docs` 1（既有 12 条 `.scratch/` 断链，与 `e257e3d` 导出树逐条相同） | `.dev/verify/merge-client-app-3/verify-changed.log`，报告 `.dev/verify/2026-10-18T05-30-05-618-verify-changed/verify.json`（`sha a0f2c01`, `dirty: false`） |

**合并后修正（本票连接 seam 的缺陷，非新增能力）**：`requestSignal.release()` 原本在 `fetch` 解析（响应头到达）时就解绑
监听，于是**调用方自带 `signal` 时**，响应体尚未读完就已失去连接生命周期与调用方的中止能力。复现（`.dev/verify/merge-client-app-3/probe-signal.log`）：
自带 signal、body 挂起、`dispose()` 后 transport signal 仍为 `false`，迟到的 body 只被 `readJson` 的 `disposed` 栅栏拒绝。
红→绿见 `.dev/verify/merge-client-app-3/red-client-signal.log`（1 fail：`disposal reaches a body that arrived after the headers`）与
`.dev/verify/merge-client-app-3/green-client-signal.log`（5/5）。修正保留在 `packages/ui/src/client.ts` 的连接 seam：组合信号活到 body 读完，
无 body 的响应立即释放。当前唯一带 `signal` 且非 JSON 的消费方是 `ProjectTrustDialog` 的 `/api/project-trust`
（`client.request` + `response.json()`，数据到齐后立即 abort），因此该缺陷今天不会造成可见失败；它被修正是因为 seam 的
契约声明就是「请求由连接与调用方结束」。



## Status reconciliation — 2026-10-19

Inspected `packages/ui/src/hooks/useAgentSession.ts` at integration `3e69c62` (application source `9400dcc8`): actual model loading uses the scoped page cache and connection reader, fences consumer abort before updating UI, and keeps the shared read tied to client lifetime. `fbcac7d` and `a0f2c01` are integration ancestors. Thus the cache acceptance row is complete; the historical “cache not on loading path” header was stale. Remaining Web/App and deployed-journey rows stay open until owning acceptance16 supplies current evidence. Provider03/04 adds OAuth/active refresh separately and is being integrated; its pending work is not silently claimed here. No source edit or additional test run for this correction.
