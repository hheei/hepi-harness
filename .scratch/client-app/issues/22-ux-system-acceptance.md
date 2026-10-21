# 22 — UX 收口整体验收

Type: verification
Status: complete with recorded limits — R7 combined acceptance and release alignment verified on `c2b69235872bde7404417bd795c180e88e390b40` (2026-10-21).
Current repair status and measured provenance: [repair plan](../../ux-closeout-research/repair-plan-2026-10-20.md).
Blocked by: [18](./18-web-logout-contract.md) (complete), [19](./19-app-connection-recovery.md) (complete),
[20](./20-native-file-save.md) (implemented; its packaged journey ran at `cc772ec` — 37/37, debug build), [21](./21-read-and-navigation-recovery.md)
(complete), [history 05](../../history-navigation-research/issues/05-system-acceptance.md) (delivered and accepted
`a0caf5d`), [provider 05](../../provider-connection/issues/05-system-acceptance.md) (implemented, limits recorded),
[MCP 05](../../mcp-conversation-tools/issues/05-system-acceptance.md) (resolved and integrated `f2d9268`),
[SSH 09](../../ssh-remote-workbench/issues/09-file-failure-and-preview-feedback.md) (**delivered**, reviewed and rebased
onto `70d9a6d`; its missing-file/preview edge is met — the rest of this ticket is not),
[references 03](../../cross-session-references/issues/03-acceptance.md) (**delivered** at `0a3d065`, re-run on this line at `0acf499` — its real
ingress→Backend journey, inherited-fork-entry follow and real transient read failure all ran).
Parent spec: [UX 收口执行图](../../ux-closeout-research/spec.md)

## Outcome

使用同一当前源码与可追溯产物证明新增 UX 工作流闭环，记录明确不支持的平台/能力。

## Acceptance

- [ ] Web fresh desktop/mobile 登入、登出、普通网络错误恢复；App 配置/拒绝/断开/替换与 bearer 资源/保存可操作。
  - Desktop Web 登入/登出与普通网络错误恢复有证据：18 的 `ux-web-logout`（17 checks）与 21 的读取失败恢复（含本票新增的
    Retry 浏览器断言）。App 配置/拒绝/断开/替换与保存有证据：19 的拒绝面、20 的 `cc772ec` 原生 37/37（真实 GTK picker、
    1048 字节身份一致、取消不留残片）。**Mobile 登录未测量**：既有记录只有 `ad225f8` 部署入口在 390×844 的只读观察
    （`/api/descriptor` 401、无登录表单），那是旧 release，不是本行的通过。故整行不勾。
- [x] 深历史 rail/search、compaction/fork、引用创建/失效目标通过 bounded window 导航，不加载所有中间历史。
  - Bounded window 与引用由 history 05（`a0caf5d`）与 references 03（`0acf499`，45 ok）拥有。R2 已集成
    `d7a03b3` / `04a14fc`：rail 可键盘打开/导航/关闭，compaction 更新 outline 与 Retry 坐标，旧读取受 lifetime/connection fence 约束。
    原缺陷已关闭；R7 组合运行通过：`.dev/review/quality-next/r7.log`，history navigation 82/82、rail keyboard 18/18、history scope 11/11、raw-history focus 32/32。
- [ ] Provider 连接/取消/移除→composer availability 与 MCP 显式选择/调用/child/fork/restart 通过各 owner 验收。
  - Provider 半边由 provider 05 拥有（64 checks，`701add2`），MCP 半边由 MCP 05 拥有（58 checks，`f2d9268`）。两条 named
    limit 仍在 owner 处：交互式 OAuth 对真实上游不可离线复现（`auth.oauth` 只在脚本 provider 组合时声明），delegated child
    在部署上未被实际执行（无 worker definition，只在其 durable seam 上钉住）。因此本行不勾。
- [ ] local/SSH 文件缺失/预览截断、上传/保存、终端输入/resize/reconnect/close 真实表现明确；复用未变源码已有证据，仅补缺口。
  - [x] 文件缺失/预览截断边缘由 [SSH 09](../../ssh-remote-workbench/issues/09-file-failure-and-preview-feedback.md)
    交付（404 `not_found`、`shownBytes`/可空总量、分类恢复面）。上传/保存、终端与 App 打包旅程仍属本票其余行，
    原生保存证据见下一条；本行剩余上传/终端证据复用未变源码记录，未在最终 revision 重跑。
  - 保存半边已补齐：`cc772ec` 的 `native-save-acceptance` 37/37（真实 GTK Save 对话框、1048 字节 sha256 一致、取消
    不留第二个或半个文件、debug shell 来自 `2b1cdf2`）。上传/终端仍复用未变源码的证据（`files-transfer` 17、
    `ux-terminal-session` 38、`ux-terminal-close` 9 场景、`ux-terminal-fan-in` 26），未在本 revision 重跑。
- [x] 面向支持平台记录键盘操作、焦点/错误播报、窄屏关键操作与中文输入观察；不以未复现猜测扩展无界修复。
  - 本票新增 `apps/web/e2e/ux-closeout-accessibility.mjs`（28 checks，`5cc6e22`；产物是 production build，树里的 `StrictMode`
    不会触发开发模式的二次调用重放，因此只陈述所挂载的树，不陈述 development replay）：Tab 可达 composer；Enter 发送、
    Shift+Enter 换行、Escape 经会话自己的 stop 路由停止；读取失败面板 `role="status"`、自述原因、Tab 第一个即 Retry，
    Enter 后二次读取把 transcript 换回；390×844 无横向溢出、裸 Enter 不发送而 Ctrl/Cmd+Enter 发送、`More controls`
    可键盘展开；中文输入法组合期间 Enter 不提交，确认后文本留在 composer，稍后 Enter 发送的正是该文本。
  - R2 键盘 rail 已交付（见深历史行）；R3 已集成 `96ffc28` / `11f84f9`：过期 raw-history 成功/失败不覆盖当前块，
    关闭 sidebar 后隐藏控件 inert，并按需恢复焦点。原四项缺陷已关闭；R7 尚待当前组合验证，本行不勾。
- [x] 运行产物 provenance、source、build target/profile、exact commands、exit、log 与运行origin对应；测试栈结果不冒称线上或不可变产物已验收。
  - 有证据：`5cc6e22` 上 `verify:changed --base=2b1cdf2` clean（`dirty:false`，typecheck/tests/web-unit 全 0），浏览器
    journey 的日志首行自述 source 与 clean 状态；原生 37/37 的日志自述 debug profile 与 `source 2b1cdf2`。
  - R7 已补齐：`build-client-runtime.mjs` exit 0，release `c2b6923`、linux/amd64 image `sha256:8f0f9c827b31a53642a43917956e4f0b62816f94caa574d815c8ba777e72c809`；`live-smoke` exit 0、origin 200、16 conversations、6 models；`live-browser` exit 0，desktop/mobile viewport 均 login/descriptor/conversation/logout 通过且无 page errors；`verify-identity` exit 0，gateway tarball、origin index、service PIDs 与 conversation/model counts 对齐。证据目录：`.dev/deploy/quality-next/`。
    原生证据仍为 debug/shared cache，不能充当不可变 release 或 release 性能测量。
- [x] owning chat/workbench/client-ingress/App 指南与 migration-status 在各实现票同改；汇总仅保留真实剩余限制。
  - 各实现票已随票改各自的 guide（`docs/chat.md` 的读取失败与导航结果、`docs/workbench.md` 的第五种拒绝与预览两个数字、
    `docs/client-ingress.md` 的 per-connection 组装与无 page-origin fallback、`docs/migration-status.md` 的 limit 收口）。
    历史验证见下表；本次同步本票与 repair plan 的交付状态，最终部署结果记录于 Final R7 evidence。

## Historical evidence (2026-10-20, branch `impl/closeout-22`, base `2b1cdf2`, result commit `5cc6e22`)

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| Keyboard, focus, error announcement, narrow viewport, Chinese IME | `node apps/web/e2e/ux-closeout-accessibility.mjs` | `5cc6e22` (clean) | 0 | **28 ok / 0 FAIL** — `.dev/verify/c22-a11y/ux-closeout-accessibility.log` |
| Selected gates over the changed packages and dependents | `pnpm verify:changed --base=2b1cdf2` | `5cc6e22` (clean) | 0 | ui **371**, app 26, gateway 166, server 357, web-unit 14/14 — `.dev/verify/2026-10-20T14-05-49-629-verify-changed/verify.json`. Its report carries three steps (`changed-typecheck`, `changed-test`, `web-unit`); it runs **no** docs step |
| Documentation links and index | `node scripts/check-docs.mjs` | `d977ec1` + the correction's Markdown (dirty) | 0 | 434 Markdown files, 0 broken relative links, 0 guides missing from the index — `.dev/verify/c22-a11y/check-docs.log` |
| Native save, packaged shell, real GTK picker | `node apps/web/e2e/ux-native-acceptance.mjs` (packaging lane) | debug shell from `2b1cdf2`, `cc772ec` | 0 | **37 ok / 0 FAIL**, run twice; private bus, host keyring unchanged — `.dev/worktrees/closeout-packaging/.dev/verify/c17-c20-native/native-save-acceptance{,-rerun}.log` |
| File missing / truncated preview, mounted | `node apps/web/e2e/ux-file-failures.mjs` | `3c7fbeb` (SSH 09 lane) | 0 | **25 ok / 0 FAIL** — `.dev/worktrees/closeout-ssh-09/.dev/verify/rebased-ssh09/ux-file-failures.log` |

**The defect this ticket's own journey found, and fixed here.** The conversation window measured `scrollContainerRef.current`
during render. A read failure replaces the transcript, so the ref is null on the render that recovers from one: Retry
re-read, the panel left, the element mounted, and the window kept measuring nothing — the recovered conversation arrived
as an empty transcript with its composer. The element is now state as well as the ref (`ChatWindow.tsx`), so mounting it
is a render the window sees; the journey's own retry assertion is what holds it.

## Final R7 evidence

- Combined browser command: `bash .dev/review/lean-design-current/r7-browser.sh c2b6923 --with-acceptance`, exit 0; log `.dev/review/quality-next/r7.log`.
- Changed verification: `pnpm verify:changed --base=c5287db`, exit 0 at clean `3bdb8c1ece63358fdbcd6e60e3dbdcf51035165b`; report `.dev/verify/2026-10-20T18-56-41-407-verify-changed/verify.json`.
- Documentation: `pnpm check:docs`, exit 0; `.dev/review/quality-next/docs/integrated-docs.log`.
- Release and deployed-flow evidence: `.dev/deploy/quality-next/{build.log,promoted-checksums.log,switch.log,live-smoke.log,live-browser.log,rehydrate.log,identity.log}`.

## Remaining limits (stated, not smoothed over)

- **R1 retains its native abort/outcome atomicity gap.** Progress persistence is delivered; a crash between native abort and outcome persistence still lacks a runtime receipt. See the repair plan’s R1 disposition.
- **Mobile is not measured.** No authenticated mobile Web login, no mobile App, no Android artifact (no SDK, `adb`, device
  or emulator on this host). The 390×844 figure above is a Chromium viewport of the shared surface, not a mobile platform.
- **Interactive OAuth against real upstream endpoints is unmeasured** and stays provider 05's named limit; the
  OAuth-shaped disconnect path is file-state setup, not a real sign-in.
- **Native evidence is debug, not release.** Debug profile, shared `CARGO_TARGET_DIR`, 6 jobs, incremental; functional
  evidence only, not release performance, not an immutable artifact check, and no peak-memory re-measurement.
- **Terminal and upload rows reuse unchanged-source evidence** from earlier revisions (`ux-terminal-session` 38,
  `ux-terminal-close` 9, `ux-terminal-fan-in` 26, `files-transfer` 17); they were not re-run at `5cc6e22`.

## Limits

既有 client-app16/17 完成情况不因本票重开。Android 缺 SDK、后台 push、live watch、Provider discovery/test、Skills 卸载、session export、global dock、extension 平台维持明确 deferred；不作为本票隐含阻塞。原生仅 debug/6 jobs/incremental/shared target；功能证据不冒称 release 性能。部署通过既有运行路径另行执行，不因发布本票启动部署。
