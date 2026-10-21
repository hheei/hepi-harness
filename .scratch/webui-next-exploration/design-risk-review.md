# Subagent 方案：实现难点与启发式审计

日期：2026-10-16。设计审计，产品尚未实现；读取当前 pi-durable 1.3.0 源码与 [方案](conversation-api-proposal.md)，不把接口推导记为产品验证通过。

## 结论

生命周期控制可以依据持久事实实现，不需要用“多久没输出”“文本说完成”推测。真正存在模型判断的是业务完成质量，以及配置明确启用的语义摘要/上下文处理插件；上下文策略本身由代理定义或用户配置决定，不由主 agent 选择。工程难点是 input-control 补丁、共享 run 语义、Read 续读和可恢复交接。

## 1. 持久 Stop 与 Continue：难，但可确定实现

原生 admission/applyBoundary 不识别 held；需要既定 M1 补丁。Stop 之后立即 Continue 另有实际交接窗口：旧 generation 正在 abort，LiveDoc.run 尚未清除；此时 resume+submit 会先排队，旧 abort 的 endRun 不消费该队列，可能留下 allowed+idle+queued。

采用明确前置条件：先依据可信 caller 与持久停止来源校验恢复权限，用户停止拒绝模型派活/恢复；模型停止不能降级用户暂停。获准后，普通取消范围退出前 Continue 返回 stopping/可重试，保留 composer；只有 native scope idle 才接受解除 held 和接纳。权限/控制版本校验和状态修改须同事务。根据 native task/run 事实判断，不用固定延时或 busy 边沿猜测。旧控制请求仍按收据/版本处理。

依据：dist/harness/scheduler.js abortConversation 在标记后 waitForIdle；generation.js abort 调用 endRun 而不 applyBoundary。scheduler 的 #gated 会拒绝已持久 abort-mark 的普通 run 提交；实现应复用该保护，覆盖 hook continuation/handover 的交错，不另造超时完成推断。

Disposition：M1 必须验证；不是应用层薄封装能替代的部分。

## 2. 多输入可能共享一个答案：语义必须明确

generation.js postTools 将 steers 加入 live.run.inputs；live.js endRun 用同一 settlement 结束这些 inputs。多个 submission 可以都 done，且 answer 指向同一个 entry。

因此“哪个 submission 结束、答案 entry 是什么”有确定事实；“答案哪一段属于哪次派活”没有原生保证。采用原始共享 answer 引用，各 dispatch 保留独立 receipt；不自动拆答案或宣称结果隔离。需要任务隔离时使用独立 Conversation。send 的定位是会话消息接纳，不是隔离 job runner。

queued reset 可让原 submission unanswered/reset；如随后有新 run，不根据时间接近把其答案接给旧 dispatch。正常 tool-round handover 继续等待同一 submission。缺失 answer 文本或非文本结果如实返回状态/引用，不扫描附近消息挑“像答案”的一条。

Disposition：明确产品契约并验收普通 steering/多调用方流程，无需启发式映射。

## 3. 执行终态与业务完成不是同一保证

Submission.done 表示原生执行已答复，并非需求、代码或测试已正确完成。框架依据该终态自动获取最终答复并回传；不要求 child 调用 contact，也不把中途主动通信判为完成。业务验证依显式测试/验收条件，或交给接收者评估。UI 不把 elapsed time、最后一句“完成了”当成验证通过。

Unsafe 外部工具在副作用完成、receipt 未提交时 crash，可能无法自动确定是否成功。安全边界沿用 interrupted/unknown outcome 与工具自身幂等协议；新 requestId 不会让任意外部副作用变成 exactly-once。

Disposition：明确能力限制；不是增加一套 agent 状态机能消除的困难。

## 4. Read 对齐：数据呈现和续读需要实现

原生 Read 读取连续文件，Conversation 存储是异构 entry。需固定文本呈现格式，保留原始 entry/block 引用，固定首次 tail，续读携带 entry、文本内位置与格式版本。超长行用 UTF-8 安全分片和可用的会话续读 token，不能依赖 bash/sed。

顺序分页可直接从 token 的 entry 前进。任意大行 offset 的首次定位可能需要扫描；首版受预算限制，不承诺任意行随机 O(1)，也不为此先建持久全文/行号索引。50 KiB 限制的是输出；native entry 仍可能整体解码，不能将其解释为读取内部内存上限。真实性能证据出现后再考虑分块存储接缝。

codemode 可以对读取结果编程筛选；单页有界并不能限制无限循环/累计数组内存，codemode 交付时仍需宿主执行、累计调用和输出预算。本轮不因此提前实现搜索或 codemode。

Disposition：确定性工程工作，进入 M2/M5 的纵向验证；现有存储粒度限制记录，不先重构存储。

## 5. 上下文准备：精确 fork 可确定，语义压缩有损

fork-at 固定来源与 entry；模型 context 使用 native context 派生。context.js orderToolResults 已合成 missing_result，避免中途 fork 的缺失工具结果破坏消息配对；它不表示原工具已执行成功。原始历史仍保留实际记录，不写入虚假成功结果。

代理定义/用户配置明确选择 fresh/fork/compact，宿主解析、固定来源并执行准备；主 agent 只选择代理和提供任务，不能通过模型参数或任务正文覆盖宿主策略。compact 通过模型总结，可能遗漏信息、受提示注入影响或失败，不能保证与原文语义等价。需要压缩时等待已提交的准备结果再派活；失败显式呈现，不静默换策略。自动判断“重要上下文”属于可选策略插件，不是 core 必备启发式。

结果过长的自动回报默认用固定截断预览与源引用；不额外调用模型“猜关键结论”。如果配置明确要求语义摘要，其质量与成本单独说明。

Disposition：core 接纳精确事实与显式策略；模型质量风险不混入调度契约。

## 6. 后台任务归属与恢复：需要一条完整纵向链证明

background 只适用于 conversation-owned tasks；普通 stop 保持不穿越，显式 background:true 的原生全范围取消会穿越。该选项不通过产品普通 stop 暗中使用。

Anchor 是 native 归属，不是常驻子进程。owner task 已 terminal 不删除 Conversation，后续 send 不能尝试复活该 terminal task。anchor 的实际等待/完成规则、reporter checkpoint、关闭工具但保留 definitions，以及 missing_task 的状态投影需按真实实现验证。

恢复依据 dispatch/submission/requestId，不从目录、标题、近期消息和日志内容重新识别 child。进度沉默只能显示“最近无更新”，不能自动裁定 failed/completed。

Disposition：M3 端到端和 SIGKILL 验收；不增设第二个 worker registry。

## 审计证据

安装包前缀：apps/server/node_modules/@earendil-works/pi-durable/。核心符号：dist/harness/{submissions.js:Submissions.wait,generation.js:answer/finishToolRound/abort,live.js:endRun,scheduler.js:abortConversation/#gated,context.js:captureContextBounds/orderToolResults}；dist/tools/read.js:readText；dist/types.d.ts:SubmissionRecord/TaskOptions。

本审计源代码确认事实；并发与恢复的产品保证仍需按 [恢复矩阵](durable-recovery.md) 实测。
