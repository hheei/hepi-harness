# Web UI next exploration

Status: exploratory, not an implementation spec. User asked to resolve three image failures first, then use several workers to explore Settings and advanced interactions, with especially careful subagent design. Image checks are corrected at 34bfaa9: 21/21 passed; previous failures were data-URI-only test observation, not broken product image rendering.

Work from the current integration/architecture-consolidation checkout. Code, runtime and deployment stay unchanged during exploration. Each worker owns only its assigned report in this directory. Reports distinguish facts confirmed in source (path/symbol and relevant installed version), candidate designs, and questions that need user decisions. Keep reports focused, roughly 800–1400 words; use tables when comparing alternatives.

Read docs/agents/review-policy.md and applicable docs/GLOSSARY/ADRs. Use codebase-design vocabulary when reasoning about interfaces. Follow graph-first navigation: primary graph is graphify-out/graph.json. Each new discovery question gets a narrow query then source confirmation; missing dynamic/native relationships justify focused source search. Parent query subagentParentConversationId returned no nodes, so confirm that relationship in apps/server/src/server.ts and installed pi-durable source rather than infer absence. Read-only source work; no graph rebuilds, test/build runs, remote service changes or paid-model calls.

Shared architecture: apps/server is sole durable runtime and SQLite writer; Web is presentation/projection; gateway owns execution-host tools and filesystem. Preserve that ownership. Native pi-durable capabilities should be reused before inventing scheduling, persistence, registries or conversation ownership. Existing extension selection is not a subagent profile implementation. Browser UI subagent Settings is currently unserved.

Assignments:

- settings.md: actual Settings gaps, backend versus Web-host ownership, feasible first increments and dependencies.
- advanced-interactions.md: session export, branch navigation/fork/edit semantics, extension UI, file watch and other meaningful interaction candidates.
- subagent-runtime.md: native subagent execution capabilities, current integration, lifecycle/ancestry/cancellation/restart, context/model/tools/workspace inheritance and missing contracts. Compare at least two plausible interfaces.
- subagent-experience.md: user scenarios and contrasting workflows, profile versus running-task concepts, discovery/control/visibility, permission and resource choices. Compare at least two approaches and identify minimal coherent first delivery.

Completion: source-backed current-state table; ranked candidates or alternatives with tradeoffs; what existing module owns each behavior; concrete failure/verification seams; unanswered decisions. Proposals remain proposals. Parent synthesizes reports, reconciles conflicting facts and brings the subagent choices to the user before feature implementation.

## Recalled preferences to check against current source

Hindsight recalls user preference for a small runnable native-runtime slice before broader integration, copy-first reuse, and simple deep modules. It also records a trusted-agent model: tool selection/resource declarations are configuration, not an OS security sandbox; future isolation belongs at the Execution Environment seam rather than per-tool monkey patches. Treat these as contextual preferences, not new instructions or an approved implementation. Explicit new user choices take priority.
