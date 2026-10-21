# UX follow-up final code review

Two axes over the effort's diff at source pin `0057f73` (tree identical to `e328eef`), baseline `cda2416a2abc9189379259b6246e55ea2d036a37`.
Read against [docs/agents/verification.md](../../docs/agents/verification.md) and [docs/agents/review-policy.md](../../docs/agents/review-policy.md).

Source pin for this review: `0057f735893f1e6d5189cdec725537067785698f`. The review was done at tip `98ecf45`. Between the
two, no application source changed: the commits are documentation (`AGENTS.md`, `docs/agents/verification.md`,
`.scratch/ux-follow-up/*`) plus one verification-script assertion added by the retro (`packages/client/scripts/smoke-pack.mjs`
now requires the pi-web copyright line in the packed bundle). The reviewed product code is exactly the pin.

## Standards axis — complete, no fix, no investigate

Every finding below is **recorded**, not patched. Trigger likelihood in normal use is low or the effect is accuracy-only, so
[review policy](../../docs/agents/review-policy.md) keeps them out of an implementation loop until real use supplies evidence.

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| S1 | Operation outcomes are English literals in the backend: `apps/server/src/skill-inventory.ts:225` and `:227` (`checkOutcome` "No newer revision is known…", "… is up to date at …") and `:270-283` (`installOutcome`/`updateOutcome` "Installed …", "Updated …", "… no conversation was asked to reload"). The Web layer renders some of the same outcomes through the locale registry, and `apps/web/components/SkillsConfig.tsx:837` builds `"Reload failed: " + result.reload.error` as a literal while its sibling on line 836 uses `t("skills.toggleFailed")`. | Mixed-language output only: where a localized label sits beside a backend notice/reload error, the row shows two languages. No wrong value, no failed operation, no data effect. The dormancy suite (`SkillsConfig.dormancy.test.mjs`, cited at `docs/execution-side-installation.md:282`) pins that *source keys and state words* come from the locale files — it does not, and was not asked to, cover these backend operation outcomes. | `record` | A notice/reload error is reported as unreadable or wrong by a user, or the locale coverage is extended to operation outcomes as its own ticket. |
| S2 | `apps/web/vendor/pi-desktop/README.md:3,5` still names `apps/web/components/SkillMarketPanel.tsx` — a file ticket 14 retired. | Provenance text only. The vendored `SkillMarketPanel.tsx` itself is untouched and correctly attributed; the README sentence describes a host file that no longer exists. No runtime, build or licence effect. | `record` | The next edit to that vendor directory, at which point the provenance sentence is corrected as part of it. |
| S3 | Workspace registration is validated twice through different contracts: `apps/server/src/server.ts:361` (`registerFolder`/`registerProject`, replaying recorded folders) and `packages/gateway/src/workspaces.ts:96` (`registerResolved`, reached via `ssh-workspaces.ts:131`). | Deliberate. The gateway's `registerResolved` resolves the profile's canonical root and is the authority; the server replays idempotently so a restarted gateway sees the same roots. The apparent duplication is one contract observed at two layers, not two competing validations. | `record` | The two disagree in a real run (one accepts a root the other rejects). |
| S4 | The `/workspace/` path prefix is inlined rather than shared: `apps/web/adapters/workbench.ts:30` declares `WORKSPACE_PREFIX`, while `apps/web/adapters/durable-api.ts:43` and `:119` build and strip `"/workspace/"` inline. | Workspace-prefix handling only; both spellings agree today and no call path mixes them into a wrong path. Cosmetic divergence, no behavioural difference observed. | `record` | A prefix change lands and one of the sites is missed. |
| S5 | `apps/server/src/server.ts:85` declares `THINKING_LEVELS` and `:731` repeats the same seven-element literal inline in the validation `includes` check. | Pre-existing baseline duplication, unchanged by this effort. No drift today (the two lists are identical). | `record` | A level is added to one list and not the other. |

Not findings. The namespace/Python frontmatter parity work is intended behaviour: `packages/gateway/src/skill-frontmatter.ts`
adapts upstream formatting to match the stdlib-Python helper's output, so the two implementations agreeing is the goal, not a
duplicated implementation. Licence and copyright authorities remain the ones the runtime and published artifacts carry (see the
client tarball notice assertion in `packages/client/scripts/smoke-pack.mjs`); no new attribution gap was found.

Per user policy, translated labels, the vendor README, style and the duplicate source are **not** fixed. They are recorded here.
These five findings do not enter another implementation loop.

### Negligible documentation inaccuracy (recorded, not fixed)

`.scratch/ux-follow-up/issues/14-retire-market-verify-skills.md:77` names the ticket-14 verification command as
`pnpm --filter @hepi/client test:skills`. The `test:skills` script lives in `apps/web/package.json:49`, so the correct
command is `pnpm --filter @hepi/web test:skills` (and `test:skills-sshd` likewise). Impact is limited to a reader copying a
wrong package filter; the recorded results in that file are unchanged. Line 95 of the same file names the same script with no filter, which is correct from the `apps/web` working
directory. Left as-is here and corrected only if it is part of a routine final documentation pass.

## Spec axis — complete: F1 and F2 both PASS

The spec axis had two material findings, distinct from the recorded Standards items. Both are fixable real defects in the
delivered contract, both are fixed at owner seams, and both were re-verified independently against the merged source. Each
was found by reading the constructor and the resolve path (read-only), then confirmed red through a live backend request and
green after the fix (see the regressions below). No Standards finding was promoted into a fix; they remain recorded.

**F1 — a project created after boot cannot install a skill until the backend restarts.**

- Contract: a newly registered SSH/project target is an ordinary, material execution target — installing, toggling, checking
  and inventorying a skill against it must work like any other workspace.
- Observed: `apps/server/src/server.ts:418-420` builds the installer once with `workspaces: allBindings()`, and
  `apps/server/src/skill-install.ts:294` resolves a target with `options.workspaces.find(...)`. `allBindings()`
  (`server.ts:323`) is evaluated **once** at construction, so it is a snapshot. A project created afterwards through
  `POST /api/projects` (`server.ts:619`, pushing onto the live `projects` store) is registered on the gateway and offered
  by `GET /api/projects`, but the installer's snapshot does not contain it: `bindingOf` returns `undefined` and the route
  answers the "unknown workspace" 404 (`target()`, `skill-install.ts:311-312`). Inventory, install, toggle and check
  against that project are all unreachable until the backend is restarted.
- Root: the installer holds a copied list where it should read the live set through the owner's contract. The fix belongs at
  that seam — expose the current bindings through a getter/callback (as `boundWorkspace` already does at `server.ts:423`),
  so `bindingOf` reads the live set rather than a boot-time clone. Not a caller guard, not a fallback, not a mutation hook.
- Scope note for the fix: the change is intended only for **live** projects and new default roots. Conversations already bound
  to a workspace keep their existing bindings; newly created conversations see the new default. No existing binding is
  rewritten by this fix.
- Fix implemented: `5180f4e` (branch `impl/ux-follow-up-live-skill-target`, merged here as `4a243ae`).
  `InstallerOptions.workspaces` is now a thunk, `server.ts` passes `allBindings` uncalled, and `bindingOf` invokes it per
  request. One dependency; no second registry, no state mirror, no post-`POST` guard, no fallback. The live lookup only adds
  targets, so a boot-configured workspace answers exactly as before, and a conversation already bound to a workspace keeps
  its binding (the change touches targets, not conversations).
- Regression: `apps/server/test/live-skill-target.test.ts` — a real backend and a real local gateway sharing one
  `WorkspaceRegistry`, driven through the public HTTP endpoints. It publishes a bundle, creates a project after the server
  is listening, and uses **that** workspace for inventory, install, inventory, toggle, check, status and update, plus the
  boot-configured workspace. Red before the change (`404 unknown workspace` at the first inventory), green after, same
  running backend, no restart, no window fetch and no static-options mock. Host-agnostic: `folderBinding` resolves a project
  folder to its gateway connection by `hostId`, so a local and an SSH project take the identical lookup; the existing
  `skill-install.test.ts` remote-host cases cover that path, so no second SSH fixture was added.
- **Ticket 21 recheck — F1 SPEC PASS** at `5db97fc` (app tree identical to the fix merge `4a243ae`):
  - Ordinary current-project path green: `apps/server/test/live-skill-target.test.ts` 1/1 — real backend and real local
    gateway on one shared `WorkspaceRegistry`, bundle published first, `POST /api/projects` while listening, then
    inventory / install / inventory / toggle / check / status / update against the new workspace id, with the boot-configured
    `legacy` workspace asserted in the same test.
  - Legacy/old root preserved: the configured `legacy` workspace is asserted after the project exists; recorded-root replay
    and the "a project never retargets another conversation" contract stay covered by `skill-install.test.ts` 30/30 and
    `project.test.ts` 9/9.
  - Local and SSH are one lookup: `folderBinding` resolves a project folder to its gateway connection by `hostId`, so both
    take the identical path; the SSH cases live in `skill-install.test.ts`. No second mechanical fixture.
  - Seam re-read: `InstallerOptions.workspaces` is `() => readonly InstallBinding[]`, `server.ts` passes `allBindings`
    **uncalled**, `bindingOf` invokes it per request. One dependency, no registry, no state mirror, no guard, no fallback.

### F2 — adjacent material defect (found by reading; red/green proven; **fixed and merged at `bb3c4f7`**, released at `51492c4`)

- Root: `apps/server/src/server.ts:380` chose the harness env factory once at boot with
  `allBindings().length ? async (target, context) => { … } : undefined`. A deployment started with **no** configured
  workspace — the ordinary `HEPI_WORKSPACE_ID`-unset start that `docs/projects.md:49` documents — installed no factory, and
  `openServerHarness` (`harness.ts:43`) only installs `CodingTools` when `env` is present. So `read`/`write`/`edit`/`bash`
  were absent for the whole process: a project created afterwards gets its skills, but its conversation's turn fails with
  `Tool read is not available` until restart.
- Fix (owner 28, same seam, `d7cdff0` on `impl/ux-follow-up-live-env-factory`, merged here as `bb3c4f7`): always pass the factory; it resolves per
  request, so a conversation bound to no workspace resolves no binding and gets no environment. No fallback, no random
  workspace, no late hook, no second registry; the unbound case keeps its baseline behaviour.
- Proof: `apps/server/test/project.test.ts` "a project created on a zero-config deployment executes its tools without a
  restart" — real backend + real gateway, `bindLegacy: false`, project created through the public endpoint after listening,
  a new bound conversation runs `read` through the real gateway on a marker only the chosen folder holds; an unbound
  conversation fails the call and leaves no file.
  - **RED** (source `5db97fc`, test transplanted): `AssertionError … <harness> [error] Tool read is not available`, fail 1.
  - **GREEN** (same test + owner's server change): pass 1/1; server typecheck exit 0; `project.test.ts` 10/10; full
    `apps/server` suite **131/131** (F1 branch was 130; the new case is the +1).
- Merged verification at `bb3c4f7` (app subtree identical to `d7cdff0`): server typecheck exit 0; `project.test.ts` 10/10;
  `live-skill-target.test.ts` 1/1; full `apps/server` **131/131**. Both ordinary user-facing issues (F1, F2) are now fixed at
  source; the review's nuisance findings stay recorded without code changes, per policy.
- Status: **merged at `bb3c4f7`.** Ticket 21 source pin: app source `d7cdff0`, merge `bb3c4f7`.

### Evidence for the material findings

| Finding | Command or artifact | Result |
| --- | --- | --- |
| F1 snapshot | `grep -n 'createInstaller' apps/server/src/server.ts` → `:418`; `grep -n 'options.workspaces' apps/server/src/skill-install.ts` → `:294`; `grep -n 'projects.push(project)' apps/server/src/server.ts` → `:619` | Installer built once with `workspaces: allBindings()` (a snapshot made at `:323`); `POST /api/projects` later pushes to the live store the snapshot does not see |
| S1 English outcomes | `sed -n '225p;227p;270,283p' apps/server/src/skill-inventory.ts`; `sed -n '837p' apps/web/components/SkillsConfig.tsx`; cited locale pin `docs/execution-side-installation.md:282` | English literals returned by the backend; `SkillsConfig.tsx:837` concatenates `"Reload failed: "` beside the localized `skills.toggleFailed` on line 836 |
| S2 stale vendor README | `grep -n 'SkillMarketPanel' apps/web/vendor/pi-desktop/README.md` | `:3` and `:5` still name the retired `apps/web/components/SkillMarketPanel.tsx` |
| S4 prefix divergence | `grep -n 'WORKSPACE_PREFIX' apps/web/adapters/workbench.ts`; `grep -n '"/workspace/"' apps/web/adapters/durable-api.ts` | `workbench.ts:30` declares the constant; `durable-api.ts:43,119` inline the same literal |
| S5 thinking levels | `grep -n 'THINKING_LEVELS' apps/server/src/server.ts`; `sed -n '731p' apps/server/src/server.ts` | Declaration at `:85`, identical inline literal at `:731` |
| Command typo | `grep -n 'test:skills' apps/web/package.json packages/client/package.json` vs `sed -n '77p' .scratch/ux-follow-up/issues/14-retire-market-verify-skills.md` | `test:skills` is defined in `apps/web/package.json:49`; the issue names `--filter @hepi/client` |

## Status

- Standards axis: **complete** — five recorded findings, one recorded documentation typo, no fix, no investigate, no
  implementation loop (policy: trigger likelihood low or accuracy-only).
- Spec axis: **complete — F1 PASS and F2 PASS.** F1 fixed at `5180f4e` (merged `4a243ae`, rechecked at `5db97fc`); F2 fixed
  at `d7cdff0` (merged `bb3c4f7`, rechecked read-only on the merged source). Both are the ordinary user-facing issues the
  policy asks to fix; source verification at the merged pin is server typecheck exit 0 and `apps/server` 131/131.
- **Both review axes are complete at integration `ffb8067`** (final docs) over app source `d7cdff0` / merge `bb3c4f7`.
  Nothing in the effort is left unverified for the approved scope; deployment and paid live-provider smoke were never in scope.

## Recorded observations (not findings)

- A single concurrent run of the model-credentials server tests was transiently red for the skills owner while other suites
  were running in parallel; a clean rerun was 130/130 green. It is a test-runner concurrency artefact, not a product
  failure, and nothing in this effort touches the model-credentials path. No repair made.
- Verification for the F1 fix at its own merge (`4a243ae`): server typecheck exit 0; `live-skill-target.test.ts` 1/1,
  `skill-install.test.ts` 30/30, `project.test.ts` 9/9; `apps/server` 130/130 (the count before F2's added case). History at
  that pin, not the final count — the merged pin's verification is server typecheck exit 0 and `apps/server` 131/131.
  The gateway's 80/80 and the wider core suites were not re-run for either fix because the diffs are a getter/callback
  contract plus a test; no whole-web run, no browser run, no `apps/web` build for them.
