# Dated design notes

One page per surface or decision that is easy to re-place wrongly. A note states where a component lives, why it lives
there, and what a second placement would cost; it is not a status record (those belong to
[migration-status](../migration-status.md)) and not a decision record with alternatives (those belong to
[ADRs](../adr/)).

- [Subtree control in the Web workbench](subtree-control-web-ux.md) — why the subtree controls live in `packages/ui`
  under `AppShell` and are shipped by both clients, and why they sit below the child tree instead of beside it.
