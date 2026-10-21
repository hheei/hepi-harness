# pi-durable 1.3.0 升级与优化结果

日期：2026-10-16。工作区基于 `68c2fb24ca5a0750fc9015de99b8cf09c678e279`，含本阶段未提交修改。仅本地开发和隔离验证，无部署或服务重启。

## 已完成

server、gateway、client 的 pi-durable/chord 升级到 1.3.0，server 的 pi-ai 同步到 1.3.0；coding-agent、MCP 与 vendored UI 保持各自现有版本。锁文件同步，仅为所需 1.3.0 包添加精确版本的 minimumReleaseAgeExclude。发布包 THIRD_PARTY_NOTICES 与 build 脚本嵌入的 durable/chord 版本通知同步到 1.3.0。

输入入口统一使用 [conversation-input.ts](../../apps/server/src/conversation-input.ts)：

- triggerTurn 缺省或 true：原生 Conversation.submit，返回原生 submission ID。
- false：同一 Conversation.commit 中写 native Submission 和 InboxDoc，不调用模型，不建独立队列。
- requestId 重试复用已有身份，不覆盖已编辑内容，不复活取消项；保留 steer/followUp、输入 kind/data 和原生 busy refusal。
- 现有 HTTP message/busy 路由使用默认行为；尚未增加公开 HTTP 参数或 Web 队列操作。

未来上游提供原生 queue-only admission 时，仅替换薄接口的 false 分支。调用方不探测版本、不访问私有模块、不替换运行时方法。

## 1.3.0 带来的优化接缝

| 范围 | 结论 |
| --- | --- |
| 自定义输入 | 原生 InputEntry kind/data 可承载结果来源与类型，无需先把待处理报告写进模型历史；薄接口已保留字段，报告 UI 尚待实现。 |
| 被动展示 | display-only write 通常直接落库，不启动模型、不消费队列；前置 queued reset 会改变该路径，不能作为全局暂停屏障。 |
| 内存 | 原生 document/context retention 已默认十分钟。保留默认值，不为同一行为额外写配置；更短时限需实际资源测量。 |
| 嵌套工具 | executeTool、NestedCallDoc、caller filters 与原生 codemode 可替代未来自建嵌套执行器；本次未启用新工具。 |
| 运行中任务升级 | 原生 pi.tool v1→v2 migrate 为旧 input 增加 kind:model，保留 checkpoint。实测恢复成功，无手动 SQL。 |
| 缓冲和上下文 | 复用上游 compaction/context 顺序修复和 base64 分块实现，不复制对应算法到应用层。 |

仍需保留现有 withCallScope / forCall：EnvTarget 没有 callId/taskId。subscribeCommits 仍是公开 API，无需改名。自定义工具返回值在新版本使用 output；现有包装透明转发原生工具结果，无需兼容转换。

queue-only 只保证本次 admission 不启动回合。后续 input、model-visible write、compaction 等原生边界仍可能消费队列。持久 stop/wake 执行意图与所有消费边界的控制仍属于后续实现，不能宣称薄接口已经提供用户要求的完整停止契约。

## 已执行验证

- 依赖升级后的 pnpm verify:changed：exit 0，工作区类型检查/测试、Web 单元测试、脚本测试、入口与文档检查全通过。原始证据见 ../../.dev/verify/2026-10-16T03-36-18-566-verify-changed/verify.json。
- 薄接口新增三项真实 MemoryStorage/faux 测试：默认执行、queue-only/编辑/重试/取消、busy refusal 与自定义 entry 放置；worker focused test 和 server typecheck 均 exit 0。最终集成 pnpm verify:changed 也 exit 0（../../.dev/verify/2026-10-16T03-45-36-710-verify-changed/verify.json），包含这三项新增测试。
- pnpm --filter @hepi/client build && pnpm --filter @hepi/client smoke:pack：exit 0，6 项通过，覆盖发布包、隔离安装、CLI、doctor、本地 gateway、真实 localhost SSH gateway。
- node .scratch/webui-next-exploration/probes/durable-upgrade.probe.mjs /tmp/hepi-durable-legacy-1792122094797：exit 0，两个隔离升级场景通过：1.1 队列经 SIGKILL 后由 1.3 重开，无模型调用，原生取消成功；1.1 执行中 replay-safe pi.tool v1 经 SIGKILL 后由 1.3 自动迁移、重放一次并完成。

升级探针需要隔离旧版本依赖目录：在临时目录安装 pi-durable/chord/pi-ai 1.1.0，再将目录传给探针。数据库及子进程均为探针独占，不读取生产库。完整主/子会话 reporter 的 SIGKILL 验收仍待子代理实现。

探针及发布包验证原始日志：

- /home/developer/.pi/agent/sessions/--home-developer-Documents-dev-hepi-harness--/tasks/01a13947-7849-75fa-b740-9d8bbc7193c6/bash-3.log
- /home/developer/.pi/agent/sessions/--home-developer-Documents-dev-hepi-harness--/tasks/01a13947-7849-75fa-b740-9d8bbc7193c6/bash-7.log
