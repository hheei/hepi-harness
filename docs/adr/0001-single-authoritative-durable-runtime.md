# Single authoritative durable runtime

The backend owns the only agent loop, conversation history, task lifecycle, and committed tool results, using `pi-durable` as the runtime boundary. Web UIs are presentation clients and gateways provide execution environments through an explicit adapter; neither runs a second Pi runtime. This preserves one source of conversation truth, allows UI disconnects without stopping work, and avoids conflicting local session supervisors.

Status: accepted and implemented. See [current architecture](../architecture.md) and [capability status](../migration-status.md).

## Considered options

- Run a Pi runtime in every Web UI or gateway: rejected because it duplicates conversation ownership and makes reconnect, concurrent control, and durable state ambiguous.
- Fork and rewrite `pi-durable` into a new runtime: rejected because the upstream package already exposes the required durable conversation, task, view, watch, storage, and `ExecutionEnv` seams.
- Keep all file and shell execution on the cloud server: rejected because local and SSH reachability, credentials, and workspace boundaries belong to the workstation gateway.

## Consequences

The project needs a versioned protocol package with snapshots, revisions, commands, events, request IDs, reconnection/resync, and explicit operation outcome states. The first server must remain the single SQLite writer. Upstream Web UI and desktop code will be adapted incrementally behind seams, with source revisions and licenses recorded.
