# Troubleshooting

本页按**症状**排查,每个症状给出:它在哪一层、怎么确认、改哪里。所有命令与变量都来自源码与
`package.json`;没有依据的猜测不写。背景见 [developer guide](../developer-guide.md)。

## The page loads but every request fails

页面能渲染,但目录为空、每处都是错误。

1. 先确认 ingress 在跑:页面读的是 `/api/descriptor`。开发态里 Vite 把 `/api` 代理到 `HEPI_INGRESS_ORIGIN`
   (默认 `http://127.0.0.1:8790`,`apps/web/vite.config.ts`)。`pnpm dev` **不**包含 ingress。
2. 起 ingress:`HEPI_INGRESS_BACKEND=... HEPI_INGRESS_SERVICE_TOKEN=... pnpm --filter @hepi/gateway start:ingress`。
3. 若 ingress 报 `backend unreachable`(503),那是它到 Backend 的转发失败:检查 `HEPI_INGRESS_BACKEND` 与
   Backend 是否在 `PORT`(默认 8787)上。

## The page shows a sign-in form, or a refusal with no retry

- `GET /api/web-auth` 返回 `{enabled:true}` 表示这个部署有登录门。表单提交到 `POST /api/web-login`,换
  `hepi-web-session` cookie(HttpOnly、SameSite=Strict、`Max-Age=2592000`)。
- 401 是登录材料不匹配(常量时间比较)。cookie 是 Strict,所以从别处点进来的跨站导航不会带上它——在同源内导航一次即可。
- App 的 refusal 面与 Web 不同:App 的凭据是设备 bearer,被拒后只有 **Configure connection…** 与 **Disconnect…**,
  没有重试——重复读不能把被拒的凭据变成可用。网关不可达(非 401/403)才有 **Try again**。

## The catalog is empty and runs end as `no_model`

这是**默认行为**,不是 bug:没配置模型就不造默认模型。

- 环境模式:在 Backend 上设 `HEPI_PROVIDER`/`HEPI_MODEL`(以及 `HEPI_PROVIDER_BASE_URL`/`HEPI_PROVIDER_API_KEY`),
  或在 Settings › Models 里定义 provider。见 [providers](../providers.md)。
- `HEPI_CONFIG_SOURCE=pi` 模式:Backend 读**它自己主机**的 agent 目录。Backend 与 Web 主机不同时,Web 主机上
  写入的 `auth.json` 不会被 Backend 看见——那不是推送关系,是"同一账号同一路径"的关系。
- 已有会话保留创建时的模型引用;它的下一次请求会原生以 `no_model` 收束,而不是偷偷换模型。

## Settings has controls that answer `unsupported`

ingress 对五条模型设置路由(`models/enabled`、`models/refresh`、`models-config/{discover,test,catalog}`)答
`501 {code:"unsupported"}`。这是**具名限制**:转发会让 Backend 答 `404 conversation not found`,面板就会以为
"部署支持,只是请求错了"。看到 501 就是"这个客户端 API 不提供该能力",见
[client ingress](../client-ingress.md#what-is-a-limit-and-what-is-a-missing-route)。

## An upload is refused

- 400 `The upload is not a multipart form` / `The upload carries no body`:请求形状不对。
- 409 `Some files already exist`:冲突策略是 `error`。用 `?conflict=overwrite` 或 `skip`,或先改名。
- 超上界:`MAX_UPLOAD_BATCH_BYTES` 默认 100 MiB(一次请求全部文件合计),部署可用
  `HEPI_UPLOAD_BATCH_BYTES` 调小。拒绝会**先写答案再后台排空**剩余 body,所以你能读到这条拒绝;继续发超过一档
  的 body 会被断开。
- `Only configured /workspace/<id> paths are available`:路径不是 `/workspace/<id>` 形式,或工作区未注册。

## Save in the App fails or leaves no file

- App 的保存由壳执行(`app_save_choose/begin/append/finish/abort`),分片 ≤ 1 MiB。失败或取消时壳删除**本次写的
  部分文件**,源文件不动,不重试。
- 目标已存在且未确认覆盖会被拒;目标是目录也会被拒。
- Web 页没有这条路径:它的保存是浏览器导航,页面不持字节,所以"保存按钮没反应"通常是浏览器的下载策略,不是产品代码。

## A terminal tab shows nothing

- 一条流服务所有标签:`GET /api/terminal/events?tabs=<id>|<cwd>|<after>,...`。`cwd` 必须是会话的 routing cwd
  (`/workspace/<id>/...`);缺失答 `501 not_supported`,未知工作区答 `404 unknown_workspace`。
- 安静会话靠注释帧保持连接(`TERMINAL_HEARTBEAT_MS` 默认 30 s,`0` 关闭)。若前置代理的空闲上界更短,在
  gateway 侧用 `HEPI_TERMINAL_HEARTBEAT_MS` 调小,**不要**靠观察重连来发现。
- 重连是续读:`TERMINAL_REPLAY_CHARS`(128 KiB)保留尾部,游标由标签自己报。新挂载的组件不报游标,所以拿到的是
  保留尾部而不是旧游标。无人附着的会话在 `TERMINAL_RECONNECT_MS`(120 s)后被关闭。
- 标签持续不读时,单条连接排队的未写字节超过 `TERMINAL_STREAM_BUDGET_BYTES`(4 MiB)会被结束;shell 不受影响,
  按游标重连即可从保留尾部继续。

## MCP answers `mcp_unavailable`

ingress 没有配置本机 host service。需要**同时**给三个变量:`HEPI_INGRESS_MCP_GATEWAY_URL`、
`HEPI_INGRESS_MCP_GATEWAY_TOKEN`、`HEPI_INGRESS_MCP_GATEWAY_ID`(只给其中一部分是启动错误,不是"没有 MCP")。
另:SSH gateway 不提供 MCP,因为 MCP 属于 Web 主机自己的账号。见
[MCP on the Web host](../mcp-on-the-web-host.md)。

## MCP tool call is refused by name

`server-missing`、`server-disabled`、`not-exposed`、`not-authorized`、`unknown-tool` 都是**主机**在调用时给出的
答案:Backend 不留平行信任表。依次检查:该文件夹是否被信任、该条目是否开启、工具是否暴露、主机是否还有这个工具。
主机侧撤销会在下一次调用生效。

## A turn's outcome is unknown

- 浏览器对仍在等的 turn 读 `GET /api/conversations/:id/submissions?requestId=`;它**只读**,从不重发。这条读失败时
  状态保持 unknown,不会假装成功。
- 执行侧:丢了答案的调用是 `outcome_unknown`,带花掉的 call ID。`timeout`、`aborted` 和明确拒绝保持自己的名字。
  文件写没有 call ID、没有 journal,写丢就是无法解析;读可幂等重试。
- 崩溃后 `write`/`edit`/`bash` 意图是 interrupted 而不是重放(没有工具声明安全),MCP 工具注册显式
  `replay: "unsafe"`。这是保守安全,不是 exactly-once 承诺。

## Backend refuses to start

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `HEPI_AUTH_TOKEN is required for non-loopback binding` | 绑了非 loopback 却没给 token | 给 token,或绑回 loopback |
| `HEPI_PROVIDER and HEPI_MODEL are required for provider configuration` | 設了 `HEPI_PROVIDER` 卻沒給 `HEPI_MODEL` | 補齊模型,或移除 provider 設定 |
| `Set HEPI_INGRESS_MCP_GATEWAY_URL, ... together, or none of them` | ingress 的 MCP 三个变量只给了一部分 | 补齐或全部去掉 |
| `HEPI_INGRESS_STATIC_DIR must name a directory, or be unset to serve no page` | 给了空字符串 | 给目录,或删掉这个变量 |

一个坏扩展不会拖垮整个 Backend:registry 的安装失败会被具名上报,其余扩展继续工作。

## Two backends on one database

不支持。一个部署一个 writer。多开 UI 是安全的;多开 backend 对着同一个 SQLite 会互相破坏 durable 语义。同理,
一个 gateway 进程一个 call journal。

## `pnpm check:docs` fails

三种失败各有含义:目标文件不存在、`file.md#fragment` 的标题不存在、`docs/` 下的指南没有被
`docs/README.md` 链接(文件存在,所以别的检查发现不了)。它只读,不改文档,也不会为了让检查通过而修改测量值。
新增 `docs/` 页面时同时加索引条目。

## `pnpm check:entrypoints` reports a missing file

它报告每个脚本里每个 `node`/`tsx` 调用的文件参数,所以第二个缺失不会藏在第一个后面。已记录的缺失在每次运行都会
打印但不算失败;`--strict` 会让已记录的也致命。

## A browser check fails but unit tests pass

选择器按包粒度选检查,它不推断跨服务契约或浏览器行为。改到这些地方时手动加对应的
`pnpm --filter @hepi/web test:<name>`。失败集比较用 `pnpm compare:tests --base=<SHA>`(两侧各自 checkout 到
`.dev/baselines/`,比较的是 TAP `not ok` 名字集合,不是数量)。已知基线与记录见
[verification](../verification.md)。
