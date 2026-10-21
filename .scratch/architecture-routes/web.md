# Web 路由：BFF → session connector → acquisition → lifecycle projection → hook/cache → ChatWindow/MessageView

范围：master `1758c1fb` + 未提交 audit/design 修复的工作树（未部署）。只读产品代码；本文件与 `.dev/architecture-routes/web/` 探针为本人产出。此前四个 bug 已修，本文不重复其诊断，只把它们当作"为何长成这样"的历史证据。

## 1. 路由与 owning seam

```
浏览器
 └─ /api/[...path]            apps/web/app/api/[...path]/route.ts        （BFF：cookie/来源检查、durable/mcp/market/project-trust 分派）
     └─ adapters/durable-api.ts                                            （SSE 代理 + delta 折叠 foldFrame；wire→UI 形状）
         └─ useAgentSession.ts (2923 行)                                   （connector：I/O、React 状态、SSE 订阅、租约、恢复）
             ├─ lifecycle-acquisition.ts (118)                             （命名 wire → Observation，不持 socket/timer/store）
             ├─ lifecycle-projection.ts (611)                              （唯一 fold：ordering/acceptance/notice/effect）
             ├─ lifecycle-store.ts (55)                                    （跨 remount 的 projection 内存存放）
             ├─ session-view-cache.ts (132)                                （settled 窗口 LRU 缓存）
             ├─ history-prefix.ts                                          （decidePrefix：窗口移动时 prefix 的保留/迁移/丢弃）
             └─ ChatWindow.tsx (2206) → MessageView.tsx (2325, memo)
Settings：components/*Config.tsx → lib/capability-availability.ts（3 个导出，一个"这条路由服务吗"的问题）
```

**Interface contracts / invariants（源码确认）**

1. **单一 acceptance 决策。** `advance()` 是纯函数；`Step.snapshotAccepted`（`lifecycle-projection.ts:180`）是"这条输入是否被当作该会话当前陈述"的唯一出口。调用方据此决定是否发布随窗口同行的旁证（revision、head marker、leaf、run failure、model、thinking、queue、tool preset、pagination、cache 写入）。
2. **acquisition 在开始时盖章**，不在响应到达时（`lifecycle-acquisition.ts:27` `nextAcquisition`；`useAgentSession.ts:632` `beginRead`）。`fence()` 丢弃更老代次的回调，`begin()` 只推进 generation、不丢弃已接受视图。
3. **identity 不透明、不可比较。** 只有 `via === "sse"` 的 snapshot 可以 rebase 到另一个 `projectionId`；HTTP 读遇到不同 identity 只发 `reattach` effect。同 identity 下 `revision <= 已接受` 被拒，但 **相等** 视为当前陈述（remount 首次读的 hydration 依赖这一点）。
4. **facts 只前进不后退**：`RANK`（queued 1 < placed 2 < done/unanswered 3），backward 记为协议矛盾；`submissions` 排序但不回退；ADR 0006 不重发，未知结局只按 requestId 查询（`applyRecover`/`applyLookup`）。
5. **`decidePrefix` 是一条纯规则**，输入全是历史事实与 id（head marker、窗口 id、上一窗口 id），按 **identity 集合** 而非 id 数值比较，幂等（同一对窗口判定两次结果相同）。head 移动或 `hasMore === false` → prefix 整体丢弃。
6. **session-view-cache**：仅页内存、LRU、只存 settled 历史，明确不存 streaming/queue/run。
7. **capability 门控**：控制项自己探测它将要调用的那条路由；`501 + code:"unsupported"` 才表示不服务，其余一律视为服务；`useCapabilityServed` 在未定（`null`）时不渲染控制项。

## 2. 强项

- **Fold 的深度真实存在。** 611 行里没有 socket/timer/store/registry；接口只有 `createProjection`/`advance`/`hasUnfinishedWork`（+ `pendingMessage`）。排序、去重、通知、effect 全在一处，测试面就是接口本身（`lifecycle-projection.test.mjs` 496 行 ~40 例，含 stale revision、remount hydration、backward fact、notice 去重、absence≠fact）。
- **两传输同一形状。** HTTP 读与 SSE state frame 都经 `snapshotObservation` 变成同一个 `Observation`，旁证同受 `snapshotAccepted` 约束——这正是 bug 2 的根因修复，且修复落在 owning seam（fold 报出决策），不是调用方自比 revision。
- **`history-prefix.ts` 与 `capability-availability.ts` 是教科书式的深模块**：小接口、一条规则、一个测试面、删除测试成立（删掉后调用方各自重写迁移逻辑）。
- **SSE delta 折叠只在一处拥有帧边界**（`durable-api.ts` `foldFrame`），下游消费完整投影，consumer 不知道后端停止重述窗口。
- **`MessageView` 被 memo，且 `toolResultsMap` 用 useMemo 保持 Map 身份**（ChatWindow.tsx:785-794 有注释说明内联 `new Map()` 曾击穿 memo）。

## 3. Findings（设计 / 逻辑 / 混合）

### F1 旁证发布被复制到两个调用方块（设计，record——**advisory，非当前缺陷**）
- 性质更正：这**不是**一个现存 bug，也**不是**必然发生的 bug。它只指出：`accepted` 守卫目前由人手写、结构上没有强制。现有守卫测试全绿，两条发布路径今天都正确。
- 若将来后端新增旁证字段：必须同时改 HTTP 读块（`useAgentSession.ts:828-870`，11 个 setter）与 SSE 块（`1542-1566`，12 个 setter + dispatch），两处都得记得包 `if (accepted)`；漏一处才会重犯"陈旧帧回退旁证"那一类。是否真的会漏，取决于未来改动，本文不作预测。
- 证据：上述两段；修复 bug 2 的方式就是在两处各加一串 `accepted` 守卫（即当时的正确修复）。
- 处置：**record / advisory**——缺的是结构性保证，不是当前失败。建议（非必需）：让 `Step` 携带"已接受的 snapshot 载荷"，或抽出 `applyAcceptedFacts(frame)` 单一 seam，调用方只在一处发布。

### F2 `data`（SessionData）与 `view` 双表示（设计，record）
- 触发：任何需要"当前已接受投影"的读取。
- 影响：`view` 由 fold 拥有，`data` 由调用方 `setData` 在旁边维护（17 处 `data?.` 读）；两者一致性靠 F1 的手工守卫维持，而非类型或结构保证。
- 证据：`useAgentSession.ts:838`、`1549` 与 `view.data`（`lifecycle-projection.ts:404` 一带）。
- 处置：**record**。与 F1 同源；同一 seam 修复即可消解。

### F3 `snapshotCoversLoadedEntries` 在生产中未被调用（混合，record）
- 触发：读 `useAgentSession.ts:2721-2723` 的注释"Only when the cached window still covers every entry the UI has loaded (paged-in history included)"。
- 影响：注释声明的不变式没有执行；`rg` 显示该导出仅被 `session-view-cache.test.mjs` 使用（生产无调用点）。写路径无条件持久化。`clearSessionViewCache` 同样仅测试使用（登出走整页 reload，故无害）。
- 可能性：读文档者建立错误心智模型。
- 证据：`session-view-cache.ts:120`；`rg -n snapshotCoversLoadedEntries` 仅测试命中。
- 处置：**record**（文档/设计漂移，未证明实质失败）。要么接上，要么删导出并改注释。

### F4 缓存写入的 O(已缓存总字节) 主线程代价（设计，record/investigate）
- 触发：8 个大会话已被缓存（缓存自身上界允许 8 × 32 MiB），此时任一 **accepted 读**（mount、`agent_end` 后的 `loadSession`、force 读）调用 `setSessionViewSnapshot`。
- 影响：每次写入做一次新条目 `JSON.stringify` + `evictToFit` 对全部已存快照重新 `JSON.stringify` 求和（`session-view-cache.ts:58-83`、`104-108`）。
- **计费口径更正（重要）**：`snapshotBytes` 返回 `JSON.stringify(snapshot).length`（`session-view-cache.ts:58-64`），即 **UTF-16 code unit 数**，不是堆内存、也不是 UTF-8 字节。本人 ASCII 探针（`x` 填充）下二者恰好相等（ratio 1.00），所以探针数字对本例成立；但非 ASCII 载荷会低估：实测同 1000 字符的 JSON 长度比 UTF-8 字节 = `é` 1.99、`中` 2.98、`𝄞` 1.99（`node -e` 一行探针，见附录）。同时 `JSON.stringify` 不包含对象头/Map 开销，因此 **`MAX_TOTAL_BYTES = 32 MiB` 是"名义序列化长度"预算，不是实际堆上限、也不是 UTF-8 字节上限**。真实堆占用更高且与内容相关。
- 测量（探针 `.dev/architecture-routes/web/probe-cache-worstcase-and-render-alloc.mjs`，Node v26.5.1 / x86_64，合成 ASCII 字符串，8 会话 × 300 条 × 13.3 KB）：写入+全量扫描 **29.8 ms**、逐出减算 2.6 ms、新条目 4.01 MB、8 会话合计 32.1 MB。小场景探针 `probe-snapshot-cache-cost.mjs`：300 条窗口单条 624,635 字符、8 条合计 4,997,080、全量扫描 **6.46 ms**、单次写入 stringify **0.09 ms**。（两次运行数字与早前一轮略有波动，属正常 JIT/GC 抖动，已记录原始输出。）
- **复杂度更正**：维护运行总量只消除"每次写入重扫全部已缓存快照"这一项；新条目本身仍需一次 `JSON.stringify`，所以完整写入是 **O(新快照大小 + 逐出条数)**，不是 O(1)。**只有总量记账是 O(1)**（增/减用已记录的单条大小）。
- 诚实边界：**测量的是 Node 里的 `JSON.stringify` 成本，不是浏览器 trace**；真实触发需要 8 个接近上界的会话。`setSessionViewSnapshot` 不在每个 SSE 帧调用（生产调用点只有 `useAgentSession.ts:873` 与 `:2730` 两处），因此不是流式热路径。
- 处置：**record**（有界、非流式路径，实测数量级不足以判定实质影响）。复查条件：真实会话达到该缓存上界且用户报告切换卡顿。

### F5 能力探测的假阴性被当成"不服务"（逻辑/混合，record）
- 触发：面板挂载瞬间 Web BFF 短暂不可达（`fetch` reject）或该路由抛错。
- 影响：`capabilityServed` 的 `catch` 返回 `false`（`capability-availability.ts:25-28`），`useCapabilityServed` 依赖只有 `[path]`、无重试，于是控制项在该次挂载内消失。与"501 才是明确不服务"的契约相比，网络错误被静默升级成能力缺失。
- 可能性：低-中（面板通常在健康后端上打开）。
- 证据：`capability-availability.ts:25-28`、`:43-52`。
- 处置：**record**（保守方向，误判为"隐藏"而非"点了才拒绝"；导航重挂载即恢复）。

### F6 探测方法（GET）与动作方法（POST）不同（设计，record）
- 触发：未来某条路由 GET 200 / POST 501。
- 影响：控制项会被提供，点击后按设计拒绝。当前所有相关路径都落在 catch-all 的兜底 501（`durable-api.ts:837`），与 method 无关，所以今天正确；耦合点在于"探测 = 是否存在任何方法可达该路由"，而非"该动作是否被服务"。
- 证据：`ModelsConfig.tsx:857-858`（探测）与 `:920`（POST 动作）；`durable-api.ts:171/837`。
- 处置：**record**。

### F7 prefix 无字节上界（设计，record）
- 触发：长会话中反复回翻，且 head 未移动、`hasMore` 仍为 true。
- 影响：`history`（prefix）只在 head 移动或 `hasMore === false` 时丢弃，没有大小上限；内存随用户回翻单调增长（同一会话内）。projection 的窗口有服务端界，prefix 没有。
- 证据：`history-prefix.ts:61-80`、`useAgentSession.ts:409/972`。
- 处置：**record**。注意 browser worker 拥有真实浏览器成本测量，此处只报设计成因。

### F8 窗口化发生在物化全部元素之后（设计，record）
- 触发：已加载条目很多（例如回翻后 5000 条）时的任一 render。
- 影响：`ChatWindow.tsx:1146-1265` 对**全部** `messages` 构造 `rendered` ReactNode 数组（每个元素经 `renderMessage`，做 `entryIds[idx]` 查表、`visibleRefIndexByMessage` 查表、时间戳扫描），随后 `getVisibleRenderWindow` 才只挂载尾部 `visibleCount`（`:1266`、`:1275`）。即每元素工作量按已加载总量支付，挂载量才按可见量。
- 测量（同探针，Node 合成）：5000 条的元素数组构造 **0.36 ms**、anchor filter **0.09 ms**。
- 诚实边界：**这不是浏览器渲染测量**；此处只报设计成因，不给"必须虚拟化"的结论。真实 paint/layout 成本归 browser worker。
- 处置：**record**。

### 说明（非本人路由）
父级已更正：`project-trust` 的 POST 只在 `AppShell.handleTrustProject`（`AppShell.tsx:1401-1406`），而 catch-all 仅把 GET 交给 `projectTrustApi`（`route.ts:42`），`mcp-surface.ts:583-590` 自己就只回答 GET。该 finding 由 cross-host worker 持有，本文只交叉引用、不重复。另：Web cookie `hepi-web-token` 与后端校验共用 `HEPI_AUTH_TOKEN` 同一秘密族（`route.ts:13-19`），非独立秘密，属 cross-host 信任面，本文不判为 finding。

## 4. 性能：复杂度与预算

| 路径 | 复杂度 | 界 | 证据级别 |
| --- | --- | --- | --- |
| `advance`/fold | O(turns + interests) 每输入 | `MAX_UNFINISHED_INTERESTS` 64、`MAX_NOTIFIED_KEYS` 128 | 源码 |
| `decidePrefix` | O(prefix + window) 每窗口移动 | 无界（F7） | 源码 |
| `setSessionViewSnapshot` | O(新快照 + 逐出条数) 每 accepted 读；总量记账 O(1) | 8 会话 / 32 MiB（名义序列化长度，非堆/UTF-8） | 探针实测（Node 合成 ASCII） |
| `messages`/`entryIds` useMemo | O(窗口 + prefix) | prefix 无界 | 源码 |
| `rendered` 数组 | O(已加载条目) 每 render | 无界（F8） | 探针实测 0.36 ms/5000（元素构造） |
| capability 探测 | 每次挂载 1 个 GET/控制项 | 无缓存、无重试 | 源码 |

计费口径：`snapshotBytes` 用 `JSON.stringify(...).length`（UTF-16 code unit），ASCII 载荷下等于 UTF-8 字节，非 ASCII 下低估（见 F4）。

## 5. 支持性测试（复用未变源的既有证据）

- `apps/web/lib/lifecycle-projection.test.mjs`（496 行，~40 例）：stale revision 不回退、remount hydration、backward fact 为矛盾、notice 去重、absence≠fact、recovery 只问一次。
- `apps/web/hooks/useAgentSession.lifecycle.test.mjs`（992 行）：`a stale HTTP read cannot rewind the facts a fresher stream already stated`、`a remount whose read states the revision the projection already holds still hydrates its facts`、`an HTTP read from another attachment keeps the accepted view and asks for a fresh stream`、`a stale read publishes none of the facts it carries, not just the transcript`、`a stream frame the fold refuses renders nothing either`、`a page loaded after the stream moved the head is stamped with the head the stream stated`。
- `apps/web/lib/history-prefix.test.mjs`（71 行）：幂等、head 移动丢弃、`hasMore=false` 丢弃。
- `apps/web/lib/session-view-cache.test.mjs`（86 行）、`apps/web/components/settings-capabilities.test.mjs`（30 行，用真实 adapter 回答验证 501/unsupported 与普通失败的区别）。

未运行全量套件或构建（scope 禁止）。本人新增探针（仅本人目录）：见下方"附录：原始测量记录"。

## 6. 图查询记录与图限制

执行的窄查询（默认图 `graphify-out/graph.json`，除注明外）：
`useAgentSession`、`snapshotAccepted`（**0 命中**）、`lifecycle-acquisition.ts`、`session-view-cache`、`readProjection`、`decidePrefix`、`capabilityServed`、`unsupportedCapability`、`getVisibleRenderWindow`、`MessageView --context call`、`session-reader`、`durable-api.ts`；深图：`lifecycle projection snapshot acceptance`、`explain "Snapshot Acceptance Seam (P2)"`。

限制（按 `.pi/skills/graphify/references/query.md` 与实际观察）：
- 匹配是 case-folded 子串 + IDF，无词干/同义词/中文；`snapshotAccepted` 在 AST 图 0 命中，但源码 `lifecycle-projection.ts:180` 确实存在——**0 命中不等于不存在**。截断的宽泛关键词结果同样不能证明缺失。
- BFS 路径不是运行时分派。`useAgentSession --calls [EXTRACTED]--> decidePrefix` 指向 L725，实际调用在 `setHistory` updater 内；`MessageView --calls--> haveSameRelevantToolResults`（L405）是 EXTRACTED 但仅是 memo 比较器。
- community 名取自最高度数 hub（`community=useAgentSession.ts`），不是子系统边界。
- 深图 `Snapshot Acceptance Seam (P2)` 是 semantic 概念节点（`source_location: null`），其到 `History Read Budget and Active Prefix Cost` 的边为 `INFERRED`，属判断而非解析事实；已回到源码确认。

## 7. 实用建议（分析，非实施）

1. 把"旁证发布"从两个调用方块收回到一个 seam（F1/F2 同源）——这是本次路由里唯一能把"漏一个 `accepted` 守卫"从可能的错误变成不可能的错误的结构性改动。
2. 缓存写入改为"运行总量 + 每项已记录大小"：消除每次写入的全量重扫（剩余成本为 O(新快照 + 逐出条数)，总量记账 O(1)）。顺带处理 F3 的死代码。若在意真实内存，`MAX_TOTAL_BYTES` 应按堆/UTF-8 口径重新命名或换算。
3. 能力探测把"网络错误"与"501 unsupported"分开：前者应重试或保持 `null`（不渲染），而不是永久 `false`。
4. prefix 加一个字节/条数上界，与窗口的服务端界对齐。
5. F8 的窗口化位置由 browser worker 依真实测量决定是否值得改；本文只指出成因。


## 附录：原始测量记录（可复核）

**被测修订与工作树状态**
- 基线：`1758c1fb4479e9d4637a957857246c5998619d73`（master）。
- 工作树 **dirty**：`git status --porcelain | wc -l` = **69** 个已修改路径（含 `apps/web/adapters/durable-api.ts`、`apps/web/app/api/[...path]/route.ts`、`apps/web/components/ModelsConfig.tsx`、`apps/server/src/history-window.ts` 等）。本报告描述的 Web 路由是"基线 + 这 69 处未提交修改"的状态，不是已提交修订，也未部署。
- 关键源文件内容哈希（sha256，测量时点）：
  - `apps/web/lib/session-view-cache.ts` = `bad82b555887a2bb1acf7891edf9b564e31d0d97bf66049e78779d080dac71a9`
  - `apps/web/hooks/useAgentSession.ts` = `35d07c5e2e47e3039e2c81415a8e080137c861ffe9904466f5601240959a0eec`
  - `apps/web/lib/lifecycle-projection.ts` = `4838645840e24a878b7b5d05ec54a4912054c1db571ad5e297dc338ebf209ce0`
  - `apps/web/lib/capability-availability.ts` = `9e028b1d569ea3f895faea30f5c71bf9df2405b8bc0a0a3ce14861de1492cee0`
  - `apps/web/components/ChatWindow.tsx` = `b34d7403184fe847de2b2b84199d866385484df47bd29ffaa82171f8ad92f735`
  （哈希只锚定这几个被引用文件；其余 69 处修改未逐一哈希。若哈希对不上，说明文件已再改，数字需重测。）

**运行环境**：Node `v26.5.1`、`x86_64`（workstation 工作站）。`performance.now()` 单次运行，非多轮统计，故有 JIT/GC 抖动（同一探针两轮：写入+扫描 29.8 ms vs 早前 35.9 ms）。

**探针 1** `node .dev/architecture-routes/web/probe-snapshot-cache-cost.mjs` → 退出码 **0**：
```json
{"oneSnapshotBytes":624635,"entries":300,"sumScanMs":6.46,"subtractMs":0.67,"writeStringifyMs":0.09,"eightSnapshotTotalBytes":4997080}
```

**探针 2** `node .dev/architecture-routes/web/probe-cache-worstcase-and-render-alloc.mjs` → 退出码 **0**：
```json
{"storedBytesBeforeWrite":32117080,"newEntryBytes":4014635,"writePlusEvictScanMs":29.8,"evictSubtractMs":2.6,"retainedSessions":8,"elementAlloc5000Ms":0.3,"filter5000Ms":0.09,"visibleMounted":40,"anchors":2500}
```

**探针 3（本次新增，UTF-16/UTF-8 口径）** `node -e '...'` → 退出码 **0**：
```json
{"char":"x","codeUnits":1011,"utf8":1011,"ratio":1}
{"char":"é","codeUnits":1011,"utf8":2011,"ratio":1.99}
{"char":"中","codeUnits":1011,"utf8":3011,"ratio":2.98}
{"char":"𝄞","codeUnits":2011,"utf8":4011,"ratio":1.99}
```
含义：`JSON.stringify(...).length` 是 UTF-16 code unit 数；ASCII 下与 UTF-8 字节相同（探针 1/2 的载荷全为 ASCII，故其字节数字对 UTF-8 也成立），非 ASCII 下明显低估。

**探针位置**：`.dev/architecture-routes/web/probe-snapshot-cache-cost.mjs`、`.dev/architecture-routes/web/probe-cache-worstcase-and-render-alloc.mjs`（仅本人目录，未触碰产品代码）。三处均为 **Node 合成字符串**，非浏览器 trace，不代表真实 paint/layout 成本。

**产品代码变更：无。** 本次任务只读产品源码；除本报告与上述两个探针外未新增或修改任何文件。