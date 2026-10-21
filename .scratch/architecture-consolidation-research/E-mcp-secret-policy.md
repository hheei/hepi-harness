# E — MCP 掩码规则的唯一浏览器安全所有者

基线 `caf6a319177554f3fcc53e6a4efc6683a1a3e433`（`git rev-parse HEAD`）。本报告只读，不改动任何源码、测试、配置或依赖。

## 1. 结论

**已确认的架构性重复（duplicated truth）/ 维护债务：一个 523 行的纯模块存在两份都活着的可执行副本，没有任何机制阻止它们分叉。今天没有观测到的凭据泄漏；分叉是未来风险。**

- `apps/web/lib/mcp-secrets.ts`（523 行）与 `packages/gateway/src/mcp/mcp-secrets.ts`（523 行）**逐字节相同**：两者 md5 均为 `dc94b7732a7b05a6211d485ab5d8037f`，与 provenance 副本 `apps/web/vendor/pi-web/lib/mcp-secrets.ts` 相同。
- 两份副本都**被代码引用**，但两侧的活跃度不同，必须分开陈述：
  - **活跃（live，浏览器与生产路由可达）——5 个文件。** 生产入口 `apps/web/app/api/[...path]/route.ts:2` → `apps/web/adapters/mcp-surface.ts:18` → `apps/web/lib/mcp-import.ts:25`；import 链上 `apps/web/lib/mcp-import-core.ts:2`、`apps/web/lib/mcp-import-json.ts:22`。UI 侧 `apps/web/components/McpConfig.tsx:145` → `apps/web/components/McpAddServer.tsx:9`（`"use client"`），`apps/web/components/McpConfig.tsx:146` → `apps/web/components/mcp-add-helpers.ts:31`。这 5 个是真实生产闭合（`SettingsPanel` 由 `apps/web/components/AppShell.tsx:14` 渲染，`app/api/[...path]/route.ts:40` 把 `mcp` 前缀路由到 `mcpSurfaceApi`）。
  - **休眠（dormant，无 live 调用者）——2 个文件。** `apps/web/lib/mcp-config-read.ts:38` 只被同属休眠的 `mcp-entry-request.ts:9` 与 `mcp-config-file.ts:14` 引用；`apps/web/lib/mcp-test.ts:6-13` 只被休眠的 `mcp-host.ts:27` 与 `mcp-sign-in.ts:27` 引用，且 `mcp-test.ts:16` import 不存在的 `./model-runtime`，**该模块本身无法加载**。二者均属 A 报告认定的「已被网关取代、待退役」集合（`.scratch/architecture-consolidation-research/A-web-runtime-retirement.md:26,41`）。**不得把它们计入生产闭合。**
  - Gateway 侧 `packages/gateway/src/mcp/secrets.ts:1` import 同目录副本，再由 `packages/gateway/src/mcp/host.ts:8`（`createRedactor`）与 `packages/gateway/src/mcp/config.ts:3`（`maskedEntry`）消费——这条链是活跃的（`packages/gateway/src/index.ts` 定义 `POST /v1/mcp`）。
- **今天没有观测到的凭据泄漏。** 两份文件当前逐字节相同（md5 已验），因此不存在「一侧已隐藏、另一侧已回显」的已发生失败；没有任何故障报告、日志或测试失败支持这一点。分叉风险是**未来风险**：这份规则决定「URL userinfo / query / path 段、command、args、`Name: value` 里的哪些字面量算凭据」，Web 面板隐藏什么与 Gateway 在 `POST /v1/mcp` 回复里遮蔽什么必须逐字一致，而 `docs/mcp-on-the-web-host.md:18` 与 `docs/upstream-sources.md:135` 把「同一套规则」当作事实陈述，**没有任何机制保证**。触发条件很窄（改动其中一份而漏掉另一份），后果很重（同一凭据在 Web 侧被隐藏、在 Gateway 侧原样进入浏览器可见文本）。这是要消除的**风险与维护债务**，不是正在发生的缺陷。
- 分类：**已确认的架构性重复（duplicated truth）/ 维护债务**；**不是**普通逻辑错误，**不是**已演示的当前泄漏。唯一的现有保护是「没人改动它」，而不是机制。

**修正既有说法：**

- `packages/gateway/src/mcp/secrets.ts` **不是**重复副本：它是本仓库自有的 93 行 redaction walker（`literalSecrets`、`createRedactor`、`maskedEntry`），import 副本后才构成完整语义。任务描述正确，文档也不冲突。
- 但 `apps/web/vendor/pi-web/lib/mcp-secrets.ts` 是**第三份**相同字节；它在 `SKIP_DIRS`（`scripts/lib/discovery.mjs:21`）下，不被任何测试或运行代码引用，属于刻意保留的 provenance，**保留**。
- 两份「纯副本」的说法在**字节层面**成立（md5 已验证），因此迁移可以零改写地搬运。

## 2. 当前所有权与数据流

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 规则（纯函数） | `apps/web/lib/mcp-secrets.ts` ≡ `packages/gateway/src/mcp/mcp-secrets.ts` | `SECRET_MASK`、`isSecretName`、`looksLikeSecretValue`、`isReferenceOnly`、`maskUrl`/`maskCommand`/`maskArgs`、`urlSecretParts`/`commandSecretParts`/`argSecretParts`、`literalSecretFields` |
| Gateway 报告遮蔽 | `packages/gateway/src/mcp/secrets.ts` | 一条 entry 的字面密钥集合 + 「最长优先」把已解析值替换成掩码 |
| Web 显示遮蔽 | `apps/web/lib/mcp-config-read.ts:461-473`、`apps/web/lib/mcp-test.ts:186-269` | 面板列表、Test 结果、状态里的 `error`/`stderr` |
| 导入器 | `apps/web/lib/mcp-import-core.ts`、`mcp-import.ts`、`mcp-import-json.ts` | 粘贴导入时判断哪个字段是密钥、预览遮蔽 |

依赖类别（按 codebase-design 词汇）：

- **in-process**：整个 `mcp-secrets` 模块——无 I/O、无 `node:` import、无 `process`/`Buffer`（已 grep 确认 `apps/web/lib/mcp-secrets.ts` 零 import）。这正是它可以跨进程搬家的原因。
- **local-substitutable**：无。
- **remote-owned**：Web→Gateway 的 `POST /v1/mcp`（`apps/web/adapters/mcp-host.ts:35`）。**本次改动不得加宽这条链路**：没有新的跨主机载荷，掩码仍只作用于 Gateway 自己回给 Web 的文本。
- **true external**：MCP server 自身（`@earendil-works/pi-mcp`）；掩码只作用于它产生的文本。

## 3. 方案比较

### 方案 A（推荐）：迁到既有浏览器安全包 `@hepi/protocol` 的一个 subpath

`packages/protocol` 已经是浏览器安全包：`packages/protocol/src/index.ts` 无 `node:` import，被 Web 的 `"use client"` 组件直接消费（`apps/web/components/SessionSidebar.tsx:44-53`、`hooks/useSessionUiState.ts:12`、`lib/session-tree.ts:21`），也同时被后端消费（`apps/server/src/server.ts:9`、`src/sidebar-state.ts:10`）。它**已经**承载过一个「两边共用的纯策略」——`MAX_TOOL_RESULT_IMAGE_BYTES` / `TOOL_RESULT_IMAGE_MIMES` 从两份 Web 副本合并进 protocol（`docs/upstream-sources.md:86-90`、`packages/protocol/src/index.ts:350`）。这次是同一模式的第二个实例，不是新架构。

新增 subpath，而不是往 wire-contract 的根导出里塞：

```json
// packages/protocol/package.json
"exports": {
  ".": "./src/index.ts",
  "./mcp-secrets": "./src/mcp-secrets.ts"
}
```

仓库已有 subpath 先例：`packages/session/package.json:6` 的 `"./browser"`。根 `index.ts` 是 wire 契约（`PROTOCOL_VERSION`、frame 类型、`validateCommand`）；掩码是显示策略，放在根导出会污染契约模块的语义边界。

### 方案 B：保留两份 + 加字节校验

在 `scripts/` 或 gateway 测试里断言两份文件 sha256 相等。优点：零依赖变化，故障域完全不动。缺点：仍然两份真相，只有「同字节」这一条不变量；任何一侧需要改动时（例如新增 token 前缀）仍然要改两处并靠检查失败提醒，而且 Web 侧 `lib/**` 根本不在 `apps/web/tsconfig.json` 的 include 里（见 §5），没有类型保护。这只把缺陷变成被监视的缺陷，**不如 A**。

### 方案 C：新建 `@hepi/mcp-secrets` 包 / 或放进 `@hepi/session`

`@hepi/session` 有 `./browser` subpath，但它当前只被 `apps/server/src/chat.ts:1` 的浏览器 bundle 用；让 Gateway 依赖 session 会形成 gateway→session→protocol 的错误方向，而且 Web 并不依赖 session。新包则是 **yagni**：一个模块、一组消费者，protocol 已经就位。

### 为什么不需要更复杂的替代方案

这是**纯函数共享**：没有运行时状态、没有 I/O、没有注入策略、没有可变配置。删除测试（deletion test）很清楚——删掉 protocol 里的文件，523 行复杂度会在 Web 与 Gateway 各重现一次。因此需要的是一个所有权位置，不是一层抽象。

## 4. 目标 Interface

```ts
// packages/protocol/src/mcp-secrets.ts —— pi-web lib/mcp-secrets.ts 的逐字节副本（不改一行）
export const SECRET_MASK = "•••";
export function isSecretName(name: string): boolean;
export function looksLikeSecretValue(value: string): boolean;
export function isReferenceOnly(value: string): boolean;
export interface MaskedValue { value: string; masked: boolean; }
export function maskUrl(url: string): MaskedValue;
export function urlSecretParts(url: string): string[];
export function maskCommand(command: string): MaskedValue;
export function commandSecretParts(command: string): string[];
export function maskArgs(args: readonly string[]): { args: string[]; masked: boolean };
export function argSecretParts(args: readonly string[]): string[];
export type LiteralSecretField = ...;
export function literalSecretFields(config: unknown): LiteralSecretField[];
```

调用示例（Web，改动仅一行）：

```ts
// apps/web/lib/mcp-import-core.ts
import { isSecretName, maskArgs, maskUrl, SECRET_MASK } from "@hepi/protocol/mcp-secrets";
```

不变量与语义（迁移必须原样保留）：

1. **引用不算密钥**：`${VAR}` / `$VAR`（`isReferenceOnly`）在 env/header/`oauth.clientSecret` 里是「密钥在哪」，不是密钥；URL/command/args 里只认 placeholder 形状（`isPlaceholderOnly`）。
2. **掩码是显示用的**：`MaskedValue.masked` 是唯一出口，没有反向解析；`*SecretParts()` 是唯一「再找出被隐藏原文」的通道，且同时给出 percent-decoded 形式。
3. **错误遮蔽最长优先**：`packages/gateway/src/mcp/secrets.ts:74` 的排序（`right.raw.length - left.raw.length`）保证短值不会把一个长值替换掉一半；这一条属于 gateway walker，**继续留在 `secrets.ts`**。
4. **错误与恢复**：模块无错误路径、无状态、无排序要求；唯一性能特征是每次调用构造正则/集合，当前调用点均为每次连接/每次列表级别，无需缓存。
5. **隐藏 vs 显式**：隐藏的是「哪些字面量算凭据」的全部规则（523 行）；显式的是 14 个纯函数与 `MaskedValue`/`LiteralSecretField` 两个类型。没有 class、没有 policy 对象、没有依赖注入。

**为什么这比最小补丁更可靠**：最小补丁（方案 B）只把分叉变成被检测的分叉；方案 A 让「同一套规则」成为类型系统与模块边界上的事实，并且顺带把这份文件从 Web 的**未类型检查区**搬进 protocol 的 `include: ["src/**/*.ts"]`（`packages/protocol/tsconfig.json`）。

## 5. Keep / delete / move

| 文件 | 动作 | 依据 |
| --- | --- | --- |
| `apps/web/lib/mcp-secrets.ts`（523 行，实测） | **删除**（内容移到 protocol） | 5 个活跃调用点改 import（`mcp-import.ts:25`、`mcp-import-core.ts:2`、`mcp-import-json.ts:22`、`McpAddServer.tsx:9`、`mcp-add-helpers.ts:31`）；另 2 个休眠调用点（`mcp-config-read.ts:38`、`mcp-test.ts:6`）随 A 的退役一并消失，不单独迁移。该文件当前不在 `apps/web/tsconfig.json` include 内，移走后获得 typecheck |
| `packages/gateway/src/mcp/mcp-secrets.ts`（523 行，实测） | **删除**（内容移到 protocol） | 唯一调用者是 `secrets.ts:1` |
| `packages/protocol/src/mcp-secrets.ts` | **新增**（逐字节副本） | 保 provenance：与 `apps/web/vendor/pi-web/lib/mcp-secrets.ts` 保持相同 md5 |
| `packages/protocol/package.json` | 加 `"./mcp-secrets"` subpath | 与 `@hepi/session` 的 `"./browser"` 同形 |
| `packages/gateway/src/mcp/secrets.ts`（93 行） | **保留**，只改第 1 行 import 为 `@hepi/protocol/mcp-secrets` | 它是本仓库自有的 walker：`literalSecrets`/`createRedactor`/`maskedEntry`，`MASK_MIN_LENGTH = 4`、`\b` 词边界、`Bearer/Basic/Digest/Token` 方案词。**不要**与 Web 的 `mcp-test.ts:186-269` redactor 合并（后者 `MASK_MIN_LENGTH = 6`、lookbehind 词边界、还要保留 `shown` 替换文本） |
| `packages/gateway/package.json` | 加 `"@hepi/protocol": "workspace:*"` | 当前无此依赖；lockfile 需同步更新 |
| `apps/web/vendor/pi-web/lib/mcp-secrets.ts` | **保留** | provenance；被 `SKIP_DIRS`（`scripts/lib/discovery.mjs:21`）跳过，无调用者。它是「移动时未改写」这一事实的唯一外部锚点 |
| `packages/gateway/vendor/pi-web/LICENSE` | **保留** | MIT 文本，迁移后仍然适用 |
| `packages/client/THIRD_PARTY_NOTICES.md:25` | 改路径文字 | 现在写「copied byte-identically into packages/gateway/src/mcp/mcp-secrets.ts」 |
| `packages/client/scripts/build.mjs:68` | 保留（可改文字） | `pi-web MCP masking rules  Copyright (c) 2026 agegr` 通知必须随 bundle 走；`packages/client/scripts/smoke-pack.mjs:173` 断言其存在 |
| `docs/upstream-sources.md:133-141` | 改路径 | 记录新的唯一副本位置，并说明 gateway `secrets.ts` 仍是自有 walker |
| `docs/mcp-on-the-web-host.md:18` | 改路径 | 同上 |

**许可与 provenance**：pi-web 固定 revision `76bdc57027172eb381a216d647225a6d24f23360`（`docs/upstream-sources.md:20`），MIT / Copyright (c) 2026 agegr。迁移**不改变**许可义务：`@hepi/client` 仍把 gateway 源码 bundle 进 `dist/cli.js`（`packages/client/scripts/build.mjs`，esbuild `bundle: true`、`legalComments: "eof"`），通知（`packages/client/scripts/build.mjs:68` 注入的 `pi-web MCP masking rules  Copyright (c) 2026 agegr`）仍随产物走，并由 `packages/client/scripts/smoke-pack.mjs:173` 断言——**该断言是发布物的硬要求，必须继续通过**。

`packages/protocol` 是 `private: true` 且 `files` 不含发布产物，因此**不产生独立的 npm 包发布物，也就没有「这个包自己带一份 notice」的问题**。这**不是**义务豁免：下游产物（`@hepi/client` 的 `dist/cli.js`，以及 Web/Gateway 镜像）仍然内联或链接这份 MIT 代码，上述通知与 `docs/upstream-sources.md:133-141`、`packages/client/THIRD_PARTY_NOTICES.md:25` 的路径文字必须同步更新并继续成立。

**「逐字节未改写」的证明属于搬迁步骤，不是永久行为测试。** 搬迁时记录 `sha256sum`（`982c17fe8ddbef7f228c46db2aabbc40a1a38dfb0dd292af28ca2b6e7cedea4d`，vendored 锚点）并在 `docs/upstream-sources.md` 写明即可。**不要求**在 protocol 套件里长期断言与 `apps/web/vendor/pi-web/lib/mcp-secrets.ts` 字节相等：那会把一次迁移证据变成对上游快照的永久契约，并且是在做源码清单式测试，而不是行为契约（先例 `apps/server/test/session-search.test.ts:254` 是常量对照，不是文件等同断言）。保留的意义在于**行为**：掩码矩阵用例继续在 protocol 里跑，产物通知继续被 `smoke-pack` 断言。**可选的**未改写校验可以留在 `scripts/` 或一次性搬迁说明里，不进完成门。

**打包/发布约束**：

- Web：`apps/web/package.json` 已有 `"@hepi/protocol": "workspace:*"`；`deploy/docker/web.Dockerfile:23-26` 已 `COPY packages packages`，所以 Web 镜像无需新改动（`docs/19d7cda-deployment.md:10-16` 记录过缺此 COPY 的构建失败）。
- Gateway：部署形态是**预构建的 `@hepi/client` bundle**（在 workstation 上 esbuild 打包，再送到目标机），因此 `@hepi/protocol` 在打包时被解析并内联，目标机无需安装依赖——符合 AGENTS.md「不在 remote-host 上编译/安装」的硬约束。只有「从源码跑 gateway」（`packages/gateway/package.json:11` 的 `node src/main.ts`）才需要在工作站执行一次 `pnpm install`（纯 TS 包，无原生编译）。
- **DB / wire 影响：无。** 不新增协议字段、不改 `POST /v1/mcp` 载荷、不动 SQLite。浏览器侧 import 图只增加一个既有 workspace 包路径。

## 6. 过度设计审查（ponytail，REVIEW 模式）

- `yagni:` 新建 `@hepi/mcp-secrets` 包。一个模块、一组调用者。用 `@hepi/protocol` 的 subpath 即可。
- `yagni:` 引入 `MaskingPolicy` 类 / `Redactor` 接口 / 可注入规则表。全部导出都是纯函数，没有任何一处需要变化；这是 `codebase-design` 明确警告的「one adapter means a hypothetical seam」。
- `delete:` Web 侧留 `apps/web/lib/mcp-secrets.ts` 作为 re-export 转发文件（crumb）。5 个活跃调用点直接改 import，少一个文件、少一层。
- `delete:` 把 Web `mcp-test.ts:186-269` 的 `createTestRedactor` 与 Gateway `secrets.ts` 的 `createRedactor` 合并成一个。两者需求不同（显示替换文本 vs 原文切分；词边界语义不同；最短长度 6 vs 4），合并会把两处策略耦合，并把 gateway 的 `literalSecrets` 暴露给浏览器。**不合并**：Web 那份随 A 退役（见下一条），Gateway 那份保留为唯一活跃实现。
- `delete:` 恢复 `apps/web/vendor/pi-web/lib/mcp-secrets.test.mjs` 的 10 个上游用例到 Web 套件。Web 套件已刻意收敛（`.scratch/web-test-value/settings-report.md:31` 记录该文件的 2 个用例是保留项，上游 token 品牌清单已退役）。在 protocol 保留这 2 个合并用例即可。
- `retire:`（与 A 联动，**不要**当作活跃策略维护）`apps/web/lib/mcp-test.ts:186-269` 的 `createTestRedactor` 及其 `MASK_MIN_LENGTH = 6`/`AUTHORIZATION_SCHEME` 规则，属于 A 报告认定的休眠 Web 运行时（`A-web-runtime-retirement.md:41`；该模块因悬空 `./model-runtime` 本就无法加载）。它**不是**需要与 protocol 或 gateway 对齐的第二份策略：唯一活跃的遮蔽实现是 gateway `secrets.ts` 的 `createRedactor`。E 的搬迁**不**为它保留兼容层，也不把它迁进 protocol；它的规则随 A 的删除一起消失。
- 不新增任何「策略加载器」「规则注册表」「默认掩码表」。
- 不为 523 行文件做行数净减估计：**迁移是中性的**，唯一确定的收益是「同一份 523 行只存在一次」。

## 7. 在公开 Seam 上的验证

关键行为（迁移必须逐条不变）：URL userinfo/query/path 遮蔽且保留公共文本；`${VAR}` 引用与 `!command` 不被遮蔽；`--token X`/`-k X`/header/连接串/裸 token 遮蔽；`urlSecretParts` 给出原文与 percent-decoded 形式；`literalSecretFields` 分类；Gateway 报告里最长优先遮蔽；Web 面板与 Test 结果的 preview 不出现字面密钥。

保留/替换的测试：

| 测试 | 处置 | 位置理由 |
| --- | --- | --- |
| `apps/web/lib/mcp-secrets.test.mjs`（2 个用例，含掩码矩阵 + 分类） | **移到** `packages/protocol/test/mcp-secrets.test.ts`（用例原样，不加字节对照） | 被测模块的新所有者；行为契约随模块走 |
| `packages/gateway/test/mcp.test.ts`（10 个用例，含 `mcp.test.ts:191-209` 失败原因遮蔽、`:353-377` 后端不泄漏 canary） | **保留** | 走真实 `POST /v1/mcp`，是 gateway `secrets.ts` 的正确 seam |
| `apps/web/components/mcp-add-helpers.test.mjs`（`:20-40` 拒绝字面项目密钥、preview 掩码） | **保留** | Web 面板的真实调用者 |
| `apps/web/lib/mcp-import.test.mjs` + `mcp-import.integration.test.mjs`（6 个用例） | **保留** | 导入器是 `mcp-secrets` 的主要浏览器调用者 |
| `apps/web/vendor/pi-web/lib/mcp-secrets.test.mjs` | **不运行**（vendor 被跳过） | provenance |

焦点检查（不在 remote-host 上构建）：

```
pnpm --filter @hepi/protocol test && pnpm --filter @hepi/protocol typecheck
pnpm --filter @hepi/gateway test && pnpm --filter @hepi/gateway typecheck
pnpm verify --profile=fast          # typecheck + workspace tests
pnpm verify --profile=full          # 加 Web 套件
pnpm --filter @hepi/client build && pnpm --filter @hepi/client smoke:pack
```

Web 套件基线为 **64 文件 / 111 测试**（`docs/verification.md:9`，实测文件数 64）。迁移后应为 **63 文件 / 109 测试**（移走 `lib/mcp-secrets.test.mjs` 的 2 个用例），套件保持精简，**不新增 Web 测试**。

回滚/切换：纯搬迁，无 wire/DB 变更，回滚即 revert 提交。切换顺序：(1) 加 `packages/protocol/src/mcp-secrets.ts` 与 subpath；(2) 加 gateway 的 workspace 依赖并 `pnpm install`（仅工作站）；(3) 改 5 个活跃 Web import + `packages/gateway/src/mcp/secrets.ts:1`；(4) 删两份副本；(5) 更新 notices/docs；(6) 跑上述检查。完成判据：两份副本不存在；`rg 'mcp-secrets' apps/web packages/gateway/src` 只命中 `@hepi/protocol/mcp-secrets`；掩码矩阵用例在 protocol 通过；client bundle 通知断言（`smoke-pack.mjs:173`）通过；Web 与 Gateway 套件无回归。字节未改写只需在搬迁记录/文档里留证，**不作为长期测试门**。

## 8. 依赖与交互（A–F）、未决项

- **与 D（中性契约）**：本报告推荐的落点（`@hepi/protocol` 的 subpath）与 D 可能选择的「中性契约放 protocol」一致。若 D 为其它浏览器安全纯模块引入同一 `"./<name>"` subpath 约定，E 应跟随该约定，而不是把掩码塞进根 `index.ts`。**需要 D 先确认 subpath 还是根导出。**
- **与 A/B/C/F**：无冲突。E 不触碰 projection frame、不触碰 gateway 组合、不触碰 terminal 投递。E 只增加 `packages/gateway → @hepi/protocol` 一条依赖边（如果其它报告也要这条边，一次加齐）。
- **未决**：`packages/client/THIRD_PARTY_NOTICES.md:25` 与 `docs/upstream-sources.md:135` 的文字如何措辞（保留「byte-identical」措辞更诚实，因为副本确实未被修改）；是否把一次性未改写校验留成脚本（**推荐：留在搬迁说明/可选脚本，不进 protocol 套件**——它不是行为契约）。

## 建议

采用方案 A：把 523 行逐字节副本移到 `packages/protocol/src/mcp-secrets.ts`，用 `"./mcp-secrets"` subpath 暴露；5 个活跃 Web import 与 gateway `secrets.ts:1` 改指向它（另 2 个休眠 import 随 A 退役）；删掉两份副本；保留 `packages/gateway/src/mcp/secrets.ts` 作为自有 walker（最长优先遮蔽留在那里）；保留 vendored provenance 与 MIT 通知（含 `smoke-pack` 断言）；把现有掩码矩阵用例移进 protocol，字节未改写只作为搬迁证据。

顺序：**等 D 确认 subpath 约定 → 一次提交完成搬迁与文档/通知更新 → `pnpm verify --profile=full` + client `smoke:pack`。** 不要引入 policy 类、不要新建包、不要合并两个 redactor。
