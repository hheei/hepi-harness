# Local Issues

Create one directory per feature. Put the spec at `<feature>/spec.md` and numbered vertical-slice tickets at
`<feature>/issues/<NN>-<slug>.md`. Keep this directory for workflow artifacts, not application source.

For current operating instructions, use the [documentation index](../docs/README.md). Plans, specs and validation logs
retain their original scope and evidence; a completed effort is not a promise that every upstream control is connected.

## How to read this directory

Two kinds of record live here, and they are read differently:

- **Current specs and tickets** own behavior someone is still building or accepting. Their status line, blocked-by edges
  and evidence are authoritative; `docs/` guides own the delivered contract and win any conflict.
- **Historical research and evidence** — dated audits, diagnoses, design memos and test inventories — records what was
  measured against a named revision. It is preserved as evidence, not maintained as a promise: a path or count in it may
  describe a tree that no longer exists. Each such file states its date and baseline, and its own links to current guides
  carry the reader forward.

Reconciled 2026-10-20 against this line: every status below was checked against the branch history and the source, not
against the previous index text. The per-effort classification of all 448 tracked files is in the
[coverage manifest](coverage-manifest.md).

## Current efforts

| Effort | Record | State |
| --- | --- | --- |
| Non-UI architecture work | [Design index](non-ui-architecture-design/README.md); implementation tickets: [Backend](backend-composition/ticket-plan.md), [workspace registry](workspace-registry/ticket-plan.md), [Gateway](gateway-transport/ticket-plan.md), [filesystem](filesystem-adapters/ticket-plan.md), [ingress locality](ingress-binding/ticket-plan.md), [native verification](native-artifact-verification/ticket-plan.md) | All 15 tickets integrated and independently reviewed on `impl/architecture-consolidation`; Backend03 `8f19a31b`, Ingress02 `17fe24d4`. Follow-up cleanup addresses the catalogue revision fixture and build warnings |
| UI architecture refactor | [Spec](ui-architecture-refactor/spec.md), [12-ticket plan](ui-architecture-refactor/ticket-plan.md), [acceptance matrix](ui-architecture-refactor/acceptance.md), [review notes](ui-architecture-refactor/review-notes.md) | All 12 tickets resolved, independently reviewed and integrated at `60714949`; 44 browser drivers (49 executions), 42 native checks passed. Named unverified capabilities remain in the acceptance matrix |
| Shared Web/App client | [Spec](client-app/spec.md), [tickets](client-app/ticket-breakdown.md), [gap/pattern review](client-app/review-notes.md) | Core migration plus 16 closeout and 17 retirement integrated; UX 18, 19, 21 complete; 20 implemented and its packaged journey run at `cc772ec` (37/37, debug shell); Pilo 23–25 complete at `2a53eef`; references 03 accepted and integrated at `0acf499`. 22 is in progress on `impl/closeout-22` at `5cc6e22`: SSH 09's file edge and 20's packaged row are met, its own keyboard/focus/narrow/IME journey passes (28 checks), and three named edges stay open — the rail/sidebar/raw-history keyboard and focus defects review 160 reproduced (fixes on `fix/history-rail-access-and-scope` and `fix/raw-history-and-sidebar-focus`), mobile being unmeasured, and `main` not being deployed. See [blueprint](../docs/research/hepi-client-architecture-blueprint.md) |
| Cross-conversation references | [Spec](cross-session-references/spec.md), [tickets](cross-session-references/ticket-proposal.md), [research](cross-session-references/research.md) | 01–03 accepted and integrated at `0acf499` |
| Full-history navigation | [Spec](history-navigation-research/spec.md), [tickets](history-navigation-research/ticket-proposal.md), [findings](history-navigation-research/research.md) | 01–05 integrated and accepted on this line; 05's matrix and 82 browser checks were re-measured here at `a0caf5d` |
| MCP tools in conversations | [Spec](mcp-conversation-tools/spec.md), [tickets](mcp-conversation-tools/ticket-proposal.md) | Complete: 01–05 integrated; 05 ran the whole journey (58 checks) and its delegated-child row is recorded as unexercised there, pinned by 04 at the durable seam |
| Provider connection management | [Spec](provider-connection/spec.md), [tickets](provider-connection/ticket-proposal.md), [deferred decisions](provider-connection/deferred-decisions.md) | Complete; two limits recorded (interactive OAuth not exercised against real upstream; no deployed-mode change) |
| SSH remote workbench | [Spec](ssh-remote-workbench/spec.md), [tickets](ssh-remote-workbench/ticket-proposal.md), [research](ssh-remote-workbench/research.md) | 01–08 delivered and integrated; 07 live watch deliberately deferred; [09](ssh-remote-workbench/issues/09-file-failure-and-preview-feedback.md) delivered, reviewed and rebased onto `70d9a6d` (missing file `not_found` 404, honest preview bound), pending integration |
| Subagent subtree control | [Spec](subagent-subtree-control/spec.md), [tickets](subagent-subtree-control/ticket-proposal.md) | 01–04 resolved and integrated |
| Child task recovery | [Spec](child-task-recovery/spec.md), [tickets](child-task-recovery/ticket-proposal.md), [audit evidence](child-task-recovery/issues/01-capability-audit-evidence.md) | 01–04 resolved (G1 fixed, G3–G5 measured by real `SIGKILL`); **G2/G6 user-approved and pending, unbuilt** — see [approved pending work](child-task-recovery/issues/02-projection-gaps.md#approved-pending-work-2026-10-20) |
| UX closeout 2026-10-19 | [Execution spec](ux-closeout-research/spec.md), [research evidence](ux-closeout-research/README.md) | Scheduling record; each row is delivered or gated by its owning ticket (references 03, SSH 09, client-app 22) |

## Delivered efforts (spec plus dated evidence)

| Effort | Record | Current reference |
| --- | --- | --- |
| Durable harness MVP | [Spec](durable-harness/spec.md) | [Architecture](../docs/architecture.md), [capabilities](../docs/migration-status.md) |
| Durable subagents | [Entry and ticket graph](durable-subagents/README.md) | [Chat](../docs/chat.md) |
| Execution resources | [Spec](execution-resources/spec.md) | [Skills](../docs/execution-side-skills.md), [installation](../docs/execution-side-installation.md) |
| UX follow-up | [Spec](ux-follow-up/spec.md), [plan](ux-follow-up/plan.md), [TODOs](ux-follow-up/todos.md), [validation](ux-follow-up/validation.md) | [Projects](../docs/projects.md), [capabilities](../docs/migration-status.md) |
| Distribution | [Spec](distribution/spec.md) | [Client](../packages/client/README.md), [containers](../docs/container-deployment.md), [releases](../docs/releases.md) |
| Initial Tailscale deployment | [Spec](tailscale-demo/spec.md), [validation](tailscale-demo/validation.md) | [Current split deployment](../docs/local-tailscale-deployment.md) |
| UI capability integration | [Spec](capability-integration/spec.md), [tickets](capability-integration/ticket-breakdown.md) | [MCP host](../docs/mcp-on-the-web-host.md), [capabilities](../docs/migration-status.md) |
| Chat lifecycle | [Spec](chat-lifecycle/spec.md), [tickets](chat-lifecycle/ticket-breakdown.md) | 01–06 merged; [Chat](../docs/chat.md) |
| Submit stall | [Spec and integrated record](submit-stall/spec.md), [measured diagnosis](submit-stall/diagnosis.md), [merge plan](submit-stall/merge-plan.md) | [Skills and resources](../docs/execution-side-skills.md), [verification](../docs/verification.md) |
| Performance follow-up | [Spec](perf-follow-up/spec.md), [design memo](perf-follow-up/DESIGN-memo.md), [decisions](perf-follow-up/decisions.md), [research](perf-follow-up/research/sse-connection-budget.md) | [Perf verification](../docs/perf-follow-up-verification.md), [Chat](../docs/chat.md) |
| Files transfer | [Spec](files-and-export/spec.md), [evidence](files-and-export/evidence.md) | [Workbench](../docs/workbench.md), [capabilities](../docs/migration-status.md) |
| Architecture unification | [Spec](architecture-unification/spec.md), [tickets](architecture-unification/ticket-breakdown.md) | [Chat](../docs/chat.md), [architecture](../docs/architecture.md) |
| Architecture consolidation | [Spec](architecture-consolidation/spec.md), [tickets](architecture-consolidation/ticket-plan.md), [research](architecture-consolidation-research/consolidated-decisions.md) | [Architecture](../docs/architecture.md) |
| Architecture routes 2026-10-14 | [Combined analysis](architecture-routes/README.md), [scope](architecture-routes/scope.md) | [Architecture](../docs/architecture.md), [graph navigation](../docs/agents/graph-navigation.md) |
| Design-review fixes | [Spec](design-fixes/spec.md), [classification and integration](design-fixes/results.md) | [Chat](../docs/chat.md), [MCP host](../docs/mcp-on-the-web-host.md), [Projects](../docs/projects.md) |
| Graphify alignment | [Workflow record](graphify-alignment/workflow.md), [deep build](graphify-alignment/deep-build.md) | [Graph navigation](../docs/agents/graph-navigation.md) |
| webui-next exploration | [Brief](webui-next-exploration/brief.md), [consolidated proposal](webui-next-exploration/conversation-api-proposal.md) | Exploratory only; [Chat](../docs/chat.md) owns delivered behavior |

## Historical research and evidence (preserved, not current promises)

| Effort | Record | Note |
| --- | --- | --- |
| UI architecture audit 2026-10-21 | [Report](ui-architecture-audit/report.md), [metrics](ui-architecture-audit/metrics.json) | Static inventory at `a57100bb`; follow-up [spec and tickets](ui-architecture-refactor/spec.md) are planned, not delivered. Current ownership remains in [Architecture](../docs/architecture.md) and the [Developer guide](../docs/developer-guide.md) |
| Development audit 2026-10-14 | [Audit](development-audit/2026-10-14.md), [follow-up](development-audit/follow-up.md), [Web test findings](development-audit/fixes-web-tests.md), [feature research](development-audit/features-research.md), [performance research](development-audit/performance-research.md), [design review](development-audit/design-review.md) | Dated audit against `1758c1f`; its fixes are recorded in [design-fixes](design-fixes/results.md) |
| Web test consolidation | [README](web-test-consolidation/README.md), [results](web-test-consolidation/results.md), [known failures](web-test-consolidation/known-failures.md) | Test-inventory evidence at its own revision |
| Web test value pass | [README](web-test-value/README.md), [results](web-test-value/results.md) | Second reduction; revision-scoped |
| Web test lean pass | [Results](web-test-lean3/results.md) | Third reduction; revision-scoped |
| Image history checks | [Results](image-history/results.md) | Corrected an observation defect only; product image behavior was unchanged |
| Deploy review fixes | [Review notes](deploy-review-fixes/review-notes.md), [red/green](deploy-review-fixes/redgreen.md) | Recorded, not fixed, on a real host |
