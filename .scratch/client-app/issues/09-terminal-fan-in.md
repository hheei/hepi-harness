# 09 — 在 cookie/bearer 下恢复多终端 fan-in

Type: implementation
Status: resolved (merged at `8c5dfb4`)
Blocked by: [05](./05-shared-ui-routing-and-scope.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

用户经 Web/App 使用多个本地或 SSH 终端，连接数与重连顺序保持可控。

## Scope

迁移 terminal client 到认证 fetch SSE reader，保留 Backend relay 和多终端聚合。处理 open/write/resize/close、重连 cursor、请求取消以及退出/scope cleanup；复用 xterm 与现有 session ownership。

## Acceptance

- [x] 多个 mounted tab 使用单个聚合订阅；切标签不重复打开远端终端。
- [x] cookie/bearer 都能读写/resize/close，Last-Event-ID 等原有恢复信息透传。
- [x] 断网、进程退出、切 profile 和恢复前台正确收敛；旧流不写入其他终端。
- [x] 本地/SSH 与非入口 execution Gateway 都能路由到正确宿主；客户端永不拿 execution token。

## Verification

复用 terminal e2e/close/session 场景，加 bearer 和连接切换；断开能关闭上游 reader。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Review notes

涉及 G3/G6，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。

## Answer

**这一片现在做什么。** 页面为所有 mounted tab 只持一条终端流，并且用 **fetch** 读它，不再用 `EventSource`。这是本票的核心：
`EventSource` 不能声明凭证，所以它只能是 Web 的 cookie 路径；App 持有可撤销设备 bearer，必须显式呈现。一个 reader 覆盖两者：
cookie 分支什么都不写（浏览器自己带 HttpOnly cookie），bearer 分支只设一个 `authorization`，两条分支都不可能把凭证放进 URL。
reader 同时拥有请求的生命周期，所以释放最后一个 tab 会 **abort** 该请求（而不是留给浏览器自己重试），掉线后的重开由模块自己发起，
并带上每个 tab 自己的 cursor。

**流属于连接，不属于 mount。** `WorkbenchClient.connection` 就是那个连接值本身（origin + credential + fetch，同一个对象，
供 surface 按引用比较），`AppShell` 把它同时交给页面唯一的 `TerminalFanIn`（经 `useTerminalFanIn(connection)` 持有）和每个
`TerminalPanel`（`connection` prop），因此一个 tab 的流和它的 writer 不可能宣称不同身份。切连接 → 旧流 `close()`、新流新建，
tab 的 cursor 不会被带进另一个 scope；`dispose()` 之后 client 拒绝后续请求。

**Backend relay、聚合与 cursor 语义原样保留。** 路由仍由 Backend 按每次请求的 routing cwd 解析到 workspace binding，再由
它连到拥有该 workspace 的 execution gateway；多宿主 tab 的合并在 Backend，页面不因此多开第二条流。open/describe/input/resize/
close、`reset` 语义、`TERMINAL_REPLAY_CHARS` 保留尾部、`Last-Event-ID`/`after` 透传都未改动。客户端永不接触 execution token：
两个 execution 凭证都不等于设备 bearer，且客户端 listener 不服务 `/v1`、也不接受 execution token 作为客户端身份。

**顺带修掉的传输缺陷（在本票范围内，属同一 seam）。** ingress proxy 和 Backend 的 terminal relay 都把响应头缓冲到第一帧
才发出，因此「从已读 cursor 继续、没有东西要重放」的续流会让调用方一直等下一帧 keepalive（30 s）。两处都改为
`flushHeaders()`：一条暂无内容可写的流同样是已挂接的，调用方应当从状态码得知这一点。

### 受测 seam

`packages/gateway/test/ingress-terminal.test.ts`（4 个用例，真实 HTTP/SSE + 真实 Backend + 真实本地 gateway 进程 + 真实
SSH 组合的 gateway，transport 是本机的 Python helper，argv 就是 launcher 构造的那份）：

1. **Web 页面**：两个 tab 在同一条流上打开、写入、resize（shell 自己报 `stty size`）、按各自 cursor 续流（续流不重放已读内容、
   不 `reset`）、关闭后 host 报 `exited`；一个 tab 的输出不写进另一个 tab。
2. **设备 bearer**：同一组读写/关闭在 bearer 下成立；bearer 不等于任一 execution 凭证，客户端 listener 不服务 `/v1`，
   也不接受 execution token 当客户端身份。
3. **两宿主**：本地与 SSH 各一个 tab 在同一条流上合并，各自跑在自己的 workspace 目录里；ingress 的默认宿主不是这两者中的
   路由依据。
4. **取消**：调用方离开后 Backend 侧上游流归零；随后一条只命名第二个 tab 的流不会收到第一个 tab 的输出。

`packages/ui/src/lib/terminal-fan-in.test.mjs`（4 个用例）覆盖 reader 本身：一条请求承载多个 tab、keepalive comment 被丢弃、
跨 chunk 的帧被完整拼出、每 tab cursor 在重开时正确、释放/关闭会 abort、拒绝（4xx）是 fatal 不重试、bearer 与 cookie 分支
各自只声明该声明的东西。`packages/ui/src/client.test.mjs`（3 个用例）断言连接值是同一个对象（surface 按引用比较）并是流
所呈现的身份，同时保留连接请求、命名拒绝、dispose 与 completion registry 读同一连接的既有断言。
`packages/ui/src/hooks/useTerminalFanIn.test.mjs` 用一个真实 `TerminalFanIn` 覆盖所有权规则：同一个连接值重渲染不重开流，
换连接值会 abort 旧请求并在新身份下开新流，卸载释放当前流。`packages/ui/src/components/TerminalPanel.test.mjs` 覆盖 writer
与请求沿用连接身份（bearer 一个 header、cookie 零 header + `same-origin`）。

`apps/web/e2e/ux-terminal-fan-in.mjs`（26 checks，真实 Chromium + esbuild 挂载真实 `TerminalPanel`/`TerminalFanIn`/terminal
client）覆盖浏览器自己的那一半：两个 mounted tab 只留一条 live 流且流内命名两个 tab；cookie 分支不写 authorization、由浏览器
自己带上 HttpOnly cookie；bearer 分支只有一个 header、没有 cookie、凭证不进 URL；一个 tab 的帧不写进另一个 tab；掉线后重开
命名该 tab 自己的 cursor；释放最后一个 tab 会 abort 请求。第三个场景用**开发构建的 React**（`conditions: ["development"]`）
跑同一份 fixture：`StrictMode` 在这里真的重放 effect（fixture 自己数到 2 次），重放之后仍必须只有一条 live 流、两个 tab 都
在上面、且帧仍到达自己的 tab。生产构建不会重放 effect，所以那一半只能在这里证明。

### 证据

命令、revision、exit code 与日志：

| 检查 | 命令 | revision | exit | 日志 |
| --- | --- | --- | --- | --- |
Revision: `7b44857`（`impl/client-app-09`，已并入 integration tip `8863369`）。所有行都在这个 revision 上、干净工作树上运行。
StrictMode 复审修复后，于 `0e621ab`（`impl/client-app-09`，其上已并入 integration tip `47f501c`）重跑下表；标 † 的行是那个 revision 上的结果，其余行未改动的源码相同，沿用 `7b44857` 的证据。

| 检查 | 命令 | exit | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| 本票新集成测试 | `node --test packages/gateway/test/ingress-terminal.test.ts` | 0 | 4 pass / 0 fail | `.dev/verify/t09/ingress-terminal.log` |
| gateway 全套 | `node --test packages/gateway/test/*.test.ts` | 0 | 334 pass / 0 fail | `.dev/verify/t09/gateway-suite.log` |
| server 全套 | `node --test apps/server/test/*.test.ts` | 0 | 453 pass / 0 fail | `.dev/verify/t09/server-suite.log` |
| session 套件 | `node --test packages/session/test/*.test.ts` | 0 | 48 pass / 0 fail | `.dev/verify/t09/session-suite.log` |
| ui 套件（含 fan-in/client/hook/panel）† | `node --test $(find packages/ui/src -name '*.test.mjs' | sort)` | 0 | 142 pass / 0 fail | `.dev/verify/ticket09-strictmode/ui-suite.log` |
| Web 单测 | `node scripts/test-web-unit.mjs` | 0 | 45 pass / 0 fail | `.dev/verify/t09/web-unit.log` |
| 浏览器 fan-in 场景 † | `node apps/web/e2e/ux-terminal-fan-in.mjs` | 0 | 26 checks, PASS（含开发构建 `StrictMode` 重放场景） | `.dev/verify/ticket09-strictmode/fan-in.log` |
| hook 生命周期（同 state 重放 effect）† | `node --test packages/ui/src/hooks/useTerminalFanIn.test.mjs` | 0 | 2 pass / 0 fail | `.dev/verify/ticket09-strictmode/hook-lifecycle.log` |
| typecheck（ui/web）† | `pnpm --filter @hepi/ui typecheck`、`cd apps/web && npx tsc --noEmit` | 0 / 0 | 两包 clean | `.dev/verify/ticket09-strictmode/typecheck-ui.log`、`.dev/verify/ticket09-strictmode/typecheck-web.log` |
| 连接作用域浏览器烟测 | `node apps/web/e2e/ux-workbench-scope.mjs` | 0 | 16 checks, PASS | `.dev/verify/t09/ux-workbench-scope.log` |
| typecheck（ui/web/app/gateway/server/session） | `pnpm --filter @hepi/<pkg> typecheck` | 0 | 6/6 exit 0 | `.dev/verify/t09/typecheck-*.log` |
| 选定检查 | `pnpm verify:changed --base=integration/client-app` | 1 | `changed-typecheck`、`changed-test`、`web-unit` 全 0；`check-docs` 1（既有 12 个 `.dev`/`.pi` 断链，全在本票之外的 `.scratch` 文档里） | `.dev/verify/2026-10-18T01-24-40-855-verify-changed/` |

浏览器场景的关键断言（`ux-terminal-fan-in`）：两个 mounted tab 只留 **一条** live `/api/terminal/events` 请求且该请求命名两个
tab（先只命名第一个 tab 的那条已 abort）；cookie 分支零 authorization header 且浏览器带上自己的 HttpOnly cookie；bearer 分支
一个 `Bearer …` header、无 cookie、凭证不进 URL；一个 tab 的帧只写进该 tab 的 xterm；掉线重开命名 `tab-a|…|8` 这个该 tab 自己
的 cursor；释放最后一个 tab 后 live 流归零。

**文档。** 客户端合同与路由写在 [client ingress 的终端 fan-in 一节](../../../docs/client-ingress.md#the-terminal-fan-in)；
连接预算的算术仍在 [chat.md](../../../docs/chat.md#the-pages-connection-budget)（本票未改该文件的数字，只确认它仍成立）。

### 复审修复：StrictMode 重放会永久关掉页面的流（2026-10-18）

**问题（P2，两个真实宿主都命中）。** `useTerminalFanIn` 用 `useMemo` 建流、用 `useEffect` 的 cleanup 关流。开发构建下
`StrictMode` 会重放 effect：cleanup 把 memo 里的那条流 `close()` 掉（`closed = true` 不可逆），effect 重放时拿回同一个实例，
于是 `subscribe()` 从此返回空订阅——页面上的终端再也挂不上，直到整页刷新。两个宿主的 root 都在 `StrictMode` 里，所以这不是
fixture 的问题，是生产路径的问题；生产构建不重放 effect，因此单元/浏览器用例都只在开发构建下能暴露它。

**修法（拥有该生命周期的抽象）。** 流改由 effect 创建并存入 state，effect 的 cleanup 关掉**它自己**创建的那条；重放时 effect
再建一条并把 state 换成新的那条，卸载仍然关掉正在展示的那条。返回给调用方的值只在该连接上有效：切连接时先给 `null`，
不把上一个连接的流（以及它的 cursor）交给面板。

**调用方随之为 nullable。** `AppShell` 只在有流时把 subscribe 回调交给 `TerminalPanel`（`stream={subscribeTerminal}`，
无流时是 `null`）；`TerminalPanel` 的 `stream` prop 因此可为 `null`，并在 effect 开头直接返回——没有流可挂时不建 widget，
否则流到达后整个 effect 会再跑一次，widget、host 的 describe 和 attach 都会做两遍。这样一次 tab 挂载仍然只有一次
`POST /api/terminal`、一个 widget、一条流（浏览器场景的 "each mounted tab opened its own session: 2" 仍是 2）。

**红-绿证据。**

| 检查 | 命令 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| hook 生命周期（同一 state 上重放 effect） | `node --test packages/ui/src/hooks/useTerminalFanIn.test.mjs` | 2 fail，但失败原因是 harness 的 react shim 没有 `useMemo`（旧实现需要它，`hook-lifecycle-red.log` 里是 `TypeError: (0, import_react.useMemo) is not a function`）——这条红只说明新 harness 跑不了旧实现，**不证明原缺陷** | 2 pass |
| 开发构建 React + `StrictMode` 的浏览器场景（`.dev/verify/ticket09-strictmode/fan-in-red.log`） | `node apps/web/e2e/ux-terminal-fan-in.mjs` | 第三个场景 FAIL：`timed out waiting for one live stream after the replay`（7 条流全部 closed） | 26 checks PASS |

**原缺陷的红证据是浏览器那条，不是 hook 那条。** hook 用例在回退实现后确实红，但红的是 harness：新用例的 react shim
只提供 `useState`/`useEffect`，而旧实现要 `useMemo`，所以它报 `TypeError: (0, import_react.useMemo) is not a function`，
与「重放后没有 live 流」无关。真正证明原缺陷的是开发构建 React 的浏览器场景：把 hook 回退成 memo 版本后，第三个场景在
等待重放后的那条 live 流时超时，7 条流全部 closed（`fan-in-red.log`）；同一份 fixture 在修复后 26 checks 全绿，并且
fixture 自己数到 effect 被重放两次。

**未声明。** 这条修复证明的是开发构建 React 的重放行为（浏览器场景里 fixture 自己确认 effect 真的被重放两次）；它不声明
生产构建会重放 effect，也不声明真实 Tauri/WebKitGTK 上的行为（仍属票据 04/16 的证据）。

### 未声明的

- **未在真实 Tauri/WebKitGTK 或移动目标上跑本票的 bearer 路径**（票据 04 的 Android 证据仍缺失）。这里证明的是协议与公开
  seam 的合同：同一 reader 在 bearer 下发出的是那一个 header、在 cookie 下不发出任何 header，浏览器里也一样；真机
  WebKitGTK/mobile 的 bearer 连接仍无证据。
- **旧的 Next 构建浏览器场景在本树跑不了。** `ux-terminal-session`/`ux-terminal-close`/`ux-terminal-budget`/
  `stream-heartbeat-idle` 都 spawn `next start` 并要求 `.next/BUILD_ID`，而 Web 宿主已改为 Vite 静态（票据 05；入口切换属
  票据 15/16）。本票因此把浏览器侧的证据换成 esbuild 挂载真实 panel/fan-in/client 的 `ux-terminal-fan-in`（真实 Chromium），
  路由、relay、多宿主与取消仍由 `ingress-terminal` 的真实 HTTP/SSE 集成测试持有。
- 没有把 terminal 流搬进 `WorkbenchClient` 作为第二个 owner：`TerminalFanIn` 仍由 `AppShell` 通过
  `useTerminalFanIn(connection)` 持有，连接只提供值。这样 panel 与流的所有权不变，切连接仍由连接值决定。
- 未测量流内 JSON 往返（P2 候选），本票没有新增 parser。

### 与并行切片的交界（记录）

- 票据 05 的 conversation-API cutover 在 `fix/client-app-05-conv-api`（`1489c2b`），未在 integration tip 上。它重写
  `AppShell` 的会话请求词汇并改 `client.ts` 的 `WorkbenchRequestError` 构造；与本票的交界是 `WorkbenchClient.connection`
  这一处新增字段与 `AppShell` 的 `connection` 读取，二者都是新增而非替换，合并时冲突面小。
- `apps/web/app/page.tsx`（旧 Next 入口）仍直接挂 `AppShell` 而不提供 workbench 连接，这在 integration tip 上已成立
  （`AppShell` 在 05 之后就需要连接作用域）；入口切换属票据 15/16，`page.tsx` 的删除属票据 17。

### 已知记录项（非阻塞）

- 文件与终端首期保留 Backend relay（spec 已声明）。本票没有走直连宿主，也没有新增宿主选择器。

