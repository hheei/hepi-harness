# Project Prompt — Personal Distributed Pi Durable Harness

Status: historical initial engineering brief. Initial implementation and the execution-resources and UX follow-up
efforts are delivered. The phase sequence and proposed layout below record the original plan; they are not startup
instructions or a current capability reference. Use the [documentation index](../README.md),
[architecture](../architecture.md), [migration status](../migration-status.md), and approved `.scratch/` tickets for
current work. Current user instructions and `AGENTS.md` govern execution.

The original brief follows, preserved for design context.

## 0. Operating rules

- **Copy first, adapt incrementally, delete last.** Reuse original TypeScript/TSX implementations from upstream projects. Do not rewrite working functionality from scratch merely for architectural cleanliness.
- Start by inspecting the current repository **once**, and only inspect relevant files thereafter. Preserve all existing user edits, conventions, and work. Do not overwrite files without reviewing them.
- Make actual implementation progress; do not stop at architectural discussions or a long speculative plan. For large tasks, implement a small working vertical slice before expanding.
- Keep changes small, testable, reversible, and clearly scoped. Prefer adapters and compatibility layers to large refactors.
- Verify up-to-date upstream architecture, exact APIs, licenses, dependencies, and commit SHAs before using them. If an assumed upstream feature does not exist, state that explicitly; do not invent an implementation.
- Default to TypeScript and existing upstream tooling. Do not introduce Rust, Tauri, extra databases, microservices, Kubernetes, or a separate agent runtime without concrete justification.
- Retain upstream commit history or reproducible source snapshots, license notices, and a provenance map. Keep copied code clearly attributable. Avoid maintaining three independent duplicate implementations indefinitely.
- Focus on single-owner personal use. Do **not** build multi-user accounts, tenant management, RBAC, billing, collaboration, or enterprise infrastructure. Still enforce authenticated, encrypted remote control and explicit workspace access boundaries.
- Do not silently start, modify, or delete remote resources or expose network services beyond the scope necessary for the currently approved phase. Never commit credentials or tokens.

## 1. Product goal

Build **one central durable harness with many independent Web UIs, optional execution gateways, and many local or SSH workspaces**.

### Deployment model

1. **Cloud Durable Server:** Runs `pi-durable`, model/provider access, agent loop, tasks, tool-call lifecycle, extensions, conversation state, and persistent storage (initially SQLite).
2. **Web UI:** Hosted independently on one or more user workstations, adapted from `pi-web`. Multiple Web UIs can connect simultaneously to the same cloud harness and view/control the same conversation. The UI owns presentation and ephemeral layout state, **not** conversation truth or an independent agent loop.
3. **Execution Gateway:** A lightweight workstation-side TypeScript service, logically independent from the Web UI. It connects securely to the cloud harness and executes file/terminal/tool operations against local directories or remote SSH hosts accessible from that workstation. The gateway can run without any Web UI being open.
4. **Execution Host:** Any local machine, SSH server, HPC cluster, or other remote host. It should **not** need to install Pi, run a Web server, or initiate an outbound connection to the cloud. SSH connections originate from the gateway workstation.

A Web UI and a gateway may run on the same computer, but they must remain architecturally distinct. A Web UI on machine B must be able to control a conversation whose workspace is reached through gateway A. Closing the UI must not end the agent run. If its required gateway is offline, the tool cannot execute; the harness must preserve the state and report a clear blocked/interrupted/unknown status rather than pretending the tool finished.

### Conceptual topology

```text
Web UI A ──┐
Web UI B ──┼── secure RPC/events ── Cloud pi-durable Server ── persistent storage
Web UI C ──┘                              │
                                          │ tool/workspace RPC
                               ┌──────────┴──────────┐
                           Gateway A             Gateway B
                           /      \                  │
                     local cwd   SSH Host X        SSH Host Y
                                   │
                                HPC / VM
```

## 2. Upstream sources and reuse priorities

- `https://github.com/earendil-works/pi` — especially `packages/durable` and `packages/tui`. Prefer consuming the upstream `pi-durable` package rather than forking the runtime immediately; verify the current exports and stability.
- `https://github.com/agegr/pi-web` — **primary Web UI implementation**. Preserve existing chat components, streaming presentation, composer, session sidebar, tool rendering, settings, file browsing, and user experience before migrating session management to the cloud API.
- `https://github.com/minghinmatthewlam/pi-gui` — **reference and selective source** for workbench UX, file explorer, diff review, terminal, Git/worktree interactions, and any proven remote/SSH capabilities. Inspect real code before asserting SSH support. Do not indiscriminately merge Electron main/preload/renderer or preserve a second runtime/session supervisor.
- `pi-tui` — retain source/references for a **future** thin terminal client; not part of the initial MVP.

### Copy-first strategy

1. Record repo URLs, upstream SHA, license, dependency versions, and relevant entrypoints in `docs/upstream-sources.md`.
2. Preserve complete upstream snapshots or Git histories under a clearly marked `upstream/` or `vendor/` reference area; maintain licenses and source mapping. Use a normal copy, subtree, or other explicitly documented approach consistent with the repository state.
3. Make `pi-web` run **unchanged** at the beginning, with its existing tests/checks as a baseline where feasible.
4. Introduce a new durable-backed session adapter alongside the legacy local session path. Migrate one pathway at a time behind a clear boundary/feature flag. Only remove obsolete legacy logic after replacement behavior is verified.
5. Selectively copy `pi-gui` components and supporting TypeScript modules, keeping original behavior and attribution. Identify Electron-only dependencies and introduce minimal adapters rather than copying Electron runtime into the Web app.
6. Avoid cosmetic refactors, mass renames, or bulk deletion before the integration works.

## 3. Non-negotiable architectural boundaries

- **Single authoritative runtime:** Only the cloud pi-durable host performs agent generation, task orchestration, conversation persistence, and tool-call lifecycle management. Do not run a second `pi-coding-agent` instance in any Web UI or gateway.
- **Server-owned conversations:** History, active runs, input queue, steering, abort, model selection, compaction, agent state, and committed tool results are owned by the harness. Client components receive snapshots/events and send explicit commands.
- **Gateway-owned SSH:** SSH configuration, private keys, network reachability, tunnels, and connection pooling stay on the gateway workstation. The cloud stores logical workspace binding and non-secret metadata, not SSH credentials.
- **Workspace identity independent of UI:** Conversations refer to stable workspace IDs and gateway IDs, not the currently active browser or Web UI instance. Workspace changes must be explicit and traceable.
- **Versioned remote protocol:** Put transport DTOs and commands/events in `packages/protocol`. Do not expose internal experimental pi-durable/Chord object graphs as an unversioned public network contract. Add snapshots, monotonic revision or equivalent consistency mechanism, reconnection, and event resync.
- **One storage writer/owner initially:** SQLite and pi-durable storage are managed by one server process. Do not attempt multiple processes concurrently writing the same storage without a proven coordination design.
- **UI-local presentation:** Theme, sidebar expansion, tab layout, and transient editor drafts can remain in the Web UI. Interactive terminal PTY sessions belong to the execution gateway, not to durable conversation transcripts.
- **Tool fidelity:** Handle stdout, stderr, exit code, cancellation, timeouts, binary file access if applicable, cwd, environment boundaries, and SSH errors. Match pi-durable `ExecutionEnv` semantics and run its environment conformance tests if available.
- **Crash safety is not exactly-once:** Distinguish queued/not-dispatched, running, completed, failed, interrupted, and outcome-unknown operations. Do not blindly replay non-idempotent shell or write operations after disconnection or crash. Use durable call IDs, correlated results, and explicit retry policies.

## 4. Suggested repository layout (adapt to current repo; do not rearrange needlessly)

```text
apps/
  server/            # pi-durable host, HTTP/WS API, persistence
  web/               # pi-web-derived UI and browser-facing API if needed
  gateway/           # workstation service: local/SSH execution
packages/
  protocol/          # versioned commands, snapshots, events, DTOs
  execution/         # pi-durable ExecutionEnv -> gateway RPC adapter
  workspace/         # workspace/gateway metadata, routing, config schemas
upstream/             # traceable original snapshots or histories
  pi-web/
  pi-gui/
  pi-tui/             # optional reference only for now
docs/
  architecture.md
  upstream-sources.md
  migration.md
  decisions.md
```

Avoid duplicating entire copies both under `upstream/` and `apps/` without clear intent. Choose a source-preservation method that balances reproducibility with maintainability, and document it.

## 5. Workspace model

Use logical configuration similar to the following (illustrative, not a fixed schema):

```yaml
workspaces:
  - id: workstation-project
    gateway: mac-workstation
    type: local
    cwd: /Users/me/projects/project-a
  - id: cluster-project
    gateway: mac-workstation
    type: ssh
    ssh_profile: nscc
    cwd: /home/me/project-b
```

Gateway SSH profiles should reuse SSH config, ProxyJump, and existing authenticated routes wherever practical. Some remote hosts are reachable only from campus networks or through VPN/EasyConnect; the gateway should surface connectivity diagnostics without assuming the cloud server can reach those networks. Secrets remain local. A gateway must allow only explicitly configured workspace roots/hosts, with path confinement and safe handling of symlinks and traversal where appropriate.

## 6. Implementation order — deliver one vertical slice at a time

### Phase 0: Audit + baseline (first action)

- Inspect the existing repository; do not assume it is empty.
- Inspect the current upstream structures: pi-durable `Harness`, `ExecutionEnv`, `watch` / `viewState`, storage, tools and extensions; pi-web API/session layer; pi-gui workbench and any actual SSH implementation.
- Produce `docs/upstream-sources.md` and a concise `docs/architecture.md`, including a reuse matrix: **copy unchanged / adapt / defer / do not import**.
- Copy/preserve source and run the current pi-web baseline. Report which upstream tests or build steps worked or failed.
- Identify integration blockers honestly; do not infer features from screenshots or README marketing language.

### Phase 1: Durable server + one Web UI

- Open persistent SQLite-backed pi-durable storage on the cloud host.
- Expose narrowly scoped authenticated APIs for conversation list/create/open, messages, submit, busy mode (follow-up/steer), abort, settings/model, and a state/event stream.
- Implement a durable session adapter in the copied pi-web code instead of rewriting conversation UI.
- Verify new conversation, streamed response, tool output, page reload, browser reconnect, and server restart/resume.
- Preserve current UI behaviors until their replacements work; distinguish provider-visible state from UI display state.

### Phase 2: Multiple independent Web UIs

- Connect two separately hosted Web UI instances to the same durable server.
- Show consistent conversation metadata, entries, running state, and streaming results on both clients.
- Ensure commands from concurrent clients are serialized by server semantics, with request IDs for retry-safe submission, not by local UI assumptions.
- Test disconnect/reconnect and snapshot resync without duplicate messages.

### Phase 3: Gateway and execution bridge

- Implement the separate workstation gateway and a remote `ExecutionEnv` adapter.
- First provide `gateway-local`, then `gateway-ssh` using the same tool interface.
- Route built-in read/write/edit/bash and later relevant workbench operations through the correct workspace.
- Cover streaming output, cancellation, CWD, return codes, SSH unreachable, reconnect, and unknown outcomes.
- Never require a Pi runtime or an inbound network listener on the SSH host.

### Phase 4: Workbench migration from pi-gui

- Inspect and extract useful TypeScript/React code for file browsing, diff/review, interactive terminal, and Git/worktree functions.
- Supply workbench file and PTY operations through the same workspace/gateway abstraction rather than by allowing direct local filesystem access from the browser.
- Introduce features incrementally with behavior parity checks. Avoid importing the entire Electron main process or duplicating session ownership.

### Deferred

- Thin TUI client based on pi-tui.
- Multiple gateway selection/failover, extensive scheduler, subagent UI, container orchestration, enterprise capabilities, distributed SQLite or multi-server horizontal scaling.
- New visual redesign or alternate frontend frameworks.

## 7. Security and operational minimum

This is a **single-person** service, not a public SaaS. Prefer private networking (for example Tailscale) or HTTPS with strong token authentication. Protect Web UI -> cloud and gateway -> cloud links. Validate gateway identity, commands, and workspace selection; do not expose an unauthenticated internet-accessible shell. No SSH private keys in cloud SQLite, logs, or Web UI. Use the least-privilege OS account that satisfies development tasks. Be explicit about what happens when the workstation gateway is offline.

## 8. Acceptance criteria for initial release

1. Two independently hosted Web UIs connect to one cloud durable server and see the same conversation.
2. A conversation and its tool results survive Web UI close/reload and durable server restart.
3. Closing every Web UI does not itself stop the agent; gateway availability determines whether remote tools can run.
4. The workstation gateway executes agent read/write/edit/bash against its local workspace and at least one SSH remote workspace without installing Pi on the remote host.
5. A different Web UI can steer/submit into a conversation using another workstation's gateway.
6. Agent/tool status remains coherent after reconnect; unknown outcome is reported instead of silently retrying potentially destructive operations.
7. Imported pi-web behavior and reused pi-gui components are covered by checks or parity tests, and upstream source/license provenance is documented.
8. No multi-user account system, duplicated runtime, or unnecessary framework rewrite was introduced.

## 9. How to work and report progress

Start now with Phase 0. First read the repository and upstream sources, produce the minimal architecture/reuse decision notes, then make the smallest testable code change toward Phase 1. Do not repeatedly rescan the tree at the beginning of every iteration. If there is already useful code, adapt it instead of creating parallel replacements. Preserve unrelated user changes.

At the end of each meaningful increment, report concisely:

- **Implemented**: exact changes, paths and what is now working.
- **Validated**: commands/tests performed and their actual outcomes.
- **Decisions**: necessary architectural choices and why.
- **Risks/blockers**: verified issues, not guesses.
- **Next minimal step**: concrete follow-on implementation.

Do not present unimplemented plans as completed work. Prefer a working, verified vertical slice over broad scaffolding.
