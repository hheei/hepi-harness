# 18 — Web 登出合同与宿主动作

Type: implementation
Status: complete (2026-10-19; branch `fix/client-app-18-logout` from `main` `d356152`)
Blocked by: [17](./17-retire-next-and-transition-paths.md) — closed by 17's 2026-10-19 closeout
Parent spec: [全栈重构后续 UX](../spec.md)

## Outcome

Cookie Web 在 Settings 登出后回到登入面；App 不显示无效的 cookie 登出动作。

## Scope

研究 A2 源码证据：SettingsPanel 发送 DELETE /api/web-auth，而当前 ingress 清 cookie 的合同为 DELETE /api/web-logout。在现有 client/request 与 ingress seam 修正调用和宿主动作可用性；共享 UI 不创建另一认证层。设备断开由 [19](./19-app-connection-recovery.md) 拥有，不把 Web logout 当设备撤销。

## Acceptance

- [x] 普通已登入 cookie 会话点击登出，调用当前合同、清 cookie、回到可操作登入面；失败显示可重试错误，不宣称已退出。
- [x] bearer App 不提供 cookie logout；不隐式撤销凭证或停止 durable run。
- [x] 在隔离 fixture 验证正常登入→登出→重新登入；研究和测试不操作开发者线上会话。
- [x] 更新 owning client-ingress/连接操作指南，记录 command、tested SHA、exit、log。

## Evidence and verification

[研究 A2](../../ux-closeout-research/04-web-app-and-operational-feedback.md)、[排程](../../ux-closeout-research/spec.md)。聚焦公开 HTTP/共享 UI 行为与 pnpm verify:changed；不重复整套认证测试。
