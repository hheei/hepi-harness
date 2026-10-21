# Durable Harness Upstream Research

Date: 2026-10-09

**Dated research record — read-only findings from this date, kept as evidence.** The revisions, licenses and reuse
matrix below informed [docs/adr/0001-single-authoritative-durable-runtime.md](../adr/0001-single-authoritative-durable-runtime.md)
and the durable-harness spec, and the project has since been built. Upstream repositories own their own current source
and licenses; this file does not describe the repository's present state. Provenance that must stay current lives in
[docs/upstream-sources.md](../upstream-sources.md); current checks in [docs/verification.md](../verification.md).

## Question

What can this repository safely reuse to build one central `pi-durable` harness with independent Web UIs, workstation execution gateways, and local/SSH workspaces?

## Sources

| Source | Revision | License | Relevant evidence |
| --- | --- | --- | --- |
| [earendil-works/pi](https://github.com/earendil-works/pi) | `6fb2e7815167e6b19006fc526d1a5d0f5f998787` | MIT (`LICENSE`) | `packages/durable/package.json`, `packages/durable/src/harness/harness.ts`, `packages/durable/src/env/index.ts`, durable tests |
| [agegr/pi-web](https://github.com/agegr/pi-web) | `76bdc57027172eb381a216d647225a6d24f23360` | MIT (`LICENSE`) | `package.json`, `lib/streaming-message.ts`, `components/SessionTree.tsx`, `lib/request-security.ts`, application routes |
| [minghinmatthewlam/pi-gui](https://github.com/minghinmatthewlam/pi-gui) | `572c0c6de8ffd3a245c224b912bb8752ca200780` | MIT (`LICENSE`) | `package.json`, `packages/pi-sdk-driver/src/session-supervisor.ts`, workspace and workbench contracts |

Revisions were read from the public Git remotes on 2026-10-09. They are evidence pins for this research, not a claim that future upstream revisions are compatible.

## Findings

### pi-durable

- `@earendil-works/pi-durable` is published as version `1.1.0`, is ESM, requires Node `>=22.19.0`, and exposes the package root plus `env`, `env/node`, tools, and storage subpaths.
- The public package is designed to be consumed rather than immediately forked. Its package metadata lists SQLite storage adapters and tests for lifecycle, recovery, submissions, views, watches, tools, and environment conformance.
- `ExecutionEnv` is a public interface combining filesystem and shell behavior. The shell contract exposes command execution, cleanup, output information, cancellation context, and bounded output semantics. This is the right seam for a gateway adapter.
- The harness exposes server-owned conversation behavior including submission, agent configuration, task scheduling, `viewState`, and `watch`. The implementation contains `Conversation`, `Harness`, scheduler, live state, task graph, and event/view modules.
- Durable state and event/watch behavior must remain server-owned. A browser should receive a versioned projection rather than internal Chord objects.

### pi-web

- `@agegr/pi-web` is version `0.10.0`, a Next.js 16 application, requires Node `>=22.19.0`, and is MIT licensed.
- The dependency list includes `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui`; therefore the current application is not merely a remote UI and currently owns local runtime assumptions.
- Existing UI code has reusable streaming presentation (`lib/streaming-message.ts`), session navigation (`components/SessionTree.tsx`), tool-call display, chat phases, settings, file browsing, and request security helpers.
- The migration should preserve the UI and streaming behavior while replacing the session/runtime boundary with a durable API adapter. It should not allow the browser to start a second agent loop.

### pi-gui

- `pi-gui` is a private pnpm workspace with desktop applications and many shared packages. Its baseline runs architecture, typecheck, guard, and unit-test checks across desktop-oriented packages.
- `packages/pi-sdk-driver/src/session-supervisor.ts` owns local session/runtime supervision and workspace-specific state. That is useful reference code but must not become a second central runtime.
- The repository has explicit workbench contracts for files, changes, terminal, workspace IDs, and worktrees. These contracts and selected React/TypeScript components are candidates for selective adaptation.
- Electron/desktop host behavior, local session supervision, and unrelated application packages should not be copied wholesale into the Web UI or gateway.
- The current research found workspace, terminal, diff, and worktree code, but does not establish a ready-made cloud-to-SSH gateway protocol. SSH support must be verified module by module before reuse.

## Reuse matrix

| Area | Decision | Rationale |
| --- | --- | --- |
| `pi-durable` package and durable tests | Copy unchanged at first / consume package | Preserve the proven runtime and use its public seams. |
| `pi-web` chat, streaming, session sidebar, tool rendering | Adapt | Preserve user-visible behavior while changing the session transport. |
| `pi-gui` workbench contracts and selected components | Selectively adapt | Reuse proven workbench behavior without importing Electron or a second supervisor. |
| `pi-tui` | Defer | Useful future thin client; not needed for the initial vertical slice. |
| Cloud protocol | Build locally | The upstream repositories do not provide the required versioned multi-client gateway protocol as a complete product boundary. |
| Gateway local/SSH execution | Build an adapter around `ExecutionEnv` | Gateway ownership of filesystem, shell, SSH credentials, and reachability is a project boundary. |
| Upstream session supervisors or browser-side agent loops | Do not import | Violates the single-authoritative-runtime constraint. |

## Constraints and open risks

- The exact durable server HTTP/WebSocket transport is not supplied by `pi-durable` itself; this project must define a versioned protocol package.
- `pi-durable` and upstream applications currently require modern Node versions and have independent dependency graphs. Integration must preserve each upstream baseline before consolidation.
- Gateway disconnection creates ambiguous tool outcomes. The protocol must distinguish queued, dispatched, running, completed, failed, interrupted, and outcome-unknown states, and must not blindly replay non-idempotent operations.
- SQLite must initially have one server writer/owner. Multiple server processes and distributed SQLite are out of scope.
- SSH availability and credentials belong to the gateway workstation. The cloud must store only logical workspace binding and non-secret metadata.

## Phase 0 conclusion

The smallest defensible next step is not to import whole applications. It is to preserve upstream source/provenance, establish a versioned protocol and workspace model, and build one server-owned durable conversation path with a remote execution seam. The first implementation slice should prove server persistence and one adapted Web UI before adding multiple clients or SSH.
