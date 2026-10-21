# Shared React Client / Gateway Ingress

Status: in-progress; metadata re-reconciled 2026-10-20 against this line (after 16's closeout, 17's two lanes, the Pilo 23–25 completion and the
UX 18/19/20/21 deliveries). Prior reconciliation 2026-10-19 against integration `3e69c62` (application source `9400dcc8`). Core implementation slices are integrated; each ticket retains its own unmet acceptance and platform limits. Web-origin cutover occurred at `1873d24` on 2026-10-18, with the legacy Web service stopped (see docs/1873d24-deployment.md), and the live origin moved to `ad225f8` on 2026-10-19, where ticket 16's concrete closeout ran both journeys on the published release and on the deployed entry (login, scroll, read-only smoke). Ticket 16 therefore has evidence for every capability except the two named limits recorded in it: no second physical host (a loopback sshd stands in) and debug-only native numbers. Android is withdrawn as a delivery gate by the user's decision of 2026-10-19 — no mobile artifact is built and its historical absence is recorded as an absence, never as a pass. System package installation evidence exists as a real dpkg transaction in a private root. Ticket 17 follows 16 (its runtime/route retirement is delivered; its manifest/typecheck residue is open and non-blocking); approved UX additions 18–21 are delivered (20's packaged journey was not re-run), 22 remains the aggregate gate, and the Pilo tickets 23–25 are complete (`7345384`, with `2a53eef` trimming 25's mirrored test case). Current delivery status and evidence live in [ticket-breakdown.md](ticket-breakdown.md) and the owning issue files.
Date: 2026-10-17; status revised 2026-10-19
Baseline: `848f391b4245070b6677704d6a64e2a0d7356996` + current documentation worktree

## Scope

私人项目，用户明确现有历史无保留价值。以新方案直接替换旧方案；旧用户升级、旧版本兼容、历史数据搬迁、旧 PWA/cache/草稿/偏好导入与回滚演练均不纳入工作。实现期间可分切片验证，切换时部署一套当前版本，不为旧客户端维持运行路径。本规格只规划实现；本轮不执行数据清理。

目标：Web/App 共用 React UI，经 Gateway 访问 Backend；完成时完整删除被替代的 Next/BFF feature、部署服务和兼容代码。现有实现是复用与删除检查的参考，不构成逐项旧行为兼容承诺。

## Agreed boundaries

- Tauri v2 与 React Router 已选；Web/App 使用 Vite 静态构建，React Router Declarative 模式。
- App/Web ⇄ Gateway client ingress ⇄ Backend。Backend 始终运行 agent loop，拥有 conversation、项目绑定和唯一 durable SQLite 写入权。
- Backend ⇄ execution Gateway；Gateway 执行工具、文件与终端。入口 Gateway 与 execution Gateway 可以不是同一台机器。
- Web/App 共用 React 组件、hooks、纯投影、协议与会话模块；宿主入口只组装路由、连接与真实平台能力。
- 以票据 01 的目标能力清单验收新方案；功能开发与旧实现删除同步推进，最终清除全部被替代路径。

## Release envelope

票据 01 的决定，2026-10-17，revision `dd1f33f478b618c221502fd65ced623d8c9617f7`（`impl/client-app-01`，基于 `integration/client-app`）。本段固定首期能力、身份边界、首发平台、Web 交付方式与删除范围；后续票据按此执行，未经验证的平台不写成已支持。

### 首期能力清单

| 能力 | 首期范围 | 拥有者 | 票据 |
| --- | --- | --- | --- |
| 聊天 | 会话读取、提交、steer、follow-up、stop/continue、队列、requestId 恢复、SSE | 共享 UI + 既有会话 hook/projection；Backend 拥有 durable 事实 | 03、05、10 |
| 项目 / worktree | 本地与 SSH 项目目录、worktree 创建与选择 | Backend workspace 绑定；Gateway 执行 | 06 |
| 关系 / 委派 | 会话关系入口与委派操作 | Backend durable 命令；共享 UI | 10 |
| 模型 / provider / 扩展 | 模型选择、provider 配置、扩展与共享设置 | Backend 拥有 provider 配置 | 11 |
| 宿主资源 | skills、安装、agent definitions | execution Gateway 宿主账户 | 12 |
| MCP / project trust | 命名 client API 指向配置宿主；trust 由宿主判定 | 配置宿主 Gateway，不经 Backend 转发凭证 | 13 |
| 媒体 / 历史 | 分页历史、长文本、thinking、图片、context 资源 | Gateway 认证获取；共享 UI lease | 07 |
| 文件 | 工作台浏览、预览、上传、下载、流式保存 | Backend relay 复用 workspace 授权 | 08 |
| 终端 | 多终端 fan-in，cookie/bearer 下认证 reader | Gateway terminal 会话 | 09 |
| 认证 | 设备凭证签发与撤销、cookie 与 bearer 分支 | Backend 凭证权威；宿主安全存储 | 02、04 |
| Web 能力 | 首次安装、offline、页面内完成通知 | Vite 构建 + 新 worker/manifest | 14 |

首期明确不做：APNs/FCM 原生后台推送（现有 Push 仅为无服务端的原型）、file watch（保留 workbench 现有 not-connected 限制，不扩展为 watcher）、版本协商与旧客户端兼容、旧用户/历史数据/草稿/偏好迁移与回滚演练。未列入的能力不因旧代码存在而成为新需求。

### 身份与宿主边界

四个身份分开，权限不得互相替代：

- **客户端入口（client ingress）**：Gateway 对外的 `/api` 合同，使用同源 HttpOnly cookie（Web）或可撤销设备 bearer（App）。客户端只拿到这个入口。
- **Backend 身份**：conversation、项目绑定与唯一 durable SQLite 写入权威；入口到 Backend 使用独立服务凭证。
- **execution Gateway**：内部 `/v1` listener，独立绑定与独立 token；当前 `packages/gateway/src/startup.ts:264` 只监听 `127.0.0.1`。Backend HostClient 直连该接口，客户端身份在此必须被拒绝。
- **SSH profile**：执行宿主传输配置（主机、端口、账户），属于 Gateway 执行侧，不进入客户端连接描述。

`cwd` 只是路径信息，不构成访问授权；workspace/project 绑定由 Backend 解析，入口默认宿主与执行宿主由受信配置决定。

### 首发桌面目标

**Linux x86_64（本工作站 workstation），WebKitGTK 4.1，Tauri v2。** 2026-10-17 复核命令与结果（exit 0 除注明外）：

| 命令 | 结果 |
| --- | --- |
| `uname -a` | `Linux workstation 6.17.0-23-generic #23~24.04.1-Ubuntu ... x86_64` |
| `uname -m` | `x86_64` |
| `rustc --version` | `rustc 1.96.0 (ac68faa20 2026-05-25)` |
| `cargo --version` | `cargo 1.96.0 (30a34c682 2026-05-25)` |
| `dpkg -l libwebkit2gtk-4.1-dev` | `ii  libwebkit2gtk-4.1-dev 2.52.3-0ubuntu0.24.04.1  amd64` |
| `pkg-config --modversion webkit2gtk-4.1` | `2.52.3` |
| `command -v cargo-tauri` | 无输出：不存在 |
| `cargo tauri --version` | `error: no such command: \`tauri\`` |

Tauri CLI 缺失阻塞票据 04 的桌面构建，不改变目标选择：目标选择依据 Rust 工具链与 WebKitGTK 4.1 开发包均已安装。安装 CLI 属 04 的前置条件，不是本票据的平台证据。（后续：CLI 以项目依赖 `@tauri-apps/cli` 2.12.3 提供，桌面壳的构建与打包已由票据 04/15 验证；本行记录的是 `dd1f33f` 当时的状态。）

### 首发移动候选

**Android。** 复核结果：`ANDROID_HOME` 与 `ANDROID_SDK_ROOT` 均为空，`adb`、`sdkmanager` 均不存在，无 `~/Android`。该缺失阻塞票据 04 的移动端证据，因此本方案不声明 Android 或 iOS 已支持；iOS 未选，Windows 与 macOS 未选。**2026-10-19 用户决定不做 Android 构建，该候选退出交付门槛**：不复核、不安装、不声明支持；历史缺测记录保留为缺测，新验收不因它的缺失而延迟，也不因它的撤销而变成通过。

### Web 交付与直接切换

Vite 静态构建，与未来 client ingress 同源；Web root 用 BrowserRouter 与同源 cookie，`/api` 与静态资源 fallback 分开返回。切换方式：新构建可用后停止 Next，由当前构建直接服务该 origin，一次替换完成，不并行保留旧站点。TLS 属部署关注点，本轮不声明存在外部 TLS 监听或反向代理。切换前 `hepi-web` 容器与 `HEPI_AUTH_TOKEN` 仍是运行入口；本票据不修改 gateway 或 Backend 启动方式。

### 删除范围（仅票据 17 执行）

被替代实现与临时残留的删除范围，证据为本 revision 源码：

| 目标 | 证据 |
| --- | --- |
| `apps/web` 的 Next 应用 | `apps/web/next.config.ts`、`apps/web/app/`（layout、page、settings/sidebar CSS） |
| `hepi-web` 服务与镜像 | `deploy/compose.yaml:62` `image: ${HEPI_WEB_IMAGE:-hepi-web:local}`；`deploy/docker/web.Dockerfile` 构建 `.next` |
| BFF catch-all | `apps/web/app/api/[...path]/route.ts`（durable-login、web-auth、market、agent-definitions、mcp、project-trust 转发） |
| 无服务端实现的 Push 原型 | `apps/web/lib/push-client.ts:35,49` 请求 `/api/push/config`、`/api/push/subscribe`；catch-all 与 Backend 均无对应 handler；同源副本 `apps/web/vendor/pi-web/lib/push-client.ts` |
| `next/dist` 的 busboy 用法 | `apps/web/lib/bounded-form-data.ts:4` 导入 `next/dist/compiled/busboy/index.js`，类型声明 `apps/web/lib/next-compiled.d.ts` |
| 共享 `HEPI_AUTH_TOKEN` 双重身份 | `apps/web/app/api/[...path]/route.ts:13-19` 用同一 token 校验浏览器登录并写入 cookie；`apps/web/adapters/durable-api.ts:43-48` 用同一值作 Backend bearer |

本票据不删除任何文件；删除在 17 执行。不建立旧用户迁移、兼容层或回滚工作项。

### Capability note: client ingress and device credentials (ticket 02, 2026-10-17)

票据 02 已实现并测试，但**尚未成为部署入口**。新增的 client listener 是显式启动
（`pnpm --filter @hepi/gateway start:ingress`，配置 `HEPI_INGRESS_BACKEND`、`HEPI_INGRESS_SERVICE_TOKEN`，
可选 `HEPI_WEB_LOGIN_TOKEN`、`HEPI_APP_ORIGINS`、`HEPI_REVOCATION_CHECK_MS`）；今天的 `apps/server/src/main.ts` 与
`packages/gateway/src/startup.ts` 仍只绑原有地址，未新增公共 listener，`HEPI_AUTH_TOKEN` 的既有 cookie/bearer 行为
不变。本段只记录该能力与它的已验证边界，不改变上面「Web 交付与直接切换」中「切换前 `hepi-web` 与
`HEPI_AUTH_TOKEN` 仍是运行入口」的现状；切换仍是票据 16。

已实现：Backend 拥有设备凭证记录与撤销（只存摘要，独立 sqlite 于 conversation db 旁，不写入 durable conversation
数据库）；Web 登录/状态/退出与 HttpOnly/Strict cookie、同源写入校验；设备 bearer 独立授权，不套用同源写入规则；
已声明 App origin 的 CORS 与未知 origin 拒绝；内部 `/v1` 不在 client listener 上；连接描述只返回已认证 Backend
身份、账号 scope、build id 与真实 capabilities，未登录方只能读到「是否启用 Web 登录」；每次请求都校验、无成功缓存，
authority 不可达即拒绝。四种材料分开：Web 登录材料、设备凭证、ingress→Backend 服务凭证、execution token；后三者
任一被当作客户端 bearer 提交均被拒绝。

撤销上限：已挂载流为**一个复查间隔（`HEPI_REVOCATION_CHECK_MS`，默认 1000 ms）加调度**；撤销只结束访问，不 abort
agent run（停止运行仍走独立 durable stop）。证据与日志见
[verification](../../docs/verification.md#client-ingress-and-device-credentials-ticket-02)，行为与路由见
[client ingress](../../docs/client-ingress.md)。

未声明：TLS/反向代理的存在（属部署关注点）、任何原生平台凭证存储证据（票据 04）、版本协商或旧客户端适配（G1）。

### Capability note: the App shell and its artifacts (ticket 15, 2026-10-18)

票据 15 交付了真实 Tauri v2 壳与产物流程：连接（profile、Gateway origin、device bearer）存于 OS 凭证存储，配置的 origin
在**窗口创建前**写入 CSP（票据 04 实测：未列出的地址由 WebView 在请求发出前拒绝），三个值在 document start 注入页面；首次运行
渲染配置面，存入后重启（运行中的文档换不了策略）。`build-artifacts.mjs` 产出静态 Web、`.deb` 与 provenance（revision、
宿主、目标架构、工具链、校验值、每步日志），并测量复现性：可执行文件两次构建字节相同，`.deb` 容器因 bundler 写入打包时刻而
不同。`verify-artifacts.mjs` 针对产物运行 33 项断言，含两次冷启动、fixture Gateway 收到带 `Origin: tauri://localhost` 与
存储 bearer 的 descriptor 请求、以及在真实窗口里用 `xdotool` 走首次使用表单。

未声明：任何移动产物（Android 无 SDK/`adb`/设备，本机不做无人值守安装）、系统 `dpkg -i` 安装（需 root）、与真实
Gateway/Backend 的整套协同与入口切换（票据 16）。指南：[apps/app README](../../apps/app/README.md)；证据：
[verification](../../docs/verification.md#app-shell-and-packaged-artifacts-ticket-15)。

## User stories

1. 用户从 Web/App 打开同一 Backend 的会话，看到相同的已提交事实。
2. 用户可通过逻辑 URL 选择 session/cwd，返回、刷新和重新打开后导航正确。
3. App 用户配置 Gateway 地址，经认证连接，不接触内部服务凭证。
4. 用户创建、检索、重命名、删除、fork 会话，并使用选定的关系与委派入口。
5. 用户提交、steer、follow-up、stop/continue 和管理队列，保持 durable 命令语义。
6. 用户在响应丢失后查询原 requestId，避免重复提交。
7. 用户查看分页会话历史、长文本、thinking、图片与 context 资源。
8. 用户在本地和 SSH 项目浏览、预览、上传与下载文件。
9. 用户使用多个终端，断网或回前台后恢复可恢复状态。
10. 用户切换 Gateway/身份后，草稿、模型、会话与通知保持作用域隔离。
11. 用户使用目标清单中的项目、worktree、模型、provider、扩展、skills 与 agent definitions。
12. 用户管理 MCP/project trust 时明确对应的配置宿主。
13. Web 用户使用新站点的安装/offline 提示和页面内完成通知。
14. App 用户回前台后重新获取 Backend 事实，而不依赖常驻连接。
15. 维护者撤销单设备凭证，活动访问在声明时限内结束。
16. 维护者可重建、安装和定位当前版本产物，并证明旧实现已完整退役。

## Design

### Modules and routing

共享 UI 模块拥有 React 工作台、现有 hooks/纯投影和按连接作用域创建的 client。通信边界集中处理 base URL、认证、取消、错误与资源生命周期；复用协议和会话解析器，不另建 client-state/client-api 包或通用 RPC 框架。

client 对共享 UI 暴露命名 domain 操作，原始 request/stream seam 留在内部。现有会话 hook/纯投影继续拥有生命周期；client 负责连接 I/O 与资源，dispose 不停止 Backend run。连接 generation 与会话 acquisition generation 各守其职责。接口三案比较、依赖分类和性能成本见[deep-module 审查](review-notes.md)。

Web root 使用 BrowserRouter 与同源 cookie；App root 使用 HashRouter、Gateway profile、设备凭证及已验证的原生能力。逻辑 query 从 React Router location/search hooks 读取。session/cwd 参数可作为当前设计复用，URL/API 可随新设计同步调整调用者，无旧链接兼容要求。

Gateway client ingress 提供明确的 /api 合同；内部 /v1 execution listener 独立绑定、独立凭证，Backend HostClient 直连内部接口。入口可代理 Backend，再由 Backend 访问选定执行宿主；两个方向的权限不能混用。

Backend 保留 ConversationOperations、workspace/project 绑定和 durable 业务决策。Gateway 隐藏运输与客户端映射。客户端提交 opaque session/workspace/project 身份；cwd 仅是路径信息，不构成访问授权。入口默认宿主和 execution 宿主由受信配置/Backend 解析。

### Connection and authentication

连接对象包含 profile、规范化 Gateway origin、服务端确认的 Backend/身份作用域及本地 generation。切换先取消旧 HTTP/SSE、解除订阅、释放 blob，再启动新 generation；迟到响应不得污染新作用域。草稿和偏好使用新作用域格式，按全新状态启动，不导入旧 key。

Web 使用同源 HttpOnly cookie；Gateway 承接登录/退出、cookie 与写请求 Origin/CSRF 校验。App 使用可撤销设备 bearer；初始签发来自已认证管理操作或本机运维命令。登录材料、设备凭证、入口→Backend 服务凭证及 execution token 分离。Backend 拥有凭证记录/撤销权威；App 凭证进入目标平台验证过的安全存储，URL、日志和构建产物不包含凭证。

Backend-bound 操作在同次受信调用中验证客户端身份；host-local API 也有明确授权。认证票据固定并测试活动流/传输的最大撤销延迟；Backend 不可用时不能无限使用缓存授权。撤销访问不自动停止 agent run，停止运行使用独立 durable stop 命令。

连接描述只返回当前 Backend 身份、必要 capabilities 和构建标识。Web/App/Gateway/Backend 使用同一套当前协议；复用 hepi.v1 数据合同，不增加版本协商、旧客户端适配或多版本支持矩阵。

### Streams and resources

会话继续 HTTP+SSE，复用 snapshot/state/submission/resync_required/state_oversize、projection identity、revision、acquisition generation 与心跳语义。只重连读取；写入 outcome_unknown 通过原 requestId 查询收敛。恢复读不补造完成通知；现有多订阅连接保留单一 I/O owner。

终端保留 fan-in，bearer 下使用认证 fetch reader。会话历史资源解析到 Gateway 后认证获取；有界图片可用可回收 blob URL，大文件走流式/原生保存，不能全量进入 JS 内存。上传保持限额、backpressure 和取消；multipart parser 使用独立依赖，移除 Next 私有依赖。

文件与终端首期保留 Backend relay，以复用 workspace 授权与多宿主路由。file watch 的未连接能力明确报告，迁移不扩展为新 watcher。MCP 管理通过命名 client API 指向配置宿主，内部 /v1 和 execution token 不暴露客户端。

### Platform and delivery

先验证一个实际桌面与一个实际移动目标：认证、增量 SSE、取消、图片、上传/保存、前后台、断网及冷启动。原生 fetch 优先，读流/上传/保存分别选路径。核验的 plugin-http 在 IPC 前全量读取请求体，不能由响应流能力推断上传流式能力，见审查 G10。OS、依赖和工具链按实际验证记录，缺失条件明确阻塞对应目标。

Web 从新构建首次安装启动，worker/manifest/offline 与 Vite 资源匹配，API/私有响应不缓存。页面通知使用同一 lifecycle 事实；删除无服务端实现的 Push 原型，不增加 APNs/FCM。App 挂起后由 Backend 继续 agent loop，回前台重新获取事实。

产物记录源码 revision、构建机、目标架构、依赖与运行配置；只交付当前版本。静态页面 fallback 与 /api 错误分开；TLS、代理 Origin 和 CORS 明确配置。构建在 workstation/CI；remote-host 仅运行预构建 linux/arm64 产物。

## Implementation and retirement

1. 确定目标能力、模块 owner、首发平台和直接切换方式；旧代码清单仅用于复用及删除检查。
2. 完成设备认证与 Gateway 会话纵切：读取、提交、SSE、requestId 恢复。
3. 验证最小 Tauri 壳，再抽共享 React/连接作用域；同步更新消费者，不增设旧版桥接。
4. 实现目标能力：项目、会话历史资源、文件、终端、控制、设置、执行宿主资源及 MCP。
5. 从新状态验证 Web/App production 构建和运行场景，停止旧服务，直接切换入口。
6. 清除剩余 Next/BFF、旧服务配置、依赖、测试与无调用代码；在删后版本验证独立运行。

仅验收目标能力清单。旧 feature 可按新设计替换或删除，未选能力不因为旧代码存在自动成为新需求；剩余未知能力诚实报告。被替代实现和临时残留必须删除，不维持双栈、fallback 或版本转换。

## Acceptance

- 新状态下 Web 创建会话 → App 读取/提交 → 丢弃响应 → 回前台查询原 requestId → 两端只出现一份提交；重启后新写入的 durable 状态可恢复。
- 本地与 SSH 项目资源/终端路由正确；入口 Gateway 不等于 execution Gateway 时仍命中正确宿主。
- Cookie/bearer 及撤销身份经过公开 client API 验证；内部 /v1 拒绝客户端身份，bundle 不含内部 token。
- SSE/revision/resync、terminal fan-in、传输取消和内存边界有选定平台证据。一次会话加载复用同一已接纳 snapshot；目录请求内 metadata 各读一次，不新增逐会话 history 查询。
- 性能证据区分已减少的冗余工作与待测候选；流内 JSON 往返、重挂载和渲染拆分按代表负载决定，不由方法/行数推断收益。
- 同 session id/cwd 的连接切换能隔离迟到响应、草稿、模型、blob 与通知。
- BrowserRouter/HashRouter 验证首开、query、返回、恢复；未知 API 与缺失静态资源返回正确错误。
- 新 Web 安装/offline/页面通知正确，API 不进缓存；无需旧 PWA/旧数据/旧版本升级测试。
- 当前 Web/App/Gateway/Backend 协同工作；设备撤销时限可观测。
- 目标能力全部验收；旧 Next/BFF、私有 parser、旧部署和桥接无生产引用；新方案不启动旧服务仍可构建运行。
- 检查附 command、revision、exit code、log；构建、平台、部署状态分别报告。

## Out of scope

旧用户升级、历史数据/草稿/偏好迁移、旧 PWA/cache 升级、多版本协商/兼容、旧版回滚演练、桌面自动更新/移动商店升级；功能研究第二部分新 UX、agent loop 迁 Gateway、离线写入/CRDT/App SQLite、副本状态框架、新协议总线、无测量 UDS/in-process、先行文件/终端直路、全 OS 商店发行、APNs/FCM 和后台常驻执行。

## Execution pointers

- 顺序与依赖：[ticket breakdown](ticket-breakdown.md)；首个可执行票据为 01。
- 缺口、模式与源码证据：[review notes](review-notes.md)。
- 设计来源：[architecture blueprint](../../docs/research/hepi-client-architecture-blueprint.md)、[adaptation research](../../docs/research/hepi-client-architecture-adaptation.md)。
- 验证：[verification practice](../../docs/agents/verification.md)；发现处置：[review policy](../../docs/agents/review-policy.md)。


<a id="ux-closeout-2026-10-19"></a>
## 11. UX 收口追加阶段（2026-10-19）

用户已批准将 [UX 调研](../ux-closeout-research/README.md) 转为后续计划。既有 01–17 与交付证据保持原意；新增票 [18 登出](issues/18-web-logout-contract.md)、[19 App 连接恢复](issues/19-app-connection-recovery.md)、[20 原生另存](issues/20-native-file-save.md)、[21 读取失败恢复](issues/21-read-and-navigation-recovery.md) 排在 17 后，可按路径分工并行，最后 [22 跨能力验收](issues/22-ux-system-acceptance.md)。这些不是 16/17 的反向阻塞边。

**Android 的处置（用户 2026-10-19）**：不再构建 Android，本规格「首发移动候选」（[spec.md](spec.md#release-envelope)）对应的证据缺口作为缺测保留，不再作为交付门槛；撤销不等于通过，规格的验收清单里凡需移动证据的行仍不勾。

历史导航、Provider、MCP、SSH 与 references 的后续行为继续由各自 spec 拥有；本 spec 只纳入宿主/共享 UI 与最终产物责任，完整对应与依赖见 [UX 执行图](../ux-closeout-research/spec.md)。已有 OAuth/刷新分支、MCP adapter/listing、SSH/DOCX、登入修正先整合和复用，不以调研缺口为由重复实现。

现有 16 优先核验已实现登入面在实际不可变发布产物上的表现；历史 live1873d24 的 unauthorized 不证明当前源码仍缺登入实现。修改任何 owning 功能时同步其当前操作指南；这里只修改计划，不宣称功能、部署或验收完成。Android、watch、后台 push、Provider discovery/test、Skills 卸载等未选能力见执行图的 deferred 条目。

## Pilo 对照精简追加（2026-10-19，用户批准）

[研究](../../docs/research/pilo-simplicity-review.md)落实到[票17](issues/17-retire-next-and-transition-paths.md)的退役矩阵与[追加票23–25](ticket-breakdown.md#stage-g---pilo-simplification)：删除未使用的SettingsReader、移除旧fixture的请求fallback、每个connection只建立一次ConversationApi。三票已于`7345384`完成（`2a53eef`修剪25的镜像测试用例），具体scope、验收与证据由各票拥有。17后按共享文件协调，不反向阻塞16/17或UX18–22；历史窗口仍由既有history-navigation spec拥有，FileSeam与durable状态职责保持现行边界。
