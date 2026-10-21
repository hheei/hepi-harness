# UX follow-up implementation validation

**Dated append-only log.** Each section records what was run at that moment and is kept as written; tip counts and
baseline numbers differ between sections because they were measured at different pins, which is the point of the log —
they are not competing claims about now. For the current entrypoints, the current whole-web baseline (23 of 2084 at
`edef2c0`, all pre-existing) and how to reproduce it, read [docs/verification.md](../../docs/verification.md).

Integration branch: integration/ux-follow-up.
Implementation authorized by user: "可以，开始吧". Deployment and paid live-provider smoke remain outside scope.
Baseline application/spec publication: 160895b; kickoff/status commit: cda2416.

## Baseline before implementation

| Check | Result |
| --- | --- |
| pnpm -r typecheck | Passed across protocol, client, gateway, session, Web and server. |
| pnpm -r test | Passed: protocol 10, client 9, session 3, gateway 59, server 70 (151 tests). |
| Web test:upstream | Passed: 15 normalization, streaming and file-mention tests. |

This does not establish all Web component/browser coverage. The new tickets require actual browser outcomes;
the workspace test command does not discover a general Web suite. The advertised Web test:e2e/test:terminal
scripts point to absent e2e entry files in the baseline checkout. Use the installed Playwright dependency and
narrow reusable browser fixtures to verify actual production components, not private/source-extraction tests.
Existing historical source-test failures are not reclassified as passing by this baseline.

Production Web build/services were not touched. Worktree builds/test servers must use isolated outputs and
ports. Test model requests use controlled providers; local/localhost SSH fixtures use temporary directories.

## Ticket 01 — failed terminal tabs close

Merged `ab73097` (`impl/ux-follow-up-01`: first pass 80a1e33, follow-up for held creation/cleanup) into
integration/ux-follow-up with `git merge --no-ff`, merge commit **ee8fdef**. Merge tree is identical to `ab73097`
(`git diff --stat ee8fdef ab73097` empty), so no conflict resolution changed source. No unrelated refactor: the change
is TerminalPanel close-as-local-action, AppShell dropping closing tabs from the saved layout, removal of the unused
`onCloseError` prop, the e2e driver and one package.json script.

| Check | Command | Result |
| --- | --- | --- |
| Workspace types | `pnpm -r typecheck` | Passed (exit 0), protocol/client/gateway/session/web/server. |
| Workspace tests | `pnpm -r test` | Passed (exit 0): protocol 10, client 9, session 3, gateway 59, server 70 — 0 fail. |
| Web terminal units | `node --test components/AppShell.terminal.test.mjs components/TerminalPanel.test.mjs lib/terminal-input.test.mjs` | Passed (exit 0): 10/10. |
| Browser driver | `node apps/web/e2e/ux-terminal-close.mjs` in `/tmp/hepi-ux-follow-up-01` (existing isolated worktree, own `.next`) | **exit 0**, 8/8 `PASS` lines: failed creation, rejected/absent/disconnected cleanup, held creation, held cleanup, normal close, restart + reload. No fixed sleeps; no PTY. |

The driver ran against that worktree's prebuilt `.next`, whose tree matches `ab73097` and therefore the merged tree,
so no separate validation build was needed. Headless Chromium and both backend/Next children exited; no
`ux-terminal-close` process or fixture remained afterwards. The main repository `.next` was not built.

The whole-web source-test run keeps its **21 pre-existing failures** (2055 tests, 2034 pass) as historical baseline
only; they are not reclassified as passing, and no claim of an all-Web pass is made. Ticket 01's own browser evidence is
the 8/8 driver above.

## Ticket 02 — every visible turn highlights

Merged `da991f8` (`impl/ux-follow-up-02`; parent 7c997c9, ancestor of the ticket-01 branch) with `git merge --no-ff`,
merge commit **8ffe804**. Only `apps/web/package.json` auto-merged: both `test:terminal-close` (01) and
`test:visible-turns` (02) are present, and the 02 `esbuild` devDependency with its lock importer and the
`e2e/**/*.ts{,x}` tsconfig entries survived. Ticket-01 sources are byte-identical to the verified worktree
(`git hash-object` equal for AppShell.tsx, TerminalPanel.tsx, ux-terminal-close.mjs), so the 01 browser evidence stands
and its worktree build was not reused for 02. The change itself is ChatMinimap's `visibleIndices` (viewport
intersection) split from `focusedIndex` (click/keyboard), replacing the single 30 %-proximity `activeIndex` and its
1600 ms lock.

| Check | Command | Result |
| --- | --- | --- |
| Workspace types | `pnpm -r typecheck` | Passed (exit 0). |
| Workspace tests | `pnpm -r test` | Passed (exit 0): protocol 10, client 9, session 3, gateway 59, server 70 — 0 fail. |
| Web minimap units | `node --test components/ChatMinimap.test.mjs components/ChatWindow.scroll-to-latest.test.mjs` | Passed (exit 0): 9/9. |
| Browser driver | `pnpm --filter @hepi/web test:visible-turns` | **exit 0**, 29 `ok` checks, "UX-02 BROWSER CHECKS PASSED". |

The 02 driver bundles the real `ChatMinimap` with the workspace's own esbuild into a temp dir and serves it on
127.0.0.1:43102; it touches no `.next`, no running service and no paid provider. It ran from the main checkout after
`pnpm install --frozen-lockfile` (exit 0, lockfile unchanged, no repo mutation beyond the pre-existing `.agents/skills`
gitlink). Port 43102 was free afterwards and no driver process remained.

## Ticket 03 — configured aliases report real catalog capabilities

Merged `75e94dd` (`impl/ux-follow-up-03`; parent 444bded, child follow-ups e951bac and 521b613 both ancestors) with
`git merge --no-ff`, merge commit **fb7d343**. Merge tree is identical to `75e94dd` (`git rev-parse` equal,
`git diff --stat` empty) and the merge touched no `apps/web` path, so tickets 01/02 are unaffected. The change
replaces the DeepSeek-only special case with the upstream generated catalog: the configured provider's own entry wins,
otherwise the facts every catalog agrees on for that model id are adopted and a field the catalogs disagree about
stays unknown. `getAllBuiltinModels` + `hasApi` replace the `getBuiltinModels(...) as unknown as ChatModel[]`
double cast, and `upstreamFacts` returns `Partial<PortableFacts>` instead of asserting a full record.

| Check | Command | Result |
| --- | --- | --- |
| Workspace types | `pnpm -r typecheck` | Passed (exit 0). |
| Workspace tests | `pnpm -r test` | Passed (exit 0): protocol 10, client 9, session 3, gateway 59, server 75 — 0 fail (core 156). |
| Provider tests | `node --test test/provider-config.test.ts` in `apps/server` | Passed (exit 0): 5/5 — alias image input, real 1x1 PNG bytes as the `image_url` data URL, text route. |
| Web catalog smoke | `pnpm --filter @hepi/server smoke:catalog` | **exit 0**, 13 `ok` + "Web-origin catalog smoke passed": `magpie/deepseek-v4.1-flash` `input ["text","image"]`, default model, authenticated session, one `/v1/chat/completions` request with the configured key/model/prompt. |

The smoke needs a production Web build and starts `next start` itself, so it cannot run against the main checkout
(main `.next` is pre-ticket-01 and is not rebuilt here). The ticket-03 worktree `/tmp/hepi-ux-follow-up-03` was
**not** reused: its `.next` (13:57) predates its own 14:27 checkout of ChatMinimap and still contains
`NAVIGATION_ACTIVE_LOCK_MS`, i.e. a pre-ticket-02 bundle. A dedicated isolated worktree
`/tmp/hepi-ux-validation-03` at the merged tip `fb7d343` was used instead: `pnpm install --frozen-lockfile`
(exit 0), `pnpm --filter @hepi/web build` (exit 0), then the smoke (exit 0). Its `apps/web` tree hash equals the
integration tree hash. The smoke bound an ephemeral loopback port, made no paid call, and left no process, listener or
temp directory behind.

## Ticket 04 — builtin Skills install feedback and revision state

Merged `216860b` (`impl/ux-follow-up-04`; parent `6df412c`, review follow-up `ea56dff` an ancestor) with
`git merge --no-ff`, merge commit **f6f0772**. Merge tree is identical to `216860b` (`git rev-parse` equal) and the
merge changed no `apps/web` path, so tickets 01-03 are unaffected. Review follow-ups in scope: `semver` `valid`/`rsort`
replace the hand-rolled version parser, an installation is compared with the repository only when the repository
published it (`sourceType === "repository"`), and a named conversation that is bound to a different workspace — or to
none — is refused as `conflict`/`409` before anything is published. The UI names a conversation only for the workspace
it actually runs on (`conversationTarget`). Server-side `semver`/`@types/semver` dependency, lock importer entries and
all existing scripts are preserved.

| Check | Command | Result |
| --- | --- | --- |
| Workspace types | `pnpm -r typecheck` | Passed (exit 0). |
| Workspace tests | `pnpm -r test` | Passed (exit 0): protocol 10, client 9, session 3, gateway 59, server 83 — 0 fail (core 164). |
| Installer API | `node --test test/skill-install.test.ts` in `apps/server` | Passed (exit 0): 23/23 — semver ordering, repository-only revision, 409 unbound/mismatched conversation. |
| Browser, controlled SSH transport | `node apps/server/scripts/skills-ui-smoke.ts --mode builtin --transport controlled` | **exit 0**, 31 `ok`, 0 `FAIL`, "== result: PASS (builtin)". |
| Browser, real localhost sshd | `node apps/server/scripts/skills-ui-smoke.ts --mode builtin --transport sshd` | **exit 0**, 32 `ok`, 0 `FAIL`, "== result: PASS (builtin)". |

Both transports run the real browser against the real UI. They share the same global directories: the run asserts the
real account's `~/.agents/skills` and `~/.pi/agent/skills` are byte-identical before and after. The `sshd` half uses a
throwaway localhost `sshd` (own key pair, pinned known-hosts, ephemeral port) driven by the gateway's real `ssh` runner
and exercises the remote host at project scope inside a temporary workspace; the controlled half makes the gateway's own
Python helper answer as a temporary login/home so remote global scope is covered without touching a real account.

The smoke needs a production Web build, so the ticket-04 worktree `/tmp/hepi-ux-follow-up-04` was checked first: its
`.next` (15:32) postdates its own 15:31 `ea56dff` checkout, no source file under `apps/web` is newer than
`BUILD_ID`, its `apps/web` tree hash equals the integration tree hash, and the built client chunk carries the
ticket-04 strings (`no conversation was asked to reload`, `up-to-date`). The build therefore matches the merged tree
and was reused as-is — the main checkout's `.next` was not rebuilt. No paid provider, no deployment, no service change;
no smoke process, listener or temp directory was left behind.

## Ticket 12 — merged (7ca85f0), and ticket 28's note integrated

Ticket 12 (`impl/ux-follow-up-12` tip `951c161`: feature `e989520`, fixes `75db25d`/`7faa3fd` and the review record
`951c161`) was merged from `cb09664` with `git merge --no-ff` as **7ca85f0**, clean, and then ticket 28's docs-only
commit `4edd021` (11 lines: a `record` finding on filesystem aliases between two install names) was cherry-picked as
**bc572e4**. The cherry-pick landed on `integration/ux-follow-up` only; branch `impl/ux-follow-up-10` keeps its own
`b8d1d00`/older metadata and its verified issue text was not overwritten.

12 branched before `cb09664`, so its tree carried the *old* `SessionSidebar.test.mjs` and
`new-session-context.test.mjs`; merging it into `cb09664` keeps this branch's corrected assertions (verified:
`git diff cb09664 <merge> --` those two files is empty). `apps/web/package.json` kept every script including the new
`test:models-config`. Spot-checked in the merged source: the three-state `defaultModel` in `harness.ts` (`undefined`
hands the built-in scripted default, `null` is preserved as no default and never turned back into a reference, a
reference is kept even when the catalog no longer serves it), one `echo-faux` provider shared by the harness registry
and environment mode, the env-mode `ModelRuntime` over the same agent dir with `allowNetwork: false` and no shadow
registry (`models-store.json` is never written), the 0600 + rename atomic write, and 08's folder/default store plus
06's nullable model projection untouched.

### One fresh isolated validation at bc572e4

Fresh worktree `/tmp/hepi-ux-v12` (base `bc572e4`, `pnpm install --frozen-lockfile`), own production `.next` built
there; the main checkout's `apps/web/.next` was not rebuilt (still 06:31). No main `.next`, no paid provider, no
deployment, no live credential. The worktree was pruned after its checks; the types and workspace-test rows were then
re-confirmed on the main checkout at `820e426`, whose source tree is identical to `bc572e4` (the only commit between
them, `820e426`, is documentation), so the source-verification result is the same tree.

| Check | Command | Result |
| --- | --- | --- |
| Types | `pnpm -r typecheck` | exit 0, 6/6 |
| Workspace tests | `pnpm -r test` | exit 0: protocol 15, client 9, session 3, gateway 62, server 119 — **208, 0 fail** |
| 12 models config units | `node apps/server/test/models-config.test.ts` | exit 0, 12/12 |
| 12 models editor, real browser | `node apps/web/e2e/ux-models-config-save.mjs` | exit 0, "Models-config Web regression passed": saved model served after a real backend restart, file unchanged by the restart |
| Image admission with no model | `node apps/server/test/submission-images.test.ts` | exit 0, 6/6, incl. a selected model the catalog no longer serves admitting the submission and failing natively (`defaultModel` null preserved) |
| 06 image submit (affected path) | `node apps/web/e2e/ux-image-submit.mjs` | exit 0, 21 ok |
| Whole-web source tests | `node --test lib components hooks adapters` | 2079 tests, 2056 pass, 23 fail — identical set to `7262f85` |

The 208 core tests are the expected 119 server (106 main + 13 ticket-12) plus protocol 15, client 9, session 3 and
gateway 62. 08/10's own browser drivers and the 10 smoke were already run at `cb09664` and were not repeated, because
12 touches no route, folder/default or skills-inventory code path; only the image-admission path and the models editor
were re-checked as the affected surfaces. The 23 whole-web failures are the historical baseline exactly as before, with
no new failure and none gone.

One low-impact finding from the same review is recorded in [issue 12](issues/12-backend-pi-model-config.md): the
localized `models.savedNotApplied` string is unreachable because the generic error guard in `handleSave` precedes the
`applied === false` branch while the backend always attaches an `error`; the truthful backend diagnostic is still
shown, so it is `record` with no patch and no test.

## Phase B dispatch (in progress)

Phase A (bug slices 01-04) is complete and merged: `f6f0772` on integration/ux-follow-up carries all four. The
bug-first dispatch order from [ticket-breakdown.md](ticket-breakdown.md) is satisfied, so feature frontier 05-13 was
dispatched. This coordinator record is documentation only — no application source, build or test was touched.

Five isolated implementation worktrees, all based on the same Phase A merge `f6f0772` and each on its own branch:

| Ticket | Branch | Worktree | Base | Child |
| --- | --- | --- | --- | --- |
| 05 token-footer SVG + browser display preference | `impl/ux-follow-up-05` | `/tmp/hepi-ux-follow-up-05` | f6f0772 | agent 25 |
| 06 image submission, SSE and restart history | `impl/ux-follow-up-06` | `/tmp/hepi-ux-follow-up-06` | f6f0772 | agent 27 |
| 07 Web-host single-folder New Project | `impl/ux-follow-up-07` | `/tmp/hepi-ux-follow-up-07` | f6f0772 | agent 26 |
| 10 Skills dual-source search and download | `impl/ux-follow-up-10` | `/tmp/hepi-ux-follow-up-10` | f6f0772 | agent 28 |
| 12 backend Pi model configuration | `impl/ux-follow-up-12` | `/tmp/hepi-ux-follow-up-12` | f6f0772 | agent 29 |

Issue 05, 06, 10, 12 are `in-progress`; 07 and 12 carry a **proposal-first** gate — the host-directory
browsing/registration contract (07) and the env-mode → authoritative Pi configuration conversion (12) must be
discovered and reported before any code lands. Tickets 08, 09, 11, 13 remain `ready-for-agent` with their published
blockers, and 14 (retire the Market implementation) still waits for complete retained Skills coverage; none of them is
started or marked done here.

This section is the coordinator's dispatch record. Each worker owns the same issue file and reports its own red/green
evidence; a worker's status change for its ticket merges identically rather than being duplicated here. **05, 06, 07,
08 and 10 are integrated** (below); 12 is being corrected; 09's source check is complete and waits on SSH
administration; 11 and 13 remain as published; 14 last.

## Tickets 08 and 10 — merged sequentially (cc22f75, 2036d6a)

The committed review policy (`docs/agents/review-policy.md`, `7262f85`) governs this round: findings are triaged by
trigger, likelihood in normal use and actual user impact into `fix` / `record` / `investigate`, and a fix corrects the
owning abstraction rather than adding a per-call guard. Both branches were merged with `git merge --no-ff` from
`7262f85`:

| Ticket | Branch tip | Merge commit |
| --- | --- | --- |
| 08 single-host multi-folder Project and default | `2aab405` | **cc22f75** |
| 10 dual-source Skills search, real fixes | `79b55d1` | **2036d6a** |

Both merges were clean; the only auto-merged file was `apps/web/package.json` (both branches append a script), and
every script survives — `test:image-submit`, `test:new-project`, `test:skills-inventory-race`, `test:token-footer`,
`test:visible-turns`, `test:terminal-close`. The merged source keeps 07's routes, 06's nullable model projection,
08's multi-folder projects, the sidebar's per-project grouping and 10's newest-read-wins guard (spot-checked in
`apps/web/adapters/durable-api.ts`, `apps/server/src/server.ts`, `apps/web/lib/session-tree.ts`,
`apps/web/components/SkillsConfig.tsx`, `apps/server/src/skill-install.ts`).

### Ticket 10 — two real product bugs fixed, not speculative findings

Both are ordinary-use failures with a deterministic reproduction, so both are `fix`:

1. **First-time Skills inventory returned 500.** `lock.value !== undefined` let the SSH helper's `null` through and
   `lock.value.skills` threw. Guard is now `lock.value != null`; deterministic test
   `apps/server/test/skill-install.test.ts` "lists a host whose lock was never written instead of failing the read".
2. **A stale inventory answer replaced the selected host's list.** `loadSkills` published any arrival; it now carries
   a generation and only the newest read publishes. Deterministic browser driver
   `apps/web/e2e/ux-skills-inventory-race.mjs`.

Measured **after** the merge at `2036d6a`: 16 controlled-transport runs and 6 real-sshd runs, **all pass** (43 checks
each), against ~1-in-5 failing before the fix. Before the merge the flake was reproduced on the merged pre-fix tip
**and** on 10's own branch tip, which is what classified it a real bug rather than a merge artifact.

### Ticket 08 — three whole-web failures its own tests left stale (`fix`, corrected)

The merged tree added three whole-web source-assertion failures that do not exist at `7262f85` (they fail on
08's own branch tip `2aab405` too). 08 intentionally changed three contracts but left the tests asserting the old
code: the header "+" now resolves the current project's default folder instead of the raw sidebar cwd, a group's "+"
uses a recorded project's default folder, and `mergeProjectChoices` carries a recorded display name. Tests are not
the product; the behaviour is the ticket's own requirement, so the assertions were updated to the delivered contract
(no production change). After the correction the whole-web set matches the baseline exactly: **no new failure, none
gone** (2082 tests, 2059 pass, 23 fail at both `2036d6a` and `7262f85`).

### Combined verification at 2036d6a

Run once, in one fresh isolated worktree `/tmp/hepi-ux-merge2` (base `2036d6a`, `pnpm install --frozen-lockfile`) whose
own production `.next` was built there; the main checkout's `apps/web/.next` was not rebuilt or touched.

| Check | Command | Result |
| --- | --- | --- |
| Types | `pnpm -r typecheck` | exit 0, 6/6 |
| Workspace tests | `pnpm -r test` | exit 0: protocol 15, client 9, session 3, gateway 62, server 106 — 195, 0 fail |
| 07 New Project driver | `node apps/web/e2e/ux-new-project.mjs` | exit 0, 49 ok |
| 08 project store/routing units | `node apps/server/test/project.test.ts`; `node --test lib/project-routing.test.mjs` | exit 0, 9 and 3 |
| 10 inventory race driver | `node apps/web/e2e/ux-skills-inventory-race.mjs` | exit 0, "== result: PASS" |
| 10 smoke, controlled | `skills-ui-smoke.ts --mode builtin --transport controlled` | 16 runs, 16 pass, 0 fail |
| 10 smoke, real sshd | `skills-ui-smoke.ts --mode builtin --transport sshd` | 6 runs, 6 pass, 0 fail, account dirs byte-identical |
| 06 image submit | `node apps/web/e2e/ux-image-submit.mjs` | exit 0, 21 ok |
| 05 footer, 01 terminal, 02 visible turns | the three drivers | exit 0, 3 checks, 8/8, 29 ok |
| Whole-web source tests | `node --test lib components hooks adapters` | 2082 tests, 2059 pass, 23 fail — identical set to `7262f85` |

The 23 whole-web failures are the historical baseline (environment/module-load plus one API-key unit case); the merged
tree adds none and removes none. No main `.next`, no paid provider, no deployment, no live credential, no port or
temporary directory left behind.

### Ticket 08 dispatch (no new worktree)

Ticket 08 reuses the workflow's own worktree directory `/tmp/hepi-ux-follow-up-07`, whose branch is now
`impl/ux-follow-up-08` at base `1bda245` (checked out there; the tree is clean). Branch `impl/ux-follow-up-07`
still points at its frozen `7fdf395`. `/tmp/hepi-ux-follow-up-08` deliberately **does not exist**: an earlier
attempt to add a second worktree for the same branch created a stray agent process; that process made no edit and was
stopped, and the unused new worktree was removed without `--force`. No new worker is running from the coordinator
side.

**08 is implemented and verified on that branch** (feature `91f8e48`, merged with the then-current
`integration/ux-follow-up` `1241a1a` as `25fe010`): a project holds several folders of one computer with exactly one
default, the default reference is deferred because the two project tables reference each other, the single-folder
database is rebuilt in one transaction (SQLite refuses to drop its UNIQUE column), every folder resolves for bindings and
re-registration, and every new-session affordance binds the default. Evidence and limits are on
[issue 08](issues/08-single-host-project-folders-default.md).

## Ticket 05 — merged (0bcd1e0)

`impl/ux-follow-up-05` (tip `4592da6`: feature `d82bc4f`, merge `7e81513` of `10081da`, cache-glyph review
follow-up `4592da6`) was merged into integration/ux-follow-up with `git merge --no-ff` as **0bcd1e0**. `10081da`
is an ancestor of the branch tip, so the merge is clean and its tree equals the branch tip's (`63076c6`). The
follow-up is the parent-requested correction: cache read and cache write no longer share one hard-drive silhouette —
`hard-drive-upload` (read, arrow leaving the disk, reading like the input arrow) and `hard-drive-download` (write,
arrow landing, reading like the output arrow) — on the same 24 grid, 1.8 stroke, `currentColor` and 11px display,
with verbatim lucide `1.54.0` paths, the full `apps/web/components/lucide-icons.LICENSE` and the
`docs/upstream-sources.md` provenance note that lists the rejected alternatives.

| Check | Command | Result |
| --- | --- | --- |
| Browser regression, merged tree | `pnpm --filter @hepi/web test:token-footer` | **exit 0**, "UX-05 BROWSER CHECKS PASSED" |
| Types | `pnpm -r typecheck` | exit 0, 6/6 projects |
| Workspace tests | `pnpm -r test` | exit 0: protocol 10, client 9, session 3, gateway 59, server 83 — 164, 0 fail |
| Ticket units | `node --test lib/response-usage-visibility.test.mjs components/MessageView.test.mjs components/SettingsPanel.response-usage.test.mjs lib/i18n/registry.test.mjs` | exit 0, 42/42 |

The browser run is the real driver, unpiped: it bundles `apps/web/e2e/ux-token-footer.fixture.tsx` with the
workspace's own esbuild into a temporary directory, serves it from `127.0.0.1:43105` and drives it with the installed
Playwright, so no production `.next` was built or used — the main checkout's `apps/web/.next` is untouched (dated
06:31). It mounts the real `MessageView`, real i18n and the real preference module, and asserts against rendered DOM,
computed styles and real clicks/reloads: four 11×11 metrics at a uniform 1.8 stroke in the footer colour with paired
numbers and localized accessible names (en, zh-CN, zh-TW); input/output directions matching the aggregate toolbar;
both cached glyphs rasterized live through a canvas at the footer's real 11px in light and dark, requiring ink in both
and more than 12% differing pixels, plus 8× device-pixel zoom copies for the human; no footer overflow or horizontal
scroll at light/dark × 900/360; the switch defaulting on, hiding only the footer statistics while the reply text
stays, persisting to `localStorage` and surviving a reload both ways; and the aggregate toolbar keeping its own
10-grid/1.2-stroke glyphs. Screenshots land in `/tmp/hepi-ux05-artifacts`; they are evidence, not acceptance.

Limitations, explicit: **no human acceptance is claimed** — visual judgement of the icons remains the user's, and the
rasterized comparison plus zoom screenshots only show the glyphs are inked and distinguishable at real size.
`components/SettingsPanel.test.mjs` still cannot run in this checkout (it reads an absent `app/login/page.tsx`), so
the switch wiring is asserted by `SettingsPanel.response-usage.test.mjs`; that file is one of the 21 pre-existing
whole-web failures, which stay **historical baseline**, not newly green. No paid provider, no deployment, no service
restart, no mutation outside the merge, and no port or temporary directory left behind (43105 free after the run). User
approval was not required as a merge gate; this is a coordinator merge of a parent-reviewed change.

## Ticket 06 — browser image submission, SSE and restart history

Implemented on `impl/ux-follow-up-06` (first commit `42444cf`). No parallel image framework: the command gained an
optional native `images` field, the backend submits those blocks through the runtime's own `UserInput.content`, and the
existing `MessageView` image path renders restored history unchanged.

| Check | Command | Result |
| --- | --- | --- |
| Workspace types | `pnpm -r typecheck` | Passed (exit 0), 6/6. |
| Workspace tests | `pnpm -r test` | Passed (exit 0): protocol 15, client 9, session 3, gateway 59, server 89 — 0 fail. |
| Protocol image limits | `pnpm --filter @hepi/protocol test` | Passed (exit 0), 15/15. |
| Backend image path | `node apps/server/test/submission-images.test.ts` | Passed (exit 0), 6/6, controlled OpenAI-completions endpoint and SQLite restart fixture. |
| Web image units | `node --test lib/image-attachments.test.mjs lib/i18n/registry.test.mjs lib/agent-client.test.mjs components/ChatInput.test.mjs adapters/durable-api.test.mjs` | Passed (exit 0), 55/55. |
| Browser, real Web origins | `pnpm --filter @hepi/web build` then `pnpm --filter @hepi/web test:image-submit` | **exit 0**, 21 `ok`, "UX-06 image submission checks PASSED": insecure HTTP LAN origin submit with exact bytes at the controlled endpoint, reconnect restore, backend-restart restore, self-signed HTTPS origin submit, named refusals with no model call, text-only-model refusal shown in the UI. |
| Regression (tickets 01, 02) | `node apps/web/e2e/ux-terminal-close.mjs`; `pnpm --filter @hepi/web test:visible-turns` | Both exit 0 (8/8 PASS; "UX-02 BROWSER CHECKS PASSED"). |

The whole-web source-test run keeps its **21 pre-existing failures** (2076 tests, 2055 pass) as the historical baseline;
no all-Web pass is claimed. Ports 43106 (Web) and 44106 (fixture backend) are this ticket's own; the driver starts a real
local gateway + backend fixture (`apps/server/scripts/image-submit-fixture.ts`) with a temporary workspace, a temporary
SQLite file and a controlled local model endpoint. No paid provider, no deployment, no live credential, no main `.next`.

## Tickets 06 and 07 — merged sequentially (0d22103, 1bda245)

Ticket 10 was already integrated by the parent as `a80522c` (`f517b0b`) before this merge round began; its merge in
the history is not revisited here and no valid work was reset. From the actual head `a80522c` the two branches were
merged in order with `git merge --no-ff`:

| Ticket | Branch tip | Merge commit |
| --- | --- | --- |
| 06 image submission, SSE and restart history | `9941acb` (`a1420a4` review follow-up) | **0d22103** |
| 07 Web-host single-folder New Project | `7fdf395` (`87a1da7` feature, `90c24ac` merge of `0588901`, gateway-restart fix) | **1bda245** |

Merge 06 was clean; merge 07 had exactly one conflict, in `apps/web/package.json`, where both branches appended a
script. It was resolved as real code, not by a bulk `ours`/`theirs` choice: **both** `test:image-submit` (06) and
`test:new-project` (07) are kept, because each has its own driver, and no other entry was dropped. Every other
auto-merged file was inspected for conflict markers (none) and each ticket's invariant was re-checked in the merged
source:

- 06 — a nullable model projection: `state()` omits `model` when the snapshot's selection is `null` rather than
  fabricating a default, and an empty `images` array is not an image submission.
- 07 — the Web host mapping stays a Web-origin concern: `HEPI_WEB_LOCAL_GATEWAY_ID` is read in
  `apps/web/adapters/durable-api.ts` and sent as `hostId`, resolved by the backend against its own configured
  gateways; 07's forwarding is separate from the backend's own configuration. The gateway-registration replay
  (`ensureBinding` → `registerProject`, and `installer.ensure`) is the idempotent bare-gateway restart fix.
- 10 — the public catalog search and its miss reporting are unchanged by these merges.

### Combined verification at 1bda245

Run once on the merged tree, in one pass, from a fresh isolated worktree `/tmp/hepi-ux-merge` (base `1bda245`,
`pnpm install --frozen-lockfile`) whose own production `.next` was built there; the main checkout's
`apps/web/.next` was not rebuilt or touched (still 06:31).

| Check | Command | Result |
| --- | --- | --- |
| Types | `pnpm -r typecheck` | exit 0, 6/6 projects |
| Workspace tests | `pnpm -r test` | exit 0: protocol 15, client 9, session 3, gateway 62, server 102 — 191, 0 fail |
| 06 browser driver | `node apps/web/e2e/ux-image-submit.mjs` | exit 0, 21 `ok`, "UX-06 image submission checks PASSED" |
| 07 browser driver | `node apps/web/e2e/ux-new-project.mjs` | exit 0, 27 `ok`, "UX-07 New Project regression passed" |
| 05 footer browser | `node apps/web/e2e/ux-token-footer.mjs` | exit 0, "UX-05 BROWSER CHECKS PASSED" |
| 01 terminal browser | `node apps/web/e2e/ux-terminal-close.mjs` | exit 0, 8/8 PASS |
| Minimap unit | `node --test components/ChatMinimap.test.mjs` | exit 0, 3/3 |

The 07 driver is the real user path through three processes (Next UI → backend → gateway → host directory) and covers the
host's own directories, the opaque workspace id, tool execution in the chosen folder, an existing conversation keeping its
own binding, page/backend/gateway restarts, and the **gateway-alone restart** idempotently re-registering the project. 06
drives the real composer and route on an insecure LAN origin and a self-signed HTTPS origin. Neither used the main
checkout's `.next`.

### Ticket 10 — smoke flake, reported not hidden (pre-79b55d1, superseded)

Historical: this is the state **before** ticket 10's fix `79b55d1` landed. The flake below is the real bug that commit
fixed (with `lock.value != null` and the newest-read generation), so at tip `cb09664` the driver passes on the merged
tree; see the 08/10 section above for the post-fix counts.

`apps/server/scripts/skills-ui-smoke.ts --mode builtin --transport controlled` (the ticket-10 browser acceptance
driver) was run repeatedly against both the merged tip and 10's own branch tip `f517b0b`, each with a fresh worktree
`.next`:

| Tree | Runs | PASS | FAIL |
| --- | --- | --- | --- |
| merged `1bda245` | 27 | 21 | 6 |
| `f517b0b` (10's tip) | 15 | 12 | 3 |

Both trees fail at roughly the same rate, so the flakes are a conditional, not a merge regression. The failure is in the
**update-after-local-edit** step: the press of "Replace anyway" occasionally leaves the
`Updated notes (global)` notice or the post-refresh "Up to date" state unobserved within the driver's 30 s wait. It
reproduces on 10's own branch tip **without** 06/07, so it is **not** introduced by these merges. No driver timeout was
loosened and no assertion was weakened to make it pass; the real account's resource directories were bytes-identical
before and after every run, including the failing ones.


## Tickets 09 and 13 — merged sequentially (d158de3, 3c8b478)

Ticket 09 (`impl/ux-follow-up-09` tip `42b3470`) merged into `89f41b2` with `git merge --no-ff` as **d158de3**, clean,
tree intact; the frontier was published at that point so ticket 11 can base on it. Ticket 13
(`impl/ux-follow-up-13` tip `eaea521`) then merged atop d158de3 as **3c8b478**. Its only conflict was in this file
(both branches appended a ticket section); it was resolved by keeping **both** sections, not by choosing one.
`apps/server/src/server.ts` auto-merged and keeps 09's `HostRequest`/`profiles`/replay owner **and** 13's
`readRunFailure` projection and `attachConversation` `readFailure` seam in one file. `apps/web/package.json` keeps every
script, including 09's `test:ssh-project` and 13's `test:missing-model`; 08's `defaultFolderId`, 06's null-model
projection, 12's `modelConfig`/`openEnvModelRuntime` and the ticket-14 nil metadata are unchanged.

### One combined fresh isolated proof at 3c8b478

Fresh worktree `/tmp/hepi-ux-v0913` (detached at `3c8b478`, `pnpm install --frozen-lockfile`), own production `.next`
built there; the main checkout's `apps/web/.next` was not rebuilt or touched. No live deployment, no paid provider, no
live credential.

| Check | Command | Result |
| --- | --- | --- |
| Types | `pnpm -r typecheck` | exit 0, 6/6 |
| Workspace tests | `pnpm -r test` | exit 0: protocol 15, client 9, session 3, gateway **65**, server **125** — **217, 0 fail** |
| 09 SSH browser driver | `node apps/web/e2e/ux-ssh-project.mjs` | exit 0, 31 `ok`, 0 not ok, "UX-09 SSH project regression passed" (real localhost `sshd`, four processes) |
| 13 missing-model driver | `node apps/web/e2e/ux-missing-model-recovery.mjs` | exit 0, 19 PASS, "Missing-model Web regression passed" |
| Whole-web source tests | `node --test lib components hooks adapters` | 2079 tests, 2056 pass, 23 fail — identical set to `7262f85`, no new failure and none gone |

The 217 core tests are the predicted combination: 09's gateway 65 and server 123 plus 13's two new server tests, with
protocol 15, client 9 and session 3 unchanged. Only the two affected browser paths were re-driven; the other drivers
that already passed on the merged tree were not re-run. The whole-web failure set was re-checked because 13 changed Web
source (adapter, components, i18n), and it matches the historical baseline exactly.

## Ticket 09 — SSH New Remote Project

Branch `impl/ux-follow-up-09` in this worktree, based on `2036d6a` (integration with 08 `cc22f75` and 10 `2036d6a`)
merged with `cb09664` (integration tip: the 08/10 inventory fixes and the review policy). No new worktree and no
branch reset; the same directory, on its own ports 43109 (Web) and 44109 (backend) plus 45109/45110 for the two SSH
gateways. The remote host in every test is a **real localhost `sshd`** (its own host key and key pair, pinned
known-hosts, absolute `AuthorizedKeysFile`, `AllowUsers <this user>`, `StrictModes no`, ephemeral port) — the same
fixture `packages/client/scripts/smoke-pack.mjs` uses; no mock runner stands in for the transport. No live
deployment, no paid model call, and the main checkout's `.next` was not rebuilt or touched.

| Check | Command | Result |
| --- | --- | --- |
| Types | `pnpm -r typecheck` | exit 0, 6/6 projects |
| Workspace tests | `pnpm -r test` | exit 0: protocol 15, client 9, session 3, gateway 65, server 123 — 0 fail |
| Gateway SSH surface | `pnpm --filter @hepi/gateway test` | exit 0: 65 pass, including `ssh-workspaces.test.ts` over the real `sshd` |
| Backend SSH project | `node --test apps/server/test/ssh-project.test.ts` | exit 0: 4/4 over the same `sshd` |
| 09 browser driver | `node apps/web/e2e/ux-ssh-project.mjs` | exit 0, 30 `ok`, "UX-09 SSH project regression passed" |
| 07 browser driver | `node apps/web/e2e/ux-new-project.mjs` | exit 0, "UX-07 New Project regression passed" |
| 02/01/05 browser drivers | `ux-visible-turns.mjs`, `ux-terminal-close.mjs`, `ux-token-footer.mjs` | exit 0 |
| Web unit suites | `node --test lib/*.test.mjs` | exit 0, 56 pass |

The 09 driver is the real user path through four processes (Next UI → backend → packaged SSH gateway → real `sshd` →
the chosen remote directory), with two configured gateway connections so the chosen profile is told apart from the
other one on the same host. It covers the remote target list and the account the host itself reports, the remote
picker, the recorded profile, `bash`/`read` running remotely while the same-named local file is left untouched, the
group's own new session binding the remote default, a **bare SSH gateway restart** re-registering the folder and
executing that existing conversation with no new conversation created, the second profile reading its own file, and
a reload plus backend restart keeping the project, its profile and its remote folder.

### Deliberately out of this ticket

- **Remote workbench.** Files, changes and diff stay local-only; the route answers as it does for any gateway without
  one. Recorded, not stubbed.
- **Python 3 on the SSH host** stays a hard requirement of the remote helper (listing, path confirmation, files and
  installation all use it). A host without it reports `not_supported`; that is the truthful answer, not a fallback.
- **Cross-platform SSH.** Only the current SSH platform is supported, as the ticket says: no new execution
  abstraction was introduced.

## Ticket 13 — missing-model failure and explicit recovery

Branch `impl/ux-follow-up-13` in `/tmp/hepi-ux-follow-up-12`, based on the merged main `bc572e4`, then merged with
`integration/ux-follow-up` (`89f41b2`) before this record. Plan committed before code (`f98ea29`), implementation
`3e1bb90`. No new registry, no scheduler, no second status machine, no new worktree.

The framework already carries the failure, so nothing new was registered: the newest `pi.generation` task's terminal
`no_model` outcome is read from the committed task table and projected on the snapshot the Web already reads, which is
what makes it survive a reconnect and a backend restart. `no_model` is projected alone because it is the one generation
failure the framework settles without appending an entry; a provider rejection already appears as its assistant entry
and is asserted not to be projected again. A busy conversation reports none, so a stale historical failure cannot
outlive the turn that replaced it.

| Check | Command | Result |
| --- | --- | --- |
| Types | `pnpm -r typecheck` | exit 0, 6/6 |
| Workspace tests | `pnpm -r test` | exit 0: protocol 15, client 9, session 3, gateway 62, server 121 — 210, 0 fail |
| 13 failure units | `node --test apps/server/test/missing-model.test.ts` | exit 0, 2/2 |
| Web seams | `node --test lib/models-cache.test.mjs lib/session-reader.test.mjs lib/i18n/registry.test.mjs components/ModelsConfig.test.mjs adapters/durable-api.test.mjs lib/project-routing.test.mjs` | exit 0, 74/74 |
| 13 browser driver | `node apps/web/e2e/ux-missing-model-recovery.mjs` | exit 0, 19 PASS, "Missing-model Web regression passed" |
| 12 models editor (regression) | `node apps/web/e2e/ux-models-config-save.mjs` | exit 0, "Models-config Web regression passed" |

The browser driver uses this ticket's own ports (Web 43113, backend 44113) and its own production `.next`, and runs
three real processes (Next → backend → gateway) with two controlled endpoints. The model it deletes is owned by a
**new** provider the editor creates in this file, so the deletion is real: the environment deployment's alias is a
separate provider and is never touched. It covers the editor save and delete, the failure shown above the composer
with the user's turn still the last transcript entry and no assistant reply for it, the deleted model receiving zero
requests, the composer usable again, a second session on a valid model unaffected, a backend restart plus a browser
reload keeping the selection and the failure, the composer naming the unavailable selection, and recovery through the
composer's own selector reaching the controlled provider.

Whole-web source tests read 2079 tests / 2056 pass / 23 fail — the same 23 pre-existing failures recorded at
`7262f85` (unrelated missing `apps/web/bin/*` fixtures and MCP host fixtures), with no new failure and none gone; no
claim of an all-Web pass is made.

## Ticket 11 — skills check, toggle and project targeting

Ticket 11 (`impl/ux-follow-up-11` tip `4323109`) merged into `5e1baaa` with `git merge --no-ff` as **86516b9**, clean;
its tree is identical to the branch tip (`d78a9695b00775854381fbca4b3d88d15f32f935`), so no conflict resolution changed
it. The frontier was published at this point so ticket 14 can base on it in the same CWD.

The merge keeps every earlier contract: 09's `HostRequest`/`profiles`/replay owner and 13's `readRunFailure` projection
and `attachConversation` seam in `apps/server/src/server.ts` (11 only *adds* the `GET /api/skill-market/check` and
`PATCH /api/skill-market/skills` routes), 08's `defaultFolderId`, 06's null-model projection, 12's `modelConfig`, and
the ticket-14 nil metadata. `apps/web/package.json` keeps every script, including 11's `test:skills-project-target`.

### One combined fresh isolated proof at 86516b9

Fresh worktree `/tmp/hepi-ux-v11` (detached at `86516b9`, `pnpm install --frozen-lockfile`), own production `.next`
built there; the main checkout's `apps/web/.next` was not rebuilt or touched. No live deployment, no paid provider, no
live credential.

| Check | Command | Result |
| --- | --- | --- |
| Types | `pnpm -r typecheck` | exit 0, 6/6 |
| Workspace tests | `pnpm -r test` | exit 0: protocol 15, client 9, session 3, gateway **80**, server **129** — **236, 0 fail** |
| 11 project-target browser driver | `node apps/web/e2e/ux-skills-project-target.mjs` | exit 0, 10 `ok`, 0 FAIL, `result: PASS` |
| Builtin skills smoke, controlled | `node apps/server/scripts/skills-ui-smoke.ts --mode builtin --transport controlled` | exit 0, 52 `ok`, 0 fail, `PASS (builtin)`; real account resource dirs byte-identical |
| Builtin skills smoke, real `sshd` | same with `--transport sshd` | exit 0, 53 `ok`, 0 fail, `PASS (builtin)`; real account resource dirs byte-identical |
| Whole-web source tests | `node --test lib components hooks adapters` | 2086 tests, 2063 pass, 23 fail — same 23-failure set as `7262f85`, no new failure and none gone |

The 236 core tests are the predicted combination: 09's gateway 65 and server 123, plus 11's new gateway and server
tests, with protocol 15, client 9 and session 3 unchanged. The whole-web count rose from 2079 to 2086 — the seven new
tests are 11's own (`lib/skill-inventory.test.mjs`, `adapters/durable-api.test.mjs`, `components/SettingsUi.test.mjs`),
all passing, and the failing set is byte-for-byte the historical baseline, re-checked because 11 changed the skills
inventory/adoption and project-routing Web source.

Only the two affected browser paths were driven; 09's SSH driver and 13's missing-model driver were **not** re-run,
because 11's changes are additive to `server.ts` (new routes only) and touch neither the SSH workspace owner nor the
failure projection, so their proofs at `3c8b478` still hold. No live deployment, no paid provider, no main `.next`.

### Vendored frontmatter helper and its notice

`packages/gateway/src/skill-frontmatter.ts` is adapted from pi-web `lib/skill-frontmatter.ts`, already vendored in this
repository at `apps/web/vendor/pi-web` (commit `76bdc57027172eb381a216d647225a6d24f23360`, MIT, copyright "agegr"). The
adaptation **copies no new vendored tree**: the file carries its own citation to that path, commit and license in its
header, and the repository already ships the full upstream MIT text at `apps/web/vendor/pi-web/LICENSE`. The one
divergence (indentation-based key ownership instead of a parsed YAML mapping, so the rule transcribes to the stdlib
Python remote helper) is documented in the same header. `packages/gateway/vendor/pi-gui` (MIT, "Matthew Lam") is a
different vendored tree and is unaffected. **Correction (ticket 14):** the claim first written here — that no new
distribution obligation arises — was wrong. `skill-frontmatter.ts` is reachable from the gateway entry point, so it is
bundled into the published client's `dist/cli.js`, and its agegr copyright was genuinely missing from
`packages/client/THIRD_PARTY_NOTICES.md`, the emitted bundle header and `docs/upstream-sources.md`. Ticket 14 fixed that
in `e328eef`; see the ticket-14 section below, which verifies the tarball artifact.
### Cleanup note (observed, non-blocking)

After this run, two orphaned `sshd -D -f /tmp/hepi-sshd-*` listeners (PPID 1, started 19:56 and 20:00, from earlier
driver runs, not from the checks above) were found still holding their ports, with their fixture directories left in
`/tmp`. The checks themselves all cleaned up: every driver and smoke run in this proof exited 0 with its own ports free
and no leftover worktree, and the two stale listeners were killed and their directories removed during cleanup. The
real SSH fixture spawns `sshd` inside the gateway process, so a gateway that is terminated without running its fixture
`finally` can leave that listener behind. Recorded as a test-harness hygiene gap; it does not affect any ticket
contract and no code was changed for it.## Ticket 14 — retire the standalone Market, verify the built-in Skills

Ticket 14 (`impl/ux-follow-up-14` tip `e328eef`) merged into `4896fed` with `git merge --no-ff` as **0057f73**, clean;
its tree is identical to the branch tip (`69e973579a70a1f59c74461a4f327bdff5597a35`), so no conflict resolution changed
it. The frontier was published at this point so the final code review can start against a pinned tip.

The retirement removes only surface with no remaining caller: `SkillMarketPanel.tsx` and its test, `lib/skill-market.ts`,
`lib/skill-updates.ts`, `lib/skill-lock.ts`, `lib/skills-service.ts`, `lib/skill-frontmatter.ts`, their test files,
`app/market.css`, the `market.*` i18n keys and the five `api-types` types only those modules used. Nothing live was
touched: the `skill-market` dispatch and every route the built-in panel reaches (search, preview, inventory, check,
`PATCH skills`, install, update), the publish/version routes, the stored `skill_bundles` table, the execution-side
`.skill-lock.json` and `packages/gateway/src/install.ts`, `SkillInfo`/`SkillsResponse` and the shared `market-card*`/
`skill-outcome` styles all stay. No migration, no table drop, no lock edit — the diff contains no SQL and no data file.
Live Market backend, Installer, libraries and provenance are preserved; no namespace was renamed and no data deleted.

### Correction to the ticket-11 licence note

The ticket-11 note above said the pi-web adaptation created "no new distribution obligation" because nothing is
published. That was wrong for the **published client tarball**: `packages/gateway/src/skill-frontmatter.ts` is reachable
from the gateway entry point, so esbuild pulls it into `dist/cli.js`, which ships in the `@hepi/client` package. Its
agegr MIT copyright was genuinely absent from `THIRD_PARTY_NOTICES.md`, from the emitted bundle header and from
`docs/upstream-sources.md`. Ticket 14 found and fixed this in `e328eef` (3 files, +8/-3): the notice table row, the
bundled build header and the upstream record now all name "Copyright (c) 2026 agegr". Verified here by rebuilding and by
packing the tarball.

### One combined fresh isolated proof at 0057f73

Fresh worktree `/tmp/hepi-ux-v14` (detached at `0057f73`, `pnpm install --frozen-lockfile`), own production `.next`
built there; the main checkout's `apps/web/.next` was not rebuilt or touched. No live deployment, no paid provider, no
live credential.

| Check | Command | Result |
| --- | --- | --- |
| Types | `pnpm -r typecheck` | exit 0, 6/6 |
| Workspace tests | `pnpm -r test` | exit 0: protocol 15, client 9, session 3, gateway 80, server 129 — **236, 0 fail** (server source unchanged by 14, as expected) |
| Skills entry point (unit + both browser fixtures + built-in smoke) | `pnpm --filter @hepi/web test:skills` | exit 0: 55 unit tests pass, `ux-skills-inventory-race` and `ux-skills-project-target` pass, built-in smoke `PASS (builtin)`; real account dirs byte-identical |
| Skills smoke, real `sshd` | `pnpm --filter @hepi/web test:skills-sshd` | exit 0, 53 `ok`, 0 fail, `PASS (builtin)`; real account dirs byte-identical |
| Retirement survival | `apps/web/components/SkillsRetirement.test.mjs` (in `test:skills`) | exit 0 — the seven modules are absent with no surviving importer or mount, `market.css` unloaded, no market nav section; the market namespace, stored bundles and execution-side lock still exist |
| Whole-web source tests (corrected) | `node --test --test-reporter=tap $FILES` with an explicit recursive file list | tip **2065 / 2042 pass / 23 fail / 12 suites**; base `4323109` in its own detached worktree **2104 / 2081 / 23 / 13 suites**; both logs have **24 unique `not ok` names**; comparator reports `newFailureNamesOnTip: []`, `failureNamesOnlyOnBase: []`, `identical: true` |
| Client build + notice | `pnpm --filter @hepi/client build` | exit 0; `dist/cli.js` carries the agegr MIT notice |
| Client pack smoke | `pnpm --filter @hepi/client smoke:pack` | exit 0, 6 checks; `hepi-client-0.1.0.tgz` has 5 entries with the notice bundled |
| Tarball licence artifact | `pnpm pack` then extract | `THIRD_PARTY_NOTICES.md` line 22 names "Copyright (c) 2026 agegr — https://github.com/agegr/pi-web"; `dist/cli.js` carries it once |

#### Whole-web provenance, corrected a second time

The numbers first written here (`2047/2024/23`, "47 `✖` lines", "24 unique names") came from a run that globbed only
`lib/*.test.mjs` and therefore missed `lib/i18n/` (a 9-test undercount), and its "base" comparison re-ran the same
unmodified tip tree — `git stash` is shared across worktrees, so the baseline was vacuous. Both the counts and the
comparison are retracted. Ticket 14's own branch corrected this in `76fda88` (cherry-picked here as `083fb8e`), and the
measurement was re-verified against the saved TAP logs:

| Tree | Log | tests | pass | fail |
| --- | --- | --- | --- | --- |
| tip `impl/ux-follow-up-14` | `/tmp/ux14-all-tip.tap` | 2065 | 2042 | 23 |
| base `4323109` (its own detached worktree) | `/tmp/ux14-all-base.tap` | 2104 | 2081 | 23 |

The file list comes from `find . -name '*.test.mjs' -not -path './node_modules/*' -not -path './.next/*' -not -path './vendor/*'`
(the `vendor/pi-web` snapshot is upstream provenance, not this repo's suite; the directory form `lib components hooks adapters`
is rejected by this machine's Node v26.5.1). Running the committed comparator
`.scratch/ux-follow-up/issues/ux14-wholeweb-compare.mjs` over the two logs reproduces its recorded name lists exactly and
reports `newFailureNamesOnTip: []`, `failureNamesOnlyOnBase: []`, `identical: true`.

The delta is exactly the retired files: 39 fewer tests and one fewer suite (12 vs 13), all of them the deleted panel's
and helpers' own cases, so **no surviving previously-passing test regressed** (the earlier phrase "no passing test lost"
is not precise, because the retired tests are themselves gone by design). Two counts describe the same tree and must not
be conflated: node's `# fail` counter is **23**, while the log has **24 unique `not ok` names** because one failing file
contributes a nested child assertion as well as its own aggregate rollup. The comparator's earlier "6 leaf / 17 file-level"
split is withdrawn: deciding "is this a file?" from a name containing `/` is unreliable, because several user-API test
names contain `/` too. What matters is measured, not inferred: the 24-name sets are **identical on both trees**
(`newFailureNamesOnTip: []`, `failureNamesOnlyOnBase: []`), and the whole-web count was re-checked because 14 deleted
Web source — no new production failure exists and none was fixed.

The earlier `git stash` incident is recorded for completeness: the child ran `git stash pop` in a worktree while an
older execution-resources entry was stashed, hit a conflict, and restored its own branch with `git reset`; the stash entry
`885186a` (execution-resources-03 work) is intact and no other worktree's content was overwritten. `git stash` must not
be used for baselining or isolating root here, precisely because it is shared across worktrees.

No 09 SSH, 13 missing-model or 11 project-target browser driver was re-run: 14 changed no server, gateway or SSH source,
and its own `test:skills` run already re-exercised the project-target and inventory-race drivers. No live deployment, no
paid provider, no main `.next`.

## Ticket 21 — F1 focused recheck (app source at `5db97fc`)

Owner branch `impl/ux-follow-up-live-skill-target` (source `5180f4e`) merged as `4a243ae`; app tree at `5db97fc` is identical.

| Check | Command | Result |
| --- | --- | --- |
| Server typecheck | `npx tsc --noEmit` in apps/server | exit 0 |
| F1 regression (ordinary current-project path) | `node --test test/live-skill-target.test.ts` | 1/1 pass |
| Installer contract unchanged | `node --test test/skill-install.test.ts` | 30/30 pass |
| Project routes / old root / no retarget | `node --test test/project.test.ts` | 9/9 pass |
| Full server suite | `node --test test/*.test.ts` | 130/130 pass |

The F1 regression drives a real backend and a real local gateway over one shared `WorkspaceRegistry`: it publishes the
bundle first, creates the project through `POST /api/projects` **after** the server is listening, then runs inventory,
install, inventory, toggle, check, status and update against that newly registered workspace id, and finally the
boot-configured `legacy` workspace. No restart, no window fetch, no static-options mock. Result: **F1 SPEC PASS**.

The seam reads as one dependency: `InstallerOptions.workspaces` is `() => readonly InstallBinding[]`, `server.ts` passes
`allBindings` uncalled, and `bindingOf` invokes it per request. No second registry, no state mirror, no post-`POST` guard,
no fallback. Local and SSH are the same lookup (`folderBinding` by `hostId`), so no second mechanical fixture was added.

## Ticket 22 — F2: a zero-config deployment must keep its tools

Found by reading the same seam during the F1 recheck. `apps/server/src/server.ts:380` chose the harness `env` factory once at
boot with `allBindings().length ? async (target, context) => { … } : undefined`. With no configured workspace — the ordinary
`HEPI_WORKSPACE_ID`-unset start documented at `docs/projects.md:49` — no factory was installed, and `openServerHarness`
(`harness.ts:43`) only installs `CodingTools` when `env` is present. A project created after boot therefore got its skills
but its conversation's tools were absent: the turn failed with `Tool read is not available` until restart.

Fix (owner 28, same seam): always pass the factory; it resolves per request, so a conversation bound to no workspace still
resolves no binding and gets no environment.

| State | Command | Result |
| --- | --- | --- |
| RED, source `5db97fc`, new test transplanted into a detached worktree | `node --test --test-name-pattern='zero-config deployment' test/project.test.ts` | fail 1 — `AssertionError … <harness> [error] Tool read is not available` |
| GREEN, same test with the owner's server change | same command | pass 1/1 |
| Server typecheck | `npx tsc --noEmit` | exit 0, no errors |
| Project suite | `node --test test/project.test.ts` | 10/10 pass |
| Full server suite | `node --test test/*.test.ts` | 131/131 pass |

The new case starts the deployment with `bindLegacy: false` (no configured workspace), creates a project through the public
endpoint after listening, and runs a `read` tool in a new bound conversation through the real gateway, reading a marker only
the chosen folder holds. An unbound conversation in the same process fails the call and leaves no file, proving no
redirection. This is the real boundary, not a fabricated environment object.

Status at the time of this proof: not yet merged (see the merge record below). The fix then sat uncommitted on
`impl/ux-follow-up-live-env-factory` (worktree `/tmp/hepi-ux-follow-up-10`) as `d7cdff0`. Recorded once: a transient red in one concurrent model-credentials server run while other
suites ran in parallel; a clean rerun was green, unrelated, no repair. The main checkout's `.next` was not built; the new
server test ran inside the owner's worktree against symlinked dependencies.

## Ticket 22 — F2 merged (bb3c4f7, source d7cdff0)

Merge `git merge --no-ff impl/ux-follow-up-live-env-factory` produced `bb3c4f7`; `git diff d7cdff0 HEAD -- apps packages` is
empty, so the merged app subtree is byte-identical to the branch tip and the only delta is this branch's docs.

| Check | Command | Result |
| --- | --- | --- |
| Server typecheck | `npx tsc --noEmit` (apps/server) | exit 0, no errors |
| Project suite | `node --test test/project.test.ts` | 10/10 pass |
| F1 regression retained | `node --test test/live-skill-target.test.ts` | 1/1 pass |
| Full server suite | `node --test test/*.test.ts` | **131/131** pass |

Source is one seam: the boot-time `allBindings().length ? … : undefined` gate is gone, so the harness env factory is always
installed and decides per request. `allBindings` remains the ordinary live getter (`server.ts:323`), passed uncalled to the
installer as `workspaces` (`:425`) and read per request (`:527`); a bounded grep finds no other boot-time `allBindings`
length gate in the app. The factory still returns `undefined` for a conversation bound to nothing — no fallback root, no
random workspace, no late hook, no second registry.

Counts: this change added the one case `project.test.ts` gained (9→10), so server went 130→131. Retained unchanged:
gateway 80, protocol 15, client 9, session 3. No new package or dependency import was introduced; the six packages'
typechecks are unchanged from `0057f73` except `apps/server`, re-run here and clean. No whole-web, gateway, browser, client
or production `.next` run was performed for this merge.

## Ticket 21 read-only recheck at the merged pin (app source d7cdff0)

Independent, read-only. The F2 test was transplanted onto the pre-fix source in a throwaway detached worktree so the red is
the reviewer's own, not the author's.

| Step | Command | Raw result |
| --- | --- | --- |
| Throwaway worktree at the pre-fix source | `git worktree add --detach /tmp/hepi-f2-red 5db97fc`; `git show d7cdff0:apps/server/test/project.test.ts > …`; `pnpm install --frozen-lockfile` | worktree at `5db97fc`, test file from `d7cdff0` |
| **RED** | `node --test --test-name-pattern='zero-config' test/project.test.ts` | `✖ a project created on a zero-config deployment executes its tools without a restart … AssertionError [ERR_ASSERTION]: <harness>\n[error] Tool read is not available\n</harness> … fail 1` |
| **GREEN** at the merged pin | same command in `apps/server` on `ab60338` | `✔ … pass 1 … fail 0` |
| F1 unchanged | `node --test test/live-skill-target.test.ts` on `ab60338` | 1/1 pass |

The GREEN run exercises the intended boundary: a deployment booted with no configured workspace (`bindLegacy: false`) creates
a project through the public endpoint after the server is listening; a new bound conversation's `read` runs **through the real
gateway** and returns a marker only the chosen folder holds; an unbound conversation in the same process fails the tool call
and writes no file in either folder. No fabricated environment object, no fake provider tool, no second registry.

### Final state

- Integration HEAD: `ab60338` (docs) over `bb3c4f7` (F2 merge) over `a4255ba`; **app source pin `d7cdff0`, merge `bb3c4f7`**.
- Review: **both axes complete.** Spec F1 PASS (`4a243ae`, recheck `5db97fc`) and F2 PASS (`d7cdff0`/`bb3c4f7`, recheck at
  the merged pin above). Standards five recorded findings + one recorded typo, no fix, no investigate.
- Verification at the merged pin: server typecheck exit 0; `apps/server` **131/131**; gateway 80, protocol 15, client 9,
  session 3 unchanged from the `0057f73` batch (the earlier 236 aggregate) — this merge touched only `apps/server/src/server.ts`
  and one server test, so those suites were **not** re-run as a new recursive total and no new aggregate is claimed.
- Retro at `98ecf45` / [retro.md](retro.md), with the client pack notice assertion at `4daee18` (pack 6/6) still valid.
- Out of scope and unchanged: deployment, paid live-provider smoke, main `.next` (untouched since 06:31), force-push/reset/PR.
  The pinned and frozen branches were left as they are.

