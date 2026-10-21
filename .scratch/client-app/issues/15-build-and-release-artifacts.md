# 15 — 产出静态 Web 与首发 App 包

Type: implementation
Status: resolved for the supported targets (desktop packaged at `e537a95`/`758dcf0`; the traceable client-runtime
release built and journey-tested by ticket 16 at `bdc8746`/`9aa4326`; the system-`dpkg -i` limit closed by 16's real
namespace transaction, 44/44 assertions). **Android stays withdrawn as a delivery gate** by the user's decision of
2026-10-19 — see the mobile note; no mobile artifact exists and the absence is recorded as an absence.
Blocked by: [05](./05-shared-ui-routing-and-scope.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

在约定目标重建、安装和运行当前客户端产物。

## Scope

完成 Web/App production 构建、共享资产/CSS、Tauri 打包和配置注入。记录当前 UI/Gateway/Backend revision 与构建信息；以直接安装/部署满足私人项目使用，不建设 updater、旧版支持矩阵或商店升级流程。

## Acceptance

- [x] 静态 Web 与桌面产物可从干净 checkout/workstation 构建并启动：clean tree 上 `build-artifacts.mjs --reproduce`
      exit 0，`verify-artifacts.mjs` 33/33（包内容、依赖解析、无连接冷启动、有连接冷启动、首次使用表单、forget 后重启）。
      **未勾选的部分**：系统 `dpkg -i` 安装需要 root，本会话没有，验证用包的真实安装布局解包并执行（报告记
      `systemInstall: false`）；**移动产物不存在**，Android 无 SDK/adb/设备，见下。
- [x] App 内嵌静态 UI，无 Next server/Node agent runtime/内部 token，revision、架构、工具链和日志齐全：二进制内无四个内部
      token 名与 `next/dist/compiled`，bundle 边界测试在真实模块图上断言，二进制自报 client/shell revision，
      `provenance.json` 记录宿主、架构、工具链与每步日志。
- [x] Gateway 地址配置符合实测安全策略，首次使用凭证存储正常：配置 origin 在窗口创建前进 CSP，越界地址由 WebView 拒绝；
      Secret Service 跨进程读写，首次使用表单经真实窗口（xdotool）提交后 fixture Gateway 收到带 bearer 的 descriptor 请求。
- [ ] 当前整套产物协同运行；remote-host 只接收预构建 linux/arm64，不在远端编译。**部分完成**：Web/App 产物已产出且 App
      可与 fixture client ingress 协同；与真实 Gateway/Backend 的整套协同与入口切换属票据 16。remote-host 约束遵守（本票
      未在远端编译，也未产出 arm64 产物：本机目标为 x86_64）。

## Verification

production bundle 检查与原生首次安装/冷启动烟测；记录产物校验值和构建日志。记录首屏加载的 JS/CSS 与重面板依赖；仅在证据支持时按需加载，不因迁框架先重写渲染结构。

## Report

实现于 `impl/client-app-15`（base `integration/client-app` `34e99da`，先快进合并再编码）。代码 revision
`2573147f03702d81e207562b8b7346821f8eb2e1`（clean tree），产物、provenance 与全部断言都在该 revision 上跑；本记录所在的
docs 提交在其上，不改代码。宿主 `workstation`，Linux 6.17.0-23-generic x86_64，WebKitGTK 2.52.3，Tauri crate 2.12.4 /
CLI 2.12.3，Rust 1.96.0，Node 26.5.1，pnpm 12.4.1。

### 现在可用的行为

**App 是真壳，不是带注入全局的 Vite 包。** `apps/app/src-tauri` 读取本机凭证存储（Secret Service）里的
profile、Gateway origin 与 device bearer，在**窗口存在之前**把配置的 origin 写进窗口 CSP，并在 document start 注入
`globalThis.__HEPI_CONNECTION__`。首次运行没有连接，页面渲染配置面；`app_configure` 存入后重启进程（CSP 只能在窗口
创建前决定，运行中的文档换不了策略），`app_forget` 删除后同样重启。同两条操作有无显示器都可执行，且 bearer 走 stdin
不进进程表：`hepi-app --configure` / `hepi-app --forget`。

**构建与验证各一条命令。** `node apps/app/scripts/build-artifacts.mjs --reproduce` 构建 UI、静态 Web 与 `.deb`，把
client/shell revision 打进二进制，写出 `checksums.sha256`、`provenance.json`（revision、dirty、宿主、目标架构、工具链、
各产物 sha256、每步 exit code 与日志路径）与 `logs/`。`node apps/app/scripts/verify-artifacts.mjs` 只针对产物运行：包内容/
架构/依赖、`ldd` 依赖解析、二进制与 bundle 无内部凭证与 Node/Next 运行时、无连接冷启动、有连接冷启动（fixture Gateway
收到 `Origin: tauri://localhost` 且带存储的 bearer 的 `/api/descriptor`）、用 `xdotool` 在真实窗口里走首次使用表单、
forget 后回到未配置。行为与命令见 [apps/app README](../../../apps/app/README.md)。

### 命令与结果

| 检查 | 命令 | revision | exit | log |
| --- | --- | --- | --- | --- |
| 构建 + provenance + 复现测量 | `node apps/app/scripts/build-artifacts.mjs --label=t15-clean --reproduce` | `2573147` | 0 | `.dev/artifacts/t15-clean/provenance.json` |
| 产物测试，33 断言 | `node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/t15-clean` | `2573147` | 0 | `.dev/artifacts/t15-clean/verify-2026-10-18T02-00-24-869Z/report.json` |
| Rust 壳单测（4） | `cargo test --manifest-path apps/app/src-tauri/Cargo.toml` | `2573147` | 0 | 终端输出；`cargo test: 4 passed` |
| App 单测（5：bundle 边界 2、宿主配置 1、IPC 契约 2） | `pnpm --filter @hepi/app test` | `2573147` | 0 | `.dev/verify/2026-10-18T02-02-47-833-verify-changed/workspace-tests.log` |
| 选定检查 | `pnpm verify:changed --base=integration/client-app` | `2573147` | 1 | `.dev/verify/2026-10-18T02-02-47-833-verify-changed/verify.json` |

`verify:changed`：workspace-typecheck、workspace-tests（含 App 5 项与 gateway 325 项）、web-unit（46）、script-tests
（51）、check-entrypoints 全部 exit 0；`check-docs` exit 1，12 条断链**全部**是 git-ignored `.dev`/`.pi` 目标的既有残留
（`grep '^BROKEN' check-docs.log | grep -v '\.dev/\|\.pi/'` 为空），与本票无关。lockfile 属 fallback file，选择器因此跑
full 档的静态检查（typecheck + 全 workspace test + web unit）。

### 产物与 provenance

| 产物 | 大小 | sha256 |
| --- | --- | --- |
| `Hepi_0.1.0_amd64.deb` | 3 612 760 B | `1c038ff42cf0b12580da51e44f6ed175f5ce42355492dd4b0c16e253bdd542e4` |
| `hepi-app`（包内 `usr/bin/hepi-app`） | 7 448 680 B | `dc4f2c6693473163303a1ab9c1b5081ead9ebb427bc89d3dccc0c8c2c7a4c48f` |
| 静态 Web `web/` | 每文件 sha256 | `checksums.sha256` |

包内：`usr/bin/hepi-app`、`usr/share/applications/Hepi.desktop`、`usr/share/icons/hicolor/512x512/apps/hepi-app.png`；
`Architecture: amd64`；`Depends: libwebkit2gtk-4.1-0, libgtk-3-0`。二进制无 `HEPI_AUTH_TOKEN` /
`HEPI_INGRESS_SERVICE_TOKEN` / `HEPI_WEB_LOGIN_TOKEN` / `serviceToken` 与 `next/dist/compiled`。

**复现性（测量，不是声明）**：同一 revision 连建两次，可执行文件字节相同（两次 sha256 均为
`dc4f2c66…a4c48f`）；`.deb` 不同（`1c038ff4…` vs `fb2e13bb…`）——Tauri bundler 把打包时刻写进成员 mtime 且不读
`SOURCE_DATE_EPOCH`，解包后 payload 逐文件相同。两项比较都写进 `provenance.json`。

**首屏与重面板**：App 首屏 JS `index-h9CM_2Xp.js` 3 226 272 B、CSS `index-rMlpbYVA.css` 122 845 B；mermaid/cytoscape
渲染（`chunk-FOHPRMQF…` 662 087 B、`cytoscape.esm…` 434 616 B）本来就是独立动态 chunk，不进首屏。本票只记录，不改渲染结构。

### 保留的实测约束

`tauri://localhost` 为页面 origin、配置 origin 必须同时进 ingress 的 `HEPI_APP_ORIGINS` 与窗口 CSP（本票在窗口创建前写入）；
SSE 断流按协议恢复而非异常；上传是受限 `Blob` body；下载跨 IPC 必须 ≤1 MiB 分片（文件路径归票据 08，本票不新增下载路径）；
凭证存储为 OS Secret Service。Android 仍为阻塞项：本机无 SDK、无 `adb`、无 `sdkmanager`、无设备，不启动无人值守的 SDK 安装。


### 合并 integration 后的重跑（`bbe8baf`，integration tip `8c5dfb4`）

票据 09/14 已并入 integration，本票合并后再跑一次产物与选定检查；断言名与结果一致，只有校验值与首屏体积随共享 UI 变化。
integration 随后又前进到 `7d910e0`（票据 13 的 MCP 代码与文档），再次合并（`261e0aa`）后第三次重跑，33 断言仍全过、
可执行文件仍两次构建字节相同（sha256 `7f69c164…2701d`，`Hepi_0.1.0_amd64.deb` `d5d40739…49b01`，3 615 738 B），
`verify:changed --base=integration/client-app`（merge-base `e257e3d`）五个步骤 0、`check-docs` 1 且同样只有那 12 条既有断链。
产物目录 `.dev/artifacts/t15-merged2`，日志 `.dev/verify/2026-10-18T02-28-17-435-verify-changed`。

| 检查 | 命令 | revision | exit | log |
| --- | --- | --- | --- | --- |
| 构建 + provenance + 复现 | `node apps/app/scripts/build-artifacts.mjs --label=t15-merged --reproduce` | `bbe8baf` | 0 | `.dev/artifacts/t15-merged/provenance.json` |
| 产物测试，33 断言 | `node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/t15-merged` | `bbe8baf` | 0 | `.dev/artifacts/t15-merged/verify-2026-10-18T02-17-18-760Z/report.json` |
| Rust 壳单测（4）/ App 单测（5） | `cargo test`；`node --test apps/app/test/*.test.mjs` | `bbe8baf` | 0 | 终端输出 |
| 选定检查 | `pnpm verify:changed --base=integration/client-app`（merge-base `8c5dfb4`） | `bbe8baf` | 1 — typecheck / workspace tests / web-unit 49 / script-tests 51 / check-entrypoints 全 0；`check-docs` 1（同样 12 条既有 `.dev`、`.pi` 断链，指向本票文件的 0 条） | `.dev/verify/2026-10-18T02-17-43-071-verify-changed/verify.json` |

`Hepi_0.1.0_amd64.deb` 3 616 328 B sha256 `7a6392e176f12a5b02ec6949d669e11dfc39faa01d5e8a65cf8a16e046642d16`；`hepi-app` 7 452 008 B
sha256 `a36ce451073b77afea5c36905888e97e7d2ecb6afad1d8c14f3308c17ad3956e`（两次构建字节相同）。首屏 JS 3 240 570 B、CSS
122 845 B，重面板 chunk 不变。

### 未做/留给后续

- **不做系统 `dpkg -i` 安装**：需要 root，本会话没有。验证走包的真实安装布局解包 + 从该布局执行，报告显式写明
  `systemInstall: false`。**后续（`bdc8746`，票据 16）关掉的是本条的较弱部分**：主机不给 root，但给非特权 user namespace，
  所以包现在以一个可丢弃 root 的根身份跑**真实 dpkg 事务**（`apps/app/scripts/offline-install.mjs`），断言到 `dpkg -V`
  与「主机自身 dpkg 库从未出现包名」，并从该布局执行；对真实主机的系统安装仍未做，报告仍是 `systemInstall: false`。证据：
  [16](./16-integration-and-direct-cutover.md#artifact-journeys-on-the-published-release-2026-10-19--bdc8746)。
- **移动产物不存在**：Android 无 SDK/adb/设备，本票不构建、不安装、不声明任何移动产物。**2026-10-19 用户决定不再做 Android 构建，该目标已从交付门槛撤销**：不可用性是如实记录的缺测（历史上就无任何 Android 证据），不是通过项，也不是待修复的阻塞项。桌面半边在票据 16 的 live-release 综合验收里继续成立。
- **不建 updater / 升级矩阵**：`tauri.conf.json` 无 updater 插件，产物只覆盖当前版本。
- **不做入口切换**：静态 Web 与 App 产物已产出，部署与 `/api` fallback 属票据 16；本票没有启动或停止任何服务。
- **spike 代码未删**：`spike/tauri-platform-04/` 仍是票据 04 报告的可复现证据，其删除随票据 17 处理，本票不动。

## Closeout on the live release (2026-10-19, recorded by ticket 16)

The `.deb` half of this ticket re-ran at the live release: `build-artifacts.mjs --label=c16-final-deb --profile=debug --skip-web`
(0, `.deb` 60.6 MB, binary stamped `88011fee…`, `dirty: false`, `production: false`) and `verify-artifacts.mjs` from the
artifact's own commit, **44 assertions, 0 failures**, with the four dpkg-transaction assertions included. One defect was
found by running that and fixed at its owner: the transaction namespace inherited the caller's `PATH`, which in an
interactive shell has no `/usr/sbin`, so `ldconfig` / `start-stop-daemon` did not resolve and dpkg aborted with
`dpkg: error: 2 expected programs not found in PATH or not executable`; `offline-install.mjs` now gives the namespace
root's `PATH` and `offline-install.test.mjs` asserts it. Report and reproduction:
[16-integration-and-direct-cutover.md](16-integration-and-direct-cutover.md#concrete-closeout-on-the-live-release-2026-10-19--ad225f8).

## Review notes

见[审查记录](../review-notes.md) G7/G8。发布只覆盖当前版本。

## Verification practice

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；发现依照[review policy](../../../docs/agents/review-policy.md)按实际影响处理。
