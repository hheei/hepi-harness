# 07: Web 主机单目录 New Project

**What to build:** 用户在 Web 主机选择任意已有目录与展示名称，创建持久 Project 并以该目录启动可实际执行工具的新对话。

**Blocked by:** None (can start immediately within the authorized dispatch phase)

**Status:** implemented, verified — merged as 1bda245; New Project driver re-run on the merged tree (no human acceptance claimed)

**Dispatch phase:** B — features after 01–04 are verified

**Stories:** 10, 12, 14, 16

- [x] 目录选择/校验使用实际 Web 主机执行账号；Web、后端与 gateway 分离时不把默认后端 Workspace 当成本地主机。
- [x] 创建 Project 仅保存身份、展示名称及已选目录，不创建或重命名 filesystem 目录。
- [x] 目录的单根 Workspace 注册/恢复与 Project 元数据生命周期明确；刷新和服务重启后仍可创建并执行对话。
- [x] 通过真实管理/对话 API 与受控工具检查文件读取位于所选目录，既有 Workspace 和会话不受影响。
- [x] 任意主机目录浏览和运行时注册目前缺接口：实现前说明具体扩展/复用方案，复用现有 gateway/Execution Environment，先交付单目录完整路径。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). For the native runtime/integration contracts, read [framework evidence](../framework-fit.md).

## Comments

**Contracts disclosed before implementation.** The two missing interfaces were reported with source evidence and
resolved with the parent before any code was written: the gateway had no arbitrary host directory listing (every file
RPC is confined to a workspace root, `packages/gateway/src/filesystem.ts`), and no runtime workspace registration
(the four surfaces each held a boot-time copy). Decisions taken: the Web host is **named**, never inferred from the
backend's default workspace or a container directory; the workspace id is opaque and independent of the path; project
metadata lives in its own `projects.sqlite` next to `HEPI_DB` and stores no gateway token.

**Delivered.**

- Gateway: one shared `WorkspaceRegistry` now backs execution, filesystem, installation and workbench, and
  `POST /v1/workspaces` lists, registers (`workspace_conflict` for an id already used with another root; idempotent
  for the same id and root) and browses the gateway's own account's directories read-only. The environment's workspace
  is seeded unchanged.
- Backend: `GET/POST /api/projects` and `GET /api/host/directories`; the backend resolves the `hostId` a Web origin
  names against the gateway connections the deployment configured (`HEPI_GATEWAYS`, or the single `HEPI_GATEWAY_*`
  triple); conversations resolve a binding through the configured workspaces or a recorded project. A host that is
  offline is reported on its own project and never redirected; an unnamed or unknown `hostId` answers
  `configuration_required`.
- Web: the sidebar's "New Project…" dialog (name + folder chosen from the host's directories, host account named,
  no directory creation), the project's display name in the sidebar, and `/api/projects` + `/api/cwd/browse` proxied
  through the Web origin — which sends **its own** `HEPI_WEB_LOCAL_GATEWAY_ID` as `hostId`, so the browser holds no
  gateway URL or token and one backend can serve several Web origins on different computers.
- Recovery: the backend re-asserts a project's root on its host, idempotently, whenever it builds that conversation's
  execution environment, so an already-bound conversation keeps running in its own folder after the gateway alone
  restarts — no new conversation, no user action, and no repetition of any request whose outcome was unknown.

**Evidence.**

- `packages/gateway/test/workspaces.test.ts` (3 tests) and `apps/server/test/project.test.ts` (6 tests) pass:
  registry validation/idempotence/conflict, host browsing, one registration served by execution + files + workbench,
  tool execution inside the chosen folder, an existing workspace conversation keeping its own root, a backend restart, a
  gateway restart with the backend still running and **no** new conversation, an offline host, the configuration error,
  and two Web origins on one backend each browsing and creating only on the host each named.
- `apps/web/e2e/ux-new-project.mjs` passes (28/28 checks) against the real production UI, a real backend process, a
  real gateway process and a controlled OpenAI-completions endpoint: the dialog names the resolved account, the folder
  is chosen from the host's own directories, the first conversation runs `bash` and `read` in that folder and nowhere
  else, the existing conversation keeps its binding, a page reload plus a backend **and** gateway restart keep the
  project and its binding, and a gateway-alone restart still runs that conversation's tools in the same folder. Run
  `pnpm --filter @hepi/web build` first.
- Docs: `docs/projects.md` (Web-process `HEPI_WEB_LOCAL_GATEWAY_ID`, backend `HEPI_GATEWAYS`, endpoints, behaviour)
  and `docs/adr/0003-projects-bind-runtime-registered-workspaces.md` (the named-host, runtime-registration and
  re-assertion decisions).
