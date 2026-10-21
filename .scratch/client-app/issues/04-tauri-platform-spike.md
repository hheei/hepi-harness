# 04 — 在桌面和移动目标验证 Tauri 通信及凭证存储

Type: investigation
Status: in-progress (desktop evidenced; mobile withdrawn as a delivery gate by the user's decision of 2026-10-19 — see the mobile row)
Blocked by: [03](./03-gateway-conversation-slice.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

App 用户在实际 WebView 能认证、读取流、保存资源并从后台恢复。

## Scope

用最小壳完成票据 01 选定目标的端到端 spike。验证锁定版本的 WebView fetch、SSE、取消、真实 Origin/CORS/CSP、TLS、跨主机配置、图片、上传与流式/原生保存。验证安全存储的解锁/锁定/进程重启和删除凭证语义。原生 fetch 不满足时才选择明确的替代；核验候选 plugin-http 是否在 IPC 前全量缓冲请求体，按读流与上传分别选择路径。

## Acceptance

- [x] 桌面目标记录设备/OS/WebView、依赖版本、命令和日志；浏览器/模拟数据不能替代实际 native 证据。
- [ ] 移动目标同上。**已撤销为交付门槛**（用户 2026-10-19 决定，不做 Android 构建）：本机无 Android SDK、无 `adb`、无 `sdkmanager`、无设备与模拟器，故无原生证据，本条不勾、不宣称 Android 支持。`tauri android init` 在 `2584b78` 上 exit 1（无 SDK）的历史观测保持原样记录，见下方 table；撤销是范围决定，不是新增通过。桌面半边由票据 16 的综合验收复查：debug 壳在 live release `ad225f8` 上 27 checks / 0 fail，含 admit 后 readiness 行、真实窗口、撤销后 `refused`、自有凭证存储与 native peak RSS。
- [x] SSE 首帧及后续帧增量、取消、断网、后台→前台、进程被杀冷启动各有证据；恢复读取不补发旧写入或重复完成音。
- [x] 证明所选凭证存储可用（Secret Service）；未假定存在官方 keyring。
- [x] 配置地址在实际 CSP/插件 scope/安全策略范围内可用；可连接限制已展示。
- [x] 大文件路径的内存边界与保存能力有证据；桌面产物可首次安装与启动，不建设 updater 或旧版升级路径。

## Verification

原生平台 spike 报告与最小复现；未满足项阻塞共享客户端完成，保留报告而不保留无用实验代码。

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；新增问题依照[review policy](../../../docs/agents/review-policy.md)判断实际影响。

## Report

Revision `40f1312` — `integration/client-app` merged into `impl/client-app-04`. The two native suites below were first
run at `b66c46d` and re-run at `40f1312` after the ticket 06 merge with identical results, so the recorded logs are the
merged-tip run.
Host `workstation`, Linux 6.17.0-23-generic x86_64, WebKitGTK 2.52.3, Tauri crate 2.12.4 / CLI 2.12.3, Rust 1.96.0.

Prerequisites re-verified on this host: `rustc`/`cargo` present, `libwebkit2gtk-4.1-dev 2.52.3` installed,
`pkg-config --modversion webkit2gtk-4.1` → `2.52.3`, `cargo-tauri` absent (CLI installed via `npx @tauri-apps/cli@2.12.3`
for the spike), `Xvfb` present, gnome-keyring running on the session bus. Android: `ANDROID_HOME` and
`ANDROID_SDK_ROOT` empty, `adb` and `sdkmanager` absent, no device — `tauri android init` exits 1.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| desktop fixture suite, 56 assertions | `node harness/run.mjs --skip-build --log-dir=logs/desktop-final` | `40f1312` | 0 | `spike/tauri-platform-04/logs/desktop-final/report.json` |
| live ingress + Backend, 22 assertions | `node harness/ingress.mjs --log-dir=logs/ingress-final` | `40f1312` | 0 | `spike/tauri-platform-04/logs/ingress-final/report.json` |
| `.deb` build + packaged smoke, 11 assertions | `npx @tauri-apps/cli@2 build --bundles deb` then `node harness/package.mjs --log-dir=logs/package-1` | `b66c46d` | 0 | `spike/tauri-platform-04/logs/package-1/report.json` |
| Rust shell build | `cargo build --release --manifest-path src-tauri/Cargo.toml` | `b66c46d` | 0 | `spike/tauri-platform-04/logs/cargo-build.log` |
| Android environment probe | `tauri android init` | `b66c46d` | 1 | `spike/tauri-platform-04/logs/android/tauri-android-init.log` |
| selected checks for the change | `pnpm verify:changed --base=b66c46d` | `81df803` | typecheck, workspace tests, Web unit and script tests 0; `check:entrypoints` 0; `check-docs` 1 (the same 12 pre-existing `.dev`/`.pi` links, none of them this ticket's) | `.dev/verify/2026-10-17T19-32-35-204-verify-changed/verify.json` |
| selected checks after the integration merge | `pnpm verify:changed --base=b66c46d` | `40f1312` | same six steps, same result: only `check-docs` 1 (the same 12 pre-existing links) | `.dev/verify/2026-10-17T19-35-34-110-verify-changed/verify.json` |

### Re-run on `integration/client-app` at `2584b78`

The branch fast-forwarded onto the integration tip `2a41b2e`, so no merge commit was needed. The native suites and the
selected checks were run again on the integrated tree into fresh logs; every assertion name and result matches the
branch run, so only timing and per-run memory figures differ.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Rust shell build | `cargo build --release --manifest-path src-tauri/Cargo.toml` | `2584b78` | 0 | `spike/tauri-platform-04/logs/desktop-integration-2584b78/cargo-build.log` |
| desktop fixture suite, 56 assertions | `node harness/run.mjs --skip-build --log-dir=logs/desktop-integration-2584b78` | `2584b78` | 0 | `spike/tauri-platform-04/logs/desktop-integration-2584b78/report.json` |
| live ingress + Backend, 22 assertions | `node harness/ingress.mjs --log-dir=logs/ingress-integration-2584b78` | `2584b78` | 0 | `spike/tauri-platform-04/logs/ingress-integration-2584b78/report.json` |
| `.deb` build + packaged smoke, 11 assertions | `npx @tauri-apps/cli@2 build --bundles deb` then `node harness/package.mjs --log-dir=logs/package-integration-2584b78` | `2584b78` | 0 | `spike/tauri-platform-04/logs/package-integration-2584b78/report.json` |
| Android environment probe | `npx @tauri-apps/cli@2 android init` | `2584b78` | 1 (no SDK at `/home/developer/Android/Sdk`) | `spike/tauri-platform-04/logs/android-integration-2584b78/tauri-android-init.log` |
| selected checks | `pnpm verify:changed --base=2a41b2e` | `2584b78` | 1 — typecheck, workspace tests, Web unit (148/148) and script tests (51/51) 0; `check:entrypoints` 0; `check-docs` 1 (the same 12 pre-existing links) | `.dev/verify/2026-10-17T19-45-08-693-verify-changed/verify.json` |

### What the desktop target actually did

Runtime identity: the WebView reports `Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 … Safari/605.1.15`
(WebKit, not Chromium), and the page's own origin is `tauri://localhost` with protocol `tauri:`.

Transport, measured inside that WebView:

| Behaviour | Observation |
| --- | --- |
| Basic fetch | 200 from the fixture origin |
| SSE incremental | 5 frames arriving at 203/402/603/802/1002 ms — delivered as they were written, not at end of body |
| Caller cancellation | the server recorded the stream aborted after 3 of 50 frames, i.e. the cancel reached it |
| Abrupt server drop | the reader **ended cleanly** with no exception after 2 frames and no terminal event; truncation must be detected by the protocol |
| Submission idempotency | the same `requestId` sent twice left exactly one server-side record |
| Declared second origin | answered across ports inside the built CSP |
| Origin outside the CSP | `TypeError: Load failed` before the request left the WebView; the server never saw it |
| Large download | 96 MiB read incrementally and written to disk in 3 WebView chunks (16.1 MB, 10.6 MB, 73.8 MB) |
| Native save | 100 663 296 bytes on disk, sha256 `9dc4c69ee63eaa6d3063cf2fcee5c5cf2f7efbdf645744093ec09e030df470a4` |
| Streamed upload body | `NotSupportedError: ReadableStream uploading is not supported` |
| `Blob` upload body | 48 MiB accepted by the server |
| Memory: read only, no IPC | 14 chunks, peak RSS 158 MB, no growth |
| Memory: whole WebView chunk to IPC | 3 chunks, peak RSS **3.06 GB** |
| Memory: 1 MiB slices to IPC | 3 chunks, same 96 MiB saved, peak RSS **225 MB** |
| Process killed mid-stream | SIGKILL while attached; the server observed the disconnect 2 s after attach, not a graceful close |
| Credential store | set → read back → delete → read-after-delete all correct in-process; a **separate process** read the value written by an earlier one, then deleted it |

The live phase ran the same WebView against the real ticket 03/07 client ingress in front of a real Backend, holding a
device bearer the Backend issued for that run: `/api/descriptor`, conversation create, submit, and the Backend's own SSE
arrived as `snapshot` → `submission` → `state`, and the settled transcript read back as
`["hello from the WebView", "Server reply to: hello from the WebView"]`. The ticket-07 deferred history block was named
as `/api/sessions/7/entries/13/text?blockIndex=0` and served on that same origin, 98 328 bytes, not truncated. The
ingress log shows every request arriving with `origin=tauri://localhost` and a device bearer, and no `/v1` route on the
client listener.

### Platform constraints this establishes

1. **Every gateway address is cross-origin.** The page origin is the Tauri custom protocol, so an App must declare its
   gateway origins to the ingress (`HEPI_APP_ORIGINS`) and must build a CSP naming them. A gateway at an unlisted origin
   is unreachable — the WebView refuses it before the request exists.
2. **A dropped stream is not an error.** Recovery cannot rely on a thrown exception; the client needs the protocol's
   terminal event and its own resync, which is what the existing `resync_required` path already provides.
3. **Uploads cannot stream from the WebView.** `ReadableStream` request bodies are rejected outright, so the upload path
   is a bounded `Blob` body with the existing size limits, not a streamed body.
4. **Downloads must be sliced before IPC.** Reading is incremental and fine; crossing IPC with the WebView's own
   multi-tens-of-MB chunk is what costs gigabytes. The bound belongs at the IPC boundary, not in the read loop.
5. **`plugin-http` was not needed and not adopted.** Native `fetch` satisfied the read/SSE path, so the G10 question of
   whether it buffers request bodies before IPC did not arise; the measured limitation is in the WebView's own upload
   support, not in a plugin.

### Remaining blockers

- **Android is blocked, not passed.** No SDK, no `adb`, no device or emulator on this host; `tauri android init` exits 1.
  The ticket's mobile half stays open, and the spec continues to claim no Android support.
- **No system `dpkg -i` install.** Installing needs root, which this session does not have. What was verified is the
  package's real contents and its packaged binary running from that installed layout. A first system install remains to
  be done where root is available.
- **Background→foreground is window hide/restore**, not a real OS-level app suspension. It shows the WebView refetches
  after being hidden, but it is not the same event as a mobile background transition.

## Handover to ticket 08 (file paths)

The measurements above are the constraints the file workbench inherits. They are recorded here so ticket 08 does not
re-derive them, and none of them is an implementation choice ticket 04 makes:

- **`tauri://localhost` is the App origin.** Every gateway origin is therefore cross-origin: it must be listed in
  `HEPI_APP_ORIGINS` for the ingress **and** named in the built CSP, or the WebView refuses the request before it exists.
- **WebKitGTK rejects `ReadableStream` upload bodies.** The upload path is a bounded `Blob`/`ArrayBuffer` body under the
  existing limits; a 48 MiB `Blob` was accepted and no streamed body was ever seen by the server.
- **A large download must be sliced to ≤1 MiB before IPC.** The read itself is incremental and bounded (14 chunks,
  158 MB peak for 96 MiB), but handing the WebView's own 69–73 MB chunk to the native save peaked at ~3.02 GB RSS; 1 MiB
  slices saved the same bytes at ~224 MB.
- **An abrupt stream drop ends cleanly.** The reader stops with no exception and no terminal event, so the file path must
  recover through `resync_required` and the lifecycle facts, never by catching a throw.

## Review notes

涉及 G2/G7/G8/G9/G10，见[架构审查](../review-notes.md)。其中 record 项不形成额外依赖。完成本票即更新能力矩阵与本票状态；全部 Blocked by 关闭后才开始。

G10 closure: the concern was that `plugin-http` buffers request bodies across IPC before sending. That plugin is not
adopted — native `fetch` covers read and SSE, and the WebView rejects streamed request bodies itself — so the specific
plugin concern is moot while the underlying rule (never assume a streaming upload; bound what crosses IPC) is now
evidenced. See [review notes](../review-notes.md) for the recorded disposition.
