# 主流 multi-agent / multi-conversation 行为比较

研究日期：2026-10-16。依据当日官方文档；产品行为可能随版本、客户端和运行模式改变。本文保留比较研究与候选建议；用户已确认的自动回报、正常完成后复用、用户停止优先及正常空闲唤醒已同步到 [最终方案](conversation-api-proposal.md)。这些是设计决定，完整产品尚未实现。

## 结论

最值得借鉴的是把用户能感知的行为分清，而不是复制工具名称。Claude Code 把 subagents、agent teams 与 cross-session messaging 分开介绍；OpenAI 的 Agents SDK 明确区分 agents-as-tools 与 handoffs；ChatGPT Projects 的分支/共享上下文又是另一层。相同 send 接口可以承载不同策略，但不能代替这些产品决定。[C1][C2][C3][O2][O3]

当前 hepi 需求包含：长期保留且可打开的 child Conversation、复用、跨主会话派活、后台运行和定向回报。因此它同时涉及可复用委派与会话协作。应先定行为，再收敛具体工具参数和 runtime 接缝；原生 input-control 缺口仍存在，但实现方式不应倒过来决定用户语义。

## 1. 先分清比较对象

| 模式 | 用户面对的对象 | 公开保证/定位 | 不能混同的行为 |
| --- | --- | --- | --- |
| Claude Code subagent | 一次委派及其可继续的 agent transcript | 独立 context；前台等待或后台工作；结果返还；部分 agent 可恢复 | 不是所有 agent 都可复用；Explore/Plan 是 one-shot |
| Claude Code agent team | lead 与独立 teammate sessions | 用户可直接打开/消息队友，队友互发消息，可共享任务列表 | teammate 的会话恢复有明确限制；不等价于 durable 重启恢复 |
| Claude agent view / background sessions | 完整且可重新打开的后台 conversations | 关闭总览仍运行；进程退出后用户 reply/attach 可从保存的对话重启 | 保留记录不等于关机后任务无缝继续 |
| Claude cross-session messaging | 已存在的其他 sessions | 文本消息、独立入站策略、可选单次 idle 通知 | 消息不搬运完整历史，不代表用户授权 |
| ChatGPT Projects / branch | 组织中的 conversations、共享资源与分支 | 分支保留原 thread，形成另一 chat；项目记忆依设置引用其他 chats | 共享上下文不等价于相互派活或自动唤醒 |
| Codex subagent workflow | main thread 与 agent threads | 委派并行工作、查看子线程、汇总、steer/stop/close | 文档未定义所有 stop/close/reopen 的底层精确协议 |
| OpenAI Agents SDK | 可组合的 agent 配置与运行流程 | manager 作为工具调用专家；handoff 让专家接管当前轮 | SDK 可用能力不证明 ChatGPT 内部使用相同机制 |

来源：[C1][C2][C3][C4][O1][O2][O3]。ChatGPT agent mode 文档只足以确认用户可以中途引导/中断任务和接管浏览器；不足以确认任意后台 child 的会话归属、投递与恢复规则。[O4]

## 2. Claude 的几个决定性行为

### 上下文必须明确传递

[C1]：普通 subagent 开始于 fresh isolated context，不自动看到主对话历史；fork 是明确例外。恢复 agent 时保留其既有历史。Explore/Plan 不返回可恢复 ID，不能把“所有 agent 都持久可复用”说成 Claude 的统一规则。

[C2]：teammate 加载项目上下文和 spawn prompt，lead 的 conversation history 不自动携带。用户可以直接打开 teammate transcript 交谈。

因此我们的 fresh / exact fork / explicit preparation 策略有参考基础；用户已明确策略由代理定义/用户配置决定，宿主执行，主 agent 不临时选择或覆盖。自动继承全部父历史、自动语义选择重要内容不是必需规则。

### 正常完成与用户取消的恢复权限不同

[C1] Resume subagents 原文：

> When Claude sends a completed subagent a message with the SendMessage tool, the subagent resumes in the background without a new Agent invocation.

> A subagent you stopped yourself, with x in /tasks or an SDK stop_task request, doesn’t auto-resume.

对后一种，模型发送消息会被拒绝并告知 agent 已取消；用户在 agent transcript 中输入以恢复后，模型消息才能再次自动恢复。相对地，模型自己通过 TaskStop 停止的 subagent，在该 run 退出后可以被 SendMessage 恢复。这里必须区分“用户停止”和“agent 停止”，也不能把 SDK stop_task 与模型工具 TaskStop 当成同一入口。

用户已确认采用该边界：正常完成的 child 可沿用历史接受新派活；用户停止只能由用户恢复，agent_send(resume:true) 不能越过。该规则已同步最终方案及恢复验收。

### 最终结果由框架自动回传

[C1]：前台 subagent 的答复通过 Agent 工具结果返回；后台结果由框架以 completion notification 交给主会话。child 无需调用主动联系工具。Codex 的完成 watcher [O5] 与 [ZCode 完成回调源码核对](zcode-completion-note.md) 也确认 runtime 自动处理正常最终回传。

用户已确认保留这个模式：框架依据原生执行终态交付最终结果；主动 contact/send 用于中途提问、报告阻塞和同步进度，不作为最终回传的前置条件。此结论不把 Claude 未公开的内部实现等同于我们必须采用的持久 task phase。

### 回报对象不必等于展示父

[C1]：交互模式中，subagent 恢复另一个已结束 subagent 后，后者向恢复它的 subagent 回报；向自己所报告的 launcher 发消息是例外，不因此重定向 launcher 的结果。

这支持把创建/展示关系与一次委派的接收者分开。也提示不要把“最后一条消息是谁发的”直接当成所有后续结果的永久接收者。

### 消息投递、处理与唤醒分开

[C3] Message delivery：

> The receiving Claude reads the message between tool calls during an active turn, so a running tool is never interrupted.

> When the receiving session is idle, Claude Code starts a new turn with the message.

入站策略独立提供 accept / hold / refuse：hold 会显示通知但不交给模型，之后 accept 生效时释放。配置 hold 不是 Escape/Stop 的同义词；文档没有证明停止主会话自动将跨会话策略改为 hold。不能用这份文档推导“所有 Claude Stop 都永久阻止来信唤醒”。

[C3] 另有显式 notify_when_idle 单次订阅；订阅本身不启动被观察会话，通知在 idle 接收方可启动新 turn，并受入站控制。它是“下次 idle/退出通知”，不是我们每个 dispatch 的 Submission settlement 契约；不应将两者互换。

### 不把本地并发能力误读成持久恢复

[C2]：in-process teammates 不被 /resume 和 /rewind 恢复；任务列表可持久保留，但不代表队友 runtime 已恢复。普通 session/turn 结束、进程退出、整个 team shutdown、用户针对单个 agent 停止是不同事件。未公开的组合不据猜测补齐。

### 完整后台 session 是另一种重要参照

[C4] agent view 明确：

> Each background session is a full Claude Code conversation that keeps running without a terminal attached, so you can open it, reply, and leave whenever you want.

关闭 agent view 不停止 session；进程退出仍可查看，reply/attach 可从保存的 conversation 重启。supervisor 能跨自身更新/重启保留状态，但关机仍停止运行中的 session。这更接近我们的“可打开、可复用、后台工作”身份模型；它不要求先加入 team，也不意味着消息自动拥有改变其他 session 的权限。其一行进度摘要明确由 Haiku-class model 生成，是有损的呈现策略；我们可以保留原生状态并把摘要作为可选显示，不能把摘要文本当成调度事实。

## 3. OpenAI 给出的参照与边界

[O1] 当前 Codex subagents 文档明确：保持主线程处理需求/决策，委派探索/测试等工作，返回摘要而非大量中间输出；支持查看 child thread，以及请求 steer、stop、close。它没有完整规定 parent 被用户 Stop 后迟到结果的处理、跨主线程的任意派活权限、closed thread 的可复用性、crash 后 exactly-once 投递。

[O2] Projects 的 branch chat 是保留原对话并创建另一条可继续的 conversation；项目内对其他 chats 的引用受 memory 设置控制。分支来源和共享知识不表示运行所有权、父子取消或自动报告。

[O3] Agents SDK 直接给出两种模式：

- Agents as tools：manager 保持用户对话控制权，专家处理有界子任务，manager 综合结果。
- Handoffs：专家成为当前 turn 的 active agent，接管余下处理。

两种可以组合，但属于 SDK 的编排选择，不能拿来证明 ChatGPT 后端具体机制。我们的多 Conversation 不需要为了名称对齐额外引入 handoff；它只在产品明确要求“切换当前对话的执行者”时相关。

已有源码审计的固定版本 7ae831991792744434027c431dfbc7e81dd5c12c 在本轮重新读取确认：control.rs 的 completion watcher 为结果通知使用 InterAgentCommunication(..., /*trigger_turn*/ false)，另一分支调用 inject_fragment_without_turn。也就是说，此路径的完成通知不承诺自动启动 idle parent。[O5] 这与 Claude cross-session 来信在 idle 时启动新 turn 的规则不同；不存在可以直接照搬的统一“主流默认唤醒”。我们的正常空闲主会话自动处理回报仍是显式产品选择，不是假称与 Codex 一致。

更细的 Codex 源码证据与版本边界见 [OpenAI 专题](openai-behavior-study.md)。Claude 细节见 [Claude 专题](claude-behavior-study.md)。

## 4. 针对当前需求的候选行为模型

以下表格区分本轮已确认规则与仍属建议的能力；实施契约以最终方案为准。

| 用户场景 | 建议行为 | 参照/理由 |
| --- | --- | --- |
| 创建子 agent | 创建可打开、可复用的子 Conversation；agent definition 是配置，单次 dispatch 是工作请求 | 与可继续 subagent/独立 teammate 的区分一致，不把身份与一次 run 混成一个状态 |
| 子 agent 默认上下文 | fresh + 明确任务描述；其他策略由定义/用户配置指定，宿主固定来源并执行，主 agent 不覆盖 | 配置决定策略；Claude 普通 context 与 fork 分开，Codex 未公开部分不推断 |
| 查看进度 | 直接打开同一个 child conversation；查看不启动运行 | Codex child thread、Claude transcript 可检查 |
| 再派活 | 已确认：正常完成后直接 send 复用同一 Conversation/历史；运行中遵守其队列语义 | 正常完成不要求用户额外恢复，不承诺每个请求隔离成独立答案 |
| 普通主会话自然结束 | child 继续后台工作；已登记结果可启动正常空闲主会话 | 符合当前已确认目标；不是“主 agent 说完”就销毁 worker |
| 用户停止主会话 | 按已确认目标，child 继续；迟到结果可见但不自动恢复已停主会话 | 保留用户优先；UI 应明确显示暂停与待处理，不能只显示 idle |
| agent 派活/恢复发给用户停止的目标 | 已确认：拒绝模型派活/恢复，resume 参数不能解除用户暂停；框架报告仍保留待处理，用户恢复后才可再派活 | 已同步最终方案，不把拒绝派活与保留自动回报混为一谈 |
| B 向 A 的 child C 派活 | 明确本次调用来源与回报接收者 B，不重挂展示父、不移交全部会话控制 | Claude 可恢复 agent 的结果路由有相似依据；我们的开放权限仍是本产品决定 |
| fork 对话 | 新 Conversation，保留来源位置；不继承运行任务、队列或父子取消权限 | ChatGPT branch 提供来源参照，不等价于委派 |
| 队友协作与共享任务板 | 以后按实际需要增加；首版不因研究 teams 就新增成员协议/任务看板/优雅退出协商 | 当前已确认需求不要求这些功能 |

## 5. 日常旅程的最小审阅样例

这里描述 hepi 的候选/既有行为组合，不冒充任一家产品的完整默认规则。

1. 用户让主会话调查两个问题；主会话创建两个 child，继续自己的工作。
2. 一个 child 正常答复；主会话收到该次委派回报，合适时继续处理。用户能打开原 child 查看完整过程。
3. 用户给已完成的 child 追加任务；复用原 Conversation，产生新 dispatch，不复活旧 native task。
4. 用户停止主会话；两个 child 的工作不因此被停止。此后到达的回报进入可见待处理项，主会话保持暂停。
5. 用户明确继续主会话；按编辑/取消后的待处理内容恢复。已确认 agent 来信本身不能越过用户暂停；用户恢复后再次允许正常派活/自动唤醒。
6. 用户从历史位置 fork；打开另一条会话。它有来源，但不因来源而自动获得原委派的待处理工作与回报订阅。

先用这条旅程评估交互是否自然，再决定是否需要 team task board、通知订阅或更多工具参数。

## 6. 应先定下的少数规则

1. **会话身份与委派工作分开**：同一 child 可复用；一次 dispatch 的状态与回报独立记录。
2. **消息语义明确**：通知/资料、请求执行、结果交接的触发策略可不同；同一底层 send 不代表 UI 混成一个动作。
3. **用户停止优先**：只有用户可恢复用户暂停，模型 resume 参数无权越过；正常完成则可直接再派活。
4. **完成与关闭分开**：一次工作已答复，不等于会话被关闭；查看、继续、停止、删除不能共用一个 completed 状态。
5. **回报约定明确**：直接向 child 聊天不自动广播父；显式委派才登记回报，避免相互唤醒链。

在这五条稳定后，再把并发、SIGKILL、超大输入和 missing_task 等技术验收挂到相应行为上。无需现在把所有主流模式做成一套通用协作平台。

## 一手来源

- [C1] Claude Code, [Create custom subagents](https://code.claude.com/docs/en/sub-agents)，尤其 foreground/background、context、resume、fork 部分。
- [C2] Claude Code, [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams)，尤其 comparison、direct messaging、architecture、limitations 部分。
- [C3] Claude Code, [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)，尤其 delivery、notify_when_idle、inbound controls 部分。
- [C4] Claude Code, [Agent view](https://code.claude.com/docs/en/agent-view)。
- [O1] OpenAI, [Subagents](https://developers.openai.com/codex/multi-agent)，当日抓取标题为 Subagents / ChatGPT Learn，区分当前文档与历史源码快照。
- [O2] OpenAI Help, [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt)，尤其 branch a chat 与 memory 部分。
- [O3] OpenAI Agents SDK, [Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)。
- [O4] OpenAI Help, [ChatGPT agent](https://help.openai.com/en/articles/11752874-chatgpt-agent)。
- [O5] OpenAI Codex, [固定版本的 completion watcher](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/agent/control.rs#L453)。本轮直接抓取该版本原始源码复核，静态分析，非执行测试；不把它推断为所有版本/客户端的 ChatGPT 行为。

本轮仅研究与设计记录，无产品代码、依赖、服务或 graph 改动。
