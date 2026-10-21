# Durable Harness MVP Specification

**Status:** implemented — tickets 01–08 are complete (each issue file carries its own final status, including the
limits recorded for 03 and 04). This spec is the approved scope as written; the running system has since moved on
substantially (execution-side resources, projects, the built-in skills workflow). Current entrypoints:
[docs/verification.md](../../docs/verification.md); current architecture: [docs/architecture.md](../../docs/architecture.md).

## Problem Statement

The planned product needs one durable coding-agent runtime that remains authoritative when browser clients disconnect, while execution may occur in a separately hosted workstation gateway against local or SSH workspaces. Existing upstream projects provide valuable runtime and UI behavior, but they have different ownership models: `pi-durable` owns durable agent work, `pi-web` contains a local web application/runtime path, and `pi-gui` contains desktop session supervision and workbench behavior. Without an explicit protocol and ownership boundary, integrating them would create duplicate agent loops, ambiguous conversation state, unsafe retries, and unclear workspace access.

## Solution

Build the harness incrementally around an authoritative cloud `pi-durable` server. The server owns conversations, task execution, persistent storage, settings, submissions, steering, aborts, and committed tool results. A versioned protocol package exposes snapshots, revisions, commands, events, request IDs, and resynchronization. A separate gateway adapts the public `ExecutionEnv` seam for explicitly configured local or SSH workspaces. The Web UI is adapted from `pi-web` behind a durable-session adapter and retains its proven chat, streaming, session, tool, and settings behavior. Selected `pi-gui` workbench contracts and components are deferred until the server/gateway boundary is proven.

## User Stories

1. As a single-person operator, I want one durable server to own a conversation so closing a browser does not stop an agent run.
2. As a single-person operator, I want a conversation and committed tool results to survive server restart.
3. As a single-person operator, I want a Web UI to create, list, open, submit to, steer, and abort conversations through the server.
4. As a single-person operator, I want streamed assistant and tool state to appear in the Web UI without starting a second agent loop.
5. As a single-person operator, I want browser reconnect to obtain a coherent snapshot and continue receiving newer events without duplicate entries.
6. As a single-person operator, I want the server to serialize commands from independent clients using request IDs and server-owned semantics.
7. As a single-person operator, I want a workstation gateway to execute approved filesystem and shell operations for a configured local workspace.
8. As a single-person operator, I want a gateway to execute against an explicitly configured SSH workspace without installing Pi on the SSH host.
9. As a single-person operator, I want SSH credentials and network reachability to remain on the gateway workstation.
10. As a single-person operator, I want workspace paths and hosts constrained to explicit configuration rather than arbitrary browser input.
11. As a single-person operator, I want stdout, stderr, exit codes, cancellation, timeouts, working directory, and environment boundaries preserved across the execution adapter.
12. As a single-person operator, I want a gateway outage to produce a visible blocked, interrupted, or outcome-unknown state rather than a false successful tool result.
13. As a single-person operator, I want potentially destructive operations not replayed automatically after a disconnect.
14. As a single-person operator, I want a second independently hosted Web UI to observe the same conversation after the first UI disconnects.
15. As a single-person operator, I want a second Web UI to submit or steer a conversation through the same authoritative server and gateway.
16. As a single-person operator, I want session lists, streamed messages, tool rendering, settings, and file browsing behavior retained from the upstream Web UI during migration.
17. As a single-person operator, I want selected file browsing, diff review, terminal, and Git/worktree behavior reused from the upstream workbench where it fits the gateway boundary.
18. As a maintainer, I want upstream versions, licenses, entrypoints, and copied/adapted source locations recorded.
19. As a maintainer, I want upstream baseline checks run before migration and parity or regression checks run after each replacement path is introduced.
20. As a maintainer, I want the system to avoid accounts, tenants, RBAC, billing, collaboration features, duplicated runtimes, and unnecessary framework rewrites.

## Implementation Decisions

- Use `@earendil-works/pi-durable` as the server runtime boundary and consume its public exports before considering a fork.
- Keep the cloud server as the only owner of agent generation, task scheduling, conversation persistence, agent state, submission queue, steering, abort, compaction, and tool-call lifecycle.
- Keep one server process as the initial SQLite writer/owner.
- Define versioned commands, events, snapshots, request IDs, monotonic revisions or equivalent consistency markers, and resync behavior in a dedicated protocol package.
- Identify conversations by stable workspace and gateway bindings, never by browser identity. Workspace changes are explicit commands with traceable results.
- Adapt the public `ExecutionEnv` interface for gateway execution. The gateway owns local filesystem access, shell execution, SSH configuration, private keys, network reachability, connection pooling, and path/host confinement.
- Store only logical workspace bindings and non-secret metadata in cloud persistence.
- Adapt `pi-web` incrementally: preserve chat, streaming, session navigation, tool rendering, settings, file browsing, and existing UX while replacing its local session/runtime path behind an adapter.
- Selectively adapt `pi-gui` workbench contracts and components only after their host assumptions and actual SSH/workspace behavior are verified. Do not import Electron main/preload/renderer or its session supervisor wholesale.
- Use explicit operation states: queued/not-dispatched, dispatched, running, completed, failed, interrupted, and outcome-unknown. Operations with possible side effects are not blindly replayed after disconnect.
- Prefer private networking or HTTPS with strong token authentication for server and gateway links. Never expose an unauthenticated shell and never store SSH private keys in cloud storage, logs, or browser state.
- Preserve upstream source history or reproducible snapshots, license notices, exact revisions, and a provenance map.

## Testing Decisions

- Test at public seams: server protocol handlers, durable conversation APIs, gateway `ExecutionEnv` adapter, workspace authorization, and adapted UI behavior.
- Use upstream durable lifecycle, recovery, submissions, view/watch, tool, SQLite, and environment conformance tests as baseline evidence where feasible.
- The first vertical slice must prove create/open/submit/stream/persist/restart with one Web UI and a deterministic test execution environment.
- Protocol tests must cover revision ordering, request idempotency, reconnect snapshot resync, concurrent client commands, and duplicate-event prevention.
- Gateway tests must cover local execution first, then SSH execution, stdout/stderr, exit code, cancellation, timeout, cwd, environment boundaries, unreachable host, reconnect, and outcome-unknown handling.
- UI tests should verify external behavior and parity for streaming messages, tool calls, session navigation, reload/reconnect, and error states rather than internal component structure.
- Security tests must verify authentication, gateway identity, workspace allowlists, path confinement, symlink/traversal handling, and absence of credentials from persisted records and logs.
- Run regression tests before removing any legacy `pi-web` path or selected `pi-gui` behavior.

## Out of Scope

- Application implementation in this planning step.
- Multi-user accounts, tenant management, RBAC, billing, collaboration, enterprise infrastructure, public SaaS onboarding, and a general-purpose scheduler.
- Distributed SQLite, multiple concurrent storage writers, horizontal cloud server scaling, gateway failover, and container orchestration.
- A full `pi-gui` Electron migration or whole-repository copy.
- The `pi-tui` client in the initial MVP.
- Visual redesign or replacement of the upstream Web UI framework.

## Further Notes

The research and ADR are authoritative inputs for this spec: `docs/research/durable-harness-upstream-research.md` and `docs/adr/0001-single-authoritative-durable-runtime.md`. The initial implementation should begin with source/provenance capture and baseline verification, then move through a small durable server plus one Web UI vertical slice before adding multiple clients or SSH.
