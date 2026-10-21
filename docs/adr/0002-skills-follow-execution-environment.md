# Skills follow the execution environment

Resource storage and resource discovery are separate concerns. The harness owns a **Skill Repository** that stores, versions, and distributes skill bundles; the runtime discovers and reads installed resources exclusively through the active **Execution Environment**, on the selected execution host. Browser, gateway, and harness filesystems are not substitute resource sources.

Scope: skills, prompts, and context files share an execution-side resource abstraction. This does not settle whether the repository distributes all three.

Status: accepted (delivered; tickets 01-08). Delivered implementation, current state and verification:
[execution-side resources](../execution-side-skills.md) and
[execution-side installation](../execution-side-installation.md).

## Considered options

- Read a shared harness resource directory: rejected because repository content is not installed execution-host content.
- Have the Web UI store or load resources: rejected because it is a presentation client, not an execution environment.
- Automatically synchronise every host and overwrite local edits: rejected for the first version because changes must be explicit and predictable.
- Resolve global resources from the gateway process home: rejected because execution identity belongs to the selected host and account.

## Decision

- **One execution-side resource set.** The **Workspace Resource Loader** discovers and reads skills, prompts, and context through the active Execution Environment, preserving their distinct parsing and use. Repository interfaces leave room for resource types; management and distribution of prompts and context remain undefined and deferred.
- **Skill Repository.** The cloud repository stores and versions bundles and answers management requests; it never supplies its own content directly to agent execution. Bundles are ordinary files with metadata kept separately from conversation storage. Concrete repository paths are illustrative, not fixed configuration.
- **Installation.** Gateway / Execution Environment places ordinary files on the execution host. Runtime loading then needs no repository connectivity. Install and Update are explicit; the first version has no automatic synchronisation.
- **Execution identity.** ExecutionEnv resolves the actual tool-execution account and its home on the selected host, for local and SSH execution alike. Resolution failure is reported explicitly; it never guesses a home path or substitutes gateway/harness home. The query mechanism is an implementation choice.
- **Installation scope.** Global installation belongs to the execution host and account and is shared across their workspaces. Workspace installation belongs to a project directory on that host, not a UI binding; ancestor discovery may expose it through other entry points.
- **Separate management entry points.** Repository APIs manage cloud bundles; workspace operations manage or inspect execution-host installations. Web UI calls these APIs and displays state; it does not store, load, or execute resources.
- **No workspace switching.** A conversation cannot switch workspaces anywhere in its lifecycle in the first version, including while idle. Changing workspace means creating a new conversation; moving conversations is deferred.
- **Discovery timing.** Initial discovery happens when a conversation first loads resources; subsequent refreshes require Reload. Successful Install / Update asks its conversation to reload. A running run keeps its adopted prefix; changes take effect on the next run. Other conversations do not automatically hot-update.
- **Durable resource state.** Persist the adopted rendered system prefix and resource catalog with the conversation. Runtime restart restores that committed loading result rather than rediscovering files or silently changing the prefix. Restart is not initial conversation loading. This does not snapshot resource directories or freeze scripts, references, or other files read through ordinary tools.
- **Atomic Reload and failure isolation.** Discover, read, and parse the complete candidate loading result before committing it as one replacement. Failure retains the previous prefix and catalog and produces a Web UI notification. First-load failure blocks only that conversation's attempted run and allows retry. Neither failure takes down the harness, Web UI, or other conversations; unreachable environments never trigger harness-local resource fallback.
- **Provenance.** Skills installed by hand, git, Pi, or the repository are discoverable and usable. Other execution-side resources likewise need no repository registration. Unknown provenance or version does not mean a skill is uninstalled or locally modified.
- **Update conflicts.** Normal Update stops on local modification. Overwrite requires separate explicit confirmation and preserves a backup of the replaced directory; there is no automatic merge. Local modification is measured against the install-time content-hash baseline, not the repository's latest version.
- **Remove `pi-resource://` and `read_pi_resource`.** No compatibility fallback keeps the namespace or dedicated tool alive. Resources use real ExecutionEnv paths and ordinary file tools. Delivered in ticket 08 after the file-access adaptation and replacement regression coverage landed.
- **Installation safety.** Bundle installation rejects path traversal and symlinks escaping the intended installation directory and publishes downloaded content atomically. This is installation safety, not a sandbox. Uploading a bundle does not execute it in the cloud harness.
- **Sandboxing is deferred.** The first version adds no sandbox or custom sandbox rewrite. Future isolation design should first examine pi-web / pi-gui approaches. This does not approve blanket removal of existing permission checks or claim that file and shell tools already share a consistent boundary.

The harness retains the single authoritative runtime from [ADR 0001](0001-single-authoritative-durable-runtime.md). Model runtime stays with the backend; gateways provide execution environments.

## Deferred design

- Repository management and distribution of prompts and context: retain extensible interfaces now; define and implement that scope later.
- Future sandbox and isolation policy: deliberate later design, upstream-first rather than a custom rewrite.

## Consequences

- `apps/server/src/pi-resources.ts` read user resources from the harness `agentDir`, contrary to this target. Ticket 08 removed the module and its harness-local loader; the two prompt-template helpers it held moved to `apps/server/src/prompt-templates.ts`.
- Pi ancestor `.agents/skills` discovery rules must be verified against the chosen upstream version before adaptation; this ADR does not claim they have been verified.
- `packages/gateway/src/filesystem.ts:110-119` confines file RPC to `workspace.root`, making global and ancestor resources potentially unreachable. Ordinary ExecutionEnv access needs adaptation for the selected host and account; deleting URI indirection alone is insufficient, and harness-local reads are not a fallback.
- Gateway shell execution checks its starting cwd, not subsequent filesystem access (`packages/gateway/src/index.ts`, `runner.ts`). File-RPC confinement therefore is not a sandbox shared by both tools. Identity resolution and ordinary resource access were implementation work, not grounds for another resource-specific permission system.
- **Delivered.** Identity resolution (`executionHost` on `/v1/files`, local and SSH) and ordinary resource access through the file RPC are implemented, along with discovery, precedence, durable adoption, atomic Reload and explicit installation; see
[execution-side resources](../execution-side-skills.md) for the current behaviour and
[docs/migration-status.md](../migration-status.md) for what remains outside the selected subset. The statements above record the
situation this decision was taken against and are kept as history.
