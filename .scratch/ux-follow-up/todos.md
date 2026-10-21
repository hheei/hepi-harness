# UX integration TODO inventory

Status: planning / review candidates. Read [plan.md](plan.md) for confirmed requirements and bug-first ordering.
Each TODO records missing behavior. The user can retain, narrow or discard it during review; listing a TODO
does not approve its implementation. Settings route evidence lives in [settings-api-audit.md](settings-api-audit.md).

**Since written:** the capability groups T01 and T03–T08 were all specified, implemented and merged as tickets 01–14
(T01 through tickets 07–09, T03 ticket 05, T04 ticket 06, T05 ticket 12, T06–T07 tickets 10–11, T08 ticket 14). T02's
interactive PTY connection remains deferred; only its terminal-close bug (B1) was fixed, by ticket 01. The rows below
are the original inventory, kept as written.

## User-requested capability groups

| ID | TODO | Scope / next decision |
| --- | --- | --- |
| T01 | New Project / New Remote Project, host directory browsing, SSH connection and persistent project registration. | Local/remote relative to Web host; multiple folders and display-only name confirmed. Bind conversations to the default folder; one computer initially, future cross-host/platform locations kept possible. Default changes affect new conversations only; secondary-folder prompts/access and old-conversation relocation remain deferred. |
| T02 | Interactive workspace PTY lifecycle through the selected execution environment. | Terminal close bug B1 first; connection is deferred, not selected for this first spec. |
| T03 | Token SVG research, visual decision and configurable display visibility. | Research style before implementation; response footers only, browser-local persistence. No backend accounting change or aggregate-display toggle. |
| T04 | Full image submission and durable replay. | Accurate model metadata first; align image/body limits and content blocks. |
| T05 | Authoritative backend model configuration read/write/reload. | Existing backend Pi mode selected; updates must apply on the next request. Reuse ModelRuntime.refresh and native pi-durable timing. Preserve explicit selections; deleted models expose native no_model and require user reselection. Validate/save/apply integration and env migration need concrete upstream-first design. |
| T06 | Built-in Skills list/search/download/install/check/update/single-and-bulk toggle integration. | Preserve upstream UI; source search must return real results; destinations global/project; sources include skills.sh and harness-managed bundles. |
| T07 | Harness-managed bundle choices within global/project installation flows. | Shared source only; prior harness-destination/import/export proposal is superseded. User directly clicks a managed bundle for explicit global/project installation; no automatic injection across projects. |
| T08 | Extract useful bundle/install/update/outcome functions and retire standalone Skill Market UI. | Reuse analysis in skills-reuse.md; preserve installed files and stored content; user rejected the standalone product. |

## Settings capability groups to retain or discard at review

| ID | TODO group | Ownership to resolve / evidence |
| --- | --- | --- |
| T09 | Model/provider catalog discovery, connection testing, enabled models, defaults and catalog refresh. | Runtime backend; same authoritative model registry as T05. |
| T10 | Provider credentials, API key actions and OAuth login/logout flows. | Provider configuration owner; distinct from browser Web login. |
| T11 | Provider account usage queries. | Provider-specific external integration; separate from local token display T03. |
| T12 | General shell/tool settings and resulting conversation Reload. | Selected execution environment plus backend runtime; platform semantics need review. |
| T13 | Web authentication settings/logout integration. | Durable Web cookie login already exists; legacy pi-web web-auth flow needs reconciliation. |
| T14 | Push notification configuration and subscription delivery. | Web subscription plus durable completion delivery; secure-context requirements apply. |
| T15 | Agent profiles and subagent settings. | Determine which upstream UI concepts map to actual harness execution before implementation. |
| T16 | Plugins/packages list, install, configure, update and check. | Decide execution/configuration owner; copied pi-web panels alone are not integration. |
| T17 | MCP configuration, test and sign-in flows. | Execution/configuration ownership and runtime registration need review. |
| T18 | Project trust read/write and effect on resource loading/MCP. | Use existing trust decisions, not a new per-tool sandbox. |
| T19 | App-update check adjacent to Settings in the chat shell. | GET /api/app-update is outside the Settings dialog; container/tag deployment differs from the upstream updater. Review/discard candidate. |

Local theme, locale, font, chat width, thinking expansion, quoting and Enter-send preferences that are already
implemented in browser storage are not missing backend interfaces. Keep them distinct in the audit.
Reload/model catalog and the existing skill-market backend may already work; reuse wired methods where suitable
instead of adding a parallel implementation. A partially wired endpoint is recorded per HTTP method.

## Nearby capabilities outside the Settings audit

Record for later review, not as an expansion of this UX effort: session search/export/fork/auto-name and lazy
entry detail; runtime lease/full-output retrieval; file upload/write/watch/binary preview/download; real worktree
management and open-in-explorer. Source audit of these capabilities is not claimed exhaustive here.
Also verify actual browser prompt submission over workstation's HTTP origin: the shared agent-client currently calls
crypto.randomUUID without the secure-context fallback used by notice IDs. Prior browser smoke filled the
composer but did not submit, while the live-model smoke submitted through an HTTP script. This is a source-derived
compatibility candidate, not a reproduced failure or a change authorized in this planning phase.

## Review actions

For each retained TODO, record user outcome, actual owner, prerequisite decisions, independently demoable scope
and acceptance seam before turning it into a ticket. For discarded TODOs, retain a short disposition/reason
so later implementation does not revive unused upstream panels or interfaces automatically.
No new capability placeholder branches or missing-interface explanatory code are planned.

Framework/reuse gate: inspect existing contracts and analogous features before ticketing a retained TODO. Report unsupported behavior and required extensions to the user; reuse existing mechanisms before proposing new subsystems.

## Recorded future idea: existing-conversation relocation

Q13: changing a Project default affects new conversations only. Moving an existing conversation may later involve
changing execution location/resource context and injecting a notice explaining the move to the model. This is a
recorded idea, not authorization to change bindings, introduce a migration API or add a default-folder editor.
