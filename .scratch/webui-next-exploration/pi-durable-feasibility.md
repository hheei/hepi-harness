# pi-durable 可行性核对

状态：2026-10-16。原始核对基于 1.1.0；当前工作区已升级到 pi-durable/chord/pi-ai 1.3.0，已实现 submitConversationInput queue-only 薄接口，并通过旧 SQLite SIGKILL→1.3 恢复探针。产品行为与实施顺序以 [最终方案](conversation-api-proposal.md) 为准；完整 subagents 与持久 stop 尚未交付。

## 能力判定

| 需求 | 原生能力 | 所需实现 |
| --- | --- | --- |
| 可选 subagents | Extension tools/tasks/sections/hooks/wraps、可选工具选择 | 独立扩展包与宿主 HTTP/Web adapter；CLI ExtensionAPI 不可直接加载 |
| 持久会话、复用与子分支 | Conversation、显式 task ownership、fork-at | 创建来源、展示父关系；child fork 分配独立 anchor，显式配置 ownership |
| 主 stop 不停 child | conversation-owned background task 不进入普通 abort/idle 范围 | 正确注册 anchor/deliver/report；不把 background 放在 tool-owned task 上 |
| 自然结束后一次回报 | Submission 终态、稳定 requestId、可恢复 Task | 保存 dispatch/recipient 身份、等待完整 submission、幂等投送；非内存 listener |
| queue-only、编辑、取消 | 公开 Tx + InboxDoc + createSubmission；abortSubmission | 已有 admission 薄接口；逐项状态/内容校验、来源投影和 Web 控件 |
| report 元数据 | 1.3 InputEntry kind/data | 使用自定义报告 kind，保留源 conversation/dispatch/entry 引用 |
| 持久 held 与 continue | **1.3.0 不提供** | **版本固定的通用 input-control runtime 补丁，作为首个前置里程碑** |
| 完整原始历史和附件 | Conversation.entries 为 fork-aware storage scan；现有 visibleEntry/read blocks 复用它 | 新增 raw-history 分页；当前 pageEntries 只分页 active view |
| 上下文准备 | fork、context、compact、公开事务与 AgentDoc 配置 | 代理定义/用户配置选择 fresh/fork/compact/策略插件，宿主执行并保存来源位置与完整 effective configuration；主 agent 无策略覆盖入口 |
| 模板只影响新 agent | 每个会话独立 AgentDoc | 创建时保存解析快照；完整覆盖/清除 native 自动复制的父配置 |

## 通用 conversation interface 与读取适配

底层统一为 ConversationOperations.spawn/send/stop/get/read；Web、HTTP 与 agent_* 模型工具使用同一 core interface。模型入口为 agent_spawn/send/stop/get/read；agent_read 直接委托核心 read，其余 adapter 按需叠加定义解析、上下文准备与委派回报。conversation_* 保留为底层 API，本阶段不注册为模型工具。正常完成后 send 直接复用原会话；恢复权限按可信 caller 与持久停止来源校验，用户停止拒绝模型派活/恢复，获准的 continue 才进入原子控制接缝。自动报告遵守 held。

会话运行态与历史由 backend 持有，Markdown 定义与项目文件仍在 Execution Host。文件 read/bash 或 grep/find adapter 只覆盖对应 ExecutionEnv 文件。Conversation.entries 提供原生语义读取；agent_read 经核心 read 对齐原生 Read 的正文/图片输出、1-based 行 offset、行 limit、2000 行/50 KiB 预算及独立 details/diagnostics。默认读稳定原始历史呈现，指定 entry/block 可精确取内容；超长行与多页读取提供可靠续读。

按用户最新决定，read 不内置 query、匹配或摘要；未来 codemode 组合 get/read 完成筛选、搜索与聚合。首版不加 context 查询模式，不扩现有 Web session-search，也不把会话复制成文件或挂虚拟文件系统。原生 Read 的截断/图片处理逻辑可复用；它依赖 bash/sed 的超长行提示需替换为会话读取自身可用的续读位置。

## 唯一必需的 runtime 增强

现有 triggerTurn:false 只绕过本次 startRun。后续后台 compaction、带 model/head/edits 的 write、final/postTools/reset 边界仍可取走队列并触发模型；idle + 空 Inbox 的直接 input admission 甚至不经过 applyBoundary。公开 hooks、全局 queueMode 与只包装报告入口不足以封闭这些路径。

采用路径是 pnpm patchedDependencies 管理通用 input-control 补丁，保留 upstream 版本/来源/许可证，未来切换到上游原生 API。详细状态、原子操作与版本要求集中在 [最终方案](conversation-api-proposal.md)的第 5 节。这里只列可行性边界：

- input 消费与 admission 都识别同一持久 held 状态及可信停止来源；用户停止不能被模型恢复或改写为 agent 停止。writes 仍遵守原生上下文规则。
- stop 在同一提交中设置 held、撤回提交点已有输入并标记普通工作 abortRequested；此后到达的输入保留。暂停标记与是否撤回输入保持正交，原生默认行为兼容。
- continue 在同一提交内解除 held 并接纳队列/可选新输入。稳定 requestId、持久 receipt 与 expectedControlRevision 防止迟到的旧请求覆盖新 stop。
- 产品 stop/send interface 包住原生控制实现；只有通过 caller/停止来源校验的恢复意图可解除 held。runtime 需提供可组合的事务接缝或等价的 request-aware 原子操作，包含该校验与控制版本检查。多个 await 不能替代原子性。

这些补丁尚未实现或验收。现有队列和升级探针不能证明产品 stop 已可靠。

## 保留的事实限制

- Native owner 不可转移；展示父、creator 与本次回报 recipient 独立。跨会话派活不改变 owner。
- abortSubmission 只撤回 queued 输入；placed 返回 already_placed，不单独中断已合并进 run 的某个输入。产品 stop 作用于会话当前普通工作。
- 原生 abort 会撤回队列，因此不能先写 held 再另一次调用 abort；两次操作间到达的结果会被误清。
- native createAgent 会复制 task owner 的配置，部分 AgentChange 会保留未指定父字段；创建须提供完整配置并清除无关继承项。
- 关闭工具与卸载任务 definitions 不同。missing_task/task_too_old/migration_failed 应真实投影，不造占位成功任务。
- 仍需现有 call-scoped ExecutionEnv wrapper：1.3 EnvTarget 没有 taskId/callId。subscribeCommits 保持兼容。
- 原生支持 fork-at 的会话来源树，不等于任意 entry-parent 历史编辑；Markdown 全互通与 CLI selector 逐项兼容延后。

## 已撤回的 terminal-contact 需求

旧设计要求 contact_conversation 后立即结束 child 生成，当前采用自然结束加框架自动结果投送：child 不调用 contact 也能可靠回报；主动 contact 仅用于中途通信，不提前结算。无需 terminal-contact 契约。原生 control.terminate 需要同轮所有工具 slot 都请求 terminate，sequential 仍执行剩余 slot；这一事实不再阻塞本方案，也不因此修改 generation 的工具短路语义。

## 证据与验证状态

- [升级结果及跨版本恢复探针](durable-upgrade-results.md)
- [原生队列实测与版本差异](native-queue-reuse.md)
- [产品恢复验收矩阵](durable-recovery.md)

当前 1.3 源码位置：包 dist/harness/harness.js 的 Conversation.entries/create；agent.js 的 createAgent/configure；submissions.js 的 admitSubmission；inbox.js 的 prepareBoundary/applyBoundary；generation.js 的 final/postTools；scheduler.js 的 abortConversation。位置按符号核对，旧研究行号仅适用于各自记录版本。
