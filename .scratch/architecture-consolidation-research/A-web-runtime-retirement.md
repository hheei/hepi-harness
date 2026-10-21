
# A. Web 本地运行时/MCP/provider/session 助手退役与上游重复副本

基线：`caf6a319177554f3fcc53e6a4efc6683a1a3e433`（工作区仅 `?? .scratch/architecture-consolidation-research/` 未跟踪）。仅研究，无产品改动、无图重建、无构建、无部署。临时探针位于 `.dev/architecture-consolidation-research/`（git-ignored）。

## 0. 方法与证据边界（先说清局限）

静态 import 闭包（正则提取 + 显式路径解析），入口 = Next 入口根 `app/**/(route|page|layout|default|instrumentation|middleware|proxy)`，解析结果 **3 个入口**：`app/page.tsx`、`app/layout.tsx`、`app/api/[...path]/route.ts`。

入口清单与 `apps/web/.next/server/app-paths-manifest.json`（`/`、`/api/[...path]`、`/_not-found`、`/_global-error`）的**形状**一致，但**该构建产物与当前提交的源码不匹配**：`.next` 的 mtime 是 `2026-10-15 09:12`（`BUILD_ID YMKNIkwIVaRyvrfGOr5CL`），而其后唯一的提交 `caf6a319`（`2026-10-15T12:57:56+08:00`）**恰好改了本报告的核心文件**（`apps/web/adapters/mcp-surface.ts`、`apps/web/lib/mcp-*.ts`、`apps/web/components/McpConfig.tsx`；`git log -1 -- <path>` 全指向 `caf6a31`）。`.next/trace-build` 只记阶段耗时（`run-webpack`/`run-typescript`/`static-check`），**不含源文件哈希或修订号**，无法把 `.next` 绑定到任何 revision。→ 所有 `.next` 观察一律**降级为弱旁证**（"某个更早的源码状态曾如此打包"），**不构成对当前闭包的证明**。

三档可达性，分别计算：

| 档 | 含义 | 非测试文件数 |
| --- | --- | --- |
| runtime | 仅 value/side-effect/dynamic/require import | 196 / 299 |
| type-only | 另加被 import type / {type X} 引到（编译期擦除） | +16 → 212 |
| neither | 两者皆不可达 | 87 |

**局限（明确标注为不完整）**：纯静态，不读 bundler/trace；正则解析而非 AST；未跑 webpack/Turbopack；无运行期探针。两项辅助检查效力不同：

(a) **构建产物 grep —— 弱旁证，不是证明**。`.next` 由早于当前源码状态的构建生成（见上：`09:12` vs `caf6a31` 12:57），**未与任何修订或源文件哈希绑定**。在此前提下：`MCP_HOST_EXTENSION_NAME`、`pi-web-mcp-host`、`readMcpOverview`、`createTestRedactor`、`readMcpServerConfigs`、`callMcpHost`、`McpHost` 在 `.next` 中 **0 命中**，`fillMcpImportFields`/`parseMcpImport`/`mcp_unavailable` 有命中。这只说明**某个更早的源码状态曾如此打包**，**不能证明当前 `caf6a319` 的 bundle 闭包**。要成为证明需在 `caf6a319` 上重新构建并比对产物哈希（本次未做：仓库规则禁止在 `remote-host` 构建，本次是只读研究，未触发构建）。

(b) **全仓动态 import 扫描 —— 对当前源码有效**（不依赖构建产物）：`apps/web` 内只有 `hooks/useAgentSession.ts:1096`（`@/lib/tool-presets`，live）与 `components/MermaidBlock.tsx:54`（`mermaid`）两处 `import()`，均不在退役集内。故**就当前源码而言，静态闭包未被动态加载绕过**；不可外推（`.next` 里的 server chunk 未逐字节核对）。

## 1. Verdict

**既有 dormant debt，不是生产缺陷，也不是未交付特性。** 生产路径只有一条：`app/api/[...path]/route.ts:2` → `adapters/mcp-surface.ts:329` (`mcpSurfaceApi`) / `:588` (`projectTrustApi`) → `adapters/mcp-host.ts:35` (`callMcpHost`) → 网关 `POST /v1/mcp`（`packages/gateway/src/mcp/host.ts:302` `McpHostService`）。**父级结论（生产路由 → adapter HTTP，而非 lib McpHost）经源码复核成立**：`adapters/mcp-surface.ts:19` 引的是 `./mcp-host`（adapter），与 `lib/mcp-host.ts` 是两个不同文件。

更正/补充既有记录：`docs/upstream-sources.md:205-224` 记 185/281 可达、96 dormant，方法（`/tmp/hepi-web-dormant.mjs`）与本次一致但样本不同（本次纳入 `public/`、`lib/__fixtures__/`、`.cjs`）。本次结论：**87 个非测试文件既非 runtime 也非 type-only 可达**，其中 76 个可退役（见 §5）。

- **真实调用者**：`lib/` 下 MCP 运行时（`mcp-host.ts` / `mcp-config-read.ts` / `mcp-test.ts` / `builtin-extensions.ts` 等）**无任何 live 调用者**；仅被彼此（同为 dormant）与 `apps/web/vendor/pi-web/**`（快照，不在 include/import 图内）引用。
- **触发/影响**：今天无用户可见故障。成本是（i）**所有权重复**：仓库里有两个 MCP host 实现（`apps/web/lib/mcp-host.ts:1013` `McpHost` vs `packages/gateway/src/mcp/host.ts:302` `McpHostService`）、两个 trust 读取器、两个 `mcp.json` 读取器；（ii）**盲区（限定范围）**：TypeScript **沿 import 传递**，所以 `tsconfig.json` 的 `include` **并不**排除被 live 代码 import 的 `lib/**` 文件——它们仍被检查（实测 typecheck 闭包 232 文件，含大量 live `lib/` 文件）。真正的盲区是**无人 import 的 `lib/**` 文件**：`include` 未列 `lib/**/*.ts`，这类文件既不在根集内、也不被任何根可达，因此**从不被检查**（这正是 87 个 dormant 文件"连悬空 import 都没人发现"的原因）。**不能**由此推断"所有 `lib/` 都没有检查"；（iii）**8 个文件连 import 都跑不通**（悬空 `./model-runtime`，见 §3）。
- **分类**：dormant debt（主要）+ 一处真实所有权重复（MCP host/config 双实现，且重复副本已被网关实现取代）。

## 2. 当前所有权与数据流

   浏览器 → Web 进程 (apps/web)
     ├─ /api/mcp, GET /api/project-trust → adapters/mcp-surface.ts (聚合/映射/拒绝语义)
     │      → adapters/mcp-host.ts (HEPI_WEB_GATEWAY_URL/TOKEN, POST /v1/mcp, 60s 超时)
     │      → 网关 packages/gateway/src/mcp/{host,config,secrets,mcp-secrets}.ts（真正的 MCP 所有者）
     ├─ 其余 → adapters/durable-api.ts → 持久后端
     └─ lib/**：UI 纯助手（196 live）+ 87 dormant

依赖分类（codebase-design 词汇）：
- **in-process**：`lib/mcp-import*.ts`、`lib/mcp-secrets.ts`、`lib/mcp-server-display.ts`、`lib/mcp-tool-display.ts`、`lib/mcp-command.ts`、`lib/mcp-config-values.ts` —— 这些是 **live**（`adapters/mcp-surface.ts:18`、`components/McpAddServer.tsx`、`components/McpConfig.tsx`、`components/mcp-add-helpers.ts`、`components/MessageView.tsx`、`components/ChatInput.tsx`），**必须保留**。
- **local-substitutable（已被网关取代）**：`lib/mcp-config-read.ts`、`lib/mcp-config-file.ts`、`lib/mcp-test.ts`、`lib/mcp-sign-in.ts`、`lib/mcp-sign-out.ts`、`lib/mcp-status.ts`、`lib/mcp-transport.ts`、`lib/builtin-extensions.ts`、`lib/project-trust.ts`、`lib/pi-sdk-internals.ts` 等 → 对应 `packages/gateway/src/mcp/*`。
- **remote-owned**：MCP 配置/OAuth/trust 属于 Web 主机账户（`docs/mcp-on-the-web-host.md:12-24`）。
- **true external**：无（`lib/web-push.ts` 会调推送服务但无调用者）。

## 3. 关键证据（可复核）

1. **悬空 import，8 个文件无法被加载**（`lib/mcp-test.ts:16` `import { createModelRuntimeWithExtensions } from "./model-runtime"`，而 `apps/web/lib/model-runtime.ts` 不存在，只在 `vendor/pi-web/lib/model-runtime.ts`）：`lib/mcp-test.ts`、`lib/mcp-host.ts`、`lib/mcp-config-read.ts`、`lib/mcp-config-file.ts`、`lib/mcp-entry-request.ts`、`lib/builtin-extensions.ts`、`lib/mcp-sign-in.ts`，另 `lib/model-catalog-refresh.ts:2`（`@/lib/model-runtime`）。与 `.scratch/web-test-consolidation/known-failures.md`、`.scratch/development-audit/fixes-web-tests.md:47-55` 记录一致。
2. **生产产物无痕迹（弱旁证，见 §0(a)）**：`.next` 与当前源码不匹配、无哈希绑定，只能说明"更早的构建里如此"。其中 `callMcpHost` 0 命中（或为内联/改名），`mcp_unavailable` 3 命中、`fillMcpImportFields` 4 命中，与 §1 的源码结论**方向一致**，但**不作为闭包证明**。
3. **local 测试清单（`scripts/lib/discovery.mjs:55`，`apps/web` 下递归 `*.test.mjs`）共 64 个文件**，与 `docs/verification.md:9`（64 文件/111 测试）一致。其中 8 个文件触达 dormant 代码（见 §5.2）。
4. **字节级重复（对 76 个删除候选逐一 md5 比对，`.dev/architecture-consolidation-research/vendor-final-A.mjs`）**：
   - **72 个（11,780 行）与 `apps/web/vendor/pi-web/` 中的副本逐字节相同**；
   - **3 个（990 行）是本仓对上游的有意改写**，与 vendor 副本不同：`lib/mcp-config-read.ts`、`lib/project-trust.ts`、`lib/tool-result-images.ts`；
   - **1 个（62 行）无任何 vendor 副本**：`hooks/__fixtures__/react-hook-shim.mjs`（`vendor/pi-web/` 无 `hooks/` 目录）。

   72 + 3 + 1 = 76，与删除集总数一致。
   - `lib/mcp-config-read.ts` 相对上游**删掉了** `freshFolderTrustBreadth` / `hasTrustRelevantEntries` / `trustFolder` 的写入路径；`lib/project-trust.ts` **删掉了** `trustProject()`；`lib/tool-result-images.ts`（2 行）改为 `export { ... } from "@hepi/protocol"`。三者都是**本仓的有意删减**，能力已在 `packages/gateway/src/mcp/config.ts:222` `readProjectTrust` / `:240` `projectTrustRefusal` 与 `packages/protocol/src/index.ts:350` 落地。
5. **fixtures 三重冗余**：`apps/web/lib/__fixtures__/mcp-env-server.mjs`（md5 `365446e4…`）= `packages/gateway/test/fixtures/mcp/stdio-server.mjs` = `vendor/pi-web/lib/__fixtures__/mcp-env-server.mjs`；`mcp-oauth-server.mjs`（`ec3b1bf5…`）同；`mcp-hang-server.mjs`（`af7c77b8…`）在 vendor 有副本。上游测试引用的是 `vendor/pi-web/lib/__fixtures__/`（`vendor/pi-web/lib/mcp-test.test.mjs:36-37` 等），**不是** `lib/__fixtures__/`。
6. **16 个 type-only 文件**（`lib/api-types.ts`、`lib/types.ts`、`lib/subagents.ts`、`lib/enabled-models.ts`、`lib/model-catalog.ts`、`lib/model-discovery.ts`、`lib/pi-types.ts`、`lib/subagent-extension.ts`、`lib/subagent-input.ts`、`lib/subagent-settings.ts`、`lib/atomic-file.ts`、`lib/git-types.ts`、`lib/i18n/types.ts`、`lib/npm-source.ts`、`lib/path-security.ts`、`lib/paths.ts`）被 live 组件以 `import type` 引用（如 `components/AppShell.tsx:74`），**不是 dead，必须保留**（§5.3）。

## 4. 方案比较

**方案 1（推荐）：删除 76 个文件，`vendor/pi-web/` 作为唯一 provenance。**
- 保留策略已在本仓成立：`docs/upstream-sources.md:203-224`、`apps/web/README.md:23`、`vendor/pi-web/README.md`（记录 URL/修订 `76bdc570…`/MIT）。上游原样副本已在 `apps/web/vendor/pi-web/lib/`（377 文件），**删除 `lib/` 副本不减少任何上游信息**。
- 效果：`lib/` 从 239 个 `.ts/.tsx` 降到约 163；仓库 −12,832 行（实测）；`McpHost` 所有权唯一化到网关。
- 代价：`test:upstream` 不受影响（只跑 `components/ChatInput.test.mjs`、`components/MessageView.test.mjs`）；**本次删除集内不含任何测试文件**，故 64/111 基线数字不变（§7）。

**方案 2：迁到 `apps/web/vendor/pi-web-orphans/` 再删 `lib/` 原件。**
- 与方案 1 差别仅在于"是否让本地副本与上游副本分开存放"。既然 `vendor/pi-web/lib/` 已是逐字节上游快照，再建一个同源目录等于**同一事实的第二份真相**，正是本仓 `copy-first` 想避免的。**否决**。

**方案 3：原地保留 + 加守卫（tsconfig/lint 白名单）。**
- 只治盲区不治重复：两个 `McpHost` 仍在，读者仍需判断哪一个是所有者。且 `apps/web` **没有 eslint 配置文件**（`package.json:41` `\"lint\": \"eslint .\"`，`apps/web` 与仓库根都无 `eslint.config.*`），守卫落点不存在。**否决**（记录该 lint 断链为独立 finding）。

**为什么不需要更精巧的设计**：这是纯删除 + 依赖清理，不是抽象重构。没有第二个 adapter 需要共享，也没有可变性需要 seam（codebase-design: "One adapter means a hypothetical seam"）。`adapters/mcp-surface.ts` + `adapters/mcp-host.ts` + 网关 `McpHostService` 已是深模块（`callMcpHost` 一个函数 + 一个 `HostAnswer` 联合类型承载全部 MCP 操作），**不需要新 Interface**。

## 5. Keep / Delete / Move 表

### 5.1 DELETE（76 文件，12,832 行 — **实测**，`wc -l`）

全部满足：runtime 不可达 ∧ type-only 不可达 ∧ 无本地 `*.test.mjs` 依赖 ∧ 非 `next.config.ts`/tsconfig 引用。

> 子组编号 D1–D4 是**删除集内部的分组**，与任务级 A–F 无关（避免同名）。

**子组 D1 — MCP/settings 运行时（21 文件，6,385 行）** —— 被网关 `packages/gateway/src/mcp/*` 取代，或本就是上游 SDK 内嵌实现：
`lib/mcp-host.ts` (1087)、`lib/mcp-config-read.ts` (835)、`lib/mcp-test.ts` (705)、`lib/mcp-sign-in.ts` (692)、`lib/mcp-config-file.ts` (499)、`lib/builtin-extensions.ts` (394)、`lib/codemode-settings.ts` (395)、`lib/mcp-add.ts` (221)、`lib/mcp-entry-request.ts` (218)、`lib/mcp-status.ts` (217)、`lib/project-trust.ts` (153)、`lib/mcp-sign-out.ts` (124)、`lib/mcp-undo.ts` (105)、`lib/mcp-transport.ts` (102)、`lib/powershell-settings.ts` (99)、`lib/mcp-json-error.ts` (93)、`lib/global-settings-file.ts` (76)、`lib/mcp-config-key.ts` (69)、`lib/regular-file.ts` (61)、`lib/mcp-read-only-policy.ts` (53)、`lib/project-command-env.ts` (187)。

**子组 D2 — session/file 本地实现（22 文件，3,293 行）** —— 上游 Next 路由实现，本仓路由已换成 `adapters/durable-api.ts`：
`lib/session-reader.ts` (910)、`lib/session-list-scanner.ts` (458)、`lib/worktree.ts` (321)、`lib/session-title.ts` (315)、`lib/project-tree.ts` (239)、`lib/git-changes.ts` (233)、`lib/session-fork.ts` (114)、`lib/directory-browser.ts` (103)、`lib/session-list-scanner.bench.mjs` (82)、`lib/session-tool-selection.ts` (78)、`lib/perf.ts` (68)、`lib/json-response.ts` (57)、`lib/session-revision.ts` (52)、`lib/git-status.ts` (48)、`lib/session-timing.ts` (46)、`lib/file-access.ts` (46)、`lib/allowed-roots.ts` (32)、`lib/session-file-references.ts` (30)、`lib/project-identity.ts` (27)、`lib/default-cwd.ts` (20)、`lib/file-dirent.ts` (18)、`lib/session-path.ts` (12)、`lib/tool-result-images.ts` (2)。
> `lib/tool-result-images.ts` 是 2 行 re-export，`lib/session-reader.ts:13` 是唯一引用者，两者同删；live 侧 `adapters/durable-api.ts` 直接用 `@hepi/protocol`。

**子组 D3 — 无调用者的 provenance 助手（29 文件，2,812 行）** —— 无调用者，与已交付能力无关：
`lib/provider-usage.ts` (411)、`lib/enabled-models-runtime.ts` (256)、`lib/model-scope.ts` (217)、`lib/file-tree-visibility.ts` (158)、`lib/model-catalog-refresh.ts` (154)、`lib/linked-directory.ts` (124)、`lib/provider-listing.ts` (119)、`lib/provider-credential-store.ts` (115)、`lib/http-dispatcher.ts` (87)、`lib/web-auth.ts` (83)、`lib/model-discovery-auth.ts` (80)、`lib/open-in-file-manager.ts` (77)、`lib/subagent-queue.ts` (75)、`lib/subagent-skills.ts` (70)、`lib/deferred-provider-models.ts` (67)、`lib/node-cli.ts` (67)、`lib/default-preferences.ts` (65)、`lib/bash-output.ts` (54)、`lib/text-preview.ts` (50)、`lib/prompt-recovery.ts` (48)、`lib/provider-listing-runtime.ts` (38)、`lib/exact-system-prompt.ts` (33)、`lib/npx.ts` (32)、`lib/subagent-prompt.ts` (32)、`lib/app-update.ts` (29)、`lib/custom-ui-terminal.ts` (28)、`lib/chat-only.ts` (24)、`lib/web-push.ts` (201)。
> `lib/web-auth.ts` 是旧 `PI_WEB_PASSWORD` 体系（当前是 `HEPI_AUTH_TOKEN` + `hepi-web-token` cookie，`adapters/auth.ts:4` `validWebToken`）。

**子组 D4 — 测试 fixtures（4 文件，342 行）**：
`lib/__fixtures__/mcp-env-server.mjs` (123)、`lib/__fixtures__/mcp-oauth-server.mjs` (132)、`lib/__fixtures__/mcp-hang-server.mjs` (25) —— 与 `vendor/pi-web/lib/__fixtures__/` 及 `packages/gateway/test/fixtures/mcp/` 逐字节相同（§3.5）；
`hooks/__fixtures__/react-hook-shim.mjs` (62) —— **本仓自有**（非上游，vendor 无 `hooks/`），全仓 0 引用。

### 5.2 DEFER（**本次不删**；实现阶段作为"测试 + 实现"一并退役的候选）

这 8 个文件 dormant，且**仅**因为本地单元测试 import 它们而被排除在 §5.1 之外。"有测试"**不是**永久保留的建筑学理由，也**不是**为了让 111 这个数字不动：它们是**实现阶段要带着测试一起退役的候选**，唯一前置条件是**活跃契约核查**——先确认它们承载的行为已由 live 所有者提供（或已无人需要），再连测试一起删。

| 候选 | 行数 | 唯一依赖方（测试） | 活跃契约核查要点 |
| --- | --- | --- | --- |
| `lib/pi-sdk-internals.ts` | 445 | `lib/mcp-import.integration.test.mjs`（35 行，1 test） | 该测试断言"外部命令值解析为文本、不执行"——须确认该保证已由网关/`@earendil-works/pi-mcp` 侧覆盖，或该保证仍需要（live 侧 `lib/mcp-import.ts` 仍被 `adapters/mcp-surface.ts:18` 使用，但 `pi-sdk-internals` 只是它历史依赖） |
| `lib/request-security.ts` | 162 | `lib/request-security.test.mjs`（53 行，1 test） | 唯一 live 引用者 `lib/mcp-entry-request.ts:13`（**本身在 D1 删除集内**）→ 删除 D1 后成为完全无引用；须确认 `isApiRequestAllowed` 的 Origin/Content-Type 校验在 live 路由（`adapters/`、`route.ts`）无等价需求，或有等价实现 |
| `lib/agent-event-stream.ts` | 316 | `lib/agent-event-stream.test.mjs`（70 行，2 tests） | 上游 SSE 读取器；须确认 live 会话流由 `adapters/durable-api.ts` / `lib/agent-event-wire.ts` 承接（§3 已见 `agent-event-wire.ts` 为 live） |
| `lib/session-liveness.ts` | 200 | 仅 `lib/agent-event-stream.ts:6`（dormant） | 与 `agent-event-stream` 同生共死（非独立测试依赖） |
| `lib/auth-throttle.ts` | 103 | `lib/auth-throttle.test.mjs`（69 行，1 test） | 上游 `PI_WEB_PASSWORD` 体系的暴力破解退避；当前 Web 认证是 `HEPI_AUTH_TOKEN` 常量时间比较（`adapters/auth.ts`），**无密码尝试面**→ 契约大概率已消失，须确认 |
| `lib/session-file-references-core.ts` | 148 | `lib/session-file-references.test.mjs`（63 行，3 tests） | 会话文件引用解析；须确认 live 侧（`adapters/durable-api.ts` / `@hepi/protocol`）已承接 |
| `lib/key-serializer.ts` | 23 | `lib/key-serializer.test.mjs`（42 行，1 test） | 唯一 live 引用者 `lib/mcp-config-file.ts:6`（**在 D1 删除集内**）→ 删除 D1 后无引用 |
| `lib/login-destination.ts` | 18 | `lib/login-destination.test.mjs`（27 行，1 test） | 登录后跳转白名单（`safeLoginDestination`）；live 侧登录由 `app/api/[...path]/route.ts` 的 `durable-login` 处理，须确认 open-redirect 防护有等价实现，**否则这不是退役候选而是缺口** |

**实现阶段规则**：逐个做上表的活跃契约核查；契约已由 live 所有者承接 → **测试与实现一并退役**（随之更新 `docs/verification.md` 的 64/111 基线，**基线数字不是保留理由**）；契约仍需要 → 把该实现迁到 live 所有者旁，而不是留在 dormant `lib/`。

### 5.3 KEEP（**真正活跃或有硬性类型/构建依赖**——与 §5.2 的区别：这些的依赖方是产品代码或构建配置，不是测试）

| 文件 | 行数 | 依赖方 | 理由 |
| --- | --- | --- | --- |
| `public/sw.js` | 180 | `components/PwaRegistration.tsx:13`（运行期加载 `/sw.js`，静态扫描看不到）、`public/sw.test.mjs` | **live**：PWA service worker |
| `lib/next-compiled.d.ts` | 19 | `apps/web/tsconfig.json` `include` 显式列出；`lib/bounded-form-data.ts` import `next/dist/compiled/busboy` | 类型声明，构建硬依赖 |
| `lib/gfm-autolink-email-loader.cjs` | 38 | `next.config.ts:17`（webpack/Turbopack loader） | 构建期引用 |
| 16 个 type-only 文件 | 4,062 | live 组件的 `import type` | 见 §3.6 |
| 其余 live `lib/**`（196 个 runtime 可达文件，含 `lib/mcp-import*.ts` 等） | — | 生产入口 | 见 §2 |

### 5.4 MOVE：无

`vendor/pi-web/` 已是完整上游快照（`README.md` 记录 URL/修订/MIT + `LICENSE`），无需第二次搬迁。

### 5.5 依赖与外部兼容性

**license/provenance**（上游 pi-web：MIT，Copyright (c) 2026 agegr，`apps/web/vendor/pi-web/LICENSE`，pin `76bdc570…` = v0.10.0，`vendor/pi-web/README.md:3`）：

- **72 个（11,780 行）**：`apps/web/vendor/pi-web/lib/` 内有逐字节副本，删除 `lib/` 原件**不减少任何上游信息**。
- **3 个（990 行）本仓改写**（`mcp-config-read.ts`、`project-trust.ts`、`tool-result-images.ts`）：删除的是**本仓的改写版**；能力已由 `packages/gateway/src/mcp/config.ts:222/240` 与 `packages/protocol/src/index.ts:350` 承接，上游原样仍在 vendor。**注意**：删除即丢弃这三处本仓改动的记录；若需可追溯，应在提交信息或 `docs/upstream-sources.md` 里留"删除了哪三处改写、上游对应哪一行"的说明（本报告不代做该文档改动）。
- **1 个（62 行）无上游副本**：`hooks/__fixtures__/react-hook-shim.mjs` 是本仓自有代码，删除即**净丢弃**，无 provenance 兜底（见 §8 未决决定 4）。

**分发与 notice（更正早前表述）**：`apps/web` 是 `\"private\": true`、不是 npm 包，所以**不存在"必须为独立发布包附带 notice"的义务**；但这**不等于"没有分发、无需考虑 notice"**。实际分发路径是容器/镜像与打包产物：`deploy/docker/web.Dockerfile` 在 **build 与 runtime 两个阶段都 `COPY apps/web apps/web`**，即把 `apps/web/vendor/pi-web/`（含 `LICENSE`）整棵树带进镜像；`.dockerignore` 未排除 `vendor/`。因此 **MIT notice 随 Web/容器分发一起保留，且必须继续保留**——本报告建议的删除**只触及 `apps/web/lib/` 与 `hooks/__fixtures__/`，不触及 `apps/web/vendor/pi-web/`**，notice 义务不受影响。`docs/upstream-sources.md:124/129` 里"不分发所以无 notice 义务"的表述应按此口径重读（该文档改动属任务 F，不在本报告范围）。

**DB/wire 影响**：零。这些文件不参与任何 HTTP 路由（`route.ts` 只分派到 `durableApi`/`mcpSurfaceApi`/`projectTrustApi`/`marketApi`）、不写任何 SQLite、不改变任何 wire 形状。

**依赖清理（删除后失去唯一引用者）**：

| 依赖 | 现状引用 | 建议 |
| --- | --- | --- |
| `proper-lockfile` (`package.json:93`) | 仅 `lib/{global-settings-file,mcp-config-file,provider-credential-store}.ts`（全删） | **删除**（含 `@types/proper-lockfile` `:107`） |
| `web-push` (`:99`) | 仅 `lib/web-push.ts`（删）+ `next.config.ts:59` | **删除**（含 `@types/web-push` `:112`），并从 `serverExternalPackages` 移除 |
| `semver` (`:96`) | `apps/web` 内 **0 引用** | **删除**（含 `@types/semver` `:111`）；`apps/server` 用自己的依赖 |
| `@earendil-works/pi-tui` (`:86`) | 仅 `package.json` + `next.config.ts:63` | **删除**（`apps/web` 内 0 import） |
| `node-pty` (`:92`) | 仅 `package.json` + `next.config.ts:57`；`pnpm-workspace.yaml` `allowBuilds: node-pty: false`；`README.md:23` 已声明"PTY 不属本 UI" | **单独决定**（pty 在后端/网关，不在 Web） |
| `undici` (`:97`) | `lib/http-dispatcher.ts`（删）+ `e2e/ux-image-submit.mjs:173` + `next.config.ts:58` | **保留**（e2e 在用） |

**无 wire/版本兼容风险**：不涉及协议、不涉及 `@hepi/protocol`、不涉及网关契约。

## 6. 过度设计审计（ponytail REVIEW 模式，只列不删）

- `apps/web/lib/mcp-host.ts:1-1087`: **delete** 整个文件。它把"每会话一个 MCP host 实例 + idle 计时 + transport 监视"实现在 Web 进程里，而所有者是网关 `McpHostService`。替代物：无——这正是重点。
- `apps/web/lib/mcp-config-read.ts` + `mcp-config-file.ts` + `mcp-config-key.ts` + `mcp-json-error.ts`: **delete** 4 文件、1,496 行。替代物 = `packages/gateway/src/mcp/config.ts`（450 行，同一件事的唯一所有者）。本报告最大一处"平行实现"。
- `apps/web/lib/mcp-sign-in.ts` + `mcp-sign-out.ts` + `mcp-status.ts`: **delete**。替代物 = 网关 `/v1/mcp` 的 `sign-in`/`sign-in-poll`/`sign-in-paste`/`sign-out` 操作（`docs/mcp-on-the-web-host.md:73-84`）。
- `apps/web/lib/builtin-extensions.ts`: **delete**。它把 SDK 内嵌 codemode/tool-search/mcp 扩展在 Web 进程里装配，而后端 harness 装配自己的扩展（`apps/server/src/harness.ts:20` `ENVIRONMENT_EXTENSION`）。**注意**：`docs/deployment.md:193` 与 `docs/container-deployment.md:26` 声称"UI 的 codemode builtin 解析 QuickJS worker/wasm"——**该文档声明在删除后即不再成立**，必须同步修正（见 §8）。
- `apps/web/lib/__fixtures__/*`: **delete** 3 文件。替代物 = `packages/gateway/test/fixtures/mcp/`（已在使用）。
- `apps/web/tsconfig.json` 的 `include` 白名单：**shrink**（删除后它掩盖的对象消失）。**是否随后放宽为 `lib/**/*.ts` 是独立、可选的清理，不是本删除的完成条件**：放宽会把此前从未被检查的 `lib/**`（含 §5.2 的 dormant 文件）首次纳入 typecheck，可能暴露与本退役无关的既有类型错误，需要**单独验证与单独授权**。本报告**不承诺**在该步骤修复任何此类错误；若放宽后出现失败，应作为独立 finding 记录，而不是塞进这次删除。
- 无新增概念、无新增层、无 fallback ladder：本报告不提议任何新 Module。

## 7. 在公开 Seam 上的验证

**关键行为**（删除后必须仍成立）：
1. `GET /api/mcp` 返回宿主列表；`HEPI_WEB_GATEWAY_URL` 未设时 `503 code=mcp_unavailable`（`adapters/mcp-host.ts:20,54`）。
2. 外主机 cwd 被拒：`403 reason=cwd-denied`（`adapters/mcp-surface.ts` 经 `hostCwdOf`）。
3. `GET /api/project-trust` 只读（`route.ts:42` 只匹配 `GET`）。
4. `lib/mcp-import*.ts` / `mcp-secrets.ts` / `mcp-server-display.ts` / `mcp-tool-display.ts` / `mcp-command.ts` / `mcp-config-values.ts` 的浏览器预览与服务端再解析一致性（`lib/mcp-import.integration.test.mjs`）。

**现有测试（复用，不新增）**：
- `pnpm test:web:unit`（`scripts/test-web-unit.mjs`，64 文件/111 测试基线，`docs/verification.md:9`）。
- 重点文件：`adapters/host-cwd-ownership.test.mjs`（175 行，直接调 `mcpSurfaceApi`/`projectTrustApi` + `hostCwdOf`）、`lib/mcp-import.test.mjs`、`lib/mcp-import.integration.test.mjs`、`lib/mcp-secrets.test.mjs`、`components/mcp-add-helpers.test.mjs`、`components/mcp-sign-in-helpers.test.mjs`、`components/OAuthPastePanel.test.mjs`、`public/sw.test.mjs`。
- **本批（§5.1）预期变化**：删除后 64 文件/111 测试**不变**（删除集内无测试文件）。这是本批可断言的完成标准。
- **注意（§5.2 的 DEFER 候选）**：那些候选**实现阶段应与测试一并退役**，届时 64/111 会**有意下降**；基线数字本身不是保留理由（见 §5.2 规则）。

**聚焦集成/浏览器检查**：`node apps/web/e2e/ux-mcp-surface.mjs`（真实网关 + fake OAuth，验证 `mcp-test-output`/`mcp-test-tools`）、`node apps/web/e2e/ux-truthfulness.mjs:250-252`（断言 "MCP is not available on this deployment" 且不提供编辑器）、`node apps/web/e2e/ux-capability-trust.mjs`。三者都走 `/api/mcp`，删除后应保持通过。

**回滚/切换与完成标准**：
- 切换 = 单次提交删除 + `pnpm install`（锁文件更新）+ `pnpm --filter @hepi/web build`（在 workstation/CI，**不得在 remote-host**）。
- 完成标准：(i) `pnpm test:web:unit` 仍 64/111；(ii) `pnpm check:docs`（基线运行：258 Markdown files; 0 broken relative links，exit 0；数字含本任务新增的 `brief.md` 与本报告）与 `pnpm check:entrypoints`（当前 60 present; 2 known-missing，exit 0）仍 exit 0；(iii) `pnpm --filter @hepi/web typecheck` 通过；(iv) 无 `apps/web/lib` 文件再导出 `McpHost`/`mcp-config-read`。
- 回滚 = `git revert`；无状态迁移，无不可逆步骤。

## 8. 与任务 A–F 的依赖、未决决定、推荐

**依赖/交互**：
- **与任务 F（文档/上游来源）**：删除必须同步改 `docs/upstream-sources.md:203-224`（"其他 dormant helper 作为 provenance 保留"一句改为"已从 `lib/` 退役，`vendor/pi-web/` 是唯一快照"），并按 §5.5 更正 `124/129` 行"不分发所以无 notice 义务"的口径（容器镜像实际携带 vendor 树）；另改 `apps/web/README.md:23`、`docs/deployment.md:193`、`docs/container-deployment.md:26`（codemode builtin 声明在删除后不再成立——须确认 codemode 由后端 harness 提供，或明确记为能力缺口）。
- **与任务 B–E**：本删除集与 session/file 组（子组 D2）重叠；若任务 B–E 打算复活任何本地读取器，须先决定该组归属，否则会重复删除。**建议本任务先做 MCP/settings 子组（D1，21 文件），因为它已被网关完整取代且无测试依赖**。
- **与既有记录**：`.scratch/architecture-routes/cross-host.md` §5 的 F2 已给出同一 dormant 列表（16 个 MCP 模块），本报告扩展到 87/76 并给出可执行删除集。

**未决决定**：
1. §5.2 的 8 个 DEFER 候选：活跃契约核查由谁执行、在本任务内还是下一个实现任务内（本报告只给核查要点，不做核查结论）。
2. `node-pty` / `@earendil-works/pi-tui` 从 `apps/web` 依赖移除是否属于本批范围（影响 `next.config.ts serverExternalPackages` 与 `pnpm-workspace.yaml allowBuilds`）。
3. `hooks/__fixtures__/react-hook-shim.mjs` 无上游副本 —— 删除即丢弃本仓自有代码，须确认无后续 hook 测试计划。
4. 可选第四批（放宽 `tsconfig include`）是否要做、由谁授权。

**推荐（含顺序）**：
1. **第一批 = §5.1 的 76 文件（12,832 行）**，作为**一次授权的删除集**；内部按风险排序执行：先 D1（21 文件）+ D4（4 文件）——已被网关完整取代、零测试依赖；再 D3（29 文件）——零测试、零路由依赖；最后 D2（22 文件）——需任务 B–E 的结论确认不复活这些读取器。同步改 §8 的 4 处文档，移除 `proper-lockfile` / `web-push` / `semver` / `@types/*`。
2. **随后（独立步骤，需活跃契约核查）**：按 §5.2 逐项退役 DEFER 候选（实现 + 测试一并删），并更新 `docs/verification.md` 基线。
3. **可选、独立（不在本次完成标准内）**：单独授权并单独验证后，把 `tsconfig.json` `include` 放宽为 `lib/**/*.ts`；**本报告不为该步骤承诺修复任何新暴露的既有类型错误**（见 §6）。
4. 每批后跑 `pnpm test:web:unit` + `pnpm --filter @hepi/web typecheck` + `pnpm check:docs` + `pnpm check:entrypoints`；第一批预期 **−12,832 行 / −76 文件 / 测试数字不变**。
5. **不要**建第二个 vendor 目录、不要加 lint 守卫（无 eslint 配置）、不要为这些文件引入任何新抽象。

**独立 finding（record，不在本报告范围）**：`apps/web/package.json:41` `\"lint\": \"eslint .\"` 在 `apps/web` 与仓库根均无 `eslint.config.*`，该脚本无法运行；`docs/verification.md` 与 `check:entrypoints` 的 `KNOWN_MISSING`（`e2e/run.mjs`、`e2e/terminal.mjs`）是既有记录项，不受本删除影响。
