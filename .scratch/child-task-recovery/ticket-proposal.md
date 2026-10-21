# Ticket proposal: Child task recovery semantics

Status: approved principles; initial tickets audit-first.

| Ticket | Blocked by | Delivery |
| --- | --- | --- |
| [01 - recovery capability audit](issues/01-capability-audit.md) | None | Trace task/operation recovery against pi-durable principles; establish evidence matrix |
| [02 - recovery projection gaps](issues/02-projection-gaps.md) | 01 | Fix only demonstrated inaccurate/missing status or lookup behavior |
| [03 - explicit continuation fork](issues/03-explicit-fork.md) | 01 | Decide whether evidence justifies a separate user-controlled fork workflow |
| [04 - system recovery acceptance](issues/04-system-acceptance.md) | 01-03 | SIGKILL/restart acceptance and docs closeout |

Ticket 03 may conclude no implementation is justified. Do not implement automatic retries/forks as part of this ticket
set. G2/G6 were recorded as product decisions by ticket 02 and were approved by the user afterwards; they remain
pending, unbuilt work stated in [ticket 02's approved pending section](issues/02-projection-gaps.md#approved-pending-work-2026-10-20)
— a manual, identity-preserving preparation retry is not an automatic retry and is not a fork.
