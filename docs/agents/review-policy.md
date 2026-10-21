# Review and Bug-Fix Policy

Ship the agreed product once material failures are addressed. A review is not a demand to eliminate every conceivable defect. This policy applies to reviewers, implementers, mergers, and their subagents, including workflows that say to fix all findings.

## Triage before implementation

For each finding, describe the concrete trigger, available evidence, likelihood during normal use, and actual user impact. A synthetic reproduction alone does not establish that a problem matters in normal use.

| Disposition | Evidence and impact | Action |
| --- | --- | --- |
| `fix` | Ordinary use readily triggers a material failure, such as an unusable workflow, incorrect execution, or lost data. A demonstrated rare failure with serious consequences also qualifies. | Fix the cause and verify the affected behavior. |
| `record` | Negligible user impact, a contrived edge case, or a hypothetical failure without evidence of a material normal-use effect. | Write a short note, then continue delivery. |
| `investigate` | A credible normal-use failure is reported, but its trigger or impact is unclear. | Run a focused reproduction to classify it. When evidence does not establish material impact, record the uncertainty and continue. |

Code smells, style preferences, and imagined future requirements are advisory findings. Treat them as blocking only when evidence connects them to a material failure or the user explicitly requests the change. Review Standards and Spec separately, while applying the same disposition rules to both.

## Fix the cause at its owner

1. Trace the observed failure through the existing framework and integration seams.
2. Check whether the abstraction, ownership, or responsibility boundary is wrong: duplicated state, divergent representations, or caller-specific workarounds can indicate this.
3. Correct the owning abstraction with the smallest coherent change. Reuse an existing capability before creating another layer. When the abstraction is sound, fix the local implementation directly.
4. Verify the real failing behavior at a public seam, and remove workarounds the fix made unnecessary.

A fix should reduce the special cases needed to explain the system. Repeated caller guards, method replacement, per-tool monkey patches, speculative fallback paths, and parallel registries require evidence that the existing owner cannot handle the observed need. Checking abstractions is not a mandate to invent a new abstraction or rewrite a subsystem.

## End the review/implementation loop

The loop is complete when the agreed work is delivered, material findings are fixed, and relevant checks pass. A follow-up review checks those corrections and regressions; it does not repeatedly expand scope to theoretical cases.

Keep `record` findings in review notes with a concrete revisit condition: an actual user incident, new evidence of material impact, or explicit user prioritization. Recording is the complete action for such a finding; it needs no patch, regression test, new abstraction, or approval gate.

For example, first-time skill inventory returning 500 and an old host response replacing the selected host's list affect ordinary use and warrant fixes. A hypothetical filesystem alias requiring extra guards, with no material failure in the supported trusted-agent workflow, belongs in notes.
