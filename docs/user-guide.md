# User guide: working with Hepi

用 Hepi 在本地或 SSH 项目里与 agent 协作、查看文件、运行终端、使用 MCP 工具。
Web 与桌面 App 挂载同一个工作台;身份与文件保存方式由宿主决定。部署安装见 [Documentation index](README.md),
开发实现见 [Developer guide](developer-guide.md)。

## Sign in on the Web

打开部署的 origin,若出现登录表单,输入部署方给的登录材料。成功后获得有效期 30 天的
登录 cookie。用页面登出控件退出;从外部链接进入若未带登录状态,在同一 origin 内导航一次。
见 [Client ingress](client-ingress.md#ending-a-web-session)。

## Configure the desktop App

1. 在已登录的 **Web 会话**签发设备凭据并附标签。App 设备不能签发新身份。
2. 在首次运行表单填写 profile、Gateway ingress origin、设备 bearer。连接存 OS 凭据库;App 重启以更新窗口策略。
3. 无显示环境用 `hepi-app --configure` 从 stdin 读 JSON,用 `hepi-app --forget` 删除本机连接。

| 状态 | 操作 |
| --- | --- |
| 凭据被拒(401/403) | **Configure connection…** 换凭据,或 **Disconnect…** |
| Gateway 不可达 | **Try again**,或 Configure / Disconnect |
| 未配置 | 填首次运行表单 |

Disconnect 只删本机连接,不撤销设备凭据、不停止 durable run。撤销在 Web 会话里做。
见 [App README](../apps/app/README.md#when-the-gateway-refuses-the-connection)。

## Projects: local and SSH

侧栏 **New** → 选择部署本机或已配置的 SSH profile → 浏览目录或输入路径 → 创建。SSH 下拉显示远端报告的账号,
目录由远端确认并规范化。

Project 属于一台计算机,含一个或多个文件夹,恰好一个默认;新会话绑定默认文件夹。切换默认、解绑文件夹、删除
项目都解析项目自己记录的主机;已绑定会话保持可解析。执行、文件与终端共用虚拟 `/workspace/<id>` 绑定,
不向浏览器暴露宿主绝对路径。见 [Projects](projects.md) 与 [ADR 0004](adr/0004-one-project-many-folders-one-default.md)。

## Chat

| 操作 | 行为 |
| --- | --- |
| 发送消息或图片 | Enter 发送、Shift+Enter 换行(以界面提示为准);网络重试不会重复准入同一消息;图片随消息提交 |
| 忙碌时输入 | steer 插入当前轮;follow-up 等当前轮结束;仅排队不唤醒 |
| 修改排队项 | 逐项编辑/取消,或 recall 回输入框;重复取消仍是同一个结果 |
| 停止 | 只停止当前会话;停止子树是另一个显式操作,不随父会话停止级联 |
| 选择模型/思考等级 | 会话内选择;新会话用部署默认,未配置则无默认并以 no_model 收束 |
| 打开本轮修改 | 点击一轮列出的已改文件 |
| 等待后台完成 | 收到页内通知与提示音;恢复/重连/重新同步静默 |

完整状态见 [Chat](chat.md)。

## Models and providers

在 **Settings › Models** 定义 provider、自定义 OpenAI-completions 端点、导入模型、编辑 models.json 与选择可用模型。
登录或 API key 写入 **Web origin 主机**账号的 `~/.pi/agent/auth.json`,不通过 Backend 转发。
列表区分 provider 可解析的凭据(含环境变量/AWS/ADC 等来源)与本机保存的类型;仅显示掩码提示。

Backend 默认读自己的进程环境;`HEPI_CONFIG_SOURCE=pi` 读 **Backend 主机**的 agent 目录。两台主机分离时,
Web 主机登录不会自动成为 Backend 模型来源。ADR 0008 目标与当前 Gateway 认证实现仍有已记录分歧。
见 [Providers](providers.md)、[Pi config](pi-config.md)、[ADR 0008](adr/0008-gateway-as-capability-broker.md)。

## Files: browse, preview, upload, save

文件面板读取会话 workspace 的目录与 git 状态,支持文本、图片、音频/视频、Word 预览。

| 操作 | 界限 |
| --- | --- |
| 文本预览 | 本地/SSH 200 KiB;无下一段续读,超出需完整下载 |
| 图片 / DOCX 预览 | 各 10 MiB;超出仍可完整下载 |
| 上传 | 每请求合计 100 MiB,部署可调小;写前按报错/覆盖/跳过处理冲突 |
| Web 下载 | 浏览器直接写盘,页面不持完整字节 |
| App 保存 | 原生保存;取消或失败删除本次部分文件,源文件不动,不重试 |

文件列表每行悬停出现保存按钮;移开指针只隐藏保存按钮,已开始的保存继续完成。

实时监听、链接目录审批尚未提供;不支持的操作会明确说明。
见 [Workbench](workbench.md) 与 [App 保存](../apps/app/README.md#saving-a-file)。

## Terminal

在会话的 `/workspace/<id>` 打开终端标签。所有标签共用一条终端流,默认 30 s 心跳。重连按标签 cursor 续读;
新挂载无 cursor 时读取保留尾部(128 KiB)。进程退出显示退出码;主机上的会话不存在时可重连开新会话。
见 [Terminal sessions](workbench.md#terminal-sessions) 与 [Terminal fan-in](client-ingress.md#the-terminal-fan-in)。

## MCP servers and tools

MCP 配置、凭据、OAuth 与服务器进程属于 **Web origin 主机**账号。

1. **Settings › MCP** 添加 URL 或命令行,也可手写条目;测试连接会启动服务器、列工具、关闭。
2. HTTP 登录打开授权链接,把浏览器最终跳转地址粘回面板。项目级配置需先决定项目信任,否则不读项目文件。
3. 会话选 `hepi.mcp` 扩展;在 MCP 面板列服务器工具,授予要提供给该会话的工具。

授予持久记录工具身份与当时 descriptor;只有授予的工具提供给模型。主机每次调用重查信任、开启、暴露与工具存在,
撤销在下次调用生效。`HEPI_MCP_TOOLS` 只是运维预置声明,不授予工具。SSH gateway 不提供 MCP;无本机服务时答
`mcp_unavailable`。见 [MCP on the Web host](mcp-on-the-web-host.md)。

## Navigation, history and references

| 操作 | 行为 |
| --- | --- |
| 向上滚动 | 加载更早消息;窗口上限 50 条可见消息、512 KiB 目标,传输硬界为 1 MiB − 64 KiB |
| 右侧历史导轨 | 分页索引整个会话;已加载节点有真实位置,未加载空心点点击后才读目标窗口 |
| Raw history / Fork here | 读取 compaction 前缀与 fork 继承前缀,在条目处分叉 |
| Fork | 继承该时点历史与配置;创建者、显示父、fork 源、任务所有者分别记录 |
| References | 引用会话或条目;不改父、不授予控制、不复制内容,目标删除后保留无法解析状态 |
| 搜索 | 定位具体条目/文本块,最多一次有界读取,不逐页走到目标 |

见 [Full-history outline](chat.md#the-full-history-navigation-outline) 与 [Subtree control](notes/subtree-control-web-ux.md)。

## Recovery when something failed

| 症状 | 下一步 |
| --- | --- |
| 会话读不到 | 看后端无响应/不存在/拒绝的区别,选 Retry 或 Back to conversations |
| 提交结果未知 | 客户端查询 durable 记录,不重发消息 |
| 跳转失败 | 按 missing/stale-snapshot/wrong-scope/malformed/cancelled/deferred-busy/error 原因 Retry |
| 子会话上下文准备失败 | 在恢复面板显式重新准备 |
| App 连接被拒 | Configure connection 或 Disconnect |

## Supported limits

- 单用户、无 shell 沙箱;允许 bash 即允许 gateway 用户运行任意脚本。
- 一个部署一个 Backend writer,一个 gateway 进程一个 call journal。
- 不承诺 exactly-once:丢答案报 outcome_unknown;崩溃后的 write/edit/bash 意图 interrupted、不重放;文件写无 journal。
- 未支持的客户端设置路由答 `501 unsupported`;实时文件监听、链接目录审批、SSH MCP、通用后台推送未提供。
- 桌面只测量 Linux x86_64 + WebKitGTK 4.1;Android 不构建或宣称。

完整能力状态见 [Migration status](migration-status.md)。
