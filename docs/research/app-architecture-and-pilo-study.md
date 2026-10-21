# Hepi 客户端架构与功能储备全景研究

> 本文严格分为架构与功能两部分，当前重点是架构。代码适配、模块 seam、认证、恢复与渐进迁移详见 [Hepi 客户端架构适配研究](hepi-client-architecture-adaptation.md)。状态：2026-10-17 研究；Tauri v2、React Router、目标入口拓扑、Backend 运行 agent loop、共享 React UI 与通信复用方向已确认；私人项目无有价值历史：直接替换，不做旧用户升级、历史搬迁、旧版本兼容或回滚演练；被替代旧 feature 必须完整移除。未实施建议不代表当前能力。

> **定点记录（2026-10-17）。** 文中“当前代码：Web → Next BFF”指当天链路，已由 client-app 票 17 删除。现行入口与职责见
> [架构](../architecture.md#ownership) 与 [客户端入口](../client-ingress.md)；本文的功能储备与研究结论保留为证据。

# 第一部分：全链路与客户端架构设计 (当前重点)

## 1. 目标拓扑与当前实现

**目标：App/Web ↔ Gateway ↔ Backend。** 客户端配置 Gateway 地址，由 Gateway 提供统一客户端入口。Web 的登录/同源职责由新入口承接，旧代理仅在迁移期保留；App 使用面向设备的认证；两者共用业务契约。

```text
Web React UI ─────────────────────────┐
                                      ├→ Gateway 客户端入口 → Backend agent loop / durable / SQLite
Tauri React UI ───────────────────────┘                                  │
                                                                         └→ Gateway 内部执行接口
```

**当前代码：Web → Next BFF → Backend → execution Gateway。** Backend 当前同时承载 authoritative agent/durable runtime 和唯一 SQLite writer；Gateway 承载文件、进程、PTY、SSH 与 MCP 等执行能力。依据：[现有架构](../architecture.md)、[内部 Gateway client](../local-integration.md)。

建议先新增 Gateway 客户端入口，复用必要客户端映射与认证，不改 durable runtime 归属。Gateway 入口与内部执行接口需要明确区分，防止 Backend 调用内部工具时再次绕回客户端入口。

**agent loop 本来就在 Backend，目标也继续如此，不涉及运行时迁移。** Gateway 计算指工具与宿主执行能力；durable 调度与提交仍归 Backend。宿主 IO 缩短路径保留 workspace 授权与多执行宿主路由。

## 2. 客户端容器与 UI 复用

**已选 Tauri v2。** 采用系统 WebView，符合复用 React、Tailwind、Markdown 和终端 DOM 界面的方向；Electron 仍偏桌面，React Native 无法直接复用现有 DOM UI。Hepi 的安装包、内存与代码复用比例尚未实测，不以其他项目的估值作为承诺。

| 方案 | Hepi 适配特点 | 定位 |
| --- | --- | --- |
| Electron | React/DOM 可复用，携带 Chromium/Node；不覆盖本次移动目标 | 不采用 |
| React Native | 可共享部分 TypeScript，DOM、xterm 与复杂 Markdown 需要另一套渲染 | 不采用 |
| Tauri v2 | React/DOM 可复用；桌面与移动仍有工具链、权限和设备差异 | 已选 App 容器 |

**共享 React UI 与 React Router 已确认，Web 无须绑定 Next。** 推荐 Vite + React + React Router，让 Web/App 复用前端构建与路由；Web 直接采用新入口；完整删除旧 Next/BFF 与残留路径是交付必做阶段，不建设旧版兼容。框架取舍详见[架构适配研究](hepi-client-architecture-adaptation.md)，入口合同、连接作用域与迁移验收见[架构蓝图](hepi-client-architecture-blueprint.md)。

迁离 Next 时，登录 Cookie、Origin 校验和同源代理职责转到 Gateway/同源入口。当前 Next 的 cookies 首屏和动态 API 不能直接打包到 Tauri；官方 Next 集成要求静态导出。[官方 Next/Tauri 说明](https://v2.tauri.app/start/frontend/nextjs/)

共享代码的工作重点是收口相对 API、路由、流和认证资源加载，再抽取实际共用的 React/投影模块。Tauri Rust 层仅承载必要原生能力，不携带第二份 agent runtime 或 SQLite 会话副本。

## 3. 同机性能优化

| 方向 | 当前事实与建议 |
| --- | --- |
| SSE 字节透传 | 当前 durable adapter 已实现；新 Gateway 入口延续，不重复 parse/stringify |
| 文件流式转发 | 当前 file-relay 已传递 HTTP body；避免完整缓冲，但不等于内核 zero-copy |
| 宿主 IO 缩短路径 | Gateway 入口授权后可逐步减少文件/终端绕行；不能跳过 workspace 解析 |
| 批量资源读取 | 复用现有 `resourceSnapshot`，减少多次小请求 |
| UDS | 待测量后考虑宿主进程间通信；仍有 HTTP/JSON 编解码，需容器与跨平台策略 |
| 同进程调用 | 能减少序列化，但改变部署和故障隔离，暂不作为 App 前置条件 |

不依据 localhost 自动降低 heartbeat；不让 WebView 普通 fetch 直接连接 UDS。先测量首屏、首帧、admission、文件吞吐与各 hop 耗时，再决定优化。[具体适配与限制](hepi-client-architecture-adaptation.md)

## 4. 通信、多端恢复与设计原则

沿用现有 **HTTP 控制 + SSE**。双向交互不要求 WebSocket；已有 native snapshot、revision、`resync_required` 与 submission 查询，可支持回前台恢复。终端 cursor 与会话 revision 各自保留原语义，不引入全局事件游标。[Submission ADR](../adr/0006-durable-submission-lifecycle.md)

- 未知发送结果按原 `requestId` 查询，不自动重发。
- App 不能假定后台长连接永久存活；以前台恢复正确为基础。
- Cookie、Bearer、图片/下载与终端 EventSource 必须一起适配；只换 API base URL 不够。
- `GatewayHostClient` 是宿主内部执行 client，不是 App SDK；`packages/client` 现为 CLI。
- 复用已有 protocol/session/投影，真实 Web/App 差异放在薄入口，不传播 `isTauri` 分支。

角色审批、通知推送与离线写入暂不作为架构前置条件，相关产品能力留到第二部分后续评估。

## 5. 旧 feature 完整退役

用户要求方案包含完全移除旧 feature。当前按被新架构替代的旧实现、入口和迁移兼容路径界定；具体产品功能若需删除，在实施清单逐项列名。迁移完成必须删除旧代码副本、临时 fallback/re-export、失去消费者的依赖、旧服务/反代/配置及旧专用测试，并把必要行为验证迁到新公开 seam。不要求旧入口并行服务，不建设旧用户/旧数据升级链路；详见[架构蓝图的退役合同](hepi-client-architecture-blueprint.md)。

## 6. 参考项目的借鉴边界

- **Pilo**：参考 Tauri 宿主、前端与平台能力隔离、连接恢复与移动 Web 体验。其本地 Pi/stdio/远程 server 生命周期不应复制到 Hepi 客户端。
- **PI-Desktop**：参考远程控制、订阅恢复与交互概念；不直接复制其状态耦合与复杂宿主实现。
- **PiDeck**：参考多任务、会话和工具反馈概念；不引入多后端引擎与 Electron 主进程架构。

实现阶段可复用的代码仍需逐项检查 license、版本与依赖。功能创意不等于架构要求，也不代表 Hepi 尚未具有对应能力。

---

# 第二部分：功能特性与 UI/UX 储备库 (供后续实现阶段参考)

> 以下功能与交互设计提炼自 **Pilo**、**PI-Desktop** 和 **PiDeck**，已剥离其混乱的源码实现，留存作为产品原型的**纯净构想库**。

## 1. 输入区增强 (Composer)
- **Model × Reasoning 胶囊芯片**：在输入框内整合模型选择器与思考强度滑块（`ThinkingLevelSlider`，设置 0 ~ 32k 思考预算）。
- **复合触发器 (`/` 与 `@`)**：输入 `/` 呼出 Agent 模式与 Slash 快捷命令；输入 `@` 呼出工作区文件路径自动补全。
- **安全挡位开关**：输入框旁一键切换「全自动执行 (Auto-run)」/「每步询问 (Confirm-each)」/「仅规划 (Plan-only)」。

## 2. 对话流与状态透视 (Transcript & Inspection)
- **会话缩略小地图 (`ConversationMinimap`)**：长会话右侧的垂直微型指示轨，以每轮提问为刻度，悬停展示摘要气泡，点击平滑滚动跳转。
- **Token 上下文透视仪 (`ContextUsageInspector`)**：环形进度条常驻，展开后清晰看到 System Prompt / Tools / 历史消息占比以及 Prompt Cache 命中率。
- **回答级修改摘要胶囊 (Per-turn Modification Pill)**：每轮代码生成完毕后，回答底部自动收纳修改统计（如 `✏️ 3 个文件已修改 (+45 -12)`），点击直达 Diff 视图。
- **高危工具拦截卡片 (`AskToolCard`)**：Agent 尝试写文件或执行破坏性 Shell 时，以原生卡片呈现命令与变更，支持单次允许/拒绝。
- **常驻待办进度条 (Active Todo Progress Strip)**：输入框上方显示当前多步任务的完成度（如 `[2/5] 正在执行编译...`），点击查看完整步骤列表。

## 3. 生产力与多任务流 (Productivity & Multitasking)
- **「Ask 并行问询」副面板 (Parallel Side Inquiry)**：主任务正在耗时运行时，呼出侧边会话并行向 Agent 提问项目细节，不阻塞主任务，回答可一键送回主输入框。
- **历史节点分叉 (Session Fork / Rewind)**：支持从历史任一轮次分叉出会话分支，截断后续内容并回填输入框，方便尝试不同提问。
- **「视觉桥」(Vision Bridge)**：当使用不支持看图的纯文本模型时，前端自动调用廉价视觉小模型把图片转成结构化文本，无缝融入 Prompt。

## 4. 辅助工作区面板 (Work Panels)
- **Review 面板**：独立全屏/分屏代码审查区，对 Agent 的全部代码修改进行逐行 Git Diff 审查与选择性接受。
- **Browser Preview 面板**：内置本地 Web 服务端口代理预览。
- **File Browser 面板**：文件树快速检视与跳转。

## 5. 多端中枢与通知
- **持久化通知信箱 (`NotificationCenter`)**：移动 App 端的核心体验点。离开电脑时，任务完成或等待审批的消息持久化沉淀在通知抽屉中，不依赖瞬时 Toast。
- **供应商额度探针 (Balance Probe)**：在模型面板中实时探测 OpenRouter / DeepSeek / Kimi / SiliconFlow 等 API 账户的实时余额与消耗。
- **飞书/企微 Webhook 通知桥**：长时间构建或执行完成后，自动向移动端通讯工具推送卡片与深层跳转链接。
