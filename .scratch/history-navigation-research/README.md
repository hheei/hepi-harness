# Full-history conversation navigation

Status: delivered. Tickets 01–02 resolved and integrated into `integration/client-app` (01 at `1f5f173`, 02 at `5e64cb9`). Ticket 03 is delivered in-review on `impl/history-navigation-03-tip`, rebased onto the integration tip `4a54277` and **integrated into `integration/client-app`** by cherry-picking that branch onto `1db108c`: the client's navigation owner, the one-target-window jump and the deep-search locate that replaces the sequential page walk. Ticket 04 is delivered in-review on `impl/history-navigation-04` (branched at the integration tip `2c28d1c`) and **integrated into this line** by cherry-picking that branch's commits onto `2c28d1c` (no conflict), reading 03's `reduceOutlinePages` and `NavigationCoordinator.jump`: the rail lists committed anchors beyond the loaded window and delegates an unloaded click once. Ticket 05 (system acceptance) is **delivered and accepted on this line**: its source and matrix were
cherry-picked onto the then-tip (`fc15cc2`) and its record arrived at `a0caf5d`, where the 82 browser checks and the
thirteen-row matrix were re-measured on the integrated tree. See [ticket 05](issues/05-system-acceptance.md).
Date: 2026-10-17

This research addresses the right-side conversation outline/minimap showing only loaded transcript blocks and being unable to jump precisely to an unloaded turn. It records current obstacles and open product/API decisions, not a chosen implementation.

- [Research findings](research.md)
- [Approved specification](spec.md)
- [Ticket graph](ticket-proposal.md)
- [Review notes](review-notes.md)
- [Prior interaction research](../webui-next-exploration/advanced-interactions.md)
- [Loaded-history integration ticket](../perf-follow-up/issues/05-loaded-history-integration.md)

