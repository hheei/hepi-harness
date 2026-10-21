# 05: 管理 Execution Host 上的代理定义

**What to build:** 用户在 Settings 选择真实本地/SSH Execution Host，以表单或原文创建、验证、保存和删除 project/user Agent Definition；读取和写入始终发生在该主机。

**Blocked by:** None (can start immediately)

**Status:** resolved

**Labels:** ready-for-agent

**Spec:** [D02](../spec.md#d02)、[D10](../spec.md#d10)、[D11](../spec.md#d11)、[D12](../spec.md#d12)、[D15](../spec.md#d15)；[验收 A12、A13、A15](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] 通过可选扩展宿主 adapter 的 GET/PUT/DELETE agent-definitions 及受限 gateway 资源接缝实现整份 Markdown CRUD；backend 解析，Web 不读写目标主机的替代本地目录。
- [x] 按结构化 host/workspace/scope/name 定位，project 同名覆盖 user；user 根来自所选 Execution Host 声明的 agentDir。离线/不可达明确失败，不 fallback 到 Web/backend 主机。
- [x] PUT dryRun 与保存共用已知字段/实际能力校验；dryRun 不写盘，保存采用原子替换和整文档 last-write-wins；表单保留未知 frontmatter 与未编辑正文/字段。
- [x] 提供 name/description/model/thinking/tools/context/instructions 的完整解析结果与来源身份；已知无效或不能执行的 tools/MCP/extensions 明确拒绝，不静默过滤。
- [x] 配置决定上下文策略；用户编辑可选 fresh/fork/compact/已注册策略，模型派活不获得覆盖入口。此票交付配置与校验，实际 durable 准备由06/10负责。
- [x] 创建时可固定完整 effective configuration，不依赖父配置的部分继承；改删定义不改变已有会话快照。
- [x] Settings 的能力显示与保存错误可解释；不借机恢复已退休的第二套 Web runtime 或其他未服务 Settings。

## Delivered

Backend (handler-only; coordinator wires the route):

- `apps/server/src/agent-definitions.ts` — pure parse/validate/serialize. Known fields
  `name/description/model/thinking/tools/context/enabled` + body instructions; the context strategies are exactly
  `fresh/fork/compact` (default `fresh`); an unknown tool, an `ext:`/`mcp:` tool selector, an `mcp_servers` /
  `extensions` / `plugins` / `hooks` key, an unknown context strategy or an invalid thinking level is refused with its
  field and code. Unknown frontmatter is preserved on a round trip. `buildEffectiveAgentConfiguration` fixes every
  field explicitly (`model`/`thinking` as `null` when unnamed) so a child never inherits part of a parent.
- `apps/server/src/agent-definitions-store.ts` — host storage over `ExecutionHostEnv.agentDefinitions`. Identity is
  `host/workspace/scope/name`; the user root is the host's own `agentDir` and the project root is
  `<workspaceRoot>/.pi/agents`. `project` overrides `user` by name (the user file is returned as `shadowed`). A write
  stages in the target directory and renames over the target (atomic, last-write-wins). An unreachable host throws
  `host_unreachable`; there is no local fallback.
- `apps/server/src/agent-definitions-http.ts` — `createAgentDefinitionsHandler({ resolveHost, readBody })` returning
  `(request: IncomingMessage, url: URL) => Promise<{status, body} | undefined>` for `/api/agent-definitions`
  (GET list, GET document, PUT with `document` or `fields` + `dryRun`, DELETE).

Gateway (`packages/gateway/src`):

- `ExecutionHost.agentDir` is now part of the host answer (local `executionHost()` and the SSH helper `discovery()`).
- `FileRequest.resource: "agent-definitions"` opens exactly the project and account agent directories on both the local
  and SSH filesystems: reads are authorized against them, and mutations are confined to them (a new
  `confineAgentDefinition` locally; `ALLOWED_WRITES` with a boundary in the remote helper).
- `ExecutionHostEnv.agentDefinitions` exposes `listDir/readTextFile/writeFile/createDir/renameFile/remove/exists`, each
  tagged with the capability so the backend cannot reach any other host path.

Web:

- `apps/web/adapters/agent-definitions.ts` + a branch in `app/api/[...path]/route.ts`: the routing workspace id for
  `cwd` and the **gateway that owns that folder** (`workspaceOwnerOf`, resolved from the deployment's own workspace and
  project listing) are added, and the backend answer (status + reason + issues) is forwarded unchanged. A folder with
  no recorded owner is a `configuration_required` refusal instead of an assumption about this origin's own host.
- `apps/web/lib/agent-definitions.ts` and a rewritten `components/AgentsConfig.tsx`: form (name, description, model,
  thinking, tools, context, enabled, instructions) and raw-document modes, Validate (dryRun), Save, Delete, scope
  selector on create, and a rendered issue list. Effective and shadowed definitions are both listed, the shadowed one
  is marked and still editable, the raw document names its own file, a form create sends the form's fields, and no
  model-side override exists.
- `apps/web/README.md` and `docs/local-integration.md` document the surface and the host contracts; the i18n strings
  the surface shows are retargeted from the retired sub-agent profile wording in `en`, `zh-CN` and `zh-TW`.

## Verification (recorded 2026-10-16, local workstation, after merging integration 455b714)

- `pnpm --filter @hepi/gateway typecheck` — exit 0
- `pnpm --filter @hepi/server typecheck` — exit 0
- `pnpm --filter @hepi/web typecheck` — exit 0
- `pnpm --filter @hepi/{gateway,server,web} typecheck` — exit 0 each.
- `apps/server`: `node --test test/agent-definitions.test.ts test/agent-definitions-http.test.ts test/agent-definitions-route.test.ts`
  — **24/24 pass** (including four through `createBackendServer`'s HTTP route and local/SSH GatewayRpcServer instances;
  the SSH filesystem runner executes Python against a separate temporary account/root directory. This route fixture
  covers HTTP binding and host isolation; the browser gate below supplies actual sshd transport). Covers dryRun
  no-write, atomic save, project>user with the user copy reported as shadowed, unknown-frontmatter retention through a
  form save, unsupported-capability refusal, `wrong_host`/`unknown_workspace`/missing-workspace refusals and an
  unreachable host as 503 with nothing written on either machine.
- `packages/gateway`: `node --test test/sshd-fixture.test.ts test/ssh-workspaces.test.ts test/resource-snapshot.test.ts
  test/ssh-filesystem.test.ts` — 21/21 pass, and the earlier seam set (`filesystem`, `resource-snapshot`,
  `ssh-filesystem`, `ssh-resources`, `ssh-session`) 59/59, so the new resource seam and the fixture's scoped `home`
  option regress nothing.
- `apps/web`: `node --test adapters/agent-definitions.test.mjs` — 5/5 pass (owner resolution from the deployment
  listing, remote Project addressed on its own gateway, forwarded refusal with its issues, missing-workspace refusal).
- **Browser gate** (the ticket's public seam): `pnpm --filter @hepi/web build && node apps/web/e2e/ux-agent-definitions.mjs`
  — exit 0, every check passing, on a real local execution host **and** a real `sshd` over loopback, through the
  production Next build, the backend process and the gateway process. Each journey creates a Project from that host's
  own directory picker, then: a definition created from the form lands in the host account's own agent directory; the
  real `~/.pi/agent/agents` receives nothing (asserted); a dry run writes no file; the same name in the project scope
  is effective while the user one is shadowed and still listed; the project document lives in the project folder (a
  path this machine does not have on the SSH host, because the sandbox mounts its own filesystem); a raw document's
  unknown frontmatter field and its body survive a later form save; an unsupported capability is refused with nothing
  written; a save with the host stopped shows the backend's own unreachable reason and writes nothing; and the delete
  removes the file from the host. The run prints 41 checks and `UX-05 agent definitions regression passed`.
- `node scripts/verify.mjs --profile=changed --base=integration/durable-subagents` — workspace-typecheck, workspace-tests
  (`pnpm -r test`, every package), web-unit, script-tests and check-entrypoints PASS; check-docs FAILs only on the
  pre-existing 12 broken `.scratch/` links (the same 12 ticket 03 measured against pinned 2197a18, none in this
  ticket's files).

## Mounted route

- `server.ts` mounts the handler on `/api/agent-definitions` (a prefix guard, before the conversation fallback) and
  builds it with `readBody` plus a `resolveHost` that binds the routing workspace and confirms the named gateway. The
  workspace binding is the authority on the host, so a Project folder on an SSH gateway is served there; the ticket-04
  read route is untouched beside it.
- The Web adapter resolves the routing folder's owning gateway from the deployment's own listing
  (`workspaceOwnerOf`, `apps/web/adapters/durable-api.ts`) instead of assuming `HEPI_WEB_LOCAL_GATEWAY_ID`: a remote
  Project is addressed on the remote gateway, and a folder with no recorded owner answers `configuration_required`.
- Two defects the browser gate found and this ticket fixed: a form create sent the raw editor's empty document instead
  of the form's fields, and the sidebar listed only effective definitions, so a shadowed definition could not be
  selected, edited or deleted (and the `Overridden` marker sat on the wrong row).
- The settings section is labelled Agents (`common.agents`), and the `agents.*` strings the surface shows were
  retargeted from the retired sub-agent profile wording in all three locales.
- `packages/gateway/test/sshd-fixture.ts` gained an optional `home` for a fixture whose SSH account home must be
  scoped: a private directory is mounted at the passwd home inside the sandbox, so a real-sshd test can exercise the
  account's own `.pi/agent` without touching the real one.

## Repair (branch `fix/durable-agent-definition-tools`, base `b912955`)

The tool vocabulary this ticket shipped named seven tools while the deployment installs four. `AGENT_DEFINITION_TOOLS`
was `["read","bash","edit","write","grep","find","ls"]`, but the installed `coding-tools` extension carries only
`read`, `write`, `edit` and `bash` (`@earendil-works/pi-durable/dist/tools/index.js`), and nothing installs
`powershell`, `codemode` or `tool-search` (`apps/server/src/harness.ts:101` installs `environmentCodingTools()` and
the optional resource extension, nothing else). The runtime's `filterTools` drops a name it cannot resolve, so a
definition naming `grep` validated, saved, and then ran with a smaller loadout than it stated — silent capability loss
on an ordinary save, exactly what acceptance criterion 4 forbids.

Fixed by reading the vocabulary from the extension that carries it instead of repeating a list:

- `apps/server/src/agent-definitions.ts` — `AGENT_DEFINITION_TOOLS` is now
  `(CodingTools.tools ?? []).map(tool => tool.name)`, so the accepted set is the installed set and cannot drift.
  `grep`/`find`/`ls` are refused as `unknown_tool` (field `tools`), not mapped to aliases and not added as tools.
- `apps/server/src/agent-definitions-http.ts` — the list answer states `capabilities: { tools, thinking,
  contextStrategies }` from those same constants, so the offered vocabulary and the validated vocabulary are one list.
- `apps/web/lib/agent-definitions.ts` + `components/AgentsConfig.tsx` — the panel's checkboxes, thinking levels and
  context options come from `capabilities` on the list answer (`capabilitiesOf`), with the same four tools as the
  fallback. The panel no longer hardcodes a second, stale list.
- Unknown-frontmatter preservation, atomic whole-document save, dryRun, scope precedence and the refusal codes are
  unchanged.

### Repair verification (2026-10-16, worktree `durable-subagents-05`)

Committed as **`599a854`** on `fix/durable-agent-definition-tools`, based on `b912955` (the 05 branch `948f183` is
preserved untouched). Every command below ran on the working tree that became that commit; `599a854` differs from it
only by this evidence section.

Raw logs in `/tmp/fix05/` (`typecheck.log`, `server-tests.log`, `web-unit/`, `script-tests.log`, `entrypoints.log`,
`docs.log`, `build.log`, `e2e.log`, `verify.log`, `red-tools.log`).

- Red first: with only `apps/server/src/agent-definitions.ts` reverted to the old constant and the new tests in place,
  `node --test test/agent-definitions.test.ts test/agent-definitions-http.test.ts` → **18 pass / 5 fail**
  (`/tmp/fix05/red-tools.log`), naming the installed-tools test, both `local:`/`ssh:` HTTP cases and both
  "does not install" cases. Restoring the fix → **23/23 pass** for those two files, and **27/27** over all three
  definition suites (`test/agent-definitions.test.ts`, `-http`, `-route`) — the file count grew from the ticket's
  original 24 because the parameterized `local:`/`ssh:` refusal case is one test per fixture.
- `pnpm -r typecheck` → exit 0. `node --test apps/server/test/*.test.ts` → exit 0, **372/372 pass**.
  `node scripts/test-web-unit.mjs` → exit 0, **126/126 pass** (59 files, includes the new
  `lib/agent-definitions.test.mjs`). `scripts/checks/cli-usage/compare-tests/deploy-inspect/dev/release-plan/verify/
  verify-changed` → exit 0, 51/51. `check-entrypoints` → exit 0, 0 newly missing. `check-docs` → exit 1 on the same 12
  pre-existing `.scratch/` links, none in this change.
- New coverage: `apps/server/test/agent-definitions.test.ts` asserts the accepted list equals the installed tools and
  that `grep`/`find`/`ls`/`powershell`/`codemode`/`tool_search` are each refused with `unknown_tool` and kept out of
  the parsed definition; `agent-definitions-http.test.ts` adds a parameterized `local:`/`ssh:` case proving a real
  `PUT` refuses `["read","grep"]` on both `dryRun: true` and the write path (400, `unknown_tool`, field `tools`,
  nothing written) and accepts all four installed names; `agent-definitions-route.test.ts` repeats the refusal through
  the mounted `createBackendServer` route and asserts no file reached the remote host;
  `apps/web/lib/agent-definitions.test.mjs` covers `capabilitiesOf` (stated vocabulary wins, empty/absent falls back,
  fallback equals the installed four).
- Browser gate re-run: `pnpm --filter @hepi/web build` exit 0; `node apps/web/e2e/ux-agent-definitions.mjs` exit 0,
  **51 ok / 0 FAIL**, `UX-05 agent definitions regression passed`, on the local host and on the real `sshd` over
  loopback. The new checks read `capabilities.tools` from the list answer, prove `grep` is refused on the dry run and
  on the save, and prove every offered tool is accepted. The real `~/.pi/agent/agents` still holds only its own four
  files; the run's artifact directory was cleaned.
- `node scripts/verify.mjs --profile=changed --base=b912955` → changed-typecheck, changed-test and web-unit PASS;
  check-docs FAILs only on the 12 known links (report
  `.dev/verify/2026-10-16T11-59-11-489-verify-changed/verify.json`, dirty tree at `b912955`).

## Remaining work

- Ticket 12 owns the quick-create/child-tree journey; tickets 06/10 consume `buildEffectiveAgentConfiguration` for the
  fixed snapshot and context preparation. The optional `packages/subagents` module was deliberately not created: the
  backend is the one place definitions are parsed.
- A definition cannot select a tool that is not installed by `coding-tools`. If a later ticket installs `grep`,
  `find`, `ls` or another extension's tools, the accepted vocabulary widens automatically for the installed ones;
  a per-workspace vocabulary is not modelled, so a tool installed but unselected at run time is still accepted here.

## Verification seam

- 生产浏览器表单/原文→真实backend→本地及localhost SSH gateway→实际定义文件的往返；检查 dryRun 不落盘、原子保存、project/user 覆盖。
- 受控能力 registry 校验未知/已知不支持字段；读取既有会话快照证明定义修改不改变它。

## Scope and handoff

可建立可选扩展的宿主 adapter/配置解析接缝，不创建子执行器、完成 reporter 或 CLI 全格式兼容层。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。

## Coordinator integration evidence

Source948f183, clean integration tree before checks. `pnpm install --frozen-lockfile` exit0; `node --test apps/server/test/agent-definitions.test.ts apps/server/test/agent-definitions-http.test.ts apps/server/test/agent-definitions-route.test.ts` exit0,24/24; `node --test apps/web/adapters/agent-definitions.test.mjs` exit0,5/5. Raw logs `.dev/verify/definitions05-merge/{install,definitions,web-adapter}.log` in integration workspace. Source audit confirms the four route tests use an injected Python SSH runner; actual sshd is verified separately by the production browser gate.

Browser evidence archived: tested product/test source478a9213007970f437cac6bf4db7efc7b665a672, selector dirty:false. `git diff --name-only 478a921 948f183` lists only four Markdown files, so reuse unchanged product verification. Worker reports build/browser exit0; copied raw logs `.dev/verify/definitions05-merge/ux05-{build,e2e,run,checks}.log`, inspected41 `ok` lines and final `UX-05 agent definitions regression passed`. Realsshd fixture artifacts/children.log retained in `.dev/verify/definitions05-browser-artifacts/`. Full selector478a921 at `.dev/verify/definitions05-selector/`: workspace checks0, web123/123, script51/51, entrypoints0; docs1 for12 knownlinks.05 accepted with integrated24/24+5/5 evidence above; no product rerun after docs-only commits.
