# 实施导航与文档归属

Workspace: /home/developer/Documents/dev/hepi-harness。当前 dirty tree 含此前已完成修复，保留它们；HEAD 不是完整源码指纹。

开始精确文件任务可复用下表与 parent graph 结果。追加发现前执行窄 query，确认 source；默认 graph: graphify-out/graph.json；辅助 deep graph: graphify-deep/graphify-out/graph.json。仅 coordinator 在集成后 update。

| 票 | 窄 graph query | 拥有源范围 | Owning guide |
| --- | --- | --- | --- |
| 01 | ServerSnapshot ServerDelta DurableSession | packages/protocol/src/index.ts；apps/server/src/server.ts 的 wire 声明；packages/session/src/index.ts；apps/web/adapters/durable-api.ts 的 raw 声明 | docs/architecture.md 的协议段 |
| 02 | startGateway GatewayRpcServer | packages/gateway/src/main.ts；新 gateway startup Module；packages/client/src/gateway.ts；CLI config；相关 installed CLI tests | packages/client/README.md 的启动段 |
| 03 | writeTerminalFrame terminalEvents | packages/gateway/src/index.ts 的终端 SSE；terminal tests | docs/workbench.md 的终端段 |
| 04 | Gateway append capture | packages/gateway/src/index.ts 的 capture；execute/journal tests | docs/architecture.md 的 capture 段 |
| 05 | SessionViewSnapshot snapshotBytes evictToFit | apps/web/lib/session-view-cache.ts；cache tests；实际调用者 immutable 合同 | docs/chat.md 的 cache 段 |
| 06 | snapshotObservation snapshotAccepted useAgentSession | apps/web/hooks/useAgentSession.ts；lifecycle receiver/acquisition/projection 与 tests | docs/chat.md 的 acquisition 段 |
| 07 | projectTrustApi capabilityServed | apps/web/components/AppShell.tsx 的 trust 控件；capability-availability helper/tests；相关 locale key | docs/mcp-on-the-web-host.md；docs/migration-status.md |
| 08–10 | ChatWindow ProcessDetailsGroup getVisibleRenderWindow | ChatWindow.tsx；ProcessDetailsGroup 展开；相关 turns/window/helper/ref/scroll 与 e2e 夹具 | docs/chat.md 的历史窗口段 |
| 11 | 上述精确源 | 整合后的共享 export/docs、检查与报告 | docs/verification.md 的新记录 |

03/04 共用 gateway index，必须按段 ownership 协作；02 只接 export/构造需要，不重排整文件。01/06 共用 hook 的类型调用者，先稳定01；05不改变 cache Interface。07 owns 三 locale 的 trust/capability keys，其他窗口文本经 coordinator 接入。多票修改同 guide 时先分段，最终去重。

检查入口在 package scripts 查询；不用固化将来可能失效的测试文件列表。票11整合使用 pnpm verify:changed 与 pnpm verify --profile=fast，加实际改到的 browser/SSH/installed CLI checks。读取 docs/agents/verification.md 和 review-policy.md 后报告结果；无源码变更重复完整验证不是进展。
