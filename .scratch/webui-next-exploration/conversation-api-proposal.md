# Subagent 支撑方案：最终设计与实施顺序

状态：2026-10-16，已确认设计研究，已正式化为 [spec](../durable-subagents/spec.md) 与 [实施票据](../durable-subagents/README.md)。后续实现以正式 spec/tickets 为准。用户已确认最终答复自动回传、正常完成后复用、用户停止优先、正常空闲唤醒、agent_read 工具及定义/用户配置决定上下文策略；完整产品功能尚未实现，本轮不部署。

当前基础：pi-durable/chord/pi-ai 1.3.0 升级和 queue-only 输入薄接口已完成，见 [升级结果](durable-upgrade-results.md)。正式实施入口为 [durable subagents](../durable-subagents/README.md)；本文件保留设计推导与研究证据，冲突时以正式 spec 为准。完整 subagents、持久 stop、关系/历史树和逐项队列 UI 尚未交付。

## 1. 交付目标与职责

用户可快速创建子 agent，在主会话下完整打开它；主会话继续工作或停止时，子 agent 独立运行。自然结束可靠回报；正常接收会话可以被回报唤醒，已停止会话只显示可编辑、可取消的待处理项。重启恢复身份、执行、队列和回报，不重建第二套运行事实。

| 归属 | 负责内容 |
| --- | --- |
| 通用 conversation module（backend） | 创建/读取/派活/stop/continue、创建来源与展示层级、fork 和完整历史、引用、原生队列的操作与投影 |
| 可选 subagents extension package | 代理定义及其上下文策略的执行、spawn/send/stop/get/read 工具、background anchor 与 deliver/report 任务、委派结果交接 |
| pi-durable | Conversation、Task、Submission、Inbox、事务、工具执行与恢复；新增通用会话级 input-control 接缝 |
| Gateway / Execution Host | 代理定义文件与执行侧资源、workspace/worktree 绑定和工具执行；provider 凭据与模型请求仍由 backend 所有 |
| Web | 快速创建、定义编辑、子会话树、完整聊天/历史、任务关联、逐项队列操作与状态呈现 |

HTTP、Web 与 agent_* 模型工具共用服务器侧 ConversationOperations：spawn/send/stop/get/read 五个主入口。agent_* 是代理定义、上下文策略与委派结果的 adapter；conversation_* 保留为底层 API，本阶段不注册为模型工具。业务规则集中在 conversation module，扩展通过宿主注入调用，避免包反向依赖 apps/server 或调用私有 native 模块。

普通聊天无需启用 subagents。关闭委派入口时保留已安装的兼容 task definitions；已有会话、关系和历史仍可见，已有后台工作仍可完成。实际缺少扩展包/任务定义时明确显示 blocked，不伪造 core 占位任务冒充成功恢复。

## 2. 通用会话 interface 与 agent adapter

用户已确认模型侧只提供 agent_spawn、agent_send、agent_stop、agent_get、agent_read 五个工具。内部统一使用 ConversationOperations.spawn/send/stop/get/read；下表 conversation_* 是底层 API 名称，本阶段不做成模型工具。

| 底层 API（非模型工具） | 核心职责 | agent 模型工具 adapter |
| --- | --- | --- |
| conversation_spawn | 创建持久 Conversation，接纳明确关系、已解析配置与绑定；不依赖代理定义解析器，省略 parent 可创建独立主会话 | agent_spawn 解析定义，按定义/用户配置确定的策略准备上下文、设置显式 child 关系，再经 send 初始派活与登记回报 |
| conversation_send | 对既有会话做幂等输入接纳，支持 steer/followUp 与 queue-only；校验可信 caller 与暂停来源，只有获准的恢复意图走原子 continue | agent_send 添加本次委派来源、回报 recipient 与后台等待；正常完成可直接再派活，用户停止时拒绝模型派活/恢复 |
| conversation_stop | 原子持久 stop 与普通工作取消，保留会话、不递归停止展示子树 | agent_stop 委托同一操作，可补代理侧描述 |
| conversation_get | 查询会话状态、有效配置、关系与任务身份；省略 id 时按过滤条件列举会话 | agent_get 组合定义/委派信息与同一原生运行状态，不维护另一份 busy/terminal |
| conversation_read | 对齐原生 Read：按会话或指定 entry/block 读取内容，offset/limit 按行，有界截断并提供可靠续读；返回正文或图片，定位/截断信息单独承载 | agent_read 委托同一核心 read，读取会话历史或指定 entry/block；搜索和批量组合由未来 codemode 完成 |

主 agent 选择代理并提供任务；上下文策略由代理定义或用户配置确定，宿主解析后执行，不由主 agent 临时决定。agent_spawn/agent_send 的模型参数不提供 fresh/fork/compact、策略插件或来源位置覆盖入口，任务正文也不作为框架策略覆盖。源会话/entry 由宿主依配置固定并记录 provenance。

spawn 与 send 之间的定义/上下文准备由可恢复任务承载，不能用一次不可恢复的顺序函数调用替代。核心接收解析结果和明确 source position，不解释 profile 名称或选择策略。自动通知与持久 reporter 仍承载委派完成交接。

工具采用 noun_verb。agent_send/get/stop 的目标身份是 Conversation ID；核心不以“是不是当前调用者的子会话”限制已授权的跨会话调用。真实 caller、taskId/callId 来自宿主或 native tool context，不信任正文里的自报身份。模型工具拒绝 self-stop，避免等待自身取消完成；用户仍可停止当前界面会话。

初版 subagents 包组合 agent_spawn/send/stop/get/read；agent_read 是读取 adapter，不另建历史存储或查询实现。底层五个 conversation 操作始终由 core 提供，供 agent adapter、Web 与 HTTP 共用；本阶段不注册或通过 capability 开启 conversation_* 模型工具。agent_spawn 明确创建子会话；底层 conversation_spawn 仍允许省略 parent 创建独立主会话。

child 直接输出最终答复，框架在原生 Submission 终态后自动获取结果并回传；child 无需调用 contact_parent、contact_conversation 或特殊终止工具，也不追加一轮“发送总结”。若提供 contact/send 主动通信能力，其职责是中途提问、报告阻塞或同步进度，不替代最终完成回报，也不因发消息就判定任务结束。正常结束、失败、中断均有明确 outcome。只为显式登记的委派建立一次最终回报，不把每个 assistant 消息或自动报告引发的回合再次回报给展示父会话。

## 3. 会话关系与历史：一个查询模型，独立事实

| 事实 | 唯一来源与规则 |
| --- | --- |
| createdBy | 创建时写入的 hepi provenance：用户或发起会话，可带 task/call；fork 必须写新创建来源 |
| hierarchy.parentId | 显式展示父会话；省略表示独立主会话；与 creator 分离 |
| fork source | 直接读取 native ConversationRecord.parent 的 conversationId + at，不再保存一份可独立修改的 fork 数据 |
| native owner | 直接读取 ConversationRecord.owner；用于运行归属，不等同展示父关系或当前回报接收者 |
| context provenance | 实际选用的 source conversation/entry、定义版本与处理策略，随准备结果保存 |
| message references | 随消息/输入持久化的 conversationId + 可选 entryId；按需展开，不自动全文注入模型 |

例如 A 创建独立主会话 B：B.createdBy=A，B 无 hierarchy.parentId。A 创建子会话 C：C.parentId=A。C fork 得到 D：D.parentId=A，D 的 fork 来源为 C@entry；D 仍是子会话。B 向 C 派活只增加本次委派记录，结果返回 B，不改 C 的展示父关系和 native owner。

最小新增关系文档只存 createdBy、可选 hierarchy.parentId 和 provenance；原生 fork/owner 直接投影。创建来源、显示父与上下文准备状态在创建事务中显式初始化。展示树与 fork 来源作为同一 catalogue/history 查询的两种视图，不另建关系服务或通用图数据库。

首版设置父关系的接缝执行同一事务内的自引用/成环检查；界面先交付创建时选择父会话，不额外增加拖拽重组需求。父会话 tombstone 不级联删除子会话、不提升其身份：保留关系，显示“父会话已删除”并允许打开；旧 fork 与引用保持可解释。父会话不存在不代表 child 变成普通主会话。

### Fork 与完整历史

子会话 fork 在创建接缝分配独立 background anchor，继承展示父会话，显式传 native task ownership。该 anchor 绑定源子会话的 conversation-owned background 范围，因此即使展示父已 tombstone 仍可创建有效子分支；native owner 不必等于展示 parent。不能直接解除现有 409 后使用 ownerless 默认，也不能与源分支共用委派身份或待处理队列。新分支的 Inbox/input-control 从 initial 状态开始，继承的是历史，非源分支的运行任务、队列和 stop 状态。普通 UI fork 保留 fork 位置的 agent 配置快照，再应用显式覆盖；agent_spawn 所用定义配置为 context=fork 时，使用创建时解析的完整定义配置，不让上下文来源顺带决定 tools/instructions。

历史树使用“native fork 边 + entry 有序历史 + compact/reset 标记”表达来源。不声称 native 已支持任意 entry-parent 的分支编辑；分支通过 fork-at 创建另一 Conversation。原始记录分页使用公开 fork-aware Conversation.entries，active model context 使用 context；当前 SSE 有界窗口保持原契约。

现有 visibleEntry/read-block 查询已经通过 Conversation.entries 精确验证会话成员关系，可复用 compact 前附件、thinking/text/tool-result-image 读取。新增 raw-history 分页，不用 active view 切片替代；也不绕过成员关系直接查全局 entry ID。共享前缀 entry 与附件链接用正在读取的 conversationId + entryId 解析。验收父会话 tombstone 后子分支仍能读取继承记录与附件。

## 4. 执行与可靠回报

子会话使用 native Conversation，创建后接入现有 catalogue/watch/SSE；用户可完整查看消息、工具过程、模型、历史和真实运行状态。正常完成只结束本次执行，保留同一 Conversation ID 与历史；后续 agent_send 可直接继续派活，不创建新会话、不复活旧 terminal task，也不要求用户额外恢复。每个 child 有自己的 background anchor；anchor 与 reporter 的 task definitions 属于可选扩展包。它们置于正确的 conversation-owned background 范围，普通父 abort 不穿越该范围。

每次显式派活由 native task/checkpoint 保存稳定 dispatch 身份、target、submissionId、回报 recipient，以及定义/上下文来源。不复制 native busy/terminal 状态。dispatch 去重使用调用/请求身份；回报使用派活派生的稳定 requestId。创建、初始提交、等待完整 submission 终态、投送之间均可重入。

完成依据是整个 Submission 的终态与 answer identity，不是第一段 generation task 完成。多个 steer/合并输入可能共享同一个 answer entry；各 dispatch 保留自己的 receipt 和共享答案引用，不启发式拆分答案。send 接纳的是会话消息，不保证独立 job 结果；需要隔离时创建独立 Conversation。queued reset 使旧 submission unanswered 时如实回报，不猜测后续 run 是其延续。done 代表已答复，不代表业务验收通过。原生任务可能跨工具轮 handover；Submission.wait 只有放在可恢复 task phase 内才足够，裸 Promise.then、SSE listener、内存事件不承担可靠回报。

原生背景示例的 anchor/deliver/report 是参考；只拆开真正需要独立恢复和取消范围的任务。最终 task 数量由实现接缝决定，不为每个步骤增加模块。已 terminal 的 owner task 不会让 Conversation 身份消失；会话仍可继续派活，anchor 的等待/完成与清理规则须由第一条纵向链验证。

后台派活工具先返回 child/dispatch 身份；完成后由框架的可恢复 reporter 自动投递结果，主 agent 无需轮询 get 或要求 child 主动 contact。回报唯一正文进入接收方原生 Inbox/Submission，携带 hepi.agent-report InputEntry kind/data，保存 source conversation、dispatch、submission 与结果 entry 引用，并明确标识为自动子 agent 输出而非用户指令。只投送最终答复/终态，不自动搬运子会话全部历史、工具过程或 thinking；模型通过 agent_read 按需读取详细内容。子会话原始结果不变；父会话编辑的是待处理副本。结果超过现有输入/帧预算时投送按固定规则截断的结果预览与源引用，明确标记截断，完整结果由已有 read-block/raw-history 读取；无需搬运完整工具输出进父上下文。

回报接收者已 tombstone 时，投送终止为 recipient_deleted 并保留源结果，不向已删除会话 admission、不无限重试；普通跨会话写入/控制也统一检查 tombstone。普通用户直接在 child 聊天不会自动向展示父会话回报；显式派活操作才登记 recipient。跨会话的新派活各自回报自己的调用来源。无此限制会因自动回报产生循环，因此回报不能按“当前 display parent”猜目标。

## 5. Stop、队列与 Continue：必须先补原生接缝

### 行为表

| 接收者当前状态/来意 | 接纳方式 | 调度 |
| --- | --- | --- |
| allowed 且 running，收到结果/输入 | 原生队列，按 steer/followUp 边界接纳 | 不并发另起回合，不中断正在执行的工具 |
| allowed 且 idle，收到结果/派活 | 原生 admission/队列；正常完成仍为 allowed | 可自动启动，无需用户额外恢复 |
| held，收到框架自动回报或用户 queue-only 输入 | 原生 queued Submission + Inbox，立即投影待处理项 | 不置入模型、不自动启动 |
| 用户停止后，模型尝试派活/恢复 | 拒绝，返回 user_stopped 与当前状态，不新增派活 | resume:true、重试或底层 send 调用都不解除 held |
| 用户明确 Continue/立即执行输入 | 原子解除 held，接纳已有队列与可选新输入 | 恢复正常调度，后续模型派活可再次正常执行 |

持久 input-control 记录可信停止来源（用户或 agent）。用户停止只能由用户明确 Continue 或在目标会话立即发送输入来恢复；模型、主动 contact 与自动 reporter 均无权解除。agent_stop 也不能把已有用户停止改写成可由模型恢复的 agent 停止。仅由 agent 停止且不含用户暂停的目标，可在旧取消范围退出后由模型的明确 continue 意图恢复。caller/恢复权限由宿主鉴别，不接受模型正文或 resume:true 自报用户授权。

派活发生早晚不影响结果能否唤醒；投递时检查接收者当前持久控制状态。正常空闲时自动回报可启动新回合；用户停止后迟到结果只保留在待处理队列。

Stop 的队列取舍沿用既有产品行为：在 stop 提交点已经排队的 input 被撤回；在该提交点之后到达的报告/输入保留为 held。Stop 时 UI 保留当前 composer 草稿。这里不能先单独写 held，再稍后调用会清空新报告的 native abort。

### 原生能力缺口与采用路径

现有 1.3.0 没有可靠的会话级暂停消费能力。triggerTurn:false 薄接口只解决 admission。只包装报告入口、用 hook 拦截任务或将 all 改为 one-at-a-time，都不能阻止 compaction/model-visible write/工具边界消费队列。

实施采用版本固定、可审查的 pi-durable 通用 input-control 补丁，经 pnpm patchedDependencies 管理，保留来源与许可证；不修改运行时私有方法、不暂停整个 Harness、不另建 held 队列。补丁是第一里程碑的前置验证，不宣称已经实现或只需改二十行。上游接纳后撤下本地补丁，产品核心 interface 保持稳定。

补丁最小契约：

1. 原生 Inbox 内持久化 allowed/held 与可信停止来源，默认 allowed；fork 使用 initial。控制状态只有一份权威记录，应用只投影，不另存同义 wakeEnabled。宿主根据真实 caller 校验恢复权限；用户停止来源与控制版本在同一事务中校验，模型停止不能降级已有用户暂停。
2. held 下所有 input 强制 queued，包括 idle + 空 inbox 的直接 admission；所有 final/postTools/reset/compaction 路径均不得取出 input 并启动新回合。writes 仍按原生 stale/head 规则处理；display-only 写入不解除 held。
3. 原子 stop：在同一提交中写 held、撤回提交点现有 queued inputs、标记目标普通 live task abortRequested。保留原生 abort 缺省行为；暂停与是否撤回输入是两个独立选项。background workers/reporters 不进入取消范围。
4. stop 确认区分“停止意图已接纳”和“正在退出/已停止”；最终成功确认须目标普通范围已 idle。重复等待同一 stop 不能再次清退后来入队的报告。网络断开不撤销已提交的停止意图。
5. 原子 continue：旧 stop 普通取消范围尚未退出时返回 stopping/可重试并保留输入，不提前解除 held；native scope idle 后解除 held、处理可选新输入、从同一 Inbox 消费并在必要时 startRun。空队列不制造虚假用户消息；不把整个队列复制后重新 submit。保留当前 one-at-a-time/all 配置，不为报告擅改所有会话的全局模式。
6. stop/continue 使用稳定 requestId、持久 receipt 和 expectedControlRevision；去重/版本检查与状态修改、边界接纳必须在同一提交。旧 continue 重试不能覆盖后来的 stop。单独保存 lastRequestId 不足以去重更早的操作；控制版本只处理操作并发，不参与派活代次判断。
7. 若新输入控制字段升级 Inbox schema，提供现有记录迁移与明确版本校验；旧 runtime 不得静默忽略 held 后继续跑。回退与兼容失败需在该里程碑验证。

对外稳定的是 conversation module 的 stop/send interface：只有通过 caller/暂停来源校验的恢复意图进入原子 continue，模型 resume 参数不构成用户授权。native 通用控制操作必须能与宿主的权限/控制版本校验及 request receipt 处于同一事务，或自身提供等价的 request-aware 原子契约。多个 await 和内存锁不能替代此契约。

### 逐项队列操作

snapshot/SSE 提供每项 submissionId、mode、content、来源、接收控制状态及编辑条件 token。用户输入与报告共用队列 UI。PATCH 只编辑仍 queued 的原生 item；服务端事务校验旧 content token，冲突返回当前内容，避免另一标签页的旧请求覆盖新编辑。取消复用 abortSubmission；placed 返回冲突，已取消的重复请求幂等成功。

编辑/取消不解除 held、不启动模型。reporter 重试先读原有 queued/terminal receipt，不覆盖正文、不复活已取消项。原有整队 recall 可继续用于普通用户输入；报告使用同一组逐项操作，原始 child 历史始终可追溯。

## 6. 定义、配置与上下文准备

第一阶段采用 Markdown + frontmatter，行为对齐 pi-subagents；双向兼容、导入导出转换延后。Web 提供快速创建、表单与原文编辑；未知 frontmatter 静默保留，已知字段严格校验，实际不支持的 tools/MCP/extension 选择明确拒绝，不静默删除。

定义解析后的最小字段为 name、description、model、thinking、tools、context 策略，正文作为 instructions；使用当前 registry/catalogue 的身份。创建时解析为完整 effective configuration 并写入任务/会话 provenance，修改定义只影响之后的创建。不能只做部分 AgentChange：native task-owned createAgent 会复制父配置，创建/准备提交必须显式设置或清除继承的 model/thinking/tools/modelTools/extensions/instructions/cwd。

默认 context 为新上下文。策略由代理定义或用户配置预设，可指定固定来源位置 fork、在新 child 上 compact，或用显式注册的策略插件处理；主 agent 无权选择或覆盖策略，也不硬编码到核心。宿主依配置固定来源 position/entry 后再准备，父会话后续消息不会混入。准备失败可重试同一创建/派活身份；fallback 必须由定义声明，不悄悄退回空上下文。记录完成前不对 child 派发模型任务。

定义文件以 Execution Host 为所有者：project scope 存 workspace 的 .pi/agents，user scope 存网关声明的 agentDir/agents；project 同名覆盖 user。定位使用结构化 host/workspace/scope/name，不从 workspaceId 字符串推断主机。读写经 gateway 受限资源接缝，backend 解析与校验，Web 不在自己磁盘上找目标主机文件。

GET/PUT/DELETE /api/agent-definitions 由可选扩展的宿主 adapter 组合；PUT 支持 dryRun，普通保存同样校验。使用整份文档 last-write-wins、原子文件替换，表单保留未编辑字段；不引入配置 lease/乐观锁。删除定义不删除已创建会话或改变其快照配置。

子会话默认继承父会话的完整执行绑定（gateway/workspace/retained worktree），不是仅复制 cwd；模型执行与 credentials 仍在 backend。首版跨 host 可新建 fresh-context child；跨 host 的历史 fork/资源快照迁移不隐式承诺，需要单独验证绑定与 adopted resources 重置后再开放。跨主会话引用和控制不搬迁目标执行主机。

首版默认 child 不再 spawn，宿主提供可配置的并发/深度限制；超限明确返回，不引入第二个调度队列。后续由定义显式启用递归，仍通过同一原生创建/派活接缝。

## 7. Web 与最小核心 interface

Web 从 conversation catalogue 构建展示子树与 fork/history 来源视图。子会话与主会话使用相同 ChatWindow 和原生流投影。Sidebar 显示真实 running/held、等待回报和 blocked/interrupted 状态，不以父 busy 推导 child 状态。

首版交付：主会话内快速创建/派活入口、Settings 代理定义编辑、子会话列表/跳转、带来源的回报待处理卡片、逐项编辑/取消、Continue、原始历史/compact 标记与 fork-at 导航、跨会话引用选择与打开。配置和派活入口按扩展 capability 显示；历史、关系和通用控制读取保留。

| 核心操作 | 接缝契约 |
| --- | --- |
| spawn | 明确 creator、可选展示 parent、ownership、完整执行绑定与已解析配置；稳定请求去重；fork-at 使用核心显式创建接缝 |
| send | 复用原生 requestId/whenBusy/Submission；queue-only；正常完成可直接再派活；恢复需校验可信 caller 与停止来源，用户暂停时拒绝模型派活/恢复；获准 continue 原子接纳队列与可选输入，空 continue 不制造用户消息 |
| stop | 原子 held、提交点队列处理与普通工作取消；请求收据及当前控制状态一起返回 |
| get | 按 ID 读取状态/关系/有效配置，或按过滤条件分页列举；配置投影不包含 provider 凭据 |
| read | Read 风格的会话历史/指定 entry/block 读取；1-based 行 offset、行 limit、字节预算、续读位置与 membership 校验；正文和 diagnostics/details 分离 |
| 支持性宿主操作 | queue.edit/cancel、fork-at 与关系修改保留明确接缝；五个主入口不承担任意 action 分发器 |

### 服务器数据与文件工具

运行态、消息、派活身份与任务状态在 backend durable storage；代理 Markdown 定义和项目文件仍可位于 Execution Host。read/bash（以及通过 bash 调用的 rg 等文件工具）通过 ExecutionEnv 访问该主机文件；它们没有天然的 Conversation 数据源。文件工具继续用于文件；模型使用 agent_read，经核心 ConversationOperations.read 读取服务器持有的语义记录。

### agent_read 对齐原生 Read

用户最新决定：新增 agent_read 模型工具，委托核心 ConversationOperations.read；conversation_read 只保留底层 API。本工具保持读取职责，目标仍是 Conversation ID，沿用已授权的跨会话读取范围，不因 agent 前缀限制为当前调用者的 child。搜索、筛选、聚合和批量调用由未来 codemode 组合 agent_get/agent_read 完成，不内置 query/snippet 匹配。现有 Web session-search 保持原职责，不扩成 read 的依赖。

- 输入使用会话身份与可选 entry/block 资源定位，常规分页采用 offset/limit；offset 为 1-based 行号，limit 为最大行数，与原生 Read 一致。
- 默认读取原始历史的稳定文本呈现，保留 entry/role/block 定位；多行消息按实际文本行处理，不把一条 message 或一条 JSONL 当作一行。模型 context 是派生视图，首版不把 context 查询模式加进此读取入口。
- 内容返回原生 text/image output；范围、来源 entry 引用、截断和续读信息放 details/diagnostics，codemode 可结构化获取，读取正文无需解析说明性尾注。
- 复用原生 Read 的默认行数/字节预算（2000 行/50 KiB）及可复用的 UTF-8 截断、图片处理逻辑；大图片仍受模型输入与宿主预算约束，图片按明确 block 引用读取。
- 连续读取固定首次读取的历史终点；追加消息不改变此前行映射。续读位置携带足够的 entry/block/文本内位置，避免每页重新扫描完整历史。工具遇到单行超过字节预算时也必须给出可用续读位置；不能照搬原生 Read 的 bash/sed 提示，因为数据不在执行主机文件里。
- 模型工具与未来 codemode 共用同一读结果和预算。codemode 可逐页过滤、批量读取并只输出所需摘要；调用总量、输出和执行时间由宿主预算约束，不靠一次拉全量日志再筛选。

原始文件 read/grep/find 无法仅靠换路径读取 SQLite 会话。对齐的是读取契约与可复用实现，不要求把会话挂成 ExecutionEnv 虚拟文件，也无需给 gateway 注入 backend token。

沿用现有 conversations/messages/submissions/events/abort HTTP 基础；新增 continue、pending item 操作和 raw-history 查询。具体 URL 随 owning route 实施固定，不增加第二套 agent runtime HTTP 调度协议。模型工具由宿主注入同一 interface，不依赖 ConversationHandle 恰好拥有宿主 Conversation.commit。

## 8. 原生、适配与 runtime 增强清单

| 能力 | 实现判定 |
| --- | --- |
| 持久 Conversation、fork、原始 history、Task/Submission 终态、safe replay | 原生提供；应用接入既有 projection/read 接缝 |
| 后台独立执行与恢复 | 原生 background task + 扩展任务定义；需实现完整任务交接，不是 callback 包装 |
| queue-only、编辑、取消、报告 kind/data | 原生 Tx/Inbox/Submission/InputEntry + 已有薄接口及少量宿主操作 |
| 展示层级、creator、引用、定义及上下文策略 | hepi 文档/扩展与 gateway/Web adapter；不伪装成 native fork 或 owner |
| 停止后持续不消费、不自动启动 | 1.3.0 不提供，必须先补通用 input-control 原生接缝 |
| 任意 entry-parent 的历史分支编辑 | 当前 native 不提供；首版使用 fork-at 的会话分支树 |
| Pi CLI ExtensionAPI / 子进程 / Unix socket | ABI 不兼容；不搬入当前执行架构，Markdown 全互通另期 |

保留现有 call-scoped execution wrapper：EnvTarget 仍没有 taskId/callId。保留 subscribeCommits；不为升级改写稳定观察接口，不另建 worker 状态库。

## 9. 实施依赖与完成标准

| 阶段 | 依赖 | 完成标准 |
| --- | --- | --- |
| M0 基础升级与 enqueue 薄接口 | 已完成 | 现有检查、3 项接口测试、旧 SQLite SIGKILL→1.3 恢复与 CLI pack smoke 通过 |
| M1 原生 input-control | M0 | 五类消费/直接 admission 路径全部验证 held；stop/report/continue 并发和 crash 后意图正确；默认聊天行为兼容 |
| M2 核心关系与历史 | M0，可与 M1 并行 | creator≠parent，独立主会话创建、子 fork 保持身份、raw 历史/附件、已删除父显示与引用通过 |
| M3 可选扩展执行闭环 | M1 + M2 | child 无 contact 也自动回报→正常完成复用 send→用户 stop→模型恢复被拒绝→用户 continue；主 stop 不影响 child/reporter；关闭工具仍可读/恢复 |
| M4 定义与执行侧资源 | M0，可与 M1/M2 并行 | 本地/SSH project/user 定义读写、完整配置快照、按配置执行上下文策略、拒绝模型策略覆盖与准备失败处理通过 |
| M5 Web 完整接入 | M3 + M4 | 快速创建、定义编辑、完整子会话、可编辑队列、历史树/引用完成真实浏览器流程 |
| M6 系统验收与文档 | 测试随各阶段落实，最后组合 | 下述产品旅程与真实进程 crash 场景通过，迁移限制与当前指南同步 |

每阶段先在真实 native 接缝验证关键行为，再扩展界面；M1 不是可跳过的附加优化。实施票据按上述依赖拆分，不在本轮提前编写产品代码。

## 10. 最终验收

1. 扩展未启用时普通聊天无退化；已有 child 的历史仍可打开。
2. A 创建独立 B 与子 C，B 能读取、派活和停止 C；创建来源、展示关系与回报接收者各自正确。
3. 主 stop 不停止 child；stop 确认后回报可见 queued，不进入模型。编辑/取消后 continue 按最终正文执行，取消项不复活。
4. 报告早于 stop 提交按既有撤回语义处理；晚于 stop 提交保留；重复 stop 不清掉后来队列。迟到旧任务在接收者已明确继续时按当前 allowed 处理。
5. compaction/reset/model-visible write、空 inbox 直接输入、工具中间/结束边界不能绕过 held；过期 continue 重试不能解除新 stop。
6. child fork 仍为原父的 child；compact 前历史、继承图片/read blocks 可读；父 tombstone 不导致 child 身份或历史消失。
7. 定义更改不改变已有 agent；完整配置不残留父 tools/instructions；本地/SSH/worktree 执行绑定正确。
8. 在创建 child、初始 admission、等待终态、回报入队、编辑/取消、stop/continue 的提交交接点 SIGKILL 后重开：不重复 child/派活/回报，不丢队列决定，恢复已确认的当前执行意图。
9. unsafe 工具不盲目重放；missing_task/task_too_old/migration_failed 明确可见。模型流断开不承诺逐 token 原位续接，也不承诺外部副作用 exactly-once。
10. child 从未调用 contact 也能在正常完成/失败/中断后自动回传一次终态；中途 contact 不提前结算或重复最终回报。父上下文收到带自动来源的最终结果/引用，不自动注入完整 child 历史。
11. 正常完成的 child 保留 ID/历史，agent_send 可直接再派活；接收者正常 idle 时被结果唤醒，running 时按边界接纳而不并发另起回合。
12. 用户停止 child 后，agent_send(resume:true) 不能派活/解除暂停；核心 send API 同样校验暂停权限，另一 agent_stop 不能覆盖用户停止来源；只有用户明确恢复后模型才可再派活。框架迟到回报仍可见 queued，拒绝的模型派活不产生新的 dispatch。
13. 模型工具注册为 agent_spawn/send/stop/get/read 五个入口，不注册 conversation_*。agent_read 与底层核心 read 共享读取契约、权限/成员关系校验、预算与续读；Web/HTTP 仍可使用 conversation API。
14. 上下文策略严格来自代理定义/用户配置；模型工具不暴露策略或来源覆盖参数，越权覆盖明确拒绝。主 agent 的任务正文不改变宿主策略；按实际配置固定来源、完成准备并保存 provenance 后才开始派活。

详细恢复场景见 [durable recovery](durable-recovery.md)；现有探针只证明基础，不代替上述尚未实现的产品验收。

## 证据入口

- [主流多 agent / 多会话行为比较](mainstream-agent-behavior.md)：Claude、ChatGPT/Codex 与 SDK 分层研究；自动回报、正常完成后复用与用户停止优先已按本轮确认同步到本文。
- [ZCode 完成回传源码核对](zcode-completion-note.md)：自动完成通知的实现证据，不把内存回调当作本项目的持久恢复保证。
- [难点与启发式审计](design-risk-review.md)：实现前读取共享答案、stop drain、Read 续读和语义压缩的限制。
- [1.3.0 升级、探针与现有薄接口](durable-upgrade-results.md)
- [原生队列复用与版本差异](native-queue-reuse.md)
- [可行性事实](pi-durable-feasibility.md)
- [扩展与参考行为研究](subagent-extension-study.md)
- [Pi 行为研究](pi-subagents-research.md)
- [历史格式比较，兼容工作延后](profile-compatibility-api.md)
- [Codex 生命周期参考，产品统一 stop](codex-lifecycle-semantics.md)
