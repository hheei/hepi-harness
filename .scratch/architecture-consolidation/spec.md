# Architecture consolidation

**Type:** spec
**Status:** resolved — all ten tickets closed 2026-10-15 (per-ticket state in [the ticket graph](ticket-plan.md)); this
spec is the approved scope as written, and later lines superseded parts of it (the Web runtime it retired is gone, and the
client ingress now owns what the BFF then proxied). Current behavior: [Architecture](../../docs/architecture.md).
**Scope approval:** 用户已批准整合建议，并要求执行 to-spec / to-tickets。
**Phase:** 用户已确认十票拆分并授权进入 implement-spec；部署、重启和发行保持范围外。
**Baseline:** caf6a319177554f3fcc53e6a4efc6683a1a3e433

## Problem Statement

Backend、Gateway、Web 已有清楚的运行职责，但内部仍混用旧 Web session 合同、休眠宿主实现、重复 Gateway 数据声明和客户端历史规则。Backend 的 delta 在 BFF 被展开回整窗，增加逐帧转换与传输成本；旧 UI 控件和事件分支还假设不存在的能力。Execution Environment 的私有调用作用域没有类型声明，并将工具调用身份误当作每条 exec 的身份。

维护者因此需要理解多个相似实现，用户则可能碰到不受支持的操作、历史规则分歧或未来多命令工具的执行身份碰撞。本轮按已批准范围收敛所有权，保持现有可用功能与跨主机边界。

## Solution

Backend 继续拥有唯一 durable runtime、会话和存储；Gateway 继续拥有 Execution Host、文件、终端和宿主 MCP；Web 负责认证入口、UI 投影和用户交互。共同 wire 合同与脱敏纯函数归协议包独立子路径；客户端历史规则归现有 session 纯模块，连接实现归其浏览器子路径。

浏览器直接消费经 BFF 认证转发的原生 HTTP/SSE 载荷，使用现有生命周期投影决定可发布状态。删除被取代的执行副本、旧事件/命令合同与 BFF 整窗折叠。原生扩展包装保持与 coding-tools 同名、同选择，并为一次工具调用内的每条 exec 分配独立身份。

## User Stories

1. 作为聊天用户，我希望流式答案持续更新，使长会话不反复传输同一整窗内容。
2. 作为翻阅历史的用户，我希望新消息到达时已加载旧页仍可阅读，使阅读位置与展开状态保持稳定。
3. 作为经历上下文重置的用户，我希望旧 prefix 按新 head 失效，使画面不拼接已经离开当前上下文的历史。
4. 作为重连用户，我希望 HTTP 和 SSE 给出一致的会话事实，使较旧响应不能覆盖新状态。
5. 作为等待提交结果的用户，我希望 Submission Outcome Unknown 通过 requestId 查询解决，使输入不会被自动重发。
6. 作为后台等待答案的用户，我希望每个已观察到的答案只通知一次，使切换会话不会丢失或重复结算通知。
7. 作为遇到失败、撤回或中止的用户，我希望看到真实结果，使失败不被当成完成提示。
8. 作为提交大内容的用户，我希望读取超限被明确说明，使读取失败不会触发重新发送或草稿回滚。
9. 作为配置 MCP 的用户，我希望导入预览和宿主响应使用同一脱敏规则，使敏感值不会因副本分叉而显示不一致。
10. 作为使用多个 Execution Host 的用户，我希望 MCP、文件和执行仍到达原来的宿主，使凭据和工作目录不跨边界。
11. 作为使用 worktree 和文件工作台的用户，我希望合同整理后现有操作继续可用，使客户端升级不改变线上字段含义。
12. 作为 Web 用户，我希望 Backend 与宿主凭据仍留在服务端，使浏览器不因接入原生帧而获得 bearer token。
13. 作为工具使用者，我希望一个工具内的多条 exec 都按各自意图执行，使第二条命令不会撞第一条的去重身份。
14. 作为配置扩展的用户，我希望 coding-tools 的选择同时控制工具与身份包装，使独立开关不能绕过执行关联。
15. 作为使用本地 Execution Environment 的开发者，我希望普通环境与无环境路径仍按原合同工作，使宿主适配不会让它们抛出 forCall 错误。
16. 作为 CLI 用户，我希望安装包自包含所需实现与许可，使新增 workspace 内部依赖不破坏发行包。
17. 作为运维人员，我希望诊断聊天页与 Web 使用同一连接生命周期实现，使它们不会维护两套易分叉的连接代码。
18. 作为已有页面的用户，我希望合同切换后的明确刷新能恢复草稿与查询提交结果，使升级不会造成重复输入或虚假成功通知。
19. 作为维护者，我希望每条历史规则、宿主合同和脱敏策略只有一个可执行所有者，使修改不依赖同步多份实现。
20. 作为用户，我希望界面只提供已有能力或明确说明限制，使旧分支和 501 命令不会伪装成可用功能。

## Implementation Decisions

### Ownership

1. 使用现有协议包的 gateway 与 mcp-secrets 独立子路径；既有会话协议根 API 保持。Gateway 实现、reader 兼容默认和 Web 面板 DTO 各留其所有者。
2. Gateway 合同机械搬迁当前 producer 形状。WorktreeListing 的五个字段维持当前必填声明；旧版本兼容读取仍由现有 reader 适配完成。共享静态类型不等于远端 JSON 校验，也不要求消灭所有 unknown 或断言。
3. MCP 脱敏纯模块一次搬迁，保留输出语义、来源与许可。Gateway 自有 walker 保留；休眠 Web redactor 随其宿主实现退役。
4. 客户端窗口推进和 prefix 规则归 session 纯根。Web 的 prefix 实现迁入共享模块；SDK 必须实际调用同一规则，取代旧决策体。既有 reducer 模块与用途保留，类型和内部实现随迁移调整。
5. 状态保留原生 entry.message、延迟内容元数据及完整快照标量。修正 SDK 类型，不另建 id→payload 状态副本。纯根保持无浏览器模块依赖。
6. 采用现有 Web 多订阅者连接实现的语义，迁入 session 浏览器子路径。Web 与诊断页改接一份物理实现；cookie BFF 与诊断 bearer 由各自 source factory 负责。packages 不依赖 apps。

### Browser contract and lifecycle

7. 原生 HTTP 读取与 SSE 浏览器接入最终一起完成迁移。可以在集成过程中保留有明确删除 ticket 的临时旧读取/事件适配，最终 BFF 会话流只认证并转发，不再折成整窗或做逐 entry UI 投影。
8. Web 保留一份显式 UI 投影。所有既有会话读取、状态读取、上下文分页、get_state 消费者和扩展设置读取同步改接；支持的模型、thinking、扩展、MCP、skills、worktree 与会话操作保持可用。
9. stream-local held 仅负责本流连续组装。delta 的 baseRevision 等于该流 held revision，revision 可以跳跃；完整 snapshot 重述按既有 hydration 语义处理。wire 组装不接管跨 acquisition 的接受决定。
10. 全局已接受窗口、prefix、beside state 与 cache 只在既有生命周期接受通过后发布。被拒帧可以推进隔离的流内状态，但不能改全局投影或缓存。ADR 0006 / 0007 的 submission、恢复与通知语义保持。
11. 无真实 paged prefix 时不积累旧窗口；head 改变或完整 active range 替换时 prefix 失效；同 head 推进按既有 Web 语义保留已加载历史和滚出旧窗口。ID 按身份判断，边界按位置判断。
12. 非重叠 snapshot 本身不证明存在历史缺口；本轮不恢复客户端从未见过的中间条目，也不以反复读取最新 state 假装恢复连续性。生产者窗口选择、字节预算与 delta 生成保持。
13. 保持每会话一条 source、多个读者共享、最后一个读者释放的语义，以及 shell 的六连接预算和兴趣集合。submission 是结算事实，state_oversize 是读拒绝；断线恢复通过 requestId 查询，不自动重发。
14. 删除无生产者的 legacy event 分支与不受支持命令的 UI 入口或改为明确限制说明。移除伪造的 branch/session-file 等旧合同依赖，不由空文件名推断会话仅在内存；不增加原来未实现的能力。

### Execution and retirement

15. forCall 在本仓 ExecutionHostEnv 明确声明。原生 wraps 与原工具、元数据同属 coding-tools 扩展，保留现有选择和工作区约束；普通 ExecutionEnv 和 undefined 路径经真实方法判断后透传。
16. forCall 返回隔离作用域，词法序号为每次 exec 分配 base#n。即使两条命令相同，也代表两次不同 exec 意图；网络重复请求继续按同一执行身份去重。保留 fingerprint、abort、outcome-unknown 和 not_supported 语义。
17. 不承诺跨尝试稳定重放、文件写入 journal 或 exactly-once；当前 unsafe replay 策略保持。上游 EnvTarget 身份扩展为后续目标，本轮不等待其发版。
18. 首批 76 文件 / 12,832 行是静态删除候选，不是要求不加核实全部删除的配额。逐一核实当前可达性、配置/类型/测试引用与合同承接；保留真实依赖、vendor 和许可。本地适配的承接关系写入变更说明。
19. 仅测试引用的休眠助手核实合同后可连旧测试退役；未确认的项记录并继续，不为凑删除数补新功能。TypeScript 会跟随 imports，扩大 lib 根 include 不属于本轮完成条件。
20. Backend hepi.v1 与 DB schema 不变；BFF 面向浏览器的载荷有意改变。按明确的已有页面刷新切换处理，不保留长期旧协议。草稿恢复与提交结果恢复必须纳入切换验收。

## Testing Decisions

1. 测试在已批准的现有 seam 上进行：公共客户端 reducer/连接订阅、Gateway HTTP 执行与宿主 MCP、安装后 CLI、真实浏览器会话。纯规则反例由现有单测承载，跨 HTTP/SSE、认证和浏览器连接预算由既有集成/浏览器驱动承载。
2. 历史比较先统一成完整 transcript，再比较 ID、顺序、payload 与 metadata。覆盖同边界、重叠、整个旧窗口滚出、head 变动、无 prefix、完整替换和 snapshot 等版本重述；合成用例不冒充 live compaction 证据。
3. 通过真实浏览器验证原生 delta 到达客户端，BFF 不再展开整窗；同 revision 的 HTTP/SSE 投影同义，旧 acquisition 响应不改窗口、prefix、beside state 或 cache。复用现有前台/后台生命周期、提交停滞、空闲心跳、历史 prefix 和窗口滚动驱动。
4. Gateway 公共 seam 验证一个工具作用域内的不同命令和相同命令分别获得独立执行身份；同一网络请求重复提交仍不二次执行。覆盖普通环境透传、coding-tools 选择、中止和 journal 重启后的 unknown 语义。
5. MCP 导入/脱敏、宿主路由、worktree、CLI pack smoke 与发行物 notices 复用现有检查。依赖和 lockfile 同步；Web、Backend、CLI 的可解析性以构建/安装包结果验证，旧 .next 不作为当前源码证明。
6. Web 递归测试保持低于 200；111/64 是历史测量，不是固定数量或本轮通过结果。只增加必要的行为回归，迁移或退役旧测试；不增加源代码形状、永久 vendor 字节相等或 SDK 内部清单测试。
7. 验证记录包含命令、被测修订/dirty 状态、退出码和原始日志。复用相同源码上的有效结果；最终集成验证覆盖所有依赖叶节点，不把规划或研究检查当作实现验收。

## Out of Scope

- 自动桥接未见过的历史 gap；大单 turn 内虚拟化、已加载 prefix 的 heap 上限和巨型结构化工具参数 deferral。
- 新增 provider/OAuth、push、分支导航、远程 workbench 或其他当前未交付功能。
- 插件管理器、Pi CLI ExtensionAPI 兼容层、第二套 runtime/生命周期监督器、通用 RPC/schema/store 框架。
- 新的 DB schema、跨尝试 exactly-once、FS 写入恢复或依赖上游新能力才能交付的工作。
- 全库 tsconfig/lint 改革、无证据的额外防御修补、为删除候选补齐旧产品能力。
- 生产部署、服务重启与发行发布；实现所需安装、构建与验证由各 ticket 覆盖。

## Further Notes

用户对上一轮整合建议和其验收边界的同意是本规格的授权来源。用户进一步确认了具体拆分并授权实现；依赖与执行入口见 [ticket 索引](ticket-plan.md)。

尊重 [ADR 0001](../../docs/adr/0001-single-authoritative-durable-runtime.md)、[ADR 0006](../../docs/adr/0006-durable-submission-lifecycle.md)、[ADR 0007](../../docs/adr/0007-lifecycle-facts-one-projection.md) 与[领域词汇](../../GLOSSARY.md)。已批准来源为[整合建议](../architecture-consolidation-research/consolidated-decisions.md)，其分项报告是证据参考；冲突处以本规格为实施目标。

已记录的非阻塞限制见 [review notes](review-notes.md)。执行和凭据边界按现有 owning guides 更新；构建在 workstation/CI，remote-host 仅运行和只读验证。诊断页共用客户端包的变更也纳入 Backend 构建验证。
