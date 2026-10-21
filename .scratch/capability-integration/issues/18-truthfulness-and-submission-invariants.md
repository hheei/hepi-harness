# 18: Truthfulness and submission invariants across the new surfaces

**What to build:** A cross-cutting pass over everything blocks A–F touched: every control either performs its action or
is visibly unavailable before it is clicked, every failure is shown as the failure it is, and the submission invariants
of ADR 0006 are re-asserted as regression coverage.

**Blocked by:** 09: Project removal and folder unlink in the UI; 11: Worktree picker in the browser; 13: Terminal in the
browser, with reconnect and the existing close behaviour; 15: Extensions panel: enable and disable installed
extensions; 17: MCP surface in the browser

**Status:** resolved — merged into `integration/ux-wave3` (code and tests `7c5fd6d`, merged with the terminal
binding-cancel fix `617c2e7` at `fc55a72`; integrated at `20aebae`).

**Demo path:** Walk the newly wired controls and the Settings surfaces that stay unsupported, and see each one either
work or be visibly unavailable; then re-run the submission invariants against a dropped connection.

**Stories:** 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114

**Seam:** browser → existing Web adapter → durable backend, plus the controlled fixture for the lifecycle cases. No
paid model call, no sleeps.

- [x] Every control touched by blocks A–F either performs its action or is visibly unavailable before it is clicked,
      asserted by inspection of the rendered surface rather than by clicking it.
- [x] A backend-answered failure is shown as that failure with its reason; a transport failure is shown as a transport
      failure; neither is converted into an empty success.
- [x] The ADR 0006 invariants hold: the browser generates the request identity, admission deduplicates by it, a pending
      turn is shown until committed or resolved, settlement arrives as a frame, an unknown outcome is looked up rather
      than resent, and only a readable rejection restores the draft.
- [x] Catalogue fields the runtime cannot supply are absent rather than fabricated, and timestamps it cannot supply are
      empty rather than placeholders.
- [x] The models configuration that already works answers exactly as before and its existing suite stays green.
- [x] A Settings surface outside blocks A–F is visibly unavailable and otherwise unchanged.

**Context:** [Spec](../spec.md) decisions 52–59; stories 103–114;
[ADR 0006](../../../docs/adr/0006-durable-submission-lifecycle.md). This is the closing ticket of the breakdown; it
adds no new capability.

## What was built

**One hidden refusal was found and fixed at its owner.** The sidebar's file-manager button reads an availability answer
of `{ supported, reason, platform }` and disables itself when `supported` is false. The Web adapter answered
`{ available: false }` — a field that surface never reads — so the button rendered enabled, looked usable, and only
refused *after* it was clicked (a `501` from the same route). `apps/web/adapters/durable-api.ts` now answers
`{ supported: false, reason: "unsupported-platform", platform: process.platform }`, which is the honest state: opening
a folder in a desktop file manager is a capability of the machine the browser runs on, and this Web origin is a remote
page, not that machine. The control is now disabled and names the reason before it is clicked, and the terminal button
beside it stays available. `apps/web/adapters/durable-api.test.mjs` asserts that contract.

**Two browser drivers carry the cross-cutting obligations**, both on the real deployment shape — the production Next
build, the real backend process over a real SQLite store and a real local execution host — with no paid model call:

- `apps/web/e2e/ux-extensions-selection.mjs` closes the gap ticket 15's driver left by replacing its network
  boundary: the panel is driven against the real backend and store, and the assertions read the backend's own answers
  (the resolved default, each conversation's materialized selection). It proves the default survives a backend restart
  against the same database, that a conversation created afterwards selects the new default, that the conversation
  created before the change keeps what it was created with, and that a per-conversation override is that
  conversation's own state which leaves the default alone and survives a reload.
- `apps/web/e2e/ux-truthfulness.mjs` asserts, in order: a control this deployment cannot serve is disabled and says
  why while the control beside it stays available (inspected, not clicked); a backend-answered failure is shown with
  the backend's own reason and leaves the row as it was; a transport failure is shown as a transport failure — the
  extensions panel reports that it could not read the installed set instead of reporting an empty one, and reads it
  again once the backend is back; the new surfaces offer only what they can do (no install, remove, update or check in
  the extensions panel; no MCP editor where the Web host serves no MCP service); a Settings surface outside the six
  blocks (Sub-agents) states the missing capability in plain language, lists nothing it never read, and leaves the rest
  of Settings working; no catalogue row carries a timestamp or a name the runtime cannot supply, and no rendered row
  shows a placeholder time; and only a readable rejection restores the draft — the reason is visible, the refused turn
  never reaches the transcript, and the text comes back to the composer.

**The ADR 0006 invariants are covered where each one lives**, and the one without browser coverage was added here:
`apps/server/test/durable-submissions.test.ts` (projections, terminal frames, the by-id lookup),
`apps/server/test/server.test.ts` (admission deduplicates by the request id across independent clients),
`apps/web/lib/submission-reconciliation.test.mjs` (the pending set's rules), `apps/web/e2e/ux-submission-recovery.mjs`
(a dropped answer is looked up rather than resent, and a recalled turn settles from its terminal frame), and this
ticket's own driver for the readable-rejection rule.

Also: `apps/web/package.json` gains `test:extensions-selection` and `test:truthfulness`, and
[docs/verification.md](../../../docs/verification.md) documents both drivers and where the submission rules are
covered.

## Verification

Merged with the integration branch before these runs: `git merge-base --is-ancestor integration/ux-wave3 HEAD` holds
at `4a81ad5`, so the measured revision is that branch plus this ticket. The terminal binding-cancel fix the merger
had under review (`617c2e7`) is merged in too, because the backend those drivers start carries it; every check below
ran at the branch tip `fc55a72`.

| Check | Revision | Result | Log |
| --- | --- | --- | --- |
| `node apps/web/e2e/ux-extensions-selection.mjs` (real Chromium, real backend, real store, real gateway) | `fc55a72` | exit 0, 17 checks pass | `/tmp/hepi-capability-18/.dev/verify/ticket18/extensions-selection.log` |
| `node apps/web/e2e/ux-truthfulness.mjs` (real Chromium, real backend, real store) | `fc55a72` | exit 0, 29 checks pass | `/tmp/hepi-capability-18/.dev/verify/ticket18/truthfulness.log` |
| `node scripts/verify.mjs --profile=fast` (typecheck + workspace tests) | `fc55a72` | exit 0, PASS/PASS | `/tmp/hepi-capability-18/.dev/verify/2026-10-11T22-50-44-428-verify-fast/verify.json` |
| `node --test apps/server/test/durable-submissions.test.ts apps/server/test/server.test.ts apps/server/test/models-config.test.ts` | `fc55a72` | exit 0, 35/35 pass | `/tmp/hepi-capability-18/.dev/verify/ticket18/server-adr.log` |
| `node --test apps/web/lib/submission-reconciliation.test.mjs apps/web/adapters/durable-api.test.mjs` | `fc55a72` | exit 0, 26/26 pass | `/tmp/hepi-capability-18/.dev/verify/ticket18/web-adr.log` |
| `node scripts/compare-tests.mjs --base=4a81ad5 --suite=web-unit` | base `4a81ad5` → tip `fc55a72` | identical failure set: 23 pre-existing names, 0 new, 0 gone | `/tmp/hepi-capability-18/.dev/verify/2026-10-11T22-52-22-152-compare-tests/tip/web-unit.log` |
| `node scripts/check-docs.mjs` / `check-tickets.mjs` / `check-entrypoints.mjs` | `fc55a72` | exit 0: 131 Markdown files with 0 broken links; 0 blocker problems across 18 tickets; 59 entry files present, the 2 known-missing unchanged | — |

The models-configuration suite is green on its own and inside the second `verify --profile=fast` run. The first run of
that profile at `7c5fd6d` failed one case in `apps/server/test/models-config.test.ts`
("environment mode keeps credentials in memory…", `configured === false`) under a fully loaded machine — the
intermittent failure already recorded as finding 24 in [review notes](../review-notes.md) and reproduced at the base
revision before this ticket. No source in this ticket touches that path.

## Review notes

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 1 | Settings › Sub-agents — a surface outside blocks A–F — states its missing capability in plain language ("This capability is not connected to the durable server yet") and lists no profile it never read, but its editor controls stay enabled, so a click still answers that same refusal rather than being disabled. | Every deployment today has no sub-agent routes behind that section, so the state is the normal one; the reason is already on screen before anything is clicked, a click loses nothing and reports the same reason, and the rest of Settings is unaffected. | `record` | A user reports clicking a Sub-agents control that cannot work, or sub-agent configuration enters scope. |
| 2 | The file-manager control is permanently unavailable in this deployment: no Web origin here can raise a window on the user's machine, so the button is disabled with "Not supported on this platform" rather than offering the action. | The upstream surface could open a folder on the Web host; hepi's Web origin is not the user's machine, so the honest state is unavailable. The previous `{ available: false }` answer made it look usable instead. | `record` | A Web host service that can open a folder for the user's own machine is added. |
| 3 | `apps/server/test/models-config.test.ts` flaked once inside a loaded `verify --profile=fast` run (recorded as finding 24) and passed focused and on the re-run. | The flake makes a profile run report a false failure for whichever ticket is being verified, not a regression; it reproduces at the base revision too. | `record` | Verification on a quiet host still fails this file, or CI reports it as a regression. |
