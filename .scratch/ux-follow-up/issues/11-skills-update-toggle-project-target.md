# 11: Skills 更新、开关与 Project 目标

**What to build:** 两种来源的技能可检查/更新、单个或批量切换 model invocation；所有 Project 操作准确落到 default 并保留冲突及 Reload 反馈。

**Blocked by:** 08: 同一主机多目录 Project 与 default; 09: SSH New Remote Project; 10: Skills 双来源搜索与下载

**Status:** implemented, verified and merged — merged into `integration/ux-follow-up` as 86516b9; combined verification at that tip (types 6/6, core 236 with gateway 80 and server 129, project-target browser driver 10 ok, builtin skills smoke 52 ok controlled / 53 ok real `sshd`, whole-web failure set unchanged at the 23 baseline). See the source proof and approved contract below, then what was built

**Dispatch phase:** B — features after 01–04 are verified

**Stories:** 32, 34, 35, 36, 37

- [ ] 来源 revision 是否最新与基线是否本地修改分别显示；unknown/unmanaged provenance 不冒充最新版或未安装。
- [ ] 明确更新到精确 revision；本地修改需确认覆盖并保留完整目录备份，读取到发布期间变化及并发更新遵守现有冲突契约。
- [ ] 单个/批量开关复用内置 dormant 排序和 toggle 语义，实际写入执行侧 SKILL 内容；不把 Web-host helpers 当资源源。
- [ ] global 根据选定执行主机/账号定位，project 根据 Project default 定位，即使当前查看的旧会话仍绑定别的 folder；包含新注册 SSH Project。
- [ ] 安装/更新/toggle 对可关联会话复用原有显式 Reload 语义，其他对话不自动热更新；发布已完成而 Reload 失败的结果保持独立可见。
- [ ] 本地/真实 SSH fixture 与浏览器操作覆盖更新、目录字节/备份、竞争变化、开关、default 目标及列表刷新。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). Before adapting Skills, read [reuse evidence](../skills-reuse.md).

## Comments

### Pre-implementation report: source proof and the minimal contract

Base: `impl/ux-follow-up-10` at `b8d1d00` (integration `2036d6a` + 10). Line numbers are that tree's. Policy:
[review policy](../../../docs/agents/review-policy.md) (parent `7262f85`); a `record` finding is a note, never a patch gate.

#### 1. What already exists, exactly

| Concern | Source | Verdict |
| --- | --- | --- |
| Dormant ordering (single + bulk) | `apps/web/components/SkillsConfig.tsx:102` `orderSkillsByDormancy`; `apps/web/components/settings-ui-helpers.ts:9` `itemsToSwitch` | **keep** — both already in this repo and tested (`SkillsConfig.dormancy.test.mjs`, `settings-ui-helpers.test.mjs`) |
| Upstream toggle semantics | upstream `components/SkillsConfig.tsx:659` (single) / `:713` (bulk), `skillsToSwitch` `:78`, `applySkillToggleResults` `:85`; `apps/web/lib/api-types.ts:107` `SkillToggleResult` | adapt: the *target* moves from the Web host to the execution host; the per-item `{ filePath, error? }` result shape is kept |
| Frontmatter edit itself | upstream `lib/skill-frontmatter.ts` `setDisableModelInvocation`, already vendored **verbatim and tested** at `apps/web/lib/skill-frontmatter.ts` + `skill-frontmatter.test.mjs` | reuse as the pure transform; it is a string function with no filesystem in it |
| Upstream PATCH route | upstream `app/api/skills/route.ts:64-116`: `toggleSkillFile` reads/writes `SKILL.md` on the **Web host** under `getAllowedFileRoots()` | **not portable**: ADR 0002 and this ticket both put the file on the execution host |
| Provenance / pinned ids | `apps/server/src/skill-install.ts:132` `installLockEntry` (`github:<name>@<commit>`, `ref` = commit); `skill-repository.ts:331` `pinnedSkill`, `:402` `skills-sh:<owner>/<repo>@<commit>:<path>` | keep; the pin already lives in the selection |
| Current revision comparison | `apps/server/src/skill-install.ts:404-410`: only `sourceType === "repository"` is compared with `newestVersion`; a `github` installation gets `available === undefined` → `revision: "unknown"` | this is the gap ticket 11 fills; it is also why inventory makes **no** GitHub call today |
| Update path (backup + 409) | `skill-install.ts:305-330` (`confirmation_required` 409, `expect` digest pinning), `packages/gateway/src/install.ts:222-248` (retained `.bak`), `updateState` `:190` | **keep unchanged**; ticket 11 must not add a second replacement path |
| Project default folder | `apps/server/src/server.ts:195-205` `ProjectView` (`defaultFolderId`, `folders[].workspaceId`), route `:476`; Web proxy `apps/web/adapters/durable-api.ts:173-183`; pure resolution `apps/web/lib/project-routing.ts:40-45` (`defaultCwd`) and `:58-66` (`projectGroupOfPath`) | real source, already served; the panel simply does not read it yet |
| Reload independence | `apps/web/lib/skill-inventory.ts` `conversationTarget(sessionId, sessionWorkspaceId, workspaceId)` returns the session only when the target **is** that conversation's workspace; `reloadResources` is per-conversation (`workspace-resources.ts:494`) | **already correct** — installing into B from a session bound to A names no conversation, so nothing is reloaded anywhere else |

#### 2. The one genuinely missing capability (reported before code, as required)

There is **no execution-side toggle operation anywhere**, and the ordinary file RPC refuses it by design:

- `packages/gateway/src/install.ts:70-76` — the whole `InstallRequest` union is four operations: `publishDirectory`, `inspectDirectory`, `readLock`, `recordInstall`. No mutation of an installed file.
- `packages/gateway/src/filesystem.ts:461-467` `mutationPath` throws `permission_denied` "execution-side resource locations are read-only" for any path under a resource root — including `<root>/<skill>/SKILL.md`. That refusal is correct and must stay; the parent's instruction forbids monkeypatching it.
- The SSH helper has the same four modes only (`install.ts:592-697`: `publish_begin/file/commit/abort`, `inspect`, `lock_read`, `lock_record`).
- The Web side has no route either: `PATCH /api/skills` is unimplemented (501) in `apps/web/adapters/durable-api.ts:208` and is listed as such in `.scratch/ux-follow-up/settings-api-audit.md:114-115`.

**Minimal proposal — one additive operation on the existing install seam, nothing new built around it.** The install capability is already the owner of "a slug inside a confined scope root, written atomically, on the right host", so the toggle belongs there:

1. `packages/gateway/src/install.ts`: add `{ operation: "toggleSkill"; scope: InstallScope; directory: string; disableModelInvocation: boolean }` to `InstallRequest`, returning `InstallResult<{ readonly changed: boolean }>`.
   - Local (`LocalInstallServer.execute`, `:276-291`): `confinedScopeRoot` → `join(root, directory, "SKILL.md")`, refuse a non-regular/linked file, read utf8, apply the pure `setDisableModelInvocation`, and write through the existing temp-file + rename pattern; an already-correct file is **not** written (mtime preserved, as upstream).
   - SSH: one `toggle` mode in the existing Python helper, same confinement (`confined_scope`), same temp+replace, same "unchanged ⇒ no write".
   - The pure transform moves to the gateway (e.g. `packages/gateway/src/skill-frontmatter.ts`, its existing test moves with it). `apps/web/lib/skill-frontmatter.ts` then has no caller and is retired in 14, not here.
2. `apps/server/src/skill-install.ts`: a `toggle` orchestrator next to `install`/`update`/`status`/`inventory` that resolves the same execution target (`target()`) and reports **per-directory** results, so one refused skill does not stop a bulk switch — the upstream contract, kept.
3. Routes (`apps/server/src/server.ts`, the existing authenticated non-conversation block `:410-445`): `PATCH /api/skill-market/skills` with `{ workspaceId, scope, directories: string[], disableModelInvocation }`; `marketApi` already forwards `PATCH` and its body (`apps/web/adapters/skill-market.ts`), so no adapter change is needed.
4. **Check / update for a GitHub installation** — a second small addition, reusing what is already there:
   - `SkillMarket` gains `refresh(installation: { repository, name }): Promise<{ revision: string; id: string } | undefined>` in `apps/server/src/skill-repository.ts`: resolve the repository's **current** default-branch commit (`defaultCommit`, `:465`) and the document path with the existing `pinHit` rules (`:427`, authoritative-first, ambiguous ⇒ refuse, `unbounded` ⇒ refuse), then return a **new** `skills-sh:<owner>/<repo>@<newCommit>:<path>` id. It is called **only** by an explicit user check/update, never by `inventory` — so browsing still makes no GitHub request and the previously previewed id keeps resolving to the blob the user saw.
   - `GET /api/skill-market/check` (or `POST`) takes the installed skill's target/scope/directory and answers `{ state: "up-to-date" | "update-available" | "unknown", currentRevision, availableRevision, id? }`; `unknown` stays `unknown` for unmanaged or non-GitHub provenance, and is never rendered as "up to date".
   - The subsequent update is the **existing** `POST /api/skill-market/update` with the returned id plus the caller's inspected `files` — backup, digest pinning and the 409 `confirmation_required` flow are untouched.

Everything else the ticket asks for is wiring, not new capability: project scope resolves its target as the owning project's `defaultFolderId` folder (`projectGroupOfPath` → `projectGroup(...).defaultCwd` → `workspaceIdFromCwd`), independent of which folder the open conversation is bound to; global scope uses the sidebar-selected execution host's `workspaceId`; both then pass through the existing `conversationTarget` rule, so a session bound to A that installs into B names no conversation.

#### 3. Dependencies and non-goals

- **On 09 (`impl/ux-follow-up-09`, plan at `d4abe36`)**: 09 adds `projects.profile_id` and an `sshOwner` resolver so an SSH workspace resolves its own profile/account. 11 must therefore keep addressing targets by **`folder.workspaceId`** from `/api/projects` and never derive a host from the Web path; the account continues to come from `GET /api/workspaces` (`executionHost`). Nothing in 11 should be written against the prefix-parsed `remote-<profile>` identity that 09 removes.
- **Not in this ticket**: no new registry, no new scope enum, no second replacement path, no publish/browse UI, no `GET /api/skills?cwd=` revival (inventory covers it), no changes to conversation binding, no 13 work.
- **Verification plan (TDD, red first)**: server tests for the toggle op through a real local gateway and the controlled SSH transport (byte-level `SKILL.md` before/after, unchanged ⇒ no write, refused/absent directory ⇒ per-item error, bulk continues past a failure) and for check/update (fresh commit only on check; preview id still resolving the old blob; `unknown` for unmanaged; moved branch then update keeps a `.bak` and records the new `ref`); a browser fixture for the panel's single/bulk switch, project-default targeting while an old conversation is bound elsewhere, and no reload notice for a non-matching target.

### Implementation: what was built, and what was reused

Base: integration \`3c8b478\` (09 + 13). The proposal above was approved with one addition the parent required: the
**canonical** \`PATCH /api/skills\` must actually be wired, not a market-only alias — the audit's "unimplemented"
entry becomes "wired", and no extra UI-facing route is introduced. The capability gap (no execution-side toggle) was
reported before any code and is unchanged.

1. **\`packages/gateway/src/skill-frontmatter.ts\` (new) + \`packages/gateway/test/skill-frontmatter.test.ts\`.**
   \`setDisableModelInvocation\`, adapted from pi-web \`lib/skill-frontmatter.ts\` (MIT, preserved verbatim under
   \`apps/web/vendor/pi-web\`). The upstream rules are kept — surgical line edit inside the block only, an explicit
   \`false\` replaced in place, an already-set key leaving the file untouched, an un-editable shape refused — with one
   deliberate difference, stated in the file: the document's **own** key level is found by indentation rather than by a
   parsed mapping, so the same rule transcribes exactly into the stdlib-only remote helper. A nested
   \`disable-model-invocation\` is therefore not mistaken for the skill's own key.
2. **\`packages/gateway/src/install.ts\`.** \`{ operation: "toggleSkill", scope, directory, disableModelInvocation }\` on the
   existing \`InstallRequest\` union, returning \`ToggledSkill { changed }\`. Local: \`confinedScopeRoot\`, the same
   per-destination \`serialized\` lock a replacement takes, a regular-file check on \`SKILL.md\`, temp file + rename,
   and **no write at all** when the document is already in the requested state. SSH: one \`toggle\` mode in the existing
   Python helper, the same confinement and the same lock file, the rule transcribed. \`gatewayInstalls\` gains
   \`toggleSkill\`, so the local gateway and the SSH fixture both serve it.
3. **\`InstallLockEntry.repository\` / \`documentPath\` (additive, optional).** A GitHub installation now records the
   coordinate and the document path it came from beside the pinned ref, so a later check reads the same document rather
   than guessing one from the skill's name. Both are validated in \`validLockEntry\` and the helper's \`valid_entry\`.
4. **\`apps/server/src/skill-install.ts\`.** \`toggle()\` reports **per directory**
   (\`results: [{ directory, changed?, error? }]\`) so one refused directory stops nothing, and adopts only a
   conversation that runs on the write target. \`check()\` is the only path that resolves a commit: \`unknown\` for no
   GitHub provenance, for a stored bundle, and for a repository that cannot be read; a moved repository answers
   \`update-available\` with a **fresh pinned id** in the search-hit shape, and the update that follows is the existing
   \`/update\` (backup, \`expect\` digests, 409 \`confirmation_required\` untouched). The inventory's install record now
   carries \`repository\`/\`documentPath\` forward.
5. **\`apps/server/src/skill-repository.ts\`.** \`refresh({ repository, documentPath })\` resolves the current default
   branch commit **past the cache** (a check asks about now) and requires the recorded path still to exist at it.
   \`defaultCommit\` gained a \`current\` flag; selections keep reading the cached commit, so one query still decides
   one commit.
6. **Routes.** \`PATCH /api/skill-market/skills\` (bulk, per-directory results) and \`GET /api/skill-market/check\`
   (explicit, user-pressed) in \`server.ts\`, with \`toggleRequest()\` validating the body before it reaches the host.
7. **Web.** \`apps/web/adapters/durable-api.ts\` now **implements** \`PATCH /api/skills\`: the upstream body shape
   (\`filePath\`/\`filePaths\` + \`disableModelInvocation\`) is reduced, per path, to the directory inside the
   installation scope (\`toggleDirectories\`), and forwarded to the backend's one operation. \`SkillsConfig.tsx\` gets
   the per-skill switch in the detail pane (with a visible reason when a skill lives in an ancestor root no scope owns),
   the group switch in each heading, the separate **Check for updates** action, and one target rule used by install,
   update, toggle and check: an installation's **own** scope decides where it writes, a project writes to the project's
   default folder (\`projectDefaultWorkspaceId\`, \`web/lib/project-routing.ts\`), and adoption is
   \`conversationTarget\` against that target — so a session on another folder of the same project names no
   conversation. Browsing still makes no GitHub request.

**Tests (red first, and the baseline re-checked).** On the pre-change sources the new tests fail for their own reasons:
the gateway transform module does not exist; the server's four new cases fail on the two routes and the missing
recorded provenance; the Web helper and adapter-contract cases fail; and the browser fixture's switch sent
\`workspaceId: alpha\` (the folder the session runs on) while naming that conversation — exactly the defect the
fixture now guards. Two real defects it caught during this work were fixed, not worked around: the operation target was
taken from the add pane's scope, and adoption followed the sidebar rather than the write. Verified: workspace
typecheck; gateway 80 tests; server 129 tests; Web unit files at the same 50 pre-existing failures with 4 more tests
passing than the base tree (3645/3595/50 vs 3641/3591/50); \`next build\`; \`ux-skills-project-target.mjs\`; and
\`skills-ui-smoke.ts\` in both controlled and real-sshd transports, now 52 checks, asserting the written document
bytes, the unchanged provenance, the reversible single switch, the per-directory bulk answer, and the on-demand check.

**Review notes.** No findings recorded: the review policy's \`record\` disposition covers negligible or hypothetical
cases, and none arose here. The one shape the local edit and the remote helper could have diverged on — every
frontmatter variant, in both scopes — is asserted byte-for-byte by a parity test instead of being left to review.
