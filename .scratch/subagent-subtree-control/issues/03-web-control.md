# 03 - Web selective control

Status: **integrated** — implemented on `impl/subtree-control-03`, approved on tip `adafc5c`, merged into
`integration/client-app` as `20fcd1781247fd3cd1fc38dd76a7b0fbf8d3a405`. Blocked by: 01 (resolved), 02 (resolved and
integrated) — both satisfied.

Add AgentSessionPanel controls with confirmation, selection, progress, partial failure and navigation. Keep global dock navigation-only.

Acceptance: nested stop, selected children, exact outcomes, safe cross-project confirmation and idempotent refresh.

## What was built

- `packages/session/src/control.ts` — `subtreeControl` (POST `/api/conversations/:id/subtree-control`) and
  `subtreeRequest` (GET, reads one `requestId` back, `unknown_request` → no record) on the shared
  `createConversationControl`, with `SubtreeAnswer`/`SubtreeChildAnswer` and the same three-outcome rule every other
  operation uses: refusal / unknown-with-identity / answer.
- `packages/ui/src/lib/subtree-control.ts` — attempt identity per (conversation, action, selection) held until settled
  (`subtreeAttemptKey`/`subtreeRequestId`/`subtreeSettled`, the same shape a fork or a delegation uses), plus
  `subtreeControlFrom`/`subtreeReadFrom` and `subtreeChildren` which pairs each **durable** outcome with the child's
  **current** catalogue row through the existing `catalogueRow`, keeping a child the Backend stated no row for as such.
- `packages/ui/src/components/SubtreeControlPanel.tsx` — two explicit actions, nothing written before confirmation; the
  confirmation names the root, the count and every descendant with its own status, and shows the execution host of any
  child not on the root's own. Descendants start all-chosen, exclusions are what the state holds, so a narrowed request
  stays narrowed. Requested and Now are two columns. A lost answer offers read-back or resume under the same id, never a
  re-send and no scheduler. A refusal shows the Backend's own code and message; a partial result is labelled partial.
- `packages/ui/src/components/AppShell.tsx` — mounted **below** the child tree in the Agents dropdown; rows keep
  navigating while a request is in flight, and an answered/refused request re-reads the catalogue instead of patching rows.
- `docs/chat.md`, `docs/client-ingress.md`, `docs/migration-status.md`, `docs/notes/subtree-control-web-ux.md`,
  `subtree.*` keys in all three message files.

## Two review findings fixed before integration

Reviewer35 confirmed both of the parent's findings on the first pass (`65d0bff`). They are the same boundary mistake, and
the first browser run **required** the faulty behaviour, so replacing that assertion is part of the fix.

1. **A resume dropped the confirmed selection.** The panel built the POST body from the listing it was rendered with:
   `selected === null || resume ? {} : { selected }`. When an answer was lost before the Backend captured anything, the
   next send stated **no** selection, so the Backend captured the **whole** subtree — the children the user had
   deliberately excluded included — and a resume after a listing that moved could instead name a subset that was never
   captured and be refused whole as `outside_subtree`. Either way a narrowed decision silently widened. Fix: the confirmed
   decision is one immutable record — `SubtreeAttempt { key, requestId, rootId, action, selected }` — minted by
   `subtreeConfirm` at the moment the confirmation is accepted, and both `subtreeControlFrom` and `subtreeReadFrom` take
   that record as their **only** input, so nothing on the send or read path can consult the current listing. A resume
   repeats the confirmed subset unchanged; no second confirmation is asked for, because that decision was already made.
   A `pending` read-back keeps the attempt whole, so the retry after it carries id **and** subset.
2. **A completed read-back held the identity.** `subtreeSettled` was reachable only from an answered write, so after a
   read-back answered `completed` the same (conversation, action, selection) decision reused the finished request's id —
   and the Backend answers a known id from the capture it already made, so the panel displayed children as controlled
   while nothing was reached. The read path is not an edge case: it is where a lost race actually settles, with no write
   of ours ever answering. Fix: `subtreeRelease(attempts, attempt)` is called on **both** completions — answered write and
   read-back stating `completed` — keyed by the attempt's own key.
3. Connection generation and the root guard were checked and need no change: `AppShell` is mounted under
   `I18nProvider key={connection.scope}` in `packages/ui/src/workbench.tsx`, so a profile or connection switch remounts
   the tree rather than re-rendering the panel against a new client, and the attempt map is keyed by root id. No extra
   guard was added.

Test-side: `subtreeRequestId`/`subtreeSettled` are now internal to the seam (the attempt record is its public shape, so a
caller cannot assemble a send body at all), `subtreeAttemptKey` stays public as the decision's identity; the fixture got
a movable descendant listing (`setListed`) and an id-keyed capture ledger so a read answers from what that id captured
rather than from the reader's own claim; and a `pending` read mode was added. The browser seam goes 52 → 68 checks, and
the two assertions that demanded the old behaviour are gone.

## Acceptance coverage

| Ticket acceptance | Where it is proven |
| --- | --- |
| A confirmed subtree stop is one request on the existing route, with the connection's own credential | `apps/web/e2e/ux-subtree-control.mjs` — exactly one POST, URL, `Authorization` |
| Nested stop (scope is the Backend's captured set) | the panel sends a proposal only; `outside_subtree` refusal path asserted in `packages/session/test/subtree-control.test.ts` and shown by the browser run |
| Selected children only | browser run — deselecting one child sends `selected: [one id]`, and the exclusion survives the next decision |
| Exact per-child outcomes, durable vs current never merged | `packages/ui/src/lib/subtree-control.test.mjs` (row pairing, missing row) + browser run two-column checks |
| Safe cross-project confirmation | browser run — a child on another host is named with that host before any write |
| Idempotent refresh, no duplicate operation | attempt identity reused across retry/resume; `subtreeRequest` GET read-back settles a lost answer (browser run), `packages/session/test/subtree-control.test.ts` carries the id |
| A narrowed decision cannot widen (review finding 1) | `subtree-control.test.mjs` "a confirmed decision is one frozen record" / "resending an attempt posts the subset it was confirmed with"; browser run: resume after `setListed` moved, subset unchanged, excluded child still ungoverned; `subtree-surface.test.mjs`: no send/read consults `selected` |
| A settled identity is not replayed (review finding 2) | browser run: same decision after a completed answer and after a completed read-back is a **new** id; `subtree-surface.test.mjs`: both paths call `release`, an unfinished read does not |
| Navigation never lost, global dock navigation-only | `packages/ui/src/components/subtree-surface.test.mjs` (no stream/state polling, sidebar untouched) + browser run: a row and a result row both open, at zero requests |
| Partial failure shown, not summarised | browser run — refused child plus a removed child stating "no current row" |

## Verification

Ran on `impl/subtree-control-03` (feature `53f2e39`, merge of `integration/client-app` `7807c46` as `9224aa7`), logs under
`.dev/verify/subtree-03/`. No production build on any remote host.

- `pnpm -r typecheck` — exit 0 (`typecheck-merged.log`).
- `pnpm -r test` — exit 0, 1246 tests, 0 fail (protocol 51, client 10, session 57, ui 208, app 9, gateway 438, server 473) (`r-test-merged.log`).
- `node apps/web/e2e/ux-subtree-control.mjs` — exit 0, 52 checks, 0 FAIL, headless Chromium (`browser/ux-subtree-control-merged.log`).
- `pnpm test:web:unit` — exit 0, 52 tests (`web-unit-merged.log`).
- `pnpm verify:changed --base=integration/client-app --test-file=packages/session/test/subtree-control.test.ts --test-file=packages/ui/src/lib/subtree-control.test.mjs --test-file=packages/ui/src/components/subtree-surface.test.mjs` — `changed-typecheck` PASS, `changed-test-packages-session` PASS, `changed-test-packages-ui` PASS; `check-docs` FAIL exit 1 on 12 broken relative links, all of them in untouched `.scratch/` documents (same pre-existing failure recorded by ticket 02; `docs/` itself reports 0 newly broken). Final run at `f5759b9`, report `.dev/verify/2026-10-18T18-33-55-690-verify-changed/`.

### At the review fix (same branch, no full-suite repeat per the review instruction)

Two commits carry the fix: `fix(subtree): a retry repeats the decision the user confirmed, not the screen` on top of the
reviewed `65d0bff`, then the merge of `integration/client-app` (which by then stood at `3398030`, bringing MCP
conversation-tools files with no overlap on this branch's `packages/session`/`packages/ui` paths). The fix changes no
Backend file — `git diff --name-only 7807c46 HEAD -- apps/server packages/server` is empty — so ticket 02's projection and
its routes are untouched. Each command below was run at this branch's tip and the retained `-verify-changed` report under
`.dev/verify/<timestamp>/` names the sha it ran, as this repository's verification practice requires; the other logs are
the `-final` names under `.dev/verify/subtree-03/` (browser, ui suite, session suite, ui typecheck, check-docs). Only
this document changes after a run, so a code-only comparison against the tested sha is empty.

- `node apps/web/e2e/ux-subtree-control.mjs` — exit 0, 68 checks, 0 FAIL, headless Chromium
  (`browser/ux-subtree-control-final.log`).
- `pnpm verify:changed --base=integration/client-app --test-file=packages/session/test/subtree-control.test.ts
  --test-file=packages/ui/src/lib/subtree-control.test.mjs --test-file=packages/ui/src/components/subtree-surface.test.mjs`
  — `changed-typecheck` PASS, `changed-test-packages-session` PASS (5 subtree control tests), `changed-test-packages-ui`
  PASS; `check-docs` FAIL exit 1 on the same 12 pre-existing broken links, all in untouched `.scratch/` documents
  (`docs/` itself: 0 newly broken).
- `packages/ui` whole suite `node --test src/**/*.test.mjs` — exit 0, 213 tests, 0 fail
  (`ui-test-final.log`); `packages/session` whole suite — exit 0, 57 tests, 0 fail (`session-test-final.log`).
- `pnpm --filter @hepi/ui typecheck` — exit 0 (`ui-typecheck-final.log`).
- `node scripts/check-docs.mjs --root=<worktree>` — exit 1, the same 12 broken links in untouched `.scratch/` documents;
  0 in `docs/` (`check-docs-final.log`).

## Deliberate omissions

- No aggregate "subtree is stopped" summary, no progress bar, no auto-escalation from stop to interrupt: the Backend
  answers per child, so a single status would be a lie about children that were refused or never reached.
- No polling scheduler and no per-child connection. Refresh is a user action on one GET; the rows themselves continue
  to come from the catalogue the app already reads.
- No new route or transport: `createConversationControl` and `WorkbenchClient` own the HTTP, so both clients inherit
  their own ingress and credential.
- Interrupt never silently resumes a user-held conversation, and nothing here rewrites a durable outcome to match the
  present.

## Merged into `integration/client-app`

Merged as `20fcd1781247fd3cd1fc38dd76a7b0fbf8d3a405` (`--no-ff`, parents `3398030` + `adafc5c`); `git merge-tree` previewed
clean as `7969f4f`, no conflict, and `git diff --quiet HEAD adafc5c` holds — the merged tree *is* the reviewed tip. `adafc5c`
and this ticket's tested merge `03e29c7` share the same two parents (`04747fe` + `3398030`) and differ only in this file, so
the reports above (`verify.json` sha `03e29c7`, `dirty: false`, base `3398030`) are direct claims about the merged code:
`git diff --exit-code 03e29c7 HEAD -- packages apps` exits 0.

Re-run at the merged tip where the *combination*, not the ticket, was the question: `pnpm --filter @hepi/session test` 57/57,
`pnpm --filter @hepi/ui test` 213/213, the two new seam files alone 5/5 and 15/15, `session`/`ui`/`app`/`web` typecheck exit 0,
and the browser seam itself — which `verify:changed --base` cannot reach — `node e2e/ux-subtree-control.mjs` exit 0, 68 checks,
0 FAIL (`merge-client-app-15/browser-subtree-merged.log`). The merge changes no gateway, protocol, client, server or
`apps/web/src` file (`git diff --exit-code 3398030 HEAD --` on those paths exits 0), so those suites were inherited rather
than re-run: server 493, gateway 438, web-unit 52 all pass at the tip. `pnpm verify:changed --base=3398030` at `20fcd17`:
`changed-typecheck` 0, `changed-test` 0, `web-unit` 0, `check-docs` 1 on the 12 baseline links (388 files).
`check-entrypoints` 0 (78 present, +1 new script, 0 newly missing).

Full evidence: `docs/verification.md`, section "Client app integration: subagent subtree control ticket 03"; logs under
`.dev/verify/merge-client-app-15/` in the integration worktree.

Ticket 04 is no longer blocked by this ticket: cut future work from `integration/client-app` at or after `20fcd17`.
