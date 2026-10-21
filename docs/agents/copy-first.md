# Copy-First TypeScript Integration

Upstream TypeScript repositories are integrated incrementally.

- Preserve upstream implementations and record the exact upstream version or commit and license.
- Prefer adapters and explicit integration seams over rewriting upstream code.
- Keep the upstream working baseline observable through regression tests, and compare behavior before removing a
  legacy implementation; remove it only after regression coverage passes.
- Keep integration changes narrow and avoid speculative refactoring.
- Reuse upstream behavior where it already solves the problem, and correct the failure at its owning seam — the
  [review policy](review-policy.md) governs how far an abstraction change may reach.
