# D — 真实共享的 Gateway 请求/响应契约的单一所有者

基线 `caf6a319177554f3fcc53e6a4efc6683a1a3e433`。只读研究：未改动源码、测试、配置、依赖、图或部署。本版为评审后的修订版（9 处修正，见 §0）。

## 0. 评审修正摘要

| # | 原稿说法 | 修正后 |
| --- | --- | --- |
| 1 | "Web 不能 import `@hepi/gateway`，硬约束" | **技术不可行性不成立**。type-only import 被擦除；`apps/web/lib/api-types.ts:1` 已有先例（`import type { McpExposure } from "@earendil-works/pi-coding-agent"`），`apps/web/package.json:106` 也已有 `@types/node`。**改为按所有权/依赖局部性拒绝**：见 §3.1 |
| 2 | `WorktreeListing` 全字段可选 | **错**。`worktrees.ts:29-35` 五个字段**全部必填**。改为**机械照搬生产者类型**；兼容性默认值留在读取侧适配器 |
| 3 | "共享类型消除 `as`" | **夸大**。union 的 value 不与 operation 相关，`McpHostResult.value` 仍是 `unknown`。逐条重列，见 §3.3 |
| 4 | "`lib/**` 不在 include 里，所以没有类型保护" | **撤回**。被传递 import 的文件同样参与类型检查。对字节校验/契约测试的反对理由改为 §6 |
| 5 | 根导出"一个字节都不变" | 改为"**根导出 API 不变**" |
| 6 | 先让 helper 走 `workbench/index.ts` 再搬 | **避免二次搬迁**：helper 直接指向 canonical 类型，见 §6 |
| 7 | `WorkspaceConfigValue` 未定义 | 使用**现有实际类型**，不发明名字，见 §4.2 |
| 8 | "Dockerfile 只 COPY protocol manifest" | **错**。三个 manifest 都 COPY（含 gateway、session）。改依赖需重新生成 frozen lockfile |
| 9 | 共享可变 `Set` 会耦合故障域 | **撤回**。不同进程各持一份，不存在跨进程可变耦合 |

## 1. 结论

**结论：存在真实的跨进程重复声明（duplicated truth），共 4 组。当前没有观测到的线上故障；缺陷是类型擦除让两侧形状可以静默分叉，且没有机制阻止。**

分类：**已确认的架构性重复 + 类型擦除（dormant debt，全部是活代码）**。不是逻辑错误，不是未实现功能。

### 1.1 已确认的重复（实测）

| # | 声明 A（Gateway，生产者） | 声明 B（消费者副本） | 实测关系 |
| --- | --- | --- | --- |
| 1 | `worktrees.ts:37-41` `WorktreeRequest` | `server.ts:104-108` `WorktreeHostRequest` | **逐字段相同**（3 variant，含 `force?: boolean`） |
| 2 | `workspaces.ts:36-41` `WorkspaceRequest` | `server.ts:99-102` `HostRequest` | B 是 A 的 **3/4 子集**（缺 `{operation:"list"}`）；`register`/`browse`/`profiles` 逐字段相同 |
| 3 | `mcp/host.ts:25-52` + `mcp/config.ts:34-98` | `apps/web/adapters/mcp-surface.ts:45-70` | **7 个类型逐字段相同**（`HostTrust`↔`ProjectTrust`、`HostServer`↔`McpServerInfo` 等） |
| 4 | `mcp/host.ts:74-76` `McpHostResult` | `apps/web/adapters/mcp-host.ts:23` `HostAnswer` | 相同，**只差 `flow` 被擦成 `unknown`** |

同仓内（不是跨进程，但同属本缺陷）：

- `workbench/contracts.ts:1-37`（`ChangedFileStatus`/`ChangedFileEntry`/`ChangedFilesErrorCode`/`ChangedFilesError`/`ChangedFilesResult`/`WorkspaceFilePreview`）与 `workbench/index.ts:7-13`（`WorkbenchFile`/`WorkbenchChangedFile`/`WorkbenchChanges`）是**同一份数据的两次声明**，被 `workbench/index.ts:25` 的 `as WorkbenchChanges` 掩盖。`contracts.ts` 只被 `app-store-diff.ts:2` 与 `app-store-files.ts:6` 引用，**从不被 `@hepi/gateway` 公开导出**。
- `apps/web/adapters/workbench.ts:32-34` 是第三份：`FilePreview` 与 `WorkbenchFile` 逐字段相同，`ChangedFile` 丢了 `stagingSourcePath` 并把 `status` 放宽成 `string`。
- 值级：`EXPOSURES` 集合在 `mcp/config.ts:148` 与 `mcp-surface.ts:323` 各写一次。

### 1.2 类型擦除的实测位置

- `server.ts:859` `hostRequest` 与 `:873` `hostWorktreeRequest` 返回 `{ ok: true; value: unknown }`。调用方因此必须在 5 处断言：`:899`、`:1263`、`:1286`、`:1404`（内联写了整份 listing 类型）、`:1421`。
- `mcp-surface.ts:104` `answer.value as T`：之后所有面板映射都建立在这一断言上。
- `mcp-surface.ts:203` `problem.reason as ...`：把 `string` 断言成字面量联合。今天恰好安全（Gateway 只发 `too-large`/`unreadable`/`unparsable`/`invalid-shape`，见 `config.ts:256-273`），但**没有机制**在新增 reason 时失败。
- `mcp-host.ts:23` `flow?: unknown` 让 `McpSignInFlowInfo` 在 Web 侧彻底失去校验。

### 1.3 修正既有注释

`mcp-surface.ts:45-70` 的注释称其为"the host service's own shapes"——**不准确**：其中 7 个是 Gateway 自己声明的类型。它们"看起来私有"的原因是 `@hepi/gateway` **没有导出它们**（`index.ts:93` 只导出 `McpHostRequest, McpHostResult, McpSignInFlowInfo, McpTestResult, McpTestState`；`McpScope`/`McpServerInfo`/`McpConfigRead`/`McpConfigFileInfo`/`ProjectTrust` 不在导出面内），且 `packages/gateway/package.json` 的 `exports` 只有 `"."` 与 `"./startup"`，标准解析下到不了 `src/mcp/config.ts`。

`apps/web/lib/api-types.ts` 里的 `McpServerInfo`/`McpTestResult`/`McpSignInFlowInfo`/`McpConfigFileInfo` **不是**重复声明，是**更宽的面板 DTO**（多出 `configKey`/`validated`/`status`/`commandFields`/`variableReferences`/`shadowedByProject`/`replacesGlobal`/`failure`/`refreshed`/`joined`/`afterSignIn`），由 `panelServer`/`panelTestResult`/`panelFlow`/`panelFiles` 构造。必须留在 Web。

## 2. 当前所有权与数据流

### 2.1 三层

```
浏览器 ──HTTP /api/*──▶ Web 适配器(Next) ──HTTP──▶ 后端(apps/server) ──HTTP /v1/*──▶ Gateway
                          └──── 直连 POST /v1/mcp ────┘  (mcp-host.ts，不经后端)
```

- **Gateway 是 `/v1/*` 形状的事实所有者**：`index.ts:526` 列 8 条路由；`index.ts:537` 做唯一通用体校验；各 surface 的 `execute` 是形状最终解释者。
- **后端重声明它调用的那部分**：`server.ts:99-108`、`:859/873`（信封）。
- **Web 重声明它读的那部分**：`mcp-surface.ts:45-70`、`workbench.ts:32-34`、`durable-api.ts:416-430`。

### 2.2 依赖类别

| 依赖 | 类别 | 说明 |
| --- | --- | --- |
| 上述所有类型声明 | **in-process**（纯数据，零 import） | 无 I/O、无 `node:`、无状态 |
| 后端 → Gateway `/v1/*` | **remote-owned** | 契约跨进程处，缺陷所在 |
| Web → Gateway `POST /v1/mcp`（`mcp-host.ts:35`） | **remote-owned**，**绕过后端** | 唯一 Web 需要宿主形状的原因 |
| Web → 后端 `/api/*` | **remote-owned** | `CatalogueEntry`(`server.ts:67`)、`Catalogue`(`durable-api.ts:143-149`)、`WorkspaceEntry`(`:263`)、`CwdIdentity`(`:238`) 属于**这条缝** |
| MCP server 本身 | **true external** | 与本次无关 |

### 2.3 运行时校验的所有权（现状，不改）

- Gateway：`index.ts:537` 只查 `typeof operation === "string"`；另有 `validExecuteRequest`(`:1027`)、`index.ts:721`（terminal open 逐字段）。未知 operation 落到各 surface `execute` 默认分支 → `{ok:false, code:"invalid_request"|"operation_failed"}`（`workspaces.ts:181`、`worktrees.ts:341`、`host.ts:346`、`workbench/index.ts:33`）。
- 后端：`readBody` + 路由局部 `typeof` 检查（如 `server.ts:1388-1394`），**不校验 Gateway 的答案**。
- Web：`mcp-surface.ts:332-338` 只校验收到的是对象，**不校验宿主答案**。
- **全仓无 JSON Schema / zod / valibot / ajv / superstruct**（已 grep 全部 manifest，零命中）。本报告不建议引入。

### 2.4 浏览器安全 import 与已发布 CLI 打包（修正版）

- `packages/protocol/src/` **零 `node:` import**（实测 grep 命中 0），已被 `"use client"` 组件直接消费（`SessionSidebar.tsx:44-53`、`hooks/useSessionUiState.ts:12`、`lib/session-tree.ts:21`），也被后端消费（`server.ts:9`、`src/sidebar-state.ts:10`）。
- `@hepi/gateway` 是 Node-only：`index.ts:1-4` import `node:http`/`node:fs`/`node:path`，`mcp/host.ts:1-4` 再 import `node:child_process`/`node:crypto`。**但 type-only import 不执行任何代码**：Web 今天已经这么做（`api-types.ts:1` 从 Node-only 的 `@earendil-works/pi-coding-agent` 引类型），且 `apps/web/package.json:106` 已有 `@types/node`，node 类型的声明在 Web 的 typecheck 里能解析。→ **"Web 无法 import Gateway 类型"不成立**，见 §3.1 的真实理由。
- 已发布 CLI：`packages/client/scripts/build.mjs` 用 esbuild `bundle: true` + `platform: "node"`，把 `packages/gateway/src/startup.ts`（经 `src/cli.ts:6`）连同 `@earendil-works/*` 打进 `dist/`。`packages/client/package.json` 的 dependencies 只有三个上游包、无任何 `workspace:`，而 `scripts/release-plan.mjs:11-13` **硬性拒绝**发布清单出现 `workspace:`/`file:`/`link:`。→ 给 `@hepi/gateway` 加 `@hepi/protocol` 依赖**不会**污染 npm 包（client 清单不变，protocol 源码被 esbuild 一起打进 bundle），但 **`packages/client/package.json` 里绝不能出现它**。
- 容器（修正）：`backend.Dockerfile:18-20` 与 `:39-41`、`web.Dockerfile:18-20` 与 `:36-38` **都 COPY 三个 workspace manifest**（gateway、protocol、session），然后各自 `pnpm install --frozen-lockfile`（`:22`/`:43`，`:22`/`:40`）。`:27`/`:46`/`:25`/`:43` 再 `COPY packages packages`。→ **新增 subpath 不需要改任何 Dockerfile**；但**改依赖关系必须重新生成 `pnpm-lock.yaml`**，否则 `--frozen-lockfile` 直接失败。这是本次唯一的构建侧前置条件。

## 3. 方案比较

### 3.1 方案 A：让 `@hepi/gateway` 做类型唯一来源（含新增 `@hepi/gateway/contracts` subpath）

**技术上可行**（type-only import 被擦除；给 gateway 加 `"./contracts": "./src/contracts.ts"` 导出即可让 Web 解析到）。**按所有权与依赖局部性拒绝**：

1. **契约的家变成 Node-only 包。** 共享声明的可达性于是取决于一个需要 `node:http`/`node:fs`/`node:child_process` 才能加载的包的解析规则。后端今天能 import 是巧合（它本来就是 Node 进程），不是设计。契约本身是纯数据，把它挂在 Node 实现包下，是让"数据形状"依附于"实现载体"。
2. **依赖方向错误。** `apps/web` 会因此获得一条指向 Gateway 实现包的依赖边。Web 只应在 `/v1/*` 与 `/api/*` 上认识**线上形状**，不应认识"谁实现了它"。今天 `apps/web/package.json` 的 dependencies 里没有 `@hepi/gateway`，这是正确状态。
3. **修不好 #3 的可用性缺口，只修类型可达性。** `McpScope`/`McpServerInfo`/`McpConfigRead`/`McpConfigFileInfo`/`ProjectTrust` 目前**不在** `index.ts` 的导出面内。方案 A 需要先扩 gateway 的公开导出面（或加 subpath），把一批此前刻意不导出的内部 MCP 载荷变成公开 API——这比"把纯数据放进本来就公开且浏览器安全的包"要重的多。
4. **方案 A 不能同时服务 E。** E 需要在浏览器安全位置放掩码逻辑；`@hepi/protocol/mcp-secrets` 已经是那个位置。两个报告落在同一个包、两个纯 subpath，边界一致。

（注：`@hepi/gateway` 是 `private: true`，所以方案 A **没有** npm 发布污染问题；拒绝理由纯粹是所有权与局部性。）

### 3.2 方案 B（推荐）：把必要的纯线上契约放进既有浏览器安全包 `@hepi/protocol` 的新 subpath `./gateway`

`packages/protocol` **已经**是"线上声明一次、所有生产消费者都读"的包（`docs/architecture.md` 的 packages/protocol 一节；`packages/protocol/src/index.ts:130-137` 的注释写明 "declared once for every production consumer"），**已经**吸收过一次"两份 Web 副本合并成一份"（`MAX_TOOL_RESULT_IMAGE_BYTES`/`TOOL_RESULT_IMAGE_MIMES`，`index.ts:346-360`，来源见 `docs/upstream-sources.md:84-90`）。本次是同一模式的第二、第三个实例。

- 同时修好 #1–#4：Web 已依赖 `@hepi/protocol`（`apps/web/package.json` 的 dependencies 有 `"@hepi/protocol": "workspace:*"`）。
- 不新建包，不加校验器，不改路由、状态码、线上字节。
- 代价：给 `@hepi/gateway` 加一条 `"@hepi/protocol": "workspace:*"`（今天为 0，实测 `packages/gateway/package.json`）。方向正确（protocol 零依赖），且不进入 npm 清单（§2.4）。**需重新生成 lockfile**。

### 3.3 共享静态类型**真正**消除什么、不消除什么（修正版）

**不消除（原稿夸大）：**

- `WorkspaceResult.value` 是 `readonly WorkspaceConfig[] | WorkspaceListing | readonly WorkspaceProfile[] | {id,root,created}` 的**无序 union，不与 `request.operation` 相关**。因此 `server.ts:1263`（`as readonly {id:string}[]`）与 `:1286`（`as {root:string}`）**仍需断言**才能从 union 里取出成员——共享类型让断言的目标有了名字，但不会让断言消失。
- `McpHostResult.value` 保持 `unknown`（`host.ts:75`，不变量 §5.2），所以 `mcp-surface.ts:104` 的 `as T` **仍在**。
- `mcp-surface.ts:203` 的 `as` 仍在（不变量 §5.3）。
- **共享静态类型不校验远程 JSON。** 它保证的是"两侧声明的形状一致"，不是"收到的字节符合声明"。任何 `as` 依然是对运行时的无根据断言。

**真正消除：**

- 4 组重复声明本身（上表 #1–#4）：删掉 `server.ts:99-108`、`mcp-surface.ts:45-70`、`mcp-host.ts:23`。
- `server.ts:1404` 的内联结构字面量类型（可换成 `WorktreeListing`；`??` 默认值仍在，见 §4.4）。
- 未来分叉的可能性：今天两侧可以各自改字段而无人察觉；之后改一处即两侧同时生效。

### 3.4 为什么不需要更复杂的方案

- **不新建 `@hepi/gateway-contracts` 包**：一个模块、一组消费者，`@hepi/protocol` 已就位 → **yagni**。新包会立刻面对和 protocol 一样的浏览器安全要求。
- **不加字节校验/契约测试**：本改动**不改变任何运行时行为**（类型全被擦除），没有需要保护的线上行为；`pnpm -r typecheck` 与既有 seam 测试已覆盖（§7.2）。原稿"Web 侧没有类型保护"的理由**已撤回**（§0#4）。
- **不加运行时 schema 校验**：现有校验覆盖各自进程的输入；缺陷在输出的**声明**，不在输入的**检查**。加校验器会改变错误行为。
- **不把 Web→后端的 `/api/*` 形状也搬进来**：那是另一条缝（§2.2）。

## 4. 推荐的目标 Interface

### 4.1 位置

新增 subpath `@hepi/protocol/gateway`，文件 `packages/protocol/src/gateway.ts`：

```json
"exports": { ".": "./src/index.ts", "./gateway": "./src/gateway.ts" }
```

**根 `index.ts` 不 re-export 本文件**（保持 "hepi.v1 会话协议" 的语义边界）。仓库已有 subpath 先例：`packages/session/package.json:6` 的 `"./browser"`。E 的 `"./mcp-secrets"` 与本 subpath 不冲突：同包、两个纯 subpath、都不拉 Node、都不动根导出。

### 4.2 内容：**机械照搬生产者的实际类型**（§0#2、§0#7）

原则：**逐字段复制 `worktrees.ts`/`workspaces.ts`/`mcp/host.ts`/`mcp/config.ts`/`workbench/index.ts` 今天声明的类型，不改一个修饰符**。不发明名字，不收窄，不把必填改成可选。

```ts
// packages/protocol/src/gateway.ts —— 仅纯数据：零 import、零 node:、零运行时值（除 §4.6 可选项）

/** 结构声明，不是 import：等价于 filesystem.ts:107 的 ExecutionHostIdentity。 */
export type ExecutionHostIdentity = { readonly user: string; readonly home: string };

// ---- /v1/workspaces（照搬 workspaces.ts:12-44）----
export type WorkspaceConfig = { readonly id: string; readonly root: string; readonly profileId?: string };
export type WorkspaceDirectory = { readonly name: string; readonly path: string };
export type WorkspaceListing = { readonly path: string; readonly parentPath: string | null; readonly directories: readonly WorkspaceDirectory[]; readonly host: ExecutionHostIdentity };
export type WorkspaceProfile = { readonly id: string; readonly host: string; readonly root: string; readonly user?: string; readonly home?: string; readonly error?: string };
export type WorkspaceRequest =
  | { readonly operation: "list" }
  | { readonly operation: "register"; readonly workspaceId: string; readonly root: string; readonly profileId?: string }
  | { readonly operation: "browse"; readonly path?: string; readonly profileId?: string }
  | { readonly operation: "profiles" };
export type WorkspaceResult =
  | { readonly ok: true; readonly value: readonly WorkspaceConfig[] | WorkspaceListing | readonly WorkspaceProfile[] | { readonly id: string; readonly root: string; readonly created: boolean } }
  | { readonly ok: false; readonly code: "invalid_request" | "invalid_workspace_id" | "invalid_root" | "workspace_conflict" | "not_found" | "not_a_directory" | "permission_denied" | "not_supported" | "unreachable" | "operation_failed" };
export type WorkspaceRegistration =
  | { readonly ok: true; readonly value: { readonly id: string; readonly root: string; readonly created: boolean } }
  | { readonly ok: false; readonly code: "invalid_workspace_id" | "invalid_root" | "workspace_conflict" };

// ---- /v1/worktrees（照搬 worktrees.ts:26-56；**全部必填**）----
export type WorktreeEntry = { readonly path: string; readonly branch: string | null; readonly isMain: boolean };
export type WorktreeListing = {
  readonly projectRoot: string;
  readonly isGit: boolean;
  readonly isTopLevel: boolean;
  readonly currentWorktreePath: string | null;
  readonly worktrees: readonly WorktreeEntry[];
};
export type WorktreeRequest =
  | { readonly operation: "list"; readonly workspaceId: string }
  | { readonly operation: "create"; readonly workspaceId: string; readonly branch: string }
  | { readonly operation: "remove"; readonly workspaceId: string; readonly path: string; readonly force?: boolean };
export type WorktreeFailureCode = "invalid_request" | "unknown_workspace" | "invalid_root" | "not_a_worktree" | "main_worktree" | "dirty" | "not_supported" | "unreachable" | "outcome_unknown" | "operation_failed";
export type WorktreeResult =
  | { readonly ok: true; readonly value: WorktreeListing | { readonly path: string; readonly branch: string } | { readonly removed: string } }
  | { readonly ok: false; readonly code: WorktreeFailureCode; readonly message?: string };

// ---- /v1/workbench（照搬 workbench/index.ts:7-13）----
export type WorkbenchFile = { readonly path: string; readonly content: string; readonly truncated: boolean; readonly binary: boolean; readonly sizeBytes: number };
export type WorkbenchChangedFile = { readonly path: string; readonly previousPath?: string; readonly stagingSourcePath?: string; readonly status: "added" | "copied" | "deleted" | "modified" | "renamed" | "untracked"; readonly staged: boolean };
export type WorkbenchChanges = { readonly state: "available"; readonly files: readonly WorkbenchChangedFile[] } | { readonly state: "unavailable"; readonly error: { readonly code: string; readonly message: string } };
export type WorkbenchOperation = "files" | "read" | "changes" | "diff";
export type WorkbenchRequest = { readonly workspaceId: string; readonly operation: WorkbenchOperation; readonly path?: string };
export type WorkbenchResult = { readonly ok: true; readonly value: readonly string[] | WorkbenchFile | WorkbenchChanges | string } | { readonly ok: false; readonly code: "unknown_workspace" | "path_denied" | "operation_failed" };

// ---- /v1/mcp（照搬 mcp/config.ts:34-98 与 mcp/host.ts:25-76）----
export type McpScope = "global" | "project";
export type McpTransportKind = "stdio" | "http";
export type McpServerInfo = { /* config.ts:38-66 逐字段照搬，含 masked/envNames/headerNames/usesOAuth/signedIn/oauthStateStored */ };
export type McpConfigFileProblem = { readonly reason: string; readonly error: string };   // reason 保持 string（§5.3）
export type McpConfigFileInfo = { readonly scope: McpScope; readonly path: string; readonly exists: boolean; readonly problems: readonly McpConfigFileProblem[] };
export type McpConfigRead = { readonly files: readonly McpConfigFileInfo[]; readonly servers: readonly McpServerInfo[] };
export type ProjectTrust = { readonly cwd: string; readonly trusted: boolean; readonly decision: boolean | null; readonly decisionPath?: string; readonly inherited: boolean; readonly error?: string };
export type McpTestState = "connected" | "needs-auth" | "failed";
export type McpTestResult = { readonly state: McpTestState; readonly error?: string; readonly stderr?: string; readonly toolCount?: number; readonly serverInfo?: { readonly name: string; readonly version: string }; readonly durationMs: number; readonly testedAt: number };
export type McpSignInPhase = "authorize" | "finishing" | "done" | "failed" | "cancelled" | "expired";
export type McpSignInFlowInfo = { readonly flowId: string; readonly scope: McpScope; readonly name: string; readonly phase: McpSignInPhase; readonly authorizationUrl?: string; readonly redirectUrl?: string; readonly expiresInMs: number; readonly alreadySignedIn?: true; readonly result?: McpTestResult; readonly error?: string };
export type McpHostRequest = /* host.ts:56-73 逐字段照搬（10 个 operation variant）*/;
export type McpHostResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly path?: string; readonly flow?: McpSignInFlowInfo };
```

**刻意不搬**（留在 Gateway 内部，后端与 Web 均零消费）：`McpWriteRefusal`/`McpWriteOutcome`(`config.ts:132-145`)、`McpSignInPaste`(`host.ts:54`)、`TerminalFailureCode`(`terminal.ts:240-250`)、`ExecuteFailureCode`(`execution.ts:21-33`)、`InstallRequest`(`install.ts:81-86`)、`Ssh*`、`Install*`。

**`WorkspaceResult` 的边界（§0#7）**：`value` 保持今天的**四成员 union 原样**，第四个成员继续内联写成 `{ id, root, created }`——**不发明 `WorkspaceConfigValue`**。`WorkspaceRegistration` 同形，一并照搬以维持两处一致。（若后续想让该成员有名字，那是独立的小决定，见 §8 未决项 2。）

### 4.3 各方如何消费

```ts
// packages/gateway/src/index.ts —— 既有导出名全部保留（:82/:84/:93 不变），改为 re-export
export type { WorkspaceConfig, WorkspaceDirectory, WorkspaceListing, WorkspaceProfile, WorkspaceRequest, WorkspaceResult, WorkspaceRegistration } from "@hepi/protocol/gateway";
export type { WorktreeEntry, WorktreeFailureCode, WorktreeListing, WorktreeRequest, WorktreeResult } from "@hepi/protocol/gateway";
export type { McpHostRequest, McpHostResult, McpSignInFlowInfo, McpTestResult, McpTestState } from "@hepi/protocol/gateway";

// packages/gateway/src/worktrees.ts / workspaces.ts / mcp/host.ts / mcp/config.ts / workbench/index.ts
import type { WorktreeRequest, WorktreeResult } from "@hepi/protocol/gateway";
export type { WorktreeRequest, WorktreeResult };   // 让 index.ts 的 re-export 链继续成立

// apps/server/src/server.ts —— 删 :99-108
import type { WorkspaceRequest, WorkspaceResult, WorktreeRequest, WorktreeResult } from "@hepi/protocol/gateway";
const hostRequest = async (binding, body: WorkspaceRequest): Promise<WorkspaceResult> => { ... };
const hostWorktreeRequest = async (binding, body: WorktreeRequest): Promise<WorktreeResult> => { ... };

// apps/web/adapters/mcp-surface.ts —— 删 :45-70，改别名 import
import type { McpConfigRead as HostRead, McpConfigFileInfo as HostFile, McpConfigFileProblem as HostFileProblem,
  McpServerInfo as HostServer, ProjectTrust as HostTrust, McpTestResult as HostTestResult,
  McpSignInFlowInfo as HostFlow } from "@hepi/protocol/gateway";

// apps/web/adapters/mcp-host.ts:23
export type { McpHostResult as HostAnswer } from "@hepi/protocol/gateway";

// apps/web/adapters/workbench.ts —— 只换 FilePreview
import type { WorkbenchFile as FilePreview } from "@hepi/protocol/gateway";
```

### 4.4 不变量、顺序、错误、恢复、性能

- **零线上字节变化。** 不新增字段、不改状态码、不改错误形状、不改路由。JSON 输出与今天逐字节相同。
- **兼容性默认值留在读取侧适配器（§0#2）。** `WorktreeListing` 在生产者侧**全部必填**；`server.ts:1404` 与 `durable-api.ts:429` 今天用 `?? true`/`?? false`/`?? null` 兜底老 Gateway 不报字段的情形，这些默认值**留在适配器里**，共享类型**不为此放宽**。理由：放宽生产者类型会同时削弱新 Gateway 的类型保证，并让"新 Gateway 真的漏报"变成编译期合法。**"老部署的二进制必须能通过新源码的 typecheck"不是要求**——老二进制不参与本次 typecheck；读取侧的容错是运行时策略，用局部断言或局部窄类型表达即可。
- **顺序**：类型搬迁不引入顺序。既有"注册 → 执行"（`server.ts:929-940`）与"创建 → 记入项目"（`server.ts:1419-1432`）不动。
- **错误语义保持**：`/v1/workspaces|worktrees|mcp` 上非字符串 `operation` → `400 {ok:false, code:"invalid_request"}`（`index.ts:537-540`）；未知 operation → `200` + surface 自己的 `invalid_request`/`operation_failed`；HTTP 不可达 → `502`/`503`（`server.ts:862,876`）；workbench 失败 → `409`（`index.ts:580-590`）。**一条都不改。**
- **恢复**：不改。
- **性能**：类型零运行时开销。

### 4.5 隐藏 vs 显式

- **隐藏**：两侧不再各写一份宿主形状；`server.ts:99-108`、`mcp-surface.ts:45-70`、`mcp-host.ts:23`、`server.ts:1404` 的内联字面量消失。
- **显式保留**（不得被"统一"吃掉）：
  - Web 面板 DTO（`api-types.ts` 的 `McpServerInfo`/`McpTestResult`/`McpSignInFlowInfo`/`McpConfigFileInfo`/`ProjectTrustStatus`）与 `panel*` 构造器。**是 UI DTO，不是传输契约**，含宿主根本不报的字段。
  - 后端 `/api/*` 形状（`CatalogueEntry`、`Catalogue`、`WorkspaceEntry`、`CwdIdentity`）。
  - Web 的 `WorktreeChoice`(`lib/new-session-context.ts:10`)、`adapters/workbench.ts:33` 的 `ChangedFile`（已放宽成 `status: string`）、`WorkbenchValue`（本适配器的错误处理形状）。
  - Gateway 内部失败码与不对外载荷（§4.2 末）。
  - 读取侧兼容默认值（§4.4）。

### 4.6 可选项（建议 disposition: record）

`EXPOSURES` 值集（`config.ts:148` 与 `mcp-surface.ts:323`）。可导出 `MCP_EXPOSURES: readonly string[]` 让两边各建自己的 `Set`。**注意（§0#9 修正）**：两个进程各持一份实例，**不存在跨进程可变耦合**，共享 `Set` 也不会"把故障域绑在一起"。不共享的唯一理由是**收益低**（1 行、4 个字面量、两侧都有各自的校验分支），而非技术上不可行。建议记录，不共享。

## 5. 不变量（实现时必须保住）

1. `WorktreeListing` 五个字段在**共享类型里全部必填**（照搬 `worktrees.ts:29-35`）。读取侧的 `?? true`/`?? false`/`?? null` 默认值留在 `server.ts:1404` 与 `durable-api.ts:429`。
2. `McpHostResult.value` 保持 `unknown`（`host.ts:75`）；收窄会破坏 `mcp-surface.ts:104` 的泛型用法。
3. `McpConfigFileProblem.reason` 保持 `string`（`config.ts:68`），**不要**收窄成 Web 面板那个字面量联合（`api-types.ts:117-130`，含 Gateway 永不发出的 `link-dangling` 等）。
4. `WorkspaceResult.value` 保持四成员 union 原样（`workspaces.ts:43`），第四成员继续内联，不新增名字。
5. **根导出 API 不变**：`@hepi/protocol` 的 `"."` 导出面与语义边界不动（新类型只出现在 `"./gateway"`）。

## 6. Keep / delete / move 表（§0#6、§0#8 修正）

尺寸为实测行数（来源区间）。

| 文件 / 位置 | 动作 | 调用者 | 外部兼容 | 来源 / 许可证 | DB / 线上影响 |
| --- | --- | --- | --- | --- | --- |
| `packages/protocol/src/gateway.ts`（新，约 185 行声明，来自 §4.2 的 5 个区间） | **新增** | 后端、Web、Gateway | 新 subpath，无既有消费者 | 本仓自有（机械搬移，非上游拷贝） | 无 |
| `packages/protocol/package.json` `exports` | **加** `"./gateway"` | — | `private: true`，不发布 | — | 无 |
| `packages/gateway/package.json` | **加** `"@hepi/protocol": "workspace:*"` | — | **不进 npm 清单**（`release-plan.mjs:11-13` 只读 client 清单） | — | **需重新生成 `pnpm-lock.yaml`**，否则 `--frozen-lockfile` 失败 |
| `packages/gateway/src/workspaces.ts:12-44`（33 行） | **移**（保留 re-export） | `index.ts:33,84`；`ssh-workspaces.ts:4`；`test/workspaces.test.ts:6`、`test/ssh-workspaces.test.ts:6` | `@hepi/gateway` 导出名不变 | 本仓自有 | 无 |
| `packages/gateway/src/worktrees.ts:26-56`（31 行） | **移**（保留 re-export） | `index.ts:31,82`；`test/worktrees.test.ts:21` | 同上 | 语义 adapted from pi-web `lib/worktree.ts`（MIT, agegr/pi-web@76bdc570，见 `docs/workbench.md:59`）；**仅类型搬迁，不新增发布物** | 无 |
| `packages/gateway/src/mcp/config.ts:34-98`（65 行；`McpWriteRefusal`/`McpWriteOutcome` 留下） | **移**（保留 re-export；**并为 `McpScope`/`McpServerInfo`/`McpConfigRead`/`McpConfigFileInfo`/`ProjectTrust` 增加从 protocol 的 re-export**） | `mcp/host.ts:7`；`index.ts:91` | **新增导出名**（此前不在 `index.ts` 导出面内，见 §1.3） | 本仓自有 | 无 |
| `packages/gateway/src/mcp/host.ts:25-52,56-76`（53 行；`McpSignInPaste` 留下） | **移**（保留 re-export） | `index.ts:36,93`、`:557`；`test/mcp.test.ts` | 导出名不变 | 本仓自有 | 无 |
| `packages/gateway/src/workbench/index.ts:7-13`（7 行） | **移**（保留 re-export） | `index.ts:31`、`:585` | 导出名不变 | 本仓自有 | 无 |
| `packages/gateway/src/workbench/contracts.ts`（37 行，无公开消费者） | **删**，并**让 `app-store-diff.ts:2` 与 `app-store-files.ts:6` 直接 import `@hepi/protocol/gateway`**（不要先改指向 `workbench/index.ts` 再搬第二次），同时去掉 `workbench/index.ts:25` 的 `as WorkbenchChanges` | 上述两处 | 无（未公开导出） | 本仓自有 | 无 |
| `apps/server/src/server.ts:99-108`（10 行） | **删**，改 import | `:861,875,899,924,1263,1286,1404,1421` | 私有类型 | 本仓自有 | 无 |
| `apps/server/src/server.ts:1404` 的内联 listing 字面量 | **换**成 `WorktreeListing`；**保留** `?? true`/`?? false`/`?? null` | 同函数 | — | — | 无 |
| `apps/server/src/server.ts:1421` 的 `as { path, branch }` | **保留**（union 未按 operation 相关，§3.3） | 同函数 | — | — | 无 |
| `apps/web/adapters/mcp-surface.ts:45-70`（26 行） | **删**，改 import + 别名 | `:104,134,140,152,165,198,203,263,266,283,354,372,414,449,465,485,493,502,570,595,599` | 私有类型 | 本仓自有 | 无 |
| `apps/web/adapters/mcp-host.ts:23` | **删**，改 re-export | `mcp-surface.ts:19,103` | 模块内导出，`adapters/` 外零消费者 | 本仓自有 | 无 |
| `apps/web/adapters/workbench.ts:34`（`FilePreview`） | **删**，用 `WorkbenchFile`。`ChangedFile`(`:33`) 与 `WorkbenchValue`(`:32`) **保留** | `:105,133,318,321` | 私有 | 本仓自有 | 无 |
| `apps/web/lib/api-types.ts`（753 行面板 DTO） | **不动** | 20+ 组件（type-only） | — | 本仓自有 + 上游 pi-web 面板类型 | 无 |
| `apps/web/vendor/pi-web/**`（provenance 快照） | **不动** | 无 | — | 保留 provenance（`docs/upstream-sources.md:128-131`） | 无 |
| `packages/client/**` | **不动** | — | — | — | 无 |
| `deploy/docker/*.Dockerfile` | **不动**（已 COPY 三个 manifest + 整个 `packages/`，§2.4） | — | — | — | 无；但**必须先提交新 lockfile** |

**过度设计审计（ponytail, REVIEW）**：`workbench/contracts.ts:1-37` **delete**；`server.ts:99-108` **delete**；`mcp-surface.ts:45-70` **delete**；`mcp-host.ts:23` **delete**；`server.ts:1404` 字面量 **delete**；`adapters/workbench.ts:34` **delete**；`EXPOSURES` 双写 **record**。**yagni**：新包、schema 校验层、统一面板 DTO、搬 `/api/*` 形状、重写 `index.ts:526-590` 的 8 条 if 链、给 `/v1/*` 加 `PROTOCOL_VERSION`（今天零命中，加版本号是真正的线上变更，需单独 ADR）。

## 7. 公开 Seam 上的验证

### 7.1 关键行为

1. 三条 `/v1/*` 路由在改动前后对同一请求返回**相同 JSON**。抓取点：`packages/gateway/test/startup.test.ts:75,77`（`POST /v1/workspaces`、`POST /v1/worktrees`）。
2. 畸形请求不变：非字符串 `operation` → 400（`test/workspaces.test.ts:97`）；未知 operation → 200 + `invalid_request`。
3. 后端容错不变：`apps/server/test/worktree-picker.test.ts`（`dirty` 409 `:210-213`、`unknown_workspace` 404 `:290`、`invalid_request` `:204,298`）。
4. Web 面板不变：`apps/web/e2e/ux-mcp-surface.mjs`、`ux-worktree-picker.mjs`。

### 7.2 复用的既有测试（不新增）

| 缝 | 既有测试 | 覆盖什么 |
| --- | --- | --- |
| Gateway 线上契约（真实 HTTP） | `test/workspaces.test.ts:96-97`、`test/worktrees.test.ts:98,399,403`、`test/mcp.test.ts:79,399`、`test/startup.test.ts:75,77,124,129`、`test/workbench.test.ts` | 每个 surface 的请求/应答形状 |
| 打包后的 CLI 仍服务这些路由 | `packages/client/test/gateway.test.ts`、`packages/client/scripts/smoke-pack.mjs:214-235`（对安装后的 tarball 打 `/v1/files`、`/v1/mcp`、`/v1/worktrees`） | **"新增 protocol 依赖后 esbuild 仍能打包并运行"的关键证据** |
| 后端 ↔ Gateway 端到端 | `apps/server/test/worktree-picker.test.ts`、`test/ssh-project.test.ts:162,171,283,307`、`test/file-relay.test.ts`、`test/terminal-browser.test.ts` | 后端解析 Gateway 答案的每条路径 |
| 类型层 | `pnpm -r typecheck`（`scripts/lib/presets.mjs:20`） | 共享类型是否真的消除了重复声明；`packages/gateway` 新增依赖后 `NodeNext` 解析 subpath 是否成立 |
| 依赖图 | `node --test scripts/release-plan.test.mjs` + `pnpm --filter @hepi/client smoke:pack` | 新 `workspace:` 依赖不进入发布清单；打包路径完好 |
| 浏览器 | `apps/web/e2e/ux-mcp-surface.mjs`、`ux-worktree-picker.mjs` | `@hepi/protocol/gateway` 能进 `"use client"` bundle |

### 7.3 明确风险与验证动作

- **风险：workspace 包 subpath 在 Next/webpack 与 `moduleResolution: "bundler"`（`apps/web/tsconfig.json:17`）下的解析。** 根 `"."` 已工作，subpath 需实机确认。**动作**：改后跑 `pnpm --filter @hepi/web typecheck` 与一次 `next build`（在 workstation/CI，**绝不在 remote-host**）。若失败，退路是让根 `index.ts` 也 re-export（代价是污染根语义边界）——**先验证再决定**。
- **风险：新增 `workspace:` 依赖后 `--frozen-lockfile` 失败。** 实测 `release-plan.mjs:12` 只读 `packages/client/package.json`，不会因此触发。**动作**：先 `pnpm install` 更新 lockfile 并提交，再跑 `node --test scripts/release-plan.test.mjs` 与 `pnpm --filter @hepi/client smoke:pack`。
- **风险：esbuild bundle 变大。** 增量是约 185 行纯类型，**编译后 0 字节**。无需度量。

### 7.4 切换与完成判据

- 可回滚：纯类型搬迁，回滚 = 恢复一个 commit（含 lockfile）。无 DB 迁移，无线上格式变化，无部署顺序要求。
- 完成判据：(a) `pnpm -r typecheck` 绿；(b) `pnpm -r test` 绿；(c) `pnpm --filter @hepi/client smoke:pack` 绿；(d) `node --test scripts/release-plan.test.mjs` 绿；(e) `apps/web/e2e/ux-mcp-surface.mjs` 与 `ux-worktree-picker.mjs` 绿；(f) §5 五条不变量逐条核对；(g) `git diff` 中没有任何 JSON 字段名/状态码/错误码变化。

## 8. 与 A–F 的依赖关系与有界未决项

- **E（MCP 掩码）**：E 推荐 `@hepi/protocol/mcp-secrets`。**兼容**：同包、两个纯 subpath、都不拉 Node、都不动根导出。落地顺序任意；若同时落地，`packages/protocol/package.json` 的 `exports` 只需一次合并编辑（加两个 key）。唯一交集是 `McpScope`（E 的掩码函数不消费它，D 的 `McpHostRequest` 消费它）——不冲突。**D 不依赖 E，E 不依赖 D。**
- **A（Web runtime retirement）**：A 认定 `apps/web/lib/mcp-test.ts`、`mcp-config-read.ts`、`mcp-entry-request.ts`、`mcp-host.ts` 等为休眠待退役。**D 不得先把这些休眠文件搬到新 subpath**：D 只搬 §6 表里的活类型（宿主真值）。A 先清掉休眠副本更省事，但非前置条件。
- **B / C / F**：与 D 无共享文件。若 C 触及 `packages/protocol`（窗口折叠），需协调一次 `package.json` `exports` 编辑。
- **未决项 1**：subpath 名 `./gateway` 还是 `./host`。`./gateway` 更贴近被声明的对象（Gateway 的 `/v1/*`）；`./host` 会与 A 报告的 "Web host" 术语混淆。**建议 `./gateway`。**
- **未决项 2**：`WorkspaceResult` 第四成员是否命名。**建议不命名**（§4.2），保持机械照搬。
- **未决项 3**：`ExecutionHostIdentity` 沿用旧名还是改名。**建议沿用**，注释写明它是结构声明、不是 import。
- **未决项 4**：`EXPOSURES`。**建议 record，不共享**（理由：收益低，非技术不可行）。

## 结论与推荐顺序

**推荐：方案 B。** 把必要的纯线上契约放进 `@hepi/protocol` 的新 subpath `./gateway`，由它成为 `/v1/workspaces`、`/v1/worktrees`、`/v1/workbench`、`/v1/mcp` 四个 surface 请求/应答形状的唯一所有者；Gateway 保留同名 re-export（并为 MCP 载荷类型**扩大**导出面）；后端与 Web 改为 import；Web 面板 DTO、后端 `/api/*` 形状、Gateway 内部失败码**全部留在原地**。

理由（按重要性）：

1. **所有权正确。** 共享的是纯数据；把它挂在 Node-only 实现包下会让形状依附于载体（§3.1）。方案 A 技术可行，但所有权与依赖局部性错误，且需要扩大 gateway 的公开导出面才能服务 Web。
2. **不是新架构。** `@hepi/protocol` 已是"线上声明一次"的包（`docs/architecture.md:9`），已吸收过一次两份 Web 副本（`docs/upstream-sources.md:84-90`）。
3. **零线上行为的类型搬迁**：可回滚，无 DB/部署顺序要求，不影响 npm 发布物与容器镜像（唯一构建侧前置条件是重新生成 lockfile）。
4. **消除的是重复声明，不是断言。** 断言数量只会小幅下降（§3.3）；不要把本改动宣传成"用静态类型校验了远程 JSON"。

**推荐顺序：**

1. **先做 `workbench/contracts.ts` 的删除**：`app-store-diff.ts`/`app-store-files.ts` 直接 import `@hepi/protocol/gateway`（或先指向 `workbench/index.ts`，但**只搬一次**）。零跨进程影响，独立可验证。
2. **加 subpath 与 `@hepi/gateway` 依赖**，只搬 Gateway 声明并保留 re-export，**更新 lockfile**，`pnpm -r typecheck` 必须绿（此时无人消费新类型，风险最小）。
3. **改后端**：删 `server.ts:99-108`、换 `:1404` 字面量（保留默认值），跑 `apps/server/test/worktree-picker.test.ts`、`test/ssh-project.test.ts`。
4. **改 Web**：删 `mcp-surface.ts:45-70`、`mcp-host.ts:23`、`workbench.ts:34`，跑 `pnpm --filter @hepi/web typecheck`、`next build`、两个 e2e。
5. **最后**跑 `pnpm --filter @hepi/client smoke:pack` 与 `node --test scripts/release-plan.test.mjs`。
6. **不新增测试。** 现有 seam 已足够（§7.2）；本改动不引入新行为，只引入新声明。
