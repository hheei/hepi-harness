# 跨主机路由：浏览器 → Web 主机服务 vs 持久后端 → 执行主机

范围：master `1758c1fb4479e9d4637a957857246c5998619d73` + 工作区未提交改动。只读分析，无产品改动、无图重建、无部署、无构建；无性能探针，性能结论均为源码推断，不含实测数字。未创建 `.dev/architecture-routes/cross-host/`。

**修订说明（source verification 后）**：更正 (1) 凭据所有权表；(2) 撤回原 F2（误报）；(3) 更正 F1 的实际链路，并将其定性为**既有已文档化能力缺口上的误导性控件**，而非新的安全或架构缺陷。并新增 import 图可达性核对作为这些更正的方法。

## 1. 架构路线（三条不重叠的路径）

```
浏览器
 ├─(A) 会话/生命周期/扩展/技能市场/技能安装/工作台文件/终端 ─→ Web 进程 (apps/web) ─→ 持久后端 (apps/server) ─→ 执行主机网关 (packages/gateway, 本机或 SSH)
 ├─(B) MCP 配置/测试/登录/登出 + project-trust 读 ────────────→ Web 进程 ─────────────→ 固定 Web 主机网关 POST /v1/mcp（不经后端）
 └─(C) 技能 toggle (PATCH /api/skills) ─────────────────────→ 后端 install 能力 ────→ 由 workspace 绑定解析出的执行主机
```

路线 (B) 的关键事实：MCP 主机服务由 `HEPI_WEB_GATEWAY_URL`/`HEPI_WEB_GATEWAY_TOKEN` 固定指向“本 Web 来源所在机器上的网关”，凭据属于 Web 进程，绝不交给后端。

## 2. 主机/身份/凭据所有权表（更正）

| 事物 | 所有者 | 解析/入口（源码确认） | 凭据种类 |
| --- | --- | --- | --- |
| Web 会话 cookie | 浏览器 origin | `route.ts:15,16,33`：`validWebToken(body.token, HEPI_AUTH_TOKEN)`，cookie 值即调用方送来的那个 token；L12 origin 校验，httpOnly + sameSite strict | **可与后端 bearer 复用同一个 `HEPI_AUTH_TOKEN`**；不同传输与作用域，不是两套秘密 |
| Web → 后端调用 | Web 进程 | `durable-api.ts:48-58` `authorization: Bearer ${HEPI_AUTH_TOKEN}` | 同一个 `HEPI_AUTH_TOKEN` |
| provider 凭据 | 后端进程 | Pi 模式：`pi-config.ts:44,147` 以 `authPath: agentDir/auth.json` 建 runtime（**确实读 auth.json**）；env 模式：`model-config.ts:237` 内存 store，仅当 `main.ts:54` 无 `piConfig` 时选用；`model-config.ts:191` 只是保存前校验的 throwaway probe（`allowModelNetwork:false`、不服务） | provider 凭据族，后端所有，永不经过浏览器 |
| MCP 配置 + OAuth 状态 | Web 主机服务（本机网关） | `mcp/host.ts:302` `McpHostService`；`mcp/config.ts:16-32`（`agentDirOf(home)/mcp.json`、`mcp-auth.json`） | MCP 凭据族，主机账户 |
| Web → 主机调用 | Web 进程 | `adapters/mcp-host.ts:29-30` `HEPI_WEB_GATEWAY_URL` / `HEPI_WEB_GATEWAY_TOKEN` | 网关凭据族，独立于后端 token |
| project trust 决策 | 执行主机账户 `trust.json` | 读 `mcp/config.ts:225` `readProjectTrust`；写：仅 pi CLI | — |
| 技能安装目录 | 执行主机，经后端安装能力 | `apps/server/src/skill-install.ts:338` `target()` → workspace 绑定 | 后端凭据 |
| 工作区根 + 所属网关 | 后端（`/api/workspaces`、`/api/projects`） | `durable-api.ts:277,213,450` | — |

三个凭据族：后端 `HEPI_AUTH_TOKEN`（Web cookie 与后端 bearer 共用一个值）、网关 `HEPI_WEB_GATEWAY_TOKEN`、以及 provider 与 MCP OAuth 两组（分别属于后端进程与主机账户）。无跨族旁路。“哪台主机”有两个刻意不同的答案：路线 (B) 用 Web origin 自己的网关 id，路线 (C) 用后端记录的 workspace→gateway 绑定。

## 3. Interface 契约与不变量

`hostCwdOf(cwd): {kind:"folder",path} | {kind:"unbound"} | {kind:"refused"}`（`durable-api.ts:341`）是 MCP 与 project-trust 共用的唯一 Seam：
1. **先解析后判断**：`resolveLocation`（:303）只用权威列表（workspaces + projects + roots），不从路径形状猜；`routingPathForRoot`（`lib/project-routing.ts:94`）按规范化 root 比较。
2. **身份需“名字 + 种类”同时成立**：`isThisWebHost`（:389）要求 owner === `HEPI_WEB_LOCAL_GATEWAY_ID` 且该网关 `profiles` 长度为 0；SSH profile 网关（`workspaces.ts:112` `remote-<profile>`）与“读不到 target”都被拒绝。
3. **拒绝先于调用**：`refused` 在 `mcp-surface.ts:311` `folderOf` 直接 403 `cwd-denied`。这是 `.scratch/design-fixes/results.md` 记录的外主机修复，**非新发现**。
4. **global 范围不需要文件夹**：`cwd === null` 时 `folder` 为 undefined，主机收到不带 cwd 的请求。
5. **路由地址 ≠ 显示路径**：`/workspace/<id>` 是地址，`displayRoot` 是用户可见路径；多文件夹项目下每个文件夹各有自己的 `.pi/mcp.json` 与信任决策（`mcp-surface.test.mjs:404+`）。
6. **写门禁在主机侧**：`mcp/config.ts:240-246` `projectTrustRefusal` 用主机自己的 trust store 拒绝 `project-untrusted`，Web 判断错也只失败、不误写。

## 4. 优势（设计层面）

- **深模块**：`hostCwdOf` + `resolveLocation` 用 3 种结果的接口承载 workspace/project/retained/legacy-root/多文件夹/SSH profile 的全部知识；MCP 的 read/write/patch/test/sign-in 与 project-trust 读共享同一次判断。删除测试成立：删掉解析模块，复杂度会散回 MCP、cwd 校验、worktree 三处。
- **凭据族之间结构性隔离**：后端不实现 `/v1/mcp`，SSH 网关构造时 `mcp` 为 undefined（`gateway/src/main.ts:77`、`client/src/gateway.ts:58`），故“把 MCP 凭据交给后端”没有代码路径；主机服务显式不读 `PI_CODING_AGENT_DIR`（`mcp/config.ts:12-14`）。注意后端 token 在 Web cookie 与后端 bearer 之间是复用同一秘密，这是**有意的同族复用**（同一次部署、同一 operator 秘密），不是漏洞。
- **拒绝语义诚实**：`mcp_unavailable`/`mcp_unreachable` 映射 503 并携带原文（`mcp-surface.ts:108-113`）；`isThisWebHost` 区分 `null`（问不到）与 `0`（问了，没有）。
- **固定外主机解析器**：`durable-api.ts:341-360` 注释明确“读另一台机器的 mcp.json 是错文件，不是降级答案”。

## 5. Findings

### F1（既有已文档化能力缺口 + 误导性控件；非新缺陷）对话框的 Trust 按钮 POST 到未实现路由，失败文案未指向主机 CLI

> **定性**：这不是新发现的安全/架构缺陷。`POST /api/project-trust` 未实现是**已经记录在案的能力缺口**（见下方“这是已记录的能力缺口”一条，含 e2e 与两份文档的引用），设计上把信任决策留给拥有该文件夹的主机上的 `pi` CLI。真正残留的只是一个**仍然误导用户的控件**：横幅路径打开的对话框继续渲染主按钮、指向未实现路由，失败文案为通用文案 + 英文诊断，未指向主机 CLI。

- **触发**：项目含 `.pi/mcp.json` 或 `.pi/extensions` 且未信任 → 点 restricted-mode 横幅 → ProjectTrustDialog → 点主按钮 `trust.trustProject`（"Trust project…"，`en.ts:732`）。
- **实际链路**：`AppShell.tsx:1406-1410` POST `/api/project-trust`（body `{cwd}`）→ `route.ts:42` 只匹配 `request.method === "GET"` → L43 `durableApi(request, parts)`；`durable-api.ts` 中**无** project-trust 分支（grep 无匹配）→ L837 `unsupported("This capability is not connected to the durable server yet")` → **501** `{error, code:"unsupported", accepted:false}`（`durable-api.ts:171`）。`projectTrustApi` 对非 GET 的 405（`mcp-surface.ts:589`）在浏览器路径上**不可达**，只有单测直接调用它（`mcp-surface.test.mjs:397-399`）。
- **UI 呈现**：`AppShell.tsx:1411-1413` 只把 `{error}` 交给 `ProjectTrustFailure`，`reason` 缺失 → `ProjectTrustDialog.tsx:290-295` `translated=false` → 渲染 `t("trust.trustFailed")`（"Could not trust this project."，`en.ts:748`）并在 `<code>` 里附上英文 501 诊断。**不是 `mcp.reason.invalid-request`，也不是 405。**
- **这是已记录的能力缺口，不是新缺陷**：`e2e/ux-workspace-routing.mjs:347-349` 明确写 “`/api/project-trust` is excluded from the refusal assertion on purpose: the durable adapter does not implement it for ANY cwd — a workspace cwd gets the same 501 — so it is a recorded capability gap”；`docs/split-deployment-verification.md:56` 记 501。设计意图（记录决策属于拥有该文件夹的主机上的 `pi` CLI）见 `docs/mcp-on-the-web-host.md:153,161`、`docs/migration-status.md:312`。`GET` 只读契约被 `route.ts:42` 与单测共同钉住，是**有意设计且正确**。
- **残留之处**：Settings › MCP 已刻意不传 `onTrustProject`（`SettingsPanel.tsx:562-565`）并改显示 `mcp.trust.recordOnHost`（`en.ts:879`），但同一个对话框从横幅打开时仍渲染主按钮、POST 到未实现路由，失败信息是通用文案 + 英文诊断，未说明“在主机上用 `pi` 记录”。另有 live 代码注释仍引用不存在的 `POST /api/project-trust`（`mcp-config-helpers.ts:407,428`、`McpConfig.test.mjs:354`）。
- **可能性**：只要存在需要信任的项目并走横幅路径就必然发生。
- **证据等级**：源码（route 分派 + durableApi 兜底 + 渲染分支）+ 既有单测 + e2e 注释；`mcp-surface.test.mjs` + `host-cwd-ownership.test.mjs` 17/17 通过（命令/修订/dirty/退出码/原始日志见 §7 与 `.dev/architecture-routes/cross-host/focused-tests.log`）。未跑浏览器复现。
- **分类**：**既有已文档化能力缺口** + UI 误导性控件（调用者逻辑残留）。**不是新的安全或架构缺陷**：接口结果本身不缺，读-only 且记录在主机 CLI 是有意、正确且已文档化的设计；缺口已由 e2e 注释与两份文档显式记录。可改的只是控件与文案。
- **归属 Seam**：`ProjectTrustDialog` footer / `AppShell.handleTrustProject`；以及 live 注释。
- **处置**：`record`（本任务不改产品代码）。重访条件：产品决定提供 UI 内记录信任，或该路径在实际使用中造成困扰。

### F2（已撤回：误报）不存在第二个活动 trust 读取器
- **原假设**：Web 进程的 `lib/project-trust.ts` / `lib/mcp-config-read.ts` 与主机侧构成两份可能分裂的 trust 读取器。
- **实际追踪**：活动路径只有一条 —— `projectTrustApi`（`mcp-surface.ts:588`）→ `hostCall({operation:"read"})`（L595）与 `hostCall({operation:"trust", cwd})`（L599）→ `callMcpHost`（`adapters/mcp-host.ts:35`）→ 网关 `/v1/mcp` → `McpHostService.execute` 的 `case "trust"`（`mcp/host.ts:315-316`）→ `readProjectTrust(request.cwd, this.#agentDir)`（主机账户 agentDir）。**Web 侧不读 trust.json**。
- **可达性核对**（apps/web 内 app/components/hooks/adapters/lib 的静态 import 闭包，排除 vendor 与 `*.test.*`）：live = `adapters/mcp-host.ts`、`adapters/mcp-surface.ts`、`lib/mcp-{command,config-values,import,import-core,import-json,import-cli,import-links,secrets,server-display,tool-display}.ts`、`components/mcp-*-helpers.ts`；**dormant**（无活动调用者，只被测试或其他 dormant 模块引用）= `lib/project-trust.ts`、`lib/mcp-config-read.ts`、`lib/mcp-config-file.ts`、`lib/mcp-entry-request.ts`、`lib/mcp-host.ts`、`lib/builtin-extensions.ts`、`lib/mcp-read-only-policy.ts`、`lib/mcp-status.ts`、`lib/mcp-sign-in.ts`、`lib/mcp-sign-out.ts`、`lib/mcp-undo.ts`、`lib/mcp-transport.ts`、`lib/mcp-add.ts`、`lib/mcp-test.ts`、`lib/mcp-config-key.ts`、`lib/mcp-json-error.ts`。注意 `adapters/mcp-surface.ts:19` 引的是 `./mcp-host`（adapter，live），与 dormant 的 `lib/mcp-host.ts` 是两个不同文件；`mcp-surface.test.mjs:511` 断言 adapter 侧命名 `HEPI_WEB_GATEWAY_URL`。
- **结论**：无第二个活动 trust 所有者，不存在运行时分裂。原 F2 **撤回**，不计为 finding。
- **仅记一条 dormant 成本**：16 个保留的上游 pi-web 模块（含 SDK 内嵌 `McpHost`、read-only policy、OAuth sign-in/out、状态与 undo）仍在仓库与测试中但无活动接线。这是 copy-first 策略的已知状态（保留上游实现以便增量适配），不是缺陷。处置：`record`；重访条件是与上游同步或做退役清理时。

### F3（设计：每次 MCP/信任请求都做一次主机归属证明，无缓存）
- **触发**：打开 Settings › MCP 或切换会话（`AppShell.tsx:1381-1399` 的 effect 随 `projectTrustCwd` 重跑）。
- **证据**：`hostCwdOf` → `resolveLocation`（`listedWorkspaces` + `recordedProjects` + `workspaceRoots` 三次后端读）→ `isThisWebHost` → `gatewayProfiles()`（`durable-api.ts:365-385`）再读 `/api/hosts`；后端 `hostProfiles`（`apps/server/src/server.ts:950,1237`）**逐个**配置网关问 `profiles`。注释明确“nothing is cached”。
- **实际影响**：一次面板操作 = 4 次后端往返，其中一次扇出到 N 个网关（远端可能走 SSH）；复杂度 O(N 网关) 而非 O(1)。
- **证据等级**：源码推断（未实测）。
- **分类**：设计（正确性优先，代价明示）。**处置**：`record`。重访条件：实测面板明显卡顿，或 `/api/hosts` 成热点。

### F4（记录）global 范围不受本机证明约束
设了 `HEPI_WEB_GATEWAY_URL` 时，不带 cwd 的 global 读/写/测试/登录都会发往该服务，即使 `HEPI_WEB_LOCAL_GATEWAY_ID` 未设或指向别处。文档化行为（`docs/mcp-on-the-web-host.md` “Global operations … remain available”）；风险仅是 URL 配错指向他机。处置：`record`。

### F5（记录）`durable-api.ts` 体积与职责
同一文件承担会话投影、SSE 折叠、worktree、技能 toggle、扩展、终端与主机归属解析（约 900 行）。接口深，Locality 成本集中在单文件。设计观察，非缺陷。处置：`record`。

## 6. 性能（复杂度/预算，全部为推断）

| 路径 | 复杂度 | 依据 |
| --- | --- | --- |
| MCP/project-trust 一次操作 | 4 次后端读 + 1 次主机调用 + O(N网关) profiles 探测；Web→主机超时 60s | `durable-api.ts:303-360,365-385,450`；`server.ts:950`；`mcp-host.ts:26` |
| 会话切换触发的 trust 读 | 同上 | `AppShell.tsx:1386` |
| MCP test / sign-in | 主机侧 30s 端到端、15s/请求、5min 流程 TTL、`!command` 10s | `mcp/host.ts:80-91`（常量，非实测） |
| 凭据面 | 后端零 MCP 凭据；provider 凭据后端所有（Pi 模式读 agentDir `auth.json`，env 模式内存）；网关 token 只在 Web 进程 | `pi-config.ts:44,147`；`model-config.ts:237`；`adapters/mcp-host.ts:29` |

无实测数字；未创建探针目录，未跑基准。若量化 F3，可在 `.dev/architecture-routes/cross-host/` 用本地网关 + 两个配置网关记录 `/api/hosts` 往返次数与耗时。

## 7. 支撑测试

- 本次实跑（未重跑，日志从会话 trace 原样保留）：`cd apps/web && node --test adapters/mcp-surface.test.mjs adapters/host-cwd-ownership.test.mjs 2>&1 | tail -25`
  - 修订：`1758c1fb4479e9d4637a957857246c5998619d73`（master HEAD）；**dirty = true**（69 项，含 `apps/web/adapters/durable-api.ts` M、`mcp-surface.test.mjs` M、`host-cwd-ownership.test.mjs` ??）——工作区状态，非干净 checkout。
  - 退出码：**管道 0**（`result.details.exitCode`）。`tail` 是管道最后一环，该值只是 `tail` 的状态，说明管道未失败，**不代表 `node --test` 退出 0**；node 自身退出码被管道掩盖、**未知**（无 `set -o pipefail`）。判定依据是捕获输出里的 TAP 汇总 `pass 17` / `fail 0`。node 自报套件耗时 192.769489 ms，工具调用 233.53 ms。运行时刻 2026-10-14T13:59:15.941Z。
  - 原始日志：`.dev/architecture-routes/cross-host/focused-tests.log`（git-ignored，含 17 条 ✔；块内文本已与 trace 的 `result.details.output` 逐字节比对为相同——即证明**捕获到的管道输出**一致，不证明未加管道的原始 stdout 行数）。自运行以来 `apps/`、`packages/`、`docs/` 下无文件 mtime 晚于 21:59 +08:00（`find -newermt` 核验），故源码未变、结果可复用。
  - 结果：**17/17 通过**，依据是捕获输出中的 TAP 汇总（含外主机拒绝、多文件夹各自身份、405 只读契约、catch-all 分派不得把 MCP 发给后端的断言）。
  - 覆盖限制：显式两文件清单，**不是** `docs/agents/verification.md` 的递归 `find` 清单，故不覆盖 apps/web 内的嵌套套件；且 `tail -25` 之前的输出从未被捕获（`totalLines:25` 是 `tail` 之后的行数，`truncated:false` 只说明工具未截断它收到的那部分），无法据此声称原始 stdout 只有 25 行。
- 未重跑：`durable-api.test.mjs`、`project-removal.test.mjs`、`packages/gateway/test/mcp.test.ts`、`apps/server/test/ssh-resources.test.ts`、`resource-snapshot.test.ts`、`skill-install.test.ts`。
- 复用 `.scratch/design-fixes/results.md` 的 Host 回归 8/8、adapter 114/114。

## 8. 图导航证据与限制

| 问题 | 查询（默认图 `graphify-out/graph.json`，除非注明） | 结果与源码确认 |
| --- | --- | --- |
| MCP/信任的主机解析 | `graphify query "hostCwdOf" --budget 1000` | 26 节点；`hostCwdOf` `durable-api.ts:L341`，边 `hostCwdOf→resolveLocation`(L342)、`→isThisWebHost`(L345) 均 EXTRACTED；源码逐行确认 |
| 位置解析 | `query "resolveLocation"`、`query "resolveLocation" --context call` | 确认 :303 调用 listedWorkspaces/recordedProjects/workspaceRoots/workspaceIdOfRoutingPath |
| MCP 主机服务 | `query "McpHostService"` | `packages/gateway/src/mcp/host.ts:L302`，`execute` L310；`case "trust"` L315-316 源码确认 |
| 组合根 | `query "startGateway"` / `"GatewayRpcServer" --context call` | `packages/client/src/gateway.ts:L18`、`packages/gateway/src/index.ts:L479`；`/v1/mcp` 路由 L539,567 源码确认 |
| 深图语义层 | `query "MCP ownership" --graph graphify-deep/graphify-out/graph.json` | 只返回文档概念节点（`_origin: semantic`，`source_location: null`），**不作代码证据**，全部源码复核 |
| 深图解释 | `explain "hostCwdOf" --graph graphify-deep/...` | 度 5，与默认图一致；`handle()→hostCwdOf` 为 INFERRED indirect_call，`route.ts:40` 证实 |

**本次修订用的补充方法**：图查询只能给出“谁引用了谁”的弱信号，无法区分 live 与 dormant。因此对 F1/F2 与凭据表做了两项源码核对：(a) 在 apps/web 内做 app/components/hooks/adapters/lib 的静态 import 闭包（排除 vendor 与测试）以判定 live/dormant；(b) 逐行追 `route.ts` 的分派与 `durableApi` 的兜底分支，确定 POST 的真实落点。原报告的 F1（405/invalid-request）与 F2、以及“auth.json 不读/凭据仅内存”的表项均因缺少 (a)/(b) 而错误。

限制：默认图为 AST 层且含自身 INFERRED 启发边；工作区有未提交改动，行号一律以源码为准（本报告行号均来自源码读取）；图不证明 HTTP/SSE 运行期契约；未重建图（避免并发）。
