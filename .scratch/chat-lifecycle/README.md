# Chat lifecycle — workflow artifacts

Design, validation, evidence and specification for one authoritative chat lifecycle. Documentation only: no
application source is written here.

Read [spec.md](spec.md) first, then [ticket-breakdown.md](ticket-breakdown.md). [check-tickets.mjs](check-tickets.mjs)
is the ticket check: it reports story coverage, blocker validity and ordering, and whether the breakdown links every
ticket. [review-notes.md](review-notes.md) is the two-axis final review of the delivered effort.

The design and evidence files are copies of the commits that produced them, kept here so this effort reads as one
record. Each names its own baseline and its own scope:

| File | Origin |
| --- | --- |
| [design.md](design.md) | consolidated design, `design/chat-lifecycle-ui` `c4d7154` |
| [design-validation.md](design-validation.md) | critical validation 73, `review/chat-lifecycle-design-validation` `28e18d9` |
| [background-delivery.md](background-delivery.md) | background delivery contract, `design/chat-lifecycle-facts` `6bf4cdf` |
| [background-coverage.md](background-coverage.md) | background coverage and its smallest migration, same commit |
| [diagnosis.md](diagnosis.md) | architecture diagnosis, `impl/chat-lifecycle-repro` `e16b1b1` |
| [red-loop.md](red-loop.md) | red-loop detail and the run-by-run table, same commit |

Baseline for all of them: `83cc7c8`. Run `node .scratch/chat-lifecycle/check-tickets.mjs` from the repository
root after editing a ticket.
