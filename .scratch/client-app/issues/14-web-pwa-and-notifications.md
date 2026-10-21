# 14 — 新 Web 的 PWA 与页面通知

Type: implementation
Status: resolved
Blocked by: [05](./05-shared-ui-routing-and-scope.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

新 Web 首次安装、offline 提示和页面通知可用。

## Scope

Web root 负责 PWA 注册、manifest/offline 与 Vite worker 资源策略。按新安装/新状态实现，API 与私有响应不缓存。页面通知沿用 lifecycle 事实；App 按平台能力声明。删除无服务端实现的 Push 原型与死调用，不新建后台推送。无需旧 worker/cache、旧页面、草稿或偏好升级路径。

## Acceptance

- [x] 新站点首次安装、manifest、图标、offline 与 Vite 资产工作。
      `apps/web/public/manifest.webmanifest` 由 `apps/web/src/index.html` 链接；Vite entry 在首帧后经
      `apps/web/src/pwa.ts` 注册 `/sw.js?v=<package version>`（scope `/`）；worker 预缓存 offline 页、manifest 与图标，
      导航网络优先并以 offline 页兜底，`/assets/` 走 cache-first。真实 Chromium 新 profile 的 seam 见
      `apps/web/e2e/ux-pwa-offline.mjs`（24 checks）：浏览器自己解析 manifest（名字、start_url、standalone、两个 PNG 图标
      200）、worker 激活并接管、离线导航显示 offline 页、hashed asset 离线仍由缓存返回。
- [x] API/私有资源不缓存，App 不注册 Web service worker。
      worker 不拦截、不缓存任何 `/api/`（真实浏览器断言：两次 API 读都到服务器，任何 cache 内没有 `/api/` 路径；离线时
      会话读被拒而不是由缓存回答）。App 侧由既有 `apps/app/test/bundle-boundary.test.mjs`（2 tests）断言其 bundle 内
      `serviceWorker.register` 不存在；本票只把注册放在 `apps/web/src`。
- [x] 页面完成音/通知遵守 lifecycle authority，恢复读不补造成功提示。
      页面系统通知仍只有 `packages/ui/src/lib/browser-notifications.ts` 一处，由 `AppShell` 仅对 `answered` 通知、且仅在页面
      不在前台时请求；recovery lookup / reconnect / 已终态 baseline / `resync_required` 在 lifecycle projection 里不产生
      notice，因此不产生通知（既有 `useAgentSession.lifecycle.test.mjs`、`completion-delivery.test.mjs`）。本票为投递路径补
      `packages/ui/src/lib/browser-notifications.test.mjs`（4 tests：注意力判定、worker 投递、窗口投递与点击、被拒即静默）。
- [x] 无 Push 死调用或虚假的后台通知成功；新草稿/偏好使用已选作用域。
      删除 `packages/ui/src/lib/push-client.ts`、`AppShell` 的自动订阅 effect 与 completion 路径里的
      `setupPushSubscription`、`SettingsPanel` 的 push 区块与 capability 探测、3 个语言包的 `settings.push*` 键、
      `capability-availability.ts` 中已无调用者的 `useCapabilityServed`。worker 不注册 `push`/`sync`/`periodicsync`。
      `packages/ui/src/lib/push-client.test.mjs`（2 tests）在可执行源码层面禁止 push 路由与 `PushManager` 回归。
      草稿/偏好作用域属 05，本票未改。

## Verification

从新浏览器状态验证首次安装、在线/离线提示、API 缓存策略及页面通知；不跑旧版升级场景。全部检查在 revision
`7516034`（clean tree，integration/client-app `47f501c` 已合入）上执行，log 在 `.dev/verify/ticket-14/`：

| 检查 | 命令 | exit | log |
| --- | --- | --- | --- |
| workspace typecheck | `pnpm -r typecheck` | 0 | `typecheck.log` |
| workspace tests | `pnpm -r test` | 0 | `workspace-tests.log` |
| Web 单测（49） | `node scripts/test-web-unit.mjs` | 0 | `web-unit.log` |
| worker 与注册（10） | `node --test apps/web/src/service-worker.test.mjs apps/web/src/pwa.test.mjs` | 0 | `web-pwa-unit.log` |
| 通知与 push 退役（6） | `node --test packages/ui/src/lib/push-client.test.mjs packages/ui/src/lib/browser-notifications.test.mjs` | 0 | `ui-notifications.log` |
| App bundle 边界（2） | `node --test apps/app/test/bundle-boundary.test.mjs` | 0 | `app-boundary.log` |
| Web 静态构建 | `pnpm --filter @hepi/web build` | 0 | `web-build.log` |
| 真实浏览器 PWA seam（24 checks） | `node apps/web/e2e/ux-pwa-offline.mjs`（= `pnpm --filter @hepi/web test:pwa-offline`） | 0 | `pwa-offline.log` |
| capability 三态 + 退役 push + trust（17 checks） | `node apps/web/e2e/ux-capability-trust.mjs` | 0 | `capability-trust.log` |
| 面板 ingress（18 checks，11 的 seam，重跑） | `node apps/web/e2e/ux-panel-ingress.mjs` | 0 | `panel-ingress.log` |
| 选定检查 | `pnpm verify:changed --base=integration/client-app` | 1 | `verify-changed.log` |

`verify:changed`：changed-typecheck / changed-test / web-unit 全部 0；`check-docs` exit 1，12 条断链全部是 git-ignored
`.dev`/`.pi` 目标的既有断链（`node scripts/check-docs.mjs | grep '^BROKEN' | grep -v '\.dev/\|\.pi/' | wc -l` 为 0），
与本票改动无关。

## Review notes

见[审查记录](../review-notes.md) G4/G5/G6。旧用户状态处理已移出范围。G4 的 push 原型在本票删除；G5 的 Vite
worker/manifest 在本票建立。

## Verification practice

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；发现依照
[review policy](../../../docs/agents/review-policy.md)按实际影响处理。

## Remaining limits

- **真实安装提示未验收。** headless Chromium 无法接受安装提示；本票断言的是安装面本身（manifest 被浏览器解析且无错、
  两个图标可取、worker 激活并接管 scope `/`），不声称系统级安装行为。
- **旧 Next 入口与 vendor 快照未清理。** `apps/web/app/**`、`apps/web/next.config.ts` 与
  `apps/web/vendor/pi-web/lib/push-client.ts`（上游快照）留给 17；本票只删除可执行死调用。`apps/web/public/sw.js` 同时
  是旧 Next 站点的 worker 路径，改写后旧站点的静态资源缓存策略随之改变——这是「直接替换、无旧版升级路径」的一部分。
- **无后台推送。** 通用后台推送仍是明确的非目标（spec 记录）；App 侧通知能力取决于其 WebView，未在本票验证。
- **cache 版本以 package version 命名。** 同一 version 的多次构建共享缓存名，靠 hashed asset 名与 network-first 导航
  保证正确性；发布标识属 15。
- **并发改动重叠已报告。** `SettingsPanel.tsx`（push 区块）、`packages/ui/src/lib/capability-availability.ts`
  （`useCapabilityServed`）以及 11 的 `apps/web/e2e/ux-panel-ingress.{mjs,fixture.tsx}`（其 page-origin 断言以 push 为例）
  在合入 integration tip 时被本票最小改动触及。
