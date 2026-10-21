# Web 设计审阅：Interface 所需知识、Execution Host 与历史视图

审阅 revision：`1758c1fb4479e9d4637a957857246c5998619d73`（master），加当前授权 audit fixes 的脏源码。审阅当前 Implementation 与调用链，并非只看 diff。只写本报告；未改源码、测试、指南、graph，未 commit、部署、运行付费推理或重跑全套测试。

已完整读取指定 `codebase-design/SKILL.md`、`DEEPENING.md`、`GLOSSARY.md`、review-policy 与 verification practice。复用父会话 graph 导航；父结果截断，随后限定到指定文件与直接调用者。没有调用 Alternative Interface 设计流程；没有再委派。

主范围：`useAgentSession.ts`、`agent-event-connection.ts`、`session-view-cache.ts`、`completion-delivery.ts`、`adapters/durable-api.ts`、`adapters/workbench.ts`、catch-all route、`ModelsConfig.tsx`、`EnabledModelsSection.tsx`、`capability-availability.ts` 与已改测试。直接核对 AppShell、ChatWindow、lifecycle acquisition/projection、MCP 路径和现有验证记录。HTML 字段数量与文件长度不构成 Depth 证据。

## 发现（最多四项，按影响排序）

| 优先级 / 处置 | 证据位置 | 具体触发与影响 | 最小责任修正 |
| --- | --- | --- | --- |
| P1 / fix：Execution Host 身份被丢弃 | `apps/web/adapters/durable-api.ts:269`、`:332`；`apps/web/app/api/[...path]/route.ts:40` | 选中另一 gateway/SSH 的会话，打开 MCP 项目配置或 project-trust。workspace 列表含 `gatewayId`，解析却只留下 root；该远端 root 被发送到固定 Web 本机 MCP。已复现错误派发；同路径的本机配置可能被读成远端配置。项目写入同样走此路径，写错本机文件是源码推断，未真实写入。 | 在现有 `hostCwdOf` Seam 保留并验证 Execution Host 所属关系；非本机目录明确 refused。不要全局拒绝远端 worktree/file 调用，也不要把 MCP 移到 backend。 |
| P2 / fix：快照接受规则只保护一半视图 | `apps/web/hooks/useAgentSession.ts:800`、`:815`、`:820`；`:1503`、`:1513` | 打开会话时 HTTP 旧读落后于 SSE 新帧。lifecycle projection 拒绝 revision 1，但 hook 继续写 `data`、historyHead、leafId、failure。真实 hook 复现中消息保持 fresh，错误提示却被旧 `failure:null` 清掉，活动条目退回 e1。 | 深化现有快照接受 Seam：同一被接受的 observation 决定生命周期与相伴历史/失败元数据；让被拒绝读没有旁路写入。不在每个 setter 周围复制 revision/generation 判断。 |
| P2 / fix（全文）；investigate（长历史，非阻塞）：历史 Interface 的读预算与活动视图成本 | `apps/web/adapters/durable-api.ts:494`、`:495`；`apps/web/hooks/useAgentSession.ts:930`、`:952`；`apps/web/components/ChatWindow.tsx:558`、`:672` | 用户粘贴约 ≥473 KiB 文本可提交落库；旧页返回 413，或空 entries + hasMore:true + 无游标。大条目在浏览器不可达；读页失败只 console.error，恢复锚点放弃。原性能线已通过真实提交/读取 Seam 测得。补充冻结浏览器：20 次显式翻页加载 2,000 条后 DOM 55,335、最长长任务 613ms；活动 prefix 持续保留 DOM，LRU 不能限制其成本。 | 全文复用已有 deferral/read-block Seam，保持窗口连续；活动 prefix 的可见窗口预算在现有 ChatWindow 渲染 Seam 调查，保留已加载数据与滚动锚点。未证明日常影响前不自动重构，不改 LRU 冒充解决 DOM 成本。 |
| P3 / record：跨 Interface 的源码形状断言已有维护成本 | `apps/web/components/SettingsPanel.test.mjs:104`、`:137`；`apps/web/components/SessionSidebar.file-search.test.mjs:8` | 本次 audit 已因 route 所属文件迁移与 trust reload 的内部写法变化，改动读源码路径及 regex；这些断言要求知道 JSX 属性布局、ref/effect 写法，而浏览器调用者无需知道。属于已发生测试维护成本，不是新用户故障。 | 后续触碰时，仅将已有浏览器/真实 handler 覆盖的断言替换为同 Interface 的行为检查。没有对应 public coverage 的 trust reload 检查保留；不追加一套等价源码断言。 |

`fix` 是后续责任归属建议，本审阅没有实施授权。前三项有明确调用路径或实测失败，不以设计偏好制造交付阻塞；第四项记录即完成。前两项测试使用本地可控输入，不代表已发生生产事故。P1 的高优先级来自跨主机配置/信任归属，未声称已损坏用户数据。

### 1. Execution Host 与目录是共同的 Interface 不变量

Backend 在 `apps/server/src/server.ts:1216`/`:1222` 返回 `{id,gatewayId,host,workspaceRoot}`。Web 的 `WorkspaceEntry`（`durable-api.ts:269`）删除了 gatewayId，`resolveLocation`（`:301`）允许整个 workspace 列表，`hostCwdOf`（`:332`）最终返回仅 `{kind:"folder",path}`。catch-all 将 MCP/project-trust 交给本机 Adapter；`mcp-surface.ts:313`/`:316` 不再有判断主机的事实，`mcp-host.ts:36`/`:40` 永远发送到 HEPI_WEB_GATEWAY_URL。

远端 Project 不是假想需求：当前 `durable-api.ts:625` 支持选择 host/profile 创建 Project，worktree/file 的现有 Seam 能正确以 workspaceId 寻址；所以它们应继续接受远端工作。只有 MCP 是固定 Web host 能力。规范见 `docs/mcp-on-the-web-host.md:3`、`docs/architecture.md:82` 及 capability spec 决策 36–39。

**测试到的事实**：以含 `gatewayId:"ssh-gateway"` 的 workspace 列表供给真实 hostCwdOf，再调用真实 mcpSurfaceApi，结果为 HTTP 200，本机 host 收到远端 root 的 read 与 trust。**推断的影响**：若本机同路径目录存在，读取本机配置/信任并错误标为所选远端目录；项目 write/patch 会使用相同 cwd（`packages/gateway/src/mcp/host.ts:351`），未用真实主机执行写入。

依赖类别：目录标识/判断属于 **In-process**；backend 身份列表与本机 MCP 属 **Remote but owned**；真实 Adapter 与受控 fetch 的测试 Adapter 已存在。保留“backend 提供目录身份、本机 host 执行 MCP”的既有两个 Seam，不新增通用 host router，不让凭证穿过 backend。

删除测试：删掉目录解析 Module，routing path → host root、Project 多文件夹和 retained binding 知识会重新散落到 MCP、cwd validation、worktree 等调用处，复杂度不会消失；它值得保留。所需深化是让身份保留到决定所有权处，而非再加一层映射。Leverage：MCP read/write/test/sign-in 与 project-trust 共用一次判断；Locality：只有 hostCwdOf 需要证明“该 root 属于本机”。调用者级使用保持现状：

`mcpSurfaceApi(request, parts, hostCwdOf)`；对非本机 `/workspace/<id>`，resolver 返回 refused，本机 host 不收到调用。

重访条件：修正后用“本机/远端两 host 有相同绝对路径”的公开 Seam 用例验证；若将来明确增加远端 MCP，另行定义凭证和主机归属，不预留单 Adapter 的抽象。

### 2. 深化已有快照接受 Module，别绕过它应用元数据

真正的排序规则已经集中在 `apps/web/lib/lifecycle-projection.ts:380`：acquisition 旧则忽略，同 projectionId 的旧/等 revision 忽略，不同 attachment 的 HTTP 读不能覆盖已选 SSE。`snapshotObservation`（`lifecycle-acquisition.ts:86`）只带 entries/run/submissions；hook 在 fold 之后独立应用其它事实。

HTTP 的 `setData(d)`/`setRunFailure(d.failure ?? null)`（`useAgentSession.ts:816`/`:820`），SSE 的 `setData(next)`/liveModel/queuedMessages（`:1517` 后）必须服从同一次接受决定。它们不是本地 transient UI：failure 是 durable run outcome，historyHead 是 compaction 不变量，model/queue 是远端状态。滚动、对话框展开、notice 动画、草稿则可以继续属于 hook。

本次真实 hook 公开输出复现：HTTP revision 1 开始后，SSE revision 2 带 fresh failure 与 e2 到达；旧 HTTP 随后返回。messages 保持 fresh，但 data.revision=1、historyHead=head1、leafId=e1、runFailure=null。`ChatWindow.tsx:938` 将 runFailure 交给可见聊天输入；用户因此失去新失败原因。history/prefix 的进一步损失风险尚未在此复现，不额外断言。

依赖类别：projection、prefix、缓存身份为 **In-process**；React/timer/页内 store 是已有 harness 可替代的 **Local-substitutable**；HTTP/SSE 是 **Remote but owned**。已有 EventSource/fetch stand-in 足够，没必要新增 SessionRepository 或两套 transport port。

最小深化选项：让现有 projection 的被接受快照结果携带相伴视图事实，在 `applyStep` 一处应用；或在同一快照接受 Implementation 返回接受结果，让 hook 只有一个事实应用入口。不得由 HTTP/SSE 两段分别实现 fence。隐藏的复杂度是 attachment identity、acquisition、revision 与元数据必须原子采用的顺序义务；不是把所有 React 操作搬到 projection。

强候选的调用者级 usage sketch：两种输送路径都执行现有 `fold(snapshotObservation(frame, acquisition, via))`，显示层只采用接受后的 frame/view；删除 fold 后各路径各自 `setData`/`setRunFailure` 的旁路写入。这是方向性草图，不是另选 Interface 或实现方案。

删除测试：删掉 projection，send、HTTP、SSE、背景 watch 都重新承担 Pending Submission、Committed Message、Submission Outcome Unknown、answer 去重与排序；现有 Depth 高，应该扩大既有知识所有者的覆盖，不重写整个 hook。Leverage 下限：两个快照应用处 + 一个 prefix 维护处/缓存恢复路径；不是“所有 Web 文件都会变简单”的无证据估算。

验证应跨同一个 hook Interface，以 HTTP/SSE 可控乱序断言消息与失败/历史事实同时保持新版本。已有 projection 单测继续负责内部 Seam；仅增加纯 projection 测试无法覆盖此次旁路错误。重访条件：责任修正后补此公开行为，或真实用户报告失败提示/历史状态倒退。

### 3. 历史视图 Interface：全文可达性与活动 prefix 成本

#### 3.1 大文本缺口属于已有历史投影 Seam

复用 `performance-research.md` §1.2/§1.3/§9 的证据：1.5 MiB 粘贴经真实 messages 提交得到 202；之后 state 只携带最新小回复，before 最新条目的 older page 空且无游标，其它游标返回具名 413。不是普通 read/bash 工具问题：真实工具已有约 50 KiB 输出上限，性能线的真实工具端到端探测没有完成，不能据此称工具路径有缺陷。

Web Adapter 的 older-page 映射还要求额外 `snapshot(parts[1])`（`durable-api.ts:495`）才能附带 model/thinking；因此“页面能读到”也不能独立于当前 state 的可读性成立。`useAgentSession.ts:956` 将页失败吞成 console.error，ChatWindow 锚点恢复看到无 context 后退回底部（`:560`），IntersectionObserver 则无法绕过有问题的条目。

Interface 的性能不变量必须同时覆盖“可提交大小”“窗口字节预算”“导航游标能继续”“全文能取回”。Backend 是唯一历史投影所有者；Web Adapter 目前只转发 thinking/tool-result-image 两种 read-block（`durable-api.ts:501`），不能把 backend 的 `/entries/:id` 能读全文等同于浏览器能打开全文。

依赖类别：窗口/延迟投影为 **In-process**，历史读取为 **Remote but owned**。复用既有 deferral 与 read-block Seam，完成 backend 投影、Web 路由和显示契约；不要新建第二套大消息存储，也不要打破连续后缀/按位置翻页规则。删除 Adapter，会将 ID/消息 normalize、read-block URL 与状态错误传播重新分摊给界面，复杂度不消失。Leverage 是 state/SSE/older pages 的同一投影规则，不是一次大规模 Web 迁移。

处置已由性能研究提出 fix；本报告只补 Web 实際调用链，父汇总应去重。后续验证用同 messages/state/entries + 浏览器回翻 Seam，检查大条目 preview、全文和之前历史都可达；没有重跑该实验。

#### 3.2 新浏览器证据：活动 prefix 增长，已有 LRU 只限制快照缓存

父会话补充冻结 Web build `IBK5kZTUaPXjHDSH9qM6f` 的浏览器测量，revision 1758c1f，chat 源码未变；实际请求由受控 **server fixture** 回答，不是原生 Backend 路由的端到端成本验证。已读取 JSON 与同名 log，未自行重跑或实现。

| 全部已加载消息 | 显式 older-page 加载 | 全页 JS heap（CDP after GC，MiB） | DOM elements | 累计 long tasks / 最长 ms | 离开后 snapshot 序列化长度 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 0 | 12.1 | 1,710 | 2 / 126 | 51,531（约 50k） |
| 500 | 5 | 22.1 | 14,085 | 18 / 163 | 511,542（约 500k） |
| 2,000 | 20 | 51.2 | 55,335 | 87 / 613 | 2,047,945（约 2 MB） |

**源码确认的责任**：`apps/web/hooks/useAgentSession.ts:945` 将 older page 累加到活动 history prefix；`:690` 将 prefix 与 projection window 拼成 messages。`apps/web/components/ChatWindow.tsx:685` 用 messages.length 提高 visibleCount，`:1266`/`:1275` 再 slice rendered。因 visibleCount 随已加载消息增长而不随着 viewport 移出旧消息，这条路径是渐进加载，活动已加载 prefix **没有 viewport virtualization**。初始窗口默认 50（`apps/web/lib/chat-lazy-load.ts:1`）；2,000 的成本要经过 20 次显式加载，不能表述为默认打开会话即产生 55k DOM。

**测试到 / 推断区分**：DOM 数、全页 after-GC heap、long-task count/duration 已直接观测；已加载旧页保留 DOM 是源码事实。它是增长成本的可信来源，但没有 profiler 隔离各 Implementation 的 CPU；不可把所有 long task 都归给 React render，也不可把全页 51.2 MiB 算成 prefix 或 snapshot 独占内存。长任务数是开页/翻页等整个场景的累计值，20 次翻页与默认首窗不是相同操作次数。

**计时/传输限制（纠正）**：perPage 的约 0.7–2.9s 是请求等待 + UI 工作 + 100ms 响应轮询（探针 `probe-loaded-history.mjs:355`）+ 150ms 间隔的 3 次稳定计数检查（`:360`，最低约 450ms 稳定等待），不是纯 React 渲染延迟，也不是固定 750ms 等待。不能直接减一个常数得到 render time。5/20 次显式翻页观测到 9/39 个 context responses，存在重复响应计数，不能冒称 9/39 次独立翻页。`servedBytes:0` 从缺失 content-length 的响应头采集，属于 instrumentation gap，不是零传输；JSON 的 CDP wireBytes 在 500/2,000 规模分别为 463,524/2,012,284。

**活动 prefix ≠ bounded LRU**：hook 活动 history 与渲染 DOM 存在于当前聊天；snapshot LRU 在读取 checkpoint 或离开时保存窗口+prefix，本次缓存读数在离开后采集；8 会话/序列化长度预算/TTL 仍生效。缓存读数约 50k/500k/2 MB 与全页 heap 12.1/22.1/51.2 MiB 是不同量纲，不能用“32 MiB LRU 有界”证明活动 DOM 有界，也不能据此称 LRU 泄漏。

处置 **investigate，非阻塞**：已观察 613ms 长任务，长会话完整回翻时有可信交互成本；真实日常规模/频率和具体卡顿归属尚未证明，不自动实施整个 chat 重构。重访条件：用户在数百到两千条已加载历史上报告卡顿，或下一轮公开浏览器滚动/搜索锚点场景验证出重复的大长任务。

最小深化方向仅供重访：在现有 ChatWindow 渲染 Seam 限制挂载范围，把 viewport、消息高度与滚动/搜索锚点义务收在同一 Implementation；活动 prefix 数据继续保留，别跳过条目或删 LRU。依赖是 **In-process** 的已加载视图、**Local-substitutable** 的浏览器/DOM（现有真实浏览器测试），不是需要新 remote Adapter 的问题。删除这个渐进加载 Module 会把锚点与窗口计算散回 UI；应深化既有 Seam，不能只删除 slice/visibility 代码。Leverage 限定到一处聊天历史显示及其翻页/恢复/搜索调用者，不外推为整个 Web 迁移收益。需要先验证同一浏览器 Interface 的内容可达、锚点恢复与滚动行为，再谈 replace-not-layer 测试；本次不添加、不删除测试。

证据：`.dev/research-performance/browser-history/results/loaded-history-2026-10-14T08-43-47-569Z.json` 与 `logs/loaded-history-2026-10-14T08-43-47-569Z.log`。JSON 记录 build/revision、dirty 列表、三个完整规模、finishedAt、空 pageErrors，无 budgetExhausted；原始 log 未记录完整 shell invocation/进程 exit code，因此不补造 exit 0。探针源码 Usage 入口为 `node --import ./lib/register.mjs probe-loaded-history.mjs`；本 run 的 scales=50,500,2000 与 pageBudgetMs=300000 来自 JSON，未声称探针源码头部“真实 Backend”描述就是本次网络目标证明。

### 4. 源码形状测试：有真实 churn，但只做局部替换

`fixes-web-tests.md` 记录 catch-all 迁移让旧文件读取 ENOENT、Skills trust reload 从直接 loadSkills 改为 reloadKey 后 regex 失配、MCP props 增减需要改 JSX 匹配。当前 diff 与 `SettingsPanel.test.mjs:104`/`:137` 可对应到此次修复，故不是泛指“regex 都不好”。test helper / SDK realpath / 子依赖解析修复是运行环境适配，不能混算为源码形状问题。

已有真实 handler auth/capability 测试、23 项浏览器 Settings 检查为对应 logout/unavailable 行为提供公共覆盖；依赖 import graph、JSX 属性顺序和 effect 名字的断言不会提供同等用户契约。替换必须先列出相同被覆盖行为，仅可删掉被新覆盖明确取代的旧断言。trust reload 等未证明已有同 Interface 行为覆盖的断言保留。本审阅没有删测试。

删除测试：删除“读某个实现文件再找字符串”的薄封装，其路径/文本耦合消失，未增加调用者义务；如果删除真实 hook/handler/browser 检查，复杂行为证据丢失，应保留。预计收益限定为上述几处断言与两种 owner 文件读取，不能外推成迁移全部 273 个测试文件。处置 record；下次内部重构再次触发这些具体断言、或明确安排测试维护时重访。

## 值得保留的深 Module 与既有 Seam

| Module / Seam | Depth、删除测试与具体价值 |
| --- | --- |
| `lifecycle-projection` + acquisition | 小的 observation/intent Interface 隐藏提交事实、acquisition 排序、跨 attachment、unknown 恢复和 completion 决策。hook 与 CompletionDelivery 共同复用；删掉会把规则散回两个调用者。此次 metadata 缺口应在此附近修正，不否定已存在的 Depth。 |
| `AgentEventConnection`（`agent-event-connection.ts:75`、`:104`、`:171`） | subscribe 返回 ready/reconnect/release，隐藏一会话一 source、handshake、超时、重试、旧 source 消息隔离与引用释放。生产 EventSource 与测试 source 两个实际 Adapter 支持此 Seam；删掉会让 on-screen 与 background 各自造连接生命周期。 |
| `CompletionDelivery`（`completion-delivery.ts:119`、`:152`、`:248`） | nominate/select/handover/settle/terminalStream 是页面必须提供的不同事实；内部隐藏答案去重、背景 interest、HTTP/1.1 六连接预算与不丢 queued follow-up 的交接。AppShell `:160`、`:193`、`:201` 与 hook `:1184`/`:1313` 实际使用；不能只因暴露 Step 就判浅，Step 包含交接所需真实事实。 |
| `session-view-cache`（`:85`、`:99`）与 history prefix | 页内 TTL/LRU、拒绝超大快照、历史与 pending/live 的隔离有价值；key=sessionId 对单页固定 origin/backend 合理。切会话/新会话 promotion 用 draft 与 projection rekey，未发现必须引入通用 cache identity registry 的证据。LRU 序列化长度预算不限制活动 prefix 的 DOM。新增浏览器已实测全页 heap；它与快照序列化长度不同，具体数值/限制见 §3.2。 |
| `workbenchApi`（`adapters/workbench.ts:136`、`:234`、`:450`） | Interface 隐藏 synthetic routing、workspace root/凭证归属、字节流/Range、partial upload、100 MiB batch bound 与 listing 失效；浏览器文件树、viewer、Git、@ index 复用。backend workspace 路由而非绝对本机路径保证远端 Execution Host 所属。删掉会使这些 UI 各自知道 transport/budget。 |
| catch-all auth 与 `capability-availability` | login cookie/origin 检查属于 Web process，models.json 属 backend，MCP 属 Web host；保留已存在归属。capabilityServed 隐藏精确 `501+unsupported` 与 transient fetch failure 解释，supported/not-supported 与 loading/error/draft 不能强并为一个布尔值。Models/EnabledModels 控件需不同 scope/pending 状态是合法 Interface 知识。 |

Settings 散落的 capability 读取主要是按具体控制路径的状态，不足以支持新 CapabilityRegistry。ModelsConfig 的四个探测点可在后续编辑时复用已有 `useCapabilityServed`，但当前未证实额外 fetch 造成实质用户影响，因此不列第五项发现。models.json 暂存 Save 与 enabledModels 即时操作是不同持久义务，不能为“简化”合并提交。当前 enabledModels 路由仍未接通，已修复 UI 只说明 unavailable；不重新打开已验证的功能问题。

明确拒绝：单 Adapter 的 SessionRepository/SettingsTransport/HostRouter、新缓存身份注册表、按文件长度拆 hook、泛化所有 capability 的中央第二份清单，以及在没有 Leverage 估算时整体重写 copied pi-web。保留 copy-first upstream Implementation 和已经赚取 Locality 的深 Module。

## 验证与限制

本审阅自行执行两项临时、内存中探测，另复用父会话新增冻结浏览器数据（§3.2）；完整命令与原始 stdout/stderr 直接保存在本报告附录（本报告即 raw log 路径），没有新增测试文件/脚本。均在上述 SHA 的当前脏源码执行，Node v26.5.1。hook 探测使用已有 lifecycle suite 的真实 bundle/harness，只评估 first-test 之前的 helper 定义；没有注册/执行原套件。MCP 探测走真实 Web Module，fetch 使用本地受控 Adapter，无网络/真实主机写入。

- R1：`cd apps/web && node --input-type=module`（附录 A 完整 stdin），exit 0。证明旧读只被 projection 拒绝，旁路公开输出仍倒退；没有验证真实浏览器渲染/生产网络频率。
- R2：同命令形态（附录 B），exit 0。证明包含 gatewayId 的远端目录仍被本机 MCP 接受；没有真实凭证、host/filesystem 写入。首次探测因 jiti 相对导入路径写错 exit 1，纠正为相对 adapters 的路径后成功；不将失败当实现缺陷。
- 性能线大文本实验：引用 `performance-research.md` §9 的 revision/命令/exit/raw logs，原日志 `.dev/research-performance/logs/frame-text-followup.log` 与 `frame-navigation-detail.log`，两者 exit 0。本次未重测，也未冒认完整浏览器恢复验证。
- Settings 已有复用证据：`fixes-settings.md` 记录 `HEPI_KEEP_ARTIFACTS=1 node .dev/worktrees/audit-follow-up-browser/apps/web/e2e/audit-settings-browser.mjs`，revision 1758c1f dirty、exit 0、23 checks，raw log `.dev/verify/audit-followup/browser-smoke-final.log`。它验证授权 Settings 修正，不覆盖本报告乱序/跨主机候选。
- 新增浏览器历史证据：§3.2 记录冻结 artifact/build、revision、受控 server fixture、完整 JSON/raw log 与测量限制。本审阅只核对源/结果，不重测；原 log 不含进程 exit code，不把数据完整等同于整个检查通过。
- 整体 Web 结果保持记录：`pnpm test:web:unit --quiet`，revision 1758c1f dirty、exit 1，273 files/2297 tests/2281 pass/16 fail；原记录 `.dev/verify/2026-10-14T08-23-27-576-web-unit/web-unit.json`。未重跑、未宣称全绿、未重新修复 dormant upstream 缺口。

## 附录 A：R1 完整命令与 raw log

```bash
cd apps/web && node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { createJiti } from 'jiti';
const url = new URL('./hooks/useAgentSession.lifecycle.test.mjs', 'file://' + process.cwd() + '/');
const source = await readFile(url, 'utf8');
const prefix = source.slice(0, source.indexOf('test("a remount')).replace(/^import .*;$/gm, '').replaceAll('import.meta.url', JSON.stringify(url.href));
const probe = `
let resolveOld;
const oldRead = new Promise(resolve => { resolveOld = resolve; });
const h = harness((url) => {
 if (url.startsWith('/api/models')) return respond({models:{},modelList:[]});
 if (url.endsWith('/state')) return respond({running:false,state:{}});
 if (url.startsWith('/api/sessions/')) return oldRead;
 return respond({success:true,data:{}});
});
const m = h.mount(sessionOptions('conv'));
await h.pump(m);
const fresh = {...frame('conv',{revision:2,text:'fresh'}),historyHead:'head2',leafId:'e2',failure:{reason:'no_model',message:'fresh failure'}};
fresh.context.hasMore = true;
h.sources.at(-1).emit({type:'durable_state',...fresh});
await h.pump(m);
const pick = () => plain({messages:m.out.messages.map(x=>x.content),dataRevision:m.out.data?.revision,historyHead:m.out.data?.historyHead,hasEarlierMessages:m.out.hasEarlierMessages,runFailure:m.out.runFailure,leafId:m.out.activeLeafId});
console.log('before old HTTP:',JSON.stringify(pick()));
resolveOld(respond({...frame('conv',{revision:1,text:'stale'}),historyHead:'head1',leafId:'e1',failure:null}));
await h.pump(m);
console.log('after old HTTP:',JSON.stringify(pick()));
assert.deepEqual(plain(m.out.messages.map(x=>x.content)),['fresh']);
assert.equal(m.out.data.revision,1);
assert.equal(m.out.hasEarlierMessages,false);
assert.equal(m.out.runFailure,null);
m.unmount();
`;
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
await new AsyncFunction('createRequire','path','vm','createJiti','assert',prefix+probe)(createRequire,path,vm,createJiti,(await import('node:assert/strict')).default);
NODE
```

exit 0；raw stdout：

```text
before old HTTP: {"messages":["fresh"],"dataRevision":2,"historyHead":"head2","hasEarlierMessages":false,"runFailure":{"reason":"no_model","message":"fresh failure"},"leafId":"e2"}
after old HTTP: {"messages":["fresh"],"dataRevision":1,"historyHead":"head1","hasEarlierMessages":false,"runFailure":null,"leafId":"e1"}
```

## 附录 B：R2 完整命令与 raw log

```bash
cd apps/web && node --input-type=module <<'NODE'
import { createJiti } from 'jiti';
process.env.HEPI_AUTH_TOKEN='probe-token';
process.env.HEPI_WEB_LOCAL_GATEWAY_ID='web-local';
process.env.HEPI_SERVER_URL='http://backend.test';
process.env.HEPI_WEB_GATEWAY_URL='http://web-local.test';
process.env.HEPI_WEB_GATEWAY_TOKEN='host-probe-token';
const seen=[];
globalThis.fetch=async (input,init)=>{
 const url=String(input);
 if(url==='http://backend.test/api/workspaces') return Response.json({workspaces:[{id:'remote',gatewayId:'ssh-gateway',workspaceRoot:'/home/operator/project',host:{id:'ssh-host',home:'/home/operator'}}]});
 if(url.startsWith('http://backend.test/api/projects')) return Response.json({projects:[]});
 if(url==='http://web-local.test/v1/mcp'){const body=JSON.parse(init.body);seen.push(body);return Response.json({ok:true,value:body.operation==='trust'?{cwd:body.cwd,trusted:true,decision:true,inherited:false}:{files:[],servers:[]}});}
 throw new Error('unexpected '+url);
};
const jiti=createJiti(new URL('./adapters/mcp-surface.test.mjs','file://'+process.cwd()+'/').href,{tsconfigPaths:true,moduleCache:false});
const {hostCwdOf}=await jiti.import('./durable-api.ts');
const {mcpSurfaceApi}=await jiti.import('./mcp-surface.ts');
console.log('resolved remote:',JSON.stringify(await hostCwdOf('/workspace/remote')));
const response=await mcpSurfaceApi(new Request('http://web-origin/api/mcp?cwd=/workspace/remote'),['mcp'],hostCwdOf);
console.log('MCP status:',response.status,'Web host calls:',JSON.stringify(seen));
NODE
```

exit 0；raw stdout：

```text
resolved remote: {"kind":"folder","path":"/home/operator/project"}
MCP status: 200 Web host calls: [{"operation":"read","cwd":"/home/operator/project"},{"operation":"trust","cwd":"/home/operator/project"}]
```
