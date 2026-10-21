# 子代理、待处理队列与 crash 恢复

状态：2026-10-16，最终方案的恢复验收补充。产品行为、职责与实现顺序以 [最终方案](conversation-api-proposal.md) 为准。pi-durable 1.3.0 升级、queue-only adapter 与独立原生队列/跨版本 SIGKILL 探针已通过；完整 subagents、持久 input-control 与 Web 队列链尚未实现，下面产品级验收尚未运行。

## 1. 恢复基础与产品缺口

| 范围 | 当前基础 | 尚需交付 |
| --- | --- | --- |
| 存储 | 同一 durable SQLite 存储、native Task/Submission/Inbox 与 checkpoint | 关系/provenance、控制收据、扩展任务与队列来源投影 |
| 启动 | backend startPaused 打开、恢复 catalogue 后再 Harness.resume | 兼容 task definitions、held 与 blocked 状态接入；全局 resume 不解除单会话 held |
| 任务恢复 | running 重回 pending，waiting 保留依赖，completing 继续 reconcile | 创建/派活/回报以 native task phase 恢复完整交接 |
| 原生输入 | queue-only adapter、编辑同一 Inbox item、abortSubmission | 逐项 Web 操作、编辑条件校验、可靠 held/continue |
| 会话控制 | 当前普通 abort 撤回队列并中断普通任务 | 通用 input-control 补丁，实现原子 stop/continue 与重试收据 |

原生 SQLite + resume 不是产品端到端 crash-safe 的证明。

## 2. 恢复当前意图

busy 从 native run 推导，allowed/held 与可信停止来源是持久输入消费意图；在同一原生 input-control 记录中保存。结果到达不更改该意图，也不按 child 创建代次决定调度。正常完成保留 Conversation ID/历史与 allowed，后续 send 可直接派活。

- allowed：结果正常 admission；忙时排队，闲时可启动。
- stop：提交点原有 queued inputs 依既有产品契约撤回；此后到达的输入保留在 held Inbox。child/reporters 的 background 范围继续运行。
- continue：用户停止只能由可信用户的明确继续/立即发送输入解除；模型派活/恢复被拒绝。仅由 agent 停止且无用户暂停时，才允许模型的明确继续。获准后按队列当前正文接纳已有项；后续结果可正常唤醒。
- crash：恢复最近已接纳的意图；明确 stop 不变自然 idle，正常运行也不被误判为 stop。

编辑/取消不解除 held。待处理结果未进入父模型上下文；用户修改的是父待处理副本，child 原始历史保持可追溯。

## 3. 交接点矩阵

创建/派活、等待与回报由 native task phase/checkpoint 承载；这些是恢复边界，不要求每行拆一个任务或模块。

| crash 窗口 | 重开后的完成标准 |
| --- | --- |
| child 创建提交后，spawn 答复前 | 稳定 dispatch 身份重取同一 child，不重复创建 |
| child admission 后，调用者 receipt 前 | 原 requestId 重取同一 submission，不重复派活 |
| child 模型/工具阶段 | 从 checkpoint 恢复，遵守 safe/unsafe replay |
| child 终态后，投送前 | 持久 reporter 重取完整 submission 终态并投送，不依赖已丢失 listener |
| 父结果 queued 后，reporter 确认前 | 原 report requestId 命中同一 queued/terminal receipt，不重复结果 |
| 用户编辑或取消后 | 保留修改/取消，reporter 重试不覆盖或复活 |
| stop 已提交，取消尚未 drain | held 与 abortRequested 均已持久化，恢复完成普通范围取消，不清退提交后到达的报告 |
| continue 接纳队列后，HTTP 答复前 | 同一操作收据和原 native admission 可重取，不重复消费/运行 |
| 新 stop 后收到旧 continue 重试 | 重试命中原收据或控制版本冲突，保持新 held 状态 |
| 用户停止后 crash，再收到模型 resume 或 agent_stop | 保留用户停止来源；拒绝模型派活/恢复，agent_stop 不降级为 agent 停止；框架结果仍可 queued |

等待对象是完整 child submission。child 直接输出最终答复，框架自动取结果并报告，无需 contact 或额外总结回合；中途通信不替代最终回报。generation task 在工具轮间可能 handover，第一段 task 终态不等于整个派活完成。可恢复 task phase 内可重取稳定 submissionId 并等待；裸 Promise.then 或 SSE 回调不是可靠 reporter。

每次派活显式保存 recipient；展示父关系或 native owner 不用于猜回报对象。只为登记委派报告，不把自动回报引发的普通消息再次无条件报告。

## 4. 原生 input-control 验证

详细契约集中在 [最终方案](conversation-api-proposal.md)。runtime 补丁实施时至少分别覆盖：

1. final 生成完成后的队列消费；
2. 工具轮终结/reset/handoff；
3. postTools 中间边界与 queued reset；
4. idle + 非空队列的 input/model-visible write/后台 compaction；
5. idle + 空队列的直接 input admission。

held 下上述路径都不消费 input 或启动新回合。writes 按 native stale/head 规则处理；1.3 display-only write 可直接显示，不影响输入控制。测试还须覆盖已排队 reset 的分支。

stop 的 held、提交点队列撤回和普通任务取消在同一提交；continue 的解除 held、可选输入与边界消费也在同一提交。稳定 requestId/持久 receipt/expectedControlRevision 与控制修改同事务生效；lastRequestId 单字段不能排除更早的重试。

Stop 已接纳但普通取消范围尚未 idle 时，Continue 返回 stopping/可重试，不提前清除 held；避免旧 abort 的 endRun 清除 run 后留下无人消费的新队列。依据 native scope 状态，不按固定时间等待推测。

队列编辑在事务中检查 queued 状态及旧 content token；旧标签页修改返回冲突。取消复用 native 终态；已 placed 明确冲突。所有控制或队列冲突返回当前状态，Web 不能用旧操作 receipt 覆盖新 snapshot。

若 Inbox schema 升级，验证旧数据迁移和旧 runtime 对新数据的拒绝行为，避免回退到忽略 held 的版本。全局 Harness.resume 只恢复调度器，不授权解除任何会话的 held。

## 5. 原生恢复的边界

- 只有已存工具 intent 与当前工具定义都允许 safe replay 时才重跑。unsafe 工具产生 interrupted 结果，可能已有外部副作用；不承诺任意 bash/API exactly-once。
- 模型请求可从 checkpoint 重新发起，已提交 partial 可转为 aborted entry；不承诺远程流逐 token 原位续接。
- terminal abort 不复活；continue 创建新工作。background tasks 同样参与 live task 恢复。
- 可选工具关闭后，已安装兼容 task definitions 继续可用。缺少或不兼容定义显示 missing_task/task_too_old/migration_failed，不丢弃任务，也不注入假成功 handler。
- 子分支恢复保持显式 native owner、展示 parent 和 fork source；Inbox/control 初始状态不从源分支复制。父 tombstone 不删除继承历史或附件。
- 这里验证进程 SIGKILL 恢复；磁盘损坏/断电耐久性遵循实际 SQLite 配置，不能由进程测试外推。

“任务回到主线”指身份、可恢复执行、结果、待处理决定与后续控制重新投影。不可安全重放或缺少定义的工作明确显示中断/阻塞，不强行重跑外部副作用。

## 6. 产品验收执行方式

使用独立 backend 进程、同一 SQLite、受控模型/工具，在上述提交交接点注入真实 SIGKILL 后重开。正常 close 或页面 reload 不替代该测试。

覆盖正常/held 父会话、独立运行 child、无 contact 的自动回报、正常完成后复用派活、用户停止来源持久化与模型恢复拒绝、报告投送前后、编辑/取消、stop/continue 冲突、定义升级/缺失和 safe/unsafe 工具。每例记录 crash 前确认的 receipt、重开投影、模型请求与 side-effect 次数。只有这些旅程通过才宣称完整产品链具备对应恢复保证。

已通过的基础探针和运行方法见 [升级结果](durable-upgrade-results.md) 与 [原生队列复核](native-queue-reuse.md)，不把基础探针重复记为产品验收结果。
