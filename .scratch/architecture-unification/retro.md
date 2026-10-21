# Architecture unification retrospective

Delivery: all11 tickets implemented and functionally accepted on dirty `integration/architecture-unification`, HEAD1758c1f. Evidence and retained limits: [integration acceptance](issues/11-integrate-verify.md), [review](review.md), [recorded limits](review-notes.md).

## What changed the outcome

Production browser scenes caught failures the original fixture could not: expansion reset on window unmount, coordinate mismatch on session return, and asynchronous corrections overriding explicit placement. Final48 window checks plus11 history/reconnect checks cover those public seams.

An empty DOM initially suggested failed selection. Immediate pageerror output instead exposed React185; state/context200 responses established selection had succeeded. Layout deduplication needed value comparison because each recomputation allocated fresh arrays.

A scrollTo-only trace missed the later write. Instrumenting the actual Element.scrollTop setter identified the window correction overwriting1006 with6937. Cancelling obsolete pending work at adoption fixed the owner; a repeated restore loop was unnecessary.

Saving coordinates alone did not restore the content: a session remount discarded process expansion. The existing reading snapshot now carries immutable expansion overrides, with a stable getter for cleanup and initialization before rendering. Final message offset−79→−80px.

## Process corrections

- Emit browser runtime errors immediately; a later driver timeout must retain the causal error.
- Verify delegated execution actually started. The replacement worker hit upstream429 before any diagnosis; coordinator resumed the work directly.
- Trace the real mutation seam before changing behavior. The earlier prototype probe missed inherited scrollTop setters.
- Bind accepted logs to source manifests. Earlier36-check results were historical once stronger return-navigation scenes or source changed.
- Compare exact known failure names. Final Web suite remains failed with16 historical failures; zero new names is a distinct result.

## Remaining scope

Single huge turns, minimap node growth, retained loaded-history heap and multi-MB structured arguments remain recorded limits. Their revisit conditions are unchanged. No production deployment or restart occurred.
