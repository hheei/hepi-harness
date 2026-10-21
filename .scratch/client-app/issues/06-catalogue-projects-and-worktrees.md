# 06 — 迁移目录、项目和 worktree 用户流程

Type: implementation
Status: resolved — implementation and native client seam integrated; global release acceptance remains in 16
Blocked by: [05](./05-shared-ui-routing-and-scope.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

用户经任一客户端找到会话、管理本地/SSH 项目并进入正确工作目录。

## Scope

把目录/搜索、sidebar UI state、项目文件夹/default/删除保留绑定、host directory 选择和 worktree 操作接到共享 UI 与新入口。迁移已有逻辑而不重写业务或由 App 重建绑定。按矩阵保留项目删除与 retained binding 对旧会话的语义。

## Acceptance

- [x] 会话列表/搜索/分页/归档或 pin 等已有目录行为跨两客户端一致，列表版本与侧栏 revision 不失真。
- [x] 创建、选择、修改默认、unlink/remove 项目以及 worktree 行为保持现有合同。
- [x] 本地/SSH、入口 Gateway ≠ execution Gateway 两类绑定都正确；原会话不因项目元数据删除而指到其他 cwd。
- [x] 所迁能力旧 caller 已切新实现，相关矩阵行附删除位置和验证记录。
- [x] 每次列表组装仅各读取一次 catalog/projects/workspaces，独立读取可并行；保留宿主/revision 语义，不逐会话读取 history，不新增全局授权缓存。请求数量有记录，见[审查 P3](../review-notes.md)。

## Verification

复用项目、workspace 路由、worktree 和 sidebar 的公开行为回归；加新入口多宿主场景。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Review notes

涉及 G3/G6，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。

## Answer

目录元数据、Project/workspace/worktree 绑定与宿主选择现在是 Backend 的事实，两个入口都以同一份合同读它。

### 现在可用的能力

**Backend 在 catalogue row 上直接陈述绑定**（`apps/server/src/catalogue-binding.ts`）。每行新增 `workspace`：
`gatewayId`、本部署为该 folder 记录的 `root`、removal/unlink 后保留绑定的 `retained: true`，以及它所属 Project 的
`project`（id、name、默认 folder 的 workspaceId、group 展示根）。同一 answer 上还有 Backend 自己算出的
`sessionListVersion`。解析优先级仍是 configured → retained → project folder，与 `bindingOf` 完全一致，不新增第二套
持久状态或第二个解析器。

**列表组装降为一次 catalogue 读加一次 workspace 读**（审查 P3）。`apps/web/adapters/durable-api.ts` 不再把
catalogue 与单独的 projects 读、单独的 workspaces 读对账：project group 与 folder root 来自 row 本身，只有
**configured** workspace 的 root 仍需 `GET /api/workspaces`（本进程只持有它的 id 与宿主，路径是宿主的回答），且该读
对整个列表只做一次、与 catalogue 并行。没有任何逐会话 state/history 读取，也没有新增全局授权缓存。

`listVersion()` 现在读 Backend 的 `sessionListVersion`，不再在 adapter 里重算同一个事实；poll 与 list 两条路由给同一
个数，客户端比较不会看到分歧。

### 被测的 seam

| seam | 文件 | 说明 |
| --- | --- | --- |
| Backend `/api` 合同（真实 HTTP、真实 Backend、真实 gateway 与内存 git） | `apps/server/test/catalogue-binding.test.ts` | 5 个测试：row 的 workspace/host/root/group/retained 与三个 revision；无 workspace 的会话不冒充任何一项；一次组装无逐会话读；Project mutation 推进 registry revision；按 named host 解析 account；removal 后已绑定会话保留 workspace/host/root 并标记 retained；创建的 checkout 是真实会话目标；移除的 checkout 保留已在其中会话的绑定；分页窗口的 list version 仍是整表版本，而关系过滤后的版本随过滤后的表变化 |
| client ingress（真实 HTTP，Web cookie 与 device bearer，本地 + SSH 双宿主） | `packages/gateway/test/ingress-catalogue.test.ts` | 2 个测试：device bearer 读 catalogue、在两台宿主上建 Project、在各自宿主上 list/create/remove worktree、removal 后 retained 仍可解析且不再作为新会话目标；Project folder 在它自己的宿主上被寻址，而不是入口旁边那台 |
| Web adapter 投影 | `apps/web/adapters/durable-api.test.mjs` | 新增 3 个测试：list 只做 catalogue + workspace 各一次读并由 row 投影出行（configured workspace 的宿主 root 仍解析）；poll 用 Backend 的 list version 与三个 revision；一次路径问答（`cwd/validate`）对每个元数据源只读一次 |

未改动的既有合同由既有套件继续覆盖并重跑：`project.test.ts`、`worktree-picker.test.ts`、`ssh-project.test.ts`、
`sidebar-state.test.ts`、`session-search.test.ts`（server 共 452 通过）、`@hepi/gateway` 299 通过（含
`ingress.test.ts` 12 通过）。

### 命令、退出码与日志

| 检查 | 命令 | exit | 日志 |
| --- | --- | --- | --- |
| catalogue binding（5） | `node --test apps/server/test/catalogue-binding.test.ts` | 0 | `.dev/verify/client-app-06/server-catalogue-binding.log` |
| ingress catalogue，双宿主（2） | `node --test packages/gateway/test/ingress-catalogue.test.ts` | 0 | `.dev/verify/client-app-06/gateway-ingress-catalogue.log` |
| Web adapter 投影（11） | `cd apps/web && node --test adapters/durable-api.test.mjs` | 0 | `.dev/verify/client-app-06/web-durable-api.log` |
| Web adapter 全量（34） | `cd apps/web && node --test adapters/*.test.mjs` | 0 | `.dev/verify/client-app-06/web-adapter-suite.log` |
| ingress 回归（12） | `node --test packages/gateway/test/ingress.test.ts` | 0 | `.dev/verify/client-app-06/gateway-ingress.log` |
| server + gateway typecheck | `pnpm --filter @hepi/server --filter @hepi/gateway -r typecheck` | 0 | `.dev/verify/client-app-06/typecheck.log` |
| server 套件（453） | `pnpm --filter @hepi/server test` | 0 | `.dev/verify/client-app-06/server-suite.log` |
| gateway 套件（299） | `pnpm --filter @hepi/gateway test` | 0 | `.dev/verify/client-app-06/gateway-suite.log` |
| 所选检查（源码） | `pnpm verify:changed` | 1（changed-typecheck 0、changed-test 0（server 453、gateway 299）、web-unit 0；`check-docs` 1 为既有 12 条断链） | `.dev/verify/2026-10-17T18-53-20-648-verify-changed/verify.json` |
| 所选检查（文档改动后） | `pnpm verify:changed` | 1（只选中 `check-docs`，仍是同 12 条既有断链） | `.dev/verify/2026-10-17T19-04-47-673-verify-changed/verify.json`、`.dev/verify/client-app-06/verify-changed.log` |

`check-docs` 报 1，是仓库既有的 12 条 `.dev`/`.pi` 断链，与本票无关。

### 与 `integration/client-app` 合并后（tip `89887b2`）

合并时集成 tip 已推进到票据 07（history read blocks），与本题改到同一个 ingress、同一个 `server.ts` 与同样两份文档。
冲突只在两份双方都在追加的文档（`docs/migration-status.md`、`docs/verification.md`）和票据表的 status 列：两票都已
resolved，所以两段内容与两个 `resolved` 单元格都保留；没有可执行文件冲突。合并后全部检查在新树上重跑，未复用任一侧结果：

| 检查 | exit | 日志 |
| --- | --- | --- |
| catalogue binding（5） | 0 | `.dev/verify/client-app-06-merged/server-catalogue-binding.log` |
| ingress catalogue（2） | 0 | `.dev/verify/client-app-06-merged/gateway-ingress-catalogue.log` |
| ingress 回归（12） | 0 | `.dev/verify/client-app-06-merged/gateway-ingress.log` |
| Web adapter 投影（11） | 0 | `.dev/verify/client-app-06-merged/web-durable-api.log` |
| Web adapter 全量（34） | 0 | `.dev/verify/client-app-06-merged/web-adapter-suite.log` |
| gateway 套件（309） | 0 | `.dev/verify/client-app-06-merged/gateway-suite.log` |
| server 套件（453） | 0 | `.dev/verify/client-app-06-merged/server-suite.log` |
| session 套件（34） | 0 | `.dev/verify/client-app-06-merged/session-suite.log` |
| typecheck（server + gateway + session） | 0 | `.dev/verify/client-app-06-merged/typecheck.log` |

### 与 `integration/client-app` 合并到 `b66c46d` 后，以及随之做的三处削减

集成 tip 再次前进（票据 07 的整合后重跑），因此再合并一次并在该合并树上重跑全部检查。复查合并结果时去掉三处本票本身
禁止的重复，去掉之后又重跑了一遍：

| 削减 | 位置 | 替代 |
| --- | --- | --- |
| 同一优先级顺序被写两遍 | `apps/server/src/server.ts` 的 `bindingOf`/`catalogueBindingOf` | 一个 `resolvedWorkspace()` 说明命中的是哪一类；`transportOf()` 由它派生传输绑定，`bindingOf()` 就是这两步的组合 |
| 一行把同一个绑定解析两次 | `apps/server/src/server.ts` 的 `catalogueEntry` | 一次解析同时回答 `gatewayId` 与 `workspace` |
| 列表版本被第二次推导 | `apps/web/adapters/durable-api.ts` 的 `listVersion()` | 直接透传 Backend 的 `sessionListVersion`，adapter 不再重算 |
| 重复的重新注册遍历 | `apps/server/src/server.ts` 的 `ensureBinding` | 一次解析决定由哪条记录重申 root |

列表版本的削减是被断言的、不是假设的：adapter 套件的会话列表用例现在给出的版本与各行之和**不相等**（先 `5`，再 `9`），
并要求列表与 running poll 都返回该数字，因此重新推导的版本会让测试失败而不是碰巧通过。

| 检查 | exit | 日志 |
| --- | --- | --- |
| catalogue binding（5） | 0 | `.dev/verify/client-app-06-merge-b66c46d/server-catalogue-binding.log` |
| ingress catalogue（2） | 0 | `.dev/verify/client-app-06-merge-b66c46d/gateway-ingress-catalogue.log` |
| Web adapter 投影（11） | 0 | `.dev/verify/client-app-06-merge-b66c46d/web-durable-api.log` |
| Web adapter 全量（34） | 0 | `.dev/verify/client-app-06-merge-b66c46d/web-adapter-suite.log` |
| server 项目/worktree/sidebar 回归（39） | 0 | `.dev/verify/client-app-06-merge-b66c46d/server-project-regression.log` |
| gateway worktree/SSH 回归（14） | 0 | `.dev/verify/client-app-06-merge-b66c46d/gateway-worktree-regression.log` |
| ingress 回归（凭证 + 票据 07 资源，22） | 0 | `.dev/verify/client-app-06-merge-b66c46d/gateway-ingress-regression.log` |
| server 套件（453） | 0 | `.dev/verify/client-app-06-merge-b66c46d/server-suite.log` |
| gateway 套件（309） | 0 | `.dev/verify/client-app-06-merge-b66c46d/gateway-suite.log` |
| typecheck（server + gateway + web） | 0 | `.dev/verify/client-app-06-merge-b66c46d/typecheck.log` |
| 所选检查 `pnpm verify:changed --base=b66c46d` | 1（changed-typecheck/changed-test/web-unit 均 0；`check-docs` 1 为既有 12 条断链） | `.dev/verify/client-app-06-merge-b66c46d/verify-changed.log` |

与集成 tip 的差异仍只含本票文件：`git diff --name-only b66c46d HEAD` 中没有票据 07 的 `read-block.ts`、
`packages/session/src/resources.ts`、`deferred-text.ts` 或 `ingress-resources.test.ts`，票据 07 的实现按集成历史保留。

### 记录项（非阻塞）

1. **列表请求数只证明"读了哪些"，不证明成本。** adapter 套件断言的是 catalogue + workspace 各一次、且无逐会话调用，
   不是延迟或分配数字。审查 P3 的收益仍需代表负载测量；本票不声称性能改善。
2. **configured workspace 的展示根仍来自 `GET /api/workspaces`。** Backend 不持有该路径（它只有 id 与宿主），把它写进
   row 就等于让 Backend 在组装列表时逐行问宿主要路径，正是 P3 要消除的成本。代价是一次与 catalogue 并行的额外读，
   只在列表/搜索/fork/委派回答时发生。
3. **搜索与 fork/委派回答也各读一次 workspace listing**，原因同上。若将来 Backend 能为 configured workspace 记录
   canonical root，这三处可再省一次读。

### 未声明

共享 React UI（票据 05）尚未交付，因此本票交付的是 Backend 合同与 Web adapter 投影，不是渲染后的 sidebar；没有
浏览器 journey 证据。桌面/移动原生入口不涉及。票据 12/13 消费的绑定 seam 就是上面第一行：catalogue row 的
`workspace` 与 `GET /api/workspaces` 的 `retained` 标记。

### 共享 UI 的消费者切到原生路由（2026-10-18，scout-238，重开本票）

本票此前的 Answer 把"共享 React UI（票据 05）尚未交付"当作未声明边界。票据 05 已交付，因此那条边界不再成立：sidebar、
目录选择器、New Project 对话框和 New Session 上下文栏仍在打 Next BFF 的词汇（`/api/sessions/ui-state`、`/api/home`、
`/api/default-cwd`、`/api/cwd/browse`、`/api/worktrees?cwd=`、`/api/open-in-explorer`），在 App 上这些请求落到 bundle
自己的 origin，且不带设备 bearer。本次把它们的消费者切到 Backend 自己的合同，未新增 Gateway/Backend 路由，未新增 BFF
别名。

**一个命名的 client seam。** `packages/ui/src/lib/workspace-api.ts`（`createWorkspaceApi(request)` + `useWorkspaceApi()`）
是这些消费者唯一的入口，每个操作一个名字：`workspaces()`、`hosts()`、`browse(target?, path?)`、`projects()`、
`createProject()`、`removeProject()`、`unlinkFolder()`、`listWorktrees()`、`createWorktree()`、`removeWorktree()`。
请求一律经连接的 `client.request`（fixture 外挂时退化为页面 origin，与票据 11 的 `useApiRequest` 同一条规则）。

**正确的 host/workspace 授权。** 没有任何客户端命名自己所在的计算机：部署通过 ingress 的
`HEPI_INGRESS_DEFAULT_HOST`（Web 侧是 `HEPI_WEB_LOCAL_GATEWAY_ID`）在转发请求上陈述它，Backend 解析。只有**远端**
目标——`/api/hosts` 自己列出的 profile——才由调用者显式命名。worktree 操作按 workspace id 寻址，由 Backend 解析到持有
该项目文件夹的宿主。

| 旧调用 | 现在的合同 |
| --- | --- |
| `GET /api/sessions/ui-state` / `POST` | `GET/POST /api/sidebar-state`（`useSessionUiState` 经连接） |
| `GET /api/projects`、`DELETE /api/projects/:id`、`DELETE …/folders/:fid` | 同名原生路由，经连接（`listProjects`、`removeRecordedProject`、`unlinkRecordedFolder`） |
| `GET /api/worktrees?cwd=` | `POST /api/worktrees {workspaceId, operation:"list"}` |
| `POST /api/worktrees {cwd, branch}` | `POST /api/worktrees {workspaceId, operation:"create", branch}` |
| `DELETE /api/worktrees {cwd, path, force}` | `POST /api/worktrees {workspaceId, operation:"remove", path, force}`（`dirty`/`not_supported` 等保留原名） |
| `GET /api/hosts`、`GET /api/cwd/browse` | `GET /api/hosts`、`GET /api/host/directories`（远端 target 才带 hostId/profileId） |
| `GET /api/home`、`POST /api/default-cwd` | 由 `GET /api/workspaces` + `GET /api/projects` 推导（`configuredHome`、`configuredDefaultCwd`），无新路由 |
| `GET/POST /api/open-in-explorer` | 不再请求：显式不支持的 UI（按钮禁用并说明原因） |
| `POST /api/cwd/browse`（新建目录） | 不再请求：原生合同没有建目录路由，选择器只提供已存在目录 |

Web 页仍由 Next BFF 提供，因此 `apps/web/adapters/durable-api.ts` 把 `/api/host/directories` 与 `/api/sidebar-state`
按自己的名字转发给 Backend（不是别名），并在调用者未命名时补上本 origin 的 gateway id；其余旧的 BFF 路由按原样保留给
仍在使用它们的页面，票据 17 删除。

### 被测 seam

| 检查 | 命令 | exit | 日志 |
| --- | --- | --- | --- |
| 命名 seam 的请求与投影（7） | `node --test packages/ui/src/lib/workspace-api.test.mjs` | 0 | `.dev/verify/client-app-06-ui/…`（见下） |
| 真实 HTTP：真实 ingress + 真实 Backend + 真实 gateway + device bearer（4） | `node --test packages/ui/src/lib/workspace-api.http.test.mjs` | 0 | 同上 |
| BFF 原生转发（1） | `node --test apps/web/adapters/native-forwarding.test.mjs` | 0 | 同上 |
| 浏览器 seam：配置的 ingress origin + bearer，真实 SessionSidebar / NewProjectDialog / DirectoryPicker（15 checks） | `node apps/web/e2e/ux-sidebar-ingress.mjs` | 0 | 同上 |
| 共享工作台单测（161） | `pnpm --filter @hepi/ui test` | 0 | `.dev/verify/client-app-06-ui/ui-suite.log` |
| Web 单测（46，20 文件） | `node scripts/test-web-unit.mjs` | 0 | `.dev/verify/client-app-06-ui/web-unit.log` |
| Web adapter 全量（34） | `cd apps/web && node --test adapters/*.test.mjs` | 0 | `.dev/verify/client-app-06-ui/web-adapters.log` |
| 全 workspace typecheck | `pnpm -r typecheck` | 0 | `.dev/verify/client-app-06-ui/typecheck.log` |
| Web 静态构建（Vite 宿主） | `pnpm --filter @hepi/web build` | 0 | `.dev/verify/client-app-06-ui/web-build.log` |

真实 HTTP seam 断言的是：device bearer 在部署陈述的宿主上读 workspaces/projects，project 的 checkout 经
`POST /api/worktrees` 创建/列出/移除且 folder 记录随之增删、被移除的 binding 标记 `retained`，browse 是宿主的自己的
列目录且带它自报的账户，sidebar 文档在 Backend 上读写共享；同时断言 `/api/home`、`/api/default-cwd`、`/api/cwd/browse`、
`/api/worktrees?cwd=` 在 Backend 上确实是 404（这正是路径必须改的原因），且服务端从未收到 `ui-state`。

浏览器 seam 断言的是：catalogue row 被投影成 Project 分组；`/api/projects`、`/api/workspaces`、`/api/sidebar-state`、
`/api/conversations` 全部落在配置的 ingress origin 并带同一 bearer；一次 pin 写 `POST /api/sidebar-state` 且采纳其回答；
目录选择器与 New Project 对话框经 `/api/host/directories` 浏览且本地浏览不带 hostId；旧 BFF 词汇一次也没有出现。

### 记录项与未声明

1. **Next Web 宿主的构建在本 revision 上本就失败**（`c0579bd` 把 `gfm-autolink-email-loader.cjs` 移到
   `packages/ui/src/lib/`，而 `apps/web/next.config.ts` 仍指向 `apps/web/lib/`）。这是本票之前就存在、且不属本票文件的
   缺陷，因此依赖 `next start` 的旧 e2e journey（`ux-new-project`、`ux-worktree-picker`、`ux-project-removal`、
   `ux-default-workspace`、`ux-truthfulness` 等）本次没有运行；本次的浏览器 seam 用 esbuild 夹具（不需要 Next）验证。
   部署的 Web 页（`deploy/compose.yaml` 的 `web` 服务）仍跑 Next，所以该缺陷仍会阻塞部署构建，但修复属票据 16/17。
2. **目录新建能力被显式移除。** 原生合同没有建目录路由，App 上原本也不可用；选择器现在只提供已存在目录。
3. **"Open in file manager" 显式不支持。** 该能力属于浏览器所在机器，没有 Backend 路由；旧 BFF 一直回答
   `unsupported-platform`，现在按钮直接以该限制呈现。
4. **未做浏览器 e2e 的真实 Next 页面 journey**；本票的浏览器证据是配置 origin + bearer 的夹具，加上真实 HTTP seam。
5. **本分支尚未合入集成。** 本票保持重开，直到它随 `integration/client-app` 落地后在那棵树上重跑一次；当前分支是
   `fix/client-app-06-fresh`（直接基于集成 tip `e257e3d` 的线性移植，见下）。

### 合并集成 tip 后（`785a39a`，已被下面的移植取代）

把 `integration/client-app` 的 tip `e257e3d` 合并进本分支（唯一冲突是双方都在追加的票据 05 文档，按集成侧保留），
然后在合并树上重跑全部检查，未复用任何一侧的结果：

| 检查 | 命令 | exit | 日志 |
| --- | --- | --- | --- |
| 共享工作台单测（172） | `pnpm --filter @hepi/ui test` | 0 | `.dev/verify/client-app-06-ui-merged/ui-suite.log` |
| 命名 seam（7） | `node --test packages/ui/src/lib/workspace-api.test.mjs` | 0 | `.dev/verify/client-app-06-ui-merged/workspace-api.log` |
| 真实 HTTP seam（4） | `node --test packages/ui/src/lib/workspace-api.http.test.mjs` | 0 | `.dev/verify/client-app-06-ui-merged/workspace-api-http.log` |
| BFF 原生转发（1） | `cd apps/web && node --test adapters/native-forwarding.test.mjs` | 0 | `.dev/verify/client-app-06-ui-merged/native-forwarding.log` |
| 浏览器 seam（15 checks） | `node apps/web/e2e/ux-sidebar-ingress.mjs` | 0 | `.dev/verify/client-app-06-ui-merged/sidebar-ingress.log` |
| Web 单测（53） | `node scripts/test-web-unit.mjs` | 0 | `.dev/verify/client-app-06-ui-merged/web-unit.log` |
| Web adapter 全量（34） | `cd apps/web && node --test adapters/*.test.mjs` | 0 | `.dev/verify/client-app-06-ui-merged/web-adapters.log` |
| 全 workspace typecheck | `pnpm -r typecheck` | 0 | `.dev/verify/client-app-06-ui-merged/typecheck.log` |
| Web 静态构建（Vite 宿主） | `pnpm --filter @hepi/web build` | 0 | `.dev/verify/client-app-06-ui-merged/web-build.log` |
| 所选检查 | `pnpm verify:changed --base=integration/client-app` | 1（changed-typecheck 0、changed-test 0、web-unit 0；`check-docs` 1 为既有 12 条 `.dev`/`.pi` 断链，指向本票文件的 0 条） | `.dev/verify/client-app-06-ui-merged/verify-changed.log`、`.dev/verify/2026-10-18T03-02-55-860-verify-changed/verify.json` |

与集成 tip 的差异只含本票文件：`git diff --stat integration/client-app HEAD` 列出 17 个文件，全部属本票（新 seam 与
测试、四个消费者、BFF 转发、文档）。

### 重新移植到集成 tip（`fix/client-app-06-fresh`，2026-10-18）

上面那轮检查跑在一个把集成 tip 合并进来的分支上。为得到可直接落地的线性历史，本票的 17 个文件在干净 worktree
（`.dev/worktrees/client-app-06-fresh`，`git worktree add -b fix/client-app-06-fresh e257e3d`）里按原样重放到
`e257e3d` 上：没有合并任何其它分支，也没有改动票据 05/09/13 的文档（旧分支的合并只碰过双方都在追加的票据 05 文档，
按集成侧保留）。移植后工作树与 `fix/client-app-06-ui` 的树逐字节相同（`git diff --quiet 44d7167 -- .` 无输出），随后
在这棵树上重跑检查：

| 检查 | 命令 | exit | 日志 |
| --- | --- | --- | --- |
| 命名 seam（7） | `node --test packages/ui/src/lib/workspace-api.test.mjs` | 0 | `.dev/verify/client-app-06-fresh/workspace-api.log` |
| 真实 HTTP seam（4） | `node --test packages/ui/src/lib/workspace-api.http.test.mjs` | 0 | `.dev/verify/client-app-06-fresh/workspace-api-http.log` |
| 浏览器 seam（15 checks） | `node apps/web/e2e/ux-sidebar-ingress.mjs` | 0 | `.dev/verify/client-app-06-fresh/sidebar-ingress.log` |
| BFF 原生转发（1） | `cd apps/web && node --test adapters/native-forwarding.test.mjs` | 0 | `.dev/verify/client-app-06-fresh/native-forwarding.log` |
| 共享工作台单测（172） | `pnpm --filter @hepi/ui test` | 0 | `.dev/verify/client-app-06-fresh/ui-suite.log` |
| 全 workspace typecheck | `pnpm -r typecheck` | 0 | `.dev/verify/client-app-06-fresh/typecheck.log` |
| 所选检查 | `pnpm verify:changed --base=e257e3d` | 1（changed-typecheck 0、changed-test 0、web-unit 0；`check-docs` 1 为既有 12 条 `.dev`/`.pi` 断链，指向本票文件的 0 条） | `.dev/verify/client-app-06-fresh/verify-changed.log`、`.dev/verify/2026-10-18T04-44-20-871-verify-changed/verify.json` |

差异检查：`git diff --name-status e257e3d`（未提交时）与 `git diff --stat e257e3d HEAD`（提交后）都只列出本票的 17 个
文件，没有触及其它票据的文件。


## Status reconciliation — 2026-10-19

The former header said the fresh UI port was not integrated. Integration `3e69c62` contains `efdd9ae`, `fbcac7d` and the connection-signal correction `a0f2c01` (confirmed with `git merge-base --is-ancestor`, exit 0). Every acceptance item above is checked and the retained native forwarding/browser evidence remains scoped to its measured revision. No source changed and no checks were rerun for this metadata correction. Final current-artifact, native-shell and deployment journeys remain owned by ticket16; this resolved implementation ticket does not claim those journeys passed.
