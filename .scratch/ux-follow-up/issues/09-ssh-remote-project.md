# 09: SSH New Remote Project

**What to build:** 用户选择 SSH 执行主机及该主机上的已有目录，创建命名 Project，并从 default 创建能实际读取远端文件的对话。

**Blocked by:** 08: 同一主机多目录 Project 与 default

**Status:** implemented, verified and merged — merged into `integration/ux-follow-up` as d158de3; combined verification at 3c8b478 (gateway 65, server 125, SSH browser driver 31 ok over a real localhost `sshd`). See the implementation report and the pre-implementation adaptation report below

**Dispatch phase:** B — features after 01–04 are verified

**Stories:** 11, 13, 14, 16

- [x] 复用 Project 多目录/default 流程与既有 SSH gateway/runner；标签展示真实目标账号/主机。
- [x] SSH 目录浏览、profile/Workspace 注册及恢复完整接通；新目录复用同一执行体系，兼容现有 client/profile/Workspace 身份契约。
- [x] 本地、后端和远端放置不同内容的同名路径，真实 SSH fixture 中只能执行选定远端路径。
- [x] 远端 global 技能身份沿用远端执行账号；不可达/权限错误据实呈现，不改用 Web 或后端目录。
- [x] 实现前报告当前固定 profile/根注册限制的具体适配方案；只支持当前 SSH 平台，不引入跨平台执行抽象或 live 部署。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). For the native runtime/integration contracts, read [framework evidence](../framework-fit.md).

## Comments

### Implementation (delivered)

`eb9aefd` on `impl/ux-follow-up-09`. All five acceptance criteria are met; the pre-implementation report below is the
adaptation that was implemented, at the seams it named.

| Criterion | Where it is served |
| --- | --- |
| Reuse the multi-folder/default flow and the existing SSH gateway/runner; labels show the real target account/host. | The Project flow is unchanged (one host, several folders, one default); `SshWorkspaceServer` reports the account the host itself resolves, and the dialog renders it (`newProject.remoteHost`). |
| SSH directory browsing, profile/workspace registration and recovery wired end to end; a new folder reuses the same execution system; existing client/profile/workspace identity contracts hold. | `browse`/`register`/`profiles` on the existing `/v1/workspaces` over the existing `SshRunner`; one shared `WorkspaceRegistry` and `workspaceOwner` behind execution, files, installation and management; `remote-<profile>` and the CLI's custom-id refusal are untouched. |
| Same-named paths with different content locally, on the backend and on the remote host: only the chosen remote path executes. | `apps/server/test/ssh-project.test.ts` and `apps/web/e2e/ux-ssh-project.mjs`, both over a real localhost `sshd`: the remote copy of `note.txt` is what `read` returns, the local copy is untouched, and a path that exists only beside the backend process is refused. |
| Remote global skill identity follows the remote execution account; unreachable/permission errors are reported truthfully, never swapped for the Web or backend directory. | The file and installation surfaces already resolve the account on the host (ADR 0002) and now resolve the root through the same registry; a host without Python 3 reports `not_supported` and an unreachable one `unreachable`/`gateway_offline`, with no local fallback (asserted in the gateway and backend tests). |
| Report the adaptation before implementing; current SSH platform only, no cross-platform execution abstraction, no live deployment. | The report below; the change is additive at existing seams, and every test runs against a real local `sshd`. |

Deliberately out of scope, recorded rather than stubbed: **remote workbench** (files/changes/diff stay local-only),
**Python 3 on the SSH host** (a hard requirement of the helper, reported as `not_supported` when absent), and any
**cross-platform execution abstraction**.

Verification: `pnpm -r typecheck` 6/6; `pnpm -r test` protocol 15, client 9, session 3, gateway 65, server 123 (0
fail); `node apps/web/e2e/ux-ssh-project.mjs` 30 checks pass over the real `sshd`; `ux-new-project`, `ux-visible-turns`,
`ux-terminal-close` and `ux-token-footer` still pass. See [validation.md](../validation.md#ticket-09--ssh-new-remote-project).
### Pre-implementation adaptation report (required by the last acceptance criterion)

Base: `impl/ux-follow-up-09` at `2036d6a` (integration with 08 `cc22f75` + 10 `2036d6a`). Line numbers are that tree's.
Policy: [review policy](../../../docs/agents/review-policy.md) (parent `7262f85`); findings triaged by impact, theoretical ones recorded in
[review-notes.md](../review-notes.md), not patched.

#### The limiting sources, verified

| Limit | Source |
| --- | --- |
| One fixed SSH profile, built from env | `packages/gateway/src/main.ts:20-23`: `{[HEPI_SSH_PROFILE ?? "loopback"], host: HEPI_SSH_HOST, remoteRoot: HEPI_WORKSPACE_ROOT, port?, identityFile?, knownHostsFile?}`; stored in a `ReadonlyMap` (`index.ts:363-372`). `SshProfile` (`index.ts:63`) carries **one** `remoteRoot`. |
| Workspace → profile resolved by string-prefix parsing, three times | `index.ts:419-421` (execute), `ssh-filesystem.ts:80` (files), `install.ts:727` (installs): `workspaceId.startsWith("remote-") ? slice("remote-".length) : ""` then a profiles `get`. |
| Every SSH surface pins `profile.remoteRoot` | `index.ts:380,402-403`; `ssh-filesystem.ts:84,139,144`; `install.ts:774`. |
| SSH gateway serves **no** workspace admin | `main.ts:40-41` and `packages/client/src/gateway.ts:45-46`: `profiles ? undefined : new WorkspaceServer(...)`; `GatewayWorkbench` likewise local-only. `GatewayRpcServer` answers `operation_failed` when that surface is absent (`index.ts:474-479`), and the backend already POSTs it (`apps/server/src/server.ts` `hostRequest` → `/v1/workspaces`). |
| Python 3 on the SSH host is a hard dependency of the remote helper | `ssh-filesystem.ts:348`, `install.ts:779`: exit 127 / `python3: command not found` → `not_supported`. Not optional, and not to be claimed optional. |
| The backend is already gateway-agnostic | `apps/server/src/main.ts` `configuredGateways()` parses `HEPI_GATEWAYS` `{id,url,token}` → `{gatewayId,gatewayOrigin,gatewayToken}` (`server.ts:24`); `webHostOf` (`server.ts:286`) validates a Web-named gateway id; project folders re-register through `ensureBinding` (`server.ts:320`). |

#### The adaptation (minimal, at the existing seams)

1. **One explicit SSH owner, no prefix parsing.** `WorkspaceConfig` gains an optional `profileId`. An SSH gateway seeds its registry with
   `{ id: "remote-" + profileId, root: remoteRoot, profileId }` (the legacy id and CLI contract are unchanged), and one exported resolver
   `sshOwner(registry, profiles, workspaceId) → { profile, root, profileId } | undefined` replaces the three prefix slices in
   `SshGateway`, `SshFilesystem` and `SshInstallServer`. A runtime-registered folder gets an **opaque** id and its own
   `{ profileId, root }` entry, so *all three* surfaces serve it at once. No colon splitting, no prefix guess, no default-to-first
   profile: an id that names no entry is `unknown_workspace`, exactly as today. `packages/client/src/config.ts:173-177`
   (custom SSH workspace id rejected) and `remoteWorkspaceId` stay as they are.
2. **Remote workspace admin on the existing `/v1/workspaces` route.** Additive `WorkspaceRequest` operations: `profiles` (id, host,
   remoteRoot, the account the host itself reports) for the target list, `browse` (read-only directory names over the runner) and
   `register` (must already exist remotely — canonicalize via the runner; never mkdir/rename). Implemented as one small
   self-contained program over the **existing** `SshRunner` (the pattern `install.ts:410` already uses for its remote helper), so the
   file helper's root confinement stays untouched. A host without Python 3 or an unreachable/permission-refused host reports
   `not_supported` / `unreachable` / its own error — never a Web- or backend-side directory.
3. **Project metadata records the host's profile.** `projects` gains **nullable** `profile_id` (additive `ALTER TABLE ADD COLUMN`,
   no rebuild — local projects stay `NULL`; the 08 single-folder rebuild path is untouched). A project is still one computer: one
   `host_id` plus one `profile_id` for all its folders.
4. **Remote selection is explicit and configured.** `GET /api/hosts` returns the configured gateways and, per gateway that serves
   SSH, its `profiles` with the real account and host — ids and names only, never a URL or token. The New Project dialog offers
   Local (its `HEPI_WEB_LOCAL_GATEWAY_ID`, unchanged) or a Remote target (`{gatewayId, profileId}`) chosen from that list.
   `POST /api/projects` accepts the same `folders: [{root, default?}]` plus the chosen `profileId`; each root is validated on the
   named remote host and registered under a fresh opaque uuid. The Web adapter forwards the chosen `hostId` verbatim (the backend
   validates it against its configured gateways, as it already does); `HEPI_WEB_LOCAL_GATEWAY_ID` keeps meaning *this origin's
   local* host only. `GatewayWorkbench` stays local-only for SSH (no remote workbench requirement in this ticket) — recorded.

#### Test seams (TDD, real public paths)

Real localhost `sshd` fixture, reused from `packages/client/scripts/smoke-pack.mjs:207-290` (own host key + key pair, pinned
known-hosts, absolute `AuthorizedKeysFile`, ephemeral port, `AllowUsers <current user>`, `StrictModes no`) — **not** the
`pythonSshRunner` mock.

- Gateway integration over the fixture: the owner resolver (legacy `remote-<profile>` and an opaque registered id both resolve; a
  prefix that was never registered does not); `SshFilesystem` and `SshInstallServer` serve a runtime-registered root at the same
  time as `SshGateway`; remote `browse` lists real remote directories and `register` refuses a missing path; no-Python-3 →
  `not_supported`.
- Backend `apps/server/test/project.test.ts` style: create a remote project (opaque ids, one default), a remote read/exec lands in
  the chosen remote folder, re-registration after a bare gateway restart and after a backend restart, unreachable host reported
  truthfully and never falling back to the Web/backend directory, and a default change leaving the old binding untouched.
- Browser `apps/web/e2e/ux-ssh-project.mjs` (own `.next`, ports 43109 Web / 44109 backend, fixture sshd): the user picks a remote
  target, sees the real remote account/host, browses real remote directories, creates the project, and the first conversation
  reads and executes only the remotely-placed same-named file while the local and backend copies of that path are proven different;
  all new-session affordances bind the remote default; recovery across a gateway and a backend restart. A two-profile fixture proves
  the chosen profile is the one that runs.

#### Essential-shape points raised for confirmation

A. nullable `projects.profile_id` (schema), B. new `GET /api/hosts` endpoint, C. additive `profiles`/`browse`/`register` SSH
operations on `/v1/workspaces` with a separate remote helper program, D. `profileId` accepted by `POST /api/projects`. Each is
additive to an existing seam; none changes the conversation binding contract or the legacy `remote-<profile>` identity.
