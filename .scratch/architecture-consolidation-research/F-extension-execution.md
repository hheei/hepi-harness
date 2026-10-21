# F — 可扩展执行契约（Extension / Registry / ToolRegistration / wraps / ExecutionEnv）

Baseline: `caf6a319177554f3fcc53e6a4efc6683a1a3e433`。研究阶段：无实现、无部署、无图重建。本版本已按父级复核修正以下判断：`forCall` 的声明状态、包装扩展的命名与选择原子性、`api.env` 收窄的正确写法、作用域计数器的归属、"多次 exec"缺陷的触发条件、以及此前未实测的行数估计。

安装版本：`@earendil-works/pi-durable@1.1.0`（`apps/server/package.json:25`、`packages/gateway/package.json:16`）、`@earendil-works/pi-coding-agent@1.1.0`、`@earendil-works/chord@1.1.0`。

---

## 1. 结论与问题定位

### 1.1 真正的问题：执行身份挂在一个**两份类型声明里都不存在**的成员上

只有两处代码把 durable 调用身份交给执行环境：

- `apps/server/src/harness.ts:70-73`：安装 `CodingTools` 的**副本**，把每个工具的 `execute` 换成读 `api.env.forCall` 的包装，用 `${api.conversationId}:${api.taskId}:${api.callId}` 造出新 env。
- `packages/gateway/src/environment.ts:33`：`forCall: (callId: string) => gatewayEnvironment(binding, cwd, callId)` —— 它是局部对象 `supported` 上的一个**运行时属性**。

`forCall` **在两侧都没有声明**：

- 上游 `ExecutionEnv`（`pi-durable dist/env/index.d.ts:259`，`interface ExecutionEnv extends FileSystem, Shell`）没有该成员。
- 本仓库自己的 `ExecutionHostEnv`（`environment.ts:13-20`）**只有** `executionHost` 与 `resourceSnapshot` 两项，同样没有 `forCall`。

返回值在 `environment.ts:102` 经 `as unknown as ExecutionHostEnv` 断言出去，所以这个成员对编译器和任何读类型的人都不可见。这就是 `harness.ts:71` 必须写 `as typeof api.env & { forCall?: ... }` 的原因：**不是风格问题，而是契约缺失**。上一版报告把 `forCall` 说成"存在于自有类型"是错的，此处更正。

### 1.2 分类

| 项 | 分类 | 证据 |
| --- | --- | --- |
| 一次工具调用内多次 `exec` 会互相顶掉身份 | **真实缺陷，但触发有前提**（见 §1.4） | `environment.ts:70-71`、`gateway/src/index.ts:292-295` |
| `forCall` 未声明于上游与本仓库类型 | **契约缺失**（本次修正重点） | `env/index.d.ts:259`、`environment.ts:13-20,33,102` |
| 包装用对象展开复制整个扩展而非原生 `wraps` | **风格/结构债务**（展开本身不是失败点，见 §6） | `harness.ts:70-73` vs `types.d.ts:197-204,211-212` |
| "forCall 传入 durable call ID ⇒ 结果可说明 completed/interrupted/outcome-unknown" | **陈旧/过强表述** | `.scratch/architecture-routes/README.md:35`；语义见 §1.5 |
| 应用没有任何扩展加载器 | **未实现的能力（不是缺陷）** | `pi-config.ts:122`；仓库内无扩展发现/加载代码 |
| `EnvTarget` 不带 `taskId`/`callId` | **上游能力缺口** | `pi-durable dist/harness/types.d.ts:385-390` |

### 1.3 关键机制（已在上游源码核对）

- `EnvTarget = { conversationId, cwd?, read }`（`types.d.ts:385-390`）——**没有 `taskId`，没有 `callId`**。
- 工厂由 `Harness.buildEnv` 实现：`build({ conversationId: id, ...(cwd...), read: this }, context)`（`dist/harness/harness.js:134-139`）。
- 调度器把 env 暴露为 `env: (context) => this.#read(invocation, () => this.#env(invocation.conversationId, context))`（`dist/harness/scheduler.js:1044`）——**每次使用都重新构建，不缓存**。
- 工具任务在执行前重建 env：`const env = await runtime.env(context)`（`dist/harness/tool.js:207`），注释称"Built for this call"。

要点修正：**不能由此断言"一次工具调用恰好一个 env"**。同一个 `runtime.env` 也服务于提示段落渲染（`scheduler.js:1044` 是通用访问器，非工具专用）。因此"每次构建即一次工具尝试"只是常见情形，不是可依赖的 1:1 保证；任何按调用计数的状态必须放进 `forCall` 作用域内，不能假设 env 实例与工具调用一一对应。

工厂能拿到的是**会话身份**，不是**调用身份**。关联只能由 `ToolExecutionApi`（`types.d.ts:113-116`，含 `taskId`/`conversationId`/`callId`）在工具执行点提供——即 `harness.ts:71-72` 的注入点，它是**唯一可用**的位置，不是冗余。

### 1.4 多次 exec 的真实后果与触发前提

`forCall` 的 id 在整个工具调用内是常量。gateway 账本键是 `gatewayId + workspaceId + callId`，并带请求指纹；指纹不同时 `#answer` 返回 `fail("invalid_request", ..., "this call ID was already used for a different request")`（`gateway/src/index.ts:292-295`，指纹由 `fingerprintRequest` 计算，`index.ts:133-135`）。指纹相同的重复请求则从账本作答，**不重跑**。

触发前提（必须同时成立，当前线上**未**触发）：

1. 一个工具在一次调用里发出第二次 `exec`，且命令不同；
2. 已安装的工具确实会多次 exec。

现状核对：`CodingTools` 只含 `read`/`write`/`edit`/`bash`（`dist/tools/index.js:11-13`），`bash` 每个调用只跑一条命令（`runCommand([execution.command], ...)`，`dist/tools/bash.js:91`）——**潜在但未激活**。`createPowerShellTool` 不在 `CodingTools` 内（`index.js:10-13` 明确"nothing installs it automatically"，仅单独导出），它按 `programs` 逐个尝试（`bash.js:39-52`，调用点 `:113-115`）；因此它的触发还需**先被安装**且**第一个程序不可用**导致回退。这是**有条件的缺陷**，不是当前故障。

结论仍然成立：身份粒度是"工具调用"，执行粒度是"命令"，二者不匹配。任何自带工具（例如先 `git status` 再 `git diff`）一旦落地就会踩中。

### 1.5 重试与重放：区分"已证实"与"未证实"

已证实：

- 工具意图在执行前提交并带重放策略：`const intent = { phase: "execute", arguments: final, replay: tool.replay ?? "unsafe" }`（`dist/harness/tool.js:63`）。
- 恢复阶段仅在**存储策略与当前策略都为 `safe`** 时重跑，否则写入 `interrupted`：`if (replay === "safe" && tool?.replay === "safe")` → `run(...)`，否则 `Tool ${call.name} was interrupted and may have partially run`（`tool.js:68-85`）。
- `CodingTools` 的四个工具都没有声明 `replay`（`dist/tools/index.js:11-14`；`defineTool` 是恒等函数，`dist/harness/define.js:6-8`），默认 `unsafe`。所以在当前代码下 **harness 级工具重放不会发生**。
- gateway 账本把遗留的 `admitted`/`dispatched` 行判为 `outcome-unknown`，不重跑（`execution.ts:202` 注释 "This is duplicate protection, not recovery: it does not resume, replay, or reconcile a call"）。
- 端到端证据：`docs/ssh-interruption-verification.md:27-33` 的用例 7/8——重开账本、同一 call ID 再提交，返回 `outcome-unknown`，远端计数器不变，无重放；`:43` 明写 "Duplicate protection is not recovery."

未证实 / 不得断言：

- **"当前不可能再次出现同一个 ID"不成立**。harness 级工具重放不发生，只能说明那条路径不产生重复；传输层重试、调用方重新发起、或调用方自选的 base 都可能复用同一 ID。正确表述是：**同一 gateway/workspace 下、身份记录仍被 ledger 保留时，同一 call ID 不会再次执行**，且答案要么复述记录、要么明确 `outcome-unknown`（`index.ts:292-295`、`execution.ts:202`）。
- **跨尝试身份稳定性未证实**：即便给某工具加 `replay: "safe"`，恢复时 `runtime.env` 会重建 env，而 `EnvTarget` 不带 `callId`，无法保证新 env 生成与上次相同的 exec 身份。上游无任何类型或文档承诺。
- **"工具重跑时 gateway 会用账本作答"未在任何测试或文档中出现**；上游工具恢复测试（`docs/upstream-sources.md:187` 列出的 `harness-tools-recovery.test.ts`）覆盖的是 harness 侧重放策略，不是本仓库的 gateway 账本。

因此 exec 级 exactly-once 从未成立，也不应写成目标。

### 1.6 只读与文件系统操作完全没有身份

`environment.ts:23-29` 的 `rpc` 不带任何 callId；gateway 的 `/v1/files` 路径（`filesystem.ts:313` `execute`）**没有账本**。因此：

- 读操作重复执行幂等（可接受）。
- 写操作在响应丢失时只能报 `FileError("unknown", "gateway unavailable or dispatched filesystem outcome unknown")`（`environment.ts:29`），调用方无法判断是否落盘。这是**已知且显式承认的边界**，必须写进契约。
- 上游 `withFileMutationQueue` 按 `env.id` + 规范化路径串行化 `edit`/`write`（`dist/tools/file-mutation-queue.js:32-33`）。**其注释明确限定范围**："Serialize `edit` and `write` mutations of one file **within this process** ... **Not a lock against `bash` or other processes**"（`file-mutation-queue.js:27-31`）。它既不是跨进程锁，也不是远端写入者的互斥保证。本次改动必须保留 `env.id`（`environment.ts:34`）以免破坏该队列的键，但不能把队列当作全局一致性保证。

### 1.7 未实现的 FS 方法：诚实拒绝，接口不完整

`environment.ts:102` 的 `Proxy` 对任何不在 `supported` 中的属性返回 `{ ok: false, error: FileError("not_supported", "<name> is not enabled by gateway") }`。缺失成员包括 `FileSystem` 要求的 `openDirReader`、`readTextLines`、`openTextLineReader`、`watch`（`dist/env/index.d.ts:129-183`）。上游工具实际只引用 `absolutePath / canonicalPath / exec / exists / fileInfo / id / joinPath / openBinaryReader / readTextFile / writeFile`（对 `dist/tools/*.js` 的 `env.*` 引用穷举）。结论：**有意的能力边界**，保留 `not_supported`，不要为凑接口写假实现。

---

## 2. 当前归属与数据流

```
Conversation(durable)  ──pi.agent.cwd──▶ HarnessOptions.env(EnvTarget{conversationId,cwd,read})
                                              │  (harness.js:134, 每次使用重建；也服务提示段落)
                                              ▼
                                        gatewayEnvironment(binding, cwd)      environment.ts:21
                                              │  .exec()  ── durableCallId??
                                              │            (environment.ts:70-71)
                                              ▼
                                   GatewayRpcClient.execute(ExecuteRequest)   index.ts:1070
                                              │  NDJSON 输出帧 + 1 结果帧
                                              ▼
                              Gateway#execute: ledger.lookup/begin/dispatch/complete   index.ts:169-245
                                              │
                                              ▼
                     LocalGateway(NodeExecutionEnv, inheritEnv:false)  index.ts:361-393
                     SshGateway(runner, spill 不支持)                  index.ts:434-457
```

调用身份注入点在 `harness.ts:71-72`（工具执行点，唯一能拿到 `callId` 处）。

依赖分类：

- **进程内**：`Extension`/`Registry`/`wraps`、工具任务、`ToolExecutionApi`、`withFileMutationQueue`（进程内，见 §1.6）。可直接依赖上游类型。
- **本地可替换**：`LocalGateway`（`index.ts:334`）+ `NodeExecutionEnv`（`inheritEnv:false`，`index.ts:372`）、`MemoryLedger`。
- **远端自有**：`SshGateway` + `GatewayExecutionJournal`（SQLite，`startup.ts:143`）；SSH 明确不支持 spill（`index.ts:414, 429-432, 454`）。
- **真正外部**：`pi-durable@1.1.0` 的 `Harness`/`Registry`/`ExecutionEnv` 契约，定义本报告全部边界。

---

## 3. 方案比较

### 路线 A：原生 `wraps` + 显式 `forCall` + 作用域内序号（推荐）

用 `Extension.wraps` 替换 `harness.ts:70-73` 的"复制扩展并逐个替换 `execute`"。原生机制已核对有效：`Wrap` 按工具名寻址（`types.d.ts:197-204`），`wrapTool` 用 `tool.name` 构造（`define.js:17-20`），`resolveAgent` 在组合工具表上按扩展顺序套用（`agent.js:148-155`），`applyWrap` 在包装抛错或改名时删除该工具并上报（`agent.js:206-220`）。`Extension.wraps` 的语义是"**Apply where this extension is selected, in order**"（`types.d.ts:211`）。

**关键决定：包装必须与被包装的工具同名同选，即仍用扩展名 `coding-tools`。** 理由：

- 扩展选择按名字从存储状态解析（`agent.js:137-142` `selectExtensions(state.extensions, ...)`）。独立名字（例如 `environment-call-scope`）需要被每个会话单独选中；漏选时工具照常工作但**静默失去调用关联**。
- `server.ts:988` 用 `materializeSelection(installed, storedDefault, workspaceId === undefined ? [ENVIRONMENT_EXTENSION] : [])` 在无工作区时**只**扣留 `ENVIRONMENT_EXTENSION`，`:1002-1003` 据同一名字返回 409 `unavailable_extension`。换名字会使这两处判定失效或需要额外同步。
- 因此：构造 `{ ...CodingTools, wraps: [...] }`，保留 `name: "coding-tools"` 与原始 `tools` 元数据，**用这一个扩展同时携带工具与包装**，选择与扣留语义天然原子。`harness.ts:17` 的 `ENVIRONMENT_EXTENSION = CodingTools.name` 因此保持正确、无需改动。

其余两点：让 `forCall` 接收**调用身份**（不再是裸字符串），由 env 内部为每次 `exec` 追加序号；`Proxy` 兜底保持原样。跨尝试稳定性仍不成立（§1.5），必须显式声明。

### 路线 B：上游把 `callId`/`taskId` 放进 `EnvTarget`，彻底删掉 `forCall`

`EnvTarget`（`types.d.ts:385-390`）增加可选身份字段后，`buildEnv`（`harness.js:134`）可自然为每次构建注入身份，应用侧无需包装、无需私有方法。**结构上最正确**，因为 env 本来就是按次构建的。代价：依赖上游发版；在获得该能力前，路线 A 是过渡形态。

### 路线 C（否决）：用 `HookRegistration`/`ToolHooks` 注入 env

`ToolHooks.beforeTool(call, api: HookApi, ...)`（`types.d.ts:572-577`），而 `HookApi` 只有 `taskId`/`conversationId`/`models`/`memo`（`:545-552`）——**没有 `env`，也没有替换 env 的返回值**（只能改 `arguments` 或 `block`）。**能力缺失，非偏好问题。**

### 路线 D（否决）：应用自建插件管理器 / 兼容 Pi CLI ExtensionAPI

`pi-coding-agent` 的 `ExtensionAPI`（`dist/core/extensions/types.d.ts:1162, 1494`）是事件注册面（`on("session_start", ...)`、`registerTool`、`registerProvider`），运行在 Pi CLI 会话里，与 durable `Extension` 无共享契约。`pi-config.ts:122` 已把 settings.json 的 `extensions`/`packages` 列为不转发项，`docs/pi-config.md:66` 明确 "Extensions, Pi packages and MCP are never loaded, installed or connected by this adapter"。ADR 0001（`docs/adr/0001-single-authoritative-durable-runtime.md:10`）已拒绝平行运行时。**不做。**

---

## 4. 目标接口（TypeScript 草图、调用者、不变量）

### 4.1 声明的执行身份契约与作用域计数器

```ts
// packages/gateway/src/environment.ts
export type ExecutionIdentity = {
  readonly conversationId: string;
  readonly taskId: string;
  readonly callId: string;
};

/**
 * The extra methods are what make the host and the resource scope of the machine behind the environment available
 * to the runtime. `forCall` scopes one tool call: it is declared here, not only present at runtime.
 */
export type ExecutionHostEnv = ExecutionEnv & {
  executionHost(context: Context): Promise<Result<ExecutionHost, FileError>>;
  resourceSnapshot(context: Context): Promise<Result<ResourceSnapshot, FileError>>;
  /**
   * One execution scope per tool call. The n-th `exec` on the returned environment uses `${base}#${n}`, so two
   * commands in one tool call are two identities. Ordinals are local to the returned environment and are not a
   * promise that a later attempt reuses the same identity: see §1.5.
   */
  forCall(identity: ExecutionIdentity): ExecutionHostEnv;
};

export function gatewayEnvironment(
  binding: EnvironmentBinding,
  cwd = "/",
  scope?: { readonly base: string },     // replaces durableCallId?: string
): ExecutionHostEnv {
  const client = new GatewayRpcClient(binding.gatewayOrigin, binding.gatewayToken);
  // ... rpc / absolute / supported 不变 ...
  let ordinal = 0;                       // lexical counter of THIS environment instance; no `this`
  const supported = {
    forCall: (identity: ExecutionIdentity) =>
      gatewayEnvironment(binding, cwd, {
        base: `${identity.conversationId}:${identity.taskId}:${identity.callId}`,
      }),
    id: binding.gatewayId + ":" + binding.id, cwd,      // preserved: withFileMutationQueue keys on env.id
    // ...
    async exec(command, options, context) {
      const callId = scope === undefined
        ? crypto.randomUUID()                            // no scope: same as today, no dedup claim
        : `${scope.base}#${++ordinal}`;                 // one identity per command in this scope
      // ... 其余不变 ...
    },
    cleanup: async () => {},
  };
  return new Proxy(supported, { /* 原样保留 environment.ts:102 */ }) as unknown as ExecutionHostEnv;
}
```

不变量：

1. 计数器是 `forCall` 所返回的那个 env 实例的**词法变量**，随实例创建而重置；不用 `this`，不存在未声明字段或 `NaN`。
2. `scope === undefined` 时行为与今天完全一致（随机 UUID），即"未声明身份 ⇒ 不做去重承诺"。
3. `id` 与 `cwd` 在作用域 env 中保持不变（`environment.ts:34`），维持 `withFileMutationQueue` 的键。
4. 错误语义不变：abort-before-dispatch 返回 `ExecutionError("aborted")`（`environment.ts:86`）；gateway 对先到 abort 的 call ID 记 `refusals`（`index.ts:179-185, 255-268`，`REFUSAL_TTL_MS` 60s，`:98`）。
5. 成本：每次 `exec` 一次字符串拼接与自增；env 本就按次重建，无新增对象图。

### 4.2 应用侧改用同名扩展 + 原生 wraps（替换 `harness.ts:70-73`）

```ts
// apps/server/src/harness.ts
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { wrapTool, type Extension, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ExecutionHostEnv } from "@hepi/gateway";

/**
 * The environment scope of one tool call, applied where `coding-tools` is selected. The wrapping extension keeps the
 * name of the tools it wraps, so selection and the workspace check that names it stay one decision.
 */
const scopedCodingTools: Extension = {
  ...CodingTools,                                   // keeps name "coding-tools" and the original tool metadata
  wraps: (CodingTools.tools ?? []).map(tool =>
    wrapTool(tool as ToolRegistration, (target) => ({
      ...target,                                    // name unchanged: a rename makes applyWrap drop the tool
      execute: (args, api, context) => target.execute(args, withCallScope(api), context),
    }))),
};

/** Narrow by runtime check: a plain `ExecutionEnv` has no `forCall`, and no environment stays no environment. */
function withCallScope(api: ToolExecutionApi): ToolExecutionApi {
  const env = api.env as (ExecutionEnv & Partial<Pick<ExecutionHostEnv, "forCall">>) | undefined;
  if (env === undefined) return api;                 // no workspace: leave it undefined for requireEnv to report
  if (typeof env.forCall !== "function") return api; // NodeExecutionEnv / test envs: pass through untouched
  return {
    ...api,
    env: env.forCall({
      conversationId: String(api.conversationId),
      taskId: String(api.taskId),
      callId: api.callId,
    }),
  };
}
```

安装处（`harness.ts:70` 位置）：

```ts
if (env) install(scopedCodingTools);   // same extension name, tools + wraps together
```

修正说明（针对上一版草图的错误）：上一版写 `(api.env as ExecutionHostEnv | undefined)?.forCall({...})`——它只检查 `api.env` 是否存在，却断言了 `forCall` 的存在；在 `NodeExecutionEnv`（`dist/env/node.d.ts`，实现 `ExecutionEnv` 且无 `forCall`）上会抛 `TypeError`。现在改为**两个运行时检查**（env 是否存在、`forCall` 是否为函数），两条不满足路径都原样透传，包括 `env === undefined`。

其他不变量：

1. 扩展名保持 `coding-tools`，故 `ENVIRONMENT_EXTENSION`（`harness.ts:17`）与其在 `server.ts:988,1002-1003` 的语义引用**均不改动**。
2. 包装体不改变工具名，否则 `applyWrap` 会删除该工具（`agent.js:212-213`）。
3. `api.env === undefined` 时透传，工具仍由 `requireEnv` 报"No execution environment is configured"（`dist/tools/env.js:2-5`）。
4. 无工作区会话在创建期即被 409 拒绝（`server.ts:1002`），因此 `forCall` 缺失路径主要出现在测试与本地 env。

### 4.3 目标（需要上游）：`EnvTarget` 增加身份

```ts
export type EnvTarget = {
  readonly conversationId: ConversationId;
  readonly cwd?: string;
  readonly read: DocumentReader;
  readonly taskId?: TaskId;      // 提案，未实现
  readonly callId?: string;      // 提案，未实现
};
```

若上游接受，`gatewayEnvironment` 可在工厂直接获得身份，§4.1 的 `forCall` 与 §4.2 的包装可一并删除。**在 1.1.0 上不可用**，故 §4.1+§4.2 是可立即交付的形态。未向上游提交，意向未证实。

---

## 5. 保留 / 删除 / 移动

| 文件:行 | 动作 | 调用者 | 外部兼容 / 许可证 / DB-wire 影响 |
| --- | --- | --- | --- |
| `apps/server/src/harness.ts:70-73` | **替换**：对象展开 + 逐个覆盖 `execute` → 同名扩展携带原始 `tools` + 原生 `wraps` | `openServerHarness`（`:39`），经 `server.ts:956` | 无 wire/DB 影响；行为契约不变 |
| `apps/server/src/harness.ts:17` | **保留不动**（名字未变） | `server.ts:15, 988, 1002-1003` | 无 |
| `apps/server/src/harness.ts:71` 的类型断言 | **删除**（被 `withCallScope` 的运行时收窄取代） | — | 无 |
| `packages/gateway/src/environment.ts:13-20` | **新增声明**：`ExecutionHostEnv` 增加 `forCall(identity)` | 唯一调用者：`harness.ts` 包装层 | 纯类型，无运行时影响 |
| `packages/gateway/src/environment.ts:21` | **改签名**：`durableCallId?: string` → `scope?: { base: string }` | 见下 | 内部 API；无 wire 影响 |
| `packages/gateway/src/environment.ts:33` | **改**：`forCall` 接收 `ExecutionIdentity`，返回带 base 的作用域 env | 包装层 | 无 |
| `packages/gateway/src/environment.ts:70-71` | **改**：`callId` 由 `scope.base` + 词法序号生成 | — | 改变 `ExecuteRequest.callId` 取值，gateway 账本键与指纹随之变化；**仅进程内语义，不跨版本复用旧 ID** |
| `packages/gateway/src/environment.ts:102` `Proxy` 兜底 | **保留不动** | — | 无 |
| `packages/gateway/src/execution.ts:38-39, 202-204, 290+` | **保留不动** | `startup.ts:143` | DB schema 不变；语义 = 去重非恢复 |
| `apps/server/src/pi-config.ts:122` | **保留**（`extensions` 仍在忽略列表） | `unsupportedWarnings` | 无 |
| `apps/server/src/server.ts:966, 986-1005` | **保留**（注册表是唯一权威；选择仍按名） | 多处 | HTTP 响应字段不变 |

调用点核对（全部实查，未运行任何测试）：

- 传第 3 个参数的只有 `packages/gateway/test/execution.test.ts:101`（`"env-await-1"`）——**必须随签名更新**（改为 `{ base: "env-await-1" }`）。
- 其余调用只用 1–2 个参数，不受影响：`server.ts:959, 1079, 1198, 1242`；`skill-install.ts:477, 639`；`scripts/diag-rpc-count.ts:136`；`apps/server/test/resource-snapshot.test.ts:63`；`apps/server/test/gateway.test.ts:63`；`packages/gateway/test/execution.test.ts:335`。
- `forCall` 的调用者只有 `harness.ts:71-72` 一处（`rg -n forCall apps packages scripts` 的全部结果）。

**不给出净行数估计**：改动集中在 2 个源文件、1 处测试调用点；具体行数未实测，上一版"约 8–10 行 + 约 6 个签名"的说法已撤销。不新增文件、不新增依赖、不新增数据库表、不改 HTTP 字段。

---

## 6. 过度设计审计（ponytail REVIEW 模式）

- **保留**：`{ ...CodingTools, wraps: [...] }` 的对象展开本身**不是失败点**——保留原始 `name` 与 `tools` 元数据正是 §3 路线 A 的要点。要替换的只是"把每个 `execute` 手写覆盖"，改为原生 `wraps`。上一版把展开本身当债务，措辞过头，此处更正。
- **删除**：`harness.ts:71` 的 `as typeof api.env & { forCall?: ... }` 断言，被 §4.2 的运行时收窄取代。
- **不要**给包装扩展起独立名字（`environment-call-scope`）：会造成选择/扣留两套判定，并可能静默丢失关联（§3）。
- **不要**把 `forCall` 升级成通用 "CallContext"/"ExecutionScope" 框架：只有一个消费者。
- **不要**为缺失的 `openDirReader`/`watch`/`readTextLines` 写实现：上游工具不用，`Proxy` 已诚实报 `not_supported`。
- **不要**引入扩展加载器、插件清单、版本解析或 Pi CLI `ExtensionAPI` 兼容层：无消费者，且被 ADR 0001 与 `docs/pi-config.md:66` 排除。
- **不要**为"工具重放"造应用层幂等表：上游已有 `replay` 策略（`tool.js:63, 73`）与 gateway 账本（`execution.ts:202-204`）；第三份真相只会冲突。

---

## 7. 公共接缝上的验证

1. **单次工具调用内两次 exec 不再互相顶掉**（本次缺陷的回归点，且**当前是条件性缺陷**，见 §1.4）。可在 `packages/gateway/test/execution.test.ts` 直接用 `gatewayEnvironment(binding, "/", { base: "scope-1" })` 断言：同一作用域内两次不同命令都成功，且两次 `callId` 不同。若要覆盖端到端，扩展现有 `apps/server/test/gateway.test.ts:15`（已用 faux provider 驱动真实 `LocalGateway` + `GatewayRpcServer`）。
2. **同一 call ID + 不同命令被拒为 `invalid_request`**：已覆盖，`index.ts:292-295` 分支 + `execution.test.ts` 的 `durable-1`（`:245`）、`once-1`（`:190`）。新增用例只断言"同一 base 下不同序号不被误判"。
3. **abort-before-dispatch / abort-while-running**：`execution.test.ts:218`（"refuses a call aborted before it was admitted, and stops one that is running"）可直接复用。
4. **重启后 `outcome-unknown` 不重放**：`execution.test.ts:266`（`interrupted-1`）与 `docs/ssh-interruption-verification.md:32-33`。改动后必须重跑并保持为真。
5. **纯 `ExecutionEnv` 透传**：`NodeExecutionEnv` 路径（`packages/gateway/test/execution.test.ts:335` 及 `apps/server/test/resource-snapshot.test.ts:63`）必须仍能工作——新增断言"无 `forCall` 时工具照常执行"，这正是上一版草图会抛 `TypeError` 的位置。
6. **无工作区时不崩溃**：`apps/server/test/extensions.test.ts` 已覆盖 `unavailable_extension` 409 与 `workspace-resources` 缺省（`:200-210`）。
7. **扩展安装失败可见**：`extensions.test.ts:215`（`broken-extension`）。因包装保持同名，既有断言无需改动。
8. **本地/SSH 双适配**：`execution.test.ts:160`（SSH runner 背压）、`:368`（SSH spill 不支持）。SSH 无 spill（`index.ts:429-432`）属预期，不得因本次改动改变。

回滚与完成判据：

- 回滚：2 个源文件 + 1 处测试调用点，无迁移、无 schema、无 wire 字段变化，可直接 revert。
- 完成：`pnpm verify:changed --base=caf6a31` 通过；`apps/server/test/gateway.test.ts`、`apps/server/test/extensions.test.ts`、`packages/gateway/test/execution.test.ts` 全绿；新增第 1、5 条用例通过。
- 不做：不新增 web e2e，不跑全量套件，不在 remote-host 上构建。

---

## 8. 与 A–F 的依赖、未决问题、建议顺序

交互：

- **A（web runtime 退役）**：一致，不引入平行运行时。
- **B（原生 web conversation）**：无直接耦合；若 B 改变会话创建路径，需确认 `server.ts:986-990` 的 `selectionFor` 仍写入 `pi.agent.extensions`。
- **C（window fold）**：无耦合。
- **E（MCP secret policy）**：无耦合，但同属"能力边界必须显式声明"；本报告的 `not_supported` 处理可作同类先例。

未决问题（记录，不在本报告内解决）：

1. **上游是否接受 `EnvTarget.taskId/callId`**——决定 §4.3 能否替代 §4.1+§4.2。未提交，未证实。
2. **是否需要 `replay: "safe"` 的工具**——当前无一工具声明，故"跨尝试身份稳定"是**未验证路径**；在引入第一个 `safe` 工具前，不得把"重试后同 ID 复用"写成保证。
3. **账本容量**：`MemoryLedger` 有 `maxEntries`/`maxBytes`（`execution.ts:224-243`），`GatewayExecutionJournal` 有 `maxBytes`/`maxCalls`（`:290+`）。淘汰后旧 call ID 变 `outcome-unknown` 墓碑。改动会使每次工具调用产生 N 个 ID 而非 1 个，**对淘汰率的影响未测量**，部署时应观察。

建议顺序：

1. **先做 §4.1 + §4.2**（声明 `forCall`、作用域内序号、同名扩展的原生 `wraps`）。这是可立即交付、修复条件性真实缺陷、并消除一处私有约定的最小完整改动。
2. **同步更新 `packages/gateway/test/execution.test.ts:101`** 的第三个参数。
3. **并行**向上游提出 `EnvTarget` 身份字段提案（§4.3）；若接受，第 4 步是纯删除。
4. 在引入第一个 `replay: "safe"` 工具**之前**补一条"重放时 exec 身份"的验证；在那之前不把重试身份稳定性写入文档。
5. **不做**插件管理器、Pi CLI `ExtensionAPI` 兼容层、缺失 FS 方法的假实现、应用层幂等表。

关键论断均可在上述 path:line 或安装包 `dist/` 对应文件复核。§1.5 标为"未证实"的三项是上游未承诺、本仓库无测试覆盖的部分，实现者不得据其推断保证。
