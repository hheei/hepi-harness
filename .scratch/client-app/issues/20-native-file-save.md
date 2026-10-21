# 20 — App bearer 文件另存

Type: implementation
Status: implemented and the packaged native journey now driven (2026-10-20, worktree `closeout-packaging`); see [Verification](#evidence-and-verification)
Blocked by: [17](./17-retire-next-and-transition-paths.md) (closed)
Parent spec: [全栈重构后续 UX](../spec.md)

## Outcome

桌面 App 可将已授权的本地／SSH workspace 文件保存到用户选定目标；Web 保持现有浏览器下载，上传沿用已有共享流程。

## Scope

解决 file-seam 的 NATIVE_SAVE_REQUIRED。原生宿主提供目标选择与有界保存 adapter，共享 UI 复用连接认证的资源读取；原生写入保持在 App 边界，前端不取得 execution token。实现前确认 WebKitGTK 的流/IPC限制，沿用平台已验证的分块约束（跨 IPC 单块至多 1 MiB），不得将整份多 GiB 文件转成 Blob/数组后另存。

## Acceptance

- [x] bearer App 从 local 与 SSH workspace 另存成功；选择取消不发起文件传输，也不显示失败。
      —— 路径由连接认证的 `?type=download` 读取实现，local 与 SSH workspace 走同一条 gateway 文件面（无 host 分支）；
      取消的 picker 返回 `null`，`saveFile` 在读取前返回 `cancelled` 且不发任何请求（`file-save.test.mjs`）。
      打包 native 旅程本身未在本轮重跑，见下方 Verification。
- [x] 既有文件覆盖按明确用户选择处理；失败/取消清理本次部分文件，不误报完成；保留源文件。
      —— `app_save_begin` 未确认时拒绝截断既有文件；`app_save_abort` 只删除本次 open 的目标；append/flush 失败走 abort
      且不返回 `saved`（Rust 单测 5 条 + `file-save.test.mjs` 的失败/取消用例）。源文件只被读取，从不写入。
- [x] 大文件读写有 backpressure/有界 chunk，原生和 JS 内存不随整份文件大小线性增长；记录实际字节数与代表性峰值。
      —— `SAVE_CHUNK_BYTES` = 1 MiB，逐 slice await；shell 侧拒绝超界 slice。峰值沿用 ticket 04 的实测：
      96 MiB 文件 1 MiB slice 峰值 ~225 MB RSS（整 chunk 跨 IPC 为 ~3.02 GB），本轮未重新测峰值。
      本轮的 packaged 旅程以 1 KiB 文件验证字节一致与取消路径（下述 T16 native driver），
      未重新运行大文件峰值测量。
      —— 2026-10-20 补充：packaged native 旅程已用真实 GTK picker + 真实 IPC 流重跑（debug binary，
      T16 native driver 第 4 段），见下述 Verification。
- [x] 开始传输时固定 connection/host/workspace/file/目标；切换视图不改写目标，连接 dispose/用户取消终止旧请求并清理资源。
      —— 每次 save 捕获 client/routingPath/destination，handle 绑定单个打开的文件；dispose 关闭连接使读取结束并清理
      （`file-save.test.mjs` 的并发与取消用例）。
- [x] 缺文件、离线、拒绝、磁盘失败有可理解结果；不自动重试未知的远端写操作。
      —— 状态映射为 401/403/404/413/5xx 的用户可读原因，且拒绝发生在 open 之前；append/finish 失败直接报错，无重试路径。
- [x] shared Web 上传和 cookie 下载回归通过；更新 workbench/App 保存与大小限制指南。
      —— `pnpm --filter @hepi/ui test` 282 pass（含 `file-seam.test.mjs` 的 cookie 下载地址用例）；
      `docs/workbench.md#native-save-the-apps-own-write-path` 与 `apps/app/README.md#saving-a-file` 已更新。
      2026-10-20 打包段另以 `apps/web/e2e/ux-native-acceptance.mjs` 重跑，见下方表格。

## Delivered

| Layer | Path | What it is |
| --- | --- | --- |
| shared seam | `packages/ui/src/lib/file-save.ts` | `saveFile`（picker → read → 1 MiB slice → await → finish/abort）与 `savePathOf`（browser / native / none 的唯一判定） |
| shared control | `packages/ui/src/components/FileSaveControl.tsx` | viewer 与 explorer 共用的保存控件：cookie 为 anchor，App 为 button |
| host bridge | `packages/ui/src/lib/navigation.ts`, `workbench.tsx` | `WorkbenchHostConfig.save` + `useWorkbenchHostCapabilities()`；Web 不传 |
| App page half | `apps/app/src/save-host.ts` | 五个 `invoke` 命令的唯一调用点；无 shell 时返回 `null` |
| App shell half | `apps/app/src-tauri/src/save.rs` | `app_save_choose/begin/append/finish/abort`，1 MiB 边界、覆盖确认、abort 清理，含 5 条单测 |
| hooks | `packages/ui/src/hooks/useFileBytes.ts` | `useFileSave`：一次一个 save、进度、取消、卸载中止 |

## Evidence and verification

[文件研究 W1](../../ux-closeout-research/03-workbench-files-ssh-terminal.md)。聚焦 reader→save adapter 与 packaged native 旅程；用隔离保存目录、凭证 store；遵循现有 Rust debug/6 jobs/shared cache。记录 command、source SHA、exit、log，测试不写用户已有文件。

### Packaged native journey (2026-10-20)

Driver: `apps/web/e2e/ux-native-acceptance.mjs` — ticket 16 的 native 半部，现持有本票的 save 旅程（第 4 段）。
不新增 driver、不新增 fixture：packaged save 走的是产品自身路径——WebView 内点击 viewer 自己的 Download file 控件，
shell 打开真实 GTK Save file 对话框，由 xdotool 对该 dialog window 输入绝对路径并确认。所有 UI 交互都通过 debug
binary 的 inspector 派发（`WEBKIT_INSPECTOR_HTTP_SERVER`，端口由本 run 抢占），没有任何 test-only save flag。

| Command | Exit | Result |
| --- | --- | --- |
| `node apps/web/e2e/ux-native-acceptance.mjs`（debug binary，`CARGO_TARGET_DIR=/home/developer/Documents/dev/hepi-harness/.dev/cargo-target`） | 0 | 37 checks pass，含 save 段的 GTK dialog 出现、destination 写入、byte-identical sha256、cancel 后无第二文件 |
| `node apps/web/e2e/ux-native-acceptance.mjs`（重跑，无 `--keep`） | 0 | 37 checks pass；isolated credential store 未留残留 |

Source: worktree `closeout-packaging` @ rebased `main` 2b1cdf2；binary 由本 worktree 重新 build
（`cd apps/app/src-tauri && CARGO_TARGET_DIR=… CARGO_BUILD_JOBS=6 CARGO_INCREMENTAL=1 cargo build`，exit 0）。

## Limits this run states

- Debug profile：binary 是 dev-profile，无 release 优化。所有 RSS/时间类数字是功能运行成本，不是发布性能。
- Save 旅程的 payload 为 1 KiB：验证字节一致与取消路径，未重新测量 ticket 04 的大文件峰值。
- 长文件选择走真实 GTK picker；本地文件读取路径（1 MiB chunk streaming）与 ticket 04 的实测共享同一 IPC 边界。
