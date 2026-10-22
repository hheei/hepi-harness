# Shared design and acceptance requirements

Status: design exploration, 2026-10-21. Baseline: `5ec7ffe6`. These requirements apply to the six linked specs in [the design index](README.md); they describe proposed work, not delivered behavior.

## Design bar

- **Depth:** caller learns fewer invariants, ordering rules, error modes and configuration facts to perform the same operation. Count those facts, not only methods or lines. One dispatch method with a huge command union can still be a wide interface.
- **Locality:** each spec names a representative change and shows which owner changes afterward. Domain knowledge belongs with the implementation that decides it.
- **Seam:** prefer an existing meaningful interface. Expose internal variation only when callers need it. Production and test adapters justify a port when they exercise the same real dependency contract; incidental helper functions do not justify a new package or framework.
- **Deletion test:** describe what disappears from current callers and what complexity would reappear if the proposed module were deleted. Remove obsolete implementations and their redundant tests when replacement evidence exists.
- **Lightweight:** use current Node/TypeScript/Python/platform primitives and existing fixtures. Introduce no new runtime dependency without a concrete missing capability. Avoid registries of handlers, generic command buses, inheritance trees or feature switches for hypothetical extensions.
- **Honest gains:** each spec names concrete knowledge/glue to remove and acceptance observations. LOC, latency and test-speed improvements are measured during implementation, not invented as planning targets.

## Behavior and migration

1. Preserve current ordinary admitted workflows: paths, result codes, result bodies, cancellation, request dedupe, streaming/backpressure, resource ownership and shutdown, except for the explicitly named internal contract replacement in the ingress spec. Existing integration tests pin these observations.
2. Preserve durable Conversation authority. Runtime attachments and projections retain their distinct roles. Preserve project folders, opaque workspace ids, Retained Bindings, profile routing, metadata-only Folder Unlink and default-folder semantics.
3. Auth/admission stays on the normal shipped entry path. No tests, probes or fixtures designed to bypass auth, authorization, preflight or safety boundaries. Remote filesystem validation remains on the execution host.
4. Directly migrate current callers. Remove obsolete aliases, wrappers and fallback readers. Changes to persisted user data require a separate explicit migration scope; these designs do not delete or rewrite existing data.
5. Keep implementation in existing packages unless actual dependency constraints require a move. Public interface means everything caller must know, including ordering, timing, errors and lifetime.

## Verification and documentation

Each implementation slice maps a named scenario to an existing test file or a replacement test at the module interface. Use colocated TypeScript unit tests for computation and state ownership; integration/E2E remains in dedicated directories. Replace redundant implementation-coupled tests after observing equivalent interface coverage. Keep ordinary full-stack tests that verify composition, artifacts or transport.

Run relevant checks through `pnpm verify:changed` for the implementation revision; add focused integration/browser/artifact checks only when changed contracts require them. Record actual command, tested SHA/dirty state, exit code and raw log using [verification practice](../../docs/agents/verification.md). A planned check is not a pass. Native artifact work builds on workstation/CI and exercises prebuilt artifacts; remote-host runs no builds.

Update each spec’s named current guide with delivered behavior in the implementation change. These planning documents do not replace current guides. Review findings use [review policy](../../docs/agents/review-policy.md): fix material design gaps, record hypothetical or negligible issues with a revisit condition.

## Completion of this planning task

Six standalone specs; three independent scout perspectives per area; explicit alternative comparison; two independent review passes over all specs; material findings resolved; dependency/parallelism map; link and structural checks with evidence. Implementation and implementation tickets are separate work.
