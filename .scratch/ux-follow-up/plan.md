# UX follow-up plan

Status: implementation authorized ("可以，开始吧") on integration/ux-follow-up; deployment excluded. All 14 tickets are implemented, verified and merged; the final code review is complete on both axes (material findings F1 and F2 fixed at source and re-verified; five Standards findings recorded non-blocking) and the retro has run. See [validation](validation.md) and [code-review.md](code-review.md).
The earlier planning-phase narrative below records how requirements were settled; current execution follows the approved spec and tickets.
Baseline: application df24b7c; diagnosis/documentation HEAD 23c5eaa.
Source: user's ten UX reports and subsequent numbered corrections in this session.

## Working order

Write and review this plan first. Fix confirmed bugs before implementing features. Record every missing
capability as a TODO; the user may discard it during review. A TODO is an inventory entry, not an instruction
to implement everything. Application code, runtime configuration and deployments stay unchanged in this phase.
Do not add placeholder handlers, new unsupported-capability branches or a capability-negotiation framework
merely to explain missing integration. Existing behavior is evidence for planning, not proposed scaffolding.

## Confirmed requirements

| User item | Requirement | Planned disposition |
| --- | --- | --- |
| 1 | Local and remote are relative to the Web host. On workstation, Local means workstation itself. Replace the directory menu with New Project and New Remote Project. | Feature F1; host identity is settled. |
| 2 | Explicitly connect workspace terminals later. | TODO T02 / feature F2. |
| 3 | A failed workspace terminal must still close. | Bug B1, first repair. |
| 4 | Replace per-request token labels with suitable SVGs after researching style compatibility. Add a browser-local setting that hides per-response token statistics only; aggregate displays and backend accounting stay as they are. | Feature F3; icon design remains undecided. |
| 5 | Right navigation should highlight all visible question/turn blocks. | Bug B2; retain a separate navigation focus. |
| 6 | DeepSeek v4.1-flash image input should work. | Bug B3 for incorrect metadata, then feature F4 for complete image submission. |
| 7 | Model configuration must be connected later. Record the missing integration rather than writing unused unsupported branches. | TODO T05 / feature F5. |
| 8 | Audit every Settings section and record interfaces awaiting implementation. | See settings-api-audit.md and TODO inventory. |
| 9 | Installation gives visible feedback; already installed/current skills do not unconditionally offer Update. | Bug B4 behavior carried into the retained Skills flow. |
| 10 | Use pi-web's built-in Skills UI. Keep global/project as installation destinations; offer harness-managed bundles as directly selectable sources within them. Search skills.sh and harness bundles. Standalone Skill Market is unwanted. Reuse useful existing functions. | Feature F6; extract reuse before retirement. |

New Project chooses arbitrary existing directories on the Web host under its execution account's normal
filesystem permissions. New Remote Project connects to an SSH host and opens a Create Project dialog with
Project Name, Add a folder on <host>, + Add, Cancel and Create Project. Host labels must identify the actual
execution host. Host directories are reached through that machine's execution environment in Docker deployment.

## Phase A: confirmed bugs

| ID | Repair outcome | Current evidence | Completion criterion |
| --- | --- | --- | --- |
| B1 | Close failed/uncreated terminal tabs; separate local tab removal from remote cleanup. | TerminalPanel waits for DELETE; 501 invokes onCloseError and reopens the tab. | A failed creation, 404/501 cleanup, or disconnected cleanup cannot trap an unusable tab; normal terminal cleanup and tab restoration still work. |
| B2 | Reflect every visible question/turn block in the minimap. | ChatMinimap stores one activeIndex chosen near 30% of viewport height. | All blocks intersecting the viewport, including clipped blocks, highlight; offscreen blocks do not; click/keyboard focus remains coherent during scroll and layout changes. |
| B3 | Describe DeepSeek model capabilities accurately with the configured provider/endpoint preserved. | Live catalog labels magpie/deepseek-v4.1-flash text-only; custom fallback metadata differs from the underlying model. | Explicit model alias/capability registration advertises images and preserves routing. A supported image block is not silently omitted by pi-ai. |
| B4 | Preserve operation feedback and distinguish installation, current revision and local modification. | Market switches controls and loses install.notice; baseline unchanged is confused with current version. | Retained Skills flow keeps success/reload-failure feedback after state refresh; Installed/Up to date/Update follow source+revision comparison; local modification remains separate. |

B1 and B2 are independently verifiable first slices. B3 settles metadata before image transport. B4 is a repair
contract for the retained Skills flow: extract/reuse useful outcome logic as part of F6 rather than polishing
the standalone Market UI that the user has rejected. Capture its regression cases before the migration.
The models.json error is caused by a missing interface; its resolution belongs to F5, not a new interim branch.

## Phase B: features after bug verification

| ID | End-to-end result | Dependencies / decisions |
| --- | --- | --- |
| F1 | New Project on the Web host; New Remote Project on an SSH target; persistent project identity and conversation binding. | Multiple existing folders and display-only Project Name confirmed; conversations bind the default folder. First version supports one computer; secondary-folder prompt inclusion/access and cross-host execution remain deferred. |
| F2 | Interactive workspace terminal on the selected execution host, with input, resize, output, reconnect and termination. | B1; existing configured workspace can be the first slice, so F1 is not an artificial prerequisite. |
| F3 | Style-compatible per-response SVG token statistics and a browser-local Settings visibility switch for response footers only. | Research record and visual review first; consult icon-style-notes.md. |
| F4 | Images reach the model and survive durable history/restart, with upload/transport limits aligned. | B3; existing runtime accepts content blocks; adapt protocol, server and Web submission as one slice. |
| F5 | Models settings edit the authoritative backend configuration and take effect in its registry. | Use existing backend Pi mode: models.json, auth.json and settings.json; design env deployment migration and actual registry apply behavior. Other settings APIs remain separate TODOs. |
| F6 | Built-in Skills lists/searches/installs/checks/updates global/project destinations, including directly selectable harness-managed bundles, with correct feedback. | Harness is a managed bundle source, not a third installation destination. Search skills.sh and the harness library; reuse install/update primitives before retiring Market. |

F1-F6 are planning candidates. Their exact order and blocking edges are reviewed before ticket publication.
Other Settings interfaces stay TODO until selected or discarded; they are not bundled into F5/F6 automatically.

## Skills direction

The retained entry is Settings → Skills, including its + Add skills/search flow. Standalone Skill Market is
explicitly unwanted. Extraction should keep valuable mechanisms such as full-bundle handling, provenance,
correct update comparison, retained backups, overwrite confirmation and separate install/reload outcomes.
Do not carry curated-market browsing, publishing forms or a separate repository UI forward by default.
See [reuse analysis](skills-reuse.md). Existing installed files and stored bundles must survive any later UI retirement.

Harness is a shared, backend-managed bundle source offered within the global/project installation flows.
The user superseded the earlier third-destination proposal: there is no harness installation scope or new
search-to-harness import/export workflow in this effort. Storing a bundle does not make it agent content or modify any project.
User explicitly rejected automatic agent availability or context injection. Any execution-host installation and
Reload remain explicit actions, preserving ADR 0002; direct harness runtime loading is outside this effort.
The current Skills section requires a project. Review this gate when adding harness storage: harness-library
search/browse must not depend on an unrelated active conversation merely because the old UI did.

## Ask Matt route and review points

Current route: incoming UX reports → triage and evidence → this planning/TODO record. The router itself
recommends the next flow; it does not authorize implementation. Skills read for routing: ask-matt, triage,
grill-with-docs, research, to-spec and to-tickets; agent-facing notes follow writing-for-agents.

1. Review confirmed bugs and the exhaustive Settings inventory; retain or discard TODO candidates.
2. Use grill-with-docs for unresolved feature behavior, especially harness semantics and project folder composition.
3. Use research for SVG source/style choices; a prototype is optional later if visual review needs a runnable answer.
4. Use to-spec to synthesize settled requirements and agree public test seams.
5. Use to-tickets for independently demoable slices with explicit blocking edges; publish after breakdown review.
6. Later implementation uses the bug frontier first, then features, with TDD and code-review; retro follows delivery.

Keep requirements/decisions in this conversation through spec and ticket breakdown where context permits.
The spec scope and ticket breakdown are approved; 14 ready-for-agent issue files are now published.
This publication does not authorize implementation or include the deferred TODOs.

## Verification strategy for later work

Use existing browser → Web adapter → durable backend → execution gateway seams. Terminal closing and minimap
behavior use deterministic browser/DOM regressions. Model metadata and images use controlled-provider HTTP/SSE
tests, with an optional bounded live image smoke after integration. Skills use temporary host directories plus
local/SSH transport fixtures to verify exact bundle bytes, revisions, conflict confirmation, backups and reload.
Local/remote project tests distinguish Web hosts from backend and SSH targets. Appearance tests cover themes,
small screens, icon readability and visibility persistence. No sleeps or broad implementation-mirroring tests.

## Confirmed grill round 1

1. Harness is a shared skill library only; no automatic activation across projects or runtime injection.
2. A Project can contain multiple existing folders. Design must first examine the current single-root Workspace
   model; this does not approve a multi-root runtime rewrite.
3. Project Name is display metadata only; creating a Project does not create or rename filesystem directories.
4. The token visibility setting controls response-footer statistics only. Aggregate displays and backend
   accounting are unchanged.
5. Persist this preference per browser first. Machine-level persistence is a possible later option, not a
   requirement or abstraction to build now.
6. Model settings use existing backend Pi configuration (models.json/auth.json/settings.json). Configuration
   save/apply and migration from env mode still need concrete design; no runtime configuration is changed now.

## Confirmed grill round 2

7. A Project may eventually span hosts/platforms. First version supports folders on one computer; preserve the
   execution-host association of folder locations without implementing cross-host execution now.
8. Conversations belong only to the Project's default folder. Other folders are project metadata in this effort;
   prompt inclusion and sandbox access grants are future work. Current single-root Workspace is reused.
9. Superseding earlier item 10/Q9: global and project remain installation destinations. Harness-managed bundles
   are directly selectable sources within those flows. No third harness destination or ZIP-export/import product
   is requested. Explicit installation still determines agent availability.
10. Search covers skills.sh and harness-managed bundles, with sources distinguished.
11. Model configuration updates should take effect on the next request, rather than waiting for every conversation
    to become idle. Existing generation and ModelRuntime.refresh behavior can support this direction; follow the documented pi-durable lifecycle
    instead of defining a new per-turn/per-call application policy. The save-success boundary must include
    validated runtime application, not merely a file write.

## Confirmed grill round 3

12. Model/configuration timing follows pi-durable's documented philosophy and existing resolution points.
    Reuse configure, registry/provider refresh and ordinary request/task behavior; define no new application
    scheduler, global-idle gate or model-change boundary. Prepared requests keep their selected model reference,
    prompt and offered tools; later requests resolve changes through the framework. Provider catalog refresh
    remains the upstream ModelRuntime operation, not a new conversation resource-reload protocol.
13. Default-folder changes affect new conversations only. Existing conversations preserve their original binding.
    Record possible future relocation plus a notice/prompt explaining the new location; do not implement old-
    conversation rebinding, prompt injection or an additional default-folder editing UI in this first effort.
    Generic pi-durable can change cwd; the present application Workspace binding is intentionally narrower.
14. Removing a selected model is allowed. Preserve the conversation's chosen reference and expose upstream
    no_model/unavailable behavior on its next attempted request; user selects a replacement explicitly.
    The existing failure path needs UI presentation, not automatic model substitution or a new failure machine.

## Framework fit and reuse rule

Before proposing implementation, inspect current contracts and analogous existing features. Tell the user
when behavior is unsupported by current framework contracts, needs an extension, or overlaps an existing
capability. Prefer reuse/adaptation; listing a feature never authorizes speculative code or a parallel subsystem.
Record evidence and limitations in [framework-fit.md](framework-fit.md) as they are established.

## Current phase: Phase B features underway

Product grilling Q1-Q14 is complete. User approved [spec.md](spec.md) scope/test boundaries
("都很好，可以下一步") and the [ticket breakdown](ticket-breakdown.md) ("同意，可以"). All 14 local
ready-for-agent tickets are published with their approved dependencies and acceptance criteria. Bug tickets 01–04
are complete and verified, merged on integration/ux-follow-up at f6f0772 (see
[validation](validation.md)). The feature frontier 05–13 is underway: 05, 06, 07, 10 and 12 are dispatched into isolated
worktrees based on f6f0772, with 07 and 12 gated on a contract proposal reported before code; 08, 09, 11 and 13 stay
ready-for-agent with their published blockers, and 14 (Market retirement) comes last. Use isolated implementation
worktrees and integrate on integration/ux-follow-up. Current authorization covers the approved implementation;
deployment remains outside this phase.

- Preserve existing configuration/provider identities when connecting backend Pi settings; inspect upstream
  validation and refresh interfaces instead of starting another registry. Env-to-Pi conversion needs a concrete
  proposal and explicit notice of any framework gap before implementation; runtime migration is not done now.
- Keep bundle source/revision, installation baseline, operation feedback and explicit reload distinct. Reuse
  existing repository/install mechanisms; an additional publishing or import/export product is not selected.
- Source/license research is in [icon-source-research.md](icon-source-research.md). Final SVG geometry, stroke and
  spacing require visual review at footer size before application changes. Preserve current visibility by default.
- Interactive terminal connection and unselected Settings APIs remain TODOs, not speculative feature branches.

## Supporting records

- [TODO inventory](todos.md): canonical missing-capability list and review disposition.
- [Settings API audit](settings-api-audit.md): method-by-method evidence, including local preferences.
- [Skills reuse](skills-reuse.md): retained functions and scope questions.
- [Icon style notes](icon-style-notes.md): present style baseline and research brief.
- [Icon source research](icon-source-research.md): pinned assets/licenses and review candidates.
- [Approved spec](spec.md): selected behavior and public test boundaries.
- [Published tickets](ticket-breakdown.md): approved slices, issue links and dispatch order.
