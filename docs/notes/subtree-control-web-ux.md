# Subtree control in the Web workbench — where the surface lives

Ticket 03 (subtree lifecycle control) put the stop/interrupt decision in front of the user. This note records the one
placement decision that is easy to undo wrongly: which surface owns it, and what that costs the other apps.

## The panel belongs in `packages/ui`, not in an app

The subtree controls are `SubtreeControlPanel` in `packages/ui/src/components/`, mounted by `AppShell` inside the Agents
dropdown directly below the `AgentSessionPanel` child tree it names. `AppShell` is the workbench shell that both shipped
clients compose: the Electron workbench (`apps/app/src/main.tsx` → `@hepi/ui/workbench`) and `apps/web`. So the code path
`AppShell` → `SubtreeControlPanel` → `@hepi/session/control` → `@hepi/client` `WorkbenchClient` is the **shipped** path in
both, not a Web-only prototype waiting for an app to adopt it.

Consequence: a subtree control written once here cannot drift between the two clients, and it inherits each host's own
transport, base URL and credential from the connection context rather than naming a host of its own.

## Why it sits below the tree instead of beside it

A child row stays a row. The controls do not replace the tree, do not take a row's click target, and do not disable
navigation while a request is in flight — a user who wants to look at a child mid-request can still open one, in the same
window, without losing the selection or the in-flight request (spec acceptance: "UI shows confirmation, partial failures
and final states without losing navigation"). The global sidebar stays navigation-only: nothing there reaches the subtree
routes.

## Placement costs to watch

- A second placement (a per-row button, a menu item in the sidebar, a dialog owned by `apps/web`) would fork the
  confirmation and the attempt-identity rules. There is one: the request id is held per (conversation, action, selection)
  by `packages/ui/src/lib/subtree-control.ts`, and a lost answer is read back with a GET, never re-sent.
- That single owner is also why a retry repeats the **confirmed** subset. `subtreeConfirm` freezes the whole decision —
  conversation, action, id, selection — and `subtreeControlFrom`/`subtreeReadFrom` take nothing but that record, so no
  placement can re-derive a selection from a listing that moved while an answer was lost. A second surface that assembled
  its own body would reintroduce exactly that widening, and `subtree-surface.test.mjs` is where the rule is held.
- An attempt is released by completion, however it was learned: an answered write or a read-back stating `completed`.
  The read path is not a bonus — a lost race settles there — so a placement that released only on its own answer would
  hand the user back a finished capture as if it were a new stop.
- The panel reads status from catalogue rows only — the same `catalogueRow` the list and the running poll publish. It
  opens no stream and no per-child state request, so a new placement must not add one either.
- `SubtreeControlPanel` is rendered only when the family listing has descendants; the Backend still captures the governing
  set from durable relations, so what the panel offers is a proposal, not the authority.
