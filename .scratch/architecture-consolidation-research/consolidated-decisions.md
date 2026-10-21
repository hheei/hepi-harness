# Architecture consolidation — 集成建议

基线：caf6a319177554f3fcc53e6a4efc6683a1a3e433。阶段：研究与设计复核；未实施产品改动。本文收束 A–F，冲突处以本文的集成建议为准。用户已批准整合方向并要求转 spec / tickets；当前执行规格见 [spec](../architecture-consolidation/spec.md)。研究本身不代表实现已完成。

## 判断

Backend / Gateway / Web 的部署职责已经清楚：Backend 拥有 durable runtime、会话与存储；Gateway 拥有执行主机、文件、终端与宿主 MCP；Web 拥有认证入口与呈现。主要问题在内部合同仍混着上游旧会话模型、休眠宿主实现和重复消费者规则。应在既有所有者处收敛，保留跨主机边界。

| 项 | 已确认的问题 | 集成建议 | 证据限制 |
| --- | --- | --- | --- |
| A | 76 个静态不可达、无本地测试依赖的候选文件，12,832 行 | 删除可执行副本；保留 vendor 来源与许可、活跃 UI、类型和构建入口 | 正则闭包不是构建证明；旧 .next 不对应当前修订 |
| B | BFF 将 delta 展开成整窗并反复 UI 投影；旧 event/command 合同仍在 | BFF 转发原生帧；浏览器使用共享客户端规则与 transport；一次迁移相关 HTTP 调用者 | Backend 原生协议保持；浏览器 BFF 载荷会有意改变 |
| C | SDK/Web 的 head 失效与整个旧窗口滚出时行为不同 | 历史规则归现有 @hepi/session 纯根；SDK 真正调用共享 prefix 规则 | 合成函数探针，不等于 live compaction 复现；历史缺口恢复另行处置 |
| D | 后端/Web 重声明 Gateway request/response 数据合同 | @hepi/protocol/gateway 纯子路径作为共同声明；运行时实现留 Gateway | 共享 TS 类型不会校验远端 JSON，也不能自动消除未知值断言 |
| E | 两份在线使用的 MCP 脱敏纯模块完全相同 | @hepi/protocol/mcp-secrets 纯子路径；保留 Gateway walker | 当前无分叉或泄漏证据；属于维护与一致性风险 |
| F | 一个工具调用的多个 exec 共用 Gateway 执行 ID | 原生 wraps + 显式调用作用域 + 每个 exec 独立序号 | 当前 Bash 单次 exec；不承诺跨尝试稳定重放或 exactly-once |

## 唯一所有者与依赖方向

- @hepi/protocol：跨进程纯数据声明；gateway 与 mcp-secrets 各自独立子路径，既有根 API 保持。
- @hepi/session 纯根：wire window 推进与 loaded prefix 规则；保留完整 native entry payload 与快照标量，修正返回类型，不为类型不足另建 id→payload map。
- @hepi/session 浏览器子路径：从现有 Web AgentEventConnection 迁移已经验证的多订阅者、每会话一 source 语义。Web 与诊断页都消费该实现；删除两处旧适配实现，保留实际 vendor 快照。纯根不导入浏览器模块。
- Web lifecycle-projection / lifecycle-acquisition：全局已接受态、acquisition fence、completion notices/effects。completion-delivery 继续拥有连接预算与兴趣集合；UI 投影继续留 Web。
- Gateway：执行身份编码、主机能力、运行时输入解释、journal、MCP 配置与凭据。Backend 通过原生 Extension/Registry 组合工具。

依赖向库和合同收敛；packages/session 不依赖 apps/web。Web 主机 MCP 仍直接调用对应 Gateway，不转给 Backend。Bearer、宿主 token 与 provider 凭据仍停留在原有服务端边界。

## A：删除范围与保留理由

76 候选 = 72 个逐字节上游副本（11,780 行）+ 3 个本地适配（990 行）+ 1 个无上游对应的 fixture（62 行）。删除本地适配时记录其已由现有所有者接管的修改；vendor 不是重新执行的备份路径。

类型可达、配置引用和 public service worker 仍是真实依赖。另 8 个仅测试引用的休眠助手是待核实的后续退役候选；测试本身不是永久保留理由，确认合同已由在线所有者承担后可连测试一起退休。111 不是必须维持的测试数量。

TypeScript 会递归检查被导入的 lib 文件；缺少 lib 根 include 只留下不可达文件的盲区。扩大 tsconfig 覆盖是独立可选清理，不是本次完成条件。

## B/C：状态与接入合同

1. 保留 ServerSnapshot / ServerDelta 的完整原生字段，包括 message、projectionId、revision、historyRevision、historyHead、run、submissions、settings 与 live 状态。不能顺手裁掉 metadata。
2. 共享 reducer 修复历史规则：将现有 decidePrefix 与类型迁入 session 根；删除 Web 副本；SDK 内部实际委托同一规则，不能仅给旧 prefixOf 加一个 head 参数后保留两套决策。
3. per-stream held 只负责该流 baseRevision 的连续组装。要求 baseRevision === held.revision，不做 revision - 1 算术；等版本 snapshot 重述仍可用于 hydration。
4. 流内 held 可在 UI 接受之前推进；它不是全局权威。窗口、prefix、beside state 和 cache 只能在 lifecycle acceptance 通过后一起发布。被拒帧不改全局缓存。
5. HTTP 相关五类读取与 SSE 一起切换成原生载荷，所有已知 hook / ExtensionsConfig 调用者同步改用 Web 投影。不要先重构 Node foldFrame 再删除它；浏览器接入后直接移除 BFF 整窗折叠。
6. 共享 transport 的 source factory 明确区分 Web cookie BFF 与诊断页 bearer。不能把 Backend token 放进 Web client props。EventSource 能在 URL 带 query；不能设置任意 Authorization header。
7. submission 仍是原生结算事实；state_oversize 是读取拒绝，不触发结算、重发或草稿回滚；重连仍按 requestId 查结果，保持六连接预算。

归一化探针把 Web prefix 与新 window 拼成完整 transcript 后比较：同边界扩展和重叠推进两个具体输入相同；head 变化与整个旧窗口滚出两类输入不同。没有重复 w1 的证据。脚本与原始输出见 .dev/architecture-consolidation-research/normalized-transition-probe.mts 及同名 .log（退出码 0）。

非重叠 snapshot 可能与旧历史相邻，也可能存在客户端未见过的中间条目；单凭 ID 无法判定。重读 /state 只能再次得到最新窗口，不能补历史。当前 consolidation 不宣称解决此缺口，也不引入反复 /state 的 resync 循环。若实现桥接，需要独立定义 /entries?before 分页、head/acquisition 校验、停止预算与未完成结果；不能把盲拼接当作连续性保证。生产者 WindowProjector / continuationIndex / frameFor 保留。

## D/E：共同声明与纯策略

选择 protocol 子路径基于公共 wire 合同的所有权与依赖方向。类型导入会擦除；一个纯 @hepi/gateway/contracts 子路径在技术上同样可行，不能用 Gateway 根导入 Node 就断言它不可行。

机械搬迁当前 producer 类型。WorktreeListing 在现有 Gateway 声明中各字段必填；不要把 reader 对旧版本的兼容默认误写成当前 producer 字段可选。兼容读仍由已有适配边界负责。WorkspaceResult 的 value union 与 McpHostResult.value: unknown 不自动提供 operation→result 关联，不为去掉 as 引入通用 RPC/schema 框架。

协议根 API 保持；不以根文件字节相等建立永久测试。包 manifest 与 lockfile 同步更新；Gateway 新依赖只进入 CLI bundle，不进入发布用 client manifest。现有 Dockerfiles 已复制相关 workspace manifests 与源码，但构建和 pack smoke 仍须验证实际解析。

脱敏纯文件一次搬迁，保留输出语义；Gateway 自有 walker 留原处；休眠 Web test redactor 随 A 退役。迁移时记录来源 revision/hash，保留有意义的 mask 行为测试，不为上游快照建立永久逐字节测试。私有 npm 包不豁免 CLI/Web/Gateway 分发的许可与 notices。

## F：原生执行作用域

当前 forCall 只存在于 gatewayEnvironment 的运行时对象，既不在上游 ExecutionEnv，也不在本仓 ExecutionHostEnv 声明中。应在本仓接口显式声明；EnvTarget 当前没有 taskId/callId，单靠 env factory 无法完成调用身份注入。

使用现有 CodingTools 扩展身份和选择语义原子地携带原生 wraps：保留原工具及元数据，用 wrapTool 装饰执行环境，不独立注册一个可被单独关闭的身份包装扩展。普通 NodeExecutionEnv 或 undefined 必须透传；调用前做实际方法判断，类型断言不是运行时检查。

forCall 建立隔离的词法计数器；每次 exec 分配 base#n，避免不同命令撞同一 ledger key。不使用未声明的 this.execCount。保留现有 ledger 指纹、拒绝、abort 与 outcome-unknown 语义；Proxy 的 not_supported 能力边界保留。FS 操作没有新增 journal，不能声称文件写入被该方案恢复。

当前工具默认 unsafe replay；将来若开放安全重放，需额外证明跨尝试 operation ID 与调用顺序稳定。不能从 native env 每次重建推断 exactly-once。上游 EnvTarget 增加身份可作为后续目标，本次不等待上游发版，不新增插件管理器或 Pi CLI ExtensionAPI 兼容层。

## 实施顺序与验收

1. D + E：确定公共子路径、搬迁合同和脱敏纯函数，保住发布物与宿主边界。
2. A：分批删除已圈定副本并清理失去真实使用者的依赖；B 相关状态与 transport 文件等待其迁移完成再删。
3. C + B：先共享历史规则，再原子切换浏览器 transport、原生 HTTP/SSE 与 UI 投影，最后删除 legacy event/command 分支及 BFF fold。
4. F：独立修正执行身份与原生 wraps，验证扩展选择不会绕过注入；可与前三项并行，但统一检查后集成。

验收使用现有 package / Web / browser 合同测试；只为身份碰撞、历史迁移与验收边界补必要回归，迁移或退休旧测试，不按文件或 case 数堆覆盖。重点是 CLI 安装包、MCP 宿主调用、混合版本兼容读、双 exec、journal 重复抑制、HTTP/SSE 同义、结算一次、历史 prefix 与滚动位置。

B 是允许破坏兼容的 Web 内部合同切换；新 Next 构建不会自动替换已经打开页面的 JavaScript。发布按一次明确的已有页面刷新切换处理，不增加长期旧协议适配；验收须覆盖刷新后的草稿恢复、requestId 结果恢复与结算去重，不能只测新打开页面。

研究只运行了窄合成探针与文档检查，没有构建、安装、部署或新一轮全套回归；实施结果不能引用研究命令冒充验收。构建在 workstation/CI，remote-host 仅运行和只读验证。

## 分项报告

- [A：Web runtime 退役](A-web-runtime-retirement.md)
- [B：原生 Web conversation](B-native-web-conversation.md)
- [C：历史窗口与 prefix](C-window-fold.md)
- [D：Gateway 合同](D-gateway-contracts.md)
- [E：MCP 脱敏](E-mcp-secret-policy.md)
- [F：扩展执行](F-extension-execution.md)
