# Project and workspace registry

Status: proposed design; implementation not started. Baseline: `5ec7ffe6`, 2026-10-21. [Design index](../non-ui-architecture-design/README.md) · [Shared requirements](../non-ui-architecture-design/requirements.md).

## Problem and evidence

[server.ts](../../apps/server/src/server.ts) holds project/retained arrays, gateway maps and `projectsRevision` at 905–918; resolution/registration helpers at 920–1120; direct mutation/publication inside project routes at 2069–2187 and worktree operations at 2205–2280. [project-store.ts](../../apps/server/src/project-store.ts) already owns atomic SQLite persistence; [catalogue-binding.ts](../../apps/server/src/catalogue-binding.ts) owns the projection vocabulary.

Representative change: Folder Unlink should update persistence, retained resolution, target eligibility and published project view in one owning implementation. An HTTP caller should not splice arrays or manually append retained records.

## Chosen module and interface

Introduce a backend-internal project/workspace registry composed from existing ProjectStore, configured workspaces, configured gateway connections and host clients. Keep the ProjectStore schema/transactions as implementation; do not merge it into the Conversation store. Preserve the configured → retained → project-folder precedence. Avoid the name `WorkspaceRegistry` alone, which already names a different Gateway module.

ProjectStore is optional in current Backend startup. With no store, configured workspace resolution, reads, catalogue projection and execution preparation continue as today; project mutation/worktree operations retain their current unavailable outcomes. Configured-binding behavior must not depend on ProjectStore being present. When a store exists, retained/project bindings join configured bindings with existing precedence.

The interface has three cohesive groups of operations, all required by current callers:

- **Read:** resolve a workspace to existing CatalogueBinding; snapshot project metadata, eligible targets, retained metadata and publication revision. Returned HTTP metadata contains no gateway credential.
- **Execution preparation:** ensure a workspace binding by resolving once, reasserting a project/retained registration on its recorded host, and returning the existing transport binding for internal callers. Boot registration uses the same owner.
- **Mutation and checkout workflow:** create Project, set default folder, unlink folder, remove Project, and list/create/remove checkout. Checkout operations own project lookup, preflight, existing host-client calls, workspace registration, persistence, publication and partial outcomes. These are concrete named operations, not an open-ended command bus. They publish their committed metadata before returning.

Illustrative call: `const binding = await registry.ensureBinding(workspaceId)`; project routes call `registry.unlink(projectId, folderId, replacementDefaultId, requestHostId)` and serialize its result. Complete type names are implementation choices; the behavioral facts below are mandatory.

Host validation and registration occur before recording a newly accepted root. Never keep SQLite transactions open while awaiting a host. Store success is required before updating live metadata or revision. On failed persistence, live metadata stays unchanged; a host-side creation/registration that already happened is not falsely rolled back. Preserve named partial outcomes such as `not_recorded`. Existing root registration may be replayed; execution, installation and mutation with unknown outcome are never replayed.

`createCheckout` owns host creation → root registration → folder recording → publication. `removeCheckout` owns project/default-folder checks **before** host removal, then host removal → folder unlink/retention → publication. An HTTP caller cannot invoke post-hoc record/reconcile methods that require it to know that ordering. `listCheckouts` joins host-reported paths with recorded folder identities inside this owner. Existing host clients still own git execution and dirty-checkout refusal; no direct git implementation moves into the registry.

The registry owns its live snapshot and publication revision; routes cannot mutate them. `projectsRevision` advances once per accepted mutation that changes persisted Project/retained/checkout metadata, including checkout create/remove after successful metadata recording; it does not advance for host refusal, no-op, failed store write or metadata-only read. It remains process-local and is published on the existing conversation/catalogue read. The registry borrows ProjectStore lifetime from its creator, which closes the store once. Lookup does no host I/O; ensure may do registration I/O. No cache TTL, observer bus, background refresh or O(1) performance promise is introduced.

## Preserved invariants

- Workspace ids remain opaque/stable, independent of display roots. Default changes affect new Conversation selection and leave existing bindings intact.
- Retained Bindings resolve existing Conversations after Folder Unlink/Project removal and across backend/gateway restart; they are never eligible for a new target and are never pruned.
- One Project’s folders belong to its recorded gateway/profile. Request host may confirm that identity; it cannot redirect a recorded Project to this Web origin’s own machine.
- Folder Unlink is metadata-only; replacement default is supplied atomically when required; last-folder unlink removes the Project. No user directory or Conversation deletion.
- Checkout create/remove keeps existing host/git refusal semantics and separates host success from metadata recording success. Existing checkout registration is idempotent.
- Catalogue projection remains derived from resolved facts through existing catalogue-binding implementation. Publication revision is process-local and opaque; define all visible registry mutations under the same publication owner without implying cross-process synchronization.

## Alternatives and dependencies

| Alternative | Assessment |
| --- | --- |
| Pure resolver over externally mutable arrays | Hides precedence but leaves publication and mutation ordering in routes. Reject. |
| Resolver + new ProjectService + new repository port | Duplicates existing ProjectStore and exposes coordination across three caller-visible modules. Reject. |
| Resolve by projectId/default folder | Fails configured, retained and non-default workspace identities. Reject. |
| Cohesive registry over current store and host clients | Keeps durable persistence distinct while hiding live publication and preparation. Select. |

In-process: resolution/projection. Local-substitutable: real SQLite in-memory/temp DB; prefer existing store to a new fake. Remote-owned: existing Gateway workspace/worktree clients and normal fixture hosts. True-external: OS/git behind those clients. The existing host transport already supplies a real seam; add no pass-through host adapter.

## Deletion, acceptance and verification

Remove server-owned project/retained mutation arrays, per-route publication increments, repeated binding assembly and duplicated registration orchestration. Internal snapshot state remains necessary; moving it into one owner is not a claim of eliminating durable/live distinctions. Deleting this registry would spread commit→publication and resolve→registration ordering back across routes, catalogue and environment creation.

| ID | Observable completion | Existing evidence seam |
| --- | --- | --- |
| WR1 | Precedence, configured targets and non-default folder resolution agree across catalogue and execution, both with and without optional ProjectStore. | `apps/server/test/catalogue-binding.test.ts`, `project.test.ts`, existing no-store startup coverage. |
| WR2 | Default changes, unlink and remove retain existing bindings; fresh targets exclude retained ids. | `project.test.ts`, folder-unlink cases and colocated registry tests. |
| WR3 | Restart reasserts all project/retained roots with the original profile; new requests recover gateway registrations. | `ssh-project.test.ts`, existing project/recovery fixtures. |
| WR4 | Host refusal/store failure leaves truthful outcomes; no false live Project or mutation replay. | Existing normal Project/worktree journeys; inspect acquisition/commit/publication ordering. |
| WR5 | Checkout list/create/remove uses the same owner; default-folder refusal precedes host removal, host dirty refusal remains intact, partial host success is truthful, and persisted metadata changes advance catalogue `projectsRevision` exactly once. | `apps/server/test/worktree-picker.test.ts`, `catalogue-binding.test.ts`, existing normal worktree journeys through admitted callers. |
| WR6 | Routes perform no snapshot surgery or revision writes; projections emit no credential. | Diff review plus admitted HTTP catalogue assertions. |

Replace computation tests tied to old closure internals with colocated registry-interface tests using the actual store. Retain HTTP and SSH composition checks. Planned checks are not executed results.

## Slices, dependencies and guides

1. Extract read/ensure logic with the existing store and host clients.
2. Move Project mutations and snapshot publication; migrate catalogue/environment consumers.
3. Move complete checkout list/create/remove workflows; remove caller mutation/preflight glue, review all revision writers.
4. Run focused checks and update [projects](../../docs/projects.md) and [architecture](../../docs/architecture.md).

Can start without Backend route extraction; that effort consumes the settled registry interface. Ingress locality may use its existing workspace facts after this slice, but requires no new registry protocol or data migration.
