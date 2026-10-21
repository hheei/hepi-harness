# 02: Define the versioned protocol and workspace model

**What to build:** The system has a versioned, testable contract for snapshots, revisions, commands, events, request IDs, workspace bindings, gateway identity, and explicit operation outcomes.

**Blocked by:** 01: Preserve upstream provenance and establish baselines

**Status:** complete

- [x] Define protocol versioning, snapshot shape, monotonic revision or equivalent consistency marker, command correlation, and event resync semantics.
- [x] Define stable conversation, workspace, and gateway identities independent of Web UI instances.
- [x] Define operation lifecycle states including queued/not-dispatched, dispatched, running, completed, failed, interrupted, and outcome-unknown.
- [x] Define local and SSH workspace configuration with non-secret metadata only and explicit allowlists.
- [x] Add contract tests for ordering, correlation, resync, and invalid workspace/gateway references.

Evidence: [packages/protocol](../../../packages/protocol) and [docs/architecture.md](../../../docs/architecture.md).
