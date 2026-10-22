# Gateway HTTP transport ownership

Status: implemented; integrated at `e7b30204`. Baseline: `5ec7ffe6`, 2026-10-21. [Design index](../non-ui-architecture-design/README.md) · [Shared requirements](../non-ui-architecture-design/requirements.md).

## Problem and evidence

[GatewayRpcServer](../../packages/gateway/src/index.ts) starts at 503, its positional constructor at 532, HTTP dispatch at 550, binary file handling after 700, terminal streaming later, and unified shutdown at 1018. [startup.ts](../../packages/gateway/src/startup.ts) constructs the actual local/SSH capabilities. The same entry implementation knows admission, JSON envelopes, raw file payloads, terminal cursors/budgets, MCP cancellation and provider-login lifetime.

Representative change: changing terminal resume framing should require editing the terminal transport implementation and its contract checks, without touching file upload parsing or provider login disposal.

## Chosen module and interface

Keep one Gateway listener and one concrete composition owner. Internally separate the cohesive transport families: execution/abort, file JSON+raw payload, terminal/SSE, and remaining host control/settings operations. Use named concrete handlers and fixed dispatch; the domain capability instances continue to own execution semantics. No configurable route-prefix plugin protocol or generic RPC command registry.

Common entry owns route recognition and credential admission before body consumption/dispatch, outer safe failures and unknown routes. Each admitted transport family owns parsing/validation specific to its protocol, exact response framing/status, cancellation, and backpressure. Shared parsing helpers are internal to transport, not a new exported HTTP package.

External callers still create one server, use its Node server for listening and await `close()`. A named construction object may replace positional holes while migrating all callers, but that ergonomic change alone does not satisfy this spec. Required depth comes from hiding framing/lifetime rules within the appropriate transport implementation and eliminating their cross-family knowledge.

Shutdown remains explicitly composed by the server, in existing order: terminals → provider logins → MCP → files → HTTP connections → gateway → listener close. Preserve existing ordinary behavior and inspect any acquisition changes. Do not derive shutdown order from a plugin array or add a supervisor. Capability instances are borrowed by handlers and disposed once by the composition owner.

## Behavioral interface facts

- Existing `/v1/*` paths, HTTP methods, query handling, JSON body limits, error envelopes and statuses remain exact; a domain refusal carried in HTTP 200 is not silently converted to another transport convention. No RFC7807 change.
- Binary payload routes remain outside base64 JSON body limits; preserve byte-range/download/upload semantics and staging outcomes.
- Terminal SSE retains Last-Event-ID precedence, per-origin fan-in, retained tail, reconnect behavior and buffered-output limits.
- MCP work ends when its requesting response closes prematurely. Provider login survives caller disconnect and ends through its own completion/cancel or server shutdown. A single global request AbortSignal must not erase that distinction.
- Execution request identity, journal/output behavior and abort stay with existing Gateway implementations. No transport migration to WebSocket/gRPC.
- Missing optional capabilities retain their named limits. Generic middleware must not normalize them into indistinguishable errors.

## Alternatives and dependencies

| Alternative | Assessment |
| --- | --- |
| Ten positional dependencies → one descriptor | Useful naming, same caller knowledge; insufficient on its own. |
| HostCapability `{prefix, handle, close}` plugin list | Adds matching/ordering/disposal protocol and can conflate distinct lifetimes. Reject. |
| New network RPC transport | Adds state and changes established streaming semantics. Reject. |
| Concrete transport families under existing composition | Localizes substantial framing behavior with a small internal interface. Select. |

In-process: parsing, capabilities and execution journal. Local-substitutable: Node HTTP loopback fixtures and temp filesystem. Remote-owned: existing SSH-backed capability adapters; reuse their interfaces. True-external: PTY/SSH/tools behind current owners. Node HTTP itself is a local dependency, not a third-party remote port.

## Deletion and test surface

Delete moved private transport branches from index, redundant request parsing and duplicate family-specific failure mapping where behavior is demonstrably identical. Remove obsolete constructor call patterns directly. Preserve differentiated host admission and remote validation. Deleting a selected transport module would return framing, cursor or cancellation rules to unrelated dispatch callers; no thin pass-through handler classes.

| ID | Observable completion | Existing evidence seam |
| --- | --- | --- |
| GT1 | Current admitted JSON operations preserve status/envelope and absent-capability outcomes. | `packages/gateway/test` execution, MCP and provider integration tests. |
| GT2 | File payloads, ranges and write outcomes agree with current behavior. | `file-transfer.test.ts`, `files-surface.test.ts`, ordinary ingress file journeys. |
| GT3 | Terminal reconnect/fan-in/backpressure and close preserve output and ownership. | `terminal.test.ts`, `terminal-stream-budget.test.ts`, existing ingress terminal cases. |
| GT4 | MCP disconnect cancels its operation; provider login remains available to subsequent admitted requests. | Existing MCP/provider-login lifecycle tests through normal listeners. |
| GT5 | Server shutdown disposes each actual capability once; transport family changes remain local. | Public close checks and diff review. |

Exercise the ordinary admitted Gateway HTTP entry, not private handlers past token admission. Keep protocol integration tests; new pure parsing tests replace redundant private-method assertions only when needed. Run focused test files explicitly: the daily Gateway test script is not the complete acceptance suite.

## Slices, dependencies and guides

1. Inventory route families and their framing/lifetime contracts.
2. Extract file and terminal transport implementations; retain common admission.
3. Move remaining transport families, migrate constructor callers if naming improves them, remove obsolete code.
4. Verify actual lifecycle/streaming and update [developer guide](../../docs/developer-guide.md), [architecture](../../docs/architecture.md) and affected terminal/workbench guides.

Independent of Backend registry and UI. Coordinate only the filesystem type/caller edits with [filesystem adapters](../filesystem-adapters/spec.md); no need to block on its internal Python representation.
