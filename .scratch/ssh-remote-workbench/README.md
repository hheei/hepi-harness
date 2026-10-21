# SSH Remote Workbench

Status: approved capability scope (7 rows) reconciled to the issue files on disk - see the table in
[Ticket proposal](ticket-proposal.md). 01, 02 and 03 delivered, reviewed and integrated (`integration/client-app`
`55a594e`, `94e62b1`, `7807c46`; `83a1188` is ticket 02's own tip, not its merge tip). **05 DOCX byte preview
delivered and integrated** at `871ae72` (branch source `f39669d`, tip `f6e1004`, which had already merged the ticket 16
acceptance batch `84b7039`) - `mammoth` is now declared by `packages/ui`, the package that
imports it, and both hosts' builds resolve the browser reader; 06 terminal parity and 08 failure boundaries **delivered**
on `impl/ssh-workbench-acceptance-next` `5527f68`, reviewed and integrated at `0994ffe`; ticket 04 is resolved using that closeout evidence; 07
resolved as deferred. Ticket 03 records two further subjects (a
`not_found` workbench refusal code, and desktop/native save above the browser seam); live watch is ticket 07's decision,
which may conclude "deferred".

- [Specification](spec.md)
- [Ticket proposal](ticket-proposal.md) - approved rows mapped to issue IDs
- [Research](research.md)
- Issues: [01](issues/01-gateway-remote-workbench.md) [02](issues/02-protocol-error-parity.md)
  [03](issues/03-web-acceptance.md) ([findings](issues/03-findings-and-plan.md))
  [04](issues/04-system-acceptance.md) [05](issues/05-docx-byte-preview.md)
  [06](issues/06-terminal-parity-and-abort.md) [07](issues/07-live-watch-protocol-research.md)
  [08](issues/08-failure-boundary-acceptance.md)


[UX followup09](issues/09-file-failure-and-preview-feedback.md) follows04 and client-app17; native save is client-app20. [Cross-effort map](../ux-closeout-research/spec.md).
