# 01 — 确定目标能力与首发平台

Type: decision
Status: resolved
Blocked by: none
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

明确新方案要交付的能力、首发平台和模块职责，按私人项目直接切换。

## Scope

以新架构整理目标能力和 owner，现有代码仅用于复用与删除检查，不逐项保留旧行为或 URL。确定一个桌面和一个移动目标、设备/工具链/签名条件，以及静态 Web 服务位置、TLS/Origin 和一次直接切换方式。允许从新状态验证，不安排历史保留、多版本兼容或旧客户端升级。

## Acceptance

- [x] 目标清单明确聊天、项目/worktree、关系/委派、模型/provider/扩展、宿主资源、MCP/trust、媒体、文件、终端、认证和 Web 能力的首期范围。
- [x] 区分入口宿主、Backend 身份、execution Gateway 与 SSH profile；cwd 不作为授权。
- [x] 首发桌面/移动目标和所需环境明确，缺失条件阻塞对应原生验证。
- [x] 列出被替代代码/服务的删除范围，不建立旧用户迁移、回滚或兼容工作项；最终删除见票据 17。

## Verification

审查目标清单与源码复用/删除范围，确认未测试平台未被写成已支持。

## Review notes

见[审查记录](../review-notes.md) G1/G3/G4/G5/G8。按用户最新范围执行直接替换。完成后更新目标清单与票据状态。

## Verification practice

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；发现依照[review policy](../../../docs/agents/review-policy.md)按实际影响处理。

## Answer

决定已写入 [spec 的 Release envelope 段](../spec.md#release-envelope)；本节记录决定本身与证据。

**首期能力**：聊天、项目/worktree、关系/委派、模型/provider/扩展、宿主资源（skills/安装/agent definitions）、MCP/trust、媒体/历史、文件、终端、认证、Web 安装/offline/页面通知。不做：APNs/FCM 原生后台推送、file watch、版本协商与旧客户端兼容、旧用户/历史/草稿/偏好迁移与回滚演练。

**身份分离**：客户端入口（Gateway `/api`，同源 cookie 或可撤销设备 bearer）、Backend 身份（durable 权威，独立服务凭证）、execution Gateway（内部 `/v1`，独立绑定与 token，`packages/gateway/src/startup.ts:264` 仅监听 127.0.0.1）、SSH profile（执行宿主传输配置，不进客户端连接描述）。`cwd` 仅路径信息，不构成授权；workspace/project 绑定由 Backend 解析。

**首发桌面**：Linux x86_64（workstation），WebKitGTK 4.1，Tauri v2。复核于 `dd1f33f`：`uname -m` = `x86_64`；`rustc --version` = `rustc 1.96.0 (ac68faa20 2026-05-25)`；`cargo --version` = `cargo 1.96.0 (30a34c682 2026-05-25)`；`dpkg -l libwebkit2gtk-4.1-dev` = `ii 2.52.3-0ubuntu0.24.04.1`；`pkg-config --modversion webkit2gtk-4.1` = `2.52.3`；`command -v cargo-tauri` 无输出，`cargo tauri --version` = `error: no such command: \`tauri\``（exit 0）。Tauri CLI 缺失阻塞票据 04 的桌面构建，不改变目标选择。

**首发移动候选**：Android。`ANDROID_HOME`、`ANDROID_SDK_ROOT` 为空；`adb`、`sdkmanager` 不存在；无 `~/Android`。该缺失阻塞票据 04 的移动端证据，故不声明 Android/iOS 支持；iOS、Windows、macOS 未选。

**Web 与切换**：Vite 静态构建，与未来 client ingress 同源；直接切换 = 停 Next，由当前构建服务同一 origin。TLS 属部署关注点，未声明存在外部 TLS 监听。切换前 `hepi-web` 与 `HEPI_AUTH_TOKEN` 仍为运行入口，本票据不改 gateway/Backend 启动。

**删除范围（17 执行，现在不删）**：`apps/web` Next 应用；`hepi-web` 服务与镜像（`deploy/compose.yaml:62`、`deploy/docker/web.Dockerfile`）；BFF catch-all `apps/web/app/api/[...path]/route.ts`；无服务端实现的 Push 原型 `apps/web/lib/push-client.ts:35,49`；`next/dist` busboy 用法 `apps/web/lib/bounded-form-data.ts:4`；`HEPI_AUTH_TOKEN` 同时充当浏览器登录密钥与 Backend bearer（`route.ts:13-19`、`durable-api.ts:43-48`）。不建立迁移、兼容或回滚工作项。

Verification：本票据为 Type: decision，无代码/测试循环。证据为上列只读命令（`uname`、`rustc --version`、`dpkg -l libwebkit2gtk-4.1-dev`、`pkg-config`、`command -v cargo-tauri`、`cargo tauri --version`、`ANDROID_HOME`/`adb` 探测）在 revision `dd1f33f478b618c221502fd65ced623d8c9617f7` 上的输出，源码位置已在本 revision 确认。
