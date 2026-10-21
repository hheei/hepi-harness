# 02 — 通过 Gateway 连接、签发及撤销设备凭证

Type: implementation
Status: resolved
Blocked by: [01](./01-contracts-and-release-envelope.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

Web/App 用户能用各自身份安全连接，维护者能单独撤销设备。

## Scope

完成端到端认证纵切：Gateway client listener、外部可达 TLS 入口、Backend 凭证权威、受认证签发/撤销及连接描述。拆开用户登录材料、设备凭证、入口到 Backend 的服务凭证、execution token。Web login/status/logout 保留必要的未登录读取与 cookie/Origin 校验顺序；App bearer 单独授权，不套用 Web 同源写入规则。连接描述携带已认证 Backend/账号 scope、当前构建标识与真实 capabilities。

## Acceptance

- [x] 正常/错误/已撤销 bearer 与 Web cookie 都有受控结果；未登录 Web 能判断登录要求，不能读取私有描述或业务数据。
- [x] 入口处理已声明 App origin 的 OPTIONS 与 authorization/content-type/需要的重连 header；拒绝未知 origin，内部 /v1 对外不可用。
- [x] 认证记录/摘要/撤销状态由 Backend 持久化，重启不恢复已撤销权限；初始签发不要求把 master token 存入 App。
- [x] 固定活动流及传输的最大撤销延迟、失败时策略并测试；撤销仅终止访问，不自动 abort agent。
- [x] 首次连接返回可信 Backend 身份及能力；不建设版本协商或旧客户端适配；Backend-bound 操作在同次调用验证身份，host-local 操作有明确授权校验；无无限授权缓存。

## Verification

公开入口集成测试：cookie/bearer、签发/撤销、preflight、真实授权分支、身份伪造拒绝、重启持久性。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Review notes

涉及 G1/G2/G8/G9，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。

## Answer

实现于 `impl/client-app-02`（base `a0d82115b8c1247e38a20ca0553c4ed7db613164`）。行为、路由表与配置见
[Client ingress](../../../docs/client-ingress.md)；证据见
[verification](../../../docs/verification.md#client-ingress-and-device-credentials-ticket-02)。

**入口是显式启动，不改今天的运行入口。** 新 listener 为 `packages/gateway/src/ingress/main.ts`
（`pnpm --filter @hepi/gateway start:ingress`），需要 `HEPI_INGRESS_BACKEND` 与 `HEPI_INGRESS_SERVICE_TOKEN`。
`apps/server/src/main.ts` 仍只绑 Backend 自己的端口，`packages/gateway/src/startup.ts` 仍只绑 127.0.0.1；两者都没有新增
公共 listener。`HEPI_AUTH_TOKEN` 的既有 cookie/bearer 行为未改，`/api` 合同与既有路由不变。

**四种材料分开。** Web 登录材料只换取 ingress 自己的 HttpOnly/Strict cookie（同源写入校验）；设备凭证是可撤销
bearer，只由 Web session 签发/列举/撤销；ingress→Backend 服务凭证只出站，客户端以它作 bearer 被拒；execution
token 在客户端 listener 上无处可达，`/v1` 与 `/internal/credentials/verify` 均返回 404。

**Backend 拥有记录与撤销。** 记录存 `apps/server/src/device-credentials.ts`，只存 SHA-256 摘要，文件为
`HEPI_DEVICE_CREDENTIALS`（默认 `device-credentials.sqlite`，与 conversation db 同目录的独立 sqlite），不写入 durable
conversation 数据库。撤销是一次写且不可恢复；重启后已撤销凭证仍被拒（测试用新 Backend + 新 ingress 验证）。

**每次请求都校验，无成功缓存。** 设备 bearer 的每次请求（含已挂载流的定期复查）都向 Backend 询问
`/internal/credentials/verify`；Backend 不可达 → 503，凭证已撤销 → 401。已声明撤销上限：已挂载流为
`HEPI_REVOCATION_CHECK_MS`（默认 1000 ms）一个复查间隔加调度，测试实际观测到在该上限内结束。撤销只结束访问，
不发 durable stop，因此不 abort agent run。

**连接描述只答已认证事实。** `GET /api/descriptor` 需 cookie 或设备 bearer，返回 ingress 已认证的 client 身份、
Backend id、账号 scope、build id 与真实 capabilities（按部署实际配置生成）。无版本协商字段。未登录方只能读
`GET /api/web-auth` 的 `{ enabled }`。

**CORS。** 已声明 App origin 得到 OPTIONS 204 与 `authorization, content-type, last-event-id`；响应 expose
`last-event-id`。未声明 origin 一律 403（含唯一的未登录读取）。

**测试。** `packages/gateway/test/ingress.test.ts`，12 个用例，真实 HTTP + 真实 Backend：
`node --test packages/gateway/test/ingress.test.ts` exit 0。改动整体验证
`pnpm verify:changed --base=integration/client-app`：typecheck 0、两个包的测试 0、`check:docs` 1（仅 12 个既有的
`.dev`/`.pi` 断链；本票新增文件无断链）。command、revision、exit code、log path 见 verification 段。

**未做/留给后续。** 不声明 TLS 或反向代理存在（属部署关注点）；未切换运行入口（票据 16）；未写旧客户端兼容或版本
协商（G1）；App 端安全存储与原生证据属票据 04。
