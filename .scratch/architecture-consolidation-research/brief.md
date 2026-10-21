# Architecture consolidation research

Baseline: caf6a319177554f3fcc53e6a4efc6683a1a3e433. Phase: research only. User requests all A–F investigated before implementation and prefers a clever, reliable design over the smallest patch.

## Working philosophy

Optimize total understanding, ownership, correctness, recovery, and maintenance. Prefer coherent replacement of a faulty abstraction even when larger than a local patch. Shorter implementation is evidence, not objective. Use Module, Interface, Depth, Seam, Adapter, Leverage, and Locality from .pi/skills/skills/engineering/codebase-design/SKILL.md.

Use native pi-durable Harness/Conversation/Registry/Extension and existing platform primitives first. Hide complexity at its owner, preserve separate fault domains, reduce caller ordering rules and duplicated truth. Establish actual callers and variability before extracting a shared Module. Keep extension behavior and injected policy visible where relevant. Reject generic frameworks, parallel registries, speculative plugin loaders, fallback ladders, or universal stores without concrete needs. Distinguish current failures from design improvements and future features.

## Execution

Each worker owns only its assigned report. Source code, tests, config, dependency files, vendor snapshots, graphs, live services, and git state remain unchanged. Local read-only commands and narrow temporary probes under .dev/architecture-consolidation-research/ are allowed. No deploy/restart, installs, builds on remote-host, broad suites, commits, or graph rebuilds.

Read docs/agents/review-policy.md and codebase-design skill. Apply ponytail-review in REVIEW mode; user explicitly requests research first. Reuse supplied exact paths, then narrow graph queries for unknown relationships. Graph: /home/developer/Documents/dev/hepi-harness/graphify-out/graph.json; supplemental semantic graph: graphify-deep/graphify-out/graph.json. Graph edges locate source; confirm material claims in current source. Read primary docs/types/source of installed versions before recommending upstream extension points. EnvTarget has conversationId/cwd/read, not taskId/callId; env factory alone is not proven to solve call correlation.

## Required report

Chinese prose, exact identifiers. Include baseline and sources with path:line or first-party URL/version.

1. Verdict/problem: real production callers, trigger/impact, architectural defect vs ordinary logic error vs dormant debt vs unsupported feature. Correct prior claims if needed.
2. Current ownership/data flow; dependency categories: in-process, local-substitutable, remote-owned, true external.
3. Compare at least two genuinely different approaches including native/existing solution and trade-offs. For trivial deletion or pure sharing, explain why no elaborate alternative is warranted.
4. Recommended target Interface: concrete TypeScript sketch when useful, example caller, invariants/ordering/errors/recovery/performance, what is hidden vs explicit. Explain why smarter and reliable, beyond smallest patch.
5. Keep/delete/move table: exact files, callers, external compatibility, licenses/provenance, DB/wire effects. Label measured vs estimated size.
6. Over-engineering audit: existing unnecessary concepts and complexity proposal could introduce; rejected alternatives with reasons. Concise ponytail findings where useful. Never invent a net line estimate.
7. Verification at public Seams: critical behavior, existing tests to reuse/replace, focused integration/browser checks, rollback/cutover and completion criteria. Web suite stays lean (baseline 111 tests/64 files); no new tests now.
8. Dependencies/interactions with A–F and unresolved decisions. End with opinionated recommendation and ordering, not a menu alone.

Done means actual callers and primary sources support recommendation, contract/failure semantics are explicit, implementer need not invent architecture. Do not implement.
