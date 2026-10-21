# 03 — 经 Gateway 完成首次会话读写与 SSE

Type: implementation
Status: resolved
Blocked by: [02](./02-credentials-and-connection-descriptor.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

用户经客户端入口读取会话、提交输入并持续接收同一 Backend 的事实。

## Scope

让一个真实客户端调用者通过 /api 读取会话、提交和订阅，而不是只测试代理 helper。必要映射移入 Gateway，Backend 继续负责 ConversationOperations 和命令业务。复用原生帧/错误合同；把客户端身份与入口默认宿主安全传入 Backend。直接按新入口更新调用者，不为旧 Web 增加桥接或 fallback。

## Acceptance

- [x] 读取、创建/选择、发送、snapshot/state/submission/resync_required/state_oversize 经新入口保持合同。
- [x] Backend HostClient 只连内部 execution listener；入口不是执行宿主时路由正确，无代理递归。
- [x] 故意丢失提交响应后查原 requestId，既不重发未知写入，也不制造第二份会话/提交。
- [x] 流逐步到达，保留 header/状态码/心跳/断开，客户端取消传到上游；入口透传原始 SSE bytes，不解码后重编码每帧。

## Verification

Gateway 公开 seam 的真实 HTTP/SSE 集成场景；复用现有 submission/lifecycle 回归，不另写投影。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Review notes

涉及 G1/G2/G3，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。

## Answer

实现于 `impl/client-app-03`（base `3965b22f20af9b74c77a2c429e6a8f48aff7c4a3`）。行为与配置见
[Client ingress](../../../docs/client-ingress.md#the-conversation-slice)；证据见
[verification](../../../docs/verification.md#client-ingress-conversation-slice-ticket-03)。

**这一片现在做什么。** 真实调用者只经 `/api` 就能创建会话、读 `state`/历史/条目、提交、stop/continue、fork/重命名/
删除，并持续收到 Backend 自己的 `snapshot`/`state`/`submission`/`resync_required`/`state_oversize` 帧。Gateway 只做两件
属于传输边界的事：路由与身份；会话映射一行没有搬进 Gateway，`ConversationOperations`、命令业务和 durable 写入仍全在
Backend。既有帧名、状态码、body、wire code 与 `projectionId`/revision 语义原样保留，没有第二套投影、没有第二份 durable
状态源。

**入口默认宿主。** 新增 `HEPI_INGRESS_DEFAULT_HOST`（gateway id），ingress 把它作为可信配置在已认证请求上以
`x-hepi-default-host` 转发；Backend 在原有 `webHostOf`/`projectHostOf` 解析前先取该值（`hostOfRequest`），未知 id 得到既有的
`configuration_required`。客户端自己的同名 header 不在 `FORWARDED_REQUEST_HEADERS` 里，会被覆盖，不能替代入口默认宿主；
未配置时 host-scoped 路由照旧答 `configuration_required`，入口不猜。协议常量
`DEFAULT_HOST_HEADER` 在 `packages/protocol/src/index.ts`，两侧共用一个拼写。

**SSE 透传与取消。** 事件流是从 Backend response 直接 pipe 到调用者 socket 的字节，没有逐帧解码/重编码；测试把同一会话
Backend 直连写出的首帧与经 ingress 收到的首帧按 `event: …\ndata: …\n\n` 逐字节比较，并确认心跳 comment 帧
（`:\n\n`）穿过了 ingress。调用者取消会结束 ingress 的上游请求，测试在 Backend 自己的 server 上数已挂载流，从 1 归 0。

**丢失提交响应。** 提交后丢弃响应体，再按原 `requestId` 查 `/submissions?requestId=`，得到 durable 记录；用同一
`requestId` 重发收敛到同一 `submissionId`；会话列表仍只有一条，transcript 只有一轮。同一 `requestId` 重建会话也回到原会话。

**seam 下的测试**（`packages/gateway/test/ingress-conversation.test.ts`，8 个用例，真实 HTTP/SSE + 真实 Backend +
真实 execution gateway 进程）：
1. Backend 经内部 execution listener 拿到宿主的真实账户/root；该 listener 拒绝客户端 cookie、ingress 服务凭证与任意客户端
   bearer，只接受 execution token；客户端 listener 不服务 `/v1`，`served` 只记录客户端自己发出的请求（无递归）。
2. ingress 默认宿主决定 host-scoped 读，客户端 `x-hepi-default-host` 不能替换；未配置默认宿主时答 `configuration_required`。
3. 创建/读/state/提交/帧/`resync_required` 保持合同，窗口用真实客户端共享 reducer（`@hepi/session`）折叠。
4. `state_oversize` 在流与 HTTP 读（413）上同名同义。
5. 丢失响应后的 `requestId` 恢复不重发、不重复。
6. 流逐步到达、首帧字节一致、心跳存活、headers/status 保留。
7. 调用者取消传到上游。

**命令与结果**（在 `df5463c` 上整体重跑，logs 在 `.dev/verify/ticket03-df5463c/`）：
`node --test packages/gateway/test/ingress.test.ts` exit 0；`node --test packages/gateway/test/ingress-conversation.test.ts`
exit 0；`pnpm --filter @hepi/server --filter @hepi/gateway -r typecheck` exit 0；`pnpm --filter @hepi/gateway test` exit 0；
`pnpm --filter @hepi/server test` 448 tests exit 0；复用的回归 `durable-submissions`、`frame-size`、
`conversation-heartbeat`、`project`、`gateway-client-boundary` 均 exit 0；`pnpm verify:changed --base=integration/client-app`
除既有的 12 个 `.dev`/`.pi` 断链（`check:docs` 1）外全部 0。测试里浏览目录的断言原先写死本机 home，现改为与宿主
自己报告的账户 home 比较（`realpath(homedir())`），因此在任何机器上都成立。

**未做/留给后续。** 入口仍不是部署入口（票据 16）；其上没有共享 React UI/App（票据 05）；不声明 TLS；旧 Web 未加桥接或
fallback，调用者随票据 05/17 一起切。记录项（非阻塞）：`HEPI_INGRESS_DEFAULT_HOST` 只声明一个宿主，多 origin/多宿主映射属
票据 06 的项目与 worktree 用户流程。
