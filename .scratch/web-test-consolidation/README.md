# Web test consolidation

Completed: [accepted result](results.md),239 files461 tests461pass/0fail/0skip from the unchanged recursive runner. All281 original files have dispositions; material review corrections resolved.

User goal: recursive Web suite below500 reported tests. Workers inventory functional purpose, merge related scenarios and parameterize inputs, remove genuinely obsolete or low-value checks. Product behavior is unchanged.

Starting evidence:2381 tests,2365pass/16fail in `.dev/verify/architecture-unification/final-reading-web-unit.log`. Focused16-file reproduction exit1,20 reported tests/4pass/16fail in `.dev/verify/web-known-failures/repro.log`, HEAD1758c1f dirty integration/architecture-unification. Initial inventory281 files; static call counts are estimates, final count comes from the real recursive runner.

Ownership: `ui-files.json` (components, soft budget125), `state-files.json` (hooks/chat/lifecycle/session, budget105), `settings-files.json` (MCP/models/provider/subagents/legacy runtime, budget85), `integration-files.json` (adapters/remaining lib/public, soft budget155). Lists partition every recursively discovered test exactly once. Worker reports: `<group>-report.md`.

Acceptance:

- `pnpm test:web:unit` runs its unchanged recursive discovery, reports fewer than500 tests; failures are investigated rather than hidden.
- All original files have a functional disposition and destination; merged/deleted coverage is reviewable per owner report.
- Preserve material behavior: lifecycle acceptance/idempotency/history, tool pairing and deferred originals, cross-host routing, auth/origin and path confinement, upload bounds, terminal/window navigation.
- Matrices assert each row with a useful case label; scenarios retain independent setup/cleanup. No nested t.test for count reduction, no registering fake tests, no blanket mega-test, no generic custom test-count wrapper.
- Source regex checks of wiring/style/class names are candidates for deletion when delivered public behavior already covers them. Missing legacy modules are not restored into production to satisfy stale tests.
- No product code, vendor snapshot, discovery rule, default script or production service changes. Prior user edits remain intact.
- Final coordinator verification, diff review, owning verification-guide update and one default graph refresh.
