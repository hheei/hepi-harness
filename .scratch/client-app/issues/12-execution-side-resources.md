# 12 — 迁移 skills、安装和 agent definitions

Type: implementation
Status: resolved (merged into `integration/client-app` at `e5a9d18`; integration-tree checks below)
Blocked by: [06](./06-catalogue-projects-and-worktrees.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

用户在两端管理选定执行宿主上的 skills/agent definitions 和已有资源安装。

## Scope

迁移现有 skills inventory、market/安装反馈、项目与全局启用、agent definitions 及相关执行侧资源入口。保持 Backend 解析执行绑定、Gateway 执行宿主 I/O 的责任；迁移来源版本/许可证随借用的上游代码保留。

## Acceptance

- [x] 库存、项目目标、安装/更新/删除及既有 agent definitions 操作在新入口有 owner 与明确结果。
- [x] 本地与 SSH 操作命中所选执行宿主；入口默认机器不覆盖项目绑定。
- [x] 错误/未支持能力、冲突及加载竞态保持现有可见语义；不引入研究第二部分的新产品功能。
- [x] 旧 adapter 和 client 引用都进入可删除状态，矩阵记录验证。
- [x] 审查修复（P1 加载竞态、P2 项目 add 目标、P2 StrictMode 生命周期、P2 delegate 迟到读）已修复并有回归，合并进 `integration/client-app` 后在集成树上复跑（见下方「集成后复跑」）。

## Verification

复用 skills inventory race、install feedback、project-target、SSH 及 agent definitions 回归。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Review notes

涉及 G3，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。

## Answer

### 现在可用的行为

**客户端入口即执行侧资源入口。** skills 库存、安装/更新/删除语义内的替换与切换、revision check、market 浏览，以及 agent definitions 的读/校验/保存/删除，全部经 client ingress 的 Backend 自有路由：

| 路由 | 归属 |
| --- | --- |
| `GET /api/skill-market/{skills,search,preview,bundles}` | Backend 自己的 repository（不是宿主） |
| `GET /api/skill-market/{inventory,installed,check}`、`POST {install,update}`、`PATCH /api/skill-market/skills` | 执行宿主的安装能力 |
| `GET/PUT/DELETE /api/agent-definitions[/document]` | 同一宿主的 `<agent dir>/agents` 与 `<workspace>/.pi/agents` |

**客户端只命名 workspace，不命名机器。** 新增 `packages/session/src/execution-resources.ts`：一个连接作用域持有 repository 读与 `select(workspaceId)` 选中的 target。哪个 gateway、哪个账号服务该 workspace 由 Backend 的绑定解析决定，与会话同一条 seam。这关闭了审查 G3 在本题面上的缺口：`apps/web/adapters/agent-definitions.ts` 原来为了填 `hostId` 去读本部署的 workspace/project listing，那段读已删除，现在只转发 workspace；入口自己的 `HEPI_INGRESS_DEFAULT_HOST` 因此不可能覆盖 Project 记录的绑定。

**可见语义保持原样。** 拒绝不被压平：`unreachable_host`（含单行原因）、installer 自己的 `not_found`（未绑定 workspace）、`confirmation_required` + `state`、`conflict`（陈旧确认，编辑保留）、`unsupported_capability` + `field`、`outcome_unknown`（不重放）。adoption 仍是与文件结果并列的第二个 outcome。宿主侧合同未改：`apps/server/src/skill-install.ts` 仍拥有 baseline/provenance/两种 state，`apps/server/src/agent-definitions-http.ts` 仍拥有校验与整文档写入，gateway 的 `/v1/installs` 与 `agent-definitions` 资源 seam 仍是唯一写入者。上游/版本/许可证记录未动（`docs/execution-side-skills.md#provenance`）。

**加载竞态是作用域属性。** 旧面板靠一个 request 计数器让最新读胜出；现在 `select()` 一个 target、旧 target `dispose()` 之后，迟到的答案被拒绝为 `disposed`，不会写进新宿主视图。这是被断言的（见下表第 6 个用例），不是假定的。

**共享 workbench 已接到这条 seam（票据 05 落地后补做）。** Skills 面板、Agents 面板、quick delegate 与输入框的 skill dormancy 都是两端同一份组件（`packages/ui`），现在各自经 `useExecutionTarget(workspaceId)` 读宿主，而不是相对 `fetch`：Web 页用自己的 origin + cookie，App 用配置的 Gateway + device bearer。相对调用在共享树里会去问 App bundle 要宿主的 skills，这正是 seam 存在的理由。切目标即 `dispose()` 旧 target，因此面板不再需要 request 计数器，迟到的 inventory 是 `disposed` 且不显示为宿主失败。同时删掉两处重复拼写：`apps/web/adapters/durable-api.ts` 的 `PATCH /api/skills` 分支（连同 SKILL.md 路径→目录名的翻译，`toggleDirectories` 一并删除）已无调用者；面板自己发规范路由 `PATCH /api/skill-market/skills`。`/api/agent-definitions` 代理仍接受 Web 页面链接的 `cwd=/workspace/<id>`，并原样转发共享客户端的 `workspaceId`，两种拼写都不解析宿主。

### 受测 seam

| seam | 文件 | 说明 |
| --- | --- | --- |
| client ingress + 真 Backend + 真本地 gateway + 真 SSH helper（5 个用例） | `packages/gateway/test/ingress-resources-install.test.ts` | 入口声明 `defaultHostId = workstation`，SSH Project 的 folder 仍落在 SSH 宿主：安装写进 `builder` 的 home 而不是本机账号；两台宿主的 inventory 各自报告自己的账号与内容；project scope 写进 folder 而非账号；切换只改远端文档；replacement 按调用者看过的 digest 集合钉住、陈旧确认 409 且编辑保留、未确认 409 + `locally-modified`；未绑定 workspace `not_found`、宿主不可达 `unreachable_host`、写入 `outcome_unknown` 且无 `installed`；definitions 在各自宿主上读/写/删（dry run 不落盘、`unsupported_capability` 带 `tools` 字段、未绑定 workspace 404）；cookie/bearer 分支与未声明 origin 403、`/v1/installs` 在入口 404 |
| client seam（8 个用例） | `packages/session/test/execution-resources.test.ts` | 地址是连接自己的 origin、凭证不进 URL、cookie 用 `same-origin`/bearer 用 `omit`；任何请求都不含 `hostId`；install/toggle/check/update 的 body 与 query 形状；拒绝保留 Backend 的 `code`/`state`/`issues`；未知 body 形状是 `unavailable` 而非空宿主；**选择切换后迟到答案被 `disposed` 拒绝**；dispose 后零请求；repository 读保留 `unavailableSources`/`unavailable` 理由 |
| Web adapter 投影（4 个用例） | `apps/web/adapters/agent-definitions.test.mjs` | 只发一次 Backend 请求、只带 `workspaceId`、不再发 workspace/project listing、body 里没有 `hostId`；共享客户端的 `workspaceId` 原样通过 |
| 共享 UI 面板走连接（116 个用例） | `packages/ui` `node --test src/**/*.test.mjs` | 面板/纯域逻辑套件，含 agent-definitions 的能力与 issues 投影 |
| skills inventory race 浏览器回归（真 Chromium，production `SkillsConfig`） | `apps/web/e2e/ux-skills-inventory-race.mjs` | 提交的用例独立驱动的是"旧宿主的答案在选中宿主仍 loading 时到达"这一序：不发布旧库存、不结束 loading；随后选中宿主作答并列出自己的 skill。断言读渲染后的 DOM。"旧宿主后答"那一序由评审时的开发构建 React 检查覆盖，不在本用例内 |
| skills project-target 浏览器回归 | `apps/web/e2e/ux-skills-project-target.mjs` | project scope 写进 project 自己的默认 folder（beta）、不点名 conversation、toggle 走规范 `PATCH /api/skill-market/skills` 且 body 是 host 目录名、check 命名同一 target |
| client seam provenance（1 个用例，新增） | `packages/session/test/execution-resources.test.ts` | 安装记录的 `ref/version/repository/documentPath` 与 `availableVersion` 保持自己的字段名——修掉了一个把 provenance 压成 `value` 的读取错误 |

未改动的既有合同由既有套件继续覆盖并重跑：`skill-install.test.ts`、`live-skill-target.test.ts`、`skill-market.test.ts`、`agent-definitions*.test.ts`、`ingress-catalogue.test.ts`、`ingress-resources.test.ts`。

### 命令、退出码与日志

| 检查 | 命令 | exit | 日志 |
| --- | --- | --- | --- |
| 本题新 ingress 测试（5） | `node --test packages/gateway/test/ingress-resources-install.test.ts` | 0 | `.dev/verify/client-app-12/gateway-ingress-install.log` |
| client seam（8） | `node --test packages/session/test/execution-resources.test.ts` | 0 | `.dev/verify/client-app-12/session-execution-resources.log` |
| session 套件 | `node --test packages/session/test/*.test.ts` | 0 | `.dev/verify/client-app-12/session-suite.log` |
| 全部 ingress 回归（53） | `node --test packages/gateway/test/ingress*.test.ts` | 0 | `.dev/verify/client-app-12/gateway-ingress.log` |
| gateway 套件（330） | `node --test packages/gateway/test/*.test.ts` | 0 | `.dev/verify/client-app-12/gateway-suite.log` |
| server 套件（453） | `node --test apps/server/test/*.test.ts` | 0 | `.dev/verify/client-app-12/server-suite.log` |
| Web adapter + lib 套件（33） | `cd apps/web && node --test adapters/*.test.mjs lib/skill-inventory.test.mjs` | 0 | `.dev/verify/client-app-12/web-adapter-suite.log` |
| typecheck（session + gateway + server） | `pnpm --filter @hepi/session --filter @hepi/gateway --filter @hepi/server -r typecheck` | 0 | `.dev/verify/client-app-12/typecheck.log` |
| typecheck（web） | `cd apps/web && npx tsc --noEmit` | 0 | `.dev/verify/client-app-12/web-typecheck.log` |
| 既有 skills inventory race 浏览器回归 | `cd apps/web && node e2e/ux-skills-inventory-race.mjs` | 0 | `.dev/verify/client-app-12/web-skills-inventory-race.log` |
| 既有 skills project-target 浏览器回归 | `cd apps/web && node e2e/ux-skills-project-target.mjs` | 0 | `.dev/verify/client-app-12/web-skills-project-target.log` |
| 所选检查（合并票据 05 后） | `pnpm verify:changed --base=47ec8f0` | 1（`changed-typecheck`/`changed-test`/`web-unit` 均 0；`check-docs` 1 为既有 12 条 `.dev`/`.pi` 断链） | `.dev/verify/client-app-12/verify-changed.log` |
| 共享 UI 套件（116） | `cd packages/ui && node --test $(find src -name '*.test.mjs')` | 0 | `.dev/verify/client-app-12/ui-suite.log` |
| Web adapter + lib 套件 | `cd apps/web && node --test adapters/*.test.mjs ../../packages/ui/src/lib/skill-inventory.test.mjs ../../packages/ui/src/lib/agent-definitions.test.mjs` | 0 | `.dev/verify/client-app-12/web-unit.log` |
| typecheck（session/ui/gateway/server/web） | `npx tsc --noEmit` 各包 | 0 | `.dev/verify/client-app-12/typecheck-*.log` |
| 合并票据 05 后的浏览器回归 | `node e2e/ux-skills-inventory-race.mjs`、`node e2e/ux-skills-project-target.mjs` | 0 | `.dev/verify/client-app-12/web-skills-{inventory-race,project-target}.log` |
| 审查修复：选择生命周期单测（4） | `cd packages/ui && node --test src/lib/workbench-scope.test.mjs` | 0 | 见下「审查修复」 |
| 审查修复：delegate 迟到读浏览器回归 | `cd apps/web && node e2e/ux-delegate-definition-race.mjs` | 0 | `.dev/verify/client-app-12/web-delegate-definition-race.log` |
| 审查修复：全套复跑 | session / ui（120）/ gateway ingress（53）/ gateway（330）/ server（453）/ web adapter / typecheck（6 包）/ 三个浏览器回归 / `ux-workbench-scope.mjs` | 0 | `.dev/verify/client-app-12/*.log` |

一次中间跑法（gateway 与 server 套件并行）曾让 `models-config.test.ts` 的 "environment mode keeps credentials in memory" 失败；串行重跑为 453/453 通过，并在集成 tip 上单跑该用例也通过，因此记为并行跑法的资源竞争，不是本题引入的回归。

### 与 `integration/client-app` 合并后

集成 tip 已推进到 `19f5a54`（04 + 06 + 10），本题开工前与最终验证前各合并一次；最终一次合并后的树上重跑了上表全部检查，未复用任一侧结果（日志目录同上）。合并冲突只在两份双方都在追加的文档（`docs/migration-status.md`、`docs/verification.md`）与票据表的 status 列，无可执行文件冲突；票据 04 的 `spike/` 与票据 10 的 `packages/session/src/control.ts` 原样保留。

### 集成后复跑（`integration/client-app` `e5a9d18`，2026-10-18）

合并 `impl/client-app-12`（`3844bd5`）进 `integration/client-app`（`34e99da`，已含票据 05 host-I/O）。冲突只在
`packages/ui/src/client.ts` 一处，且是"双方各加一段"的冲突：本票的 `execution` scope 与票据 05 的 `request`/
`readJson` 并存，`request` 保留票据 05 的实现并被 `readJson` 复用；`ChatInput` 的两处 import 合并成一条，
draft-scope 守卫与 dormancy target 都保留；`docs/client-ingress.md` 两侧段落并存。下表全部在合并后的树上重跑，
未复用任一侧结果。

| 检查 | 命令 | exit | 日志 |
| --- | --- | --- | --- |
| 本题 ingress 测试（5） | `node --test packages/gateway/test/ingress-resources-install.test.ts` | 0 | `.dev/verify/client-app-12-integration/gateway-ingress-install.log` |
| client seam | `cd packages/session && node --test test/execution-resources.test.ts` | 0 | `.dev/verify/client-app-12-integration/session-execution-resources.log` |
| session 套件（48） | `cd packages/session && node --test test/*.test.ts` | 0 | `.dev/verify/client-app-12-integration/session-suite.log` |
| 全部 ingress 回归（53） | `node --test packages/gateway/test/ingress*.test.ts` | 0 | `.dev/verify/client-app-12-integration/gateway-ingress.log` |
| gateway 套件（330） | `node --test packages/gateway/test/*.test.ts` | 0 | `.dev/verify/client-app-12-integration/gateway-suite.log` |
| server 套件（453） | `node --test apps/server/test/*.test.ts` | 0 | `.dev/verify/client-app-12-integration/server-suite.log` |
| 共享 UI 套件（124，含 `workbench-scope.test.mjs` 4 例） | `cd packages/ui && node --test $(find src -name '*.test.mjs' \| sort)` | 0 | `.dev/verify/client-app-12-integration/ui-suite.log` |
| Web adapter + 共享 lib 套件（37） | `cd apps/web && node --test adapters/*.test.mjs ../../packages/ui/src/lib/skill-inventory.test.mjs ../../packages/ui/src/lib/agent-definitions.test.mjs` | 0 | `.dev/verify/client-app-12-integration/web-unit.log` |
| App 宿主配置（3） | `node --test apps/app/test/*.test.mjs` | 0 | `.dev/verify/client-app-12-integration/app-host-config.log` |
| typecheck（ui / session / gateway / server） | `pnpm --filter @hepi/<pkg> typecheck` | 0 / 0 / 0 / 0 | `.dev/verify/client-app-12-integration/typecheck-{ui,session,gateway,server}.log` |
| typecheck（web） | `cd apps/web && npx tsc --noEmit` | 0 | `.dev/verify/client-app-12-integration/web-typecheck.log` |
| skills inventory race 浏览器回归 | `cd apps/web && node e2e/ux-skills-inventory-race.mjs` | 0 | `.dev/verify/client-app-12-integration/web-skills-inventory-race.log` |
| skills project-target 浏览器回归 | `cd apps/web && node e2e/ux-skills-project-target.mjs` | 0 | `.dev/verify/client-app-12-integration/web-skills-project-target.log` |
| delegate 迟到读浏览器回归 | `cd apps/web && node e2e/ux-delegate-definition-race.mjs` | 0 | `.dev/verify/client-app-12-integration/web-delegate-definition-race.log` |
| 连接作用域浏览器回归（票据 05） | `cd apps/web && node e2e/ux-workbench-scope.mjs` | 0 | `.dev/verify/client-app-12-integration/web-workbench-scope.log` |
| 所选检查 | `pnpm verify:changed --base=34e99da` | 1 | `.dev/verify/2026-10-18T01-00-03-507-verify-changed/` |

`verify:changed` 的 `verify.json` 记录 `sha: e5a9d18…`、`dirty: true`（唯一脏项是未跟踪的 `.serena/`）；各步
exit：`workspace-typecheck` 0、`workspace-tests` 0、`web-unit` 0（42）、`script-tests` 0（51）、
`check-entrypoints` 0、`check-docs` 1。`check-docs` 的 1 是仓库既有的 12 条 `.dev`/`.pi` 断链（
`.scratch/architecture-unification`、`.scratch/design-fixes`、`.scratch/development-audit` 三处历史文档指向
git-ignored 路径），不是本题引入。

### 未声明

- 共享 React UI（票据 05）落地后已由本票补做接入（见上）：面板经连接读宿主，两个浏览器回归用 esbuild 挂载 production `SkillsConfig`，因此它们证明的是共享组件本身的行为，而不是旧 Next 入口。
- 未在真实 Tauri/移动目标上验证这些操作（票据 04 的 Android 仍缺 SDK）。
- 依赖 Next 生产构建的两个浏览器 smoke 在本题树上无法运行：`apps/server/scripts/skills-ui-smoke.ts --mode builtin`（install feedback）与 `apps/web/e2e/ux-subagent-delegate.mjs`（agent definitions journey）都要求 `apps/web/.next/BUILD_ID`，而票据 05 之后 Web 用 `vite build` 且没有 Next 构建脚本。这两条路径的 install feedback 与 agent definitions 行为由 `packages/gateway/test/ingress-resources-install.test.ts`（真 ingress + 真 gateway + 真 SSH helper）与 `packages/ui`/`apps/web` 单元套件覆盖；本票记录为未跑，不声明通过。
- 未新增"研究第二部分"的产品功能：没有删除已安装 skill、没有备份恢复、没有新的仓库源，也没有第二个 market 界面。`docs/execution-side-installation.md` 记录的既有界限（备份保留但不列出/恢复/删除）保持不变。

### 审查修复（reviewer 222，2026-10-18，本分支 63ba406 之后）

四条复现的问题与修法，均修在拥有该选择的抽象上（`useExecutionTarget` 的生命周期与"这次读是否仍属于屏幕上的 target"），没有引入全局请求计数器：

1. **P1 迟到读清掉了 loading 并暴露旧库存。** 读 A 属于 alpha，选 beta 后 A 先于 B 返回：A 的 `finally` 把 `loading` 置 false，屏幕上短暂显示 alpha 的库存/空态。现在 `loadSkills` 的**每个**完成点（答案、失败、结束 loading）都经 `useTargetFence` 判定是否仍属于当前 target；不匹配就什么都不写。切换 selection 时同时清空 `inventory`/`error` 并进入 loading，不再把上一个宿主的列表留在屏幕上。回归：`ux-skills-inventory-race.mjs` 现在把每次 inventory 读都扣住，先让旧宿主的答案在选中宿主仍在 loading 时到达（断言 loading 未被结束、未发布旧库存），再让选中宿主作答，最后再放一次旧宿主（该 entry 的 promise 已 settle，第二次 release 不产生新的到达）。即提交的浏览器用例独立驱动的是**旧宿主先答**这一序；"旧宿主后答"这一序在评审时的开发构建里被驱动过，提交的 production 构建用例不再单独构造它。把修复回退后该用例 FAIL（"the previous host's answer did not end the selected host's loading state: \"No skills found\""），修复后 PASS。
2. **P2 Project add pane 没有 target。** 选中 folder 属于某 Project 时，写目标是项目自己的默认 folder（beta），与侧栏显示的 alpha 不同，于是 `target` 为 null，安装直接以 "No execution workspace is configured" 失败、零 POST。现在 add pane 用 `useExecutionTarget` 为**它实际写入的** workspace 取 target（仅在该 pane 打开且写目标不同于当前选中时），并把 workspace 标签与 conversation 判定也指向同一 folder。回归：`ux-skills-project-target.mjs` 新增 add-pane 安装断言（`POST /api/skill-market/install` 的 `workspaceId=beta`、`scope=workspace`、无 conversation）；回退修复后该断言超时失败，修复后 PASS。
3. **P2 StrictMode 复用已 dispose 的 memoized target。** `useMemo` 的实例在 effect cleanup 被 dispose 后仍被 replay 复用，之后每次读都是 `disposed`。现在 target 由 effect 创建、存于 state，cleanup 同时 dispose 并清空；replay 得到新 target，真卸载仍回收旧 target，两个 selection 之间的一帧返回 null 而不是上一个 folder 的 target。回归：新增 `packages/ui/src/lib/workbench-scope.test.mjs`（4 个用例，用真实 hook + React 替身模拟 StrictMode replay），并把 `ux-skills-inventory-race` fixture 改为 StrictMode 挂载。StrictMode replay 本身**不由浏览器用例证明**：fixture 以 `process.env.NODE_ENV="production"` 打包，production React 不双调用 effect，所以那 4 个用例与评审时的开发构建 React 检查才是这条修复的证据；浏览器用例证明的是"选中的 target 活着并持续被读"这一可观察后果。
4. **P2 Quick delegate 迟到读覆盖新 folder 并隐藏选择器。** 旧 target 的定义读返回 `disposed` 后被当作错误写进 `loadError`，selector 被错误文案替换。现在读的每个完成点同样经 `useTargetFence` 判定，`AgentsConfig` 的同类读也一并加上（同一抽象、同一失败面）。回归：新增 `apps/web/e2e/ux-delegate-definition-race.mjs`（真 Chromium + production `QuickDelegatePanel`）；回退修复后 3 条断言 FAIL（错误出现、selector 消失、列表被清空），修复后 PASS。

未改动的既有语义：seam 的 API（`select`/`dispose`/各操作的参数与返回）、Backend 路由与宿主侧合同、拒绝词汇、provenance 字段名。`useTargetFence` 是新增的共享 hook，只有"这次读是否仍属于屏幕上的 target"一个判断。

### 记录项（非阻塞）

1. `apps/web/adapters/skill-market.ts` 仍是纯转发（不带 host）。票据 05 已把 Web 构建改为 Vite SPA（`apps/web/package.json` 的 `build` 是 `vite build`，没有 Next 构建脚本），因此 `apps/web/adapters/*` 与 `apps/web/app/api/[...path]` 已不在生产路径上；它们随票据 17 的文件删除一并退役，本票只删掉了其中已无调用者的 `PATCH /api/skills` 分支。`/api/agent-definitions` 代理保留并接受两种 workspace 拼写，避免它成为"不接受新命名"的陷阱。
2. `workspaceOwnerOf`（唯一为填 `hostId` 而读 listing 的导出）随 `agent-definitions.ts` 的改动失去唯一调用者并已删除；`readPathMetadata` 仍被路径解析使用，保留。
