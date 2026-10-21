# 16 — 完整双端验收与直接切换

Type: implementation
Status: **concrete closeout done at the live release `ad225f8` (2026-10-19)** — the journeys below now run against the
published immutable release **and** against the deployed origin, which is what this ticket's open half asked for; the
remaining rows are the named limits at the end of
[Concrete closeout on the live release](#concrete-closeout-on-the-live-release-2026-10-19--ad225f8), not un-run acceptance.
Android is **withdrawn as a delivery gate** by the user's decision of 2026-10-19 (nothing is built for it, and its
historical absence is recorded as an absence, never as a pass).

**Dated record note (2026-10-20).** Every "12 pre-existing broken links" / `check-docs` exit 1 row below is what
`node scripts/check-docs.mjs` printed **at that ticket's own revision**: those links pointed at git-ignored local
evidence (`.dev/verify/...`) and at a local `.pi/` skill install, so they existed only on a workstation. The scratch
trees have since converted those hyperlinks to plain local-path text, and at the current documentation revision the check
reports **0 broken relative links over 432 Markdown files, exit 0**. The rows stay as the exact test revision they
measured; they are not the current baseline. The earlier four slices stay as delivered: the static Web
entry, the runtime packaging, and the
**acceptance driver** and **acceptance harness and readiness** slices below, all now on `integration/client-app`: the two
acceptance slices were merged as `84b7039058b1d44aebbb416411d167a51a37f503` (source `2c6f801`, reviewed tip `a658539`; see
[the merge record](../../../docs/verification.md#client-app-integration-ticket-16-acceptance-batch--credential-sandbox-and-native-readiness-2026-10-19)). Separately, the **Web-origin
cutover ran on 2026-10-18 at `1873d24`** (`hepi-ingress.service` now holds the tailnet Web origin, `hepi-web.service` is
stopped and disabled, and the Backend image and gateway bundle moved to the same revision, with read-only smoke
evidence: [the cutover record](../../../docs/records/1873d24-deployment.md)). That cutover was not performed by this ticket, but it
closes the deployment-evidence gap below and the「旧服务停止」half of the last acceptance box. That revision was superseded
on 2026-10-19 by `ad225f8`, and the journeys **were** then driven on that release's exact bytes; see
[Concrete closeout on the live release](#concrete-closeout-on-the-live-release-2026-10-19--ad225f8).

The **static Web entry** is merged into `integration/client-app` at `b492e9c` (`bd89c14` + `f36a7e1`): the ingress
listener serves the Vite build on its own origin under `HEPI_INGRESS_STATIC_DIR`, confined to the configured root, with
hashed assets immutable and everything else revalidated.

The **runtime packaging** slice is merged too, at `6b33b3f` (`impl/client-app-16-runtime` `237edc9`, reviewed at
`94526e2` with the code unchanged through the tip): `node scripts/build-client-runtime.mjs` builds one immutable
release — the ingress bundle, the execution gateway's packed tarball, the static Web build and the Backend image — with
`SHA256SUMS` and a provenance record; `node scripts/ingress-unit.mjs` renders the unit and the env template from one
table of variable names and roles, so no secret has anywhere to be written down; `deploy:plan` names the release as the
artifact a Web cutover switches. The App's Rust build now shares one `CARGO_TARGET_DIR` across worktrees with six jobs
and incremental compilation, and `build-artifacts.mjs` selects and records its profile (debug by default, never
labelled production).

The **acceptance driver slice** (this branch) runs both production hosts against one real system and found two defects
that made a first open unusable; see the Report below. It is browser plus debug-native functional evidence, not a
cutover and not release performance. Its driver-host fallback for the static page is now removed: the driver refuses to
run unless the ingress serves the shell itself, because a page served by a stand-in host is not evidence about the entry
a cutover switches.

The **acceptance harness and readiness slice** (this branch, after the driver slice) fixes two things the drivers could
only expose by running: an acceptance run that wrote the **developer's own** credential store, and a native shell that
reported a workbench before its connection had been admitted. See "Fixed because this acceptance found them" items 3 and
4 and the 2026-10-19 rows of Checks run.

The packaged release was built and driven on the workstation against a real Backend image on throwaway state: page, SPA
fallback, cache policy, `/api` distinction, login, device bearer, revocation, ingress→gateway MCP and restart
durability — at `0746d7a`, `f50df75` and `94526e2`, not at a later revision. **The cutover happened on 2026-10-18** at a
revision built later than all three: the Web origin is `release-1873d24/ingress.mjs`, the deployed Backend is
`hepi-backend:1873d24-workstation` and the gateway bundle is `release-1873d24`, so the live artifact is now described by
[this record](../../../docs/records/1873d24-deployment.md) rather than by `release-1062840`. **Android/mobile is withdrawn as a
delivery gate by the user's decision of 2026-10-19**: no Android artifact is built, none will be, and the historical fact is
recorded as what it is — this host has no Android SDK (`~/Android/Sdk` exists but has no `platforms` and no `build-tools`),
no `adb`, no `sdkmanager`, no device and no emulator, no provisioning was attempted unattended, and 09's bearer path has no
native-shell evidence on a mobile target. That absence is an absence: it is not a pass, and no row below is closed by it.
[Artifact journeys on the published release](#artifact-journeys-on-the-published-release-2026-10-19--bdc8746) closes the
gap that ticket 15 left as a limit rather than a host: the acceptance stack now runs against the immutable release
directory itself, and 15's package goes through a **real `dpkg` transaction** as root of a throwaway tree — the host grants
no root for `dpkg -i`, but it does grant unprivileged user namespaces, so nothing about the live deployment or the
developer's keyring is assumed or touched.
**The 2026-10-19 observation above was about `1873d24` and is now historical:** that build predates the Web login gate
(`41fabf3`) and the readiness fix (`2c6f801`), so a cold browser there got `body: "unauthorized"` with `/api/descriptor`
401 and no path to authenticate (read-only, no credentials used: `.dev/verify/c16-closeout/live-entrance-observation.json`,
desktop 1440×900 and mobile 390×844, zero page errors; its `index.html` was the same 1 860 B but referenced
`assets/index-oh_ZJ82Q.js` against the release's `assets/index-CI2q_or9.js`, so that origin was not a stand-in for this
artifact). The live origin is now `release-ad225f8` — the same bytes this closeout drives — and the entry, login and
scroll journeys pass there; the record below states exactly what ran and what did not.
Blocked by: [06](./06-catalogue-projects-and-worktrees.md), [07](./07-history-and-authenticated-resources.md), [08](./08-files-and-workbench-streaming.md), [09](./09-terminal-fan-in.md), [10](./10-conversation-controls-and-relations.md), [11](./11-models-providers-and-extensions.md), [12](./12-execution-side-resources.md), [13](./13-mcp-and-project-trust.md), [14](./14-web-pwa-and-notifications.md), [15](./15-build-and-release-artifacts.md)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

Web/App 的目标能力在新入口通过验收，停止旧服务并直接使用新方案。

## Scope

以新状态验证 production Web 与约定桌面/移动目标。配置静态 Web fallback、/api、TLS/CORS/代理和服务启动；停止旧 Next 服务，一次切换到当前整套产物。不安排旧用户、旧数据、旧版本兼容或回滚演练。

## Acceptance

- [ ] 规格 Acceptance 与目标能力清单全部有证据；Web 创建→App 提交→丢响应→原 requestId 查询只提交一次，新写入状态重启可恢复。
      **只剩一个具名缺口**（2026-10-19 复核，见 [Concrete closeout on the live release](#concrete-closeout-on-the-live-release-2026-10-19--ad225f8)）：
      跨客户端读取/提交、丢响应单次提交、requestId 查询、重启恢复、作用域、撤销、资源、终端 fan-in 与 MCP 路由都有
      发布产物上的 driver 证据；多宿主路由现在有票据 09 suite 的**当场重跑**（4 pass）与 `ux-ssh-project` 的**真实 sshd**
      两 profile 路由（31 checks），二者都在 tip 复验。**Android 不再是本条的理由**：用户 2026-10-19 决定不构建 Android，
      它作为交付门槛撤销，历史缺测仍如实记为缺测（见下 limits）。本条不成立的唯一剩余理由：两个 suite 的第二宿主都是
      同一台机器上的 loopback sshd，**没有第二台物理主机**可测，规格那句「入口 Gateway 不等于 execution Gateway 时仍命中
      正确宿主」因此只有同机两宿主证据。
- [ ] 当前 Web/App/Gateway/Backend 认证、资源、终端和多宿主路由正常；撤销期限可观测。**认证/资源/终端/MCP/撤销有证据**：无
      cookie、未知 bearer、内部 /v1、服务凭证各自被拒；撤销观测到拒绝（`HEPI_REVOCATION_CHECK_MS=400`；产物上本次 131 ms、
      前次 205 ms、历史 448/512/534 ms — 契约是间隔不是数值），Backend 记录含 `revokedAt`；资源读取、terminal fan-in 与
      `/api/mcp` 读写在发布产物上重跑，并在部署 origin 上以只读 HTTP smoke 复验同一入口行为（缓存策略、SPA fallback、
      404、`/api` 401、内部 `/v1` 404）。**仍未勾的唯一理由**与上一条同：多宿主证据的第二宿主是 loopback sshd，非第二台物理主机。
- [x] 新 Web 首次安装/offline/API cache 与 App 冷启动通过。**App 冷启动**（debug 壳：无连接→配置面且不断言任何连接，有连接→
      workbench 且只在 ingress 实际 admit 后才报出 backend/scope/client，真实窗口）在发布的 immutable release 上重跑
      **27 checks / 0 fail**（新增 native peak RSS 项）。Web 安装/offline/API cache 由 `ux-pwa-offline` 覆盖，在本次 tip
      重跑 **24 checks / 0 fail**；gated 首次打开由本票修复并验证。**部署 origin 现在有直接证据**，这是本条此前唯一未勾的理由：
      `release-ad225f8` 即线上 `hepi-ingress.service` 正在服务的目录（`SOURCE_COMMIT` = `ad225f89…`，`SHA256SUMS` 177 条本机
      重验 exit 0，线上 `web/` 与本次 `apps/web/dist` 逐字节相同），冷浏览器入口在 1280×800 与 390×844 都渲染登入面、
      `POST /api/web-login` 返回 200 且表单消失，既有长会话在部署 origin 上 `overflow-y: auto` 且 scrollTop 与真实滚轮均可用
      （`.dev/verify/login-live.log`、`.dev/verify/scroll-parent-wheel.log`，父会话记录
      `.dev/deploy/login-layout/result.json`）。**该 origin 的只读入口 smoke 见**
      `.dev/verify/c16-final/live-entry-smoke-ad225f8.log`。offline 路径本身仍在本机同字节产物上证明——切断 tailnet 不是
      本票可做的动作，也不是产物差异。
- [ ] production 构建在固定设备/会话窗口/帧负载/文件大小下记录冷暖状态、重复次数、请求/连接数、首个可见内容、帧处理/React commit、JS/native 峰值内存；按[审查 P1–P5](../review-notes.md)区分明确冗余与待测候选。必要旧实现对照只做一次，不维护旧版矩阵；测量不自动扩展为 UDS、bypass 或新状态框架。
      **现在全部有记录**（2026-10-19 在发布产物上）：请求数 83 Web / 35 App，冷首次可见 212 ms 与暖 176 ms（同一 origin 两次文档），
      脚本字节 3 306 577 / 3 309 647，**React commit 计数**（登入面 2 → 目录就绪 18；重载文档 shell 21；一条流式回答 17；暖文档总计 51）、
      **帧/主线程 long task**（`longtask` observer：1 个 77 ms，回答流内 0 个）、**JS 堆 30 MB**、进程峰值 RSS
      （backend 214 MB / gateway 82 MB / ingress 90 MB，容器自报）、**native 峰值 RSS**（三个壳进程 VmHWM 155/160/155 MB），
      撤销延迟 131 ms（间隔 400 ms 是契约）。帧处理与 React commit 此前记为「未测」，现由 driver 从页面自身读取。
      仍未满足本条的部分，且是用户 2026-10-19 明确决定的：native 只有 **debug** 产物（不做昂贵 release 优化），所以不产出
      release 性能结论；固定设备/窗口/帧负载/文件大小的矩阵是本机的代表值，不是 production 基准。
- [x] 新入口已核验，旧服务停止，操作指南记录实际部署 revision 与运行结果 — [the 1873d24 record](../../../docs/records/1873d24-deployment.md) plus the [live release closeout](#concrete-closeout-on-the-live-release-2026-10-19--ad225f8) (2026-10-19). 本轮切换操作（部署 `release-ad225f8` 的那次窗口）不是本票执行的：本票未启动、停止、重启或写入任何服务，只读并校验了线上目录。浏览器登录 journey 与滚动回放**已在部署 origin 上跑过**（1280×800 与 390×844，登入 200、表单消失、滚动与滚轮可用）。

## Concrete closeout on the live release (2026-10-19 — `ad225f8`)

**What the live origin actually is.** The deployed Web origin is
`/home/developer/.local/share/hepi/client/release-ad225f8` (`hepi-ingress.service`'s own `ExecStart` and
`WorkingDirectory`, `HEPI_INGRESS_STATIC_DIR=…/release-ad225f8/web`), whose `SOURCE_COMMIT` is
`ad225f89b945f8d9e381ed98a6a71821dbd88237`; `hepi-backend:ad225f8-workstation`
(`sha256:e7281d46…44c2`, amd64) and the release's installed gateway bundle run beside it, all three units
`active` (parent's deployment record:
`/home/developer/Documents/dev/hepi-harness/.dev/worktrees/client-app-integration/.dev/deploy/login-layout/result.json`).
The release build, its promoted copy and this checkout's `apps/web/dist` were compared, not assumed: `SHA256SUMS`
177 entries verify exit 0 **inside the promoted directory**, `ingress.mjs`, the gateway tarball, `provenance.json` and
`SOURCE_COMMIT` are byte-identical between build and live directory, and `diff -rq` of the live `web/` against the release's
and against this run's `apps/web/dist` is empty. So a journey driven with
`--release=…/release-ad225f8` runs on **the same bytes the deployment serves**, and the earlier
「no journey ran against the deployed origin, and none could」statement is superseded: it was true of the
pre-login-gate `1873d24`, not of what runs now.

**Journeys and checks, each at the revision its own log states (`7f743e1` client, `a70c78d` native; tree clean at both — the Web inputs are unchanged since `ad225f8`,
verified with `git diff --name-only ad225f8..HEAD -- apps/web/src apps/web/index.html apps/web/vite.config.ts packages/ui/src apps/app/src`).**
Raw logs under `.dev/verify/c16-final/`. The directory passed as `--release` is the build worktree's
`/home/developer/Documents/dev/hepi-harness/.dev/worktrees/client-app-integration/.dev/releases/release-ad225f8` — the source of
the promoted copy above, byte-identical to it — so `--release` and the live origin are the same artifact, not two builds.

| Command | Revision the run states | Exit | Result |
| --- | --- | --- | --- |
| `node apps/web/e2e/ux-client-acceptance.mjs --release=.dev/releases/release-ad225f8` | `Provenance: source … (clean)` + the three identity assertions (ingress argv is the release bundle, gateway argv is the release's installed tarball, served `index.html` equals the release's byte for byte) | 0 | **61 checks, 0 failures** (`client-release-clean.log`, which states `source 7f743e1… (clean)`: the driver's own provenance line); the 6 new checks are the render-cost items below |
| `node apps/web/e2e/ux-native-acceptance.mjs --release=<same> --binary=.dev/artifacts/c16-final-deb/hepi-app` | shell reports `shell_revision 88011fee…`; `HEPI_APP_BUILD` read from the binary, not from the checkout | 0 | **27 checks, 0 failures** (`native-release-peak.log`): admitted line names `backend=hepi-backend scope=default client=device:…`, the revoked-bearer restart reports `refused` with no admitted line, the run's store starts empty and every shell process got that bus (`/run/user/1000/bus` used by none), login keyring `0ced02df2ba9…` unchanged, **native peak RSS recorded** for the three shell runs |
| `node apps/app/scripts/build-artifacts.mjs --label=c16-final-deb --profile=debug --skip-web` | debug, shared `CARGO_TARGET_DIR=/home/developer/Documents/dev/hepi-harness/.dev/cargo-target`, `CARGO_BUILD_JOBS=6`, `CARGO_INCREMENTAL=1`, `dirty: false`, `production: false` | 0 | `.deb` (60.6 MB) + binary stamped `88011fee…` (`build-artifacts-tip2.log`) |
| `node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/c16-final-deb --log-dir=.dev/verify/c16-final/artifacts-88011fe/run` | `provenance-names-the-built-revision`: `88011fee… (HEAD 88011fee…)` — run from the artifact's own commit | 0 | **44 assertions, 0 failures** (`verify-artifacts-tip2.log`), the four dpkg-transaction assertions included — see the defect below |
| `node --test apps/app/test/offline-install.test.mjs` | same | 0 | **6 pass**, including the two real transactions and the new `PATH` assertion |
| `node apps/web/e2e/ux-pwa-offline.mjs` | reads this checkout's `apps/web/dist`, byte-identical to the live `web/` | 0 | **24 checks, 0 failures** |
| `node apps/web/e2e/ux-chat-scroll.mjs` | the production stylesheet + the real page on the ingress | 0 | **15 checks, 0 failures** — the P1–P5 scrolling regression at the seam that broke |
| `node apps/web/e2e/ux-ssh-project.mjs` | real `sshd` fixture, two configured profiles, page built by `apps/web/dist` | 0 | **31 checks, 0 failures** — the remote-host routing and restart rows |
| `node --test packages/gateway/test/ingress-terminal.test.ts` | two hosts (one local, one SSH-composed) merged by the Backend on one stream | 0 | **4 pass** |
| `node apps/web/e2e/ux-panel-ingress.mjs`, `node apps/web/e2e/ux-capability-trust.mjs` | ticket 11's seam: panels ask the connection's ingress origin with its own credential | 0 | **65** and **17 checks, 0 failures** |
| `node apps/web/e2e/window-experiment.mjs` | fixed viewport 1000×800, 200 vs 2000 messages, three window candidates | 0 | **68 checks, 0 failures**, long-task/tail-return/heap reported per candidate (`window-experiment-ad225f8.log`) |
| `pnpm verify:changed --base=ad225f8` | `7f743e1…`, `dirty: false` | 1 | typecheck 0, app/server/gateway tests 0, web-unit **57/57 pass**, `check-docs` 1 = the same **12 pre-existing** broken links, all git-ignored `.dev/`/`.pi/` targets. `.dev/verify/2026-10-19T13-48-48-828-verify-changed/` |
| `pnpm verify:changed --base=ad225f8`, re-run at the delivered tip | `240c3e3…` (the integration merge), `dirty: false` | 1 | same four steps and the same exits (typecheck 0, changed-test 0, web-unit 57/57, `check-docs` 1 on those 12 links). `.dev/verify/2026-10-19T14-24-19-566-verify-changed/`. The integration tip split the gateway/server `test` scripts into a deterministic default set plus `test:acceptance`, so the full `ingress-terminal` suite is cited as its own run above rather than assumed inside `changed-test` |
| live read-only entry smoke (no credential, no write, no restart) | origin `http://192.0.2.10:30141` | 0 | `/` 200 `no-cache`, `/assets/index-Bw8OauG9.js` 200 `public, max-age=31536000, immutable`, `/conversations/<id>` 200, `/missing.js` 404, `/../package.json` 404, `/api/models` 401, `/api/web-auth` `{"enabled":true}`, `/api/descriptor` 401, `/v1/files` 404, `/sw.js` 200 |

**One real defect found by running the acceptance, fixed at its owner.** `verify-artifacts` reported 40 pass / 4 fail on
the tip artifact: every dpkg-transaction assertion failed with
`dpkg: error: 2 expected programs not found in PATH or not executable — Note: root's PATH should usually contain
/usr/local/sbin, /usr/sbin and /sbin`. Cause: `apps/app/scripts/offline-install.mjs` runs the private-root transaction
under `bwrap --unshare-all`, which **inherits the caller's environment**, and an interactive developer `PATH` here has no
`/usr/sbin`, where `ldconfig` and `start-stop-daemon` live. The same artifact therefore installed from one session and
failed from another for a reason unrelated to the package — ordinary use, material consequence, so fixed rather than
recorded: the namespace is now given root's `PATH`, and the argv test asserts it
(`apps/app/scripts/offline-install.mjs:35`, `apps/app/test/offline-install.test.mjs:49`). Re-run: **44/44, exit 0**.

**What this closeout does not claim.** No service was started, stopped, restarted or written to by this ticket; the live
directory was only read and hash-verified. No real keyring was touched (the native runs addressed their own private store
and compared the developer's `login.keyring` digest before and after). No Android build was attempted and none is a gate.
The native numbers are debug-profile. `ux-models-config-save`, `ux-extensions-selection`, `ux-missing-model-recovery` and
`ux-agent-definitions` still fail by design here: they start the retired **Next** server (`next start`,
`.next/BUILD_ID`), so they are ticket 17's deletion inventory rather than new-entry acceptance — reported to the parent,
not silently re-pointed at the ingress. `packages/ui/src/components/DurableLogin.tsx` still posts to the Next-only
`/api/durable-login` and its only remaining consumer is `apps/web/app/page.tsx`, likewise 17's scope.

## Verification

相关 pnpm verify:changed、公开合同/浏览器/原生验收与运行服务检查；分别记录源码、构建、平台和部署证据。

Packaging slice evidence: [client-runtime release](../../../docs/client-runtime-release.md#evidence-what-was-measured-on-this-branch)
and [verification](../../../docs/verification.md#client-runtime-release-and-rust-build-cost-ticket-16-packaging-slice).
Source, build and platform evidence exist; **deployment evidence now exists too**, from the 2026-10-18 cutover
([the 1873d24 record](../../../docs/records/1873d24-deployment.md)): pinned `SOURCE_COMMIT`, artifact hashes, `SHA256SUMS`
(175 entries), verified online backups taken before the window, per-step exit codes, and a 30-check read-only smoke
re-run live an hour and a half later with conversation continuity and database integrity confirmed. **The browser and native
journeys are no longer the missing half:** they now run on the published immutable release and, on the deployed origin, as
login/scroll at two viewports plus the read-only entry smoke above. `1873d24` was superseded on 2026-10-19 by
`ad225f8`, which carries the Web login gate and the readiness fix that made `1873d24` unable to host a journey.

## Review notes

见[审查记录](../review-notes.md) G2/G3/G7/G8。仅当前版本全新状态验收。

## Verification practice

依照[验证实践](../../../docs/agents/verification.md)记录 command、source revision、exit code 与 log；发现依照[review policy](../../../docs/agents/review-policy.md)按实际影响处理。

## Report (acceptance driver slice)

Status: **acceptance evidence landed; the cutover itself is not done here.** This slice owns the acceptance drivers and
the two defects they found. The static surface and the runtime packaging come from the parallel slices (merged here);
the deployment and the switchover stay open and are recorded below.

### What now exists

| File | What it is |
| --- | --- |
| `apps/web/e2e/acceptance-stack.mjs` | the real system a journey runs on: execution gateway, Backend over its own SQLite files and device-credential store, client ingress, one controlled OpenAI-completions endpoint, and the production builds of both hosts, all on ports and state the run owns |
| `apps/web/e2e/ux-client-acceptance.mjs` | the production Web page in Chromium plus the App bundle at its own origin, driven through the cross-client journeys (52 checks) |
| `apps/web/e2e/ux-native-acceptance.mjs` | the real packaged shell under its own Xvfb, **debug profile**, and under a credential store the run owns (26 checks) |
| `scripts/lib/credential-sandbox.mjs` + test | one private D-Bus session bus with its own unlocked gnome-keyring, for any run that must write real credentials; the ambient bus address, keyring control socket and XDG homes reach no child |
| `packages/ui/src/lib/web-session-gate.ts` + test | which surface a failed connection read is: sign-in, refusal, or admitted |
| `packages/ui/src/lib/connection-readout.ts` + test | what a host may state about the connection its **own descriptor read settled on**, and nothing while it is undecided |
| `packages/ui/src/lib/connection-lifetime.ts` + test | what identifies a connection, as the one value its lifetime depends on |

### Journeys with evidence

- **Web creates → App reads → lost response → single submission.** The Web page creates a conversation through its own
  composer; the App (browser-emulated, its own origin and HashRouter) reads that turn over its own stream; a submission
  whose response is dropped at the transport reaches the model **once** and appears as **one** durable entry; the Web
  page then reads it without waking a second model request. The request-id lookup route is stated on the Web page's own
  turn with an id the driver knows.
- **Restart durability.** The Backend is stopped and started again on the same port and the same SQLite files; the same
  entries are served, no turn is duplicated, and the page re-attaches its stream (counted from inside the page).
- **Resource authorization.** No cookie → 401; unknown bearer → 401; the internal `/v1` surface → 404 on the client
  ingress; the deployment's own service credential → 401. A device credential issued by the Web session is admitted from
  the App's declared origin and refused from an origin the deployment did not declare.
- **The routes a cutover actually switches, on the App's own bearer.** Through the one ingress origin, with a device
  bearer and no cookie: `/api/workspaces` and `/api/hosts` read the deployment's own resources; the browser's
  `/api/files/workspace/local?type=list` lists a real folder on the execution host (`notes`) and a path naming no
  workspace is refused; a terminal tab is opened, attached to `/api/terminal/events`, its shell's own output is read off
  that stream, and the tab is closed; and `/api/mcp` reads this host's configuration, writes one entry, and reads it
  back from the host's own file. These are the four different ways the ingress answers (Backend forward, file surface,
  terminal fan-in, locally-answered host service), so one pass says the listener is the entry and not only its
  conversation half.
- **Scope switch.** A draft typed on the Web page is not the App's, on the same conversation.
- **Revocation.** The Web session revokes the App credential; on this revision the ingress refuses it **448 ms** later
  with `HEPI_REVOCATION_CHECK_MS=400` (512 ms and 534 ms on the earlier runs of the same check — the interval, not the
  measurement, is the contract), and the Backend's own record states `revoked` with its `revokedAt`.
- **Native shell (debug).** Cold start with no connection renders the configuration surface **and states no connection**;
  the connection is stored through the path the shell ships, into **this run's own credential store**; the restarted
  process is admitted by the real ingress, and its readiness line names the Backend, account scope and client id
  (`device:<id>`) the descriptor read actually answered; a real WebKitGTK window appears on the X display; the credential
  the shell wrote is located in that store through the Secret Service's own answer rather than inferred from an exit code;
  the same bearer is admitted from `tauri://localhost` by the driver's own request and agrees with what the WebView
  stated; and after revocation a shell restarted **still holding that revoked credential** reports `refused` with the
  reason the tree shows, with no line in that run ever stating an admitted connection. The kinds of statement are kept
  apart in the driver's own output: the surface and its connection facts come from `HEPI_APP_READY`, printed by the App
  bundle inside the WebView (**a UI / transport assertion**), the window from `xdotool` asked of the X server (**a platform
  assertion**), and the capture is **pixel evidence** whose only claim is that it is not one flat surface (34 distinct grey
  levels at a 24×24 reduction). The screenshot is not read for text and no check depends on which frame it caught — under
  Xvfb with software rendering it can be the App's transient `Connecting…` paint while the first descriptor read is still
  in flight. The run ends by stating where its own store went (retained with `--keep`, gone otherwise) and that the
  developer's login keyring is byte-for-byte what it was.

### Fixed because this acceptance found them

1. The new page showed a bare `unauthorized` on a gated deployment, because the workbench still used the retired
   `DurableLogin` form (posting to the Next-only `/api/durable-login`) and treated a refused descriptor read as a dead
   end. `web-session-gate.ts` now decides sign-in / refusal / admitted, and the page's own form posts to
   `POST /api/web-login` same-origin.
2. The page rendered but every send answered "the connection this request belonged to is closed": the client was
   memoized from render and disposed by an effect cleanup, so a replayed effect (StrictMode) got a disposed client, and
   the config object's identity changed every render. The client is now created and disposed by one effect pair, keyed on
   `connectionKeyOf`.
3. **An acceptance run wrote the developer's own credential store.** The native driver ran `hepi-app --configure` and
   `--forget` with `process.env` inherited, so the shell's `keyring` → Secret Service calls went to *the session bus of
   whoever was running the test*: `--configure` overwrote and `--forget` deleted the one entry
   (`dev.hepi.app/connection`) a real installed App on this machine lives on. Two runs had already done that before this
   was noticed, and the entry was restored from a store copy afterwards. The driver and
   `apps/app/scripts/verify-artifacts.mjs` (same hazard, packaged binaries) now run every shell process under
   `scripts/lib/credential-sandbox.mjs`: its own `dbus-daemon` on a config-file socket and its own
   `gnome-keyring-daemon --foreground --unlock` on a temp `HOME`, with `DBUS_SESSION_BUS_ADDRESS`,
   `GNOME_KEYRING_CONTROL`/`GNOME_KEYRING_PID` and every XDG home replaced or removed from the child environment, and no
   fallback — it throws rather than start a run that would address the ambient bus. Both drivers then **assert** the two
   properties the claim rests on — the run's own store starts empty, and every shell process is handed this run's bus and
   no keyring control socket — and compare the SHA-256 of the developer's `login.keyring` before and after. A socket path
   that cannot be named is a real failure mode, not a theoretical one: rooting the tree in `.dev/verify/<run>/…` produced a
   146-byte path, the daemon could not bind, and the run reported a store that never answered — so the store always lives
   under `TMPDIR`, a `TMPDIR` that cannot hold the socket is refused by name, and the tree is *moved* to the caller's log
   directory for retention only once its daemons have exited (a live daemon recreates directories under it and the removal
   fails with `ENOTEMPTY`).
   Two further ways the same hazard reopened, both found while reviewing this change and fixed in it:
   - **An empty environment is not an isolated one.** `apps/app/scripts/verify-artifacts.mjs` caught the store-start error,
     left `shellEnv = {}` and went on to run `--forget`. With no `DBUS_SESSION_BUS_ADDRESS` the Secret Service library the
     shell's `keyring` crate uses does not give up — it goes on to `/run/user/<uid>/bus`, the developer's running session —
     so a run that had *reported* "no store started" would still have deleted a real user's App connection. Every packaged
     spawn now goes through `packagedEnvironment(credentials, extra)` in the same module, which throws unless it is handed
     this run's own bus: no store, no credential process. (A missing `gdbus`/`dbus-daemon` on an ordinary host is the
     trigger, which is why the guard is a function and not a per-driver `if`.)
   - **A driver that acquires before it owns cleanup orphans what it took.** `apps/web/e2e/ux-native-acceptance.mjs`
     started Xvfb and the whole stack before it had a shutdown handle or signal handlers registered, so a store-start throw
     left a display and three services running. Every resource handle is now declared first, the cleanup and the signal
     handlers are installed before anything is acquired, and each acquisition failure releases what it managed to take
     before exiting.
4. **Readiness was reported before the connection was admitted.** `apps/app/src/main.tsx` printed
   `HEPI_APP_READY … workbench` in the effect branch that *found a stored connection*, so a shell whose bearer had been
   revoked — or whose Gateway was unreachable — still claimed a workbench, and a packaged check reading that line believed
   a WebView that never reached a Backend. The rule now lives with the code that reads the connection:
   `packages/ui/src/lib/connection-readout.ts` turns the descriptor read's own settled state into
   `admitted {profile, backendId, accountScope, client}` or `refused {reason}`, and **nothing in between**; `Workbench`
   calls the host's `onConnectionReadout` only for those two; the App reports `connecting` at mount and prints `workbench`
   only together with the four facts the ingress answered. `app_ready` gained those fields (`backend`, `scope`, `client`,
   `profile`, `reason`) and the driver's workbench check requires them, so the line is a transport observation rather than
   a process-liveness one. `client` is the identity the deployment named (`device:<id>` / `web`), never the bearer, and the
   App's own test suite asserts that the bearer cannot reach the readiness line at all.

### Still open (not this slice)

- **The workbench keeps the previous connection's readout readable until the next read settles.** `descriptor` and
  `admission` are `useState` values that a changed `connectionKey` does not clear synchronously: the effect that clears
  them runs after the render, and `identity`/`readout` are derived during that render from `configRef.current.profile`
  plus the still-retained descriptor. A host that swaps profile or credential *within one mounted page* can therefore be
  handed the previous connection's `backend`/`client` with the new `profile` for one commit. The reviewer classified this
  as not a normal trigger for this App: the packaged shell changes connection by **restarting the process** (`--configure`
  stores and restarts), so no in-page profile switch exists on the native path, and the Web host states no readout at all.
  It is recorded rather than fixed here because the coherent fix is to key the read result itself by `connectionKey` and
  drop a mismatched answer at the seam that owns it — a change to the workbench's state model, not to this ticket's
  readiness contract. A profile refactor is deliberately not attempted under ticket 16.
- **Ingress static surface — the only surface the driver will run against.** The fallback host is gone. The stack asks
  the ingress for `/` and fails with `the client ingress does not serve the static Web shell on / … Point
  HEPI_INGRESS_STATIC_DIR at apps/web/dist; this driver has no fallback host to substitute for the surface under test`
  when the answer is not its shell. Verified both ways on `0d90b7d`: the journey runs report `static surface: ingress`,
  and with `apps/web/dist/index.html` moved aside the stack refuses to start (cause quoted above; the build directory was
  restored byte-identically afterwards). `startStaticHost` survives for exactly one thing — the App bundle's own origin,
  which is not the ingress's and must not be.
- **What the new route checks do *not* cover.** They drive one execution host. Multi-host terminal fan-in (ticket 09's
  Backend merge across two gateways) and a real MCP server being started and tested (ticket 13) stay with
  `packages/gateway/test/ingress-{terminal,mcp}.test.ts`, which this slice does not duplicate; this ticket adds the
  App-bearer path through the same ingress rather than a second suite. The stack does now configure
  `HEPI_INGRESS_MCP_GATEWAY_{URL,TOKEN,ID}` against the gateway it already starts, which is the deployed shape; a
  deployment that names no host service keeps its own answer (`mcp_unavailable`) and no driver here depends on it.
- **Cutover, deployment and old-service stop** — untouched by this slice. No deployment was started, stopped or written to;
  the later 2026-10-19 closeout only read and hash-verified the deployed directory.
- **Android / mobile App** — no SDK, no `adb`, no device on this host: no mobile artifact exists and nothing here is
  evidence about one. The user withdrew Android as a delivery gate on 2026-10-19; this absence is still an absence.
- **Release artifacts and their performance** — ticket 15. The native run here is a **debug** build; it is functional
  evidence, not release performance.
- **Terminal, multi-host routing, MCP and project trust, PWA install/offline** are stated by their own tickets' drivers
  (`ux-terminal-fan-in`, `ux-mcp-surface`, `ux-pwa-offline`, `ux-worktree-picker`, `ux-ssh-project`); this slice does not
  duplicate them, per the test-scope constraint.

### Checks run

The first block is this change; the rows from `0d90b7d` down are the previous slice's record and stay as it was measured.

| Command | Revision | exit | result |
| --- | --- | --- | --- |
| `node apps/app/scripts/build-artifacts.mjs --label=t16-final --profile=debug --skip-web` | **`2c6f801`** (clean tree — the commit that carries this change), debug profile, shared `CARGO_TARGET_DIR`, 6 jobs, incremental | 0 | `.deb` + binary with `provenance.revision = 2c6f8019fbd3…`; log `.dev/verify/t16-final/build-artifacts.log` |
| `node apps/web/e2e/ux-native-acceptance.mjs --keep` | same, debug shell reporting `HEPI_APP_BUILD {"shell_revision":"2c6f8019fbd3…"}`, `static surface: ingress` | 0 | **26 checks, 0 failures** (`.dev/verify/t16-final-native/run.log`). Private bus `unix:path=/tmp/hepi-t16-native-cred-HR09W4/bus`; the run's own store starts empty; every shell process handed that bus and no keyring control socket while the address it did *not* use was `unix:path=/run/user/1000/bus`; the admitted line names `backend=hepi-backend`, `scope=default`, `client=device:3dafd337-4a60-…` matching the credential this run issued; the revoked-bearer restart reports `refused` with no admitted line; the store is retained as evidence at `/tmp/hepi-t16-native-0uV8QV/hepi-t16-native-cred-HR09W4`; login keyring `0ced02df2ba9…` unchanged |
| `node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/t16-final --log-dir=.dev/verify/t16-final-artifacts/run` | same, debug deb | 0 | **39 assertions, 0 failures** (`.dev/verify/t16-final-artifacts/run/report.json`). `provenance-names-the-built-revision` compares against this HEAD, so it binds the run to `2c6f801`; `the-run's-store-starts-empty`, `the-stored-entry-is-in-the-run's-own-store` (`/org/freedesktop/secrets/collection/login/1`), `forget-emptied-the-run's-own-store`, `packaged-runs-addressed-a-private-credential-store` (`unix:path=/tmp/hepi-artifact-cred-d2yiKv/bus`, removed with the run) and `developer-login-keyring-unchanged` (`0ced02df2ba9… -> 0ced02df2ba9…`) all pass |
| `node apps/web/e2e/ux-client-acceptance.mjs` | same, `static surface: ingress` | 0 | **52 checks, 0 failures** — the client journey rerun against the changed `Workbench` public seam (`.dev/verify/t16-final-client/run.log`; first visible 215 ms, 75 Web / 28 App requests, 3 model requests, peak RSS backend 122 MB / gateway 119 MB / ingress 199 MB, revocation refused after 949 ms — the interval, not the measurement, is the contract) |
| `node --test scripts/credential-sandbox.test.mjs` | same | 0 | **11 pass** — pointer replacement, control socket removed, an absent keyring stated as absent, `packagedEnvironment` refusing a run with no store / an environment naming somebody else's bus, a started sandbox answering on its own bus and leaving nothing behind, retention relocating the tree, an over-long socket path refused by name, and both drivers' acquisition/guard shape (`scripts/credential-sandbox.test.mjs:120`) |
| `node --test packages/ui/src/lib/connection-readout.test.mjs` | same | 0 | **7 pass** — admitted / web-session / descriptor-without-client / refused / sign-in / in-flight (`.dev/verify/t16-final/readout-test.log`) |
| `pnpm --filter @hepi/app test` | same | 0 | **10 pass** — the `app_ready` arguments for configure / refused / admitted and "the bearer never reaches the readiness line" (`.dev/verify/t16-final/app-test.log`) |
| `pnpm --filter @hepi/ui test`, `pnpm test:scripts` | same | 0 | **208 pass**, **85 pass** (`.dev/verify/t16-final/ui-test.log`, `.dev/verify/t16-final/scripts-test.log`) |
| `pnpm --filter @hepi/ui typecheck`, `pnpm --filter @hepi/app typecheck` | same | 0 | clean |
| `cd apps/app/src-tauri && CARGO_TARGET_DIR=…/.dev/cargo-target CARGO_BUILD_JOBS=6 CARGO_INCREMENTAL=1 cargo test` | same | 0 | **4 pass**, 1 suite, debug profile (`.dev/verify/t16-final/cargo-test.log`) |
| `node apps/web/e2e/ux-client-acceptance.mjs` | **`0d90b7d`** (clean, the commit that carries the previous slice's change), `static surface: ingress` | 0 | 52 checks, 0 failures |
| `node apps/web/e2e/ux-native-acceptance.mjs` | same revision, debug shell, `static surface: ingress` | 0 | 12 checks, 0 failures |
| the stack alone, `apps/web/dist/index.html` moved aside | same | 0 | refuses to start as designed: `… this driver has no fallback host to substitute for the surface under test` (`.dev/verify/t16-nofallback/probe-0d90b7d.log`) |
| `node --test packages/ui/src/lib/web-session-gate.test.mjs` | same | 0 | 5 pass |
| `node --test packages/ui/src/lib/connection-lifetime.test.mjs` | same | 0 | 3 pass |
| `node --test` navigation + workbench-scope + client seams | same | 0 | 13 pass. The run recorded at `41fabf3` stated 18 for this same trio; none of those three files changed here, so this is that row's own current number rather than a regression this slice introduced |
| `pnpm --filter @hepi/ui typecheck`, `@hepi/web typecheck` | same | 0 | clean |
| `node --test packages/gateway/test/ingress-mcp.test.ts` | same | 0 | 9 pass — the contract this ticket's new MCP check reads (an aggregate over the host's own `POST /v1/mcp`) is unchanged by the driver change |
| `cargo build` (debug, shared `CARGO_TARGET_DIR`, `CARGO_BUILD_JOBS=6`, `CARGO_INCREMENTAL=1`) | same | 0 | 3 crates, dev profile |

### Focused check on this branch

`pnpm verify:changed --base=5c4a6d8` at `2c6f801` selected six steps (every **source** file at that commit, which is what
`provenance.revision` and the shell's own `HEPI_APP_BUILD` line below confirm; only these two docs records were still
dirty); log directory `.dev/verify/2026-10-19T00-44-00-514-verify-changed/`.

| Step | exit | note |
| --- | --- | --- |
| `changed-typecheck` | 0 | `@hepi/app`, `@hepi/server`, `@hepi/web`, `@hepi/gateway`, `@hepi/ui` |
| `changed-test` | 0 | `-r test` across the selected workspaces, including the new `connection-readout`, sandbox and App shell suites |
| `web-unit` | 0 | |
| `script-tests` | 0 | includes `scripts/credential-sandbox.test.mjs` (11) |
| `check-entrypoints` | 0 | |
| `check-docs` | 1 | the same 12 pre-existing broken links, all git-ignored `.dev/`/`.pi/` targets and none in a file this change touched (`grep '^BROKEN' \| grep -v '\.dev/\|\.pi/'` is empty) |

`pnpm verify:changed` at `5c4a6d8` (dirty tree: the same change before the two review fixes were folded in) selected the
same six steps with the same exits; its runs are superseded by the `2c6f801` rows above and are kept only as the
pre-review record in `.dev/verify/t16-native-cred/`, `.dev/verify/t16-artifact-isolation/` and
`.dev/verify/t16-client-after-readout/`.

The drivers above are the boundary this change owns — `verify:changed` selects packages and dependents, not browser or
native flows — so the two acceptance runs and the packaged-artifact run are recorded separately, not folded into this table.

`pnpm verify:changed --base=integration/client-app` at `41fabf3` (dirty tree: the merge of the static-surface and
packaging slices plus this ticket's docs) selected six steps; log directory
`.dev/verify/2026-10-18T06-40-38-604-verify-changed/`.

| Step | exit | note |
| --- | --- | --- |
| `workspace-typecheck` | 0 | |
| `workspace-tests` | 1 | one failure, `apps/server` `provider-config.test.ts` → "the configured alias advertises the upstream image input of its model id", `SyntaxError: Unexpected end of JSON input` in the test's own endpoint reader. **Pre-existing flake, not this branch**: the file passes 5/5 three times in a row on its own, and a full `pnpm --filter @hepi/server test` rerun is **455/455, exit 0**. This branch changes no file in `apps/server` beyond a `tsconfig` line from the merged slice |
| `web-unit` | 0 | |
| `script-tests` | 0 | |
| `check-entrypoints` | 0 | |
| `check-docs` | 1 | the same 12 pre-existing broken links (git-ignored `.dev`/`.pi` targets); `grep '^BROKEN' | grep -v '\.dev/\|\.pi/'` is empty |

The acceptance drivers and the two rule tests are the checks this change owns; the selected run above is the
regression guard that the shared UI and workspace still build and pass around them.

Raw logs and the captured native window are in the drivers' own artifact directories (`--keep`); the verification
record is [docs/verification.md](../../../docs/verification.md#shared-client-acceptance-ticket-16).

## Artifact journeys on the published release (2026-10-19 — bdc8746)

The gap above was an **artifact** gap, not a host gap: the journeys had run against this checkout's `apps/web/dist` and
`apps/app/dist` with a source-tree ingress and a source-tree gateway, while a cutover switches the directory
`scripts/build-client-runtime.mjs` publishes. So the acceptance stack learned to consume that directory, and both journeys
were driven against it.

**The seam.** `startAcceptanceStack({ releaseDir })` (`apps/web/e2e/acceptance-stack.mjs`) refuses to start when the
directory is incomplete — no `provenance.json`, no bundle, no `web/index.html`, no gateway tarball, no recorded image tag —
and **it never substitutes a fallback**: passing `--release` and then serving the checkout would silently mean the run proved
the sources, so the check that guards this (`apps/web/e2e/acceptance-release.test.mjs`) asserts both the resolved component
paths and the rejection shape. With `releaseDir`: the ingress process is the release's `ingress.mjs`; static assets come from
its `web/`; the execution host is the release's tarball installed with `npm install` into the run's own temporary directory
and launched by its real path; the Backend is a container from the release's recorded image tag, on `--network host`, as this
user's uid/gid, on a state directory this run owns, configured through a mode-0600 env file. Restart durability restarts
**that container**, so `stack.stopBackend` removes it and waits for the client to release the port before the replacement
binds. `pidOf` reads RSS from `docker inspect` for that role instead of `/proc/<pid>`, because the `docker run` process is the
CLI client, not the server: measuring it would have reported the Backend at a few MB.

**Three identity assertions were added to the client driver, because "it passed" is not "it passed on this artifact"**: the
running ingress's own argv names the release bundle; the running gateway's real path is inside the release tarball as
installed by that run; and the served `index.html` equals the release's `web/index.html` byte for byte. The drivers also state
the one component a client-runtime release does **not** carry — the App bundle — and the log line says so rather than
quietly taking it from the checkout.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| release contract, 4 tests (component resolution, incomplete-release rejection, no-fallback) | `node --test apps/web/e2e/acceptance-release.test.mjs` | `7d68696` | 0 | `.dev/verify/c16-closeout/acceptance-release-test.log` |
| immutable release built | `node scripts/build-client-runtime.mjs --json=…` | **`bdc8746`** (clean tree) | 0 | `.dev/verify/c16-closeout/release-build-bdc8746.log` — `release-bdc8746`, 4 artifacts, Backend image `hepi-backend:bdc8746-workstation` `sha256:c566ca91…` amd64 |
| release integrity | `sha256sum -c SHA256SUMS` inside the release | same | 0 | `.dev/verify/c16-closeout/sha256sums-bdc8746.log` — 177 entries OK |
| client journey on the published release | `node apps/web/e2e/ux-client-acceptance.mjs --release=.dev/releases/release-bdc8746` | same | 0 | **55 checks, 0 failures** (`.dev/verify/c16-closeout/client-release-bdc8746.log`): the three identity assertions pass; first visible 201 ms; 72 Web / 28 App requests, 3 model requests; peak RSS backend 208 MB (container-reported) / gateway 81 MB / ingress 87 MB; revocation refused after 578 ms |
| native journey on the published release | `node apps/web/e2e/ux-native-acceptance.mjs --release=.dev/releases/release-bdc8746` | same | 0 | **26 checks, 0 failures** (`.dev/verify/c16-closeout/native-release-bdc8746.log`): real debug shell configured against the release's `ingress.mjs`, its own private bus `unix:path=/tmp/hepi-t16-native-cred-PYGVdC/bus`, the inherited `/run/user/1000/bus` used by no shell process, store emptied by `--forget`, developer login keyring `0ced02df2ba9…` unchanged, sandbox unmounted and removed |
| unit files for a release switch (generated only, never installed) | `node scripts/ingress-unit.mjs --release-dir=.dev/releases/release-bdc8746` | same | 0 | `.dev/verify/c16-closeout/hepi-ingress-bdc8746.service` — `ExecStart` and `WorkingDirectory` both inside the release directory; requires an **absolute** `--release-dir`, so the generated unit does not depend on the caller's cwd |
| packaged App artifacts | `node apps/app/scripts/build-artifacts.mjs --label=c16-closeout-bdc8746 --profile=debug --skip-web` then `verify-artifacts.mjs` | same | 0 | **43 assertions, 0 failures** (`.dev/verify/c16-closeout/artifacts-bdc8746/run/report.json`) — see the dpkg paragraph below | — that run used the verifier as it stood at `bdc8746`; reviewer58's P2 (below) replaces its host claim with a before/after record comparison and brings the count to **44**
| release built at the merged tip | `build-client-runtime.mjs` + both journeys | **`9aa4326`** (= `75f72f5` + `integration/client-app` `68ce3ca`) | 0 | `.dev/verify/c16-closeout/release-build-merged.log`, `client-release-9aa4326.log` **55/55**, `native-release-9aa4326.log` **26/26**, `pwa-offline-9aa4326.log` **24/24** (`ux-pwa-offline` reads this checkout's `apps/web/dist`, the same build that release directory holds). Packaged artifacts at that tip ran **39/39**: the four dpkg-transaction assertions below are added at `bdc8746`, so the count is revision, not regression |

**The install half of ticket 15's limit closed itself.** The host grants no root for `dpkg -i` and that was reported as a
limit; it does grant unprivileged user namespaces (`kernel.unprivileged_userns_clone=1`, `bwrap` installed), so
`apps/app/scripts/offline-install.mjs` runs a **real dpkg transaction** with the host bind-mounted read-only and one throwaway
root writable, `dpkg`'s own status database and log inside it, seeded from the host's installed package set so
`libwebkit2gtk-4.1-0` resolves. `verify-artifacts` then asserts five ids extraction cannot state:
`dpkg-transaction-reaches-installed-state` (`Status: install ok installed`, exit 0),
`dpkg-verify-agrees-with-what-it-installed` (`dpkg -V`, exit 0), `the-installed-binary-executes-into-this-run's-own-store`
(the binary **dpkg's transaction placed** cold-starts against the run's private Secret Service), and
`the-host's-own-dpkg-record-of-this-package-is-unchanged` — the host's own record of `hepi` read **before and after**
the transaction and compared as read, not a presence flag (reviewer58 P2: asserting absence would fail a healthy hepi
workstation, which has such a record; what survives both hosts is "unchanged", and this host happens to state
`not in the host's database` on both sides). dpkg's own transaction log is copied out of the private root into the report
directory and then matches `status installed hepi:` in the **retained** file, since the private root it lived in is
removed moments later (44 assertions, 0 failures, run at the artifact's own commit). Capability is
decided, not assumed: `offlineDpkgInstall.supported` carries a stated `reason` when `dpkg`, `bwrap` or userns is absent, and
then the run reports extraction as the weaker evidence it is. There is no `--force` fallback. `systemInstall` stays `false` —
no system was written — and `pnpm --filter @hepi/app test` now passes 18, six of them in
`apps/app/test/offline-install.test.mjs`: the support decision from host facts, the seeded database keeping only
fully-installed packages, the argv holding the host read-only with one writable root, a host that already has the package
yielding a comparable record rather than an absence, a real transaction in a private root reaching installed state, and a
transaction over an **already-installed** fixture package leaving that record alone end to end.

**The intermediate run explains the worktree.** `verify-artifacts` binds the artifact's revision to `git rev-parse HEAD`, so the
first re-verification from `1c74cb9` correctly reported **42 assertions, 1 failure** — `provenance-names-the-built-revision`,
`bdc8746810e2… (HEAD 1c74cb92e805…)` (`.dev/verify/c16-closeout/verify-artifacts-bdc8746-p2.log`, retained). The new
host-record and log-retention assertions passed in that run; the repeat from the artifact's own commit is what makes the 44
citable. The pre-fix 43-assertion run (`.dev/verify/c16-closeout/artifacts-bdc8746/run/report.json`) stays as the shape
reviewer58 read.

**How the artifact was re-verified without rebuilding it.** `verify-artifacts.mjs` binds `provenance-names-the-built-revision` to
`git rev-parse HEAD`, so the pre-existing `bdc8746` artifact is re-verified from a detached worktree **at that commit** with
only the verifier files copied in — no release, no App artifact rebuilt, since this change touches neither:
`git worktree add --detach /tmp/c16-verify-bdc8746 bdc8746`, copy `offline-install.mjs` + `verify-artifacts.mjs` into
`apps/app/scripts/` and the test into `apps/app/test/`, symlink the primary worktree's `.dev/artifacts` as the default
artifact root, then `node apps/app/scripts/verify-artifacts.mjs --artifact-dir=<primary>/.dev/artifacts/c16-closeout-bdc8746
--log-dir=<primary>/.dev/verify/c16-closeout/artifacts-bdc8746-hostrecord/run`. That worktree was removed afterwards; the
report, its `dpkg-transaction.log` and both driver logs stay in the primary worktree's `.dev/`.

**What this did not close, at the time of that record.** The deployed origin then ran `1873d24`, which answers `unauthorized`
with no login surface, so the journey could not run there until a release was switched — a switch this ticket did not perform,
no unit was installed, no service was restarted, and the plan and unit above stayed in `.dev/`. **That gap is now closed by the
2026-10-19 closeout:** the live origin is `release-ad225f8`, the same bytes both journeys ran on, and the entry itself was
driven at two viewports (see [Concrete closeout](16-integration-and-direct-cutover.md#concrete-closeout-on-the-live-release-2026-10-19--ad225f8)).
Android stays unevidenced (empty SDK directory, no `adb`, no device, no emulator) and is **no longer a delivery gate** by the
user's decision of 2026-10-19: no mobile artifact is built, and the absence is recorded as an absence. Debug-only native
numbers, no release performance claim.

## UX 研究补充（2026-10-19）

[入口实测](../../ux-closeout-research/evidence/runtime-observation.md)针对旧 live1873d24：桌面/手机无 cookie 入口仅 unauthorized。当前源码已有 41fabf3 登入修正与 2c6f801 readiness，先以不可变产物/实际 origin 复核，不再实现一套入口。已记录的测试栈数据不能当作当前产物/线上全流程证明。

原 acceptance 保持；新增 logout/App恢复/保存/读错误计划在 17 后的 18–22，见 [执行图](../../ux-closeout-research/spec.md)。本票不依赖那些新票，后续 UX scope 不倒灌成历史票的完成声明。Android 与 debug/release 证据限制仍须如实单列。

**该项已完成（2026-10-19）**：入口与滚动在**当前部署 origin**（`release-ad225f8`，即 `ad225f89…`）上复核，而非停在旧 live1873d24 的观测：桌面 1280×800 与手机 390×844 都渲染登入面、登入 200、表单消失，既有长会话 `overflow-y: auto` 且 scrollTop/滚轮均可用，另加只读入口 smoke（缓存策略、SPA fallback、404、`/api` 401、`/v1` 404）。Android 已按用户 2026-10-19 的决定退出交付门槛，缺测仍如实记为缺测。详见 [Concrete closeout](#concrete-closeout-on-the-live-release-2026-10-19--ad225f8)。
