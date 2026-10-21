# Chat lifecycle ticket breakdown

Status: **resolved.** Six tickets, numbered blockers-first. All six are resolved and merged into
`integration/chat-lifecycle`; ticket 06 landed as `e7c7555`.

Approval: the product owner approved background delivery contract A on 2026-10-13, authorized this breakdown, and
invoked `implement-spec`, which authorizes implementing the tickets and merging them into
`integration/chat-lifecycle`. Deployment is not authorized. The specification is [spec.md](spec.md).

Sources: [design.md](design.md) (`c4d7154`), [design-validation.md](design-validation.md) (`28e18d9`),
[background-delivery.md](background-delivery.md) and [background-coverage.md](background-coverage.md) (`6bf4cdf`),
[diagnosis.md](diagnosis.md) and [red-loop.md](red-loop.md) (`e16b1b1`).

## Dispatch order

1. **Resolved:** 01, 02 — the two independent roots, the pure projection and the wire facts it consumes, merged into
   `integration/chat-lifecycle` as `0787784`.
2. **Resolved:** 03 (needs 01, 02) — joined them through the adapter, merged as `7226473`.
3. **Resolved:** 04 (needs 03) — switched the conversation surface to the projection and deleted the replaced
   authorities, merged as `e196ae0` after a review round fixed four defects.
4. **Resolved:** 05 (needs 04) — delivered background completion from live facts, merged as `7ae9aa3` after a
   review round fixed five ownership defects.
5. **Resolved:** 06 (needs 05) — removed the old absence-based tone, fixed the empty suppression filters at their
   source, and wrote the owning guides and the accepted ADR, merged as `e7c7555` after four review rounds fixed four
   findings.

Numbers give dependency order, not a serial chain. A ticket is ready when every ticket on its `Blocked by:` line is
resolved. This is not a wide refactor: no ticket renames a shared symbol across the codebase, so no expand–contract
sequence is needed.

## The dependency graph

`@txt
01 ──┐
     ├──> 03 ──> 04 ──> 05 ──> 06
02 ──┘
`@

| Ticket | Blocked by | Blocks |
| --- | --- | --- |
| 01 One pure lifecycle projection | — | 03 |
| 02 The lifecycle facts the wire is missing | — | 03 |
| 03 Transport facts and the acquisition fence | 01, 02 | 04 |
| 04 Switch the conversation surface to the projection | 03 | 05 |
| 05 Background completion from live facts | 04 | 06 |
| 06 Remove the old background tone and finish the migration | 05 | — |

## Tickets

- [01 One pure lifecycle projection](issues/01-lifecycle-projection.md) — stories 1–21
- [02 The lifecycle facts the wire is missing](issues/02-wire-lifecycle-facts.md) — stories 7–10, 37–39
- [03 Transport facts and the acquisition fence](issues/03-adapter-acquisition-plumbing.md) — stories 4–10, 37–39
- [04 Switch the conversation surface to the projection](issues/04-switch-the-hook.md) — stories 1–6, 40
- [05 Background completion from live facts](issues/05-background-delivery.md) — stories 17, 18, 22–30, 34, 36
- [06 Remove the old background tone and finish the migration](issues/06-remove-the-old-path.md) — stories 29, 31–36, 41–44

## Story coverage

Stories 1–44 are all covered: notice truthfulness and readiness in 01 and 04; ordering in 02 and 03; the overlay,
interest and notice rules in 01 and 04; abort, failure and recall in 01, 04 and 05; background delivery in 05; coverage
and limits in 05 and 06; scope discipline in 05 and 06; the wire facts in 02 and 03; migration and documentation in 04
and 06. `check-tickets.mjs` reports any story the tickets stop covering.

## Resolution

| Ticket | Commit | Merged as | Verification |
| --- | --- | --- | --- |
| 01 One pure lifecycle projection | `77e115c` | `0787784` | [issues/01](issues/01-lifecycle-projection.md#verification) |
| 02 The lifecycle facts the wire is missing | `f10e89f` | `0787784` | [issues/02](issues/02-wire-lifecycle-facts.md#verification) |
| 03 Transport facts and the acquisition fence | `6471038` | `7226473` | [issues/03](issues/03-adapter-acquisition-plumbing.md#verification) |
| 04 Switch the conversation surface to the projection | `66bc00c` | `e196ae0` | [issues/04](issues/04-switch-the-hook.md#verification) |
| 05 Background completion from live facts | `93bc802` | `7ae9aa3` | [issues/05](issues/05-background-delivery.md#verification-at-the-merged-tip-7ae9aa3) |
| 06 Remove the old background tone and finish the migration | `cb8ae3b` | `e7c7555` | [issues/06](issues/06-remove-the-old-path.md#verification-at-the-merged-tip-e7c7555) |

The merge commit `7226473` has parents `0787784` and `6471038`. On that tip `pnpm verify --profile=fast` passed with
`dirty=false` (`.dev/verify/2026-10-12T18-02-15-210-verify-fast/` in the integration worktree), beside `pnpm check:docs`
and `pnpm check:entrypoints`. The spec/ticket import merged on top of it, and `pnpm verify --profile=fast` passed at
that tip too with `dirty=false`.

The merge commit `e196ae0` has parents `bb1eb09` and `66bc00c`. On that tip `pnpm verify --profile=fast` passed with
`dirty=false` (`.dev/verify/2026-10-12T20-12-51-943-verify-fast/`), beside `pnpm check:docs`, `pnpm check:entrypoints`
and the ticket checker, and the focused hook/projection/adapter run passed 119 with 0 failures
(`.dev/verify/focused-ticket04/focused-e196ae0.log`).

The merge commit `7ae9aa3` has parents `2b14716` and `93bc802`. Review 82 reproduced five ownership defects at
`36e4dac` (0 pass / 5 fail); all five are fixed at `93bc802` and pass at the merged tip. On that tip
`pnpm verify --profile=fast` passed with `dirty=false`
(`.dev/verify/2026-10-13T00-11-55-109-verify-fast/`), the eight-suite focused run passed 133 with 0 failures
(`.dev/verify/focused-ticket05/focused-7ae9aa3.log`), the five reproductions passed 5/5
(`.dev/verify/focused-ticket05/review-82-repro-7ae9aa3.log`), `pnpm test:web:unit` kept its recorded 22-failure baseline
with an identical failing-name set, and `pnpm check:docs`, `pnpm check:entrypoints` and the ticket checker passed.
The merge commit `e7c7555` has parents `284638e` and `cb8ae3b`, and its tree is identical to `cb8ae3b`. Ticket 06 was
implemented on `impl/chat-lifecycle-06`, and four review rounds fixed four findings on it before the merge: review84's
unobserved-run marker (`938f3de`), review85's queued-follow-up handover and review84's marker while a follow-up runs
(`f772a59`, reviewed as `4a39361`), and review85's retained settled conversations (`bbee619`, `retained after empty
nominations: 7/7` at `c54d23b` and `0/7` at the tip). The revisions `079f3fb`, `938f3de`, `e966011`, `f772a59` and
`bbee619` are each superseded by the next and kept in the ticket for the review trail. At the merged tip
`pnpm verify --profile=fast` passed with `dirty=false`
(`.dev/verify/2026-10-13T05-35-25-940-verify-fast/verify.json`), the twelve-suite focused run passed 237 with 0
failures (`.dev/verify/focused-ticket06/focused-unit-e7c7555.log`), the background and foreground browser drivers
passed 57 and 28 checks (`.dev/verify/focused-ticket06/chat-lifecycle-background-e7c7555.log` and
`.dev/verify/focused-ticket06/chat-lifecycle-foreground-e7c7555.log`), `pnpm --filter @hepi/server test` passed 232,
`pnpm test:web:unit` kept its recorded 22-failure baseline with an identical failing-name set, and `pnpm check:docs`,
`pnpm check:entrypoints` and the ticket checker passed. The full evidence is in
[issues/06](issues/06-remove-the-old-path.md#verification-at-the-merged-tip-e7c7555).

## Not in this breakdown

Deployment, configuration, container, host and release changes; the reported sustained stall, which is not reproduced
at this revision; universal background catch-up; a new endpoint, a native recalled primitive, a generic harness, a
scheduler or a persistent epoch. Merging into `integration/chat-lifecycle` is authorized by `implement-spec`; no
ticket authorizes a live host change or a deployment.
