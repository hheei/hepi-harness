# Optional subagents extension: research brief

User-directed scope, 2026-10-16: study Codex and `../hepi-mono/packages/pi-subagents/` before proposing implementation. Subagents must be an optional plugin/extension, not mandatory core functionality. Earlier Settings and advanced-interaction reports remain exploratory references.

## Sources and responsibilities

- `codex-subagents-research.md`: worker 80; official Codex docs and pinned upstream source. Separate CLI, cloud and SDK claims. Codex behavior is reference material, not proof that Codex itself implements this feature as a plugin.
- `pi-subagents-research.md`: worker 78; sibling package source, package version, commit and scoped dirty status. Separate reusable code/product semantics from CLI process/socket/TUI coupling.
- `subagent-runtime.md`: worker 79; installed pi-durable API, task lifecycle, ownership, recovery and optional extension registration. Confirm what deselection, uninstall and unavailable task definitions do to persisted work.
- Parent synthesis: reconcile sources, audit important claims, identify smallest coherent extension boundary and unresolved product choices.

## Required questions

1. How do spawn, follow-up/steer, inspect, stop and resume relate to persistent child conversations and individual assignments?
2. What owns state, completion delivery, cancellation and restart recovery? Which mechanisms are actually supplied by each runtime?
3. Which pieces belong to the optional extension, and which generic host primitives already exist or need adaptation?
4. What happens when the extension is absent, deselected, disabled during work, or restored after restart?
5. How do agent definitions, inherited model/thinking, instructions, tools and execution workspace resolve without silently changing hosts or capability semantics?
6. Which code can be copied with version/license provenance, which semantics require adaptation, and which implementation details should stay with their original runtime?

## Constraints and pending choices

Research artifacts only; no feature implementation, deployment, build, graph rebuild, or paid model probes. Existing graph navigation is confirmed in source. Native Task remains the lifecycle authority; proposals must not imply another scheduler or authoritative run registry.

Previous questions to the user remain unanswered: automatic delegation versus human-managed workers (or both, with priority), and one-shot context versus continuing a persistent worker. Do not treat either as a settled requirement. Optional extension architecture is now an explicit requirement, not a pending choice.
