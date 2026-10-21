# Ticket proposal: subtree lifecycle control

Status: approved; tickets 01–04 all resolved and integrated into `integration/client-app` (`2cc7d0d` for 02 and
earlier for 01, `20fcd17` for 03, `23cef1a` for 04).

| Ticket | Blocked by | Delivery |
| --- | --- | --- |
| 01 backend subtree operation | None | resolved — durable scope, authorization, idempotent control |
| 02 outcome projection | 01 | resolved — each child's current session row beside its durable outcome |
| 03 Web selective control | 01, 02 | resolved — confirmation, progress, partial failure |
| 04 system acceptance | 01-03 | resolved — nested/hidden scope, races, restart replay, Gateway interruption, browser matrix |

Failure recovery/fork-on-failure remains separate. The matrix and its evidence are in
[the system acceptance ticket](issues/04-system-acceptance.md).
