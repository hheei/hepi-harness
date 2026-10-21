# 03 - Acceptance

Type: acceptance
Status: **delivered** — the three journeys this ticket was blocked on now run over the deployed shape at `0a3d065`, in
`apps/web/e2e/ux-references-acceptance.mjs`: the real ingress→Backend create/reload/follow, the inherited-fork-entry
follow, and a real transient read failure with the retry that lands. See
[what was run](#what-was-run-and-what-was-not) for which rows that driver reaches, which stay at the seams that prove
them, and why.
Blocked by: 02 (delivered, integrated on this line at `6191f82`),
[history 05 - system acceptance](../../history-navigation-research/issues/05-system-acceptance.md) (**met** — its source
and browser matrix are on this line, cherry-picked at `d1e3be5`…`fc15cc2`, and the ticket is delivered and accepted at
`a0caf5d`)
Parent spec: [Cross-conversation references](../spec.md)

## Outcome

The reference capability is demonstrated end to end against the current Web/App client ingress to Backend, with recorded evidence and no unstated scope drift.

## Scope

Run the user journeys for explicit creation, reload, follow, and unavailable targets/entries in a real client. Confirm entry follow uses the bounded history coordinator rather than a sequential walk. Confirm scope guard: conversation-only default, explicit user creation only, no automatic dispatch/fork references, no model tool, no new schema, no copied history.

Record revision, dirty state, commands, exit codes and logs for the checks that run. Record remaining limits rather than overstating guarantees for tombstoned targets or transient read failures.

## Acceptance

- [x] Create a conversation-only reference and an entry reference; both persist across reload.
- [x] Follow each to the exact target; the entry follow issues one bounded target request with no intervening-history loading.
- [x] Deleted target, tombstoned target, missing entry, wrong-scope entry and transient read failure each produce their named outcome with an actionable next step.
- [x] Creation refuses an entry outside the target's visible committed fork-aware history and stores nothing.
- [x] Inherited fork entry resolves in the selected conversation scope, and existing fork/tombstone behaviour is unchanged.
- [x] No automatic dispatch/fork reference, model tool, new schema or copied history exists in the delivered diff.
- [x] The owning current guide and `docs/migration-status.md` reflect delivered behaviour, and the spec closes only when this matrix passes.
- [x] Verification records revision, dirty state, commands, exit codes and logs.

Two rows are ticked at the seams that prove them rather than in the new browser journey, because the surface cannot
reach them by construction — see [the two rows a browser cannot reach](#the-two-rows-a-browser-cannot-reach).

## What was run and what was not

The driver is `apps/web/e2e/ux-references-acceptance.mjs`, and the system it runs against is `apps/web/e2e/acceptance-stack.mjs`:
`apps/web/dist` served by the client ingress on the same origin as `/api`, the ingress's own HttpOnly cookie, the real
Backend (`apps/server/src/main.ts`) over SQLite files the run created, a real execution gateway, and one controlled
model endpoint. **No route is intercepted anywhere in this driver**, which is the difference from ticket 02's scene: a
creation here is a real `POST /api/conversations/:id/references` answered by `unresolvedReference`'s own membership
check against a real committed history, and a follow is the real `useHistoryNavigation` coordinator asking the real
navigation route.

What it establishes, one section per journey:

| journey | what the run observed |
| --- | --- |
| the surface is deployed | the references surface renders inside the Full history panel of the production page, and a conversation with no links says so |
| creation | one conversation-only link and one entry link created through the picker, one creation request each, and the Backend's own list holding exactly `target` + `entryId` with no copied content |
| reload | a full page reload lists both links again and issues no creation |
| conversation follow | the target conversation opens, with **zero** `/navigation/around` reads |
| entry follow | the named entry comes on screen, from **exactly one** bounded target read whose coordinate names that conversation and that entry (`{"v":1,"c":"16","s":"16|-","e":"40"}`), with **zero** outline continuation pages and no named failure |
| inherited-fork-entry follow | a link into the fork pinned to an entry the fork **inherited** (outside its own active window) is accepted, followed with **exactly one** target read addressed in the **fork's** coordinate (`{"v":1,"c":"162","s":"162|-","e":"46"}`), and the inherited entry lands; the fork still starts with no references of its own |
| refused creation | the picker's target is removed while the picker is open; submitting shows `target-unavailable` and "Nothing was stored", and the owner's list gained no record naming that target |
| tombstoned target | a stored link whose target the user then removed is listed as `target-unavailable`, with a readable sentence and **no** offers; the record itself is kept rather than cascaded |
| real transient read failure | the Backend process is stopped (`SIGTERM`, confirmed down by its own unanswering read); the panel's read is named as a failed read rather than an empty list; a retry while it is still down repeats the named failure; after `restartBackend()` the retry lists the stored links and the failure state is gone; the three stored links are unchanged |
| follow after the outage | the same entry follow still lands, for exactly one target read |

The journeys are deliberately ordinary: no probe of an authorization, scope or capability boundary is made, and no
external message or real user data is involved. Every conversation, entry, port, SQLite file and process belongs to the
run and is removed with it unless `--keep` is passed.

### The two rows a browser cannot reach

`entry-missing` and `entry-out-of-scope` are **not reachable through the surface by construction**: the picker offers the
chosen target's own paged outline anchors, and the owner validates exactly those, so an entry link created through the
UI cannot name an entry outside the target's visible committed fork-aware history. Manufacturing one would mean either
intercepting the write (which is the stubbed-boundary evidence this ticket exists to move past) or driving the API by
hand around the surface (which measures nothing the surface does). They are therefore ticked where they are proven:

- **refusal and named outcome at the owner and route** — `apps/server/test/conversation-references.test.ts` (ticket 01,
  five cases at the core seam and the HTTP route) and the relay assertions in `packages/gateway/test/ingress-control.test.ts`;
- **their rendering and offers at the client seam** — ticket 02's `node apps/web/e2e/ux-references.mjs`, which mounts the
  production panel with only the network boundary replaced and renders every one of the six named states.

The creation-refusal row is proven end to end in the new driver anyway, through the one refusal the ordinary lifecycle
does produce: the target is removed while the picker is open.

## Evidence, tied to its revision

Taken on `0a3d065eb259f9ec19f9af4c6e8f631b34f90cbb` with a dirty tree carrying only this change
(`apps/web/e2e/ux-references-acceptance.mjs`, `apps/web/package.json`, and the documentation edits below), then **re-taken
on the integration line** after this work was cherry-picked there — see
[the integrated run](#the-integrated-run) below. Logs are in `.dev/verify/xref03/` and
`.dev/verify/xref03-integrated/` (untracked, like every run directory here).

| what it establishes | command | revision | exit | result |
| --- | --- | --- | --- | --- |
| **The three journeys this ticket was blocked on, over the real ingress and Backend** | `node apps/web/e2e/ux-references-acceptance.mjs` | `0a3d065` (dirty) | 0 | `CROSS-SESSION REFERENCES ACCEPTANCE PASSED`, **45 ok / 0 FAIL**, run twice with the same result (`.dev/verify/xref03/ux-references-acceptance.log`, `…-rerun.log`) |
| Ticket 02's client-seam scene, unchanged, re-run beside this one | `node apps/web/e2e/ux-references.mjs` | `0a3d065` (dirty) | 0 | `PASS`, **43 checks / 0 FAIL** (`.dev/verify/xref03/ux-references.log`) |
| The Web build the browser scenes were served from | `pnpm --filter @hepi/web build` | `0a3d065` (dirty) | 0 | `✓ built in 653ms`, third-party notice emitted (`.dev/verify/xref03/web-build.log`) |
| Selector over the changed package and its dependents | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=0a3d065` | `0a3d065` (dirty) | 0 | `changed-typecheck` 0; `web-unit` 0 (**14/14**); `check-docs` 0 (**0 broken relative links**, 0 guides missing from the index); selection `@hepi/web`, full test mode (`.dev/verify/2026-10-20T10-39-28-710-verify-changed/verify.json`) |
| The same selector at the committed revision, clean tree | `PATH="$PATH:/usr/sbin:/sbin" pnpm verify:changed --base=0a3d065` | `1b8138f` (`dirty: false`) | 0 | same three steps pass — the record above changes only Markdown (`.dev/verify/2026-10-20T10-44-43-572-verify-changed/verify.json`) |
| Dependency install for this worktree | `pnpm install --offline --frozen-lockfile` | `0a3d065` | 0 | 571 reused, 0 downloaded (`.dev/verify/xref03/install.log`) |
| **The same journey on the integration line, after the UI request assembly under the real stack changed** | `pnpm --filter @hepi/web build` then `node apps/web/e2e/ux-references-acceptance.mjs` | `0acf499` (`dirty: false`) | 0 · 0 | `✓ built in 647ms` (`/assets/index-DQC5oIlS.js`, 3346286 B); `CROSS-SESSION REFERENCES ACCEPTANCE PASSED`, **45 ok / 0 FAIL** — `.dev/verify/xref03-integrated/web-build.log`, `…/ux-references-acceptance.log` |

### The integrated run

`1b8138f`/`b483df3` were cherry-picked onto the integration line as `55f6f55`/`0acf499`. The client's request assembly
under the real stack changed between `0a3d065` and that line (23–25 integrated at `2a53eef`), and the Web build the rows
above were served from predated it, so the journey was re-run rather than inherited: this worktree was rebased onto
`0acf499` (the two already-applied picks skipped, nothing force-pushed), `apps/web/dist` was rebuilt **there**, and the
driver ran against that build with a clean tree. It passed with the same **45 checks and 0 failures**, and its provenance
line names the clean revision it ran at (`source 0acf499bd5d168e003cd32371f7967acf2c1b6dc (clean)`, `web script
/assets/index-DQC5oIlS.js`). No whole-suite repeat was run for it: the selector rows above stand for the source they
measure, which the cherry-picks reproduce byte-for-byte.

What the driver counts, stated as counted: the "no outline continuation page" assertion is a count of
`GET /api/conversations/:id/navigation?cursor=…` requests observed by the ingress during the follow, and nothing wider.
It is not a proof about entry pagination in general; the no-intermediate-walk property is history 05's accepted matrix,
which this ticket reuses rather than re-derives.

Reused rather than re-run, because the source they measure is unchanged on this line: ticket 01's Backend contract
(`node --test --test-reporter=tap test/conversation-references.test.ts` in `apps/server`, 5 pass / 0 fail at `5a963cd`),
the `@hepi/ui` suite (354 pass / 0 fail at `42dcbc3`), the surface's decision module
(`node --test packages/ui/src/lib/references.test.mjs`, 10 pass / 0 fail at `42dcbc3`), and history 05's 82-check
system matrix at `a0caf5d`.

**What this run did not do.** No push, deployment, restart of a deployed service or `remote-host` build. No product code
was changed: the driver found no material failure in normal use, so there was no cause to fix. The only limits the
journeys surfaced are the two documented below and the two unreachable rows above.

## What still has to run before this closes

Nothing. The three journeys this ticket was blocked on — a reference created through the client ingress against a real
Backend, the inherited-fork-entry follow in the fork's own scope, and a real transient read failure with the retry that
lands — ran at `0a3d065` and passed. The heading is kept because
[the integration record](../../../docs/verification.md#cross-conversation-references-how-0203-arrived-on-the-integration-line-2026-10-20)
points at it, and because the honest answer belongs where that record's reader arrives: the two rows a browser cannot
reach are proven at their own seams, not deferred.

## Remaining limits

- **`stale` is not produced by this stack.** The Backend reports `target-missing`, `target-unavailable`, `entry-missing`
  and `entry-out-of-scope`; `stale` is the follow-time answer when a coordinate's history re-baselined under a page, which
  is the navigation contract's own `stale-snapshot`. It is proven there (history 05's acceptance) and rendered from the
  client seam (ticket 02), not produced here.
- **`target-unavailable` is a statement about the stored target, not a live subscription.** A target removed after a
  panel read is reported on the next read or reload; the surface does not watch for the tombstone. The journey above
  reloads, which is the reader's own action.
- **The picker lists one bounded outline page per target.** A very long target offers the anchors that page states;
  choosing one from a later page is not a UI capability yet.
- **`entry-missing` and `entry-out-of-scope` are unreachable from the picker**, as described above; their evidence is the
  owner/route seam and the client rendering seam.

## Notes

The history-05 gate this ticket carried is met at `a0caf5d`, and this ticket adds no second implementation and no
deployment: it is the acceptance the spec was waiting on. The spec's own status is updated in the same change.
