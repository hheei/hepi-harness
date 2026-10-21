# 10: 完成整合集成与升级验收

**Parent:** [Architecture consolidation spec](../spec.md)

**What to build:** 六项整合在同一修订上可构建、可安装、可使用；有可追踪的浏览器升级与回滚说明，结果足以进入后续发布流程。

**Blocked by:** 01, 02, 03, 09

**Status:** resolved（2026-10-15：六项整合在冻结源 `c13fdd2` 与唯一生产构建 `Be4b114CesOWD7SHhEc6I`（`e20ab94`）上完成验收；18 个浏览器驱动中 16 个 exit 0、2 个为已知基线（C1、C2，既未修复也非新回归）；R6–R13 在 standards 与 spec 两轴各 0 剩余实质发现。六条验收全部成立，见"完成记录"）

## Pre-final evidence

### Gate status

**Current gates:** `.dev/verify/consolidation-10/current-gates.md` is the parent's superseding addendum; `plan.md` is the
historical preparation at `13d5a63` and states no current status.

The full workspace test already covers the diagnostic runtime: `apps/server` runs `node --test test/*.test.ts`, which
includes `browser-session.test.ts`. Run it once inside the full gate — **no separate duplicate**. The node full profile is
still **not launched**; ticket 10 stays pending R9/R10 and the final runtime, with no repeated review and no repeated full run.

The final worktree exists at `f71bf11`, but the **full gate is not launched**: ticket 09 is reopened for two P2s whose fix
changes `apps/web` — R9 (the new-session tool choice the creation adapter drops) and R10 (the busy steer/follow-up paths
bypassing the composer shell-limitation preflight), both in
`.scratch/architecture-consolidation/issues/09-contract-legacy-web.md`, and the adjacent R11 (the new-session model/thinking
choice the same creation adapter drops — owner 74, investigate until a public red confirms; its basis is spec decision #8,
not 09 criterion 2). Launch the gate after both fixes are reviewed so the
browser and source-bound proofs are not repeated.

B18 diagnostic and CLI (76) proofs are **unaffected** by those fixes: they are Web-side changes, and neither bundle's closure
contains `apps/web`. Re-verify with the exact closure compare at the final tip rather than a rebuild.

R11 (the new-session model/thinking choice the same creation adapter dropped) is **fixed at `ddb9126`** and awaiting a
narrow 72/73 follow-up; that fix is not this ticket's closure either.

### Install preparation (done)

`pnpm install --offline --frozen-lockfile` in `.dev/worktrees/architecture-consolidation-10` at clean `f71bf11`, exit 0:
**759 packages, 759 reused, 0 downloaded**, `dirtyBefore: false`, `dirtyAfter: false`
(`install-preparation.json`, `install-preparation.log`). The gate is now **launched**: `verify --profile full` at clean `afc1fd0` (the integration tip after the R11 browser scene),
raw output in `.dev/verify/consolidation-10/final/` with the command recorded in
`.dev/verify/consolidation-10/full-command.log`. One run, no duplicate suites — the full profile already covers
`apps/server`'s `browser-session.test.ts`.

### Full gate result (clean `afc1fd0`)

`verify --profile full`, **`ok: true`**, `dirty: false`, `dirtyFiles: []` — every step exit 0:
`workspace-typecheck` (7 s), `workspace-tests` (143 s; `apps/server` 286 pass / 0 fail, `packages/gateway` 0 fail),
`web-unit` (2 s, 118 tests). Raw logs and `verify.json` in `.dev/verify/consolidation-10/final/`. The run happened
**once**; the browser rows of B4–B17 and the fresh-image / fresh-composer checks are the remaining gate work, all against
this one frozen build.

### Browser batches on the frozen build

Frozen source **`c13fdd2`**; build under test is the ticket 10 worktree's own `apps/web/.next`, **BUILD_ID
`Be4b114CesOWD7SHhEc6I`** (built from `e20ab94` — same product code). No source edit, no rebuild, no full rerun in the
worktree; every run's `sha` before and after is `c13fdd2`.

**Batch A — done** (`batch-a-metadata.json`, logs in this directory): `chat-lifecycle-foreground` 28/0,
`chat-lifecycle-background` 69/0, `ux-submission-recovery` 81/0 (stable scene 6), `submit-stall` 55/0,
`stream-heartbeat-idle` 23/0, `ux-nav-new-session` 15/0 — all exit 0. The foreground/background drivers' own tracked
evidence was archived to `browser/foreground-artifacts` and `browser/background-artifacts` and restored to HEAD
afterwards; no product or source file was touched.

**Batch C — done** (`batch-c-metadata.json`): `ux-mcp-surface` 26/0, `ux-extensions-selection` 17/0,
`ux-truthfulness` 29/0, `ux-capability-trust` 15/0 exit 0; `ux-terminal-budget` exit 1 — 13 ok / 2 fail in this batch, then **15/15 exit 0** on the test-only observation fix (reused run, below).

**Batch B — done** (`.dev/verify/consolidation-10/browser/BATCH-B.md`, per-run `0N-*.meta.txt` + `0N-*.log`):

| Driver | Exit | Checks | Note |
| --- | --- | --- | --- |
| `ux-missing-model-recovery.mjs` | 0 | 33/33 | the R11 witness: fresh composer picks B+`high` with no conversation yet, first prompt served by B, deployment default called **0** times, created conversation's native settings `{fileonly, ephemeral-1}`/`high`; refusal half keeps the draft, dispatches no prompt, creates no conversation |
| `ux-models-config-save.mjs` | 0 | 16/16 | includes the saved model surviving a backend restart |
| `ux-image-submit.mjs` | 1 | 18 pass / **3 fail** | the 3 pinned baseline **names**, in the same order; driver sha256 `fc32e07f…` **identical** to the pinned baseline driver → **no regression**; name lists kept (`checks-03-*.names.txt`, `fail-names-03-*.txt`) |

**Parent runner — history prefix:** exit 0 in 13.3 s at source `c13fdd2` / build `Be4b114…`. Its metadata records
`dirtyAfter: true` **only** because agent 75's concurrent foreground driver wrote its own tracked
`.scratch/chat-lifecycle/foreground/{scene1.json,scene2.json,timeline.jsonl}` outputs; the strict whole-tree guard then
stopped **before** the remaining three, so they were not run at that moment and no passed check was rerun
(`parent-guard-note.md`, raw `parent-browser-command.log`). No product failure.

**Remaining three — run once, guard narrowed** (`parent-remaining-batch.json`; the guard now allows only the known
foreground/background `json`/`jsonl`/`summary.txt` evidence outputs, and metadata records the actual dirty list rather
than claiming a clean tree):

| Driver | Exit | Duration |
| --- | --- | --- |
| `ux-windowed-transcript.mjs` | 0 | 61.1 s, 48 checks |
| `ux-deferred-text.mjs` | 0 | 14.2 s, 14 checks |
| `ux-worktree-picker.mjs` | **1** | 34.0 s — **20 checks pass**, then `TimeoutError` |

`ux-worktree-picker`'s timeout is the **exact same** failure — same stack, same progress point (20 checks in, after the
forced-removal checks) — as the pinned `caf6a31` baseline log
(`.dev/verify/consolidation-01/baseline-caf6a31-worktree-picker.log`: 20 ok, identical `TimeoutError`). **C2 is
therefore classified as pre-existing, not a regression on this source** — no new failure was introduced, and no "fixed"
claim is made. The fresh comparison row is recorded: `.dev/verify/consolidation-10/browser/worktree-baseline-comparison.json`
— current `c13fdd2` 20 pass + `TimeoutError`, pinned `caf6a31` raw baseline 20 pass + the **identical normalized check
sequence, including the FAIL line** (only the `/tmp` fixture prefix normalized away), **driver blob identical on both
sides** (`7cc7c9fc9acb5c1ee88bf5210d4fc17a5c32503f`). The baseline log is the clean pinned detached baseline with its own
deps and build (`.dev/verify/consolidation-01/baseline-caf6a31-worktree-picker.log`), already verified. **Known baseline
retained; no new observed regression; no broader root-cause identity claim**, and no baseline rerun is justified while
the baseline is unchanged.

**C1** likewise stays a retained known baseline: `ux-image-submit` 18 pass plus the same three failure **names**, with a
driver sha256 identical to the pinned `fb99018` driver (`BATCH-B.md`, `checks-03-*.names.txt`, `fail-names-03-*.txt`).

**Ticket 10 does not claim all browser rows green.** Its acceptance account is: batches A, B, C and the parent runner
green; **C1 and C2 as known baselines** with the fresh comparison rows above; and the **budget row green on the test-only
observation fix**, pending its narrow review. Nothing here closes the ticket.

**Budget — fixed (R13).** The test-only fix (`2046c4088edc419c0c0b6bffcea49b139757ee2d`, branch
`work/ticket10-budget-observer`, parent `c13fdd2`, merged `9f38e11`; `apps/web/e2e/ux-terminal-budget.mjs` only, +57/-41,
**no product file**) reads the page's sources **off its own network** — a request that answered `text/event-stream` with
a **200** is one live source and its finish or failure is its close, which counts the terminal's `EventSource` and the
conversation's `fetch` reader the same way; a request issued with no response yet is queued in the pool, not a live
source. **No product hook, no page-side instrumentation, all 15 assertions and the UI unchanged.** Result: **exit 0,
15 checks, 0 failed** — A `live=4 (terminal 1, conversation 3)`, B `conversation=4 of 4 held runs`. The passed 15 are
**reused** rather than rerun here because the source (`c13fdd2`), the runtime (only the driver changed; the frozen
`Be4b114…` build was copied with `cp -a`, no build/`tsc`/`next build`) and the provenance are valid: isolated fix
worktree, ports 45790/45791, `frozen_10_readonly head c13fdd2, dirty 0, BUILD_ID Be4b114…` after the run,
`tracked_dirty_after_commit 0`. The original 13 ok / 2 fail is kept unchanged at `ux-terminal-budget.log`; the run and its
metadata are in `browser/ux-terminal-budget-observer.log` and `browser/BATCH-C.md`. **R13 is fixed.** The tested artefact is the **pre-commit patch on `c13fdd2`, not a clean `2046c40` checkout**: the
driver in the worktree when it ran is `driver_blob_under_test 35079b81cc7275755c58d1e9c64e9cd674846d6a` /
`driver_sha256 00e1d543558c2f7c9d038eba8183f9fafbc40f0f21efcbf5a171751db733fc72`, byte-for-byte the published commit's file
(`git diff --quiet 2046c40 -- <file>` reports no difference), so `2046c40` is the same patch and no clean-commit run is
relabelled. Dirty state: **before = count 2 only, paths not captured and therefore unknown**; after =
` M apps/web/e2e/ux-terminal-budget.mjs` + `?? .scratch/perf-follow-up/perf-follow-up/` (copy artifact, removed), the
before set equalling the after set by construction rather than by a second capture; **no tracked product dirt**. Metadata
companion `browser/ux-terminal-budget-observer.meta.txt`. Review: **73 spec accepted with 0 material findings**
(`.dev/verify/consolidation-review-09/r13-spec-followup.md`) and **72 standards with 0 material findings**
(`.dev/verify/consolidation-review-09/r13-standards-followup.md`). Valid tested-patch reuse —
no second driver run, no full run, no build.

Agent 75 archives and restores its own generated foreground/background outputs once its writers close; future runs
should write theirs to Primary via `HEPI_CLF_OUT` / `HEPI_CLB_OUT`. Other batches continue.

### Completion record

**Resolved 2026-10-15.** Frozen source `c13fdd2` (`c13fdd262ee617fd90abe7dced2ac4111dfa191d`), one production Web build
`Be4b114CesOWD7SHhEc6I` from `e20ab94`. **18 browser drivers: 16 exit 0 (A 6 + B 2 + C 5 + parent runner 3) and 2 known
baselines at exit 1 — C1 (image projection) and C2 (worktree picker), neither fixed and neither a new regression**, each
with a fresh comparison against its pinned baseline. All six criteria are met; the full profile is `ok: true` on clean
`afc1fd0` with **118 Web tests / 57 files**, and the CLI and diagnostic bundles are reused with exact closure matches
(`unchanged: true`). R6–R13 are resolved with 0 material findings on both the standards and the spec axis. No production
deploy, restart or release was performed, and nothing was built on `remote-host`.

### Superseded: what was still owed before closure

All browser rows exist on the frozen build — every batch is done (A, B, C, parent runner, remaining three) and the
budget row is green on the merged test-only leaf `2046c40` / `9f38e11`; nothing is rerun. What remains before closure is
the **narrow standards/spec test-observation review and the evidence binding** of that leaf. Product source is unchanged
throughout, the full profile's 118 Web tests stand, and build `Be4b114…` remains the valid build under test. Both CLI and
diagnostic closure comparisons are still `unchanged: true`. When they do: the final
guide counts (**118 Web tests / 57 files**), the "model applied before the first prompt" statement, and the C1/C2
limitation rows **if** they are confirmed by the actual runs. The graph update waits for the final browser and material-fix
decision and happens **once** after the last code change. No routine checks for status-only edits.

### Release-artifact / image context

Recorded at `.dev/verify/consolidation-10/artifact-context-review.md`: both Dockerfiles copy the **complete** `packages`
tree and their own app tree wholesale, and `.dockerignore` excludes no license or notice path — every tracked
`LICENSE`/`THIRD_PARTY_NOTICES.md` under those trees ships (`apps/web`, `packages/client`, `packages/gateway`,
`packages/session`). It is a **context inspection, not an OCI build claim**: no `docker build` ran, and none may run on
`remote-host`. The CLI tarball's own notices come from the reused `smoke:pack` proof at `8da61d5`.

### Cleanup (skill step 9, after the final reports and the graph update)

Every implementer worktree goes, with its logs already retained under primary `.dev/verify/`: **nested baselines first**
(for example `.dev/worktrees/architecture-consolidation-01/.dev/baselines/caf6a31`, whose C2 log lives at
`.dev/verify/consolidation-01/`), then `architecture-consolidation-01…09`, `architecture-consolidation-upgrade-drafts`,
`architecture-consolidation-10-cli` and `ticket10-budget-observer`. **Preserved:** the parent-owned
`.dev/worktrees/architecture-consolidation-10` with the frozen `Be4b114…` build (review evidence, not an implementer
tree), all five user stashes, and unrelated older worktrees. Cleanliness is checked before each removal.

### Reused proofs, exact closure (CLI / diagnostic)

Both bundles were re-compared by exact `git ls-tree` scope against the captured fingerprints, with **no rebuild and no
smoke rerun**: `unchanged: true` at `110c093` for the CLI scope (`packages/client packages/gateway packages/protocol`
plus manifests and lockfile) and for the diagnostic scope (`apps/server/src` + `packages/session` + `packages/protocol`
plus manifests and lockfile) — `.dev/verify/consolidation-10/cli/closure-compare-current.json` and
`.dev/verify/consolidation-10/diagnostic/closure-compare-current.json`, artifact SHAs verified. **Evidence path is
`.dev/verify/consolidation-10/cli`** (there is no `consolidation-10-cli` evidence directory; that name is a worktree).
The changes after those fingerprints are Web-only, so they do not touch either closure.

The fresh-composer model/thinking driver is **prepared for the final build**: 33/33 on the `ddb9126` Web build; the final
gate reruns the same driver once, not a new suite.

### On the R12 driver leaf

When 75's leaf lands, merge **only the driver and statuses** — no product change — and do **not** rerun the full profile
for a script-only edit. The final browser run is what verifies R12.

### Fresh image check (required at the gate)

The final fresh-image run must cover the sources that actually changed: `ChatInput` and `MessageView`, plus R11's
boundary — a **fresh** conversation whose first prompt uses a model the picker chose (and an image-capable model where
relevant). Compare the failure **names** against the pinned `fb99018` classification; do **not** carry the three
`ux-image-submit` failures forward by count alone — re-establish them by name on the fresh image.

**Browser candidate gap.** No browser suite covers a fresh composer's first prompt:
`ux-missing-model-recovery` creates its conversation through the backend first, so it exercises the existing-conversation
`set_model` route. The public adapter test is the current witness for the creation path; a focused fixture addition was
requested from the R11 owner (74) so the gate can exercise the first-new-model path in a browser.


### B18 diagnostic bundle (built clean, artifact reused pending the final closure compare)

`pnpm --filter @hepi/server build:ui` at clean `780ba98` in the isolated `architecture-consolidation-10-cli` worktree,
exit 0: `chat.js` 21.0kb, sha256 `8dee4a12cad67b0f036783eff72a91b499fd5358361431f63517a47bc397642a`. Metadata,
fingerprint and build log are in `.dev/verify/consolidation-10/diagnostic/` (see its `README.md`).

The runtime closure (`apps/server/src/chat.ts` → `@hepi/session/browser` → `packages/session`, `packages/protocol`) is
**unchanged** between the artifact revision and the integration tip `7931915`: the whole delta is `apps/web` + docs, and
none of the closure files appear in it. So the artifact stays representative and no rebuild is needed — the final
closure step is to compare the cumulative closure and toolchain against the fingerprint before reuse, not to trust this
build alone.

The runtime check is `apps/server/test/browser-session.test.ts` at the **final source** revision; skip a separate
duplicate run if the final full gate already includes it. The CLI (76) proof shares this closure.

## Acceptance criteria

- [x] 所有传递依赖完成，当前源代码的必要 package/Web 检查、CLI pack smoke、Web/诊断构建和关键浏览器流程有对应修订与原始日志。
- [x] 验证宿主 MCP 与凭据边界、worktree 兼容读取、双 exec 与重复抑制、HTTP/SSE 同义、一次结算、历史 prefix/阅读位置及连接预算。**（"连接预算"在 test-only 观测修复上测得 15/15；R13 两轴各 0 实质发现）**
- [x] 覆盖已有打开页面的明确刷新切换：草稿恢复、requestId 结果查询、不重复提交/通知；不只测新打开页面。
- [x] 实际发行物与镜像上下文保留 notices/许可，依赖和 lockfile 一致；Backend 诊断页共用 transport 的构建风险已验证。
- [x] material review findings 已解决，非阻塞项按 trigger/impact/revisit 记录；owning guides 和能力限制反映最终实现，保留回滚到前一 Web/诊断构建的说明。**（R6–R13 全部两轴各 0；guide 最终提交见"完成记录"）**
- [x] 本票交付实现与验证证据，不执行生产部署、重启或发行；构建仅在 workstation/CI，remote-host 不编译。

## Criteria → evidence (prepared; two rows stay open)

Prepared ahead of closure. Criterion 2 and criterion 5 stay **unchecked** until 76's test-only leaf lands and the
budget driver reruns green; nothing here closes the ticket.

| Criterion | State | Evidence |
| --- | --- | --- |
| 1. transitive dependencies done; package/Web checks, CLI pack smoke, Web/diagnostic builds and key browser flows carry a revision and raw logs | **met** | tickets 01–09 resolved (0 open findings); full profile `ok: true` at clean `afc1fd0` (118 Web tests, workspace 0); CLI `smoke:pack` reused from `8da61d5` with exact closure `unchanged: true` at `110c093`; diagnostic `chat.js` built at `780ba98` with exact closure `unchanged: true`; Web build `Be4b114…` from `e20ab94`; all 18 browser drivers in `.dev/verify/consolidation-10/browser/` |
| 2. host MCP and credential boundary, worktree compatible reads, double exec and duplicate suppression, HTTP/SSE synonymy, single settlement, history prefix/read position, **connection budget** | **met** | MCP 26/0, extensions 17/0, capability trust 15/0, truthfulness 29/0, history prefix 11/0, submission recovery 81/0, submit-stall 55/0, heartbeat idle 23/0 all green. The **connection-budget** driver now passes **15/15** on the test-only observation fix (`2046c40`, driver file only, frozen build copied) — A `live=4 (terminal 1, conversation 3)`, B `conversation=4 of 4 held runs` — with the original 13 ok / 2 fail kept at `ux-terminal-budget.log`. **R13** is fixed with **both axes at 0 material findings**, and no product finding was ever involved. |
| 3. the explicit refresh switch for already-open pages: draft restore, requestId result lookup, no duplicate submission/notification — not only freshly opened pages | **met** | `ux-submission-recovery` 81/0 (draft restored after reload, held reads, recall/admitted), `chat-lifecycle-foreground` 28/0 (held conversation read), `chat-lifecycle-background` 69/0, `submit-stall` 55/0; draft persistence in `draft-store` (refused-attachment caching) covered by the 118 Web tests |
| 4. release artifacts and image context keep notices/licenses, dependencies and lockfile consistent; the shared-transport build risk of the Backend diagnostic page is verified | **met** | `hepi-client-0.1.0.tgz` with `THIRD_PARTY_NOTICES.md` and the 6 pack checks at `8da61d5`; diagnostic `build:ui` artifact with its fingerprint; both closure comparisons `unchanged: true` at `110c093` (`.dev/verify/consolidation-10/{cli,diagnostic}/closure-compare-current.json`); `browser-session.test.ts` runs inside the full profile |
| 5. material review findings resolved, non-blocking items recorded with trigger/impact/revisit; owning guides and capability limits reflect the final implementation, with the rollback instructions retained | **met** | R6, R7, R8, R9, R10, R11, R12 and **R13** resolved on both review axes; non-blocking records: the empty default conversation after a settings refusal, the status/widgets projection gap and the SDK importer-parity guard. Guides updated: `docs/verification.md` (gate rows, both limits), `docs/chat.md`, `docs/migration-status.md`; rollback stays the ordinary image re-pin in `docs/deployment-runbook.md` |
| 6. deliver implementation and evidence without a production deploy, restart or release; builds only on workstation/CI, remote-host compiles nothing | **met** | no deploy, restart, release or remote compile was executed; every build in this ticket ran on the workstation against the ticket 10 worktree |

### Provenance table — the 18 browser drivers

All runs: source **`c13fdd2`** (`c13fdd262ee617fd90abe7dced2ac4111dfa191d`, unchanged before and after), build under test
**`Be4b114CesOWD7SHhEc6I`** (the worktree's own `apps/web/.next`, built from `e20ab94` — same product code), cwd
`.dev/worktrees/architecture-consolidation-10`. Per-run `sha`/dirty/`BUILD_ID` live in each log's header and in
`0N-*.meta.txt`, `batch-a-metadata.json`, `batch-c-metadata.json`, `parent-remaining-batch.json`.

| # | Driver | Exit | Checks | Log (all under `.dev/verify/consolidation-10/browser/`) |
| --- | --- | --- | --- | --- |
| 1 | `chat-lifecycle-foreground` | 0 | 28/0 | `chat-lifecycle-foreground.log`, artifacts `foreground-artifacts/` |
| 2 | `chat-lifecycle-background` | 0 | 69/0 | `chat-lifecycle-background.log`, artifacts `background-artifacts/` |
| 3 | `ux-submission-recovery` | 0 | 81/0 | `ux-submission-recovery.log` |
| 4 | `submit-stall` | 0 | 55/0 | `submit-stall.log` |
| 5 | `stream-heartbeat-idle` | 0 | 23/0 | `stream-heartbeat-idle.log`, artifacts `stream-heartbeat-idle-artifacts/` |
| 6 | `ux-nav-new-session` | 0 | 15/0 | `ux-nav-new-session.log` |
| 7 | `ux-missing-model-recovery` | 0 | 33/0 | `01-ux-missing-model-recovery.log` + `.meta.txt` |
| 8 | `ux-models-config-save` | 0 | 16/0 | `02-ux-models-config-save.log` + `.meta.txt` |
| 9 | `ux-image-submit` | 1 | 18 pass / 3 fail — **C1** | `03-ux-image-submit.log` + `.meta.txt`, `checks-03-*.names.txt`, `fail-names-03-*.txt` |
| 10 | `ux-mcp-surface` | 0 | 26/0 | `ux-mcp-surface.log` |
| 11 | `ux-extensions-selection` | 0 | 17/0 | `ux-extensions-selection.log` |
| 12 | `ux-truthfulness` | 0 | 29/0 | `ux-truthfulness.log` |
| 13 | `ux-capability-trust` | 0 | 15/0 | `ux-capability-trust.log` |
| 14 | `ux-terminal-budget` | 0 | **15/0 — R13 fixed, both axes 0** | `ux-terminal-budget-observer.log` (original 13 ok / 2 fail kept at `ux-terminal-budget.log`) |
| 15 | `ux-history-prefix` | 0 | 11/0 | `ux-history-prefix.log` + `.json` |
| 16 | `ux-windowed-transcript` | 0 | 48/0 | `ux-windowed-transcript.log` + `.json` |
| 17 | `ux-deferred-text` | 0 | 14/0 | `ux-deferred-text.log` + `.json` |
| 18 | `ux-worktree-picker` | 1 | 20 pass then `TimeoutError` — **C2** | `ux-worktree-picker.log` + `.json`, `worktree-baseline-comparison.json` |

**18 drivers, 16 exit 0 (A 6 + B 2 + C 5, budget among them, + parent runner 3) and 2 known baselines at exit 1 (C1,
C2); no product regression observed.** The batch-C budget failure is that driver's earlier attempt on the stale observer,
**not a nineteenth driver** — the driver ran twice and the green run is the one recorded. C1 and C2 are retained known baselines (not fixed) with their
comparison artifacts; the budget row is the only one still open. The worktree is clean of source dirt: agent 75's
foreground/background drivers write tracked generated evidence under `.scratch/chat-lifecycle/{foreground,background}/`,
which is archived and restored — actual dirty lists are recorded in the metadata rather than a clean-tree claim.
## Verification seam

使用最终 source 上的 verify:changed 及必要的 targeted browser/pack/build 检查；相同源码已有有效证据可复用，不为文档变化重复全套测试。

## Integration notes

仅列终端阻塞边；04/05/06/07/08 经 09 传递覆盖。此票是跨包 wide refactor 的 integrate-and-verify 收口，不是另开一轮架构设计或全量重测。

## Comments

Implementation preparation found draft-store currently holds drafts in an in-memory Map. Hard refresh therefore cannot be claimed to preserve drafts without an explicit handover. Story18 and this ticket require testing and completing that handover at its existing draft owner. Existing submission-recovery and submit-stall browser scenes cover requestId lookup and a refreshed live run; reuse them instead of adding duplicate lifecycle suites.

## Draft-handover subtask resolved (story18 refresh half)

**Status:** this subtask is done; the ticket stays **unresolved**, because its remaining acceptance criteria depend on tickets 01–09.

**Delivered** (`9777b3e`, baseline `4b9e0c6`, merged with integration tip `fb99018`):

- `apps/web/lib/draft-store.ts` keeps its synchronous `Map` as the owner and mirrors each draft into the tab's own
  `sessionStorage` — the one per-tab store, so a hard refresh finds *this* tab's draft and another tab keeps its own.
  Text and attachments are two entries under one key, so typing never re-serializes attachments; `rekeyDraft`,
  `clearDraft` and `setDraft` keep their synchronous semantics, and no operation awaits.
- A fresh composer's transient `new:<id>:<cwd>` key is not derivable from the folder, so `apps/web/lib/tab-session.ts`
  now carries it beside the cwd it already remembered; the shell refuses a key naming another folder.
- `ChatInput` adopts its stored draft in a layout effect instead of during the first render (the store is empty on the
  server, so a first-render read would be a hydration mismatch) and writes nothing back before it has read.
- A browser that refuses the write (a quota) drops the stale entry — it no longer describes the composer — and reports
  the limit through a composer notice; the draft stays in memory and is still sendable.

**Verification** (raw logs in `.dev/verify/consolidation-upgrade-drafts/`, dirty tree at the commit above):

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `pnpm --filter @hepi/web build` | 0 | production build, typecheck included | `web-build.log` |
| `node scripts/test-web-unit.mjs` | 0 | 111/111 pass, 62 files (adds `lib/draft-store.test.mjs`) | `web-unit/web-unit.json` |
| `node apps/web/e2e/ux-submission-recovery.mjs` | 0 | 47 checks, 0 failures; scene 5 is the real reload | `ux-submission-recovery.log` |
| `node apps/web/e2e/submit-stall.mjs` | 0 | 55 checks, 0 failures | `submit-stall.log` |
| `ux-nav-new-session` / `ux-nav-flicker` / `ux-default-workspace` / `ux-workspace-routing` | 0 | all pass | same dir |
| `pnpm verify:changed --base=integration/architecture-consolidation` | 1 | typecheck PASS, web-unit PASS; `check-docs` FAIL on the 12 pre-existing broken links, identical with and without this change | `verify-changed.log` |
| the same command at `08d2247` (clean tree) | 1 | same three results, same 12 links; the build and browser logs above are from `9777b3e`'s source, and this revision only added ticket text | `verify-changed.log` |
| `node apps/web/measure-draft-quota.mjs` | 0 | refusal-path cost before/after the owner fix | `measure-draft-quota.log` |

The new browser scene is a true reload of the page that was already open (`page.reload`, not a new page): unsent text
and an attached image come back into the same fresh composer with the image's exact bytes; sending clears it, and the
reload after the send resurrects neither, resends nothing (one model request for the whole scene) and plays no further
completion tone for the already-answered turn; an open conversation's own unsent text survives too, and text the user
removed stays removed. The requestId lookup scene and the submit-stall refresh scene are reused unchanged.

**Recorded limit, not a guarantee.** A page still running the **pre-switch** build holds its drafts in the old in-memory
`Map`, so this build cannot checkpoint them retroactively; the cutover guide states the manual step (copy the unsent
text, save any attached image) before that page's first refresh
([runbook](../../../docs/deployment-runbook.md#existing-open-pages-at-a-web-contract-switch)). No compatibility bridge for the old
store is implemented, and no old-build automatic recovery is claimed: the browser test above measures the new build's
own store on a same-build reload.

**Owning guides updated:** [Chat](../../../docs/chat.md#composer-drafts-across-a-refresh) (behaviour, storage choice,
no-resend and no-re-notify rules, the switch limit),
[deployment runbook](../../../docs/deployment-runbook.md#existing-open-pages-at-a-web-contract-switch) (the cutover step
and its rollback), [verification](../../../docs/verification.md#composer-drafts-across-a-refresh) (the checks),
[migration status](../../../docs/migration-status.md#composer-drafts-across-a-refresh-delivered) (capability and limit).

**Pre-existing, unrelated — evidence corrected.** `apps/web/e2e/ux-image-submit.mjs` fails 3 checks:

1. `the submitted image is rendered from the durable entry`
2. `a reconnected browser restores the image from history`
3. `a page after a backend restart restores the image`

An earlier version of this ticket cited a **stashed** baseline for that claim. That evidence is **withdrawn**: `git
stash` is shared across worktrees, and a stash-pop around this worktree compared the tree against itself while mixing
the new `.next` with old source. The claim is re-established on a real pinned revision instead:

- Baseline worktree `git worktree add --detach .dev/baselines/fb990182d3549d846046d769d0c130ae018f4979 fb99018` — HEAD
  `fb990182d3549d846046d769d0c130ae018f4979` (integration tip, pre-draft, tickets 01–06), tree clean, its own
  `pnpm install --frozen-lockfile --offline` (exit 0) and its own `pnpm --filter @hepi/web build` (exit 0,
  BUILD_ID `eflZQM0i4R7h4lB2DmUWj`).
- Driver unchanged and identical to this worktree's:
  `sha256 fc32e07fcaa5084df6ad0f2078436c7dc2d4e28f0b9a61b227d9d2336450284b` for `apps/web/e2e/ux-image-submit.mjs`.
- Run: `node apps/web/e2e/ux-image-submit.mjs` → exit 1, the same 3 names. Log:
  `ux-image-submit-baseline-fb99018.log`.
- Tip run on a clean tree with its own build: exit 1, the same 3 names; the normalized check-name lists `diff` empty.
  Logs: `ux-image-submit-tip-ea65647.log`, `ux-image-submit-tip-postfix.log`.
- Provenance and the explicit non-claims: `image-submit-baseline-provenance.md`.

Verdict: pre-existing on this baseline. Left for the ticket that owns image projection; no draft-owner change was made
for it. Scope note: only this one suite was run on the pinned baseline, so no broader baseline claim is made.

**Owner fix found by source review (same subtask, separate commit).** On a quota refusal the store dropped the
attachment half's bookkeeping, so every later keystroke re-serialized an unchanged oversized attachment list before
failing again — the exact cost the split entries exist to avoid, and contrary to the "typing never re-serializes
attachments" claim. A browser refused list is now remembered and not re-offered while it stands unchanged; changing the
attachments retries. Measured with the public `setDraft` against a 5M-character stand-in store: 10 attachments at
13.0M base64 chars went from a 4.4–7.4 ms median keystroke (worst 7.6 ms) to 0.0 ms, and 4 screenshots at 5.2M chars
from ~1.5 ms to 0.0 ms. Log: `measure-draft-quota.log`. Typing-only re-attempts when *no* attachments were refused
were kept, since such a store may simply have become writable again and the re-attempt is cheap.

**Recorded, not fixed.** A browser that denies the storage API itself (`window.sessionStorage` getter throws) leaves
nothing to read or refuse, so the store stays in memory and states no limit. Every other browser preference in this app
has the same silent fallback, and a profile that blocks site storage this way would block the app's ordinary login
path too, so no new evidence of normal use justifies a notice; recorded in
[Chat](../../../docs/chat.md#composer-drafts-across-a-refresh).

**Still blocked on other tickets:** the full "existing open page" acceptance needs the 07–09 payload switch to exist at
all (the draft handover is its precondition, not its replacement), and the remaining acceptance criteria need 01–09.
