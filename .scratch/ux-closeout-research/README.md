# UX closeout research

Date: 2026-10-19. Status: research complete; user approved spec/ticket supplementation. [Execution spec and dependency map](spec.md) now owns scheduling; this file preserves research findings. No feature implementation or deployment. Extension platform remains deferred.

## Baseline and limits

Code: clean integration/client-app at `9400dcc8ca970f42ba4e02d71022d793a684039a`, workspace `/home/developer/Documents/dev/hepi-harness/.dev/worktrees/client-app-integration`. Live ingress artifact: `1873d244289db29e5aaa62118e3dfc1b30ffabb5`. These are distinct. Source gaps below are not all reproduced in browser.

Fresh unauthenticated browser contexts at live origin `http://192.0.2.10:30141/` were observed at desktop 1440x900 and mobile 390x844: HTML status 200, descriptor 401, only `unauthorized` rendered and no login action. Command exited 0; this means observation runner completed, not entrance UX passed. [Raw evidence and scope](evidence/runtime-observation.md). Current integration already contains WebSignIn/admission handling introduced after live release (`41fabf3`; subsequent readiness changes `2c6f801`). Parent checked `1873d24..9400dcc8` history and old Workbench source. This is a delivered-source fix awaiting deployment/immutable-artifact acceptance, not a missing gate implementation.

## Findings and priority

| Priority | Journey / gap | Current state | Smallest next work / owner |
| --- | --- | --- | --- |
| First | New user opens deployed Web | Confirmed live entrance blocked by bare unauthorized | Compare current gate fix and release artifact, then acceptance of immutable release; existing client-app 16 |
| High | Log out from Web Settings | Source-confirmed obsolete DELETE /api/web-auth vs ingress /api/web-logout | Correct existing request seam and cookie-only action; isolated normal logout acceptance |
| High desktop usability | Recover refused App credential | Shell configure/forget exists; no ordinary recovery action | Host-provided Configure/Disconnect using current shell restart/storage |
| High | Find early message or deep search result | Full-history rail missing; search sequentially pages intervening history | Existing history-navigation tickets 01-05, shared bounded target coordinator |
| High | Connect provider using OAuth | Implemented branch `impl/provider-connection-03` (`b20d814`), absent baseline | Inspect/integrate branch and finish provider 05 acceptance; preserve Gateway credential owner |
| High | Credential saved → composer can use provider | Provider panel refresh is not model-catalog/runtime refresh | Reconcile existing ticket 04 work; trace config mode and credential consumer, invalidate correct connection |
| High | MCP setup → choose tools → run in conversation | Invocation/durable bridge/listing delivered; discovery/grants UI not closed | Finish MCP 03b/03c, 04 lifecycle and 05 acceptance; reuse Backend bridge |
| High | Session load error or failed target navigation | Bare load-error screen; some failures only console log | Existing load/navigation owners: typed state, retry read/back, preserve valid state and request IDs |
| High verification | Supported Web/App/local/SSH flows | Many implementations delivered; immutable release and native/SSH acceptance incomplete | Current client-app 16; SSH 06/08/04; preserve logs/revisions |
| Desktop parity | Save file from bearer App to disk | Explicit NATIVE_SAVE_REQUIRED; uploads already have shared UI | App native destination + bounded authenticated save adapter |
| Medium | Follow/create cross-conversation reference | Stored references/navigation exist; ordinary creation missing, failed read feedback weak | Existing reference/control and navigation owner; minimal picker/action |
| Medium | Preview removed/moved file | Missing can flatten to operation_failed/HTTP 500 | Workbench/filesystem refusal and file-view state owner |
| Decide scope | Test/discover provider models | Intentionally unserved, generally capability-gated | Separate capability from OAuth, define test semantics before implementation |
| Optional | Remove installed skill | Install/update/disable exist; uninstall absent | Managed-only removal/provenance/local-edit decision before deletion API |
| Investigate | Switch profile/workspace mid-operation | Source lifetime/identity and upload ownership need focused scenarios | Connection admission owner and original operation target; avoid speculative broad rewrite |
| Research/parked | Live watch, mobile terminal ribbon, Android, background push | Existing explicit limits / platform prerequisites | Continue owning research/acceptance only when selected; not silently release-blocking |

## Detailed notes

- [Navigation, search, references, conversation recovery](01-navigation-and-conversations.md)
- [Provider, MCP, settings, skills](02-provider-mcp-and-settings.md)
- [Workbench, files, SSH, terminal](03-workbench-files-ssh-terminal.md)
- [Web, App, admission, operational feedback](04-web-app-and-operational-feedback.md)
- [Scope, source identity, evidence rules](05-scope-and-evidence.md)
- [Live entrance observation](evidence/runtime-observation.md), [desktop screenshot](evidence/desktop.png), [mobile screenshot](evidence/mobile.png)

## Research priority order (execution tickets now published in spec.md)

1. Reconcile live entrance and existing gate fix, fix current logout contract and expose App credential recovery, then source/branch status and release acceptance. This provides usable entrance and trustworthy baseline. No deployment performed by this research.
2. Parallel domain lanes: history/navigation; provider branch plus runtime availability; MCP discovery/grants/lifecycle. Each reuses existing specs rather than creating competing runtimes.
3. Close file-not-found/navigation/load errors at owners alongside affected lane. Native save can proceed separately through App adapter when prioritized.
4. Run actual supported Web/App/SSH user journeys against final immutable artifact. Finish old-entry retirement via client-app 17 only with its existing acceptance/dependency contract satisfied.
5. Consider optional provider discovery/test, managed-skill uninstall and watch after core workflows are usable and verified. Keep parked export/global dock/extension platform out.

AppShell and shared settings are overlapping paths: domain runtime work can proceed independently; coordinate UI integration at those files. Do not run parallel implementations of current MCP bridge or alternate history stores.

## Acceptance scenario matrix

| Scenario | Required observable outcome | Evidence still needed |
| --- | --- | --- |
| Fresh Web entrance, desktop/mobile | Login or actionable admission state; real accepted descriptor before workbench | Current immutable release browser run |
| App cold start/profile change/revocation | Correct backend/account only; no prior identity; actionable reconfiguration | Packaged native run on isolated credential store |
| Deep rail/search/fork/compaction jump | Bounded target window, exact target or named refusal, no intermediate hydration | Existing history spec implementation and browser acceptance |
| Provider connect/change/remove | Credential storage and runtime availability reported separately; composer refresh correct | Existing branch integration plus config-mode acceptance |
| MCP config/trust/select/invoke | Explicit grant, actual result and correct child/fork/restart behavior | Existing 03b/03c,04,05 |
| Local/SSH files and Git | Read/preview/upload/conflict, named missing/offline; no wrong-host late UI | Focused browser + current SSH acceptance |
| App save/terminal | Native bounded save; real bearer terminal input/reconnect/resize/close | Native adapter and packaged acceptance |
| Lost mutation response | Read original request ID; do not resend uncertain side effect | Existing public-seam/recovery acceptance, reuse when source unchanged |

## Decisions to settle only when affected lane starts

- Historical target rendering shape: reuse raw blocks or projected window (existing navigation ticket 01).
- Provider runtime behavior when credential-management host/account differs; actual supported configuration mode.
- Reference creation entry point and default target granularity.
- Whether provider test/discovery and managed-skill uninstall enter next implementation scope.
- Native save priority and supported desktop targets; watch/mobile/Android remain separate readiness decisions.

These are recorded together to avoid asking piecemeal questions during research. Existing approved decisions (bounded history, Gateway credentials, MCP execution, durable no automatic replay) remain in force.

## Manual review and rejected overclaims

Parent manually traced scout findings back to source. Rejected: missing durable MCP adapter; universally missing App uploads; 500 KiB DOCX raw limit; SSH 02/03 unimplemented; leaf child necessarily loses subtree controls; missing custom IME buffer proves broken CJK input. Rejected sequential minimap backfill recommendation because approved design forbids loading intervening history. Detailed notes preserve corrections.

No runtime source edited, no credential mutation, deployment, migration or broad build/test run. Evidence scripts/reports/screenshots only. Research artifacts are untracked in primary `.scratch/ux-closeout-research` (confirmed with git status); they are not a committed product change.
