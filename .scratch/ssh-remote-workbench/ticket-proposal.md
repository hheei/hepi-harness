# Ticket proposal: SSH Remote Workbench

Status: approved framework. The approved scope is the **seven capability rows** below; the issue files on disk carry the
sequence this effort actually shipped in, which diverged from the proposal's numbering. The table is the reconciliation:
proposal row to issue file. Nothing was renumbered afterwards and no delivered ticket claims another's work.

| Proposal row | Issue file | State |
| --- | --- | --- |
| P01 - remote workbench read/Git seam | `01-gateway-remote-workbench.md` | delivered, integrated |
| P02 - remote writes and transfer parity | `02-protocol-error-parity.md` | delivered, integrated - the issue covered writes/transfer **and** the error, abort and deadline parity the proposal put under P06 |
| P06 - failure/security acceptance (part) | `02-protocol-error-parity.md`, `03-web-acceptance.md` | the ordinary failure states landed with those two; what is left of the row is `08-failure-boundary-acceptance.md`
| - (browser acceptance, not a proposal row) | `03-web-acceptance.md` | delivered - the refusal-cause wording at the browser seam. It is **not** P03: it did not touch DOCX |
| P03 - DOCX byte preview | `05-docx-byte-preview.md` | delivered on `impl/ssh-workbench-05`, integrated at `871ae72` - browser reader declared by its owner (`packages/ui`), bounded, inert, on both hosts
| P04 - terminal parity and abort | `06-terminal-parity-and-abort.md` | delivered 2026-10-19 on `impl/ssh-workbench-acceptance-next` `5527f68` - five rows already had owners; the missing-helper and no-session-transport rows had none, and are closed there, along with one SSH-vs-local classification difference |
| P05 - live watch protocol research | `07-live-watch-protocol-research.md` | resolved 2026-10-19 — stays deferred; no event implementation selected
| P06 - failure/security acceptance (rest) | `08-failure-boundary-acceptance.md` | delivered 2026-10-19 on that branch - every listed row green, and the stale `ux-ssh-project.mjs` precondition repaired onto the client ingress; no probe added |
| P07 - system acceptance | `04-system-acceptance.md` | closeout executed 2026-10-19 on that branch (01/02/03/05 integrated, 06/08 delivered there, 07 deferred). **Resolved: reviewed and integrated at `0994ffe`**; the limits it leaves standing are named there |

Two rules from the proposal still bind: ticket P05 (issue 07) may conclude live watch remains deferred, and no ticket may
implement polling as a substitute for event semantics.


## UX followup after current scope

[09 — missing-file and preview feedback](issues/09-file-failure-and-preview-feedback.md) depends on04 and client-app17. Native save belongs to client-app20; cross-domain final acceptance belongs to client-app22. [Execution map](../ux-closeout-research/spec.md).
