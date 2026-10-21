# Hepi 客户端架构蓝图：入口、共享 UI 与交付路径

日期：2026-10-17。源码基线：`848f391b4245070b6677704d6a64e2a0d7356996` 加当前工作区。本文补充[架构适配研究](hepi-client-architecture-adaptation.md)，仅做架构研究，未创建 App、修改业务代码或部署服务。用户已选 **Tauri v2、共享 React UI、React Router、App/Web ↔ Gateway ↔ Backend**；Backend 保持 agent loop、durable runtime 和唯一 SQLite writer。用户新增完成条件：**被新方案替代的旧 feature 必须完整移除，不能以新旧长期并存交付。** 项目仍为私人项目，用户明确无有价值历史：直接替换，不规划旧用户/旧 PWA/旧草稿升级、历史数据搬迁、旧版本兼容或回滚演练。旧 feature 按旧实现与残留路径退役，目标能力以实施规格为准。下面的模块命名、认证细节与实施阶段均为建议。产品功能留在[功能储备](app-architecture-and-pilo-study.md)。

实施时先读[规格](../../.scratch/client-app/spec.md)与[17 张票据及依赖](../../.scratch/client-app/ticket-breakdown.md)；设计缺口、源码证据、适用模式及 deep-module 三案比较见[审查记录](../../.scratch/client-app/review-notes.md)；其中 P1–P5 给出重复读取、流编码、metadata 和资源/渲染成本的落点。本轮完成规划，应用代码与部署未改动。

> **定点记录（2026-10-17）。** 本文是实施前蓝图；其入口合同与认证归属已在 [客户端入口](../client-ingress.md) 与
> [架构](../architecture.md#ownership) 中实现。蓝图中的阶段建议不再描述现状。

## 1. 收敛后的结构

```text
Web browser ── 同源静态 UI + Cookie ─┐
                                     ├→ Gateway 客户端入口 /api → Backend agent loop / durable / SQLite
Tauri WebView ── 静态 UI + Bearer ────┘                                  │
                                                                          └→ execution Gateway /v1
```

Web 目标为 Vite SPA；认证/代理直接由新入口承接，不安排旧 Next 过渡代理。Web 具体构建选型不影响已确定的 React Router，也不能成为保留旧入口的理由。执行宿主可以是入口 Gateway，也可以是另一个本地/SSH Gateway，不能按入口机器推断工作区位置。

建议目录只新增真实需要的安置点：

```text
apps/web/                         # Vite Web composition root；旧 Next 删除
apps/app/                         # Vite 静态入口、Tauri 配置、必要 Rust 原生能力
packages/ui/src/
  components/ hooks/ lib/ styles/ # 共用 React、纯投影、草稿与界面资源
  client/                         # Gateway 请求、资源、连接作用域
packages/session/                 # 既有 SSE reader、订阅管理、wire state
packages/protocol/                # 既有协议、DTO、资源路径
packages/gateway/src/client-entry/ # 服务端入口：认证、客户端路由、Backend 访问
apps/server/                      # 既有权威运行时与持久化；必要认证持久化扩展
```

`packages/client` 仍是 gateway/doctor CLI。不另建平行的 UI SDK、client-state 或 Rust 业务 RPC；先以 `packages/ui` 内部模块收口。`packages/*` 不反向导入 `apps/*`。Gateway 服务端不得为复用少量 helper 引入 React UI 包；必要的纯 DTO/路由词汇可按实际双端依赖放到 protocol，展示映射则留在入口。

## 2. Gateway 客户端入口合同

当前 Next BFF 包含实际映射与编排，不只是改写 URL。复用必要映射到 Gateway，调用者随新合同同步修改；复用 `/api` 是代码选择，不承担旧 URL 兼容。以下是关键切片，不是完整端点表。[S1][S2]

| UI 请求 | 当前 Backend/执行路径 | 入口迁移必须保留 |
| --- | --- | --- |
| `GET /api/sessions`、`sessions/search`、`agent/running` | conversations catalog、search，加 projects/workspaces | 侧栏行、running/list/sidebar revisions；不能退回每个会话全量读取 |
| `GET /api/sessions/:id`、`:id/state` | `/api/conversations/:id/state` | 原生 snapshot；只在共享 UI 做 transcript/lifecycle 投影 |
| `GET /api/sessions/:id/context`、`:id/read` | conversations entries/read | history window、字节预算、continuation；不拼全量历史 |
| `POST /api/agent/new` | 创建 conversation → 可选 settings PATCH → 读取状态 | 首次发送前设置生效；失败可能已创建会话，不能整段盲重试 |
| `POST /api/agent/:id` | prompt 映射 conversation.submit；其他控制按现有分支 | 原始 requestId、images、busy 模式；明确拒绝与未知结果 |
| `GET /api/agent/:id/events` | `/api/conversations/:id/events` | 命名 SSE、原生 snapshot/revision、resync、heartbeat、取消 |
| `GET /api/agent/:id/submissions?requestId=` | 原生 submissions lookup | 查无记录仍是未知，不变成拒绝或自动重发 |
| sessions entries 的 thinking/text/tool-result-image | 原生 entry read-block | 长文本按既有 JSON、图片按 bytes/content-type；不混淆媒体与 JSON |
| 文件/终端/工作台 | Backend relay → binding 所属 Gateway | workspace 解析、上传冲突/部分成功、range 与终端自己的 replay 规则 |
| MCP、project-trust、agent-definitions | 现有 host-scoped adapter | 保留宿主身份与凭证归属；不能泛化成全部经过 durable Backend |

完整 Web 切换还需盘点 models、settings/providers、extensions、队列、fork/delegation、skill-market 等现有功能；最小 App 切片不能被当成 Web 全量替换完成。当前显式返回 501 的能力，如部分文件 watch/DOCX，不因换入口就成为已支持。[S1][S3]

入口内部建议分三件事：认证得到当前访问身份；复用必要的客户端映射；用服务端配置调用 Backend 或指定宿主。HTTP `Request/Response` 与流作为外部 interface，Backend URL/token、host identity、取消和错误映射藏在 implementation。Node listener 到 Web Request 的适配需验证流和断开传播，不能把整个 body 先读入内存再交给路由。上传 parser 当前还导入 `next/dist/compiled/busboy/index.js`；迁入口时需改成明确的服务端 parser 依赖，保持现有流式与限额合同，而不是把 Next 一起带进 Gateway。[S9]

### 外部入口与内部执行不能共用权限

推荐外部 listener 只接受客户端 `/api` 与静态 UI；内部执行 listener 继续接 Backend 的 `/v1`。可在同进程，分别监听或由严格路由分发隔离。路径前缀本身不是认证措施；设备凭证不能调用 `/v1/execute`，内部 execution token 也不能自动登录客户端入口。部署反代不能把内部 listener 全量公开。

Backend 的 HostClient 仍连接 execution listener，入口反向调用 Backend 使用独立服务间凭证。这样即便请求路径是入口 → Backend → 同进程 execution listener，也没有路由递归。并发流不能持有阻塞内部执行的全局串行锁；应以一个正在接收 SSE 的客户端同时触发工具调用验证。

迁移 `HEPI_WEB_LOCAL_GATEWAY_ID` 时，以可信入口配置承接 host-scoped 默认位置；与显式 workspace 所属执行宿主分开。客户端不提供内部 origin/token，未知 workspace 不退回入口机器 cwd。每个 SSH execution Gateway 不默认开启客户端入口。[S1][S4]

## 3. React Router、共享 UI 与连接作用域

React Router 已确定。本轮重新读取官方 Picking a Mode：已有自有数据层的应用是 Declarative 模式列出的适用情况。建议先采用该模式：Web `BrowserRouter`、App `HashRouter` 共用一套路由和导航逻辑；现有请求、SSE、投影仍负责数据。若后续确实需要 route loaders，可改 Data 模式；现在不为路由新增数据缓存、mutation action 或默认重试。[E1][E2]

首期保留现有 `?session=`、`?cwd=`，降低迁移变量。路由只表达会话/工作区/面板选择；不存 snapshot、revision、凭证或待发送正文。Web 部署支持客户端路径 fallback；App hash 路由避免把 UI 深路径当打包资源路径。`window.location.search` 在 hash 模式下看不到 hash 内 query，现有直接读取必须跟随 React Router 的 location/search params 一起迁移，不能只替换 `next/navigation` import。[S5]

两端由 React Router composition root 提供导航，移动实现时同步更新调用者，不为旧 Next 增加导航桥接。不要在每个组件判断 Tauri。`next/image` 的普通图标可替换为普通图片；认证历史图片仍需下面的资源加载合同。App 产物不能包含 Next server、undici、Node 内置模块或 coding-agent runtime；类型依赖与运行时代码分别审计。

### 切连接是一整套作用域变化

当前 session view cache 用 sessionId，models cache 用 cwd，草稿与其他本地存储也依赖单 origin 的假设；AgentEventConnection 每个实例按 sessionId 管连接。[S6][S7] 新 App 同窗口切 Gateway/账号时必须整体换连接作用域。

建议每个连接资料使用本地稳定 profile ID，结合当前认证身份/代次隔离 session、workspace、draft 等键；profile 的目标地址或身份改变即清空该连接缓存并提高 acquisition generation。不要假设 execution gatewayId 能唯一标识 Backend，也不自动合并两个别名地址的缓存。必要时只清空缓存，比首次迁移即重构所有缓存键更小。

一次切换按以下顺序完成：停止旧读取/订阅 → 保存属于旧作用域的草稿 → 废弃旧 generation → 销毁旧连接缓存与 Blob URL → 建立新 client/订阅 → 读取新目录与 snapshot。迟到响应即使 sessionId 相同，也不能写入新作用域。

根级主题/字体/i18n 可留在应用层；client、AgentEventConnection、完成通知订阅与 terminal fan-in 属于连接作用域。可见会话是订阅者之一：离开聊天不意味着关闭仍被完成通知使用的共享流；沿用最后一个 subscriber release 才断开的规则。[S7]

## 4. 认证、资源与平台选择

### 建议的最小身份模型

当前是单一部署访问 token，不应把它误称已有多用户授权。目标建议先保持单一所有者能力，为各设备生成独立随机、可撤销凭证，不先引入角色体系。[S1]

为符合 Backend 负责持久化的方向，建议 **Backend 持有设备凭证摘要与撤销记录，Gateway 处理入口验证及浏览器 Cookie**；具体签发/校验端点在实施规格中定义。这是研究建议，尚未采用或实现。初期可由受信任操作端 provision 设备凭证，无须先实现二维码配对 UI。原始设备 secret 只在签发/设备保存时出现，内部 Backend/execution token 不发给 App。

本来就访问 Backend 的请求，建议在同一次内部调用中校验客户端身份并执行业务；不要固定先做一次 auth probe 再做一次业务调用。入口本地处理的 host-scoped 请求才需要单独获取认证结果。SSE 建连时验证；暂不加分布式 token cache、JWT refresh 或第三套身份库。必须给出活动流撤销策略，例如撤销通知使对应 Gateway 流结束，或有界重新鉴权；仅拒绝下一次 HTTP 请求不能宣称当前长连接立即撤销。撤销客户端连接不等于 abort Backend 正在运行的 agent。Backend 不可达时如实报不可用，不用 stale UI 推定已登录或已完成。

静态 Web 由 Gateway/同源入口承接登录、退出、httpOnly/secure/sameSite Cookie 与写请求 Origin 验证。App 使用 Bearer；不能照搬 Web 的“每次写请求必须与 Host 同源”规则拒绝合法 WebView 请求，也不能因此取消 Cookie 路径的 CSRF 防护。CORS OPTIONS 按允许的实际 origin/method/header 回答；CORS 不是权限验证。外部 HTTPS 与可信反代的转发头策略一起定义。

### 资源适配不止 fetch JSON

| 通道 | Web 同源 | App 适配建议 |
| --- | --- | --- |
| 会话读写/长文本 | Cookie fetch | Gateway client 解析 URL、加 Bearer、AbortSignal |
| 会话 SSE | 既有 fetch source | 沿用 parser/订阅管理，注入客户端路径与认证 |
| 终端 SSE/文件 watch | 部分调用原生 EventSource | 使用认证 fetch reader；保留各流自己的事件、cursor 与 reset 合同 |
| 历史图片/文件预览 | Cookie 媒体 URL | 认证 fetch → Blob URL；作用域切换或视图释放时 revoke |
| 下载 | 同源 Cookie 链接 | 认证下载与原生保存；大文件验证边读边写，不默认整文件 Blob |
| 上传 | 既有流式 multipart adapter | 继续边读边转发、总量限制与冲突/部分成功规则 |

`@hepi/session` 的 `cookieBffSource` 指向 `/api/agent/:id/events`；现有 `bearerSource` 固定指向 Backend `/api/conversations/:id/events`，用于诊断页面。后者不能仅替换 origin 就作为新 App source；需要沿既有 seam 提供 Gateway 路径与认证，避免第二套 SSE parser。[S7]

资源 URL 只允许认证请求发往当前可信 Gateway 及约定路径，拒绝协议相对外站、非允许 origin 或跨源重定向携带凭证。禁止把长期 token 放 URL。无需首期就增加一次性资源 ticket 系统。

优先验证 WebView 原生 fetch，受阻才选 plugin-http。CSP `connect-src`、CORS 与插件 capabilities 是不同限制；动态 Gateway 地址也受打包策略制约，不能承诺“配置任意 URL 即可连接”。先明确支持的 HTTPS 部署范围；HTTP 局域网/localhost、Android cleartext 与 iOS ATS 作为单独平台用例，不能默认放开全网。Stronghold 需要密钥/解锁设计，仍需选定实际设备凭证存储方式。[E3][E4][E5]

## 5. 流、取消与恢复验收

代理保留原始 SSE bytes 与上游错误；非 2xx JSON 错误不能强制标成成功 SSE。分清连接阶段、普通 JSON timeout 与持续流读取：heartbeat 能维持正常空闲，不代表手机后台一定维持网络。`X-Accel-Buffering: no` 是相关反代提示，不是 WebView 不缓冲的保证，需经真实公网路径与目标设备验证。[S2][E3]

下游 reader 取消应传播至 Gateway 和 Backend stream reader，释放订阅/定时器；**关闭流不等于停止 agent**。停止任务仍用明确 control 请求。上传断开可能已写入，终端输入/执行结果也可能未知，不能把所有 mutation 当可重放请求。

resume 时废弃旧 acquisition，恢复当前作用域会话并读取 Backend 允许的 snapshot/revision。当前浏览器 source 每次连接读取 baseline，不会自动发送 `after`；现有代理支持该参数不等于 App 已有 delta replay。可继续用 fresh snapshot 恢复，不为省一次 snapshot 重写协议。会话 revision、history cursor 与 terminal event ID 彼此独立。[S2][S7]

现有 pending submissions 按 ADR 0006 在内存中：普通断线仍对已知 requestId 做 lookup；进程被杀后重新读取 durable snapshot/outstanding。不要宣称未持久化的客户端 requestId/未发出草稿都能恢复，也不为此偷偷增加离线发送队列。若以后要求冷启动保留本地未决收据，应单独定义持久化与隐私合同。[S8]

## 6. 构建、部署与实施顺序

Web 与 App 分别构建、共享源码：Web 使用同源入口；App 内嵌静态资源，运行时选 Gateway，包内没有服务器密钥。pnpm workspace export、TypeScript 路径、Tailwind 源扫描、字体/静态 URL、xterm/KaTeX CSS 随 UI 抽取迁移。不能靠 apps/web 的 `@/` alias 或 node_modules 布局偶然工作。

React Router SPA fallback 只应用于页面导航；`/api`、内部 `/v1`、缺失 JS/CSS 和媒体不得返回 `index.html`。公开入口可以由既有可信反代提供 TLS/静态文件，Gateway 提供 API；不为删除 Next 再造通用 Web server。长连接 idle/buffering 设置与已存在 heartbeat 对齐，避免套短 JSON timeout。

构建仍在本地工作站/CI，远端运行宿主只接收预构建产物，遵守[部署 runbook](../deployment-runbook.md)。Tauri Linux 系统依赖、Android SDK/NDK/JDK、iOS macOS/Xcode/签名条件按目标平台检查；本轮未验证本机具备任何完整移动构建链。[E6]

| 阶段 | 范围 | 进入下一阶段的证据 |
| --- | --- | --- |
| 0. 实施规格 | 首发桌面/移动目标、外部入口/TLS、认证权威、API 表、旧 feature 退役清单 | 每项旧能力明确迁移或删除、替代 seam、删除范围与证据 |
| 1. 入口 | 实现一个首屏与发送切片，直接使用 Gateway 新入口 | 两种凭证不串用，工具执行无递归，状态/流/资源合同通过 |
| 2. 平台 spike | 少量共用 UI，WebView 原生 fetch + 一个桌面/移动真机 | 首帧、取消、图片、上传、回前台恢复通过；据此决定是否需要 HTTP 插件 |
| 3. 共享 UI | 会话/投影/路由/client 迁 packages/ui，两端薄入口 | Web 既有用例保持，切连接无迟到污染，包内无 Node/Next runtime |
| 4. Web 宿主切换 | 新 Web 入口承接现有功能，登录/静态部署迁入口 | 登录/退出、刷新导航、终端、设置/MCP 等通过；停止旧入口流量 |
| 5. 完整退役（必做） | 删除退役清单中的旧代码、临时兼容、依赖、测试与部署配置 | 新入口独立工作，旧服务停止，旧调用路径不可达；清单逐项关闭 |
| 6. 测量优化 | 先测 hop/首帧/admission/吞吐/内存，再决定直路/UDS | 有同场景对照数据，workspace 与 durable 语义保持 |

平台 spike 与少量 UI 抽取可交错进行；不用先搬完整应用再发现 WebView 网络限制。按新状态验证当前整套产物，通过后停止旧 Next/BFF 并直接切换；旧实现从交付源码和当前部署中删除。不要求旧入口持续可用，也不安排历史数据库迁移、旧版升级/回滚或双路径开关。

最低验证矩阵：

- Web 创建 → App 读取/发送 → 丢发送响应 → 保留 requestId 的连接恢复查询 → 两端各显示一次。
- 两个客户端并发提交、Backend 重启、Gateway 入口重启；结果按 durable 规则，不宣称重启不中断工具。
- 切 Gateway/账号但 sessionId/cwd 相同；旧 stream/JSON/Blob 不进入新视图，草稿仍归旧作用域。
- authenticated image/长文本、range 下载、大文件上传、冲突/部分成功、取消中途传输。
- terminal fan-in 多 tab、重连 cursor/reset；浏览器 EventSource 与 App fetch 实际观察一致。
- Cookie 跨站写拒绝、合法 App Bearer 写接受、撤销新请求及活动流、外部设备 token 调内部 `/v1` 拒绝。
- Web 深路径刷新、未知 API/缺失 JS 保持正确错误；桌面与手机后台/网络切换后重新恢复。

## 7. 旧 feature 完整退役合同

“新入口可用”只是迁移里程碑。**旧 feature 清理与新能力交付属于同一方案，清理完成才算交付完成。** 阶段 0 为每项登记旧入口/调用者、迁移或删除决定、替代实现、代码/配置/测试范围及退出证据；临时 re-export、适配器或 feature flag 必须绑定该清单的删除阶段，不能变成长久维护路径。

| 退役范围 | 完成时必须达到 |
| --- | --- |
| 旧 Web 与 BFF | 旧 Next 页面/动态 routes、宿主认证代理及框架绑定代码退出交付；必要业务映射迁到 Gateway 后删除原实现 |
| 重复前端与通信 | 只保留共享 UI 和新连接边界；删除搬迁后的旧副本、临时 re-export、旧 URL fallback 与迁移开关 |
| 依赖与构建 | 删除失去消费者的 Next 及相关依赖、脚本、框架配置、容器构建步骤与 CI 分支，更新 lockfile；不删除仍有新消费者的共享依赖 |
| 部署与配置 | 停止旧服务，移除旧反代 upstream、端口暴露、环境变量和仅供旧入口使用的凭证；迁移所需配置转为新入口配置 |
| 测试与文档 | 将仍有效的行为验证迁到新公开 seam；删除只验证旧实现的 fixture/脚本，更新当前操作指南和 capability limits；历史记录保留并标明历史状态 |
| 明确删除的产品 feature | 清单逐项列名后，移除 UI 入口、API、后台任务和配置；无历史数据保留或搬迁要求；本轮文档修改不执行数据删除 |

终态验证必须同时提供：新 Web/App 不启动旧服务仍能通过关键场景；在交付源码、构建产物和部署配置中核对退役符号/依赖已移除；原旧入口无法再承接业务；回归测试不再隐式依赖旧 fixture。删除旧专用依赖时，可核对 pnpm lockfile 与依赖树；不能仅以进程未运行或目录更名宣称完成。

保留现有 `/api`、`?session=`/`?cwd=` 合同以及在新方案中仍需要的业务映射，不自动构成旧 feature 残留。它们必须只有新路径的实际实现。Backend agent loop、durable/SQLite 和 execution API 是目标结构的一部分，不按“旧代码”批量删除；本轮仅补充研究与清理要求，不执行代码或用户数据删除。

## 8. 来源与研究限制

源码已按图导航定位并在当前工作区确认；图只作导航，不从推断边认定行为。平台约束引用官方文档及[上一轮核验](hepi-client-architecture-adaptation.md)，未运行 Hepi App、WebView benchmark、真机或签名构建。因此本文没有体积、内存、跨平台兼容性和迁移完成的实测结论。

- [S1] Next catch-all (`../../apps/web/app/api/[...path]/route.ts`)、durable adapter (`../../apps/web/adapters/durable-api.ts`)、agent definitions adapter (`../../apps/web/adapters/agent-definitions.ts`)、MCP adapter (`../../apps/web/adapters/mcp-surface.ts`)。
- [S2] 会话 events 代理 (`../../apps/web/adapters/durable-api.ts`)、[Backend HTTP](../../apps/server/src/server.ts)。
- [S3] workbench/upload adapter (`../../apps/web/adapters/workbench.ts`)、[FileViewer](../../packages/ui/src/components/FileViewer.tsx)、terminal adapter (`../../apps/web/adapters/terminal.ts`)。
- [S4] [Gateway startup](../../packages/gateway/src/startup.ts)、[内部 Gateway server](../../packages/gateway/src/index.ts)、[Backend file relay](../../apps/server/src/file-relay.ts)、[terminal relay](../../apps/server/src/terminal-relay.ts)。
- [S5] [AppShell](../../packages/ui/src/components/AppShell.tsx)、[ChatWindow](../../packages/ui/src/components/ChatWindow.tsx)、[Web CSS](../../packages/ui/src/styles/globals.css)。
- [S6] [session view cache](../../packages/ui/src/lib/session-view-cache.ts)、models cache (`../../apps/web/lib/models-cache.ts`)、[draft store](../../packages/ui/src/lib/draft-store.ts)。
- [S7] [browser source](../../packages/session/src/browser.ts)、[连接订阅管理](../../packages/session/src/agent-event-connection.ts)、[completion delivery](../../packages/ui/src/lib/completion-delivery.ts)。
- [S8] [submission lifecycle ADR](../adr/0006-durable-submission-lifecycle.md)。
- [S9] [流式 multipart parser](../../packages/gateway/src/multipart.ts)（票据 08 前位于 `apps/web/lib/bounded-form-data.ts`，现由公开 `busboy` 实现）。
- [E1] [React Router modes](https://reactrouter.com/start/modes)、[BrowserRouter](https://reactrouter.com/api/declarative-routers/BrowserRouter)、[HashRouter](https://reactrouter.com/api/declarative-routers/HashRouter)。
- [E2] [Vite 静态部署](https://vite.dev/guide/static-deploy)。
- [E3] [Tauri Vite](https://v2.tauri.app/start/frontend/vite/)、[CSP](https://v2.tauri.app/security/csp/)、[HTTP plugin](https://v2.tauri.app/plugin/http-client/)。
- [E4] [Tauri capabilities](https://v2.tauri.app/security/capabilities/)、[Stronghold](https://v2.tauri.app/plugin/stronghold/)。
- [E5] [Android network security](https://developer.android.com/privacy-and-security/security-config)、[Apple ATS](https://developer.apple.com/documentation/security/preventing-insecure-network-connections)。仅列实施时核对入口，不声称已核验各 WebView 的实际例外行为。
- [E6] [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)、[Android process lifecycle](https://developer.android.com/guide/components/activities/process-lifecycle)。
