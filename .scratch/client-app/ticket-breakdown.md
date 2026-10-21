# Shared client implementation tickets

Status: in-progress; reconciled 2026-10-20 against this line (`main`, after 16's closeout and 17's two lanes). Core migrations, 16's packaging/driver/readiness slices and 17's retirement are integrated; Web cutover `1873d24` (2026-10-18) was superseded by the live release `ad225f8` (2026-10-19), where 16's concrete closeout ran. 17 follows 16; UX 18–21 are delivered after it, 22 stays the gate over them, and the Pilo tickets 23–25 are complete at `7345384` (`2a53eef` for 25's trimmed test). Android stays withdrawn as a delivery gate (user decision 2026-10-19) and its absence is recorded as an absence, never a pass.

[Specification](spec.md) owns behavior and acceptance; [review notes](review-notes.md) owns gaps, patterns and source evidence. Each issue is an observable user/operational slice. The target capability list is fixed before coding, and platform evidence precedes shared UI extraction. Private project: direct replacement from fresh state; no historical-data migration, old-user upgrades, version compatibility or rollback rehearsals.

| Ticket | Observable outcome | Blocked by | Status |
| --- | --- | --- | --- |
| [01](issues/01-contracts-and-release-envelope.md) | 确定目标能力与首发平台 | none | resolved |
| [02](issues/02-credentials-and-connection-descriptor.md) | 通过 Gateway 连接、签发及撤销设备凭证 | 01 | resolved |
| [03](issues/03-gateway-conversation-slice.md) | 经 Gateway 完成首次会话读写与 SSE | 02 | resolved |
| [04](issues/04-tauri-platform-spike.md) | 在桌面和移动目标验证 Tauri 通信及凭证存储 | 03 | desktop evidenced (live release `ad225f8`, 27 checks); **Android withdrawn as a delivery gate by user decision 2026-10-19** — nothing is built for it, and its absence is recorded as an absence, not a pass, in [ticket 04](issues/04-tauri-platform-spike.md) |
| [05](issues/05-shared-ui-routing-and-scope.md) | Web/App 共享会话 UI、路由与连接作用域 | 04 | resolved for the shared surface: the workbench, both hosts and the native conversation-API cutover are integrated, and 16's 2026-10-19 closeout drove the App's own journey on the packaged shell (27 checks at `ad225f8`, native journey 26 on the published release) plus `ux-chat-scroll` on the deployed origin. What this row never claimed stays with its owners: platform evidence is 04/15's, cross-host release acceptance is 16's, and debug-only native numbers are 16's named limit. |
| [06](issues/06-catalogue-projects-and-worktrees.md) | 迁移目录、项目和 worktree 用户流程 | 05 | resolved: Backend catalogue and native sidebar/project/worktree seam integrated at `837aa1d` (`efdd9ae`), checked with connection fix `a0f2c01`; final release journeys remain ticket16 |
| [07](issues/07-history-and-authenticated-resources.md) | 迁移历史、context 与认证媒体资源 | 05 | resolved: the read-block contract, the shared UI consumers and the image-body bound merged into `integration/client-app` at `644ac55` (`dc1cfef`, tested at `dd51a06`, docs at `fd6e810`) and re-checked on the merged tree; native/platform evidence was never this ticket's claim and stays 04/16's |
| [08](issues/08-files-and-workbench-streaming.md) | 接通文件工作台、流式上传与下载 | 05 | resolved: merged into `integration/client-app` at `c2e691e` (`be2712f`, review corrections included), re-checked on the merged tree at `a0f2c01`; the App's own upload/download UI and native memory claims stay 04/05/15 work |
| [09](issues/09-terminal-fan-in.md) | 在 cookie/bearer 下恢复多终端 fan-in | 05 | resolved: merged at `8c5dfb4`, its effect-owned stream (StrictMode replay) fix included; the focused review passed with no material residuals |
| [10](issues/10-conversation-controls-and-relations.md) | 迁移会话控制、队列及关系操作 | 05 | resolved |
| [11](issues/11-models-providers-and-extensions.md) | 迁移模型、provider、扩展和共享设置 | 05 | resolved: the settings contract, scoped cache, panels and the composer's catalogue read are merged at `fbcac7d` (`7f41151`) with the connection-lifetime fix at `a0f2c01`; provider login and model refresh were delivered by that effort's tickets 03–05 (`4a54277` and earlier, integrated), and the panels' own origin is the live ingress, re-run by 16's closeout (`ux-panel-ingress` 65, `ux-capability-trust` 17). Its two named limits stay limits, not rows of this ticket: interactive OAuth is not exercised against real upstream endpoints, and the retired-Next inventory belonged to 17 |
| [12](issues/12-execution-side-resources.md) | 迁移 skills、安装和 agent definitions | 06 | resolved (merged at `e5a9d18`, re-run on the integration tree) |
| [13](issues/13-mcp-and-project-trust.md) | 通过命名客户端 API 管理 MCP 与 project trust | 06 | resolved: review corrections merged into `integration/client-app` at `e257e3d`, and the merged tree re-checked with the 06/07/08/11/15 batch at `644ac55` |
| [14](issues/14-web-pwa-and-notifications.md) | 新 Web 首次安装、PWA 与页面通知 | 05 | resolved: merged at `90859ee`, reviewed at `2cfb18d`; install surface and page notifications evidenced, OS install prompt/native notifications unverified |
| [15](issues/15-build-and-release-artifacts.md) | 产出可追溯静态 Web 与首发 App 包 | 05 | resolved for the supported targets: desktop packaged and merged at `e537a95` (`758dcf0`), the traceable client-runtime release built and journey-tested by 16 (`release-bdc8746`, `9aa4326`), and the system-`dpkg -i` limit closed by 16's 2026-10-19 real namespace transaction (44/44 assertions), whose one finding (the namespace's `PATH`) is fixed in `offline-install.mjs` and asserted in `offline-install.test.mjs`. Android remains withdrawn (user decision 2026-10-19): no mobile artifact exists, none is a gate, and the absence is recorded as an absence |
| [16](issues/16-integration-and-direct-cutover.md) | 完整双端验收并直接切换入口 | 06–15 | **concrete closeout done on the live release `ad225f8` (2026-10-19)**: client journey 61/61, native journey 27/27, packaged artifacts 44/44, pwa-offline 24, chat-scroll 15, ssh-project 31, ingress-terminal 4, panel-ingress 65, capability-trust 17, window-experiment 68, `verify:changed --base=ad225f8` typecheck/tests/web-unit clean (its one failing step is the 12 pre-existing ignored broken links). What remains is a named limit set: debug-only native numbers, a loopback-sshd second host rather than a second physical machine, and the retired-Next drivers that are ticket 17's inventory. See [ticket 16](issues/16-integration-and-direct-cutover.md#concrete-closeout-on-the-live-release-2026-10-19--ad225f8) |
| [17](issues/17-retire-next-and-transition-paths.md) | 完整删除旧 Next/BFF 与残留路径 | 16 | **runtime/route retirement delivered; manifest/typecheck residue open** — lane A `782ccb6` deleted `apps/web/{app,adapters,lib,vendor}` after its caller matrix; lane B `89c9ec5` removed the Next build config, Web image/Dockerfile, Compose `web` service, smoke's Web checks, deploy-plan Web image and dead scripts. Not complete against its own criteria: `apps/web/package.json` still declares `next` 16.3.6 (lockfile entry present) and `apps/web/tsconfig.json` still carries the Next plugin and the `.next/types` include. Nothing imports `next`, so build/typecheck/run are unaffected — the disposition is a small follow-up and it does **not** block 23–25 |

## Decisions so far

- 08: the browser's file surface is one implementation — `packages/gateway/src/files-surface.ts`, with its rules in
  `packages/protocol/src/files.ts` — served by the client ingress for a Web page or an App and assembled by the Web
  origin over the same Backend calls. The multipart body is read by `packages/gateway/src/multipart.ts` over the public
  `busboy`, so the Next-private parser is gone; a batch past the bound is refused with the bound, a download's body is
  piped and paced by its reader, and a caller that goes away releases the host reader. Browsing is local-only: a host
  composed without a workbench serves payloads and answers `501` for listing, preview, changes and diff rather than
  answering from this machine. file watch, DOCX preview and linked-directory approval stay `501` by decision. The
  App's own upload/download UI and any native memory claim remain ticket 04/05/15 work — ticket 04's desktop evidence
  constrains this surface (cross-origin page origin, no streamed request body, ≤1 MiB IPC slicing) and is not
  re-claimed here. Behaviour: [Workbench](../../docs/workbench.md#the-file-surface-is-one-implementation); evidence:
  [verification](../../docs/verification.md#files-and-workbench-streaming-ticket-08).
- 13: the MCP panel aggregate is declared once (`packages/ui/src/lib/mcp-panel.ts`) and answered by both client entries —
  the client ingress (`packages/gateway/src/ingress/mcp.ts`, from the host's own `POST /v1/mcp`, never forwarded to the
  Backend) and the Web entry's Next route, which keeps only its own host service and folder resolution until ticket 17.
  A folder is named to the host as a **workspace id** and resolved by that host's registry (`unknown-workspace` → 403
  `cwd-denied`), so no caller synthesizes a path — and the id is verified first against the Backend's own binding
  (`/api/workspaces`, `/api/hosts`, read with the ingress's service credential) against
  `HEPI_INGRESS_MCP_GATEWAY_ID`, because a name is not an identity: two machines can each serve a folder called
  `local`. The cookie's same-origin write guard applies to a Web session only, so an App's declared origin writes with
  its own bearer while a cross-origin cookie write stays refused, and a revocation or a disconnect aborts the host's own
  operation — a sign-in mid-exchange stores nothing and reports an unknown outcome, not a rollback. Absent
  `HEPI_INGRESS_MCP_GATEWAY_URL`/`HEPI_INGRESS_MCP_GATEWAY_TOKEN`/`HEPI_INGRESS_MCP_GATEWAY_ID` (stated together or
  not at all) the routes answer 503 `mcp_unavailable` naming them, and every other client route keeps working. The
  panel and the trust dialog ask through the connection's client, so the App reaches the client API on its own origin.
  Routes and evidence:
  [client ingress](../../docs/client-ingress.md#host-local-mcp-and-project-trust),
  [MCP on the Web host](../../docs/mcp-on-the-web-host.md).
- 07: the read blocks a deferred history entry names are served on the client ingress under the same cookie or device
  bearer as everything else, and that path rewrite (`/api/sessions/:id/entries/:entryId/{text,thinking,tool-result-image}`
  → the Backend's own `/api/conversations/...`) is the ingress's only route translation. Both blocks are bounded by
  default: text and thinking answer at most 256 KiB of UTF-8 with `offset`/`totalBytes`/`truncated`/`nextOffset`, and an
  image honours a byte `Range` decoded from only the groups it touches. `packages/session/src/resources.ts` is the client
  half — one reader per connection scope, resolving a wire address against the admitted Gateway, no credential in a URL,
  images as blob leases reclaimed by budget and revoked by `dispose()`, every refusal named. Bounds, route table and
  evidence: [client ingress](../../docs/client-ingress.md#history-context-and-media-resources).
- 02: the credential path is implemented and tested but is not the deployed entry. A new explicit start (`pnpm --filter @hepi/gateway start:ingress`) binds the client listener; today's Backend and execution-gateway entries bind what they always bound. The Backend owns device credential records and revocation (digest-only, own sqlite beside the conversation db), the four materials are separated, every request is checked with no cached success, and the declared revocation bound for an attached stream is one re-check interval (1000 ms by default). Routes and limits: [client ingress](../../docs/client-ingress.md). Cutover is ticket 16.
- 15: the App is a real Tauri v2 shell — it holds this install's connection in the OS credential store, names the
  configured Gateway origin in the window CSP before the window exists, and injects the connection into the page at
  document start; a first run renders a configuration surface and storing one restarts into it. `build-artifacts.mjs`
  produces the static Web build, the `.deb` and a provenance record (revision, host, target, toolchain, checksums,
  per-step logs) plus a measured reproducibility comparison — byte-identical executable, package container differs
  because the bundler writes its own time. `verify-artifacts.mjs` asserts against the produced package, including two
  cold starts, the fixture Gateway seeing the descriptor request with `Origin: tauri://localhost` and the stored bearer,
  and the first-run form driven through the real window. No mobile artifact exists: Android has no SDK, `adb` or
  device on this host, and **none will be built** — the user withdrew Android as a delivery gate on 2026-10-19, so this line is
  a recorded absence rather than a blocked requirement; the record stands as it was measured and is not retrospectively
  upgraded. A system `dpkg -i` install no longer needs root as a *limit*: since ticket 16's 2026-10-19 closeout a real dpkg
  transaction runs as root of a throwaway tree in an unprivileged user namespace (44/44 assertions, with its `PATH` defect
  fixed at `offline-install.mjs:35`), which is why this bullet's last sentence changed rather than being deleted. Guide:
  [apps/app](../../apps/app/README.md); evidence: [verification](../../docs/verification.md#app-shell-and-packaged-artifacts-ticket-15).
- 04: the desktop target is evidenced on real WebKitGTK 4.1 in a real Tauri v2 shell — SSE arrives incrementally, a dropped stream ends silently so recovery must key on the protocol, the page origin `tauri://localhost` makes every gateway cross-origin and CSP-bound, WebKitGTK rejects streamed request bodies, whole WebView chunks cost ~3 GB peak RSS across IPC while 1 MiB slices cost ~225 MB, and the OS credential store round-trips across processes. Android was unevidenced (no SDK, `adb`, device or emulator on this
  host) and the user withdrew it as a delivery gate on 2026-10-19, so no mobile artifact exists and none is promised — this
  line records the measured absence rather than upgrading it retrospectively. Report and reproduction: [ticket 04](issues/04-tauri-platform-spike.md#report), [spike](../../spike/tauri-platform-04/README.md).
- 06: the catalogue row now states its workspace's binding facts — `gatewayId`, the recorded `root`, the `retained` marker and the Project group it belongs to — beside the Backend's own `sessionListVersion`, so a session list is one catalogue read plus one workspace read with no per-conversation read and no second derivation of the version. A configured workspace's host-reported root still comes from `GET /api/workspaces`, once per list. A conversation bound before a Project removal or a folder unlink keeps its workspace, host and root. Behaviour: [Projects](../../docs/projects.md) and [Chat](../../docs/chat.md); evidence: [verification](../../docs/verification.md#catalogue-project-binding-and-host-selection-ticket-06).
- 12: skills, installations and agent definitions are reachable through the client ingress, and the client seam is
  `packages/session/src/execution-resources.ts` — one connection scope, the repository reads, and a `select(workspaceId)`ed
  target whose disposal retires its answers (an inventory that arrives after the selection moved is `disposed`). **No
  request names a computer**: an operation names a workspace, the Backend resolves its binding, and the entry's stated
  default host cannot override a Project's recorded one. The Web `/api/agent-definitions` proxy stopped reading workspace
  and project listings to pick a gateway id (G3), so the two entries cannot disagree about which computer a definition
  lives on. Host-side contracts, refusals (`unreachable_host`, `confirmation_required` + state, `conflict`,
  `unsupported_capability` + field, `outcome_unknown`), adoption as a second outcome and the upstream provenance records
  are unchanged. Behaviour: [client ingress](../../docs/client-ingress.md#execution-side-resources-skills-installations-and-agent-definitions);
  evidence: [ticket 12](issues/12-execution-side-resources.md#answer). The shared workbench reads through this seam too,
  and its selection-lifecycle review fixes (StrictMode replay, a superseded read's completion state, a Project add pane's
  off-selection target, a late definition read) are merged at `e5a9d18` and re-run on the integration tree. The committed
  browser regression drives one arrival order independently; the other order and the StrictMode replay are covered by
  the reviewer's development-React checks and `packages/ui/src/lib/workbench-scope.test.mjs` respectively, which is what
  the ticket now states.
- 01: release envelope fixed in [spec](spec.md#release-envelope) — target capability list, four separated identities (client ingress, Backend, execution Gateway, SSH profile; cwd is not authorization), first desktop Linux x86_64 on workstation with WebKitGTK 4.1 and Tauri v2, Android as the mobile candidate, Vite static Web on the client-ingress origin with a direct cutover, and the ticket-17 deletion scope. The then-missing Tauri CLI and the still-missing Android SDK blocked ticket 04's evidence, not the target choice; the desktop half is now evidenced through the project's own `@tauri-apps/cli` 2.12.3 (tickets 04/15), Android remains unevidenced.

- 11: the settings route contract, the scoped settings cache and the settings panels' connection routing are adapted onto
  the shared-client tree `47ec8f0` rather than merged from the historical branch, because ticket 05 had already moved
  React out of `apps/web`. The Backend-owned settings (`models`, `models-config`, `extensions`, a
  conversation's own settings/extensions) are forwarded unchanged, and the routes no owner serves answer `501` `code:
  "unsupported"` before forwarding so a panel reads a named limit instead of `404 conversation not found`. The scope rule lives
  once in `@hepi/session/settings`, the workbench's catalog cache is that rule, and every panel read/write goes through
  `WorkbenchClient` (a fixture that mounts one panel outside a workbench falls back to its own origin), so an App asks the
  Gateway it was admitted to with its own bearer; the panels were driven in real Chromium against a real ingress, and the
  push capability probe is the one request that stays on the page's own origin. The composer's own catalogue read
  (`useAgentSession.loadModels`) is now on that same connection and on the scoped cache: it reads `/api/models` through
  `WorkbenchClient` and holds the answer under the connection's scope plus the folder, so a switch reads the new
  connection's catalogue instead of the previous one's, and the shared read's lifecycle is the connection's (a StrictMode
  replay or another composer's exit cancels nothing; disposal aborts and fences it). What remains is the Web/App entry
  cutover (ticket 16). Routes:
  [client ingress](../../docs/client-ingress.md#settings-over-the-client-api-ticket-11).
- 10: the conversation control surface is reachable through the client ingress and called through `packages/session/src/control.ts` — stop/continue, the queue (steer, follow-up, per-item edit and cancel, recall), fork, delegation (both a new child and a dispatch to an existing conversation), references, rename and removal. One lost-answer rule covers all of it: no answer is an unknown outcome carrying the attempt's request id, resolved by asking the conversation about that id and never by resending. React consumers belong to 05 and the removal of the old adapter paths to 17. Routes and limits: [client ingress](../../docs/client-ingress.md#conversation-control-queue-fork-and-relations).

- 09: the page's one terminal stream is read with `fetch` instead of `EventSource`, so the Web page's httpOnly cookie
  and an App's device bearer are one reader: the cookie branch states nothing and the bearer branch sets one header, and
  neither can put a credential in a URL. The stream belongs to the connection (origin + credential + fetch, one value a
  surface compares by identity), so a switch closes it and opens the next one instead of carrying a tab's cursor into
  another scope; releasing the last tab aborts the request rather than leaving the browser to retry. The Backend relay,
  its multi-host merge, open/write/resize/close, per-tab cursors and the retained tail are unchanged. One transport bug
  is fixed where it belonged: the ingress proxy and the Backend relay buffered response headers until the first byte, so
  a continuation with nothing to replay waited for the next keepalive. Behaviour: [client ingress](../../docs/client-ingress.md#the-terminal-fan-in).

## Execution

01 → 02 → 03 → 04 → 05 establishes the contract, credential path, working conversation, native evidence and shared UI. After 05, independent capabilities 06–11 and 14–15 may proceed in parallel. 12–13 depend on 06 for the host/project mapping they use. 16 validates all selected capabilities from fresh state and switches directly; 17 removes replaced implementations and verifies the deletion revision.

Ready means every Blocked by issue is resolved. Claim one ticket before implementation; use targeted source navigation and current checks. A missing device/signing/toolchain is an explicit blocker on the agreed target, not evidence of support. 04 is an investigation with a bounded native spike; abandoned experiments are removed.

The 17 tickets cover the complete selected architecture migration, not the feature-ideas backlog. Acceptance follows the selected target capabilities; existing code is a reuse/deletion reference, not a blanket promise to preserve old behavior or URLs. UDS, direct host paths, offline sync and universal background push remain non-blocking records outside this plan.


## 追加阶段 F — UX 收口（批准于 2026-10-19）

原 01–17 保持既有实施/验收顺序，新增工作在 17 后；当前领域票可继续并行，不因这些追加项重开已交付票。

| Ticket | Outcome | Blocked by |
| --- | --- | --- |
| [18](issues/18-web-logout-contract.md) | 当前 cookie logout 合同与宿主动作 — **complete** 2026-10-19, branch `fix/client-app-18-logout` | 17 |
| [19](issues/19-app-connection-recovery.md) | App 拒绝连接→配置/断开→重新 admit — **complete** 2026-10-19: 拒绝面按 credential/unreachable 分状态给出可键盘操作的 Configure/Disconnect/Try again，替换在旧连接之上打开且 Cancel 保留，packaged 验收 54/54 | 17 |
| [20](issues/20-native-file-save.md) | bearer native bounded save，上传保持已有能力 — **implemented** 2026-10-19; the packaged native save journey was not re-run in that round | 17 |
| [21](issues/21-read-and-navigation-recovery.md) | 会话/入口读失败的可见恢复面 — **complete** 2026-10-19 (`ReadFailurePanel` plus the hook's read-failure state) | 17 |
| [22](issues/22-ux-system-acceptance.md) | 最终 Web/App/历史/Provider/MCP/SSH/reference 用户流程 | 18–21 及各领域追加验收，完整链接在本票 |

[跨 spec 执行图](../ux-closeout-research/spec.md) 是跨领域排程入口；各领域 spec 保持行为唯一 owner。相同 AppShell、Settings、file-seam 的写入需协调集成，领域 runtime 可并行；不以新增票形成新的认证、历史或 durable 状态层。

## Stage G - Pilo simplification

[研究依据](../../docs/research/pilo-simplicity-review.md)。17显式覆盖旧app/adapters/vendor的消费者退役矩阵；目录库存不等于净删除承诺。以下票在17后按路径并行，与18–22协调共享文件，不反向阻塞现有UX或领域交付。

| Ticket | Outcome | Blocked by | Status |
| --- | --- | --- | --- |
| [23](issues/23-remove-unused-settings-reader.md) | 删除无产品消费者的SettingsReader及专属测试，保留真实cache合同 | 17 (runtime retirement delivered; residue non-blocking) | **complete `7345384`** — `ModelCatalog`/`SettingsReader`/`createSettingsReader` and their dedicated test case/import are gone; `createScopedCache` keeps the scope/in-flight/invalidation/TTL/bound contract |
| [24](issues/24-require-connection-backed-requests.md) | 产品请求统一connection；fixture提供provider，移除旧page-origin fallback | 17 (runtime retirement delivered; residue non-blocking) | **complete `7345384`** — `pageOriginRequest` and the five fallbacks are gone; the shared seams ask `useWorkbenchConnection().client.request`; the optional Markdown/file seams refuse `unavailable` when no connection is mounted, and only the Web host's sign-in and public probes keep the page's `fetch` |
| [25](issues/25-share-conversation-api-per-connection.md) | ConversationApi由connection建立一次，六个消费者共享 | 17 (runtime retirement delivered; residue non-blocking) | **complete `7345384`** — `workbenchConnection(client, identity)` assembles client, scope, identity, file seam and API once; 15 fixtures use it and eight surfaces read `connection.api` |

完整历史目录与bounded hydration继续由history-navigation spec拥有。保留FileSeam与durable projection/acquisition/cache的职责；descriptor probe合并不纳入本批。净减行按最终diff报告，38行仅为23的研究估算。
