# UI capability integration ticket breakdown

Status: **complete.** 18 tickets, numbered blockers-first, all implemented, verified and merged. Tickets 01, 02, 03,
04, 07, 10, 12, 14, 16 and 17 are on `integration/ux-follow-up`; 05, 06, 08, 09, 11, 13, 15 and 18 are on
`integration/ux-wave3`, the parent's fast-forward source. Each ticket file records its own status and evidence, and
this breakdown stays the plan.

Approval: the product owner confirmed the testing seams exactly as proposed ("browser E2E through Web adapter/backend;
real local gateway + isolated localhost SSH public contracts; controlled fake model/MCP fixtures, no paid model calls,
no sleeps, event/state waits") on 2026-10-11 and authorized this breakdown.

Source: [spec.md](spec.md) (status `ready-for-agent`), [design-notes.md](design-notes.md), and the route manifest in
apps/web/vendor/pi-web/app/README.md (`../../apps/web/vendor/pi-web/app/README.md`).

## Dispatch order

1. **Frontier, start now (no blockers):** 01, 02, 04, 07, 10, 12, 14, 16. Eight independent root tickets across all six
   blocks. Nothing in them depends on another ticket.
2. **Second wave:** 03 (needs 01), 05 (needs 03), 06 (needs 02), 08 (needs 07), 11 (needs 10), 13 (needs 12),
   15 (needs 14), 17 (needs 16).
3. **Third wave:** 09 (needs 07, 08).
4. **Closing:** 18 (needs 09, 11, 13, 15, 17). It adds no capability; it is the truthfulness and lifecycle pass over
   everything the other tickets touched.

Numbers give dependency order, not a serial chain. A ticket is ready when every ticket on its `Blocked by:` line is
resolved. Every ticket is one complete user-visible path — the two halves of a block that would otherwise be a
horizontal schema/API layer and a UI layer are split only where the first half is independently demonstrable at a
non-browser seam (the execution host, the Web host service, the backend's own surface).

Nothing here is a wide refactor: no ticket renames a shared symbol across the codebase, so no expand–contract
sequence is needed.

## The dependency graph

```txt
01 ──> 03 ──> 05
02 ──> 06
04
07 ──> 08 ──> 09 ─┐
10 ──> 11 ─────────┤
12 ──> 13 ─────────┼──> 18
14 ──> 15 ─────────┤
16 ──> 17 ─────────┘
```

Edges, in words:

| Ticket | Blocked by | Blocks |
| --- | --- | --- |
| 01 Shared sidebar state | — | 03 |
| 02 Session rename and catalogue title | — | 06 |
| 03 Session delete | 01 | 05 |
| 04 Session fork | — | — |
| 05 Session search | 03 | — |
| 06 Session auto-name | 02 | — |
| 07 Retained bindings survive removal | — | 08, 09 |
| 08 Unlink a folder, default replacement | 07 | 09 |
| 09 Project removal and unlink in the UI | 07, 08 | 18 |
| 10 Worktrees on the execution host | — | 11 |
| 11 Worktree picker in the browser | 10 | 18 |
| 12 Interactive terminal on the execution host | — | 13 |
| 13 Terminal in the browser | 12 | 18 |
| 14 Extension inventory and selection state | — | 15 |
| 15 Extensions panel: enable and disable | 14 | 18 |
| 16 MCP on the Web host | — | 17 |
| 17 MCP surface in the browser | 16 | 18 |
| 18 Truthfulness and submission invariants | 09, 11, 13, 15, 17 | — |

Edges that are real and not merely ordered: 03→01 (the delete must clear the shared document's entries, so the document
must exist first); 05→03 (a deleted session must never appear in results, so search is graded after delete exists);
06→02 (auto-name writes the same title state rename owns); 08→07 (the unlink path and the Project-removal path write the
same retained binding); 09→07,08 (the UI half of an operation that must already be demonstrable at the backend seam);
11→10, 13→12, 15→14, 17→16 (each browser half needs its non-browser half); 18→09,11,13,15,17 (the closing pass grades the
surfaces those tickets create).

Edges deliberately **not** present: 04 (fork) and 06 (auto-name) have no blocker, because fork is the runtime's own and
auto-name is an independent request path. No ticket blocks another merely because it shares a block letter.

## Published tickets

### 01: Shared sidebar state

**Ticket:** [01-sidebar-shared-ui-state.md](issues/01-sidebar-shared-ui-state.md) — **Blocked by:** None

**Delivers:** Pins, archive, project order and unread/running markers as one hepi session-scoped document per backend;
two windows agree; refused changes leave the sidebar unchanged.

**Stories:** 1–20 · **Seam:** browser → Web adapter → durable backend; shared rules also carry pure-rule unit coverage.

### 02: Session rename and the catalogue title

**Ticket:** [02-session-rename-and-catalogue-title.md](issues/02-session-rename-and-catalogue-title.md) — **Blocked by:** None

**Delivers:** A hepi conversation-scoped title the user sets, surviving reload and restart, listed by the catalogue in
the same read that lists sessions.

**Stories:** 21, 22, 23 · **Seam:** browser → Web adapter → durable backend.

### 03: Session delete

**Ticket:** [03-session-delete-tombstone.md](issues/03-session-delete-tombstone.md) — **Blocked by:** 01

**Delivers:** Delete removes a session from the catalogue and search as a hepi tombstone written through the durable
document path; records are retained, never deleted directly; pins and archive entries are cleared with it.

**Stories:** 27–32 · **Seam:** browser → Web adapter → durable backend.

### 04: Session fork

**Ticket:** [04-session-fork.md](issues/04-session-fork.md) — **Blocked by:** None

**Delivers:** A fork at a chosen point through the runtime's own fork, answering the new identity and catalogue row,
refusing a missing, unsaved, empty or subagent source, and leaving the source's live run undisturbed.

**Stories:** 33–37 · **Seam:** browser → Web adapter → durable backend.

### 05: Session search over full conversation bodies

**Ticket:** [05-session-search.md](issues/05-session-search.md) — **Blocked by:** 03

**Delivers:** Bounded full-body search over real history with the upstream matcher, limits and response shape, no
index, a truncation report and a readable over-long-query refusal.

**Stories:** 38–45 · **Seam:** browser → Web adapter → durable backend.

### 06: Session auto-name on request

**Ticket:** [06-session-auto-name.md](issues/06-session-auto-name.md) — **Blocked by:** 02

**Delivers:** A name generated only on explicit request from the conversation's own transcript, never overwriting a
typed name implicitly.

**Stories:** 24–26 · **Seam:** browser → Web adapter → durable backend, with the controlled fake model.

### 07: Retained workspace bindings survive Project and folder removal

**Ticket:** [07-retained-bindings-survive-removal.md](issues/07-retained-bindings-survive-removal.md) — **Blocked by:** None

**Delivers:** Removal of a Project removes metadata only; a bound conversation keeps its execution environment through a
retained binding written in the same transaction; the retained id never becomes a target and is never reused.

**Stories:** 46–51, 55–57 · **Seam:** browser → Web adapter → durable backend with the real store.

### 08: Unlink a folder and keep a Project's default valid

**Ticket:** [08-unlink-folder-and-default-replacement.md](issues/08-unlink-folder-and-default-replacement.md) — **Blocked by:** 07

**Delivers:** A per-folder unlink; removing the default folder requires naming its replacement in the same call;
removing the last folder removes the Project; every unlink writes the same retained binding.

**Stories:** 52–54, 58 · **Seam:** browser → Web adapter → durable backend.

### 09: Project removal and folder unlink in the UI

**Ticket:** [09-project-removal-and-unlink-ui.md](issues/09-project-removal-and-unlink-ui.md) — **Blocked by:** 07, 08

**Delivers:** The Project menu's removal, the per-folder unlink and the replacement prompt, with copy stating that only
metadata is removed.

**Stories:** 46–54 · **Seam:** browser → Web adapter → durable backend.

### 10: Worktree list, create and remove on the execution host

**Ticket:** [10-worktrees-on-the-execution-host.md](issues/10-worktrees-on-the-execution-host.md) — **Blocked by:** None

**Delivers:** Real host worktree operations with the upstream semantics: list, create (existing root and a branch),
remove, a distinct dirty refusal, an explicit force, a fallback for a vanished worktree, a named limit where a host
cannot serve it.

**Stories:** 59–66 · **Seam:** the execution host's contracts, local gateway and isolated localhost SSH gateway.

### 11: Worktree picker in the browser

**Ticket:** [11-worktree-picker-in-the-browser.md](issues/11-worktree-picker-in-the-browser.md) — **Blocked by:** 10

**Delivers:** The existing picker wired to the host: list with the main checkout marked, create, remove, the dirty
prompt with explicit force, and a conversation whose target is the worktree.

**Stories:** 59–66 · **Seam:** browser → Web adapter → durable backend → execution host.

### 12: Interactive terminal on the execution host

**Ticket:** [12-interactive-terminal-on-the-execution-host.md](issues/12-interactive-terminal-on-the-execution-host.md) — **Blocked by:** None

**Delivers:** A long-lived host shell session: open in a bound root, streamed output, input, resize, close ending the
process, reported exit, a named limit where unsupported, and no transcript entry.

**Stories:** 67–71, 75, 78, 79 · **Seam:** the execution host's contracts, local and isolated localhost SSH.

### 13: Terminal in the browser, with reconnect

**Ticket:** [13-terminal-in-the-browser.md](issues/13-terminal-in-the-browser.md) — **Blocked by:** 12

**Delivers:** The panel wired to the host session, with a bounded replay after reconnect, input never replayed after an
ambiguous failure, the existing close behaviour preserved, and close ending the host process. The two numbers are
`TERMINAL_RECONNECT_MS` (120,000 ms) and `TERMINAL_REPLAY_CHARS` (128 KiB).

**Stories:** 67–79 · **Seam:** browser → Web adapter → durable backend → execution host, plus host contracts.

### 14: Durable extension inventory and selection state

**Ticket:** [14-extension-inventory-and-selection-state.md](issues/14-extension-inventory-and-selection-state.md) — **Blocked by:** None

**Delivers:** Installed extensions from the runtime's registry, a persisted global default, a selection materialized
explicitly at conversation creation, a per-conversation override, and a startup report for an extension that failed to
install.

**Stories:** 91–100 · **Seam:** the backend's public surface through the Web adapter, with the real store.

### 15: Extensions panel: enable and disable

**Ticket:** [15-extensions-panel-enable-disable.md](issues/15-extensions-panel-enable-disable.md) — **Blocked by:** 14

**Delivers:** The panel lists exactly the installed durable extensions, enables and disables them globally or per
conversation, bulk-toggles, and offers no install, update, check or generic editor.

**Stories:** 91, 92, 95, 96, 100–102 · **Seam:** browser → Web adapter → durable backend.

### 16: MCP on the Web host

**Ticket:** [16-mcp-on-the-web-host.md](issues/16-mcp-on-the-web-host.md) — **Blocked by:** None

**Delivers:** Configuration, test and OAuth sign-in on the Web host service, global and project scopes, masked failure
reasons, trust-gated project scope, no secret to the backend, and a named limit where no host service can serve it.

**Stories:** 80–90 · **Seam:** the Web host service's public surface, with the controlled fake MCP and OAuth fixture.

### 17: MCP surface in the browser

**Ticket:** [17-mcp-surface-in-the-browser.md](issues/17-mcp-surface-in-the-browser.md) — **Blocked by:** 16

**Delivers:** The MCP dialogs wired to the host: list, add, edit, remove, test with a masked reason, sign in and sign
out, and no control the host cannot perform.

**Stories:** 80–87, 90 · **Seam:** browser → Web host service, with the controlled fake.

### 18: Truthfulness and submission invariants across the new surfaces

**Ticket:** [18-truthfulness-and-submission-invariants.md](issues/18-truthfulness-and-submission-invariants.md) — **Blocked by:** 09, 11, 13, 15, 17

**Delivers:** Every control touched by blocks A–F works or is visibly unavailable before it is clicked; failures are
shown as what they are; the ADR 0006 submission invariants are re-asserted; catalogue fields and timestamps the runtime
cannot supply stay empty; the models configuration and the untouched Settings surfaces are unchanged.

**Stories:** 103–114 · **Seam:** browser → Web adapter → durable backend, plus the controlled fixture.

## Checking this breakdown

[`check-tickets.mjs`](check-tickets.mjs) asserts the artifact itself: every story number in [the
spec](spec.md#user-stories) is covered by exactly the tickets that name it and no ticket names a story the spec does
not have; every ticket file has a `Blocked by:`, a `Status:` and a `Seam:` line; every blocker reference resolves to
an existing ticket and points to a lower number; and every ticket is linked from this breakdown. Run
`node .scratch/capability-integration/check-tickets.mjs` from the repository root.

## Review notes

Deferred findings carried into these tickets live in [review-notes.md](review-notes.md), with trigger, evidence,
normal-use likelihood, user impact, disposition and revisit condition per
[review policy](../../docs/agents/review-policy.md). They are non-blocking: a `record` finding does not reopen a
ticket, create a blocking edge, or require defensive code or tests.

Two recorded findings have a revisit condition this breakdown triggers, and are therefore checked in the ticket named
beside them rather than left dormant: the terminal tab's label source and the project-trust answer. Both are noted on
those tickets, and both are now closed — ticket 13 fixed the label source (a tab carries its own workspace's folder),
and ticket 16 gave trust a real consumer.
