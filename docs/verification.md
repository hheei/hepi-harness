# Verification entrypoints

What to run, what each check actually covers, and the revision each recorded result was measured on. Read
[verification practice](agents/verification.md) before comparing baselines or reporting a pass: a number here is
scoped to the revision in its row, not a standing claim about the current tip.

A raw-log path here is where that log lived when the row was written. A worktree removed with an archive entry keeps
its relative layout under `.dev/worktree-archive/<name>`, and a log whose worktree owned `.dev/verify/` may now sit
under the repository root's own `.dev/verify/<topic>`. Where neither applies, the path is historical evidence for that
row, not a runnable command.

## Readable statically bundled SSH helper (filesystem adapters 01)

Source: `impl/nonui-filesystem-01` at `5ec7ffe62a2aaf172fb294bd68f1976098cfb012` plus the uncommitted working tree of that
slice. The remote filesystem helper moved out of one escaped 45,582-character string literal in
`packages/gateway/src/ssh-filesystem.ts` into `packages/gateway/src/ssh-filesystem-helper.ts`, where it is one
Python line per source line. It is still a static TypeScript import: no asset, loader, generated file, sidecar or
runtime source lookup was added, and `SshFilesystem` sends the same program over the same session bootstrap. Only
the three sequences a template literal would consume (backslash, backtick, dollar-brace) are escaped.

Logs below are relative to `.dev/verify/nonui-filesystem-01/` and
`.dev/verify/2026-10-21T13-12-51-032-verify-changed/` (the runner's own run directory).

| Command | Exit | Evidence |
| --- | --- | --- |
| decoded-program comparison: `git show HEAD:packages/gateway/src/ssh-filesystem.ts` literal vs the new module | 0 | `{"equal":true,"bytesBefore":43443,"bytesAfter":43443,"shaBefore":"60f28535…cb4c","shaAfter":"60f28535…cb4c"}` — byte-identical, so no inert formatting change either |
| `node --test test/ssh-helper-source.test.ts` (packages/gateway) | 0 | 1/1 pass: no CR, no interpolation, >1,000 lines, `node-ignore@7.0.5` notice, the backslash-built `_TEST_INVALID_TRAILING_BACKSLASH`, `b"\xef\xbb\xbf"` and `chunk.find(b"\n"…)` verbatim, and `python3` compiles the decoded source |
| `node --test test/{ssh-helper-source,ignore-parity,ssh-filesystem,ssh-session,ssh-resources,ssh-workspaces,resource-snapshot,filesystem,files-surface,ingress-resources-install,ingress-ssh-workbench,file-transfer,file-transfer-sshd,host-files,ssh}.test.ts` (packages/gateway) | 0 | `gateway-ssh-suites.log`: 104 tests, 104 pass, 0 fail — the ordinary admitted file/SSH workflows, including the loopback-sshd and parity suites |
| `node --test $(find src test -name '*.test.ts' | sort)` (packages/gateway acceptance) | 0 | `gateway-acceptance.log`: 496 tests, 496 pass, 0 fail — the whole package, not only the selected suites |
| `node --test test/{ssh-project,agent-definitions-http,agent-definitions-route}.test.ts` (apps/server) | 0 | `server-ssh-project.log`: 20 tests, 20 pass — resource snapshot, permitted agent-definition read/write and host account semantics over the SSH adapter |
| `pnpm typecheck` | 0 | `typecheck.log`; workspace and root tooling projects |
| `pnpm --filter @hepi/client build` | 0 | `client-build.log`; the helper program is in `dist/cli.js` (712,636 bytes, 43 chunks), and the entry file carries `Kael Zhang` and `node-ignore 7.0.5 port` |
| `HEPI_REQUIRE_SSH_SMOKE=1 pnpm --filter @hepi/client smoke:pack` | 0 | `client-smoke-pack.log`: 6 checks — packed tarball installed outside the checkout, help/version/doctor, local gateway, and a real localhost sshd serving account, read, command and worktree create/remove through `remote-loopback` |
| `pnpm verify:changed --quiet` | 0 | `verify.json` in the run directory: `changed-typecheck`, `changed-test` (362 tests, 362 pass), `web-unit` (14 pass) and `check-docs` all exit 0, `sha 5ec7ffe6…`, `dirty: true` for this slice's files |
| `pnpm verify:changed --quiet --base=5ec7ffe6` | 0 | `verify-changed-committed.log` and the run directory's `verify.json`: the same four steps exit 0 on the committed slice, `sha bcc02f26…`, `dirty: false` |

The build and pack ran on the workstation. `python3` 3.13.13 is the interpreter the local fixture and the helper's own
syntax check use; the helper's runtime requirement is unchanged (Python 3 on the execution host).

**Not covered here.** No remote-host deployment was made from this slice, and the persisted-state, alias-retirement and
cross-adapter scenario work belongs to the later filesystem tickets. The parity suite proves the two engines agree over
its generated corpus, not over every pattern `node-ignore` accepts.

## TypeScript test migration (2026-10-21)

Source: main at 67e3682967b067948f9b066ee72e20486323771b plus the uncommitted integrated working tree,
measured on Node 26.5.1. This supersedes the preceding naming batch's test filenames; older records below retain
the commands their own source used. Current placement and execution rules are in the
[test convention](developer-guide.md#test-layout-and-typescript).

107 former MJS unit-test files now use TypeScript (UI 86, App 8, Web 3, tooling 10). Browser drivers and their
shared stack, test-only helpers, MCP process fixtures and the two performance probes also use TypeScript.
The inventory in .dev/verify/test-typescript/inventory.json lists 267 current .test.ts files and 40 E2E .ts sources
(including the stack helper and one unit suite); no active legacy MJS test source remains in those scopes.
The inventory describes source, not which integration suites ran. Default Backend/Gateway profiles retain their
explicit selections; full acceptance discovery includes colocated src tests as well as test/.

Single-module tests moved beside Configure.tsx, skill-frontmatter.ts and subagents/recovery.ts. Package/platform
contracts remain under test/. Root and Web module format is explicit ESM, and tooling tests use strict NodeNext
checking. Historical comparison invokes each revision's own Web test runner, so discovery belongs to that revision.

Logs below are relative to .dev/verify/test-typescript/.

| Command | Exit | Evidence |
| --- | --- | --- |
| pnpm verify:changed --quiet --log-dir=.dev/verify/test-typescript/final | 0 | final/verify.json and per-step logs: all six checks pass. Workspace default suites: 1,058 pass; Web unit: 14 pass; tooling: 89 pass. Typecheck includes workspace tests, E2E sources and root tooling tests |
| pnpm --filter @hepi/web build | 0 | web-build-final.log |
| pnpm --filter @hepi/app build | 0 | app-build.log; App build inputs unchanged by later test-only edits |
| node apps/web/e2e/acceptance/ux-provider-connection-acceptance.ts | 0 | provider-final.log: 64 checks, 0 failures, controlled provider and disposable account |
| node apps/web/e2e/chat/ux-chat-scroll.ts | 0 | chat-scroll-final.log: all checks passed against the production build and real ingress/Backend stack |

The first gate (changed/verify.json, exit 1) caught a release fixture incorrectly naming the generated ingress
bundle ingress.ts. The fixture now names the actual ingress.mjs artifact; the final gate passes all 14 Web unit
cases. Independent tooling/process-fixture review found no material issues. Native TS syntax checks cover the
browser drivers; this record claims only the two browser journeys above, not the entire fleet or native desktop.

## Naming and dependency reorganization (2026-10-21)

Source: `main` at `67e3682967b067948f9b066ee72e20486323771b` plus the integrated, uncommitted working-tree changes.
These results certify that working tree, not a new commit or a deployed service. The batch removes Gateway → UI
imports, moves shared MCP contracts/parsers to protocol, groups UI file/chat/provider modules and current E2E
drivers, and renames the Backend Diagnostic Page assets and routes. Current ownership and layout are in the
[developer guide](developer-guide.md#directory-map); retired-driver coverage limits are in
[migration status](migration-status.md#retired-next-browser-drivers-2026-10-21).

Logs below are relative to `.dev/verify/session-resume-integration/`.

| Command | Exit | Evidence |
| --- | --- | --- |
| `pnpm verify:changed --quiet --log-dir=.dev/verify/session-resume-integration/changed` | 0 | `changed/verify.json` and per-step raw logs: all six steps pass — workspace typechecks/tests, recursive Web unit tests, script tests, entrypoints and docs |
| `pnpm --filter @hepi/server build:ui` | 0 | `diagnostics-build.log`; emits `public/diagnostics.js` |
| `pnpm --filter @hepi/web build` | 0 | `web-build.log` |
| `pnpm --filter @hepi/app build` | 0 | `app-build.log` |
| `node apps/web/e2e/acceptance/ux-provider-connection-acceptance.mjs` | 0 | `provider-acceptance.log`; **64 checks, 0 failures**, real ingress/Backend/Gateway stack with a controlled provider and disposable account files |

The protocol suite checks emitted modules for SDK runtime imports; the SDK remains a type-only development
dependency. Independent static review found no material correctness or ownership issues. This batch does not
claim the entire browser fleet, desktop shell, packaged artifacts or retired Next journeys passed.

## Deterministic test budget

Gateway and Server development suites each target less than 5 seconds of complete command wall time, including
runner startup. Exercise deadlines, expiry and retry scheduling with a controllable clock; tests advance virtual
time instead of sleeping or waiting for a real timeout. Substitute in-memory implementations at external transport,
filesystem, process and persistence boundaries for ordinary behavior tests. Keep production deadlines unchanged.

A fast run must state its selected files and test count. Moving tests into an explicit integration or acceptance
command does not establish equivalent deterministic coverage. Retain real process/crash, filesystem and database
acceptance evidence under its own command and identify any behavior not yet covered by the development suite.
Historical timings below describe their own revisions and broader test selections; they are not measurements of
the deterministic suite.

### Deterministic profile evidence — 2026-10-19

The gateway's ordinary profile is the fifteen suites that need no external boundary: no child process, no listening
socket, no temporary directory, no SSH fixture. It is **166 tests** across `control`, `files-surface`, `host-client`,
`host-files`, `host-terminal`, `mcp-import-resolution`, `mcp-invocation`, `mcp-list-tools`, `multipart`, `process`,
`provider-credential-store`, `skill-frontmatter`, `ssh`, `terminal-launcher` and `terminal-stream-budget`. Every other
file stays in `test:acceptance` (`node --test test/*.test.ts`), which is the whole package: **493 tests**.

The earlier profile reached 0.28 s by selecting five files (44 tests); it met the budget by dropping coverage, not by
making the slow cases deterministic. The two suites that dominated the wall time are now inside the budget:

- `provider-login.test.ts` took **75.8 s** of a 76.6 s acceptance run. Its flow deadline is armed through
  `ProviderLoginClock`, so the expiry case advances fifteen minutes instead of sleeping 4.3 s, and the deadline timer is
  unref'd — a host bound must not be what keeps a run alive. The fixture's own 60 s provider waits are unref'd too.
  Cases that hold a flow at a step the provider never reports state their own `graceMs` instead of spending the
  production 1.5 s first-step grace per start. 75.8 s → **0.90 s**, 15/15 passing.
- `ingress-providers.test.ts` took **32.4 s**, most of it a 30 s fixture exchange timer that outlived its assertions.
  Unref'd, plus the same `graceMs` seam at the deployment fixture. 32.4 s → **2.1 s**, 13/13 passing.

The full acceptance suite went **76.6 s → 8.2 s** with all 493 tests still passing, and `pnpm -r test` across the
workspace went to **4.5 s**. Production deadlines are unchanged: `PROVIDER_LOGIN_TTL_MS`, `PROVIDER_LOGIN_KEEP_MS`,
`PROVIDER_LOGIN_MAX_FLOWS` and `FIRST_STEP_GRACE_MS` keep their values, and the expiry test now asserts the real
15-minute bound rather than a 4 s stand-in. No assertion was weakened.

- `cd packages/gateway && /usr/bin/time -p pnpm test`: 166/166, `real 1.56s` (1.53–1.59 s over three runs);
  `pnpm --filter @hepi/gateway typecheck`: exit 0.
- `cd packages/gateway && /usr/bin/time -p pnpm test:acceptance`: 493/493, `real 8.17s`, exit 0.
- `cd apps/server && /usr/bin/time -p pnpm test`: 21/21, `real 0.35s`; `pnpm --filter @hepi/server typecheck`: exit 0.

Gateway and Server retain full suites as `test:acceptance` (`node --test test/*.test.ts`). These acceptance commands
are intentionally separate because they include real servers, filesystem fixtures, SSH/process boundaries, and
wall-clock deadline cases. The acceptance profiles were not used to claim the five-second development budget.

Behavior the ordinary profile therefore does **not** cover: real SSH transports and `sshd` fixtures (`ssh-session`,
`file-transfer`, `controlmaster`, `sshd-fixture`), real process execution and output capture (`execution`, `capture`,
`gateway`), the ingress suites' real Backend-over-SQLite deployments, and the filesystem/worktree suites that read a real
temporary directory. Those remain acceptance evidence and are unchanged by this profile.

### Server development profile widened — 2026-10-20

At `d356152` the Server `test` script selected three files (21 tests) and the rest of the suite lived only in
`test:acceptance`, so the five-second budget was met by a selection that did not describe the ordinary behavior. The
profile now runs the 51 files that reach no process, crash or remote-account boundary, and 23 stay in
`test:acceptance`: the five durable-subagent acceptance drivers, the four real-`SIGKILL` crash suites, the
context-preparation and MCP-call kill suites, the SSH/remote-account fixtures, the project and worktree filesystem
suites, and the skill install/market suites that copy bundles and open their own SQLite files.

- `cd apps/server && /usr/bin/time -p pnpm test`: 345/345 tests, `real 3.71s`–`4.02s` over five runs
  (the files' own durations sum to 36.5 s; the difference is the runner's default per-file concurrency);
  `pnpm --filter @hepi/server typecheck` exit 0.
- `cd apps/server && node --test test/*.test.ts` (`pnpm test:acceptance`): 544/544, `real 12.05s`.

`frame-size.test.ts` stays in the development profile because its seam is an ordinary state/stream read. Its stream
case had a 5 s `Promise.race` deadline whose timer was never cleared, so the file held the process open for the whole
5 s after the frame had already arrived; the timer is now cleared when the race settles. The deadline value and every
assertion are unchanged.

Not yet covered by the development profile: the crash-recovery evidence (a real `SIGKILL` between a preparation
commit and its admission, inside an MCP call, inside a stop's drain, and the durable-subagent commit/receipt windows),
filesystem fixtures over a real temporary directory tree (projects, worktrees, skill installs) and the SSH transport
fixtures. Those keep their acceptance command.



## Image display across recovery — observation corrected (2026-10-15)

The former C1 image failures were a **test observation error**, not missing product image rendering. The driver only
selected `data:image/png;base64,...` sources, while committed images use the backend's bounded image read blocks.
A browser probe found the transcript image decoded at its natural width, its authenticated read URL answered 200,
and its response bytes exactly matched the submitted PNG. No product rendering, storage or image route changed.

`apps/web/e2e/ux-image-submit.mjs` now checks images inside committed transcript entries, waits for successful decoding,
requires a rendered image, and compares its fetched bytes with the original PNG. Composer previews cannot satisfy a
history assertion. All **21 checks pass**, including submission, fresh-browser restoration, backend restart restoration,
HTTP/HTTPS submission, invalid/oversized file refusal and image-incapable model refusal. The latter still checks that
the transcript contains no image and the composer retains its attachment.

Measured source: precommit `e6c182f` plus the single driver patch published as `34bfaa9`; dirty-before paths are recorded.
Command: `HEPI_UX06_WEB_PORT=45806 HEPI_UX06_BACKEND_PORT=45807 node apps/web/e2e/ux-image-submit.mjs`, exit 0.
The unchanged product used the existing `Be4b114CesOWD7SHhEc6I` production build from `e20ab94`; no rebuild or full
unit rerun was needed for this test-only change. Raw red/probe/green logs and provenance are in
`.dev/verify/image-history/`. Historical C1 failure logs below retain their actual results; their earlier description
as a product projection gap is superseded by this diagnosis. The unrelated worktree baseline remains recorded.

## Subtree control system acceptance (2026-10-20)

Ticket 04 of [subagent subtree lifecycle control](../.scratch/subagent-subtree-control/spec.md) closes the system
acceptance for the subtree operation tickets 01–03 delivered. This section records the revision, the commands, their
exit codes and the logs; [the ticket](../.scratch/subagent-subtree-control/issues/04-system-acceptance.md) records the
acceptance matrix row by row and what the work does not claim. It is now **integrated into this line** — see
[the integration record](#how-subtree-control-ticket-04-arrived-on-this-line-2026-10-20) below.

The rows in this section are the ticket’s own runs in its branch worktree `impl/subtree-control-04`, cut from
the `integration/client-app` tip `96fc976`: no deployment, no service restart, no push, no build on the runtime
host, and no build outside that worktree. Every acceptance store is a test-owned SQLite file under a temporary
directory; the crash stages are child processes this suite starts, and the execution host the
Gateway-interruption case kills is the gateway entrypoint started by the test itself
(`apps/server/test/recovery-acceptance-host.ts`, reused rather than re-implemented).

**What was added.** `apps/server/test/subtree-control-acceptance.test.ts` (6 cases, now named in
`apps/server`'s own `test` script so the standard gate runs it rather than only this ticket's command) and its stage
`apps/server/test/subtree-control-acceptance-child.ts` (`partial` and `blocked`); the browser harness
`apps/web/e2e/ux-subtree-control.mjs` grew from 68 to 78 checks with a mixed-state matrix that the same
`AgentSessionPanel`/`SubtreeControlPanel` fixture serves (`apps/web/e2e/ux-subtree-control.fixture.tsx` gained the
`mixed` answer and the matching catalogue rows). One manifest line changed — `apps/server/package.json`'s `test` script
now names the new suite, so the standard workspace gate runs it — and no lockfile, dependency or production source file
did: this ticket is acceptance evidence and docs.

| Check | Command | Revision | Exit | Result and log |
| --- | --- | --- | --- | --- |
| The four subtree suites, focused | `node --test --test-reporter=tap test/subtree-control.test.ts test/subtree-control-crash.test.ts test/subtree-control-projection.test.ts test/subtree-control-acceptance.test.ts` (cwd `apps/server`) | `96fc976` + ticket tree | 0 | 20/20 pass, 0 fail. The 6 acceptance cases are the ones above; the other 14 are tickets 01–02's own suites, rerun at this tip. |
| Server + Web typecheck (the fixture is TypeScript) | `pnpm --filter @hepi/server --filter @hepi/web -r typecheck` | `96fc976` + ticket tree | 0 | Both `tsc --noEmit` runs and Web's `tsconfig.vite.json` pass. A first run caught one real error in the new fixture (`row.name` is optional in `CatalogueRow`) which was fixed at the fixture rather than asserted around. |
| Browser seam, outside `--base` reach | `node e2e/ux-subtree-control.mjs` (cwd `apps/web`) | `96fc976` + ticket tree | 0 | **78 checks, 0 FAIL**, headless Chromium. The selector covers packages and dependents, not browser flows, so this is run separately at the tested tree. |
| Gate selector | `pnpm verify:changed --base=96fc976` | `96fc976` + ticket tree | 1 | `changed-typecheck` 0, `changed-test` 0 (**352** server tests = 346 + the 6 new acceptance cases, 0 fail), `web-unit` 0 (14/14), `check-docs` 1. The non-zero exit is `check-docs` alone, on the repository's pre-existing 12 broken links (reconciled below). |
| Docs link check | `node scripts/check-docs.mjs` | `96fc976` + ticket tree | 1 | 432 files, **12** broken links. The list is **identical** to the same command run on a clean detached worktree at `96fc976` (`diff` of the broken paths is empty), so this ticket adds none of them: 10 are `.scratch` documents pointing at git-ignored `.dev/verify` logs and 2 point at a `.pi/skills` path absent from this checkout. |

**The mixed-state matrix, and why it needed the browser.** The projection suite already asserts that one child's
recorded outcome and its current row are two facts. What no server test can state is that the **screen** keeps them
apart for *every* state at once: the new step drives one request in which every child records `accepted` while each
child's own row reads `blocked`, `interrupted` and `waiting-report`, then asserts the child tree and the answer state
the same row per child id — the comparison is by id, because the tree draws a grandchild beneath its parent and the
answer reports discovery order. The same step asserts the refresh is one GET under the request's own id and that it
writes nothing.

**A finding this ticket produced, and what happened to it.** The first run of the mixed step failed on
`running,running,held` instead of the mixed rows, because the fixture's catalogue was one fixed list while the answer
was mode-dependent: the surface was correct and the *fixture* was stating two projections. That is the exact
aggregate-state lie the operation exists to avoid, so the fixture now projects its rows from the same table the answer
uses (`rowsFor`), and the assertion compares per child id rather than positionally. Recorded because it is evidence
about the surface: the panel renders whatever the catalogue says, and cannot be blamed for a catalogue that disagrees.

**Not asserted, and stated as a limit.** No power-loss, disk-full, kill-during-commit or corrupt-journal claim:
`SIGKILL` of a process this suite owns is the only window it stands behind. No exactly-once claim for an external side
effect — the delegated child's killed `bash` call settles as `outcome_unknown` and the control never replays it. No
deployment or live-stack reading was taken for this ticket.

### How subtree-control ticket 04 arrived on this line (2026-10-20)

The ticket branch was cut at `integration/client-app` `96fc976`, and this line has moved a long way past it: the
history-navigation 03 and 04 work, the provider-connection work, the MCP lifecycle work, the Web logout contract and the
deployment records all landed after that tip. Merging the branch would have carried that older tree back over them, so
the integration **cherry-picked `7cd4f79` alone** onto this line's tip `3d15c864` and took nothing else from the
branch's history.

The pick produced no conflict: `docs/chat.md`, `docs/migration-status.md` and `docs/verification.md` auto-merged
and every other file was purely additive against this tree. The files the ticket's source lives in are
**byte-identical to `7cd4f79`** after the pick (`git diff 7cd4f79 HEAD` over
`apps/server/test/subtree-control-acceptance.test.ts`, its `-child` stage, `apps/web/e2e/ux-subtree-control.mjs`,
`apps/web/e2e/ux-subtree-control.fixture.tsx` and `apps/server/package.json`: empty), so this is the reviewed source
rather than a reconstruction of it. The `apps/server` `test` script now names the new suite beside the 50 files this
line had, and the ticket's four record documents and the three subtree guides state ticket 04 as delivered.

What the surrounding line had to keep was therefore the tree, not a hunk in it. Inspected after the pick: the
history-navigation 03/04 sections of `docs/verification.md` and `docs/chat.md#the-full-history-navigation-outline`
are intact above and below the inserted section, [migration status](migration-status.md) keeps the full-history
navigation entry beside the subtree one it edited, the provider and MCP records are untouched, the Web logout contract
section still reads as delivered, and no deployment or container guide changed.

Every row below was **re-measured on this integrated tree**, not inherited from the ticket's own `96fc976` runs — the
surrounding line moved, so the code was re-run here. Logs are in
`.dev/verify/2026-10-20T03-27-16-498-verify-changed/` and `/tmp/subtree04-focused.log`, `/tmp/ux-subtree04.log`.

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| The four subtree suites, focused | `node --test --test-reporter=tap test/subtree-control.test.ts test/subtree-control-crash.test.ts test/subtree-control-projection.test.ts test/subtree-control-acceptance.test.ts` (cwd `apps/server`) | `23cef1a` | 0 | **20/20 pass**, 0 fail — the 6 acceptance cases plus the 14 tickets 01–02 already had here |
| The standard Server gate, with the new suite in it | `cd apps/server && pnpm test` | `23cef1a` | 0 | **352/352 pass**, 0 fail (`real ~4.0s`) |
| Server + Web typecheck | `pnpm --filter @hepi/server --filter @hepi/web -r typecheck` | `23cef1a` | 0 | both `tsc --noEmit` runs and Web's `tsconfig.vite.json` pass — see the environment note below |
| Browser seam, outside `--base` reach | `node e2e/ux-subtree-control.mjs` (cwd `apps/web`) | `23cef1a` | 0 | **78 checks, 0 FAIL**, headless Chromium, including the mixed matrix (`accepted/blocked`, `accepted/interrupted`, `accepted/waiting-report`, the tree's rows equal to the answer's per child id, one read and no write on refresh) |
| Gate selector over the integrated tree | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=3d15c864` | `23cef1a` (clean tree) | 1 | `changed-typecheck` 0, `changed-test` 0 (**352** server tests, 0 fail), `web-unit` 0 (14/14), `check-docs` 1 — the repository's pre-existing 12 broken links and nothing else |
| Docs link check | `node scripts/check-docs.mjs` | `23cef1a` | 1 | 435 files, **12** broken links, and the `file:line -> target` list is **identical** (`diff` empty) to the same command run over a clean export of `3d15c864`. This ticket adds none: 10 are `.scratch` documents pointing at git-ignored `.dev/verify` logs and 2 at a `.pi/skills` path absent from this checkout. |
| Whitespace / conflict-marker check | `git diff --check` | `23cef1a` | 0 | no output |

**An environment note, so the typecheck row is not read as stronger than it is.** This worktree carries an untracked
`apps/server/scripts/history-acceptance-fixture.ts` that is not part of this or any commit here — history-navigation
ticket 05's fixture, still in progress in this worktree. It has two real `tsc` errors of its own
(`TS2345` at lines 204–205: a `string` passed where `ConversationId` — which is `number` — is required), so the
typecheck above was measured with that file set aside, exactly as the commit's tree stands. The file was left untracked
and untouched; it is not this ticket's to fix and no check here was rewritten around it. **Corrected 2026-10-20:** that
file, and its driver `apps/web/e2e/ux-history-acceptance.mjs`, were later **tracked by accident** by a docs commit that
added them while collecting an unrelated record, so they briefly joined this tree. Both were removed — from the index and
from disk — when the accidental commit was amended; history-navigation 05's formal pair
(`history-navigation-acceptance-fixture.ts`, `ux-history-navigation-acceptance.mjs`) already carries that ticket's
acceptance, and the rows above were never measured with the accidental pair in a tree the selector read.

**Not claimed by this integration.** No push, deployment, service restart or `remote-host` build; no bypass or
security-control probe. The ticket's own limits stand unchanged: `SIGKILL` of a process the suite owns is the only
window it stands behind, an external side effect is never claimed to happen exactly once, and no live-stack reading was
taken. The merged browser evidence is the fixture-backed seam, not a deployed stack.

## Durable subagents: the combined acceptance gate (2026-10-17)

The subagents feature's acceptance table (A01–A22) is closed by five drivers, each at a seam no owning ticket could
reach, plus one production browser journey that runs the whole feature as one session. They are the current entrypoints
for that claim; the per-ticket records remain in the
[ticket breakdown](../.scratch/durable-subagents/README.md) and its issues.

```bash
cd apps/server && node --test test/acceptance-chain.test.ts test/acceptance-recovery.test.ts \
  test/acceptance-failure.test.ts test/acceptance-multisession.test.ts test/acceptance-shared-answer.test.ts
pnpm --filter @hepi/web build
HEPI_UX13_WEB_PORT=32013 HEPI_UX13_BACKEND_PORT=42013 HEPI_UX13_CONTROL_PORT=42113 \
  node apps/web/e2e/ux-system-acceptance.mjs
```

Measured on 2026-10-17 at `b6b6745` with the ten new files as the only dirty paths: `pnpm verify:changed
--base=b6b6745` exit 0 (`.dev/verify/2026-10-17T04-00-29-199-verify-changed/`), the five drivers **8 tests, 8 pass**
(`.scratch/durable-subagents/logs/13/acceptance-tests.log`), and the browser journey **53 checks, 0 failures**
(`.scratch/durable-subagents/logs/13/ux-system-acceptance.log`). Ports, SQLite files and artifact directories are the
driver's own; the browser one deletes its artifact directory unless `--keep` is passed.

Two things about that browser log worth knowing before citing it. It is **not** a live-deployment check: it serves an
isolated production build of this work over its own backend, SQLite file, gateway and controlled model endpoint. And it
now states its own provenance: the driver prints its first line as the Next build id plus the git revision (and whether
the tree was dirty), so a recorded log names the build and source it measured instead of leaving that to the ticket. The
driver also stops every process it started — on success, on failure and on `SIGINT`/`SIGTERM`/`SIGHUP` — so an
interrupted run leaves no listener holding its ports.

Final integration closure on 2026-10-17: `pnpm verify:changed --base=2ce7272` passed at `311b0c9`
(server **448**, gateway **277**, protocol **51**, client **10**, session **34**, Web **144**, script tests **51**).
The integrated browser journey passed **53/53** at `cac2395` plus the single driver cleanup patch published as
`339ce42`, using build `pLDNKU8f6EwFlvDX4S_Aw` copied from the running `hepi-web:b6b6745` image. Web product
source was unchanged across that range. An older local `.next` lacked the Agents panel and was replaced before this run.
The signal and `finally` paths now share one cleanup Promise: a concurrent-call probe proves both wait for resource
closure, and a real `SIGTERM` during the browser Settings workflow exited **130**, leaving **0** live processes in
the driver's owned process group (3 were running before the signal). Raw integration, cleanup and deployment evidence
is retained in `.dev/merge-backup-20261017/` and `.dev/deploy/1062840/`.

On the final changed gate, gateway tests took **1.03 s** and the expanded server suite **13.6 s**; the server
**5 s** target remains unmet. Core suites retained their behavior coverage and ran without skips. The vendor snapshot
checks below remain separate from this gate.

What each driver states, and what none of them may be read as:

- **`acceptance-chain.test.ts`** — two real `SIGKILL`s in **one** chain: a process admits a child and is killed, a second
  admits the report and is killed, a third finishes. Across all three processes: one child, one dispatch, one child
  submission, one report entry and one permanent anchor. A page reload, a clean close or a listener test cannot produce
  this; only a killed process whose successor reads the same SQLite file can.
- **`acceptance-recovery.test.ts`** — the three windows that only exist **mid-drain**, each an isolated backend process
  over its own SQLite killed without a close: a stop committed while its ordinary scope still drains, a continue whose
  HTTP answer never reached the caller, and a newer stop that supersedes an older continue whose retry then arrives
  (answered `409 superseded`, newer hold still in force).
- **`acceptance-failure.test.ts`** — a tool task killed **inside `execute`** reopens with its call settled as
  "interrupted and may have partially run", while the file its body appended still holds exactly one line, so the body is
  never replayed; and a store reopened by a build that installs no anchor definition states `missing_task` with the
  child's history still readable. The wait is on the file the body wrote, not on the task's `execute` checkpoint — the
  checkpoint is stated before the body runs, and a driver that waits for it kills a process that may not have written
  anything yet.
- **`acceptance-multisession.test.ts`** — one parent, an independent main conversation, a child and a branch of that
  child read back after the work ran, with the child inheriting a **retained** workspace binding (a Project that was
  removed after the conversation was bound) and the file its tool wrote on that host.
- **`acceptance-shared-answer.test.ts`** — with `followUpMode: "all"`, two admitted inputs cost **one** model request and
  both submissions name the same committed `answerId`, each still answering its own request id.
- **`ux-system-acceptance.mjs`** — the production Next build, a real backend over real SQLite, a real local execution
  host with real definition files, the real anchor and reporter tasks, and one controlled OpenAI-completions endpoint
  that records every request. It saves a definition in Settings and reads the file off the host, quick-creates a child
  from the composer and opens it, checks the tree's own statuses, queues a late report under a user stop and proves no
  model was woken, edits the item, reloads and re-reads the edit, continues and proves the model read the kept text,
  then opens the child's raw history (compacted prefix, an inherited image as its own bytes, a structured reference,
  a fork from a chosen entry), and re-checks a request-id-recovered submission, a bounded history and an image block
  read by address.

Not claimed by any of this: that an **external** side effect happens exactly once (the unsafe result says it may have
partly run), that the live deployment is crash-safe (no driver here runs against it — the routine deploy that ships this
work is a deployment check, not recovery evidence), or that every browser journey of every owning ticket is rerun
here — those keep their own records.

## App connection refusal and recovery (ticket 19)

The App's refusal surface now states which failure it is and offers the step that can change it, instead of a paragraph
with nothing to press. Measured on `workstation` (Linux x86_64) against the packaged artifact, 2026-10-19.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| build, provenance | `node apps/app/scripts/build-artifacts.mjs --label=ticket19` | `d356152` + this change (dirty tree) | 0 | `.dev/artifacts/ticket19/provenance.json` |
| packaged artifact test, **54 assertions** | `node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/ticket19` | `d356152` + this change (dirty tree) | 0 | `.dev/artifacts/ticket19/verify-2026-10-19T18-07-26-325Z/report.json` |
| selected checks | `pnpm verify:changed --base=d356152` | `d356152` + this change (dirty tree) | 1 — typecheck, workspace tests (279 ui, 44 gateway, 21 server, 21 app) and web unit (14) 0; `check-docs` 1 with only the 12 pre-existing `.dev`/`.pi` links, none added | `.dev/verify/2026-10-19T17-59-57-279-verify-changed/verify.json` |

The assertions this ticket adds to the packaged run, by name, and what each was measured against:

| Assertion | What it holds |
| --- | --- |
| `a-refused-connection-is-reported-as-refused` | a stored bearer the fixture Gateway answers 401 for produces `"surface":"refused"` with the credential reason, and the fixture's own log shows the `GET /api/descriptor` it refused (`the-refused-gateway-saw-the-descriptor-read-it-refused`) |
| `a-refusal-names-no-connection`, `a-refusal-states-the-credential-as-its-reason` | the refusal states no Backend, scope or client and names the credential as what to change: a refused connection is never reported as a workbench |
| `the-refusal-primary-action-is-reachable-by-keyboard` | Enter in the focused window activates the surface's primary control; the refusal surface has no other input to type into |
| `opening-the-replacement-form-does-not-delete-the-stored-connection` | the Secret Service entry this run owns is read before and after that keypress and is the same entry — a replacement is opened **over** the connection, not after forgetting it |
| `replacing-a-refused-connection-admits-the-new-credential`, `the-replacement-request-carries-the-new-bearer`, `the-replacement-is-reported-as-the-admitted-connection` | the form is typed into the real window with `xdotool` against a second fixture, and the admitted readout names **that** fixture's Backend, account scope and client (`replacement-backend` / `replacement-account` / `device:cred-replacement`); the refused connection's descriptor is not carried over |

Credential isolation: the run reported `credentialStore.inheritedSessionBusUsed: false` on a private
`/tmp/hepi-artifact-cred-*` bus and keyring, and `loginKeyringUntouched: true` with the developer's own
`login.keyring` digest identical before and after (`0ced02df2ba9` → `0ced02df2ba9`). No `dev.hepi.app/connection`
write reached the real session store.

Unit coverage of the same rule: `packages/ui/src/components/ConnectionRecovery.test.mjs` (the action plan per state, the
destructive copy behind its confirmation, and the Web page that offers nothing it cannot perform),
`packages/ui/src/lib/web-session-gate.test.mjs` (the refusal kind per status) and
`apps/app/test/connection-recovery.test.mjs` (first-run versus replacement form, the stored bearer never rendered, and the
App entry stating its two management actions).

Not evidenced here, and not claimed: any Android artifact (still no SDK, `adb` or device on this host), and a recovery
journey against a **real** Gateway and Backend — the two fixture ingresses are the other end, one refusing and one
admitting. The App has still not been run against a real Backend in this ticket.

## Shared client acceptance (ticket 16)

The two new hosts — the production Vite Web page and the packaged App — are accepted against one real system by two
drivers that state different things, because only one of them can state the native half. Both are entered from the Web
workspace and both are honest about the platform they do not cover.

```bash
pnpm --filter @hepi/web build && pnpm --filter @hepi/app build
node apps/web/e2e/ux-client-acceptance.mjs [--keep]

# The native half needs the debug shell; see "debug build" below. It starts its own private D-Bus session bus and its own
# Secret Service, so it never writes the credential store of whoever runs it.
cd apps/app/src-tauri && CARGO_TARGET_DIR=/home/developer/Documents/dev/hepi-harness/.dev/cargo-target \
  CARGO_BUILD_JOBS=6 CARGO_INCREMENTAL=1 cargo build && cd -
node apps/web/e2e/ux-native-acceptance.mjs [--keep] [--binary=<path>]
```

What each driver stands up, and what it refuses to claim:

- **`ux-client-acceptance.mjs`** — Chromium on the production Web build and, separately, on the production App bundle
  loaded at its own origin with the shell's injected connection. Real client ingress, real Backend over its own SQLite
  files, real execution gateway, real device-credential store, one controlled model endpoint. It drives: a gated first
  open that asks for the deployment's login; a wrong login refused with the form still usable; a Web-created
  conversation; a device credential issued by the Web session and refused from an origin the deployment did not
  declare; the App reading the Web turn over its own stream on its configured Gateway origin; a submission whose
  response is dropped at the transport and which reaches the model exactly once; the Web page reading the App's turn
  without a second model request; a Backend restart after which the same durable state is served and the page
  re-attaches its stream; refusals for a missing cookie, an unknown bearer, the internal `/v1` surface and the
  deployment's own service credential; a draft that does not cross clients; and a revocation whose refusal is
  measured from the revoke call. **The App half here is browser-emulated**: it states the App host's own logic, not a
  native shell. It also drives the routes a cutover switches with that emulated App's **device bearer and no cookie**,
  over the ingress origin alone: `/api/workspaces` and `/api/hosts`, the browser's `/api/files/<workspace>` listing (plus
  a path naming no workspace refused), a terminal tab opened / streamed over `/api/terminal/events` / closed, and
  `/api/mcp` read → written → read back from the host's own `mcp.json`. Those four are the ingress's four different
  ways of answering — Backend forward, file surface, terminal fan-in, locally-answered host service — so the journey says
  the one listener is the entry, not only its conversation half.
- **`ux-native-acceptance.mjs`** — the real packaged shell (WebKitGTK + Tauri) under its own Xvfb, in the **debug**
  profile, and under **a credential store the run owns** (`scripts/lib/credential-sandbox.mjs`): a private session bus and
  a private unlocked keyring, with the ambient bus address, keyring control socket and XDG homes reaching no child, every
  packaged environment taken from `packagedEnvironment()` (which refuses a store that is not this run's, because an empty
  environment still reaches `/run/user/<uid>/bus`), and a check that the developer's own `login.keyring` digest is identical
  at the end. It states a cold start with no connection
  (which asserts no connection at all), the connection stored through the path the shell ships, the workbench that comes
  back after the restart it triggers **named by the Backend, account scope and client id the ingress actually admitted**,
  a real window on the display, and the stored device bearer admitted from the shell's `tauri://localhost` origin and
  refused after revocation — including a shell restarted while still holding that revoked credential, which reports
  `refused` rather than a workbench, and no line of whose run ever states an admitted connection. The kinds of claim are
  labelled in its own output — a **UI / transport assertion** (`HEPI_APP_READY`, printed by the App bundle inside the
  WebView from the read that settled it, carrying the admitted connection's facts), a **platform assertion** (`xdotool`,
  asked of the X server) and **pixel evidence** (the capture, asserted only not to be
  one flat surface). It states nothing
  about performance: the binary is unoptimised with symbols retained, because this workflow needs a fast debuggable
  shell rather than a release artifact. Release artifacts and their reproducibility stay with ticket 15.

Measured 2026-10-18 on `workstation` (Linux 6.17.0-23-generic x86_64, Node 26.5.1, pnpm 12.4.1, WebKitGTK 2.52.3) at
`41b55ce` (clean tree, integration tip `a39dc80` merged) — the drivers print the source revision and dirty state as
their first line and the native one names its debug binary. The first runs of the same drivers, before the
static-surface and packaging slices were merged, are what found the two defects below; their numbers are not repeated
because the builds changed.

| Check | Command | exit | result |
| --- | --- | --- | --- |
| Web + browser-emulated App journey | `node apps/web/e2e/ux-client-acceptance.mjs` | 0 | 41 checks, 0 failures |
| Native shell, debug profile | `node apps/web/e2e/ux-native-acceptance.mjs` | 0 | 11 checks, 0 failures |
| Login/refusal rule | `node --test packages/ui/src/lib/web-session-gate.test.mjs` | 0 | 5 tests |
| Connection identity | `node --test packages/ui/src/lib/connection-lifetime.test.mjs` | 0 | 3 tests |
| Shared UI seams (existing) | `node --test packages/ui/src/lib/navigation.test.mjs packages/ui/src/lib/workbench-scope.test.mjs packages/ui/src/client.test.mjs` | 0 | 18 tests |

Rerun 2026-10-18 at `0d90b7d` — the driver change below (fallback host removed, App-bearer route checks added, native
assertions separated), driven on the **clean** commit it landed in, so these numbers belong to that revision and to no
other. `node apps/web/e2e/ux-client-acceptance.mjs` → exit 0, **52 checks, 0 failures**, first line
`source 0d90b7d… (clean)` and `static surface: ingress`; the refusal it now performs was checked by moving
`apps/web/dist/index.html` aside and starting the stack alone → `the client ingress does not serve the static Web shell on
/ (404 application/json) … this driver has no fallback host to substitute for the surface under test`; `node
apps/web/e2e/ux-native-acceptance.mjs` (debug shell, shared `CARGO_TARGET_DIR`) → exit 0, **12 checks, 0 failures**.
`node --test packages/ui/src/lib/web-session-gate.test.mjs packages/ui/src/lib/connection-lifetime.test.mjs` → exit 0,
**8 pass**; `node --test packages/gateway/test/ingress-mcp.test.ts` → exit 0, **9 pass**. The shared-UI-seams row above
was taken at 18 tests on its own revision; the same three files are **13 tests, 13 pass, exit 0** here
(`.dev/verify/t16-nofallback/ui-seams.log`) — this change touches none of them, so it is that row's own record rather
than a regression. Logs: `.dev/verify/t16-nofallback/`. Measurement from this clean run: first visible content **228 ms**,
**75** Web and **28** App requests, **3** model requests, peak RSS backend **113 MB** / gateway **118 MB** / ingress
**199 MB**, revocation refused after **369 ms**. The 11 extra checks are the routes a cutover switches, driven with the
App's device bearer over the one ingress origin: `/api/workspaces`, `/api/hosts`,
`/api/files/workspace/local?type=list` (and a path naming no workspace refused), a terminal tab opened / streamed /
closed through `/api/terminal…` fan-in, and `/api/mcp` read → written → read back from the host's own file.

Rerun 2026-10-19 at **`2c6f801`** — the defects below were **in the test harness and in the readiness contract, not in the
deployed page**, and all of them are recorded here because they change what a native run is allowed to claim:

- **The native driver used to write the developer's own credential store.** `hepi-app --configure` / `--forget` ran with
  `process.env` inherited, so the shell's `keyring` → Secret Service calls went to the session bus of whoever was running
  the test — overwriting and deleting `dev.hepi.app/connection`, the one entry a real installed App on this machine lives
  on. Both native drivers (`apps/web/e2e/ux-native-acceptance.mjs` and `apps/app/scripts/verify-artifacts.mjs`) now run
  every shell process under `scripts/lib/credential-sandbox.mjs`: its own `dbus-daemon` on a config-file socket and its own
  `gnome-keyring-daemon --foreground --unlock` on a temp `HOME`, ambient `DBUS_SESSION_BUS_ADDRESS`,
  `GNOME_KEYRING_CONTROL`/`GNOME_KEYRING_PID` and every XDG home replaced or removed, and **no fallback to the ambient
  bus** — the helper throws if a tool is missing or the private Secret Service never appears, and `packagedEnvironment()`
  refuses to hand any packaged process an environment that does not name this run's bus. The store lives under
  `TMPDIR` and is moved to the caller's log directory for retention only after its daemons exit, because a unix socket
  path over the 107-byte `sockaddr_un` limit (measured 146 B when rooted in a worktree's `.dev/verify/<run>/`) makes a bus
  that never binds and a run that reports a store it does not own. Both runs state the SHA-256 of the developer's
  `~/.local/share/keyrings/login.keyring` before and after and check it identical.
- **An empty environment is not an isolated one.** `apps/app/scripts/verify-artifacts.mjs` caught that store-start failure,
  left `shellEnv = {}` and went on to run `--forget` anyway. With no `DBUS_SESSION_BUS_ADDRESS` the Secret Service library
  does not give up — it goes on to `/run/user/<uid>/bus`, the developer's running session — so a run reporting "no store
  was started" would still have deleted a real user's App connection. Every packaged spawn now takes its environment from
  `packagedEnvironment(credentials, extra)`, which throws unless it is handed this run's own bus: no store, no credential
  process. The trigger is ordinary (a host missing `gdbus` or `dbus-daemon`), which is why the guard lives with the sandbox
  rather than as a per-driver `if`.
- **A driver that acquires before it owns cleanup orphans what it took.** `apps/web/e2e/ux-native-acceptance.mjs` started
  Xvfb and the whole stack before registering a shutdown handle or signal handlers, so a store-start throw left a display
  and three services behind. Its resource handles are now declared first, cleanup and signal handlers are installed before
  anything is acquired, and each acquisition failure releases what it took before exiting.
- **A stored connection used to be reported as a workbench.** `apps/app/src/main.tsx` printed
  `HEPI_APP_READY {"surface":"workbench"}` in the branch that *found* a stored credential, before its descriptor read
  settled — so a revoked or unreachable deployment still claimed a workbench, and a packaged check reading that line would
  have believed a WebView that never reached a Backend. `packages/ui/src/lib/connection-readout.ts` now decides what a host
  may state from the read's own settled outcome (`admitted {profile, backendId, accountScope, client}` / `refused
  {reason}`, nothing while in flight), `Workbench` calls the host's `onConnectionReadout` only for those, and `app_ready`
  carries `backend`, `scope`, `client`, `profile`, `reason`. The driver's workbench check now **requires** all four
  non-empty and compares `client` with the id it issued, so the line is an observation of the WebView's own transport; the
  revocation journey then restarts the shell holding the revoked credential and asserts it reports `refused` and that no
  line in that run ever stated an admitted connection.

`node apps/app/scripts/build-artifacts.mjs --label=t16-final --profile=debug --skip-web` → exit 0, debug `.deb` + binary with
`provenance.revision = 2c6f8019fbd3…` (`.dev/verify/t16-final/build-artifacts.log`); the shell itself reports the same
revision in `HEPI_APP_BUILD`, so the runs below are measured against this commit rather than a dirty tree.

`node apps/web/e2e/ux-native-acceptance.mjs --keep` → exit 0, **26 checks, 0 failures** (`.dev/verify/t16-final-native/run.log`;
private bus `unix:path=/tmp/hepi-t16-native-cred-HR09W4/bus`, the run's own store starting empty, every shell process handed
that bus and no keyring control socket while the address it did *not* use was `unix:path=/run/user/1000/bus`, the admitted
line naming `backend=hepi-backend` / `scope=default` / `client=device:3dafd337-4a60-…` matching the credential the run
issued, the revoked-bearer restart reporting `refused` with no admitted line anywhere in its run, the store retained as
evidence at `/tmp/hepi-t16-native-0uV8QV/hepi-t16-native-cred-HR09W4`, login keyring `0ced02df2ba9…` unchanged).
`node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/t16-final --log-dir=.dev/verify/t16-final-artifacts/run`
→ exit 0, **39 assertions, 0 failures** (`.dev/verify/t16-final-artifacts/run/report.json`; `the-run's-store-starts-empty`,
`the-stored-entry-is-in-the-run's-own-store`, `forget-emptied-the-run's-own-store`,
`packaged-runs-addressed-a-private-credential-store` (`unix:path=/tmp/hepi-artifact-cred-d2yiKv/bus`, removed with the run)
and `developer-login-keyring-unchanged` all pass). `node --test scripts/credential-sandbox.test.mjs` → exit
0, **11 pass**. The client journey was rerun because `Workbench`'s public configuration gained a host callback: `node
apps/web/e2e/ux-client-acceptance.mjs` → exit 0, **52 checks, 0 failures** (`.dev/verify/t16-final-client/run.log`;
first visible **215 ms**, **75** Web / **28** App requests, **3** model requests, peak RSS backend **122 MB** / gateway
**119 MB** / ingress **199 MB**, revocation refused after **949 ms**) — the same shape as the `0d90b7d` record above, as
expected for a host the Web page does not pass. `node --test packages/ui/src/lib/connection-readout.test.mjs` → 7 pass;
`pnpm --filter @hepi/app test` → 10 pass (including "the bearer never reaches the readiness line"); `pnpm --filter
@hepi/ui test` → 208 pass; `pnpm test:scripts` → 85 pass; `pnpm --filter @hepi/ui|@hepi/app typecheck` → clean; `cargo
test` in the shared debug target → 4 pass. `pnpm verify:changed --base=5c4a6d8` at `2c6f801` (clean) → five steps exit 0,
`check-docs` 1 with the same 12 pre-existing git-ignored broken links (`.dev/verify/2026-10-19T00-44-00-514-verify-changed/`).

One finding is recorded rather than fixed: the workbench's `descriptor`/`admission` state survives a changed
`connectionKey` until the next read settles, so a host that swapped profile or credential inside one mounted page could be
handed the previous connection's Backend and client for one commit. The reviewer classified this as not a normal trigger —
the packaged shell changes connection by restarting the process, and the Web host states no readout — and the coherent fix
belongs to the workbench's state model, not to this ticket's readiness contract; see
`.scratch/client-app/issues/16-integration-and-direct-cutover.md`.

Representative measurement from the client journey run (`--keep`, its own artifacts): first visible content **194 ms**
after navigation, **74** Web requests and **28** App requests for the whole journey, **3** model requests for three
submitted turns, Web script **3 235 408 B**, App script **3 238 066 B**, peak RSS backend **112 MB**, gateway **115 MB**,
ingress **200 MB**, revocation observed refused **701 ms** after the revoke call (`HEPI_REVOCATION_CHECK_MS=400`). These
are this host's numbers for these journeys; nothing here is a production benchmark and no optimisation is claimed from
them. The rerun below (after merging the static-surface and packaging slices) is the recorded one.

What neither driver covers, stated rather than implied:

- **Android has no evidence.** This host has no Android SDK, no `adb`, no `sdkmanager` and no device, so no mobile
  artifact exists to test. Nothing above is a statement about a mobile App.
- **The page has one server, and the driver refuses to run otherwise.** It used to fall back to a same-origin host of
  its own that forwarded `/api` to the ingress, and reported which one ran. That fallback is removed: a page served by a
  stand-in is not evidence about the entry a cutover switches, and it would let a misconfigured
  `HEPI_INGRESS_STATIC_DIR` pass for the real thing. The stack asks the ingress for `/` and fails if the answer is not
  the shell. `startStaticHost` still exists for the App bundle's own origin, which legitimately is not the ingress's.
- **What a native "UI assertion" is, and what a screenshot is not.** The surface claims come from `HEPI_APP_READY`,
  printed by the App bundle inside the WebView from the same branch that rendered it; the window's existence is asked of
  the X server with `xdotool`; and the capture is kept as **pixel evidence only**, checked for not being one flat
  surface. Nothing reads text out of the pixels, and no check depends on which frame the capture caught.
- **No deployment was touched, and neither was the developer's credential store.** Every port, SQLite file, workspace and
  process belongs to the run and is removed with it unless `--keep` is passed. Nothing here starts, stops or writes to a
  running service. Every `--configure` / `--forget`
  a driver or the packaged-artifact test performs goes through `scripts/lib/credential-sandbox.mjs`, so the
  `dev.hepi.app/connection` entry they write and delete lives in a keyring the run created under its own `HOME` on its own
  bus — and each run states the digest of the real login keyring before and after to prove it.

### Two defects this acceptance found and fixed

Both were found by driving the production hosts, not by reading them, and both made the new page unusable in ordinary
use. A third pair was found in this ticket's own harness and in the readiness contract it tests; they are recorded under
the 2026-10-19 rerun above rather than here, because neither is a defect in what a person deploys:

1. **A gated deployment showed a bare `unauthorized` word.** The workbench still wrapped the tree in the retired
   `DurableLogin`, whose form posted to the Next-only `/api/durable-login` — a route the new ingress does not serve — and
   the workbench treated a refused descriptor read as a dead end instead of the deployment asking for its login. The rule
   now lives in `packages/ui/src/lib/web-session-gate.ts`: a refused cookie read on a deployment that gates its page is
   the page's own sign-in form (`POST /api/web-login`, same-origin), a refused device bearer is a credential the shell
   must reissue (no page can mint one), a gated deployment with no login material is a configuration to report, and any
   other failure is reported as itself. `DurableLogin` was itself a Next-application file and is gone with it (ticket 17
   retired the whole application; this record keeps the defect's installed state as it was measured).
2. **The page rendered and every send answered "the connection this request belonged to is closed".** The client was
   memoized from render and disposed by the effect's cleanup, so StrictMode's simulated unmount — and any replayed
   effect — handed the replay an already-disposed client; the configuration object's identity also changed on every
   render, which tore the connection down per keystroke. The client is now created and disposed by one effect pair, and
   its lifetime depends on `connectionKeyOf` (host kind, ingress origin, profile, credential) rather than on the object
   the host happened to render. `connection-lifetime.test.mjs` states the key; `workbench-scope.test.mjs` already states
   the same effect-owns-the-lifecycle rule for a selected execution target.

### The journeys now run against the published release itself (2026-10-19 — `bdc8746`)

Every run above drove **this checkout's** bundles: the ingress from `packages/client` source, the page from
`apps/web/dist`, the execution gateway from the source entry. A cutover switches something else — the immutable directory
`scripts/build-client-runtime.mjs` publishes. `startAcceptanceStack` now takes `releaseDir` and takes **no fallback**: an
incomplete directory (`provenance.json`, bundle, `web/index.html`, gateway tarball or recorded image tag missing) refuses to
start rather than quietly serving the checkout, because that run would prove the sources and be logged as the artifact
(`apps/web/e2e/acceptance-release.test.mjs`, 4 tests). With it: the ingress process is the release's `ingress.mjs`, static
assets come from its `web/`, the execution host is the release's tarball installed with `npm install` into the run's own
temporary directory and launched by its real path, and the Backend is a container from the release's recorded image tag —
`--network host`, this user's uid/gid, a state directory the run owns, a mode-0600 env file. Restart durability restarts
**that container** (`stopBackend` removes it and waits for the `docker run` client to exit before the replacement binds —
`once(child,"exit")` on an already-exited child never resolves, which hung the first release run). `pidOf` reads the
Backend's RSS from `docker inspect`, because the `docker run` process is the CLI client: measuring it would have reported a
few MB for a 200 MB server.

Three identity assertions were added to the client driver, since "it passed" is not "it passed on this artifact": the
running ingress's own `argv` names the release bundle; the running gateway's real path is inside the tarball as installed by
that run; and the served `index.html` equals the release's `web/index.html` **byte for byte**. The drivers also name the one
component a client-runtime release does not carry — the App bundle, taken from this checkout — so the log states the
substitution instead of hiding it.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| release contract, 4 tests | `node --test apps/web/e2e/acceptance-release.test.mjs` | `7d68696` | 0 | `.dev/verify/c16-closeout/acceptance-release-test.log` |
| immutable release | `node scripts/build-client-runtime.mjs --json=…` | **`bdc8746`** (clean) | 0 | `.dev/verify/c16-closeout/release-build-bdc8746.log` — `hepi-backend:bdc8746-workstation` `sha256:c566ca91…` amd64 |
| integrity | `sha256sum -c SHA256SUMS` | same | 0 | `.dev/verify/c16-closeout/sha256sums-bdc8746.log` — 177 OK |
| client journey on the release | `node apps/web/e2e/ux-client-acceptance.mjs --release=.dev/releases/release-bdc8746` | same | 0 | `.dev/verify/c16-closeout/client-release-bdc8746.log` — **55 checks, 0 failures**; first visible **201 ms**, **72** Web / **28** App requests, **3** model requests, peak RSS backend **208 MB** / gateway **81 MB** / ingress **87 MB**, revocation refused after **578 ms** |
| native journey on the release | `node apps/web/e2e/ux-native-acceptance.mjs --release=.dev/releases/release-bdc8746` | same | 0 | `.dev/verify/c16-closeout/native-release-bdc8746.log` — **26 checks, 0 failures**; debug shell configured against the release's ingress, private bus `/tmp/hepi-t16-native-cred-PYGVdC/bus`, inherited `/run/user/1000/bus` used by no shell process, keyring `0ced02df2ba9…` unchanged |
| same pair at the merged tip | both drivers with `--release=.dev/releases/release-9aa4326` | **`9aa4326`** (`75f72f5` + `integration/client-app` `68ce3ca`) | 0 | **55/55** and **26/26** (`.dev/verify/c16-closeout/client-release-9aa4326.log`, `native-release-9aa4326.log`); plus `ux-pwa-offline.mjs` **24/24**. `verify-artifacts.mjs` at that tip is **39/39** — the four dpkg-transaction assertions are added at `bdc8746`, so that count is revision, not regression |

**The release path is generated, never executed.** `node scripts/ingress-unit.mjs --release-dir=.dev/releases/release-bdc8746`
emits a unit whose `ExecStart` and `WorkingDirectory` both point inside the release
(`.dev/verify/c16-closeout/hepi-ingress-bdc8746.service`); it was written to a file and read, not installed — no daemon
reload, no service restart, nothing pushed. It needs an **absolute** `--release-dir`: a relative one would bake this cwd into
a unit systemd starts from `/`.

**Reviewer58 P2, fixed at `1c74cb9`+this revision.** `the-host's-own-dpkg-database-was-not-written` equated *the host
does not name the package* with *the transaction did not touch the host*, so on a workstation that already has `hepi`
installed — the ordinary case for a real deployment — the check would have failed an untouched, healthy host, and a passing
run there would have meant only that the verifier's own assumption was wrong. The assertion is now the weaker thing that is
true on both hosts: `runOfflineInstall` reads the host's record of the package (`Status`/`Version`/`Architecture`, or an
explicit `unreadable`) before and after the transaction, and `the-host's-own-dpkg-record-of-this-package-is-unchanged`
compares the two. A fifth assertion, `the-dpkg-transaction-log-survives-the-private-root`, copies dpkg's own
transaction log into the report directory and then matches `status installed hepi:` **in the retained file**, because the
private root it lived in is deleted moments later — asserting a file inside a tree this run is about to remove would be a
claim no later reader could check. The retained path is reported under `offlineDpkgInstall.log`. The other install and
private-root assertions are unchanged.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| verifier and its host-record seam | `node --test apps/app/test/offline-install.test.mjs` | this commit | 0 | `.dev/verify/c16-closeout/offline-install-test-p2.log` — **6 pass**: a host that already has the package yields a comparable record (and an unreadable database states `unreadable`, never "absent"); **a transaction over an already-installed fixture package** reaches `install ok installed`, passes `dpkg -V`, runs its payload and leaves the host record identical |
| app suite | `pnpm --filter @hepi/app test` | this commit | 0 | `.dev/verify/c16-closeout/app-test-p2.log` — **18 pass** |
| the real artifact, on the commit that produced it | `verify-artifacts.mjs --artifact-dir=.dev/artifacts/c16-closeout-bdc8746`, run from a detached `bdc8746` worktree carrying only the verifier change, so `provenance-names-the-built-revision` compares against the revision the artifact was built from | artifact `bdc8746`, HEAD `bdc8746` | 0 | `.dev/verify/c16-closeout/verify-artifacts-bdc8746-hostrecord.log` + `artifacts-bdc8746-hostrecord/run/report.json` — **44 assertions, 0 failures**: `hostPackageBefore`/`hostPackageAfter` both `not in the host's database` (this build host genuinely has no `hepi` installed, and the same comparison passes a host that does), `dpkgState` `Status: install ok installed`, `installExit` 0, `verifyExit` 0, `rootRemoved` true, and `the-dpkg-transaction-log-survives-the-private-root` matches `status installed hepi:amd64` **in the retained file** `artifacts-bdc8746-hostrecord/run/dpkg-transaction.log` (4 lines, last `status installed hepi:amd64 0.1.0`); developer keyring `0ced02df2ba9…` unchanged |
| the same artifact under the pre-fix verifier | the 43-assertion run recorded above | `bdc8746` | 0 | kept for the shape it had: the host claim was `grep -c` plus "still does not name the package", and its transaction log left with the private root, `offlineDpkgInstall.log` stating only `the transaction wrote no log file` |

The verifier binds the artifact's revision to `git rev-parse HEAD`, so a pre-existing artifact is re-verified from a worktree
**at its own commit** with only the verifier files copied in — no rebuild of any release or App artifact, none of which this
change touches (`git diff` over `apps`, `packages`, `scripts` at the fix is the verifier, its test and `offline-install.mjs`). The
first attempt, from `1c74cb9`, is retained rather than deleted: `.dev/verify/c16-closeout/verify-artifacts-bdc8746-p2.log`
reports **42 assertions, 1 failure**, and the one failure is `provenance-names-the-built-revision`
(`bdc8746810e2… (HEAD 1c74cb92e805…)`) — that binding working exactly as designed, and the reason the repeat above exists.

**What this still does not evidence.** Not the **deployed origin**: the live entrance is `release-1873d24`, which predates the
Web login gate (`41fabf3`) and the readiness fix (`2c6f801`), so a cold browser there gets `body: "unauthorized"` with
`/api/descriptor` 401 and no way to sign in — read-only observation at desktop 1440×900 and mobile 390×844, zero page errors, no
credentials used (`.dev/verify/c16-closeout/live-entrance-observation.json`). Its `index.html` is the same 1 860 B as the
release's but references `assets/index-oh_ZJ82Q.js` against the release's `assets/index-CI2q_or9.js`: different builds, so the
deployed origin is not a stand-in for this artifact and the reverse is equally untrue. **Android** stays blocked with no evidence:
`~/Android/Sdk` exists but holds no `platforms` and no `build-tools`, and there is no `adb`, no device and no emulator. Debug
profile only, so no release performance numbers.

## Web logout contract (ticket 18)

The Web page's logout is one route on one credential, and the journey that matters is the ordinary one: a signed-in
cookie session clicks Settings › General › Log out, lands back on a usable entrance, and signs in again. Driven at
`d356152` plus this ticket's changes (`fix/client-app-18-logout`), with the production Vite build served by a real
client ingress, a real Backend over its own SQLite files and Chromium holding the cookie — all on ports and state the
run created and removed, so no deployment or developer session was touched.

```bash
pnpm --filter @hepi/web build
node apps/web/e2e/ux-web-logout.mjs        # the cookie journey, 17 checks
node apps/web/e2e/ux-panel-ingress.mjs     # the production panel under a device bearer
node --test packages/ui/src/lib/web-logout.test.mjs
cd packages/gateway && node --test test/ingress.test.ts
```

| Command | Exit | Result |
| --- | --- | --- |
| `node apps/web/e2e/ux-web-logout.mjs` | 0 | **17 checks, 0 failures** — sign-in form for a browser with no session; the form's login admits the workbench; Settings › General offers the logout; a `503` logout says `Could not log out. Try again. (HTTP 503)`, reloads nothing, shows no sign-in form and leaves the session admitted (`GET /api/conversations` → `200`); the real logout asks `DELETE /api/web-logout` exactly once, returns the page to the sign-in form, leaves a business read at `401` and removes `hepi-web-session` from the browser jar; the same browser signs in again and is offered the logout again; no page error |
| `node apps/web/e2e/ux-panel-ingress.mjs` | 0 | **67 checks, 0 failures** — under a device bearer the production panel asks no `/api/web-auth`, renders no `Log out` control and every one of its 35 requests still resolves against the configured ingress origin with the connection's own bearer |
| `node --test packages/ui/src/lib/web-logout.test.mjs` | 0 | **4 pass** — the credential matrix (`cookie` offers the logout, `bearer` does not), the route (`WEB_LOGOUT_PATH` = `/api/web-logout`, as `DELETE`, on the connection's transport), and the answer (`200` ends the session; `401`/`403`/`404`/`500`/`503` and a transport that never answered are all failures that leave it standing) |
| `cd packages/gateway && node --test test/ingress.test.ts` | 0 | **13 pass** — including the new case that a device caller's `DELETE /api/web-logout` clears the browser cookie and leaves that device's credential and its record untouched; and the extended login/logout case, where `DELETE /api/web-auth` (the obsolete pairing) sets no cookie, answers nothing `200` and leaves the session admitted, and a cross-origin logout is `403` |
| `pnpm verify:changed --base=d356152` | 1 | `changed-typecheck` 0, `changed-test` 0 (protocol 67, session 57, ui 277, gateway 44, server 21, app 18), `web-unit` 0 (14 tests); `check-docs` 1 — **12 broken links, all pre-existing** in `.scratch/` records, and none added by this change |
| `node scripts/check-entrypoints.mjs` | 0 | 91 entry files present; 0 known-missing; 0 newly missing |

Logs: `.dev/verify/2026-10-19T17-33-17-519-verify-changed/` (the verify run, with `verify.json`) and the driver output
quoted above. The `check-docs` baseline was measured by stashing this ticket's changes on the same base — the same 12
links — so the count is the recorded one, not something this change introduced; the section heading above is what
`docs/client-ingress.md`'s new link resolves to.

Not claimed: a native App run. The bearer half is stated at the seams above (the production panel under a device
bearer, and the ingress route asked as a device); an App's own disconnection is its shell's stored material and belongs
to [ticket 19](../.scratch/client-app/issues/19-app-connection-recovery.md).

## Web test scope

Latest measured result (architecture consolidation ticket 09's R9/R10 fixes merged with R11's creation-adapter fix, on ticket 08's R8 cache-adoption fix, 2026-10-15): **57 files,118 tests,118 pass,0 fail,0 skipped**, exit0 from the unchanged recursive runner at revision `dbeee26` (clean; R11's adapter fix merged in). R9 retired the new-session tool picker, its stored preference (`lib/tool-preset-preference.ts`), the preset machinery in `lib/tool-presets.ts` and six locale strings, because the create request carried no tool selection and the host serves no command to change one — the choice was dropped and the conversation came up on the backend's default tools; the create request no longer builds a `toolNames` field, while model/reasoning selection, the read-only `get_tools` list and native extension selection are untouched. R10 moved the `!` refusal to one shared preflight both send seams pass through (`handleSend` and `sendStreamingPrompt`), so an idle send, a steer and a follow-up are refused before any staging or dispatch, and the composer keeps a refused draft and its attachments instead of clearing them. The added cases are the refusal regressions in `apps/web/hooks/useAgentSession.lifecycle.test.mjs` (idle 0 POST / 0 pending, busy steer and follow-up 0 POST / 0 pending, ordinary turns still 1 POST each), the composer-clearing regression in `apps/web/components/ChatInput.test.mjs`, and R11's adapter case in `apps/web/adapters/durable-api.test.mjs`. Beside the runner: `pnpm -r typecheck` 0, `pnpm -r test` 0 (protocol 47, client 10, session 34, gateway 185, server 286), `check-entrypoints` 0 (60 present / 2 known-missing), `check-docs` 1 (271 files / 12 pre-existing broken links / 0 new). Raw logs: `/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-09/r9r10-final-*`.

**Ticket 10 closes on this scope (2026-10-15).** The consolidation gate ran on frozen source `c13fdd2` with the one
production Web build `Be4b114CesOWD7SHhEc6I` (built from `e20ab94`; the test-only R13 leaf used a `cp -a` copy of that
build rather than a rebuild): **18 browser drivers — 16 exit 0 and 2 known baselines at exit 1, C1 and C2, neither fixed
and neither a new regression**. The counts above (**118 tests / 57 files**) are this scope's; the model and reasoning level
chosen on a **new** composer are applied to the conversation **before its first prompt** — one settings update after the
create and before the state read, an omitted loadout left to the runtime and a refused loadout returned before anything is
read. **Two witnesses cover this seam:** the adapter unit test `apps/web/adapters/durable-api.test.mjs`, and the final
ticket 10 browser run, which **does** cover a fresh composer — `ux-missing-model-recovery` **33 pass / 0 fail** on this
build opens a composer with **no conversation yet**, states the chosen level before anything is sent, creates no
conversation until the first prompt, serves that first request on the chosen model with the deployment's default endpoint
called **zero** times, shows the created conversation natively on that model with `thinkingLevel: "high"`, and refuses a
declined creation without dispatching a prompt, creating a conversation or calling the provider (raw evidence
`.dev/verify/consolidation-10/browser/BATCH-B.md` §1 and `01-ux-missing-model-recovery.log`). Raw logs:
`.dev/verify/consolidation-10/`.

Preceding result (R11 — the new-session model/thinking loadout reaching the conversation the creation adapter
makes, 2026-10-15): **57 files,116 tests,116 pass,0 fail,0 skipped**, exit0 from the unchanged recursive runner on the
fix (the fix's own run was the pre-commit patch on dirty `f90414c`, whose dirty files were exactly the two fix files;
the merged clean revision `ddb9126` was then re-measured at the same 116/116 — logs in
`.dev/verify/consolidation-09/new-session-settings/` and its `merged/`). The added case is the adapter-level
`apps/web/adapters/durable-api.test.mjs` test of the creation path — the explicit loadout applied in one settings
update after the create and before the state read, an omitted loadout left to the runtime, a refused loadout returned
before anything is read, and the existing conversation's `set_model` command unchanged — and it fails on the pre-fix
adapter (`adapter-red.log`, exit1, 3 pass / 1 fail: the answer states the runtime default where the chosen model and
level were expected). **At that earlier checkpoint** no browser suite covered a fresh composer's first prompt, so the
public adapter test was this seam's witness; the later final ticket 10 browser run (`ux-missing-model-recovery`, 33/33,
`.dev/verify/consolidation-10/browser/BATCH-B.md` §1) covers the fresh composer directly.

Preceding result (ticket 09's dead-surface retirement merged with ticket 08's R8
cache-adoption fix, 2026-10-15): **57 files,115 tests,115 pass,0 fail,0 skipped**, exit0 from the unchanged recursive
runner at revision `1ef55cb` (clean; the 09 cleanup merged with the primary's R8 checkpoint). The retirement deleted the seventeen event branches the native wire
never produces (the browser's stream states only connected, frame, submission, resync and oversize) with the retry
banner, the extension dialog queue, custom panel, blocking-request attention notification and the legacy delta
assembler (`lib/streaming-message.ts`'s delta action, `agent-event-wire.ts`'s translation helpers), and rewrote
`lib/streaming-message.test.mjs` around whole live messages; the composer's three unsupported entries are refused
before they are sent, with `lib/composer-limits.test.mjs` covering the shared rule. Ticket 08's R8 fix — the mount
adopts the remembered view as its initial state instead of writing it from an effect after the subscription, and the
cache records the window's own `historyHead` — is in this revision, with its two regressions in
`apps/web/hooks/useAgentSession.lifecycle.test.mjs` (both fail on the pre-fix hook:
`cache-handover/hook-lifecycle-red.log`, exit1, 10 pass / 2 fail). This row is the suite's scope, not the tickets'
status: 08 stays open until its own review closes. Beside the runner: `pnpm -r typecheck` 0, `pnpm -r test` 0
(protocol 47, client 10, session 34, gateway 185, server 286 — an earlier run of this same revision had one
`apps/server` provider-config case fail on an empty stub response body, and the package alone re-ran 286/286 green),
`check-entrypoints` 0 (60 present / 2 known-missing), `check-docs` 1 (271 files / 12 pre-existing broken links / 0 new).
Raw logs:
`/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-09/` and `.../consolidation-08/`.

Preceding result (architecture consolidation ticket 09's dead-branch and extension-UI retirement, 2026-10-15):
**57 files,113 tests,113 pass,0 fail,0 skipped**, exit0 from the unchanged recursive runner at revision `977b29b`
(clean; the 09 changes on top of `82c481f`).

Preceding result (architecture consolidation ticket 08's cache-adoption fix, 2026-10-15): **57 files,115
tests,115 pass,0 fail,0 skipped**, exit0 from the unchanged recursive runner on the fix (a dirty working tree on
`82c481f`; the two added cases are the changed-head and same-head cache-adoption regressions).

Preceding result (architecture consolidation ticket 08's cache-adoption fix, merged, 2026-10-15): **57 files,115
tests,115 pass,0 fail,0 skipped**, exit0 from the unchanged recursive runner at revision `ece3723` (clean; the R8
fix on top of the 09 core — log `.dev/verify/consolidation-08/cache-handover/merged-web-unit/`). This row is the
suite's scope, not the ticket's status: 08 stays in-progress until reviewer 73's focused re-check of R8, whose fix
is `ee2ee20`. The added file is
`apps/web/lib/handover-continuity.test.mjs`, which covers the reader handover in both directions over the real shared
connection, reducer, projection and acceptance fold; the package's own join and fail-closed cases are in
`packages/session/test/`. The fix is recorded under [R7](../.scratch/architecture-consolidation/review-notes.md)
and verified in the real browser by scene 7 of `apps/web/e2e/chat-lifecycle-background.mjs` (69 checks) beside
`chat-lifecycle-foreground` (28) and `stream-heartbeat-idle` (23); logs in
`/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-08/handover/`.

Preceding result (architecture consolidation ticket 09 legacy-contract cleanup, merged with ticket 08's native
SSE cutover, 2026-10-15): **56 files,110 tests,110 pass,0 fail,0 skipped**, exit0 from the unchanged recursive runner at
revision `3dc172e` (clean; ticket 09's cleanup on top of ticket 08's `44ecc99`, with the integration tip merged).
This row is the suite's scope, not the ticket's status: 09 is reopened (spec §Implementation Decisions 14 and User
Story 20 — the remaining producerless branches and the 501-as-product-behaviour entries are outstanding), and finishing
them will move this count again. The cleanup retired the old Web event-stream helpers and
their frame translator, the projection's synthetic `tree`/`filePath`/`totalActiveMs` fields with the branch navigator
and the session-file/active-time rows, and the six built-in slash commands the durable runtime answers 501 to;
`lib/pi-types.ts` was trimmed to the two types anything imports. Beside the runner: `pnpm -r typecheck` 0,
`pnpm -r test` 0 (protocol 47, client 10, session 31, gateway 185, server 286), `check-entrypoints` 0 (60 present /
2 known-missing), `check-docs` 1 (271 files / 12 pre-existing broken links / 0 new). Raw logs and per-item
dispositions: `/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-09/`.

Preceding result (architecture consolidation ticket 08 native SSE cutover, 2026-10-15): **58 files,114 tests,
114 pass,0 fail,0 skipped**, exit0 from the unchanged recursive runner at revision `44ecc99` (clean; log
`.dev/verify/consolidation-08/web-unit/`). This row is the suite's scope, not the ticket's status: 08 stays open for the
P1 shared-source handover-continuity defect (review notes R7), which this suite does not cover. The cutover
moved the Web host's conversation stream to an authenticated byte forward and the fold into the browser, so the stream
cases now read the backend's own frame names and the browser's own `reduceSseFrame` + projection path: the adapter's
stream test asserts the forwarded bytes and the caller's cursor, `durable-lifecycle` folds the native frames into the
surface payload, and `durable-projection` gained the live-fields cases. Raw evidence and the browser drivers'
logs: `/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-08/`.

Preceding result (architecture consolidation ticket 09 independent retirement slice merged with the
ticket 07 page-race fix, 2026-10-15): **58 files,111 tests,111 pass,0 fail,0 skipped**, exit0 from the unchanged
recursive runner at revision `eec988c` (clean). The slice retired five dormant, test-only Web helpers with their local
tests (`lib/request-security`, `lib/auth-throttle`, `lib/login-destination`, `lib/key-serializer`,
`lib/session-file-references-core`); each had no live consumer, and the live behaviour it used to guard is covered at
the route/adapter seam by `lib/web-auth-lifecycle.test.mjs` and the workbench adapter tests. Measured on the slice
alone (base `13d5a63` dirty) the same suite was 58 files/110 tests; the merge added ticket 07's history-page
acquisition case. Per-item evidence: `.dev/verify/consolidation-09/dispositions.md`; raw logs
`/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-09/after/` and `postmerge/`.

Preceding result (architecture consolidation ticket 07 merged with 01–06 and the draft-owner slice,
2026-10-15): **63 files,117 tests,117 pass,0 fail,0 skipped**, exit0 from the unchanged recursive runner at revision
`3f56be6` (clean). The browser projection gained its own seam test
(`apps/web/lib/durable-projection.test.mjs`, 4 tests), the adapter's conversation-read tests were rewritten around the
native payloads the Web host now forwards, and `draft-store`/image-submit fixtures from the sibling slices are in the
same run. Raw evidence: `/home/developer/Documents/dev/hepi-harness/.dev/verify/consolidation-07/final/` — the
**primary** checkout's directory, since a worktree's own `.dev/verify` is a different one.

Preceding result (architecture consolidation ticket 06,2026-10-15): **63 files,109 tests,109 pass,0 fail,0
skipped**, exit0 from the unchanged recursive `pnpm test:web:unit` runner at revision
`20f7733` (dirty). The shared connection's own contract moved out of Web with the implementation —
`apps/web/lib/agent-event-connection.test.mjs` became `packages/session/test/agent-event-connection.test.ts` plus
`packages/session/test/browser-transport.test.ts`, which the `@hepi/session` suite runs. Raw evidence:
`.dev/verify/consolidation-06/verify-full-merged.json`.

Preceding result (further reduction,2026-10-15): **64 files,111 tests,111 pass,0 fail,0 skipped**, exit0 from
the unchanged recursive `pnpm test:web:unit` runner. This pass reduced physical test code from7097 to4445 lines
(37.4%) and tests from142 to111. Retained contracts and deliberate cuts: [accepted further reduction](../.scratch/web-test-lean3/results.md).
Raw evidence: `.dev/verify/web-test-lean3/accepted/web-unit.json` and `web-unit.tap`, dirty1758c1f source.

Preceding high-value pass:69files142pass,33303→7097lines; [historical result](../.scratch/web-test-value/results.md).

Previous measured result (first pass,2026-10-15): **239 files,461 reported tests,461 pass,0 fail,0 skipped**, exit0 from the
unchanged `pnpm test:web:unit` entrypoint. The preceding recorded run had2381 tests with16 failures; obsolete
launcher/runtime/proxy checks were retired, current unsupported-route contracts retained. Per-file dispositions,
review corrections and source hashes: [accepted consolidation](../.scratch/web-test-consolidation/results.md).
Raw evidence: `.dev/verify/web-test-consolidation/accepted/web-unit.json` and `web-unit.tap`, dirty1758c1f source.

Keep the recursively discovered Web suite below 200 reported Node tests. Favor tests for plausible, costly user failures
over exhaustive formatting, source-shape or SDK implementation inventories. Reduce test code as well as registrations;
merging unrelated domains into a large wrapper does not meet this goal. The [latest reduction](../.scratch/web-test-lean3/results.md)
records the current scope and deliberate coverage cuts. Count the actual TAP summary, including
nested tests. Related variations of one contract belong in a labelled assertion matrix with independent fixtures;
registering each input as another subtest does not reduce the suite. Preserve useful failure diagnostics and async
cleanup. Remove obsolete runtime/launcher tests and source-shape snapshots when current behavior has a stronger
owner or public-seam check. The functional inventory and each deletion/merge destination are recorded in
[Web test consolidation](../.scratch/web-test-consolidation/README.md); the original sixteen failures are diagnosed
[separately](../.scratch/web-test-consolidation/known-failures.md).

The recursive discovery and verification entrypoints remain the same. A matrix budget is not a coverage claim;
behavioral contracts and browser seams determine what to retain. Historical measurements below describe their tested
source, including failures from tests subsequently retired by this explicit cleanup.

## Architecture consolidation ticket 10 browser gate

The final gate runs every browser row once against **one frozen source and one frozen build**. Frozen source
`c13fdd262ee617fd90abe7dced2ac4111dfa191d`; the build under test is the ticket 10 worktree's own `apps/web/.next`,
`BUILD_ID Be4b114CesOWD7SHhEc6I`, built from `e20ab94` (same product code). No source edit, no rebuild and no full
rerun happen inside the worktree; the full profile's **118 Web tests** and the CLI/diagnostic closure comparisons
(`unchanged: true`) still stand for this source.

| Batch | Drivers (exit) |
| --- | --- |
| A | `chat-lifecycle-foreground` 28/0, `chat-lifecycle-background` 69/0, `ux-submission-recovery` 81/0 (scene 6 stable), `submit-stall` 55/0, `stream-heartbeat-idle` 23/0, `ux-nav-new-session` 15/0 |
| B | `ux-missing-model-recovery` 33/0, `ux-models-config-save` 16/0, `ux-image-submit` 18 pass / 3 fail |
| C | `ux-mcp-surface` 26/0, `ux-extensions-selection` 17/0, `ux-truthfulness` 29/0, `ux-capability-trust` 15/0; `ux-terminal-budget` 13 ok / 2 fail in the batch, then **15/15 exit 0** on the test-only observation fix (reused run) |
| Parent runner | `ux-history-prefix` 11/0, `ux-windowed-transcript` 48/0, `ux-deferred-text` 14/0; `ux-worktree-picker` 20 pass then `TimeoutError` |

**18 drivers in total**, including the budget driver. The per-driver provenance table — revision, `BUILD_ID`, exit, check counts and log path for each of the 18 — is in the ticket ledger at
[`.scratch/architecture-consolidation/issues/10-integrate-verify-consolidation.md`](../.scratch/architecture-consolidation/issues/10-integrate-verify-consolidation.md).
Raw logs, per-run metadata and the batch reports are in `.dev/verify/consolidation-10/browser/` (`BATCH-B.md`,
`BATCH-C.md`, `batch-a-metadata.json`, `batch-c-metadata.json`, `parent-remaining-batch.json`), each with the run's own
`sha`, dirty list and `BUILD_ID`. The tree is **not** recorded as clean: agent 75's foreground/background drivers write
tracked generated evidence under `.scratch/chat-lifecycle/{foreground,background}/`, which is archived to
`browser/{foreground,background}-artifacts` and restored afterwards — output-only dirt, no product source, config or
runtime path.

**Two known baselines are retained, not fixed, and neither is a new regression:**

- **C1 — image projection.** `ux-image-submit` passes 18 checks and fails the same three **names** in the same order as
  the pinned `fb99018` baseline, with a driver sha256 identical to that baseline's
  (`fc32e07fcaa5084df6ad0f2078436c7dc2d4e28f0b9a61b227d9d2336450284b`). Name lists:
  `browser/checks-03-now.names.txt`, `checks-03-baseline-fb99018.names.txt`, `fail-names-03-*.txt`.
- **C2 — worktree picker.** `ux-worktree-picker` passes 20 checks and then times out exactly as the clean pinned
  `caf6a31` baseline does: `browser/worktree-baseline-comparison.json` records the current run against the existing raw
  baseline log (`.dev/verify/consolidation-01/baseline-caf6a31-worktree-picker.log`, its own deps and build, already
  verified) with an identical normalized check sequence including the FAIL line — only the `/tmp` fixture prefix
  normalized — and an identical driver blob on both sides (`7cc7c9fc9acb5c1ee88bf5210d4fc17a5c32503f`). This is a
  retained known baseline, not a fix and not a broader root-cause identity claim; no baseline rerun is justified while
  the baseline is unchanged.

**The budget row is green:** the test-only observation fix (`2046c40`, `apps/web/e2e/ux-terminal-budget.mjs` only,
+57/-41) reads sources off the page's own network — a request that answered `text/event-stream` with a 200 is one live
source — so the terminal's `EventSource` and the conversation's `fetch` reader count the same way; the run reused the
passed **15/15** (isolated fix worktree, the frozen `Be4b114…` build copied rather than rebuilt, `c13fdd2` source, ports
45790/45791) instead of a second budget run, and the original 13 ok / 2 fail is kept at `ux-terminal-budget.log`. **R13** is fixed: the spec axis is **accepted with 0 material findings** (73,
`.dev/verify/consolidation-review-09/r13-spec-followup.md`) and the standards axis is **0 material findings** as well
(72, `.dev/verify/consolidation-review-09/r13-standards-followup.md`). The tested artefact is
the **pre-commit patch on `c13fdd2`**, not a clean `2046c40` checkout — the driver in the worktree when it ran
(`35079b81…` / `00e1d543…33fc72`) is byte-for-byte the published commit's file; the before dirty state is **count 2
only, paths unknown**, and no tracked product file was dirty. `browser/ux-terminal-budget-observer.meta.txt` is the
metadata companion.

All **18 drivers** now have a result on this source: **16 exit 0** (batch A 6 + batch B 2 + batch C 5, the budget
driver among them, + parent runner 3) and **2 known baselines at exit 1 — C1 and C2** (neither fixed, neither a new
regression). The batch-C budget failure is the same driver's earlier attempt on the stale observer, not a nineteenth
driver: the driver ran twice and the green run is the one recorded. Ticket 10 closes on this evidence (its status lives in
the ticket ledger), and the rows are still **not all green** and **neither baseline is fixed**.

## Design-fix follow-up checks (2026-10-14)

Measured against `1758c1f` plus the uncommitted audit and design-fix changes. `pnpm verify:changed` passed workspace
typechecks and tests, scripts (51/51), entrypoints and docs; overall exit 1 comes from Web unit tests (2307 pass,
16 retained upstream failures, 2323 total). Exact failure-name comparison against the preceding snapshot-fix run
shows no additions or removals. Evidence: `.dev/verify/2026-10-14T12-46-03-163-verify-changed/verify.json` and
`.dev/verify/design-fixes/web-failure-set-comparison.json`. These are working-tree runs, not two detached revisions.

An isolated production Next.js webpack build passed. Browser checks passed for deferred text (17), loaded-history
prefix and reconnect (11), and Settings/model persistence/logout (23). The deferred-text driver runs production
MessageView against the production Web read proxy and a real backend; its controlled model context is widened so
compaction does not replace the large input. It verifies full prompt copy/edit recovery and explicit failure retry.
Run `node apps/web/e2e/ux-deferred-text.mjs` after a Web build; no paid provider is used. A newly added backend fixture
subsequently passed server typecheck. See [design-fix results](../.scratch/design-fixes/results.md) for classification,
review scope and remaining payload limits. No runtime deployment or restart accompanied these checks.

## Audit follow-up checks (2026-10-14)

Measured against `1758c1fb4479e9d4637a957857246c5998619d73` plus the uncommitted audit follow-up changes;
these working-tree results do not describe the committed SHA alone.

- `pnpm verify:changed --quiet` exited 1: changed-package typechecks, client tests, tooling fixtures, entrypoint
  check and documentation check passed; Web tests retained unsupported-upstream failures. Evidence:
  `.dev/verify/2026-10-14T08-05-30-379-verify-changed/verify.json`. The later model-visibility correction was
  independently typechecked and browser-checked; unchanged client/tooling results are reused.
- Final `pnpm test:web:unit --quiet` exited 1: **273 files, 2297 tests, 2281 pass, 16 fail**, recorded in
  `.dev/verify/2026-10-14T08-23-27-576-web-unit/web-unit.json`. The 16 names are retained upstream runtime/launcher
  tests or unserved provider routes, classified in [the Web findings](../.scratch/development-audit/fixes-web-tests.md).
  No test was deleted or skipped to claim green. The recorded pre-change run had 23 failures; this is a comparison
  of recorded working-tree runs, not `compare:tests` against two detached revisions.
- Client typecheck/tests and installed-tarball smoke passed, including real local and localhost-SSH Worktree
  create/remove. See [client evidence](../.scratch/development-audit/fixes-worktree.md).
- Production Next build in an isolated local worktree exited 0; the real-browser Settings regression passed
  **23 checks**, including models.json persistence over backend restart, unavailable model-visibility controls,
  cookie clearing, protected API rejection and re-login. Logs:
  `.dev/verify/audit-followup/browser-build-final.log`, `browser-smoke-final.log`.
- The deployment probe exited 0 after the missing-health fix; dedicated runtime-host authenticated
  `GET /api/models` returned 200 and its unauthenticated control returned 401. Runtime backend `56ff08f` and
  Web `df24b7c` were healthy with restart count zero. This was read-only inspection, not deployment of the edits.
  See [probe evidence](../.scratch/development-audit/fixes-deploy-probe.md).

The original audit and the implementation/research record are in
[the audit follow-up](../.scratch/development-audit/follow-up.md). Historical measurements below retain their original
scope and revisions; neither the old 23-failure count nor a previous deployment record is a current-state guarantee.

## Checks that ship as commands

The everyday development loop is edit, run `pnpm verify:changed`, inspect the diff and deliver. Start `pnpm dev`
only when interactive checking is needed; it already owns hot reload and isolated development state.

These wrap the commands below. `verify` and `test:web:unit` run their steps through the shared runner, so a result
arrives with the evidence the practice requires — the command, the SHA and dirty state, the exit code, and a raw log
per step — under the git-ignored `.dev/verify/<timestamp>-<label>/`. `check:docs` and `check:entrypoints` are plain
read-only checks: they print their finding and exit non-zero, and write a JSON report only with `--json=<path>`.

```bash
pnpm check:docs           # every relative Markdown link resolves, its heading exists, the index covers the guides
pnpm check:entrypoints    # every file argument a package script names exists
pnpm test:web:unit        # the Web *.test.mjs suite, run directly, TAP kept
pnpm verify:changed      # select checks from staged, unstaged and untracked changes against HEAD
pnpm verify:changed --base=main   # also include branch commits since merge-base with main
pnpm verify:changed --dry-run     # preview selected files/packages/commands; writes nothing
pnpm verify:changed --test-file=apps/server/test/acceptance-chain.test.ts  # run only these tests
pnpm verify:changed --test-file=scripts/verify-changed.test.mjs  # a tooling test runs from scripts/
pnpm verify --profile=fast   # typecheck + the workspace test run
pnpm verify --profile=full   # fast, plus the Web unit suite
pnpm compare:tests --base=<SHA>   # compare:'s failure set against a detached baseline
pnpm test:scripts         # the checks' own fixture tests
pnpm deploy:inspect       # what is deployed, read-only; --probe adds one fixed SSH read
pnpm deploy:plan          # the full deployment-runbook reference, offline
```

`verify:changed` is an alias for `verify --profile=changed`. It retains the same per-step logs and JSON evidence as
the existing runner, plus selection details (base, changed paths, affected packages, ignored paths and fallback paths).
No extra report-writing step is needed. Default selection compares the current working tree against HEAD, including
staged changes, deletions and untracked files. On a clean committed branch, pass `--base=<branch-or-SHA>`; otherwise
there are no local edits to check. A bad base or failed Git read exits 2 before any check starts.

| Changed scope | Selected checks |
| --- | --- |
| Markdown, including AGENTS.md | Documentation links and index |
| apps/* or packages/* source/config | Package typecheck/test scripts and transitive workspace dependents |
| Web selected directly or as a dependent | Web typecheck and the explicitly enumerated Web unit suite |
| scripts/* | Tooling fixture tests, entrypoint check, documentation check |
| Root config, lockfile, deployment config or unrecognized executable scope | Full workspace/Web gates plus tooling, entrypoint and docs checks |
| Scratch records, generated graph, upstream skill store | Listed as ignored; no executable check |

Selection reads package manifests in the current `apps/*` and `packages/*` workspace layout, including dependency,
dev, peer and optional relationships. A workspace-layout change takes the conservative full fallback. It selects
at package granularity; it does not infer cross-service contracts or browser behavior from imports. Add a focused
integration or browser check for those changes. Web selection reports the current suite
result; a recorded historical failure set is not an exemption from a non-zero exit. `--dry-run` prints the plan without checks, run directories or JSON writes. A run with no selected
checks explicitly says so and records an empty step list; it is not evidence that a suite passed.

**Typecheck keeps package granularity; tests can be narrowed.** `--test-file=<path>` (repeat it for several files)
replaces the dependent test suites with one `node --test` step per package, in that package's own directory, naming
exactly those files, with that directory's own timeout. `scripts/*.test.mjs` is the one non-package group it accepts:
those run from `scripts/` with the tooling suite's 120 s timeout, and naming one replaces the whole `script-tests`
step while the entrypoint and docs checks still run. The same narrowing happens on its own when every changed
executable file is a `*.test.*` file inside a workspace package — a test edit cannot change another package's
behaviour, so running those suites would add time without adding evidence. Typecheck still runs for the changed package and every transitive dependent, because
types cross the boundary, and the Web unit suite is not re-added when a narrowed run already covers it. A narrowed run
names its own files, so it does not depend on the package declaring a `test` script: `apps/web` declares none (its
suite is enumerated by `webUnitFiles`), and a Web `*.test.mjs` file selected explicitly or by a test-only change runs
in `apps/web` with its 60 s timeout. Without a narrowing, the Web suite is still the separate `web-unit` step.

The report records the decision, not just the outcome: `selection.testSelection` carries `mode`
(`explicit`, `changed-tests` or `full`), the `reason` it chose that mode and the `files` it will run, and the command
prints the same line. Anything the selector cannot place — a deleted test file, an unrecognized root file, changed
non-test source — stays on the conservative full path with the reason naming why. A `--test-file` path must be an
existing `*.test.*` file inside a workspace package or `scripts/`, or the run exits 2 before any check starts.

`verify --profile=fast` runs workspace gates; `full` adds the current recursive Web suite. Each profile reports its
actual exit status, and `full` remains a superset of `fast`. The dated failure baselines below are evidence about
older source, not a requirement for later runs to remain red. None of these profiles calls a paid provider, starts a
browser driver or touches a deployment.

The two deployment commands are read-only and offline respectively: `deploy:inspect` reads the repository and
git-ignored private configuration (and, with `--probe`, runs one fixed read-only SSH command set), while
`deploy:plan` prints the runbook's stages and contacts nothing. Neither builds, deploys or reads a secret, and neither
prints a host name, address, login, absolute root or registry: a report says a role field is `set`, a plan prints
`<registry>/<owner>/<repo>` placeholders. A probe that fails exits 3 with the failing field named, and its raw output —
where a host name or a path would actually appear — is written to a git-ignored `.dev/deploy-inspect/` file instead of
the report. The plan emits **no** `docker compose` command: a stage whose private inputs (the runtime override that
pins the image and keeps the existing state volume) are unset is printed as incomplete with its manual prerequisites,
so following it cannot fall back to a local image tag or create a fresh named volume. See
[the deployment runbook](deployment-runbook.md). There is no apply command.

Every command above answers `-h`/`--help` with the flags it really has and starts nothing — no suite,
no probe, no plan, no report file — and exits 2 on an argument it does not understand (an unknown
flag, a value flag without a value, a value on a switch, a stray argument) instead of running the
workflow anyway. A misspelled flag must not cost a minute of work or a host contact, so the usage
contract is asserted for all seven commands by `scripts/cli-usage.test.mjs`.

`check:docs` checks three things, because a reader can land nowhere in three ways: a link target that does not
exist, a `file.md#fragment` whose heading no heading in that file produces, and a guide under `docs/` that the index
no longer links to at all (the file still resolves, so nothing else would notice). It reads no report measurement and
edits nothing.

`check:entrypoints` reports every file argument of every `node`/`tsx` invocation in every script, so a second missing
test file cannot hide behind a first that exists; it reports the known-missing ones on every run and fails only on a
**newly** missing one, and `--strict` makes the recorded ones fatal too. The two this repository has are the reason
the check exists: see *Scripts that do not run*.

`compare:tests --base=<SHA>` checks **both** revisions out into their own detached worktrees — the base under
`.dev/baselines/<base-sha>`, the tip under `.dev/baselines/<head-sha>` — runs the same suite in each, and compares the
TAP `not ok` names exactly, stripping only each checkout's own path. No side ever runs in your working tree, so an
uncommitted edit cannot be measured as the revision the report names, and nothing stashes or resets: `git stash` is
shared across worktrees, so using it for a baseline would compare the tree against itself. Each side keeps its own log
under `<log-dir>/base/` and `<log-dir>/tip/`. The verdict is the **failure-name set**, never a matching count, and a
side that never ran a suite is an infrastructure failure (exit 3, recorded in `comparison.json` as `comparable: false`)
rather than a pass — a fresh worktree whose test files cannot load would otherwise compare empty against empty and read
as "identical".

The tip side is a **pinned commit**, not your working copy: it is checked out detached at `HEAD`, so the two sides are
two revisions and never the tree against itself. Your own uncommitted work is *reported* rather than folded in —
`comparison.json` carries `caller: {sha, dirty, dirtyFiles}` beside the two sides and the command prints the same
sentence — and the run leaves your tree exactly as it found it, index and stash list included. `--cleanup` removes both
worktrees afterwards and deregisters them from `git worktree list`; the logs and the report live in `<log-dir>`, outside
the worktrees, so the evidence survives it.

`verify`, `test:web:unit`, `check:docs` and `check:entrypoints` all take `--root=<dir>` and run against a checkout
other than the one the script lives in, which is also how their tests drive them.

## Tests for the checks themselves

The checks are tested at their **public seam**: one file per workflow, each driving the shipped CLI as a child process
against a throwaway repository and reading the exit code, the printed line, the log and the JSON it left behind. No test
calls a production helper to compute the value it then compares against, and the fixtures are owned in one place
(`scripts/testing/fixture.mjs`: directories, worktrees, processes with a timeout, cleanup; `scripts/testing/docker-fixture.mjs`:
the external docker CLI). A helper-level unit test that only re-asserted what its own helper does was deleted rather than
kept beside the workflow test that covers the behaviour for real.

| Workflow | File | The real failure it protects against | Remaining limit |
| --- | --- | --- | --- |
| verify and the Web runner | `scripts/verify.test.mjs` | a result that lost its log, its report or the SHA it measured; a hidden dirty tree; a Web suite that silently ran fewer files than it named | the fixture workspace is one package; the real six-project workspace is not re-run here |
| baseline comparison | `scripts/compare-tests.test.mjs` | a false pass (a side that never started, or a changed failure name behind an equal count); a side measured in the caller's tree; a reused dirty baseline; worktrees left registered | `normalizeName`'s absolute-prefix stripping is only reached by a suite invoked with absolute paths, which the shipped Web suite does not do |
| deployment inspect and plan | `scripts/deploy-inspect.test.mjs` | a host name, login, root, registry or secret reaching a report; a failed probe reading as clean; a plan able to start production before its gates; an architecture read from a container | the fixture docker CLI implements the subcommands the probe uses, not docker's whole surface, and no real host is contacted |
| documentation and entry points | `scripts/checks.test.mjs` | a fragment no heading produces; an index that stopped covering a guide; a second or third test file missing behind the first; a known-missing entry hidden or silently fatal | the fixture mirrors this repository's two known-missing entries by shape; the real list is asserted by the real run, not by a test |
| release tag contract | `scripts/release-plan.test.mjs` | a release tag publishing a mismatched version, npm tag or image prefix | the pure contract only; the GitHub workflow around it is not run here |
| development plan | `scripts/dev.test.mjs` | a dev plan starting the wrong processes, or binding the backend somewhere the UI was not told to reach | plan-level only; the processes are not started |

`pnpm test:scripts` runs all of them. Its pass count is not an acceptance criterion: what a change has to show is which
row above it protects and that the row's failure was reproduced before the fix.

## Workspace checks

```bash
pnpm -r typecheck    # the six workspace projects that declare a typecheck script; the root package declares none
pnpm -r test         # the five that declare a test script: protocol, client, session, gateway, server
pnpm --filter @hepi/web build      # Next production build
pnpm --filter @hepi/client build   # client bundle build
```

Two workspace projects declare a build script, `@hepi/web` and `@hepi/client`; `pnpm -r test` runs one script per
package that has one. `pnpm verify --profile=fast` runs the first two of these and keeps their evidence.

**Typecheck is incremental per worktree.** Every workspace `tsconfig` that runs `tsc --noEmit` sets
`"incremental": true`, so the compiler writes `tsconfig.tsbuildinfo` beside the config and the next run reuses it.
`*.tsbuildinfo` is git-ignored, so each worktree keeps its own cache and no cache is ever committed; deleting the file
costs one cold run and nothing else. The checking itself is unchanged — same `strict`, same `noEmit`, same
`include`, no project references and no emit. Measured on 2026-10-18 at `e43783a` (this branch merged with `integration/client-app` `eccdd86`), on the local
workstation: `pnpm -r typecheck` went from **19.5 s cold to 6.7 s warm** (exit 0 both times, 6.8 s on a second
warm run); per package warm, server 1.2 s, gateway 1.4 s, Web 2.8 s (two configs), app 1.4 s, and the four small
packages 0.3–0.5 s each. The cache is **4.35 MB** across the nine configs (app 1.14, Web 0.84 + 0.56, gateway 0.66,
ui 0.50, server 0.46, client 0.14, protocol and session 0.04). A stale cache cannot hide a type error: `tsc` re-checks any file whose content
or options changed, and the timestamps it compares are the ones it wrote itself.

Merged into `integration/client-app` at `f4d328a` (`d351ed6` … `972f051`); the scripts and configs there are the
ones measured, `git diff 972f051 f4d328a -- scripts packages/*/tsconfig.json apps/*/tsconfig*.json` being empty. The
measured run and the focused selector/CLI run are the branch's own evidence and were not repeated. Re-checked on the
merged tree by a dry run, `pnpm verify:changed --base=eccdd86 --dry-run --test-file=scripts/verify-changed.test.mjs --test-file=scripts/cli-usage.test.mjs`
(exit 0): the plan named the eight dependent packages for typecheck, the two explicit files as
`changed-test-scripts: node --test … ./verify-changed.test.mjs ./cli-usage.test.mjs`, and `testSelection.mode`
`explicit`. No full suite, typecheck or benchmark was re-run for this merge. Limits, unchanged by it: automatic
narrowing applies only when every changed executable file inside a workspace package is a test file, so any changed
source — or a deleted test file — takes the full path; and a changed `scripts/` test still runs the whole tooling suite
unless the run names the file with `--test-file`. A Web test-only change does narrow on its own, with no package
`test` script involved (that is what `apps/web` exercises).

Counts
recorded at `78078de` (see the evidence footer — they are not evergreen), with the earlier `edef2c0` values beside
them:

| Project | Tests at `78078de` | at `edef2c0` |
| --- | --- | --- |
| `@hepi/protocol` | 19 | 15 |
| `@hepi/client` | 9 | 9 |
| `@hepi/session` | 3 | 3 |
| `@hepi/gateway` | 80 | 80 |
| `@hepi/server` | 148 | 138 |

Ticket 01 of the capability-integration effort added tests to two of them, so the counts on a tree carrying that
ticket are higher: `@hepi/protocol` gains the shared sidebar-state rule suite and `@hepi/server` the durable document
suite. Re-read the run's own TAP log rather than this table when citing a count for a later revision.

`apps/web` declares **no `test` script**, so `pnpm -r test` never runs a Web test. That is a coverage gap, not a
deliberate exclusion: `pnpm test:web:unit` (or `pnpm verify --profile=full`) runs it directly, and the file list it
enumerates is kept in the run's report beside the TAP log. These are local checks, not a claim of whole-upstream
feature parity. Critical tests use public HTTP/durable/environment seams; avoid sleeps and noncritical UI suites.

## Whole-Web source run, and the 23-failure baseline

Enumerate files explicitly — a glob misses nested suites and the directory form is rejected by some Node builds:

```bash
cd apps/web
find . -name '*.test.mjs' -not -path './node_modules/*' -not -path './.next/*' -not -path './vendor/*' | sort > /tmp/web-files.txt
mapfile -t F < /tmp/web-files.txt
node --test --test-reporter=tap --test-timeout=60000 "${F[@]}" > /tmp/wholeweb.tap 2>&1; echo "exit=$?"
grep -E '^# (tests|pass|fail) ' /tmp/wholeweb.tap
```

At `edef2c0` that is **251 files, 2084 tests, 2061 pass, 23 fail** (`exit=1`, from `/tmp/wholeweb-edef2c0-final.tap`
against the file list `/tmp/web-files-edef.txt`; the tap summary reports 23 and the
`not ok` lines carry 24 unique names — a file's own rollup plus its nested assertion). The 23 are the **historical baseline at this revision**, not a standing count for later source. Its module-load
failures include `SettingsPanel` reading an untracked
`../app/login/page.tsx`; the MCP, node-version, process-lifecycle and web-auth-proxy files load
outside a Next runtime, plus a few leaf assertions (`gfm-autolink-email-loader`, the SDK inline budget, the
provider Base-URL and API-key-route cases) and `components/SessionSidebar.file-search`. No resources, skills,
recall or session-list test failed in that run. It was not a green whole-Web result. Compare exact failure names, not counts —
`pnpm compare:tests --base=<SHA>` does that against a detached baseline worktree, normalizing only each checkout's own
prefix; [`.scratch/ux-follow-up/issues/ux14-wholeweb-compare.mjs`](../.scratch/ux-follow-up/issues/ux14-wholeweb-compare.mjs)
is the scratch comparator the shipped one generalizes.

**Ticket 13 removes one of those 23.** `apps/web/lib/terminal-manager.ts` and its test are gone: that module spawned a
shell in the Web process with `node-pty` and was never routed, and ticket 13's terminal is a session on the execution
host reached through `/api/terminal`. The whole-web run at that change is **2110 tests, 2088 pass, 22 fail**
(`/tmp/web-unit-13.tap`), and the 22 names are the edef2c0 baseline minus `lib/terminal-manager.test.mjs` — no other
failure name is added. The new tests that cover the browser terminal are `components/TerminalPanel.test.mjs`
(rewritten: the writer now carries the tab's routing cwd) and, at the seams beneath it,
`apps/server/test/terminal-browser.test.ts` and `packages/gateway/test/terminal.test.ts`.

**The review fixes add seven passing tests and no failure.** `apps/web/adapters/terminal.test.mjs` (3) covers the
browser's own reconnect cursor surviving both Web layers, `apps/server/test/terminal-relay.test.ts` (3) covers a caller's
disconnect cancelling the host request it opened — mid-stream and during setup — and `packages/gateway/test/terminal.test.ts`
gains the frame-shape case for the event stream's own `id` field (1). Measured against the same tree with the fixes
stashed: gateway 108 → 109, server 214 → 217, whole-web **2118 → 2121 tests, 2096 → 2099 pass, 22 fail**, the same 22
names on both sides and no new one.

**The binding-interval fix adds one more.** `apps/server/test/terminal-relay.test.ts` gains the case where the caller
disconnects while the relay is still resolving the workspace binding — before any host request exists — and holds the
binding open from the test so the disconnect lands inside it. The host's own request record is the assertion: it stays
empty. Measured against this tree with the source change stashed: server **218 tests, 217 pass, 1 fail** (the new case)
against **218 tests, 218 pass, 0 fail** with it. The rest of the suite is unchanged, and both browser suites still pass.

## Recorded upstream startup-status race (2026-10-17)

`apps/server/test/models-config.test.ts` can transiently report an environment provider as unconfigured immediately
after `openEnvModelRuntime` resolves. `ModelRuntime.registerNativeProvider` launches an unawaited full refresh;
the caller also awaits a full refresh. Their availability sequence numbers can invalidate the awaited pass before
the other pass publishes its auth snapshot. This is an upstream refresh-ordering logic error, not a merge regression.

The unchanged test passed in isolation and the integrated server suite passed **448/448** on rerun. Under deliberate
CPU load, a direct 60-iteration startup probe observed **4** false status reads at the await point; **3** recovered
after one macrotask and **1** was still false at that point. Preserve this evidence rather than adding an arbitrary
test delay. The assertion remains part of the gate; this finding is not an accepted failure baseline.

Disposition: **record** under the review policy. The observed impact is an immediate startup status read while
the second refresh is pending; no deployed provider-status failure has been observed. Revisit if ordinary Web use
reproduces it, or when an upstream change provides an awaited provider-registration refresh. Initial failing and
successful rerun logs are retained locally under `.dev/merge-backup-20261017/`.

## Vendor pi-web snapshot unit tests (2026-10-17) — historical

**Historical.** Client-app ticket 17 retired `apps/web/vendor/` with the Next app; the six files a surviving executable
path still names moved byte-identically to `packages/gateway/vendor/pi-web/` and are recorded in
[`docs/upstream-sources.md`](upstream-sources.md). The commands and counts below describe the snapshot as it stood on
2026-10-17 and are kept as evidence, not as a current guide.

The dormant snapshot at `apps/web/vendor/pi-web/` (`../apps/web/vendor/pi-web/README.md`) (pi-web `76bdc570` at v0.10.0)
keeps its sibling tests, and they are not part of any verification profile: `scripts/lib/discovery.mjs` skips
`vendor/`, so `pnpm verify` and `test:web:unit` neither run nor count them. Run them by path, from `apps/web`:

```bash
cd apps/web
node --test --test-reporter=tap vendor/pi-web/lib/mcp-host.test.mjs
```

They used to need the pinned clone's `package.json` (its `proper-lockfile`), its `bin/` launcher and the machine's
`git`, `mkfifo` and native `node-pty`; ten of the thirteen failed or could not run here. `lib/__fixtures__/hermetic-*.mjs`
now supply those as explicit stand-ins through `node:module`'s `registerHooks` — no flag, no production edit — and
`lib/__fixtures__/hermetic-typescript.mjs` compiles a source the way jiti does, which is what a test that needs a
parameter property or an `enum` requires. **Twelve files, 166 tests, 165 pass, 0 fail, 1 skipped** (the skip is the
snapshot's own Windows-only case), every file exit 0, measured 2026-10-17 on this branch's base `2ce7272` plus the
test-only change that adds this section; logs in `.dev/verify/vendor-pi-web/`:

| File | Tests | Exit | Time |
| --- | --- | --- | --- |
| `app/api/git/diff/route.test.mjs` | 5 pass, 1 skipped | 0 | 0.36 s |
| `lib/builtin-extensions.test.mjs` | 8 pass | 0 | 0.65 s |
| `lib/codemode-settings.test.mjs` | 16 pass | 0 | 0.43 s |
| `lib/file-tree-visibility.test.mjs` | 13 pass | 0 | 0.07 s |
| `lib/mcp-config-read.test.mjs` | 20 pass | 0 | 0.73 s |
| `lib/mcp-host.test.mjs` | 51 pass | 0 | 1.74 s |
| `lib/mcp-test.test.mjs` | 20 pass | 0 | 10.39 s |
| `lib/project-command-env.test.mjs` | 13 pass | 0 | 1.89 s |
| `lib/regular-file.test.mjs` | 1 pass | 0 | 0.17 s |
| `lib/subagent-isolation.test.mjs` | 2 pass | 0 | 0.07 s |
| `lib/terminal-manager.test.mjs` | 11 pass | 0 | 0.19 s |
| `lib/worktree.test.mjs` | 5 pass | 0 | 0.07 s |

Two files were left alone because a real process is what they assert, and both already passed:
`lib/mcp-test.test.mjs` connects stdio and HTTP MCP servers through the SDK's own transport, and
`lib/project-command-env.test.mjs` runs a real shell for the environment, streaming and abort cases. Their fixtures
(`lib/__fixtures__/mcp-*.mjs`) stay. `lib/pi-web-options.test.mjs` was **removed**: it required
`../bin/pi-web-options.js`, absent from the snapshot, from this repository and from every recorded upstream clone, and
the Web UI runs through `next dev/start` rather than that launcher, so there is no implementation to test. Its eleven
case names remain in `.scratch/web-test-consolidation/settings-report.md`, which had already classified it `delete` for
the same reason.

## Scripts that do not run

`apps/web/package.json` still declares `test:e2e` (`node e2e/run.mjs`) and `test:terminal`
(`node e2e/terminal.mjs`). **Both entry files are absent**, so those two scripts fail immediately. A third was
found the same way and repaired earlier: `test:upstream` named `lib/git-types.test.mjs`, which does not
exist — `git-types.ts` is a types-only module; the helper checks then lived in `lib/git-changes.test.mjs`. The
high-value pass subsequently retired those helper inventories; the current script targets composer and message/tool
behavior. Node
silently skips a missing file when other test files are also named, so the script had been running one file fewer
than it claimed, with no failure to show for it. That silent skip is why the check reads **every** file argument of
an invocation instead of the first: `node --test a.test.mjs b.test.mjs missing.test.mjs` exits 0 and reports only
`a` and `b`. They are recorded in
`KNOWN_MISSING` in `scripts/check-entrypoints.mjs` and printed by `pnpm check:entrypoints` on every run, rather
than deleted or hidden; any *other* missing entry file fails that check. Every other
`e2e/*.mjs` file the package references does exist — run the relevant driver separately; an existing entry file is not
proof that the driver passes. The `test:skills` flow is the maintained browser entry point.

## Chat navigation regression (`test:nav-flicker`)

A project's identity being re-resolved used to drop the conversation that was open. The fix is `9e5af9d`
(`fix/image-navigation-514`, based on `51492c4`): a nine-line identity-hydration guard in
`apps/web/components/AppShell.tsx`, with the driver that proves it, `apps/web/e2e/ux-nav-flicker.mjs`, and the
`test:nav-flicker` script. It is merged into `integration/ux-follow-up` at `242796f`.

The driver needed one correction of its own: `c122f0b` (`fix/nav-flicker-driver-fold`) opens a folded project group
before picking a row, because the reopening scene starts at `/` with nothing selected and previously passed or failed
on whether the shell had already adopted a cwd rather than on the navigation it exists to check.

**Deployed, driver evidence reused.** The released `51492c4` predates both commits and contains neither the driver
nor the script, and `9e5af9d` is not an ancestor of the intermediate `edef2c0`, so the images built from those two did
not carry the guard. The current deployment does: `39c168d` contains `9e5af9d`, and the workstation Web image
`hepi-web:39c168d` carries the guard string that `hepi-web:edef2c0` lacks. The guard, the driver and the
`test:nav-flicker` script are byte-identical between `c122f0b` and `39c168d`, so the driver evidence below carries
over to the deployed artifact; no fresh paid model turn was taken for this deployment, and no live model turn is
claimed. See [the 39c168d record](records/39c168d-deployment.md).
Browser proof on `c122f0b` (source-identical to the deployed `39c168d`), `pnpm --filter @hepi/web test:nav-flicker`
with `exit=0`: `/tmp/final-run1.log` and `/tmp/final-run2.log`, each ending `UX nav flicker checks PASSED` over eight
checks, against the build in `/tmp/final-build.log`.

## New-session navigation (`test:nav-new-session`) and auto-name (`test:session-auto-name`)

Two browser fixtures that were failing for reasons unrelated to the behavior they check. Both now run standalone
against the built tree.

`apps/web/e2e/ux-nav-new-session.mjs` (`pnpm --filter @hepi/web test:nav-new-session`) drives the production Next
build, the real backend, a real local gateway and a model endpoint that holds its answer until the driver releases it,
so "the run is in flight" is a real state rather than a sleep. It samples the real DOM on every animation frame and
asserts the sent turn stays on screen from Send until its answer arrives. It failed about half its runs on
`fresh: the sent turn never left the screen before its answer`: for one frame the shell drew the empty new-session
hero instead of the transcript, with the turn the user had just sent. The cause is in
`apps/web/components/ChatWindow.tsx`: the empty-new gate did not count the surface's own staged turns, so the one
frame during promotion in which the run's busy flags read false — the session exists, its stream is open, the run's own
frames have not arrived — while the session prop had not arrived either unmounted the whole transcript and swapped in
the hero. The gate now also requires `pendingSubmissions.length === 0`, which is what the staged turns are for.

- Measured on `76f0831`, before the fix: 6 of 8 runs failed on that one assertion, each recording a single frame at
  `/?cwd=…` with the transcript gone (`/tmp/nav-base1`). With a temporary probe build that exposed the gate's own
  inputs on the chat root, that frame read `emptyNew=true, pending=1, busy=false, isNew=true, session=none` on the same
  mounted `ChatWindow` instance as the frames before and after it, so the staged turn was present and the gate was
  what removed it.
- After the fix, the unmodified fixture passed 8 of 8 runs (`/tmp/nav-fixed1`) and 8 of 8 again (`/tmp/nav-fixed2`),
  each batch four runs in parallel on its own port pair.
- Recorded, not fixed: `agentRunning` still reads false for a frame or two of the promotion while the run is in
  flight, which is what the gate was reading. No material effect was established beyond that gate, and the fixture does
  not assert the affordance. Revisit on a user report of the Send/Stop control or the running indicator flickering, or
  of a duplicate send, rather than on the frame itself.

`apps/web/e2e/ux-session-auto-name.mjs` (`pnpm --filter @hepi/web test:session-auto-name`) drives the same real
stack with a controlled endpoint that answers naming requests. It required `HEPI_AUTONAME_BACKEND_PORT` in the
environment and aborted before starting anything without it, so the `test:session-auto-name` script could not run at
all. It now chooses its own ports the way the sibling fixtures do (`freePort`), propagating them once to the backend
and the Web server and reusing the backend port across its restart scene; the environment variables remain as optional
pins.

- Before: with no environment variables the unmodified fixture exits 1 with
  `AssertionError [ERR_ASSERTION]: set HEPI_AUTONAME_BACKEND_PORT to a free port` (`/tmp/autoname-red.log`).
- After: with no environment variables, exit 0 and every check ok, including the backend-restart scene
  (`/tmp/autoname-green.log`).

Unrelated flake seen while checking the two fixtures, recorded rather than fixed. Two of five
`pnpm verify --profile=fast` runs on this revision failed
`apps/server/test/models-config.test.ts:236` — "environment mode keeps credentials in memory and never reads the
agent directory's auth.json", `false !== true` at line 245, the environment provider's own credential reading as
unconfigured (`.dev/verify/2026-10-12T09-28-56-007-verify-fast`, `…09-33-35-060-verify-fast`). Both failures
happened while four browser fixtures were running; the same check passed in the three other verify runs, in 3 of 3
isolated runs of that file, in 6 of 6 isolated runs in parallel, in the server suite alone twice, and in the server
suite under four parallel fixtures once. `apps/server` and `packages` are byte-identical to `76f0831`
(`git diff --quiet 76f0831 HEAD -- apps/server packages`), so this is not this change's. Revisit if it fails on an
idle machine, or if a user reports an environment-configured provider reading as unconfigured.

## Integration branch `integration/p1` (browser stability + deploy probe + file payloads)

The reviewed axes merged onto the current deployment record, verified together before any release. Base `576a49e`;
sources `fix/browser-stability` `05b06bd`, `impl/deploy-probe-layout` `c22f7da` and `impl/files-transfer`
`3663884`. The file-payload merge (`e16c1ce`) touched no file the first two did, so it resolved without a conflict
and every earlier record stands unchanged.

| Check | Revision | Exit | Raw log |
| --- | --- | --- | --- |
| `pnpm verify --profile=fast` — typecheck, protocol 46, client 9, session 3, gateway 111, server 219 | `0350ece` | 0, PASS/PASS | `.dev/verify/2026-10-12T10-28-23-387-verify-fast/` |
| `node scripts/deploy-inspect.test.mjs` — 8 tests | `0350ece` | 0 | `.dev/verify/p1/2026-10-12T18-28-23-p1-gates.log` |
| `pnpm --filter @hepi/web build` then `test:nav-new-session` | `0350ece` | 0, checks PASSED | `.dev/verify/p1/2026-10-12T18-29-40-p1-browser.log` |
| `pnpm --filter @hepi/web test:session-auto-name` — no environment pins | `0350ece` | 0, checks PASSED | same log |
| `pnpm compare:tests --base=576a49e --suite=web-unit` | tip `ec4d70f` (tip worktree) | identical failure set, 0 new, 23 names both sides | `.dev/verify/2026-10-12T10-33-21-594-compare-tests/` |
| `pnpm deploy:inspect --probe` against the live runtime role | `0350ece` | **3**, `probe FAILED field=containerDetail` — recorded, not fixed | `.dev/verify/p1/2026-10-12T18-30-58-p1-probe.log` |

After merging `impl/files-transfer` `3663884` (`e16c1ce`):

| Check | Revision | Exit | Raw log |
| --- | --- | --- | --- |
| `pnpm verify --profile=fast` — typecheck, protocol 46, client 9, session 3, gateway 126, server 227 | `e16c1ce` | 0, PASS/PASS | `.dev/verify/2026-10-12T11-07-28-495-verify-fast/` |
| `pnpm --filter @hepi/gateway test` — includes the real-sshd `file-transfer-sshd.test.ts` | `e16c1ce` | 0, 126 tests | same run's `workspace-tests.log` |
| `pnpm test:web:unit` | `e16c1ce` | 1 — the known 22 failures | `.dev/verify/p1/2026-10-12T19-08-37-p1-files-browser.log` |
| `pnpm compare:tests --base=576a49e --suite=web-unit` | tip `e16c1ce` | identical failure set, 0 new, 23 names both sides (base 2139 / tip 2152 tests) | `.dev/verify/2026-10-12T11-09-13-936-compare-tests/` |
| `pnpm --filter @hepi/web test:files-transfer` | `e16c1ce` | 0, `FILES TRANSFER UI PASSED` | `.dev/verify/p1/2026-10-12T19-09-32-p1-files-e2e.log` |
| `test:nav-new-session` and `test:session-auto-name` re-run after the merge | `e16c1ce` | 0, both PASSED | same log |
| `pnpm deploy:inspect` / `pnpm deploy:plan` (offline preflight) | `e16c1ce` | 0 | `.dev/verify/p1/2026-10-12T19-10-22-p1-files-preflight.log` |

The merged range moves all three roles — 6 files under `apps/server`, 11 under `apps/web`, 6 under
`packages/` — so a release of it rebuilds the backend image, the Web image and the gateway bundle; the preflight
plan says so and nothing was applied.

`0350ece`, the docs-only `ec4d70f` and the docs-only `9f7de93` are byte-identical across `apps/`,
`packages/`, `scripts/` and `deploy/`, so the fast, focused and comparison runs evidence all three. (`9f7de93` is the
same docs-only change as the superseded `f7f0402`; the file-payload merge above is the first revision in this section
whose code differs.) The probe failure is pre-existing at the base
(`scripts/lib/deploy.mjs` `containerDetail`) and is recorded in
`.scratch/deploy-review-fixes/review-notes.md`; the merged marker fix is proven by its fixture only.

After merging `fix/sshd-fixture-teardown` `722db2a` — review 73's approved tree, whose own records are in
[Shared SSH fixture teardown](#shared-ssh-fixture-teardown-the-leaked-localhost-sshd-processes) — as `a7d6f2c`:

| Check | Revision | Exit | Raw log |
| --- | --- | --- | --- |
| the merged tree's `apps/`, `packages/`, `scripts/`, `deploy/` and `.github/` against `722db2a`; `docs/` and `.scratch/` against `dce8cea` | `a7d6f2c` | identical both ways | `git diff --quiet` |
| `pnpm --filter @hepi/gateway typecheck` | `a7d6f2c` | 0 | `.dev/verify/p1/2026-10-12T21-31-p1-fixture-merge.log` |
| `sshd-fixture.test.ts`; the four gateway consumers (`terminal`, `worktrees`, `ssh-workspaces`); the two server consumers (`terminal-transcript`, `ssh-project`) | `a7d6f2c` | 0 — 4, 25 and 8 tests pass, 0 skipped, and 0 leaked processes and 0 `/tmp/hepi-sshd-*` directories after them | same log |
| `pnpm check:docs` | `a7d6f2c` | 0 — 136 files, 0 broken links, 0 unindexed guides | same log |

The merged range moves `packages/gateway` test code and `.github/workflows/ci.yml` only, so nothing in the running
roles changes; no release was made and none is implied by this record.

## Shared SSH fixture teardown (the leaked localhost sshd processes)

`packages/gateway/test/sshd-fixture.ts` is the fixture `terminal.test.ts`, `worktrees.test.ts`, `ssh-workspaces.test.ts`,
`apps/server/test/terminal-transcript.test.ts` and `apps/server/test/ssh-project.test.ts` all start. Both of its shapes
now run the daemon inside one sandbox — `bwrap --dev-bind / / --unshare-pid --proc /proc --die-with-parent --tmpfs /run
--dir /run/sshd`, with the private tmpfs added only when `isolated` is asked for — so the process the fixture spawns is
that sandbox's pid 1 and everything the daemon forks is inside its namespace.

That is what makes the teardown ownable. `stop()` signals the one process the fixture spawned, waits — bounded — for it
to exit, and then removes the tree; the kernel kills the rest of the namespace with its pid 1, which is how the daemon,
the children OpenSSH forks per connection and the sessions those children `setsid` into all end together. Nothing else
on the machine is signalled, and nothing is searched for.

Two earlier attempts are recorded and withdrawn. Killing the wrapper left the daemon listening forever, reparented to
init, with every session it had served still alive — a session gets a session id of its own, so neither the pid file
(which names pid `2`, a pid of the sandbox's namespace) nor the wrapper's process group reaches it; every
`pnpm verify --profile=fast` left exactly two (the two isolated `terminal.test.ts` cases), and the removal that
followed raced the survivors' writes into the tree, which is how a run could end in `ENOTEMPTY: directory not empty`.
Killing every process holding a file under the fixture's tree was not ownership either: any process may hold a path,
and the negative control's own observer holding `base/log` was the counterexample — the review that blocked that
revision named both it and the host-wide `/proc` scan it needed.

Availability is a probe rather than a binary check: `sshdAvailable()` really starts a sandbox and asks whether it ran,
because a `bwrap` that exists but cannot unshare a pid namespace starts a fixture that looks fine and then leaks. A
machine without the prerequisites skips these tests; `HEPI_REQUIRE_SSH_SMOKE=1` turns that skip into a failure, which
is what CI sets now that its prepare step installs `bubblewrap`.

| Check | Revision | Result | Raw log |
| --- | --- | --- | --- |
| `packages/gateway/test/sshd-fixture.test.ts` — four tests, each run in both shapes | `2e96779` | 4 pass: the daemon is in a namespace nested below this machine's; a stop leaves no daemon, no sandbox process and no tree; the remote shell, its `sleep` and the connection's own children are gone; a neighbour, its session, an unrelated child and an unrelated holder of the fixture's log all survive | `.dev/verify/sshd-fixture-teardown/green-2e96779-fixture.log` |
| `pnpm --filter @hepi/gateway typecheck` | `2e96779` | PASS | `.dev/verify/sshd-fixture-teardown/typecheck-2e96779.log` |
| `pnpm --filter @hepi/gateway test` | `2e96779` | 130 pass, 0 fail, 0 skipped | `.dev/verify/sshd-fixture-teardown/gateway-2e96779.log` |
| `pnpm --filter @hepi/server test` | `2e96779` | 227 pass, 0 fail, 0 skipped | `.dev/verify/sshd-fixture-teardown/server-2e96779.log` |
| leaked processes and `/tmp/hepi-sshd-*` directories after every run above | `2e96779` | 0 and 0 | same logs |

The red evidence belongs to the revision before: at `43a92cb` the earlier two-test version of this file failed on the
port still open after `stop()` and on a session outliving its host
(`.dev/verify/sshd-fixture-teardown/red-43a92cb-sshd-fixture.log`), and the session child that survives a wrapper-only kill was
reproduced directly in a probe — the connection's children hold the fixture's log open while the command they started
holds nothing at all, which is why a holder scan cannot reach it and a pid namespace can.

**Review 73 blocked the two revisions before this one, and neither is a deployment point.** `ca177c5` (with its
negative-control test `a668ea0`) stopped the leak by killing every process holding a file under the fixture's tree,
which needed a host-wide `/proc/*/fd` scan and still was not ownership — the negative control's own observer holding
`base/log` was the counterexample, and the uncontained remote command the scan could not reach is the reason a pid
namespace is the answer. It was followed by `93944ed`, documentation only: the gateway restart-loop record in
`docs/local-tailscale-deployment.md`, unchanged by the final tree. `2e96779` is the revision the review approved
(`722db2a` the approved tree), and it is the one whose measurements the table above reports.

One full-suite run failed once in `terminal.test.ts`'s **local gateway** case ("a process the shell started outlived the
closed session") while a second suite ran at the same time; that case starts no SSH host, and `terminal.test.ts` passed
5 of 5 alone on the fixture revision in place at the time, so it is recorded as a load-sensitive flake of its own, not
this change's.

A remote shell now reports a pid of the sandbox's own namespace, so `terminal.test.ts` maps the pid its shell prints
through the fixture (`sandboxProcessByNamespacePid`) before asking this machine whether that process is still running;
the assertion is unchanged, the pid it names is this machine's.
## Builtin Skills browser check (no credential)

`node apps/server/scripts/skills-ui-smoke.ts --mode builtin` drives the real Next production UI in a headless
Chromium against a real backend, a real local gateway, the gateway's real SSH helper through a controlled transport,
and a controlled repository fetch. It needs no provider credential and no network, and it uses its own Web and backend
ports (`HEPI_SKILLS_SMOKE_WEB_PORT`, default 43104; `HEPI_SKILLS_SMOKE_BACKEND_PORT`, default 44104), plus an
ephemeral port the fixture itself binds. Run `pnpm --filter @hepi/web build` in the same worktree first;
`--web-root` points it at another checkout's build. `--mode baseline-market` reproduces the pre-repair feedback loss
and belongs to the baseline worktree, where the standalone Market entry still exists.

The SSH execution host has two transports. `--transport controlled` (default) makes the gateway's real Python helper
report a temporary login and home, so the remote global scope is exercised without touching a real account.
`--transport sshd` starts a real throwaway localhost `sshd` with its own key pair, host key and pinned known-hosts
file and drives it through the gateway's real `ssh` runner, so the remote account is this machine's real login: the
remote host is then exercised at project scope inside a temporary workspace, and the real account's own resource
directories are asserted byte-identical before and after. It needs `/usr/sbin/sshd`, `ssh-keygen` and
`ssh-keyscan` on `PATH`.

Reachable as `pnpm --filter @hepi/web test:skills` (unit files, both browser fixtures, the built-in smoke) and
`pnpm --filter @hepi/web test:skills-sshd`.

## Session fork

`POST /api/conversations/:id/fork` forks through pi-durable's own `Conversation.fork()` at a named entry, or at the
conversation's newest committed entry when none is named, and answers the new identity plus its catalogue row; the
source is only read, so a live run in it is undisturbed. Deterministic, credential-free coverage:

- `apps/server/test/session-fork.test.ts` — the real backend over a real store. A fork at a chosen entry, the copy's
  history read back and compared entry by entry with the source's, the source's entries unchanged, a fork while the
  source is genuinely inside its provider response (a faux provider held by a gate, no sleep) whose source run then
  finishes, the four refusals (missing, uncommitted fork point, empty, task-owned subagent) each asserted as its exact
  status, code and message with nothing created, and the execution-workspace document proving the copy's
  conversation-scoped documents follow the runtime's fork semantics.
- `apps/web/adapters/session-fork.test.mjs` — the adapter against a stand-in backend that records every request:
  which backend operation the browser reaches, that the named entry travels unchanged, that the answered row is the
  list's own row (including the fork relation) with no per-conversation state read, that a refusal keeps the backend's
  status and code, and that a fork moves the shared session-list version so another window's poll re-reads the list.
- `apps/web/e2e/ux-session-fork.mjs` (`pnpm --filter @hepi/web test:session-fork`) — the browser-driven demo path:
  the production Next build, the real backend, a real local gateway and the sidebar's own row menu, with the model
  endpoint holding its answer so the source's run is really in flight. Asserts the copy's row appears without a page
  reload, the copy's history (read from the durable API and from the screen) is the source's at the fork, the source's
  run finishes undisturbed and does not reach the copy, a second window agrees without a reload, and an empty session
  is refused with the reason the user reads.

## Session delete

`DELETE /api/conversations/:id` removes a conversation from the catalogue by writing the conversation-scoped
`hepi.deleted` document through the durable document path — pi-durable 1.1.0 has no conversation or entry deletion, so
the records are retained and the removal is presented as an ordinary one — and clears that session's own pin, archive
and unread entries in the same commit. Deterministic, credential-free coverage:

- `apps/server/test/session-delete.test.ts` — the real backend over a real store. A removal leaves the catalogue and
  the shared sidebar document with no orphan entry while the session's transcript still reads back entry by entry; the
  tombstone and the retained records survive a backend restart, with the tombstone read back as the document it is; a
  removal while the conversation is genuinely inside its provider response (a faux provider held by a gate, no sleep)
  is answered without waiting for the run, which then finishes into the retained records, and a later turn is refused
  as `session_deleted`; a forked child stays listed and openable with no parent reported; an unknown session is
  refused as `not_found` with nothing changed; and the seam's own source carries the required retention comment with
  no direct store editing.
- `apps/web/adapters/session-delete.test.mjs` — the adapter against a stand-in backend that records every request:
  which backend operation the browser reaches (a `DELETE` with no body and no per-conversation state read), that a
  refusal keeps the backend's status and reason, and that a removal moves the shared session-list version so another
  window's poll re-reads the list and drops the row.
- `apps/web/e2e/ux-session-delete.mjs` (`pnpm --filter @hepi/web test:session-delete`) — the browser-driven demo path:
  the production Next build, the real backend over a real SQLite store, a real local gateway and the sidebar's own row
  menu and delete confirmation. Asserts the row leaves the sidebar without a page reload, the session is out of the
  catalogue with its pin and archive entries cleared, its records still read back, a second window drops the row on its
  own poll, a removal during a genuinely in-flight run (the endpoint holds its answer) is answered at once and the run
  then settles, a child stays listed and openable, and an unknown session's removal is refused with the reason the user
  reads. Every wait is an observable UI or request state; there are no fixed sleeps.
## Session search

Search reads the conversations the catalogue lists through the runtime's public paginated entry reads
(`Conversation.entries()`) and applies upstream pi-web's matcher, bounds and response shape — a literal
case-insensitive match over the whole body's user and assistant text, one result per conversation with the entry, block
and an excerpt around the match, and `{ results, truncated }` — with no index and nothing to rebuild. Deterministic,
credential-free coverage:

- `apps/server/test/session-search.test.ts` — the real backend over a real store, and the reading half over the
  runtime itself. A phrase that appears only in a deep turn returns that conversation, its entry and an excerpt around
  the match, and the entry the result names is the one the transcript holds; regex operators in a query are literal;
  a removed conversation is absent from results while its retained records still hold the phrase; an entry appended
  after a search is found by the next search with nothing rebuilt, and a conversation created after one is searched
  too; the result bound (31 conversations, one phrase) is reported as `truncated`; an over-long query is refused with
  `code: "query_too_long"` and a readable reason rather than answered as empty; a tool result and a compaction entry
  are not searched and Unicode offsets stay correct; the wall-clock budget, the per-entry cap and the per-conversation
  text bound are each exercised through the injectable clock and limits; and every limit is asserted against the
  vendored upstream file, so the matcher and the bounds cannot drift from the source they are reused from.
- `apps/web/adapters/session-search.test.mjs` — the adapter against a stand-in backend that records every request:
  which backend operation the browser reaches (one `GET /api/search`, with the query unchanged and no
  per-conversation state read), that a result carries the row the session list would show for that conversation, and
  that a refusal keeps the backend's status and `code`.
- `apps/web/components/SessionSearch.test.mjs` — the panel's own rules: an open search with a query replaces the tree
  and states that it is searching, a closed or empty one leaves the tree alone, the excerpt renders around a marked
  match, opening a result names the session, entry and block, a truncated answer is reported, an over-long query is
  reported as the limit it is, and every locale carries the two new messages.
- `apps/web/e2e/ux-session-search.mjs` (`pnpm --filter @hepi/web test:session-search`) — the browser-driven demo path:
  the production Next build, the real backend over a real SQLite store, a real local gateway and the sidebar's own
  search box and result rows. Asserts a phrase only a deep turn holds returns that session with an excerpt containing
  the match (not its first message), clicking the result opens that session at the matching turn on screen, an entry
  appended after a search is found by the next search, a removed session never appears while its records are retained,
  a query past the bound is refused with the reason the user reads, and a search that reaches the result bound reports
  truncation. Every wait is the panel's own request and rendered answer; there are no fixed sleeps.

## Project removal and retained bindings (ticket 07)

Removing a Project removes hepi metadata only. The backend deletes the project record and its folder links in one
transaction with a retained binding per folder, so no directory is touched and a conversation already bound to one of
its folders keeps its execution environment, while the retained id is never a target again. Deterministic,
credential-free coverage:

- `apps/server/test/project.test.ts` — the real backend over a real store and a real local gateway. The removal of a
  Project whose folder an existing conversation is bound to, answered `200`, with the directory and a file inside it
  byte-identical afterwards and its listing unchanged; the bound conversation then running `bash`, `read` and a write
  in the same root; the retained binding read back through `GET /api/workspaces` with `retained: true` and its own
  `workspaceRoot`; `POST /api/conversations` refusing that workspace id as `unknown workspace`; re-adding the same
  directory minting a **different** workspace id with both served by the host; a retained root re-registered after the
  gateway alone restarts, with the conversation still reading and `pwd`-ing in the removed folder; a removal of a
  Project with several folders retaining **every** one of them; and an unknown project and a wrong host each refused
  with the backend's code and nothing changed.
- `apps/server/test/ssh-project.test.ts` — the same removal over a **real localhost `sshd`**: the retained record's
  profile id is what re-registers the remote root after the SSH gateway alone restarts, so the conversation keeps
  executing on the remote host and the retained entry reports the remote root.
- `apps/web/adapters/project-removal.test.mjs` — the adapter against a stand-in backend that records every request:
  the removal reaching the backend's `DELETE` with this origin's host id, a refusal forwarded with the backend's status
  and code, a retained binding passed through with its marker, `GET /api/home` and `POST /api/default-cwd` never
  answering with a retained folder, and a conversation bound to one still listed with its display root and its marker.
- Pure rules and the tree: `apps/web/lib/project-routing.test.mjs` (a retained default folder is reported on the
  group), `apps/web/lib/project-groups.test.mjs` (a retained folder is no recent project), `apps/web/lib/session-tree.test.mjs`
  (the group is marked and its conversations keep their rows), `apps/web/components/SessionTree.test.mjs` (no
  new-session control is rendered for such a group), `apps/web/components/SessionSidebar.test.mjs` (the project list
  leaves it out and the group's action refuses it), and `apps/web/lib/skill-inventory.test.mjs`
  (`selectableWorkspaces` leaves it out of the installation target list).

## Folder unlink and default replacement (ticket 08)

Unlinking one folder of a Project removes hepi metadata only, and the Project is never left without a default: a
non-default folder goes on its own, the default folder's removal must name its replacement in the same call, and the
last folder's removal takes the Project with it in one transaction. Every unlink writes the same retained binding a
Project removal writes. Deterministic, credential-free coverage:

- `apps/server/test/project.test.ts` — the real backend over a real store and a real local gateway. Unlinking a
  non-default folder of a three-folder Project, answered `200` with the folder gone, the default unchanged and the
  directory and its file byte-identical; the retained row carrying the folder's own workspace id, host id and root; the
  conversation bound to it still reading and `pwd`-ing in the unlinked folder, while `POST /api/conversations`
  refuses that id as `unknown workspace`; the default folder's removal refused as `default_replacement_required`
  with nothing removed; a replacement that is not another folder of the Project refused as `unknown_folder`; a
  replacement named while unlinking a non-default folder refused as `unexpected_replacement`; the same request naming
  a real folder succeeding and leaving it the default; an origin that does not serve the Project's host, a foreign
  folder and an unknown Project each refused with the backend's own code and nothing changed; and the last folder's
  removal answering `project: null`, leaving the Project out of the list, every root retained and the directory on
  disk. A second case unlinks a Project's only folder and then restarts the gateway bare, so the retained record is
  what re-registers the root and the bound conversation keeps executing there.
- `apps/server/test/ssh-project.test.ts` — the same unlink over a **real localhost `sshd`**: a non-default remote
  folder unlinked with the Project's default and both directories untouched, and the retained record's profile id the
  only thing that can put the remote root back after the SSH gateway alone restarts — with the conversation executing
  on that host and the unlinked id refused as a new target.
- `apps/web/adapters/project-removal.test.mjs` — the adapter against a stand-in backend that records every request:
  the unlink reaching the backend's own folder route with this origin's host id, the replacement default riding the
  same call, and a refusal (`default_replacement_required`, `unknown_project`) forwarded with the backend's status,
  code and reason.

The browser half — the folder list's unlink control and the replacement prompt — is ticket 09: `apps/web/lib/project-removal.test.mjs`, `apps/web/components/ProjectRemovalMenu.test.mjs`, `apps/web/adapters/project-removal.test.mjs` and `apps/web/e2e/ux-project-removal.mjs`.

## Recall and session-list regressions

Two behaviours have their own deterministic, credential-free coverage; re-run them when touching the conversation
catalogue or the Web adapter.

- `apps/server/test/recall-queue.test.ts` — a real backend with a faux provider held inside its first response, so a
  queue is observed while genuinely busy. Asserts that `POST /api/conversations/:id/recall-queue` removes the queued
  inputs without running them, that a recalled input is not delivered when the run settles, that an empty recall is an
  empty recall and not a failure, and that `GET /api/conversations` carries the catalogue fields (`busy`,
  `revision`, `messageCount`, `firstMessage`) the Web session list and running poll are built from.
- `apps/web/adapters/recall-and-session-list.test.mjs` — the adapter against a stand-in backend that records every
  request. Asserts the cost as a **count**: zero per-conversation `/state` reads for `GET /api/sessions` and for the
  `GET /api/agent/running` poll, one shared `sessionListVersion` on both, `clear_queue` forwarded to the backend
  operation, and a refused recall surfacing instead of an empty queue.

The running poll fires every 2.5 s in the UI, so a regression here is a per-poll fan-out, not a one-off request.

## Truthfulness and the extension selection

Two browser drivers carry the closing ticket's cross-cutting obligations. Both start the same three processes a
deployment composes — the production Next build, the real backend over a real SQLite store, and a real local
execution host — and neither makes a paid model call.

- `apps/web/e2e/ux-extensions-selection.mjs` — the durable-extension selection through the real UI, where
  `ux-extensions-panel.mjs` replaces its network boundary. Asserts the backend's own answers: a conversation created
  under the deployment's default selects it, a change made in the panel reaches the store and is what the panel shows,
  the changed default survives a backend restart against the same database, a conversation created afterwards selects
  the new default, the one created before it keeps what it was created with, and a per-conversation override is that
  conversation's own state that leaves the default alone and survives a reload. Run
  `pnpm --filter @hepi/web build` first.
- `apps/web/e2e/ux-truthfulness.mjs` — every control either works or is visibly unavailable before it is clicked
  (the sidebar's file-manager button is disabled and names the reason, the control beside it stays available); a
  backend-answered failure is shown with its reason and leaves the surface unchanged; a transport failure is shown as
  a transport failure (the extensions panel reports that it could not read the installed set instead of reporting an
  empty one, and reads it again when the backend returns); the new surfaces offer nothing they cannot do (no install,
  remove, update or check in the extensions panel, no MCP editor where no host service is configured); a Settings
  surface outside the six blocks stays visibly unavailable and unchanged; no catalogue row carries a timestamp or a
  name the runtime cannot supply, and no row renders a placeholder time; and only a readable rejection restores the
  draft, with the refused turn absent from the transcript.
- `apps/web/adapters/durable-api.test.mjs` — the availability contract behind the first of those: the
  `open-in-explorer` route answers the shape the sidebar reads (`supported`, `reason`, `platform`) rather than a
  field it never reads, which is what made the button look usable and refuse only after a click.
- `apps/web/e2e/ux-capability-trust.mjs` (`pnpm --filter @hepi/web test:capability-trust`) — the capability
  three-state, the retired push affordance and the read-only trust surface, with the production `ModelsConfig`,
  `SettingsPanel` and `ProjectTrustDialog` and only their network boundary replaced
  (`apps/web/e2e/ux-capability-trust.fixture.tsx`): a served capability offers its control; the deployment's own
  unsupported reply (501 + `code: "unsupported"`) hides it and names the limit; a request that never arrived is
  reported as unconfirmed and is **not** read as the deployment's limit, with one read per mount and no silent retry;
  Settings General offers no background-push control and no surface reads `/api/push/*`; and the trust dialog lists
  the folder's declared servers, says where the decision is recorded, reads the decision with `GET` only, and offers
  exactly one control — Close — which closes it. It needs no Web build and no backend.

The submission rules themselves are covered where they live: `apps/server/test/durable-submissions.test.ts`
(projections, terminal frames, the by-id lookup), `apps/server/test/server.test.ts` (admission deduplicates by the
request id across independent clients), `apps/web/lib/lifecycle-projection.test.mjs` (the one projection's ordering,
overlay, interest, readiness, notice and error rules) and `apps/web/e2e/ux-submission-recovery.mjs` (a dropped answer
is looked up rather than resent, and a recalled turn settles from its terminal frame).

## Composer drafts across a refresh

The composer's unsent text and images belong to the tab, and `apps/web/lib/draft-store.ts` is their one owner: the
operations stay synchronous and the browser store is a mirror of that memory, in `sessionStorage` so a hard refresh
finds this tab's own draft and another tab keeps its own. The behaviour and its limit at the contract switch are in
[Chat](chat.md#composer-drafts-across-a-refresh).

- `apps/web/lib/draft-store.test.mjs` — the store's own contract, against a stand-in browser store: a draft written,
  moved (`rekeyDraft`) and cleared reads back synchronously and comes back from the stored bytes after a reload; a
  second tab's store holds none of it; an emptied draft leaves nothing to restore; typing re-serializes only the text
  entry while the attachment entry is written only when the attachment list changes; a store that refuses the write
  drops the stale entry, keeps the draft in memory and reports the refusal, and a later successful write clears the
  report; attachments the browser refused are offered once and then left alone while they stand unchanged, so an
  oversized draft does not re-serialize them on every keystroke, and changing the attachments is what retries the write;
  and a malformed, unreadable, orphaned or over-limit entry restores nothing rather than a wrong draft. A server render
  with no browser store still reads and writes synchronously.
- `apps/web/lib/tab-session.test.mjs` — the tab's navigation memory carries the fresh composer's own key alongside its
  folder, and drops a key this build cannot use.
- `apps/web/e2e/ux-submission-recovery.mjs` (scene 5, after `pnpm --filter @hepi/web build`) — the real reload of an
  already-open page against the production Next build, the real backend and the real composer: an unsent text and an
  attached image come back into the same fresh composer with the image's exact bytes; sending clears it, so the reload
  after the send resurrects neither the text nor the image and does not resend (one model request for the whole scene);
  the answered turn is in the transcript exactly once and the reload plays no further completion tone; and an open
  conversation's own unsent text survives the refresh and text the user removed stays removed.

## Chat lifecycle: the open conversation

Two deterministic, credential-free suites own the open conversation's lifecycle — the transcript, the staged overlay,
the answer interest and the running indicator — and neither makes a paid model call or a sleep.

- `apps/web/lib/lifecycle-projection.test.mjs` — the pure fold, asserted directly. Every ordering counterexample the
  design validation recorded is a named case (a delayed old HTTP read over a fresh stream after a restart, a late old
  read rebasing backwards, a token mismatch that must not roll back, a cancelled acquisition's late response fenced
  out, a terminal record surviving an equal-revision snapshot), beside readiness from either transport, a held read that
  cannot hide a complete stream projection, a first failed read that is `unread` rather than loading, one notice per
  answer with separately delivered frames deduplicated, a queued follow-up's own later notice, abort and refusal that
  never sound, a null lookup that stays unknown, and a contradiction that keeps the last good view. `advance` and
  `createProjection` are also asserted to open no connection and run no timer.
- `apps/web/adapters/durable-lifecycle.test.mjs` — the adapter and the fold at the wire seam, against a stand-in
  backend: the HTTP conversation read and the stream's state frame are driven through the adapter's real request and
  response shapes, and the ordering counterexamples are re-asserted there so a field dropped in mapping fails a test
  rather than only a browser.
- `apps/web/hooks/useAgentSession.lifecycle.test.mjs` — the hook itself, bundled with esbuild and run against this
  file's own React, `EventSource`, `fetch` and timers, so the assertions are about what the hook does rather than about
  the text of its source. Four regressions the first review reproduced are named cases: a remount whose restored
  projection is already past the mount's own generation still accepts its fresh stream frame (control: the run really is
  on screen before the switch away), a first send whose session cannot be created settles the turn and restores the draft
  and its images exactly once with the reason shown, a refused steer restores its text and images once rather than twice,
  and both `connected` and `durable_resync` ask about each waiting turn by the request id the browser generated — one
  real request per turn, silent, and never a resend.
- `apps/web/e2e/chat-lifecycle-foreground.mjs` (`pnpm --filter @hepi/web build` first) — the browser, with the real
  completion callback recorded. It starts the production Next build, the real backend over a real SQLite store and a
  real local execution host, and holds the driver's own OpenAI-completions endpoint at named barriers, so a held state
  is a real in-flight request and never a sleep. It asserts the two proven reds and keeps each scene's negative
  control: no completion tone while the provider is held before its first token (control: the run really is busy on the
  wire), exactly one tone once the terminal answer fact arrives and only after it, a held conversation read that cannot
  keep the surface on Loading when the stream's complete projection arrived (control: with both transports held the
  surface really is on Loading and the transcript is absent), an abort that shows the runtime's reason and plays no
  tone, and one tone per distinct answer rather than per submission frame.

## Chat lifecycle: background completion

The same real stack, the same controlled provider, and the acceptance matrix for a conversation the user is not looking
at. Nothing here sleeps to wait for a state: the driver waits on evidence it recorded — a request held at its barrier, a
poll answer, a frame the page received — and each scene records the wire facts it observed as its own negative control.

- `packages/session/test/agent-event-connection.test.ts` — the shared stream: two readers of one conversation share one source
  and both hear every frame, conversations are independent, the source closes when its last reader leaves, and a
  subscription survives a dropped stream.
- `packages/session/test/browser-transport.test.ts` — the two ways into that stream: the Web cookie-BFF factory is a
  same-origin URL carrying no credential, and the diagnostic bearer factory authenticates its own direct read and hands
  the connection the same frames, closing with its last reader.
- `apps/web/lib/completion-delivery.test.mjs` — background delivery, driven through a stand-in stream: a nomination
  acquires and a live terminal fact notifies, an acquired baseline and a recovery are silent, a steer group is one
  notice, an abort or a failure is never a completion and never sounds, the open conversation's frames are its own
  surface's to fold, a handover carries the surface's own projection so a left conversation stays watched until its own frames settle it,
  a settled projection the owner hands over releases the stream while a projection that has accepted no fact never takes
  that interest away, the registry takes every owner's completion and reports each answer once, a subagent's completion
  is claimed but never sounded and no later owner can sound it, seven idle visits release their sources, and a baseline
  acquired after the run ended is silent.
  There is no fallback to ask about: the tone's only source is the live fact these cases fold. The transfer seam itself
is asserted here rather than in the browser: a watch that inherits a surface's projection continues from its turns and
interests, a handover reporting nothing in flight releases a stream only when the projection it carries has accepted a
fact, and seven conversations the user has entered and left with their runs settled hold no stream at all.
- `apps/web/hooks/useAgentSession.lifecycle.test.mjs` — the hook's own half of the same contract, against the real
  `CompletionDelivery` over a fake transport: a fresh composer releases the stream it acquired although its session prop
  is still null, rejoining a conversation whose stream was retained asks about the turn it left waiting (once, by id, and
  never by resending), a live completion of the conversation on screen is reported once so no other owner sounds it,
  and a run that ended before its stream was acquired is silent.
- `apps/web/e2e/chat-lifecycle-background.mjs` (`pnpm --filter @hepi/web build` first) — the browser: a foreign run
  this browser never dispatched sounds exactly once from its own terminal fact and leaves an unread marker, and later
  polls and re-delivered frames do not sound it again; a conversation left with a run in flight keeps its stream and its
  completion arrives while the user is elsewhere, and selecting it back duplicates no notice; a queued follow-up has its
  own later notice while a steer group shares one; an abort and a provider failure in the background play no tone; a
  backend restart and its re-acquisition are silent while a run after the restart still sounds once; a queued follow-up survives a leave made before any poll could nominate the conversation — the first answer sounds,
  the follow-up placed behind it sounds its own distinct answer, and both arrive on the one stream the leave never
  closed, with a held poll as the control that nothing else could have kept it; and a run that
  finished entirely unobserved is never acquired after the fact, is never named as running by any poll, sounds nothing
  and still leaves its unread marker — read back from the shared document, so the marker is the fact the sidebar
  recorded rather than a state the driver inferred.

The removal of the absence-based background tone is asserted where it lives, not by reading source text: the sidebar's
poll now has one observable output — the unread marker in the shared document — and `apps/web/e2e/chat-lifecycle-background.mjs`
counts tones per scene, so a second sound from an absence edge would fail the scene it belongs to. The marker itself
comes from the run's own end rather than from the poll's absence, which is asserted at each seam it crosses:
`apps/server/test/server.test.ts` proves the real backend reports `lastRunEndedAt` on the catalogue row from the run's
durable receipt and moves it forward on the next run, `apps/web/adapters/recall-and-session-list.test.mjs` proves the
adapter forwards it, `apps/web/lib/run-marks.test.mjs` proves the diff rule (a window's first listing is history, a
later end is a marker, the open conversation and a subagent's are not), and the browser scene proves the end-to-end
case the poll could never see: a run no poll ever named as running still leaves the marker. A subagent's completion is
silent along a chain that is proven the same way rather than in the browser, because no part of this deployment creates
a task-owned conversation: `apps/server/test/session-fork.test.ts` proves the real backend reports the creator edge on
the catalogue row for one (the fixture writes the owned record through the durable API itself, as nothing else would),
`apps/web/adapters/recall-and-session-list.test.mjs` proves the adapter turns that edge into the subagent relation the
surfaces read, and `apps/web/lib/completion-delivery.test.mjs` proves a suppressed conversation's completion is claimed
and never sounded.

## One resource snapshot per discovery

A conversation's first submission used to wait for the resource walk: the loader read the execution host one serialized
round trip per file, inside the submit handler and before the submission was committed. The walk is now one request —
`resourceSnapshot` returns the entire resource scope set, and the loader walks that snapshot in memory.

```bash
node --test apps/server/test/resource-snapshot.test.ts          # one snapshot request, zero per-file requests
node --test packages/gateway/test/resource-snapshot.test.ts     # one helper run, loopback and real sshd
node --test apps/server/test/workspace-resources.test.ts        # precedence, ignore rules, links, reload, shadow
node --test apps/server/test/ssh-resources.test.ts              # the same over the SSH transport
node apps/server/scripts/diag-rpc-count.ts --rtt=168 --flat --skills=130
node apps/server/scripts/diag-ssh-rpc-count.ts --flat --skills=65
```

Both counters are kept and now report the fixed shape: the local one counts the gateway methods a discovery issues over
the real HTTP surface and the real adapter, and the SSH one counts remote helper runs over the real Python helper.

| Shape | Before | After |
| --- | --- | --- |
| Local gateway, 40 nested skills | 292 per-file requests | **1** `resourceSnapshot`, 0 per-file |
| Local gateway, 130 flat skills at 168 ms modelled RTT | 365 round trips, 61.3 s serialized | **1** round trip, 168 ms |
| Local gateway, 130 nested skills | 1,015 round trips, 170.5 s serialized | **1** round trip |
| SSH, 65 flat skills | 716 helper runs, 430 of them authorization | **1** helper run, 0 authorization runs |

The SSH fixture here is a real localhost sshd with its own keys and the real `ssh` client
(`packages/gateway/test/sshd-fixture.ts`), so the one-run result is measured across the transport the deployment
uses, not only across the loopback runner.

Evidence at `abc5981`, on this branch's base `44c485f`:

| Check | Exit | Detail |
| --- | --- | --- |
| `node --test apps/server/test/resource-snapshot.test.ts` | 0 | 12 tests; the count tests fail at the base with `not 292 per-file requests` |
| `node --test packages/gateway/test/resource-snapshot.test.ts` | 0 | 9 tests, the real-sshd one included |
| `node --test packages/gateway/test/ignore-parity.test.ts` | 0 | 35,882 decisions over 1,500 generated pattern sets, the helper's engine against `node-ignore` |
| `node --test apps/server/test/*.test.ts` | 0 | 244 pass |
| `node --test packages/gateway/test/*.test.ts` | 0 | 140 pass |
| `pnpm -r typecheck` | 0 | all six packages clean |
| `pnpm verify --profile=fast` | 0 | typecheck plus the workspace run, PASS/PASS, revision `abc5981`, clean tree, `ok: true` in `.dev/verify/2026-10-13T12-00-25-289-verify-fast/verify.json` |
| `pnpm --filter @hepi/client build` then `smoke:pack` | 0 | 6 checks; the packed bundle carries the ported engine's copyright, and `THIRD_PARTY_NOTICES.md` travels in the tarball |
| `pnpm compare:tests --base=44c485f` | — | Web unit suite: base 22 failures, tip 22, `failures-new-on-tip.txt` and `failures-only-on-base.txt` both empty (at `ab86261`) |

Each review fix has its own red, reproducible with `bash .scratch/submit-stall/red-proofs.sh`: it reverts one fix at
a time and writes the failing run to `.scratch/submit-stall/red/<fix>.log` — `prune-before-read`, `skill-terminal`,
`per-file-limit`, `serialized-bound`, `unreadable-directory`, `opaque-parity` and `skill-terminal-ssh`. A mutation
whose test still passes prints `NOT A PROOF`.

`node .scratch/submit-stall/ignore-review-repro.mjs` runs the reviewed shapes against both producers and prints, per
row, the catalog each loader reached and the files that crossed the wire: an ignored directory with a negation and an
unreadable ignored skill, a nested globstar, and 70 ignored files of 250 KB. All three answer the same catalog on both
hosts, with nothing from the ignored subtrees in either snapshot. `node
.scratch/submit-stall/ignore-engine-reds.mjs` degrades the helper's engine one capability at a time — a negation
ignored, a mid-pattern globstar read as a literal, an ending that does not anchor the directory boundary, a bracket
class dropped, parent traversal dropped — and reports that the parity test catches all five, the snapshot tests four of
them. The fallback those shapes used to hit is gone; see [docs/migration-status.md](migration-status.md).

Three properties beyond the counts are asserted, because the loader's own walk is unchanged and runs over the
snapshot rather than over the host:

- **Scope.** The snapshot covers the discovery's own trees and nothing else. An unrelated `src/deep` tree and a
  `README.md` in the workspace must not appear, and every directory and file the snapshot does carry must be below a
  resource root or be one of the host's own resource files.
- **Parity.** Against the filesystem, the snapshot must hold exactly the directories, entries and file texts a direct
  per-file walk of the same roots reads. Across producers, the local gateway's snapshot and the SSH helper's snapshot
  of the same host must be deep-equal field by field, except `mtimeMs` — Node and Python round the same nanosecond
  timestamp differently in the last bits of the double, and no loader decision reads it.
- **Single-request completeness.** A host with a nested skill, a loose skill, an ignore file, an in-root link and an
  escaping link is discovered with one `resourceSnapshot` and zero per-file calls, so nothing the walk needs is
  deferred to a second request.
- **Pruning.** The producer applies the same ignore rules the loader applies, so an ignored file or subtree is never
  read, transmitted or counted, and it stops where the loader stops: a directory declaring `SKILL.md` contributes that
  declaration and nothing beside or below it, and a prompts root is read one level deep. A directory inside an ignored
  subtree that cannot be opened at all is therefore absent from the snapshot and does not fail the discovery, while a
  path the walk does reach and cannot read is still carried as a failure the loader raises. The two producers are given
  the same tree with an ignored subtree, a declared skill with supporting documents and a loose markdown file, and must
  return the same paths and the same text. The helper reads a pattern with a Python port of the `node-ignore` 7.0.5
  engine the loader uses, so a negation, a bracket class, `?`, a brace, a backslash escape and an interior `**` are
  read by both, and `packages/gateway/test/ignore-parity.test.ts` requires every decision the two engines make over a
  generated corpus to agree (35,882 decisions over 1,500 pattern sets).
- **Bounds on the response, not on the text.** The per-file limit covers a frontmatter read, so an oversized `SKILL.md`
  fails where a plain read fails instead of being advertised from a truncated head, and the byte bound is measured on
  the serialized response — metadata and escaping included — so a host whose content is under the limit in text and
  over it once escaped fails clearly.

### Integrated revision

The resources slice and the Web slice of this work are merged into `integration/chat-lifecycle` as `3a571cb` and
`0f9f5ab` (base `44c485f`; resources `a715a0a`, which carries the reviewed `9060e17`; Web `7a71932`). Both
merges were conflict-free. At `0f9f5ab`:

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `pnpm verify --profile=fast` | 0 | typecheck PASS, workspace tests PASS, clean tree, `ok: true` | `.dev/verify/2026-10-13T12-06-56-855-verify-fast/` |
| `pnpm verify --profile=fast`, re-run at the documentation revision `db8f2d5` | 0 | PASS/PASS, clean tree, `ok: true` | `.dev/verify/2026-10-13T12-14-16-593-verify-fast/` |
| `pnpm --filter @hepi/web build` | 0 | `Compiled successfully`, 3 static pages | `/tmp/int-web-build.log` |
| `node apps/web/e2e/submit-stall.mjs` | 0 | 55 checks, 0 failures — the reported symptom's own scenes against the real Next build, backend and held barriers | `/tmp/int-submit-stall.log` |
| `node apps/web/e2e/ux-submission-recovery.mjs` | 0 | 31 checks, 0 failures | `/tmp/int-recovery.log` |
| the four resource suites, targeted | 0 | 45/45 | rerun |

The fast profile already runs the real-sshd snapshot case, the ignore parity case and the prune-before-read cases, so
they were rerun only as a targeted set. The client artifact checks were not rerun because `packages/client` and the
gateway files the port lives in are byte-identical to `abc5981`, where `build` and `smoke:pack` passed.

What is not claimed: the live per-listing cost of a very large tree is not reproduced locally, and this change does not
parallelize a walk — it removes the per-file round trips. A snapshot over 16 MiB or 20,000 entries is refused with a
clear error rather than streamed. The idle SSE `BodyTimeoutError` teardown is a separate finding, untouched here.

## Persistent remote filesystem session (ticket 06)

The SSH filesystem used to spawn a fresh `ssh` process, ship the 51 KB helper and start a Python per operation, and
resolve the host's read authorization twice per request before doing any work. It now runs one framed helper session
per (profile, root) over the runner's interactive transport, with the corrected redundant-call elimination. The
session path is **latent in production** — the deployed gateway is local and configures no SSH profile — so the counts
below are a controlled measurement on the build host against the controlled transport and the real-sshd fixture, not a
production latency.

```bash
node --test packages/gateway/test/ssh-session.test.ts            # the session contract, 10 tests
node --test packages/gateway/test/resource-snapshot.test.ts      # one helper request per discovery, loopback and sshd
node apps/server/scripts/diag-ssh-rpc-count.ts --flat --skills=65
node .dev/verify/ticket-06/probe-helper-runs.mjs                 # per-method request counts on this revision
```

The before-numbers come from the same probe on the pinned baseline worktree `.dev/worktree-archive/perf-ssh-06-red` at
`52b0131`, which is checked out detached and never measured from the caller's tree:

| Operation | Helper requests before (`52b0131`) | After | Log |
| --- | --- | --- | --- |
| `executionHost` | 2 | **1** | `.dev/verify/ticket-06/helper-runs-baseline-52b0131.json` / `helper-runs-session.json` |
| `fileInfo`, `listDir`, `exists` | 3 | **2** | same |
| `readTextFile` | 4 | **2** | same |
| `createTempDir` | 3 | **1** | same |
| `writeFile` (one chunk) | 5 | **4** | same |
| `resourceSnapshot` | 1 | 1 (unchanged) | same |
| one discovery, 65 flat skills | 1 helper run, 0 authorization runs | 1, 0 | `.dev/verify/ticket-06/diag-ssh-rpc-count.log` |

Every number in that table is a **request frame the host receives**, so a path-naming read still makes 2 network round
trips and a one-chunk write still makes 4: the session does not remove the requests, it removes the per-operation
connection, the 51 KB helper payload and the Python start, so a (profile, root) pays one open instead of one per
operation, and the two redundant requests (`A0`, `A1'`, `A2`) are gone.

Two focus paths are measured by ad-hoc probes under `.dev/verify/ticket-06/` rather than by the suites: a request
arriving after the idle close opens its own session (`idle-reopen.json`: one session for the first read, a second for
the read after the window, both `ok`), and `close()` during an in-flight write answers `unknown`, never re-sends the
write (`writeBeginCount 1`), lets the helper remove its own staging file (`residue []`) and does not reuse the session
(`abort-replay.json`).

**Review corrections (ticket 06, after `14f34fd`).** Two material gaps were found by independent review and fixed on
the same branch: a dispatched request (and every waiter behind it) had no deadline and could stay unresolved forever,
and a gateway-initiated end killed the helper before it could remove the staging file it had created.

| Check | Command | Result | Log |
| --- | --- | --- | --- |
| The deadline settles both requests | `node --test packages/gateway/test/ssh-session.test.ts` | 12 pass, 0 fail — the dispatched request is `unknown`, the one that only waited is `aborted` ("not sent"), the operation is sent once, the next request opens its own session | `.dev/verify/ticket-06/ssh-session.log` |
| A session end after the staging file exists | same | the real helper's staging file is confirmed non-empty on disk before `close()`, and afterwards the target is unchanged and the staging file is gone | same |
| Independent fixture, corrected source | `TICKET06_SOURCE="$PWD/packages/gateway/src/ssh-filesystem.ts" node .dev/verify/ticket-06-review/deadline-and-close-repro.mjs` | `defectObserved false` for both probes: `residue []`, `childSignal null`, target `original`; `settledBeforeCleanup 2` at 60.5 s with `frames 1` | `.dev/verify/ticket-06-review/deadline-and-close-repro-after.log` |

The deadline is the gateway's own file bound, `SSH_FILE_TIMEOUT_MS` (60 s), the same deadline the one-shot transport
applied to every file operation; a test overrides it with `requestTimeoutMs` so no check waits a minute. A request
whose frame was written and then timed out is `unknown` and is never replayed; one that only waited past its deadline
was never written and is reported as not sent. Every end the gateway initiates — an idle close, a cancellation, a
deadline — now sends the helper the close frame and gives it the bounded grace to remove the staging paths it recorded
itself, so the fixture's 32 KiB staging file is gone and the helper exits on its own (`childSignal null`) instead of
being killed. A host that has already gone still cannot be asked, so an abnormal death still leaves its residue, and
that limit stands.

`pnpm verify --profile=fast` → 0 (PASS/PASS) at the current revision `d5a8f68`; logs in
`.dev/verify/2026-10-13T17-56-10-225-verify-fast`. The same profile passed at `606add4` before the two review
corrections (`.dev/verify/2026-10-13T17-19-39-974-verify-fast`). `packages/gateway` runs 164 tests, 0 fail, 0 skipped, and
`pnpm --filter @hepi/gateway test` is 162/162. One run of the whole workspace at the same revision
(`.dev/verify/2026-10-13T17-14-36-743-verify-fast`) failed a single fixture-teardown case,
`sshd-fixture.test.ts` "a stopped fixture leaves no daemon of its own listening and no process of its sandbox"; it is a
load-sensitive process-reaping check that touches neither the session nor the helper, passes standalone (4/4) and
passed on the rerun at the identical sha, so it is recorded as a flake rather than attributed to this change.
`packages/gateway/test/ignore-parity.test.ts` still requires the ported engine to agree with `node-ignore` (35,882
decisions over 1,500 generated pattern sets), and the ported engine is unchanged.

What is not claimed: no production traffic exercises this path, so the reduction is a measurement and not a deployed
latency; the session's own overhead is not benchmarked against the one-shot path on a real link here (the recorded
`perf-a` measurements stand as the transport evidence); and an abnormal session death leaves its staging file, which
is recorded as a limit rather than swept.

## Gateway-managed ControlMaster for install and execution (ticket 07)

An SSH-profile gateway used to spawn one `ssh` per install step and per executed command, so a publication paid a full
handshake per 32 KiB chunk. Installation and execution now share one gateway-managed master, keyed on the full
connection profile and living in `<HEPI_GATEWAY_DATA>/ssh-control` (0700, created before the first spawn). The socket
is passed as its own argv word (`-S`), not as an `-o ControlPath=` configuration line, so a state directory containing a
space works. Files, workspace management, worktrees and terminal sessions keep the plain transport.

```bash
node --test packages/gateway/test/controlmaster.test.ts
pnpm --filter @hepi/gateway test
pnpm verify --profile=fast
```

The before/after numbers are the localhost sshd's own `Accepted publickey` count for one real publication
(`SshInstallServer.publishDirectory`, two 40 KiB files, real `ssh` client and real Python helper) plus one execution
call, measured by the same probe against the base and this revision:

| Shape | Base `52b0131` | This revision |
| --- | --- | --- |
| One publication (6 helper runs) | 6 authentications | **1** |
| + one `/v1/execute` call | 7 | **1** |

`packages/gateway/test/controlmaster.test.ts` (9 cases, real localhost sshd) asserts the public facts rather than the
argv: one authentication carries a whole publication and a following execution, and the same holds when the gateway's
state directory contains a space, where the socket must stay one whole argv word instead of a re-parsed
`-o ControlPath=` configuration word; a runner composed without a master
opens its own connection, so the master is opt-in per capability; the socket name differs for every one of profile id,
host, port, identity file and known-hosts file, and a plain runner carries no `Control*` word at all; the managed
options go on the short-lived `execute` spawn and never on a long-lived `open` session, which is what a terminal and
the persistent filesystem session use; a missing or wrongly-permissioned socket directory is a reported failure and the
call is attempted once, never retried onto a direct connection; a foreign socket and a crash residue are left alone by
`prepare` and by `close`; and the gateway's own `ssh` is multiplexed while the user's own `ssh -G` output and the
user's own master are untouched and still work.

| Check | Revision | Exit | Raw log |
| --- | --- | --- | --- |
| `node --test packages/gateway/test/controlmaster.test.ts` — 9 pass, 0 fail, 0 skipped | `52b0131` + this change | 0 | `.dev/verify/ticket-07/controlmaster-test.log` |
| `pnpm --filter @hepi/gateway test` — 149 pass, 0 fail, 0 skipped | same | 0 | `.dev/verify/ticket-07/gateway-test.log` |
| `pnpm --filter @hepi/gateway typecheck` | same | 0 | `.dev/verify/ticket-07/typecheck-gateway.log` |
| `pnpm --filter @hepi/client typecheck` | same | 0 | `.dev/verify/ticket-07/typecheck-client.log` |
| `pnpm verify --profile=fast` — PASS/PASS | same | 0 | `.dev/verify/ticket-07/verify-fast.log` |

The base probe (6 and 7 authentications) ran in a detached worktree at `52b0131` with the unmodified runner; the
after-probe ran in this worktree. Both logs are this machine's runs, not artifacts this repository ships.

**Review fix: a state directory with a space.** An independent public probe at `244ab26`
(`.dev/verify/ticket-07-review/public-probe.log`) published and executed fine through the master with an ordinary state
directory (1 authentication) and failed both with `outcome_unknown` when `HEPI_GATEWAY_DATA` contained a space, while
the base `52b0131` succeeded in both shapes: the socket was handed to ssh as `-o ControlPath=<path>`, and ssh re-parses
an `-o` value as a configuration line, so the space ended the path ("keyword controlpath extra arguments at end of
line") and ssh exited 255 before authenticating. The owning transport now passes `-S <socket>` — one argv word, taken
verbatim — for both the execution spawn and the `ssh -O exit` reap. The new case was run red against the pre-fix runner
(`.dev/verify/ticket-07/red-spaced-directory.log`: `outcome_unknown` on the publication, exit 1, 3 failed) and green
after it, with the ordinary-directory case still at one authentication.

The reviewer's own public shape was then re-run against the fixed revision
(`.dev/verify/ticket-07-review/spaced-probe.ts`, log `public-probe-after-fix.log`): `startGateway` in SSH mode with
`databasePath` under `/tmp/hepi gateway data …`, then `POST /v1/installs` and `POST /v1/execute` — publication `ok`,
execution `ok` with `exec-ok`, and **1** authentication for both calls together, where the pre-fix probe reported
`outcome_unknown` for each and the base `52b0131` reported 6 and 7.

## Paid-provider smoke (operator credential required)

Start apps/server with OPENAI_API_KEY, HEPI_PROVIDER=openai and HEPI_MODEL set to a registered model ID; credentials
stay on the backend. Then run `HEPI_AUTH_TOKEN=<backend-token> pnpm --filter @hepi/server smoke:provider`. Optionally
set HEPI_SERVER_URL. This creates one durable conversation and makes one small paid request; refuses faux models,
checks the final SSE response and closes its reader. It is not included in test scripts. Do not print or commit keys.

After user authorization, a real-provider smoke passed with locally configured magpie/deepseek-v4.1-flash through its
OpenAI-compatible remote endpoint (not local inference). A temporary backend used supplied Models, loopback HTTP and
isolated SQLite; the existing provider-smoke.ts submitted one short request and verified the final non-error assistant
response through authenticated SSE. Backend and temporary database were cleaned. Credentials were loaded at runtime,
not written to repository files. Real-model abort and full UI parity remain unverified. CLI custom-provider
configuration is implemented in apps/server/src/provider-config.ts and wired in main.ts; a second live DeepSeek smoke
using it passed. See docs/providers.md.

Operator smokes not in CI, each a dated one-off: [real-model coding verification](real-model-coding-verification.md),
[execution-resources real-model smoke](execution-resources-real-model-smoke.md),
[split execution-resource smoke](distribution-smoke.md), [SSH interruption matrix](ssh-interruption-verification.md).
See [docs/upstream-sources.md](upstream-sources.md) for dependency-complete upstream baseline commands and results;
[docs/local-integration.md](local-integration.md) for gateway trust/lifecycle assumptions; [docs/pi-config.md](pi-config.md)
for the one-off `HEPI_CONFIG_SOURCE=pi` fixture smoke and what it does not claim; [docs/migration-status.md](migration-status.md)
for what has replaced what.

## Evidence for the numbers above

[Verification practice](agents/verification.md) requires a command, revision, exit code and raw log for every check
claim, so the counts above are scoped to a revision rather than offered as standing facts. The current counts were
measured at `78078de`; the rest were measured on this branch's base `edef2c0`, except the two browser checks.

| Check | Revision | Exit | Raw log |
| --- | --- | --- | --- |
| `pnpm -r typecheck`, six projects | `78078de` | 0 | `/tmp/gate-78078de-typecheck.log` |
| `pnpm -r test` — protocol 19, client 9, session 3, gateway 80, server 148 | `78078de` | 0 | `/tmp/gate-78078de-test.log` |
| `pnpm verify --profile=fast` | `78078de` | 0, PASS/PASS | `/tmp/gate-78078de-verify.log` |
| `pnpm -r typecheck`, six projects | `edef2c0` | 0 | `/tmp/verif-typecheck.log` |
| `pnpm -r test` — protocol 15, client 9, session 3, gateway 80, server 138 | `edef2c0` | 0 | `/tmp/verif-r-test.log` |
| whole-Web `node --test`, 251 files | `edef2c0` | 1, the 23 known failures | `/tmp/wholeweb-edef2c0-final.tap` (list `/tmp/web-files-edef.txt`, names `/tmp/failnames-edef-final.txt`) |
| `next build --webpack` | `c122f0b` | 0 | `/tmp/final-build.log` |
| `pnpm --filter @hepi/web test:nav-flicker` | `c122f0b` | 0 | `/tmp/final-run1.log`, `/tmp/final-run2.log` |

There are seven workspace projects (the root plus six members) and `pnpm -r test` reports `Scope: 6 of 7`. Five declare
a `test` script and ran; the root and `apps/web` declare none. The workspace logs were taken on `133da80`, whose `apps/`
and `packages/` trees are byte-identical to `edef2c0` (`git diff --quiet edef2c0 -- apps packages`), so they evidence
that revision's code. The server test-file count at `edef2c0` (17) is what distinguishes that revision's
138 from `51492c4`'s 129. These logs are evidence of one run on one machine, not artifacts this repository ships:
re-run the command when a number here matters to your change.

## Client ingress and device credentials (ticket 02)

The credential path is tested at the public ingress seam: real HTTP against a real Backend, its own credential records
and its own identity answer. The file is `packages/gateway/test/ingress.test.ts`; behaviour and the route table are in
[Client ingress](client-ingress.md).

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| ingress credential path, 12 tests | `node --test packages/gateway/test/ingress.test.ts` | `da9b171943615910e41fab03865aac10c15b6560` | 0 | `.dev/verify/2026-10-17T17-07-03-687-verify-changed/changed-test.log` |
| selected checks for the change | `pnpm verify:changed --base=integration/client-app` | same | typecheck 0, both package suites 0, `check:docs` 1 (the 12 pre-existing `.dev`/`.pi` links only) | `.dev/verify/2026-10-17T17-07-03-687-verify-changed/verify.json` |

The suite covers the Web cookie (HttpOnly, Strict, same-origin write, logout), the device bearer (issue, authenticate,
revoke, and a refusal on the very next request), restart persistence of a revocation through a fresh Backend and a fresh
ingress, the connection descriptor's Backend-stated identity and capabilities, the refusal of the login material, the
service credential and an execution token as client bearers, preflight for `authorization`/`content-type`/
`last-event-id` with an undeclared origin refused, the absence of every internal `/v1` route and of the credential
verification route on the client listener, fail-closed behaviour when the Backend is gone, and the revocation bound on
an attached conversation stream.

Not evidenced here, and not claimed: any deployment of the ingress. No service starts it by default, no runbook step
does, and the cutover that would is ticket 16.

## Client ingress conversation slice (ticket 03)

The conversation slice is tested at the same public seam with a real execution gateway behind the Backend: one client
listener, one Backend, and — where routing is the subject — two gateway processes the Backend may route to. Behaviour is
in [Client ingress](client-ingress.md#the-conversation-slice).

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| ingress conversation slice, 8 tests | `node --test packages/gateway/test/ingress-conversation.test.ts` | `df5463c819cdaad34fc210a0884c5b855e77b9fa` | 0 | `.dev/verify/ticket03-df5463c/ingress-conversation-test.log` |
| ingress credential path, 12 tests (unchanged, re-run) | `node --test packages/gateway/test/ingress.test.ts` | same | 0 | `.dev/verify/ticket03-df5463c/ingress-test.log` |
| typecheck, both packages | `pnpm --filter @hepi/server --filter @hepi/gateway -r typecheck` | same | 0 | `.dev/verify/ticket03-df5463c/typecheck.log` |
| gateway package suite | `pnpm --filter @hepi/gateway test` | same | 0 | `.dev/verify/ticket03-df5463c/gateway-test-suite.log` |
| server package suite, 448 tests | `pnpm --filter @hepi/server test` | same | 0 | `.dev/verify/ticket03-df5463c/server-full-suite.log` |
| submission/lifecycle regression (reused, not re-projected) | `node --test apps/server/test/durable-submissions.test.ts` | same | 0 | `.dev/verify/ticket03-df5463c/server-durable-submissions.log` |
| frame-size and `state_oversize` regression | `node --test apps/server/test/frame-size.test.ts` | same | 0 | `.dev/verify/ticket03-df5463c/server-frame-size.log` |
| stream keepalive regression | `node --test apps/server/test/conversation-heartbeat.test.ts` | same | 0 | `.dev/verify/ticket03-df5463c/server-conversation-heartbeat.log` |
| host routing and project regression | `node --test apps/server/test/project.test.ts` | same | 0 | `.dev/verify/ticket03-df5463c/server-project.log` |
| transport boundary as a source property | `node --test apps/server/test/gateway-client-boundary.test.ts` | same | 0 | `.dev/verify/ticket03-df5463c/server-gateway-client-boundary.log` |
| selected checks for the change | `pnpm verify:changed --base=integration/client-app` | `df5463c819cdaad34fc210a0884c5b855e77b9fa` | typecheck, every package suite, Web unit and script tests 0; `check:entrypoints` 0; `check:docs` 1 (the 12 pre-existing `.dev`/`.pi` links only) | `.dev/verify/2026-10-17T18-10-45-118-verify-changed/verify.json` |

What the conversation suite covers, each through the client listener only: create/read/state over the Backend's own
rows; the native `snapshot`, `submission` and `state` frames folded by the shared reducer a real client uses;
`resync_required` on a stale `after`; `state_oversize` on the stream and the 413 on the HTTP read; a submission whose
answer was never read recovered by its `requestId` with no second submission and no second conversation; a stream frame
byte-identical to what the Backend wrote for the same conversation; a keepalive comment frame surviving the hop; a
caller's cancellation ending the Backend's attached stream; and the routing split — the Backend reaching the execution
gateway's internal listener with the execution token, while that listener refuses the client cookie, the ingress service
credential and any client bearer, and the client listener serves no `/v1` route and is never itself used as the host.

The browsed-folder assertion is deliberately not a path literal: with no path named, the host answers with its own
execution account's home, so the test compares against `realpath(homedir())` and holds on any machine rather than only
the one it was written on.

Not evidenced here, and not claimed: any deployment of the ingress, and any browser or App UI above it. No service
starts the listener by default, and the cutover is ticket 16; the shared React client is ticket 05.

### Merged into `integration/client-app` at `a66363f`

The slice was fast-forwarded from its `3965b22` base, so the integrated tree is the ticket's own revision — no merge
commit, no conflict, nothing resolved by hand. The checks below were re-run against the integrated HEAD instead of
being reused from the branch:

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| ingress conversation slice, 8 tests | `node --test packages/gateway/test/ingress-conversation.test.ts` | `a66363fcf4cd2ed102f7713b174ad7ea37bdb6cd` | 0 | `.dev/verify/ticket03-merge-a66363f/ingress-conversation-test.log` |
| ingress credential path, 12 tests | `node --test packages/gateway/test/ingress.test.ts` | same | 0 | `.dev/verify/ticket03-merge-a66363f/ingress-test.log` |
| typecheck, both packages | `pnpm --filter @hepi/server --filter @hepi/gateway -r typecheck` | same | 0 | `.dev/verify/ticket03-merge-a66363f/typecheck.log` |
| gateway package suite | `pnpm --filter @hepi/gateway test` | same | 0 | `.dev/verify/ticket03-merge-a66363f/gateway-test-suite.log` |
| server package suite, 448 tests | `pnpm --filter @hepi/server test` | same | 0 | `.dev/verify/ticket03-merge-a66363f/server-full-suite.log` |
| submission/lifecycle regression | `node --test apps/server/test/durable-submissions.test.ts` | same | 0 | `.dev/verify/ticket03-merge-a66363f/server-durable-submissions.log` |
| frame-size and `state_oversize` regression | `node --test apps/server/test/frame-size.test.ts` | same | 0 | `.dev/verify/ticket03-merge-a66363f/server-frame-size.log` |
| stream keepalive regression | `node --test apps/server/test/conversation-heartbeat.test.ts` | same | 0 | `.dev/verify/ticket03-merge-a66363f/server-conversation-heartbeat.log` |
| host routing and project regression | `node --test apps/server/test/project.test.ts` | same | 0 | `.dev/verify/ticket03-merge-a66363f/server-project.log` |
| transport boundary as a source property | `node --test apps/server/test/gateway-client-boundary.test.ts` | same | 0 | `.dev/verify/ticket03-merge-a66363f/server-gateway-client-boundary.log` |
| selected checks for the merge | `pnpm verify:changed --base=3965b22` | same | typecheck, every package suite, Web unit and script tests 0; `check:entrypoints` 0; `check:docs` 1 (the same 12 pre-existing `.dev`/`.pi` links) | `.dev/verify/ticket03-merge-a66363f/verify-changed.log`, `.dev/verify/2026-10-17T18-26-27-879-verify-changed/verify.json` |

## Catalogue, project binding and host selection (ticket 06)

The catalogue projection, the Project/workspace binding and host selection are tested over real HTTP against a real
Backend and a real gateway holding a real git repository. The files are
`apps/server/test/catalogue-binding.test.ts` (the Backend's own facts), `packages/gateway/test/ingress-catalogue.test.ts`
(the same facts through the client listener, with a local and an SSH host) and `apps/web/adapters/durable-api.test.mjs`
(the Web adapter's projection of them); behaviour is in [Chat](chat.md) and [Projects](projects.md).

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| catalogue binding, 5 tests | `node --test apps/server/test/catalogue-binding.test.ts` | `0e8c34a1e58c1ed0652e6ae137afa23debf2c881` + this change (dirty tree) | 0 | `.dev/verify/client-app-06/server-catalogue-binding.log` |
| Web adapter projection, 11 tests | `cd apps/web && node --test adapters/durable-api.test.mjs` | same | 0 | `.dev/verify/client-app-06/web-durable-api.log` |
| Web adapter suite, 34 tests | `cd apps/web && node --test adapters/*.test.mjs` | same | 0 | `.dev/verify/client-app-06/web-adapter-suite.log` |
| ingress catalogue through the client listener, 2 tests | `node --test packages/gateway/test/ingress-catalogue.test.ts` | same | 0 | `.dev/verify/client-app-06/gateway-ingress-catalogue.log` |
| ingress regression, 12 tests | `node --test packages/gateway/test/ingress.test.ts` | same | 0 | `.dev/verify/client-app-06/gateway-ingress.log` |
| gateway package suite, 299 tests | `pnpm --filter @hepi/gateway test` | same | 0 | `.dev/verify/client-app-06/gateway-suite.log` |
| server + gateway typecheck | `pnpm --filter @hepi/server --filter @hepi/gateway -r typecheck` | same | 0 | `.dev/verify/client-app-06/typecheck.log` |
| server suite, 453 tests | `pnpm --filter @hepi/server test` | same | 0 | `.dev/verify/client-app-06/server-suite.log` |
| selected checks for the change (source) | `pnpm verify:changed` | same | 1 — `changed-typecheck` 0, `changed-test` 0 (server 453, gateway 299), `web-unit` 0; `check-docs` 1 (the 12 pre-existing `.dev`/`.pi` links only) | `.dev/verify/2026-10-17T18-53-20-648-verify-changed/verify.json` |
| selected checks after the documentation edit | `pnpm verify:changed` | `83b285f` + docs | 1 — only `check-docs` was selected (no executable file changed since the run above) and it reports the same 12 pre-existing links | `.dev/verify/2026-10-17T19-04-47-673-verify-changed/verify.json`, `.dev/verify/client-app-06/verify-changed.log` |

The Backend suite covers one catalogue read stating each conversation's workspace, host, recorded root, Project group
and retention beside the sidebar revision, the registry revision and the list version; a conversation bound to nothing
claiming none of them; a list assembled with no per-conversation read; a Project mutation advancing the registry
revision; the host account resolved per named host with another host's Projects reported as belonging to it; a removal
leaving the bound conversation's workspace, host and root intact with the retained marker; a created checkout being a
real conversation target; and a removed checkout keeping the binding of the conversation already in it. The Web suite
covers the adapter reading the catalogue plus one workspace listing and projecting rows from them, with the
configured workspace's host-reported root still resolved and the list version taken from the Backend rather than
recomputed. The ingress suite covers a device bearer reading the catalogue, creating Projects on two hosts, and
listing, creating and removing worktrees on the host each Project records — including that a folder a Project records
is addressed on its own host and not the host the ingress runs beside, and that a retained folder stays resolvable for
the conversation already in it while never being offered as a new target.

Not evidenced here, and not claimed: any browser journey through a deployed Web page. The extraction of the shared React
UI is ticket 05 and no shared client shipped when this was first written, so these are the two public seams the binding is
consumed through — the Backend's `/api` answer and the Web adapter's projection — not a rendered sidebar. The residual
gap that left is recorded and closed in the subsection below.

### Re-run after merging `integration/client-app` at `89887b2`

The integration tip had moved to ticket 07 (history read blocks), which touches the same ingress, the same `server.ts`
and the same two documentation files. The branch was merged and every check below was run on the merged tree rather
than reused from either side.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| catalogue binding, 5 tests | `node --test apps/server/test/catalogue-binding.test.ts` | merged tree | 0 | `.dev/verify/client-app-06-merged/server-catalogue-binding.log` |
| ingress catalogue, 2 tests | `node --test packages/gateway/test/ingress-catalogue.test.ts` | same | 0 | `.dev/verify/client-app-06-merged/gateway-ingress-catalogue.log` |
| ingress credential path, 12 tests | `node --test packages/gateway/test/ingress.test.ts` | same | 0 | `.dev/verify/client-app-06-merged/gateway-ingress.log` |
| Web adapter projection, 11 tests | `cd apps/web && node --test adapters/durable-api.test.mjs` | same | 0 | `.dev/verify/client-app-06-merged/web-durable-api.log` |
| Web adapter suite, 34 tests | `cd apps/web && node --test adapters/*.test.mjs` | same | 0 | `.dev/verify/client-app-06-merged/web-adapter-suite.log` |
| gateway suite, 309 tests | `pnpm --filter @hepi/gateway test` | same | 0 | `.dev/verify/client-app-06-merged/gateway-suite.log` |
| server suite, 453 tests | `pnpm --filter @hepi/server test` | same | 0 | `.dev/verify/client-app-06-merged/server-suite.log` |
| session suite, 34 tests | `pnpm --filter @hepi/session test` | same | 0 | `.dev/verify/client-app-06-merged/session-suite.log` |
| typecheck, three packages | `pnpm --filter @hepi/server --filter @hepi/gateway --filter @hepi/session -r typecheck` | same | 0 | `.dev/verify/client-app-06-merged/typecheck.log` |

The only conflicts were the two documentation files both tickets append to (`docs/migration-status.md`,
`docs/verification.md`) and the ticket table's status column: both tickets are resolved, so both sections and both
`resolved` cells are kept. No executable file conflicted.

### Re-run after merging `integration/client-app` at `b66c46d`, and the cuts that followed

The tip moved again (ticket 07's integrated re-run), so the branch was merged once more and every check below was run on
that merged tree. Reviewing the merged result then removed three duplications the ticket itself forbids, and the checks
were re-run again after them:

| Cut | Where | What replaced it |
| --- | --- | --- |
| two statements of one precedence order | `apps/server/src/server.ts` `bindingOf`/`catalogueBindingOf` | one `resolvedWorkspace()` naming the case; `transportOf()` derives the transport binding from it, and `bindingOf()` is that composition |
| a row resolving its binding twice | `apps/server/src/server.ts` `catalogueEntry` | one resolution answers both `gatewayId` and `workspace` |
| a second derivation of the list version | `apps/web/adapters/durable-api.ts` `listVersion()` | the Backend's `sessionListVersion` passes through; the adapter recomputes nothing |
| a second re-registration walk | `apps/server/src/server.ts` `ensureBinding` | one resolution decides which record re-asserts the root |

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| catalogue binding, 5 tests | `node --test apps/server/test/catalogue-binding.test.ts` | `5f98296` + the cuts (dirty tree) | 0 | `.dev/verify/client-app-06-merge-b66c46d/server-catalogue-binding.log` |
| ingress catalogue, 2 tests | `node --test packages/gateway/test/ingress-catalogue.test.ts` | same | 0 | `.dev/verify/client-app-06-merge-b66c46d/gateway-ingress-catalogue.log` |
| Web adapter projection, 11 tests | `cd apps/web && node --test adapters/durable-api.test.mjs` | same | 0 | `.dev/verify/client-app-06-merge-b66c46d/web-durable-api.log` |
| Web adapter suite, 34 tests | `cd apps/web && node --test adapters/*.test.mjs` | same | 0 | `.dev/verify/client-app-06-merge-b66c46d/web-adapter-suite.log` |
| server project/worktree/sidebar regression, 39 tests | `node --test apps/server/test/catalogue-binding.test.ts apps/server/test/project.test.ts apps/server/test/ssh-project.test.ts apps/server/test/worktree-picker.test.ts apps/server/test/sidebar-state.test.ts` | same | 0 | `.dev/verify/client-app-06-merge-b66c46d/server-project-regression.log` |
| gateway worktree/SSH regression, 14 tests | `node --test packages/gateway/test/ingress-catalogue.test.ts packages/gateway/test/worktrees.test.ts packages/gateway/test/ssh-workspaces.test.ts` | same | 0 | `.dev/verify/client-app-06-merge-b66c46d/gateway-worktree-regression.log` |
| ingress regression (credential path + ticket 07 resources), 22 tests | `node --test packages/gateway/test/ingress.test.ts packages/gateway/test/ingress-resources.test.ts` | same | 0 | `.dev/verify/client-app-06-merge-b66c46d/gateway-ingress-regression.log` |
| server suite, 453 tests | `pnpm --filter @hepi/server test` | same | 0 | `.dev/verify/client-app-06-merge-b66c46d/server-suite.log` |
| gateway suite, 309 tests | `pnpm --filter @hepi/gateway test` | same | 0 | `.dev/verify/client-app-06-merge-b66c46d/gateway-suite.log` |
| typecheck, three packages | `pnpm --filter @hepi/server --filter @hepi/gateway --filter @hepi/web -r typecheck` | same | 0 | `.dev/verify/client-app-06-merge-b66c46d/typecheck.log` |
| selected checks | `pnpm verify:changed --base=b66c46d` | `5f98296` + the cuts (dirty tree) | 1 — `changed-typecheck` 0, `changed-test` 0, `web-unit` 0; `check-docs` 1 (the same 12 pre-existing `.dev`/`.pi` links) | `.dev/verify/client-app-06-merge-b66c46d/verify-changed.log`, `.dev/verify/2026-10-17T19-19-09-506-verify-changed/verify.json` |

The list-version cut is asserted rather than assumed: the adapter suite's session-list case now serves a version the
rows do not sum to (`5`, then `9`) and requires that exact number on both the list and the running poll, so a
re-derived version fails the test instead of passing by coincidence.

### Merged into `integration/client-app` at `338ef40`

The branch fast-forwarded onto the integration tip `b66c46d` (ticket 07 already integrated), so the integrated tree is
the branch's own content plus that history and no merge commit was needed. The checks were run again on the integrated
revision rather than reused from the branch, and the `check-docs` failure below is the repository's 12 pre-existing
`.dev`/`.pi` links.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| catalogue binding, 5 tests | `node --test apps/server/test/catalogue-binding.test.ts` | `338ef40fd3c251a2930c7ad7da572d0d92adab8c` | 0 | `.dev/verify/client-app-06-integration-338ef40/server-catalogue-binding.log` |
| ingress catalogue, 2 tests | `node --test packages/gateway/test/ingress-catalogue.test.ts` | same | 0 | `.dev/verify/client-app-06-integration-338ef40/gateway-ingress-catalogue.log` |
| Web adapter projection, 11 tests | `cd apps/web && node --test adapters/durable-api.test.mjs` | same | 0 | `.dev/verify/client-app-06-integration-338ef40/web-durable-api.log` |
| Web adapter suite, 34 tests | `cd apps/web && node --test adapters/*.test.mjs` | same | 0 | `.dev/verify/client-app-06-integration-338ef40/web-adapter-suite.log` |
| server project/worktree/sidebar regression, 43 tests | `node --test apps/server/test/project.test.ts apps/server/test/worktree-picker.test.ts apps/server/test/sidebar-state.test.ts apps/server/test/session-search.test.ts apps/server/test/ssh-project.test.ts` | same | 0 | `.dev/verify/client-app-06-integration-338ef40/server-project-regression.log` |
| gateway worktree/SSH regression, 15 tests | `node --test packages/gateway/test/worktrees.test.ts packages/gateway/test/ssh-workspaces.test.ts packages/gateway/test/worktree-shadow.test.ts` | same | 0 | `.dev/verify/client-app-06-integration-338ef40/gateway-worktree-regression.log` |
| ingress regression (credential path + ticket 07 resources), 22 tests | `node --test packages/gateway/test/ingress.test.ts packages/gateway/test/ingress-resources.test.ts` | same | 0 | `.dev/verify/client-app-06-integration-338ef40/gateway-ingress-regression.log` |
| typecheck, three packages | `pnpm --filter @hepi/server --filter @hepi/gateway --filter @hepi/web -r typecheck` | same | 0 | `.dev/verify/client-app-06-integration-338ef40/typecheck.log` |
| selected checks | `pnpm verify:changed --base=b66c46d` | same | 1 — `changed-typecheck` 0, `changed-test` 0 (server 453, gateway 309), `web-unit` 0; `check-docs` 1 (the same 12 pre-existing `.dev`/`.pi` links) | `.dev/verify/client-app-06-integration-338ef40/verify-changed.log`, `.dev/verify/2026-10-17T19-27-04-631-verify-changed/verify.json` |

### The shared UI's own consumers (ticket 06 residual, 2026-10-18)

The ticket was reopened because its own "not claimed" boundary had stopped being true: ticket 05 delivered the shared
workbench, and the sidebar, folder picker, New Project dialog and New Session context bar were still asking the retired
Next BFF's vocabulary on a relative `fetch`, which on an App reaches the bundle's own origin under no credential. The
consumers now ask the Backend's own routes through one named seam, `packages/ui/src/lib/workspace-api.ts`
(`createWorkspaceApi` / `useWorkspaceApi`), and `useSessionUiState` reads and writes `/api/sidebar-state`. Behaviour and
the route table are in [Client ingress](client-ingress.md#the-shared-workbench-and-whose-state-a-page-holds).

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| named seam: requests, projection and refusal names, 7 tests | `node --test packages/ui/src/lib/workspace-api.test.mjs` | `ab8f4c3` + ticket 05 prerequisite `bb9994e` + this change (dirty tree) | 0 | `.dev/verify/client-app-06-ui/ui-suite.log` (whole `@hepi/ui` suite) |
| real HTTP: real ingress, real Backend, real gateway, device bearer, 4 tests | `node --test packages/ui/src/lib/workspace-api.http.test.mjs` | same | 0 | `.dev/verify/client-app-06-ui/ui-suite.log` |
| Web BFF native forwarding, 1 test | `node --test apps/web/adapters/native-forwarding.test.mjs` | same | 0 | `.dev/verify/client-app-06-ui/web-unit.log` |
| browser seam: configured ingress origin + bearer over the production surfaces, 15 checks | `node apps/web/e2e/ux-sidebar-ingress.mjs` | same | 0 | `.dev/verify/client-app-06-ui/sidebar-ingress.log` |
| shared workbench suite, 161 tests | `pnpm --filter @hepi/ui test` | same | 0 | `.dev/verify/client-app-06-ui/ui-suite.log` |
| Web unit suite, 46 tests over 20 files | `node scripts/test-web-unit.mjs` | same | 0 | `.dev/verify/client-app-06-ui/web-unit.log` |
| Web adapter suite, 34 tests | `cd apps/web && node --test adapters/*.test.mjs` | same | 0 | `.dev/verify/client-app-06-ui/web-adapters.log` |
| typecheck, every workspace package | `pnpm -r typecheck` | same | 0 | `.dev/verify/client-app-06-ui/typecheck.log` |
| Web host static build (Vite) | `pnpm --filter @hepi/web build` | same | 0 | `.dev/verify/client-app-06-ui/web-build.log` |

What the real-HTTP case holds: a device bearer lists workspaces and projects on the host the deployment stated (naming
none itself), creates a Project, creates, lists and removes a checkout through the Backend's one `POST /api/worktrees`
route with its folder record following and the removed binding marked `retained`, browses a host's own directories with
the account that host reported, and reads and writes the sidebar document — while asserting that `/api/home`,
`/api/default-cwd`, `/api/cwd/browse` and `/api/worktrees?cwd=` are `404` on the Backend and that no `ui-state` request is
ever made. The browser fixture mounts the production `SessionSidebar`, `NewProjectDialog` and `DirectoryPicker` behind
one real `createClient` with a configured ingress origin and one device bearer, and asserts that the catalogue row is
projected into the Project's group, that the project/workspace/sidebar-state reads and the pin write all land on that
origin with that bearer and the same-origin cookie policy, that a local browse names no host, and that the retired
vocabulary is never asked.

Recorded rather than closed: the Next-based e2e journeys (`ux-new-project`, `ux-worktree-picker`,
`ux-project-removal`, `ux-default-workspace`, `ux-truthfulness`) were **not** run, because `next build` on this
revision is broken for a pre-existing reason outside this ticket — `c0579bd` moved `gfm-autolink-email-loader.cjs` to
`packages/ui/src/lib/` while `apps/web/next.config.ts` still names `apps/web/lib/`. The deployed Web page still runs the
Next presentation layer, so its adapter forwards the two native routes the workbench now asks
(`/api/host/directories`, `/api/sidebar-state`) under their own names; that forwarding is covered by the Web unit suite,
and the page-level journey remains ticket 16/17's. Also recorded: creating a directory inside the folder picker is gone
(the native contract has no such route) and "open in file manager" is stated as the unsupported platform capability it is.

#### Re-run on the tree with `integration/client-app` merged in, `785a39a` (superseded by the linear port below)

The integration tip `e257e3d` was merged into the branch (the only conflict was the ticket 05 document both sides append
to) and every check below was run on the merged tree rather than reused from either side. The branch is not itself merged
into `integration/client-app`, so ticket 06 stays reopened until it lands and the same checks are re-run there. This
merge is historical: the change was re-ported linearly onto `e257e3d` in `fix/client-app-06-fresh`, and the current
evidence is the subsection below.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| shared workbench suite, 172 tests | `pnpm --filter @hepi/ui test` | `785a39a2e80db90e484d780199b73c09cf242c25` | 0 | `.dev/verify/client-app-06-ui-merged/ui-suite.log` |
| named seam, 7 tests | `node --test packages/ui/src/lib/workspace-api.test.mjs` | same | 0 | `.dev/verify/client-app-06-ui-merged/workspace-api.log` |
| real-HTTP seam, 4 tests | `node --test packages/ui/src/lib/workspace-api.http.test.mjs` | same | 0 | `.dev/verify/client-app-06-ui-merged/workspace-api-http.log` |
| BFF native forwarding, 1 test | `cd apps/web && node --test adapters/native-forwarding.test.mjs` | same | 0 | `.dev/verify/client-app-06-ui-merged/native-forwarding.log` |
| browser seam, 15 checks | `node apps/web/e2e/ux-sidebar-ingress.mjs` | same | 0 | `.dev/verify/client-app-06-ui-merged/sidebar-ingress.log` |
| Web unit suite, 53 tests | `node scripts/test-web-unit.mjs` | same | 0 | `.dev/verify/client-app-06-ui-merged/web-unit.log` |
| Web adapter suite, 34 tests | `cd apps/web && node --test adapters/*.test.mjs` | same | 0 | `.dev/verify/client-app-06-ui-merged/web-adapters.log` |
| typecheck, every workspace package | `pnpm -r typecheck` | same | 0 | `.dev/verify/client-app-06-ui-merged/typecheck.log` |
| Web host static build (Vite) | `pnpm --filter @hepi/web build` | same | 0 | `.dev/verify/client-app-06-ui-merged/web-build.log` |
| selected checks | `pnpm verify:changed --base=integration/client-app` | same | 1 — `changed-typecheck` 0, `changed-test` 0, `web-unit` 0; `check-docs` 1 (the same 12 pre-existing `.dev`/`.pi` links, 0 of them pointing at this change) | `.dev/verify/client-app-06-ui-merged/verify-changed.log`, `.dev/verify/2026-10-18T03-02-55-860-verify-changed/verify.json` |

#### Re-ported linearly onto the integration tip `e257e3d`, `fix/client-app-06-fresh` (2026-10-18)

The change above existed only on a branch that carried a merge of the integration tip. To leave a history that can land
directly, ticket 06's 17 files were re-ported as-is onto `e257e3d` in a fresh worktree
(`.dev/worktrees/client-app-06-fresh`, `git worktree add -b fix/client-app-06-fresh e257e3d`; that worktree was later removed without an archive entry, so its path is historical): no other branch was
merged, and no other ticket's files were touched. The worktree after the port was byte-identical to
`fix/client-app-06-ui`'s tree (`git diff --quiet 44d7167 -- .` produced no output), and every check below was run on
that tree rather than reused.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| named seam, 7 tests | `node --test packages/ui/src/lib/workspace-api.test.mjs` | `e257e3d` + this change (dirty tree) | 0 | `.dev/verify/client-app-06-fresh/workspace-api.log` |
| real-HTTP seam, 4 tests | `node --test packages/ui/src/lib/workspace-api.http.test.mjs` | same | 0 | `.dev/verify/client-app-06-fresh/workspace-api-http.log` |
| browser seam, 15 checks | `node apps/web/e2e/ux-sidebar-ingress.mjs` | same | 0 | `.dev/verify/client-app-06-fresh/sidebar-ingress.log` |
| BFF native forwarding, 1 test | `cd apps/web && node --test adapters/native-forwarding.test.mjs` | same | 0 | `.dev/verify/client-app-06-fresh/native-forwarding.log` |
| shared workbench suite, 172 tests | `pnpm --filter @hepi/ui test` | same | 0 | `.dev/verify/client-app-06-fresh/ui-suite.log` |
| typecheck, every workspace package | `pnpm -r typecheck` | same | 0 | `.dev/verify/client-app-06-fresh/typecheck.log` |
| selected checks | `pnpm verify:changed --base=e257e3d` | same | 1 — `changed-typecheck` 0, `changed-test` 0, `web-unit` 0; `check-docs` 1 (the same 12 pre-existing `.dev`/`.pi` links, 0 of them pointing at this change) | `.dev/verify/client-app-06-fresh/verify-changed.log`, `.dev/verify/2026-10-18T04-44-20-871-verify-changed/verify.json` |

The diff against the integration tip holds ticket 06's files and nothing else: `git diff --stat e257e3d HEAD` lists the
same 17 paths (the named seam and its tests, the four consumers, the BFF forwarding, and the documents). The branch is
not itself merged into `integration/client-app`, so ticket 06 stays reopened until it lands there.

## History, context and authenticated media resources (ticket 07)

The read blocks a deferred history entry names are tested at the public seam: real HTTP against a real Backend behind a
real client ingress. The file is `packages/gateway/test/ingress-resources.test.ts`; behaviour, the route table and the
bounds are in [Client ingress](client-ingress.md).

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| read blocks over the ingress, 10 tests | `node --test packages/gateway/test/ingress-resources.test.ts` | `3965b22` + ticket worktree | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/ingress-resources-test.log` |
| ingress credential path, 12 tests (regression) | `node --test packages/gateway/test/ingress.test.ts` | same | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/ingress-regression.log` |
| gateway suite, 299 tests | `node --test packages/gateway/test/*.test.ts` | same | 0 | `.dev/verify/2026-10-17T18-19-32-949Z-client-app-07-gateway/gateway-suite.log` |
| Backend suite, 448 tests | `node --test apps/server/test/*.test.ts` | same | 0 | `.dev/verify/2026-10-17T18-19-32-949Z-client-app-07-gateway/server-suite.log` |
| history, images and read blocks, 27 tests | `node --test apps/server/test/history-text.test.ts apps/server/test/history-window.test.ts apps/server/test/submission-images.test.ts apps/server/test/conversation-read.test.ts` | same | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/server-history-regression.log` |
| session suite | `node --test packages/session/test/*.test.ts` | same | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/session-suite.log` |
| Web deferred-text loader, 2 tests | `node --test apps/web/lib/deferred-text.test.mjs` | same | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/web-deferred-text.log` |
| typecheck | `pnpm --filter @hepi/server --filter @hepi/gateway -r typecheck` | same | 0 | `.dev/verify/2026-10-17T18-13-15-558Z-client-app-07/typecheck.log` |
| the three ingress suites after the integration merge, 30 tests | `node --test packages/gateway/test/ingress-resources.test.ts packages/gateway/test/ingress.test.ts packages/gateway/test/ingress-conversation.test.ts` | merged with `integration/client-app` | 0 | `.dev/verify/2026-10-17T18-29-00-586Z-client-app-07-merged/ingress-all.log` |
| gateway suite after the merge, 307 tests | `node --test packages/gateway/test/*.test.ts` | same | 0 | `.dev/verify/2026-10-17T18-29-00-586Z-client-app-07-merged/gateway-suite.log` |
| Backend suite after the merge, 448 tests | `node --test apps/server/test/*.test.ts` | same | 0 | `.dev/verify/2026-10-17T18-29-00-586Z-client-app-07-merged/server-suite.log` |
| session suite after the merge, 34 tests | `node --test packages/session/test/*.test.ts` | same | 0 | `.dev/verify/2026-10-17T18-29-00-586Z-client-app-07-merged/session-suite.log` |

### Final revision, merged with `integration/client-app` at `0e8c34a`

The branch was merged with the current integration tip and the ticket's checks were run again on that tree, after one
behaviour correction: a repeat `image()` read of a blob the scope already holds is a **use** of it, so the budget now
reclaims what the scope stopped looking at rather than the blob it is still showing. The test asserts that directly
(three blobs under a two-blob budget, with the middle one reclaimed after the first is read twice), and paging is also
asserted under a device bearer, not only under the Web cookie.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| read blocks over the ingress, 10 tests | `node --test packages/gateway/test/ingress-resources.test.ts` | `70537e9` + this change | 0 | `.dev/verify/2026-10-18T-ticket07-final/ingress-resources.log` |
| ingress credential path, 12 tests | `node --test packages/gateway/test/ingress.test.ts` | same | 0 | `.dev/verify/2026-10-18T-ticket07-final/ingress.log` |
| conversation slice, 8 tests | `node --test packages/gateway/test/ingress-conversation.test.ts` | same | 0 | `.dev/verify/2026-10-18T-ticket07-final/ingress-conversation.log` |
| session suite, 34 tests | `node --test packages/session/test/*.test.ts` | same | 0 | `.dev/verify/2026-10-18T-ticket07-final/session.log` |
| history, images and read blocks, 39 tests | `node --test apps/server/test/history-text.test.ts apps/server/test/history-window.test.ts apps/server/test/submission-images.test.ts apps/server/test/conversation-read.test.ts` | same | 0 | `.dev/verify/2026-10-18T-ticket07-final/server-history.log` |
| Web deferred-text loader, 2 tests | `node --test apps/web/lib/deferred-text.test.mjs` | same | 0 | `.dev/verify/2026-10-18T-ticket07-final/web-deferred.log` |
| typecheck, three packages | `pnpm --filter @hepi/server --filter @hepi/gateway --filter @hepi/session -r typecheck` | same | 0 | `.dev/verify/2026-10-18T-ticket07-final/typecheck.log` |
| selected checks | `pnpm verify:changed --base=integration/client-app` | `70537e9` (dirty: `docs/chat.md`, `packages/gateway/test/ingress-resources.test.ts`, `packages/session/src/resources.ts`) | typecheck, `changed-test` and `web-unit` 0; `check:docs` 1 (the same 12 pre-existing `.dev`/`.pi` links) | `.dev/verify/2026-10-17T18-57-13-113-verify-changed/` |

The suite covers: a deferred text served in bounded pages whose continuation rejoins the committed text byte for byte;
the client reader resolving a wire address against the connection's own Gateway, refusing a foreign origin before making
a request, and putting no credential in a URL; a tool-result image as a blob lease that serves exactly its bytes, is
shared by two readers of one address, and stops resolving once its last lease is released; a byte `Range` answered as
`206` with `content-range`, `416` outside the block, and `accept-ranges` on a whole read; a device bearer reading the same
blocks with the same image policy; the thinking read block restoring the whole reasoning; every refusal named
(`unauthorized`, `forbidden`, `not_found`, `oversize`, `unavailable`, `disposed`); a disposed scope revoking its blobs and
dropping a response that arrived too late; the retained image budget reclaiming the least recently used blob; and paging
plus the window staying the Backend's own, unchanged by reading resources.

Not evidenced here, and not claimed: any native platform behaviour (ticket 04's Tauri CLI and Android SDK are still
absent), any shared React surface (ticket 05), and the in-stream JSON round trip as a measured cost.

### Merged into `integration/client-app` at `89887b2`

The branch merged without a conflict against the then-current tip `0e8c34a`, so the integrated tree is the ticket's own
content plus the integration history. The focused checks were run again on the merged revision rather than reused from
the branch:

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| read blocks over the ingress, 10 tests | `node --test packages/gateway/test/ingress-resources.test.ts` | `89887b22cf7268412ce5117ec9f9b6298270d231` | 0 | `.dev/verify/2026-10-18-ticket07-integration-89887b2/ingress-resources.log` |
| ingress credential path and conversation slice, 20 tests | `node --test packages/gateway/test/ingress.test.ts packages/gateway/test/ingress-conversation.test.ts` | same | 0 | `.dev/verify/2026-10-18-ticket07-integration-89887b2/ingress-regression.log` |
| session suite, 34 tests | `node --test packages/session/test/*.test.ts` | same | 0 | `.dev/verify/2026-10-18-ticket07-integration-89887b2/session-suite.log` |
| history, images and read blocks, 39 tests | `node --test apps/server/test/history-text.test.ts apps/server/test/history-window.test.ts apps/server/test/submission-images.test.ts apps/server/test/conversation-read.test.ts` | same | 0 | `.dev/verify/2026-10-18-ticket07-integration-89887b2/server-history.log` |
| Web deferred-text loader, 2 tests | `node --test apps/web/lib/deferred-text.test.mjs` | same | 0 | `.dev/verify/2026-10-18-ticket07-integration-89887b2/web-deferred.log` |
| typecheck, three packages | `pnpm --filter @hepi/server --filter @hepi/gateway --filter @hepi/session -r typecheck` | same | 0 | `.dev/verify/2026-10-18-ticket07-integration-89887b2/typecheck.log` |
| documentation index | `node scripts/check-docs.mjs` | same | 1 (the same 12 pre-existing `.dev`/`.pi` links, none of them this ticket's) | `.dev/verify/2026-10-18-ticket07-integration-89887b2/check-docs.log` |

### Shared UI consumers, and the image-body bound (`dd51a06`)

Ticket 07's read-block contract reached the shared React workbench after the records above, together with two fixes to the
reader itself. The surfaces are `packages/ui/src/components/MessageView.tsx` (deferred text, thinking, tool-result
images, the user/custom message images) and `packages/ui/src/lib/deferred-text.ts`; the seam between them and the
connection's reader is `packages/ui/src/lib/resource-read.ts`, and the reader is read from
`useOptionalResourceReader()` in `packages/ui/src/lib/workbench-scope.ts`. Behaviour is in
[chat.md](chat.md#bounded-history-older-pages-and-the-read-blocks); the reader's own boundary is
`packages/session/src/resources.ts`.

Two defects were fixed at that seam rather than worked around at the surfaces:

- **A Web connection's read blocks were all refused.** The reader resolved every wire address with
  `new URL(address, origin + "/")`, and the Web host states `origin: ""` (`apps/web/src/main.tsx`), so the relative
  base threw and `resolve()` answered `undefined` — every deferred text, thinking block and image on the production
  Web page. A connection that states no origin now keeps its addresses relative, a continuation included, so the browser
  decides the origin and attaches its own cookie; an absolute address is still refused there.
- **An image body was buffered whole before the budget could refuse it.** `image()` called `response.arrayBuffer()`
  and only then compared the size with the retained budget, so a body the scope could never keep occupied the tab first.
  The body is now read through its stream and cancelled the moment it passes `limits.imageBytes`, and a stated
  `content-length` over that bound is refused without reading at all. The answer is the existing `oversize` refusal.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| reader boundary, 4 tests | `node --test packages/session/test/resources.test.ts` | `dd51a06` (clean) | 0 | `.dev/verify/2026-10-18T05-39-13Z-client-app-07-ui/session-resources.log` |
| session suite, 52 tests | `node --test packages/session/test/*.test.ts` | same | 0 | `.dev/verify/2026-10-18T05-39-13Z-client-app-07-ui/session-suite.log` |
| read blocks over the ingress, 10 tests | `node --test packages/gateway/test/ingress-resources.test.ts` | same | 0 | `.dev/verify/2026-10-18T05-39-13Z-client-app-07-ui/ingress-resources.log` |
| shared workbench suite, 193 tests | `pnpm --filter @hepi/ui test` | same | 0 | `.dev/verify/2026-10-18T05-39-13Z-client-app-07-ui/ui-suite.log` |
| selected checks | `pnpm verify:changed --base=integration/client-app` | `dd51a06` (clean) | 1 — `changed-typecheck`, `changed-test` and `web-unit` 0; `check-docs` 1 (the same 12 pre-existing `.dev`/`.pi` links) | `.dev/verify/2026-10-18T05-36-59-304-verify-changed/verify.json` |
| documentation links | `node scripts/check-docs.mjs` | same | 1 (the same 12 pre-existing links) | `.dev/verify/2026-10-18T05-36-59-304-verify-changed/check-docs.log` |

The cases this change added: a Web connection's read-block address and continuation stay relative while an absolute or
protocol-relative one is refused; an image body is cancelled at the budget instead of read to its end; a stated length
over the budget is refused before the body is read; an image within the budget is still one blob of exactly its bytes; a
deferred text is read once per block through the connection's reader and never through the global fetch; every refusal
keeps its name into the surface's own i18n label; an image lease is released on unmount, on a change of address or
connection, and an answer that arrives after the release is released instead of published; and a deferred preview renders
bounded and reads nothing on mount.

Not evidenced here: any native platform (Android still has no SDK; the desktop shell's own evidence is tickets 04 and
15's), and the browser driver for this surface — `apps/web/e2e/ux-deferred-text.mjs` still spawns `next start`, which the retired Next entry no
longer serves (ticket 17), so it was not run; the fixture it bundles was typechecked and bundled, not driven. Its
connection scope was updated to the `files` the provider now requires.

### Ticket 07 on the integration tip (`644ac55`)

`fix/client-app-07-resources-fresh` (`dc1cfef` code, `dd51a06` merge of this tip, `fd6e810` docs-only) merged into
`integration/client-app` as `644ac55`; the merge was clean and no file needed a hand resolution — the only overlapping
file, this one, was appended to rather than rewritten, so both records stand. The tip it merged into already carried
tickets 06, 08, 11 and 15 and their seam fix (`a0f2c01`), and `git diff dd51a06 644ac55 -- packages/session packages/ui/src apps/web`
is empty: the tree the ticket tested is the tree this merge has.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| reader boundary, 4 tests | `node --test packages/session/test/resources.test.ts` | `644ac55` (clean) | 0 | `.dev/verify/merge-client-app-4/session-resources.log` |
| session suite, 52 tests | `node --test packages/session/test/*.test.ts` | same | 0 | `.dev/verify/merge-client-app-4/session-suite.log` |
| read blocks over the ingress, 10 tests | `node --test packages/gateway/test/ingress-resources.test.ts` | same | 0 | `.dev/verify/merge-client-app-4/ingress-resources.log` |
| shared UI read blocks, 14 tests | `node --test packages/ui/src/lib/resource-read.test.mjs packages/ui/src/components/MessageView.test.mjs packages/ui/src/lib/deferred-text.test.mjs` | same | 0 | `.dev/verify/merge-client-app-4/ui-resource.log` |
| connection seam, 6 tests | `node --test packages/ui/src/client.test.mjs` | same | 0 | `.dev/verify/merge-client-app-4/client.log` |
| file seam and workspace seam, 13 tests | `node --test packages/ui/src/lib/file-seam.test.mjs packages/ui/src/lib/workspace-api.test.mjs` | same | 0 | `.dev/verify/merge-client-app-4/files-workspace.log` |
| shared workbench suite, 193 tests | `pnpm --filter @hepi/ui test` | same | 0 | `.dev/verify/merge-client-app-4/ui-suite.log` |
| workspace typecheck and tests | `pnpm -r typecheck`, `pnpm -r test` | same | 0, 0 | `.dev/verify/merge-client-app-4/workspace-typecheck.log`, `.dev/verify/merge-client-app-4/workspace-tests.log` |
| Web unit suite | `node scripts/test-web-unit.mjs` | same | 0 | `.dev/verify/merge-client-app-4/web-unit.log` |
| selected checks | `pnpm verify:changed --base=04875ef` | `644ac55` (clean) | 1 — `changed-typecheck`, `changed-test` and `web-unit` 0; `check-docs` 1 (the same 12 pre-existing `.scratch`/`.pi` links, identical to the `e257e3d` export in `.dev/verify/merge-client-app-4/check-docs-tip.log` vs `.dev/verify/merge-client-app-3/check-docs-base.log`) | `.dev/verify/2026-10-18T05-42-56-617-verify-changed/verify.json` |

Ticket 07's own record above stands as the evidence for the code: the merged tree was re-checked, not re-reviewed, and
the focused final review is the reviewer's. Not evidenced here, unchanged by the merge: any native platform (Android
still has no SDK; the desktop shell is evidenced by tickets 04 and 15) and the deferred-text browser driver, which still
spawns the retired Next entry (ticket 17).

## Client-runtime release and Rust build cost (ticket 16, packaging slice)

`impl/client-app-16-runtime`, merged with `integration/client-app` (`ea47917`) and then `0746d7a`; merged into
`integration/client-app` as `6b33b3f` on top of `a39dc80`. The rows below ran on `bd7783d` with a clean tree, and the
final review's targeted run on `94526e2`; the commits after each — `f426c4b`, then `237edc9` — change only this table,
and `git diff 94526e2 237edc9 -- scripts apps/app package.json` is empty, so the logs stand for unchanged code. Neither
run was repeated for the merge. The slice builds one
immutable release — ingress bundle, execution-gateway tarball, static Web build, Backend image — plus the unit and env
templates that run it, and it makes the App's Rust build share one cache. Contract:
[Client-runtime release](client-runtime-release.md); the artifact run below is recorded there in full.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| release contract, 8 tests | `node --test scripts/client-runtime.test.mjs` | `bd7783d` (clean, merged with `integration/client-app` `a39dc80`) | 0 | `.dev/verify/ticket-16-runtime-final/client-runtime.log` |
| CLI usage contract, 2 tests | `node --test scripts/cli-usage.test.mjs` | same | 0 | `.dev/verify/ticket-16-runtime-final/cli-usage.log` |
| release contract, 11 tests (promotion, template and release-name fixes) | `node --test scripts/client-runtime.test.mjs` | `94526e2` (clean; `integration/client-app` `a39dc80` an ancestor) | 0 | `.dev/verify/2025-client-runtime-promotion/runtime-cli-94526e2.tap` |
| CLI usage contract, 2 tests, same run | `node --test scripts/cli-usage.test.mjs` | `94526e2` | 0 | same file (13 tests total) |
| deployment plan and probe, 9 tests (shared release name) | `node --test scripts/deploy-inspect.test.mjs` | `94526e2` | 0 | `.dev/verify/2025-client-runtime-promotion/deploy-inspect-94526e2.log` |
| deployment plan and probe, 9 tests | `node --test scripts/deploy-inspect.test.mjs` | same | 0 | `.dev/verify/ticket-16-runtime-final/deploy-inspect.log` |
| Rust build seam, 4 tests | `node --test apps/app/test/cargo-build.test.mjs` | same | 0 | `.dev/verify/ticket-16-runtime-final/cargo-build.log` |
| App shell tests, 5 tests | `pnpm --filter @hepi/app test` | same | 0 | `.dev/verify/ticket-16-runtime-final/app-tests.log` |
| App typecheck | `pnpm --filter @hepi/app typecheck` | same | 0 | `.dev/verify/ticket-16-runtime-final/app-typecheck.log` |
| gateway typecheck | `pnpm --filter @hepi/gateway typecheck` | same | 0 | `.dev/verify/ticket-16-runtime-final/gateway-typecheck.log` |
| ingress static surface (agent10's module, re-run here), 12 tests | `node --test packages/gateway/test/ingress-static.test.ts` | same | 0 | `.dev/verify/ticket-16-runtime-final/ingress-static.log` |
| entrypoints | `node scripts/check-entrypoints.mjs` | same | 0 (the two recorded known-missing Web entries, unchanged) | `.dev/verify/ticket-16-runtime-final/check-entrypoints.log` |
| documentation links | `node scripts/check-docs.mjs` | same | 1 — the same 12 pre-existing `.dev`/`.pi` links under `.scratch/` as the `b492e9c` baseline, none in a file this slice touched | `.dev/verify/ticket-16-runtime-final/check-docs.log` |
| release build | `node scripts/build-client-runtime.mjs` | `0746d7a`, re-run at `f50df75` | 0, `release-0746d7a` / `release-f50df75` | `.dev/releases/.logs-0746d7a/`, `.dev/releases/.logs-f50df75/` |
| App debug artifact + reproducibility | `node apps/app/scripts/build-artifacts.mjs --skip-web --reproduce` | `efe84f7` (clean) | 0, executable identical across two builds, `.deb` not (bundler mtime) | `.dev/artifacts/t16-repro4/` |

The artifact run itself is the row that matters most, and it is not a unit test: the release was started as the unit
would start it (`/usr/bin/node <release>/ingress.mjs` with its env file), the Backend image was run on a throwaway
state directory, and the page, the `/api` distinction, the login, a device bearer, revocation, the ingress→gateway MCP
call and a Backend restart were all driven with real HTTP. The measured results are the table in
[the release guide](client-runtime-release.md#evidence-what-was-measured-on-this-branch).

**Rust cache, measured.** Before: the only App build tree was `client-app-15/apps/app/src-tauri/target` at 3.4 GiB
(3382 MiB), the per-checkout duplication this slice removes; no shared cache existed and no `cargo`/`rustc` was
running. After one debug build: `<repo>/.dev/cargo-target` at 2837 MiB, one generation, and a second build of the same
sources finished in 4 s instead of 33 s. A second build of the same sources reused the cache and left it at 2887 MiB.
`CARGO_TARGET_DIR` is the shared directory, `CARGO_BUILD_JOBS=6`, and `CARGO_INCREMENTAL=1` for the debug profile
(`0` for release), all recorded in the artifact's `provenance.json`. A checked-in relative `target-dir` was measured to
resolve per checkout (main tree and worktree each created their own `.dev/cargo-target`), which is why the directory is
computed and passed as an environment variable instead.

What this does **not** claim: no cutover was executed, no browser or native journey ran against the release, and the
Android target remains blocked. The revisions named here are the ones tested; the bundle this workstation is actually
serving is still the older `release-1062840`, so no row above describes the live artifact. The App artifact here is a **debug** build — `provenance.json` says
`build.profile: "debug"` and `production: false` — and is not production acceptance.

## Static Web entry on the ingress origin (ticket 16, static slice)

`impl/client-app-16-static` (`bd89c14` code, `f36a7e1` preflight/\`/api\` ordering fix) merged into
`integration/client-app` as `b492e9c`; the merge was clean and no file needed a hand resolution. The slice is the page
half of the ingress listener: `packages/gateway/src/ingress/static.ts` is a confined file lookup under
`HEPI_INGRESS_STATIC_DIR` (real-path root and candidate, decoded-once segments, `index.html` only for a navigation path
that names no file, content-hashed assets immutable, everything else revalidated, `nosniff`), and `index.ts` serves it
for any non-`/api`, non-`/v1` path. Contract: [Client ingress](client-ingress.md#the-web-build-on-this-origin).

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| static surface over real HTTP, 12 tests | `node --test packages/gateway/test/ingress-static.test.ts` | `b492e9c` (clean) | 0 | `.dev/verify/merge-client-app-5/ingress-static.log` |
| ingress credential path, 12 tests | `node --test packages/gateway/test/ingress.test.ts` | same | 0 | `.dev/verify/merge-client-app-5/ingress.log` |
| ingress regressions — resources, conversation, files, 27 tests | `node --test packages/gateway/test/ingress-resources.test.ts packages/gateway/test/ingress-conversation.test.ts packages/gateway/test/ingress-files.test.ts` | same | 0 | `.dev/verify/merge-client-app-5/ingress-regressions.log` |
| conversation control, 16 tests | `node --test packages/gateway/test/ingress-control.test.ts` | same | 0 | `.dev/verify/merge-client-app-5/ingress-control.log` |
| bounded multipart reader, 6 tests | `node --test packages/gateway/test/multipart.test.ts` | same | 0 | `.dev/verify/merge-client-app-5/multipart.log` |
| gateway typecheck | `pnpm --filter @hepi/gateway typecheck` | same | 0 | `.dev/verify/merge-client-app-5/gateway-typecheck.log` |
| selected checks | `pnpm verify:changed --base=6a79586` | `b492e9c` (clean) | 1 — `changed-typecheck`, `changed-test` and `web-unit` 0; `check-docs` 1, and its 12 failures are **the same 12 lines** as the `e257e3d` baseline, compared by path and line, not by count (`.dev/verify/merge-client-app-5/check-docs-tip.log` vs `.dev/verify/merge-client-app-3/check-docs-base.log`) | `.dev/verify/2026-10-18T05-57-26-900-verify-changed/verify.json` |

The slice's own record is in the ticket; this re-ran it on the merged tree rather than re-reviewing it. What this does
**not** claim: the direct cutover (the deployed entry still starts the old service), any fresh-state acceptance of either
host, and any native or Android evidence. Ticket 16 keeps those as its remaining work.

## Conversation control, queue, fork and relations (ticket 10)

The control surface a Web page or an App drives is tested at the same public seam: real HTTP through the client ingress
against a real Backend, with one Web session and one device bearer acting on the same conversation. The file is
`packages/gateway/test/ingress-control.test.ts`; the operations, the lost-answer rule and the ownership split are in
[Client ingress](client-ingress.md#conversation-control-queue-fork-and-relations).

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| ingress control/queue/fork/relations, 16 tests | `node --test packages/gateway/test/ingress-control.test.ts` | `60428f1` (merged with `integration/client-app` `2a41b2e`) | 0 | `.dev/verify/ticket-10-final/ingress-control.log` |
| ingress credential path, conversation slice, read blocks and catalogue (02/03/06/07 regression), 32 tests | `node --test packages/gateway/test/{ingress,ingress-conversation,ingress-resources,ingress-catalogue}.test.ts` | same | 0 | `.dev/verify/ticket-10-final/ingress-regressions.log` |
| the seam's own classification, 5 tests | `node --test packages/session/test/control.test.ts` | same | 0 | `.dev/verify/ticket-10-final/session-control.log` |
| durable submission, stop/continue, pending-item, fork and delegation regressions, 57 tests | `node --test apps/server/test/{conversation-stop-continue,durable-submissions,pending-item-routes,session-fork,web-delegate,conversation-fork-source}.test.ts` | same | 0 | `.dev/verify/ticket-10-final/server-regressions.log` |
| gateway + session + server typecheck | `pnpm --filter @hepi/gateway --filter @hepi/session --filter @hepi/server -r typecheck` | same | 0 | `.dev/verify/ticket-10-final/typecheck.log` |
| whole gateway suite, 325 tests | `pnpm --filter @hepi/gateway test` | same | 0 | `.dev/verify/ticket-10-final/gateway-suite.log` |
| whole session suite, 39 tests | `pnpm --filter @hepi/session test` | same | 0 | `.dev/verify/ticket-10-final/session-suite.log` |
| documentation links | `pnpm check:docs` | same | 1 | `.dev/verify/ticket-10-final/check-docs.log` — the same 12 pre-existing `.dev`/`.pi` links under `.scratch/`, none of them in a file this ticket touched |

The control suite's 16 tests are the ones this ticket added. The regression rows are the suites the same seam already
had — the credential path, the conversation slice, the read blocks, the catalogue binding, the durable
control/submission/fork/delegation behavior they build on, and the package suites they live in — re-run on the merged
HEAD rather than restated as a second projection of the same behavior.

What the suite holds, in the order the operations are used: a stop's durable receipt and the control read that states
the same commit; a stop, a queue admission, a fork, a delegation and a message whose **answer was dropped by a hop in
front of the ingress** — each reported as an unknown outcome carrying its own request id, and each resolved by asking
the conversation about that id rather than sending the write again; a refusal that is a refusal and never an unknown
outcome, with the Backend's own code; a Backend that is gone answering nothing at all rather than remembering a grant; a
queued steer and follow-up read back as one queue with the request id each was admitted under; one item edited against
the token it was read with, a stale edit refused with the current item, a cancel that is idempotent and a recall that
returns the text in queue order while the hold stays; a fork that keeps its branch point and its provenance and answers
a replay with the branch it already made; a reference that changes nothing about its target; a removal that leaves the
catalogue, keeps the records readable and refuses every control write; a delegation whose child keeps its definition
provenance, its creator and its place, and a dispatch to a conversation that already exists answering that target's own
identity with `created: false` and one admission; a resume that answers `stopping` while the old stop drains and
finishes only on a new intent; and two clients whose racing stops leave exactly one commit, with the loser's refusal
readable by its own request id.

Not evidenced here, and not claimed: that the React surfaces call these operations yet. Ticket 05 owns the shared UI;
this record holds the client seam those surfaces call, at the ingress they reach.

`pnpm check:docs` reports the same 12 broken relative links it reports on the baseline revision (all under
`.scratch/`, pointing at git-ignored `.dev/verify/` and `.pi/` paths); none of them is in a file this ticket touched,
so the count is unchanged rather than new.

### Earlier re-runs (historical records of the same checks)

#### Merged tree `f1f7608`, integration tip `0e8c34a`

The branch merged `integration/client-app` before delivery; the conflicts were three documentation sections and no
source file, so the same checks were re-run on the merged HEAD rather than reused. The user-facing description of the
seam is in [Chat](chat.md#control-queue-fork-and-relations-through-the-shared-client).

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| ingress control/queue/fork/relations, 16 tests | `node --test packages/gateway/test/ingress-control.test.ts` | `f1f7608` | 0 | `.dev/verify/ticket-10-merge/ingress-control.log` |
| ingress credential path (regression), 12 tests | `node --test packages/gateway/test/ingress.test.ts` | same | 0 | `.dev/verify/ticket-10-merge/ingress-regression.log` |
| durable submission, stop/continue, pending-item, fork and delegation regressions, 57 tests | `node --test apps/server/test/{conversation-stop-continue,durable-submissions,pending-item-routes,session-fork,web-delegate,conversation-fork-source}.test.ts` | same | 0 | `.dev/verify/ticket-10-merge/server-regressions.log` |
| gateway + server + session typecheck | `pnpm --filter @hepi/gateway --filter @hepi/session --filter @hepi/server -r typecheck` | same | 0 | `.dev/verify/ticket-10-merge/typecheck.log` |
| whole gateway suite, 313 tests | `pnpm --filter @hepi/gateway test` | same | 0 | `.dev/verify/ticket-10-merge/gateway-suite.log` |
| session control seam, 5 tests | `node --test packages/session/test/control.test.ts` | same | 0 | `.dev/verify/ticket-10-merge/session-control.log` |
| whole session suite, 39 tests | `pnpm --filter @hepi/session test` | same | 0 | `.dev/verify/ticket-10-merge/session-suite.log` |
| documentation links | `pnpm check:docs` | same | 1 | `.dev/verify/ticket-10-merge/check-docs.log` — the same 12 pre-existing `.dev`/`.pi` links under `.scratch/`, none added here |
| selected checks for the change | `pnpm verify:changed --base=0e8c34a` | same | 1 | `.dev/verify/ticket-10-merge/verify-changed.log` — typecheck, package suites and Web unit tests 0; the only failure is that same `check-docs` link count |

#### After the ticket 07 merge, `8973500`, integration tip `b66c46d`

Ticket 07's history/read-block work reached `integration/client-app` after the re-run above, so the same checks were run
again on the merged HEAD. The conflicts were again two capability sections appended at one anchor in
[migration status](migration-status.md) and this file; both records are kept, ticket 07's first. No source file was
contested.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| ingress control/queue/fork/relations, 16 tests | `node --test packages/gateway/test/ingress-control.test.ts` | `8973500` | 0 | `.dev/verify/ticket-10-integration/ingress-control.log` |
| session control seam, 5 tests | `node --test packages/session/test/control.test.ts` | same | 0 | `.dev/verify/ticket-10-integration/session-control.log` |
| ingress credential path, conversation slice and read blocks (03/07 regression), 30 tests | `node --test packages/gateway/test/{ingress,ingress-conversation,ingress-resources}.test.ts` | same | 0 | `.dev/verify/ticket-10-integration/ingress-regressions.log` |
| durable submission, stop/continue, pending-item, fork and delegation regressions, 57 tests | `node --test apps/server/test/{conversation-stop-continue,durable-submissions,pending-item-routes,session-fork,web-delegate,conversation-fork-source}.test.ts` | same | 0 | `.dev/verify/ticket-10-integration/server-regressions.log` |
| gateway + server + session typecheck | `pnpm --filter @hepi/gateway --filter @hepi/session --filter @hepi/server -r typecheck` | same | 0 | `.dev/verify/ticket-10-integration/typecheck.log` |
| whole gateway suite, 323 tests | `pnpm --filter @hepi/gateway test` | same | 0 | `.dev/verify/ticket-10-integration/gateway-suite.log` |
| whole session suite, 39 tests | `pnpm --filter @hepi/session test` | same | 0 | `.dev/verify/ticket-10-integration/session-suite.log` |
| documentation links | `pnpm check:docs` | same | 1 | `.dev/verify/ticket-10-integration/check-docs.log` — the same 12 pre-existing links, none added here |

#### Against the integration tip that carries ticket 06, `60428f1`, tip `2a41b2e`

That merge had no conflict: ticket 06 appends its own sections at other anchors and touches the catalogue/binding path,
not the control seam. The checks were run once more there, and the table at the top of this section is that run — the
gateway suite grew to 325 tests and the ingress regression set to 32 by the catalogue suite that arrived with it.

## Tauri desktop platform spike (ticket 04)

The first desktop target — Linux x86_64 on `workstation`, WebKitGTK 4.1 (2.52.3), Tauri v2 (crate 2.12.4, CLI 2.12.3) — was
measured inside a real Tauri v2 shell, not a browser. The spike lives at `spike/tauri-platform-04/` and is throwaway: it
exists to produce this evidence and is removed when the real App shell lands. Each run writes `report.json` plus the raw
per-process logs beside it.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| desktop fixture suite, 56 assertions | `node harness/run.mjs --skip-build --log-dir=logs/desktop-final` | `b66c46d` | 0 | `spike/tauri-platform-04/logs/desktop-final/report.json` |
| live ingress + Backend, 22 assertions | `node harness/ingress.mjs --log-dir=logs/ingress-final` | `b66c46d` | 0 | `spike/tauri-platform-04/logs/ingress-final/report.json` |
| `.deb` build and packaged smoke, 11 assertions | `npx @tauri-apps/cli@2 build --bundles deb`; `node harness/package.mjs --log-dir=logs/package-1` | `b66c46d` | 0 | `spike/tauri-platform-04/logs/package-1/report.json` |
| Rust shell build | `cargo build --release --manifest-path src-tauri/Cargo.toml` | `b66c46d` | 0 | `spike/tauri-platform-04/logs/cargo-build.log` |
| Android environment probe | `tauri android init` | `b66c46d` | 1 (no SDK, no `adb`, no device) | `spike/tauri-platform-04/logs/android/tauri-android-init.log` |

The fixture suite drives the built binary under Xvfb and asserts against **server-side** records as well as the page's own
report, so a claim like "the cancel reached the server" is the server's own disconnect, not the page's belief. The live
suite runs the same binary against the real ticket 03/07 client ingress in front of a real Backend, holding a device
bearer the Backend issued for that run: descriptor, create, submit and the Backend's own `snapshot` → `submission` →
`state` frames, the settled transcript, caller cancellation, and the ticket-07 deferred read block named by the frame
(`/api/sessions/7/entries/13/text?blockIndex=0`, 98 328 bytes, not truncated) all served on the client listener. Its
request log shows `origin=tauri://localhost` with a device bearer on every admitted call and no `/v1` route.

What the platform itself decided, and what the shared client must therefore respect:

- **Every gateway address is cross-origin.** The page origin is `tauri://localhost`, so an App declares its gateway
  origins to the ingress (`HEPI_APP_ORIGINS`) and builds a CSP naming them. An origin outside that CSP is refused by the
  WebView with `TypeError: Load failed` before the request leaves it; the server never sees it.
- **A truncated stream is not an error.** When the server dropped the socket mid-stream the reader ended cleanly with no
  exception and no terminal event. Recovery must key on the protocol (`resync_required` and the existing lifecycle
  facts), never on a throw.
- **Streamed upload bodies are rejected.** `fetch` with a `ReadableStream` body throws
  `NotSupportedError: ReadableStream uploading is not supported`; a `Blob` body of 48 MiB was accepted. The upload path
  is therefore a bounded body under the existing limits, not a stream.
- **Downloads stream, but crossing IPC must be bounded.** A 96 MiB body arrived in 3 WebView chunks (16.1 MB, 10.6 MB,
  73.8 MB) and reached disk byte-exact (sha256 `9dc4c69e…`). Sending those chunks whole across IPC peaked at **3.06 GB**
  RSS; slicing to 1 MiB first saved the same 96 MiB at a **225 MB** peak, against 158 MB for reading with no IPC at all.
- **The OS credential store works.** `keyring` → Secret Service (gnome-keyring on the session bus): set, read back,
  delete and read-after-delete all behaved, and a **separate process** read the value an earlier one had written.

Not evidenced, and not claimed: any Android or iOS target (no SDK, no `adb`, no device or emulator), a **system** `dpkg`
install onto a real host (that still needs root the host does not grant; what changed at `bdc8746` is that the package now
runs a **real dpkg transaction** as root of a throwaway tree in an unprivileged user namespace, asserted down to `dpkg -V`
and to the host's own record of the package being unchanged across the transaction — see
[the release-artifact record](#the-journeys-now-run-against-the-published-release-itself-2026-10-19--bdc8746)), and any App
UI above the spike. Background→foreground is a window hide/restore, which is not the same event as a mobile background
transition. `plugin-http` was not adopted: native `fetch` covered the read and SSE paths, so the G10 buffering question
did not arise.

### Re-run on the integrated revision `2584b78`

`impl/client-app-04` fast-forwarded onto `integration/client-app` at `2a41b2e`, so the integrated tree is the branch's
content plus that history. The three native suites and the selected checks were run again on the integrated tree, not
reused from the branch, into logs of their own; the assertion names and pass/fail set are identical to `desktop-final`,
`ingress-final` and `package-1`, and only timing and per-run memory figures differ.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Rust shell build | `cargo build --release --manifest-path src-tauri/Cargo.toml` | `2584b78` | 0 | `spike/tauri-platform-04/logs/desktop-integration-2584b78/cargo-build.log` |
| desktop fixture suite, 56 assertions | `node harness/run.mjs --skip-build --log-dir=logs/desktop-integration-2584b78` | `2584b78` | 0 | `spike/tauri-platform-04/logs/desktop-integration-2584b78/report.json` |
| live ingress + Backend, 22 assertions | `node harness/ingress.mjs --log-dir=logs/ingress-integration-2584b78` | `2584b78` | 0 | `spike/tauri-platform-04/logs/ingress-integration-2584b78/report.json` |
| `.deb` build + packaged smoke, 11 assertions | `npx @tauri-apps/cli@2 build --bundles deb`; `node harness/package.mjs --log-dir=logs/package-integration-2584b78` | `2584b78` | 0 | `spike/tauri-platform-04/logs/package-integration-2584b78/report.json` |
| Android environment probe | `npx @tauri-apps/cli@2 android init` | `2584b78` | 1 (no SDK: `/home/developer/Android/Sdk` absent) | `spike/tauri-platform-04/logs/android-integration-2584b78/tauri-android-init.log` |
| selected checks | `pnpm verify:changed --base=2a41b2e` | `2584b78` | 1 — `workspace-typecheck` 0, `workspace-tests` 0, `web-unit` 0 (148/148), `script-tests` 0 (51/51), `check-entrypoints` 0; `check-docs` 1 (the same 12 pre-existing `.dev`/`.pi` links) | `.dev/verify/2026-10-17T19-45-08-693-verify-changed/verify.json` |

The integrated run reproduced the measurements the file path depends on, not just their conclusions. The 96 MiB body
again arrived in 3 WebView chunks (16.1 MB, 11.2 MB, 73.4 MB) and reached disk byte-exact at sha256
`9dc4c69ee63eaa6d3063cf2fcee5c5cf2f7efbdf645744093ec09e030df470a4` (100 663 296 bytes). Sending those chunks whole
across IPC again peaked at 3 021 016 kB RSS (`mem-ipc-whole-chunk-peak`), against 224 144 kB for 1 MiB slices
(`mem-ipc-bounded-peak`) and 158 396 kB for reading with no IPC (`observed:mem-bare`); the read-only phase is also where
the highest high-water mark of the run appears (`observed:big-stream-noipc` reports 3 181 004 kB, carried over from the
preceding whole-chunk phase in the same process). The streamed-upload rejection
(`NotSupportedError: ReadableStream uploading is not supported`), the unlisted-origin refusal (`TypeError: Load failed`)
and the silent end of a dropped stream (`{"error":"","sawDone":false,"frames":2}`) all reproduced unchanged.

#### Merged with the ticket 04 evidence, `ebb6257`, integration tip `90274e1`

Ticket 04's desktop evidence reached `integration/client-app` after the run above, so `integration/client-app` was
merged into the ticket 10 branch and the checks were run again on the merged HEAD. The conflicts were the two appended
records in [migration status](migration-status.md) and this file; both are kept, ticket 10's first, and no source file
was contested. Ticket 04 stays partial: desktop evidenced, Android blocked.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| ingress control/queue/fork/relations, 16 tests | `node --test packages/gateway/test/ingress-control.test.ts` | `ebb6257` | 0 | `.dev/verify/ticket-10-integration-04/ingress-control.log` |
| session control seam, 5 tests | `node --test packages/session/test/control.test.ts` | same | 0 | `.dev/verify/ticket-10-integration-04/session-control.log` |
| ingress credential path, conversation slice, read blocks and catalogue (02/03/06/07 regression), 32 tests | `node --test packages/gateway/test/{ingress,ingress-conversation,ingress-resources,ingress-catalogue}.test.ts` | same | 0 | `.dev/verify/ticket-10-integration-04/ingress-regressions.log` |
| durable submission, stop/continue, pending-item, fork and delegation regressions, 57 tests | `node --test apps/server/test/{conversation-stop-continue,durable-submissions,pending-item-routes,session-fork,web-delegate,conversation-fork-source}.test.ts` | same | 0 | `.dev/verify/ticket-10-integration-04/server-regressions.log` |
| gateway + session + server typecheck | `pnpm --filter @hepi/gateway --filter @hepi/session --filter @hepi/server -r typecheck` | same | 0 | `.dev/verify/ticket-10-integration-04/typecheck.log` |
| whole gateway suite, 325 tests | `pnpm --filter @hepi/gateway test` | same | 0 | `.dev/verify/ticket-10-integration-04/gateway-suite.log` |
| whole session suite, 39 tests | `pnpm --filter @hepi/session test` | same | 0 | `.dev/verify/ticket-10-integration-04/session-suite.log` |
| documentation links | `pnpm check:docs` | same | 1 | `.dev/verify/ticket-10-integration-04/check-docs.log` — the same 12 pre-existing `.dev`/`.pi` links under `.scratch/`, none of them in a file this ticket touched |

## Files and workbench streaming (ticket 08)

Date 2026-10-17/18. Host `workstation`, Linux 6.17.0-23-generic x86_64, Node v26.5.1. The branch is
`impl/client-app-08`, merged with `integration/client-app` at `e257e3d`; each run's revision is in its row. The rows
below the gateway ones were re-run on the merged, reviewed tree at `c80657f` and `b236f70` (clean; the second differs only by this
record).

The file surface moved to `packages/gateway/src/files-surface.ts` (rules in `packages/protocol/src/files.ts`) and the
multipart reader to `packages/gateway/src/multipart.ts` over the public `busboy`; the Next-private parser and the four
Web modules it needed are deleted. What is recorded here is the checks that hold that move, the browser path that
exercises it, and the measured cost of a representative transfer.

The client half is recorded below the gateway rows: the shared surfaces stopped assembling file addresses and now ask
the connection's own seam (`packages/ui/src/lib/file-seam.ts`), which is what makes the same tree work from a Web page
and from the App's bundle.

Reconciliation 2026-10-18. `fix/client-app-08-fresh` re-lands the reviewed work as one commit (`be2712f`) directly on
the integration tip `e257e3d`, with a tree identical to `impl/client-app-08`'s; the branch that carried it also carried
three merges of older integration states, which is what the fresh branch drops. The focused rows at the end of the
table were re-run on `be2712f`; the rows above are the reviewed branch's own runs and are not re-claimed for this
revision.

| Check | Command | Exit | Raw log |
| --- | --- | --- | --- |
| whole gateway suite, 339 tests | `node --test packages/gateway/test/*.test.ts` | 0 | `.dev/verify/ticket-08/gateway-suite.log` |
| file surface at the ingress seam, 8 tests | `node --test packages/gateway/test/ingress-files.test.ts` | 0 | `.dev/verify/ticket-08/ingress-files.log` |
| bounded multipart reader, 6 tests | `node --test packages/gateway/test/multipart.test.ts` | 0 | `.dev/verify/ticket-08/multipart.log` |
| backend relay and end-to-end payload routes, 8 tests | `node --test apps/server/test/file-relay.test.ts apps/server/test/files-transfer.test.ts` | 0 | `.dev/verify/ticket-08/server-files.log` |
| ingress credential/conversation/read-block/catalogue regression, 32 tests | `node --test packages/gateway/test/ingress.test.ts packages/gateway/test/ingress-conversation.test.ts packages/gateway/test/ingress-resources.test.ts packages/gateway/test/ingress-catalogue.test.ts` | 0 | `.dev/verify/ticket-08/ingress-regressions.log` |
| Web unit suite, 45 tests | `node scripts/test-web-unit.mjs` | 0 | `.dev/verify/2026-10-17T21-09-59-364-web-unit/web-unit.json` |
| shared UI suite, 116 tests | `pnpm --filter @hepi/ui test` | 0 | `.dev/verify/ticket-08/ui-suite.log` |
| workspace typecheck | `pnpm -r typecheck` | 0 | `.dev/verify/ticket-08/typecheck.log` |
| selected checks | `node scripts/verify.mjs --profile=changed --base=19f5a54` | 1 — typecheck, workspace tests, Web unit and script tests, and entrypoints 0; `check-docs` 1 (the 12 pre-existing broken links, the same set as before this ticket and none of them in a file it touched) | `.dev/verify/2026-10-17T21-18-19-413-verify-changed/verify.json` |
| Web static build | `pnpm --filter @hepi/web build` | 0 | `.dev/verify/ticket-08/web-build.log` |
| real-browser path through the ingress, 17 checks | `node apps/web/e2e/files-transfer.mjs` | 0 | `.dev/verify/ticket-08/files-transfer-e2e.log`; re-run on the merged tree at `f216764`: `.dev/verify/ticket-08/files-transfer-cookie.log` (the cookie path, after the bearer fix) |
| representative transfer | `node packages/gateway/test/file-transfer-evidence.ts --megabytes=16` | 0 | `.dev/verify/ticket-08/transfer-evidence.log` |
| shared UI suite, 167 tests | `pnpm --filter @hepi/ui test` | 0 | `.dev/verify/ticket-08/ui-suite.log` (116 before the client half; `lib/file-seam.test.mjs` is this ticket's case) |
| shared UI typecheck | `pnpm --filter @hepi/ui typecheck` | 0 | |
| whole gateway suite, 362 tests | `node --test packages/gateway/test/*.test.ts` | 0 | `.dev/verify/ticket-08/gateway-suite.log` |
| file surface at the ingress seam, 9 tests | `node --test packages/gateway/test/ingress-files.test.ts` | 0 | `.dev/verify/ticket-08/ingress-files-encoded.log` — the added case is the percent-encoded browser path |
| mounted file surfaces under a device bearer, 10 checks | `node apps/web/e2e/ux-file-surfaces.mjs` | 0 | `.dev/verify/ticket-08/file-surfaces-bearer.log` |
| the review's own repros, re-run | `node /tmp/ticket08-review-19b2c59-seam.mjs`, `node /tmp/ticket08-review-19b2c59-browser.mjs` | 0 | `.dev/verify/ticket-08/review-repro-seam.log`, `review-repro-browser.log` |
| changed packages, including the client half | `pnpm verify:changed --base=integration/client-app` | 1 — `check-docs` is the only failing step (the same 12 pre-existing links under `.scratch/`, none in a file this ticket touched); changed typecheck, workspace tests, Web unit (54 tests) and script tests (51 tests) and entrypoints 0 | `.dev/verify/2026-10-18T02-38-24-645-verify-changed/verify.json` at `b236f70`, clean (the same run at `c80657f` before the record-only commit: `.dev/verify/2026-10-18T02-34-15-881-verify-changed/verify.json`) |
| fresh port `be2712f`: file surface at the ingress seam + bounded multipart reader, 15 tests | `node --test packages/gateway/test/ingress-files.test.ts packages/gateway/test/multipart.test.ts` | 0 | `.dev/verify/ticket-08-fresh/ingress-multipart.log` |
| fresh port `be2712f`: the client's file seam, 6 tests | `node --test packages/ui/src/lib/file-seam.test.mjs` | 0 | `.dev/verify/ticket-08-fresh/file-seam.log` |
| fresh port `be2712f`: mounted file surfaces under a device bearer, 10 checks | `node apps/web/e2e/ux-file-surfaces.mjs` | 0 | `.dev/verify/ticket-08-fresh/ux-file-surfaces.log` |
| fresh port `be2712f`: workspace typecheck | `pnpm -r typecheck` | 0 | `.dev/verify/ticket-08-fresh/typecheck.log` |
| fresh port `be2712f`: port identity and whitespace | `git diff --stat impl/client-app-08` (empty), `git diff --check e257e3d HEAD` | 0 | `.dev/verify/ticket-08-fresh/diff-check.log` |
| fresh port `be2712f`: changed packages | `pnpm verify:changed --base=integration/client-app` | 1 — `check-docs` is the only failing step (the same 12 pre-existing links under `.scratch/`, none in a file this ticket touched); changed typecheck, workspace tests, Web unit, script tests and entrypoints 0 | `.dev/verify/2026-10-18T05-00-53-603-verify-changed/verify.json` at `be2712f`, clean |

### What each run asserts

- **`ingress-files.test.ts`** drives the surface the way a client does: a cookie or a device bearer on the ingress, a
  real Backend, and two real gateways — this machine's filesystem and the in-process SSH host of `fake-ssh.ts`. It
  covers the listing and nested listing, a text preview and its meta, the `@` index in both shapes, an upload of two
  files past the 1 MiB JSON request limit with the pre-flight check before it, the conflict refusal with the names that
  exist, a name that is not one file's own name, a whole download and a `206` range from the host's own reader, a
  percent-encoded name in each of browse, preview, download and upload with an encoded separator, an encoded escape
  refused by the host's confinement and invalid encoding answered `400`, an
  image served as its own bytes, an out-of-range request answered `416`, the SSH workspace's payloads going to the SSH
  host while its browsing answers `501 not_supported` instead of this machine's tree, a batch past the bound refused
  with the bound and nothing written, a download whose reader is paced by its caller and whose host reader is released
  when the caller goes away, the device-bearer branch, an undeclared origin refused `403`, and the named `501`s.
- **`multipart.test.ts`** asserts the reader's own contract: arrival order under the upload field, a declared over-bound
  body refused before it is read, a chunked one counted as it arrives, a caller's refusal ending the request, and a body
  that dies reported as a failure rather than a short file.
- **`apps/web/adapters/files-transfer.test.mjs`** asserts the Web origin's assembly of the same implementation: the
  request shapes the copied explorer sends, the answers the viewer reads, the batch bound refused mid-body, and the
  named `501`s — the contract the deleted Next-private parser used to serve.
- **`apps/web/e2e/files-transfer.mjs`** runs the real client ingress, the real Backend, a real gateway and a real
  workspace, then a headless Chromium on the ingress origin: the page's own login cookie, an `XMLHttpRequest` multipart
  upload the browser builds itself, a 1.4 MB file past the JSON request limit, the pre-flight check and conflict refusal,
  an `<img>` that decodes the uploaded image, a `206` range answered from the host's reader, a download navigation that
  saves the whole file under its own name, the named `501`, and no page error.

### Representative transfer, measured

`node packages/gateway/test/file-transfer-evidence.ts --megabytes=16` drives the ingress, the Backend and the gateway
in one process, so the peak RSS below is the whole stack's:

| Step | Size | Result |
| --- | --- | --- |
| upload, browser form | 16 MiB (the host's `MAX_FILE_BYTES` ceiling) | 98 ms, sha256 matched, peak RSS 336.2 MiB |
| download, paused reader | 16 MiB in 258 chunks | 59 ms, sha256 matched, peak RSS 336.2 MiB |
| range | last 4096 bytes | `206`, bytes matched |
| abandon mid-download | — | host reader released, 0 open handles |
| batch past the bound | 3 × 8 MiB against a 20 MiB bound | `413` naming the bound, nothing written, peak RSS 408.1 MiB |

The RSS figures include the fixture payload the script itself allocates, so they are not a memory claim about a
transfer; what they show is that the transfer does not grow with the file. Native platform memory for the desktop target
is ticket 04's measurement (96 MiB body: 3.06 GB peak with whole-chunk IPC against 225 MB with 1 MiB slices), recorded
in the ticket 04 section above; nothing here re-measures or re-claims it.

### Defects found and fixed in this ticket

The review of `19b2c59` found two more in the client half, both fixed and re-verified at `c80657f`. A markdown body's
local image, and the viewer's first frame, pointed an element at an `/api/files` address on a bearer connection: no
element of an App's document can present a device bearer, so the request was answered `401` and the viewer reported a
failed image before the lease it really has had arrived. `FileSeam.url` now answers an address only where an element's
own request carries the credential — a Web page's cookie — `useFileBytes` starts with none on a bearer connection, the
markdown body reads through that hook and states a refusal in words, and a viewer's load error is cleared when the
address changes. `ux-file-surfaces.mjs` mounts the production `MarkdownBody` and `FileViewer` behind a real bearer
client whose server answers only a request carrying it, and asserts both images are the connection's own leases and that
no file request went out without the credential; the previous code fails it with an unauthenticated read and a failed
image. The second: a browser's percent-encoded path reached the host still encoded, so a name with a space, a Unicode
letter or a `%` could not be browsed, previewed, uploaded or downloaded. `files-surface.ts` now decodes the path once,
where the URL stops being a URL, answers `400` for invalid encoding, and leaves an escape to the host's confinement; the
`ingress-files.test.ts` case above asserts each of those against real files on disk. The third finding — the shared
read-block reader buffers a whole response before it checks its budget — belongs to `packages/session/src/resources.ts`
and was left to its owner; only the seam's own refusal wording changed, to say that a file past the bound cannot be
*shown* here rather than naming a download's native save.

Both download hops waited for a response's `close` event **after** a write reported backpressure. A caller that goes
away mid-download has already closed by then, so the wait never ended and the host reader stayed open until its idle
expiry. `drained()` in `packages/gateway/src/index.ts` and in `apps/server/src/file-relay.ts` now checks
`writableEnded`/`destroyed` before waiting, and the surface carries the caller's own `AbortSignal` to every Backend
call. The paced-download case in `ingress-files.test.ts` fails against the previous code with a host reader still open.

## App shell and packaged artifacts (ticket 15)

The App's production artifact was built, packaged and started from a clean checkout on `workstation` (Linux x86_64, WebKitGTK
2.52.3, Tauri crate 2.12.4 / CLI 2.12.3, Rust 1.96.0, Node 26.5.1, pnpm 12.4.1). Every assertion below runs against the
produced package — the `.deb` extracted into its real installed layout and the packaged binary executed from there —
rather than against the sources that produced it.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| build, provenance and the reproducibility measurement | `node apps/app/scripts/build-artifacts.mjs --label=t15-clean --reproduce` | `2573147` | 0 | `.dev/artifacts/t15-clean/provenance.json` |
| artifact test, 33 assertions | `node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/t15-clean` | `2573147` | 0 | `.dev/artifacts/t15-clean/verify-2026-10-18T02-00-24-869Z/report.json` |
| Rust shell unit tests (4) | `cargo test --manifest-path apps/app/src-tauri/Cargo.toml` | `2573147` | 0 | `cargo test: 4 passed` |
| selected checks | `pnpm verify:changed --base=integration/client-app` | `2573147` | 1 — typecheck, workspace tests, web unit (46), script tests (51) and `check:entrypoints` 0; `check-docs` 1 with only the 12 pre-existing `.dev`/`.pi` links | `.dev/verify/2026-10-18T02-02-47-833-verify-changed/verify.json` |
| re-run on the merged tip: build, provenance, reproducibility | `node apps/app/scripts/build-artifacts.mjs --label=t15-merged --reproduce` | `bbe8baf` | 0 | `.dev/artifacts/t15-merged/provenance.json` |
| re-run on the merged tip: artifact test, 33 assertions | `node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/t15-merged` | `bbe8baf` | 0 | `.dev/artifacts/t15-merged/verify-2026-10-18T02-17-18-760Z/report.json` |
| re-run on the merged tip: selected checks | `pnpm verify:changed --base=integration/client-app` (merge-base `8c5dfb4`) | `bbe8baf` | 1 — same five steps 0 (web unit 49), `check-docs` 1 with the same 12 pre-existing links | `.dev/verify/2026-10-18T02-17-43-071-verify-changed/verify.json` |
| re-run after merging ticket 13's tip: artifact test, 33 assertions | `node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/t15-merged2` | `261e0aa` | 0 | `.dev/artifacts/t15-merged2/verify-2026-10-18T02-28-00-665Z/report.json` |
| re-run after merging ticket 13's tip: selected checks | `pnpm verify:changed --base=integration/client-app` (merge-base `e257e3d`) | `261e0aa` | 1 — same five steps 0, `check-docs` 1 with the same 12 pre-existing links | `.dev/verify/2026-10-18T02-28-17-435-verify-changed/verify.json` |

The artifact test holds, by name: package contents (binary, desktop entry, icon), `Architecture: amd64`, the WebKitGTK
dependency, resolved shared libraries, the absence of `HEPI_AUTH_TOKEN` / `HEPI_INGRESS_SERVICE_TOKEN` /
`HEPI_WEB_LOGIN_TOKEN` / `serviceToken` and of `next/dist/compiled` in the packaged binary, a cold start with no
connection (the page reports the configuration surface), a cold start from a stored connection (the page reports the
workbench and a fixture Gateway records `GET /api/descriptor` with `Origin: tauri://localhost` and the stored device
bearer), the first-run form typed into the real window with `xdotool` and the same request arriving from the typed
values, and a cold start after `--forget` returning to the configuration surface. Each packaged run is also checked
against the binary's own build stamp, so the artifact names the source it was built from.

The merge of `integration/client-app` (`8c5dfb4`, tickets 09 and 14) was re-run rather than assumed: the same 33
assertions hold, the executable is byte-identical across two builds (sha256 `a36ce451…73956e`), and the package and
binary checksums move with the shared UI (`7a6392e1…2d16` / `a36ce451…73956e`). The same re-run was repeated after
integration advanced again to `7d910e0` (ticket 13): `261e0aa`, 33 assertions, executable `7f69c164…2701d` identical
across two builds, package `d5d40739…49b01`.

**Reproducibility is measured, not asserted.** Two builds of the same revision produce a byte-identical executable
(sha256 `dc4f2c66…a4c48f` at `2573147`, `a36ce451…73956e` at `bbe8baf`). The `.deb` checksums differ (`1c038ff4…` against `fb2e13bb…`): the Tauri
bundler writes the bundling time into the package's member mtimes and does not read `SOURCE_DATE_EPOCH`. Extracting both
packages and comparing them file by file shows identical payloads, which is why the executable is the compared artifact.

**First load, recorded.** The App's first-load JS is 3 226 272 B and its CSS 122 845 B; the mermaid/cytoscape renderer is
already a separate dynamic chunk (662 087 B + 434 616 B) and is not part of first load. No rendering structure was
rewritten for this ticket.

Not evidenced, and not claimed: any mobile artifact (no Android SDK, `adb`, device or emulator on this host, and no
unattended provisioning was attempted), and a system `dpkg -i` install (it needs root; the package's real installed
layout is extracted and executed instead, and the report records `systemInstall: false`). A system `dpkg -i` onto a real
host remains undone for the same reason, but the weaker claim was replaced with a stronger one at `bdc8746`: the package now
goes through a **real dpkg transaction** in a private root over a read-only host bind, the packaged binary executes from the
layout dpkg itself wrote, and the report records both `systemInstall: false` and the transaction's own outcome under
`offlineDpkgInstall`. The App has not been run
against a real Gateway and Backend in this ticket — the fixture ingress is the other end — and the deployed entry,
static-Web serving and `/api` fallback belong to ticket 16.

## Web install, offline and page notifications (ticket 14)

The Web host's install surface and the page's completion notice, on the Vite build. All checks ran at revision
`7516034` (clean tree; integration tip `47f501c` merged), logs under `.dev/verify/ticket-14/`.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| workspace typecheck | `pnpm -r typecheck` | `7516034` | 0 | `.dev/verify/ticket-14/typecheck.log` |
| workspace tests | `pnpm -r test` | same | 0 | `.dev/verify/ticket-14/workspace-tests.log` |
| Web unit suite, 49 tests | `node scripts/test-web-unit.mjs` | same | 0 | `.dev/verify/ticket-14/web-unit.log` |
| worker rules and registration, 10 tests | `node --test apps/web/src/service-worker.test.mjs apps/web/src/pwa.test.mjs` | same | 0 | `.dev/verify/ticket-14/web-pwa-unit.log` |
| push retirement and notice delivery, 6 tests | `node --test packages/ui/src/lib/push-client.test.mjs packages/ui/src/lib/browser-notifications.test.mjs` | same | 0 | `.dev/verify/ticket-14/ui-notifications.log` |
| App bundle boundary, 2 tests | `node --test apps/app/test/bundle-boundary.test.mjs` | same | 0 | `.dev/verify/ticket-14/app-boundary.log` |
| Web static build | `pnpm --filter @hepi/web build` | same | 0 | `.dev/verify/ticket-14/web-build.log` |
| fresh-browser PWA seam, 24 checks | `node apps/web/e2e/ux-pwa-offline.mjs` (`pnpm --filter @hepi/web test:pwa-offline`) | same | 0 | `.dev/verify/ticket-14/pwa-offline.log` |
| capability three-state, retired push and trust, 17 checks | `node apps/web/e2e/ux-capability-trust.mjs` | same | 0 | `.dev/verify/ticket-14/capability-trust.log` |
| panel ingress, 18 checks (ticket 11's seam, re-run) | `node apps/web/e2e/ux-panel-ingress.mjs` | same | 0 | `.dev/verify/ticket-14/panel-ingress.log` |
| selected checks | `pnpm verify:changed --base=integration/client-app` | same | 1 | `.dev/verify/ticket-14/verify-changed.log` — changed-typecheck, changed-test and web-unit 0; `check-docs` 1 with the same 12 pre-existing `.dev`/`.pi` links (0 outside those prefixes) |

The browser seam loads the real production build in a fresh Chromium profile: the browser parses the linked manifest with
no error and the name, start URL, standalone display and both 192/512 PNG icons; the versioned worker activates and
controls scope `/`; no path from the retired Next worker is in any cache; Vite's hashed asset is kept and still served
while the server is unreachable; two API reads reach the server twice with no `/api/` path in any cache, and offline a
conversation read is refused rather than answered from a cache; an unreachable ingress answers the offline page. It does
not assert the browser's install prompt, which headless Chromium cannot accept.

The worker's own rules are Node tests against a worker-shaped global scope: install precaches only static Web paths and
claims no API; a navigation asks the network first and falls back to the offline page; API, foreign and `sw.js` requests
are left alone; hashed assets are cache-first with the cold miss stored without blocking the response; a clicked notice
opens the target the page stated and only on this origin. `push-client.test.mjs` states the retirement as a property of
the executable sources (no `/api/push/` request, no `PushManager`, no `setupPushSubscription`) and of the worker (no
`push`, `sync` or `periodicsync` handler). `browser-notifications.test.mjs` covers the notice's attention rule and its
two delivery paths.


## The page's one terminal stream (ticket 09)

The stream is held by two seams: the real HTTP/SSE integration test (a real client ingress, a real Backend and a real
gateway process, plus an SSH-composed gateway, with the local Python helper as its transport) and the browser fixture,
which mounts the production `TerminalFanIn`, `TerminalPanel` and terminal client through esbuild in a real Chromium.
All checks ran at revision `8c5dfb4` (clean tree, the ticket 05 merge included); logs are under
`.dev/verify/client-app-05-09-integration/`.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| terminal relay, bearer, two hosts and cancellation, 4 tests | `node --test packages/gateway/test/ingress-terminal.test.ts` | `8c5dfb4` | 0 | `.dev/verify/client-app-05-09-integration/gateway-suite.log` |
| whole gateway suite, 338 tests | `node --test packages/gateway/test/*.test.ts` | same | 0 | same |
| fan-in reader, connection identity, hook lifecycle and panel writer (161 tests, this file included) | `node --test` over every `packages/ui/src/**/*.test.mjs` | same | 0 | `.dev/verify/client-app-05-09-integration/ui-suite.log` |
| browser fan-in seam, 26 checks | `node apps/web/e2e/ux-terminal-fan-in.mjs` | same | 0 | `.dev/verify/client-app-05-09-integration/ux-terminal-fan-in.log` |

The browser seam drives both credential branches against the real routes: two mounted tabs hold **one** live stream whose
query names both tabs; the cookie branch states no authorization header and lets the browser present its own HttpOnly
cookie; the bearer branch states exactly one header, has no cookie jar and never puts the credential in a URL; a frame
reaches its own tab and not the other; a reopen names that tab's own cursor; releasing the last tab aborts the request.
Its third case is the one that matters for the effect-owned stream: the same fixture is served twice, once from a
production React bundle and once from a development one, and in the development case the fixture counts its own effect
runs and fails unless the replay really happened (2 runs) before it holds the page to one live stream. The production
bundle does not replay effects, so that half cannot be shown there.

The StrictMode defect it was written for is real and was red before the fix: with the memoized hook, the development case
timed out waiting for one live stream after the replay with all seven streams closed. Reverting the hook now also fails
the Node lifecycle test, but for the harness's own reason — the test's React shim provides `useState` and `useEffect` and
not `useMemo`, which the old implementation needs — so the browser case, not the Node one, is the evidence that the original
bug is gone. What is still unproven here: a real Tauri/WebKitGTK or mobile host (ticket 04's Android half), and the retired
Next entry's own terminal scenarios, which spawn `next start` and belong to tickets 15–17.

## Client app integration: tickets 06, 08, 11 and 15 on one tree (2026-10-18)

The four reviewed branches were merged sequentially into `integration/client-app` from `e257e3d`: ticket 06
(`fix/client-app-06-fresh` `efdd9ae`), ticket 08 (`fix/client-app-08-fresh` `8edf8d3`), ticket 11
(`fix/client-app-11-cache-fresh` `9625896`) and ticket 15 (`impl/client-app-15` `758dcf0`), each as its own merge
commit (`837aa1d`, `c2e691e`, `fbcac7d`, `e537a95`). One conflict appeared, in this file: ticket 08's and ticket 15's
sections were both appended at the same place, and both are kept verbatim. The merged tree carries a seam fix of its own
(`a0f2c01`, below).

`pnpm install --frozen-lockfile` ran first (exit 0): the worktree had no `node_modules`, and ticket 08 adds
`@hepi/gateway` and `busboy` to the Web importer's dependencies.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| workspace typecheck | `pnpm -r typecheck` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/workspace-typecheck.log` |
| workspace tests | `pnpm -r test` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/workspace-tests.log` |
| shared UI suite, 184 tests | `pnpm --filter @hepi/ui test` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/ui-suite.log` |
| Web unit suite | `node scripts/test-web-unit.mjs` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/web-unit.log` |
| Web adapters | `cd apps/web && node --test adapters/*.test.mjs` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/web-adapters.log` |
| file surface at the ingress seam + bounded multipart reader, 15 tests | `node --test packages/gateway/test/ingress-files.test.ts packages/gateway/test/multipart.test.ts` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/ingress-multipart.log` |
| ticket 06's named seam, 7 tests, and its real-HTTP ingress seam, 4 tests | `node --test packages/ui/src/lib/workspace-api.test.mjs packages/ui/src/lib/workspace-api.http.test.mjs` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/workspace-api.log` |
| ticket 08's client file seam, 6 tests | `node --test packages/ui/src/lib/file-seam.test.mjs` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/file-seam.log` |
| ticket 11's connection seam, 5 tests | `node --test packages/ui/src/client.test.mjs` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/client.log` |
| ticket 11's composer lifecycle, 22 tests | `node --test packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/lifecycle.log` |
| ticket 06's browser seam, real SessionSidebar / NewProjectDialog / DirectoryPicker | `node apps/web/e2e/ux-sidebar-ingress.mjs` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/sidebar-ingress.log` |
| ticket 08's mounted file surfaces under a device bearer, 10 checks | `node apps/web/e2e/ux-file-surfaces.mjs` | `a0f2c01` | 0 | `.dev/verify/merge-client-app-3/file-surfaces.log` |
| selected checks | `pnpm verify:changed --base=e257e3d` | `a0f2c01` | 1 — `check-docs` only (the 12 pre-existing `.scratch/` links; the same set at `e257e3d`, compared in `.dev/verify/merge-client-app-3/check-docs-base.log` and `check-docs-tip.log`) | `.dev/verify/2026-10-18T05-30-05-618-verify-changed/verify.json` (`dirty: false`) |

Two integration defects were found and are recorded rather than carried: the ticket 06 browser fixture did not state the
`files` seam ticket 08 made part of `WorkbenchConnection`, so `apps/web` typecheck failed at the fixture; it now derives
one from the same client. And `client.ts`'s combined request signal was released when `fetch` resolved, so a body that
arrived after the headers could no longer be aborted by disposal or by its caller; the signal now lives until the body is
read (red and green in `.dev/verify/merge-client-app-3/red-client-signal.log` and `green-client-signal.log`). Neither defect changed a ticket's
semantics, and the tickets they belong to are not marked resolved here: 06 stays reopened until ticket 16's cutover, 11
still awaits the Web/App entry cutover, and 15 keeps its Android and system-install limits.

## Client app integration: SSH workbench 01 and child recovery 01 on one tree (2026-10-18)

Two reviewed PASS branches were merged sequentially into `integration/client-app` from the tip `80608d6`, each as its
own `--no-ff` `ort` merge commit: `ssh-remote-workbench` ticket 01 (`impl/ssh-workbench-01` `bd80fc2`) as `55a594e`, and
`child-task-recovery` ticket 01 (`impl/child-recovery-01` `c8ed522`) as `01901bc`. Both branches had the then-reviewer
tip `95f9257` as their merge base, which is also an ancestor of `80608d6`, so both were confirmed by
`git merge-base --is-ancestor 95f9257 <tip>` (exit 0) before merging. `git merge-tree --write-tree` reported no conflict
for either before it was run, and neither merge needed a hand resolution: the single overlapping path was
`docs/migration-status.md`, where the HEAD subtree-control paragraph (lines 176-180) and the branch's file-surface
paragraph (lines 46-53) sit ~130 lines apart and both survived verbatim.

The merged tree carries the reviewed source unchanged, so the branch evidence stands and was not repeated:
`git diff bd80fc2..01901bc -- packages/gateway` and `git diff 80608d6..01901bc -- apps/server/src` are both empty
(`git diff c8ed522..01901bc -- apps/server/test/recovery-capability-audit.test.ts` likewise). The only evidence re-run
was at the changed boundary — the merged tree itself:

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| SSH workbench seam + its two neighbours (22 tests) | `node --test packages/gateway/test/ssh-workbench.test.ts packages/gateway/test/ingress-files.test.ts packages/gateway/test/startup.test.ts` | `01901bc` | 0 | `.dev/verify/merge-client-app-8/ssh-workbench-seam.log` |
| Recovery audit assertions (3 tests) | `node --test apps/server/test/recovery-capability-audit.test.ts` | `01901bc` | 0 | `.dev/verify/merge-client-app-8/recovery-audit.log` |
| selected checks | `pnpm verify:changed --base=80608d6` | `01901bc` (`dirty: false`) | 1 — `check-docs` only | `.dev/verify/2026-10-18T10-34-50-879-verify-changed/verify.json` |

`verify:changed` selected the three affected packages (`@hepi/gateway`, `@hepi/server`, `@hepi/web`) and reports
`changed-typecheck` 0, `changed-test` 0 (gateway 381, server 467) and `web-unit` 0 (52 tests); see
`changed-typecheck.log`, `changed-test.log` and `web-unit.log` in that report directory.

`check-docs` exits 1 on the **12** pre-existing broken relative links, and it is the same set: a detached, clean
`80608d6` worktree (`.dev/baselines`-style, at `/tmp/base-80608d6`) reports 12 broken in 351 files, the merged tree
reports 12 in 360 (the 9 new ticket files are all clean), and the name-qualified broken-line sets are byte-identical —
`broken-base-80608d6.txt` vs `broken-tip-final.txt` in `.dev/verify/merge-client-app-8/`, `diff` exit 0. None names a
file either ticket touched. That baseline failure stays recorded, not repaired here.

After the two merges, the documentation was reconciled in `docs` (`git grep` for the claim, not the file set): three
tracked guides stated "an SSH gateway serves no workbench" as current truth, which the merged source falsifies —
`docs/migration-status.md` (fixed in `bd80fc2` itself), `.scratch/client-app/issues/08-files-and-workbench-streaming.md`
and `.scratch/durable-harness/issues/07-workbench-adaptation.md`. The latter two are now dated statements pointing at
[the SSH workbench](workbench.md#the-ssh-workbench); neither ticket is reopened, and PTY, worktree writes, live watch and
DOCX preview remain outside both. `.scratch/capability-integration/*` and `.scratch/development-audit/*` carry the same
sentence as scope history and audit findings for a completed effort; they are left as written. No graph rebuild, no
deploy, no build on `remote-host`, and no main-checkout file was touched.

## Client app integration: provider connection ticket 01 (2026-10-18)

`impl/provider-connection-01` `db1470f` merged into `integration/client-app` as `e406971` (`--no-ff`, `ort`, second
parent `db1470f`, no conflict). The branch was ahead of the integration tip in one direction only: `b51926b` is an
ancestor of `db1470f` (the branch merged the integration line at `e561039`, which is `406573b` + `b51926b`), so the
merge adds exactly the branch's four commits — `619e66a` the surface, `406573b` the lock/`wx` fix, `e561039` that
integration merge, `db1470f` the ticket evidence — and moves nothing else.

Source equivalence needs no diff-by-path argument: `git diff db1470f..e406971` is empty and both trees hash
`044541b8b8dacb1b7e133e9ea474e46d41978db1`. The merged tree *is* the reviewed tree, so the branch's
`e561039` evidence (gateway 396, server 467, `verify:changed` with `check-docs` only failing) stands and was not
repeated at package level. Two things did change for this worktree:

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Dependency materialisation (new `proper-lockfile` + its types) | `pnpm install --frozen-lockfile --prefer-offline` | `e406971` | 0 (+1 package, 0 tracked files changed) | `.dev/verify/merge-client-app-9/pnpm-install.log` |
| Provider seam + startup dual-host composition (21 tests) | `node --test packages/gateway/test/provider-auth.test.ts packages/gateway/test/startup.test.ts` | `e406971` | 0 | `.dev/verify/merge-client-app-9/provider-startup-seam.log` |
| Gateway typecheck against the new dependency | `pnpm --filter @hepi/gateway typecheck` | `e406971` | 0 | `.dev/verify/merge-client-app-9/gateway-typecheck.log` |
| Whole tree | `pnpm verify:changed --base=b51926b` | `e406971` (`dirty: false`) | 1 — `check-docs` only | `.dev/verify/2026-10-18T11-24-28-738-verify-changed/verify.json` |

The install was required, not cosmetic: the merge is the first time this worktree saw `proper-lockfile` in
`packages/gateway/package.json`, and the store had the runtime but not the `@types` link. The run itself then
escalated to the whole workspace — `verify:changed` reports `tests: full (unrecognized changed files: pnpm-lock.yaml)` —
so `pnpm -r typecheck` and `pnpm -r test` ran across all 8 packages and both exit 0 (gateway 396, server 467, ui 193,
session 52, protocol 51, client 10, app 9; `web-unit`, `script-tests` and `check-entrypoints` 0 too). `check-docs` exits
1 on the unchanged 12-link baseline, now across 368 files: `merge-client-app-9/broken-tip-provider.txt` diffs empty
against `merge-client-app-8/broken-base-80608d6.txt` (`diff` exit 0). The lock-mode and pi-CLI `ensureFileExists()`
items on ticket 01 stay advisories, recorded and not fixed, as does the one formatting note that `.scratch/
provider-connection/spec.md` ends with a trailing blank line.

What the merge does to the docs is a claim correction, not new behaviour: `docs/architecture.md` now names
`/v1/providers/auth` in the `@hepi/protocol/gateway` surface list beside `/v1/mcp`, and `docs/migration-status.md`'s
"remaining Settings/provider surfaces that answer 501" paragraph says which half of that is no longer true — the host
operation exists on the local gateway, while the browser relay is ticket 02. `docs/client-ingress.md`'s "not served"
table was checked and is **not** changed: those rows are `/api/auth/*` on the Backend-facing side, which still has no
provider route, and ticket 01 explicitly keeps credentials out of the Backend.

## Client app integration: MCP ticket 01 and recovery ticket 02 (2026-10-18)

Two more serial merges, both `--no-ff` with `ort`, neither needing hand resolution, both proven byte-equivalent to
their reviewed tips for the paths each owns:

| Merge | Parents | Reviewed tip | Preview | Merged tree facts |
| --- | --- | --- | --- | --- |
| `b7c49b3` (MCP 01) | `926341c` + `0a98dfa` | `0a98dfa` | `merge-tree` `c8473e0`, exit 0 | gateway **410**, server 467, ui 193, session 52, protocol 51, app 9; web-unit 52 |
| `2ff97b0` (recovery 02) | `b7c49b3` + `3e69260` | `3e69260` | `merge-tree` `a9e3115`, exit 0 | gateway **411**, server **468**; web-unit 52 |

Merge order mattered for one reason: the recovery branch carried `926341c` (its `a0bff56`) but **not** the MCP merge, and
the MCP branch carried `b51926b` but not provider work. So the first of these two merges created a new combination of
source that no branch ever ran, which is the only justification for the runs below — not a broader retest.

**What actually intersected.** `packages/protocol/src/gateway.ts` is the sole code collision in the pair: provider ticket
01 appended `ProviderAuth*`, MCP ticket 01 appended `MCP_INVOKE_*`/`McpToolCall*`, at disjoint tails of one file, and the
merged copy is a strict union (`diff` removes 0 lines against the MCP tip's copy; removes 1 — the sign-out union member
MCP extends — against the provider tip's). `docs/migration-status.md` took three separate insertions (recovery ~202, MCP
~421, provider ~502) with no overlap. Ownership never crossed: `control.ts` + `src/mcp/*` are MCP-only, `index.ts` +
`startup.ts` + `provider-auth.ts` provider-only, `environment.ts` recovery-only, so the 9-argument
`GatewayRpcServer`/`startGateway` composition and both `profile === undefined` local-only wirings survive untouched —
`git diff --exit-code` proves it per path group, and after the second merge `git diff --name-only b7c49b3 -- packages apps`
is exactly the three recovery files.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| MCP-side seam + provider composition | `node --test packages/gateway/test/mcp-invocation.test.ts packages/gateway/test/control.test.ts packages/gateway/test/provider-auth.test.ts packages/gateway/test/startup.test.ts` | `b7c49b3` | 0 (63/63) | `.dev/verify/merge-client-app-10/combined-gateway-seam.log` |
| Typecheck on the union | `pnpm --filter @hepi/{gateway,protocol,session} typecheck` | `b7c49b3` | 0 / 0 / 0 | `.dev/verify/merge-client-app-10/{gateway,protocol,session}-typecheck.log` |
| MCP merge, whole changed tree | `pnpm verify:changed --base=926341c` | `b7c49b3` (`dirty: false`) | 1 — `check-docs` only | `.dev/verify/2026-10-18T11-39-14-316-verify-changed/verify.json` |
| Recovery-side seams | `node --test packages/gateway/test/execution.test.ts …` (5 files) and `node --test apps/server/test/execution-scope.test.ts` | `2ff97b0` | 0 (76/76) and 0 (2/2) | `.dev/verify/merge-client-app-11/combined-gateway-seam.log`, `server-execution-scope.log` |
| Recovery merge, whole changed tree | `pnpm verify:changed --base=b7c49b3` | `2ff97b0` (`dirty: false`) | 1 — `check-docs` only | `.dev/verify/2026-10-18T12-27-48-115-verify-changed/verify.json` |

Counts reconcile arithmetically, which is the cross-check that no suite silently stopped running: 396 (provider tip) + 14
MCP (10 invocation, 4 new control) = **410**, +1 recovery execution case = **411**; server 467 + 1 recovery model-seam
case = **468**, the number ticket 02 recorded at its own tip. `verify:changed` scoped the recovery run to
`@hepi/server, gateway, web` (a source-only change, no manifest, so no full-workspace escalation) while the MCP run
selected seven packages — including `web` and `ui` — because that merge moved `protocol`.

`check-docs` exits 1 on the same **12** pre-existing links at both tips: 376 files after the MCP merge, and
`.dev/verify/merge-client-app-10/broken-tip-mcp.txt`, `merge-client-app-11/broken-tip-recovery.txt` and
`merge-client-app-11/broken-final.txt` each diff empty against the `80608d6` baseline
(`merge-client-app-8/broken-base-80608d6.txt`). Still recorded, not repaired.

Provider ticket 01's two advisories and its trailing-blank-line note stand unchanged. No graph rebuild (coordinator runs
the integrated batch), no deploy, no build on `remote-host`, no push, no main-checkout file touched. Ticket 01 (MCP) and
ticket 02 (recovery) both carry their merge section in-place; `docs/architecture.md` and `docs/migration-status.md` needed
no further edit because the MCP surface list and the 501 paragraph already stated both halves correctly.


**Ticket 02 (Web auth relay) was specified against the surface this line required** — the current ingress plus
`packages/ui` only, no Next BFF route — and it landed that way at `bbd0d59` (see the section below for this batch): the
shared answer contract is `packages/ui/src/lib/provider-auth.ts`, the host-local half is
`packages/gateway/src/ingress/providers.ts` dispatched beside `handlesMcpRoute` over one configured host service, and
`docs/client-ingress.md` now carries a *host-local provider credentials* section instead of the old "not served" rows for
`/api/auth/providers` and `/api/auth/api-key/:id`. Credential transport stays caller→local-gateway on
`POST /v1/providers/auth`; the Backend gets no route and no value, which is what ticket 05 checks at system level.


## Client app integration: provider connection ticket 02 (2026-10-18)

`impl/provider-connection-02` relayed the provider credential surface on the client ingress and wired Settings › Models to
it. The branch starts from the integration tip `926341c`, so ticket 01's host operation was already its own; the work here
is the ingress half (`packages/gateway/src/ingress/providers.ts`, dispatched from the host-scoped branch of
`packages/gateway/src/ingress/index.ts`), the panel half (`packages/ui/src/lib/provider-auth.ts` and its consumer
`ModelsConfig.tsx`), one seam test per package, and the browser driver extension.

The relay reuses the **existing** host-service configuration instead of adding variables: one local gateway owns both
`mcp.json` and this account's `auth.json`, so a second pair of settings could only drift or name a different machine for the
credentials. Provider sign-in stays the deployment's named limit (`/api/auth/login/:id`, `/api/auth/logout/:id`), and the
panel asks that route before offering the control, so nothing opens an event stream whose only possible answer is a 501.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Selected gates (typecheck + tests for app, server, web, gateway, ui; web-unit; docs) | `node scripts/verify.mjs --profile=changed --base=integration/client-app` | `558c9fc` (`dirty: false`) | 1 - `check-docs` only | `.dev/verify/provider02-merged/verify.json` |
| Gateway seam, 6 tests: list/set/read-back/remove, refusal codes, no host configured, host without the capability, unreachable host, Backend receives no credential | `node --test packages/gateway/test/ingress-providers.test.ts` | `558c9fc` | 0 | `.dev/verify/provider02-merged/ingress-providers.log` |
| Panel contract, 5 tests | `node --test packages/ui/src/lib/provider-auth.test.mjs` | `558c9fc` | 0 | `.dev/verify/provider02-merged/provider-auth-ui.log` |
| Browser seam: set/list/remove cycle, masked hint only, one request body carrying the raw key, no browser storage, sign-in withheld | `pnpm --filter @hepi/web test:panel-ingress` | `558c9fc` | 0 (PASS) | `.dev/verify/provider02-merged/browser-panel-ingress.log` |
| Capability three-state unchanged beside the new gate | `pnpm --filter @hepi/web test:capability-trust` | `558c9fc` | 0 (PASS) | `.dev/verify/provider02-merged/browser-capability-trust.log` |

Counts from `changed-test` on the merged tree: gateway 417, server 468, ui 198, app 9, 0 failures; `web-unit` 52/52.
`check-docs` exits 1 on the **unchanged** 12-link baseline across 376 files: the sorted `BROKEN` set at `558c9fc`
(`.dev/verify/provider02-merged/broken-tip.txt`) diffs empty against the `integration/client-app` tip's own set. The anchor
links this record's ticket added to `docs/client-ingress.md` resolve.

Before the merge one gateway run reported `a revoked device credential ends an MCP operation that is in flight` failing on an
extra recorded `/` host call. It passes isolated (6 repeats), in three whole-suite runs, and in `changed-test` on the merged
tree that carries the MCP cancellation work, so it is load timing inside the parallel suite rather than a defect in this
change. Recorded, not chased.

The integration merge brought MCP conversation-tools ticket 01 and child-task-recovery ticket 02 into the branch; the
combined-seam run above is their re-verification at this revision - no separate implementation loop was started for them.

The source this ticket delivers is `558c9fc` (ticket 01's host operation plus `6b51881`'s relay, merged with
`integration/client-app` `1873d24`); the gates were re-run at `3fb29af`, whose `packages` and `apps/web` trees are
identical to it, and every commit after that edits only this record and the ticket. `3fb29af` ran the selected gates
(`.dev/verify/provider02-head/verify.json`, `dirty: false`): `changed-typecheck`, `changed-test` (gateway 417, server 468, ui 198, app 9, 0 failures) and `web-unit`
(52/52) all exit 0, `check-docs` fails on the identical 12-link baseline (`provider02-head/broken-head.txt` diffs empty
against the integration tip's set), and `pnpm --filter @hepi/web test:panel-ingress` still PASSes
(`provider02-head/browser-panel-ingress.log`). So the seam table above is the record for the delivered source and that run
binds it to the revision the branch carries.

## Client app integration: four serial merges onto the cutover docs (2026-10-18)

Reviewer-approved work landed on `integration/client-app` in four `--no-ff` merges, in the order
`ce415af → 0b96176 → 6b9341e → 1b34c6e`, each from its own branch and each previewed with `git merge-tree --write-tree`
before being run. Final integrated **source** tip: **`bbd0d59da329e4cdddcc41e49104ba39c4a2f748`**; the evidence commits that
follow this section move the branch tip but change no file under `packages` or `apps` (`git diff --exit-code bbd0d59 HEAD --
packages apps` exits 0), so nothing re-runs for them.

| # | Merge | Parents | Reviewed source | Preview tree |
| --- | --- | --- | --- | --- |
| 1 | `afbe2e9` | `1873d24` + `ce415af` | `ce415af` (deployment docs, live cutover record) | `74d7979`, exit 0 |
| 2 | `2cc7d0d` | `afbe2e9` + `0b96176` | `4b45f60` source, gates at `a4487a3` | `3293de1`, exit 0 |
| 3 | `94e62b1` | `2cc7d0d` + `6b9341e` | `83a1188` source, gates at `83a1188` | `d69f0dc`, exit 0 |
| 4 | `bbd0d59` | `94e62b1` + `1b34c6e` | `558c9fc` source, gates at `3fb29af` | `46714bb`, exit 0 |

**Order and why it held.** Merge 1 is documentation-only (the live deployment record for the `1873d24` Web-origin cutover),
so it went first and could not collide with source. All four branches share merge-base `1873d24` pairwise, and the two
source branches that merged the integration tip themselves (`2df33af`, `558c9fc`) already carried it. Zero conflicts: no
hand resolution, no `--ours`/`--theirs` choice anywhere in the batch. The three-way overlaps were
`docs/migration-status.md` (four branches, at ~42/~179/~51/~487/~574/~640/~701 — disjoint insertions) plus
`docs/chat.md` (cutover ~666 vs subtree ~162-194) and `docs/client-ingress.md` (cutover ~5/~22 vs provider ~28/~291/~449);
`ort` took both sides in every case. Verified as content, not assumed: every added line of each branch's diff on those
three files is present at the merged tip (49 added lines, 0 missing) and every removed line is absent (except phrases
that legitimately recur inside a longer replacement paragraph).

**Ownership, which is why nothing was lost at the seams.** `apps/server/src/server.ts` is subtree-only;
`packages/gateway/src/{index.ts,workbench/*}` and the gateway workbench tests are SSH-only;
`packages/gateway/src/ingress/*`, `packages/ui/*` and `apps/web/e2e/*` are provider-only. The single file two source
branches of *this* batch both depended on is `packages/gateway/src/ingress/index.ts` — owned by the provider branch,
consumed by MCP's cancellation work already in the tree — and the merged copy keeps both routes
(`handlesMcpRoute(route) || handlesProviderAuthRoute(route)`, dispatched to `mcp.handle`/`providers.handle` over one host
service). The gateway composition is intact on both sides: 9-argument `GatewayRpcServer`/`startGateway` with
`workbench` mounted for local and SSH (`profile === undefined` split) and `providers` as argument 9, plus
`/v1/providers/auth` in the served-route list.

**Byte identity against the reviewed tips.** Each branch's own non-shared paths are unchanged at the merged tip —
`git diff --exit-code <branch> -- <own paths>`: 7/10, 5/7, 18/19, 19/21 files identical, the differences being exactly the
three shared docs files above. The gate records each branch carries (`420` gateway for SSH at `83a1188`, `417` for
provider at `3fb29af`, `473` server for subtree at `a4487a3`) therefore stay valid for the source, and only the combination
needed new runs.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Gateway combined seam: workbench parity, MCP, provider, execution, startup, control | `node --test packages/gateway/test/ssh-workbench.test.ts packages/gateway/test/workbench.test.ts packages/gateway/test/file-transfer.test.ts packages/gateway/test/ingress-providers.test.ts packages/gateway/test/provider-auth.test.ts packages/gateway/test/startup.test.ts packages/gateway/test/control.test.ts packages/gateway/test/mcp-invocation.test.ts packages/gateway/test/execution.test.ts packages/gateway/test/ingress-files.test.ts` | `bbd0d59` | 0 (124/124) | `.dev/verify/merge-client-app-12/seam-gateway.log` |
| Server subtree projection + recovery model seam | `node --test apps/server/test/subtree-control-projection.test.ts apps/server/test/execution-scope.test.ts` | `bbd0d59` | 0 (7/7) | `.dev/verify/merge-client-app-12/seam-server.log` |
| Panel contract seam | `node --test packages/ui/src/lib/provider-auth.test.mjs` | `bbd0d59` | 0 (5/5) | `.dev/verify/merge-client-app-12/seam-ui.log` |
| All four packages' typecheck | `pnpm --filter @hepi/gateway --filter @hepi/protocol --filter @hepi/ui --filter @hepi/server typecheck` | `bbd0d59` | 0 | `.dev/verify/merge-client-app-12/typecheck.log` |
| Narrow ingress overlap check (`--test-file`, the shared ingress dispatch) | `node scripts/verify.mjs --profile=changed --base=1873d24 --test-file=packages/gateway/test/ingress-mcp.test.ts --test-file=packages/gateway/test/ingress-files.test.ts --test-file=packages/gateway/test/settings.test.ts --test-file=packages/gateway/test/ingress-providers.test.ts --test-file=packages/gateway/test/ingress-terminal.test.ts` | `bbd0d59` | 1 — `check-docs` only; `changed-typecheck` 0, `changed-test-packages-gateway` 0 (32/32) | `.dev/verify/2026-10-18T17-25-22-427-verify-changed/verify.json`, `.dev/verify/merge-client-app-12/narrow-ingress.console.log` |
| Public browser claims over the merged dispatch | `pnpm --filter @hepi/web test:panel-ingress` / `pnpm --filter @hepi/web test:capability-trust` | `bbd0d59` | 0 (PASS) / 0 (PASS) | `.dev/verify/merge-client-app-12/browser-panel-ingress.log`, `browser-capability-trust.log` |
| Whole changed tree | `pnpm verify:changed --base=1873d24` | `bbd0d59` (`dirty: false`) | 1 — `check-docs` only | `.dev/verify/2026-10-18T17-18-53-282-verify-changed/verify.json` |

`verify:changed` selected `@hepi/app, gateway, server, ui, web` and ran their suites in full: **gateway 426**, **server
473**, **ui 198**, app 9, `web-unit` 52, 0 failures. The arithmetic is the cross-check that no suite silently dropped:
gateway 411 (`2ff97b0`) + 9 SSH parity (ssh-workbench 7→12, workbench 3→5, file-transfer 14→16) + 6 provider relay = 426;
server 468 + 5 subtree projection = 473; ui 193 + 5 panel contract = 198. `check-entrypoints` 0 (76 present, 2
known-missing pre-existing, 0 newly missing).

`check-docs` exits 1 on the same **12** baseline links, now over 385 files (+9 from the SSH branch's `.scratch/` records,
all resolving): `.dev/verify/merge-client-app-12/broken-merged.txt` diffs empty against the `80608d6` baseline recorded in
`.dev/verify/merge-client-app-8/broken-base-80608d6.txt`. Recorded, not repaired by this merge.

**Deployed SHA vs integrated SHA, kept distinct.** The live artifacts remain the `1873d24` set recorded in
[the cutover record](records/1873d24-deployment.md) — `release-1873d24/ingress.mjs`, `hepi-backend:1873d24-workstation`,
`release-1873d24`. This batch produced a **new integrated revision `bbd0d59` that is not deployed**: no service was
rebuilt, restarted or cut over here, no build ran on `remote-host`, nothing was pushed, and the acceptance worktree owned by
worker 36 (`.dev/worktrees/client-app-16-acceptance`, `4ffcbf0`) was left untouched. Deploying `bbd0d59` requires the
ordinary release path; until then the provider relay answers the documented unconfigured 503 wherever the host service is
unnamed.

**What this unblocks.** Subtree ticket 03 (Web control), SSH ticket 03 (Web acceptance, agent30) and provider tickets 03
and 04 (agent32) are all `Blocked by` satisfied at `bbd0d59`. Ticket 16's remaining gap is unchanged: the browser journey
over the cut-over origin still needs recording, which is worker 36's acceptance line. `graphify-out/graph.json` was
updated once by this session as the sole merge owner, after all four merges and the evidence edits.

## SSH workbench ticket 03: browser acceptance of a remote workbench (2026-10-19)

Base: `impl/ssh-workbench-03` cut from ticket 02's tip `6b9341e`, then merged over `integration/client-app` `283caa0`
(the provider-relay, subtree-projection and cutover-docs batch) with `docs/verification.md` as the only conflict — the
provider batch's replacement of the "ticket 02 is unblocked" note and this ticket's section both appended at the end, so
the newer note leads and this ticket's section sits after the batch it describes.

Ticket 02 shipped the parity of the two workbench hosts (`impl/ssh-workbench-02` `83a1188`, integrated at
`94e62b1`). Ticket 03 asked the question one host-level contract cannot answer: what a person using the browser file
surfaces against an **SSH workspace on a real gateway** sees when the workbench works, and when it does not. The
acceptance seam is the ingress surface's own fetch (`packages/gateway/src/files-surface.ts`), driven through the real
Backend (`apps/server`) and real client ingress (`createClientIngress` + `GatewayRelay`), with the far side a
`fakeSsh` checkout — so the chain is route → backend → gateway → surface → host with no network or sshd bound, and a
local-workspace twin on the same tree answers the same requests for comparison.

The probe found four things, all on **existing** mounted-SSH paths, and all are fixed here:

1. **A working host's failure was reported as a missing capability.** The surface flattened every workbench refusal
   except two into `501 not_supported` — "this host cannot serve X: it is composed without the workbench surface".
   A mounted host answers `operation_failed` for a file it cannot read (a deletion the surface's own 30 s cache or the
   host's directory cache still remembers), so the ordinary case of that mapping was the false claim. `operation_failed`
   is now `500`; `gateway_offline` is a new answer the transport gives this surface and maps to `503`; the
   `501` is reserved for a host that says `not_supported` itself. That required the wire vocabulary to carry the
   distinction: `WorkbenchResult`'s refusal codes gained `not_supported` (the same shape `WorktreeResult` has
   always had) and `GatewayRpcServer`'s unmounted-workbench fallback answers `not_supported` rather than
   `operation_failed`. A local gateway composed without the surface already said `not_supported` on its own route, so
   its behavior is unchanged.
2. **The payload routes repeated the host's filesystem path to the browser.** A missing file answered the raw errno
   (`ENOENT: no such file or directory, lstat '/tmp/hepi-.../workspace/gone.md'` locally, `... open
   '/tmp/hepi-.../remote/gone.md'` remotely). The code and status are the host's and stay; the *words* now speak the
   path the caller named, and the host's `path` field is dropped (`hostFailure` in `file-transfer.ts`). This is
   the route boundary `docs/architecture.md` already draws: those three payload routes are the browser's byte path,
   while the `/v1/files` RPC keeps the real host path because the execution tools that call it act on it (ADR 0002).
   The asymmetry is provenance, not policy: `hostFailure` rewrites only a code that can only have come from a host,
   and only when it names an absolute path. The file-transfer parity case now compares answer **bodies**, not just
   statuses, and the two hosts word the same failure identically.
3. **A changed-files failure looked like no changes.** `FileExplorer` cleared its list in the catch and showed the
   empty state, so "nothing changed" was indistinguishable from "nothing could be asked" — a failure on a remote host
   reads as an idle workspace. It now states the failure and offers a Retry button. It reuses the existing
   `i18n.retryLoad` and shows the host's own message, so no new locale key was added and no reason was invented; the
   listing error got `role="alert"` with wrapping, since both were announced to nobody.
4. **A byte refusal reached the viewer as a status-shaped sentence.** The viewer's non-OK branch forwarded the host's
   words but dropped its code, so an over-bound preview and a missing file were one string. The code travels with it now.

The second seam is the browser itself. `apps/web/e2e/ux-file-failures.mjs` (`test:file-failures`) bundles a fixture
that mounts the real `FileExplorer` and `FileViewer` and runs in chromium over four workspace states — working,
failing changes, unreachable backend, absent workspace — asserting that a failed changes read is *not* the empty state,
that each failure names its own cause, that the failed panel offers a Retry button, and that one workspace's failure
never becomes a claim about another. What the browser does **not** check: it never clicks Retry, so "the click re-asks
and heals the panel" is source-reviewed only (`packages/ui/src/components/FileExplorer.tsx:1010` — the button's
`onClick` bumps `changesRetryKey`, which `:800` puts in the effect's dependency list, so the effect re-runs
`files.changedFiles`; on success `:797` clears `changesError` and the count effect at `:803` reports the healed length,
neither of which the fixture observes — it mounts `FileExplorer` without `onChangesCountChange`). No test in this
repository clicks it, so the claim stops at presence. It is written to fail on the old silence, and was checked to: restoring
`FileExplorer`'s catch to `setGitFiles([])` makes `test:file-failures` exit 1 on the two assertions that carry it —
"and names which surface failed" and "the panel offers to ask again".

**Baseline comparison.** This ticket changes browser-visible behavior on existing paths, so the before/after is stated
rather than implied:

| Case | Before | After |
| --- | --- | --- |
| Mounted SSH host, read of a file the host cannot open | `501 not_supported` + "composed without the workbench surface" | `500 operation_failed` + "the host could not answer for the file preview" |
| Mounted SSH host, backend cannot reach it | `501 not_supported` + capability claim | `503 gateway_offline` + reachability |
| Unmounted SSH gateway | `501`, but the host said `operation_failed` | `501` and the host says `not_supported` (protocol + `WORKBENCH_CODES` carry it) |
| Download of a missing file | `404` + errno with the host directory | `404` + "no such file in this workspace: /gone.md", no `path` |
| Changes read fails | panel shows "No changes." | panel states the cause and offers Retry (browser-checked: wording + button presence; the click re-asking is source-reviewed only, see above) |
| Viewer byte refusal | message only | message + the host's code |

Commands, on this tree (`cceb0ef`, the branch's own tip before it merged `integration/client-app` `283caa0`; the
gateway figure in the comment is that tree's count, which does not include the provider relay cases — at the merge base
`283caa0` the suite is 426, and the merged tip runs 438):

```bash
cd packages/gateway && node --test --test-concurrency=6 test/*.test.ts        # 438 pass / 0 fail (432 before the
                                                                                     # 283caa0 merge, 420 at ticket 02)
cd packages/gateway && node --test test/ingress-ssh-workbench.test.ts         # 5 pass — the acceptance seam
cd packages/gateway && node --test test/files-surface.test.ts                 # 6 pass — refusal mapping
pnpm --filter @hepi/app --filter @hepi/server --filter @hepi/gateway --filter @hepi/protocol --filter @hepi/session --filter @hepi/ui --filter @hepi/web typecheck
pnpm --filter @hepi/web test:file-failures                                    # 15 checks pass, chromium
pnpm --filter @hepi/web test:files-transfer                                   # 17 checks pass, local workspace
pnpm --filter @hepi/web test:file-surfaces                                    # 10 checks pass, chromium
pnpm verify:changed --base=cceb0ef                                            # all green but check-docs
```

`verify:changed` selected seven packages and ran each suite in full on the pre-merge tip: gateway **431**, server
**468** (its own tip baseline held), app **9**, protocol **51**, session **52**, ui **193**, web-unit **52**, and the app
E2E **52**. After the merge the same seams re-ran here: gateway **438**, ui **198**, protocol **51**, and
`test:file-failures` / `test:file-surfaces` / `test:files-transfer` at 15 / 10 / 17 checks. The only failure is
`check-docs`, exit 1 on the **same 12 pre-existing broken links** diffing empty against the `80608d6` baseline set
under `merge-client-app-*` — recorded, not repaired. This ticket adds no new document.

**Deferred, and why.** Two of ticket 03's bullets cannot be accepted at this seam, and neither is a gap in the work
above:

- **DOCX preview.** `spec.md`'s assumption that `mammoth` "already renders" DOCX is false: the dependency is declared
  in `apps/web` and `packages/ui` and imported nowhere, and `DocumentViewer` states the opposite of an
  implementation — "DOCX preview is not connected; download the file instead". Turning it on means rendering an
  untrusted remote document in the browser: a new failure mode (malformed or hostile archives), new bundle weight, and a
  decision about whether the host or the browser does the work. That is a design decision for the owner, not a checkoff,
  and ticket 02's bound still applies upstream: a remote host's reader cannot open a file past 16 MiB, so a large DOCX
  would fail before it rendered.
- **Live file watch.** Still `501` by decision; no host has an event surface, local or remote.

No boundary bypass was designed or run: no path-confinement, symlink-escape, auth or preflight probe, and no attempt to
make a hostile remote answer succeed. The `path_denied` / `403` row in the acceptance suite is a **statement of the
existing rule** at the seam where a browser is answered (a traversal path is refused in both directions), read from the
source's policy, not a probe against it. The leaked host paths are reported as the consequence of an already-shipped
default, not as a new vulnerability claim.

**Not run here.** `apps/web/e2e/ux-ssh-project.mjs` — the sshd-backed remote-project journey — asserts a `.next/BUILD_ID`
and is stale on this tree, which builds `@hepi/web` to `dist/` under Vite: it fails its own precondition with
"build first" even after a successful `pnpm --filter @hepi/web build`. Unrelated to this change, left untouched; its
remote-UI coverage is supplied here by `test:file-failures`, `test:file-surfaces` and the ingress acceptance suite.

No graph rebuild, no deploy, no build on `remote-host`, no push, no `/home/developer/Documents/dev/hepi-client-app` file
touched, no live service or environment mutated. The ticket 02 branch `impl/ssh-workbench-02` is preserved at its tip
`6b9341e`; this work stands on its own branch `impl/ssh-workbench-03` cut from that tip.

## Client app integration: SSH workbench ticket 03 (2026-10-19)

`impl/ssh-workbench-03` tip `bc6c71a2ce05f30952d3895a528d22d46546fa3b` merged into `integration/client-app` as
**`7807c464d3c303b682923bf8699420ffb49f5273`** (`--no-ff`, `ort`, parents `283caa0` + `bc6c71a`). `git merge-tree
--write-tree` previewed clean as `f58b99d` (exit 0) beforehand; no conflict, no hand resolution. 20 files, +1448/-26.

**The merge is a fast-forward in content, recorded as a merge.** `git merge-base HEAD bc6c71a` = `283caa0` = the
integration tip, because the branch merged integration at `ed27c21` first; and `git diff --exit-code bc6c71a HEAD` exits 0
at the merged tip, so the integrated tree is byte-identical to the reviewed tip. The open question was only whether the
reviewed tree still passes *in combination* — it does, with one pre-existing flaking gate named below.

Preserved from the previous batch, checked rather than assumed (`git diff --exit-code 283caa0 HEAD -- …`, each exit 0):
`apps/server`, `apps/app`, `apps/web/src`, `packages/session`, `packages/gateway/src/ingress`,
`packages/gateway/src/startup.ts`, `packages/ui/src/lib`, `packages/ui/src/components/FileViewer.tsx` — so provider 02
relay dispatch (`ingress/index.ts:439` and `:471`), the 9-argument `GatewayRpcServer`/`startGateway` composition with
`providers` as argument 9, ticket 02's SSH parity suites and the `/v1/providers/auth` served-route entry all survive
unchanged. `git diff --name-only 283caa0..HEAD` is exactly the branch's own 20 files.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Gateway suite, deterministic (3 repeats) | `cd packages/gateway && node --test --test-reporter=tap test/*.test.ts` | `7807c46` | 0 x3 (438/438 each) | `.dev/verify/merge-client-app-13/gateway-serial-1.log` … `-3.log` |
| Combined seam: this ticket plus the surfaces it now shares a process with | `cd packages/gateway && node --test test/files-surface.test.ts test/ingress-ssh-workbench.test.ts test/file-transfer.test.ts test/ssh-workbench.test.ts test/workbench.test.ts test/ingress-files.test.ts test/ingress-providers.test.ts test/provider-auth.test.ts test/startup.test.ts test/control.test.ts test/mcp-invocation.test.ts test/execution.test.ts test/ingress-terminal.test.ts` | `7807c46` | 0 (140/140) | `.dev/verify/merge-client-app-13/seam-gateway.log` |
| This ticket's three gateway files alone | `node --test test/ingress-ssh-workbench.test.ts`, then `test/files-surface.test.ts`, then `test/file-transfer.test.ts` | `7807c46` | 0, 0, 0 (5, 6, 17) | this run, TAP counts |
| Server (consumes the refusal codes this ticket extends) | `cd apps/server && node --test --test-reporter=tap test/*.test.ts` | `7807c46` | 0 (473/473) | `.dev/verify/merge-client-app-13/seam-server.log` |
| UI suite (`FileExplorer` changed) — the package's own gate | `pnpm --filter @hepi/ui test`, i.e. `cd packages/ui && node --test --test-reporter=tap $(find src -name '*.test.mjs' | sort)` | `7807c46` | 0 (198/198) | `.dev/verify/merge-client-app-13/seam-ui-full.log` |
| Protocol / session / app | `node --test` per package | `7807c46` | 0 (51) / 0 (52) / 0 (9) | `seam-protocol-full.log`, `seam-session.log`, `seam-app.log` |
| Seven-package typecheck | `pnpm --filter @hepi/app --filter @hepi/server --filter @hepi/gateway --filter @hepi/protocol --filter @hepi/session --filter @hepi/ui --filter @hepi/web typecheck` | `7807c46` | 0 | `.dev/verify/merge-client-app-13/typecheck.log` |
| Browser seams this ticket owns | `pnpm --filter @hepi/web test:file-failures`, `test:file-surfaces`, `test:files-transfer` | `7807c46` | 0 / 0 / 0 (15 / 10 / 17 checks) | `browser-file-failures.log`, `browser-file-surfaces.log`, `browser-files-transfer.log` |
| Docs and entrypoints | `node scripts/check-docs.mjs`, `node scripts/check-entrypoints.mjs` | `7807c46` | 1 (baseline) / 0 | `check-docs.log`, `check-entrypoints.log` |

`check-docs` reports **12** pre-existing broken relative links, now over 386 Markdown files (+1: the branch's
`.scratch/ssh-remote-workbench/issues/03-findings-and-plan.md`), and
`.dev/verify/merge-client-app-13/broken-merged.txt` diffs empty against the `80608d6` baseline set in
`.dev/verify/merge-client-app-8/broken-base-80608d6.txt`. `check-entrypoints`: 77 present (+1 — the new
`test:file-failures` script and its e2e file; the manifest change adds no dependency, which is why no lockfile install was
needed), 2 known-missing pre-existing, 0 newly missing.

Counts reconcile from the previous tip: gateway 426 -> **438** = +5 (`ingress-ssh-workbench`) +6 (`files-surface`) +1
(`file-transfer` 16 -> 17); ui 198, server 473, protocol 51, session 52, app 9, web-unit 52 unchanged — this ticket adds no
test to those packages, and `FileExplorer`'s new Retry path is covered by the browser seams rather than a unit case.

**Concurrent-runner flake, pre-existing, recorded not repaired.** `pnpm verify:changed --base=283caa0` at the merged tip
exited 1 with step exits `changed-typecheck` 0, `changed-test` 1, `web-unit` 0 (52/52), `check-docs` 1
(`merged-verify-changed.json`, sha `7807c46`, `dirty: false`); `changed-test` failed
`packages/gateway/test/ingress-mcp.test.ts:260` — a revoked device credential ends an MCP operation that is in flight — with
`seen = [/, /v1/mcp]` against the expected `[/v1/mcp]`. That is not this merge: the identical command at base `283caa0`
failed the identical assertion (`.dev/verify/merge-client-app-13/base-concurrent-fail.log`), and neither
`ingress-mcp.test.ts` nor anything it exercises is touched here (`git diff --exit-code 283caa0 HEAD --
packages/gateway/test/ingress-mcp.test.ts` exits 0). Nine concurrent runs at the tip failed twice and seven passed —
the first failure is `.dev/verify/merge-client-app-13/merged-verify-changed-changed-test.log`, kept with its
gate record `merged-verify-changed.json`, and the second is `merged-concurrent-fail-gateway-350.log`; twelve
concurrent runs at the base failed once; six sequential gateway suites at the base passed 426/426 and three at the tip
438/438. Load-sensitive and reproducible at base, so it is recorded rather than attributed, per the convention already in
this file: a run that passes on the rerun at the identical sha is a flake, not a finding against the change.

The mechanism is legible in the assertion and worth the owner's attention: the test's `seen` recorder sits on a bare
`createServer` standing in for the host, and the only requests the reviewed code makes to it are
`fetch(host.origin + "/v1/mcp")` (`ingress/mcp.ts:63`) and `fetch(host.origin + "/v1/providers/auth")`
(`ingress/providers.ts:120`); nothing in `packages/gateway/src` or `apps/server/src` builds a root-path request — the only
`origin + "/"` occurrences in the tree are a browser-side URL base (`packages/session/src/resources.ts:172`) and
static/browser tests. So the recorded root request arrives from outside the reviewed path, and what breaks under load is the
test's own premise (this host answered only what the caller asked) rather than the cancellation behaviour it asserts: its 503
`mcp_unreachable` and post-revocation 401 assertions held in every failing run. The sibling case
`ingress-mcp.test.ts:350` (a client that disconnects ends the host call it started) failed once on the same shape
(`merged-concurrent-fail-gateway-350.log`: 438 cases, 437 pass, 1 fail). Second
flake, same class: `apps/server/test/provider-config.test.ts:80` failed once with `SyntaxError: Unexpected end of JSON
input` from its own endpoint stub parsing a request body whose `end` event arrived without data
(`apps/server/test/provider-config.test.ts:28` parses without checking the body is non-empty;
`merged-concurrent-fail-server-provider-config.log`). Also unchanged by this merge.
Neither is fixed here: both are harness robustness in files this ticket does not own, and a fix needs its own change and
evidence.

**Two wording corrections to the ticket's own record**, made because the branch text was written before the merge: `cceb0ef`
is not ticket 02's merge tip — it is the branch's own pre-merge docs tip (single parent `6b9341e`); ticket 02's
integration merge tip is `94e62b1`, and this ticket's merge base is `283caa0`. And "432 before the merge" was measured on
the branch tree, which did not contain provider 02's 6 relay cases: at `283caa0` the gateway suite is **426**, which is the
number 438 derives from. Corrected in ticket 03 and its spec/README status lines rather than left to be re-derived.

**Boundary.** No deploy, no service restart, no build on `remote-host`, no push (`local/integration-client-app` stays at
`a39dc80`). The live artifacts remain the `1873d24` set in [the cutover record](records/1873d24-deployment.md): the deployed
revision and this integrated revision `7807c46` stay distinct. Worker 30's reconciliation of the SSH approved-scope-7 vs
delivered-3 numbering happens on its own next branch; this merge touches no future ticket file. **MCP ticket 02 is not a
merge candidate in this lane** — its branch tips (`impl/mcp-conversation-02` and `impl/mcp-conversation-03`, both `ebf26df`)
had not been reported review-ready when this was written, so it stayed out. **Superseded the same day:** ticket 02 was
approved on `ebf26df` and merged as `61c2d6692821e1d040ef8d2b3a8d898d0eec440a`; see the next section.
`graphify-out/graph.json` is updated once, after this batch's commits.

## Client app integration: MCP conversation tools ticket 02 (2026-10-19)

`impl/mcp-conversation-02` tip `ebf26df5f9765895864e02318c496d30f68e430a` merged into `integration/client-app` as
**`61c2d6692821e1d040ef8d2b3a8d898d0eec440a`** (`--no-ff`, `ort`, parents `c2d9089` + `ebf26df`). `git merge-tree
--write-tree` previewed clean as `f5be8be81a9aa5c5e604f5deb8ee31fc9a140a16` (exit 0); no conflict, nothing hand-resolved.
16 files, +1501/-22 against the branch merge base `283caa0`. Logs: `.dev/verify/merge-client-app-14/`.

**What the merge had to prove, and what reuse could not prove.** The branch's own clean gate run is bound to `56e38b5`
(`.dev/worktrees/mcp-conversation-02/.dev/verify/2026-10-18T17-52-09-581-verify-changed/verify.json`: sha `56e38b5`,
`dirty: false`, base `283caa0`; `changed-typecheck` 0, `changed-test` 0 = **493 tests / 493 pass / 0 fail**, `check-docs` 1
on its own 12 baseline links). The branch merged integration at `10c5b4b`, whose second parent *is*
`283caa056bbe98b65784350d335472299c7bddea`, so `apps/server` at the merged tip is byte-identical to that tested tree
(`git diff --exit-code 56e38b5 HEAD -- apps/server` exits 0) — that 493-case result is a direct claim about the merged
code, not an approximation of it, so the suite was not re-run at full width to confirm what identity already confirmed.
The combination question was narrower: `c2d9089` sits 8 commits past `283caa0`, and against the branch base **exactly one**
path was edited on both sides — `docs/migration-status.md` (`git diff --name-only 283caa0 c2d9089 ∩ branch files`).
`apps/server/src/server.ts` changes only on the MCP side (`git diff --exit-code 283caa0 c2d9089 -- …` exits 0), so its 38
added / 3 removed lines are the branch's own tested delta.

**Cross-package types are the real seam here, so they were checked rather than assumed.**
`apps/server/src/mcp-conversation-tools.ts:39-40` imports `MCP_INVOKE_MAX_ARGUMENT_BYTES` and the MCP wire types from
`@hepi/protocol/gateway` and `HostTransportError` from `@hepi/gateway`, and SSH 03 had just changed
`packages/protocol/src/gateway.ts` (`WorkbenchFailureCode`) and `packages/gateway/src/index.ts` on the integration side.
A `server.ts` that is byte-identical to a tested tree can still compile differently once its dependency's *source* moved:
`@hepi/server` and `@hepi/app`, `@hepi/protocol`, `@hepi/gateway` were typechecked at the merged tip (exit 0) rather than
inherited.

| Check | Command | SHA | Exit | Result / evidence |
| --- | --- | --- | --- | --- |
| Preview | `git merge-tree --write-tree --name-only HEAD impl/mcp-conversation-02` | `c2d9089` | 0 | `f5be8be` (clean) |
| Reviewed tree = integrated tree (code) | `git diff --exit-code 56e38b5 HEAD -- apps/server` | `61c2d66` | 0 | reuse basis |
| Doc-only final fix | `git diff --stat 5a485db ebf26df` | `ebf26df` | — | 1 file, +83/-2, `.scratch/mcp-conversation-tools/spec.md`; `git diff --exit-code 56e38b5 ebf26df -- packages apps` 0 |
| Integration side preserved | `git diff --exit-code c2d9089 HEAD -- packages apps/web apps/app docs/verification.md docs/workbench.md docs/client-ingress.md docs/chat.md` | `61c2d66` | 0 | exit 0: merge added nothing to gateway/protocol/ui/web |
| Merge adds exactly the branch files | `git diff --name-only c2d9089 HEAD` | `61c2d66` | — | 16 paths, all branch paths (`merge.log`) |
| Targeted seam | `node --test --test-reporter=tap test/mcp-conversation-tools.test.ts test/mcp-declarations.test.ts` (cwd `apps/server`) | `61c2d66` | 0 | 20/20 (14 adapter + 6 declaration), `mcp-focused.log` |
| Server suite, deterministic | `node --test --test-concurrency=1 --test-reporter=tap test/*.test.ts` (cwd `apps/server`) | `61c2d66` | 0 | **493/493**, `server-serial.log` |
| Server typecheck | `pnpm --filter @hepi/server typecheck` | `61c2d66` | 0 | `typecheck-server.log` |
| Dependent typechecks | `pnpm --filter @hepi/app --filter @hepi/protocol --filter @hepi/gateway typecheck` | `61c2d66` | 0 | `typecheck-dependents.log` |
| Gate selector | `pnpm verify:changed --base=c2d9089` | `61c2d66` | 1 | `merged-verify-changed.json` (`dirty: false`): `changed-typecheck` 0, `changed-test` **0** (493/493), `check-docs` 1 (baseline). No `web-unit` step: the selected change is server-side, and `--base` covers packages and dependents, not browser flows |
| Docs | `node scripts/check-docs.mjs` | `61c2d66` | 1 | 386 files, **12** broken links; `broken-merged.txt` diffs empty against `merge-client-app-8/broken-base-80608d6.txt` |
| Entrypoints | `node scripts/check-entrypoints.mjs` | `61c2d66` | 0 | 77 present, 2 known-missing, 0 newly missing |

Test counts reconcile without hand-waving: `473 → 493` is this ticket's 20 new cases (14 + 6) and nothing else — the
server suite is the only suite the merge touches, gateway stays 438 and ui 198 as recorded at `7807c46` (proven by the
byte-identity row above, so they were not re-run).

**One failing run, attributed rather than repeated away.** `pnpm --filter @hepi/server test` (the package script, which
runs concurrently) exited 1 once on `apps/server/test/provider-config.test.ts` — "a text turn still uses the configured
provider, endpoint and key" threw `SyntaxError: Unexpected end of JSON input` (`server-suite.log`: 493 / 492 pass / 1
fail). That file is untouched by this merge (`git diff --exit-code c2d9089 HEAD -- apps/server/test/provider-config.test.ts`
exits 0), its stub parses a request body on `end` without checking it is non-empty
(`apps/server/test/provider-config.test.ts:28`), and it is the same load-sensitive class already recorded against ticket
03. Run alone it passes 5/5 three times (`provider-config-{1,2,3}.log`); with `--test-concurrency=1` the whole suite is
493/493 (`server-serial.log`). Not chased with further concurrent runs, and not fixed here — the harness owns it.

**A mistake of mine, recorded because it is the interesting kind.** My first focused command included
`test/mcp-replay-crash-child.ts` and reported 21 / 20 pass / 1 fail. That file is a **fixture child process**, not a test
file: `mcp-conversation-tools.test.ts` spawns it in two stages (`kill-inside-call`, `reopen`) to drive the restart window.
Run directly under `node --test` it fails `AssertionError [ERR_ASSERTION]: stage is kill-inside-call or reopen` — the
child refusing to run without its stage argument. The 20/20 above is the honest seam (`mcp-focused.log` re-run on the two
real files); the shell glob `test/*.test.ts` never picks the helper up, which is why the suite counts never included it.

**Docs composition.** `docs/migration-status.md` is the only both-sides path, and the merged file keeps both texts:
ticket 02's `mcp__<gatewayId>__<server>__<tool>` adapter paragraphs (from `ebf26df`) and the SSH 03 Retry / live-watch
rows (from `c2d9089`) — `git diff --numstat` gives +32/-9 against `c2d9089` and +15/-2 against `ebf26df`, i.e. neither
side overwrote the other. `docs/architecture.md` and `docs/README.md` came in identical to the branch (`git diff
--exit-code ebf26df HEAD -- …` exits 0). `check-docs` reads the filesystem, so its file count moves 384 (branch,
pre-merge) → 386 (this tip) for two reasons unrelated to the merge's correctness: the ticket 03 findings file added at
`7807c46`, and an untracked `apps/web/dist/icons/catppuccin/README.md` build artifact present in this worktree and absent
in the branch worktree (`scripts/lib/discovery.mjs:50` walks the tree, it does not read git). The broken set is unchanged
at the same 12 paths either way.

**Not merged, and why.** `impl/subtree-control-03` carried P1/P2 fixes not yet approved when this was written — left
alone then; **superseded the same day**: approved on `adafc5c` and merged as `20fcd1781247fd3cd1fc38dd76a7b0fbf8d3a405`; see
the next section. The queue item then called
`impl/native-extensions-36` (SHAs `a658539` / `2c6f801`) merged the same day as `84b7039`; the name resolved to
`impl/client-app-16-acceptance` — see that section's Naming paragraph. DOCX preview work stayed out.
`impl/mcp-conversation-03` still shares a tip with this branch
and has no approval of its own — left alone. No deploy, no service restart, no build on `remote-host`, no push
(`local/integration-client-app` stays at `a39dc80`), no install (`git diff --name-only c2d9089 HEAD` names no
`package.json`, `pnpm-lock.yaml` or `tsconfig*`), no main-checkout file mutated, no worker30/worker32 branch touched.
`graphify-out/graph.json` is updated once, after this batch's evidence commits.

## Client app integration: subagent subtree control ticket 03 (2026-10-19)

`impl/subtree-control-03` approved tip **`adafc5cfb571da03084dde854952385724cbc63e`** (review35 APPROVED FINAL) merged into
`integration/client-app` as **`20fcd1781247fd3cd1fc38dd76a7b0fbf8d3a405`** (`--no-ff`, parents `3398030` + `adafc5c`).
`git merge-tree --write-tree` previewed clean as `7969f4f636fdbea0a8031712c4846c736cd62f32` (exit 0); no conflict, nothing
hand-resolved, and `git diff --quiet HEAD adafc5c` proves the merged tree is byte-identical to the reviewed tip. 22 files,
+2164/-18 against the base. Logs: `.dev/verify/merge-client-app-15/`.

**The branch's tested tree *is* the merged code — the strongest reuse case in this queue.** `adafc5c` (parents `04747fe` +
`3398030`) and the branch's own tested merge `03e29c7` have the **same two parents**, and `03e29c7` is not an ancestor of
`adafc5c`: they are sibling merges whose only difference is one documentation file (`git diff --name-only 03e29c7 HEAD` names
`.scratch/subagent-subtree-control/issues/03-web-control.md` alone; the code-only comparison `git diff --exit-code 03e29c7
HEAD -- packages apps` exits 0). So the branch's retained report (`.dev/worktrees/subtree-control-03/.dev/verify/`
`2026-10-19T00-36-31-733-verify-changed/verify.json`: sha `03e29c7`, `dirty: false`, base `3398030` — the integration tip
being merged into) is a direct claim about this merged tree, including its **whole** suites: `packages/session` 57/57,
`packages/ui` 213/213 and the 68-check browser seam, all run after the P1 fix. Nothing was re-run to re-establish what
identity already establishes.

**Overlap, and why the merge had nothing to arbitrate.** The branch merged `3398030`, which already carries the
provider 01/02, MCP 01/02, SSH 01/02/03 and subtree 01/02 batches, so relative to the current integration tip the merge brings
in exactly its 22 files and touches no path another branch had just changed: `git diff --exit-code 3398030 HEAD --`
`packages/gateway packages/protocol packages/client apps/server apps/web/src` exits 0 — gateway, protocol, client, server and
Web app source are unchanged by this merge. `packages/session/src/control.ts` is **+134/-0**: a pure addition
(`SubtreeAnswer` / `SubtreeChildAnswer` / `SubtreeControlAction`, `readSubtreeAnswer`, and the `subtreeControl` /
`subtreeRequest` members) that rewrites none of the delegate/control surface the integration side had already tested. That is
why the whole-package session suite on the branch, rather than a targeted slice, is the right evidence here.

**Merge checks run at `20fcd17`, aimed at what the combination could break:**

| Check | Command | SHA | Exit | Result / evidence |
| --- | --- | --- | --- | --- |
| Preview | `git merge-tree --write-tree --name-only HEAD adafc5c` | `3398030` | 0 | `7969f4f` (clean) |
| Reviewed tip = merged tree | `git diff --quiet HEAD adafc5c` | `20fcd17` | 0 | no conflict resolution invented content |
| Tested code = merged code | `git diff --exit-code 03e29c7 HEAD -- packages apps` | `20fcd17` | 0 | reuse basis (one docs file differs) |
| Sibling-merge proof | `git log -1 --format=%p` on `03e29c7` and `adafc5c` | — | — | both `04747fe 3398030` |
| Integration side preserved | `git diff --exit-code 3398030 HEAD -- packages/gateway packages/protocol packages/client apps/server apps/web/src` | `20fcd17` | 0 | exit 0 |
| New seam files, deterministically | `node --test ./test/subtree-control.test.ts` (session); `node --test ./src/lib/subtree-control.test.mjs ./src/components/subtree-surface.test.mjs` (ui) | `20fcd17` | 0 | 5/5 and 15/15 (`seam-session.log`, `seam-ui.log`) |
| Changed packages, whole suites | `pnpm --filter @hepi/session test`; `pnpm --filter @hepi/ui test` | `20fcd17` | 0 | 57/57, 213/213 (`session-test.log`, `ui-test.log`) — rerun here, not only inherited |
| Typechecks across the seam | `pnpm --filter @hepi/session --filter @hepi/ui --filter @hepi/app --filter @hepi/web typecheck` | `20fcd17` | 0 | `typecheck.log` (Web consumes `@hepi/ui` components; `AppShell.tsx` gained the panel) |
| Browser seam, outside `--base` reach | `node e2e/ux-subtree-control.mjs` (cwd `apps/web`) | `20fcd17` | 0 | **68 checks, 0 FAIL**, headless Chromium (`browser-subtree-merged.log`). The selector covers packages and dependents, not browser flows, and this surface is the ticket's whole deliverable, so it was re-run at the merged tip instead of inherited |
| Gate selector | `pnpm verify:changed --base=3398030` | `20fcd17` | 1 | `verify-changed/verify.json` (`dirty: false`): `changed-typecheck` 0, `changed-test` **0** (session 57, ui 213, app 9, **server 493**, gateway 438 — 0 fail), `web-unit` 0 (52/52), `check-docs` 1 (baseline) |
| Docs | `node scripts/check-docs.mjs` | `20fcd17` | 1 | 388 files, **12** broken links; `broken-merged.txt` diffs empty against `merge-client-app-8/broken-base-80608d6.txt` — the two new `docs/notes/` pages and their index links add 0 |
| Entrypoints | `node scripts/check-entrypoints.mjs` | `20fcd17` | 0 | 78 present (+1: the new `test:subtree-control` script), 2 known-missing, 0 newly missing |

Test counts reconcile across the whole integration: server stays **493** (ticket 02's MCP cases) and gateway **438** (SSH 03),
session 52 → **57** (+5 subtree) and ui 198 → **213** (+15 subtree), which is this ticket and nothing else.

**Manifest change with no lockfile and no install.** `apps/web/package.json` gains one line (`+1/-0`:
`"test:subtree-control": "node e2e/ux-subtree-control.mjs"`); no dependency changed and `pnpm-lock.yaml` is not in the merge,
so nothing was installed at the merged tip — the browser seam resolves through the existing `node_modules`.
`apps/web/e2e/ux-subagent-delegate.mjs` was attempted and refused with `build first: pnpm --filter @hepi/web build`
(`ux-subtree-control.mjs` builds its own fixture bundle under `/tmp` and needs no repo build). That neighbouring script was
not run: it is a stale-`.next` precondition of this worktree (its `.next` is from Oct 18) and unrelated to this merge, which
changes no `apps/web/src` file. Recorded, not chased.

**i18n parity is a test, not a gate script.** The three message files each gain `i18n.retryLoad` and the subtree keys at the
same line (`en.ts:1522`, `zh-CN.ts:1522`, `zh-TW.ts:1522`), and `packages/ui/src/components/subtree-surface.test.mjs:95`
asserts that every word the surface asks for exists in every locale — inside the 213/213 above. A first draft of this section
claimed there was no parity check; `scripts/check-i18n.mjs` does not exist in this repository, and the coverage is the test.

**Docs composition.** `docs/migration-status.md`, `docs/chat.md` and `docs/client-ingress.md` are edited on both sides of
`3398030`; the branch merged that tip before review, so the merged files equal the branch's reviewed files — `git diff --quiet
HEAD adafc5c` covering them is the proof. The merge also adds `docs/notes/` (`README.md` + `subtree-control-web-ux.md`), a new
directory that `docs/README.md:96` links, so `check-docs` still reports 0 guides missing from the index.

**Not merged, and why.** The next queue item was recorded here as "`impl/native-extensions-36` (`a658539`, source
`2c6f801`)". The SHAs are right and the branch name is not: `a658539` / `2c6f801` belong to
**`impl/client-app-16-acceptance`** (worktree `.dev/worktrees/client-app-16-acceptance`), and no ref named
`impl/native-extensions-36` exists in this repository — `git for-each-ref | grep -i native` returns nothing. That batch
merged the same day as `84b7039058b1d44aebbb416411d167a51a37f503`; see the ticket 16 acceptance-batch section below.
DOCX preview stays as its own finding records it (not connected; `docs/verification.md` above and
`docs/migration-status.md:68`), and no DOCX branch exists to merge. No
deploy, no service restart, no build on `remote-host`, no push (`local/integration-client-app` unchanged), no install, no
main-checkout file mutated, worker30/worker32 worktrees untouched. `graphify-out/graph.json` is updated once, after
this batch's evidence commits — that single update covers subtree 03 together with the ticket 16 acceptance merge that
followed it here.

## Client app integration: ticket 16 acceptance batch — credential sandbox and native readiness (2026-10-19)

`impl/client-app-16-acceptance` tip **`a6585397cea23feb7bf01a08082979faf435b374`** (review38 APPROVED: material **P1**
empty-env credential fallback and **P2** native cleanup ordering both resolved; source commit **`2c6f8019fbd38440a2d5bbc97096d273defc1f1e`**,
`a658539` docs-only) merged into `integration/client-app` as **`84b7039058b1d44aebbb416411d167a51a37f503`** (`--no-ff`,
parents `2c49e12` + `a658539`), merging **ticket 16's acceptance drivers, the credential sandbox and the native readiness
fixes**. No native-extensions lane was merged here — the queue name `impl/native-extensions-36` matches no ref in this
repository, as the Naming paragraph below records. Logs: `.dev/verify/merge-client-app-16/`.

**This branch did not sit on the current integration tip, so this is the first merge in the queue with real arbitration.**
Its base is `5c4a6d8` (a merge of `1873d24`); `git merge-base HEAD a658539` is **`1873d24`**, and `HEAD` is not an ancestor
of the branch. Against that base both sides edited four paths — `apps/web/package.json`, `docs/client-ingress.md`,
`docs/verification.md` and `.scratch/client-app/issues/16-integration-and-direct-cutover.md` — and `git merge-tree`
predicted exactly one content conflict (preview `79cc1ab…`, exit 1, conflict in the ticket 16 document). The other three
auto-merged.

**The one conflict, resolved by keeping both histories.** `ce415af` had rewritten the ticket's status and acceptance list to
record the `1873d24` Web-origin cutover (three slices, deployment evidence, box checked); the branch rewrote the same
paragraphs for a pre-cutover world (four slices, "**No cutover has happened** … `release-1062840`", box unchecked with
"**未做**：本票未启动、停止或写入任何部署"). Taking either side whole would have been wrong: the branch's line is false about
today's deployment, and the integration line is false about what this branch's journeys evidenced. The resolution states
four slices, keeps the cutover as a separate, not-performed-by-this-ticket fact, keeps every branch claim, and corrects only
those three spots: the box keeps `[x]` with the branch's "this ticket did not start, stop or write a deployment" sentence
folded into it, and the "no journey ran against the immutable release directory" claim is now "no journey ran against the
deployed origin, nor against the immutable release directory" — which is what both sides actually mean. Verified
mechanically, not by eye: every line the branch added to the file is present in the merged file except the seven I rewrote,
and each rewrite is confirmed present as rewritten text (`grep -F` on the flattened document). The branch's own
"Still open" section keeps saying the cutover is not this slice's doing — true, and untouched.

**Source identity, stated per path rather than as one claim.** `git diff --exit-code HEAD 2c6f801 -- apps/app scripts`
exits 0 (`apps/app/src-tauri` included, same file set), and every path the branch changed in `packages/ui`, `apps/web`,
`packages/client` and `packages/protocol` is byte-identical at the merged tip. The merged tree differs from `a658539` only
where integration had advanced — `packages/gateway`, `packages/protocol`, `packages/session/src/control.ts`,
`apps/server`, subtree/provider/i18n files in `packages/ui`, and the four overlap paths — and the branch changed **none**
of those (`git diff --quiet 1873d24 2c6f801 -- packages/protocol packages/gateway apps/server packages/session` all clean).
`pnpm verify:changed --base=2c49e12` selected `app, gateway, server, ui, web`: **gateway 438** and **server 493** pass at
the tip, which is the check that SSH 03's `WorkbenchFailureCode`, MCP 02's durable bridge and subtree 03's
`SubtreeAnswer` client surface survived the merge intact.

**Native reuse is now proven by inputs, not asserted.** The credential-sandbox module, the artifact verifier and every Rust
input (`main.rs`, `Cargo.toml`, `Cargo.lock`, `.cargo/config.toml`, `tauri.conf.json`) are byte-identical to `2c6f801`,
the revision whose native run printed `HEPI_APP_BUILD {"shell_revision":"2c6f8019fbd3…"}` (26 checks,
`.dev/verify/t16-final-native/run.log`) and whose 39 assertions (`t16-final-artifacts/run/report.json`) are bound to that
HEAD by the `provenance-names-the-built-revision` check. So no new Rust build, no cargo test and no credential write was run
for this merge. The P1 fix is confirmed in the source the reuse rests on: `scripts/lib/credential-sandbox.mjs:110` throws
("a packaged credential process may not be started without this run's own Secret Service … an empty environment still
reaches `/run/user/<euid>/bus`"), and `verify-artifacts.mjs` hands `packagedEnv()` to every binary spawn — `--forget`
(4 sites), `--configure` (`captureWithInput`) and `launch()`, whose base is the run's private session rather than
`process.env` (`launch` is called for all four window runs). P2 likewise: the `finally` block awaits
`credentials?.stop()` before `fixture?.server.close()` and `display?.stop()`, with the null-tolerant handles closed last.

**Client-side checks run at `84b7039`, chosen because the branch rewrote the shared `workbench.tsx` (+132/−41) that both
hosts mount while integration rewrote `AppShell.tsx` (subtree 03) and `index.ts` never exports the subtree lib:**
`pnpm --filter @hepi/ui test` **228/228** (15 new branch files + the 213 already at the tip; `ui-test.log`), the three new
branch seams alone **15/15** (`ui-new-seam.log`), `pnpm --filter @hepi/app test` **10/10** (`app-test.log`),
`pnpm test:scripts` **85/85** including the new `credential-sandbox.test.mjs` **11/11** (`scripts-test.log`,
`scripts-credential-sandbox.log`), `packages/session` **57/57** for the seam the branch consumes
(`createConversationControl`/`WorkbenchClient`), `ui + session + app + web typecheck` exit 0 (`typecheck.log`), and
`verify:changed --base=2c49e12` → `changed-typecheck` 0, `changed-test` 0, `web-unit` 0 (52/52), `script-tests` 0,
`check-entrypoints` 0 (80 present, +2 new scripts, 0 newly missing), `check-docs` 1 on the same **12** baseline links
(388 files; `broken-merged.txt` diffs empty against `merge-client-app-8/broken-base-80608d6.txt`).

**The branch's headline journey was re-run here, because it tests the merged bundle.** `ux-client-acceptance.mjs` runs the
production Web build against a stack it starts itself on its own ports and `mkdtemp` state — Backend/gateway/ingress as
`node <main.ts>` with a stub model — so it is a question about `84b7039`, not about the branch. It needed
`pnpm --filter @hepi/app --filter @hepi/web build` (Vite only, 2 × ~1 s, both `dist` dirs gitignored) and then
**exit 0, 52 checks, 0 FAIL** with provenance naming this tip: `source 84b7039058b1… (clean)`, web script
`/assets/index-ryMbDa2v.js` 3263689 B, app script `./assets/index-RzsdGcwW.js` 3266745 B
(`browser-client-acceptance.log`). Its measurement line (71 web / 33 app requests, 195 ms first-visible,
`revocationMs` 491) is representative debug-profile data, not a production claim, and is recorded as such by the ticket.
`ux-native-acceptance.mjs` was **not** re-run here — its first action is a cargo debug build, and the source-identity rows
above already prove its inputs; the 12/26-check native evidence stays at `2c6f801`, where it was produced and revision-bound.

**Other seams at this tip:** `test:workbench-scope` 16, `test:pwa-offline` 24, `test:panel-ingress` 33,
`test:capability-trust` 17, `test:subtree-control` 68 — all exit 0 (`browser-*.log`). The subtree panel is mounted by
`AppShell`, which this branch never saw, so that one was re-run after subtree 03 as well.

**Two records, not repairs.** (1) `apps/web/e2e/ux-subagent-delegate.mjs` refuses to run here with
`build first: pnpm --filter @hepi/web build` — advice that cannot be followed, because `build` is `vite build`
(outDir `dist`) while the script asserts `apps/web/.next/BUILD_ID`, which nothing writes any more. The same stale
precondition is already recorded for `ux-ssh-project.mjs` above; 36 scripts under `apps/web/e2e/` still name `.next`. It is unchanged by this merge
(`git diff --quiet HEAD a658539 -- apps/web/e2e/ux-subagent-delegate.mjs` and the same assertion at `1873d24`), so
`test:subagent-delegate` was not attempted further; it belongs to whoever owns those harnesses. (2) The readiness admission reports the four fields
(`backend`/`scope`/`client` plus profile) that the ingress itself answered — `shell.ts:readoutReport` copies them into
`app_ready` at the revision this record measured (`b432be8`, 2026-10-19; the helper is now `reportConnection`, same emission) — and `verify-artifacts.mjs`
asserts the line's presence and the run's own credential — but no driver
independently re-validates those four values against the credential it issued. That belongs to ticket 15's historical
scope; recorded, not expanded here. The known stale-descriptor limit for future in-place profile changes stays documented
in ticket 16's "Still open" list, unmodified.

**Docs composition.** `docs/client-ingress.md` keeps both: the branch's "What a client shows when its first read is
refused" (line 50) and the integration side's "Host-local provider credentials" (line 314) plus subtree 03's
`subtreeControl`/`subtreeRequest` operation rows. `docs/verification.md` keeps all 184 lines the branch added and all
integration sections. `docs/migration-status.md`, `docs/README.md` and `docs/notes/` are integration-side content the
branch never touched (`git diff --quiet HEAD a658539 -- docs/migration-status.md` is not empty only because integration
added to it; the branch added nothing there).

**Naming, for the reader of this record.** The queue called this item "Native 16 / `impl/native-extensions-36`". The
merge above is `impl/client-app-16-acceptance`; there is no `impl/native-extensions-36` ref here, and no native-extensions
work was merged by this commit. Anyone looking for that lane should check the acceptance branch's tip instead, or re-confirm
the name with the coordinator.

**Not merged, and why.** DOCX preview stays a recorded finding (not connected), with no branch to merge.
`impl/mcp-conversation-03` shares `ebf26df` with no approval of its own — left alone.
No deploy, no service restart, no build on `remote-host`, no push (`local/integration-client-app` unchanged), no
`cargo`/`docker` invocation, no credential write outside a run's own sandbox, no main-checkout file mutated, and
worker30/worker32 worktrees untouched. `graphify-out/graph.json` gets its one update after this batch's evidence commits,
covering subtree 03 and this merge together as instructed.

## Client app integration: MCP conversation tools ticket 03a (2026-10-19)

`impl/mcp-conversation-03` approved tip **`d95d6d4a0839da62bd6c356b4109c173972b2cd7`** (review35 APPROVED, standard 0 /
spec 0 material; **03a only** — 03b/03c are not written yet) merged into `integration/client-app` as
**`8f71db4412e403ff93d835a0a1dda86aefd084e4`** (`--no-ff`, parents `b432be8` + `d95d6d4`), exactly that commit, not a later
branch tip. 20 files, +1592/−54 against its base. Logs: `.dev/verify/merge-client-app-17/`.

**The branch did not sit on the current tip, so this merge arbitrates.** `git merge-base HEAD d95d6d4` is
**`ebf26df`** — the MCP 02 tip — because the branch was cut before subtree 03 (`20fcd17`) and before the ticket 16
acceptance batch (`84b7039`). Both sides edited 6 paths (`packages/gateway/src/index.ts`,
`packages/protocol/src/gateway.ts`, `docs/migration-status.md`, and the MCP spec / README / ticket 03), and `git
merge-tree` predicted exactly two content conflicts (preview `3f914e2…`, exit 1): `README.md` and
`issues/03-trust-selection.md` — both of them **my own** integration-evidence edits from earlier merges meeting the
branch's status rewrite. The four source/shared-doc overlaps auto-merged, and each was verified rather than trusted:
every line either side added is present at the merged tip — `packages/protocol/src/gateway.ts` 104/104 branch-added lines
**and** SSH 03's `WorkbenchFailureCode` (2 hits), `packages/gateway/src/index.ts` branch-added export line **and** SSH
03's `hostFailure` (4 hits) and `not_supported`, `docs/migration-status.md` 5/5 branch lines **and** subtree 03's
`SubtreeControlPanel` paragraph. So the merged `/v1/mcp` dispatch, the workbench refusal vocabulary and the provider-auth
route all stand together. The merge also adds nothing of its own to those files: `git diff --numstat b432be8 HEAD` for
`packages/protocol/src/gateway.ts` and `packages/gateway/src/index.ts` is **the branch's own numstat exactly** (+110/−0 and
+1/−1). The line check was then run in **both** directions, which is what an auto-merge needs rather than one: every
branch-added line is present at the tip (protocol 104/104, index 1/1, migration-status 5/5) **and** every integration-added
line against the same `ebf26df` base is still present (12/12, 7/7, 23/23), with the merged numstat equal to the branch's for
those three paths — so 03a's work was laid on top of integration's and replaced none of it. `git diff --quiet HEAD d95d6d4`
is clean for the remaining **13** branch paths (every non-`.scratch` branch file except those three).

**Conflict resolution.** The ticket's status is now "03a resolved and integrated" with the merge SHA, and it keeps my
earlier instruction to future work, sharpened: **03b/03c must be cut from `integration/client-app` at or after
`8f71db4`, not from `impl/mcp-conversation-03`** — the branch base predates subtree 03 and the acceptance batch, and
03a's own surfaces exist only on the integration tip. `README.md` keeps both facts (01/02 integration SHAs from HEAD, the
03a/03b/03c split from the branch).

**Closing the evidence gap — and correcting what the gap actually was.** The queue record said the branch's verification
was a **dirty** run (`d2a9f17`, 1240 tests, typecheck 0 / web-unit 0 / docs baseline) and that clean-HEAD equivalence could
not be claimed. Inspecting `.dev/worktrees/mcp-conversation-03/.dev/verify/` shows two clean reports the note did not count:

| Branch report | sha | dirty | steps |
| --- | --- | --- | --- |
| `2026-10-19T01-36-31-079-verify-fast` | **`d95d6d4`** (the approved tip itself) | **false** | `workspace-typecheck` 0, `workspace-tests` 0 → **1249 tests, 0 fail** (app 9, server 493, client 10, gateway 436, protocol 51, session 52, ui 198) |
| `2026-10-19T01-25-44-919-verify-changed` | `bf1ab16` (the superseded 03a commit) | **false** | `changed-typecheck` 0, `changed-test` 0, `web-unit` 0, `check-docs` 1 |
| `2026-10-19T01-33-12-818-verify-changed` | `d2a9f17` | true | the run the gap note quoted (1239 tests sum) |

So a **clean, exact-tip, whole-workspace** proof of `d95d6d4` does exist (the fast profile just omits `web-unit` and
`check-docs`). And the clean `changed` run at `bf1ab16` covers the same executable source: `git diff bf1ab16 d95d6d4`
changes `listing.ts` **only in comments** — stripping comment lines from both versions and diffing them is empty, and the
only other delta is `docs/mcp-on-the-web-host.md`. What genuinely could not be inherited from any branch run was
**combination** evidence: nothing on the branch ever saw `WorkbenchFailureCode`, subtree 03, or the acceptance batch, so
the merged tip was checked rather than assumed.

**Checks run at the clean merged tip `8f71db4` (`dirty: false` throughout) — narrow, no 1240-test repeat:**

| Check | Command | Exit | Result |
| --- | --- | --- | --- |
| Exact-count seam the gap asked for | `node --test --test-concurrency=1 ./test/control.test.ts` (`packages/gateway`) | 0 | **33/33** — the 32 the branch base had plus 03a's one; `gw-control.log` |
| New listing seam | same, `./test/mcp-list-tools.test.ts` | 0 | **9/9** (`gw-mcp-list-tools.log`) |
| Shared invocation rule | same, `./test/mcp-invocation.test.ts` | 0 | **10/10** (`gw-mcp-invocation.log`) |
| Server-side adapter + declarations | same, `test/mcp-conversation-tools.test.ts test/mcp-declarations.test.ts` | 0 | **20/20** (`server-mcp-seam.log`) |
| Gateway whole suite, serial | `node --test --test-concurrency=1 test/*.test.ts` | 0 | **448/448** (`gateway-full-serial.log`) |
| Server whole suite, serial | `node --test --test-concurrency=1 test/*.test.ts` (`apps/server`) | 0 | **493/493** (`server-full-serial.log`) |
| Unchanged packages | `pnpm --filter @hepi/protocol/--filter @hepi/ui/--filter @hepi/app/--filter @hepi/session test`, `node scripts/test-web-unit.mjs` | 0 | 51, **228**, 10, 57, 52 |
| Typecheck across the seam | `pnpm --filter @hepi/gateway --filter @hepi/protocol --filter @hepi/ui --filter @hepi/server typecheck` | 0 | `typecheck.log` |
| Gate selector, narrowed | `pnpm verify:changed --base=b432be8 --test-file=…` (the 5 MCP files) | 1 | `changed-typecheck` 0, both `changed-test-*` 0 (52 + 20), `check-docs` 1 on baseline |
| Docs / entrypoints | `node scripts/check-docs.mjs`, `node scripts/check-entrypoints.mjs` | 1 / 0 | 389 files, **12** broken links (`broken-merged.txt` diffs empty against `merge-client-app-8/broken-base-80608d6.txt`); 80 present, 0 newly missing |

Counts reconcile arithmetically. Gateway at `b432be8` was **438**; 03a adds exactly **10** cases (the new
`mcp-list-tools.test.ts` 9, plus `control.test.ts` 32 → 33), giving **448** at the merged tip. The branch's clean run
reported gateway **436** because its base `ebf26df` predates SSH 03's 12 cases — 426 + 12 + 10 = 448 is the same total by
the other route, so nothing silently stopped running. Server stays **493** and ui **228**: 03a edited three server
**source** files (+17/−15, the listing vocabulary and the `exposureOf` return shape) without adding a server case, which
is why the server suites were run once serially rather than re-derived.

**Why the source-level reuse is safe.** `git diff --exit-code HEAD d95d6d4` is empty for every path the branch changed
except the 6 both-sides files, and inside those, `invocation.ts`, `host.ts`, `listing.ts`, the three `apps/server` files,
`api-types.ts`, `stdio-server.mjs`, `mcp-list-tools.test.ts`, `docs/upstream-sources.md` and `GLOSSARY.md` are
byte-identical to the approved tip. So 03a's tested semantics are literally the merged code. No manifest, lockfile or
`tsconfig` is in the merge (`git diff --name-only b432be8 HEAD` names none) → **no install**, and `node_modules`
resolves as before.

**The changed call boundary, read rather than re-probed.** `invocation.ts` is not an export-only change: `exposureOf`
now returns `{ exposure, overridden }` instead of a bare string, and `SERVER_REFUSALS` narrows to
`McpInvocationFailureCode & McpToolListFailureCode`. Its only call site in the invocation path became
`exposureOf(…)‏?.exposure === "hidden"` (`invocation.ts:165`), and the one other consumer is
`listing.ts:147`; nothing outside `packages/gateway/src/mcp/` reads it (the only textual hits elsewhere are stale jiti
compile caches under `apps/web/node_modules/.cache`, not sources). `entrySwitchedOff` replaced an inline
`config.enabled === false` in both operations, so a switched-off server cannot be listed while still callable, or the
reverse — the "one rule, not two" claim holds structurally. The `/v1/mcp` dispatch itself is untouched by the merge
(`index.ts:596-609`: one abort controller per request, `mcp_unavailable` when no host service, 200 + typed result), so
the new operation travels the existing route rather than a second listener.

**Two non-blocking records, kept as records.** (1) **Schema verbatim.** `describeTool` masks name and description before
clipping, but passes `inputSchema` through as the server wrote it (`listing.ts:156-157`, with the test's own words at
`mcp-list-tools.test.ts:252-254`: "a schema is the server's own bytes"). A secret that a server chose to *embed inside a
schema document* therefore reaches a caller unmasked; the host's redactor is not applied inside the schema. No evidence
exists that any real server does this, and the ticket's design states the host does not interpret schema internals —
recorded, not expanded. (2) **`serverInfo` bound.** `listing.ts:266` redacts `serverInfo.name`/`.version` but applies no `MCP_LIST_MAX_TEXT_CHARS` clip,
unlike a tool's name and description. It is **not** wholly unbounded: `carried` seeds its byte budget from
`bytesOf({…base…})` at `listing.ts:183`, and `base` carries `serverInfo`, so a long one does consume the
`MCP_LIST_MAX_RESPONSE_BYTES` allowance and can stop the answer carrying tools. What is missing is a bound **on the field
itself**: an oversized `serverInfo` with an empty or absent tool list is returned whole with `truncated` false, because
`cut` is only ever set while walking items (`listing.ts:191-198`). The fixture answers
`{name:"pi-web-env-fixture",version:"1.0.0"}` and `mcp-list-tools.test.ts:159` asserts exactly that value, so the oversized
field is untested by construction. Recorded as a limit with its exact shape, no probe built for it, per the instruction not
to grow this merge.

**No security, auth, trust or preflight bypass was tested, probed or asserted.** The listing cases exercised here are the
ordinary ones the branch already wrote — descriptor reading, pagination bounds, masking, and abort/cleanup ("a caller that
disconnects ends the listing, and the server it opened exits"; "stopping the service ends a listing still running and
waits for the connection it opened"), plus control's existing ordinary refusal/pagination cases. Trust enforcement stays
where 03a put it — inside `#target`, shared with `test` — and this merge verified that the shared code is byte-identical,
which is a source fact, not a claim about a bypass.

**Overlap with the still-pending lanes (for whoever merges next).** Scanning every `impl/*` branch whose tip is not yet
contained in integration HEAD against the paths this merge touched:
`impl/provider-connection-03` (`48844cd`, base `c2d9089`) overlaps **3** paths — `packages/gateway/src/index.ts`,
`packages/protocol/src/gateway.ts`, `docs/migration-status.md` — i.e. it will meet exactly the same both-sides composition
now proven here, and must be re-based or re-verified against `8f71db4`.
`impl/ssh-workbench-05` (read as `5d4427f`; it has since advanced to `a0b9a18` while this merge ran — **worker30's lane is
live, so treat these SHAs as read-at-time, not as the set to merge**) overlaps 2 docs paths
(`docs/migration-status.md`, `docs/upstream-sources.md`) —
`docs/upstream-sources.md` is newly both-sides because 03a edited it; expect a real conflict there.
`impl/child-recovery-03` (`fa53186`) overlaps `docs/migration-status.md` only. No DOCX branch exists to merge: `git
for-each-ref | grep -i docx` is empty, and DOCX preview stays a recorded `501` limit in `docs/migration-status.md`.

**Not merged, and why.** `impl/mcp-conversation-03` has **no later commits** to take — 03b/03c are not written; nothing
beyond `d95d6d4` was pulled. No deploy, no service restart, no build on `remote-host`, no push (`local/integration-client-app`
unchanged), no install, no credential write, no main-checkout file mutated, worker30/worker32/worker36 worktrees untouched.
`graphify-out/graph.json` gets its one update after this batch's evidence commits.

## SSH workbench ticket 05: the browser reads a `.docx` (2026-10-19)

_Tested source: `impl/ssh-workbench-05`. The feature commit is `0fdf212`, cut from ticket 03's tip `bc6c71a`;
`integration/client-app` `c2d9089` merged at `2713d53`, and the docs tip that follows is `51eb1b7`, which is the
source of the last `verify:changed` row below. Each row names its own exit code and the log directory it produced.
An earlier `pnpm verify:changed` on the still-dirty tree reported `sha bc6c71a... (dirty tree)`, the commit **before**
these changes; the commit that followed holds exactly that tree, so the rows below are the evidence for it._

This branch's merge changes no source file (`git diff --name-only 0fdf212 2713d53` is `docs/verification.md` plus four
`.scratch/` planning files), so unchanged source means those rows stay this ticket's evidence
(docs/agents/verification.md). As a combination check, at the merge tip `@hepi/ui` (209), `@hepi/protocol` (53) and the
three gateway seam files (`files-surface`, `ingress-ssh-workbench`, `ingress-files`: 22 cases) were re-run and passed,
exit 0, in `.dev/verify/merged-ticket-05/`.

### The commands and what their logs say

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `pnpm --filter @hepi/gateway test` | 0 | 440 tests, 440 pass, 0 fail | `.dev/verify/ticket-05-docx/gateway-test.log` |
| `pnpm --filter @hepi/protocol test` | 0 | 53 tests, 53 pass, 0 fail | `.dev/verify/ticket-05-docx/protocol-test.log` |
| `pnpm --filter @hepi/ui test` | 0 | 209 tests, 209 pass, 0 fail | `.dev/verify/ticket-05-docx/ui-test.log` |
| `pnpm --filter @hepi/server --filter @hepi/app --filter @hepi/session -r test` | 0 | 9 / 52 / 473 tests, 0 fail | `.dev/verify/ticket-05-docx/server-app-session-test.log` |
| `pnpm --filter @hepi/app --filter @hepi/server --filter @hepi/web --filter @hepi/gateway --filter @hepi/protocol --filter @hepi/session --filter @hepi/ui -r typecheck` | 0 | every package `Done` | `.dev/verify/ticket-05-docx/typecheck-all.log` |
| `pnpm test:web:unit` | 0 | 55 tests, 55 pass, 0 fail; 19 files enumerated (was 18) — **superseded below:** the notice test moved to `packages/ui`, so the Web suite is 18 files / 52 tests again | `.dev/verify/ticket-05-docx/web-unit.log` |
| `pnpm --filter @hepi/web test:docx-preview` | 0 | 15 checks in chromium | `.dev/verify/ticket-05-docx/browser-docx.log` |
| `pnpm --filter @hepi/web test:file-failures` | 0 | 15 checks | `.dev/verify/ticket-05-docx/browser-failures.log` |
| `pnpm --filter @hepi/web test:file-surfaces` | 0 | 10 checks | `.dev/verify/ticket-05-docx/browser-surfaces.log` |
| `pnpm --filter @hepi/web test:files-transfer` | 0 | 17 checks | `.dev/verify/ticket-05-docx/browser-transfer.log` |
| `pnpm --filter @hepi/web build` | 0 | `dist/THIRD_PARTY_NOTICES.md` present, 2,547 bytes (Web-owned public copy, since replaced by the build hook) | `.dev/verify/ticket-05-docx/web-build.log` |
| `pnpm check:entrypoints` | 0 | 78 entry files present, 2 known-missing (pre-existing), 0 newly missing | `.dev/verify/ticket-05-docx/check-entrypoints.log` |
| `pnpm verify:changed --base=83a1188` (run on the dirty tree, before the feature commit) | 1 | `changed-typecheck` 0, `changed-test` 0, `web-unit` 0, **`check-docs` 1** | `.dev/verify/2026-10-18T19-57-47-842-verify-changed/` |
| `pnpm verify:changed --base=integration/client-app` at this branch tip `51eb1b7` | 1 | `changed-typecheck` 0, `changed-test` 0 (full suites, all seven packages), `web-unit` 0 (55), **`check-docs` 1** | `.dev/verify/2026-10-18T20-29-58-299-verify-changed/` (`verify.json`: sha `51eb1b77`, `dirty: false`) |
| `pnpm check:docs` | 1 | 392 Markdown files, 12 broken relative links, 0 guides uncovered | `.dev/verify/ticket-05-docx/check-docs.log` |

_App-parity pass (2026-10-19, same section, later revision): the rows above stand for `0fdf212`; the rows below were
run at the App-parity commit on this branch, whose source is `packages/ui`'s manifest and exports, both hosts'
`vite.config.ts`, the moved notice and its test, and `apps/app/test/docx-preview-bundle.test.mjs`._

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `pnpm --filter @hepi/app build` | 0 | `hepi: third-party notice -> apps/app/dist/THIRD_PARTY_NOTICES.md (3313 bytes)`; reader chunk `apps/app/dist/assets/lib-4L70xDUm.js`, 308,121 bytes | `.dev/verify/ticket-05-app-parity/app-build.log` |
| `pnpm --filter @hepi/web build` | 0 | same notice copied to `apps/web/dist/THIRD_PARTY_NOTICES.md` (3,313 bytes); reader chunk unchanged | `.dev/verify/ticket-05-app-parity/web-build.log` |
| `pnpm --filter @hepi/ui --filter @hepi/app --filter @hepi/web -r typecheck` | 0 | three packages `Done` | `.dev/verify/ticket-05-app-parity/typecheck.log` |
| `pnpm --filter @hepi/ui test` | 0 | 216 tests, 216 pass, 0 fail (209 before, +7 notice tests) | `.dev/verify/ticket-05-app-parity/ui-test.log` |
| `node --test apps/app/test/docx-preview-bundle.test.mjs` | 0 | 2 tests: the App's bundle resolves mammoth's browser entry, no Node reader, no Node builtin in the output | `.dev/verify/ticket-05-app-parity/app-bundle.log`; the same file failing at exit 1 without the declaration is `.dev/verify/ticket-05-app-parity/app-bundle-MUTATION.log` |
| `pnpm --filter @hepi/app test` | 0 | 11 tests, 11 pass, 0 fail (9 before, +2) | `.dev/verify/ticket-05-app-parity/app-test.log` |
| `pnpm test:web:unit` | 0 | 52 tests, 52 pass, 0 fail; 18 files (the notice test left `apps/web/src`) | `.dev/verify/ticket-05-app-parity/web-unit.log` |
| `pnpm --filter @hepi/web test:docx-preview` | 0 | all checks passed in chromium, with `mammoth` no longer declared by `apps/web` | `.dev/verify/ticket-05-app-parity/browser-docx.log` |
| `pnpm --filter @hepi/web test:pwa-offline` | 0 | PASS — the notice is no longer a precached public file and the worker still serves its hashed assets | `.dev/verify/ticket-05-app-parity/browser-pwa.log` |
| `pnpm check:entrypoints` | 0 | 78 entry files present, 2 known-missing (pre-existing), 0 newly missing — unchanged by the moved file, which is not a script target | `.dev/verify/ticket-05-app-parity/` (re-run inside the `verify:changed` log below) |
| `pnpm verify:changed --base=integration/client-app` at the App-parity commit `749daeb` | 1 | `workspace-typecheck` 0, `workspace-tests` 0 (full suites — the selector reports `unrecognized changed files: pnpm-lock.yaml`, so it widened rather than narrowed), `web-unit` 0, `script-tests` 0, `check-entrypoints` 0, **`check-docs` 1** | `.dev/verify/2026-10-19T01-54-11-815-verify-changed/` (`verify.json`: sha `749daebf`, `dirty: false`) |

`check:docs` exit 1 is the recorded pre-existing set, and it is the same set: all 12 findings are
`.scratch/**` links to git-ignored `.dev/verify/` logs and two `.pi/skills` SKILL.md paths, none of them in a
file this ticket touched, and `diff` of the two runs' `check-docs.log` `BROKEN` lines (`2026-10-18T20-29-58` vs
`2026-10-19T01-54-11`) is empty. The App-parity pass scanned 393 Markdown files where the earlier run scanned 392:
`check-docs` walks the working tree and skips `vendor` but not a build's `dist/`, so the count moves with what is built
here, not with what is committed - the committed count is unchanged at 395 tracked `*.md`, and the findings are the
identical set. Every link this ticket writes still resolves, including `docs/workbench.md#the-word-document-preview`
from `docs/upstream-sources.md` and `docs/migration-status.md`.

### What the new checks actually assert, and the mutation that proves each

- `packages/protocol/test/files.test.ts` (2 tests, at the declaration the surface and the viewer both read): a
  `.docx` is byte-served with its document MIME and `previewKind: "docx"`, a `.txt` is not, and the preview bound
  is the one declared number. Without `servesBytes` naming a docx the read would fall through to the workbench and
  come back as the "binary content not displayed" placeholder.
- `packages/ui/src/lib/docx-preview.test.mjs` (8 tests, the byte-boundary seam, no gateway): a `content-length`
  over the bound is refused **from the header** with the body untouched and the stream closed; a body that overruns
  its own claim is abandoned **at** the bound and the refusal names the bytes actually read; an abandoned preview
  cancels its reader; a caller that was already gone asks the gateway for nothing (`opened === 0`); a transport that
  stops mid-document is a refusal, not a truncated preview; a surface refusal stays words, not an empty document;
  bytes inside the bound arrive whole; the paragraph split drops whitespace-only runs.
- `packages/ui/src/lib/i18n/messages/locale-keys.test.mjs` (3 tests): every key a `t("...")` call in
  `packages/ui/src` names exists in all three locales; the locales match English's key set and required
  placeholder set (`files.conflictSummary`'s optional `{countSuffix}` allowed, as the vendored pi-web registry test
  does); and the four `files.docxPreview*` keys exist and keep `{max}` in every locale. **Mutation that proves it is
  load-bearing:** renaming `files.docxPreviewOversize` in `messages/en.ts` while `FileViewer` still asks for it made
  all three fail — `en has no entry for: files.docxPreviewOversize (src/components/FileViewer.tsx)` — and restoring
  the key returned `fail 0`. This is not a theory: the same ticket had already deleted
  `files.docxPreviewUnavailable` from all three locale files while `FileViewer.tsx` still translated it, so
  the page would have printed the literal key for any non-PDF, non-docx document. That dangling call is gone (the
  viewer's docx branch is now exhaustive), and the test is what stops it happening again.
- ~~`apps/web/src/third-party-notices.test.mjs` (3 tests)~~ — **moved by the App-parity pass below**, because a test of the
  notice for a dependency the page does not declare belonged to the wrong package. `pnpm test:web:unit` is therefore
  18 files / 52 tests now, not the 19 / 55 recorded above.

### App parity: the reader is declared by its owner, and both hosts' builds prove it

The section above stated a limit that was not real: "`apps/app` declares no `mammoth` and its graph reaches
`@hepi/ui/workbench`, which does not import `FileViewer`, so the App bundles no reader today." The graph does —
`packages/ui/src/workbench.tsx:4` imports `components/AppShell`, which imports `components/FileViewer` at line 9 — and
`pnpm --filter @hepi/app build` was already emitting the same 308,121-byte reader chunk `apps/web` produces. The App was
therefore shipping a bundled `mammoth` whose licence lived only in the other host's `public/`, and it resolved the
package at all only because a **dev** install had put it where the App's bundler could reach it.

- `packages/ui` declares `mammoth` in `dependencies` and `apps/web`'s `devDependencies` entry is deleted. The reader
  belongs to the package that imports it (`src/lib/docx-preview.ts:125`), and every host that builds this workbench
  embeds it, so the host that merely builds it has no declaration to keep in step.
- `packages/ui/THIRD_PARTY_NOTICES.md` is the notice's single owner, and `thirdPartyNoticesPlugin()`
  (`packages/ui/src/lib/third-party-notices.ts`) copies it into each host's `build.outDir` from `closeBundle` — the hook
  Vite calls **after** `emptyOutDir` has cleared it, which is why the copy survives instead of being deleted with the
  rest of the directory. It is passed in `apps/web/vite.config.ts` and `apps/app/vite.config.ts`; `apps/app` still has no
  `publicDir`, because the notice is the one static file its artifact legitimately needs and the install prompt, manifest
  and service worker remain Web-only claims.
- `packages/ui/src/lib/third-party-notices.test.mjs` (7 tests): the notice names the reader, the licence and the
  installed package's own version, read from `require("mammoth/package.json")` and the package's `LICENSE` rather than
  retyped; the copyright line is required to appear exactly as upstream states it; the copy lands in a real output
  directory byte-for-byte; **a build that cannot place the notice rejects instead of reporting success**; both hosts'
  configs actually call the plugin; and no host keeps a second copy that could drift from the owner.
- `apps/app/test/docx-preview-bundle.test.mjs` (2 tests): the App's own `tsconfig.json` and `platform: browser` over
  `packages/ui/src/lib/docx-preview.ts`, requiring `mammoth/browser/*` among the esbuild metafile inputs and requiring
  that neither `lib/unzip.js` nor `lib/docx/files.js` is present, plus no `node:fs` / `node:buffer` / `require("fs")` in
  the emitted output and the `arrayBuffer` input shape still named. This is the check the `browser` field's promise rests
  on: the Node pair reaches for `Buffer`, which a webview does not have, and it needed no Rust build to answer.

**Mutations that prove the dependency move is load-bearing**, each recorded with its failing run:

- `mammoth` removed from `packages/ui`'s `dependencies` (and reinstalled) → `pnpm --filter @hepi/app build` **exit 1**,
  `Rolldown failed to resolve import "mammoth" from .../packages/ui/src/lib/docx-preview.ts`
  (`.dev/verify/ticket-05-app-parity/app-build-MUTATION.log`), `apps/app/test/docx-preview-bundle.test.mjs` **exit 1** on
  both cases (`mammoth's browser mapping was not bundled at all`, `.dev/verify/ticket-05-app-parity/app-bundle-MUTATION.log`),
  `packages/ui/src/lib/third-party-notices.test.mjs` **exit 1** with `Cannot find module 'mammoth/package.json'`
  (`.dev/verify/ticket-05-app-parity/notice-MUTATION.log`), and `pnpm --filter @hepi/ui --filter @hepi/app -r typecheck`
  **exit 1** with `error TS2307: Cannot find module 'mammoth'` (`.dev/verify/ticket-05-app-parity/typecheck-MUTATION.log`).
  The declaration is a build input, and pnpm gives a workspace only what it declares — which is the same reason
  `packages/gateway` takes no `mammoth` at all and writes its own zip fixture.
- Dropping `thirdPartyNoticesPlugin()` from `apps/app/vite.config.ts` → the notice test's "both hosts" case fails with
  `apps/app/vite.config.ts builds without placing the notice in its output`. The plugin is what makes the notice part of
  the artifact rather than a file someone serves by hand.
- `packages/gateway/test/files-surface.test.ts` (the added case): a `.docx` `?type=read` goes to the byte route,
  is answered with its document MIME and unaltered bytes, and `/api/workbench` is **not** called; its `?type=meta`
  answer keeps `previewKind: "docx"`, the number the viewer reads before deciding to fetch.
- `packages/gateway/test/ingress-ssh-workbench.test.ts` (the added case): one real archive produced by
  `packages/gateway/test/docx-fixture.ts` is handed over with the same status, MIME, length and bytes by a local
  and an SSH workspace, `meta` names the kind on both, and a `Range: bytes=0-3` is answered `206` with
  `content-range` — the bound a browser-side reader depends on.
- `apps/web/e2e/ux-docx-preview.mjs` (15 checks, chromium, esbuild bundle of the real `FileViewer`): a document's
  three paragraphs reach the page as three `<p>` blocks on a cookie connection and on the App's bearer connection;
  each connection reads the document **exactly once**; every request presented its own credential and none
  presented nothing; a paragraph containing `<script>window.__pwned = 1</script>` arrives as words, with `frames
  === 0`, `scripts === 0` and `window.__pwned === 'unset'`; an over-bound document states its bound and the download
  alternative with **zero** read requests issued for it; a textless document states that it holds no text; and the
  page raised no error. **Mutation that proves the once-only checks:** routing `useDocxPreview` back through the
  routing path (the shape this ticket first shipped) made the run exit 1 with `FAIL the App connection did not read
  the document exactly once` while the cookie connection still passed — the bearer path was fetching the same
  remote document twice and holding two leased blobs for one viewer.
  `.dev/verify/ticket-05-docx/browser-docx-mutation.log` is that failing run; the restored hook passes 15/15
  (`.dev/verify/ticket-05-docx/browser-docx.log`).
- `packages/gateway/test/ingress-files.test.ts`: the case named "live watch and DOCX preview are named absences"
  asserted `501` for `?type=preview`, a request kind this surface has never served for any path — and a docx no longer
  needs it, because a docx read is byte-served. Its three-loop assertion (`watch`, `preview`, `allow-link`) is unchanged
  and the case is renamed to what it now proves. That suite: 9 tests, 0 fail.

### Decisions the library forces, recorded rather than papered over

- **Text, not markup.** `mammoth.extractRawText` returns the document's text runs and drops structure, styles,
  images and links, so what reaches the page is inert text mounted as React text nodes. `convertToHtml` was
  rejected: it emits an HTML document the archive chose, which would need a sanitiser policy and an owner decision
  before it could be a preview of a file on someone else's machine. The UI says what it is — a "text preview" badge,
  and a document with no text says so instead of showing a frame a reader has to interpret.
- **The input shape is the browser build's, and the check that caught it.** `mammoth`'s `browser` field maps
  `./lib/unzip.js` to `./browser/unzip.js`, which accepts only `{ arrayBuffer }` and rejects anything else with
  "Could not find file in options"; the Node `lib/unzip.js` takes `{ path }` or `{ buffer }`. So the preview passes
  an `ArrayBuffer`, and the same call cannot be run against the Node build's shape.
- **One fetch per document per connection.** `useDocxPreview` takes the address `useFileBytes` already resolved
  rather than the routing path: a Web page's address carries its cookie on the request the preview makes, and an
  App's address is the leased blob its connection already filled. Fixing this removed a second full download of the
  same remote document and a second live lease for one screen; the boundary is pinned by the two once-only checks
  above rather than by a sentence here.
- **Bounds, three times.** `DOCX_PREVIEW_MAX_BYTES` = 10 MiB, declared once in `packages/protocol/src/files.ts`.
  The viewer refuses an over-bound document before issuing a read; `readDocxBytes` checks the `content-length`
  claim and then the arriving body, cancelling at the bound; and the host's own 16 MiB read policy
  (`MAX_FILE_BYTES`) still sits above both, so a document this client offers to preview is one either gateway can
  also download whole. Nothing new was opened in the byte route.
- **The licence travels inside every artifact, and the notice has one owner** (App-parity pass). esbuild keeps only
  `@license`/`@preserve` comments and `mammoth`'s browser build has neither, so the shipped chunk states no copyright of
  its own, and the notice has to be a file the distribution carries. This section first recorded it as
  `apps/web/public/THIRD_PARTY_NOTICES.md` copied into `dist/` by Vite's public-directory step — which left the packaged
  App bundling the same reader with no notice at all, and left two files that could drift. It is now
  `packages/ui/THIRD_PARTY_NOTICES.md`, beside the manifest that declares the dependency, copied by
  `thirdPartyNoticesPlugin()` into each host's `build.outDir` (3,313 bytes measured in `apps/web/dist` and
  `apps/app/dist`). `packages/client`'s bundle pipeline (`THIRD_PARTY_NOTICES.md`, `smoke:pack`) is a separate artifact
  with its own notice and is unchanged; no second notice gate was invented for the browser page.
- **A dependency is declared by the package that imports it.** pnpm gives a workspace only what its manifest declares,
  and `packages/gateway`'s `tsc --noEmit` answers `error TS2307: Cannot find module 'mammoth' or its corresponding type
  declarations` for a `mammoth` import — which is why `packages/gateway/test/docx-fixture.ts` writes a real zip out of
  `node:zlib` and takes no dependency at all; the gateway's job on this path is the byte route, not the document. The
  same rule is what made `packages/ui`'s `devDependencies` entry the wrong home: `mammoth` is imported by production
  source (`src/lib/docx-preview.ts`) and reaches both hosts' bundles, so it is declared in `dependencies` and `apps/web`
  no longer declares it at all. `@hepi/ui` and both hosts are `private` and publish source, so no npm install path
  consumes these manifests today — the difference the move makes is not a registry promise but a stated one: a host
  outside this workspace, a `--prod` install, or a future split no longer resolves the reader by accident of a dev
  install, and if the declaration is missing the App's own build says so
  (`Rolldown failed to resolve import "mammoth"`) instead of succeeding because of an accident.
- **Weight.** esbuild over `packages/ui` with `--bundle --platform=browser --format=esm`: the root entry is
  694,015 bytes unminified, 322,572 minified; the shipped page chunk is 308,121 bytes. Hence dynamic-import, and
  the entry chunk does not contain it (`apps/web/dist/assets`, 95 chunks).

**Not run here.** `apps/web/e2e/ux-ssh-project.mjs` — it asserts a `.next/BUILD_ID` and is stale on this tree, which
builds `@hepi/web` to `dist/` under Vite (recorded under ticket 03; its precondition fails with "build first" even
after a successful `pnpm --filter @hepi/web build`, which was re-run here for the notice check and passed).
`pnpm compare:tests --base=83a1188` was reported under ticket 03 against that source and is **not** re-claimed here:
the web-unit suite's own baseline failures are the recorded ones, and this ticket's changed source is what the
rows above measured.

No boundary bypass was designed or run: no path-confinement, symlink-escape, auth or preflight probe, and no
attempt to make a hostile remote document execute. The `frames === 0` / `scripts === 0` / `window.__pwned ===
'unset'` checks are the **stated contract** of this ticket's own renderer, read through the production `FileViewer`
against a fixture document that carries a script paragraph — the smallest thing that makes "its markup stays inert"
a measurement instead of a claim — and the credential checks are the seam's routing, not an attack on it.

**Boundary.** No push, no merge *of this branch into* `integration/client-app`, no deployment, no graph rebuild, no build
on `remote-host`, no worktree other than `.dev/worktrees/ssh-workbench-05`, no file under
`/home/developer/Documents/dev/hepi-client-app` created or touched.

### App-parity pass on the merged tree; what was re-run and what was reused

`integration/client-app` `84b7039` was merged into this branch (the merge commit this section is recorded in, so it is not
named by its own SHA), taking 33 commits of integration work (MCP
conversation tools 02/03a, subagent subtree control 03, ticket 16's acceptance batch, and the credential-sandbox scripts).
Unlike the merge above, **this one does change source** - `packages/ui/src/workbench.tsx` (+132/-41), `AppShell.tsx`, the
three locale files, `packages/ui/src/index.ts` - so the reused evidence was confirmed against the merged tree rather than
asserted from it:

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `pnpm verify:changed --base=integration/client-app` on the merged tree | 1 | `workspace-typecheck` 0, `workspace-tests` 0 (every package, including the incoming subtree/MCP work), `web-unit` 0, `script-tests` 0, `check-entrypoints` 0, **`check-docs` 1** (the same 12 findings; `diff` of the `BROKEN` lines against the pre-merge run is empty) | `.dev/verify/2026-10-19T02-02-56-538-verify-changed/` (`verify.json`, sha `a0b9a18f`, `dirty: true` - the merge commit, so it names the pre-merge tip it was resolved from) |
| `pnpm --filter @hepi/ui test` | 0 | 246 tests, 246 pass, 0 fail (213 incoming subtree/connection files + this branch's 33) | reused from the `workspace-tests` row above; run again alone at `.dev/verify/ticket-05-app-parity/` (TAP in that command's stdout) |
| `pnpm --filter @hepi/web test:docx-preview` | 0 | all chromium checks pass on the merged tree, with the reader declared by `packages/ui` and not by `apps/web` | `.dev/verify/ticket-05-app-parity/merged-browser-docx.log` |
| `pnpm --filter @hepi/app build` / `pnpm --filter @hepi/web build` | 0 | each prints its own `hepi: third-party notice -> ... (3313 bytes)` line into its `dist/` | stdout of the merged run, `.dev/verify/ticket-05-app-parity/` |
| `node --test apps/app/test/docx-preview-bundle.test.mjs` | 0 | 2 pass: the App's browser bundle still resolves mammoth's browser entry after `workbench.tsx` was rewritten by subtree control 03 | stdout of the merged run |
| `pnpm verify:changed --base=integration/client-app` **on the stamped merge commit** | 1 | the same five passes and `check-docs` 1; `verify.json` records sha `9071f4df`, `dirty: false`, and its `BROKEN` lines diff empty against the resolved-tree run above | `.dev/verify/2026-10-19T02-05-54-604-verify-changed/` |

The four rows below were measured on that resolved merged tree, before the merge commit was stamped; its source is the
merge commit's own tree, so they stand for it. The App-parity rows further above were measured on `749daeb`, before the
merge; they stay the evidence for the dependency declaration and the notice plugin, whose files the merge did not touch
(`git diff --name-only 749daeb HEAD` contains neither `packages/ui/src/lib/docx-preview.ts` nor
`packages/protocol/src/files.ts`).

## SSH workbench ticket 05 follow-up: the preview cancel seam (2026-10-19)

_Tested source: `impl/ssh-workbench-05`, fix commit `f39669d90bddb047172a8a356549ad693a7bc819` (`f39669d`), cut from the
branch tip `8da96fd` - the merged tree recorded above. Source first (`f39669d`: `packages/ui/src/lib/docx-preview.ts`,
its test, and the new hook test), then the documentation of it. Not merged into
`integration/client-app`, no push, no deployment, no graph rebuild, no build on `remote-host`._

**What was wrong.** Reviewer 35's finding on `8da96fd` held for an ordinary file close, not an attack on a boundary: the
document preview's viewer hook had always handed its read an `AbortSignal`, and `readDocxBytes` had always looked at it -
**between chunks**. It never put it on the request (`open(address, options.init)`, while the controller arrived in the
sibling `signal` option), and a read already parked on `reader.read()` has no next chunk to check before the host
decides to send one. So closing a document whose SSH host had stalled left the page waiting on that read, holding its
stream and one of the filesystem's reader handles (64 per host, five-minute idle expiry,
`packages/gateway/src/filesystem.ts:18-20`) and the remote read behind it, until the abort was nothing more than a
flag on an object nobody polls.

**The fix, at the owning seam** (`packages/ui/src/lib/docx-preview.ts`, +54/-23): `previewSignal` composes the caller's
signal with any signal the request init already names (standard `AbortSignal.any`, so neither owner is the silent loser);
the composition is what goes on the sent request; the same signal is registered on the reader so an abort closes the
pending read instead of waiting for the stream; the listener is removed in a `finally`; and an abort arriving on the
document's last chunk returns `aborted` rather than a document to parse, so the answer does not depend on which side of
the final `read()` the stop landed. `loadDocxText` deliberately does not re-check after the `mammoth` import - the bytes
own the abort - and no wrapper or new seam was added.

**Checks run at `f39669d`.**

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `pnpm --filter @hepi/ui typecheck` | 0 | `tsc --noEmit` clean | stdout of the run |
| `pnpm --filter @hepi/ui test` | 0 | 257 tests, 257 pass, 0 fail (was 246; +16 in `docx-preview.test.mjs` from 8, +3 in the new `useDocxPreview.test.mjs`) | `.dev/verify/ticket-05-docx/f39669d-ui-test.log` |
| `node --test --test-reporter=tap packages/ui/src/lib/docx-preview.test.mjs` | 0 | 16 pass | `.dev/verify/ticket-05-docx/docx-abort.log` |
| `node --test --test-reporter=tap packages/ui/src/hooks/useDocxPreview.test.mjs` | 0 | 3 pass | `.dev/verify/ticket-05-docx/hook-abort.log` |
| `pnpm --filter @hepi/web test:docx-preview` | 0 | all 15 chromium checks pass on the existing docx route journey | `.dev/verify/ticket-05-docx/f39669d-browser-docx.log` |
| `node scripts/check-docs.mjs` | 1 | 12 broken relative links, the `BROKEN` lines diffing empty against the pre-change run at `8da96fd` (`diff` exit 0, reported as `IDENTICAL_TO_EARLIER_BASELINE`); the new links in this record, `docs/workbench.md` and the ticket file all resolve | `.dev/verify/ticket-05-docx/f39669d-check-docs.log` |

(`pnpm check:docs` counted a 13th finding while this section's anchor did not exist yet - the ticket file links to it;
the row above is the run after the section was added.)

**Why those tests and not others.** Focused docx lib + hook tests and `@hepi/ui` typecheck, then one browser journey
(`test:docx-preview`) because the cancel is behaviour the page can reach; no full-suite cycle was opened for a finding
reviewed to a verdict on `8da96fd`. `pnpm --filter @hepi/ui test` is the package's own gate and covers the locale and
notice suites that share the module graph.

**Load-bearing, each part measured.** The injectable source stalls the way a transport does - pull asked only while a
read waits (`highWaterMark: 0`), nothing settling but a cancel - which is the only shape that separates an abort acted on
from an abort remembered; a stream that keeps producing passes whether or not the abort does anything.

| Mutation (at `f39669d`) | Exit | Failing tests |
| --- | --- | --- |
| `open(address, init)` -> `open(address, options.init)` (composed abort never reaches the request) | 1 | lib 8, 10, 14 (3 fail); hook 1, 2, 3 (all 3 fail) - `.dev/verify/ticket-05-docx/MUTATION-1-signal-not-on-request.log`, `MUTATION-hook-2-signal-not-on-request.log` |
| drop `signal.addEventListener(`abort`, stop)` (abort never reaches a pending `read()`) | **124, timeout** | lib 11 (`# fail 1`, run hung) - `MUTATION-2-no-listener.log`; hook 1, 2, 3 all fail - `MUTATION-hook-1-no-listener.log` |
| drop the final `aborted` check (last-chunk stop becomes a document) | 1 | lib 11, 12, 14 (3 fail) - `MUTATION-3-no-final-check.log` |
| drop `removeEventListener` in the `finally` (listener leaks) | 1 | lib 13 - `MUTATION-4-no-listener-cleanup.log` |
| `previewSignal` returns the caller's signal alone (init's own signal dropped) | 1 | lib 10, "a stop from either the preview or the request itself ends the read" - `MUTATION-6-caller-only-composition.log`; the hook file stays green, which is why the composition case lives in the lib suite |

**Reused unchanged:** the App-parity and ticket-05 rows above (protocol bounds, gateway routing, notices, bundle
resolution) - this change touches no manifest, no lockfile, no gateway or protocol source, and `git diff --name-only
8da96fd f39669d` is three files under `packages/ui`.

**Boundary.** Fix commit `f39669d` is the source; `docs/workbench.md`, this record and the ticket file follow it.
No merge into `integration/client-app`, no push, no deploy, no `remote-host` build, no graph update.
---

## Client app integration: SSH workbench ticket 05 (2026-10-19)

**Merged.** `impl/ssh-workbench-05` at **`f6e1004bc56490d6be18b72ee96c294d7779c2aa`** into `integration/client-app` as
**`871ae72835c7264d74782cee612a61d2e247798c`** (`--no-ff`, parents `66a56f3e4e6e894b50395b7b4e1b1c9c2345f8de` +
`f6e1004…`, exact pinned tip, no later commit taken). **`871ae72` is the tested source tip**; the evidence commit after it
is documentation only. Second review by reviewer35: Std 0 / Spec 0, no material findings. The first review's single P2 —
an abort that never reached the request — is fixed in source commit `f39669d` and was confirmed by the parent at the seam
(signal composed into `RequestInit`, reader cancelled on abort, listener dropped in `finally`, abort on the final chunk
still returns the caller's abort). The sections above this one (`ticket 05` and `the preview cancel seam`) are the
**branch's own** measurements, carried in by the merge; this section records only what was true at the merged tip.

### The overlap was smaller than the queue assumed, and why

The queue expected `docs/upstream-sources.md` to be both-sides. It was not. `git merge-base HEAD f6e1004` is
**`c6babf3`** — my own MCP 03a evidence commit — because that lane merged integration twice while this queue was open
(`2713d53` took `c2d9089`, then merge `9071f4d` had parents `a0b9a18` + `c6babf3`). Confirmed rather than inferred:
`c6babf3` is an ancestor of `f6e1004`, and `packages/gateway/src/mcp/listing.ts` plus all of
`.scratch/mcp-conversation-tools/` on the branch are byte-identical to the integration tip. **The MCP fixture adaptation
the queue asked me to keep was already kept by the branch's own merge**, so there was nothing for me to re-arbitrate.

That leaves **one** both-sides file: `docs/verification.md`, the ledger both lanes append to. It still needed no manual
resolution:

- `git merge-tree --write-tree HEAD f6e1004` → **exit 0**, tree `7bdc52ef0a9e806ecb416105fa304c07bb02f8c6`. The merge
  produced **exactly that tree** (`git rev-parse HEAD^{tree}` equals it), so nothing was decided after the preview.
- Direction-checked anyway, because "auto-merged" is not a proof: **266/266** branch-added ledger lines are present at the
  tip, and **7/7** integration-added lines from my two post-merge evidence commits (`6b7de55`, `66a56f3`) are still
  present. `git diff --stat HEAD f6e1004` is `docs/verification.md | 2 insertions(+), 8 deletions(-)` — the merged tree
  is the branch plus those two commits and nothing else.
- `docs/migration-status.md` and `docs/upstream-sources.md` were **branch-only** against this base, so the DOCX licence
  record and the MCP record could not collide; both are present at the tip.

### The dependency move, and why no install ran

`mammoth` is imported by production source (`packages/ui/src/lib/docx-preview.ts:156`, a dynamic import) but was
declared as a `devDependency` of `packages/ui` and of `apps/web`. The branch moves it to **`packages/ui`
`dependencies`** and deletes both dev entries — one lockfile importer instead of two (`awk` over `pnpm-lock.yaml` prints
exactly `importer: packages/ui:`). Correct owner: the package that imports declares it.

No install was run, and that was checked rather than hoped: `mammoth@1.13.0`'s resolution block (version + integrity)
diffs **identical** between the base and branch lockfiles, the store `node_modules/.pnpm/mammoth@1.13.0` already
existed, and the sole importer after the move was already linked. Nothing outside `packages/ui` imports it (the only
other reference is `third-party-notices.test.mjs:29`, reading its installed `package.json`). The full workspace run
below is the proof — a missing link fails at import, and nothing failed.

### What the new combination required, and what was reused

Both hosts' `vite.config.ts` now import `@hepi/ui/lib/third-party-notices` (a new `exports` subpath) and register
`thirdPartyNoticesPlugin()`, and `apps/web/package.json` gains `test:docx-preview`. That combination existed on neither
side before the merge, so JS builds ran. **No Rust, no Tauri** — 0 changed files under `apps/app/src-tauri`; the new
bundle test answers its module-resolution question with `esbuild buildSync` only.

| command | exit | what the log says |
| --- | --- | --- |
| `pnpm --filter @hepi/app build` | 0 | wrote `apps/app/dist/THIRD_PARTY_NOTICES.md` (3313 B) fresh beside `index.html` |
| `pnpm --filter @hepi/web build` | 0 | wrote `apps/web/dist/THIRD_PARTY_NOTICES.md`; both carry the `mammoth` BSD line |
| `node --test apps/app/test/docx-preview-bundle.test.mjs` | 0 | **2 pass**: the browser build resolves mammoth's browser entry, not `lib/unzip.js` / `lib/docx/files.js` (which need `Buffer`) |
| `pnpm --filter @hepi/web test:docx-preview` | 0 | **15/15 chromium checks**: bytes not text-preview, document markup mounted as text (0 frames, 0 scripts, `window.__pwned` unset), read exactly once per connection, and an over-bound document refused **before** any byte request (`[]`) |
| `node --test` over the 4 docx/licence/locale ui files | 0 | **29 pass** = lib 16 + hook 3 + notices 7 + locale 3 — the cancel-seam and licensing files measured at `f39669d` |
| `pnpm --filter @hepi/ui --filter @hepi/app --filter @hepi/web typecheck` | 0 | 0 `error TS` |
| `node scripts/check-entrypoints.mjs` | 0 | 81 present, 2 known-missing (pre-existing), 0 newly missing |
| `node scripts/check-docs.mjs` | 1 | **396** Markdown files, the same **12** broken relative links; `BROKEN` lines diff empty against the `merge-client-app-8` baseline list |

**Evidence reused validly:** `git diff --quiet f39669d f6e1004 -- packages apps scripts` is exit 0 — the tip adds only
documentation (ticket row, ledger, `docs/workbench.md`) — so the branch's ui-257 / type-0 / lib-16 / hook-3 / browser-15
numbers describe the merged source, not a superseded one.

### The narrowing I planned was refused by the repository's own gate, so the gate ran full

The instruction was to avoid repeating the gateway/server full suites. I tried: `pnpm verify:changed --base=66a56f3
--test-file=<9 files>` exited **2** with `Cannot select changed checks: --test-file cannot narrow the full fallback for
pnpm-lock.yaml`. A changed lockfile is precisely the case where per-file narrowing could hide a resolution problem, so
the selector upgrades to `tests: full`. That is the gate's rule overriding my convenience — I ran it un-narrowed rather
than dropping the gate. The full run passed everything (`.dev/verify/2026-10-19T03-02-33-754-verify-changed/`,
`sha 871ae72…`, `dirty false`, `dirtyFiles []`): workspace-typecheck 0, workspace-tests 0, web-unit 0, script-tests 0,
check-entrypoints 0, check-docs 1 (baseline only).

Per-package counts taken from that single log, each predicted before the run — which is the cross-check that no suite
stopped running: **protocol 53** (51 + 2 new `files.test.ts`), **ui 257** (228 + 16 + 3 + 7 + 3, equal to the branch's
own 257), **app 12** (10 + 2 bundle cases), **gateway 450** (448 + 1 `files-surface` + 1 `ingress-ssh-workbench`),
**server 493**, **session 57**, **client 10**, web-unit 52, scripts 85 — **0 failures anywhere**. No test file was
deleted (`git diff --diff-filter=D 66a56f3 HEAD` is empty), so that arithmetic has no negative terms. `apps/server`,
`packages/session`, `packages/gateway/src/{index,startup}.ts`, `packages/gateway/src/mcp` and
`packages/protocol/src/gateway.ts` are byte-identical to the base, so their passing is a no-drop confirmation for the
merge, not new coverage of them.

**Reverse impact as a search, not a feeling.** Exactly **one** gateway source file changed
(`packages/gateway/src/files-surface.ts`: the `?type=preview` refusal wording). Its consumers are `index.ts`,
`ingress/index.ts` and `packages/ui/src/lib/file-seam.ts`. The changed protocol file `packages/protocol/src/files.ts`
(`servesBytes` now routes a docx to its own bytes) has exactly one gateway consumer — `files-surface.ts` — and its ui
consumers are covered by the ui-257 and web-unit-52 runs. `docx-fixture.ts` is used only by
`ingress-ssh-workbench.test.ts`. No test anywhere asserts the old sentence; the new one is asserted by the renamed
`ingress-files.test.ts` case and by the browser journey.

### Honest limit: no live SSH host was interrupted

The defect was a stalled remote read holding a stream, a leased reader handle (`packages/gateway/src/filesystem.ts:18`,
64 per filesystem) and the SSH read behind it. What proves the fix is cancelled-stalled-stream coverage: the injectable
source stalls like a transport (pull asked only while a read waits at `highWaterMark: 0`) — the only shape that
separates an abort acted on from an abort remembered — and dropping the listener hangs that case to its timeout (exit
124). **No `remote-host` or other live host was touched and no real remote read was interrupted for this merge.
`ingress-ssh-workbench.test.ts` runs the real SSH classes over the in-process `fakeSsh` with git on a temporary tree, so
it does prove docx parity across both host kinds (same bytes, MIME and `previewKind` for `LOCAL` and `REMOTE`) and does
not prove that a stopped remote process reacts. The branch's own record already states the remote half as reasoning; that
limit stands unchanged by the merge.

### Records corrected on the way in

`.scratch/ssh-remote-workbench/README.md:6` said ticket 05 was "delivered on `impl/ssh-remote-workbench-05` awaiting
integration" — updated to integrated at `871ae72`, with `84b7039` named as the batch it inherited. The other sentences
that still describe DOCX preview as unconnected are **dated historical records** (`docs/verification.md:2970` is the
pre-ticket-05 finding that the spec's "already renders" premise was false; `:3624` names a test the branch renamed), so
they stay as written rather than being rewritten after the fact. `docs/migration-status.md` and
`docs/workbench.md#the-word-document-preview` carry current behaviour.

**Graph:** one update for the integrated code batch (03a `8f71db4` + ticket 05 `871ae72`), run after the code tip, not
after each documentation commit. **No deployment, no push:** `local/integration-client-app` stays at `a39dc80`, the
running `release-1873d24` artifacts and the four `hepi-*` user services are untouched, no remote build, and
`.dev/worktrees/client-app-16-acceptance` (worker36) plus the open 03b/provider-03 lanes were not written to.


## Provider lane into integration: how to read the two blocks above and below (2026-10-19)

_The three SSH workbench ticket 05 sections above are integration/client-app's own records, kept exactly as the_
_integration side wrote them. The provider connection ticket 03/04 and review-iteration sections below were written on_
_the provider lane and name that lane's own revisions (4245fcf, b20d814, 32d2a25, faae18a); they are the evidence this_
_merge carries in, not a re-statement of the rows above. Ordering is lane history, not precedence: the merge changed no_
_source file in either block, so every row still describes the tree it ran on._

## Client app integration: provider connection ticket 03 (2026-10-19)

`impl/provider-connection-03` runs the provider sign-in flows on this host and wires Settings to them. Ticket 01 owned the
credential file and ticket 02 the browser relay for keys; what lands here is pi-ai's own login driven by the gateway
(`packages/gateway/src/provider-login.ts`, `POST /v1/providers/login`) through a `CredentialStore` adapter over the same
locked `auth.json`, and the browser half as **polled** flow state (`/api/auth/login/:id` start/poll/answer/cancel, plus
`POST /api/auth/logout/:id`) instead of the `EventSource` that used to stream it. No OAuth protocol logic is added, no
credential is written anywhere but that file, and no value a flow produced or a person typed is in any answer this
surface writes.

Two properties decided the shape. A flow's lifetime cannot belong to a socket, because the person finishes it in another
browser: hence poll, a host-side TTL, and a resume-by-provider read. And a flow's id cannot be the only claim on it,
because one ingress shares one host bearer across its clients: hence the host keys each flow by the caller this ingress
admitted (`device:<credential id>`, `web:<hash of the session cookie>`), a stranger gets the same 404 as an id that never
existed, and a revoked device credential makes this entrance ask the host to forget that caller's open flows before one
can finish and store a credential nobody can reach.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Selected gates (typecheck + tests for app, server, web, gateway, protocol, session, ui; web-unit; docs) | `node scripts/verify.mjs --profile=changed --base=integration/client-app` | `4245fcf` (`dirty: false`) | 1 - `check-docs` only | `.dev/verify/provider03-merged/verify.json` |
| Host seam, 12 tests: manual and device flows to success, cancel reaches the provider's wait, TTL expiry stores nothing, caller isolation, masked provider text, `login-forget`, flow limit, no-capability host, `stop()` | `node --test packages/gateway/test/provider-login.test.ts` | `4245fcf` | 0 | `.dev/verify/provider03/provider-login.log` |
| Client ingress seam, 13 tests: start/question/answer/stored over real HTTP, stranger 404s, revoked caller's own flows dropped, refusal shapes, 501 without the service while keys and sign-out work, 503 unconfigured and unreachable, Backend sees no provider route or credential | `node --test packages/gateway/test/ingress-providers.test.ts` | `4245fcf` | 0 | `.dev/verify/provider03/ingress-providers.log` |
| Panel contracts, 5 + 5 tests | `node --test packages/ui/src/lib/provider-login.test.mjs packages/ui/src/lib/provider-auth.test.mjs` | `4245fcf` | 0 | `.dev/verify/provider03/ui-provider-login.log`, `…/ui-provider-auth.log` |
| Browser seam: withheld at a 501, one click one flow, device code and authorization URL rendered whole, answer in exactly one request body and in nothing rendered, cancel and disconnect, no browser storage | `pnpm --filter @hepi/web test:panel-ingress` | `4245fcf` | 0 (PASS) | `.dev/verify/provider03/browser-panel-ingress-tip.log` |
| Capability three-state unchanged with the sign-in gate serving flows | `pnpm --filter @hepi/web test:capability-trust` | `4245fcf` | 0 (PASS) | `.dev/verify/provider03/browser-capability-trust-tip.log` |

Counts from `changed-test` on the merged tree: gateway 458, server 473, ui 203, protocol 52, session 52, app 9, 0
failures; `web-unit` 52/52. `check-docs` exits 1 on the unchanged 12-link baseline across 385 files, its sorted `BROKEN`
set diffing empty against ticket 02's retained set. Two pre-merge parallel-run flakes (`apps/server` upload-over-body-
limit, `packages/ui` device-bearer conversation journey) pass isolated and as whole package suites and passed in the merged
run; recorded, not chased, and neither package's source is touched here.

The full record, including what a scripted provider cannot prove and why no loopback callback is relayed, is in
[ticket 03's own answer](../.scratch/provider-connection/issues/03-pi-ai-login-flows.md).

## Client app integration: provider connection ticket 04 (2026-10-19)

`impl/provider-connection-03` closes the availability question tickets 02 and 03 left. The ticket asked for a refresh or
invalidation signal after a Gateway auth mutation; the seam was run first, and it answered that the Backend is not the
stale party. `apps/server/test/provider-availability.test.ts` composes one agent directory read two ways — a durable
Backend whose registry is that directory in Pi mode, and this repository's own execution Gateway `ProviderAuthService`
writing that directory's `auth.json` — and asserts the facts the contract needs: a credential the Gateway stores makes
that file's catalog model available on the Backend's next read with no restart and no refresh call; a replaced key
changes the answer; a removed one withdraws it; a Backend that cannot load its credential file reports it without
rolling back or rewriting what the host stored; and an environment-mode Backend over the same directory is not made to
offer the model by a credential the Gateway stored, which is that mode's rule rather than a missing route. Every answer
is asserted to carry no credential value.

The client half is the one answer that does go stale: the catalog this page caches per connection. That instance moved to
`packages/ui/src/lib/models-cache.ts`, so the surface that supersedes an answer is not reaching into a hook's module
state, and `invalidateModelCatalog()` is called by every confirmed credential change — key save, key remove, sign-in
completion, sign-out — the way a `models.json` save already bumped the generation. A composer that is open keeps what it
shows and its next read asks the deployment again, so this is an invalidation and not a reload: nothing fetches, notifies
or retries.

The third change is a wrong message rather than a missing capability. `POST /api/models/refresh` is a limit no process
behind this origin owns, and the enabled-models view used to POST to it and render the refusal as the provider's endpoint
being unreachable — blaming a third party for a route this deployment never had, and offering a retry that reaches the
same limit. It now asks that route as its control's own capability and withholds the button on that answer, keeping the
control on every other answer including none; the Next BFF answers the same code as every other unconnected route, so
both hosts mean one thing.

Two revisions are stated separately, because the branch advanced between them: the change landed at **`32d2a25`**, and
`integration/client-app` `66a56f3` — carrying MCP conversation tools 03a at `d95d6d4` — merged in as **`faae18a`**. A
count from one is not claimed for the other.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Gateway-write / Backend-read seam, both modes, 4 tests | `node --test apps/server/test/provider-availability.test.ts` | `32d2a25` | 0 - 4/4 | `.dev/verify/provider04-merged/provider-availability.log` (re-run at `faae18a`) |
| Whole Backend suite | `pnpm --filter @hepi/server test` | `faae18a` | 0 - 497/497 | `.dev/verify/provider04-merged/server-test.log` |
| Whole UI suite, incl. the cache drop, its generation fence and its connection scope | `pnpm --filter @hepi/ui test` | `faae18a` | 0 - 235/235 | `.dev/verify/provider04-merged/ui-test.log` |
| Browser seam: a credential change drops the page's cached catalog and the next read asks again; no catalog-refresh control is offered where the ingress answers the limit and no pass is started against it | `pnpm --filter @hepi/web test:panel-ingress` | `faae18a` | 0 (PASS, 61 checks) | `.dev/verify/provider04-merged/panel-ingress.log` |
| Capability three-state intact with the new control gate | `pnpm --filter @hepi/web test:capability-trust` | `faae18a` | 0 (PASS, 17 checks) | `.dev/verify/provider04-merged/capability-trust.log` |
| Selected gates over the changed packages and their dependents | `node scripts/verify.mjs --profile=changed --base=integration/client-app` | `faae18a`, `dirty: false` | 1 - `check-docs` only | `.dev/verify/provider04-merged/verify.json`, `…/changed-typecheck.log`, `…/changed-test.log`, `…/web-unit.log`, `…/check-docs.log` |
| The invalidation is load-bearing: with the `invalidateModelCatalog()` call removed the same browser suite fails rather than passing quietly | `pnpm --filter @hepi/web test:panel-ingress` | `32d2a25`, mutated | 1 - `FAIL the fixture threw: page.waitForFunction: Timeout 30000ms exceeded` | `.dev/verify/provider04/panel-ingress-without-invalidation.log` |

`changed-test` on the merged tree: app 10, server 497, gateway 468, protocol 52, session 57, ui 235 — 0 failures;
`web-unit` 52/52; every typecheck exits 0. `check-docs` exits 1 on the unchanged 12-link broken set, now across 388
files, its sorted `BROKEN` list identical to the set tickets 02/03 retained — a baseline failure, not a new one.

The merge took **both** sides of the two overlapping files: `packages/protocol/src/gateway.ts` gained MCP 03a's
`MCP_LIST_*` bounds, `McpToolListRequest`/`McpToolDescriptor`/`McpToolList`/`McpToolListFailureCode`/`McpToolListResult`
beside this lane's `ProviderLogin*` shapes with no type defined twice, and `packages/gateway/src/index.ts` re-exports MCP
03a's `McpTool*` types alongside this lane's `ProviderLoginService` exports. Nothing in MCP 03a's seam was touched: no
Backend `/mcp-conversation-tools` route, no gateway `tools` operation, no workbench tools panel, no change to
`mcp-conversation-tools.ts` or `mcp-declarations.ts`. docs/verification.md itself conflicted at its tail — ticket 03a's
merged section and this lane's two provider sections were appended after the same anchor — and was resolved by keeping the
integration's ordering, its superseded note about MCP ticket 02 included, and re-placing the provider sections after it.

## Client app integration: provider connection tickets 03/04 review iteration (2026-10-19)

Review of tickets 03/04 at the pinned source `2ac94bc` returned three requests for change, and all three were defects in the
code rather than in how it was documented; a fourth fell out of the third's fixture work. Each is fixed at the seam that owns
it, in `b20d814`, with these two records landing as a separate commit so that every revision named below names a tree that
existed while its check ran. The prose of each finding is in the ticket 03 record; this entry holds the seams and the counts.

The one worth restating at this level is the store's. A cancelled, expired or revoked sign-in reaches `auth.json` through
`ProviderFileCredentialStore.modify`, which is handed the login's abort signal and had been ignoring it — so a caller that left
during the lock wait still got its credential stored, the opposite of what docs/client-ingress.md and docs/architecture.md
claimed. The two moments the store owns are now checked against that signal, and the review's other concern — that an abort
check might break a legitimate wait — is held by checks in the same file: a write that waits for another writer still commits
exactly once, the credential decision is asked at most once, and one lock still covers read-decide-write.

The panel and the host disagreed about what a read means. An ended flow stays readable for `PROVIDER_LOGIN_KEEP_MS` and
`login-status` answers it, so a panel that adopted whatever it read showed its own last cancel and sent no start — a Login
button that did nothing for a minute — while a host returning the first Map match could hide a live flow behind an older
record. An open flow wins at both ends; a terminal flow on a resume read is now expected, and the panel starts the host's
idempotent sign-in on seeing one. The browser fixture models that readable window instead of dropping the flow when it ends,
so the suite performs the sequence a person performs, and fails without the guard.

The fourth is the OpenAI-shaped flow ticket 03 already recorded as unexercised: `#deviceId()` wrote
`~/.pi/agent/installation-id` ahead of the credential file's step that creates the agent directory under its lock, so on a host
that had never signed in the account directory's first write answered `ENOENT` and the sign-in failed as `operation_failed`
before producing anything. The directory is now created the way the credential file creates it — recursive, `0700`, with the id
file at `0600` — and a scripted provider asks for the id, which covers the path without reaching a real upstream.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Store's abort contract, and the serialized write it must not break — 6 tests | `node --test packages/gateway/test/provider-credential-store.test.ts` | `b20d814` (`dirty: these two records only`) | 0 - 6/6 | `.dev/verify/provider03-review-fix-final/store-abort.log` |
| Whole Gateway suite, incl. 3 new sign-in checks and the existing 474 | `pnpm --filter @hepi/gateway test` | `b20d814` (`dirty: these two records only`) | 0 - 477/477 | `.dev/verify/provider03-review-fix-final/gateway-test.log` |
| Whole UI suite | `pnpm --filter @hepi/ui test` | `b20d814` (`dirty: these two records only`) | 0 - 235/235 | `.dev/verify/provider03-review-fix-final/ui-test.log` |
| Browser seam, incl. a second sign-in started after an ended one | `pnpm --filter @hepi/web test:panel-ingress` | `b20d814` (`dirty: these two records only`) | 0 - PASS, 65 checks | `.dev/verify/provider03-review-fix-final/panel-ingress.log` |
| Capability three-state intact with the fixture's readable ended flow | `pnpm --filter @hepi/web test:capability-trust` | `b20d814` (`dirty: these two records only`) | 0 - PASS, 17 checks | `.dev/verify/provider03-review-fix-final/capability-trust.log` |
| `@hepi/web` typecheck after the fixture change | `pnpm --filter @hepi/web typecheck` | `b20d814` (`dirty: these two records only`) | 0 | `.dev/verify/provider03-review-fix-final/web-typecheck.log` |
| Selected gates over the changed packages and their dependents | `node scripts/verify.mjs --profile=changed --base=integration/client-app` | `b20d814` (`dirty: true` - `verify.json` names exactly these two records) | 1 - `check-docs` only | `.dev/verify/provider03-review-fix-gates/verify.json` and its logs |
| Mutation: both signal checks removed from the store's write | `node --test packages/gateway/test/provider-credential-store.test.ts` | `b20d814` (`dirty: one line restored`) | 1 - 3 failures, incl. the queued-abort case | `.dev/verify/provider03-review-fix/store-mutation.log` |
| Mutation: `login-status` back to first-match-wins | `node --test packages/gateway/test/provider-login.test.ts --test-name-pattern "provider read answers"` | `b20d814` (`dirty: one line restored`) | 1 - "the open flow was hidden by the older ended record" | `.dev/verify/provider03-review-fix/status-mutation.log` |
| Mutation: the agent-directory creation removed | `node --test packages/gateway/test/provider-login.test.ts --test-name-pattern "installation id"` | `b20d814` (`dirty: one line restored`) | 1 - 2 failures, both the fresh-host sign-in | `.dev/verify/provider03-review-fix/deviceid-mutation.log` |
| Mutation: the panel adopts any flow it reads again | `pnpm --filter @hepi/web test:panel-ingress` | `b20d814` (`dirty: one line restored`) | 1 - after Re-login, no Cancel control arrives (`ux-panel-ingress.mjs:264`): the panel re-adopted the ended flow and sent no start | `.dev/verify/provider03-review-fix/panel-ingress-without-terminal-guard.log` |

The selected gates' counts, from that report: app 10, server 497, gateway 477 (the 3 new sign-in checks included), protocol 52,
session 57, ui 235 — 0 failures; `web-unit` 52/52; every typecheck exit 0. `check-docs` exits 1 on 12 broken relative links and
its sorted `BROKEN` list is byte-identical to the baseline retained under `.dev/verify/` by tickets 02/03/04 — a baseline
failure, not a new one - re-confirmed at this section's own commit `c0a454a`, where the `BROKEN` set is unchanged
(`.dev/verify/provider03-review-records/check-docs.log`). Because the gates ran on the fix's own commit with only these two
records unwritten, the tree they
describe is the tree this iteration shipped. An earlier pass of the same package and browser commands, retained in
`.dev/verify/provider03-review-fix/` beside the mutation logs, agreed with these counts.

Nothing here expands the environment-mode question: the review confirmed the capability note is a documented limit and not a
bug, so no UI text changed and no deployment mode was touched. No auth- or trust-boundary probe was run — these are the
ordinary credential-store and catalog composition paths the lane is already authorized for — and no live credential, host
service or deployment was touched. The real-upstream OAuth half stays outside what these checks prove, exactly as ticket 03's
limits state it, and ticket 05's composed-browser journey is unchanged as the place that claim would be settled.
Named and not held: a host-local check that a credential stored through a real browser becomes selectable in a real
conversation's model list on one shared-account host. The deployed stack runs the Backend in environment mode with a
container-private agent directory, so it cannot see the Web host's `auth.json` — by design; mounting that directory in
would move a workstation user's OAuth refresh tokens into the container's reach, which docs/deployment.md now states
against this revision. Also not held: that `d95d6d4` and this lane's provider surfaces compose at the **wire** rather than
at the source — the merged tree typechecks and both suites pass, which covers the shared exports and the shared protocol
module, while a browser exercising one server's tool listing beside a live provider sign-in belongs to MCP ticket 03b.


## Client app integration: provider connection tickets 03/04 merge (2026-10-19)

_The merge itself: lane tip `15c2b19` (source `32d2a25`, review fixes `b20d814`, records `15c2b19`) merged with_
_`integration/client-app` `3e69c62` as `60e9148` (parents `15c2b19` + `3e69c62`), which the integration branch_
_then took as a fast-forward, so the integration tip **is** `60e9148` and the two worktrees' `HEAD^{tree}` are identical_
_(`7435386`); only this record, committed after it, makes the tips differ. No cherry-pick was needed: `32d2a25`, `2ac94bc` and_
_`faae18a` are ancestors of `15c2b19` (checked per SHA with `git merge-base --is-ancestor`), which is the UX closeout P1/P2_
_recovery satisfied by ancestry rather than by re-applying patches. Integration's own ticket 05 DOCX preview, MCP 03a and the_
_approved UX closeout plans came the other way in the same merge._

**Eleven files were touched by both sides and not one of them is source.** Six conflicted and were resolved by hand — the five
_`.scratch/provider-connection` planning files plus `docs/verification.md`. The other five (`docs/migration-status.md`, `.scratch/provider-connection/spec.md`,
and the three locale message files) auto-merged keeping both sides' lines; a hand-resolved code file would itself have been the
finding, and there is none. `docs/verification.md` keeps both blocks in full — integration's three SSH workbench ticket 05 sections first,
then the lane's three provider sections, with a seam note naming the revisions each ran on; ordering is lane history, not
precedence. The five planning files keep the lane's delivered status **and** the approved addenda verbatim: the recovery
instructions are marked satisfied by this merge rather than pending, and ticket 04 records this merge's source review of the four
P2 acceptance additions (composer availability through the two-signal chain, the pre-existing ticket 13 unavailable-model
labelling, save-versus-apply separation, and the one-page/one-account invalidation recorded as deliberate rather than fixed).
Ticket 05 keeps `ready-for-agent` plus the approved real-path observations, its pin widened to the integrated tip.

**What composition had to prove, and does.** The one dependency the two lanes moved together is `mammoth`: `packages/ui` still
declares it as a production dependency (it is the importer, `src/lib/docx-preview.ts`) and `apps/web` no longer declares it at all — the
merged tree resolves it through `packages/ui/node_modules/mammoth` (1.13.0), which is exactly what ticket 16's bundle test asserts, and no
import or config was edited to get there. The i18n files kept both sides' keys in all three locales and the merged locale-key test
passes. The lane's edits to `packages/gateway/src/index.ts` and `packages/protocol/src/gateway.ts` land on top of MCP 03a, whose changes are
in the merge base `66a56f3`, so those are not both-sides files here: what this pair proves is the composition the earlier 03a record
expected of this merge — two protocol additions and one gateway composition point, typechecked and tested together.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Selected gates over the merged tree | `node scripts/verify.mjs --profile=changed --base=3e69c62` | `60e9148` (`dirty: false`) | 1 — `check-docs` only | `.dev/verify/2026-10-19T04-51-13-318-verify-changed/verify.json` |
| Changed packages and dependents (app 12, server 497, gateway 479, protocol 54, session 57, ui 264) | same run, `changed-test` step | `60e9148` | 0 | `…/2026-10-19T04-51-13-318-verify-changed/changed-test.log` |
| Seven-package typecheck | same run, `changed-typecheck` step | `60e9148` | 0 | `…/2026-10-19T04-51-13-318-verify-changed/changed-typecheck.log` |
| Web unit, incl. ticket 16's docx bundle test | same run, `web-unit` step | `60e9148` | 0 — 52/52 | `…/2026-10-19T04-51-13-318-verify-changed/web-unit.log` |
| Browser seam composing both lanes' UI: sign-in panel, catalog drop, withheld catalog-refresh control | `node apps/web/e2e/ux-panel-ingress.mjs` | `60e9148` | 0 — PASS, 65 checks | `.dev/verify/provider03-integration-pre/panel-ingress.log` |
| Capability three-state with the sign-in gate serving flows | `node apps/web/e2e/ux-capability-trust.mjs` | `60e9148` | 0 — 17 checks | `.dev/verify/provider03-integration-pre/capability-trust.log` |
| Integration's own browser check running against provider-touched `packages/ui` | `node apps/web/e2e/ux-docx-preview.mjs` | `60e9148` | 0 — 15 checks | `.dev/verify/provider03-integration-pre/docx-preview.log` |
| Locale key parity across the merged message files | `node --test packages/ui/src/lib/i18n/messages/locale-keys.test.mjs` | `60e9148` | 0 | `.dev/verify/provider03-integration-pre/locale-keys.log` |

**One composition finding, and where it belongs.** The first `pnpm --filter @hepi/server test` on the merged tree exited 1 (496/497) on the
environment-mode case in `apps/server/test/models-config.test.ts` (`environment mode keeps credentials in memory and never reads the
agent directory's auth.json`); two direct re-runs and the `verify:changed` step above all report 497/497, exit 0. Neither side touched that
file since the merge base (`git diff --name-only 66a56f3 60e9148 -- apps/server/test/models-config.test.ts` is empty), and the cause is inside
the file: sibling tests assign `process.env.HEPI_PROVIDER_API_KEY` and the runner interleaves files within a package, so this is a
pre-existing intra-package environment race — not a product of this merge, and not provider-lane code. **Recorded, not fixed:**
no source was changed to make a flake disappear, and the honest statement is that the merged tree passes with that one known race
in the suite. Revisit condition: a second occurrence in an ordinary run.

**`check-docs` at this merge exits 1 on 29 broken relative links, and the split matters.** 12 of them are the lane's retained baseline
(`.dev/verify/provider03-review-records/check-docs.log` and its successors — the same 12 `file:line:target` through `b20d814`). The other 17 are
integration's own: the planning commit `3e69c62` wrote links as absolute integration-worktree paths, which the checker cannot resolve
outside the repository root, plus anchors no heading produces. This merge touches none of those 17 files, so they are inherited,
not introduced, and they are retired by the parent's `docs/client-core-status-next` `b2dfb3f` (portable relative links, heading-target
validation, and the explicit `ux-closeout-2026-10-19` anchor), which the merger merges into integration immediately after this merge.
Recorded here as the disposition, not claimed as this run's result.

**Limits this merge does not remove.** The real upstream OAuth half stays untested: every flow here is pi-ai's shape against a
scripted provider, no live provider sign-in was attempted, and no real credential, host service or deployment was read or mutated.
Ticket 05's composed same-account browser journey stays separate acceptance work and is **not** claimed by this merge — integrating
the branch integrates its source, not its acceptance. No bypass or security-control probe was designed or run; the checks above are
the ordinary admitted credential and catalog paths. `graphify-out/graph.json` is parent-owned: no graph rebuild was run here, and the
_`invalidateModelCatalog` query against the integration graph returned no nodes, so navigation used source reads. No push, no deploy, no
build on `remote-host`.

## Client app integration: docs/core-status merge (2026-10-19)

_`docs/client-core-status-next` `b2dfb3f` (with `a0b90be`) merged into `integration/client-app` `2ba3058` as **
_`844d1e5`** (parents `2ba3058` + `b2dfb3f`, merge base `3e69c62`), a three-way merge rather than a fast-forward
_because both sides moved on from `3e69c62`. Docs only: the merge's own diff touches 18 planning/review files under
_`.scratch/client-app` and `.scratch/ux-closeout-research` and **zero** files outside those two trees — no source, build, dependency or
_runtime change, so no test or typecheck was rerun (the tree's source is byte-identical to `60e9148` apart from `docs/verification.md`)._

**Both-sides files and what preservation means here.** `.scratch/client-app/spec.md` and `.scratch/client-app/ticket-breakdown.md` were touched
_by the parent's Pilo planning commit `2ba3058` (stage G, tickets 23–25) and by the incoming link/status fixes, in disjoint hunks: the merged
_tree keeps the Pilo section heading, the stage-G table rows and `docs/research/pilo-simplicity-review.md` **and** the portable links — verified by
_the merge producing no conflict markers in any file (`git diff --diff-filter=U` empty, zero markers by grep) and by the retained text being
_read back at `spec.md:235` and `ticket-breakdown.md:143`. This merge is the disposition recorded as pending in the 03/04 merge section above,
_and the measurement now backs it: broken relative links at `60e9148` were 29, at `844d1e5` they are 14.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Docs/link check over the merged tree | `pnpm check:docs` | `844d1e5` (`dirty: false`) | 1 — 14 broken links, 1 uncovered guide | `.dev/verify/docs-merge-b2dfb3f/check-docs.log` |

**14 = the lane's retained 12 plus 2, and the 2 are this branch's own new planning links, not the merge's.** The retained 12 are
_unchanged (`.scratch/architecture-unification/issues/11`, nine `.scratch/design-fixes/host/diagnosis.md` targets under
_`.dev/verify`, two `.scratch/development-audit` skill paths). The 2 new ones are `.scratch/client-app/spec.md:237` and
_`.scratch/ux-closeout-research/spec.md:69`, both pointing at the stage-G heading, and both are a checker convention the heading cannot
_satisfy: `headingAnchor()` in `scripts/lib/discovery.mjs` strips every character outside `[a-z0-9 -]`, so a CJK heading collapses to
_`g--pilo-2026-10-19` and any fragment containing the Chinese words is unreachable. The same run also reports
_`UNCOVERED docs/research/pilo-simplicity-review.md — not linked from docs/README.md`, which the index has to gain. All three belong to the
_Pilo planning revision `2ba3058` (its own links, its own new guide), not to this merge and not to provider work; fixing them means either an
_ASCII heading or a checker that keeps non-Latin characters, which is the docs branch's call, not a merge-time edit.

**Provider limits this merge does not change.** Tickets 01–04 stay delivered/integrated and ticket 05 stays `ready-for-agent` with nothing
_asserted; the real-path observations remain **not held** — no live host-local check that a credential stored through a real browser
_becomes selectable in a real conversation's model list, the agent-directory isolation stands, and the real upstream OAuth
_half stays untested (scripted provider only, no live sign-in, no credential mutation, no bypass or security-control probe).
_Android, native, system and performance limits remain open as stated in the Pilo planning revision. No push, no deploy, no build
_on `remote-host`; `graphify-out/graph.json` is parent-owned and untouched._

## History navigation ticket 01 integration (2026-10-19)

`impl/history-navigation-01-next` ticket 01 (full-history navigation anchor contract) integrated into `integration/client-app` as
**`1f5f173`** by **fast-forward** — `68ce3ca` is an ancestor of the branch, so no merge commit was needed and the integration tip equals
the reviewed branch tip. Composition: implementation `d5f14d9`, worker-side merge onto the then-tip `68ce3ca` at `0051cb2`, contract and
evidence commit `1f5f173`. The integrated change is 16 files / +1,626 -8: one protocol contract (`packages/protocol/src/navigation.ts`,
re-exported and published as the `./navigation` subpath), a Backend adapter (`apps/server/src/conversation-navigation.ts`, `history-window.ts`,
wired in `server.ts`), three test files, and the owning guides (`docs/chat.md`, `docs/client-ingress.md`, `docs/migration-status.md`,
`GLOSSARY.md`). No client surface reads the outline yet — that is tickets 02-05.

**Reviewer finding recorded, not fixed.** Reviewer 57 reported no material finding; its one observation is real and is carried in
`.scratch/history-navigation-research/review-notes.md` as **N1** with trigger, impact and revisit condition:
`packages/protocol/src/navigation.ts:328-329` measures the page against a candidate that omits its own `bytes` field, then adds that number to
the object serialized on the wire, so a page admitted at exactly the ceiling ships 14 bytes larger than it states. The reviewer repro against the
public assembler (200 anchors, each at the full 240-byte preview cap, `hasMore: false`) logs
stated 65,536 against actual 65,550 for a max of 65,536 with `remaining: 0`
(`/tmp/history-navigation-ticket01-assembler-review.log`).
Judged non-blocking and deliberately **not changed by this merge**: the existing assertions
(`apps/server/test/conversation-navigation.test.ts:187,207,220`) check the self-stated number and stay true, no consumer enforces 64 KiB on
received bytes, `limit` caps at 200, and changing the measurement would alter a contract `0051cb2` was verified against. Ticket 02 owns it,
because 02 adds the second use of the same byte-count pattern; the pointer is written into ticket 02 status block and ticket 01 `## Answer` links the row.

**Verification — reused against unchanged source, per policy.** `verify:changed` ran in the worker worktree at `0051cb2` with `dirty: false` and
`verify.json` naming that SHA (`../history-navigation-01-next/.dev/verify/2026-10-19T06-23-15-391-verify-changed/`). The integrated tip changes no
tested source: `git rev-parse` shows `1f5f173:apps` and `1f5f173:packages` are **the same trees** as `0051cb2` ones (`3d9f1ef`, `6c2271a`),
and the only paths differing between them are planning `.scratch`, `docs/` and `GLOSSARY.md`. Those results are restated as inherited, not
re-run: changed-typecheck 0 (7 packages), changed-test 0 (1,385 pass / 0 fail — server 509, gateway 480, ui 264, protocol 63, session 57, app 12),
web-unit 52/52. The navigation suites were re-run once here as this merge boundary check, and `check:docs` on the merged tree:

| Check | Command | Revision | Exit | Result / log |
| --- | --- | --- | --- | --- |
| Navigation contract at the integrated tip (merge boundary check) | `node --test --test-reporter=tap packages/protocol/test/navigation.test.ts apps/server/test/conversation-navigation.test.ts packages/gateway/test/ingress-navigation.test.ts` | `1f5f173` (`dirty: true` — only the `.scratch/history-navigation-research` planning files being edited for this integration, which no test reads; apps/ and packages/ trees identical to `0051cb2`) | 0 | 22 pass / 0 fail (protocol 9, server 12, ingress 1) — `.dev/verify/hn01-integration/navigation-focused-at-integrated-tip.log` |
| Docs/link check over the merged tree | `pnpm check:docs` | `1f5f173` plus this integration planning edits | 1 — **the same 12 pre-existing broken links**, byte-identical set, 0 uncovered guides, 435 files | `.dev/verify/hn01-integration/check-docs.log` (`review-notes.md` adds no link) |
| Worker selector run (inherited, unchanged source) | `pnpm verify:changed --base=integration/client-app` | `0051cb2` (`dirty: false`) | 1 — every step 0 except `check-docs` at the same 12 | `../history-navigation-01-next/.dev/verify/2026-10-19T06-23-15-391-verify-changed/verify.json` |
| Worker focused contract runs (inherited) | per-file `node --test --test-reporter=tap` | `0051cb2` | 0 | protocol 9, server 12, ingress 1 — `../history-navigation-01-next/.dev/verify/hn01-focused/` |

**Not covered by these checks.** No browser or rail behaviour is claimed: the outline has no client consumer until tickets 03/04. The
worker focused logs state `dirty: true` for the protocol run and no dirty line for the server/ingress runs — the clean-tree evidence is the selector
run. No bypass or security-control probe was designed or run; no credential, deployment or `remote-host` path is touched. Ticket 01 is now
integrated, ticket 02 is `ready-for-agent`. `graphify-out/graph.json` is updated once for this integrated code batch per AGENTS.md.

## History navigation ticket 02 integration (2026-10-20)

Ticket 02 (bounded target window, `GET /api/conversations/:id/navigation/around`) was recorded as "delivered on
`impl/history-navigation-02-next`, not merged". The merge happened, just not under a commit of its own: `c070e7e`
("Merge integration/client-app (5e64cb9) into fix/mcp-grants-owner-next") carried `5e64cb9` — the branch's evidence tip —
onto the integration line, and `integration/client-app` at `701add2` is a descendant. `git merge-base --is-ancestor 5e64cb9
701add2` is true; nothing was cherry-picked, re-implemented or fixed by this integration.

**Recovered by inspection, not by trust.** The tip's `packages/protocol/src/navigation.ts`,
`apps/server/src/conversation-navigation.ts`, `apps/server/src/conversation-read.ts`, `apps/server/test/conversation-navigation.test.ts`,
`packages/protocol/test/navigation.test.ts` and `packages/gateway/test/ingress-navigation.test.ts` are byte-identical to
`5e64cb9` (`git diff --stat 5e64cb9 701add2` over those paths is empty). The only file the integration line moved is the
route host `apps/server/src/server.ts`, which gained the MCP grant work at `a40f251`; the `navigation/around` registration
and its `projectEntry` projection are unchanged, so the two efforts meet as adjacent route registrations.

**Re-run at the tip rather than inherited from the branch's own `e881f81` run**, because the surrounding line changed even
though the navigation source did not. Logs in `.dev/verify/hn02-integration/`:

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| Navigation suites at the integration tip | `node --test --test-reporter=tap` over the protocol, Backend and ingress navigation tests plus `conversation-read.test.ts` and `history-window.test.ts` | `701add2` (clean tree) | 0 | protocol 13, server navigation 23, ingress 2, conversation-read 12, history-window 17 — 67 pass / 0 fail |
| Whole server acceptance suite | `pnpm --filter @hepi/server test:acceptance` | `701add2` | 0 | 544 pass / 0 fail |
| Whole gateway acceptance suite | `pnpm --filter @hepi/gateway test:acceptance` | `701add2` | 0 | 491 pass / 0 fail |
| Selector run over the integration line | `pnpm verify:changed --base=00528fc` | `701add2` (`dirty: false`) | 1 | `changed-typecheck` 0 (7 packages), `changed-test` 0 (app 18, gateway 44, protocol 67, server 21, session 57, ui 275), `web-unit` 57/57, `check-docs` 1 — the same 12 pre-existing broken links |

`check-docs` remains at exit 1 for the twelve links ticket 01's integration recorded (nine
`.scratch/design-fixes/host/diagnosis.md` targets under `.dev/verify`, one `.scratch/architecture-unification` log, two
`.scratch/development-audit` skill paths); no navigation link is among them.

**Not claimed.** No client surface reads the window: the rail, the jump coordinator and the browser acceptance are
tickets 03–05. No push, deployment, restart or `remote-host` build; no bypass or security-control probe was designed or run.
The integration's own diff is documentation only — this section, ticket 02's integration record, the effort README and the
status lines of tickets 03–05.

## History navigation ticket 03 delivery (2026-10-20)

Ticket 03 (navigation state and jump coordinator) was delivered on `impl/history-navigation-03-tip`, **rebased onto
`integration/client-app`'s tip `4a54277`**, and is now **integrated into `integration/client-app`** (see
[the integration record](#how-ticket-03-arrived-on-the-integration-line-2026-10-20) below). The rebase was the whole
integration cost: the branch as
reviewed was cut from `c070e7e`, 600+ commits behind the integration line, and its only conflicts were additive — the
integration line added the read-recovery panels and the Web logout/capability work exactly where the ticket added the
navigation owner, so each hunk is a union of both rather than a choice. Nothing under `packages/protocol`,
`apps/server` or `packages/gateway` was touched by this ticket, so ticket 01/02's contract source is unchanged.

**Re-measured at the rebased tip, not inherited.** The branch's own evidence table named `c070e7e` and counts from
suites that have since been split into ordinary/acceptance profiles (`fb94b82`). Every row was re-taken on the rebased
branch; logs are in this worktree's `.dev/verify/` and the ticket's own table carries the commands, exit codes and counts.
The focused rows cite `3aa2fb9`, and the tree at the delivered tip is **byte-identical to it under `packages/` and
`apps/`** — every later commit on the branch is a record — so a source-level run against `3aa2fb9` is a statement about
the delivered code; the selector row below was run at the delivered tip.

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| Selector run on the delivered tip | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=4a54277` | `5b80d9c` (`dirty: false`) | 1 | `changed-typecheck` 0 (5 packages), `changed-test` 0 (ui 338, app 26, gateway 166, server 346 — 876 pass / 0 fail), `web-unit` 0 (14/14); `check-docs` 1 — the same 12 pre-existing broken links the base worktree at `4a54277` reports |
| Coordinator and outline reducer | `node --test packages/ui/src/lib/history-navigation.test.mjs` | `3aa2fb9` | 0 | 22 pass / 0 fail — one read per jump, none for a loaded target, a deep hit's exact block, no sequential request at any distance, seven named outcomes, switch → `cancelled`, superseded → dropped, busy deferral landing only on accept, the client-side fences costing zero reads, the prefix merge, page accumulation/ordering/refresh, the viewport hold's edges, and the four review corrections |
| Rendered outcome states | `node --test packages/ui/src/components/NavigationOutcomeBanner.test.mjs` | `3aa2fb9` | 0 | 3 pass / 0 fail — all seven names, distinct sentences, the three offers |
| Transcript owner | `node --test packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs` | `3aa2fb9` | 0 | 26 pass / 0 fail, including a landed window joining the paged prefix |
| Both reads over a real Backend + ingress | `node --test packages/ui/src/lib/conversation-api.http.test.mjs` | `3aa2fb9` | 0 | 6 pass / 0 fail, including a refusal's code crossing the connection |
| Browser: a failed hit's Retry lands and nothing pages during it | `node apps/web/e2e/ux-navigation-retry.mjs` | `3aa2fb9` | 0 | PASS, 8/8 — the production `ChatWindow` under `StrictMode` with only its network boundary replaced; one navigation read, 0 older-history reads during the settlement |
| The Web app's own build | `pnpm --filter @hepi/web build` | `3aa2fb9` | 0 | Vite build succeeds. The Next refusal the pre-rebase record cited no longer applies — the Next app is retired on the integration line |
| Reused seams, unchanged source | `pnpm --filter @hepi/protocol test` · `pnpm --filter @hepi/session test` | `3aa2fb9` | 0 · 0 | 67 pass / 0 fail · 57 pass / 0 fail |

The environment note ticket 03's own record carries still holds and is not a change in this ticket: `apps/app`'s two
`offline-install` dpkg cases need `/usr/sbin` and `/sbin` on `PATH`, which is how the selector run above was made.

**Not claimed.** No rail exists yet (ticket 04) and the full journeys are ticket 05's. No push, deployment, restart or
`remote-host` build; no bypass or security-control probe was designed or run. See
[Chat](chat.md#the-full-history-navigation-outline) for the delivered behaviour and
[migration status](migration-status.md) for the remaining capability limits.

### How ticket 03 arrived on the integration line (2026-10-20)

The ticket branch carried its source in three commits and its record in the rest. The branch's tip commit is a record
commit, so the integration cherry-picked the branch's commits onto this line's tip `1db108c` in branch order rather than
taking the tip: `46c0dfe` (the feat commit — the rules, the owner hook, the rendered outcomes, `landWindow` and the two
forwarded reads), `ddf362b` (the transcript-owner regression), `0af1884` (the four review corrections, the browser
fixture and driver, and the recorded evidence), then the record commits `7c74d43` … `02cca3e`. Everything the ticket
touched was additive against this line, so no pre-existing section was replaced: conflicts were limited to the ticket's
own record and `docs/verification.md`, and each was resolved in favour of the record the branch delivers. Ticket 21's
read-recovery record in [migration status](migration-status.md) is present on the integrated tree, as are the ticket
01/02 sections; the integration added no commit of its own to the source.

Verified over the tree this integration produces, not inherited from the branch's own `3aa2fb9` runs — the surrounding
line moved, so the code was re-run here. Rows cite `925af8e`, the last source-bearing pick; the only difference between
it and the tree measured is this integration's own record (`docs/verification.md` and the four status lines), which no
test reads:

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| Selector run over the integrated tree | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=4a54277` | `925af8e` plus this record's edits | 1 | `changed-typecheck` 0 (5 packages), `changed-test` 0 (app 26, server 346, gateway 166, ui 338 — 876 pass / 0 fail), `web-unit` 0 (14/14); `check-docs` 1 — the same 12 pre-existing broken links. Log: `.dev/verify/2026-10-20T02-16-16-433-verify-changed/` |
| Coordinator, reducer and the four review corrections | `node --test packages/ui/src/lib/history-navigation.test.mjs` | `925af8e` (clean tree) | 0 | 22 pass / 0 fail |
| Rendered outcome states | `node --test packages/ui/src/components/NavigationOutcomeBanner.test.mjs` | `925af8e` | 0 | 3 pass / 0 fail |
| Navigation hook under a `StrictMode` replay | `node --test packages/ui/src/hooks/useHistoryNavigation.lifecycle.test.mjs` | `925af8e` | 0 | 1 pass / 0 fail |
| Transcript owner | `node --test packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs` | `925af8e` | 0 | 26 pass / 0 fail |
| Both reads over a real Backend + ingress | `node --test packages/ui/src/lib/conversation-api.http.test.mjs` | `925af8e` | 0 | 6 pass / 0 fail |
| `packages/ui` whole suite | `pnpm --filter @hepi/ui test` | `925af8e` | 0 | 338 pass / 0 fail — the five files above included, so this is the integration line's count *with* ticket 03's cases |
| `packages/ui` typecheck | `pnpm --filter @hepi/ui typecheck` (`tsc --noEmit`) | `925af8e` | 0 | no diagnostics |
| Browser: a failed hit's Retry lands and nothing pages during it | `node apps/web/e2e/ux-navigation-retry.mjs` | `925af8e` | 0 | PASS, 8/8 — the production `ChatWindow` under `StrictMode` with only its network boundary replaced; one navigation read, 0 older-history reads during the settlement |
| The Web app's own build (the browser scene's host) | `pnpm --filter @hepi/web build` (Vite) | `925af8e` | 0 | `✓ built in 1.01s`, third-party notice emitted |
| Whitespace / conflict-marker check | `git diff --check` | `925af8e` | 0 | no output |

`check-docs` and the `apps/app` `offline-install` note are unchanged by this integration: nothing under `apps/app` was
touched (its 26 cases pass in the selector run above, which carries `/usr/sbin:/sbin` on `PATH`), and the twelve
pre-existing broken links are the same set the section above records. No push, deployment, restart or `remote-host`
build; no bypass or security-control probe was designed or run.

## History navigation ticket 04 delivery (2026-10-20)

Ticket 04 (the full-history rail) was delivered on `impl/history-navigation-04`, branched at the integration tip
`2c28d1c`; source commit **`7116eaf`**. The rail now reads ticket 03's paged outline as its index and the measured
transcript as its geometry, joined by one rule (`buildRailNodes` in `packages/ui/src/lib/history-rail.ts`), so a long
conversation's nodes beyond the loaded window are listed — and a click on one hands over exactly one coordinate and
issues no page request. Ticket 03's coordinator, `landWindow`, the read-recovery panels, the model catalog capability
gate and the Web logout work are consumed unchanged; no ticket 03 source line was rewritten to make room for the rail.
It is now **integrated into this line** — see
[the integration record](#how-ticket-04-arrived-on-this-line-2026-10-20) below.

Every row was taken in the ticket's worktree at source commit `7116eaf`; the focused runs were taken while the
ticket record was being written (no test reads it), and the selector row was re-run at the record commit `3e2ac68` with
`dirty: false` and identical step results. Nothing under `packages/` or `apps/` differs between the two SHAs, so both
describe the delivered source. Logs are in `.dev/verify/hn04/` and
`.dev/verify/2026-10-20T02-34-42-264-verify-changed/`. The integration re-measured the same rows on the integrated
tree; those runs are the ones in the subsection below.

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| Selector run over the delivered tree | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=2c28d1c` | `7116eaf` (`dirty: false`) | 1 | `changed-typecheck` 0 (5 packages); `changed-test` 0 (ui 344, app 26, gateway 166, server 346 — 882 pass / 0 fail); `web-unit` 0 (14/14); `check-docs` 1 — the same 12 pre-existing broken `.scratch/…` links, 0 guides missing from the index |
| The rail's join rule | `node --test packages/ui/src/lib/history-rail.test.mjs` | `7116eaf` | 0 | 6 pass / 0 fail — fallback to the measured transcript, unloaded nodes with no geometry, server-cursor order, the newer-than-the-last-page tail rule, one node per entry across an outline refresh, the preview bound |
| The rail in a browser, against the production component | `node apps/web/e2e/ux-history-rail.mjs` | `7116eaf` | 0 | 23 checks pass — 6 listed anchors + 3 measured tail nodes, unloaded dots never "visible", bounded preview (38 chars), one coordinate and zero page requests on an unloaded click, the landed node becoming loaded, the local measured jump unchanged and read-free, one read per "more", a named failed page that keeps the anchors it held and does not move the transcript |
| Coordinator and outline reducer, unchanged | `node --test packages/ui/src/lib/history-navigation.test.mjs` | `7116eaf` | 0 | 22 pass / 0 fail |
| Rendered outcome states, unchanged | `node --test packages/ui/src/components/NavigationOutcomeBanner.test.mjs` | `7116eaf` | 0 | 3 pass / 0 fail |
| Transcript owner, unchanged | `node --test packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs` | `7116eaf` | 0 | 26 pass / 0 fail |
| `packages/ui` whole suite | `pnpm --filter @hepi/ui test` | `7116eaf` | 0 | 344 pass / 0 fail |
| Typecheck, ui and web | `pnpm --filter @hepi/ui typecheck` · `pnpm --filter @hepi/web typecheck` | `7116eaf` | 0 · 0 | no diagnostics |
| The Web app's own build (the browser scene's host) | `pnpm --filter @hepi/web build` (Vite) | `7116eaf` | 0 | `✓ built in 1.03s`, third-party notice emitted |
| Ticket 03's failed-hit → Retry → landing scene, re-run on this tree | `node apps/web/e2e/ux-navigation-retry.mjs` | `7116eaf` | 0 | PASS, 8/8 — the production `ChatWindow` under `StrictMode`; one navigation read, 0 older-history reads during the settlement |
| The unchanged local navigation | `node apps/web/e2e/ux-visible-turns.mjs` | `7116eaf` | 0 | `UX-02 BROWSER CHECKS PASSED`, 29 checks — highlight, click, keyboard, streaming growth and resize all still hold with the rail reading a page |
| The windowed transcript journey | `node apps/web/e2e/window-experiment.mjs` | `7116eaf` | 0 | `WINDOW EXPERIMENT CHECKS PASSED` |
| Whitespace / conflict-marker check | `git diff --check` | `7116eaf` | 0 | no output |

The environment notes earlier sections carry still hold and are unchanged by this ticket: the selector run sets
`/usr/sbin:/sbin` on `PATH` for `apps/app`'s two `offline-install` dpkg cases, and the twelve `check-docs` links are
the same pre-existing set.

**Not claimed.** The system acceptance matrix — a real-Backend conversation longer than its window, a compacted anchor,
fork inheritance, an append during a navigation, stale coordinates, and the deep-search journeys observed together — is
[ticket 05](../.scratch/history-navigation-research/issues/05-system-acceptance.md)'s. The rail's own browser scene
mounts the production `ChatMinimap` against a fixture surface (because `ChatWindow` cannot be mounted without a
connection, a Backend and a conversation), so it proves the rail's boundary — what it lists, what a click hands over,
how many reads it issues — while the `ChatWindow` wiring is typechecked and ticket 03's scene drives the production
window. No push, deployment, restart or `remote-host` build; no bypass or security-control probe was designed or run.
See [Chat](chat.md#the-full-history-navigation-outline) for the delivered behaviour and
[migration status](migration-status.md#full-history-navigation-history-navigation-tickets-0105) for the remaining
capability limits.

### How ticket 04 arrived on this line (2026-10-20)

The branch carried its source in one commit and its record in two, cut at this line's tip `2c28d1c` — so the
integration **cherry-picked all three in branch order onto that tip** and resolved nothing: `7116eaf` (the feat
commit — `buildRailNodes`, the rail's outline/allocation/isolation rules, `ChatWindow`'s rail request and settlement,
the two i18n strings, the browser fixture and driver, and the guides), then the record commits `3e2ac68` and
`a641d66`. No conflict was produced, and each pick was verified byte-identical to its source commit (`git diff` between
each pick and its original: empty), so this is the reviewed source rather than a reconstruction of it.

That clean pick is a property of the branch point, not of luck: ticket 04 was cut from this line's tip, so it already
carries ticket 03's coordinator, the read-recovery panels, the model-catalog capability gate, the MCP work and the Web
logout work as the base it edited. What the integration had to preserve was therefore the surrounding tree rather than
any hunk in it, and the check for that is the diff below plus the re-run rows: nothing outside the 16 files the feat
commit names changed, and `ChatWindow`'s ticket-03 lines (`useHistoryNavigation`, `landWindow`, the recovery panels,
the search-settlement comment block) are extended — never replaced — by the rail's own request and settlement.

Manually inspected after the pick, at the three seams the ticket crosses:

- **`packages/ui/src/lib/history-rail.ts`** — the join rule states its two authorities and keeps them apart: the paged
  outline decides *which nodes exist and their order* (the server's `cursor`, never arrival order), the measured
  transcript decides *where one is*. An unloaded node carries `turn: null` and therefore no geometry, which is the
  spec's non-goal held structurally rather than by comment.
- **`packages/ui/src/components/ChatMinimap.tsx`** — the node list is derived per render (`buildRailNodes` over
  `measuredTurns` plus `outline`) and the focus is held by **entry id**, so a page arriving in front of the list cannot
  move the reader's focus to a different message. `owesOutlinePage` is one control whose activation is one read, never a
  read on visibility; `scrollToNode` splits loaded (measured scroll or reveal) from unloaded (one `onJumpAnchor`
  hand-off) and never pages.
- **`packages/ui/src/components/ChatWindow.tsx`** — the rail's request is `railLanding` beside the shell's
  `searchTarget`, both settling through the same `searchSettlementAction` and the same pending scroll; the viewport gate
  reads both, and the shell's retire seam is called only for a scroll that belongs to the shell's own target
  (`pendingSearchScroll === searchTarget`), so a rail landing never claims a search request this surface did not make.

Rows below were taken **on the integrated tree in this worktree**, at the last source-bearing pick `d3c0dff` with
`dirty: false` for the selector and a clean tree for the focused runs — not inherited from the branch. The commit that
adds this section changes only `docs/verification.md` and four ticket status lines, which no test reads, so it
describes the same source. Logs are in `.dev/verify/hn04-integration/` and
`.dev/verify/2026-10-20T02-39-43-369-verify-changed/`.

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| Selector run over the integrated tree | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=2c28d1c` | `d3c0dff` (`dirty: false`) | 1 | `changed-typecheck` 0 (5 packages); `changed-test` 0 (ui 344, app 26, gateway 166, server 346 — 882 pass / 0 fail); `web-unit` 0 (14/14); `check-docs` 1 — **12 broken relative links, all pre-existing**, 0 guides missing from the index |
| The rail's join rule | `node --test packages/ui/src/lib/history-rail.test.mjs` | `d3c0dff` | 0 | 6 pass / 0 fail — the six cases above |
| The rail in a browser, against the production `ChatMinimap` | `node apps/web/e2e/ux-history-rail.mjs` | `d3c0dff` | 0 | `HISTORY-RAIL BROWSER CHECKS PASSED`, 23 checks — the listed page plus the measured tail, unloaded dots never "visible", bounded preview, one coordinate and zero page requests on an unloaded click, the landed node becoming loaded, the local measured jump read-free, one read per "more", a named failed page that keeps its anchors |
| Ticket 03's coordinator and outline reducer, unchanged | `node --test packages/ui/src/lib/history-navigation.test.mjs` | `d3c0dff` | 0 | 22 pass / 0 fail |
| Rendered outcome states, unchanged | `node --test packages/ui/src/components/NavigationOutcomeBanner.test.mjs` | `d3c0dff` | 0 | 3 pass / 0 fail |
| The navigation hook under a `StrictMode` replay, unchanged | `node --test packages/ui/src/hooks/useHistoryNavigation.lifecycle.test.mjs` | `d3c0dff` | 0 | 1 pass / 0 fail |
| The transcript owner, unchanged | `node --test packages/ui/src/hooks/useAgentSession.lifecycle.test.mjs` | `d3c0dff` | 0 | 26 pass / 0 fail |
| `packages/ui` whole suite | `pnpm --filter @hepi/ui test` | `d3c0dff` | 0 | 344 pass / 0 fail |
| Typecheck, ui and web | `pnpm --filter @hepi/ui typecheck` · `pnpm --filter @hepi/web typecheck` | `d3c0dff` | 0 · 0 | no diagnostics |
| The Web app's own build (the browser scenes' host) | `pnpm --filter @hepi/web build` (Vite) | `d3c0dff` | 0 | `✓ built in 930ms`, third-party notice emitted (3,313 bytes) |
| Ticket 03's failed-hit → Retry → landing scene, on this tree | `node apps/web/e2e/ux-navigation-retry.mjs` | `d3c0dff` | 0 | PASS, 8/8 — the production `ChatWindow` under `StrictMode`; one navigation read, 0 older-history reads during the settlement |
| The unchanged local navigation | `node apps/web/e2e/ux-visible-turns.mjs` | `d3c0dff` | 0 | `UX-02 BROWSER CHECKS PASSED`, 29 checks |
| The windowed transcript journey | `node apps/web/e2e/window-experiment.mjs` | `d3c0dff` | 0 | `WINDOW EXPERIMENT CHECKS PASSED` |
| Whitespace / conflict-marker check | `git diff --check` | `d3c0dff` | 0 | no output |

**The one non-zero exit is `check-docs`, and it is not this ticket's.** It reports exactly twelve broken relative
links, unchanged in number, path and bytes from the count every section above records: ten under
`.scratch/design-fixes/host/diagnosis.md` and `.scratch/architecture-unification/issues/11-integrate-verify.md` pointing
at git-ignored `.dev/verify/…` logs, and two under `.scratch/development-audit/` pointing at the ignored
`.pi/skills/` tree. Those files are not touched by this integration and their targets are deliberately untracked, so the
count is the repository's, not the rail's: the integration adds no broken link (435 Markdown files checked, 0 guides
missing from the index). Nothing was "fixed" by deleting a link to make the step green.

Also unchanged by this integration: nothing under `apps/app` was touched (its 26 cases pass in the selector run, which
carries `/usr/sbin:/sbin` on `PATH` for the two `offline-install` dpkg cases). No push, deployment, restart or
`remote-host` build; no bypass or security-control probe was designed or run.

**Not claimed here either.** The system acceptance matrix remains
[ticket 05](../.scratch/history-navigation-research/issues/05-system-acceptance.md)'s, and the rail's browser scene still
mounts the production `ChatMinimap` against a fixture surface rather than the production `ChatWindow` — the same
boundary the delivery section above states. Integration is not acceptance.

## Full-history navigation system acceptance (ticket 05, 2026-10-20)

Ticket 05's acceptance journey is now driven end to end on the deployed shape: `apps/web/dist` served by the real
client ingress beside `/api` on one origin, the ingress's own HttpOnly session cookie, the real Backend over its own
SQLite store, and one controlled OpenAI-completions endpoint this run owns. Nothing is stubbed and no Next server is
started — `apps/web` builds with Vite.

**The fixture.** `apps/server/scripts/history-navigation-acceptance-fixture.ts` seeds the three facts the ticket names
through the runtime's own public seams, before the Backend opens the store: a conversation of 130 committed user
messages (two entries each, far past the 50-message active window), a `CompactionEntry` head marker over turn 20 so the
opening question is in the committed history and not in the active window, and a fork at turn 40 through the same
`ConversationOperations.spawn` seam a user's branch goes through. It states the identities it seeded on stdout for the
driver to read. The recovered draft of this fixture seeded 60 anchors, which fits inside the contract's default page
limit of 100, so the rail's continuation was never reached; `5eea65d` raises it to 130 and the second page is now in
the seed's own path (verified 100 + 30 anchors, `hasMore` false on the second, no repeated cursor).

**Two defects the journey found, both fixed at their owning seam.**

| defect | where it lived | what it was | fix |
| --- | --- | --- | --- |
| a rail click was a silent no-op | `packages/ui/src/components/ChatMinimap.tsx` (`scrollToNode`, and the reveal alignment in `measureNodes`) | a node marked **loaded** is one the transcript *measured*, and a windowed transcript keeps measuring turns it unmounts. The click read the `scrollTop` that measurement stored and scrolled there; that offset is a snapshot of a scroll coordinate, and the window rewrites its geometry afterwards (an estimated spacer for a far turn becomes a real measurement and everything below moves). The jump landed 500–3500 px from the turn, named no outcome and reported nothing — exactly the silently handled failure spec decision 9 forbids | the turn's anchor element is kept beside the measurement and the click path asks whether it is still connected; an unmounted turn is treated as an unmeasured one and the surface is asked to mount it. Both the click and the reveal alignment read the offset from the element in the DOM now, as the sibling assistant/heading jumps already did, and the reveal alignment stays pending across the measurements that replace the estimates (bounded to 12 re-aims) instead of stopping after one scroll |
| a page error on conversation switch | `packages/ui/src/hooks/useHistoryNavigation.ts` | the coordinator's host read its abort signal through `lifetime.current!.signal`, and the lifetime effect cleared that ref in its cleanup. A read issued in the gap between a cleanup and the next setup — the gap a `StrictMode` replay opens, and the state after any unmount — threw `Cannot read properties of null (reading 'signal')` | the aborted controller is left in the ref rather than cleared: it answers the same question with the same meaning, and the host never finds itself without a signal |

**What the driver asserts,** each read off the DOM or off counted requests rather than believed (`apps/web/e2e/ux-history-navigation-acceptance.mjs`, 82 checks):

| ticket requirement | how it is observed |
| --- | --- |
| long history displays nodes beyond the loaded window | the rail lists all 100 first-page anchors plus only the 30 measured turns newer than the page's newest anchor, while the transcript mounts 42 of 262 entries |
| nodes ordered by server cursor, previews bounded | ascending entry ids with no repeat; the compacted opening question previews its committed text at 78 chars |
| an unloaded anchor costs one bounded target read | one `/navigation/around` read addressed by `anchor=nav1.…`, **zero** outline-page reads, landing at `top: 52` |
| a loaded anchor's local jump is free | zero navigation reads, however the turn was reached |
| one outline page on open, one per activation | one read on open; the continuation is read once from the Backend's own `cursor=213`, adds the remaining 30 anchors, renumbers nothing, and disappears once the history is complete |
| an append extends the outline without moving an anchor | a submitted turn grows the rail 130 → 131 with every prior node's identity and position intact and no outcome named |
| a deep search hit outside the window uses the same coordinator | one `/around` read carrying `entry=93&block=0`, zero outline pages, the matched turn placed at `top: 52` |
| fork inheritance | the fork's rail is its own 40 anchors, inherited prefix included, read under `scope=277`; the inherited anchor lands |
| stale / missing / wrong-scope are refused by name | `409 stale-snapshot`, `404 missing` **with no window in the body**, `409 wrong-scope`, all over the ingress |
| deferred-busy | a turn admitted against a genuinely held model gate; the jump is named `deferred-busy`, reads nothing behind the run, mounts nothing, and its Retry lands once the gate opens |
| read error | an aborted `/around` names `error`, mounts no neighbour, and its Retry lands the entry |
| cancelled | proved at the coordinator seam it is decided in (ticket 03's `history-navigation.test.mjs`), plus the mounted consequence here: a real sidebar switch mid-read lands the abandoned target nowhere and leaves no stale banner |
| compaction keeps anchors navigable | the compacted opening question is listed and landed on through one bounded read of committed history |
| no silent handled path | every journey ends either on screen at the entry or on a named banner with its own sentence; the driver asserts no two outcome names share a sentence, and no page error occurred |

**The selector run on the delivered tip.** `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=a641d66` on
`96e7ae0` (`dirty: false`): `changed-typecheck` **0** (app, server, web, gateway), `changed-test` **0**, `web-unit`
**0** (14/14), `check-docs` **1** — the same **12 pre-existing broken links** in four `.scratch/` files this branch never
touches, and 0 guides missing from the index. Logs in
`.dev/verify/2026-10-20T06-04-38-240-verify-changed/` (`verify.json` sha `96e7ae0`).

The focused runs beside it, all on the same tree: `node apps/web/e2e/ux-history-navigation-acceptance.mjs` **0** (82
checks, clean tree); `ux-history-rail.mjs` **0**; `ux-navigation-retry.mjs` **0**; `node --test` over
`history-rail.test.mjs`, `history-navigation.test.mjs`, `useHistoryNavigation.lifecycle.test.mjs` and
`NavigationOutcomeBanner.test.mjs` **0** (32 pass); `apps/server/test/conversation-navigation.test.ts` **0** (23 pass);
`tsc --noEmit` in `apps/server`, `apps/web` and `packages/ui` **0**; `git diff --check` **0**.

**Not claimed.** `cancelled` is not provoked as a rendered banner in this driver: the mounted surface clears the
outcome in the same commit that retires it, so the name is the coordinator's and is asserted there. No push,
deployment, restart or `remote-host` build was performed; no build ran on `remote-host`. No bypass or security-control probe
was designed or run.

### How history-navigation ticket 05 arrived on this line (2026-10-20)

The ticket branch tip was `a8b1f8f`; this line's tip was `c1299df`, which already carries ticket 04 (picked as
`0d66ff1`, `82a4885`, `d3c0dff`, `3d15c86`) and ticket 03 before it. Ticket 04's commits were therefore **not**
re-picked: only the seven ticket-05 commits were cherry-picked, in branch order, onto `c1299df`:

| source | picked as | content |
| --- | --- | --- |
| `5eea65d` | `90214d2` | the fixture, raised from 60 to 130 anchors so the rail's continuation is on its path |
| `5b01ec6` | `117f1e4` | the browser driver's journeys |
| `33f8389` | `7643aa9` | **fix** — a rail click aims at the turn, not at a stored measurement of it |
| `a0958a2` | `42756f7` | every unresolved lookup named, and each Retry's landing |
| `ed0e4a1` | `d1e3be5` | **fix** — the navigation surface's abort signal stays readable when it has none to give |
| `96e7ae0` | `12998fb` | the record: the matrix, the two defects and what it does not claim |
| `a8b1f8f` | `fc15cc2` | the evidence bound to the selector run at the delivered tip |

**The two source fixes landed byte-identical.** For `33f8389` and `ed0e4a1` the picked
`ChatMinimap.tsx`, `useHistoryNavigation.ts` and driver file are `git show … | md5sum` equal to their source
commits, so this line runs the reviewed fix rather than a reconstruction. The same holds for the two test commits and
the fixture. Only the four documentation files differ from their source, and only by the conflicts below.

**Conflicts were documentation only, and resolved additively.** `docs/verification.md` and
`.scratch/history-navigation-research/issues/05-system-acceptance.md` conflicted at `96e7ae0`; both were unions. The
verification file takes this line's "How ticket 04 arrived" record **and** the ticket-05 acceptance section — neither
replaces the other, because they answer different questions about different tickets. The status line of ticket 05 states
both facts this line now holds: it was delivered on `impl/history-navigation-04`'s branch and it was cherry-picked onto
this line at `c1299df`. `docs/migration-status.md` and ticket 04's status line auto-merged; the first's heading and
the route it links to were repointed 01–04 → 01–05 by the pick's own hunks.

**What the tree kept.** No deletion entered this line: `git diff --diff-filter=D --name-only c1299df HEAD` is empty,
so no old-base removal the branch happened to carry came with the pick. Everything subtree-control 04 added on
`c1299df` — `subtree-control-acceptance.test.ts`, its stage child, the 78-check browser matrix, the
`apps/server/package.json` test manifest line and its own verification section — is present and unchanged. The commit
count is eleven files: two under `apps/` (the fixture, 148 lines; the driver, 615), two under `packages/ui/src`
(the two fixes), and seven documentation files.

**Measured on the integrated tree, not inherited.** Every row below was taken in this worktree at `42dcbc3` with a
clean tree for the selector and for the focused runs; logs are in `.dev/verify/hn05-integration/` and
`.dev/verify/2026-10-20T06-13-06-811-verify-changed/`.

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| The system acceptance journey | `node apps/web/e2e/ux-history-navigation-acceptance.mjs` | `42dcbc3` (clean) | 0 | `HISTORY-NAVIGATION ACCEPTANCE PASSED`, **82** checks — the same count the ticket records, on this line's tree |
| The rail's own browser scene | `node apps/web/e2e/ux-history-rail.mjs` | `42dcbc3` | 0 | `HISTORY-RAIL BROWSER CHECKS PASSED` |
| Ticket 03's failed-hit → Retry → landing | `node apps/web/e2e/ux-navigation-retry.mjs` | `42dcbc3` | 0 | `PASS`, 8/8 — the production `ChatWindow` under `StrictMode` |
| The rail's join rule | `node --test packages/ui/src/lib/history-rail.test.mjs` | `42dcbc3` | 0 | 6 pass / 0 fail |
| Coordinator, hook lifecycle and outcome banner | `node --test packages/ui/src/lib/history-navigation.test.mjs packages/ui/src/hooks/useHistoryNavigation.lifecycle.test.mjs packages/ui/src/components/NavigationOutcomeBanner.test.mjs` | `42dcbc3` | 0 | 26 pass / 0 fail |
| The Backend's navigation and read routes | `node --test apps/server/test/conversation-navigation.test.ts apps/server/test/conversation-read.test.ts apps/server/test/history-window.test.ts apps/server/test/history-text.test.ts` | `42dcbc3` | 0 | 56 pass / 0 fail |
| `packages/ui` whole suite | `pnpm --filter @hepi/ui test` | `42dcbc3` | 0 | 344 pass / 0 fail |
| Typecheck, ui / web / server | `pnpm --filter @hepi/ui typecheck` · `@hepi/web` · `@hepi/server` | `42dcbc3` | 0 · 0 · 0 | no diagnostics — the fixture is inside `apps/server`'s `scripts/**` include, so it is typechecked with the Backend |
| The Web app's own build | `pnpm --filter @hepi/web build` (Vite) | `42dcbc3` | 0 | `✓ built in 980ms`, third-party notice (3,313 bytes) |
| Gate selector over the integrated tree | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=c1299df` | `42dcbc3` (`dirty: false`) | 1 | `changed-typecheck` 0 (5 packages), `changed-test` 0 (server 352, ui 354, gateway 166, app 26 — 898 pass / 0 fail), `web-unit` 0 (14/14), `check-docs` 1 — the same **12 pre-existing broken links**, 0 guides missing from the 435 files checked |
| Whitespace / conflict-marker check | `git diff --check c1299df HEAD` | `42dcbc3` | 0 | no output |

The one non-zero exit is `check-docs`, and it is the repository's: the broken list is byte-identical to the set every
section above records (ten `.scratch` documents pointing at git-ignored `.dev/verify` logs, two at a `.pi/skills`
path absent from this checkout). This integration adds no link to it — the three cross-references the pick repointed
(ticket 04's status, the migration-status heading and the verification section) all resolve.

**Not claimed by this integration.** Integration is not a new acceptance: the matrix's own limits stand exactly as the
ticket states them, including that `cancelled` is asserted at the coordinator seam rather than as a rendered banner, and
that the landing is a computed scroll against live geometry rather than a persisted pixel position. The ticket's
selector row still cites `96e7ae0`; the row above is this line's re-run. No push, deployment, restart or `remote-host`
build; no build ran on `remote-host`. No bypass or security-control probe was designed or run.

## MCP conversation tool states (ticket 03c, 2026-10-19)

`impl/mcp-conversation-03c` (base `c070e7e`, the integration tip carrying 03b) delivers the browser surface for one
conversation's MCP tools: the four states, explicit per-server discovery and revocation on 03b's existing extension seam.
See [MCP on the Web host](mcp-on-the-web-host.md#a-conversations-tool-states-in-the-browser-ticket-03c).

**Worker selector run — clean tree.** `pnpm verify:changed --base=integration/client-app` at `a40f251` with
`dirty: false` (report `.dev/verify/2026-10-19T11-10-36-687-verify-changed/verify.json`):

| Step | Exit | Result |
| --- | --- | --- |
| `changed-typecheck` (5 packages) | 0 | `@hepi/app`, `@hepi/server`, `@hepi/web`, `@hepi/gateway`, `@hepi/ui` |
| `changed-test` | 0 | 1,309 pass / 0 fail — server 537, gateway 481, ui 273, app 18 |
| `web-unit` | 0 | 57/57 |
| `check-docs` | 1 | the **same 12 pre-existing** broken links, byte-identical set, 0 uncovered guides, 432 files |

The 12 docs failures are the lane's retained baseline (`.scratch/architecture-unification/issues/11`, nine
`.scratch/design-fixes/host/diagnosis.md` targets under `.dev/verify`, two `.scratch/development-audit` skill paths) and
none names a file this ticket touched: the new heading link from `docs/migration-status.md` into
`docs/mcp-on-the-web-host.md` resolves, which an earlier run proved by failing on it before the path was made relative.

**Focused runs.** `node apps/web/e2e/ux-mcp-tool-states.mjs` — PASS (32 checks; real Chromium against the production
`ExtensionsConfig`, esbuild bundle in a temp dir, 127.0.0.1:43135): no listing on mount, one `?mcp=` request per press,
the four states read per tool, a hidden tool named as hidden, a `needs-auth` refusal shown as that server's own limit and
not as an empty list, one grant and one revocation each as exactly one write of that server's whole set, and the
panel's machine-readable state carrying no `sourcePath`/`command`/`env`/token/`inputSchema`/`cwd`. Re-run of
`node apps/web/e2e/ux-extensions-panel.mjs` and `node apps/web/e2e/ux-panel-ingress.mjs` — both PASS, so the mount inside
`ExtensionsConfig` did not disturb the extension panel's own journey or its ingress routing.

**Environment note, not a change in this ticket.** `apps/app`'s two `offline-install` dpkg cases fail when the shell's
`PATH` omits `/usr/sbin` and `/sbin` (`dpkg: error: 2 expected programs not found in PATH`); they pass with
`PATH=$PATH:/usr/sbin:/sbin`, which is how the selector run above was made. That is a property of this workstation's
`PATH`, not of the ticket, and the earlier run on the same tree with the shorter `PATH` is retained as the counter-example.

**Not covered.** No live host was asked to list a real server: the browser journey replaces its network boundary with a
fixture that answers as the seam does, so 03a's own stdio listing behaviour is covered by its gateway tests rather than
here. No deployment, no `remote-host` build and no push. `graphify-out/graph.json` is parent-owned and untouched.

### Review follow-up: a switch while an answer is in flight (2026-10-19)

Parent review found the block's request identity narrower than the document it reads: the seam answers a whole
conversation per request, so an ordinary switch could paint one conversation's listing, refusal or grant over another's,
and the extension switch above the block left it holding a stale selection snapshot. Fixed on the same branch at
`424b5f8`:

- `ExtensionsConfig` mounts the block with `key={sessionId}`, so a switch is a new block rather than one panel
  re-deciding what it holds.
- The block fences a read, a listing and a write by the conversation epoch they were made under, clears view, listings,
  refusals and the busy control on a change, and drops an answer that lands afterwards. A write that lands while its own
  conversation is shown again re-reads it, because the view that answered before that write may be older than the
  document; the next checkbox then derives that conversation's real set.
- `extensionSelected` is a prop from the panel that writes it: a flip takes availability away immediately while keeping
  the grants, and triggers one re-read of the conversation, which asks no host to connect anything.

**Worker selector run — clean tree.** `pnpm verify:changed --base=integration/client-app` at `424b5f8` with
`dirty: false` (report `.dev/verify/2026-10-19T11-32-16-805-verify-changed/verify.json`): `changed-typecheck` 0,
`changed-test` 0 (1,310 pass / 0 fail — server 537, gateway 481, ui 274, app 18), `web-unit` 57/57, and `check-docs`
the same 12 retained pre-existing broken links (432 files, 0 uncovered guides, none naming a file this ticket touches).
The `PATH` note above still applies to `apps/app`'s two dpkg cases.

**Focused browser run.** `node apps/web/e2e/ux-mcp-tool-states.mjs` — PASS, 52 checks. New in this run: a listing held
open across a switch lands as nothing on the new conversation (no listing, no `search` row); a write held open across a
switch does not restripe the conversation it was not made for, the panel re-reads the conversation it shows once that
write lands, and the next checkbox writes `{docs: [fetch]}` — this conversation's own set — rather than a set the late
answer carried; an extension flip removes availability from every granted row while keeping both grants, names
`extension-not-selected`, re-reads the conversation, and restores availability when switched back.
`ux-extensions-panel.mjs` and `ux-panel-ingress.mjs` both PASS, and `packages/ui/src/lib/conversation-mcp.test.mjs`
is 10/10 with the selection-override projection case.

**Not covered.** The fixture drives the switch by re-rendering the panel with another conversation id, which is what an
ordinary sidebar switch does, rather than through the app shell's own click; no live host, no deployment and no
`remote-host` build was involved.

### Review follow-up 2: an unread host configuration is unknown, not absent (2026-10-19)

Reviewer67 found a P2: 03b keeps a conversation's grants when the host's configuration read answers nothing, while the
panel iterated `mcp.servers` alone — so an offline host read as "this host configures no server" and hid the very grants
that were still selected and revocable. Fixed on the same branch:

- **Seam.** `apps/server/src/server.ts` — `mcpHostServers` now answers `{ servers, known, refusal }` instead of a bare
  list: `known: false` with the host's own code (`gateway_offline`, `mcp_unavailable`, `host_unavailable`,
  `protocol_error`) when the read did not answer. `mcpGrantAnswer` publishes it as `serversKnown` + `serversRefusal`
  beside the unchanged `servers` and `grants`. No new route, no new vocabulary.
- **Panel.** `packages/ui/src/lib/conversation-mcp.ts` — `serversKnown`/`serversRefusal` on the view; a new
  `mcpServerBlocks` is the **union** of the host's servers and the servers this conversation holds grants of, in the
  host's own order then name order; `configUnknown`/`availableUnknown` on rows and counts. A host that answered still
  says an absence as an absence.
- **Component.** `McpConversationTools.tsx` renders that union: a granted server the host does not name keeps its
  checkbox and its `Revoke every grant of this server` control, states `host configuration not read` and
  `availability unknown`, and the panel says the configuration could not be read instead of `noServers`.
- **Docs/ticket.** The "unread configuration" rule in [MCP on the Web host](mcp-on-the-web-host.md#a-conversations-tool-states-in-the-browser-ticket-03c) and ticket 03c.

**Worker selector run — clean tree.** `pnpm verify:changed --base=integration/client-app` at `373fe75` with
`dirty: false` (report `.dev/verify/2026-10-19T12-01-47-579-verify-changed/verify.json`): typecheck 0, changed-test 0
(1,311 pass / 0 fail — server 537, gateway 481, ui 275, app 18), web-unit 57/57, check-docs the same 12 retained
pre-existing broken links (432 files, none of mine).

**Focused runs.** `node apps/web/e2e/ux-mcp-tool-states.mjs` — PASS, 62 checks, including the new offline case
(`?host=offline`, host keeps a grant): `serversKnown: false` with `gateway_offline` stated, the granted `docs` server
still listed with `configured not asked` / `availability unknown`, no `configures no MCP server` sentence, the granted
row `selected: true` with `configUnknown`/`availableUnknown`, a listing refused with the host's own code that leaves the
grant intact, and one `PATCH {mcp:{server:"docs",tools:[]}}` revocation that succeeds with no listing asked.
`packages/ui/src/lib/conversation-mcp.test.mjs` 11/11; `apps/server/test/mcp-conversation-tools.test.ts` 23/23 (the
SSH-host rig now also asserts `serversKnown: false` + `serversRefusal.code` and an offline revocation answered 200).
`ux-extensions-panel.mjs` and `ux-panel-ingress.mjs` PASS.

**Not covered.** No live offline host was driven: the browser case replaces the network boundary with the fixture's own
`gateway_offline` answer, and the backend case uses the SSH-host rig that answers `mcp_unavailable`.

## SSH workbench tickets 06 and 08: terminal parity and failure boundaries (2026-10-19)

_Tested source: `impl/ssh-workbench-acceptance-next`. Cut from `integration/client-app` `3e69c62`; the code commits are
`7238258` (the terminal launcher's failure classification plus its tests) and `5527f68` (three browser drivers moved onto
the client ingress), with `integration/client-app` `68ce3ca` merged at `12d4ed9`. Every row below ran at the merged tip
`5527f68` unless the row says otherwise. Raw logs: `.dev/verify/ssh-workbench-06-08/` and, for the gate,
`.dev/verify/2026-10-19T06-26-39-317-verify-changed/`. No deployment, no push, no build on `remote-host`, and no bypass,
security-control, auth or path-escape probe was designed or run: the boundary rows below consume existing evidence, they
do not re-derive it._

### Ticket 06 — every named failure has an owner, and two of them did not

The ticket's table lists failures with owners. Measured at the base `3e69c62`, most had owners and two rows were claimed
by files that never asserted them: `terminal.test.ts` names "a host with no `python3`" and "an SSH transport that cannot
hold a session open" in comments as cases it dropped because they belong to the launcher, and no launcher test existed.
Both rows now have a seam of their own.

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `node --test packages/gateway/test/{terminal-launcher,terminal,terminal-heartbeat,terminal-stream-budget,host-terminal,ingress-terminal}.test.ts` | 0 | 55 tests, 55 pass, 0 fail — of which **10** are the new `terminal-launcher.test.ts` | `.dev/verify/ssh-workbench-06-08/ticket06-gateway.log` |
| `node --test apps/server/test/{terminal-relay,terminal-transcript,terminal-browser,file-relay}.test.ts` | 0 | 17 tests, 17 pass, 0 fail | `.dev/verify/ssh-workbench-06-08/ticket06-server.log` |
| `node --test apps/web/adapters/terminal.test.mjs packages/ui/src/components/{TerminalPanel,AppShell.terminal}.test.mjs packages/ui/src/hooks/useTerminalFanIn.test.mjs packages/ui/src/lib/{terminal-fan-in,terminal-input}.test.mjs` | 0 | 13 tests, 13 pass, 0 fail | `.dev/verify/ssh-workbench-06-08/ticket06-ui.log` |
| `pnpm --filter @hepi/web test:terminal-session` | 0 | 38 checks, 7 scenarios, a real gateway host and a real shell | `.dev/verify/ssh-workbench-06-08/browser/merged-ux-terminal-session.log` |
| `pnpm --filter @hepi/web test:terminal-close` | 0 | 9 scenarios | `.dev/verify/ssh-workbench-06-08/browser/merged-ux-terminal-close.log` |
| `pnpm --filter @hepi/web test:terminal-fan-in` | 0 | 26 checks | `.dev/verify/ssh-workbench-06-08/browser/tip-ux-terminal-fan-in.log` |

**The parity defect the run found.** Over SSH a host with no `python3` answers exit 127 with the host's own stderr; over
a local spawn the same absence arrives as `ENOENT`. `missingHelper` (`packages/gateway/src/terminal.ts`) read only the
spawn error, so the local host answered `not_supported` naming python3 and the SSH host answered `operation_failed` with
the host's last stderr line — two hosts, one host fact, different words. `SshFilesystem` already called that host fact
`not_supported`. Fixed by matching the host's own message inside the one shared classification, so the SSH launcher now
answers what the local launcher and the SSH filesystem answer, and the reason still names python3. The SSH host's own
`unreachable` classification (`code 255`) is untouched.

`terminal-launcher.test.ts` covers, at the launcher's seam and again on the gateway's own route: SSH unreachable (`255`),
SSH without `python3` (`127`), SSH without the pty module, an SSH host that ends for a reason with no name (it gives its
own last line, never an empty session), a transport with no session path, a workspace no profile owns (the transport is
never asked), and a machine with no `python3` on PATH through a real `spawn`. Every refused open also asserts the store
holds nothing behind it — `describe` answers `unknown_terminal` — which is the "never an empty success" half of the row.

**What the route answers, and what the record said.** The three route cases assert `409` with the reason in the body,
because a refused open keeps one refusal status whatever the named reason, and `501` is the answer of a gateway composed
_without_ the terminal capability (`terminal.test.ts`, `host-terminal.test.ts`). Two guides claimed a missing python3
itself answers `501`, which is the reading that would have made this fix a status change; it is not one. Corrected in
[workbench.md](workbench.md) and [local-integration.md](local-integration.md) in this change. The relay is where the
`501` legitimately reappears: `lifecycleStatus` (`apps/server/src/terminal-relay.ts`) maps a `not_supported` answer to
`501` and keeps the host's refusal status for everything else, asserted from opposite ends by `terminal-browser.test.ts`
and `host-terminal.test.ts`.

### Ticket 08 — the ordinary failures on both hosts, and the driver that asserted a build nothing produces

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `node --test packages/gateway/test/{workbench,ssh-workbench,ingress-ssh-workbench,file-transfer,host-files,files-surface,ssh-filesystem,filesystem,ingress-files,sshd-fixture,control,file-transfer-sshd,ssh,ssh-workspaces,host-client}.test.ts` | 0 | 149 tests, 149 pass, 0 fail across the 15 files the ticket's table names | `.dev/verify/ssh-workbench-06-08/ticket08-gateway.log` |
| `node --test apps/server/test/ssh-project.test.ts` | 0 | 6 tests, 6 pass, 0 fail | `.dev/verify/ssh-workbench-06-08/tip-ssh-project.log` |
| `pnpm --filter @hepi/web test:ssh-project` | 0 | **31 checks**, real `sshd`, two profiles, driven over the client ingress | `.dev/verify/ssh-workbench-06-08/browser/merged-ux-ssh-project.log` |
| `pnpm --filter @hepi/web test:file-failures` | 0 | 15 checks | `.dev/verify/ssh-workbench-06-08/browser/tip-ux-file-failures.log` |
| `pnpm --filter @hepi/web test:file-surfaces` | 0 | 10 checks | `.dev/verify/ssh-workbench-06-08/browser/tip-ux-file-surfaces.log` |
| `pnpm --filter @hepi/web test:docx-preview` | 0 | 15 checks | `.dev/verify/ssh-workbench-06-08/browser/tip-ux-docx-preview.log` |

**The stale precondition, repaired rather than retired.** `apps/web/e2e/ux-ssh-project.mjs` asserted
`apps/web/.next/BUILD_ID` and started `next start`, while `@hepi/web`'s `build` is `vite build` into `dist/`: no command
could produce what the driver demanded. The remote-project journey is a failure-boundary claim this ticket owns, so it
now runs the deployed shape instead. The **client ingress** (`packages/gateway/src/ingress/main.ts`) serves
`apps/web/dist` through `HEPI_INGRESS_STATIC_DIR` and forwards `/api` to the real backend under its service credential;
`HEPI_WEB_LOGIN_TOKEN` is the page's own session and stays distinct from that credential, and
`HEPI_INGRESS_DEFAULT_HOST` is left unset, which is what makes the two remote profiles the only targets the dialog can
offer. The browser signs in through the rendered login form rather than being handed a cookie, and the turn reader
accumulates both whole-`entries` frames and `appended` deltas, because an event stream sends only the delta once it holds
the baseline window. Nothing was deleted and no assertion was weakened: the same 31 checks, on a stack the tree can build.

Two terminal drivers failed on the same precondition and were repaired the same way (`5527f68`):
`ux-terminal-close.mjs` and `ux-terminal-session.mjs`. 33 of the 57 files under `apps/web/e2e/` still assert `BUILD_ID`
(`git grep -l BUILD_ID 3e69c62 -- apps/web/e2e` gave 36, the tip gives 33). That remainder is **client-app 17's** to
close — it owns retiring the Next entry files and their harnesses — and is not re-implemented here.
`ux-terminal-budget.mjs` additionally reaches `/api/durable-login` and `/api/agent`, routes the ingress does not serve:
recorded, not repaired, since that driver's own ticket already carries it.

### The two limits this ticket re-checks rather than re-litigates

Both still read as documented, and both are asserted rather than merely believed.
`ssh-workbench.test.ts` ("a file past the gateway read bound is previewed locally and refused on the remote host") passes
a 16 MiB + 1 sparse file through each host and asserts `ok: true` locally against `{ok: false, code: "operation_failed"}`
remotely. The same file and `workbench.test.ts` assert a path the tree no longer has as `operation_failed` on **both**
hosts, because the workbench has no `not_found` code. Naming a missing file means adding one to the public refusal
vocabulary, which is ticket [09](../.scratch/ssh-remote-workbench/issues/09-file-failure-and-preview-feedback.md)'s
decision — blocked behind this ticket and client-app 17, and not taken early here.

### Composition, and what did not run

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `pnpm --filter @hepi/gateway test` | 0 | 489 tests, 489 pass, 0 fail | `.dev/verify/ssh-workbench-06-08/gw-test-merged.log` |
| `pnpm --filter @hepi/server test` | 0 | 497 tests, 497 pass, 0 fail | `.dev/verify/ssh-workbench-06-08/srv-test-merged.log` |
| `pnpm --filter @hepi/gateway typecheck` | 0 | `tsc --noEmit` clean | within the gate log below |
| `pnpm verify:changed --base=3e69c62` | 1 | `changed-typecheck` 0, `changed-test` 0, `web-unit` 0 (52/52), **`check-docs` 1**; `verify.json`: sha `5527f68b…`, `dirty: false`, `dirtyFiles: []` | `.dev/verify/2026-10-19T06-26-39-317-verify-changed/` |
| `pnpm check:entrypoints` | 0 | 81 entry files present, 2 known-missing (pre-existing), 0 newly missing | run at the tip plus this docs edit |
| `pnpm check:docs` | 1 | 433 Markdown files, **12** broken relative links, 0 guides uncovered | run at the tip plus this docs edit |

The changed gate fell back to **full** tests because the merge touched `pnpm-lock.yaml`; the selector refuses to narrow a
lockfile change, which is the gate's rule and not this branch's convenience. Per-package counts read out of that single
log, each predicted before the run: protocol 54, session 57, ui 264, app 12, gateway 489, server 497 — **0 failures
anywhere**, matching the two per-package runs above, so no suite silently dropped. `check:docs` exit 1 is the retained
baseline the branch records at the same count: 12 links inside `.scratch/` planning files pointing at git-ignored
`.dev/verify` artefacts and two `.pi/skills` paths.

**Not run, and why.** No live remote host was contacted. The SSH half is the repository's own fakes
(`packages/gateway/test/ssh-transport.ts`, `test/ssh-fake.ts`) and, where the claim is about a real host, a real
**localhost `sshd`** under `bwrap` (`sshd-fixture`, `ssh-workspaces`, `apps/server/test/ssh-project.test.ts`,
`ux-ssh-project.mjs`). No paid model, no credential mutation, no deployment, no service restart. The 33 still-`BUILD_ID`
drivers and `pnpm --filter @hepi/web test:terminal` were not attempted: they assert a build this tree does not produce,
which is the recorded client-app 17 limit above rather than a result withheld.

### Ticket 04 — the capability's final closeout, read off the rows above

06 and 08 are the two blockers the closeout named, and both are delivered on this branch, so the scope closes here as a
**consumption**, not a repetition. The rows this capability claimed, and where each is answered now:

| Proposal row | Answered by | At this revision |
| --- | --- | --- |
| P01 remote workbench read / Git seam | ticket 01, integrated | gateway 489 / server 497 green at `5527f68` |
| P02 remote writes, transfer and error/abort/deadline parity | ticket 02, integrated | 149 tests / 0 fail in the ticket-08 run above |
| P03 DOCX byte preview on both hosts | ticket 05, integrated `871ae72` | `ux-docx-preview` 15 checks, `files-transfer` 17, App bundle test in the 12 |
| P04 terminal parity and abort | **ticket 06, this branch** | 55 + 17 + 13 unit tests, 38 / 9 / 26 browser checks |
| P05 live watch protocol | ticket 07 — resolved **deferred**, no event implementation selected, no polling substitute introduced | nothing in this branch adds a watcher |
| P06 failure and security acceptance (ordinary states) | **ticket 08, this branch**, plus 02/03 evidence | every table row green, the stale driver repaired |
| P07 system acceptance | this section | 31 remote-journey checks over a real `sshd`, 52 client-acceptance checks |

**Browser acceptance at the tip** (each exit 0; raw logs kept in the git-ignored
`.dev/verify/ssh-workbench-06-08/`, which is where every count above was read from):
`ux-ssh-project` 31, `ux-terminal-session` 38, `ux-terminal-close` 9 scenarios, `ux-terminal-fan-in` 26,
`ux-file-failures` 15, `ux-file-surfaces` 10, `ux-docx-preview` 15, `files-transfer` 17, `ux-workbench-scope` 16,
`ux-client-acceptance` 52 — the last two needing `pnpm --filter @hepi/app build` and `@hepi/web build` first.
`ux-client-acceptance` failed once at its own precondition (no App dist) and passed after the two builds; that is its
documented requirement, not a defect.

**The scope check the closeout asks for.** `git diff --name-only 68ce3ca HEAD` is 11 files: two ticket records, four docs,
three browser drivers, `packages/gateway/src/terminal.ts` and its new test. The source change is a **classification**
inside the terminal launcher — the SSH host now names the same `not_supported` reason the local host and
`SshFilesystem` already named. No watch operation, no write operation, no new route, no new protocol field, no polling
path was added, and `docs/workbench.md`'s "live file watch and linked-directory approval stay `501`" still describes the
tree.

**Limits that survive this closeout, stated rather than closed.** (1) No live remote host was interrupted or contacted:
the SSH half is the fakes plus a real localhost `sshd`, so the remote reaction to a *stopped* remote process remains the
reasoning ticket 05 recorded, not a measurement. (2) The `not_found` refusal code and the misleading truncated-preview
progress are ticket 09's, blocked behind this closeout **and** client-app 17 — deliberately not taken early. (3) 33 of 57
`apps/web/e2e` drivers still assert `.next/BUILD_ID`, which is client-app 17's harness retirement, so "browser
acceptance" above means the ten drivers that run on this tree, not the whole directory. (4) This is a verification
closeout on a branch: no merge, push, deployment or restart, and the running release is untouched.

## Native file save (client-app ticket 20)

The App's save control writes a file the connection read, in slices bounded at the IPC boundary. Measured on `workstation`,
Linux 6.17 x86_64, WebKitGTK 2.52.3, Rust 1.96.0, Tauri crate 2.12.4 / plugin-dialog 2.8.3, from branch
`impl/client-app-20-native-save` off `d356152`. The debug shell was built into the shared cache
(`<git-common-dir>/.dev/cargo-target`, 6 jobs, incremental); nothing was compiled on `remote-host`.

| Check | Command | Exit | Result | Log |
| --- | --- | --- | --- | --- |
| save seam, 10 tests | `node --test packages/ui/src/lib/file-save.test.mjs` | 0 | picker-first, 1 MiB slices, cancel and failure cleanup, a destination fixed at the start, the one path decision | `.dev/verify/t20-native-save/file-save.log` |
| save seam against a real server and a real file, 2 tests | `node --test packages/ui/src/lib/file-save.io.test.mjs` | 0 | 8 MiB and 128 MiB bodies saved with matching SHA-256 in 64 KiB slices; resident memory **+29.1 MiB** and **+24.5 MiB** — a sixteen-times-larger file cost less, which is the bound stated as a measurement | `.dev/verify/t20-native-save/file-save-io.log` |
| shell save commands, 9 Rust tests | `cd apps/app/src-tauri && CARGO_TARGET_DIR=<shared> CARGO_BUILD_JOBS=6 cargo test` | 0 | 9 tests, 9 pass: a slice past the bound refused before it is written, an abort removes only the file it opened, an unconfirmed existing file is not truncated, a directory destination refused | `.dev/verify/t20-native-save/cargo-test.log` |
| App page half of the IPC contract, 5 tests | `node --test apps/app/test/save-host.test.mjs` | 0 | the five command names, their exact arguments, a cancelled dialog, no credential or origin in the host | `.dev/verify/t20-native-save/save-host.log` |
| mounted save control under a device bearer, 17 checks | `node apps/web/e2e/ux-file-surfaces.mjs` | 0 | the control is a button, the save finishes, the shell is handed the whole 77-byte file in one bounded slice, the read presented the bearer and happened once | `.dev/verify/t20-native-save/ux-file-surfaces.log` |
| packaged shell, native acceptance, 27 checks | `node apps/web/e2e/ux-native-acceptance.mjs --binary=<shared>/debug/hepi-app` | 0 | the unchanged journey on the shell that now carries the dialog plugin and five save commands: cold start, stored credential admitted, real window, revocation refused | `.dev/verify/t20-native-save/ux-native-acceptance.log` |
| App package, provenance and reproducibility | `node apps/app/scripts/build-artifacts.mjs --label=t20-native-save` | 0 | `.deb` 62.6 MB, binary 233.2 MB, debug profile, `failedSteps: []` | `.dev/artifacts/t20-native-save/provenance.json` |
| selected checks for the change | `pnpm verify:changed --base=d356152` | 1 | typecheck, workspace tests and Web unit 0; `check-docs` 1 for the same 12 pre-existing `.dev`/`.pi` links, none of them this change's | `.dev/verify/2026-10-19T17-48-49-186-verify-changed/verify.json` |

**What the memory row means, and what it does not.** The figure is a sample taken from `saveFile`'s own progress
callback, not `maxRSS` (which never falls, so comparing two saves by it would measure the first one twice). It states
that the path's resident memory does not scale with the file: sixteen times the bytes cost 2 MiB more. It is **not** a
re-measurement of ticket 04's WebView peak — that one crossed the real WebKitGTK IPC boundary with real slices, and the
1 MiB bound this ticket enforces is the number that measurement produced (~225 MB against ~3.02 GB for whole-chunk IPC).

**The packaged native save journey (2026-10-20).** The paragraph this record used to carry here said the journey was not
driven, because a GTK file chooser needs keyboard choreography against a dialog whose widget order is the platform's and a
wrong keystroke would write into a directory the run does not own. It is now driven, inside the driver that already owns
the credential store: `apps/web/e2e/ux-native-acceptance.mjs` takes the workbench in the shell's own document through the
debug build's inspector, clicks the viewer's own Download file control, and answers the GTK Save file dialog with an
absolute path typed into its location bar. The destination is inside the run's own artifacts directory, so no keystroke
can reach a directory the run does not own.

| Check | Command | Exit | Result | Log |
| --- | --- | --- | --- | --- |
| packaged save journey inside the native acceptance | `node apps/web/e2e/ux-native-acceptance.mjs` | 0 | 37 checks: the real GTK Save file dialog opened, the destination the dialog was answered with holds the workspace file's own 1048 bytes (sha256 `fc4525e8ddcb3af4…`), the control returned to idle, a cancelled choice left no second file and no partial one | `.dev/verify/c17-c20-native/native-save-acceptance.log` |
| the same run, repeated | `node apps/web/e2e/ux-native-acceptance.mjs` | 0 | 37 checks; the isolated credential store left nothing behind and the developer's login keyring is byte-for-byte what it was | `.dev/verify/c17-c20-native/native-save-acceptance-rerun.log` |

What that journey still does not state: the payload is 1 KiB, so it is a byte-identity and cancellation measurement, not a
re-measurement of ticket 04's WebView peak; and it is a debug profile, so nothing in it is a release-performance claim.

## Client app integration: provider connection ticket 05, system acceptance (2026-10-20)

The gap this ticket closed was stated as a sentence no other suite held: *a credential stored in Settings through a real
browser becomes usable in a real conversation's model list, on a deployment whose Backend reads the same account its
Gateway writes*. One driver now drives that end to end — `apps/web/e2e/ux-provider-connection-acceptance.mjs` — against
the production Web build, the real client ingress, a real Gateway and a real Backend over its own SQLite files, in **Pi
file-backed mode** (`HEPI_CONFIG_SOURCE=pi`, the run's own agent directory shared by Gateway and Backend). Nothing is
stubbed: the one stand-in is the provider's own authorization server, an RFC 8628 device-authorization endpoint this run
starts and points upstream's Kimi flow at through `KIMI_CODE_OAUTH_HOST`, so a real sign-in completes without a paid
provider, a real account or a network token exchange.

**Mode and topology, stated because they decide the claim.** Pi mode is the one mode in which the Gateway's `auth.json`
*is* the Backend's account (docs/providers.md); environment mode was exercised separately and reports the same pair as a
documented limit rather than as a defect — a credential stored on the Web host is not that Backend's account, and no
refresh signal would change it. The deployment (`remote-host`/`workstation`) is untouched by this run.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| The whole journey, 64 checks: ingress listing; API-key set/list/remove; 0600/0700 and one whole atomic document; device-code sign-in with the code reaching the panel; cancel, reload-resume, completion, re-login, expiry, disconnect; the composer's catalog following every change with no reload; no token in any response, render, browser storage or request body | `node apps/web/e2e/ux-provider-connection-acceptance.mjs` | `701add2` (`dirty: true`; the tree this record describes) | 0 - 64 checks, 0 failures | `.dev/verify/provider05/journey-final.log` |
| The journey's own claim is load-bearing: with `invalidateModelCatalog()` and Settings-close's refresh key both removed, the composer check fails instead of passing quietly | same driver, mutated `ModelsConfig.tsx` + `AppShell.tsx` | `701add2` + mutation | 1 - `FAIL the composer's model list offers the newly authenticated model after the credential change` | `.dev/verify/provider05/journey-without-invalidation.log` |
| Production Web build the journey serves | `pnpm --filter @hepi/web build` | `701add2` | 0 | `.dev/verify/provider05/web-build.log` |
| Catalog answer read into one shape, 3 tests (the Backend's list, the retired BFF's name map, malformed answers) | `node --test packages/ui/src/lib/catalog-answer.test.mjs` | `701add2` | 0 - 3/3 | in the ui suite below |
| Whole UI suite, incl. the composer's catalog read and the cache's connection scope | `pnpm --filter @hepi/ui test` | `701add2` | 0 - 278/278 | `.dev/verify/provider05/ui-test.log` |
| Typecheck, ui and web (app and vite configs) | `npx tsc --noEmit` in each | `701add2` | 0 | `.dev/verify/provider05/ui-typecheck.log`, `…/web-typecheck.log`, `…/web-typecheck-full.log` |
| Selected gates over the changed packages and their dependents | `node scripts/verify.mjs --profile=changed --base=integration/client-app` | `701add2` | 1 - `check-docs` only | `.dev/verify/provider05/verify-changed.log` |
| Neighbouring browser journeys unchanged: the composed Web + App client journey | `pnpm --filter @hepi/app build && node apps/web/e2e/ux-client-acceptance.mjs` | `701add2` | 0 - 58 checks | `.dev/verify/provider05/client-acceptance.log`, `…/app-build.log` |
| The fixture-host panel seam and the capability three-state, which serve the retired BFF's shape and so do not exercise this read | `pnpm --filter @hepi/web test:panel-ingress`, `… test:capability-trust` | `701add2` | 0 (PASS each) | `.dev/verify/provider05/panel-ingress.log`, `…/capability-trust.log` |

`check-docs` exits 1 on the unchanged 12-link broken baseline across 434 files; its sorted `BROKEN` set is the one
tickets 02/03/04 retained, so it is the baseline failure and not a new one.

**The material finding this run produced is a defect in the shipped client, not in the harness.** The composer's catalog
read (`useAgentSession.loadModels`) parsed the retired Next BFF's answer — a `provider:id` → name map under `models`
plus `modelList` — while the only route this ingress serves is the Backend's, where `models` is the list of models
itself. The fallback path built its names from `Object.entries` of that list, so a model *object* reached
`ModelSelector` as a name and React refused to render it (error #31), taking the whole composer down: on any deployment
whose catalog was non-empty through the ingress, not only after a credential change. The read now goes through one
function, `packages/ui/src/lib/catalog-answer.ts`, which produces the shape the selectors use from either answer, and the
three tests above hold both. This is the second half of the same claim ticket 04's fixture lane could not see: the
fixture served the old shape, so the composed seam is what found it.

**Named limits, recorded rather than smoothed over.** (1) The interactive half is the SDK's own device-code flow driven
end to end; a browser OAuth flow whose authorize and token endpoints are compile-time constants upstream is not
reachable offline, and `startup.ts` composes `ProviderLoginService` without `extraProviders`, so no scripted provider is
registered on a real deployment. (2) The deployed stack stays in environment mode with a container-private agent
directory; this harness proves the same-account composition and changes nothing about what `remote-host`/`workstation` run. (3)
No security-boundary probing was performed in this lane: cross-caller flow theft, hostile `models.json` credential
expressions, forged caller identity, provider-id traversal and OAuth state replay are their own assignment, and several
are already answered at the ingress and login seams. (4) The model the run stores an API key for is an SDK built-in
(`deepseek`) whose base URL is an unused endpoint, so no paid request is made; the catalog entry the run asserts on is
the one this run's own `models.json` names, which is why its name is a fact of the run rather than of the provider.

## Cross-conversation references: creation and follow (ticket 02)

The reference surface is `ReferencePanel`/`ReferenceSurface` in `packages/ui/src/components/ReferencePanel.tsx`, placed by
`RawHistoryPanel` where its own reference list used to be; its decisions are one pure module
(`packages/ui/src/lib/references.ts`). The browser journey mounts the **production** panel and the **production**
`ChatWindow` under `StrictMode` with only the network boundary replaced, so the creation it drives is the real
`POST /api/conversations/:id/references` through `ConversationControl.addReference`, and the entry follow is the real
`useHistoryNavigation` coordinator.

Rows were taken on `impl/xref-02-03` at `c986a56` with a clean tree (`dirty: false` in the selector's own
`verify.json`). Logs are in `.dev/verify/xref02/` (untracked, like every run directory here).

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| Selector over the changed packages and their dependents | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=c1299df` | `c986a56` (`dirty: false`) | 1 | `changed-typecheck` 0; `changed-test` 0 (ui 354, app 26, gateway 166, server 352 — 898 pass / 0 fail); `web-unit` 0 (14/14); `check-docs` 1 — the same 12 pre-existing broken links, 0 guides missing from the index |
| The surface's decisions | `node --test packages/ui/src/lib/references.test.mjs` | `c986a56` | 0 | 10 pass / 0 fail — follow/refuse per outcome, the offers each outcome can support, a write's answer as a named state, the picker's entries taken from the outline the history owner issued, and one identity listed once |
| Whole `@hepi/ui` suite (the locale-key scan runs here) | `node --test $(find packages/ui/src -name '*.test.mjs' \| sort)` | `c986a56` | 0 | 354 pass / 0 fail |
| The coordinator this ticket reuses, unchanged | `node --test packages/ui/src/lib/history-navigation.test.mjs packages/ui/src/components/NavigationOutcomeBanner.test.mjs packages/ui/src/hooks/useHistoryNavigation.lifecycle.test.mjs` | `c986a56` | 0 | 26 pass / 0 fail |
| Browser: create, reload, follow, every unavailable state | `node apps/web/e2e/ux-references.mjs` | `c986a56` | 0 | `PASS`, 43 checks — conversation-only default (submit disabled until a target is chosen), two creations with one write request each, both read back after a remount with no new write, a conversation follow with **zero** target reads, an entry follow with **exactly one** `/navigation/around` and **zero** older-history pages, all six outcomes with their own words and offers, an unresolvable follow opening nothing, and two refused creations storing nothing |
| Browser: the rail's own scene, unchanged | `node apps/web/e2e/ux-history-rail.mjs` | `c986a56` | 0 | `HISTORY-RAIL BROWSER CHECKS PASSED` |
| Browser: ticket 03's failed-hit → Retry → landing, unchanged | `node apps/web/e2e/ux-navigation-retry.mjs` | `c986a56` | 0 | `PASS`, 8/8 — the `ChatWindow` gate this change adds does not disturb it |
| Typecheck, ui and web (web runs its app and vite configs) | `pnpm --filter @hepi/ui typecheck` · `pnpm --filter @hepi/web typecheck` | `c986a56` | 0 · 0 | no diagnostics |
| Whitespace / conflict-marker check | `git diff --check` | `c986a56` | 0 | no output |

**The one non-zero exit is `check-docs`, and it is the repository's.** It reports exactly twelve broken relative links
— the same count, paths and bytes every section above records (ten under `.scratch/design-fixes/host/diagnosis.md` and
`.scratch/architecture-unification/issues/11-integrate-verify.md` pointing at git-ignored `.dev/verify/…` logs, two under
`.scratch/development-audit/` pointing at the ignored `.pi/skills/` tree). None is in a file this change touches, and
the new `docs/chat.md` anchor resolves.

**What the browser journey found, and why the change is more than a panel.** An entry follow into a conversation the page
already remembers was refused as `malformed`. The coordinator mints its coordinate from the conversation **and its
history scope**, while `useAgentSession`'s restored view reports `ready` with messages before its read has stated
`snapshotRevision` — so `ChatWindow`'s locate effect fired with no scope to address, and the coordinator refused a
coordinate it had just minted itself. The effect now waits for that identity before issuing a locate: a gate on the
existing fact, not a timer. Nothing else in `ChatWindow` changed.

**No sleeps in these checks.** The journey waits on rendered selectors and on the counters the fixture advances when the
request each stands for arrives; the unit cases are pure values. No bypass or security-control probe was designed or
run: the fixture's Backend is an ordinary response stub behind the client's real request path, and no authorization or
system boundary was exercised.

**Not claimed here.** This is ticket 02's client evidence, not the system acceptance: the Backend is stubbed, so
create-through-the-ingress-against-a-real-committed-history, the inherited-fork-entry row and a real transient read
failure remain ticket 03's (in `.scratch/cross-session-references/issues/03-acceptance.md`), which also gates on the still
open history ticket 05. No push, deployment, restart or `remote-host` build was performed.

## Cross-conversation references: how 02/03 arrived on the integration line (2026-10-20)

Ticket 02's source and its record were cherry-picked from `impl/xref-02-03` tip `3544d3b` onto this line, in branch
order: `c986a56` (the feat commit) became `6191f82` and the record `3544d3b` became `42dcbc3`. Both picks were
**clean** — `git range-diff c986a56^..c986a56 6191f82^..6191f82`, and the same pair for the record, report the pairs
identical — so no conflict was resolved and nothing was rewritten. The branch had been cut from this line at `c1299df`;
the commits this line gained since then are history-navigation ticket 05 (`d1e3be5`…`fc15cc2`), which is why the two
documents the picks touch most (`docs/migration-status.md`, `docs/verification.md`) were already carrying 05's sections:
each pick appended the reference sections beside them rather than replacing them, and 05's system-acceptance record and
ticket 02/03's records are present together on the integrated tree. Nothing in history 05's source
(`packages/ui/src/components/ChatMinimap.tsx`, `packages/ui/src/hooks/useHistoryNavigation.ts`) was touched by the
picks, and ticket 02's one seam change sits in `ChatWindow.tsx`, which 05 did not modify.

**Ticket 03 is not closed.** Its gate is a set of journeys nobody has run, and this integration does not run them: a
reference created **through the client ingress against a real Backend** (so the creation-refusal row is proven from the
picker to the runtime's own membership check, not at each half separately), an **inherited-fork-entry follow** in the
fork's own scope, and a **real transient read failure** on the reference routes with the retry that lands after it.
Ticket 02's browser evidence stands on the client's real request path with a fixture Backend — the right seam for ticket
02, and not a real ingress→Backend journey. History 05 is **no longer** a reason it stays open: 05's source and its
82-check matrix are on this line and that ticket is delivered and accepted at `a0caf5d`, so the shared coordinator this
acceptance leans on has an accepted system matrix. [The spec](../.scratch/cross-session-references/spec.md)
stays open and 03's checkboxes stay unticked — see
[03's record](../.scratch/cross-session-references/issues/03-acceptance.md#what-still-has-to-run-before-this-closes).

Every row below was re-taken **over the tree this integration produces**, not inherited from the branch's own
`c986a56` runs: the surrounding line moved (05's rail and coordinator fixes are in it), so the code was re-run here. Rows
cite `42dcbc3`, the last pick, measured with the tree otherwise carrying only the two files this integration neither
touched nor committed — history 05's draft acceptance fixture and driver
(`apps/server/scripts/history-acceptance-fixture.ts`, `apps/web/e2e/ux-history-acceptance.mjs`), which the selector's
own `verify.json` listed as `dirtyFiles` and no `--base` selection here read. Those two were untracked at `42dcbc3`
and, because a later docs commit picked them up by mistake, briefly tracked; they are **not** part of this line's tree
now — see the correction in the environment note above. Nothing in the rows below depended on them. Logs are in
`.dev/verify/xref0203/` (untracked, like every run directory here).

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| The surface's decisions | `node --test packages/ui/src/lib/references.test.mjs` | `42dcbc3` | 0 | **10 pass / 0 fail** — follow/refuse per outcome, the offers each can support, a write's answer as a named state, the picker's entries from the history owner's outline, one identity listed once |
| Whole `@hepi/ui` suite (locale-key scan included) | `node --test $(find packages/ui/src -name '*.test.mjs' \| sort)` | `42dcbc3` | 0 | **354 pass / 0 fail** |
| UI and Web typecheck (Web runs its app and Vite configs) | `pnpm --filter @hepi/ui typecheck` · `pnpm --filter @hepi/web typecheck` | `42dcbc3` | 0 · 0 | no diagnostics |
| Web unit suite | `pnpm test:web:unit` | `42dcbc3` | 0 | **14/14 pass** |
| The Web build the browser scenes are served from | `pnpm --filter @hepi/web build` (Vite, this workstation) | `42dcbc3` | 0 | `✓ built`, third-party notice emitted |
| Browser: create, reload, follow, every unavailable state | `node apps/web/e2e/ux-references.mjs` | `42dcbc3` | 0 | `PASS`, **43 checks / 0 FAIL** |
| Browser: the rail's own scene, beside 05's fixes | `node apps/web/e2e/ux-history-rail.mjs` | `42dcbc3` | 0 | `HISTORY-RAIL BROWSER CHECKS PASSED` |
| Browser: failed-hit → Retry → landing, beside 05's fixes | `node apps/web/e2e/ux-navigation-retry.mjs` | `42dcbc3` | 0 | `PASS`, **8/8** |
| Selector over the changed packages and their dependents, against the **current integration base** | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=c1299df` | `42dcbc3` | 1 | `changed-typecheck` 0; `changed-test` 0 (**ui 354, app 26, gateway 166, server 352 — 898 pass / 0 fail**); `web-unit` 0 (14/14); `check-docs` 1 — the same 12 pre-existing broken links, 0 guides missing from the index |
| Whitespace / conflict-marker check | `git diff --check` | `c05857f` | 0 | no output |

The selector was run twice: over the picked source at `42dcbc3`, and again at this record's own commit `c05857f`
(`.dev/verify/2026-10-20T06-18-21-389-verify-changed/verify.json`), with the same four step outcomes and the same
counts — ui 354, app 26, gateway 166, server 352, web-unit 14/14 — because the second run differs only in Markdown no
test reads. `dirtyFiles` in that report is the two files described above, not an edit to a tracked one. Those files were
removed from the tree afterwards (the accidental tracking described in the environment note above), which changes no file
any `--base=c1299df` selection reads: the removed pair are history 05's superseded draft, and 05's formal
`history-navigation-acceptance-fixture.ts`/`ux-history-navigation-acceptance.mjs` are untouched by this integration.

**The one non-zero exit is `check-docs`, and it is the repository's.** Twelve broken relative links — ten under
`.scratch/design-fixes/host/diagnosis.md` and `.scratch/architecture-unification/issues/11-integrate-verify.md` pointing
at git-ignored `.dev/verify/…` logs, two under `.scratch/development-audit/` pointing at the ignored `.pi/skills/`
tree. The same count, paths and bytes every section above records; none in a file this integration writes, and the
`docs/chat.md` anchor the reference guide adds resolves.

**Not claimed here.** No push, deployment, service restart or `remote-host` build — the Vite build ran on this
workstation, the only place this line builds. No bypass or security-control probe was designed or run. The system
acceptance ticket 03 owes is not claimed by this integration: `03-acceptance.md` keeps its gate and its unticked matrix.

## Shared client Stage G (Pilo 23–25) on one tree (2026-10-20)

Tickets 23, 24 and 25 of the shared client landed on `main` as one reviewed change, in this order: `7345384` (the product change — the three tickets share `workbench-scope.ts`, the browser fixtures and `docs/client-ingress.md`) and `2a53eef` (review follow-up, dropping the test case that mirrored the implementation from `packages/ui/src/lib/workbench-connection.test.mjs`). Base `0a3d065`. `2a53eef` changes no product source: it removed a source-grep case and one tautological assertion.

Ticket 22 is untouched by this batch: it remains the aggregate gate, waiting on SSH 09 and a re-run of ticket 20's packaged journey, and no acceptance checkbox in it was ticked. Its references-03 edge is met — that ticket is accepted and integrated on this line at `0acf499`. Child recovery's G2/G6 is separate approved work, not a 22 gate. The three rows below are implementation slices with their own acceptance, held in `.scratch/client-app/issues/`.

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| Selector over the changed packages and their dependents, clean tree | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=0a3d065` | `7345384` | 0 | `.dev/verify/2026-10-20T10-40-08-666-verify-changed/` — `verify.json` reports sha `7345384f`, `dirty: false`, `ok: true`; steps `changed-typecheck` 0, `changed-test` 0, `web-unit` 0, `check-docs` 0 |
| Typecheck step | `.dev/verify/2026-10-20T10-40-08-666-verify-changed/changed-typecheck.log` | `7345384` | 0 | `tsc --noEmit` for session, ui, app, gateway, server and both Web programs; 12.1 s, no diagnostics |
| Test step | `.dev/verify/2026-10-20T10-40-08-666-verify-changed/changed-test.log` | `7345384` | 0 | `@hepi/ui` **358 pass / 0 fail** (1.683 s), `@hepi/session` 57 pass (86.4 ms), `@hepi/gateway` 166 pass (1.639 s), `@hepi/server` 352 pass (3.883 s), `@hepi/app` 26 pass (891.4 ms) — 959 pass / 0 fail |
| Web unit step | `.dev/verify/2026-10-20T10-40-08-666-verify-changed/web-unit.log` | `7345384` | 0 | 14/14 pass, 65 ms |
| Docs links and index | `.dev/verify/2026-10-20T10-40-08-666-verify-changed/check-docs.log` | `7345384` | 0 | 434 Markdown files, 0 broken relative links, 0 guides missing from the index |
| The two focused cases `2a53eef` keeps | `node --test packages/ui/src/lib/workbench-connection.test.mjs` | `2a53eef` | 0 | 2 pass / 0 fail, 73 ms — the connection's API asks its own origin and answers nothing once the client is disposed; a hook outside a connection throws instead of reaching the page's `fetch` |

**Scopes, named per command.** The selector's `changed-test` step ran whole-package suites (`ui 358, session 57, gateway 166, server 352, app 26`); its `web-unit` step ran the three Web files it names; the `node --test` row is the single file `2a53eef` trims. The `355` in the ticket files is a different run — `node --test $(find packages/ui/src -name '*.test.mjs')` — and is not this selector's count.

Browser seams driven over these sources (PASS each): `ux-capability-trust`, `ux-sidebar-ingress`, `ux-extensions-panel`, `ux-mcp-tool-states`, `ux-workbench-scope`, `ux-references`, `ux-navigation-retry`, `ux-subtree-control`, `ux-file-surfaces`, `ux-file-failures`, `ux-docx-preview`, `ux-skills-project-target`, `ux-skills-inventory-race`, `ux-delegate-definition-race`. `ux-panel-ingress.mjs` still times out at its `/api/sessions/session-1/state` wait at this tip **and** at the pinned `0a3d065` baseline worktree alike — a pre-existing mismatch between the fixture's retired path and the path `ExtensionsConfig` now asks. It is recorded in [ticket 24](../.scratch/client-app/issues/24-require-connection-backed-requests.md) and unchanged by this batch.

**Not claimed here.** Ticket 22's system acceptance is not delivered by this batch and none of its checkboxes moved; no push, deployment, restart or `remote-host` build ran — every command above ran on this workstation.
## Client closeout ticket 22: the UX rows the platform checks could not state (2026-10-20)

Ticket 22 is the aggregate UX gate, and its last unmeasured row was how the supported platforms are **operated**: keyboard
walk-through, where focus lands, whether a failure is announced, what a narrow viewport still lets a person do, and what a
Chinese IME does to a half-composed sentence. Every other driver in `apps/web/e2e/` asserts a workflow's outcome; none
stated how one is reached. One new driver, `apps/web/e2e/ux-closeout-accessibility.mjs`, mounts the production
`ChatWindow` (inside `StrictMode`, an `I18nProvider` and a workbench connection, with only its network boundary replaced)
in three scenarios — an idle conversation, a running one, and a read the Gateway could not answer — and drives it in
Chromium. No admission boundary is bypassed: every request it makes is an ordinary one the product ships.

The bundle is a **production** build, so `StrictMode` is present in the mounted tree but its development double-invocation
replay does not run: this driver exercises the tree the hosts mount, not React's development-mode remount behaviour, and
claims nothing about the latter.

Branch `impl/closeout-22`, base `2b1cdf2` (`main`), result commit **`5cc6e22`** (clean tree). Everything below ran on
`workstation`, this workstation; nothing ran on or was deployed to `remote-host`.

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| Keyboard, focus, error announcement, narrow viewport, Chinese IME, 28 checks | `node apps/web/e2e/ux-closeout-accessibility.mjs` | `5cc6e22` (clean) | 0 | **28 ok / 0 FAIL**, `== result: PASS` — `.dev/verify/c22-a11y/ux-closeout-accessibility.log`; the panel is announced (`role="status"`, `data-read-failure="unreachable"`), its Retry is the first control Tab reaches and lands the second read's transcript; 390×844 does not overflow, a bare Enter inserts a line while Ctrl/Cmd+Enter sends, More controls opens by keyboard; a composition in progress submits nothing and a later Enter sends exactly the composed text |
| Selector over the changed packages and their dependents | `pnpm verify:changed --base=2b1cdf2` | `5cc6e22` (clean, `dirty: false`) | 0 | `@hepi/ui` **371 pass / 0 fail**, `@hepi/app` 26, `@hepi/gateway` 166, `@hepi/server` 357, `web-unit` 14/14 — `.dev/verify/2026-10-20T14-05-49-629-verify-changed/verify.json`. That report lists **three** steps (`changed-typecheck`, `changed-test`, `web-unit`) and no docs step; the link check is the row below, run on its own |
| Documentation links and index | `node scripts/check-docs.mjs` | `d977ec1` plus this correction's Markdown, uncommitted (dirty) | 0 | 434 Markdown files, 0 broken relative links, 0 guides missing from the index — `.dev/verify/c22-a11y/check-docs.log` |
| Native save on the packaged debug shell, real GTK picker (reused unchanged, this ticket's own row) | `node apps/web/e2e/ux-native-acceptance.mjs` (`closeout-packaging` lane) | debug shell from `2b1cdf2`, host at `cc772ec` | 0 | **37 ok / 0 FAIL**, run twice; private bus with the inherited address used by no shell process, developer keyring unchanged, 1048-byte save with matching SHA-256, a cancelled choice leaving no second or partial file — `.dev/worktrees/closeout-packaging/.dev/verify/c17-c20-native/native-save-acceptance{,-rerun}.log` |
| File missing and truncated preview, mounted (reused unchanged) | `node apps/web/e2e/ux-file-failures.mjs` | `3c7fbeb` (`closeout-ssh-09` lane) | 0 | **25 ok / 0 FAIL** — `.dev/worktrees/closeout-ssh-09/.dev/verify/rebased-ssh09/ux-file-failures.log` |

**The driver found a real defect, and this commit fixes it.** The conversation window computes its rendered range in a
layout effect that takes the element it measures, and that element was read off `scrollContainerRef.current` **during
render**. A read failure replaces the transcript, so the ref is null on the render that recovers from one: the Retry
re-read, the panel left, the element mounted — and the window kept measuring nothing, because a ref assignment is not a
render. The recovered conversation arrived as an empty transcript with its composer. The element is now state as well as
the ref, published by a callback ref, so mounting it is a render the window sees; the journey's retry assertion holds it.

**What this does not close, stated as limits rather than passes.** Three named edges keep ticket 22 open, and its
acceptance boxes stay unticked:

- **Keyboard and focus defects reproduced by the UI review (160) at `23d4f1e` are not fixed on this branch.** The
  history rail cannot be opened by keyboard (no focusable element); a closed sidebar's hidden controls keep taking Tab;
  `RawHistoryPanel` reads whole blocks in reverse order, so a late answer A overwrites B; and a compaction in the open
  conversation leaves the outline stale with a Retry that never succeeds. Two fix branches own those files
  (`fix/history-rail-access-and-scope`, `fix/raw-history-and-sidebar-focus`); this ticket neither fixes nor re-verifies them.
- **Mobile is unmeasured.** There is no authenticated mobile Web login, no mobile App and no Android artifact — no SDK,
  `adb`, device or emulator on this host. The 390×844 figure is a Chromium viewport of the shared surface, not a platform.
- **The deployed origin is not this revision.** `main` at `23d4f1e` was not deployed, so nothing here corresponds to a
  live origin; and the native row is a **debug** shell (shared `CARGO_TARGET_DIR`, 6 jobs, incremental), functional
  evidence only — not release performance, not an immutable artifact check, no peak-memory re-measurement.
- **Interactive OAuth against real upstream endpoints stays unmeasured** (provider 05's named limit: the composed service
  declares `auth.oauth` only over a scripted provider), and the terminal/upload rows reuse unchanged-source evidence from
  earlier revisions rather than re-running at this one.
## Native artifact verification: the callable operation (2026-10-21)

`apps/app/scripts/verify-artifacts.mjs` was a 657-line file whose top level selected the artifact, created the log
directory and sampled the login keyring before the journey began, and whose tail called `process.exit`. It is now the
operational entry point only — resolve `--artifact-dir`/`--log-dir`, call
`runArtifactVerification({ artifactDir, logDir })` from `apps/app/scripts/verify-artifacts.operation.mjs`, print
`{ logDir, passed, failed }`, exit — and the operation owns the artifact inspection, the packaged journey, the private
display and credential store it acquires, its fixture listeners and packaged process groups, their release, and report
finalization. Importing the operation performs no artifact lookup, creates no directory, spawns nothing and never exits.
Flags, the default artifact choice, the summary line, the report's fields and the exit semantics are unchanged; no generic
verifier, scenario runner or class per subprocess was introduced.

Branch `impl/nonui-native-01`, base `5ec7ffe6`. The packaged journey was run against a **prebuilt debug artifact**
(`.dev/artifacts/nv01-debug`, `Hepi_0.1.0_amd64.deb`, provenance revision `5ec7ffe6`, `dirty: true`) built on this
workstation; nothing ran on or was built on `remote-host`.

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| The callable operation's interface | `node --test apps/app/test/verify-artifacts-operation.test.ts` | `5ec7ffe6` + this change (dirty tree) | 0 | 3 pass / 0 fail — importing the operation starts nothing, and a report counts the assertions it recorded in order, bounds a detail at 800 characters and states an absent one as an empty string |
| The shared packaged-environment guard, pointed at the operation | `node --test scripts/credential-sandbox.test.ts` | `5ec7ffe6` + this change (dirty tree) | 0 | 14 pass / 0 fail; the driver table now reads `verify-artifacts.operation.mjs`, the file that builds every packaged environment |
| Selector over the changed package and its dependents | `pnpm verify:changed --base=5ec7ffe6` | `5ec7ffe6` + this change (`dirty: true`) | 0 | `changed-typecheck` 0, `changed-test` 0 (`@hepi/app` **29 pass / 0 fail**, this change's three included), `script-typecheck` 0, `script-tests` 0 (**89 pass**), `check-entrypoints` 0 (141 entries, 0 newly missing), `check-docs` 0 (466 files, 0 broken links) — `.dev/verify/2026-10-21T13-14-43-025-verify-changed/verify.json` |
| The packaged artifact journey, through the new entry point | `node apps/app/scripts/verify-artifacts.mjs --artifact-dir=.dev/artifacts/nv01-debug --log-dir=.dev/verify/nv01/final` | `5ec7ffe6` + this change (dirty tree); artifact from `5ec7ffe6` | 0 | **54 assertions, 0 failures** — `.dev/verify/nv01/final/report.json` and `.dev/verify/nv01/final.log`; `dpkgState` `Status: install ok installed`, `installExit` 0, `verifyExit` 0, `rootRemoved` true, `credentialStore.retained` `removed with the run`, developer keyring `0ced02df2ba9… -> 0ced02df2ba9…` unchanged |
| The same artifact and host, through the pre-change script | `node <5ec7ffe6 verify-artifacts.mjs> --artifact-dir=.dev/artifacts/nv01-debug --log-dir=.dev/verify/nv01/legacy-run` | `5ec7ffe6` | 0 | **54 assertions, 0 failures** — `.dev/verify/nv01/legacy-run/report.json`. Compared field by field with the run above: identical report key set, identical assertion names in identical order, identical outcomes. The nine differing details are the run's own identities (bearer values, the private bus path, the retained dpkg log path) |

**What the paired run establishes.** The comparison is the replacement's evidence: a refactor of this size could pass its
own tests and still change what the artifact check observes, so the same artifact was verified by both the old script and
the new entry point on the same host and the two reports were diffed. Teardown was checked as a process fact rather than
read from the report: after the final run no `Xvfb :9x`, no `hepi-app` from this worktree and no private
`dbus-daemon --print-address` from either run was alive, and no `hepi-artifact-cred-*` tree remained under `/tmp`. The
`Xvfb :90`, `dbus-daemon` and `hepi-app` processes still running belong to other checkouts and predate this run by two
days; they were left alone.

**Not claimed.** No release-profile artifact was built or verified, no `remote-host` build or run happened, and no
system `dpkg` install was made — the transaction ran in a private user namespace over a root this run removed. The debug
artifact is functional evidence only, not a release measurement.

**The run at the committed revision `0aab74e9` differs only where it must.** The verifier binds
`provenance-names-the-built-revision` to `git rev-parse HEAD`, and the artifact was built from `5ec7ffe6`, so running the
committed tree against it reports `5ec7ffe62a2a… (HEAD 0aab74e9c…)` and 53/54 with that one failure
(`.dev/verify/nv01/postcommit.log`). The other 53 assertion outcomes and the report's key set are identical to the run
above, which is the point of the assertion: a run against an artifact built from another revision is a different run, and
it says so rather than passing. The passing runs are the two revision-matched ones.

## Model workflow refresh (ticket 06, 2026-10-21)

Branch `impl/ui-model-workflow`, base `b3ab7871`. The `modelsRefreshKey` hop from `AppShell` → `ChatWindow` →
`useAgentSession` is gone, and with it the "closing Settings" refresh: every write of a model-domain resource now states
its change through the catalog's own rule. `packages/ui/src/lib/models-cache.ts` keeps the one page cache and gained the
mounted readers (`subscribeModelCatalog`); `invalidateModelCatalog()` drops the cached answer **and** tells those readers,
each of which re-runs the read it already owns — the same bounded retry a mount performs.

What each write states: a `models.json` save the Backend answered `applied:true` (plus the `enabledModels`
re-verification it then performs), and an accepted `enabledModels` write, both call the rule. A `models.json` save
answered `applied:false` is saved-but-not-applied: it reads the file back, states the failure and claims no catalog
change, because the running runtime still serves what it had. A refused credential write returns before the rule, so the
stored hint and the held catalog stay as they were. A catalog read that fails is stated where the model is chosen and
offers one Retry, which is one more read of `/api/models` and no part of a mutation.

| Check | Command | Revision | Exit | Result |
| --- | --- | --- | --- | --- |
| Selector over the changed packages and their dependents | `pnpm verify:changed --base=b3ab7871` | `a5687489` (clean tree) | 0 | `changed-typecheck` 0, `changed-test` 0 (`@hepi/ui` **464 pass / 0 fail**, `@hepi/app` green), `web-unit` 0 (14 pass), `check-docs` 0 (465 files, 0 broken links) — `.dev/verify/2026-10-21T19-06-11-174-verify-changed/verify.json` |
| The settings panels' own browser seam, with the workflow's observations | `pnpm --filter @hepi/web test:panel-ingress` | `a5687489` (clean tree) | 0 | **77 checks, all ok** — `.dev/verify/ticket06/panel-ingress-committed.log`. A stored credential re-read the mounted reader's catalog with Settings still open; a refused key write claimed no change; an applied `models.json` save re-read it; a save the runtime could not apply added no catalog read and re-read the file instead; an accepted `enabledModels` write re-read it; a removal re-read it |
| The provider acceptance journey, with Settings kept open | `pnpm --filter @hepi/web test:provider-acceptance` | `a5687489` (clean tree) | 0 | **70 checks, 0 failures** — `.dev/verify/ticket06/provider-acceptance-committed.log`. A stored key re-read the catalog behind the still-open dialog (1 → 2 reads of `/api/models`); no conversation-settings write followed the change; the composer offered the newly authenticated model; the removal re-read it again (2 → 3); closing an unedited Settings made no read at all |
| The rule is load-bearing, not incidental | `test:panel-ingress`, mutated tree | `a5687489` + mutation (`dirty: true`) | 1 | Removing the reader loop in `invalidateModelCatalog()` fails `test:panel-ingress` with `the fixture threw: page.waitForFunction: Timeout 30000ms exceeded`. Calling the rule on a saved-but-not-applied save fails the same driver with `FAIL a save that was not applied claimed an applied catalog change (4 → 5)`. Both mutations were reverted before the runs recorded above |

Correction at `8a64b0e2`: each catalog reader now owns a sequence claim. Superseded success and failure responses
cannot replace current state, and superseded retry loops stop before another attempt. The lifecycle regression releases
old responses last and checks the retry schedule. Independent correction review found no remaining material finding;
its focused lifecycle run passed 40/40. The historical table above describes the earlier revision.

Merged source `07943df4`: `pnpm verify:changed --base=62c2c588` exit 0 (UI 465/465, App 29/29,
Web unit 14/14, selected typechecks). Report and raw step logs:
`.dev/verify/2026-10-21T19-21-04-372-verify-changed/verify.json`. Graph update also exited 0.

**Not claimed.** No deployment was restarted or inspected, no App-host journey ran, and nothing was built or run on
`remote-host`. The unit cases in `packages/ui/src/lib/models-cache.test.ts` and
`packages/ui/src/hooks/useAgentSession.lifecycle.test.ts` state the same contract at their own seams and ran inside
`changed-test` above.
