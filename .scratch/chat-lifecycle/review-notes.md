# Chat lifecycle final code review

Two axes over the effort's delivered source, reviewed at `0cf5a32652c8c123d182dc7f68e69f6d6fd90153` and tested at
`e7c7555bb6411d64b5b4a72c02ba1d5398326710`. Read against [docs/agents/verification.md](../../docs/agents/verification.md)
and [docs/agents/review-policy.md](../../docs/agents/review-policy.md).

Reviewed revision: `0cf5a32652c8c123d182dc7f68e69f6d6fd90153` — the integration tip, whose product tree is identical to
`cb8ae3b086f4792f684479b8dbb555dd9e4494f5`; the only commit after the merge, `0cf5a32`, is documentation
(`.scratch/chat-lifecycle/**`, `.scratch/README.md`). The verified revision is the merge commit
`e7c7555bb6411d64b5b4a72c02ba1d5398326710`, and every command and log path below belongs to that revision. This
document was written after the review; no claim in it is a re-run, and no check was repeated for it.

Baseline: the pre-ticket Web unit run at `7ae9aa303058f4c740df226315db1a2cb71bd07c` —
`.dev/verify/2026-10-13T00-13-07-558-web-unit/`.

## Standards axis — PASS, 0 material findings

No material Standards finding. What the axis checked and what it found:

- **Review trail and supersession.** The ticket keeps four passes and names which revision superseded which
  (`079f3fb` → `938f3de`/`e966011` → `f772a59`/`4a39361` → `bbee619`/`cb8ae3b`), with each earlier pass's runs
  kept rather than overwritten. Later sections are marked as branch runs so a reader cannot mistake a superseded run
  for the current claim.
- **Guides own the rules.** The behaviour guide [docs/chat.md](../../docs/chat.md) and the verification guide
  [docs/verification.md](../../docs/verification.md) state the delivered lifecycle, the notice rules, the ordering
  contract and the unobserved-run limit; the accepted ADR
  [docs/adr/0007-lifecycle-facts-one-projection.md](../../docs/adr/0007-lifecycle-facts-one-projection.md) is indexed
  from [docs/README.md](../../docs/README.md). `pnpm check:docs` covers the index.
- **Evidence shape.** Each verification section names the command, the revision, the exit code and a log path, as
  [docs/agents/verification.md](../../docs/agents/verification.md) requires; the Web unit suite is reported as failing
  with its baseline, never as green.
- **Deleted authorities stay deleted.** The absence-based tone, its sidebar boolean and the always-empty suppression
  filter are removed rather than layered, which is the change the ticket asked for; the two suppression seams that
  remain are filled from real backend facts.

Logs for this axis: `/tmp/standards-commits.txt` (the reviewed commit range),
`/tmp/standards-guides.diff` and `/tmp/standards-server-adapter.diff` (the reviewed documentation and
server/adapter diffs). Archived in `.dev/verify/chat-lifecycle-final/`.

## Spec axis — PASS, 0 material findings, no missing scope, no scope creep

Every acceptance item of [issues/06](issues/06-remove-the-old-path.md) is delivered by the reviewed source and no
delivered change falls outside the specification:

- The absence-based tone and its sidebar boolean are gone; a completion notice comes only from a live terminal fact.
- The two provably empty suppression filters are fixed at their source: the backend reports `lastRunEndedAt` and
  `subagentParentConversationId` on the catalogue row, the adapter forwards both, and `CompletionDelivery.isSuppressed`
  reads a set that is really filled.
- The unobserved run leaves the unread marker from the run's own end, and the limit is stated in the owning guide.
- The behaviour and verification guides and the accepted ADR 0007 are in the same change.
- No deployment, configuration or release change.

Verified at `e7c7555` (product tree identical to `cb8ae3b`), all with `git status --porcelain` empty:

- **Focused run, twelve suites** — `node --test` over `lib/completion-delivery.test.mjs`,
  `lib/lifecycle-projection.test.mjs`, `lib/run-marks.test.mjs`, `lib/agent-event-connection.test.mjs`,
  `lib/session-family.test.mjs`, `lib/session-tree.test.mjs`, `hooks/useAgentSession.lifecycle.test.mjs`,
  `hooks/useAgentSession.test.mjs`, `components/SessionSidebar.test.mjs`,
  `components/SessionSidebar.marker-effect.test.mjs`, `adapters/recall-and-session-list.test.mjs`,
  `adapters/session-fork.test.mjs` — exit 0, **237 pass, 0 fail** —
  `.dev/verify/focused-ticket06/focused-unit-e7c7555.log`.
- **Background driver** — `node apps/web/e2e/chat-lifecycle-background.mjs` against the production Next build, the real
  backend over a real SQLite store and a real local execution host, no paid model call and no sleep — exit 0,
  **57 checks, 0 failures** — `.dev/verify/focused-ticket06/chat-lifecycle-background-e7c7555.log`.
- **Foreground driver** — `node apps/web/e2e/chat-lifecycle-foreground.mjs`, same stack — exit 0, **28 checks, 0
  failures** — `.dev/verify/focused-ticket06/chat-lifecycle-foreground-e7c7555.log`.
- **`pnpm verify --profile=fast`** — exit 0, PASS/PASS, `dirty=false`, `sha=e7c7555bb6411d64b5b4a72c02ba1d5398326710`
  — `.dev/verify/2026-10-13T05-35-25-940-verify-fast/verify.json`.
- **`pnpm --filter @hepi/server test`** — exit 0, 232 pass, 0 fail —
  `.dev/verify/focused-ticket06/server-e7c7555.log`.
- **`pnpm test:web:unit`** — exit 1, 2224 tests, 2202 pass, **22 fail**, and the failing-name set is identical to the
  pre-ticket baseline (23 `not ok` lines: the 22 tests plus the file rollup that carries them; 0 new, 0 gone) —
  `.dev/verify/2026-10-13T05-37-13-792-web-unit/web-unit.json`. This suite is never claimed green.
- **`pnpm check:docs`** — exit 0, 153 Markdown files, 0 broken relative links, 0 guides missing.
- **`pnpm check:entrypoints`** — exit 0, 61 entry files present, 2 known-missing (pre-existing, recorded), 0 newly
  missing.
- **`node .scratch/chat-lifecycle/check-tickets.mjs`** — exit 0, 44 stories covered, 0 blocker problems, breakdown
  links ok.

The four findings the two review rounds raised are fixed in this source and asserted by the runs above:
review84's unobserved-run marker (`938f3de`), review85's queued-follow-up handover (`f772a59`), review84's marker
while a follow-up runs (`f772a59`), and review85's retained settled conversations (`bbee619`, `retained after empty
nominations: 7/7` at `c54d23b` and `0/7` at the tip). Their reproduction logs are archived under
`.dev/verify/chat-lifecycle-final/review-logs/`.

## Recorded limits — not findings, not fixed

- **Subagent suppression is proven at each seam and not in the browser.** The backend reports the creator edge, the
  adapter forwards it, and `CompletionDelivery.isSuppressed` consumes it — each asserted. No part of this deployment
  creates a task-owned conversation, so the browser has no subagent producer to observe. Revisit if a deployment ever
  creates subagent conversations for real; the browser matrix should then gain that scene.
- **The reported sustained multi-second stall is not reproduced at this revision** and is not claimed to be fixed.
- **`GET /api/agent/running` reports ids only.** Unchanged and sufficient: the marker no longer depends on the poll,
  and the session list is the catalogue read that carries the run's own end.
- **A run that finishes entirely between two polls is never acquired and sounds nothing.** This is the stated limit;
  the unread marker is its fallback.

## No redeployment

No deployment, configuration, container, host or release change was made, and no live host or paid provider was
contacted by this effort. Deployment remains unauthorized.
