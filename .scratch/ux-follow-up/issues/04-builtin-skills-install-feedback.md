# 04: 内置 Skills 安装、反馈与当前版本状态

**What to build:** 在已注册 Workspace 上使用内置 Skills 浏览/直接安装 harness bundle，保留安装/Reload 结果与正确的版本状态；将用户入口从独立 Market 切到此流程。

**Blocked by:** None (can start immediately within the authorized dispatch phase)

**Status:** complete — merged as f6f0772; both browser transports green on the merged tree

**Dispatch phase:** A — bug fixes (01–04 first)

**Stories:** 28, 30, 31, 32, 33, 34, 35, 36, 37

- [x] global/project 目标显式关联执行主机与账号；project 先使用现有单根 Workspace，读取的是执行侧技能。
- [x] 无需活跃对话可浏览 harness 库；安装必须有明确执行目标，完整文件（脚本、二进制及空文件）保持字节一致。
- [x] 成功或已安装但 Reload 失败的反馈在列表/控件刷新后保留；无可关联对话时不伪造 Reload 成功。
- [x] Installed、Up to date、Update 按来源/安装 revision 与目标 revision 显示，基线本地修改另行呈现；已知有新版时更新走现有确认/备份机制。
- [x] 手动技能、既有安装和库数据保留；当前已接通的操作在内置 UI 完整可用，后续来源能力不以占位处理器暴露。
- [x] 以真实浏览器安装/刷新及本地、已有 SSH Workspace fixture 验证上述结果；先复现 B4 再修复。
- [x] 替换 Market 用户入口后保留仍有调用者的存储/安装机制，旧实现清理留到最后；不新增发布或导入导出界面。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). Before adapting Skills, read [reuse evidence](../skills-reuse.md).

## Contract extension reported before implementation

`createInstaller` resolved its target only from an initiating conversation, and always asked that conversation to
reload. The extension is additive and narrow: `InstallRequest` gains an optional `workspaceId`; `conversationId`
becomes optional; the target resolves from the named workspace, or the conversation's own binding, and refuses with
`conflict` when both are named and disagree. `reload` is now omitted when no conversation was named, so an
installation without one reports no adoption outcome instead of inventing one. Existing conversation-only callers and
their tests are unchanged. `GET /api/workspaces` additionally resolves each workspace's execution account through the
gateway's own `executionHost` answer.

## Implementation

- **Backend.** `apps/server/src/skill-install.ts` adds the optional workspace target, the omitted-reload outcome, and
  `inventory()`: one execution workspace's skills, discovered through the existing `WorkspaceResources.discover`, each
  joined with the scope lock entry recorded for its directory and with the repository's newest version of that bundle.
  Revision state (`up-to-date` / `update-available` / `unknown`) and baseline state (`unchanged` /
  `locally-modified` / `unmanaged`) are separate fields. `apps/server/src/server.ts` serves
  `GET /api/skill-market/inventory`, extends `GET /api/workspaces` with the resolved host/account, and lets the
  existing install/update/status routes take `workspaceId`.
- **Web.** `apps/web/components/SkillsConfig.tsx` is now the retained workflow: an execution-host selector, the
  selected host's real skills with their provenance and both state questions, the harness library as a directly
  selectable source inside the same global/project destinations, and one outcome region rendered outside every
  installed/status switch. `apps/web/lib/skill-inventory.ts` holds the pure decisions. The standalone Market section
  and its Settings entry are gone; `SkillMarketPanel.tsx` and `lib/skill-market.ts` stay in place with no caller for
  ticket 14, and their still-used helpers (bundle preview/listing, pinned digest updates) are reused.

### Review refinements

The parent's review found three concrete defects in the first cut, all fixed here.

- **Version ordering is the semver library's, not a string's.** The hand-rolled comparison ordered prereleases
  lexically, so `1.0.0-beta.10` came out *older* than `1.0.0-beta.2` — a wrong "newest version" claim, and the wrong
  update offered. `newestVersion` now uses the `semver` package already vendored by `apps/web` (7.8.5): `valid` on
  every listed version, `rsort` to pick the newest. A version `valid` rejects — a leading zero, a malformed
  identifier — is not ordered at all, so that bundle answers `revision: "unknown"` rather than a guessed newest.
- **Only the repository's own publication is compared with the repository.** `newestVersion` was called for every
  managed installation, so a curated GitHub install whose lock recorded a commit was compared with an unrelated
  repository bundle that merely shared the directory name, and could be reported "up to date" with it. The comparison
  now requires `install.sourceType === "repository"`; a GitHub installation is `revision: "unknown"` until its own
  source has an ordering, which is honest about a question this module cannot answer.
- **A named conversation and a named workspace must agree on the host, including when the conversation is bound to
  none.** The guard only fired when the conversation's bound workspace was known, so an unbound conversation plus a
  named workspace published the files and *then* asked a host-less conversation to adopt them. The mismatch is now
  refused with `conflict` (409) before the host is touched, the status route reports that refusal as 409 rather than
  the 404 that means "no such installed skill", and the panel names a conversation only for the workspace that
  conversation actually runs on — every other target is an independent installation that names none. A legacy
  conversation-only call to a workspace-less conversation still answers 404.
- **A skill is annotated by its directory, not its declared name.** The frontmatter `name` is a display name and may
  differ from the install directory; the installation, the lock entry, the update and the outcome key all use the real
  directory, and the inventory carries it as its own field.
- **A gateway's own error is bounded.** An unreachable host's message is collapsed to one line and truncated before it
  reaches the browser; the Web process never composes a host name it did not receive.

## Evidence

- Red-then-green: B4 was reproduced first against the pre-change baseline worktree
  (`node apps/server/scripts/skills-ui-smoke.ts --mode baseline-market` there): after an installation, the outcome
  notice count is 0 once the installed-state controls replaced the install controls. The same run against the repaired
  tree fails on purpose because the Market entry no longer exists.
- `node apps/server/scripts/skills-ui-smoke.ts --mode builtin`: PASS, 28/28 checks, real Next production UI → Web
  adapter → real backend → real local gateway and controlled localhost-SSH transport, with a controlled repository
  fetch and no model call. Covers: both hosts' accounts named; library browsed with no active conversation; global and
  project installs written into the execution account's home and the selected workspace, never the other; an
  installation with no conversation reporting no reload outcome; the outcome surviving a list refresh; the repository
  revision and the local content state shown separately; a newer version offered as Update; a local edit named
  separately; the explicit confirmation and the retained backup; the outcome surviving the post-update refresh.
- `pnpm -r typecheck` pass (6 projects). `pnpm -r test` pass: protocol 10, client 9, session 3, gateway 59,
  server 75 (5 new cases in `apps/server/test/skill-install.test.ts`), 0 fail.
- **Merged tip `f6f0772`** (integration/ux-follow-up, after review follow-up `ea56dff`): `pnpm -r typecheck` 6/6;
  `pnpm -r test` protocol 10, client 9, session 3, gateway 59, server 83, 0 fail (core 164);
  `node --test test/skill-install.test.ts` 23/23; `skills-ui-smoke.ts --mode builtin` PASS with 31 `ok`
  (`--transport controlled`) and 32 `ok` (`--transport sshd`), 0 `FAIL` each. The re-verified counts are lower than
  the pre-review run because `ea56dff` replaced the "no conversation was asked to reload" assertion with the
  "names no conversation" + "adopts on its own workspace" pair and folded the imports.
- Web: `lib/skill-inventory.test.mjs` (8 new cases), `components/SettingsUi.test.mjs`,
  `components/SkillsConfig.dormancy.test.mjs`, `components/SkillMarketPanel.test.mjs`,
  `lib/settings-navigation.test.mjs`, `lib/i18n/registry.test.mjs`, `adapters/durable-api.test.mjs` — 59/59.
- Whole-web run: 2063 tests, 2042 pass, 21 fail — the same 21 pre-existing baseline failures as `cda2416`
  (2058 / 2037 / 21), file-for-file identical, not a regression. Not claimed green.
- Merged `integration/ux-follow-up` (tickets 01–02) before reporting and rechecked on the merge commit: typecheck 6/6,
  `pnpm -r test` protocol 10, client 9, session 3, gateway 59, server 75, 0 fail; `node
  apps/server/scripts/skills-ui-smoke.ts --mode builtin` PASS again on the merged tip.
- After the review refinements: typecheck 6/6; `pnpm -r test` protocol 10, client 9, session 3, gateway 59, server 76,
  0 fail. Targeted web 60/60 (`lib/skill-inventory.test.mjs` now 9 cases). Whole-web 2064/2043/21 — the same
  pre-existing baseline failures as `cda2416`, not a regression.
- Follow-up fixes: typecheck 6/6; `pnpm -r test` protocol 10, client 9, session 3, gateway 59, server 78, 0 fail.
  Targeted web 38/38; whole-web 2065/2044/21 — the same pre-existing baseline failures as `cda2416`. Browser
  acceptance PASS on both transports: `--transport controlled` and `--transport sshd`, with the session's own
  conversation adopting the installation on its own workspace and naming no conversation for any other target.
- **Real localhost sshd acceptance** (`--transport sshd`): PASS, 33/33. A real throwaway `sshd` (pinned host key,
  its own key pair, ephemeral port) driven by the gateway's real `ssh` runner, so the remote account is this machine's
  real login: the remote host is exercised at project scope inside a temporary workspace, and the real account's own
  resource directories (`~/.agents/skills`, `~/.pi/agent/skills`) are asserted byte-identical before and after. The
  controlled transport (`--transport controlled`) still PASSes 32/32, covering the remote global scope.

## Not in this ticket

- Per-skill and bulk model-invocation toggles: the panel shows the host's dormancy read-only, because the
  execution-side toggle route belongs to ticket 11. `SkillsConfig.bulk.test.mjs` is removed with the bulk UI.
- skills.sh search and download: ticket 10. The Add pane lists the harness library the backend already serves.
- `SkillMarketPanel.tsx` / `lib/skill-market.ts` deletion and the now-unused Web host-side skill helpers
  (`skills-service.ts`, `skill-lock.ts`, `skill-updates.ts`, the `/api/skills` types): ticket 14.
- The panel's own integration into a per-ticket e2e entry is a reusable command
  (`pnpm --filter @hepi/server smoke:skills`, `pnpm --filter @hepi/server smoke:skills-sshd`, or
  `pnpm --filter @hepi/web test:skills-install-feedback`), not yet part of an aggregate e2e runner: `e2e/run.mjs`
  does not exist in this repository.
