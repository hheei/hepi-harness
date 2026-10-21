# 性能研究：大文本帧预算、资源树规模、搜索规模、已加载历史成本

研究范围：审计"剩余限制与待测项"1–4（2026-10-14 审计的性能章节）。只做研究：不改业务源码/测试，不部署、不 push、不 commit。
基准 revision：`1758c1fb4479e9d4637a957857246c5998619d73`（HEAD）。运行环境：workstation，Node v26.5.1，pnpm 12.4.1，隔离 SQLite + 本地临时目录 + ephemeral 端口。

历史测量说明：以下数值与失败属于上述被测源码。大文本恢复与分页问题后来已修复，见 [设计修复结果](../design-fixes/results.md) 和 [当前 Chat 合同](../../docs/chat.md)。资源树、搜索与已加载 DOM 测量仍保留原样；本报告不宣称它们已被优化。

## 0. 可复现性与脏状态

- 探测脚本（版本化）：`.scratch/development-audit/perf-probes/*.mjs`，公共库 `lib/probe-lib.mjs`、解析钩子 `lib/register.mjs` + `lib/resolve-hook.mjs`。实验脚本不需要额外的 `node_modules` 符号链接：`node --import ./lib/register.mjs <probe>.mjs` 会让裸导入回退到 `apps/server` 的依赖树解析。运行时产物（日志/结果 JSON/临时 SQLite）全部在 git-ignored `.dev/research-performance/`。
- 被测源码脏状态：`git status --porcelain apps/server/src packages/gateway/src apps/web/lib/session-view-cache.ts` 为空 → 本报告所有后端/网关/缓存测量都是针对与 HEAD 一致的上述目标源码运行的。工作区整体是脏的（36 项，集中在 `apps/web/components`、`apps/web/hooks`、docs、`packages/client`，属并发 worker 的 Settings/文档/CLI 工作），不影响上述路径。
- 每个探测的 exit code、日志路径与结果路径见 §9。

## 1. 主题一：纯文本与帧预算（512 KiB 软 / 960 KiB 硬）

### 1.1 结论先行

1. 真正决定成败的是 **帧硬预算 `FRAME_LIMIT_BYTES = 1 MiB − 64 KiB = 983,040 B = 960 KiB`**（传输层 1 MiB 守卫前的余量）；512 KiB 是**软目标**，只决定窗口保留多少条目，不决定拒绝。**审计原文并未把它写成 500 KB 硬限制**——审计该条明确警告「不能误写为 500KB 硬限制」，本线测量与这条警告一致。
2. 被拒绝的阈值不是 960 KiB 文本，而是**本夹具的 472.93–473.67 KiB 文本**：`ServerEntry` 同时带 `text` 和 `message`，同一段文本在线上出现两次，实测放大 **2.03×**。所以这段文本在本夹具中接近960 KiB帧边界。**该区间是夹具特有的**（帧字节含 JSON 转义开销，随内容变化），不是可外推的常数。
3. **正常 agent 工具路径（read/bash/ls/grep/find）到不了这个量级**：pi-coding-agent 的默认输出上限是 50 KiB / 2000 行，pi-durable 的工具结果再经 `OutputBuffer` + `boundContent` 以同一上限裁剪。实测把 5 MiB 输入喂给真实函数：`truncateTail` 51,155 B、`truncateHead` 51,127 B、`OutputBuffer` 51,155 B（丢弃 5,191,725 B）、`boundOutput` 51,155 B。**不能把合成的大 tool-result 条目当成正常工具缺陷**。
4. 能触发的是 **用户大段粘贴**：`validateCommand` 对 `text` 没有长度上限，唯一上限是请求体 `MAX_SUBMISSION_BODY_BYTES ≈ 141 MiB`。1.5 MiB 粘贴实测被 202 接受并落库。
5. 触发后的恢复是**部分恢复**：新的一轮小回复会把窗口收缩到"只剩最新条目"，会话能重新打开；但那条大消息本身、以及它之前的导航被卡住（见 1.3）。

### 1.2 实测：窗口与拒绝

命令：`node --import ./lib/register.mjs probe-frame-text-budget.mjs`（exit 0），`probe-frame-text-followup.mjs`（exit 0）。
日志：`.dev/research-performance/logs/frame-text-budget.log`、`.../frame-text-followup.log`；结果：`.../results/frame-text-budget.json`、`.../frame-text-followup.json`。

| 最新条目文本 | `/state` | 帧字节 | 窗口条目 | 页面 `/entries` | 单条 `/entries/:id` | 一轮小回复后 `/state` | 之后回翻页 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 64 KiB | 200 | 135,552 | 13 | 200 | 200 | 200 | — |
| 300 KiB | 200 | 623,056 | 1（只留最大条目） | 200 | 200 | 200 | 200 |
| 490 KiB | **413** `frame_too_large`（entryId 25, 1,017,230 B） | 114 | — | 413 | 200 | 200 | 413 |
| 700 KiB | 413（1,452,896 B） | 114 | — | 413 | 200 | 200 | 413 |
| 1.0 MiB | 413（2,075,274 B） | 114 | — | 413 | 200 | 200 | 413 |
| 3.0 MiB | 413（6,373,840 B） | 114 | — | 413 | 200 | 200 | 413 |

阈值二分（`probe-frame-text-followup.mjs`）：484,280 B 文本 → 200（帧 981,816 B）；485,040 B 文本 → **413**（帧 983,356 B）。即**帧**的阈值就是 `FRAME_LIMIT_BYTES = 983,040 B = 960 KiB`，对应的**文本**边界落在 484,280–485,040 B，即本夹具的 **472.93–473.67 KiB**。该文本区间取决于这段内容的 JSON 转义开销，不是通用的「473.67 KiB」常数；可推广的只有帧字节阈值本身。
重复放大实测：307,200 B 文本的条目，单条读取 622,617 B，`ratioEntryToText = 2.03`，且 `entry.text` 与 `entry.message` 同时存在。

软目标实测：40 个 20 KiB 小条目（合计 819,200 B 文本）→ `/state` 200、帧 501,778 B（≤512 KiB）、窗口保留 24 条、`hasMore: true`、耗时 1.87 ms。软目标按设计工作。

工具输出上限（实测真实函数，5,242,880 B 输入）：

| 函数 | 输出字节 | 说明 |
| --- | ---: | --- |
| pi-coding-agent `truncateTail` | 51,155 | `DEFAULT_MAX_BYTES = 51200`、`DEFAULT_MAX_LINES = 2000` |
| pi-coding-agent `truncateHead` | 51,127 | 同上 |
| pi-durable `OutputBuffer`（retain tail） | 51,155 | `droppedBytes = 5,191,725` |
| pi-durable `boundOutput` | 51,155 | 最终 content 再裁剪 |

对应的应用点（源码）：pi-durable `dist/harness/tool.js` 的 `run()` 取 `tool.outputLimits ?? DEFAULT_MAX_BYTES/MAX_LINES`，`finalResult()` 对最终 content 调 `boundContent(final.content, reported.limits)`，`appendToolResult()` 才写 `pi.tool-result` 条目。因此落库的工具结果文本 ≤ ~50 KiB（+诊断文本）。

**端到端实测缺口（诚实记录）**：`probe-tool-output-bound.mjs` 试图用真实 gateway（`LocalGateway`+`GatewayRpcServer`+`gatewayEnvironment`）+ faux provider 脚本化 `bash cat big.log`（5 MiB 文件）走完整链路。结果：脚本化的 tool call 作为 assistant 消息提交了，但**始终没有 tool-result 条目落库**，轮次以 `[user, assistant]` 结束；探测由看门狗在 120 s 终止（`timeout 240` 外层再终止，exit 124）。所以"真实 bash 工具端到端落库 ≤50 KiB"这条**没有端到端测量**，只有上述两个真实函数的实测 + 源码应用点 + 既有 `apps/server/test/frame-size.test.ts`（合成条目）。该脚本保留为可复现的负结果，未再迭代。

### 1.3 实测：大粘贴之后的导航

`probe-frame-navigation-detail.mjs`（exit 0，日志 `.../logs/frame-navigation-detail.log`）：4+8 轮小历史后提交 1.5 MiB 粘贴，**按观测等待结算**（提交前先读基线：最新条目 28、revision 0；提交后观测到最新条目 36 且 `busy === false`，42.6 ms 内 1 次观测即结算，无固定 sleep）。

结算后活动范围（runtime 自身顺序，最新在前）：`36(assistant) → 35(pi.system) → 34(pi.compaction) → 30(pi.user, 1,593,292 B) → 28 → 27 … 13`（`pi.compaction` 说明这轮粘贴触发了自动压缩）。

| 读取 | 结果 |
| --- | --- |
| `/state` | 200，帧 878 B，窗口只有 `[36]`，`hasMore: true`，`oldestEntryId: "36"` |
| `/entries?before=36` | **200 但 `entries: []`、`hasMore: true`、`oldestEntryId: null`**（空页却声称还有更多，且没有游标可继续） |
| `/entries?before=35` | **413** `frame_too_large`，entryId `30`，bytes 3,186,772 |
| `/entries?before=34` / `before=30` | 200；`before=30` 返回 `[34]`（压缩摘要），`hasMore: false` |
| `/entries/:30`（恢复读取块） | 200，3,186,732 B（3.0 MiB），整条可读 |
| `tail=50/200/1000` | 都只返回窗口 `[36]` |

另一形状（`probe-frame-history-navigation.mjs`，exit 0）：大条目在中间、最新是小条目时，`/state` 200（窗口收缩到最新小条目），但回翻页 `before=<oldest>` **413** 并指名那条大条目（entryId 29, 1,452,496 B）。

**用户可见影响**：一条大到本夹具 472.93–473.67 KiB 量级的文本消息（用户粘贴，或任何绕过工具上限的落库路径）在重新加载后**从窗口消失**，而回翻页要么 413、要么返回空页且 `hasMore: true` 无游标 —— 该消息在 UI 中不可达，只有 API 的 `/entries/:id` 能读到。**UI 没有按 id 打开条目的入口**（只有 thinking 预览与 tool-result-image 两个读块），所以「readable by id」目前只是 API 级恢复。**这是本主题唯一有正常使用路径、有实质影响的失败。**

## 2. 主题二：资源树快照（16 MiB / 20,000 entries）

### 2.1 本线实测（`probe-resource-snapshot.mjs`，exit 0）

日志 `.../logs/resource-snapshot-scale.log`，结果 `.../results/resource-snapshot-scale.json`。契约：`resourceSnapshot(root, identity)`（`@hepi/gateway`）+ 加载器 `createWorkspaceResources().discover()` 走真实 `GatewayRpcServer`。

| 树 | 快照耗时 | 目录/文件 | entries | 响应 | heap 增量 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 40 skills（测试规模） | 12.0 ms | 43 / 44 | 80 | 69.7 KiB | 4.6 MiB |
| 1000 skills | 176.7 ms | 1003 / 1004 | 2,000 | 1.49 MiB | 13.5 MiB |
| 5000 skills | 740.9 ms | 5003 / 5004 | 10,000 | 7.46 MiB | 14.6 MiB |
| 9800 skills | 1,421.3 ms | 9803 / 9804 | 19,600 | 14.6 MiB | 57.3 MiB |

加载器（含 RPC 往返与内存内遍历）：40 skills → 23.3 ms / catalog 40 / prefix 17.9 KiB；1000 → 200.1 ms / 1000 / 266 KiB；5000 → 966.5 ms / 5000 / 1.31 MiB。`executionHost` 恒为 ~1–1.7 ms。

边界（真实抛错，信息明确、不静默截断）：
- 20,100 文件树 → `FileError code=invalid`："the execution-side resource snapshot exceeds 20000 entries"。
- 120 个整读 prompt 模板（每个 ~200 KiB，合计 >16 MiB）→ `FileError code=invalid`："... exceeds 16777216 bytes"。
- 未超限但接近上限（19,600 entries）仍能成功返回 14.6 MiB 响应。

### 2.2 合并 agent14 的独立测量（同一 revision）

来源：`.dev/research-performance/resource-search/resource-snapshot.json`（agent14 拥有，未改其脚本）。JSON字段与标签已核对；原始日志起初在实验目录logs，协调者现另存于`.dev/research-performance/resource-search/logs/`，路径见§10。

计数语义（**verified**，`packages/gateway/src/filesystem.ts:662`）：遍历时每列出一个子项就 `entries += 1`，超过 20,000 抛错 —— 即 `entries` 是"列出过的子项数（子目录 + 文件）"，不含根本身。agent14 的 JSON 用同一语义自己算 `snapshotEntries = directories.reduce(列出条目数)`。**但它的行标签是夹具的构造尺寸，不是快照的 `entries` 总数**：`"100 entries"` 夹具 = 1 个分组目录 + 99 个文件；同一行的 JSON 还记录 `directories: 2`、`files: 100`；`exclusion` 是另一棵树，记录 `entries: 102`、`files: 101`、`directories: 2`。下表按 JSON 原样引用，**不把夹具尺寸当作总条目数**：

| agent14 标签（夹具尺寸） | 耗时 | 响应 | `directories` / `files` | 加载器 discover |
| --- | ---: | ---: | ---: | ---: |
| `"100 entries"`（1 组 + 99 文件） | 8.8 ms | 62.0 KiB | 2 / 100 | 21.8 ms / catalog 99 |
| `"1000 entries"` | 64.2 ms | 622 KiB | 11 / 991 | 69.8 ms / catalog 990 |
| `"5000 entries"` | 217.7 ms | 3.15 MiB | 51 / 4,951 | 288.5 ms / catalog 4,950 |
| `"19000 entries"`（under 界） | 768.4 ms | 11.7 MiB | — | — |

两线一致的部分（**verified**）：成本随列出条目数近似线性（本地 SSD、热缓存）；排除规则无泄漏（`node_modules`、隐藏文件、被 ignore 目录都未进快照：`leakedPaths: 0`、`ignoredFileRead: false`、`ignoredDirectoryEntered: false`）；20,000 entries 与 16 MiB 两个上限都以具名 `FileError code=invalid` 失败，无部分结果。两线耗时差异来自树的形状：我的夹具每个 skill = 1 目录 + 1 SKILL.md，`entries` 恰为 skill 数 ×2（1000 skills → 2,000；**verified**），不是矛盾。

**verified vs inferred**：19,600 entries 成功、>20,000 抛错，两侧都实测；"约 9,800 个 skill 是实际上限"是由该计数规则**推得（inferred）**，我没有在 19,600 与 20,001 之间二分。"耗时近似线性"是这 4 个点的拟合（inferred），不是逐点验证。

### 2.3 判断

- **正常规模无问题**：几十到几百个 skill/prompt 是 10–100 ms、<1 MiB 量级。
- **触发条件**：单仓 ~10,000 个 skill 目录，或 >16 MiB 的整读 prompt 模板集合。触发后 discovery 直接失败（提交 failed 状态，该次运行被阻断），不会静默给半个 catalog。
- **影响与处置：`record`**。无正常使用证据表明需要分页或索引；16 MiB / 20,000 是"一次往返有界"的设计选择。重访条件：真实主机出现 10k 级 skill 目录或 >16 MiB prompt 集合，或用户报告首次加载等待。候选缝合点（若重访）：把 `resourceSnapshot` 的单一响应改为按 root 分批的多响应 + 加载器增量合并（改动大，需新证据才做）。

## 3. 主题三：会话搜索（500 / 30 / 3 s）

⚠️ **命名**：本线原始脚本也叫 `probe-session-search-scale.mjs`，与资源/搜索 worker 的 brief 撞名。**本节表格引用的是历史运行**：日志 `.../logs/session-search-scale.log`、结果 `.../results/session-search-scale.json`（即本节 100/500/600 数据集）。原始脚本已按父会话要求以新名 `probe-session-search-scale.mjs` 保留（同一份逻辑、同一数据集），而 `probe-session-search-scale.mjs` 现为另一 worker 的 10/100/500 数据集。

命令：`node --import ./lib/register.mjs probe-session-search-scale.mjs`（exit 0）。真实路由 `GET /api/search?q=`；每个会话 15 轮 × 3 条目（user/assistant/toolResult），每条 ~1 KiB 文本；needle 只放**最老**会话（扫描顺序最坏情况）。

| 会话数 | 目录文本量 | 命中耗时 | 结果 | truncated | 是否找到最老会话 |
| ---: | ---: | ---: | ---: | --- | --- |
| 100 | 1.6 MiB | 15.9 ms | 1 | false | 是 |
| 500 | 7.8 MiB | 28.7 ms | 1 | false | 是 |
| 600 | 9.4 MiB | 42.4 ms | 0 | **true** | **否** |
| 500（needle 遍布） | 7.8 MiB | 3.4 ms | 30 | true（maxResults） | — |

- **预算只测到远低于它的夹具（不要过度概括）**：本线最大夹具是 500 会话 × 22 条目 = 11,000 条目 / 7.8 MiB 被搜索文本，全量顺序扫描 28.7 ms；agent14 的合成夹具 500 会话 × 4 条目 × 8 KiB = 15.63 MiB 被搜索文本，16.65 ms。这只能说明"这台机器 + 热本地 SQLite + 这些夹具"下远未触顶，**不能推出 3 s 预算不可能触顶**。
- 预算的作用粒度（**verified**，源码 `apps/server/src/session-search.ts`）：截止时间在每个分页读之前、页内每条条目处理之前，以及每个会话之间检查；它不能打断已经开始的单次原生 `entries()` 读取。此前把它描述为“只在页边界检查”有误，已由本轮架构效能路线按源码纠正，见 [server-perf F5](../architecture-routes/server-perf.md)。一个会话的**条目数不设上限**，单页可含 200 条条目、每条文本上限 1 MiB（`:127`），因此**一个超大历史可能在一次分页读内就超过 3 s**，那次读不会被打断；返回后在页内第一条条目处理前检查截止时间并记为 `truncated: true`。另有每会话"已检查文本 ≤16 MiB"（`:128`）与"单条 >1 MiB 字符则跳过并置 `truncated`"（`:127`）两个界。硬件、存储与工作负载都会改变结论。
- 真正的约束是 `maxConversations = 500`：601+ 会话时，只存在于第 501 个及更老会话的匹配**找不到**，但 `truncated: true` 如实告知（不是静默空洞）。`maxResults = 30` 同样以 `truncated` 告知。
- **影响与处置：`record`**。已测规模下无索引也够快；只有"会话数 >500 且需要全量完整结果"才会不完整，且已具名。**未验证**的是超大单会话：预算在页内条目之间生效，但不能打断单次原生分页读；这次读本身可能使搜索超过 3 s。重访条件：真实目录超过 500 会话并出现"搜不到已知内容"的抱怨，或出现超大单会话（数十 MB 文本 / 数万条目）导致搜索卡顿。候选缝合点（若重访）：在 catalogue 层做按会话的增量全文索引（FTS5），而不是给 `session-search.ts` 加分页参数——分页会改变"最多 30 条"的上游契约。
### 3.1 合并 agent14 的独立测量（同一 revision，`resource-search/session-search.json`）

每条会话 22 条条目、needle 放在最新 / 最老 / 不存在 / 到处四种场景：

| 会话数 | 最老会话命中（冷/热） | 全量未命中扫描（热） | 到处命中 | 预算触顶 |
| ---: | ---: | ---: | ---: | --- |
| 10 | 1.0 / 0.9 ms | 0.9 ms | 10 条结果，`truncated:false` | 否 |
| 100 | 4.3 / 3.1 ms | 3.1 ms | 30 条，`truncated:true`（maxResults） | 否 |
| 500 | 15.0 / 14.1 ms | 14.5 ms | 30 条，`truncated:true` | 否 |
| 510（超 500 上限） | 2.2 ms，**`truncated:true`、最老会话未找到** | — | — | 否 |

文本边界（500 会话 × 4 条目 × 8 KiB = 15.63 MiB 被搜索文本）：全量扫描 16.65 ms，**约 1.07 ms/MiB**，`truncated:false`，预算未触顶。

两线一致（**verified**）：在本地热缓存、被搜索文本 ≤15.63 MiB 的夹具下，3 s 预算远未成为约束；真正的硬界是 500 会话上限，且以 `truncated: true` 具名（最老会话被排除、不冒充完整结果）。**未验证**：预算在超大单会话（条目数无上限、单页 ≤200 条 × ≤1 MiB 文本）下的行为——见 §6 第 4 项。

- 未测：冷缓存 / 远端存储下的扫描成本（两线都是进程内 SQLite、本地磁盘）；UI 是否把 `truncated` 明确呈现给用户（属前端行为，未在本线范围）。

## 4. 主题四：已加载历史（手动翻页）成本

### 4.1 本线后端实测（历史命令 `probe-loaded-history-cache.mjs`，exit 0；现名 `probe-loaded-history-cache.mjs`）

⚠️ **命名**：该文件名与浏览器线撞名（父会话的 brief 给了同一个 basename）。**历史产物与本节引用的是原始文件名下的运行**：日志 `.../logs/loaded-history-cost.log`、结果 `.../results/loaded-history-cost.json`。原始脚本已按父会话要求以新名 `probe-loaded-history-cache.mjs` 保留（同一份后端-only 逻辑），共享的 `probe-loaded-history-cache.mjs` 这个文件名现在归 agent15 的浏览器扩展版。

测量：真实后端 + 真实 `/entries?before=` 翻页 + Web 应用自己的 `session-view-cache` 模块（浏览器里跑的就是这份代码）。

60 轮 / 180 条目的会话：

| 阶段 | 条目 | 线上字节 | 耗时 |
| --- | ---: | ---: | ---: |
| 首窗 `/state` | 76（50 条可见消息的窗口按原始条目上限裁出） | 230.3 KiB | — |
| 回翻第 1 页 | +75 | 231.2 KiB | 1.79 ms |
| 回翻第 2 页 | +29（到底） | 88.4 KiB | 0.82 ms |
| **累计（浏览器持有）** | **180 条 / 180 消息** | **542.3 KiB** | ~2.6 ms 服务端 |

`session-view-cache` 边界实测（12 次 5 MiB 快照插入）：保留 **6 个会话 / 30.0 MiB**（会话数上限 8、字节上限 32 MiB 都生效，此处字节上限先触发）；40 MiB 单快照**被拒**（返回 false，不进缓存）；最老被淘汰、最新保留。TTL 10 分钟在源码中，未额外等待实测。

### 4.2 真实浏览器补测（协调者合并）

冻结生产 Web build `IBK5kZTUaPXjHDSH9qM6f`，chat源码与HEAD1758c1f一致，另含本次Settings修改；并非主检出中旧的.next。实际React页面由受控server fixture提供数据，**不是原生backend的端到端耗时**。50/500/2000条消息均加载完整，最终JSON有finishedAt，pageErrors为空，无budgetExhausted。

| 已加载消息 | 显式旧页加载 | 全页 after-GC JS heap | DOM elements | 累计long tasks / 最长 | 离开后LRU快照序列化长度 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 0 | 12.1MiB | 1710 | 2 / 126ms | 51531B |
| 500 | 5 | 22.1MiB | 14085 | 18 / 163ms | 511542B |
| 2000 | 20 | 51.2MiB | 55335 | 87 / 613ms | 2047945B |

源码核对：ChatWindow的visibleCount随loaded messages增长，活动prefix没有viewport virtualization；默认首窗仍50，不是打开会话就挂载2000条。DOM、全页heap及long task直接实测，但没有CPU profiler归因，不能把全部长任务归给React或把全部heap归给prefix。

分页约0.7–2.9s包含请求/UI、100ms响应轮询和150ms间隔的3次稳定计数（最低约450ms），不等于纯render time。5/20次翻页对应9/39个context responses，存在重复计数。servedBytes:0是缺失content-length的采集缺口，不是零传输；CDP wireBytes在500/2000场景为463524/2012284B。GC每5页强制执行，是测量干预，不代表生产GC节奏。

证据：`.dev/research-performance/browser-history/results/loaded-history-2026-10-14T08-43-47-569Z.json`与同名`logs/*.log`。JSON记录revision/dirty/buildId/scales/pageBudgetMs=300000与起止时间；raw log没有完整shell invocation或进程exit，**不补造exit0**。当前可复现入口是`node --import ./lib/register.mjs probe-loaded-history-browser.mjs`（原run名probe-loaded-history.mjs，脚本现已分名）。未重新跑只是为改名。

### 4.3 判断

**investigate，非阻塞**。20次主动回翻后的613ms长任务是可信交互成本；日常规模/频率与CPU归属仍需focused验证。LRU预算限制离开后缓存的序列化长度，不能证明当前DOM有界，也不等于JS heap。重访时沿现有ChatWindow渲染Seam调查挂载范围、滚动/搜索锚点，保留prefix数据，不用修改LRU冒充解决渲染。详见[Web设计审查](design-web-review.md)。

## 5. 结论：修复 vs 记录

| # | 发现 | 触发 | 正常使用影响 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | 单条文本达到本夹具 472.93–473.67 KiB 量级即让 `/state`、`/entries` 返回 413；大粘贴之后该消息与回翻页不可达（413 或空页 + `hasMore:true` 无游标） | 用户粘贴约 0.5 MiB 文本（submit 文本无长度上限）；工具路径到不了（50 KiB 上限） | 会话读不到、内容在 UI 中消失，只有 API 能按 id 取；UI 无按 id 打开条目的入口 | **fix**（需新增客户端缝合点，见 §5.1，未授权实施） |
| 2 | 每条目文本在线上出现两次（`text` + `message`），放大 2.03×，把有效阈值从 960 KiB 拉到本夹具约 473 KiB | 所有条目 | 帧体积翻倍；大条目阈值减半 | 与 #1 同一处投影，但不能直接删 `entry.text`（协议与 CLI/chat 消费者依赖它，见 §5.1） |
| 3 | 资源树 >20,000 entries / >16 MiB → discovery 具名失败 | 10k 级 skill 目录或 >16 MiB prompt 集合 | 该次运行被阻断，信息明确 | **record** |
| 4 | 搜索 >500 会话时结果不完整（`truncated: true`）；已测夹具（≤15.63 MiB 文本、500×22 条目）远低于 3 s 预算 | 会话数 >500 且需全量完整；或超大单会话（预算只在页边界检查，页内可能超 3 s，未测） | 可能搜不到已知内容，但已具名 | **record** |
| 5 | 2000条经20次旧页加载后DOM55335、全页after-GC heap51.2MiB、最长long task613ms | 用户主动加载长历史 | 实测增长成本；日常影响与CPU归属未分离 | **investigate，非阻塞** |

### 5.1 最小连贯Seam建议（研究提案，未实施）

- **复用现有历史投影，补齐文本preview与全文恢复。** projectEntry/deferHistoryMessage是state/SSE/分页/by-id的共同Seam。已有thinking/image可延迟，但客户端TextContent只有type/text，Next Adapter仅转发thinking/tool-result-image，没有URL文本恢复能力。因此需贯通backend原生text block读取、投影、Next Adapter及文本显示/展开/复制契约；不是只改后端helper的小修。by-id也使用projectEntry，不能假设延迟后它仍自动返回全文。
- **分页必须能推进。** hasMore=true时应提供可推进游标或非空可导航页；raw-only bookkeeping与预算裁剪的空页形状须独立验证。不能跳过大条目造成历史空洞。
- **不能裸删ServerEntry.text。** ProtocolEntry必需字段、诊断chat、real-model脚本等真实消费者使用它；Web使用message。需一致延迟两种表示中的重内容，或在另一个明确迁移中协调消费者；不是删一字段即可减半且无代价。

以上由[Backend设计审查](design-backend-review.md)核对消费者及恢复链。实施验证从真实0.5/1.5MiB提交开始，检查preview、全文恢复、压缩后分页及浏览器锚点，不新增存储所有者或泛化port。本轮用户指定这项做research，尚未实施。

## 6. 下一批实验（按优先级）

1. ~~浏览器实测已加载历史~~ **已完成**（§4.2，agent15，最终运行 08:43）：50 / 500 / 2000 轮翻到底，DOM / CDP heap（GC 后）/ long task 已有实测；余留口径缺口是 `servedBytes` 未被填充，以及每页 ms 含轮询等待。
2. **大文本读块的行为验证**（若批准 #1 的修复）：真实粘贴 0.5/1.5 MiB → `/state` 200、窗口含 preview、读块返回全文；回翻页不再 413/空页。
3. **端到端真实 bash/read 落库上限**：修正 §1.2 的负结果（工具未执行的原因未定位：可能是探针 env/绑定或 faux 队列）；在 `apps/server/test` 语义下用真实 gateway 断言条目 ≤ ~50 KiB + 诊断。
4. **搜索的超大单会话（预算的未验证面）**：构造 1 个会话、数万条目或接近 16 MiB 已检查文本，测单次 `/api/search` 的实际墙钟——验证"截止时间只在页边界检查"是否会让一次搜索明显超过 3 s，以及此时 `truncated` 的语义。
5. **搜索冷缓存 / 大目录**：500 会话 × 每会话接近 16 MiB 上限（`maxConversationBytes`）时的扫描时间与 `truncated` 语义；确认 UI 是否呈现 `truncated`。
6. **资源快照远端成本**：SSH/远端 transport 下同样的树（本次全是本地 transport，SSH 数字不可外推）。

## 7. 限制与未测（汇总）

- 所有数字是**本地、热缓存、合成数据**的测量；不是生产延迟、不是真实模型吞吐、不是远端主机成本。浏览器部分（§4.2）是**编译后真实客户端 + 受控 fixture 后端**，且只有 Chromium。
- 工具输出 50 KiB 上限是**真实函数实测 + 源码应用点**，不是端到端落库实测（§1.2 负结果）。
- **大文本边界的 472.93–473.67 KiB 是夹具特有的**：文本与帧的字节差来自 JSON 转义开销（随内容变化），可外推的只有帧字节阈值 983,040 B = 960 KiB。
- 大文本条目在本线用**直接 durable commit** 合成（除 1.5 MiB 粘贴走真实提交路由）；这与 `apps/server/test/frame-size.test.ts` 同一做法，属"越界落库"场景，不等于工具路径缺陷。
- 浏览器 DOM/heap/long task **已测**（§4.2，agent15）：编译后真实客户端 + 受控 fixture，三档翻到底、无 page error、无预算耗尽。未覆盖：`servedBytes` 口径未填（真值看 `wireBytes`）、每页 ms 含约 450 ms 轮询/稳定等待、`contextRequests` 重复计数、后端是受控 fixture 而非原生 durable backend、只有 Chromium。
- 资源快照全部 local transport；SSH 未测。资源数字中"夹具标签 ≠ 快照 `entries` 总数"（agent14 的 `exclusion` 场景即为 102 entries / 101 files / 2 directories），引用时按 JSON 字段而非标签。
- 搜索为进程内 SQLite、热缓存，夹具最大 15.63 MiB 被搜索文本；未测冷启动、磁盘压力、远端存储，也**未测超大单会话**——3 s 预算只在页边界（每 200 条）检查，页内与"条目数无上限的单会话"不受预算约束。
- 未测 UI 呈现：`truncated` 的可见性、413 之后 UI 的具体恢复动作（仅从 `useAgentSession.ts` 源码读到会 `setError` 并显示具名原因）。**客户端对 URL 形态 text 读块的渲染面经核实不存在**（§5.1），因此"大文本读块能在 UI 中显示"目前**未验证**，不能当成已有能力。

## 8. 与审计原文的差异（纠正）

- 审计"FRAME_TARGET_BYTES=512 KiB 为软目标，FRAME_LIMIT_BYTES=960 KiB 为帧硬预算"成立；**审计该条同时明确写了「不能误写为 500KB 硬限制」**——本线测量与这条警告一致，没有推翻它，只是补上审计未给出的放大原因与误差区间：条目文本在线上重复一次（2.03×），故本夹具的文本边界约 473 KiB（472.93–473.67 KiB，随 JSON 转义开销浮动）。
- 审计"可能阻碍会话窗口读取，entry 本身仍可按 id 读取"成立，但**恢复面比原文更窄**：新回复后会话可再打开，然而那条消息与它之前的回翻页在 UI 中不可达（413 或空页 + `hasMore:true` 无游标），且 UI 没有按 id 打开条目的入口。这条"在 UI 中不可达"有前后端复核支持：客户端不存在 URL 形态 text 的渲染分支（§5.1），entry.text 也不能删（协议与 CLI/chat 消费者依赖）。
- 审计"大量资源树仍需扫描"成立：本地实测近似线性（100→19,000 entries 时 8.8 ms→768 ms），正常规模（≤几百 skills）10–100 ms。
- 审计"Search 有界顺序扫描…规模变大可能结果不完整"成立：**500 会话上限**实测会排除最老会话并置 `truncated: true`（两线一致）。但"3 s 预算未触顶"只能就**已测夹具**而言（500 会话 / ≤15.63 MiB 被搜索文本，14–29 ms）：截止时间只在每个分页读之前与每个会话之间检查，单页（≤200 条目 × ≤1 MiB 文本）与条目数无上限的单会话不受预算约束，因此预算能否真界住一次搜索**未验证**。
- 审计第 4 条"主动加载历史的浏览器成本…大量加载后的内存/长任务/渲染未在本次测量"**已被 §4.2 补上并部分推翻其乐观含义**：50 轮几乎无成本，但 2000 轮时 DOM 5.5 万节点、long task 累计 25.5 s、GC 后 heap 51.2 MiB，成本近似随已渲染条目线性增长。审计"cache 有 8 sessions/32MiB/10min 限制，不能声称无界 cache"成立且被实测加强：浏览器里缓存序列化体积 2 MB，远小于相邻 heap 51.2 MiB——**压力来自渲染层，不是缓存**。

## 9. 证据清单（命令 / revision / dirty / exit / 日志）

| 探测 | 命令（cwd=`.scratch/development-audit/perf-probes`） | exit | 日志 | 结果 |
| --- | --- | ---: | --- | --- |
| 帧预算扫描 | `node --import ./lib/register.mjs probe-frame-text-budget.mjs` | 0 | `.dev/research-performance/logs/frame-text-budget.log` | `.../results/frame-text-budget.json` |
| 阈值/重复/粘贴 | `node --import ./lib/register.mjs probe-frame-text-followup.mjs` | 0 | `.../logs/frame-text-followup.log` | `.../results/frame-text-followup.json` |
| 导航（合成大条目） | `node --import ./lib/register.mjs probe-frame-history-navigation.mjs` | 0 | `.../logs/frame-history-navigation.log` | `.../results/frame-history-navigation.json` |
| 导航细节（粘贴） | `node --import ./lib/register.mjs probe-frame-navigation-detail.mjs` | 0 | `.../logs/frame-navigation-detail.log` | `.../results/frame-navigation-detail.json` |
| 资源快照 | `node --import ./lib/register.mjs probe-resource-snapshot.mjs` | 0 | `.../logs/resource-snapshot-scale.log` | `.../results/resource-snapshot-scale.json` |
| 搜索规模（**历史命令**：原始文件名；现名 `probe-session-search-scale.mjs`，写 `.../results/session-search-scale-recovered.json`） | `node --import ./lib/register.mjs probe-session-search-scale.mjs` | 0 | `.../logs/session-search-scale.log` | `.../results/session-search-scale.json` |
| 已加载历史后端 + 缓存（**历史命令**：原始文件名；现名 `probe-loaded-history-cache.mjs`） | `node --import ./lib/register.mjs probe-loaded-history-cache.mjs` | 0 | `.../logs/loaded-history-cost.log` | `.../results/loaded-history-cost.json` |
| 已加载历史（**浏览器**，agent15，现占用共享名 `probe-loaded-history-cache.mjs`） | `node --import ./lib/register.mjs probe-loaded-history-cache.mjs`（其自有 runtime） | 0 | `.dev/research-performance/browser-history/logs/loaded-history-2026-10-14T08-43-47-569Z.log` | `.../browser-history/results/loaded-history-2026-10-14T08-43-47-569Z.json` |
| 真实工具端到端（负结果） | `node --import ./lib/register.mjs probe-tool-output-bound.mjs`（外层 `timeout 240`） | 124 | `.../logs/tool-output-bound.log` | `.../results/tool-output-bound.json` |

所有探测都在 revision `1758c1fb4479e9d4637a957857246c5998619d73`、`apps/server/src`/`packages/gateway/src`/`apps/web/lib/session-view-cache.ts` 干净的工作区上运行；工作区整体脏（36 项，他人并发改动），与上述被测路径无关。运行后已确认无遗留探测进程、无遗留 `node_modules` 符号链接；本线产物仅 `logs/`+`results/`（~96 KiB）。

## 10. 协调者整合与可复现脚本归属

- agent14资源/搜索已合并；实际raw logs原在.scratch/perf-probes/logs，现另存`.dev/research-performance/resource-search/logs/probe-resource-search.log`与`probe-session-search.log`，不是缺失日志。JSON同目录resource-snapshot.json/session-search.json。
- agent15浏览器最终数据已合并§4.2；只有观测完成证据，不补造未记录的process exit。
- 协调者的并行任务命名有冲突，现分为`probe-session-search-scale.mjs`（原性能线）、`probe-session-search-resource.mjs`（agent14）、`probe-loaded-history-cache.mjs`（原性能线）、`probe-loaded-history-browser.mjs`（agent15）。原性能线两份完整源码从它自己的session创建调用恢复，syntax check exit0；测量未重跑。§9表列当前repro入口，raw logs仍保留原run的文件名与原始命令。共享lib解析/输出位置已固定，不增加node_modules链接。
- 字节/预算、源码Interface及浏览器限制经三位design reviewers核对；综合候选见[设计汇总](design-review.md)。报告和脚本在仓库研究目录，当前未提交。
