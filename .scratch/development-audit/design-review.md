# Codebase 设计审查汇总（2026-10-14）

用户追加授权：按 codebase-design skill（本地、git-ignored 安装：`.pi/skills/skills/engineering/codebase-design/SKILL.md`）派 reviewer 审查设计。基准 master `1758c1fb4479e9d4637a957857246c5998619d73` + 当前未提交的审计修复。三位 reviewer 分别审查后端、Web、Gateway/CLI；本汇总去重并按证据排序。设计审查不等于新一轮重构授权，以下新增项尚未实施。

当前状态：本报告保留审查当时的发现与证据。后续用户授权的四项源码修复已完成，根因分类、回归与浏览器验证见 [design-fix results](../design-fixes/results.md)；当前合同见 [Chat](../../docs/chat.md)、[MCP host](../../docs/mcp-on-the-web-host.md) 和 [Projects](../../docs/projects.md)。尚未部署。

## 需修复的实际失败

| 优先级 | 发现与触发 | 最小责任归属 / 验证 | 证据 |
| --- | --- | --- | --- |
| P1 | 远端会话的目录经 hostCwdOf 解析后丢掉 gateway/Execution Host 身份，MCP/project-trust 派发到固定 Web 本机 host。受控真实 Module 调用已确认错误派发；同路径本机配置可能被读成远端配置，写错文件尚未执行、仅源码推断。 | 在现有目录解析 Seam 保留并校验实际 Web host 归属；远端明确 refused。不能只比较路径，也不能把同 gateway 的 SSH profile 当本机。不影响已支持的远端文件/Worktree，不把 MCP 凭证转移到 backend。 | [Web §1](design-web-review.md)；真实 hostCwdOf + mcpSurfaceApi，受控 fetch Adapter，原始命令/输出在其附录 B。 |
| P1 | 合法大粘贴被 202 接受并持久化，之后普通历史分页 413，或空页 + hasMore:true + 无可推进游标。单条 by-id 能读到，浏览器无法恢复。 | 加深现有历史投影 Module：有界 preview、全文读块、连续且可推进的分页；贯通 backend、Next Adapter、文本渲染。不能裸删 entry.text，不能假设客户端已有 URL 文本恢复。 | [Backend §1](design-backend-review.md)、[Web §3.1](design-web-review.md)、[性能研究](performance-research.md)；真实 1.5MiB submit，原始日志已核对。 |
| P2 | HTTP revision1 晚于 SSE revision2 返回时，projection 正确拒绝旧读，但 hook 仍应用旧 data/historyHead/leafId/failure；复现中新失败提示被旧 null 清除。 | 同一个快照接受 Seam 决定全部远端视图事实；被拒绝 observation 不再通过旁路 setter 更新元数据。保留草稿、滚动等本地 transient UI。 | [Web §2](design-web-review.md)；真实 hook Interface + 已有可控 HTTP/SSE harness，附录 A 含命令/输出。 |
| P2 | SSH profile 初始 root 指向 linked worktree，删除该 checkout 后，仍存在的 main 目录 list 返回500；已设计的 gone-worktree fallback 也失效。 | ExistingPaths 使用 resolveRepository/fallback 已选定的有效目录；失败归回 WorktreeResult。复用现有 Local/SSH Adapter，不新增 resolver 层。 | [Gateway §1](design-gateway-review.md)；真实 localhost sshd + git + POST /v1/worktrees，附录保存原始日志。 |

这些是审查新增的候选，不代表已发生生产事故。大粘贴与 SSH 触发经过真实公共读取/执行 Interface；快照乱序与跨主机派发通过真实 Module 的受控 Adapter 验证，未真实写入本机 MCP 文件。原始审计优先级1/2的已授权修复另见 [执行记录](follow-up.md)。

## 调查与 advisory

- **investigate，非阻塞：活动历史挂载范围。** 50/500/2000条已加载消息，DOM1710/14085/55335，全页 after-GC heap约12.1/22.1/51.2MiB，最长 long task126/163/613ms。2000条须20次显式旧页加载，默认首窗50；受控 server fixture + 实际冻结 Web build，不是生产/native backend端到端延迟。ChatWindow.visibleCount 随已加载消息增长，活动 prefix无viewport virtualization。LRU的32MiB序列化预算不限制当前DOM，也不等于heap。先在现有渲染 Seam 验证滚动/搜索锚点与挂载范围；不据此重写整个chat。详见 [Web §3.2](design-web-review.md)。
- **record：Gateway 装配重复。** CLI与独立入口都记住 registry、Local/SSH选择、local-only能力及关闭顺序；过去的CLI漏装Worktree已修。下次实际能力变化时收拢运行装配 Implementation，避免泛化DI或只包一层参数。详见 [Gateway §2](design-gateway-review.md)。
- **record：目录增量计数重复检测 append。** 10000条、零追加的聚焦复现仍读20000次数组索引；既有 appendedEntries 已包含同一事实。无实际卡顿证据；真实长会话CPU证据或明确优先级出现时复用现有ops。详见 [Backend §2](design-backend-review.md)。
- **record：discover Interface 的失败协议多余。** 实际只返回loaded或throw，failed union属于持久化状态转换；下一次修改该协议时收窄返回类型。详见 [Gateway §3](design-gateway-review.md)。
- **record：源码形状测试已产生churn。** route文件迁移、JSX/ref/effect表达变化引发断言维护。仅在同 Interface 已有等效行为覆盖时 replace-not-layer；当前不删除测试、不扩大成全套测试迁移。详见 [Web §4](design-web-review.md)。

## 应保留的 Depth

Native durable生命周期、WindowProjector、model-config/ModelRuntime、searchConversationBodies、Gateway执行账本、gatewayEnvironment、资源Loader、AgentEventConnection、CompletionDelivery、lifecycle-projection与session-view-cache都有明确 Leverage：删去后，顺序、重试、归属、预算或恢复知识会重返多个调用者。问题应在现有 Seam 加深或纠正 Adapter；没有证据支持第二套持久化、中央CapabilityRegistry、通用HostRouter/SessionRepository、按文件长度拆Module或整体重写 copied upstream。

## 验证界限与实施顺序

所有 reviewer 只新增各自报告；没有源码重构、部署或广泛测试重跑。完整命令、revision/dirty、真实exit及原始输出在分报告；exit0的复现仅表示探测完成，不表示被测行为正确。浏览器测量原始JSON完整，但raw log不含退出码，不补造exit0。分页耗时含100ms响应轮询及至少约450ms稳定等待，不能当纯React render time。

建议先处理跨主机归属及快照原子采用，再完成大文本可恢复契约和SSH有效目录选择；它们互不需要泛化架构。活动DOM成本继续focused investigate，advisory记录即完成。实施前沿各自当前 Interface 写可观察失败检查，修正在owner，复用未变源码的已有验证。
