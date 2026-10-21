# UX follow-up ticket breakdown

Status: approved and published as 14 local ready-for-agent tickets. Phase A (01-04) complete and merged at f6f0772; Phase C — all 14 tickets are merged (14 as 0057f73, its tree identical to `e328eef`); every ticket is implemented and verified. The final code review (two axes) and the retro have run: both are complete, and its two material findings (F1, F2) are fixed at source and re-verified — see [code-review.md](code-review.md). Deployment/paid live-provider smoke remain outside scope. See [validation](validation.md).
Breakdown approval: user confirmed ("同意，可以").
Spec scope and public test boundaries: user approved ("都很好，可以下一步").
Implementation: user authorized ("可以，开始吧") on integration/ux-follow-up.
Deployment/paid live-provider smoke: outside this phase.

## Dispatch order

1. Bug slices 01-04 are complete and verified (merged at f6f0772). Slice 04 carried B4 into the retained builtin
   Skills workflow and replaced the Market entry; later slices expand source/Project integration before legacy code
   retirement.
2. After the bug phase, work the feature frontier 05-13, where all listed blockers are complete. Phase B is underway:
   05, 06, 07, 10 and 12 were dispatched into isolated worktrees based on f6f0772, with 07 and 12 gated on a contract
   proposal reported before code. (Recorded as dispatched at the time; all of them were subsequently merged — 06 `0d22103`,
   07 `1bda245`, 10 `2036d6a`, 12 `7ca85f0`, and 05 `0bcd1e0`.)
3. Retire unused Market implementation in 14 after complete retained Skills coverage.

Bug-first is a dispatch priority, not an architectural blocker. Features with no blockers remain technically
independent. The next implementation coordinator must respect this phase order even if a generic frontier
scheduler would offer all root tickets at once. Numbers give dependency order, not a mandatory serial chain.

Each proposed ticket is one complete user-visible path; reusable extraction belongs inside its first working
slice. No horizontal schema/API/helper foundation or speculative expand-contract rewrite is proposed.

## Published tickets

### 01: 失败终端页签可关闭

**Ticket:** [01-close-failed-terminal-tabs.md](issues/01-close-failed-terminal-tabs.md)

**Blocked by:** None (technically independent; respect dispatch phase)

**Delivers:** 失败或未创建的终端页签可立即关闭；正常终端仍请求清理，远端清理失败不恢复已关闭页签。

**Stories:** 1, 2, 3

**Acceptance criteria:**

- 创建失败、清理拒绝/不存在、网络断开均不会留下无法关闭的页签。
- 正常关闭保留必要的连接/资源清理，已关闭页签不会在刷新或恢复布局时重现。
- 通过浏览器交互与受控失败响应验证，不接入交互 PTY。

### 02: 右侧导航高亮全部可见 turn

**Ticket:** [02-highlight-visible-chat-turns.md](issues/02-highlight-visible-chat-turns.md)

**Blocked by:** None (technically independent; respect dispatch phase)

**Delivers:** 右侧导航反映所有与聊天视口相交的 turn，同时保留独立的点击/键盘导航焦点。

**Stories:** 4, 5

**Acceptance criteria:**

- 完整可见及上下边缘部分可见的 turn 均高亮，离开视口后取消。
- 流式内容增长、窗口调整和折叠/展开后重新计算，点击及键盘导航仍正常。
- 使用确定的浏览器布局验证多个可见项，不依赖固定等待或私有状态断言。

### 03: DeepSeek 图片能力元数据正确

**Ticket:** [03-correct-deepseek-image-capability.md](issues/03-correct-deepseek-image-capability.md)

**Blocked by:** None (technically independent; respect dispatch phase)

**Delivers:** 模型目录正确声明配置别名下 DeepSeek 的图片能力，现有 provider、endpoint 与凭据来源保持一致。

**Stories:** 6

**Acceptance criteria:**

- 通过真实 Web 模型目录请求看到目标模型支持 image，文本调用仍使用原配置路由。
- 能力来源沿用上游/显式配置数据，其他模型不会因 provider 名称猜测被错误标成图片模型。
- 在现有原生内容接口及受控 provider 上验证图片不被静默降级；本票不宣称浏览器图片传输已接通。

### 04: 内置 Skills 安装、反馈与当前版本状态

**Ticket:** [04-builtin-skills-install-feedback.md](issues/04-builtin-skills-install-feedback.md)

**Blocked by:** None (technically independent; respect dispatch phase)

**Delivers:** 在已注册 Workspace 上使用内置 Skills 浏览/直接安装 harness bundle，保留安装/Reload 结果与正确的版本状态；将用户入口从独立 Market 切到此流程。

**Stories:** 28, 30, 31, 32, 33, 34, 35, 36, 37

**Acceptance criteria:**

- global/project 目标显式关联执行主机与账号；project 先使用现有单根 Workspace，读取的是执行侧技能。
- 无需活跃对话可浏览 harness 库；安装必须有明确执行目标，完整文件（脚本、二进制及空文件）保持字节一致。
- 成功或已安装但 Reload 失败的反馈在列表/控件刷新后保留；无可关联对话时不伪造 Reload 成功。
- Installed、Up to date、Update 按来源/安装 revision 与目标 revision 显示，基线本地修改另行呈现；已知有新版时更新走现有确认/备份机制。
- 手动技能、既有安装和库数据保留；当前已接通的操作在内置 UI 完整可用，后续来源能力不以占位处理器暴露。
- 以真实浏览器安装/刷新及本地、已有 SSH Workspace fixture 验证上述结果；先复现 B4 再修复。
- 替换 Market 用户入口后保留仍有调用者的存储/安装机制，旧实现清理留到最后；不新增发布或导入导出界面。

### 05: 响应页脚 SVG 与浏览器显示开关

**Ticket:** [05-token-footer-icons-preference.md](issues/05-token-footer-icons-preference.md)

**Blocked by:** None (technically independent; respect dispatch phase)

**Delivers:** 响应页脚使用匹配现有视觉语言的 SVG 和数字；Settings 开关仅控制这些页脚并按浏览器保存。

**Stories:** 17, 18, 19, 20

**Acceptance criteria:**

- 选择统一笔画/比例的输入、输出、缓存读取图标，实际页脚尺寸下评审明暗主题与窄屏；方向语义与现有总量栏一致。
- 保留数字、本地化 tooltip 及包含指标名称和值的可访问名称；复制外部路径时保存完整许可证和固定来源。
- 默认显示延续既有行为，关闭/开启及刷新恢复均正常；总量显示与后端计费统计保持原行为。
- 通过浏览器偏好与可访问性验证；复用现有存储/订阅及 inline SVG 风格，不新增图标运行库。

### 06: 图片提交、SSE 与重启历史

**Ticket:** [06-image-submission-durable-history.md](issues/06-image-submission-durable-history.md)

**Blocked by:** 03

**Delivers:** 从浏览器提交的图片以原生内容块到达目标模型，随后在 SSE、重连与重启后的历史中正确恢复。

**Stories:** 7, 8, 9

**Acceptance criteria:**

- 使用既有附件与原生图片内容机制接通协议、Web、后端及运行时，受控 provider 收到正确 MIME、图片内容与文本。
- Web origin 上的真实提交成功；HTTP/HTTPS 支持场景均验证实际发送，不仅验证 composer 可编辑。
- SSE 投影、断线重连及 SQLite/后端重启保留图片与文本含义，文本-only 历史和命令兼容。
- 大小与内容校验在浏览器/协议/后端一致，不支持或超限时返回可理解的实际错误，不静默丢图。
- 使用受控 provider 与暂存状态验证；付费真实模型 smoke 仍需后续明确授权。

### 07: Web 主机单目录 New Project

**Ticket:** [07-web-host-single-folder-project.md](issues/07-web-host-single-folder-project.md)

**Blocked by:** None (technically independent; respect dispatch phase)

**Delivers:** 用户在 Web 主机选择任意已有目录与展示名称，创建持久 Project 并以该目录启动可实际执行工具的新对话。

**Stories:** 10, 12, 14, 16

**Acceptance criteria:**

- 目录选择/校验使用实际 Web 主机执行账号；Web、后端与 gateway 分离时不把默认后端 Workspace 当成本地主机。
- 创建 Project 仅保存身份、展示名称及已选目录，不创建或重命名 filesystem 目录。
- 目录的单根 Workspace 注册/恢复与 Project 元数据生命周期明确；刷新和服务重启后仍可创建并执行对话。
- 通过真实管理/对话 API 与受控工具检查文件读取位于所选目录，既有 Workspace 和会话不受影响。
- 任意主机目录浏览和运行时注册目前缺接口：实现前说明具体扩展/复用方案，复用现有 gateway/Execution Environment，先交付单目录完整路径。

### 08: 同一主机多目录 Project 与 default

**Ticket:** [08-single-host-project-folders-default.md](issues/08-single-host-project-folders-default.md)

**Blocked by:** 07

**Delivers:** Project 可记录同一电脑的多个已有目录和一个 default；新对话只绑定 default，其他目录保持元数据。

**Stories:** 13, 14, 15

**Acceptance criteria:**

- 同一主机多目录可添加到 Project，Create 时指定一个 default；主机关联保留，跨主机组合明确不属于当前功能。
- 新增对话的实际工具执行根来自 default，额外目录不自动注入 prompt 或开放工具根。
- 保留已存在的单根 Workspace/Project 记录，刷新/重启恢复 metadata、default 和展示名称。
- 用已绑定会话及变化后的 Project 元数据验证：旧会话保持原位置，新对话选择新的 default；不为此新增 default 编辑器或迁移 UI。
- 通过浏览器创建和实际对话/工具请求验证，不能只断言 metadata schema。

### 09: SSH New Remote Project

**Ticket:** [09-ssh-remote-project.md](issues/09-ssh-remote-project.md)

**Blocked by:** 08

**Delivers:** 用户选择 SSH 执行主机及该主机上的已有目录，创建命名 Project，并从 default 创建能实际读取远端文件的对话。

**Stories:** 11, 13, 14, 16

**Acceptance criteria:**

- 复用 Project 多目录/default 流程与既有 SSH gateway/runner；标签展示真实目标账号/主机。
- SSH 目录浏览、profile/Workspace 注册及恢复完整接通；新目录复用同一执行体系，兼容现有 client/profile/Workspace 身份契约。
- 本地、后端和远端放置不同内容的同名路径，真实 SSH fixture 中只能执行选定远端路径。
- 远端 global 技能身份沿用远端执行账号；不可达/权限错误据实呈现，不改用 Web 或后端目录。
- 实现前报告当前固定 profile/根注册限制的具体适配方案；只支持当前 SSH 平台，不引入跨平台执行抽象或 live 部署。

### 10: Skills 双来源搜索与下载

**Ticket:** [10-skills-dual-source-search-download.md](issues/10-skills-dual-source-search-download.md)

**Blocked by:** 04

**Delivers:** 内置 Add skills 同时搜索 skills.sh 与 harness-managed bundles，标明来源并直接装入明确的 global/project 目标。

**Stories:** 29, 30, 31, 33, 37

**Acceptance criteria:**

- 两类来源分别呈现加载、空结果与实际失败；库搜索不需要运行中的对话。
- 来源解析复用既有上游搜索/完整 bundle 下载机制；安装记录不可变 revision/commit 与 provenance，而不是浮动 branch。
- 两种来源的完整内容均通过已接通的执行侧安装/反馈路径，不在 Web 或后端进程执行下载的脚本。
- 既有 curated/GitHub 来源的安装 provenance 可继续识别，不因 UI 迁移将其判为未安装；旧库及手动目录保留。
- 受控搜索/download 服务与真实 gateway fixture 覆盖查询、安装及重复刷新；harness 仍是来源而非第三目标或自动 agent 内容。

### 11: Skills 更新、开关与 Project 目标

**Ticket:** [11-skills-update-toggle-project-target.md](issues/11-skills-update-toggle-project-target.md)

**Blocked by:** 08, 09, 10

**Delivers:** 两种来源的技能可检查/更新、单个或批量切换 model invocation；所有 Project 操作准确落到 default 并保留冲突及 Reload 反馈。

**Stories:** 32, 34, 35, 36, 37

**Acceptance criteria:**

- 来源 revision 是否最新与基线是否本地修改分别显示；unknown/unmanaged provenance 不冒充最新版或未安装。
- 明确更新到精确 revision；本地修改需确认覆盖并保留完整目录备份，读取到发布期间变化及并发更新遵守现有冲突契约。
- 单个/批量开关复用内置 dormant 排序和 toggle 语义，实际写入执行侧 SKILL 内容；不把 Web-host helpers 当资源源。
- global 根据选定执行主机/账号定位，project 根据 Project default 定位，即使当前查看的旧会话仍绑定别的 folder；包含新注册 SSH Project。
- 安装/更新/toggle 对可关联会话复用原有显式 Reload 语义，其他对话不自动热更新；发布已完成而 Reload 失败的结果保持独立可见。
- 本地/真实 SSH fixture 与浏览器操作覆盖更新、目录字节/备份、竞争变化、开关、default 目标及列表刷新。

### 12: 后台 Pi 模型配置读写与原生刷新

**Ticket:** [12-backend-pi-model-config.md](issues/12-backend-pi-model-config.md)

**Blocked by:** None (technically independent; respect dispatch phase)

**Delivers:** Models 设置读取/保存后台权威 Pi 配置，并通过原有 ModelRuntime 验证、刷新与持久化路径影响后续请求。

**Stories:** 21, 22, 23, 24, 26, 27

**Acceptance criteria:**

- Models 设置真实读取后台配置；经 Web origin 验证读写及所需 HTTP 方法，不读取另一个 Web 主机的配置文件。
- 复用上游验证、凭据解析与 refresh；清楚区分校验失败、保存及运行时应用结果，诊断保持既有凭据脱敏。
- 修改后通过受控 provider 检查实际后续请求的 endpoint/参数，保持别名和当前凭据来源；已有 prepared/in-flight 工作遵守上游时机。
- 配置保存后重启仍生效；显式对话选择、模型目录、新对话默认值及资源 Reload 保持各自既有职责。
- 实现前说明 env-mode 接到 Pi 权威配置的具体转换方案；现有部署设置须可保留，不开展 live 配置迁移。
- OAuth、账户用量及其他 provider Settings 子功能保留各自 TODO，不以编辑模型配置扩张实现范围。

### 13: 删除已选模型后的错误与显式恢复

**Ticket:** [13-missing-model-error-recovery.md](issues/13-missing-model-error-recovery.md)

**Blocked by:** 12

**Delivers:** 从模型设置删除仍被会话选择的模型后，后续请求显示原生 no_model/不可用状态，用户可显式选择有效模型并继续。

**Status:** implemented, verified — see [issue 13](issues/13-missing-model-error-recovery.md) and
[validation](validation.md#ticket-13--missing-model-failure-and-explicit-recovery).

**Stories:** 25

**Acceptance criteria:**

- [x] 配置删除可以完成，已有会话的选择仍可识别，不静默改选其他模型。
- [x] 浏览器经真实 Web 提交和 HTTP/SSE 观察框架 failure；错误不伪装为 assistant 回复，也不重写运行时状态机。
- [x] 缺失模型不阻塞其他使用有效模型的会话；错误后的运行状态允许用户重新选择与再次提交。
- [x] 显式重新选择后受控 provider 收到新选择，后端重启/浏览器重连不丢弃原选择与恢复状态。
- [x] 复用当前 model selector、configure、generation failure 与事件/投影机制；以可见用户结果证明后端 no_model 已真正接线。

### 14: 退役 Market 遗留并验收统一 Skills

**Ticket:** [14-retire-market-verify-skills.md](issues/14-retire-market-verify-skills.md)

**Blocked by:** 11

**Delivers:** 清理被替换的 Market 专属 UI/无调用者逻辑，验证内置 Skills 已覆盖既有和新 Project 的完整流程且保留安装与库数据。

**Stories:** 28, 37, 38

**Acceptance criteria:**

- 唯一用户入口为内置 Skills；用管理依赖/调用证据删除已无调用者的 Market 组件、专属展示与失效测试。
- 保留库数据、安装锁、执行侧文件和仍被调用的分发/安装原语，明确处理仍有来源记录的旧 curated 安装。
- 浏览器覆盖双来源、两种目标、新旧/远端 Project、反馈、当前版本、确认更新与开关；核心 gateway/资源加载回归保持通过。
- 将相关交互回归纳入可重复的验证入口；记录既有基线失败与本轮结果，不把 unrelated Settings TODO 当完成条件。
- 更新 Settings 审计中本轮真正接通的接口状态，未选中功能继续留在 TODO；最终 code-review/retro 是后续工作阶段。

## Dependency explanation

- 03 → 06: the requested DeepSeek image path depends on correct capability metadata to avoid native downgrade.
- 07 → 08 → 09: multi-folder UI extends the real single-root Project flow; Remote uses that settled folder/default
  model and the shared registration/lifetime behavior rather than constructing another Project system.
- 04 → 10: dual search/download enters the working builtin installation/outcome path from the bug transition.
- 08, 09, 10 → 11: final toggles/updates must target actual Project defaults, including newly registered SSH
  roots, and must compare/install revisions from both connected sources. These are prerequisites for its demo.
- 12 → 13: deletion/reselection is verified through the real configuration editing/application workflow.
- 11 → 14: obsolete code contracts only after complete replacement flow passes; earlier Skills prerequisites are
  transitive and do not need duplicate edges.

Terminal, navigation, tokens, Models editing and Project creation are not mutually blocked solely because
files overlap or a fixture can be reused. Full effort completion requires every accepted slice plus normal
final review/validation, rather than pretending all unrelated features gate Market retirement.

## Public verification and extension notices

Use the approved browser, Web/backend HTTP/SSE controlled-provider, and local/localhost-SSH execution seams
from [spec.md](spec.md). Tests control completion/committed state rather than sleep and demonstrate visible
behavior, actual request content, filesystem ownership, exact bytes and persistence. Include affected browser
regressions explicitly in validation; workspace test discovery alone does not establish Web behavior coverage.

Before implementing Projects or model configuration, report the actual missing contract and concrete reuse
proposal described in [framework-fit.md](framework-fit.md). These notices are implementation prerequisites,
not permission to run production migration. Model timing follows installed pi-durable; registry/application
failures use native lifecycle rather than a new scheduler.

Interactive terminal connection, existing-conversation relocation/default editing, secondary-folder access,
cross-host folders, machine-wide preferences, unrelated Settings APIs and additional library publishing remain
in [todos.md](todos.md). SVG source research is ready; 05 still includes actual-size visual acceptance.

## Approval and publication

User approved the proposed granularity and dependencies ("同意，可以"). Published one local issue file per
ticket, with the approved descriptions, acceptance checklists, blockers and ready-for-agent status. Spec scope,
public testing boundaries and ticket breakdown are approved. User subsequently authorized implementation
("可以，开始吧"); deployment remains outside this phase. Read dispatch order before assigning ready
tickets: all 14 are merged at tip 0057f73 (14 last, as 0057f73). Implementation and per-ticket verification are
done; the final code review (two axes) and retro remain.

The numbered issue files are authoritative for ticket descriptions, acceptance and progress after publication.
This index preserves the approved breakdown and scheduling context. Update each issue status/checklist during
implementation; approval/publication does not mark any acceptance criterion complete.
