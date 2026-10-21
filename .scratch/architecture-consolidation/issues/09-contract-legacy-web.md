# 09: 删除已退出的 legacy Web 合同与测试

**Parent:** [Architecture consolidation spec](../spec.md)

**What to build:** 用户只看到当前已支持的会话能力或明确限制，维护者不再面对无生产者的事件、501 命令入口与退役 runtime 的测试。

**Blocked by:** 04, 08

**Status:** resolved（2026-10-15：重开的两条 P2 已由 75 在 checkpoint `110c093` 修完，干净 `110c093` 上 72 standards 与 73 spec 两轴各 0 剩余实质发现——R9 新建会话的工具选择、R10 忙碌路径的 shell 预检；验收 2 恢复成立。**遗留一项测试逻辑项（R12，mjs only）**：72 指出 `ux-submission-recovery.mjs` 第 6 幕把带附件的 `!` 草稿的队列契约断言错了（它会被立即接收，不是被排队），已由 75 的叶子 `86bc9f4` 修完并 cherry-pick 到集成线（`ba7e0a7`，只动驱动），**等最终 10 的浏览器运行做真正的验证**；它不影响本票的产品关闭。此前：验收 1、2 的余项已在 74 的 join 修复（`5887484`，合入 `82c481f`）落地后完成——无生产者事件分支、扩展 UI 队列/dialog/customUI/attention 路径、legacy delta 组装器已删除；三条不受支持入口已改为调用前限制。逐条账目与验证见文末"完成记录"）

## Acceptance criteria

- [x] 移除无生产者的 legacy event 分支、不可达 streaming delta 与已退出的过渡适配；保留当前 native snapshot/live message 呈现。
      —— 旧 Web stream 三件套（`lib/agent-event-stream.ts`、`lib/session-liveness.ts`、`lib/agent-event-wire.ts` 的翻译半部）与
      compaction 事件分支（`auto_compaction_start/end`、`compaction_start/end`，无生产者）已退役；native snapshot/live message
      呈现（`projectSession`/`projectLive`、`isNestedToolExecutionEvent`/`isSystemMessageEvent`、frame/submission/resync/oversize）保留。
      —— `handleAgentEvent` 中其余 17 个无生产者 case（`agent_start/end`、`agent_settled`、`prompt_done/error`、
      `extension_error`、`message_start/update/end`、`tool_execution_start/update/end`、`queue_update`、`auto_retry_start/end`、
      `extension_ui_request/closed`）**已按实际 event union 删除**（browser StreamSource 只发 `connected`/`frame`/`submission`/
      `resync`/`oversize`），连同只服务它们的 `retryInfo`、`endLiveOutput`、`refreshContextUsage`；不可达 delta 组装器
      （`lib/streaming-message.ts` 的 `delta` 动作与 `applyDelta`、`agent-event-wire.ts` 的
      `isNestedToolExecutionEvent`/`isSystemMessageEvent`/`ClientAssistantMessageEvent`）一并退役，reducer 只保留
      start/resume/snapshot/end。native 呈现（`projectSession`/`projectLive`、frame/submission/resync/oversize）与 R7 的
      source continuity 未动。
- [x] 不受支持的命令入口隐藏或说明限制，branch/session-file 等合成字段及其误导性消费退出；现有支持的会话和设置操作不因同名旧命令而被误删。**（2026-10-15 重开的两条 P2 已由 75 在 `110c093` 修完并在干净 `110c093` 上经 72/73 两轴确认各 0：R9 —— 新建会话的 Chat only / Read only 工具选择不再以可用的样子出现；R10 —— 忙碌路径的 shell 预检与空闲路径共用同一规则。见文末 R9/R10/R12）**
      —— 六项内置 slash 命令（`/compact`、`/auto-compact`、`/name`、`/session`、`/copy`、`/clone`）与 compaction UI 已隐藏，
      合成字段 `tree`/`filePath`/`totalActiveMs` 及其消费者（branch navigator、Session File: In-memory、Active Time 行、cache
      的 `summaryTree`/`totalActiveMs`、`SessionTreeNode`/`BranchPreview`）退出。保留 `/reload`、`/mcp`、fork、模型/思考级别、
      recall queue、会话面板（读本地投影）与侧栏重命名。
      —— 三条不受支持入口改为**调用前**限制（`set_tools`/`navigate_tree`/`bash`/`abort_bash` 在 `apps/web` 全树 0 引用）：
      编辑历史消息的入口与其 navigate 机制删除；`!` 草稿由 composer 提示 + 发送拒绝（同一规则 `lib/composer-limits.ts`）；
      工具预设只在 `isNew` 时出现且不再发命令。扩展 UI 队列/dialog/custom panel/attention 路径（无生产者）已删除。
      保留：复制全文、草稿编辑、普通 prompt、fork、模型/思考级别、扩展选择、recall queue、侧栏重命名。
- [x] 复核八项仅测试引用的休眠助手及其合同承接；已被在线所有者接管或不存在当前产品合同的实现与旧测试一起退役，未确认项记录后继续。
      —— 八项中 7 项退役（5 项见独立切片 `dd8b8d1`；`agent-event-stream`+`session-liveness` 于本轮 08 落地后退役），
      `pi-sdk-internals.ts` 记录后保留（importer 端口与 SDK `!command`/`$NAME` 解析一致性的唯一守卫）。逐项理由：
      `.dev/verify/consolidation-09/dispositions.md`。
- [x] 已删除实现没有脚本/测试/构建引用，迁移后窗口规则和连接实现各有一个运行时所有者，来源快照和许可保留。
      —— `git grep` 全树（apps/packages/scripts/e2e，排除 vendor/.scratch/.dev）无残留引用；`check-entrypoints` 0（0 newly
      missing）；窗口规则/连接实现的所有者是 `packages/session` 的 browser StreamSource + `adapters/durable-api.ts` 的 forward 与
      `lib/durable-projection.ts`；八个休眠文件与 vendor 逐字节相同，`apps/web/vendor/pi-web/**` 与许可未改动。
- [x] 按实际递归结果更新测试基线与 migration/upstream/chat 指南，Web 低于 200；不把保持 111 当作保留旧测试理由。
      —— 基线更新为 **57 文件 / 113 测试**（`docs/verification.md`，含本轮删除与新增的 `lib/composer-limits.test.mjs`），
      并更新 `docs/upstream-sources.md`、`docs/migration-status.md`、`docs/chat.md`、`apps/web/README.md`。

## Verification seam

复用当前聊天/设置/工作台浏览器场景、Web 递归单测与脚本入口检查；按公共行为审查测试退役，而非源码快照。

## Comments

### 2026-10-15 — 独立切片（`dd8b8d1`，合入 `eec988c`）

逐项复核研究 A §5.2 的八项仅测试引用的休眠助手：退役 5 项（`request-security`、`auth-throttle`、`login-destination`、
`key-serializer`、`session-file-references-core`）及其本地测试；3 项记录后继续。逐项证据与在线所有者对照见
`.dev/verify/consolidation-09/dispositions.md`。

### 2026-10-15 — 最终阶段（08 合入后）

分支 `work/architecture-consolidation-09`，08 tip `44ecc99`（08 核心可作基线；08 的 final 状态在 74 的 join 修复前保持 REOPEN）。
三个代码提交 + 一个记录提交：

| 提交 | 内容 | 行数 |
| --- | --- | --- |
| `c8436e2` | 退役旧 Web stream 三件套（`agent-event-stream`、`session-liveness`、`agent-event-wire` 翻译半部）及其 2 个测试 | -770 |
| `c68668b` | 投影合成字段 `tree`/`filePath`/`totalActiveMs` 与 branch navigator 全链退役 | -650 |
| `3505b72` | 六项 501 命令入口与 compaction UI 隐藏；`lib/pi-types.ts` 裁剪到两个在用类型 | -556 |

**验证**（日志 `/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-09/`，全部记录实际 SHA 与退出码）：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node scripts/test-web-unit.mjs`（08 基线，44ecc99 clean） | 0 | 58 文件 / 114 测试 / 0 失败（`base08/`） |
| `node scripts/test-web-unit.mjs`（本阶段） | 0 | **56 文件 / 110 测试 / 110 通过 / 0 失败**（`final-web/`） |
| `pnpm -r typecheck` | 0 | 六个项目 |
| `pnpm -r test` | 0 | protocol 47 / client 10 / session 31 / gateway 185 / server 286 |
| `node scripts/check-entrypoints.mjs` | 0 | 60 present / 2 既有 known-missing / 0 newly missing |
| `node scripts/check-docs.mjs` | 1 | 271 文件 / 12 broken（0 new，与基线逐条相同） |

合入 integration tip（`8d3dcec`，ticket 07 关闭 + 08 保持 REOPEN 的记录）后于 `3dc172e` clean 复核：web 单测 **56/110/0 失败**、
`pnpm -r typecheck` 0、`check-entrypoints` 0、`check-docs` 1（0 new）；日志 `merged-*`、`clean09-*`。

未重跑完整浏览器矩阵：08 已在 `44ecc99` 记录 drivers 全绿；本轮按 changed behavior 只跑 Web 递归单测 + 工作区
typecheck/单测 + 脚本入口检查。**但不据此声称 UI closure 未变**：本票删掉了 `BranchNavigator`、compaction UI 与六个
slash 入口，并裁掉投影字段及其消费者——`AppShell` 与 hook 的实际渲染/效果路径因此改变（挂载的组件、可发出的命令、
投影字段读取都不同）。**最终浏览器证明必须 source-bound 到最终修订**，不能以 08 在 `44ecc99` 的 driver 结果替代。

### 重开原因：余项是待办，不是永久限制

**这些不是"已批准的能力限制"。** 规范《Implementation Decisions》14 与 User Story 20 要求：无生产者的 legacy event 分支
和不受支持的命令入口要**删除或改成明确的限制说明**，让界面只提供已有能力或把限制说清楚，使旧分支和 501 命令不伪装成
可用功能。本轮只是**暂时避开 74 正在重写的原生 SSE 区**，不是把这些项判为可长期保留。

1. **无生产者的 hook 事件分支**（`agent_settled`、`auto_retry_start/end`、`extension_ui_request/closed` 等）与 `case "frame"`
   同区。暂缓的唯一理由是它们与 74 的 shared transport baseline/replay 与原子转移接缝重叠；**74 的修复落地后必须删除**。
2. **扩展 UI 对话框队列**（`extensionDialogs`/`extensionCustomUis`、`ExtensionDialog`/`ExtensionCustomPanel`、
   `lib/extension-ui-queue.ts` + 测试、`onAttentionNeeded` 的阻塞通知路径）无生产者，是纯 dead code，与第 1 条同区，
   同属 74 之后的删除项。
3. **三条入口仍把 501 当成产品行为**：编辑历史消息（`navigate_tree`）、`!` shell、工具预设 pin（`set_tools`）先发出
   POST，再以错误形式显示后端自己的 501 理由。这**不是**验收 2 要的"调用前就说明限制的 UI 限制"——用户是在触发之后
   才看到失败的。指南里写一句不算产品层面的说明。要么在调用前隐藏/禁用并给出理由，要么把限制做成调用前的界面事实。
4. `lib/pi-sdk-internals.ts` 保留（parity 守卫，已记录理由）；`agent-event-wire.ts` 已只剩
   `isNestedToolExecutionEvent`/`isSystemMessageEvent` 与 assistant-delta 形状。

### 后续（已通知 75）

74 的 join 修复落地后：删净第 1、2 条的死分支，并把第 3 条改成**调用前**的隐藏/禁用加理由（连同 `bashRunning`/`pendingBash`
等状态一起退）。**不新增功能**；这是把已退出能力的入口收干净，不是补产品能力。

**第 3 条已在叶子 UI 独立完成**（不触碰 `case "frame"`、handover 与扩展 UI 队列）：三条入口都在**调用前**禁用并给出理由，
见下节；第 1、2 条仍待 74 之后在所有者处（`hooks/useAgentSession.ts` 的事件归约与其渲染/通知消费者）删除。

### 2026-10-15 — 检查点：三条不受支持入口改为"调用前"限制（叶子 UI）

原第 3 条把 501 当产品行为：先发 POST，再以错误显示后端理由。现在三条入口都在**调用前**给出限制，且对应命令已从代码中消失
（`set_tools`/`navigate_tree`/`bash`/`abort_bash` 在 `apps/web` 全树 0 引用）：

- **编辑历史消息**（`navigate_tree`）：删除 `MessageView` 的 "Edit from here" 与取消按钮、`ChatWindow` 的
  `onEditContent`/`onCancelEdit`/`isEditing` 传参、hook 的 `editEntryId`/`setEdit`/`cancelEdit`/`handleEditContent`/
  `pendingHistoryEdits`/`handleNavigate`，以及 `ChatInputHandle.replaceMessage` 与其只被测试引用的 helper
  `canRestoreUserMessage`（连同 `ChatInput.test.mjs` 的对应断言）。保留：复制全文、草稿编辑、普通 prompt、fork。
- **`!` 直接 shell**（`bash`/`abort_bash`）：草稿以 `!` 开头时 composer 立即显示限制（`chat.shellNotServed`，三语），
  发送在同一规则上拒绝——不发 POST、不建会话、无 pending 假象，文本留在 composer。删除 `executeBash`/`pendingBash`/
  `bashRunning`/`bashRecoveryIdRef`/`waitForBashSettlement`、`abort_bash` 分支、`isBashRunning` 恢复块与 ChatWindow 的
  pending 气泡/"Running command…" 行。助手自身的 bash 工具不受影响。
- **工具预设 pin**（`set_tools`）：`set_tools` POST 已删除；预设仍是**新会话创建**时携带的 `toolNames`（受支持），
  选择器只在 `isNew` 时出现，已有会话时隐藏；若点击时已有会话，只记录偏好并说明该会话保持创建时的工具集。

规则落在 `apps/web/lib/composer-limits.ts`（`isShellCommandDraft`），composer 的提示与发送的拒绝共用同一条规则；
新增 `apps/web/lib/composer-limits.test.mjs`（7 断言）。

**验证**（日志 `/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-09/`）：web 单测 **57 文件 / 111 测试 /
0 失败**（`ui-final/`）；`pnpm -r typecheck` 0；`check-entrypoints` 0；`check-docs` 1（271 文件 / 12 既有 broken / 0 new）。
`pnpm -r test` 首轮在 `packages/gateway` 的 terminal 注释帧用例超时失败（与本次 apps/web 改动无关），单包复跑
185/185 通过，记为 flake。

**仍待 74 之后**：第 1 条无生产者事件分支、第 2 条扩展 UI 队列/dialog/customUI/attention 路径（在所有者处按实际 union 删除，
保留 native `case "frame"`/submission/resync/oversize 与 R7 连续性）。


### 2026-10-15 — 完成记录（74 join 修复落地后；criterion 1/2 收尾）

**基线**：74 的 R7 join 修复 `5887484`（记录 `82c481f`）合入本分支后开始；本票改动三个提交：
`c6b8e22`（三条入口改为调用前限制）、`977b29b`（删除无生产者事件面，19 文件 −1569 行）与本文档提交。

**criterion 1 — 无生产者分支与不可达 delta（已删除，按实际 union）**

browser StreamSource 的实际事件 union 只有 `connected`/`frame`/`submission`/`resync`/`oversize`（`packages/session/src/browser.ts`），
因此 `hooks/useAgentSession.ts` 的 `handleAgentEvent` 中 17 个 case 全部无生产者，已删除；保留的 5 个 case 及其 fold/接受、
R7 的 stream continuity、`decidePrefix` 与 head/cache 逻辑**未改动**（74 负责的 cache-init/head 顺序在 `openEvents`/bootstrap 处，
本票未触碰）。

随之退役（只被这些分支使用）：`retryInfo` 状态与 ChatInput 的重试横幅、`endLiveOutput`、`refreshContextUsage`、
`isNestedToolExecutionEvent`/`isSystemMessageEvent`/`ClientAssistantMessageEvent`（`lib/agent-event-wire.ts` 现只剩
`AgentEventLike`，被 stream/delivery/registry 三处真实使用）、`lib/streaming-message.ts` 的 `delta` 动作与 `applyDelta`
（native 帧整条消息到达，reducer 只保留 start/resume/snapshot/end；`lib/streaming-message.test.mjs` 改写为覆盖
snapshot 归一化、替换、resume 与 end）、`lib/tool-execution-progress.ts`（仅该分支使用）、`lib/codemode-view.ts` 的
`getCodemodeProgress`。

**criterion 2 — 不受支持入口与扩展 UI 死链（已删除/已改为调用前限制）**

扩展 UI：`extensionDialogs`/`extensionCustomUis` 状态、`handleExtensionUiRequest`（含 setStatus/setWidget/setTitle/
set_editor_text/notify）、`respondToExtensionUi`、`sendExtensionCustomInput`、ChatWindow 内联的 `ExtensionDialog`/
`ExtensionCustomPanel`（约 618 行）、AppShell 的 `handleAttentionNeeded` 与 `browser-notifications.ts` 的
`isBlockingExtensionUiRequest`/`claimExtensionAttentionNotification`、`lib/extension-ui-queue.ts` + 测试、
`lib/extension-dialog-fit.ts`、`lib/extension-widgets.ts`、`lib/ansi.ts` 的 custom-panel 行归一化、
`types.ts` 的 `ExtensionUiRequest`/`BlockingExtensionUiRequest`/`ExtensionUiResponse`，以及对应 i18n 键
（`chat.retrying`、`i18n.attentionNeeded`、`i18n.extensionInputNeeded`）。

三条入口（`c6b8e22`）：编辑历史消息（`navigate_tree` 已从代码中消失）、`!` shell（composer 提示 + 发送拒绝，
共用 `lib/composer-limits.ts` 的 `isShellCommandDraft`，不发 POST、不建会话、无 pending 假象）、工具预设 pin
（`set_tools` 已从代码中消失，选择器只在 `isNew` 时出现）。保留：复制全文、草稿编辑、普通 prompt、fork、
模型/思考级别、扩展选择、recall queue。

**记录（未删除，非 criterion 项）**：`extensionStatuses`/`extensionWidgets` 状态与 `ExtensionStatusBar`/
`ExtensionWidgets` 渲染器保留——`projectAgentState` 明确记录"这些字段不在此读取中"（absence 即事实），
因此它们是**投影缺口的渲染面**而非旧 runtime 的死代码；同一记录也适用于 `systemPrompt`/`contextUsage` 读取。
`lib/pi-sdk-internals.ts` 按 criterion 3 保留（parity 守卫）。

**验证**（日志 `/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-09/`，实际 SHA/退出码）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm -r typecheck` | 0 | 六个项目 |
| `node scripts/test-web-unit.mjs` | 0 | **57 文件 / 113 测试 / 113 通过 / 0 失败**（`dead-final/`） |
| `node scripts/check-entrypoints.mjs` | 0 | 60 present / 2 既有 known-missing / 0 newly missing |
| `node scripts/check-docs.mjs` | 1 | 271 文件 / 12 broken（0 new） |

**最终修订（`1ef55cb`，clean；已合入 primary 的 R8 检查点 `780ba98`）**：`pnpm -r typecheck` 0；web 单测
**57 文件 / 115 测试 / 0 失败**（`fin-web/`，115 = 本票删除后的集合 + R8 的两个 cache-adoption 回归用例）；
`pnpm -r test` 0（protocol 47 / client 10 / session 34 / gateway 185 / server 286；同修订早前一轮有一次
`apps/server` provider-config 用例因 stub 响应体为空失败，单包复跑 286/286 通过，记为 flake）；
`check-entrypoints` 0；`check-docs` 1（12 既有 broken，0 new）。日志 `fin-*`。

删除后 `apps/web` 全树对**发往宿主的命令类型** `navigate_tree`/`set_tools`/`abort_bash`/`type: "bash"`/
`extension_ui_response`/`extension_ui_input` 与**事件类型** `agent_settled`/`auto_retry_*`/`extension_ui_request`/
`extension_ui_closed` 均 0 引用（`git grep`，排除 vendor）；`bash` 作为**工具名**仍在（助手自身的 bash 工具，
未受影响）。**未跑**：最终 10 个公共浏览器场景（按计划在源码完成后、
最终修订上跑一次）；本票不据此声称 UI closure 未变——本轮删除的正是渲染/事件路径，最终浏览器证明必须 source-bound
到最终修订。

## R9（review 72 final 09，复现于 `7931915`）— 新建会话的工具选择被创建适配器静默丢弃

**分类（协调者细化）：UI/后端契约不匹配**，不是后端缺能力，也不是单一转发字段写漏。

唯一提供工具选择的 UI 只出现在**新建会话** composer：`ChatWindow.tsx:1255` 传
`onToolPresetChange={isNew ? handleToolPresetChange : undefined}`，既有会话根本不显示这个控件。选择进入
`toolPreset` → `ensureNewSession` 组装 `toolNames` 并 POST `/api/agent/new`
（`useAgentSession.ts:1067`），但 BFF 创建适配器只转发 `workspaceId`：
`apps/web/adapters/durable-api.ts:543` 的 `body: JSON.stringify({ workspaceId })` 丢掉
`toolNames`/`provider`/`modelId`/`thinkingLevel`/`type`，后端于是按默认**可写**工具建会话。

用户可见后果：在新建会话里选 Chat only 或 Read only，界面显示已切换，实际拿到可写工具——一个从未被后端收到的
选择静默生效为默认。`55ccccc` 时代就存在这个遗漏，但本票此前把它记为"已保留/受限的受支持入口"，该声明不成立。

**父级探针**（`7931915`，`/tmp/hepi-09-new-session-tools-7931915.log`，副本
`.dev/verify/consolidation-review-09/`）：请求 `requestedToolNames: []` 与
`["read","grep","find","ls"]` 两种，后端 create 都是 `{"workspaceId":"w"}`，probe exit 0 并给出
`CONFIRMED: concrete tool selections silently omitted by creation adapter`。

**修复所有者与范围（agent 75）**：隐藏或明确限制新建会话的 picker、退役被忽略的选择链、改掉指南里
"新建会话可改工具"的失实说法。**不**新增后端能力、**不**做只转发补丁。真正的工具只读与原生扩展路径保持不变。

**验收 2 因此重开**，本票回到 in-progress；修复与评审完成前不再关闭。

## R10（review 73 final 09，复现于 `7931915`）— 忙碌路径绕过 composer 的 shell 限制预检

**分类（协调者细化）：普通的提交预检覆盖逻辑错误**——共享规则没有放在共享的派发接缝上，于是覆盖按入口而不是按
提交生效。不是后端问题，也不需要新框架。

共享预检规则只在**空闲**发送路径上被调用：`handleSend`（`apps/web/hooks/useAgentSession.ts:1524`）用
`isShellCommandDraft` 拒绝 `!` 开头的草稿、保留文本并给出提示；而 steer / follow-up 走的
`sendStreamingPrompt`（同文件 `:1895`，由 `:1943`/`:1955` 调用）**从不查这条规则**，直接 stage 并 POST
`type:"prompt"` 的原始 `!pwd`。`ChatInput.sendQueued`（`apps/web/components/ChatInput.tsx:1272`）在派发**之前**
就 `clearInput()`，所以忙时草稿被清掉、文本留在队列里等着被当作普通 prompt 发出。

**父级探针**（`7931915`，`/tmp/final09-shell-send-7931915.log`，副本
`.dev/verify/consolidation-review-09/shell-send-7931915.log` 与 `shell-send-probe.sh`）：idle 0 POST / 0 pending；
steer 与 followUp 各 1 POST + 1 pending；断言 `shell limitation must refuse idle, steer and follow-up before POST or
staging` 失败。

`lib/composer-limits.ts` 自己的文档声明"输入时提示限制的 composer 与拒绝它的发送端对哪些草稿达成一致"——该声明
只在一条入口成立。

**修复所有者与范围（agent 75）**：在 **staging/派发之前**做共享校验，并**保留草稿/附件与 UI 清空行为**（忙时拒绝
也要像空闲路径一样把文本留在 composer，而不是清掉后排队）；**不**改后端、**不**引入新框架。

**验收 2 在 R9 与 R10 都修完并复核前保持打开。**

### 修复（agent 75，R9 + R10）

**R9**：新建会话的工具选择链整条退役——`ChatInput` 的 tool-preset 按钮/下拉与 `toolPreset`/`onToolPresetChange`
属性、`ChatWindow` 的透传、hook 的 `toolPreset` 状态/`sessionToolsPinnedRef`/`handleToolPresetChange`、
`lib/tool-preset-preference.ts`、`lib/tool-presets.ts` 里的预设机制（`getToolNamesForPreset`/`getPresetFrom*`/值常量）与
6 条 i18n 文案全部删除；`ensureNewSession` 的创建请求只带 `cwd`/`type`/`provider`/`modelId`/`thinkingLevel`，
**不再带 `toolNames`**。保留：`ToolEntry` 与 `get_tools` 只读工具列表（System 面板）、`PRESET_READ_ONLY`（子代理配置）、
原生扩展选择、模型/思考级别选择与新会话 prompt。模型/思考覆盖引用（`newSessionModelOverrideRef`/
`thinkingLevelOverrideRef`）与 `set_model` 发送路径未动——这两条是本宿主**已服务**的能力，其创建期生效由 74 在 BFF
侧修复（R11），与本轮删除互不相交。

**R10**：共享预检 `refuseShellCommandDraft`（`isShellCommandDraft` + 提示）落在 hook 的**两条发送接缝**上：
`handleSend`（空闲/Enter/Alt+Enter）与 `sendStreamingPrompt`（steer/follow-up/`handlePromptWithStreamingBehavior`），
在**任何 staging/派发之前**返回，因此既不 fold 也不 POST；`ChatInput.handleSend`/`sendQueued` 用同一个谓词
（`bashMode`）跳过 `clearInput()`，草稿与附件留在 composer。拒绝不再调用 `restoreSubmission`：草稿从未离开
composer，回填只会把同一段文本合并进草稿存储（`mergeRestoredSubmissionDraft` 会拼接）。普通 prompt/steer/
follow-up 路径不变。

**验证（`dbeee26`，clean；已合入 R11 的 BFF 修复 `ddb9126`）**：`pnpm -r typecheck` 0；web 单测
**57 文件 / 118 测试 / 118 通过 / 0 失败**（`final2-web/`；118 = 本分支的 117 + R11 的适配器用例）；
`pnpm -r test` 0（protocol 47 / client 10 / session 34 / gateway 185 / server 286）；`check-entrypoints` 0；
`check-docs` 1（12 既有 broken，0 new）。日志 `final2-*`（R9/R10 单独一轮为 `r9r10-final-*` / `783acd4`）。

**公共 UI 证明（final 10 运行，本轮不新建 build）**：`apps/web/e2e/ux-submission-recovery.mjs` 新增第 6 场——运行中把
`!pwd` 放进 composer，然后依次走 Enter、Alt+Enter、Steer 按钮、Follow-up 按钮四条忙时入口：每条都断言 0 个
prompt POST、0 个新 model 请求、pending 数不变、队列里没有 Recall 行、composer 仍持有该草稿、拒绝理由在屏；随后同一
草稿带上附件（按 `lib/composer-limits.ts` 的边界，感叹号旁边的附件是普通 prompt）仍照常入队：它由**自己那条 POST 当场被接纳**
（prompt POST 1 → 2，此时 model 请求仍为 1），等前面那次运行结束后 model 才收到它（model 请求 1 → 2，POST 仍为 2）。
（复核 P2 修正：此前该场景误以为入队要等到 release 才 POST；`/tmp/r9r10-shell-110c093.log` 的 hook 探针显示接纳 POST 与
pending 当场发生，故断言改为"release 前 2 POST / 1 model，release 后仍 2 POST / 2 model"。）R9 的 UI 缺失由 `apps/web/e2e/ux-nav-new-session.mjs`
在新建会话 composer 上断言：不存在 `aria-label="Change tool preset"` 的控件（即被删掉的 picker 标记）。

**回归**（`apps/web/hooks/useAgentSession.lifecycle.test.mjs`）：空闲 `!pwd` 0 POST / 0 pending + warning 提示；
忙时（`busy:true` 帧）steer 与 follow-up 各 0 POST / 0 pending；普通 steer/follow-up 仍各 1 POST / 1 pending；
`restored` 为空（草稿未被清，无需回填）。`apps/web/components/ChatInput.test.mjs`：`bashMode:true` 时空闲/steer/
follow-up 三条路径都不 `clearInput`，普通草稿仍清一次并派发。

## R11（相邻项，**已解决**——72 standards 与 73 spec 窄复核各 0，owner 74，commit `ddb9126`）— 新建会话的模型/thinking 选择被创建适配器丢弃

本票之外的相邻发现，记录在此是因为它落在同一个 BFF 创建接缝上；**其规范依据是决策 #8**
（"支持的模型、thinking、扩展、MCP、skills、worktree 与会话操作保持可用"），不是验收 2，因此**不**重开验收 2，也**不**
与 R9/R10 合并。

**源码事实。** `ensureNewSession` 确实把选择带上：`provider`/`modelId`/`thinkingLevel` 都在 POST
`/api/agent/new` 的 body 里（`apps/web/hooks/useAgentSession.ts:1062-1082`）。BFF 的 `agent/new` 处理器仍只转发
`workspaceId`（`apps/web/adapters/durable-api.ts:543`），这些字段被丢弃，后端按**默认** model/thinking 建会话。
UI 侧并非未接线：`handleModelChange`（`:1663`）在无 sid 时只写 `newSessionModelOverrideRef`/`newSessionModel`/
`pendingModel`；首次 `handleSend`（`:1557-1572`）只在 `existingSid` 为真时才发 `set_model`——**由
`ensureNewSession()` 新建的那条路径恰好不发**，因为它假设创建请求已经带上了选择。

**用户可见后果：** 全新会话里选模型 B 与 thinking level，发出第一条 prompt A，会话仍以服务端默认 model/thinking
创建。

**与 R9 的区别（不得混同）：** R9 是后端**根本不提供**的工具选择（应隐藏或限制）；R11 是**已有原生 API 支持**的
能力被适配器漏掉（应**应用**，而不是隐藏）。

**修复（74，确认公开红灯后执行）：** 在 BFF 创建路径上组合既有的
`PATCH /api/conversations/:id/settings`（已支持 `model` 与 `thinkingLevel`，见 `durable-api.ts:592`/`:595`）
显式写入用户覆盖，并在返回 / `snapshot` / prompt **之前**完成；**不**新增后端能力、**不**直接塞未知字段。74 只动
BFF 与自身确认路径，**不碰 75 的 hook**，两者所有权不相交。

**完成记录（74，2026-10-15，基线 `f90414c`）。** 目标确认：源码逐条核对上述四点，且确认后端 create 只读
`workspaceId`（`apps/server/src/server.ts`），既有 `PATCH /api/conversations/:id/settings` 同时接受
`model` 与 `thinkingLevel` —— **适配器契约缺口成立，不是缺后端能力**，因此不新增后端能力、不改 schema/runtime。

修复：`apps/web/adapters/durable-api.ts` 的 `agent/new` 处理器改为**先 create（body 仍只有 `workspaceId`，未知字段一个不塞）
→ 若调用方确实带了 loadout 则用**一次**既有 settings PATCH 同时写入 `model` 与 `thinkingLevel` → 再读 state 并应答**；
应答里的 `model`/`thinkingLevel` 即已应用的值，故 hook 的 `setPendingModel`/`newSessionDefaultThinkingLevel` 读到的是会话真实
loadout。用户没选的字段**不发**（省略即保持 runtime 解析出的默认，应答仍会陈述它）；后端拒绝（未知模型 / 非法 level）时把
**上游自己的 status 与 reason** 在 state 读取之前返回，调用方因此拒绝该次发送而不是静默用默认跑第一条 prompt。附带同一处理器内
create 的拒绝也走既有 `forward`（原来非 2xx 会抛成 500），使整条创建路径的拒绝都保留后端原因。

验证（`.dev/verify/consolidation-09/new-session-settings/`）：公开适配器测试
`apps/web/adapters/durable-api.test.mjs` 新增一条覆盖四例（显式 model+thinking 在 create 之后、state 读取之前以**一次**
settings 更新落地；省略时**完全不发** settings 更新、应答 runtime 默认；被拒绝时返回后端 400 且其后不再读 state；既有会话的
`set_model` 命令不变）。**红→绿**：pre-fix `adapter-red.log` exit1（3 pass / 1 fail，应答给出 `openai/gpt-5`+`off` 而选择是
`anthropic/claude-sonnet-4-5`+`high`）→ 修复后 `adapter-green.log` exit0（4/4）；web 单元 `116/116`（`web-unit.log`）、
`tsc --noEmit` exit0（`typecheck.log`）。

**浏览器场景（74，加在既有的 `ux-missing-model-recovery.mjs` 驱动里，未新建套件）。** 该驱动本就有受控的两个本地
completion 端点（环境默认 A = `magpie/deepseek-v4.1-flash`，文件自有 B = `fileonly/ephemeral-1`），因此不引入付费网络或后端改动：
`saveFileProvider` 通过编辑器**既有的** Reasoning 勾选把 B 声明为推理模型（未新增任何配置能力），于是 composer 的推理菜单对 B
提供级别（非推理模型只有 `off`）。新增两幕，各自独立 context：

1. **全新 composer 的成功路径**：点侧栏新建 → 选 B → 选 `high` → 断言"选择过程中不产生任何会话" → 发出第一条 prompt →
   断言创建出的会话被找到、**B 收到这条 prompt 的 provider 请求**（`{"model":"ephemeral-1"}`）、环境默认端点**一次都没被调用**、
   且该会话自己的原生 settings 为 `model={fileonly,ephemeral-1}`、`thinkingLevel="high"`。这条路径下会话是**发送时才创建**的，
   没有任何 `set_model` 命令先行，所以它证明的正是创建适配器这条接缝，而不是既有会话的 `set_model`。
2. **创建被拒绝（73 的追加要求）**：同一个全新 composer 上把 `/api/agent/new` 的应答固定为适配器在 loadout 被后端拒绝时
   返回的形状（400 `{error:"unknown model"}`），发出 send → 断言"确实尝试了创建（拒绝就是它收到的答案）"、**没有派发任何 prompt 命令**、
   **没有创建任何会话**、**受控 provider 一次都没被调用**、**草稿文本回到 composer**。真实 PATCH 拒绝发生在 state 读取/首次 prompt 之前
   这一点由上面的公开适配器测试证明（两者组合，未复制后端框架；未为了造 stale model 而新增配置能力）。

结果：`node apps/web/e2e/ux-missing-model-recovery.mjs` **exit 0，33 条检查全部通过**（新增 16 条：成功路径 10 条、拒绝路径 6 条；原有 17 条不变），
日志 `.dev/verify/consolidation-09/new-session-settings/browser-fresh-composer.log`。运行所用的 Web build 就是修复候选
`ddb9126` 的构建（其后只改了驱动与文档，均不在应用构建闭包内），因此最终 10 在最终 build 上只需重跑同一驱动一次。
R9 的 `toolNames` 未被本修复触碰（create body 仍收到该字段且仍不转发，picker 的隐藏/限制归 75）。

**provenance：** `adapter-red.log`、`adapter-green.log` 与 116 的 `web-unit.log` 都是**提交前**在 dirty `f90414c`
上测的，dirty 文件恰为 `durable-api.ts` + `durable-api.test.mjs` 两个；集成后已在 clean `ddb9126` 上重测
116/116（`.dev/verify/consolidation-09/new-session-settings/merged/`）。**两轴复核各 0 剩余实质发现**（`.dev/verify/consolidation-review-09/r11-standards-followup.md`、
`r11-spec-followup.md`），R11 因此**已解决**；72 另记录一项**非阻塞**项：settings 被拒绝后目录里会留下一个空的默认会话，
它没有跑过任何 prompt 或模型（不删除是刻意的——那会是第二个破坏性操作）。浏览器那一半已由 `e47feda` 补上（在 `ddb9126` 的 Web build 上 33/33），**最终 gate 仍需在最终 build 上重跑同一驱动一次**，
本票不声称最终 gate 已通过。

### final 09 复核余项（记录，不作为修复项）

除 R9、R10 两条 P2 外，final 09 复核没有其它实质发现（`.dev/verify/consolidation-review-09/standards-final-r9.md`、
`spec-core.md`）：原生 union / 死 dialog / retry 退役正确；原生归一化、接受门、R7/R8、prompt/草稿/全文加载/fork/
既有 model/thinking 选择器、扩展与只读工具、原生反馈与 notice 均在检查中完好。**status/widgets 投影缺口与 SDK
importer-parity guard 只记录**，不作为本票的修复项。node / CLI / diagnostic 的运行时闭包稳定，仍可作为最终复用证明，
但要在最终修订上做精确闭包比对。
