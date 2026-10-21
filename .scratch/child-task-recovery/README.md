# Child task recovery semantics

Status: approved principles; tickets 01–04 all resolved — G1 fixed at the execution seam, G3–G5 measured by real
`SIGKILL` acceptance, 03 decided as evidence-only. G2 and G6 were recorded here as product decisions and were
**approved afterwards by the user**; both are pending, unbuilt and owned by [approved pending work](issues/02-projection-gaps.md#approved-pending-work-2026-10-20)
(a minimal per-object preparation/delivery visibility surface, and a retry that reuses the existing dispatch identity).

- [Specification](spec.md)
- [Ticket proposal](ticket-proposal.md)
- [01 - recovery capability audit](issues/01-capability-audit.md) — resolved; [evidence](issues/01-capability-audit-evidence.md)
- [02 - recovery projection gaps](issues/02-projection-gaps.md) — resolved; gap G1 fixed at the execution seam, and G2/G6 approved-pending there
- [03 - explicit continuation fork](issues/03-explicit-fork.md) — resolved; evidence-only decision, no implementation and no new spec
- [04 - system recovery acceptance](issues/04-system-acceptance.md) — resolved; gaps G3/G4/G5 measured by real `SIGKILL`, at `1873d24` and again at the merged integration tip
