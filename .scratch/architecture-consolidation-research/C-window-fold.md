# C（第三版 · 收束）：窗口 fold 与已加载历史 prefix

基线 `caf6a319177554f3fcc53e6a4efc6683a1a3e433`。仅研究；工作树只有未跟踪的 `.scratch/architecture-consolidation-research/` 与 `.dev/architecture-consolidation-research/`（探针），无产品/测试/图改动。

本版收束三点：撤回「两侧只差一个输入」的等价性断言（§2），把共享规则从「建议」升为**硬要求**（§4），撤回 §9 中关于 snapshot spread 的建议（§9）。

---

## 0. 结论

1. 消费者侧确有重复真相：`apps/web/lib/history-prefix.ts:61 decidePrefix` 与 `packages/session/src/index.ts:150 prefixOf`（由 `mergeWindow` L165 / `advanceWindow` L179 调用）实现同一条规则。已确认 head 变化与旧窗口完全滚出时有行为差异；同边界和重叠推进两个具体输入在归一化后相同，不能据此推断所有情况等价（§2）。
2. 归属：规则收敛到 `@hepi/session` 根（该模块零运行时 import，web 可直接依赖），删掉 web 的副本。**不新建包、不新建通用 fold**。
3. 硬要求：SDK 侧必须**真正调用**共享规则（`prefixOf` 函数体删除，改为委托），**不是**在旧 `prefixOf` 上补一个 `historyHead` 参数——后者仍留两份实现，等于没修（§4.1）。
4. 真正跳过的 gap（两侧都没见过的中间条目）**不在本提案范围内**，标记为未决：需要独立的调用者恢复契约（重新拉取或显式声明不连续），本报告**不**发明通用 gap 框架（§2.3、§7）。
5. 生产者侧（`apps/server/src/history-window.ts`、`server.ts frameFor`/`continuationIndex`）一行不改、不抽象。

---

## 1. 基线证据（实测）

| 事实 | 来源 |
| --- | --- |
| wire 帧声明 | `packages/protocol/src/index.ts`：`ServerSnapshot` L203-227（`projectionId`/`historyRevision`/`historyHead`/`hasMore`/`oldestEntryId`/`run`/`submissions`/`liveMessage`/`settings`…）、`ServerDelta` L233、`ServerFrame` L234、`ProtocolEntry` L119 |
| 生产者窗口 | `apps/server/src/history-window.ts`：`advance` L156、`hasMore`/`oldestEntryId` L178-179、`continuationIndex` L483、`headMarkerId` L494、`advanceHistoryFacts` L246；预算常量（`VISIBLE_WINDOW`/`FRAME_TARGET_BYTES`）在此文件，**与 SDK 无关** |
| 生产者发布 | `apps/server/src/server.ts`：`revision` L593、`projectionId` L600、`written` L643、`frameFor` L649、`publish` L655、`onAdvance` L689 |
| SDK reducer | `packages/session/src/index.ts`（206 行）：`SessionState` L8、`reduceSseFrame` L53、delta 基校验 L55、snapshot 分支 L66-70、`windowStart` L118、`prefixOf` L150、`mergeWindow` L165、`advanceWindow` L179、`extendWindow` L192 |
| web prefix 规则 | `apps/web/lib/history-prefix.ts`（81 行）：`LoadedPrefix` L25、`WindowFacts` L32、`decidePrefix` L61 |
| web 调用点 | `apps/web/hooks/useAgentSession.ts`：import L25、`history` L414、`historyHeadRef` L416、窗口移动 effect L837、HTTP 读路径 L949、page-memory 恢复 L2777 |
| Next 代理 fold | `apps/web/adapters/durable-api.ts`：`foldFrame` L130（基校验 L132、合并 L134-136）、唯一调用 L885、resync 回退 L886+ |
| 依赖 | `packages/session/package.json`：`exports` 为 `"."` 与 `"./browser"`，`dependencies` 仅 `@hepi/protocol`；`apps/web/package.json` 有 `@hepi/protocol`、**无** `@hepi/session`；`apps/server/src/chat.ts:1` 是 `./browser` 唯一消费者 |
| 模块纯度 | `packages/session/src/index.ts:1` 只有 `import type { … } from "@hepi/protocol"`，零运行时 import |

探针（均在 `.dev/architecture-consolidation-research/`，`node` 退出码 0）：
- `head-change-probe.mts` → `changed-head divergence confirmed for this reducer input`
- `nonoverlap-probe.mts` / `.log` → `same-head nonoverlap transition also differs`
- `normalized-transition-probe.mts` / `.log` → 将 Web prefix 与新窗口拼接后比较完整 transcript，并断言具体结果；旧 `transition-matrix-probe.mts` 只打印不同形状，不能直接作为等价性证据。

---

## 2. 精确差异（修订：无完全等价）

### 2.1 撤回的断言

上一版 §2.2 称「两侧只差 `historyHead` 一个输入，其余逐例等价」。**撤回，且是错的**：`prefixOf` 与 `decidePrefix` 在**同一 head 下**也对不同输入给出不同答案。原因是两条规则对「窗口不重叠」的处理不同：
- `prefixOf` 把 `after === held.length`（新边界不在所持条目里）当作「新窗口在所持之后」→ 只留 `held.slice(0, before)`，**丢弃被挤出的 `w0,w1`**。
- `decidePrefix` 用**集合**判断（`entryIds` 是否仍在新窗口里），被挤出的条目**迁入 prefix**。

因此「重叠 / 不重叠」这一转移类别本身就是判据，不能靠一个 head 输入弥合。

### 2.2 统一输出形状后比较转移

SDK 返回完整 transcript；`decidePrefix` 只返回 prefix。正确比较必须先把 Web prefix 与 incoming window 拼接，不能把两种形状直接比较。

共同输入：held `[p0,p1,w0,w1]`、旧边界 `w0`、prefix `[p0,p1]`。除最后一行外 head 不变。

| 转移 | incoming window | SDK 完整 transcript | Web 完整 transcript | 结论 |
| --- | --- | --- | --- | --- |
| 同边界扩展 | `[w0,w1,w2]` | `[p0,p1,w0,w1,w2]` | `[p0,p1,w0,w1,w2]` | 此例相同 |
| 重叠前移 | `[w1,w2]` | `[p0,p1,w0,w1,w2]` | `[p0,p1,w0,w1,w2]` | 此例相同，没有重复 `w1` |
| 相邻不重叠 snapshot | `[w2,w3]` | `[p0,p1,w2,w3]` | `[p0,p1,w0,w1,w2,w3]` | SDK 丢掉旧窗口 `w0,w1` |
| 未见过中间条目的 snapshot | `[w4,w5]`，假设实际存在未见的 `w2,w3` | `[p0,p1,w4,w5]` | `[p0,p1,w0,w1,w4,w5]` | 两者均无法从当前输入补出 `w2,w3` |
| head 变化 | `[w1,w2]` | `[p0,p1,w0,w1,w2]` | `[w1,w2]` | head 失效语义不同 |

合成探针仅证明这些具体输入的输出，不能证明任意输入等价，也不能证明线上 compaction 的可达性。前版把完整 transcript 与 prefix 比较、声称所有行都分歧及 `w1` 重复，均撤回。

相邻不重叠的 delta 输入也能观察到 SDK 丢弃旧窗口；真实后端的 `frameFor` 在旧尾部不再位于新窗口时改发 snapshot，该 delta 探针不算线上故障证据。生产者决策仍应保留。

### 2.3 gap 恢复：范围之外，未决

若实际存在两次读取之间发布又滚出窗口的 `w2,w3`，且 incoming 已是 `[w4,w5]`，两侧当前输入都不含 `w2,w3`。这是一个假设存在中间条目的合成场景，不能单凭 ID 或窗口不重叠断定线上已经发生缺口。**这不是 fold 规则能修的**：fold 只根据「我所持的 + 本帧声明的」推演，缺失的中间条目在两侧都不存在。要覆盖它需要**独立的调用者恢复契约**（例如：检测到边界跳跃时重新拉取区间，或把「不连续」作为显式事实交给 UI）。本报告把它列为**未决、超出本提案范围**，**不**设计通用 gap 框架——那正是「用一个抽象换三类转移」的过度设计。

---

## 3. 归属

### 3.1 推荐：规则留在 `@hepi/session` 根，删掉 web 副本

- 该模块已是窗口推进规则的唯一实现处，且 `index.ts` 零运行时 import（§1），`./browser` 是独立 subpath，唯一消费者是 `apps/server/src/chat.ts:1`。因此 `apps/web` 加 `"@hepi/session": "workspace:*"` 并 import 根，**不会**把 `pi-web` vendor 或 SSE 连接带进浏览器包。
- 不放进 `@hepi/protocol`：prefix 规则**不是 wire 策略**，它需要「上一窗口」与「已加载页」这两个调用者事实；协议包多出两个与 wire 无关的类型，收益为零。
- 不做通用 `foldWindow(held, frame, facts)`：它要求三个调用者各自组装 `{prefix, window, anchor, loadedHead}`，而三者的分解本就不同（SDK 单数组、web 的 `history`/`view.data` 两个 store、适配器的标量优先 + `submissions` 回退）。那是把重复真相换成重复知识。

### 3.2 三个所有权分离

| 关注点 | 拥有者 | 本提案 |
| --- | --- | --- |
| 生命周期接受（哪帧是当前陈述、`projectionId` 排序、acquisition generation） | `lifecycle-projection.ts`/`lifecycle-acquisition.ts`（ADR 0007） | 不触碰。`reduceSseFrame`/`foldFrame` 都不比较 `projectionId` |
| 每条流的 `baseRevision` 组装 | 生产者 `written`（`server.ts:643`）+ 折帧方 | 规则共享、持有值各自（合法每流状态，非重复真相）。校验一律 `frame.baseRevision === held.revision`，**不做 `revision - 1` 算术**（revision 可跳，`server.ts:681`） |
| prefix 所有权 | 调用者自己（web 的 `history` L414；SDK 的 `entries` 中边界以下那段） | 共享规则以显式 previous head 工作；各调用者各自持有 store，**不合并** |

### 3.3 与 B 的关系

生产者 `continuationIndex`/`frameFor`/`history-window.ts` **保留、不抽象**：它们是生产者规则（只有它知道 active range 与预算），也是实测平坦成本来源。B 若直转 wire 帧，浏览器需要的仍是 §4 的共享规则——同向，不是替代。直转 Chord `Op[]` 不可行（ops 不含投影/`hasMore`/`historyRevision`，且需完整 active range 才能 apply）。

---

## 4. 目标契约（最小）

`packages/session/src/index.ts` 导出（形状与现有 `history-prefix.ts` 一致，不新增概念）：

```ts
/** 读者自己翻页加载的前缀，以及它是在哪个 head 下加载的。 */
export type LoadedPrefix<T> = { readonly entryIds: readonly string[]; readonly messages: readonly T[]; readonly historyHead: string | null };
/** 刚发布的窗口，与它之前的窗口。 */
export type WindowFacts = { readonly entryIds: readonly string[]; readonly previousEntryIds: readonly string[]; readonly historyHead: string | null; readonly hasMore: boolean };
export function decidePrefix<T>(previous: LoadedPrefix<T> | null, window: WindowFacts, messageOf: (id: string) => T | undefined): LoadedPrefix<T> | null;
```

规则（顺序即语义）：`previous === null` → `null`；head 变动 → `null`；`!hasMore` → `null`；按 **id 集合**保留未被新窗口持有的前缀，`kept.length === 0` → `null`（迁移以真实 prefix 存在为门）；被挤出的 `previousEntryIds`（且不在 `kept`）迁入尾部；幂等；比较一律按 **identity**，边界一律按 **位置**。

### 4.1 硬要求：SDK 必须真正调用共享规则

仅仅「把 `historyHead` 加进旧 `prefixOf` 的参数」**不算修好**——`prefixOf` 与 `decidePrefix` 的窗口处理不同（§2.2），保留两份实现等于保留两套行为。要求：

1. `apps/web/lib/history-prefix.ts` **删除**，`decidePrefix` + 两个类型移入 `packages/session/src/index.ts`。
2. SDK 的 `prefixOf` **函数体删除**；`mergeWindow`/`advanceWindow` 改为**调用** `decidePrefix`（把 `held` 按当前窗口边界分解为 `LoadedPrefix`，把窗口与 previous 窗口 id 组成 `WindowFacts`），由 `decidePrefix` 返回的 prefix 拼接窗口/tail。
3. `SessionState` 显式声明 `historyHead?: string | null`，语义为「当前所持 transcript 是在哪个 head 下加载的」，**旧值用于本帧决策，决策完成后**才写入本帧的 head（否则 `decidePrefix` 永远看到已更新的 head，head 判据失效）。
4. 判定标准：`grep -n "prefixOf" packages/session/src/index.ts` 不再出现该函数定义；两条规则只剩一处实现。

`mergeWindow`/`advanceWindow` 中「`held` 如何分解为 prefix + window」仍由 SDK 自己持有——那是**调用者事实**，不是重复规则。

### 4.2 适配器

若 C 独立交付而暂保留 BFF，可让 `apps/web/adapters/durable-api.ts:130 foldFrame` 使用共享规则并保留现有 metadata 投影。与 B 一起集成时采用 B 的原始转发方案：浏览器接入后直接删除 `foldFrame`，不先做一次临时 Node 重构再删。delta 的前进校验属于共享消费者规则；生产者仍不改。

### 4.3 性能

`O(|prefix| + |window|)`，每窗口移动一次，与现有两实现同级；SDK 侧不新增扫描。

---

## 5. 需修正的前置声明（累计）

1. 「两侧只差 `historyHead` 一个输入 / 逐例等价」→ **撤回**（§2.1-2.2，四种转移实测全部不同）。
2. 「`session-reducer.test.ts:71` 证明分歧可复现」→ 收窄：它证明**按位置**裁剪（id 比较会留下 marker），不证明 head 变动下的 prefix 失效；head 分歧标注为「已由合成探针证实输入层不同，未在 live 场景证明」。
3. `baseRevision === facts.revision - 1` → 撤回；一律 `frame.baseRevision === held.revision`，不做算术。
4. 等 revision 的 snapshot 重述不可 blanket resync → `reduceSseFrame` L67 只对 `event === "state"` 提前返回，`snapshot` 等值重述照常应用（`resyncRequired: false`），与 ADR 0007 remount hydration（`lifecycle-projection.ts:401-406`）相容。
5. 「迁移无条件执行是现有缺陷」→ 撤回；两实现都已以「prefix 真实存在」为门（SDK `before === 0 → []` L155，web `kept.length === 0 → null` L71）。
6. `SessionState` 运行时经 spread 保留 `historyHead` → 准确表述：**类型未声明、规则从未读取**（`grep historyHead packages/session/src/index.ts` 零命中）。
7. 「B 可能删除 `continuationIndex`/`frameFor`」→ 撤回。
8. 「引入 `@hepi/session` 会拖入 vendor」→ 撤回；根模块零运行时 import（实测）。Chord `Op[]`/`ConversationView` 是进程内持有的第三方库语义，不是 remote-owned。
9. `packages/protocol` 「已有 prefix helpers」→ 仍不成立（仅 `textUrl`）。
10. 「`windowStart` 是预算选择」→ **术语修正**：`packages/session/src/index.ts:118 windowStart` 是**边界位置查找**（`findIndex`，`null`→0、`undefined`→`held.length`、未找到→`held.length`）。预算算法（`VISIBLE_WINDOW`/`FRAME_TARGET_BYTES`）在 `apps/server/src/history-window.ts`，与 SDK 无关。上一版把二者混为一谈。

---

## 6. keep / delete / move

| 路径 | 动作 | 依据 |
| --- | --- | --- |
| `packages/session/src/index.ts` | 新增 `decidePrefix` + 两类型；**删除** `prefixOf` 函数体，`mergeWindow`/`advanceWindow` 改调 `decidePrefix`；`SessionState` 声明 `historyHead` | 零运行时 import；已是窗口规则归属 |
| `apps/web/lib/history-prefix.ts`（81 行） | 删除，规则并入 session 根 | 与 `prefixOf` 已证实不等价（§2） |
| `apps/web/lib/history-prefix.test.mjs` | 替换为 session 侧单测（迁移、幂等、head 移动丢弃、`hasMore=false` 丢弃、`null`、**同 head 不重叠迁移**） | 断言同一条规则 |
| `apps/web/package.json` | 新增 `"@hepi/session": "workspace:*"` | 只拿到根模块 |
| `apps/web/hooks/useAgentSession.ts` | 仅改 import 与两处调用点（L837/L949）；`history`/`historyHeadRef`/cache 结构不动 | prefix 独立 store 是正确设计 |
| `apps/web/adapters/durable-api.ts:130` | 内部改调共享规则 + 补 `revision >` 校验；`submissions` 回退与 `message` 投影保留 | 输出形状不变 |
| `apps/server/src/history-window.ts`、`server.ts frameFor`/`continuationIndex` | 不动、不抽象 | 生产者规则 |
| `lifecycle-projection.ts`/`lifecycle-acquisition.ts`/`session-view-cache.ts` | 不动 | ADR 0007；cache 已按 `prefix*` 与窗口分开 |
| wire / DB | 无变更 | 无新字段 |
| `apps/web/vendor/pi-web/**`、`packages/session/vendor/pi-web/**` | 不动（MIT，rev `76bdc57027172eb381a216d647225a6d24f23360`） | copy-first |

`apps/server` 依赖 `@hepi/session`（`chat.ts` 诊断页）：若后端镜像需携带新实现须重建镜像（`linux/arm64`，在 workstation/CI 构建，**不得在 remote-host 编译**）；web 侧可独立发布。

---

## 7. 验证

要断言的行为：

1. **四种转移下两侧同解**（同边界扩展、重叠前移、相邻不重叠、head 变动）——本报告唯一认定的真实分歧，判据是共享规则生效且 SDK 不再自持一份。
2. 窗口移动时已加载页**迁移**；未翻页不增长；重连不丢页；无重复渲染。
3. `baseRevision` 不符 / 边界不在所持之内 / 帧未声明边界 → resync，**不应用**。
4. `oldestEntryId === null` → prefix 与窗口一起替换。
5. 等 revision 的 snapshot 重述仍被应用（ADR 0007 不回归）。
6. 边界按位置、appended 按 id 替换。

**未决（不在本提案）**：真实跳过 gap 的恢复契约（§2.3）。需独立设计；本报告只要求共享规则在「所持 + 本帧声明」范围内两侧一致。

复用既有测试（改实现、不改行为）：`packages/session/test/{delta,loaded-prefix,window}.test.ts`、`apps/web/adapters/durable-lifecycle.test.mjs`、`apps/server/test/session-reducer.test.ts`、`apps/server/test/{delta-frames,history-window,frame-size}.test.ts`、`apps/web/e2e/ux-history-prefix.mjs`（需先 `pnpm --filter @hepi/web build`）。`apps/web/lib/history-prefix.test.mjs` 移到 session 侧并补同 head 不重叠用例。**当前不新增任何测试**；实现时随改动落地。

完成判据：(a) 窗口/prefix 规则只剩一份实现（`prefixOf` 函数体消失）；(b) 上表 1 号四种转移被断言；(c) `ux-history-prefix.mjs` 通过；(d) wire/DB 无变更；(e) 生产者测试未改而通过。

---

## 8. 未决问题

1. `SessionState.historyHead` 可选还是必填？**建议可选**，未声明时按「head 未知、不作判据」，避免破坏 `heldFrom` 这类自建 state（`session-reducer.test.ts`）。
2. `isSnapshot`/`isDelta` 是否移入协议包？**建议只移这两个**（校验的是 wire 帧），`events` 帧留原处。
3. 真实跳过 gap 的恢复契约：**未决、范围之外**（§2.3）。
4. 是否给 web 适配器传 head？**不必**：`foldFrame` 的 held 恒为纯窗口，无 prefix 可失效。

---

## 9. 过度设计审计

**现有可删**：`prefixOf` 函数体（§4.1 硬要求，这不是「简化」而是修掉重复真相）。`useAgentSession` 的 `lastWindowRef`（L423）/`windowSessionRef`（L424）只服务一条规则，可选简化，非本提案前提。

**撤回上一版建议**：不把 snapshot 分支的整帧 spread（`packages/session/src/index.ts:68`）改成显式取字段。理由：(a) 该 state 每帧**整体替换**，不是累积，wire 键不会越积越多；(b) `ServerSnapshot` 携带 `run`/`submissions`/`liveMessage`/`liveTools`/`settings`/`queuedMessages`/`failure`/`projectionId`/`historyRevision` 等 B 需要的原生元数据，收窄 spread 会静默丢掉它们；(c) 正确做法是**保留完整字段**并把类型声明补全（`SessionState` 或独立的 wire-facts 类型），而不是删字段。delta 分支剔除 `baseRevision`/`appended` 是对的（那才是每帧的连续性字段），两者不矛盾。

**本提案须避免**：通用 `HistoryStore<T>`/plugin reducer/多态策略；通用 gap 框架（§2.3）；新 package；branded token / 第二个 reducer；把生命周期接受并进历史 fold（ADR 0007 明确分层）。

**一句话**：窗口是服务端发布的 suffix，prefix 是读者自己的页；这条规则写成两份，且在重叠/不重叠/head 变动三类转移上已实测**不等价**。把它收敛到 `@hepi/session` 根、**让 SDK 真正调用它**（而非给旧 `prefixOf` 加参数）、删掉 web 副本、生产者一行不动；真正跳过的 gap 单独列为未决，不发明通用框架。
