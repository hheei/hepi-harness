# UX follow-up specification

Status: implementation authorized by user ("可以，开始吧"); all 14 tickets are implemented, verified and merged on integration/ux-follow-up (bug phase 01-04 at f6f0772; features 05-13 and retirement 14 after). The final code review is **complete on both axes**: its two material findings (F1, F2) are fixed at source and re-verified, its remaining five Standards findings are recorded non-blocking by policy. The approved scope is complete; **deployment is not part of this authorization**.

## Completion status

The final code review has run (see [code-review.md](code-review.md)). Its **Standards axis is complete** with five recorded,
non-blocking findings and no fix or investigate; its **Spec axis is now complete**: both material findings are fixed at source and re-verified.

### Material findings and their fixes (both resolved)

1. **Spec F1 — a project created after boot is not an installer target until restart.** At `apps/server/src/server.ts:418-420`
the installer is built once with `workspaces: allBindings()`, and `apps/server/src/skill-install.ts:294` resolves a target from
that snapshot. `POST /api/projects` (`server.ts:619`) adds a live project that the snapshot lacks, so install/toggle/check/
inventory answer "unknown workspace" until the backend restarts. Fix at the seam: read the live bindings through a getter or
callback (as `boundWorkspace` already does), not a boot-time clone. The fix applies to live projects and new default roots;
conversations already bound keep their bindings. Owned by the skills owner, with a real-backend public-registration regression.
Fix implemented at `5180f4e` (merged `4a243ae`): `InstallerOptions.workspaces` is a thunk read per request, `server.ts`
passes `allBindings` uncalled, and `bindingOf` invokes it. Ticket 21 rechecked it at `5db97fc`: **F1 SPEC PASS** —
`live-skill-target.test.ts` 1/1 on the ordinary current-project path, the boot-configured `legacy` workspace preserved,
local and SSH sharing one lookup; `skill-install.test.ts` 30/30 and `project.test.ts` 9/9 unchanged.
2b. **F2 (adjacent, found while rechecking F1)** — a deployment that starts with no configured workspace installed no harness
`env` factory (`server.ts:380`), and `openServerHarness` only installs `CodingTools` when `env` is present, so a project
created afterwards got its skills but had no `read`/`write`/`edit`/`bash` until restart. Fix: always pass the factory (it
resolves per request; an unbound conversation still resolves nothing). Owner 28, source `d7cdff0`; red/green proven in
`project.test.ts`; merged as `bb3c4f7` — server typecheck exit 0, `project.test.ts` 10/10, `live-skill-target.test.ts` 1/1,
server suite 131/131. Ticket 21 rechecked the merged pin read-only: **F2 SPEC PASS** — independent RED at `5db97fc`
(test transplanted into a detached worktree: `AssertionError … <harness> [error] Tool read is not available`) and GREEN on the
merged source (`bindLegacy: false` boot, a real `read` through the gateway on a marker only the chosen folder holds; an
unbound conversation errors and writes no file). F1 was unchanged by this fix.
2. Retrospective is written at [retro.md](retro.md).
Source: user UX reports and grill Q1-Q14. Current requirements supersede earlier harness-destination proposals.

## Problem Statement

Users can get trapped in failed terminal tabs, see misleading chat-navigation highlights and model capabilities,
and lose skill-operation feedback. Copied Settings and project UI expose workflows whose backend interfaces
are absent. Users need concrete fixes first, followed by selected integrations that use the existing runtime.

## Solution

Repair terminal closing, visible-turn tracking and model metadata first. Keep the builtin Skills interface,
restore real installation feedback there, and retire the standalone Skill Market UI after extracting useful
mechanisms. Add single-host Projects with a default folder, configurable response-footer token icons, image
transport/history and backend-owned model configuration. Preserve pi-durable's lifecycle and native recovery.
Interactive terminal connection and unselected Settings integrations remain explicit TODOs.

## User Stories

1. As a user, I want a terminal tab to close after creation fails, so an unusable tab cannot trap me.
2. As a user, I want closing a tab to work even when remote cleanup fails, so UI cleanup remains usable.
3. As a user, I want normal tab cleanup and remembered tabs to remain coherent, so successful terminal flows retain their behavior.
4. As a reader, I want every visible turn highlighted in the right navigation, so it represents what I can see.
5. As a reader, I want click/keyboard navigation to remain stable while messages resize, so streaming does not disrupt navigation.
6. As a user, I want DeepSeek image capabilities described accurately under my configured provider alias, so input is neither incorrectly rejected nor silently removed.
7. As a user, I want uploaded images to reach an image-capable model intact, so responses can use image content.
8. As a user, I want image messages restored after reconnect/restart, so durable history retains their meaning.
9. As a user, I want meaningful validation for unsupported image content and size limits, so rejected submissions are understandable.
10. As a user, I want New Project to select folders on the Web host, so Local refers to the computer serving my Web UI.
11. As a user, I want New Remote Project to select folders on an SSH execution host, so work runs on the host I chose.
12. As a user, I want a display-only Project Name, so organizing projects does not create or rename directories.
13. As a user, I want a Project to record several existing folders on one computer, so related folders can be grouped.
14. As a user, I want one designated default folder for new conversations, so their working location is predictable.
15. As a user, I want older conversations to retain their location if the Project default changes later, so their work is not silently relocated.
16. As a user, I want accurate host/account labels, so identical paths on different hosts are distinguishable.
17. As a reader, I want token labels replaced with compatible SVGs and readable numbers, so response statistics fit the frontend.
18. As a reader, I want localized accessible metric names and tooltips, so icons remain understandable.
19. As a user, I want a browser-persisted switch for response-footer statistics, so I control their visual noise.
20. As a user, I want that switch to preserve aggregate displays and usage accounting, so it affects presentation only.
21. As an operator, I want Models settings to use backend Pi configuration, so the editor controls the registry that serves requests.
22. As an operator, I want configuration saves to expose validation/application outcomes, so file persistence is not mistaken for runtime success.
23. As a user, I want model changes to follow pi-durable's existing request/phase semantics, so updates behave like the underlying framework.
24. As a user, I want already-started work to finish under its native lifecycle, so configuration edits do not introduce a new interruption policy.
25. As a user, I want a deleted selected model to remain identifiable and report unavailable, so I can explicitly choose a replacement.
26. As an operator, I want current provider aliases, endpoints and credential resolution preserved during configuration integration, so working deployments are not silently rerouted.
27. As a user, I want saved model configuration restored after backend restart, so editing it is durable.
28. As a user, I want the builtin Skills panel rather than a separate Market, so there is one skills workflow.
29. As a user, I want skills.sh and harness-managed bundle search with source labels, so I can find skills from either source.
30. As a user, I want library browsing without an active conversation, so discovery does not require starting a run.
31. As a user, I want to directly select a harness-managed bundle for global/project installation, so shared bundles use the normal install flow.
32. As a user, I want installation on the chosen execution host/account or default project folder, so the Web/backend host is not substituted.
33. As a user, I want complete bundle contents preserved, so scripts, binary assets and empty files remain available.
34. As a user, I want install/update feedback to survive list refresh and distinguish installed files from reload failure, so I know what happened.
35. As a user, I want Up to date and Update based on source/revision, with local modifications reported separately, so actions reflect actual state.
36. As a user, I want explicit overwrite confirmation and retained backups, so updates preserve local edits according to the existing contract.
37. As a user, I want manual installations and existing repository content preserved when Market UI is removed, so the UI migration does not erase skills.
38. As a reviewer, I want missing Settings interfaces recorded separately, so a TODO does not silently expand implementation scope.

## Implementation Decisions

### Sequence and reuse

- Verify terminal closing and navigation as independent bug slices. Correct DeepSeek metadata before image transport.
- Capture skill-feedback regressions and satisfy them through the retained Skills workflow; polishing the rejected Market UI is not a preliminary deliverable.
- Use existing browser preferences, navigation, Pi configuration/runtime, resource loading, gateway and installer mechanisms.
- Before implementation, disclose missing framework contracts and analogous existing capabilities. Extend the current integration at those seams; use upstream TypeScript and preserve version/license provenance.
- Missing APIs remain documented work. A generic capability framework, unused fallback branches or explanatory placeholder handlers are not deliverables.

### Projects and execution

- Project identity, display name, folder locations and default-folder selection are distinct metadata. Each location retains execution-host association.
- A Project contains folders on one computer in this version. Metadata leaves later cross-host/platform support possible; no multi-host executor or general path abstraction is included.
- New conversations bind one existing single-root Workspace for the Project default. Other folders remain metadata; they are not injected prompts or additional tool roots.
- Local refers to the Web host's real execution account, including split/container deployments. Remote refers to the chosen SSH execution account.
- Current filesystem listing is confined to a registered root; arbitrary host browsing and runtime registration are missing management interfaces. Their extension must be made explicit before implementation.
- Preserve existing conversation bindings. A changed default affects new conversations only; an old-conversation relocation workflow and additional default-editing UI are not required.
- **A bare load opens nothing (user decision, 部署配置的默认 workspace 不要打开).** The shell's first load opens only what
  its URL names (a `?session=`/`?cwd=`) and this tab's own remembered pick: it adopts no project of its own accord,
  so a deployment's configured workspace is reached by a pick or by "Use default directory", never by landing. The
  configured workspace keeps its conversations and its group; nothing is hidden and no per-origin hide state is added.
- Generic pi-durable can change agent cwd. The first-version application binding policy is narrower and does not justify a new lifecycle mechanism or per-tool sandbox guards.

### Tokens and images

- SVGs use the existing outlined, rounded, currentColor visual language. Select a coherent set at footer size; keep numeric values and localized accessible names/tooltips.
- Prefer adapting inline paths. Copying external paths requires pinned source and complete upstream license notices; no icon dependency is needed merely to render three glyphs.
- Visibility applies to response footers only, persists through the browser preference mechanism and preserves current visibility by default. Aggregate UI and backend accounting retain their behavior.
- Image support must align model metadata, command validation, Web transport, server body limits, runtime content blocks, SSE projection and restored history. Reuse native image content; avoid a parallel attachment/runtime subsystem.
- Preserve configured provider identity, endpoint and auth when correcting image capability metadata. Capability correction alone does not claim full image support.

### Model configuration

- Backend Pi configuration and auth storage are authoritative; an editor on a different Web host must not read that Web host's unrelated configuration.
- The current Web catch-all route does not export PUT. Connect the real model-config read/write operations and their required HTTP methods together; verify requests through the Web origin rather than only calling the backend directly.
- Reuse upstream configuration validation, ModelRuntime refresh and credential resolution. Persist/apply results must be truthful and diagnostic handling must preserve existing credential sanitization.
- Follow documented pi-durable configure, prepared-request and task-phase semantics. Registry/provider refresh follows existing lookup behavior. Introduce no custom global-idle gate, per-turn freeze or model-change scheduler.
- Preserve native distinctions between stored conversation choices, new-conversation defaults, provider catalog data and execution-resource Reload. Updating one does not justify replacing another.
- Permit removing a model. Preserve explicit conversation selection and present native no_model/unavailable state until the user selects a valid replacement. Verify the Web presentation rather than assuming the backend path already appears in UI.
- Configuration ownership is decided, but deployment env-to-Pi conversion must be proposed concretely using upstream facilities before implementation. This planning draft authorizes no live migration.
- Provider OAuth, account usage and unrelated model/provider Settings actions remain their audited TODOs unless selected separately.

### Skills

- Retain builtin Skills and its Add/search workflow. Destinations are global/project; harness-managed bundles are sources, not a third installation scope.
- Search both skills.sh and existing harness-managed bundles, with provenance visible. Browse/search can work without an active conversation; installation still needs an explicit execution target.
- Reuse managed-bundle storage, complete bundle transport, install hashes, provenance, source revisions, update-conflict checks, backup publishing and operation/reload outcomes.
- Map UI project destination to the default execution folder and existing gateway workspace scope. Runtime resource discovery remains execution-side under the accepted resource ADR.
- Source revision currency and baseline local modification are separate states. Unknown provenance is not evidence that a skill is missing or modified.
- Install/update remains explicit; storing bundles causes no automatic activation or synchronization. Preserve current resource Reload behavior rather than applying new model-registry timing to it.
- Retire standalone Market UI after the retained workflow has coverage. Preserve installed files, bundle storage and useful management primitives; a new publishing/import/export UI is not included.
- Bulk/single skill toggles must operate on the selected execution host and use the retained Skills contracts. The copied Web-host mutation helpers are not sufficient by themselves.

## Testing Decisions

Use the highest existing public seam that demonstrates behavior. Test user outcomes, real protocol payloads and
observable persistence; do not mirror private reducers, method calls or source-code strings as acceptance tests.

| Boundary | External behavior to verify | Existing prior art / fixtures |
| --- | --- | --- |
| Browser against Web adapter | Close failed tabs despite rejected cleanup; all visible turns highlighted across scroll/reflow; keyboard navigation; token visibility persistence, themes, localization and narrow layout. | Existing browser/component test harness, controlled DOM dimensions and response fixtures. |
| Browser + backend HTTP/SSE with controlled model | Actual prompt/image submission; advertised capability and endpoint identity; exact image content at provider; restart/reconnect history; configuration refresh and no_model/reselection under native lifecycle. | Existing server controlled-provider/SSE tests, temporary Pi config/auth, SQLite restart fixtures and prior browser smoke. |
| Project/Skills HTTP + execution gateway | Host/account ownership; default-folder binding and old-conversation stability; global/project installs; full bundle bytes including empty/binary files; revision states, conflict confirmation, backups and independent reload outcome. | Existing local gateway and localhost SSH fixtures, install race regressions, temporary execution accounts/directories and resource loader tests. |

Control model/tool completion with provider gates and committed state, not sleeps. Configuration timing tests
assert installed upstream semantics rather than inventing another scheduler. Verify a model deletion produces
native failure and leaves other conversations/configured models usable, then explicit reselection succeeds.

Use separate Web/backend/execution locations to catch accidental filesystem ownership substitution. Verify real
browser submission under supported HTTP and HTTPS origins: previous composer-only checks do not establish send.

Review icon candidates at actual footer size in both themes and mobile/desktop; confirm accessible metric names
remain even when textual labels become icons. Source research is evidence, not completed human visual acceptance.

A bounded live image smoke may supplement controlled-provider coverage after implementation; it does not replace
regressions or authorize paid/live tests or deployment during this planning phase.

## Out of Scope

- Connecting interactive terminal PTYs now; retain its TODO after the close fix.
- Cross-host folders within one Project, Windows execution support or a speculative portability layer.
- Simultaneous multi-root tooling, secondary-folder prompt injection or sandbox openings.
- Moving existing conversations, relocation notices or an additional default-folder editing workflow.
- Machine-wide preference persistence, aggregate token icon redesign or usage-accounting changes.
- A third harness installation destination, automatic library activation/sync or another Market/publishing/export UI.
- Implementing every audited Settings endpoint, a generic capability negotiation system or unused fallbacks.
- Rewriting pi-durable lifecycle, introducing a second model registry/execution engine, live deployment or publishing.

## Further Notes

User approved scope/public testing boundaries ("都很好，可以下一步") and the ticket breakdown ("同意，可以").
The 14 published local tickets are linked from [ticket-breakdown.md](ticket-breakdown.md); their ready-for-agent
status records planning readiness. User subsequently authorized implementation ("可以，开始吧").
Execute the bug-first dispatch order on integration/ux-follow-up; deployments and paid live-provider smoke
remain outside this implementation phase.

Authoritative user decisions and bug ordering: [plan](plan.md). Framework evidence and limitations:
[framework fit](framework-fit.md). Skills extraction: [reuse](skills-reuse.md). Remaining interfaces:
[TODO inventory](todos.md) and [Settings audit](settings-api-audit.md). SVG evidence:
[style brief](icon-style-notes.md) and [source research](icon-source-research.md).

Record only: a future old-conversation relocation could change execution location and resource context, then
inject a notice explaining the move to the model. Current conversations keep their bound Workspace.
