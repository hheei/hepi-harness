# Ticket proposal: full-history conversation navigation

**Status:** delivered and accepted on this line. 01–05 are implemented and integrated (01 `1f5f173`, 02 `5e64cb9`,
03 `1db108c`, 04 `0d66ff1`, 05 as `fc15cc2` source with its record at `a0caf5d`). 05's acceptance gate is closed by
its thirteen-row matrix and 82 browser checks, re-measured on the integrated tree rather than inherited from the
delivery branch.

| Ticket | Blocked by | Delivery |
| --- | --- | --- |
| [01 - historical anchor contract](issues/01-historical-anchor-contract.md) | None — **integrated** at `1f5f173` | Backend-owned snapshot identity, user-anchor enumeration, fork/compaction semantics, bounded page contract |
| [02 - bounded target window](issues/02-bounded-target-window.md) | 01 (met) — **integrated** at `5e64cb9`, carries [N1](review-notes.md) | Backend target read around a user anchor, explicit stale/missing/out-of-scope outcomes, client-ingress relay |
| [03 - navigation state and jump coordinator](issues/03-navigation-jump-coordinator.md) | 01, 02 (met) — **integrated** at `1db108c` | Outline pages, one target coordinator shared by rail jumps and deep search, named failure states, direct placement before smooth settlement |
| [04 - full-history rail](issues/04-full-history-rail.md) | 01, 03 (met) — **integrated** at `7116eaf` (delivered in-review) | User-message nodes, previews, unloaded-node interaction, no animation-driven paging |
| [05 - system acceptance and guide sync](issues/05-system-acceptance.md) | 02, 03, 04 (all met) — **delivered and accepted** at `a0caf5d` | Compaction/fork/browser acceptance, search failure-outcome matrix, verification records, docs and completion decision |

Tickets are vertical where practical. 01 must settle the wire and ownership contract before client code invents a coordinate. 02 and 03 preserve bounded body loading. 04 owns presentation. 05 is an integration gate over 02-04, not a separate release and not a second implementation.

All routes run on Backend and reach Web/App through the client ingress; no Web BFF owns or rewrites the payload. Deep exact-block search reuses ticket 03's bounded target coordinator instead of adding a locate loop.

Cross-effort context: `../ux-closeout-research/spec.md`; current architecture owner `.scratch/client-app/spec.md`.


Owning chat/history guide and docs/migration-status.md update with the implementation slice that changes behavior;05 checks guide sync rather than postponing all documentation until final acceptance. Ordinary read/compaction/fork/append cases provide coverage; no bypass probes are designed or run.
