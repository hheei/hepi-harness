# 路由报告：浏览器质量（Web 渲染/缓存/连接池/验证架构）

范围：master `1758c1f` + 工作区未提交修复（**未部署**）。只读分析，无产品改动。前四类缺陷按
[.scratch/design-fixes/results.md](../design-fixes/results.md) 视为已修，不重复。本报告只拥有本文件与
`.dev/architecture-routes/browser-quality/`。

## 1. 架构路由

浏览器侧有三条互相独立的路线，各自有清楚的 Seam：

1. **历史装配线（backend → 投影 → 渲染）**：后端 `apps/server/src/history-window.ts` 用
   `VISIBLE_WINDOW=50`/`MIN_RAW_WINDOW_ENTRIES=200`/`FRAME_LIMIT_BYTES=960KiB` 产出**有界窗口**；
   Web 侧 `apps/web/lib/history-prefix.ts:decidePrefix()` 决定被窗口挤出的条目是否**迁移**到 prefix；
   `apps/web/components/ChatWindow.tsx` 用 `getVisibleRenderWindow()` 按**计数**切片渲染。
2. **缓存线（`session-view-cache.ts` ↔ `deferred-text.ts`）**：会话视图快照（8 会话/32 MiB/10 min LRU）
   与延迟正文读块（100 条/16 MiB LRU）各自持有独立预算与淘汰规则，都是 page-memory only。
3. **连接池线（`completion-delivery.ts` ↔ `agent-event-connection.ts`）**：`POOL_BUDGET=6`（HTTP/1.1
   per-origin）预算被 `backgroundBudget()` 派生成 3（无终端）/2（有终端）；`AgentEventConnection` 保证
   「一个会话一条 source，多读者共享」。

**Interface 契约/不变量（源码确认）**

- `SessionViewSnapshot`：只缓存**已结算历史**（messages/entryIds/leafId/oldestEntryId/hasMore/summaryTree/
  stats + `prefixEntryIds/prefixMessages/prefixHistoryHead`），永不缓存 streaming/队列/run/SSE
  （`session-view-cache.ts:1-14,16-45`）。写入门槛：`sessionId` 与 `revision` 皆非空，且单条序列化 ≤32 MiB
  （`L100-108`）。
- `decidePrefix` 不变量：`historyHead` 变了 → 整段 prefix 丢弃（compaction 重基线）；`hasMore=false` → 丢弃；
  已在 prefix 中的 id 不重复加入（幂等）（`history-prefix.ts:61-74`）。
- `loadDeferredText`：**只在显式 expand/copy/edit 时**发起；all-or-nothing，失败即 reject，绝不回落 preview
  （`deferred-text.ts:1-25,78-105`）。`MessageView.tsx:168` 注释与实现一致（mount/reconnect/scroll 不取）。
- `AgentEventConnection`：订阅跨重连存活；`startup_error` 不重试（拒绝非瞬态），其余失败按
  `reconnectDelayMs` 重试（`agent-event-connection.ts:186-192`）。`ready()` 用 while 循环处理
  「曾经 ready 又变 CONNECTING」的 source（`L109-121`）。
- `CompletionDelivery`：deferred watch **保投影、保提名、保位置**，只缺传输；`handover` 只接受
  conversationId 匹配（或尚未绑定）的投影，且「未接受任何事实」的投影不被当作已结束
  （`completion-delivery.ts:127-145`）。

## 2. 设计优势

- **预算被推导而非假设**：`backgroundBudget()` 由 `POOL_BUDGET - SELECTED_STREAM - HEADROOM - terminal`
  算出，浏览器 e2e `ux-terminal-budget.mjs` 断言了 3/2 两个数字（`L347-350`），文档
  `docs/chat.md:291-300` 与实现同源。连接预算因此是 Interface 的一部分（调用者必须知道它）。
- **缓存与渲染是两个独立预算**：浏览器实测中 scale=2000（2000 条 message）的缓存序列化体积为 2.05 MB
  （`serialized.length` 字符数，非 heap 字节——见 §3-F2 与 §4），
  相邻 GC 后 heap 为 53.7 MB。这**只**说明「在该测量点，渲染面已加载的 DOM/长任务压力是观测到的现象」，
  **不构成 CPU 归因，也不排除缓存**：缓存 `stringify` 的墙钟本次未测（见 §4），因此不能声称「缓存不是瓶颈」。
  该测量点还有明确口径限制（`documents` 跨越导航、`openMs` 非 settle 时间），见 §4。
- **延迟正文是一个深模块**：一个 `loadDeferredText(textUrl)` 后面藏着 in-flight 去重、双预算 LRU、
  「淘汰后不重新插入」的所有权规则（`deferred-text.ts:44-63,88-100`）；`loadTextBlockOriginals` 让
  copy/edit 不必知道 preview 结构。删除测试通过：删掉它，7 个渲染面都要各自重写取正文逻辑。
- **`SessionTree` 已虚拟化**（`getRowOffsets`/`getVisibleRowIndices`/`OVERSCAN_PX` +
  `SessionRowView`/`GroupRowView` 皆 `memo`），所以侧栏不是渲染热点。这是**同一仓库里已有的正确做法**，
  可与 §3-F1 的 transcript 形成对照。

## 3. 发现（设计 / 逻辑 / 混合）

### F1 — transcript 无虚拟化，`visibleCount` 单调增长（**设计**；`mount 成本增长已证`，`回收策略未证`）

- **触发**：正常使用——反复上翻加载历史，或一次 `loadContext` 后
  `setVisibleCount(current => current + max(50, messages.length*2))`（`ChatWindow.tsx:565`）。
- **证据**：`ChatWindow.tsx:489,548,565,627,685,806,1266` 全部是 `Math.max` 或 `current + N`，
  **没有任何一处减小 `visibleCount`**；渲染是 `rendered.slice(startIndex)`（计数切片），
  不是窗口化虚拟列表。
- **影响**：会话 mount 期间已渲染条目只增不减；滚动到最新、切走再切回（同一 mount）都不释放 DOM。
  与实测一致：scale 50→500→2000 **条 message** 时 DOM 节点 1710→14085→55335，long task 累计
  189→1833→25484 ms。（单位是 message，不是轮：探针 fixture 每个 index 追加一条 `UserEntry` + 一条
  `AssistantEntry`，`messages = floor(count/2)*2`，故 scale 50 = 25 个 user 轮 / 50 条 message；
  源码 `probe-loaded-history-browser.mjs:seed()`。）
- **已证与未证的分界（重要）**：`rendered.slice(startIndex)` + `visibleCount` 单调 +
  实测 DOM 节点随已加载 message 数单调上升，这三者**已经足够证明「mount 成本随已加载历史增长」**，
  无需额外测量。**未证**的是「可见区之外的 DOM 是否会被回收/释放」——当前探针只做单调翻页到底，
  没有任何「回翻到底 → 滚回尾部 → 再读 DOM」的观测点，因此**无法**区分
  「计数式切片 + 永久驻留」与「计数式切片 + 浏览器/滚动回收」两种解释。
  这一缺口**只限定交互（interaction）与回收建议的边界**，不否定 mount 成本增长本身。
- **可能性**：高（长会话 + 回翻即触发）。**实际影响**：scale 2000 下 87 次 long task / 25.5 s 阻塞，
  单次最长 613 ms——是可感知卡顿，但属于「重负载 + 极长会话」，非日常路径。
- **归属 Seam**：`ChatWindow` 的渲染窗口策略（`getVisibleRenderWindow` 是纯函数，`chat-lazy-load.ts` 是正确
  的 Seam，只是策略本身是计数式而非窗口式）。
- **处置：`investigate`**（保留）—— 补一个「回翻到底再滚回尾部」的观测点，用于判定可见区外 DOM 的
  驻留/回收行为。**本报告不主张必须虚拟化**：窗口化虚拟列表只是候选修法之一，是否值得做取决于该观测结果
  与真实交互中的卡顿证据；在证据成立前不动渲染架构。

### F2 — 快照字节计量用 `JSON.stringify`，每次写入 O(缓存总字节)（**设计**）

- **触发**：切换会话时的 unmount 写快照（`useAgentSession.ts:2722-2748`）与 `getSessionViewSnapshot` 的
  LRU 触碰；`evictToFit()` 对**整个 store** 重新 stringify 累计
  （`session-view-cache.ts:58-77`）。
- **证据**：`snapshotBytes()` = `JSON.stringify(snapshot).length`；`setSessionViewSnapshot` 先算一次
  `bytes`（L103），`evictToFit()` 再对每个条目重算（L73），删除时又算一次（L76）。实测缓存单条最大
  2,047,945 B（scale=2000 条 message 的 fixture，`browser-history/results/loaded-history-2026-10-14T08-43-47-569Z.json`）。
- **复杂度**：每次写入 Θ(store 总字节)，最坏 ≈ 2 × 32 MiB 的 stringify，且发生在**切换瞬间**——正是缓存
  存在的意义所在。**浏览器内未测**（本报告 §4 的探针只记录了 cache `totalBytes`，没有 stringify 墙钟；
  §2 已据此撤回"缓存不是瓶颈"的结论）。
- **Node 合成证据（存在，非浏览器）**：web 路由 worker 的
  `.dev/architecture-routes/web/probe-cache-worstcase-and-render-alloc.mjs`（8 会话 × 300 条 × 13.3 KB ≈ 32.1 MiB
  合成字符串）实测：**写入 + 全量扫描 35.9 ms**（本次复核重跑 35.4 ms），逐出减算 2.9 ms，新条目
  `JSON.stringify` 4,014,635 B；`probe-snapshot-cache-cost.mjs`（8 × 300 × 2 KB）扫描 6.25–8.7 ms。
  详见 `web.md` §3-F4（同一 worker，本报告交叉引用、不重复其归属判断）。
- **正确性说明**：预算单位是 **UTF-16 `serialized.length`（字符数）**，不是 heap 字节
  （`session-view-cache.ts:snapshotBytes()`）。因此 32 MiB 界是**字符预算**，与 §4 的 GC 后 heap 数字
  不可直接相减；§2/§4 只用它做"缓存序列化体积 vs heap"的**数量级**对比，不做换算。
- **可改进点（非 O(1)）**：把**总量账本**改成增量维护（写入时累加、逐出时相减）可去掉每次写入对全部已存条目的
  重扫；但**新条目本身的序列化仍是 O(新条目字节)**，无法消除。省下的是"重扫已存 7 条"的那部分。
- **可能性**：中（需多会话接近上限）；**影响**：切换卡顿，且不改变正确性。
- **归属 Seam**：`session-view-cache.ts` 的字节账本（应随写入增量维护，而非每次全量重算）。
- **处置：`record`**（有界、非流式路径；Node 合成数量级不足以判定实质影响，且有 32 MiB 硬界兜底）。
  重访条件：真机出现切换卡顿。

### F3 — 注释声明的覆盖守卫不再被调用；`snapshotCoversLoadedEntries` 成为死代码（**混合**）

- **触发**：会话 unmount 写快照。
- **证据**：`useAgentSession.ts:2723-2724` 注释仍写「Only when the cached window still covers every entry the
  UI has loaded (paged-in history included)」，但紧随其后的条件是
  `if (sid && currentData && currentData.sessionId === sid && currentData.snapshotRevision)`，**没有**调用该谓词。
  `snapshotCoversLoadedEntries` 在全仓库的非 vendor 引用只剩它自己的测试
  （`apps/web/lib/session-view-cache.test.mjs:79-83` 与 `apps/web/vendor/pi-web/...` 保留副本）。
- **影响**：**正确性影响很可能为零**——prefix 现在随快照一起保存
  （`prefixEntryIds/prefixMessages/prefixHistoryHead`，L2746-2748，及 L886-889），覆盖性由构造保证；
  剩下的是**注释与实现不一致**（维护者会以为存在一道守卫）。
- **归属 Seam**：`useAgentSession` 的快照写入点 + `session-view-cache` 的公开面。
- **处置：`record`**（注释漂移 + 未使用导出；删除或重新接线由后续维护者按同一 ticket 处理，不阻塞交付）。

### F4 — `deferredTextCache` 没有清理/测试 Seam（**建议性记录，非缺陷**）
（与 `web.md` §3-F4 的编号无关：那条讲的是 `session-view-cache` 的写入字节成本，已并入本报告 F2。）

- **触发**：登出、切换账号、长驻页面。
- **证据**：`session-view-cache.ts:130` 导出 `resetSessionViewCacheForTests`，而 `deferred-text.ts` 只有
  module-level `deferredTextCache`/`deferredTextSizes`/`cachedTextBytes`（L40-42），**无 clear/reset 导出**；
  全仓库无任何调用点（`grep -rn 'deferredTextCache' apps/web` 仅命中该文件自身）。
- **影响**：上限 16 MiB 仍然成立（`MAX_CACHED_TEXT_BYTES`），所以不是泄漏；登出后仍持有已恢复的正文
  （纯内存、不同源不发送），且测试无法隔离缓存状态。
- **归属 Seam**：`deferred-text.ts` 的公开面。
- **处置：`record`（仅建议）** —— 这是**与兄弟模块的一致性观察，不是缺陷**。
  一个有界缓存**没有义务**仅仅为了测试而导出生产用的 clear/reset：上限本身就是隔离边界，
  而测试可自行构造新模块实例。若将来真的引入登出清理，再复用 view-cache 的既有约定；否则维持现状即可。

### F5 — 验证依赖选择器不覆盖浏览器契约（**设计**，回答「selector 正确性」）

- **触发**：只改 `apps/web/lib/session-view-cache.ts` 或 `history-prefix.ts`。
- **证据（实测，本次运行）**：`pnpm verify:changed --dry-run` 输出
  （`.dev/architecture-routes/browser-quality/dry-run.txt`，exit 0）显示选中的 Web 步骤只有
  `web-unit`（273 个 `*.test.mjs`，`--test-timeout=60000`），**没有任何 e2e 步骤**；
  `changed-checks.mjs:85-91` 在 `apps/web` 受影响时只追加 `webUnitStep`。
  同时 `.scratch/`/`.dev/` 被忽略（`changed-checks.mjs:70`），根级非 md 文件走
  `fallbackFiles` → 回落到 `profile=full`（本次 `.gitignore`/`.graphifyignore` 正是如此）。
- **影响**：`session-view-cache`/`history-prefix` 的**真实契约在浏览器**（prefix 迁移、重连不丢页），
  而这些只由 `apps/web/e2e/ux-history-prefix.mjs` 覆盖。选择器因此会给出「绿」的假象；
  这是文档已声明的边界（`docs/verification.md`「不覆盖运行时契约或浏览器流程」），属**设计取舍**而非缺陷。
- **归属 Seam**：`scripts/lib/changed-checks.mjs`（映射是 package 级，非 contract 级）。
- **处置：`record`** + 实践建议：改动历史装配线时手工追加
  `pnpm --filter @hepi/web build && node apps/web/e2e/ux-history-prefix.mjs`（需先构建，属浏览器检查，
  不在默认闸门内）。

### F6 — `admit()` 的「等待最久」是创建顺序，不是等待时长（**逻辑**，轻微）

- **证据**：`admit()` 遍历 `this.watches.values()` 取第一个未订阅且非 dormant 者
  （`completion-delivery.ts:268-281`），Map 顺序 = 插入顺序 = 创建顺序；而 `rebalance()` 在预算收缩时从
  `holding()` **尾部**释放（L292-298），即先让最新创建的让位。
- **影响**：行为确定、无饥饿（每个 watch 最终都会被 admit），只是注释「waited longest」在
  「曾被释放又重排」的场景下不精确。**处置：`record`**。

## 4. 性能：复杂度、预算、实测 vs 推断

**实测（可复用，不得当作端到端页面稳定耗时）** 来源：`probe-loaded-history-browser.mjs`
（源码在 `.scratch/development-audit/perf-probes/`，报告称 agent15），revision `1758c1f` + 脏工作区，
产物 `.dev/research-performance/browser-history/results/loaded-history-2026-10-14T08-43-47-569Z.json`
（`buildId IBK5kZTUaPXjHDSH9qM6f`，scales 50/500/2000，pageBudgetMs=300000）。

| scale（message 条数） | openMs | 翻页数 | DOM 节点 | long task 累计 | 单次最长 | GC 后 heap | 缓存序列化 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50（25 user 轮） | 499 | 0 | 1710 | 189 ms | 126 ms | 12.7 MB | 51,531 B |
| 500（250 user 轮） | 307 | 5 | 14085 | 1833 ms | 163 ms | 23.2 MB | 511,542 B |
| 2000（1000 user 轮） | 334 | 20 | 55335 | 25484 ms | 613 ms | 53.7 MB | 2,047,945 B |

（`userMessages` 实测：scale 2000 打开时为 25，翻页完成后 1000；`domNodes` 1662 → 55335。）

- **单位口径**：`scale` 是**已 seed 的 message 条数**（fixture 每 index 一对 user/assistant，
  故 scale 2000 = 1000 个 user 轮 / 2000 条 message，见 `probe-loaded-history-browser.mjs:seed()`）。
  报告全篇以此为计。
- **复杂度（推断）**：DOM/长任务随**已加载 message 数**近似线性，与 `visibleCount` 单调增长（F1）一致；
  没有证据显示超线性。
- **归因边界（必须随数字引用）**：这些数字只证明「渲染面随已加载历史增长」这一**现象**；
  它们**不**构成渲染层与缓存层的 CPU 对比归因。**本报告的浏览器基准不得用于任何 CPU 对比归因**
  （无论指向渲染还是缓存）。
  缓存 `JSON.stringify` 的墙钟**在浏览器内未测**，因此**不能**用「缓存字节数远小于 heap」来排除缓存的
  CPU 成本；但**已有 Node 合成证据**（F2、`web.md` §3-F4：最坏界 35.9 ms / 重跑 35.4 ms），
  其适用范围仅限"Node 里 32 MiB 合成字符串的 stringify 成本"，**不可**当作浏览器主线程实测。
- **口径限制（必须随数字引用）**：`servedBytes` 字段为 0，真实传输字节看 `wireBytes`（scale 2000 = 2,012,284 B）；
  每页 ms 含约 450 ms 的轮询/稳定等待，**不是纯渲染时间**；`openMs` 是打开动作耗时，**不是页面 settle 时间**；
  只有 Chromium、受控 fixture 后端（非原生 durable 后端）、本地热缓存；`contextRequests` 有重复计数。
  scale 50 档 `before` 的 `documents:4` 与 `after:1` 说明测量点跨越了导航，`after` 前 heap 反而下降——
  这两档的绝对差不宜跨档比较。
- **未测**：可见区外 DOM 是否随滚动回收（F1 唯一的判据缺口）；**缓存 stringify 墙钟（F2）——仅在浏览器内未测**
  （Node 合成证据见下）；连接池在 4 条以上后台
  watch + 终端 + 发送并发下的排队延迟（`ux-terminal-budget.mjs` 只断言数量上限，不断言延迟）。

## 5. 支撑测试与浏览器 Seam 策略

- **纯函数 Seam（已有，正确）**：`chat-lazy-load.test.mjs`、`session-view-cache.test.mjs`（jiti 直载
  `.ts`，0 个 `assert.match`）、`deferred-text.test.mjs`（注入 `fetch` stub）、`completion-delivery.test.mjs`
  （`FakeSource`）、`history-prefix.test.mjs`。这些测在 Interface 上，不读源码文本。
- **源码正则测试（维护成本）**：19 个 Web 测试文件读自身源码（`readFileSync(new URL("./X.tsx"))` 或
  `ts.createSourceFile`），合计约 80 处 `assert.match`（`ChatInput.test.mjs` 52、
  `FileViewer.test.mjs` 13、`mcp-slash-command.test.mjs` 6、`AppShell.auto-name.test.mjs` 4 等）。
  例：`AppShell.auto-name.test.mjs:9-12` 断言
  `/\(sessionStats\?\.userMessages \?\? 0\) > 0 \|\| selectedSession\.messageCount > 0/`。
  **性质**：这些断言把**格式**当契约——重排表达式、改名、加一个括号都会红，而行为可能完全未变；
  它们测不到实现，只测到文本。**处置：`record`**（既有上游基线，非本次引入；重写为行为测试需单独 ticket）。
  注意与 F1/F2 相关的核心模块（`session-view-cache`、`chat-lazy-load`、`deferred-text`、
  `completion-delivery`）**都是 0 个正则断言**——热点模块的测试质量是好的。
- **浏览器 Seam（已有，正确）**：`ux-history-prefix.mjs`（`TURNS = 30`、真实 Next 生产构建 + 真实 backend +
  受控 OpenAI endpoint，断言「迁移而非消失」「重连不丢页」，全部以可观察 UI/请求状态为条件，**不做时间断言**）、
  `ux-deferred-text.mjs`（17 检查）、`ux-terminal-budget.mjs`（连接数量）。这些正是 F5 指出的
  「选择器不会自动跑」的那一层。
- **上游基线**：`apps/web/vendor/pi-web` 是 `agegr/pi-web` @ `76bdc570`（v0.10.0，MIT）的**保留源码快照**，
  非可运行包（`vendor/pi-web/README.md`）。本地 `lib/session-view-cache.ts` 相对 vendor 版本仅新增
  `prefixEntryIds/prefixMessages/prefixHistoryHead` 三个字段（`diff` 9 行新增，逻辑函数逐字相同）。
  含义：缓存模块的**淘汰/LRU/TTL 行为可回到上游基线比对**，而 prefix 迁移是本仓库自己的扩展。

## 6. 图表查询记录与限制

MCP `query_graph`（默认图，depth=1，token_budget=1000）：
`ChatWindow`、`session-view-cache`、`completion-delivery`、`changedChecks`、
`useAgentSession history pagination loaded entries`、`session sidebar search filter render`、
`browser benchmark real50 real500 real2000`、`deferred text cache message text store`、
`session search client index build`、`unitTestFiles discovery.mjs test file enumeration`、
`useAgentSession snapshot restore cache write`、`decidePrefix history prefix seam`。
CLI 深图：`~/.local/bin/graphify query "loaded history cache budget render cost"
--graph graphify-deep/graphify-out/graph.json --budget 1000`（depth=2）。

- `changedChecks` 是唯一返回**完整**答案的查询：12 节点 / 27 边，全为 `EXTRACTED` `ast`，
  定位 `scripts/lib/changed-checks.mjs:40` 并给出 `verify.mjs:108` 调用边——与源码一致。
- 其余查询在 ~1000 token 预算处**被截断**（ChatWindow 30/33、session-view-cache 30/32、
  completion-delivery 27/40、history-pagination 28/123、sidebar 29/55、decidePrefix 27/55）。
  按导航规则，截断结果**不能**用于断言缺失；本报告所有结论都在源码中确认过。
- 深图节点 `Loaded History Render Cost (DOM / heap / long tasks)` 与
  `History Read Budget and Active Prefix Cost (P2/investigate)` 的 `source_location` 为 `null`
  （语义层回填特征），指向 `.scratch/development-audit/performance-research.md` 与
  `design-web-review.md`——它们是**历史文档概念**，不是当前实现契约。
- 默认图 `built_at_commit` 与 HEAD `1758c1f` 一致，但工作区脏，行号需按源码复核（已逐条复核）。
  BFS 路径只证明静态可达性，**不**证明运行时派发：例如 `ChatWindow` 的边不体现
  `visibleCount` 的运行时单调性，那条结论来自源码阅读。

## 7. 建议（分析，非实施）

1. **先测再改（F1）**：mount 成本随已加载历史增长已由源码与实测共同证明；缺的**只有**「回翻到底 →
   滚回尾部 → 再读 DOM 节点数」这一观测，它界定的是交互行为与回收建议，而非增长事实本身。
   在该观测到手之前，**不建议**把窗口化虚拟列表当作既定修法（`investigate` 保持开放）。
2. **F2 的修法**：字节账本改为写入时增量维护（在 `setSessionViewSnapshot` 内累加），
   `evictToFit` 只做减法；改动局限在一个模块，且不改变 Interface。
3. **F3/F4/F6 只是记录**：注释漂移、与兄弟模块的一致性观察（非缺陷）、注释措辞。均不构成交付阻塞。
   与 F2 相关的动作建议：把总量账本改为增量维护（去掉重扫），新条目序列化仍为 O(新条目)——
   这条建议与 `web.md` §7 第 2 条一致。
4. **验证实践（F5）**：把「历史装配线改动 → 必跑 `ux-history-prefix.mjs`」写进
   `docs/verification.md` 的手工追加清单，而不是让选择器假装覆盖它。
5. **不要重写源码正则测试**（§5）：它们成本高但不是本次范围内的失败来源，且上游基线如此。
