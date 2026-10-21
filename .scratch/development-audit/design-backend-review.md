# Backend / lifecycle / history / model runtime DESIGN review

## 发现（按影响排序，2 项）

### 1. P1 · fix — 已接受的大粘贴不能由正常历史 Interface 恢复；文本表示重复放大同一缺口

证据入口：[server.ts:330](../../apps/server/src/server.ts#L330)、[history-window.ts:257](../../apps/server/src/history-window.ts#L257)、[server.ts:380](../../apps/server/src/server.ts#L380)。

**正常触发与实测影响。** 用户粘贴约 1.5 MiB 文本，真实 POST messages 接受 202；native durable 随后完成回复并压缩。性能研究同 revision 的真实路由记录：state 只剩回复 36；entries?before=36 返回 200、entries=[]、hasMore=true、oldestEntryId=null；before=35 返回 413、指向 entry 30；by-id 30 仍能返回约 3.1 MiB 内容。故不是持久化丢失，而是正常历史读取不能到达已提交消息及其前面的历史。另一个合成形状会直接在回翻页遇到 413。约 472.93–473.67 KiB 的阈值仅属于这些 fixture，不能当成所有消息的通用字节上限。

**Interface 义务。** 调用方发送合法文本后，仍须知道“被接受不代表可在 transcript 读回”；state/分页受 960 KiB 帧限制，单条 by-id 却不受同一窗口限制。分页还可能返回“有更多”而没有可继续使用的游标。现有 Interface 把内容恢复、帧预算和原始条目位置知识转移给调用方，普通浏览器没有 by-id 手动入口。POST 路径见 server.ts:1848、1866；协议仅校验 text 类型与非空（packages/protocol/src/index.ts:98、104），不是帧预算约束。文档 docs/chat.md:112 已记录大文本限制；本次证据把它从合成巨大工具结果风险升级为真实用户输入问题。正常工具输出约 50 KiB 的已有约束不构成该缺陷的触发证据。

**Implementation 根因。** projectEntry 把原文同时放入 text 与 message（server.ts:330），性能研究测得约 2.03× 表示放大；deferHistoryMessage 只对 thinking 和 image 延迟，text 原样通过。WindowProjector 在字节预算下丢弃旧 raw entry，但保留最新 raw entry；若最新 raw entry 是不投影成消息的 pi.system，items 可以为空，而 #start/#dropped 仍让 hasMore 为 true（history-window.ts:147–165）。pageEntries 用这个结果作为公开分页答案。两者共同使 accepted content 无法通过普通历史 Interface 恢复。

**最小连贯 deepening。** 在现有历史投影 Module 中补齐“大文本 preview + 可恢复读块”的行为，沿用 projectEntry 这个唯一投影 Seam、native Conversation.entries 的 fork-aware 读取及既有 read-block 路由结构。让窗口和分页隐藏字节预算与全文存储的差异；同时要求公开分页在 hasMore=true 时提供可推进的非空消息页或明确可推进的游标，不能把空 raw bookkeeping 后缀当作可导航页。修复范围应包含实际用户文本消费链，保留连续历史，不跳过大消息。

**不能照抄研究提案中的两个假设：**

- **“客户端已经渲染 URL 文本”不成立。** apps/web/lib/types.ts:19 的 TextContent 只有 type/text；MessageView.tsx:349 直接组合用户文本，:998 的 TextBlock 只渲染 block.text，:1151 的 tool-result 也直接拼文本。ThinkingBlock 才在 :1029 调恢复读取；image 在 :383 读取 source.url。Next Adapter 仅转发 thinking/tool-result-image（adapters/durable-api.ts:501）。增加 text deferral 必须补同一链路的文本恢复契约、代理与渲染，不能只改后端 helper。
- **不能删除 text 字段。** apps/server/src/chat.ts:23 的诊断聊天真实读取 entry.text；apps/server/scripts/real-model-smoke.ts:218、537 与 split-resources-smoke.ts:393、594 读取它；apps/server/test/browser-session.test.ts:36、server.test.ts:123 等公开检查也依赖它；packages/protocol/src/index.ts:118 将 text 声明为 ProtocolEntry 必需字段。Web 的 uiMessage 读取 message（adapters/durable-api.ts:82），这解释了两种真实消费形式。处理表示放大应在现有投影中一致限制兼容 text 与 message 的重内容，或另行协调消费者迁移；本审查不建议裸删除字段。

单条 GET entries/:id 也调用 projectEntry（server.ts:1666）；如果该函数开始延迟 text，现有 by-id 返回也只剩 preview。因此全文恢复需要像 thinking 一样读取 native block 的文本，而不能假设现有 by-id 会自动恢复它。

调用方使用草图，仅表达这一个强候选的可见行为，不是新层设计：

    GET /state 或 /entries?before=<oldest>
      → 有界文本 preview + 稳定 entryId/blockIndex，分页可推进
    展开同一消息的文本读块
      → GET /entries/<entryId>/text?blockIndex=<n> → 原文

依赖分类：投影/窗口规则为 **in-process**；native durable SQLite 读取为 **local-substitutable**，使用既有临时 SQLite 与真实 Harness；浏览器到 backend 是 **remote but owned**，复用已有 Next Adapter；模型是 **true external**，本行为验证无需付费推理，现有 faux Adapter 足够。无需新 port/class 或第二份持久化所有者。

Deletion test：删除 projectEntry/deferHistoryMessage 会把 redaction、角色过滤、读块 URL、preview 与预算兼容知识散到 state、SSE、分页、单条读取四个调用方；应加深现有 Module，不能拆成四份修补。预期 Leverage 是四个读取入口共享恢复能力；Locality 是一次修改投影与读块即可统一可读性。

优先级/重访：已有真实合法输入路径与内容不可达证据，归 fix；本报告没有实施授权，也不把修复变成抽象重写。下一次实现验证须从真实 POST 0.5/1.5 MiB 文本开始，检查 state、分页连续推进、压缩后导航及浏览器展开/复制原文。已存在 raw-only 空页的独立形状，不能假定仅 text deferral 就解决所有分页进度问题。

### 2. P3 · record（advisory）— 目录增量计数重复识别 append，使每次 view 更新仍遍历全历史

证据：[history-window.ts:340](../../apps/server/src/history-window.ts#L340)、[server.ts:720](../../apps/server/src/server.ts#L720)。

advanceCatalogueStats 的 Interface 要求 previous/before/after 三种状态；Implementation 用 before.every 比较整个旧范围，再处理新条目。同一个 view.start 调用方下一行已经通过 native ops 调 appendedEntries。一个更新因此有两种 append 判定：目录依靠数组身份逐项比较，窗口/history facts 依靠 native ops。即使 live-doc 更新沿用完全相同的 entries 数组，目录计数仍线性扫描。

本次聚焦复现：对同一 10,000 条目的 Proxy 数组调用 advanceCatalogueStats，追加 0 条，产生 20,000 次数字索引读取，count 保持 10,000。这确认额外工作，不证明正常规模已有卡顿。正常触发是长 active range 的每次 native view 更新；维护影响是同一 advance 事实的两套判定与性能解释。材料不足以归 fix。

最小 cut：先取既有 appendedEntries(ops, previousLength)；目录复用该结果，只有 undefined 时 catalogueStats(value.entries) 全量重算。计数 helper 的 Interface 收缩为 previous + appended；无需新 Module 或 Adapter。删除重复 array comparison 后，复杂度消失而不会重返调用方；删除计数规则本身，则 messageCount/firstMessage 规则会重返 catalogue 调用方，所以保留规则所属 Module。依赖仅 **in-process**；现有 ops 翻译 Seam 已存在。Leverage：同一 append 事实驱动窗口、history facts、目录；Locality：head-marker/overflow 的 reset 语义只解释一次。

重访条件：真实长会话 CPU/延迟证据，或用户明确优先优化该路径。此时在调用方相同 Interface 的 catalogue 路由检查 append/live-only/head-marker 后结果，并验证计数路径不扫描旧条目。当前 tests/history-window.test.ts:307 只证明长历史初始 catalogue 的正确性，不能声称已经覆盖这个增量成本。

## 应保留的 deep Modules

| Module / Seam | Depth、Leverage、Locality 与实际义务 | Deletion test / 依赖 |
| --- | --- | --- |
| native durable + attachConversation（server.ts:579） | native submit/watch/watchEvents/fork 拥有提交去重、原子提交、fork-aware 历史、事件获取与 overflow。attach 是生产 Adapter，持有派生窗口/pending/目录，不是第二份 durable 写入者。浏览器只需 requestId、projectionId/revision、恢复查询规则。watch 与 watchEvents 分别承载结构及 submission；合并成自制队列反而重建生命周期。 | 删除会把恢复、顺序及 settlement 知识散到多个 HTTP/SSE 入口。依赖为 in-process + local-substitutable SQLite；保留 upstream 实现、暂停恢复后再 resume 的启动顺序（server.ts:982、1074–1088）。 |
| WindowProjector / appendedEntries（history-window.ts:131、90） | advance 隐藏 visible/raw/byte 三种预算、增量投影与 reset；native ops 不跨外部 Interface。head marker 必须 reset、最新条目不被静默删、边界按位置，是该 Interface 的真实不变量。内部可组合，不需暴露 per-client cursor。 | 删除会让 snapshot/分页/advance 各自处理预算；有真实 Depth。投影 callback 为内部 Seam，属于 in-process，不值得另建单一 Adapter port。问题 #1 是现有 Module 能力缺口。 |
| model-config + upstream ModelRuntime（model-config.ts:185、200、222、235） | 保存把候选验证、私有原子替换、串行刷新、saved-but-not-applied 隐藏在 SaveResult；env/pi 模式共享 upstream ModelRuntime。main.ts:54–55 的同一 runtime 同时交给 models 与 modelConfig，真实调用方没有第二份目录。refreshOnCreate=false 与 allowNetwork=false 防止验证时运行凭据命令/付费请求。 | 删除会把配置解析、错误清洗、文件权限、应用顺序散到 Settings 路由。文件系统为 local-substitutable；provider 为 true external，已有 faux/本地受控 HTTP Adapter。不要另造 ModelRegistry 或重新实现 provider composition。 |
| searchConversationBodies（session-search.ts:145） | 小 Interface 隐藏 literal matcher、excerpt、原生分页、六项预算与读取失败的 truncated 语义；最多一条结果/会话。排序与预算属于 Interface 的性能义务，并非文件长度能衡量的 shallowness。 | 删除会把扫描/游标/截断知识推回 search 路由。依赖为 local-substitutable native durable；已有临时 SQLite 测试。500 会话限制如实返回 truncated；性能研究没有支持此刻加 FTS/index/新存储所有者。 |
| reduceSseFrame / DurableSession（packages/session/src/index.ts:56、86） | 诊断客户端及性能脚本的外部 Seam；调用方给 frame，得到 state/resyncRequired。窗口位置、已有 prefix、delta baseRevision 检查留在内部 Implementation。不是发送时重新运行 agent。 | 删除 reducer 会把这些规则散到诊断浏览器与探针。in-process reducer + remote-but-owned fetch；真实 fetch 与注入 fetcher 为已有 Adapter。未证明需要把 Web 的完整 lifecycle Module 抽成通用新包。 |

## 测试与验证范围

审查的是当前源码，不是 diff。HEAD = 1758c1fb4479e9d4637a957857246c5998619d73；git status --porcelain apps/server/src packages/session/src 输出为空（exit 0），整体工作区仍有授权审计的并行脏改动。沿用 parent 提供的 graph 导航；结果被截断，之后只做指定路径的源码读取与调用方搜索。defer-history-message.ts 未找到独立文件，deferHistoryMessage 实际在 history-window.ts；model-runtime.ts 亦非本仓自有文件，使用安装的 upstream dist/core/model-runtime.js 与本仓 model-config.ts，未建议复制重写。

**已运行：**一个纯内存聚焦复现，无网络/模型调用/源文件修改。命令为 node --input-type=module -e 导入 ./apps/server/src/history-window.ts，构造 10,000 entry 的数组 Proxy，对相同 before/after 调 advanceCatalogueStats；上述 revision 的当前干净目标源码，exit 0。精确命令如下；原始 stdout 嵌入本报告（design-backend-review.md）作为原始记录：

```sh
node --input-type=module -e 'import { advanceCatalogueStats } from "./apps/server/src/history-window.ts"; const n=10000; let reads=0; const raw=Array.from({length:n}, (_,i)=>({id:i,kind:"pi.user",model:[{role:"user",content:"x",timestamp:0}]})); const held=new Proxy(raw,{get(target,key,receiver){if(typeof key==="string" && /^[0-9]+$/.test(key)) reads++; return Reflect.get(target,key,receiver);}}); const out=advanceCatalogueStats({count:n,firstMessage:"x"},held,held); console.log(JSON.stringify({entries:n,appended:0,indexReads:reads,count:out.count}));'
```

    {"entries":10000,"appended":0,"indexReads":20000,"count":10000}

**复用、非本审查重跑：** performance-research.md §1、§5、§9 的同 revision 证据。命令 node --import ./lib/register.mjs probe-frame-navigation-detail.mjs，exit 0；原始日志 .dev/research-performance/logs/frame-navigation-detail.log，结果 .dev/research-performance/results/frame-navigation-detail.json。本次读取了脚本与原始日志：真实 submit，压缩后的空页/413 可直接确认。阈值与 by-id 大小还见 probe-frame-text-followup.mjs（exit 0，日志 .dev/research-performance/logs/frame-text-followup.log）。未声称生产延迟或真实模型吞吐；UI 不能恢复由文本消费与代理源码推出，未新增浏览器运行。

**已读、未运行的公开覆盖：** tests/server.test.ts:70/111/126（restart、独立客户端去重、观察者关闭不停止运行）；durable-submissions.test.ts:132/255/371/403（lookup、terminal frame、共同生命周期载荷、重启新 identity）；history-window.test.ts:141/210/234/364/399（分页、thinking/image、native 顺序、fork 读块）；frame-size.test.ts:52/114（具名拒绝和 by-id）；models-config.test.ts:98/119/152/220/249（保存/重启、拒绝不破坏文件、命令凭据、部分应用）。这些跨调用方所用 HTTP/SSE Interface；纯函数测试与其函数调用方共用内部 Interface，同样有效。frame-size 的合成超大 tool-result 测试只能验证拒绝，不能替代真实粘贴和 UI 恢复覆盖。

session-search.test.ts:271 等存在源码表达式断言，但本范围没有实现改动，也没有证据证明实际 churn；不制造独立“测试脆弱”发现。不删测试；只有将来新增等效公开 Interface 覆盖、证明旧检查失去职责后，才考虑 replace-not-layer。

未启动 DESIGN-IT-TWICE：本任务是审查，尚未选定候选重设计。未拆 server by LOC；未改源码、测试、guide、graph、commit 或 deploy；只写本报告。没有新增 investigate 项，#1 有现成证据，#2 不需要为假想卡顿继续扩张研究。
