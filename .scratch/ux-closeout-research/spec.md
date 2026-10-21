# UX 收口执行规格与跨 spec 排程

Status: approved-for-planning; owning specs/tickets supplemented. **This change implemented nothing** — that sentence is
about the planning commit. Current delivery is owned per row by the linked tickets: most rows are now delivered, and what
still gates acceptance is client-app 22 as the aggregate gate: references 03 was accepted at `0acf499` and SSH 09 is
delivered (rebased onto `70d9a6d`), while 22 waits on 20's packaged journey. Read each row's owner for its state; the table below is the approved ordering and stays authoritative
only for scheduling and scope.
Date: 2026-10-19
Evidence baseline: integration/client-app `9400dcc8ca970f42ba4e02d71022d793a684039a`; observed live ingress `1873d244289db29e5aaa62118e3dfc1b30ffabb5`

## 目标与所有权

当前收尾审查后的修复顺序、worker 分工与验收条件见 [2026-10-20 修复计划](repair-plan-2026-10-20.md)。具体能力合同仍由下表各 owner 维护。

把已批准的 [UX 调研结论](README.md) 转成现有实施计划之后的可执行工作。本文只拥有跨 spec 顺序、交付覆盖与明确延期项；具体行为由下表的 owning spec/ticket 拥有。追加工作不重开已交付票，不建立另一认证、MCP、历史、client-state 或 durable runtime。此次仅编辑计划，未实现功能、操作凭证或部署。

计划记录存于主 workspace 的 .scratch；更新后的计划同步至当前 client-app integration worktree。修改前先恢复整合 worktree 中较新的四组计划记录（client-app、Provider、MCP、SSH，共42份 Markdown 差异），保留其历史证据与未完成状态。历史issue顶部/表格有相互滞后的叙述时，以 issue 的实际 delivered/verification 记录为依据；本次不把已知源代码存在等同于最终验收。后续实现基于 integration/client-app 当前 tip，不基于主 workspace 的旧应用源码。

## 排程规则

1. 继续当前 client-app16 发布产物/双端验收与17退役；当前 Provider、MCP、SSH 等已在进行的领域票继续，历史导航既有01可开始，不增加人为串行门槛。入口已有修正先部署验收，不再设计登入层。
2. 新增 client-app18–21 在17后启动，允许按路径分工并行；新SSH09在既有SSH04和client-app17之后；新references01也在17之后。追加票不反向阻塞16/17或SSH04。
3. 领域 Backend/Gateway 工作可并行；AppShell、Settings、file-seam、共享hook修改由明确owner集成。当前未完成票若已覆盖同一结果，补原票，不另造第二实作。
4. 新增 client-app22 等各领域与追加票的验收闭环，再对最终产物补缺口；未变源码已有证据可复用，不重复宽泛测试。

## 工作对应与验收入口

| ID | 用户流程与已知事实 | Owner / scope | Dependencies / delivery |
| --- | --- | --- | --- |
| A1 | 线上首开仅unauthorized；当前源码已有登入修正 | [client-app16](../client-app/issues/16-integration-and-direct-cutover.md) | 原范围继续；核验当前不可变产物与实际origin，保留旧live观察 |
| A2 | Web Settings登出旧端点与当前ingress不一致 | [client-app18](../client-app/issues/18-web-logout-contract.md) | 17后；普通cookie登出/回登入面，宿主动作正确 |
| A3 | App拒绝后缺配置/断开入口，shell能力已在 | [client-app19](../client-app/issues/19-app-connection-recovery.md) | 17后；隔离keyring的packaged恢复旅程 |
| N1/N2 | 完整user anchor rail、深search精确目标与失败反馈 | [history spec](../history-navigation-research/spec.md)、[01–05](../history-navigation-research/ticket-proposal.md) | 01–05已交付并验收（05在 `a0caf5d`）；搜索共用03，禁止加载中间历史 |
| P1 | Provider OAuth 已有分支b20d814 | [provider03](../provider-connection/issues/03-pi-ai-login-flows.md) | 01/02已交付；先恢复/审查分支与已有取消/重登修正 |
| P2 | 模型刷新已有32d2a25/2ac94bc工作，面板刷新不等于runtime可用 | [provider04](../provider-connection/issues/04-model-refresh.md)、[05](../provider-connection/issues/05-system-acceptance.md) | 03/04可并行；05等两者。分别核对存储成功、runtime账户/配置模式与composer更新 |
| M1 | MCP invocation/durable adapter/listing已交付；缺grant/UI闭环 | [MCP03b](../mcp-conversation-tools/issues/03b-durable-grant.md)、[03c](../mcp-conversation-tools/issues/03c-browser-tool-states.md)、[04](../mcp-conversation-tools/issues/04-child-fork-lifecycle.md)、[05](../mcp-conversation-tools/issues/05-system-acceptance.md) | discovery03a→03b→{03c,04}→05；05已整合于 `f2d9268` 并验收；显式授权，不自动grant，不重做adapter |
| W1 | App上传已有，bearer下载返回NATIVE_SAVE_REQUIRED | [client-app20](../client-app/issues/20-native-file-save.md) | 17后；原生目标选择+有界保存，复用认证reader |
| W2 | 缺文件可能500，预览截断进度可能伪装完整 | [SSH09](../ssh-remote-workbench/issues/09-file-failure-and-preview-feedback.md) | SSH04+client-app17后；owner分类到UI，不重开SSH01–03/05 |
| W3 | SSH/终端实现已有，当前普通故障/驱动验收未收口 | [SSH06](../ssh-remote-workbench/issues/06-terminal-parity-and-abort.md)、[08](../ssh-remote-workbench/issues/08-failure-boundary-acceptance.md)、[04](../ssh-remote-workbench/issues/04-system-acceptance.md) | 06/08→04；DOCX05已整合，watch07决议为deferred |
| N3 | References存储/导航已有；缺显式创建与目标失效处理 | [reference spec](../cross-session-references/spec.md)、[01–03](../cross-session-references/ticket-proposal.md) | 17→refs01；refs02再等history03；refs03的history05门槛已满足，仍差自身三个真实栈旅程 |
| N4/A5 | 读取错误只红字或console，无可操作恢复 | [client-app21](../client-app/issues/21-read-and-navigation-recovery.md) | 17后；重试只读/返回，history/ref共用owner，不重发未知mutation |
| V1 | 新流程跨Web/App/local/SSH最终验收 | [client-app22](../client-app/issues/22-ux-system-acceptance.md) | 完整阻塞链接在22；不把Android、watch等未选项偷偷加作release门槛 |

## 明确保留的行为边界

- Web/App→Client ingress→Backend→Execution Gateway 拓扑不变。Provider/MCP secret只由Gateway持有；Backend可保存非secret身份与授权，MCP调用仍由Gateway执行。
- OAuth复用上游pi-ai；原生另存复用现有resource reader与App能力。已存在的上传、SSH/DOCX、MCP adapter/listing和登入层不重复开发。
- 历史坐标属于conversation+snapshot+stable entry；rail只列user节点，search/reference可指向精确entry/block；均通过一个有界target coordinator，不遍历中间page。
- Reference默认会话级；用户可从已知entry选择更精细目标。只做明确用户建立，不自动连dispatch/fork，不新增model工具或复制历史；既有fork reference策略保持。
- MCP grant采用显式选择，fork:"initial"表示document初始值，不表示复制parent当前grant；后续继承政策由MCP04明确。
- 临时读失败可retry；未知mutation沿用requestId查询/outcome_unknown，不自动重发副作用。
- 本仓库禁止设计、运行或提交旨在绕过安全控制/认证/授权/preflight/系统边界的测试、探测或fixture。计划验证普通用户流程和正常故障，复用既有边界证据。

## 非阻塞记录与明确延期

| 事项 | Disposition / reopen condition |
| --- | --- |
| 动态profile热切换的旧identity、切workspace中的upload归属 | investigate；先复现受支持普通触发。App当前配置更换走重启，不以假想热切换阻塞交付；19/20仅保证其实际支持操作归属 |
| Provider discovery/connection-test | deferred；[decision record](../provider-connection/deferred-decisions.md)先定义测试语义与secret owner，再由用户选择 |
| Skills卸载 | deferred；managed来源、手改目录与删除边界明确并被优先后再排票；现有install/update/disable不是uninstall |
| Live file watch | [SSH07 resolved: deferred](../ssh-remote-workbench/issues/07-live-watch-protocol-research.md)；保持501/静态提示，未来明确优先才设计producer/cursor/overflow/teardown，无轮询替代 |
| Android/mobile terminal辅助条 | Android缺SDK，辅助条尚未被选；分别记录平台准备与需求，不承诺当前交付 |
| PWA/通知 | 现有Web安装面/offline/页面完成通知按14/16范围验收；后台push不选，App不注册worker |
| 键盘/焦点/窄屏/中文IME/文案 | 22针对已选流程做观察，真实材料问题按owner修；未观察项目不列为确认bug，零碎润色不扩成无限review |
| Session export / global dock / extension平台 | 继续parked，不因本次UX规划恢复实现 |

## 完成条件与验证记录

计划完成：每个已批准缺口有唯一owner与票、未满足依赖标blocked、无环、已交付状态不被泛化覆盖；延期项有重开条件。实现完成：各票公开seam/真实用户路径通过，owning操作指南与migration-status同改，22最终记录实际限制。

本次规划检查仅验证新增票字段、相对链接、依赖图、两份计划一致与Markdown差异；不运行应用构建/测试，不声称行为已修复。实施证据必须逐项记录 exact command、tested revision、dirty state、exit、log，区分源码/平台/build/deploy/actual origin。原生使用debug、6 jobs、incremental、共享target，保持宿主keyring隔离。

## Pilo 对照精简排程（2026-10-19，用户批准）

[client-app阶段G](../client-app/ticket-breakdown.md#stage-g---pilo-simplification)承接研究：17补充旧目录消费者退役矩阵，新增23删除死SettingsReader、24移除fixture请求fallback、25统一connection API组装。23/24/25仅依赖17，按路径可并行；25随会话整合协调AppShell/useAgentSession，24协调provider fixture。它们不加入22的阻塞边，现有UX/领域交付继续；若同一最终revision已包含精简，22复用该revision的适用验证。详细合同只在各票维护。
