# 原生排队、触发与 Web 复用接缝复核

日期：2026-10-16。用户要求优先复用既有功能。本轮为源码研究与隔离探针，没有修改产品或升级依赖。结论修正此前“没有高层 held 参数所以需要应用层新队列”的推断：优先复用 native pi.inbox、Submission、事务、取消和恢复；需要补齐的是暂停消费的控制接缝及 Web 逐项操作。

## 1. 核对版本与原始源码

- 当前项目：已安装 @earendil-works/pi-durable 1.1.0。除 dist 实现外，读取了 inbox.js.map、submissions.js.map、types.js.map 中嵌入的原始 TypeScript sourcesContent，来源为 src/harness/*.ts。不是仅搜索 d.ts。
- 当前官方上游：git ls-remote 获取 HEAD `4954d760504c11df9b2cbdc040346107b6a8153d`，packages/durable/package.json 为 1.3.0。直接抓取该 SHA 的 types.ts、inbox.ts、submissions.ts 与 examples 20/23。它与当前安装版本确实不同，不能把本地 1.1.0 结论冒称当前上游结论。
- 1.1.0 与本次核对的 1.3.0 SubmissionDraft 都没有 input triggerTurn/trigger:false。当前上游新增 InputEntry(kind/data) 和 display-only write 直接写入，见下文。

## 2. 名为“不触发”的已有能力分别是什么

| 能力 | 行为与可复用范围 |
| --- | --- |
| native input + whenBusy=followUp | 忙时排队，当前 run 回答后可以启动下一 run；不是 idle-held 开关 |
| native type=write | passive entry，无 input 时不请求模型；已进入模型上下文的 entry 不等于仍待用户编辑的队列项 |
| 公共 Tx.createSubmission + InboxDoc | 可创建原生 queued input 而不 startRun；确实能排队但暂不触发，是本轮探针验证的关键接缝 |
| native followUpMode=all | 同一个 final 边界消费多个 follow-up，继续消息与已有报告可在同一 run 处理；不是暂停开关 |
| Pi CLI/SDK sendCustomMessage | triggerTurn:false、deliverAs:nextTurn 已存在，属于 pi-coding-agent AgentSession，不是 durable Conversation 接口；可参考行为，不能直接当 durable 参数传入 |

当前 CLI 实现见 apps/server/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1774-1815。nextTurn 路径保存待下轮的自定义消息，triggerTurn:false 路径不主动启动回合；这与用户记忆中的功能接近。

## 3. 已验证的原生 queue-only 路径

在 conversation.commit 中先读 submissionByRequest 与 InboxDoc，再创建 status=queued/type=input 的 Submission，把其 ID、followUp 模式和正文加入 InboxDoc.items。两者在一笔 native commit 中保存；无需额外权威队列。

使用公开接口，未修改 private 字段或加入不受支持的自定义 inbox mode。Tx.createSubmission 明确允许调用方自己实现 admission；adapter 仍须负责去重、调用来源、允许状态及输入校验。

隔离探针验证：

- 同一 requestId 返回原 Submission，不重复入队。
- enqueue 后 resume/waitForIdle，模型调用数仍为 0。
- 在 native transaction 中修改 InboxItem.content，仍不调用模型。
- abortSubmission 取消 queued input，移出 inbox，留下原生终态 receipt。
- 正常输入会消费同一个 inbox，不需要从应用队列再复制到 native。
- 默认 one-at-a-time 会分次处理排队项；followUpMode=all 可将报告和 continue 输入合并到一个 run。此模式当前为 harness 级设置，不能未经评估全局改变其他会话行为。

### 尚未解决的真实边界：queue-only 不等于可靠 hold

当前 1.1.0 在 idle 且 inbox 非空时，任何走 admitSubmission 的新提交都会执行 final boundary，包括 type=write。因此，一个普通 passive write 可消费 queued followUp 并 startRun。探针已直接复现，模型调用从 0 增到 1。

后台 compaction 的 summary 放置也走 admitSubmission(type=write)，所以“只在我们自己的报告入口不调用 submit”不足以保证用户 stop 后不再唤醒。stop 还会撤回原生 queued input，需要确定操作顺序及哪些报告是停止后新入队的项。

1.3.0 改善了显示专用写入：只有 kind/data，没有 model/head/edits，且前面没有 queued reset 时，会直接追加，不消费普通队列。但含 model 的 compaction summary 仍走正常 admission，因此新版本没有自动解决所有 hold 情况。上游 src/harness/submissions.ts:187-196、202-224。

正确的下一步是围绕 native inbox 增加或复用统一的暂停消费/继续接缝，让 admission 与 generation 边界遵守接收会话当前控制状态。不要分别在每个 passive-write、compaction 或报告调用者补分散的特判，也不要加入框架不认识的 inbox mode。本轮尚未实现该接缝。

## 4. Web 已有能力与最小扩展

| 已有位置 | 当前行为 | 复用与补足 |
| --- | --- | --- |
| ChatInput.tsx:1725-1791 | 输入框上方有原生排队列表，steer/follow-up 分组 | 在相同列表显示子结果，补来源、稳定 ID、逐项编辑/取消 |
| ChatInput.tsx:2240-2287 | 运行中有 steer/follow-up 按钮，Alt/Option+Enter 走 follow-up | 复用发送与排队交互；现有按钮只在 streaming 时出现，不是停止后的 held 控件 |
| zh-CN.ts:590-591 | steer 提示当前回复及工具结束后送达，follow-up 提示 Agent 完成后排队 | 文案描述忙时送达边界，没有承诺永远不触发下一回合 |
| ChatInput.tsx:1750、useAgentSession.ts:1948 | 移回输入框：整队撤回后 prependText 编辑 | 复用 composer/草稿编辑，不重做输入组件；逐项操作需扩展 |
| server.ts:1896-1911 | recall-queue 在事务中编辑同一个 InboxDoc、settleSubmission | 项目已经直接使用原生事务接缝；可提取共用的单项 edit/cancel 操作 |
| server.ts:405-409 | snapshot 从 inbox 投影 steering/followUp 文本数组 | 补 ID 与来源投影，而不是另设前端权威队列 |
| durable-api.ts:601、631 | prompt 映射原生 whenBusy；clear_queue 转发 recall | 沿用现有 adapter 通路，新增小范围命令/队列操作 |

显示在 Web 并不意味着已贡献给模型：原生 queued input 仍在 InboxDoc，边界消费时才变成 entry。恰好符合用户的“可见、可改、可取消，继续才处理”。

## 5. crash 恢复实测

独立进程打开真实 SQLite，在 queue-only 入队并编辑的提交完成后 SIGKILL。重开同一库，resume + waitForIdle：

- 仍有一个原生 queued input，内容是 crash 前编辑后的正文。
- 模型调用数为 0。
- 使用原生 abortSubmission 取消，再次重开：队列为空，同 requestId 的原生 receipt 为 unanswered/aborted。

这验证队列、编辑和取消记录可沿用 native 持久化；没有验证尚未实现的 stop hold 控制或完整 subagent reporter 链。后者仍需 [durable 恢复设计](durable-recovery.md) 中的产品集成验收。

复现命令，均为本地 faux 模型，无付费调用；临时 SQLite 会清理：

```sh
node .scratch/webui-next-exploration/probes/native-queue.probe.mjs
node .scratch/webui-next-exploration/probes/native-queue.probe.mjs --all
node .scratch/webui-next-exploration/probes/native-queue-crash.probe.mjs
```

## 6. 对设计的修正

采用 native queue-first：保留一个 native inbox 和 Submission 事实来源，恢复依赖 native storage/tasks。Web 复用现有排队列表、recall/composer 和共享快照。新增工作聚焦 queueOnly admission adapter、逐项操作/来源投影、持久控制状态与 native 消费边界的衔接。应用层独立 held 队列不再是预定方案。

若需要扩展 native，优先补通用 enqueue-only/暂停消费能力；是否升级 1.3.0 需另外评估，当前未升级依赖。当前上游 InputEntry 可承载报告类型和来源，display-only entry 可承载不进入模型的展示事件，均是可选复用点。

## 官方源码

固定当前上游 SHA，不能据此称本项目已运行 1.3.0：

- [SubmissionDraft 与 InputEntry](https://github.com/earendil-works/pi/blob/4954d760504c11df9b2cbdc040346107b6a8153d/packages/durable/src/harness/types.ts#L58)
- [Admission 与 display-only 分支](https://github.com/earendil-works/pi/blob/4954d760504c11df9b2cbdc040346107b6a8153d/packages/durable/src/harness/submissions.ts#L171)
- [原生 inbox 边界](https://github.com/earendil-works/pi/blob/4954d760504c11df9b2cbdc040346107b6a8153d/packages/durable/src/harness/inbox.ts)
- [Inbox 示例](https://github.com/earendil-works/pi/blob/4954d760504c11df9b2cbdc040346107b6a8153d/packages/durable/test/examples/20-inbox.ts)
- [后台 subagent 示例](https://github.com/earendil-works/pi/blob/4954d760504c11df9b2cbdc040346107b6a8153d/packages/durable/test/examples/23-subagent-background.ts)
