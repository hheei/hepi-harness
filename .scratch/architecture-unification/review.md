# Architecture unification review

Initial review subject: integrated dirty tree, HEAD1758c1fb4479e9d4637a957857246c5998619d73, manifest `.dev/verify/architecture-unification/integrated-source.json`, sourceHash c516252bd7ff6e7d77d07f9df9fc0056403142f7b885f111147b4f588b9b6d36. Reviewers used source/diff and existing logs; initial findings were source-confirmed, not freshly browser-reproduced. [Scope](review-context.md), [spec](spec.md), [policy](../../docs/agents/review-policy.md).

## Standards

Reviewer41: one documented-standard finding, two advisory smells connected to material normal-use failures.

- P2: fixture expansion map crosses a different Seam from production local ProcessDetailsGroup state; violates codebase-design Interface test-surface rule. Real production expansion resets on window unmount.
- P2, possible Feature Envy: scroll save/restore assumes entry elements are direct content children; window adds turn wrappers. Normal session switch while reading saves no anchor.
- P2, possible Duplicated Code: minimap independently derives turn index, while render model includes leading mid-turn segment; offscreen click reveals wrong turn.

These overlap Spec requirements but remain Standards findings; severity is justified by concrete ordinary interaction, not the smell label itself.

## Spec

Reviewer42 identified five material P2 findings:

1. Reading restoration: direct-child selector no longer finds entry IDs; guessed turn key also fails for assistant anchors. Violates story21. Classification: integration logic error at navigation Seam.
2. Manual process expansion: component-local state disappears on unmount, while fixture state map masks it. Violates decision10. Classification: state ownership design defect.
3. Tall search block: full containment is impossible when target exceeds viewport; RAF loop fights user navigation. Violates story20. Classification: navigation completion logic error.
4. Leading history segment: minimap and render turn indexes differ. Violates story21. Classification: Interface identity defect; resolve stable entry/anchor identity rather than positional index.
5. Deep unloaded search: only one extra200-entry page acquired, then target marked handled without reveal. Violates story20. Classification: incomplete acquisition logic at existing paging/navigation Seam.

Disposition: fix all five after public production-browser counterpart reproductions. Window owner37 handles shared entry→containing-turn lookup, production expansion ownership and one finite cancellable navigation path; acquisition remains at existing hook paging Seam. No general framework or duplicate clock.

Advisory evidence gaps: production switching and deferred-original interaction after remount need matching browser coverage; initial fixture timings are observations, not enforced performance acceptance or normalized post-GC heap evidence. Preserve that distinction in final report.

## Correction follow-up

All five findings corrected and browser-verified. Final narrow reviewer45: Standards no material findings; Spec restore defect confirmed, then corrected at the owning window adoption contract. DOM setter trace established the queued correction overwrote the explicit restore (1006→6937); adoption now cancels it synchronously. Layout comparison uses values to avoid React185; expansion is restored from the existing reading snapshot before geometry is placed. Reviewer45 found no material issue in those final source corrections; review itself ran no independent tests.

Coordinator public verification: production48/48, prefix/reconnect11/11, no page errors. Exact commands, final source manifest and reused unchanged-source evidence are in [11](issues/11-integrate-verify.md). Web2365pass/16fail with zero new failure names; suite remains reported failed. Remaining recorded limits retain revisit conditions in [review notes](review-notes.md).
