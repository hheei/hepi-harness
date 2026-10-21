# Durable subagents — 正式规格

Status: ready-for-agent
Labels: ready-for-agent
Date: 2026-10-16
Scope: 已确认产品设计的正式规格；用户已批准按票据开始实现，不部署或重启生产服务。

## Problem Statement

用户需要让主 agent 将工作分给可持续协作的子 agent，同时继续自己的工作，并能打开每个子会话查看完整过程。目前 backend 已有原生持久会话、任务、提交和队列，但尚无完整的委派、自动回报、持久停止和 Web 操作链。只靠轮询、临时回调或文件工具不能可靠读取服务器会话，也不能保证用户停止后迟到结果不会重新启动模型。

用户还需要明确控制边界：代理定义决定执行配置与上下文准备；主 agent 负责选择角色和交付任务；用户的停止决定不能被另一个模型覆盖。

## Solution

提供可选 subagents 扩展，复用单一 backend durable runtime。主 agent 创建持久 Child Conversation 后立即继续工作；child 独立执行，框架在整个 Submission 结束后自动回传最终答复或终态，无需 child 调用完成联系工具。

正常完成的 child 保留身份和历史，可直接再次派活。结果到达正常空闲的接收者时可以启动新回合；到达运行中的接收者时按原生边界排队；到达用户停止的接收者时保持为可编辑、可取消的待处理项，直到用户明确继续。

Web 提供定义编辑、快速创建、子会话树、完整聊天、历史来源与引用导航，以及逐项队列和 Continue。模型工具只提供 agent_spawn、agent_send、agent_stop、agent_get、agent_read；conversation_* 是共用底层 API，本阶段不注册为模型工具。

## User Stories

1. As a 用户, I want 在主会话中快速选择代理并派活, so that 可以并行完成工作。
2. As a 主 agent, I want 创建 child 后先获得稳定身份并继续执行, so that 无需阻塞等待或不断轮询。
3. As a 用户, I want 打开 child 的完整消息、工具过程、模型和历史, so that 可以审查和直接参与工作。
4. As a 用户, I want child 正常完成后保留同一 ID 和历史, so that 后续任务能够延续已有上下文。
5. As a 主 agent, I want 收到框架自动捕获的最终答复或终态, so that child 不需要额外联系调用或总结回合。
6. As a 接收 agent, I want 正常空闲时被结果唤醒、运行时按消息边界接收, so that 不丢协作结果或并发另开同一会话的回合。
7. As a 用户, I want 停止主会话时 child 继续工作, so that 暂停我的对话不会误杀后台任务。
8. As a 用户, I want 停止后的迟到结果保持为可见队列项, so that 我可以决定何时交给模型。
9. As a 用户, I want 用户停止不能被模型 resume、contact 或再次 agent_stop 覆盖, so that 停止具有可信优先级。
10. As a 用户, I want 明确 Continue 或立即发送输入后恢复正常调度, so that 不需要创建替代会话。
11. As a 用户, I want 在停止尚未退出时收到明确 stopping 并保留输入, so that 不会丢失刚写好的内容。
12. As a 用户, I want 编辑或取消每个尚未接纳的队列项, so that 模型只消费我最终确认的内容。
13. As a 多标签页用户, I want 过期编辑和已 placed 项返回当前状态及冲突, so that 旧操作不覆盖新决定。
14. As a 用户, I want 回报重试不覆盖编辑或复活取消项, so that 重连和重启不撤销我的决定。
15. As a 用户, I want 定义角色的模型、thinking、工具、instructions 和上下文策略, so that 每种代理按预设方式工作。
16. As a 用户, I want fresh/fork/compact 或注册策略由定义或用户配置决定、由框架执行, so that 主 agent 无权临时改变上下文准备方式。
17. As a 用户, I want 修改定义只影响之后创建的 agent, so that 已有会话继续使用可追溯的配置快照。
18. As a 用户, I want 在本地或 SSH Execution Host 上管理 project/user 定义, so that Web 不会写到错误主机。
19. As a 用户, I want 表单和原文编辑保留未知 frontmatter 并拒绝已知不支持的能力, so that 保存不会静默损坏定义。
20. As a 用户, I want child 默认继承完整 Execution Host/workspace/Retained Binding, so that 工具在正确目录与身份下执行。
21. As a 用户, I want 创建来源、展示 parent、fork 来源、运行 owner、回报 recipient 分别准确, so that 跨会话协作不改变已有关系。
22. As a 另一主会话的 agent, I want 读取、派活和控制已授权目标会话, so that 协作不限于自己的展示子树。
23. As a 用户, I want 普通 child 聊天不自动向展示父回报, so that 只有显式委派产生对应回报且不会循环。
24. As a 接收 agent, I want 通过 agent_read 有界读取原始历史或指定 entry/block, so that 不必把服务器数据库伪装成主机文件。
25. As a 接收 agent, I want 按行读取、得到图片和可靠续读位置, so that 大历史、多行消息和超长单行均可继续读取。
26. As a 用户, I want compact 前记录和继承附件仍可读取, so that 上下文压缩不等于历史删除。
27. As a 用户, I want 从 child 的历史位置创建独立子分支, so that 保留来源又不继承运行任务、待处理队列和暂停状态。
28. As a 用户, I want 隐藏父会话后 child 与继承历史仍可打开, so that 关系变化不会丢失独立工作。
29. As a 用户, I want 通过结构化会话/entry 引用定位其他讨论, so that 无需自动合并全部会话内容。
30. As a 用户, I want 重启恢复已提交的派活、队列和停止决定, so that 无需猜测是否重发。
31. As a 用户, I want 不可安全重放或缺少定义的工作明确显示 interrupted/blocked, so that 系统不会重复未知外部副作用或伪报成功。
32. As a 用户, I want 不启用 subagents 时普通聊天继续工作, so that 可选功能不成为基础会话的前置依赖。
33. As a 用户, I want 关闭委派工具后已有历史和兼容后台任务仍可读与恢复, so that 功能开关不删除既有工作。
34. As a 用户, I want 并发和深度限制明确拒绝超限请求, so that 不产生隐藏的第二个调度队列。
35. As a 用户, I want 分清已答复与业务验收通过, so that 不把执行终态当作代码或测试正确性的保证。

## Implementation Decisions

### D01

**权威边界与公共接缝**

backend 是唯一会话运行时和 SQLite writer。ConversationOperations 的 spawn/send/stop/get/read 是业务规则入口；HTTP、Web 与可选扩展 adapter 共用它。Gateway 提供 Execution Environment 和执行侧资源，不承担第二套会话运行时。核心接收已解析配置和明确身份，不解析代理定义或解释策略。

### D02

**模型工具与可信调用者**

只注册 agent_spawn、agent_send、agent_stop、agent_get、agent_read。conversation_* 保留底层 API。目标使用 Conversation ID；get 可按条件分页列举，read 沿用已授权跨会话读取范围。真实 caller/task/call 身份来自宿主，不从模型正文信任自报身份。模型 self-stop 拒绝，用户可停止当前会话。get 的配置投影不包含 provider 凭据。

### D03

**关系与引用**

持久保存 createdBy、可选 hierarchy.parentId、配置/上下文 provenance 以及消息携带的结构化 Conversation Reference；原生 fork source 和 owner 直接投影。creator、展示 parent、fork source、owner 和每次派活 recipient 互不替代。创建接缝同事务校验自引用/成环，不加通用图服务。独立 Main Conversation 可由另一会话创建；省略展示 parent 时仍为主会话。

父 tombstone 不级联删除、不提升 child 为主会话，界面明确父已隐藏且 child 可打开。跨会话读取或控制遵守既有授权，不因非当前 child 而一律拒绝；引用不自行授予控制权或搬迁目标主机。

### D04

**派活、任务与可恢复交接**

使用原生 Conversation、Task、Submission、Inbox 与 checkpoint。稳定 dispatch 身份持久关联 target、submission、recipient 和配置来源；创建、准备、admission、等待与回报可重入。工具先返回 child/dispatch 身份，终态由可恢复 reporter 投送。background anchor/report 的任务定义属于可选扩展，置于正确的 conversation-owned background 范围，普通父 stop 不跨越。task 数量按真实恢复边界确定，不按每个步骤预建模块。

完整 Submission 终态及 answer identity 是完成依据；generation handover、长时间无输出或文本“完成”均不替代。done 表示已答复，不表示业务验证成功。多个合并/steer Submission 可以共享 answer；保留各自 receipt 和共享引用，不猜测拆分正文。需要任务隔离时新建 Conversation。

### D05

**自动回报与唤醒**

child 自然输出最终答复，框架自动捕获完成、失败或中断；无需完成 contact 或额外总结回合。中途 contact/消息仅为沟通，不提前结算。只为显式登记的派活投送一次最终回报，普通用户聊天及自动回报触发的回合不按展示 parent 继续级联报告。

以 hepi.agent-report InputEntry kind/data 向登记 recipient 的原生 Inbox/Submission 投送，携带源会话/dispatch/submission/answer 引用，并明确自动 agent 来源。只搬运最终答复/终态；大结果使用确定性截断预览和完整内容引用，不自动搬运全部工具过程/thinking 或调用模型猜摘要。

投递时按 recipient 当前持久控制状态决定唤醒：allowed+idle 可启动，allowed+running 按原生边界排队且不打断工具，held 只入队。recipient 已 tombstone 时以 recipient_deleted 结束投递并保留源结果，不写入、不无限重试；通用写入/控制同样校验 tombstone。

### D06

**原生输入控制与兼容**

已完成的 1.3.0 升级和 queue-only admission 作为基础复用；queue-only 不等于持久停止。采用版本固定、保留来源和许可证的通用 pi-durable input-control 补丁，经 pnpm patchedDependencies 管理；上游提供等价契约后替换补丁，不让产品依赖私有 runtime 方法或包装猴子补丁。

同一原生 Inbox 权威记录 allowed/held、可信停止来源与控制版本；默认 allowed，fork 使用 initial。覆盖空 Inbox 直接 admission，以及 final、postTools、reset/handover、可见 write 与 compaction 的所有 input 消费路径；held 时 input 必须 queued，不能启动回合。writes 保留原生 stale/head 规则，display-only write 不解除 held。全局 Harness.resume 不改变会话控制状态。不另建 held 队列、wakeEnabled 状态库或第二个调度器。

若需 Inbox schema 升级，必须验证旧数据迁移及旧 runtime 对不兼容 held 记录的明确拒绝；不能静默降级成 allowed。兼容/回退的可行性是交付前置验证，不由文档宣称已成立。

### D07

**原子 Stop 与用户优先级**

stop 在同一提交持久 held、撤回该提交点已有 queued inputs、标记目标普通 live tasks abortRequested。提交之后到达的回报保留；重复 stop/等待同一操作不能重新清空后来项。保留原生 abort 缺省契约，暂停和是否撤回输入保持独立。composer 草稿保留，background child/reporter 不取消。

返回值区分意图接纳、stopping 与普通范围已 idle。网络断开不撤销已提交 stop。用户停止只能由可信用户 Continue 或立即发送输入恢复；用户 queue-only 输入不恢复。模型 resume、自动回报、contact 或另一次 agent_stop 不能降级用户停止来源。仅由 agent 停止的目标可在旧取消范围退出后接受获准模型的明确恢复意图。

### D08

**原子 Continue 与幂等控制**

旧 stop 的普通取消范围未退出时，continue 返回 stopping/可重试，保留输入且不解除 held；根据原生范围事实判断，不用固定延时。idle 后在同一提交校验 caller/停止来源、expectedControlRevision 和持久 request receipt，解除 held、接纳可选新输入并从原 Inbox 消费/启动。空队列恢复不制造虚假用户消息，沿用 one-at-a-time/all 配置。

stop/continue 使用稳定 requestId、可重取收据与控制版本，去重、权限和状态修改在同一事务。迟到旧 continue 不覆盖后来 stop，单一 lastRequestId 或内存锁不构成保证。控制版本用于操作并发，与 dispatch 或 SSE 投影 revision 分开。

### D09

**待处理队列操作与投影**

snapshot/SSE 投影原生 queued 项的 submissionId、mode、content、来源、控制状态与编辑条件 token。用户输入和报告共用队列。编辑同一 queued item 时事务校验旧 content token；冲突返回当前内容，placed 项拒绝修改。取消复用原生 abortSubmission，已取消重试幂等，placed 返回冲突。

编辑/取消不解除 held，不启动模型；reporter 重试不覆盖新正文、不复活取消项。原始 child 历史不变，用户编辑的是接收方待处理副本。保留原有普通用户输入整队 recall，不用它替代报告逐项操作。旧 HTTP receipt 不回退较新投影。

### D10

**Agent Definition 所有权与保存**

Agent Definition 是配置，不是运行实例。Markdown/frontmatter 提供 name、description、model、thinking、tools、context 策略和正文 instructions；创建时固定完整 effective configuration 和定义来源。未知 frontmatter 保留，已知字段校验，不能执行的工具/MCP/extension 选择明确拒绝，不静默删改。行为对齐 pi-subagents，但不承诺 CLI 全格式互通。

定义归 Execution Host。project scope 使用项目代理定义目录，user scope 使用网关声明的 agentDir 对应目录；project 同名覆盖 user。以结构化 host/workspace/scope/name 定位，经 gateway 的受限资源接缝读写，backend 解析，Web 不在自身磁盘查找目标文件。宿主提供 GET/PUT/DELETE agent-definitions API，PUT dryRun 和保存采用同一校验；整文档 last-write-wins、原子文件替换，表单保留未编辑字段。不引入定义 lease 或乐观锁。修改/删除定义不改变已有会话。

### D11

**上下文策略由配置决定**

主 agent 只选择代理并提供任务。fresh/fork/compact 或显式注册准备策略来自 Agent Definition/用户配置，宿主解析后执行；模型 spawn/send schema 不暴露策略、插件或来源位置覆盖参数，任务正文不覆盖宿主策略。

默认 fresh。宿主按配置固定 source conversation/entry，再执行可恢复准备；父后续消息不混入。准备结果提交前不派模型任务。失败明确可见、按同一创建身份重试，fallback 必须由配置声明。语义 compact 有损，不保证原文等价；插件可用既有注册接缝，不要求首版实现自动“重要上下文”选择或通用插件平台。

完整配置必须设置或清除原生自动继承的 model/thinking/tools/modelTools/extensions/instructions/cwd；不能让 fork 来源决定实际代理能力。普通用户 fork 保留 fork 位置配置快照并接受明确用户覆盖；agent_spawn 则执行定义的完整快照。

### D12

**Execution Environment 与限制**

child 默认继承完整 gateway/workspace/Retained Binding，而非单独 cwd。凭据和模型请求仍由 backend 所有；不向 gateway 或浏览器投递 backend/provider token。结构化主机身份解析遵循现有 registry，不解析 workspaceId 拼写。已有会话不切换 workspace；跨主机会话引用不搬迁执行绑定。

跨 host fresh child 可经已有明确绑定创建，跨 host 历史 fork/资源迁移本期不承诺。默认 child 不再 spawn；宿主提供并发/深度限制，显式超限拒绝，不新增调度队列。递归只通过定义和同一接缝显式启用；不开放无限递归。

### D13

**原始历史与 agent_read**

ConversationOperations.read/agent_read 读取 backend 语义记录；普通文件 read/bash/grep/find 继续读取 Execution Environment 文件，不增加 SQLite 虚拟文件系统。read 可读取完整 fork-aware 原始历史或指定 entry/block，不以 active context/SSE 窗口代替。精确校验 conversation membership，不能凭全局 entry ID 越过成员关系。共享前缀与附件用当前读取的 conversation+entry 解析，含 compact 前内容和父 tombstone 后继承内容。

对齐原生 Read：offset 为 1-based 实际文本行号，limit 为最大行数，默认 2000 行/50 KiB；正文为 text/image，范围、entry/block 引用、截断和续读放 details/diagnostics。图片按明确 block 读取并遵守宿主/模型预算。首次固定 tail；续读携带 entry/block、entry 内行/字符位置、固定 tail 与呈现版本，追加历史不改变已读映射。超长单行也返回 UTF-8 安全分片和可用 token，不返回 bash/sed 指令。顺序续读不逐页重扫全历史；大 offset 首次定位不承诺 O(1)，输出预算也不代表存储内部解码内存上限。

本期不内置 query/search/snippet/context 查询。未来 codemode 组合 get/read；不因此提前交付 codemode 或全文索引。现有 Web session-search 保持职责。

### D14

**Fork 与展示历史**

历史来源由 native conversation fork 边、entry 顺序和 compact/reset 标记表达；不增加 native 尚无的任意 entry-parent 编辑树。child fork 保持展示 parent，但创建独立 native background anchor 和明确 owner、新配置/provenance、独立 dispatch/Inbox/控制初始状态，不解除既有拒绝后退回 ownerless fork，也不复用旧 anchor/任务。

anchor 绑定正确的源 child conversation-owned background 范围，不要求仍可写展示父；父 tombstone 后仍能创建合法子分支。继承历史与 read blocks 可读，运行任务/队列/stop 不继承。分支创建请求同样幂等。

### D15

**Web 与可选扩展**

复用现有 catalogue/watch/SSE、ChatWindow 和纯生命周期投影。Web 提供快速创建、Settings 定义表单/原文编辑、child 展示树与跳转、真实 running/held/stopping/blocked/interrupted 状态、回报待处理项、逐项操作与 Continue、原始历史/compact 标记/fork-at、结构化引用选择和打开。不以父 busy 推导 child 状态，不建每个目录项永久监听器。

关闭委派入口时保留已安装兼容 task definitions、已有历史/关系/通用控制读取；不启用扩展时普通聊天无退化。实际缺少或不兼容任务定义时显示 missing_task/task_too_old/migration_failed，不以假成功 handler 替代。退出浏览器不停止 backend 工作。

### D16

**恢复能力的边界**

用同一 SQLite 与原生 checkpoint 恢复已确认意图。每条派活和回报的逻辑身份去重，编辑/取消/控制收据持久。只有 intent 与当前定义都支持 safe replay 才重跑工具；unsafe 工作明确 interrupted/unknown，不承诺任意外部副作用 exactly-once 或模型流逐 token 原位续接。进程 SIGKILL 证据不外推为磁盘损坏/断电保证。

保留现有调用级 Execution Environment wrapper 和提交观察接口，不借此重写稳定接缝。真实副作用计数、模型请求、收据与重开投影构成恢复证据。

## Testing Decisions

测试主接缝为实际 HTTP/模型工具调用经 ConversationOperations 到原生 runtime 与同一 SQLite 的可观测行为；断言身份、Submission 终态、模型请求次数、队列正文、控制结果和副作用，避免测试 helper 调用顺序或内部 task 数量。

- 原生 input-control 例外需要直接使用公开 runtime API 驱动每类消费边界，证明宿主外包装无法替代的 held 保证；再经 HTTP 检查用户语义。
- 沿用现有受控模型、真实 SQLite、原生 memory/faux API 测试先例；不依赖付费模型判断测试是否通过。
- Web 用生产构建和独立端口验证关键旅程，复用提交恢复、前后台生命周期、图片/延迟文本和窗口化历史的既有驱动方式。原生原子性矩阵不在浏览器重复展开。
- 定义读写使用本地/真实 localhost SSH gateway 接缝；校验远端实际文件、原子保存、结构化身份和不会本地 fallback。
- crash 测试使用独立进程、测试独占 SQLite、受控模型/工具和提交交接点真实 SIGKILL；正常 close、页面刷新和 listener 单测不是替代。
- 每张 ticket 在其公开行为接缝验证并更新 owning guide；最后组合执行相关选择检查和浏览器/进程旅程，保留实际命令、revision、dirty 状态、退出码和日志。不得把本次文档检查当作产品验证。

| 验收 ID | 必须可观察的结果 |
| --- | --- |
| A01 | 扩展关闭时普通聊天无退化；兼容任务仍恢复，历史可读，缺失定义显示真实 blocked 原因。 |
| A02 | A 创建独立 B 与 child C；creator、展示 parent、owner、fork source 和 recipient 分别正确，合法跨会话操作不改关系。 |
| A03 | 模型工具恰为五个 agent_*；不注册 conversation_*，get 不泄露凭据，caller 不由正文自报，模型 self-stop 被拒绝。 |
| A04 | child 不调用 contact 也自动回报完整 Submission 终态一次；工具轮 handover 不提前回报，中途联系不结算。 |
| A05 | 正常完成保留 child ID/历史，可直接 send；合并输入共享 answer 引用，各 dispatch receipt 正确。 |
| A06 | allowed idle 被结果唤醒；running 按边界接收且不打断工具、不并发另起回合；普通聊天不循环回报。 |
| A07 | 主 stop 不取消 child/reporter；停止后迟到结果可见 queued 且无父模型请求。 |
| A08 | stop 提交点既有输入撤回、之后报告保留；重复 stop 不再次清空，所有五类 admission/消费路径均遵守 held。 |
| A09 | 用户停止后模型 send/resume/agent_stop 无法解除或降级；拒绝不新增 dispatch；用户明确恢复后模型可继续。 |
| A10 | stopping 时 continue 保留输入；idle 后原子恢复/消费；空 continue 无虚假用户消息，旧请求不覆盖新 stop。 |
| A11 | queued 项编辑/取消不启动模型；多标签页旧 token 和 placed 项冲突；reporter 重试不覆盖/复活，重开后决定保留。 |
| A12 | 本地/SSH 定义 project 覆盖 user；dryRun 不落盘，保存原子，未知字段保留，已知无效能力拒绝；改删只影响后续创建。 |
| A13 | 配置完整快照无父能力残留；上下文策略只由定义/用户配置决定；模型越权覆盖被拒绝，源位置固定，准备提交后才执行。 |
| A14 | fork/compact 准备失败显式可重试，不重复 child/派活、不静默 fallback；compact 不被声称为无损。 |
| A15 | child 继承完整本地/SSH/worktree/Retained Binding；跨主机 fresh 明确绑定，超限拒绝且不引入第二队列，child 默认不再 spawn。 |
| A16 | agent_read/HTTP 共享完整原始历史和 membership；多行/超长行、追加期间续读、图片与预算可用，无逐页全历史重扫。 |
| A17 | child fork 独立 owner/任务/队列/控制状态，保留展示 parent 和来源；compact 前历史/继承附件可读，父 tombstone 不破坏它。 |
| A18 | Web 可快速创建、打开完整 child、编辑定义、查看真实状态、编辑取消待处理项、继续、浏览历史/fork 和打开引用。 |
| A19 | 创建/admission/终态至回报/回报入队至确认等交接点 SIGKILL 后保持同一 child、dispatch、submission、report 身份。 |
| A20 | stop drain、continue、编辑/取消后 SIGKILL 保留最新意图和决定；global resume 不解除 held；unsafe 不盲重放。 |
| A21 | 旧 SQLite 迁移和不兼容 runtime/任务版本行为明确；不静默忽略 held，不伪造成功，不声称外部副作用 exactly-once。 |
| A22 | recipient tombstone 结束投递为 recipient_deleted 并保留源结果；通用写入/控制拒绝隐藏目标，父隐藏不级联 child。 |

## Out of Scope

- 将 conversation_* 注册为模型工具；由模型临时选择上下文策略或覆盖源位置。
- 第二套代理进程/Unix socket 监督器、第二状态库、held 队列或调度器。
- Pi CLI ExtensionAPI 动态加载、Markdown 双向全格式兼容和导入导出转换。
- 任意 entry-parent 历史编辑、拖拽重组展示树、已有会话迁移 workspace、跨 host 历史 fork/资源迁移。
- read 内建搜索/语义摘要/全文索引、会话虚拟文件系统、本期交付 codemode 或自动重要上下文插件。
- 将模型权限选择称为 OS sandbox；新增隔离、安全模型或无界递归。
- 解决其他 Settings/provider/OAuth/通知能力，或顺带重构稳定调用观察与执行包装。
- 生产部署或重启；上线另按既有交付范围执行。

## Further Notes

本规格和 [实施票据及依赖图](README.md) 是后续实现的权威入口。产品范围已获用户确认；具体 URL、模块命名、任务数量、准备策略编码与并发限制数值可在 owning ticket 选择并记录，不扩大上述语义。默认 fresh、默认 child 不再 spawn 和明确超限拒绝已经固定。遇到原生契约无法实现时，先记录可复现阻塞和影响，不用应用层私有补丁绕过。

基础 M0 已完成，不重复开实施票据：1.3.0 升级与 queue-only 接口的现有证据见 [基础升级结果](../webui-next-exploration/durable-upgrade-results.md)。这些证据来自既有未提交工作区，不等于完整 subagent 产品通过。

设计来源与恢复解释见 [已确认设计](../webui-next-exploration/conversation-api-proposal.md)、[恢复矩阵](../webui-next-exploration/durable-recovery.md)、[风险审计](../webui-next-exploration/design-risk-review.md)。研究材料为证据，不覆盖本规格。

沿用 [领域词汇](../../GLOSSARY.md)、[单权威运行时](../../docs/adr/0001-single-authoritative-durable-runtime.md)、[执行侧资源](../../docs/adr/0002-skills-follow-execution-environment.md)、[SSH 显式归属](../../docs/adr/0005-ssh-project-one-profile-explicit-owner.md)、[提交生命周期](../../docs/adr/0006-durable-submission-lifecycle.md)、[生命周期投影](../../docs/adr/0007-lifecycle-facts-one-projection.md)。本地 tracker 按 [issue 约定](../../docs/agents/issue-tracker.md) 管理；发现按 [review policy](../../docs/agents/review-policy.md) 判断，不把假设性风险自动扩成阻塞。
