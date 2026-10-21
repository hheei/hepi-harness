# 14: 退役 Market 遗留并验收统一 Skills

**What to build:** 清理被替换的 Market 专属 UI/无调用者逻辑，验证内置 Skills 已覆盖既有和新 Project 的完整流程且保留安装与库数据。

**Blocked by:** 11: Skills 更新、开关与 Project 目标

**Status:** done — implemented, verified and merged into `integration/ux-follow-up` as 0057f73 (tree identical to `e328eef`); combined verification at that tip (types 6/6, core 236, `test:skills` 55 units + both fixtures + built-in smoke PASS, `test:skills-sshd` 53 ok, whole-web failure set unchanged at the 23 baseline, client build + pack smoke + tarball agegr notice verified). The final code review (two axes) is complete with both material findings fixed (F1 at `4a243ae`, F2 at `bb3c4f7`) — see [code-review.md](../code-review.md). This ticket's own deliverable was never affected by those two findings.

**Dispatch phase:** C — legacy retirement after blockers

**Stories:** 28, 37, 38

- [ ] 唯一用户入口为内置 Skills；用管理依赖/调用证据删除已无调用者的 Market 组件、专属展示与失效测试。
- [ ] 保留库数据、安装锁、执行侧文件和仍被调用的分发/安装原语，明确处理仍有来源记录的旧 curated 安装。
- [ ] 浏览器覆盖双来源、两种目标、新旧/远端 Project、反馈、当前版本、确认更新与开关；核心 gateway/资源加载回归保持通过。
- [ ] 将相关交互回归纳入可重复的验证入口；记录既有基线失败与本轮结果，不把 unrelated Settings TODO 当完成条件。
- [ ] 更新 Settings 审计中本轮真正接通的接口状态，未选中功能继续留在 TODO；最终 code-review/retro 是后续工作阶段。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). Before adapting Skills, read [reuse evidence](../skills-reuse.md).

## Comments

### Read-only removal plan (written before anything was deleted)

Base: `86516b9` (integration, ticket 11 at `4323109`). Every row below is a resolved import graph, not a guess. The
rule used: **a file goes only if its only importers are files that also go.**

#### Removed — no caller survives the deletion

| Path | Lines | Resolved callers | Why it is dead |
| --- | --- | --- | --- |
| `apps/web/components/SkillMarketPanel.tsx` | 756 | `SkillMarketPanel.test.mjs:9` only | No `<SkillMarketPanel` anywhere: `AppShell.tsx`, `SettingsPanel.tsx` and `settings-navigation.ts` contain no market section (case-insensitive search, 0 hits). The Settings › Market entry this file was for does not exist any more. |
| `apps/web/components/SkillMarketPanel.test.mjs` | 293 | none | The panel's own test; it is the panel's only importer. |
| `apps/web/lib/skill-market.ts` | 168 | `SkillMarketPanel.tsx:31`, `SkillMarketPanel.test.mjs:10` | Both callers go. |
| `apps/web/lib/skill-updates.ts` | 263 | `skill-updates.test.mjs:11` only | Dormant: it ran `git` and `npx` on the **Web host** (ADR 0002 forbids it), and ticket 11 replaced the question with `GET /api/skill-market/check`. |
| `apps/web/lib/skill-updates.test.mjs` | 263-observed | none | Test of the above. |
| `apps/web/lib/skill-frontmatter.ts` | 85 | `skill-frontmatter.test.mjs:8` only | Superseded by `packages/gateway/src/skill-frontmatter.ts` (ticket 11), which is dependency-free and runs on the host that owns the file. |
| `apps/web/lib/skill-frontmatter.test.mjs` | 192 | none | Test of the above; the gateway suite asserts the same rules plus host parity. |
| `apps/web/lib/skills-service.ts` | 16 | **none at all** | Loaded resources with `DefaultResourceLoader` in the Web process — the ADR 0002 path `docs/execution-side-skills.md` rejects. |
| `apps/web/lib/skill-lock.ts` | 146 | `skills-service.ts:3` | Its only importer is itself dead; the live lock is the execution-side `.skill-lock.json` (`packages/gateway/src/install.ts`). |
| `apps/web/lib/skill-lock.test.mjs` | 182 | none | Test of the above. |
| `apps/web/app/market.css` | 116 | `layout.tsx:7` import only | Every selector it defines (`market-views`, `market-card.is-selected`, `market-versions`, `market-version*`, `market-bundle`, `market-file*`, `market-field`, `market-input`, `market-textarea`, `market-publish-actions`) is used only by `SkillMarketPanel.tsx`, checked selector by selector. |
| `market.*` i18n keys used only by the panel | 41 keys × 3 locales | none after the panel goes | Computed, not eyeballed: the panel's referenced keys minus the ones `SkillsConfig.tsx` still uses. |
| `SkillToggleResult`, `SkillInstallScope`, `SkillInstallInfo`, `SkillUpdateState`, `SkillUpdateResult` in `lib/api-types.ts` | ~50 | none | Their only consumers were `skill-lock.ts` and `skill-updates.ts`. |

#### Kept — still called, or still data

- `SkillInfo`, `SkillsResponse` (`api-types.ts`): `ChatInput.tsx:5,1579` reads them for the chat palette's dormancy
  map. That route (`GET /api/skills?cwd=`) is still unimplemented and still answers 501 — it is not Market, and it
  stays a TODO in the audit rather than gaining a stub.
- The 8 `market.*` keys `SkillsConfig.tsx` uses (`refresh`, `noDescription`, `unavailableSources`, `previewError`,
  `fieldDocument`, `files`, `bundleEmpty`, `encodingBase64`) and the 5 source-state/search-miss keys.
- `settings.css` `.market-cards`/`.market-card*`/`.market-preview-actions`/`.skill-outcome`: shared with the built-in
  panel.
- `adapters/skill-market.ts`, `server/src/skill-repository.ts`, `server/src/skill-install.ts`,
  `packages/gateway/src/install.ts`: the distribution/installer seam itself, its routes, and its data.
- `app/api/[...path]/route.ts`'s `skill-market` dispatch: the built-in panel and `server/scripts/split-resources-smoke.ts`
  both use it.
- `apps/web/vendor/pi-web|pi-desktop`, `apps/server/vendor/*`: provenance snapshots, never on an import path.
- All stored data: `skill_bundles`/`skill_bundle_files`, execution-side `.skill-lock.json`, installed directories.

#### Uncertainties raised rather than deleted blind

1. **Publishing loses its only user surface.** After retirement, `POST /api/skill-market/bundles` (and the version
   list/retrieve pair) is reachable only from the API and `server/scripts/split-resources-smoke.ts`; the built-in Add
   pane *consumes* harness bundles through `search` but publishes nothing. The backend, data and routes are kept as
   instructed. If a publish surface is wanted, it is new work, not a retirement decision — flagging it, not inventing it.
2. **`GET /api/skills?cwd=`** stays a live call to an unimplemented route (silently empty dormancy). Recorded as a TODO,
   not fixed and not stubbed.
3. **The skills.sh update-hash lookup** (`lib/skill-updates.ts`) disappears with the file; ticket 11's `check` is the
   replacement for the GitHub-sourced case, and there is no caller that wanted the old one.
4. **`apps/web/lib/skill-frontmatter.ts` depends on `@earendil-works/pi-coding-agent`.** Nothing needs porting back:
   the gateway copy is dependency-free by design and its rules are asserted byte-for-byte against the remote helper.

#### Verification entry point (added by this ticket)

One repeatable command for the retired surface and the built-in workflow: `pnpm --filter @hepi/web test:skills`,
(originally written as `@hepi/client`; `test:skills` is defined in `apps/web/package.json`, so the filter was wrong —
corrected in this documentation pass, with the recorded results unchanged),
which runs the skills unit files, the browser fixtures (`ux-skills-inventory-race`, `ux-skills-project-target`), the
retirement assertions (`components/SkillsRetirement.test.mjs`: no Market section in the shell, no reference to any
retired module), and the built-in smoke in both transports.

#### Core baseline — not fixed here

The whole-web suite's 23 pre-existing failures are unrelated to this ticket and stay recorded, not repaired; the
audit rows for other unwired endpoints keep their TODO status.

### Implementation: what was removed, what was kept, and the evidence

Removed (2,764 lines deleted, 125 added, almost all of it the retirement test and the audit/docs): `SkillMarketPanel.tsx` (756), its test (293), `lib/skill-market.ts` (168), `lib/skill-updates.ts` (263), `lib/skill-lock.ts` (146), `lib/skills-service.ts` (16), `lib/skill-frontmatter.ts` (85), their three test files, `app/market.css` (116), the 56 `market.*` i18n keys per locale, the 132 lines of `settings.css` only the panel's selectors used, and the five `api-types` types whose only consumers were those modules. Each deletion is the last link of a resolved chain, not a name match: the panel test imported the panel, `skills-service` was imported by nothing and was itself `skill-lock`'s only importer, and `skill-updates`' test was its only caller.

Kept, with reasons in the code path rather than in prose: the `skill-market` dispatch and every route the built-in panel reaches (search, preview, inventory, check, PATCH skills, install, update), the publish/version routes and the stored `skill_bundles` tables, the execution-side `.skill-lock.json` and `packages/gateway/src/install.ts`, `SkillInfo`/`SkillsResponse`, and the shared `market-card*`/`skill-outcome` styles. No data was touched: no migration, no table drop, no lock edit.

Tests. `apps/web/components/SkillsRetirement.test.mjs` asserts the removal itself — the seven modules are absent, no surviving source imports or mounts them, `market.css` is not loaded, `settings-navigation` has no market section, the dead selectors are gone, and the built-in panel is the entry point — and separately that the market namespace, its stored bundles and the execution-side lock still exist, so a future "cleanup" cannot quietly delete live machinery instead of retired surface.

Verification: `pnpm --filter @hepi/web typecheck`, `next build`, gateway 80/80, server 129/129, `test:skills` PASS (55 unit tests, both browser fixtures, the built-in smoke), `test:skills-sshd` PASS, and all six packages' `tsc --noEmit` clean. The publish route now has no UI caller — recorded above, not given a stub surface.

#### Whole-web provenance, corrected

An earlier claim of "2047 tests / 24 fail, byte-identical to base" is retracted: it described an incomplete file subset (a bare `lib/*.test.mjs` glob, which misses the nested `lib/i18n/` tests), so 2047/2079 do not describe the whole Web suite; and its baseline was not an isolated tree — `git stash` is shared across worktrees, so the "base" run executed the same unmodified tip tree as the first, making the comparison vacuous. The measured, complete numbers are 2065 tip / 2104 base below.

Measured again, file list from `find . -name '*.test.mjs' -not -path './node_modules/*' -not -path './.next/*' -not -path './vendor/*'` (the `vendor/pi-web` snapshot is upstream provenance, not this repo's suite, and the canonical `lib components hooks adapters` directory form no longer runs on this machine's Node v26.5.1, which rejects directory arguments):

| Tree | Command | Log | tests | pass | fail |
| --- | --- | --- | --- | --- | --- |
| tip `impl/ux-follow-up-14` | `node --test --test-reporter=tap $FILES` in `apps/web` | `/tmp/ux14-all-tip.tap` | 2065 | 2042 | 23 (12 suites, 24 unique `not ok` names) |
| base `4323109` (detached worktree, since removed) | same | `/tmp/ux14-all-base.tap` | 2104 | 2081 | 23 (13 suites, 24 unique `not ok` names) |

The delta is exactly the retired files: 39 fewer tests and one fewer suite, all of them the deleted panel's and helpers' own cases, so **no surviving previously-passing test regressed**. Failure sets compared name-by-name with `.scratch/ux-follow-up/issues/ux14-wholeweb-compare.mjs` (strips only the `/apps/web/` prefix, then reports `newFailureNamesOnTip` and `failureNamesOnlyOnBase`): both empty, so the sets are identical. Node's `# fail` counter is **23** while the logs hold **24 unique `not ok` names** (one file contributes a nested child assertion as well as its own rollup); those are two counts of the same tree, not 24 independent defects. The committed `ux14-wholeweb-failnames-{base,tip}.txt` lists hold all 24 names and are byte-identical to each other. Names: `SessionSidebar.file-search`, `SettingsPanel`, `builtin-extensions`, `gfm-autolink-email-loader`, `mcp-config-file`, `mcp-config-read`, `mcp-host`, `mcp-sign-in` (+ `.integration`), `mcp-test`, `model-catalog-refresh`, `node-version`, `pi-web-node-args`, `pi-web-options`, `process-lifecycle`, `rotate-preview-secrets`, `terminal-manager`, `web-auth-proxy`. All are environment/module-load and one API-key case — the historical baseline, present before this ticket.

The pack smoke's bundled-notice assertion (`packages/client/scripts/smoke-pack.mjs`) now also requires `Copyright (c) 2026 agegr` in the emitted `dist/cli.js`, so the fix this ticket made cannot silently regress. It is one added string in an existing check, not a new gate; the packed artifact already carries it.

Environment note: the pack smoke's `npm install` step needs lifecycle scripts to be permitted. It passes (6/6 checks, build + install + CLI + doctor + local and real-sshd gateway) in the isolated worktree used here; an earlier attempt on another machine failed at that step under an `EALLOWSCRIPTS` policy, identically on the unmodified tree. That is an environment setting, not a packaging defect, and changing an operator's npm security config is out of scope.
